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

package org.apache.texera.web.service

import com.google.protobuf.timestamp.Timestamp
import com.typesafe.scalalogging.LazyLogging
import io.opentelemetry.api.trace.StatusCode
import io.reactivex.rxjava3.disposables.{CompositeDisposable, Disposable}
import io.reactivex.rxjava3.subjects.BehaviorSubject
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}
import org.apache.texera.observability.{SpanAttrs, TexeraTracer}
import org.apache.texera.amber.core.WorkflowRuntimeException
import org.apache.texera.amber.core.virtualidentity.{
  EmbeddedControlMessageIdentity,
  ExecutionIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.coordinator.CoordinatorConfig
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED
}
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.{
  FaultToleranceConfig,
  StateRestoreConfig
}
import org.apache.texera.amber.error.ErrorUtils.{
  getOperatorFromActorIdOpt,
  getStackTraceWithAllCauses
}
import org.apache.texera.web.auth.UnitPrincipal
import org.apache.texera.web.execution.ExecutionRegistry
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.request.WorkflowExecuteRequest
import org.apache.texera.web.service.WorkflowService.mkWorkflowStateId
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.apache.texera.web.{SubscriptionManager, WorkflowLifecycleManager}
import org.apache.texera.common.compiler.model.LogicalPlan
import play.api.libs.json.Json

import java.net.URI
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import scala.jdk.CollectionConverters.IterableHasAsScala

object WorkflowService {
  private val workflowServiceMapping = new ConcurrentHashMap[String, WorkflowService]()

  /**
    * Maps an execution's chosen warehouse (its user_warehouse row id) to its Lakekeeper
    * warehouse name, checking that the requesting user owns it.
    *
    * With warehouses enabled a pick is **required**, the same way a computing unit is:
    * falling back to the shared default would make "a run writes into the user's own
    * warehouse" a UI convention rather than a system property, and would silently route
    * any caller that forgot to pick into shared storage (#7751).
    *
    * With warehouses disabled, an explicit pick is refused loudly rather than silently
    * routed into the shared warehouse, and no pick keeps the shared default (#6930).
    */
  def resolveLakekeeperWarehouseName(
      warehouseId: Option[Int],
      enabled: Boolean = StorageConfig.warehouseEnabled
  ): Option[String] = {
    // Per-user warehouses are a catalog concern now; the unit writes to the configured default.
    if (!enabled && warehouseId.nonEmpty) {
      throw new IllegalArgumentException("per-user warehouses are disabled in this deployment")
    }
    None
  }
  val cleanUpDeadlineInSeconds: Int = ApplicationConfig.executionStateCleanUpInSecs

  def getAllWorkflowServices: Iterable[WorkflowService] = workflowServiceMapping.values().asScala

  def mkWorkflowStateId(workflowId: WorkflowIdentity): String = {
    workflowId.toString
  }

  def getOrCreate(
      workflowId: WorkflowIdentity,
      computingUnitId: Int,
      cleanupTimeout: Int = cleanUpDeadlineInSeconds
  ): WorkflowService = {
    workflowServiceMapping.compute(
      mkWorkflowStateId(workflowId),
      (_, v) => {
        if (v == null) {
          new WorkflowService(workflowId, computingUnitId, cleanupTimeout)
        } else {
          v
        }
      }
    )
  }
}

