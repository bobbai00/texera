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
import org.apache.amber.core.workflow.{PortIdentity, WorkflowSettings}
import org.apache.amber.engine.architecture.rpc.controlcommands.{ConsoleMessage, ConsoleMessageType}
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.web.model.websocket.event.python.ConsoleUpdateEvent
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.OPERATOR_EXECUTIONS
import org.apache.texera.web.model.websocket.request.{LogicalPlanPojo, WorkflowExecuteRequest}
import org.apache.texera.workflow.LogicalLink
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.{ExecutionResultService, WorkflowService}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState

import java.net.URI
import java.util.concurrent.{CountDownLatch, TimeUnit}
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
    maxResultRows: Option[Int],
    maxCellTokens: Option[Int],
    serializationMode: Option[String] // "json" (default) or "csv"
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
  * Structured CSV result format for compact representation.
  * Each row is a single comma-separated string.
  */
case class CsvResult(
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
    resultFormat: Option[String], // "json" or "csv"
    result: Option[Any], // JSON array (List[ObjectNode]) or CSV structure (CsvResult)
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
  * REST API resource for synchronous (blocking) workflow execution.
  */
@Path("/execution")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class SyncExecutionResource extends LazyLogging {

  private val DEFAULT_TIMEOUT_SECONDS = 300
  private val DEFAULT_MAX_RESULT_ROWS = 200
  private val DEFAULT_MAX_CELL_TOKENS = 200

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
    val maxResultRows = request.maxResultRows.getOrElse(DEFAULT_MAX_RESULT_ROWS)
    val maxCellTokens = request.maxCellTokens.getOrElse(DEFAULT_MAX_CELL_TOKENS)
    val serializationMode = request.serializationMode.getOrElse("json")

    logger.info(s"Starting sync execution for workflow $workflowId")

    try {
      val workflowService = WorkflowService.getOrCreate(
        WorkflowIdentity(workflowId),
        computingUnitId
      )

      // Compute sub-DAG if there's exactly 1 target operator (Execute To behavior)
      val effectiveLogicalPlan =
        computeSubDAGIfNeeded(request.logicalPlan, request.targetOperatorIds)

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

      val completionLatch = new CountDownLatch(1)
      @volatile var finalState: WorkflowAggregatedState = UNINITIALIZED
      @volatile var operatorStates: Map[String, (String, Long, Long)] =
        Map.empty // opId -> (state, input, output)
      @volatile var consoleErrorDetected: Boolean = false
      @volatile var executionStarted: Boolean = false // Flag to ignore stale events
      val collectedConsoleLogs: mutable.Map[String, mutable.ListBuffer[ConsoleMessageInfo]] =
        mutable.Map.empty

      // Shutdown any previous execution's client before starting a new one.
      // This ensures clean state when executing workflows multiple times.
      try {
        val previousEs = workflowService.executionService.getValue
        if (previousEs != null && previousEs.client != null) {
          logger.info(s"Shutting down previous execution client for workflow $workflowId")
          previousEs.client.shutdown()
        }
      } catch {
        case e: Exception =>
          logger.warn(s"Error shutting down previous execution client: ${e.getMessage}")
      }

      val stateDisposable = workflowService.connectToExecution { event =>
        // Only process events after execution has actually started
        if (executionStarted) {
          event match {
            case org.apache.texera.web.model.websocket.event.WorkflowStateEvent(state) =>
              val parsedState = parseState(state)
              if (isTerminalState(parsedState)) {
                finalState = parsedState
                completionLatch.countDown()
              }
            case org.apache.texera.web.model.websocket.event.OperatorStatisticsUpdateEvent(stats) =>
              operatorStates = stats.map {
                case (opId, s) =>
                  opId -> (s.operatorState, s.aggregatedInputRowCount, s.aggregatedOutputRowCount)
              }
            case ConsoleUpdateEvent(opId, messages) =>
              // Collect console messages and detect errors
              val opLogs = collectedConsoleLogs.getOrElseUpdate(opId, mutable.ListBuffer.empty)
              var hasError = false
              messages.foreach { msg =>
                opLogs += ConsoleMessageInfo(msg.msgType.name, msg.title, msg.message)
                if (msg.msgType == ConsoleMessageType.ERROR) {
                  hasError = true
                }
              }
              // If error detected and not already triggered, kill execution
              if (hasError && !consoleErrorDetected) {
                consoleErrorDetected = true
                logger.warn(s"Console error detected in operator $opId, killing execution")
                try {
                  val es = workflowService.executionService.getValue
                  if (es != null) {
                    // Properly kill execution: shutdown client and update state stores
                    if (es.client != null) {
                      es.client.shutdown()
                    }
                    es.executionStateStore.statsStore.updateState(stats =>
                      stats.withEndTimeStamp(System.currentTimeMillis())
                    )
                    es.executionStateStore.metadataStore.updateState(metadataStore =>
                      updateWorkflowState(KILLED, metadataStore)
                    )
                  }
                } catch {
                  case e: Exception =>
                    logger.warn(
                      s"Error shutting down execution after console error: ${e.getMessage}"
                    )
                }
                finalState = KILLED
                completionLatch.countDown()
              }
            case _ =>
          }
        }
      }

      try {
        workflowService.initExecutionService(
          executeRequest,
          Some(user.getUser),
          new URI(s"sync-execution://$workflowId")
        )

        // Check if workflow already failed during initialization (e.g., compilation errors)
        // This handles cases where errors occur before the workflow actually starts running
        val es = workflowService.executionService.getValue
        if (es != null) {
          val currentState = es.executionStateStore.metadataStore.getState.state
          if (isTerminalState(currentState)) {
            // Workflow already failed during initialization - return immediately
            val fatalErrors = es.executionStateStore.metadataStore.getState.fatalErrors
              .map(err => s"${err.`type`}: ${err.message}")
              .toList

            // Include console logs if available
            val consoleLogs = collectedConsoleLogs.toMap.map {
              case (opId, logs) => opId -> logs.toList
            }

            return SyncExecutionResult(
              success = false,
              state = stateToString(currentState),
              operators = consoleLogs.map {
                case (opId, logs) =>
                  opId -> OperatorInfo(
                    state = "Failed",
                    inputTuples = 0L,
                    outputTuples = 0L,
                    resultMode = "table",
                    resultFormat = None,
                    result = None,
                    totalRowCount = None,
                    displayedRows = None,
                    truncated = None,
                    consoleLogs = Some(logs),
                    error = logs
                      .find(_.msgType == "ERROR")
                      .map(e => if (e.message.nonEmpty) s"${e.title}: ${e.message}" else e.title)
                  )
              },
              compilationErrors = None,
              errors = if (fatalErrors.nonEmpty) Some(fatalErrors) else None
            )
          }
        }

        // Mark execution as started - events before this point are ignored
        executionStarted = true

        val completed = completionLatch.await(timeoutSeconds, TimeUnit.SECONDS)

        if (!completed) {
          // Properly kill execution on timeout: shutdown client and update state stores
          try {
            val es = workflowService.executionService.getValue
            if (es != null) {
              if (es.client != null) {
                es.client.shutdown()
              }
              es.executionStateStore.statsStore.updateState(stats =>
                stats.withEndTimeStamp(System.currentTimeMillis())
              )
              es.executionStateStore.metadataStore.updateState(metadataStore =>
                updateWorkflowState(KILLED, metadataStore)
              )
            }
          } catch { case _: Exception => }

          return SyncExecutionResult(
            success = false,
            state = "Killed",
            operators = Map.empty,
            compilationErrors = None,
            errors = Some(List(s"Timeout after $timeoutSeconds seconds"))
          )
        }

        val executionService = workflowService.executionService.getValue
        val executionId = executionService.workflowContext.executionId

        // Wait a bit for results to be persisted to the database
        // TODO: remove this delay after fixing the issue of reporting "completed" status too early
        Thread.sleep(1000)

        // Build per-operator info
        val operatorInfos = mutable.Map[String, OperatorInfo]()
        val targetOps = if (request.targetOperatorIds.nonEmpty) {
          request.targetOperatorIds
        } else {
          // Include operators from states and any that have console logs
          (operatorStates.keys ++ collectedConsoleLogs.keys).toList.distinct
        }

        logger.info(
          s"Target operators: $targetOps, operatorStates keys: ${operatorStates.keys.toList}"
        )

        for (opId <- targetOps) {
          val (state, inputTuples, outputTuples) =
            operatorStates.getOrElse(opId, ("Unknown", 0L, 0L))

          // Get result
          val (resultMode, resultFormat, result, totalRowCount, displayedRows, truncated) =
            collectOperatorResult(
              executionId,
              opId,
              maxResultRows,
              maxCellTokens,
              serializationMode
            )

          // Get console logs - prefer real-time collected logs, fall back to database
          val consoleLogs = collectedConsoleLogs.get(opId) match {
            case Some(logs) if logs.nonEmpty => Some(logs.toList)
            case _                           => collectConsoleLogs(executionId, opId)
          }

          // Check for error in this operator's console logs
          val hasConsoleError = consoleLogs.exists(_.exists(_.msgType == "ERROR"))
          val errorMsg = if (hasConsoleError) {
            consoleLogs.flatMap(
              _.find(_.msgType == "ERROR").map(e =>
                if (e.message.nonEmpty) s"${e.title}: ${e.message}" else e.title
              )
            )
          } else None

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

        // Collect fatal errors (console errors are already in operator consoleLogs)
        val fatalErrors = executionService.executionStateStore.metadataStore.getState.fatalErrors
          .map(err => s"${err.`type`}: ${err.message}")
          .toList

        SyncExecutionResult(
          success = finalState == COMPLETED && !consoleErrorDetected,
          state = stateToString(finalState),
          operators = operatorInfos.toMap,
          compilationErrors = None,
          errors = if (fatalErrors.nonEmpty) Some(fatalErrors) else None
        )

      } finally {
        stateDisposable.dispose()
        workflowService.disconnect()
      }

    } catch {
      case e: Exception =>
        logger.error(s"Sync execution error: ${e.getMessage}", e)

        // Check if this is a compilation error
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
            errors = Some(List(e.getMessage))
          )
        }
    }
  }

  /**
    * Collect result for a single operator.
    * Returns (mode, resultFormat, result, totalRowCount, displayedRows, truncated).
    */
  private def collectOperatorResult(
      executionId: ExecutionIdentity,
      opId: String,
      maxRows: Int,
      maxCellTokens: Int,
      serializationMode: String
  ): (String, Option[String], Option[Any], Option[Int], Option[Int], Option[Boolean]) = {
    try {
      logger.debug(s"Collecting result for operator $opId, execution ${executionId.id}")

      val storageUriOption = WorkflowExecutionsResource.getResultUriByLogicalPortId(
        executionId,
        OperatorIdentity(opId),
        PortIdentity()
      )

      logger.debug(s"Storage URI for $opId: $storageUriOption")

      storageUriOption match {
        case Some(storageUri) =>
          val document = DocumentFactory
            .openDocument(storageUri)
            ._1
            .asInstanceOf[VirtualDocument[Tuple]]

          val totalCount = document.getCount.toInt
          val fetchCount = Math.min(maxRows, totalCount)
          val tuples = document.getRange(0, fetchCount).toList
          val displayedRows = tuples.size
          val truncated = displayedRows < totalCount

          if (tuples.size == 1 && isVisualizationTuple(tuples.head)) {
            // It's a visualization - extract the JSON content (always JSON format)
            val jsonResults =
              ExecutionResultService.convertTuplesToJson(tuples, isVisualization = true)
            (
              "visualization",
              Some("json"),
              Some(jsonResults),
              Some(totalCount),
              Some(displayedRows),
              Some(truncated)
            )
          } else {
            // Regular table result
            val jsonResults = ExecutionResultService.convertTuplesToJson(tuples)
            val truncatedResults = truncateCellsByTokens(jsonResults, maxCellTokens)

            if (serializationMode == "csv") {
              // CSV mode: structured format with header and rows
              val csvResult = jsonToCsv(truncatedResults, maxCellTokens)
              (
                "table",
                Some("csv"),
                Some(csvResult),
                Some(totalCount),
                Some(displayedRows),
                Some(truncated)
              )
            } else {
              // JSON mode (default)
              (
                "table",
                Some("json"),
                Some(truncatedResults),
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
        logger.warn(s"Error collecting result for $opId: ${e.getMessage}")
        ("table", None, None, None, None, None)
    }
  }

  /**
    * Truncate individual cells (fields) based on estimated token count.
    * Uses approximate 4 characters per token heuristic.
    */
  private def truncateCellsByTokens(
      tuples: List[ObjectNode],
      maxCellTokens: Int
  ): List[ObjectNode] = {
    import com.fasterxml.jackson.databind.ObjectMapper
    import com.fasterxml.jackson.databind.node.TextNode

    val mapper = new ObjectMapper()
    val maxChars = maxCellTokens * 4 // Approximate 4 chars per token

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
              new TextNode(text.substring(0, maxChars) + "...[truncated]")
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

  /**
    * Convert JSON tuples to structured CSV format.
    * Returns CsvResult with header as comma-separated string and rows as list of comma-separated strings.
    */
  private def jsonToCsv(tuples: List[ObjectNode], maxCellTokens: Int): CsvResult = {
    if (tuples.isEmpty) return CsvResult("", List.empty)

    val maxChars = maxCellTokens * 4

    // Get headers from first tuple
    val headers = scala.collection.mutable.ArrayBuffer[String]()
    val fieldNames = tuples.head.fieldNames()
    while (fieldNames.hasNext) {
      headers += fieldNames.next()
    }

    // Build data rows - each row is a single comma-separated string
    val rows = tuples.map { tuple =>
      headers
        .map { header =>
          val fieldValue = tuple.get(header)
          val cellValue = if (fieldValue == null || fieldValue.isNull) {
            ""
          } else {
            val text = if (fieldValue.isTextual) {
              fieldValue.asText()
            } else {
              fieldValue.toString
            }
            // Truncate if needed
            if (text.length > maxChars) {
              text.substring(0, maxChars) + "...[truncated]"
            } else {
              text
            }
          }
          // Escape CSV: wrap in quotes if contains comma, newline, or quote; escape internal quotes
          escapeCsvCell(cellValue)
        }
        .mkString(",")
    }

    CsvResult(headers.map(escapeCsvCell).mkString(","), rows)
  }

  /**
    * Escape a cell value for CSV format.
    * Wraps in quotes if contains comma, newline, or quote; doubles internal quotes.
    */
  private def escapeCsvCell(value: String): String = {
    if (
      value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r")
    ) {
      "\"" + value.replace("\"", "\"\"") + "\""
    } else {
      value
    }
  }

  /**
    * Check if a tuple is a visualization result (contains html-content or json-content).
    */
  private def isVisualizationTuple(tuple: Tuple): Boolean = {
    try {
      val schema = tuple.getSchema
      val fieldNames = schema.getAttributes.map(_.getName)
      fieldNames.exists(name => name == "html-content" || name == "json-content")
    } catch {
      case _: Exception => false
    }
  }

  /**
    * Collect console logs for an operator.
    */
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

  private def parseState(stateStr: String): WorkflowAggregatedState = {
    stateStr.toUpperCase match {
      case "UNINITIALIZED" => UNINITIALIZED
      case "READY"         => READY
      case "RUNNING"       => RUNNING
      case "PAUSING"       => PAUSING
      case "PAUSED"        => PAUSED
      case "RESUMING"      => RESUMING
      case "RECOVERING"    => RUNNING
      case "COMPLETED"     => COMPLETED
      case "FAILED"        => FAILED
      case "KILLED"        => KILLED
      case "TERMINATED"    => TERMINATED
      case _               => UNINITIALIZED
    }
  }

  private def isTerminalState(state: WorkflowAggregatedState): Boolean = {
    state match {
      case COMPLETED | FAILED | KILLED | TERMINATED => true
      case _                                        => false
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

  /**
    * Compute a sub-DAG from the logical plan by starting from the target operator
    * and traversing backwards through incoming links.
    *
    * Execute To behavior:
    * - If targetOperatorIds has exactly 1 operator: execute only the sub-DAG up to that operator
    * - Otherwise: execute the full DAG and collect results from specified operators
    *
    * @param logicalPlan The original logical plan
    * @param targetOperatorIds The list of target operator IDs
    * @return Modified LogicalPlanPojo with sub-DAG if applicable
    */
  private def computeSubDAGIfNeeded(
      logicalPlan: LogicalPlanPojo,
      targetOperatorIds: List[String]
  ): LogicalPlanPojo = {
    // Only compute sub-DAG when there's exactly 1 target operator
    if (targetOperatorIds.length != 1) {
      return logicalPlan
    }

    val targetOpId = targetOperatorIds.head

    // Build operator ID to operator mapping
    val operatorMap: Map[String, LogicalOp] =
      logicalPlan.operators.map(op => op.operatorIdentifier.id -> op).toMap

    // Check if target operator exists
    if (!operatorMap.contains(targetOpId)) {
      logger.warn(s"Target operator $targetOpId not found in logical plan, using full DAG")
      return logicalPlan
    }

    // Build adjacency list for reverse traversal (incoming links per operator)
    val incomingLinks: Map[String, List[LogicalLink]] =
      logicalPlan.links.groupBy(_.toOpId.id)

    // DFS to collect all operators in the sub-DAG
    val visited = mutable.Set[String]()
    val subDagOperators = mutable.ListBuffer[LogicalOp]()
    val subDagLinks = mutable.ListBuffer[LogicalLink]()

    def dfs(currentOpId: String): Unit = {
      if (visited.contains(currentOpId)) return
      visited.add(currentOpId)

      operatorMap.get(currentOpId).foreach { op =>
        subDagOperators += op

        // Find incoming links to this operator
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

  @GET
  @Path("/health")
  def healthCheck: Map[String, String] = Map("status" -> "ok")
}
