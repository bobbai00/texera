/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.web.resource

import com.fasterxml.jackson.databind.node.ObjectNode
import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import org.apache.amber.config.ApplicationConfig
import org.apache.amber.core.storage.DocumentFactory
import org.apache.amber.operator.LogicalOp
import org.apache.amber.core.storage.model.VirtualDocument
import org.apache.amber.core.tuple.Tuple
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, OperatorIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow.{PortIdentity, WorkflowContext, WorkflowSettings}
import org.apache.amber.engine.architecture.rpc.controlcommands.{ConsoleMessage, ConsoleMessageType}
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.amber.engine.common.executionruntimestate.{
  ExecutionConsoleStore,
  ExecutionMetadataStore
}
import io.reactivex.rxjava3.core.Observable
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.OPERATOR_EXECUTIONS
import org.apache.texera.web.model.websocket.request.{LogicalPlanPojo, WorkflowExecuteRequest}
import org.apache.texera.workflow.{LogicalLink, WorkflowCompiler}
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.{ExecutionResultService, WorkflowService}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState

import java.net.URI
import java.util.concurrent.TimeUnit
import javax.annotation.security.RolesAllowed
import javax.ws.rs._
import javax.ws.rs.core.MediaType
import scala.collection.mutable

/**
  * Request body for synchronous workflow execution.
  */
case class SyncExecutionRequest(
    executionName: String,
    logicalPlan: LogicalPlanPojo,
    workflowSettings: Option[WorkflowSettings],
    targetOperatorIds: List[String],
    timeoutSeconds: Option[Int],
    maxOperatorResultTokenLimit: Option[Int], // Max tokens for operator results (total)
    maxCellTokens: Option[Int], // Max tokens per cell
    serializationMode: Option[String], // "json" (default) or "table"
    restrictOperatorResultToken: Option[Boolean], // If false, no token limit applied
    disablePrint: Option[Boolean] // If true, validate Python UDFs have no print statements
)

/**
  * Console message in a simplified format - contains type, title, and details.
  */
case class ConsoleMessageInfo(
    msgType: String,
    title: String,
    message: String
)

/**
  * Structured table result format for compact representation.
  * Each row is a single comma-separated string.
  */
case class TableResult(
    header: String,
    rows: List[String]
)

/**
  * Per-operator result info - contains everything about one operator.
  */
case class OperatorInfo(
    state: String,
    inputTuples: Long,
    outputTuples: Long,
    resultMode: String, // "table" or "visualization"
    resultFormat: Option[String], // "json" or "table"
    result: Option[Any], // JSON array (List[ObjectNode]) or Table structure (TableResult)
    totalRowCount: Option[Int],
    displayedRows: Option[Int],
    truncated: Option[Boolean],
    consoleLogs: Option[List[ConsoleMessageInfo]],
    error: Option[String]
)

/**
  * Simplified execution result - just success, state, and per-operator info.
  */
case class SyncExecutionResult(
    success: Boolean,
    state: String,
    operators: Map[String, OperatorInfo],
    compilationErrors: Option[Map[String, String]],
    errors: Option[List[String]]
)

/**
  * Sealed trait representing the reason for execution termination.
  */
sealed trait TerminationReason
case class TerminalStateReached(state: ExecutionMetadataStore) extends TerminationReason
case class ConsoleErrorDetected(consoleState: ExecutionConsoleStore) extends TerminationReason

/**
  * REST API resource for synchronous (blocking) workflow execution.
  * Uses Observable-based approach to wait for execution completion.
  */
