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

package org.apache.texera.web.execution

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.google.protobuf.timestamp.Timestamp
import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionLayout,
  ExecutionLayouts,
  VFSURIFactory
}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.{Attribute, Tuple}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{PortIdentity, WorkflowContext, WorkflowSettings}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  TERMINATED
}
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionConsoleStore,
  ExecutionMetadataStore,
  ExecutionStatsStore,
  OperatorStatistics
}
import org.apache.texera.amber.operator.metadata.{AllOperatorMetadata, OperatorMetadataGenerator}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.web.auth.{UnitIdentity, UnitPrincipal}
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{CompilationErrorHandling, WorkflowCompiler}
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.web.model.websocket.request.{
  TexeraWebSocketRequest,
  WorkflowExecuteRequest,
  WorkflowPauseRequest,
  WorkflowResumeRequest
}
import org.apache.texera.web.service.{ExecutionResultService, WorkflowService}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState

import java.net.URI
import java.util.concurrent.TimeUnit
import javax.annotation.security.RolesAllowed
import javax.ws.rs._
import javax.ws.rs.core.{MediaType, Response}
import scala.collection.concurrent.TrieMap
import scala.jdk.CollectionConverters._

// ---- contract types (api/engine.tsp) ----

@JsonIgnoreProperties(ignoreUnknown = true)
case class WorkflowRef(rid: String, vno: Int)

@JsonIgnoreProperties(ignoreUnknown = true)
case class ResolvedInput(
    dataset: String,
    vno: Int,
    path: String,
    url: String,
    sizeBytes: Option[Long]
)

/** The Python packages a unit adds to its runtime, under the key the catalog derives from them. */
@JsonIgnoreProperties(ignoreUnknown = true)
case class EnvironmentRequest(key: String, packages: List[String])

@JsonIgnoreProperties(ignoreUnknown = true)
case class OutputTable(opid: String, port: String, table: String)

/**
  * Where an execution stores what it writes: the warehouse, by its name in the lake catalog,
  * the namespace the catalog made for the execution in it, and the tables of the output ports.
  */
@JsonIgnoreProperties(ignoreUnknown = true)
case class ResultStore(
    warehouse: String,
    namespace: String,
    tables: Option[List[OutputTable]]
) {

  /** The layout the catalog asks for: the namespace and the named external output ports. */
  def layout: ExecutionLayout =
    ExecutionLayout(
      namespace,
      tables
        .getOrElse(Nil)
        .flatMap { t =>
          t.port.stripPrefix("output-").toIntOption.map(port => (t.opid, port) -> t.table)
        }
        .toMap
    )
}

@JsonIgnoreProperties(ignoreUnknown = true)
case class Reporting(lineageUrl: String)

@JsonIgnoreProperties(ignoreUnknown = true)
case class ExecutionStartRequest(
    eid: String,
    workflow: WorkflowRef,
    name: Option[String],
    logicalPlan: JsonNode,
    inputs: Option[List[ResolvedInput]],
    environment: Option[EnvironmentRequest],
    resultStore: Option[ResultStore],
    reporting: Reporting,
    actor: String,
    onBehalfOf: Option[String],
    parameters: Option[JsonNode]
)

case class ExecutionAck(eid: String, accepted: Boolean)

case class OperatorRun(
    state: String,
    rowsIn: Option[Long],
    rowsOut: Option[Long],
    error: Option[JsonNode]
)

/** Rows an operator has read and put out so far, over all its ports. */
final case class OperatorRows(in: Long, out: Long)

object OperatorRows {
  def of(statistics: OperatorStatistics): OperatorRows =
    OperatorRows(
      statistics.inputMetrics.map(_.tupleMetrics.count).sum,
      statistics.outputMetrics.map(_.tupleMetrics.count).sum
    )
}

case class PortResult(
    opid: String,
    port: String,
    table: Option[String],
    tupleCount: Option[Long],
    bytes: Option[Long]
)

case class ExecutionState(
    eid: String,
    status: String,
    operators: Map[String, OperatorRun],
    results: List[PortResult],
    error: Option[JsonNode]
)

@JsonIgnoreProperties(ignoreUnknown = true)
case class EngineCompileRequest(logicalPlan: JsonNode)

case class CompileAttribute(attributeName: String, attributeType: String)

