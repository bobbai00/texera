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
import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{PortIdentity, WorkflowContext, WorkflowSettings}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  TERMINATED
}
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.amber.operator.metadata.{AllOperatorMetadata, OperatorMetadataGenerator}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.web.auth.UnitPrincipal
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{CompilationErrorHandling, WorkflowCompiler}
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.web.model.websocket.request.WorkflowExecuteRequest
import org.apache.texera.web.service.{ExecutionResultService, WorkflowService}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState

import java.net.URI
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

@JsonIgnoreProperties(ignoreUnknown = true)
case class PythonEnvironmentRequest(version: Option[String], packages: List[String])

@JsonIgnoreProperties(ignoreUnknown = true)
case class EnvironmentRequest(rid: String, vno: Int, python: Option[PythonEnvironmentRequest])

@JsonIgnoreProperties(ignoreUnknown = true)
case class ResultStore(catalogUri: String, warehouse: String, namespace: String)

@JsonIgnoreProperties(ignoreUnknown = true)
case class Reporting(lineageUrl: String, token: String)

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

case class OperatorRun(state: String, tuples: Option[Long], error: Option[JsonNode])

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

case class EnvironmentBuild(rid: String, vno: Int, status: String, message: Option[String])

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

  /** Execution ids a start has claimed; claiming is atomic, so one id never starts twice. */
  private val claimed = new TrieMap[String, Unit]()
  private[execution] def claim(eid: String): Boolean = claimed.putIfAbsent(eid, ()).isEmpty
  val UNIT_ID = 0

  /**
    * A result location the catalog recorded for (eid, opid, port), accepted only when it is that
    * port result: a result table of this execution's engine id, for that operator's external port.
    * Anything else is refused, so the parameter cannot be used to read another run's tables.
    */
  def recordedResult(eid: String, opid: String, port: Int, table: String): URI = {
    val refused = new WebApplicationException(
      s"the recorded location is not $opid/output-$port of execution $eid",
      Response.Status.FORBIDDEN
    )
    val uri = scala.util.Try(new URI(table)).getOrElse(throw refused)
    val components = scala.util
      .Try(org.apache.texera.amber.core.storage.VFSURIFactory.decodeURI(uri))
      .getOrElse(throw refused)
    val matches =
      components.resourceType == org.apache.texera.amber.core.storage.VFSResourceType.RESULT &&
        components.executionId.id == EngineIds.of(eid) &&
        components.globalPortId.exists(g =>
          !g.portId.internal && g.opId.logicalOpId.id == opid && g.portId.id == port
        )
    if (!matches) throw refused
    uri
  }

  /** A stable engine workflow id for a catalog rid. */
  def workflowIdOf(rid: String): Long = EngineIds.of(rid)

  def statusOf(state: WorkflowAggregatedState): String =
    state match {
      case COMPLETED                                                             => "completed"
      case FAILED                                                                => "failed"
      case KILLED | TERMINATED                                                   => "cancelled"
      case WorkflowAggregatedState.UNINITIALIZED | WorkflowAggregatedState.READY => "pending"
      case _                                                                     => "running"
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

  def isTerminal(state: WorkflowAggregatedState): Boolean =
    state == COMPLETED || state == FAILED || state == KILLED || state == TERMINATED
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
  def health(): UnitHealth = UnitHealth("ok", Some("2.0.0-alpha"))

  @GET
  @Path("/operators")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def operators(): OperatorTypeList = UnitApiResource.operatorRegistry

  @POST
  @Path("/compile")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
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
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def buildEnvironment(request: EnvironmentRequest): EnvironmentBuild = {
    val name = EnvironmentManager.nameOf(request.rid, request.vno)
    val status = EnvironmentManager.ensure(name, request.python.map(_.packages).getOrElse(Nil))
    environmentBuild(request.rid, request.vno, status)
  }

  @GET
  @Path("/environments/{rid}/{vno}")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def environmentStatus(
      @PathParam("rid") rid: String,
      @PathParam("vno") vno: Int
  ): EnvironmentBuild = {
    val name = EnvironmentManager.nameOf(rid, vno)
    EnvironmentManager.status(name) match {
      case Some(status) => environmentBuild(rid, vno, status)
      case None         => throw new WebApplicationException(Response.Status.NOT_FOUND)
    }
  }

  private def environmentBuild(
      rid: String,
      vno: Int,
      status: EnvironmentManager.Status
  ): EnvironmentBuild =
    status match {
      case EnvironmentManager.Ready     => EnvironmentBuild(rid, vno, "ready", None)
      case EnvironmentManager.Building  => EnvironmentBuild(rid, vno, "building", None)
      case f: EnvironmentManager.Failed => EnvironmentBuild(rid, vno, "failed", Some(f.message))
      case _                            => EnvironmentBuild(rid, vno, "failed", Some("unknown"))
    }

  @POST
  @Path("/executions")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def start(request: ExecutionStartRequest, @Auth user: UnitPrincipal): ExecutionAck = {
    // A repeated start (a retry after a timeout, say) must not touch the run already going.
    if (!UnitApiResource.claim(request.eid)) {
      throw new WebApplicationException(
        s"execution ${request.eid} already started",
        Response.Status.CONFLICT
      )
    }
    val reporter =
      new LineageReporter(request.reporting.lineageUrl, request.reporting.token, request.eid)
    // Environment: build (or confirm) the venv and point every Python UDF at it.
    val planNode = request.logicalPlan.deepCopy[JsonNode]()
    request.environment.foreach { env =>
      val packages = env.python.map(_.packages).getOrElse(Nil)
      val name = EnvironmentManager.nameOf(env.rid, env.vno)
      EnvironmentManager.ensure(name, packages) match {
        case f: EnvironmentManager.Failed =>
          reporter.runStatus("failed", Some(s"environment ${env.rid}@${env.vno}: ${f.message}"))
          reporter.close()
          throw new WebApplicationException(
            s"environment build failed: ${f.message}",
            Response.Status.BAD_REQUEST
          )
        case _ => applyEnvironment(planNode, name)
      }
    }
    val plan = objectMapper.treeToValue(planNode, classOf[LogicalPlanPojo])
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
      warehouseId = None,
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
    def reportTerminal(state: ExecutionMetadataStore): Unit =
      synchronized {
        if (reported) return
        reported = true
        val stats = executionService.executionStateStore.statsStore.getState
        val record = ExecutionRegistry.get(handle.internalEid)
        plan.operators.foreach { op =>
          val opid = op.operatorIdentifier.id
          val metrics = stats.operatorInfo.get(opid)
          val opState = metrics
            .map(m => Utils.aggregatedStateToString(m.operatorState))
            .getOrElse("Uninitialized")
          val tuples = metrics.map(_.operatorStatistics.outputMetrics.map(_.tupleMetrics.count).sum)
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
                    Some(uri.toString),
                    count,
                    record.flatMap(_.resultSize(globalPortId))
                  )
                }
          }
          val inputs = plan.links
            .filter(_.toOpId.id == opid)
            .map(l => reporter.PortRef(l.fromOpId.id, s"output-${l.fromPortId.id}"))
          val opError = state.fatalErrors.find(_.operatorId == opid).map(_.message)
          reporter.operator(opid, opState, tuples, opError, outputs, inputs, terminal = true)
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
    ExecutionAck(request.eid, accepted = true)
  }

  /** Points every Python UDF operator of the plan at the built environment. */
  private def applyEnvironment(plan: JsonNode, envName: String): Unit = {
    val operators = plan.get("operators")
    if (operators == null || !operators.isArray) return
    operators.elements().asScala.foreach {
      case op: ObjectNode =>
        val opType = Option(op.get("operatorType")).map(_.asText()).getOrElse("")
        if (opType.contains("PythonUDF") || op.has("envName")) {
          op.put("defaultEnv", false)
          op.put("envName", envName)
        }
      case _ =>
    }
  }

  private def handleOf(eid: String): RunHandle =
    runs.getOrElse(
      eid,
      throw new WebApplicationException(s"unknown execution $eid", Response.Status.NOT_FOUND)
    )

  @GET
  @Path("/executions/{eid}")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def status(@PathParam("eid") eid: String): ExecutionState = {
    val handle = handleOf(eid)
    val executionService = handle.workflowService.executionService.getValue
    val meta = executionService.executionStateStore.metadataStore.getState
    val stats = executionService.executionStateStore.statsStore.getState
    val operators = stats.operatorInfo.map {
      case (opid, m) =>
        opid -> OperatorRun(
          Utils.aggregatedStateToString(m.operatorState),
          Some(m.operatorStatistics.outputMetrics.map(_.tupleMetrics.count).sum),
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
              Some(uri.toString),
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
  @RolesAllowed(Array("REGULAR", "ADMIN"))
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

  @GET
  @Path("/executions/{eid}/results/{opid}/{port}")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def result(
      @PathParam("eid") eid: String,
      @PathParam("opid") opid: String,
      @PathParam("port") port: String,
      @QueryParam("offset") @DefaultValue("0") offset: Long,
      @QueryParam("limit") @DefaultValue("100") limit: Int,
      @QueryParam("table") table: String
  ): RowPage = {
    val portIndex = port.stripPrefix("output-").toIntOption.getOrElse(0)
    // The run's own record while this unit holds it; otherwise where the catalog recorded it.
    val uri = runs
      .get(eid)
      .flatMap(h =>
        ExecutionRegistry.getResultUriByLogicalPortId(
          h.internalEid,
          OperatorIdentity(opid),
          PortIdentity(portIndex)
        )
      )
      .orElse(
        Option(table)
          .filter(_.nonEmpty)
          .map(UnitApiResource.recordedResult(eid, opid, portIndex, _))
      )
      .getOrElse(
        throw new WebApplicationException(s"no result for $opid/$port", Response.Status.NOT_FOUND)
      )
    val (document, schemaOpt) = DocumentFactory.openDocument(uri)
    val doc = document.asInstanceOf[VirtualDocument[Tuple]]
    val safeLimit = Math.max(1, Math.min(limit, 1000))
    val tuples = doc.getRange(offset.toInt, offset.toInt + safeLimit).toList
    val attributes = schemaOpt
      .map(_.getAttributes.toList)
      .getOrElse(tuples.headOption.map(_.getSchema.getAttributes.toList).getOrElse(Nil))
    val json = ExecutionResultService.convertTuplesToJson(tuples)
    val rows = json.map(node =>
      attributes.map(a => Option(node.get(a.getName)).getOrElse(objectMapper.nullNode()): JsonNode)
    )
    RowPage(
      attributes.map(a => CompileAttribute(a.getName, a.getType.toString)),
      rows,
      offset,
      Some(doc.getCount)
    )
  }
}