class WorkflowService(
    val workflowId: WorkflowIdentity,
    val computingUnitId: Int,
    cleanUpTimeout: Int
) extends SubscriptionManager
    with LazyLogging {

  // state across execution:
  val stateStore = new WorkflowStateStore()
  var executionService: BehaviorSubject[WorkflowExecutionService] = BehaviorSubject.create()

  val resultService: ExecutionResultService =
    new ExecutionResultService(workflowId, computingUnitId, stateStore)
  val lifeCycleManager: WorkflowLifecycleManager =
    new WorkflowLifecycleManager(s"workflowId=$workflowId", cleanUpTimeout, () => releaseEngine())

  /**
    * Lets go of the engine once nobody is watching and nothing runs: the Amber client, the
    * subscriptions, and this service's slot in the registry. The executions' results stay; the
    * catalog's lineage points at them, and only the retention sweep drops them
    * (see [[org.apache.texera.web.execution.ExecutionStorage]]).
    */
  private[service] def releaseEngine(): Unit = {
    WorkflowService.workflowServiceMapping.remove(mkWorkflowStateId(workflowId), this)
    Option(executionService.getValue).flatMap(e => Option(e.client)).foreach(_.shutdown())
    unsubscribeAll()
  }

  var lastCompletedLogicalPlan: Option[LogicalPlan] = Option.empty

  executionService.subscribe { executionService: WorkflowExecutionService =>
    {
      executionService.executionStateStore.metadataStore.registerDiffHandler {
        (oldState, newState) =>
          {
            if (oldState.state != COMPLETED && newState.state == COMPLETED) {
              lastCompletedLogicalPlan = Option.apply(executionService.workflow.logicalPlan)
            }
            Iterable.empty
          }
      }
    }
  }

  def connect(onNext: TexeraWebSocketEvent => Unit): Disposable = {
    lifeCycleManager.increaseUserCount()
    val subscriptions = stateStore.getAllStores
      .map(_.getWebsocketEventObservable)
      .map(evtPub =>
        evtPub.subscribe { evts: Iterable[TexeraWebSocketEvent] => evts.foreach(onNext) }
      )
      .toSeq
    new CompositeDisposable(subscriptions: _*)
  }

  def connectToExecution(onNext: TexeraWebSocketEvent => Unit): Disposable = {
    val localDisposable = new CompositeDisposable()
    val disposable = executionService.subscribe { execService: WorkflowExecutionService =>
      localDisposable.clear() // Clears previous subscriptions safely
      val subscriptions = execService.executionStateStore.getAllStores
        .map(_.getWebsocketEventObservable)
        .map(evtPub =>
          evtPub.subscribe { events: Iterable[TexeraWebSocketEvent] => events.foreach(onNext) }
        )
        .toSeq
      localDisposable.addAll(subscriptions: _*)
    }
    // Note: this new CompositeDisposable is necessary. DO NOT OPTIMIZE.
    new CompositeDisposable(localDisposable, disposable)
  }

  def disconnect(): Unit = {
    lifeCycleManager.decreaseUserCount(
      Option(executionService.getValue).map(_.executionStateStore.metadataStore.getState.state)
    )
  }

  private[this] def createWorkflowContext(): WorkflowContext = {
    new WorkflowContext(workflowId = workflowId, cuid = Some(computingUnitId))
  }

  def initExecutionService(
      req: WorkflowExecuteRequest,
      userOpt: Option[UnitPrincipal],
      sessionUri: URI
  ): Unit = {
    val span = TexeraTracer.tracer
      .spanBuilder("WorkflowService.initExecutionService")
      .setAttribute(SpanAttrs.WorkflowId, Long.box(workflowId.id))
      .startSpan()
    val scope = span.makeCurrent()
    try {

      // Validate before touching the execution already in flight: a request that is
      // going to be refused must not take the running one's subscriptions with it.
      if (userOpt.isEmpty) {
        throw new IllegalArgumentException(
          "Cannot start execution: a signed-in user is required but none was provided."
        )
      }
      val warehouseName = WorkflowService.resolveLakekeeperWarehouseName(req.warehouseId)

      if (executionService.hasValue) {
        executionService.getValue.unsubscribeAll()
      }

      val workflowContext: WorkflowContext = createWorkflowContext()
      workflowContext.warehouse = warehouseName
      workflowContext.pastRuntimeStatistics =
        ExecutionRegistry.latestCompletedStatistics(workflowId.id)
      var coordinatorConf = CoordinatorConfig.default

      // Earlier runs keep their results: each one is a recorded execution the catalog's lineage
      // refers to, so a new run must not clear them.
      workflowContext.executionId = ExecutionsMetadataPersistService.insertNewExecution(
        workflowContext.workflowId,
        req.executionName,
        convertToJson(req.engineVersion),
        req.computingUnitId,
        req.warehouseId,
        req.externalExecutionId
      )
      span.setAttribute(SpanAttrs.ExecutionId, Long.box(workflowContext.executionId.id))
      // A run has started: record the start counter and stamp its start time.
      org.apache.texera.web.observability.WorkflowMetricsRecorder
        .onStart(workflowContext.executionId)

      if (ApplicationConfig.faultToleranceLogRootFolder.isDefined) {
        val writeLocation = ApplicationConfig.faultToleranceLogRootFolder.get.resolve(
          s"${workflowContext.workflowId}/${workflowContext.executionId}/"
        )
        ExecutionsMetadataPersistService.tryUpdateExistingExecution(workflowContext.executionId) {
          execution => execution.setLogLocation(writeLocation.toString)
        }
        coordinatorConf = coordinatorConf.copy(faultToleranceConfOpt =
          Some(FaultToleranceConfig(writeTo = writeLocation))
        )
      }
      if (req.replayFromExecution.isDefined) {
        val replayInfo = req.replayFromExecution.get
        ExecutionsMetadataPersistService
          .tryGetExistingExecution(ExecutionIdentity(replayInfo.eid))
          .foreach { execution =>
            val readLocation = new URI(execution.getLogLocation)
            coordinatorConf = coordinatorConf.copy(stateRestoreConfOpt =
              Some(
                StateRestoreConfig(
                  readFrom = readLocation,
                  replayDestination = EmbeddedControlMessageIdentity(replayInfo.interaction)
                )
              )
            )
          }
      }

      val executionStateStore = new ExecutionStateStore()
      // assign execution id to find the execution from DB in case the constructor fails.
      executionStateStore.metadataStore.updateState(state =>
        state.withExecutionId(workflowContext.executionId)
      )
      val errorHandler: Throwable => Unit = { t =>
        {
          val fromActorOpt = t match {
            case ex: WorkflowRuntimeException =>
              ex.relatedWorkerId
            case other =>
              None
          }
          val (operatorId, workerId) = getOperatorFromActorIdOpt(fromActorOpt)
          logger.error("error during execution", t)
          // Do NOT touch `span` here: this handler is passed into
          // WorkflowExecutionService and invoked asynchronously (runtime,
          // websocket, startWorkflow callbacks) after initExecutionService has
          // returned and the setup span has already ended, so recording onto it
          // would be a silent no-op. The failure is surfaced via the metadata
          // store below; setup-span errors are recorded in the catch block.
          executionStateStore.statsStore.updateState(stats =>
            stats.withEndTimeStamp(System.currentTimeMillis())
          )
          executionStateStore.metadataStore.updateState { metadataStore =>
            updateWorkflowState(FAILED, metadataStore).addFatalErrors(
              WorkflowFatalError(
                EXECUTION_FAILURE,
                Timestamp(Instant.now),
                t.toString,
                getStackTraceWithAllCauses(t),
                operatorId,
                workerId
              )
            )
          }
        }
      }
      // WorkflowExecutionService construction does no external work and cannot
      // throw; it registers its error/state diff handler up front. Once published
      // via `executionService.onNext`, any failure in `executeWorkflow()` is
      // recorded by `errorHandler` into the metadata store, whose handler emits a
      // WorkflowErrorEvent that `connectToExecution` forwards.
      try {
        val execution = new WorkflowExecutionService(
          coordinatorConf,
          workflowContext,
          resultService,
          req,
          executionStateStore,
          errorHandler,
          sessionUri
        )
        lifeCycleManager.registerCleanUpOnStateChange(executionStateStore)
        executionService.onNext(execution)
        // A synchronous setup failure (e.g. compilation) is surfaced to the UI by
        // the run's errorHandler and signalled back here; record it on the still-open
        // setup span so error-trace searches find it. None means the run started, after
        // which runtime failures arrive asynchronously through errorHandler and belong
        // to later execution work, not this setup span.
        execution.executeWorkflow().foreach { setupErr =>
          span.recordException(setupErr)
          span.setStatus(StatusCode.ERROR)
        }
      } catch {
        case e: Throwable =>
          // Setup threw before the run's errorHandler could record it; mark the
          // open setup span and surface the failure to the UI.
          span.recordException(e)
          span.setStatus(StatusCode.ERROR)
          errorHandler(e)
      }

    } catch {
      case t: Throwable =>
        // Synchronous setup failure (before the run's own errorHandler is wired).
        span.recordException(t)
        span.setStatus(StatusCode.ERROR)
        throw t
    } finally {
      scope.close()
      span.end()
    }
  }

  def convertToJson(frontendVersion: String): String = {
    val environmentVersionMap = Map(
      "engine_version" -> Json.toJson(frontendVersion)
    )
    Json.stringify(Json.toJson(environmentVersionMap))
  }

  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    Option(executionService.getValue).foreach(_.unsubscribeAll())
    resultService.unsubscribeAll()
  }
}