case class CompileResult(
    ok: Boolean,
    operatorOutputSchemas: Map[String, Map[String, Option[List[CompileAttribute]]]],
    operatorErrors: Map[String, JsonNode],
    physicalPlan: Option[JsonNode]
)

case class RowPage(
    schema: List[CompileAttribute],
    rows: List[List[JsonNode]],
    offset: Long,
    total: Option[Long]
)

case class EnvironmentBuild(
    key: String,
    status: String,
    message: Option[String],
    installed: Option[List[String]]
)

case class UnitHealth(status: String, version: Option[String])

/** api/common.tsp OperatorType: one registry entry, with its properties' JSON Schema. */
case class OperatorType(
    operatorType: String,
    userFriendlyName: String,
    operatorGroupName: String,
    operatorDescription: Option[String],
    jsonSchema: JsonNode,
    inputPorts: List[JsonNode],
    outputPorts: List[JsonNode],
    version: Option[String]
)

case class OperatorTypeList(operators: List[OperatorType], groups: List[JsonNode])

/** One running execution the unit API started. */
final case class RunHandle(
    externalEid: String,
    workflowService: WorkflowService,
    internalEid: ExecutionIdentity,
    plan: LogicalPlanPojo
)

object UnitApiResource {
  val runs = new TrieMap[String, RunHandle]()

  /** The engine's operators that run Python besides the UDFs: a function, a model version. */
  val PythonRunners: Set[String] = Set("function", "predict")

  /** Points every operator of the plan that runs Python at the built environment. */
  def applyEnvironment(plan: JsonNode, envName: String): Unit = {
    val operators = plan.get("operators")
    if (operators == null || !operators.isArray) return
    operators.elements().asScala.foreach {
      case op: ObjectNode =>
        val opType = Option(op.get("operatorType")).map(_.asText()).getOrElse("")
        val udf = opType.contains("PythonUDF")
        if (udf || PythonRunners(opType) || op.has("envName")) {
          // Only the UDFs have a switch to their default environment; the others take the name
          // alone, and a property an operator does not have makes the plan unreadable.
          if (udf || op.has("defaultEnv")) op.put("defaultEnv", false)
          op.put("envName", envName)
        }
      case _ =>
    }
  }

  /** Execution ids a start has claimed; claiming is atomic, so one id never starts twice. */
  private val claimed = new TrieMap[String, Unit]()
  private[execution] def claim(eid: String): Boolean = claimed.putIfAbsent(eid, ()).isEmpty
  val UNIT_ID = 0

  /**
    * The warehouse a request names, by its name in the lake catalog. Absent or empty is the
    * unit's configured default warehouse. A name the storage layer cannot carry is refused:
    * it must never turn into the default.
    */
  def warehouseNamed(name: String): Option[String] =
    Option(name).filter(_.nonEmpty).map { named =>
      if (!VFSURIFactory.isValidWarehouseName(named)) {
        throw new WebApplicationException(
          s"'$named' names no warehouse",
          Response.Status.BAD_REQUEST
        )
      }
      named
    }

  /** The one column of what a visualization operator draws: the page, as HTML. */
  val VisualizationColumn = "html-content"

  /**
    * Whether a result is the page a visualization operator drew: its one column holds it.
    */
  def isVisualization(attributes: List[Attribute]): Boolean =
    attributes.size == 1 && attributes.head.getName == VisualizationColumn

  /**
    * A page of rows as the contract serves them, in the order of the columns. A long string
    * is cut for a table's cell; a visualization's page is served whole, since cut it is no
    * page to show.
    */
  def rowsOf(tuples: List[Tuple], attributes: List[Attribute]): List[List[JsonNode]] =
    ExecutionResultService
      .convertTuplesToJson(tuples, isVisualization(attributes))
      .map(node =>
        attributes.map(a =>
          Option(node.get(a.getName)).getOrElse(objectMapper.nullNode()): JsonNode
        )
      )

  /**
    * Where a port's result is, as the catalog knows it: `namespace.table` when the catalog
    * named the table, else the engine's own URI (a run started without a layout).
    */
  def tableIdentifier(eid: ExecutionIdentity, uri: URI): String = {
    val components = VFSURIFactory.decodeURI(uri)
    ExecutionLayouts
      .lookup(eid)
      .flatMap(layout =>
        components.globalPortId.flatMap(layout.tableOf).map(t => s"${layout.namespace}.$t")
      )
      .getOrElse(uri.toString)
  }