@Path("/execution")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class SyncExecutionResource extends LazyLogging {

  private val DEFAULT_TIMEOUT_SECONDS = 300
  private val DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT = 2000
  private val DEFAULT_MAX_CELL_TOKENS = 10000
  // Ultimate caps - always applied regardless of restrictOperatorResultToken flag
  private val MAX_OPERATOR_RESULT_TOKEN = 10000
  private val MAX_CELL_TOKEN = 10000

  @POST
  @Path("/{wid}/{cuid}/run")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def executeWorkflowSync(
      @PathParam("wid") workflowId: Long,
      @PathParam("cuid") computingUnitId: Int,
      request: SyncExecutionRequest,
      @Auth user: SessionUser
  ): SyncExecutionResult = {
    val timeoutSeconds = request.timeoutSeconds.getOrElse(DEFAULT_TIMEOUT_SECONDS)
    val restrictTokens = request.restrictOperatorResultToken.getOrElse(false)
    val disablePrint = request.disablePrint.getOrElse(true)

    // Calculate token limits: use user-provided values if restrictTokens is true,
    // otherwise use ultimate caps. Always cap at MAX values.
    val (maxOperatorResultTokenLimit, maxCellTokens) = if (restrictTokens) {
      (
        Math.min(
          request.maxOperatorResultTokenLimit.getOrElse(DEFAULT_MAX_OPERATOR_RESULT_TOKEN_LIMIT),
          MAX_OPERATOR_RESULT_TOKEN
        ),
        Math.min(request.maxCellTokens.getOrElse(DEFAULT_MAX_CELL_TOKENS), MAX_CELL_TOKEN)
      )
    } else {
      (MAX_OPERATOR_RESULT_TOKEN, MAX_CELL_TOKEN)
    }
    val serializationMode = request.serializationMode.getOrElse("table")

    logger.info(
      s"Starting sync execution for workflow $workflowId (restrictTokens=$restrictTokens, disablePrint=$disablePrint)"
    )

    try {
      val workflowService = WorkflowService.getOrCreate(
        WorkflowIdentity(workflowId),
        computingUnitId
      )

      // Shutdown any previous execution's client
      shutdownPreviousExecution(workflowService)

      // Compute sub-DAG if there's exactly 1 target operator (Execute To behavior)
      val effectiveLogicalPlan =
        computeSubDAGIfNeeded(request.logicalPlan, request.targetOperatorIds)

      // Validate Python UDFs for print statements if disablePrint is true
      if (disablePrint) {
        val printErrors = validateNoPrintStatements(effectiveLogicalPlan)
        if (printErrors.nonEmpty) {
          return SyncExecutionResult(
            success = false,
            state = "ValidationFailed",
            operators = Map.empty,
            compilationErrors = Some(printErrors),
            errors = Some(printErrors.values.toList)
          )
        }
      }

      // Pre-compile the workflow to catch errors early
      val compilationErrors = validateWorkflow(workflowId, effectiveLogicalPlan)
      if (compilationErrors.nonEmpty) {
        return SyncExecutionResult(
          success = false,
          state = "CompilationFailed",
          operators = Map.empty,
          compilationErrors = Some(compilationErrors),
          errors = Some(compilationErrors.values.toList)
        )
      }

      val executeRequest = WorkflowExecuteRequest(
        executionName = request.executionName,
        engineVersion = "1.0",
        logicalPlan = effectiveLogicalPlan,
        replayFromExecution = None,
        workflowSettings = request.workflowSettings.getOrElse(
          WorkflowSettings(dataTransferBatchSize = ApplicationConfig.defaultDataTransferBatchSize)
        ),
        emailNotificationEnabled = false,
        computingUnitId = computingUnitId
      )

      // Initialize and start execution
      workflowService.initExecutionService(
        executeRequest,
        Some(user.getUser),
        new URI(s"sync-execution://$workflowId")
      )

      val executionService = workflowService.executionService.getValue
      if (executionService == null) {
        return SyncExecutionResult(
          success = false,
          state = "Error",
          operators = Map.empty,
          compilationErrors = None,
          errors = Some(List("Failed to initialize execution service"))
        )
      }

      // Check if workflow already completed (for very fast executions)
      // This handles the race condition where execution finishes before Observable subscription
      val currentState = executionService.executionStateStore.metadataStore.getState
      val currentConsoleState = executionService.executionStateStore.consoleStore.getState

      val terminationReason: TerminationReason =
        if (isTerminalState(currentState.state)) {
          // Already in terminal state
          TerminalStateReached(currentState)
        } else if (hasConsoleError(currentConsoleState)) {
          // Already has console error
          ConsoleErrorDetected(currentConsoleState)
        } else {
          // Create two termination conditions:
          // 1. Terminal state (COMPLETED, FAILED, KILLED, TERMINATED)
          // 2. Console ERROR message (any operator logs an error)

          // Observable for terminal state
          val terminalStateObservable: Observable[TerminationReason] =
            executionService.executionStateStore.metadataStore.getStateObservable
              .filter((state: ExecutionMetadataStore) => isTerminalState(state.state))
              .map[TerminationReason](state => TerminalStateReached(state))

          // Observable for console ERROR messages
          val consoleErrorObservable: Observable[TerminationReason] =
            executionService.executionStateStore.consoleStore.getStateObservable
              .filter((consoleState: ExecutionConsoleStore) => hasConsoleError(consoleState))
              .map[TerminationReason](consoleState => ConsoleErrorDetected(consoleState))

          // Race between the two conditions - whichever fires first wins
          try {
            Observable
              .amb(java.util.Arrays.asList(terminalStateObservable, consoleErrorObservable))
              .firstOrError()
              .timeout(timeoutSeconds.toLong, TimeUnit.SECONDS)
              .blockingGet()
          } catch {
            case _: java.util.concurrent.TimeoutException =>
              // Timeout - kill the execution
              killExecution(executionService)
              return SyncExecutionResult(
                success = false,
                state = "Killed",
                operators = Map.empty,
                compilationErrors = None,
                errors = Some(List(s"Timeout after $timeoutSeconds seconds"))
              )
            case e: Exception =>
              logger.error(s"Error waiting for execution: ${e.getMessage}", e)
              return SyncExecutionResult(
                success = false,
                state = "Error",
                operators = Map.empty,
                compilationErrors = None,
                errors = Some(List(e.getMessage))
              )
          }
        }

      // Handle termination based on reason
      val (finalState, terminatedByConsoleError) = terminationReason match {
        case TerminalStateReached(state) =>
          (state, false)
        case ConsoleErrorDetected(_) =>
          // Console error detected - kill the workflow and get current state
          killExecution(executionService)
          (executionService.executionStateStore.metadataStore.getState, true)
      }

      // Small delay to ensure results are persisted
      Thread.sleep(500)

      // Get in-memory console state for error extraction (may not be persisted to DB yet)
      val inMemoryConsoleState = terminationReason match {
        case ConsoleErrorDetected(consoleState) => Some(consoleState)
        case _                                  => None
      }

      // Collect results
      val executionId = executionService.workflowContext.executionId
      val operatorInfos = collectOperatorInfos(
        executionId,
        executionService,
        request.targetOperatorIds,
        maxOperatorResultTokenLimit,
        maxCellTokens,
        serializationMode,
        inMemoryConsoleState
      )

      // Collect fatal errors
      val fatalErrors = finalState.fatalErrors
        .map(err => s"${err.`type`}: ${err.message}")
        .toList

      // Check for console errors in operator results
      val hasOperatorConsoleError = operatorInfos.values.exists(_.error.isDefined)

      // Determine state string - if terminated by console error, show as "Failed"
      val stateString =
        if (terminatedByConsoleError) "Failed" else stateToString(finalState.state)

      SyncExecutionResult(
        success =
          finalState.state == COMPLETED && !hasOperatorConsoleError && !terminatedByConsoleError,
        state = stateString,
        operators = operatorInfos,
        compilationErrors = None,
        errors = if (fatalErrors.nonEmpty) Some(fatalErrors) else None
      )

    } catch {
      case e: Exception =>
        logger.error(s"Sync execution error: ${e.getMessage}", e)
        handleExecutionError(e)
    }
  }

  private def shutdownPreviousExecution(workflowService: WorkflowService): Unit = {
    try {
      val previousEs = workflowService.executionService.getValue
      if (previousEs != null && previousEs.client != null) {
        logger.info(s"Shutting down previous execution client")
        previousEs.client.shutdown()
      }
    } catch {
      case e: Exception =>
        logger.warn(s"Error shutting down previous execution client: ${e.getMessage}")
    }
  }

  private def killExecution(
      executionService: org.apache.texera.web.service.WorkflowExecutionService
  ): Unit = {
    try {
      if (executionService.client != null) {
        executionService.client.shutdown()
      }
      executionService.executionStateStore.statsStore.updateState(stats =>
        stats.withEndTimeStamp(System.currentTimeMillis())
      )
      executionService.executionStateStore.metadataStore.updateState(metadataStore =>
        updateWorkflowState(KILLED, metadataStore)
      )
    } catch {
      case e: Exception =>
        logger.warn(s"Error killing execution: ${e.getMessage}")
    }
  }

  private def collectOperatorInfos(
      executionId: ExecutionIdentity,
      executionService: org.apache.texera.web.service.WorkflowExecutionService,
      targetOperatorIds: List[String],
      maxOperatorResultTokenLimit: Int,
      maxCellTokens: Int,
      serializationMode: String,
      inMemoryConsoleState: Option[ExecutionConsoleStore] = None
  ): Map[String, OperatorInfo] = {
    val operatorInfos = mutable.Map[String, OperatorInfo]()

    // Get operator stats from the state store
    val statsState = executionService.executionStateStore.statsStore.getState
    val operatorStats = statsState.operatorInfo

    // Determine which operators to collect - include both target operators and any with console errors
    val baseTargetOps = if (targetOperatorIds.nonEmpty) {
      targetOperatorIds
    } else {
      operatorStats.keys.toList
    }

    // Also include operators from in-memory console state that have errors
    val consoleErrorOps = inMemoryConsoleState
      .map { consoleState =>
        consoleState.operatorConsole.keys.toList
      }
      .getOrElse(List.empty)

    val targetOps = (baseTargetOps ++ consoleErrorOps).distinct

    for (opId <- targetOps) {
      val stats = operatorStats.get(opId)
      val (state, inputTuples, outputTuples): (String, Long, Long) = stats match {
        case Some(s) =>
          val inputCount = s.operatorStatistics.inputMetrics.map(_.tupleMetrics.count).sum
          val outputCount = s.operatorStatistics.outputMetrics.map(_.tupleMetrics.count).sum
          (stateToString(s.operatorState), inputCount, outputCount)
        case None => ("Unknown", 0L, 0L)
      }

      // Get result
      val (resultMode, resultFormat, result, totalRowCount, displayedRows, truncated) =
        collectOperatorResult(
          executionId,
          opId,
          maxOperatorResultTokenLimit,
          maxCellTokens,
          serializationMode
        )

      // Get console logs - first try database, then fallback to in-memory state
      val dbConsoleLogs = collectConsoleLogs(executionId, opId)
      val consoleLogs = dbConsoleLogs.orElse {
        // Fallback to in-memory console state if database logs not available
        inMemoryConsoleState.flatMap { consoleState =>
          consoleState.operatorConsole
            .get(opId)
            .map { opConsole =>
              opConsole.consoleMessages.map { msg =>
                ConsoleMessageInfo(
                  msgType = msg.msgType.name,
                  title = msg.title,
                  message = msg.message
                )
              }.toList
            }
            .filter(_.nonEmpty)
        }
      }

      // Check for error in console logs
      val errorMsg = consoleLogs.flatMap(
        _.find(_.msgType == "ERROR").map(e =>
          if (e.message.nonEmpty) s"${e.title}: ${e.message}" else e.title
        )
      )

      operatorInfos(opId) = OperatorInfo(
        state = state,
        inputTuples = inputTuples,
        outputTuples = outputTuples,
        resultMode = resultMode,
        resultFormat = resultFormat,
        result = result,
        totalRowCount = totalRowCount,
        displayedRows = displayedRows,
        truncated = truncated,
        consoleLogs = consoleLogs,
        error = errorMsg
      )
    }

    operatorInfos.toMap
  }

  private def handleExecutionError(e: Exception): SyncExecutionResult = {
    val errorMsg = e.getMessage
    val isCompilationError = errorMsg != null && (
      errorMsg.contains("compilation") ||
        errorMsg.contains("Compilation") ||
        errorMsg.contains("operator") ||
        errorMsg.contains("schema")
    )

    if (isCompilationError) {
      SyncExecutionResult(
        success = false,
        state = "CompilationFailed",
        operators = Map.empty,
        compilationErrors = Some(Map("error" -> errorMsg)),
        errors = Some(List(errorMsg))
      )
    } else {
      SyncExecutionResult(
        success = false,
        state = "Error",
        operators = Map.empty,
        compilationErrors = None,
        errors = Some(List(Option(e.getMessage).getOrElse("Unknown error")))
      )
    }
  }

  /**
    * Collect result for a single operator.
    * Uses token-based limiting: iterates through all rows using get() iterator
    * and stops when token limit is reached.
    */
  private def collectOperatorResult(
      executionId: ExecutionIdentity,
      opId: String,
      maxOperatorResultTokenLimit: Int,
      maxCellTokens: Int,
      serializationMode: String
  ): (String, Option[String], Option[Any], Option[Int], Option[Int], Option[Boolean]) = {
    try {
      val storageUriOption = WorkflowExecutionsResource.getResultUriByLogicalPortId(
        executionId,
        OperatorIdentity(opId),
        PortIdentity()
      )

      storageUriOption match {
        case Some(storageUri) =>
          val document = DocumentFactory
            .openDocument(storageUri)
            ._1
            .asInstanceOf[VirtualDocument[Tuple]]

          val totalCount = document.getCount.toInt

          // Check if limits are reasonable (avoid integer overflow)
          val shouldTruncateCells = maxCellTokens < Int.MaxValue / 4
          val shouldLimitByTokens = maxOperatorResultTokenLimit < Int.MaxValue / 4

          // Use iterator to fetch tuples with token-based limiting
          val (tuples, truncatedByTokens) = collectTuplesWithTokenLimit(
            document.get(),
            maxOperatorResultTokenLimit,
            maxCellTokens,
            shouldLimitByTokens
          )

          if (tuples.size == 1 && isVisualizationTuple(tuples.head)) {
            val jsonResults =
              ExecutionResultService.convertTuplesToJson(tuples, isVisualization = true)
            (
              "visualization",
              Some("json"),
              Some(jsonResults),
              Some(totalCount),
              Some(1),
              Some(false)
            )
          } else {
            val jsonResults = ExecutionResultService.convertTuplesToJson(tuples)

            // Apply cell truncation if needed
            val cellTruncatedResults =
              if (shouldTruncateCells) truncateCellsByTokens(jsonResults, maxCellTokens)
              else jsonResults

            val displayedRows = cellTruncatedResults.size
            val truncated = displayedRows < totalCount || truncatedByTokens

            if (serializationMode == "table") {
              val tableResult =
                jsonToTable(cellTruncatedResults, shouldTruncateCells, maxCellTokens)
              (
                "table",
                Some("table"),
                Some(tableResult),
                Some(totalCount),
                Some(displayedRows),
                Some(truncated)
              )
            } else {
              (
                "table",
                Some("json"),
                Some(cellTruncatedResults),
                Some(totalCount),
                Some(displayedRows),
                Some(truncated)
              )
            }
          }

        case None =>
          ("table", None, None, None, None, None)
      }
    } catch {
      case e: Exception =>
        logger.warn(s"Error collecting result for operator $opId: ${e.getMessage}", e)
        ("table", None, None, None, None, None)
    }
  }

  /**
    * Collect tuples from iterator with token-based limiting.
    * Estimates tokens as characters / 4.
    * Returns (collected tuples, whether truncation occurred due to token limit).
    */
  private def collectTuplesWithTokenLimit(
      iterator: Iterator[Tuple],
      maxTokens: Int,
      maxCellTokens: Int,
      shouldLimit: Boolean
  ): (List[Tuple], Boolean) = {
    if (!shouldLimit) {
      // No limit - collect all tuples
      return (iterator.toList, false)
    }

    val result = scala.collection.mutable.ListBuffer[Tuple]()
    var totalTokens = 0
    val maxCellChars = maxCellTokens * 4

    while (iterator.hasNext) {
      val tuple = iterator.next()

      // Estimate tokens for this tuple by converting to string representation
      val tupleTokens = estimateTupleTokens(tuple, maxCellChars)

      if (totalTokens + tupleTokens > maxTokens && result.nonEmpty) {
        // Token limit reached - stop collecting
        return (result.toList, true)
      }

      result += tuple
      totalTokens += tupleTokens
    }

    (result.toList, false)
  }

  /**
    * Estimate token count for a tuple.
    * Approximates tokens as characters / 4.
    */
  private def estimateTupleTokens(tuple: Tuple, maxCellChars: Int): Int = {
    var totalChars = 0
    val schema = tuple.getSchema
    for (i <- 0 until schema.getAttributes.size) {
      val fieldValue = tuple.getField[Any](i)
      val valueStr = if (fieldValue == null) "" else fieldValue.toString
      // Apply cell truncation in estimation
      val effectiveLength = Math.min(valueStr.length, maxCellChars)
      totalChars += effectiveLength + 10 // Add overhead for field name and formatting
    }
    Math.ceil(totalChars / 4.0).toInt
  }

  private def truncateCellsByTokens(
      tuples: List[ObjectNode],
      maxCellTokens: Int
  ): List[ObjectNode] = {
    import com.fasterxml.jackson.databind.ObjectMapper
    import com.fasterxml.jackson.databind.node.TextNode

    val mapper = new ObjectMapper()
    val maxChars = maxCellTokens * 4

    tuples.map { tuple =>
      val truncatedTuple = mapper.createObjectNode()
      val fieldNames = tuple.fieldNames()
      while (fieldNames.hasNext) {
        val fieldName = fieldNames.next()
        val fieldValue = tuple.get(fieldName)
        if (fieldValue.isTextual) {
          val text = fieldValue.asText()
          if (text.length > maxChars) {
            truncatedTuple.set(
              fieldName,
              new TextNode(text.substring(0, maxChars) + "...(cut off due to the token limit)")
            )
          } else {
            truncatedTuple.set(fieldName, fieldValue)
          }
        } else {
          truncatedTuple.set(fieldName, fieldValue)
        }
      }
      truncatedTuple
    }
  }

  private def jsonToTable(
      tuples: List[ObjectNode],
      shouldTruncate: Boolean,
      maxCellTokens: Int
  ): TableResult = {
    if (tuples.isEmpty) return TableResult("", List.empty)

    val maxChars = maxCellTokens * 4
    val headers = scala.collection.mutable.ArrayBuffer[String]()
    val fieldNames = tuples.head.fieldNames()
    while (fieldNames.hasNext) {
      headers += fieldNames.next()
    }

    val rows = tuples.map { tuple =>
      headers
        .map { header =>
          val fieldValue = tuple.get(header)
          val cellValue = if (fieldValue == null || fieldValue.isNull) {
            ""
          } else {
            val text = if (fieldValue.isTextual) fieldValue.asText() else fieldValue.toString
            if (shouldTruncate && text.length > maxChars) {
              text.substring(0, maxChars) + "...(cut off due to the token limit)"
            } else {
              text
            }
          }
          escapeTableCell(cellValue)
        }
        .mkString(",")
    }

    TableResult(headers.map(escapeTableCell).mkString(","), rows)
  }

  private def escapeTableCell(value: String): String = {
    if (
      value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r")
    ) {
      "\"" + value.replace("\"", "\"\"") + "\""
    } else {
      value
    }
  }

  private def isVisualizationTuple(tuple: Tuple): Boolean = {
    try {
      val schema = tuple.getSchema
      val fieldNames = schema.getAttributes.map(_.getName)
      fieldNames.exists(name => name == "html-content" || name == "json-content")
    } catch {
      case _: Exception => false
    }
  }

  private def collectConsoleLogs(
      executionId: ExecutionIdentity,
      opId: String
  ): Option[List[ConsoleMessageInfo]] = {
    try {
      val uriOption = getConsoleMessageUri(executionId, OperatorIdentity(opId))

      uriOption.flatMap { uri =>
        val document = DocumentFactory
          .openDocument(uri)
          ._1
          .asInstanceOf[VirtualDocument[Tuple]]

        val messages = document.get().toList.flatMap { tuple =>
          try {
            val protoString = tuple.getField[String](0)
            val msg = ConsoleMessage.fromAscii(protoString)
            Some(
              ConsoleMessageInfo(
                msgType = msg.msgType.name,
                title = msg.title,
                message = msg.message
              )
            )
          } catch {
            case _: Exception => None
          }
        }

        if (messages.nonEmpty) Some(messages) else None
      }
    } catch {
      case _: Exception => None
    }
  }

  private def getConsoleMessageUri(
      eid: ExecutionIdentity,
      opId: OperatorIdentity
  ): Option[URI] = {
    val context = SqlServer.getInstance().createDSLContext()
    Option(
      context
        .select(OPERATOR_EXECUTIONS.CONSOLE_MESSAGES_URI)
        .from(OPERATOR_EXECUTIONS)
        .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(eid.id.toInt))
        .and(OPERATOR_EXECUTIONS.OPERATOR_ID.eq(opId.id))
        .fetchOneInto(classOf[String])
    ).filter(uri => uri != null && uri.nonEmpty)
      .map(s => URI.create(s))
  }

  private def isTerminalState(state: WorkflowAggregatedState): Boolean = {
    state match {
      case COMPLETED | FAILED | KILLED | TERMINATED => true
      case _                                        => false
    }
  }

  /**
    * Check if any operator has logged an ERROR console message.
    */
  private def hasConsoleError(consoleState: ExecutionConsoleStore): Boolean = {
    consoleState.operatorConsole.values.exists { opConsole =>
      opConsole.consoleMessages.exists(_.msgType == ConsoleMessageType.ERROR)
    }
  }

  private def stateToString(state: WorkflowAggregatedState): String = {
    state match {
      case UNINITIALIZED => "Uninitialized"
      case READY         => "Ready"
      case RUNNING       => "Running"
      case PAUSING       => "Pausing"
      case PAUSED        => "Paused"
      case RESUMING      => "Resuming"
      case COMPLETED     => "Completed"
      case FAILED        => "Failed"
      case KILLED        => "Killed"
      case TERMINATED    => "Terminated"
      case _             => "Unknown"
    }
  }

  private def computeSubDAGIfNeeded(
      logicalPlan: LogicalPlanPojo,
      targetOperatorIds: List[String]
  ): LogicalPlanPojo = {
    if (targetOperatorIds.length != 1) {
      return logicalPlan
    }

    val targetOpId = targetOperatorIds.head
    val operatorMap: Map[String, LogicalOp] =
      logicalPlan.operators.map(op => op.operatorIdentifier.id -> op).toMap

    if (!operatorMap.contains(targetOpId)) {
      logger.warn(s"Target operator $targetOpId not found in logical plan, using full DAG")
      return logicalPlan
    }

    val incomingLinks: Map[String, List[LogicalLink]] =
      logicalPlan.links.groupBy(_.toOpId.id)

    val visited = mutable.Set[String]()
    val subDagOperators = mutable.ListBuffer[LogicalOp]()
    val subDagLinks = mutable.ListBuffer[LogicalLink]()

    def dfs(currentOpId: String): Unit = {
      if (visited.contains(currentOpId)) return
      visited.add(currentOpId)

      operatorMap.get(currentOpId).foreach { op =>
        subDagOperators += op
        incomingLinks.getOrElse(currentOpId, List.empty).foreach { link =>
          subDagLinks += link
          dfs(link.fromOpId.id)
        }
      }
    }

    dfs(targetOpId)

    LogicalPlanPojo(
      operators = subDagOperators.toList,
      links = subDagLinks.toList,
      opsToViewResult = targetOperatorIds.filter(id => visited.contains(id)),
      opsToReuseResult = logicalPlan.opsToReuseResult.filter(id => visited.contains(id))
    )
  }

  /**
    * Validate Python UDF operators for print statements.
    * Returns a map of operator ID -> error message if print statements are found,
    * or an empty map if no print statements are found.
    */
  private def validateNoPrintStatements(logicalPlan: LogicalPlanPojo): Map[String, String] = {
    import org.apache.amber.operator.PythonCodeValidator
    import org.apache.amber.operator.udf.python.PythonTableUDFOpDescV2
    import org.apache.amber.operator.udf.python.source.PythonUDFSourceOpDescV2

    val errors = mutable.Map[String, String]()

    for (op <- logicalPlan.operators) {
      // Check PythonTableUDFOpDescV2
      op match {
        case pythonTableUdf: PythonTableUDFOpDescV2 =>
          try {
            PythonCodeValidator.validateNoPrint(pythonTableUdf.code)
          } catch {
            case e: RuntimeException =>
              errors(op.operatorIdentifier.id) = e.getMessage
          }
        case pythonSource: PythonUDFSourceOpDescV2 =>
          try {
            PythonCodeValidator.validateNoPrint(pythonSource.code)
          } catch {
            case e: RuntimeException =>
              errors(op.operatorIdentifier.id) = e.getMessage
          }
        case _ => // Not a Python UDF, skip
      }
    }

    errors.toMap
  }

  /**
    * Validate workflow by attempting to compile it.
    * Returns a map of operator ID -> error message if there are compilation errors,
    * or an empty map if compilation succeeds.
    */
  private def validateWorkflow(
      workflowId: Long,
      logicalPlan: LogicalPlanPojo
  ): Map[String, String] = {
    try {
      val tempContext = new WorkflowContext(WorkflowIdentity(workflowId))
      val compiler = new WorkflowCompiler(tempContext)
      compiler.compile(logicalPlan)
      Map.empty // Compilation succeeded
    } catch {
      case e: Exception =>
        // Extract operator ID from error message if possible
        val errorMsg = Option(e.getMessage).getOrElse("Compilation failed")
        // Try to extract operator ID from the error
        val operatorIdPattern = """operator[- ]?(\S+)""".r
        val operatorId = operatorIdPattern
          .findFirstMatchIn(errorMsg.toLowerCase)
          .map(_.group(1))
          .getOrElse("workflow")
        Map(operatorId -> errorMsg)
    }
  }

  @GET
  @Path("/health")
  def healthCheck: Map[String, String] = Map("status" -> "ok")
}