  /** A stable engine workflow id for a catalog rid. */
  def workflowIdOf(rid: String): Long = EngineIds.of(rid)

  def statusOf(state: WorkflowAggregatedState): String =
    state match {
      case COMPLETED                                                             => "completed"
      case FAILED                                                                => "failed"
      case KILLED | TERMINATED                                                   => "cancelled"
      case WorkflowAggregatedState.UNINITIALIZED | WorkflowAggregatedState.READY => "pending"
      case WorkflowAggregatedState.PAUSED                                        => "paused"
      case _                                                                     => "running"
    }

  /**
    * An operator's state once its run is over: no operator is still going. Its own last state
    * when that is final; a state the run's statistics had not caught up with yet is said as the
    * run ended it: completed when the run completed (every operator of a completed run
    * completed), failed for the operator the run failed on, killed for any other.
    */
  def settledState(
      last: WorkflowAggregatedState,
      run: WorkflowAggregatedState,
      failed: Boolean
  ): WorkflowAggregatedState =
    last match {
      case COMPLETED | FAILED | KILLED | TERMINATED => last
      case _ if run == COMPLETED                    => COMPLETED
      case _ if failed                              => FAILED
      case _                                        => KILLED
    }

  /**
    * What the unit reports as its engine: the release and a digest of its operator registry, so a
    * unit whose operators changed is told apart and the catalog takes its operators again.
    */
  lazy val engineVersion: String = {
    val digest = java.security.MessageDigest
      .getInstance("SHA-256")
      .digest(objectMapper.writeValueAsBytes(operatorRegistry))
    "2.0.0-alpha+" + digest.take(6).map("%02x".format(_)).mkString
  }

  /** The operator registry in the contract's shape, computed once. */
  lazy val operatorRegistry: OperatorTypeList = toOperatorTypeList(
    OperatorMetadataGenerator.allOperatorMetadata
  )

  def toOperatorTypeList(all: AllOperatorMetadata): OperatorTypeList =
    OperatorTypeList(
      all.operators.map { m =>
        val info = m.additionalMetadata
        OperatorType(
          operatorType = m.operatorType,
          userFriendlyName = info.userFriendlyName,
          operatorGroupName = info.operatorGroupName,
          operatorDescription = Option(info.operatorDescription).filter(_.nonEmpty),
          jsonSchema = m.jsonSchema,
          inputPorts = info.inputPorts.map(p => objectMapper.valueToTree[JsonNode](p)),
          outputPorts = info.outputPorts.map(p => objectMapper.valueToTree[JsonNode](p)),
          version = Option(m.operatorVersion)
        )
      },
      all.groups.map(g => objectMapper.valueToTree[JsonNode](g))
    )

  /** api/engine.tsp EnvironmentBuild: an environment's state, the packages once built. */
  def environmentBuild(key: String, status: EnvironmentManager.Status): EnvironmentBuild =
    status match {
      case EnvironmentManager.Ready(installed) =>
        EnvironmentBuild(key, "ready", None, Some(installed))
      case EnvironmentManager.Building => EnvironmentBuild(key, "building", None, None)
      case EnvironmentManager.Failed(message) =>
        EnvironmentBuild(key, "failed", Some(message), None)
    }

  def isTerminal(state: WorkflowAggregatedState): Boolean =
    state == COMPLETED || state == FAILED || state == KILLED || state == TERMINATED

  /** The first error an operator's console holds, with the operator it came from. */
  def firstOperatorError(console: ExecutionConsoleStore): Option[(String, ConsoleMessage)] =
    console.operatorConsole.iterator
      .flatMap {
        case (opid, operator) =>
          operator.consoleMessages.find(_.msgType == ConsoleMessageType.ERROR).map(opid -> _)
      }
      .nextOption()

  /** An operator's error as the run's fatal error, in the operator's own words. */
  def fatalErrorOf(opid: String, error: ConsoleMessage): WorkflowFatalError =
    WorkflowFatalError(
      EXECUTION_FAILURE,
      Timestamp(error.timestamp.seconds, error.timestamp.nanos),
      error.title,
      error.message,
      opid,
      error.workerId
    )
}

/**
  * The unit API (api/engine.tsp): the catalog starts executions here with self-contained
  * requests and the unit reports back through OpenLineage events. The unit keeps no catalog
  * state; see [[ExecutionRegistry]].
  */
@Path("/")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class UnitApiResource extends LazyLogging {
  import UnitApiResource._

  @GET
  @Path("/health")
  def health(): UnitHealth = UnitHealth("ok", Some(engineVersion))

  @GET
  @Path("/operators")
  @RolesAllowed(Array("SERVICE"))
  def operators(): OperatorTypeList = UnitApiResource.operatorRegistry

  @POST
  @Path("/compile")
  @RolesAllowed(Array("SERVICE"))
  def compile(request: EngineCompileRequest): CompileResult = {
    val plan = objectMapper.treeToValue(request.logicalPlan, classOf[LogicalPlanPojo])
    val context = new WorkflowContext(workflowId = WorkflowIdentity(0))
    val result = new WorkflowCompiler(context).compile(plan, CompilationErrorHandling.Lenient)
    val schemas = result.operatorIdToOutputSchemas.map {
      case (opId, ports) =>
        opId.id -> ports.map {
          case (portId, schemaOpt) =>
            val attrs = schemaOpt
              .flatMap(Option(_))
              .map(_.getAttributes.map(a => CompileAttribute(a.getName, a.getType.toString)).toList)
            s"output-${portId.id}" -> attrs
        }
    }
    val errors = result.operatorIdToError.map {
      case (opId, err) => opId.id -> objectMapper.valueToTree[JsonNode](err)
    }
    val ok = errors.isEmpty && result.physicalPlan.nonEmpty
    CompileResult(ok, schemas, errors, None)
  }

  @POST
  @Path("/environments")
  @RolesAllowed(Array("SERVICE"))
  def buildEnvironment(request: EnvironmentRequest): EnvironmentBuild =
    UnitApiResource.environmentBuild(
      request.key,
      EnvironmentManager.ensure(request.key, request.packages)
    )

  @GET
  @Path("/environments/{key}")
  @RolesAllowed(Array("SERVICE"))
  def environmentStatus(@PathParam("key") key: String): EnvironmentBuild =
    EnvironmentManager.status(key) match {
      case Some(status) => UnitApiResource.environmentBuild(key, status)
      case None         => throw new WebApplicationException(Response.Status.NOT_FOUND)
    }

  @POST
  @Path("/executions")
  @RolesAllowed(Array("SERVICE"))
  def start(request: ExecutionStartRequest, @Auth user: UnitPrincipal): ExecutionAck = {
    // Where the run stores everything it writes: the warehouse the catalog named. Checked
    // before the execution is claimed, so a request that cannot run touches nothing.
    val warehouse = request.resultStore.flatMap(store => warehouseNamed(store.warehouse))
    // A repeated start (a retry after a timeout, say) must not touch the run already going.
    if (!UnitApiResource.claim(request.eid)) {
      throw new WebApplicationException(
        s"execution ${request.eid} already started",
        Response.Status.CONFLICT
      )
    }
    val reporter =
      new LineageReporter(request.reporting.lineageUrl, () => UnitIdentity.token(), request.eid)
    // The unit's packages: build (or confirm) their venv and point every operator that runs
    // Python at it.
    val planNode = request.logicalPlan.deepCopy[JsonNode]()
    request.environment.foreach { env =>
      EnvironmentManager.ensure(env.key, env.packages) match {
        case EnvironmentManager.Failed(message) =>
          reporter.runStatus("failed", Some(s"installing ${env.packages.mkString(", ")}: $message"))
          reporter.close()
          throw new WebApplicationException(
            s"environment build failed: $message",
            Response.Status.BAD_REQUEST
          )
        case _ => UnitApiResource.applyEnvironment(planNode, env.key)
      }
    }
    val plan = objectMapper.treeToValue(planNode, classOf[LogicalPlanPojo])
    // Every table of the run goes into the namespace the catalog made for it in that
    // warehouse, the output ports under the names it chose, registered before the first
    // worker can write.
    request.resultStore.foreach(store =>
      ExecutionLayouts.register(ExecutionIdentity(EngineIds.of(request.eid)), store.layout)
    )
    val workflowService =
      WorkflowService.getOrCreate(WorkflowIdentity(workflowIdOf(request.workflow.rid)), UNIT_ID)
    // One execution at a time per workflow on this unit.
    Option(workflowService.executionService.getValue).foreach { previous =>
      if (previous.client != null) previous.client.shutdown()
    }
    val executeRequest = WorkflowExecuteRequest(
      executionName = request.name.getOrElse(""),
      engineVersion = "2.0",
      logicalPlan = plan,
      replayFromExecution = None,
      workflowSettings =
        WorkflowSettings(dataTransferBatchSize = ApplicationConfig.defaultDataTransferBatchSize),
      emailNotificationEnabled = false,
      computingUnitId = UNIT_ID,
      warehouse = warehouse,
      externalExecutionId = Some(request.eid)
    )
    reporter.runStatus("running", None)
    try {
      workflowService.initExecutionService(
        executeRequest,
        Some(user),
        new URI(s"unit://${request.eid}")
      )
    } catch {
      case e: Exception =>
        reporter.runStatus("failed", Some(Option(e.getMessage).getOrElse(e.toString)))
        reporter.close()
        throw new WebApplicationException(e.getMessage, Response.Status.BAD_REQUEST)
    }
    val executionService = workflowService.executionService.getValue
    if (executionService == null) {
      reporter.runStatus("failed", Some("the execution service did not start"))
      reporter.close()
      throw new WebApplicationException(
        "the execution service did not start",
        Response.Status.INTERNAL_SERVER_ERROR
      )
    }
    val handle =
      RunHandle(request.eid, workflowService, executionService.workflowContext.executionId, plan)
    runs.put(request.eid, handle)

    @volatile var reported = false
    // Progress while the run goes, for the catalog's watchers: every operator's state and
    // count about once a second, and the run's own state when it pauses or resumes. The
    // terminal report below is the last word, so nothing is reported past it.
    def reportProgress(stats: ExecutionStatsStore): Unit =
      synchronized {
        if (reported) return
        stats.operatorInfo.foreach {
          case (opid, m) =>
            reporter.operator(
              opid,
              Utils.aggregatedStateToString(m.operatorState),
              Some(OperatorRows.of(m.operatorStatistics)),
              None,
              Seq.empty,
              Seq.empty,
              terminal = false
            )
        }
      }
    var lastStatus = "running"
    def reportTransition(state: ExecutionMetadataStore): Unit =
      synchronized {
        val status = statusOf(state.state)
        if (!reported && status != lastStatus && (status == "running" || status == "paused")) {
          lastStatus = status
          reporter.runStatus(status, None)
        }
      }
    val progress = executionService.executionStateStore.statsStore.getStateObservable
      .sample(1, TimeUnit.SECONDS)
      .subscribe((stats: ExecutionStatsStore) => reportProgress(stats))
    val transitions = executionService.executionStateStore.metadataStore.getStateObservable
      .subscribe((state: ExecutionMetadataStore) => reportTransition(state))
    def reportTerminal(state: ExecutionMetadataStore): Unit =
      synchronized {
        if (reported) return
        reported = true
        progress.dispose()
        transitions.dispose()
        val stats = executionService.executionStateStore.statsStore.getState
        val record = ExecutionRegistry.get(handle.internalEid)
        plan.operators.foreach { op =>
          val opid = op.operatorIdentifier.id
          val metrics = stats.operatorInfo.get(opid)
          val opError = state.fatalErrors.find(_.operatorId == opid).map(_.message)
          val opState = Utils.aggregatedStateToString(
            UnitApiResource.settledState(
              metrics.map(_.operatorState).getOrElse(WorkflowAggregatedState.UNINITIALIZED),
              state.state,
              opError.isDefined
            )
          )
          val rows = metrics.map(m => OperatorRows.of(m.operatorStatistics))
          val outputs = record.toList.flatMap(_.portResults.toList).flatMap {
            case (globalPortId, uri) =>
              val components = org.apache.texera.amber.core.storage.VFSURIFactory.decodeURI(uri)
              components.globalPortId
                .filter(g => g.opId.logicalOpId.id == opid && !g.portId.internal)
                .map { g =>
                  val port = s"output-${g.portId.id}"
                  val count = metrics.flatMap(
                    _.operatorStatistics.outputMetrics
                      .find(_.portId == g.portId)
                      .map(_.tupleMetrics.count)
                  )
                  reporter.OutputPort(
                    port,
                    Some(UnitApiResource.tableIdentifier(handle.internalEid, uri)),
                    count,
                    record.flatMap(_.resultSize(globalPortId))
                  )
                }
          }
          val inputs = plan.links
            .filter(_.toOpId.id == opid)
            .map(l => reporter.PortRef(l.fromOpId.id, s"output-${l.fromPortId.id}"))
          reporter.operator(opid, opState, rows, opError, outputs, inputs, terminal = true)
        }
        val error = state.fatalErrors.headOption.map(e => s"${e.message}\n${e.details}".trim)
        reporter.runStatus(statusOf(state.state), error)
        reporter.close()
      }
    // The state stream is hot; diff handlers only run while a WebSocket client listens, so the
    // reporter subscribes to the stream itself.
    executionService.executionStateStore.metadataStore.getStateObservable
      .filter((state: ExecutionMetadataStore) => isTerminal(state.state))
      .firstElement()
      .subscribe((state: ExecutionMetadataStore) => reportTerminal(state))
    val current = executionService.executionStateStore.metadataStore.getState
    if (isTerminal(current.state)) reportTerminal(current)
    // A Python operator that raises pauses its worker for an interactive console nobody attends
    // here, and the run would wait forever without saying why. It fails instead, in the operator's
    // own words, the way a fatal error ends a run.
    def failOnOperatorError(console: ExecutionConsoleStore): Unit =
      synchronized {
        val stateStore = executionService.executionStateStore
        firstOperatorError(console)
          .filterNot(_ => isTerminal(stateStore.metadataStore.getState.state))
          .foreach {
            case (opid, error) =>
              logger.warn(s"execution ${request.eid}: operator $opid failed: ${error.title}")
              if (executionService.client != null) executionService.client.shutdown()
              stateStore.statsStore.updateState(s => s.withEndTimeStamp(System.currentTimeMillis()))
              stateStore.metadataStore.updateState(m =>
                updateWorkflowState(FAILED, m).addFatalErrors(fatalErrorOf(opid, error))
              )
          }
      }
    executionService.executionStateStore.consoleStore.getStateObservable
      .filter((console: ExecutionConsoleStore) => firstOperatorError(console).isDefined)
      .firstElement()
      .subscribe((console: ExecutionConsoleStore) => failOnOperatorError(console))
    failOnOperatorError(executionService.executionStateStore.consoleStore.getState)
    ExecutionAck(request.eid, accepted = true)
  }

  private def handleOf(eid: String): RunHandle =
    runs.getOrElse(
      eid,
      throw new WebApplicationException(s"unknown execution $eid", Response.Status.NOT_FOUND)
    )

  @GET
  @Path("/executions/{eid}")
  @RolesAllowed(Array("SERVICE"))
  def status(@PathParam("eid") eid: String): ExecutionState = {
    val handle = handleOf(eid)
    val executionService = handle.workflowService.executionService.getValue
    val meta = executionService.executionStateStore.metadataStore.getState
    val stats = executionService.executionStateStore.statsStore.getState
    val operators = stats.operatorInfo.map {
      case (opid, m) =>
        val rows = OperatorRows.of(m.operatorStatistics)
        opid -> OperatorRun(
          Utils.aggregatedStateToString(m.operatorState),
          Some(rows.in),
          Some(rows.out),
          None
        )
    }
    val results =
      ExecutionRegistry.get(handle.internalEid).toList.flatMap(_.portResults.toList).flatMap {
        case (_, uri) =>
          val c = org.apache.texera.amber.core.storage.VFSURIFactory.decodeURI(uri)
          c.globalPortId.filter(!_.portId.internal).map { g =>
            val count = stats.operatorInfo
              .get(g.opId.logicalOpId.id)
              .flatMap(
                _.operatorStatistics.outputMetrics
                  .find(_.portId == g.portId)
                  .map(_.tupleMetrics.count)
              )
            PortResult(
              g.opId.logicalOpId.id,
              s"output-${g.portId.id}",
              Some(UnitApiResource.tableIdentifier(handle.internalEid, uri)),
              count,
              None
            )
          }
      }
    val error = meta.fatalErrors.headOption.map(e => objectMapper.valueToTree[JsonNode](e))
    ExecutionState(eid, statusOf(meta.state), operators, results, error)
  }

  @POST
  @Path("/executions/{eid}/cancel")
  @RolesAllowed(Array("SERVICE"))
  def cancel(@PathParam("eid") eid: String): ExecutionState = {
    val handle = handleOf(eid)
    val executionService = handle.workflowService.executionService.getValue
    try {
      if (executionService.client != null) executionService.client.shutdown()
      executionService.executionStateStore.statsStore.updateState(s =>
        s.withEndTimeStamp(System.currentTimeMillis())
      )
      executionService.executionStateStore.metadataStore.updateState(m =>
        updateWorkflowState(KILLED, m)
      )
    } catch {
      case e: Exception => logger.warn(s"cancel $eid: ${e.getMessage}")
    }
    status(eid)
  }

  @POST
  @Path("/executions/{eid}/pause")
  @RolesAllowed(Array("SERVICE"))
  def pause(@PathParam("eid") eid: String, @Auth user: UnitPrincipal): ExecutionState =
    control(eid, WorkflowPauseRequest(), user)

  @POST
  @Path("/executions/{eid}/resume")
  @RolesAllowed(Array("SERVICE"))
  def resume(@PathParam("eid") eid: String, @Auth user: UnitPrincipal): ExecutionState =
    control(eid, WorkflowResumeRequest(), user)

  /**
    * Hands a control request to the run's input bus, where the websocket used to put it, and
    * answers with the state as it stands. The engine confirms through its state store, which
    * the run's reporter relays to the catalog.
    */
  private def control(
      eid: String,
      request: TexeraWebSocketRequest,
      user: UnitPrincipal
  ): ExecutionState = {
    val handle = handleOf(eid)
    val executionService = handle.workflowService.executionService.getValue
    executionService.wsInput.onNext(request, Some(user.subject))
    status(eid)
  }

  @GET
  @Path("/executions/{eid}/results/{opid}/{port}")
  @RolesAllowed(Array("SERVICE"))
  def result(
      @PathParam("eid") eid: String,
      @PathParam("opid") opid: String,
      @PathParam("port") port: String,
      @QueryParam("offset") @DefaultValue("0") offset: Long,
      @QueryParam("limit") @DefaultValue("100") limit: Int,
      @QueryParam("table") table: String,
      @QueryParam("namespace") namespace: String,
      @QueryParam("warehouse") warehouse: String
  ): RowPage = {
    val portIndex = port.stripPrefix("output-").toIntOption.getOrElse(0)
    val recordedWarehouse = warehouseNamed(warehouse)
    // The run's own record while this unit holds it; otherwise the table where the catalog
    // put it, by warehouse, namespace and name.
    val own = runs
      .get(eid)
      .flatMap(h =>
        ExecutionRegistry.getResultUriByLogicalPortId(
          h.internalEid,
          OperatorIdentity(opid),
          PortIdentity(portIndex)
        )
      )
    val recorded = for {
      ns <- Option(namespace).filter(_.nonEmpty)
      t <- Option(table).filter(n => n.nonEmpty && !n.contains("."))
    } yield (ns, t)
    val (document, schemaOpt) = (own, recorded) match {
      case (Some(uri), _) => DocumentFactory.openDocument(uri)
      case (None, Some((ns, t))) =>
        try DocumentFactory.openTable(recordedWarehouse, ns, t)
        catch {
          case _: IllegalArgumentException =>
            throw new WebApplicationException(s"no table $ns.$t", Response.Status.NOT_FOUND)
        }
      case _ =>
        throw new WebApplicationException(s"no result for $opid/$port", Response.Status.NOT_FOUND)
    }
    val doc = document.asInstanceOf[VirtualDocument[Tuple]]
    val safeLimit = Math.max(1, Math.min(limit, 1000))
    val tuples = doc.getRange(offset.toInt, offset.toInt + safeLimit).toList
    val attributes = schemaOpt
      .map(_.getAttributes.toList)
      .getOrElse(tuples.headOption.map(_.getSchema.getAttributes.toList).getOrElse(Nil))
    RowPage(
      attributes.map(a => CompileAttribute(a.getName, a.getType.toString)),
      UnitApiResource.rowsOf(tuples, attributes),
      offset,
      Some(doc.getCount)
    )
  }
}
