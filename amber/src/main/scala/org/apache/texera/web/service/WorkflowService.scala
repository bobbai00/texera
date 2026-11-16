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
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionResultUris,
  WarehouseReadGuard
}
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}
import org.apache.texera.observability.{SpanAttrs, TexeraTracer}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.USER_WAREHOUSE
import org.apache.texera.amber.core.WorkflowRuntimeException
import org.apache.texera.amber.core.storage.result.iceberg.OnIceberg
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{ReplaySource, WorkflowContext}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  TERMINATED
}
import org.apache.texera.amber.error.ErrorUtils.{
  getOperatorFromActorIdOpt,
  getStackTraceWithAllCauses
}
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.service.util.LargeBinaryManager
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.request.WorkflowExecuteRequest
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.WorkflowService.{fatalErrorsOf, mkWorkflowStateId}
import org.apache.texera.web.service.execution.CostHintsLoader
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.apache.texera.web.{SubscriptionManager, WorkflowLifecycleManager}
import org.apache.texera.common.compiler.WorkflowCompilationFailed
import play.api.libs.json.Json

import java.net.URI
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
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
      uid: Integer,
      enabled: Boolean = StorageConfig.warehouseEnabled
  ): Option[String] = {
    if (!enabled) {
      warehouseId.foreach(_ =>
        throw new IllegalArgumentException(
          "per-user warehouses are disabled in this deployment"
        )
      )
      return None
    }
    if (warehouseId.isEmpty) {
      throw new IllegalArgumentException(
        "a warehouse must be selected for this execution"
      )
    }
    warehouseId.map(id => {
      val row = SqlServer
        .getInstance()
        .createDSLContext()
        .selectFrom(USER_WAREHOUSE)
        .where(USER_WAREHOUSE.WHID.eq(id).and(USER_WAREHOUSE.UID.eq(uid)))
        .fetchOne()
      if (row == null) {
        throw new IllegalArgumentException(s"no warehouse with id $id owned by this user")
      }
      row.getLakekeeperWarehouseName
    })
  }

  /**
    * What a run that failed with `failure` reports, as its error handler records it. A workflow
    * that does not compile reports each operator's error as the editing compile reports it, in
    * the order of the workflow, so the UI shows each error on its operator. Any other failure is
    * one error, of the operator and worker given when a worker raised it.
    */
  private[service] def fatalErrorsOf(
      failure: Throwable,
      operatorId: String,
      workerId: String
  ): Seq[WorkflowFatalError] =
    failure match {
      case compileFailure: WorkflowCompilationFailed => compileFailure.operatorErrors.values.toSeq
      case other =>
        Seq(
          WorkflowFatalError(
            EXECUTION_FAILURE,
            Timestamp(Instant.now),
            other.toString,
            getStackTraceWithAllCauses(other),
            operatorId,
            workerId
          )
        )
    }

  val cleanUpDeadlineInSeconds: Int = ApplicationConfig.executionStateCleanUpInSecs

  /** The states a run ends in: a run in any other may still be running. */
  private[service] val FinishedStates: Set[WorkflowAggregatedState] =
    Set(COMPLETED, FAILED, KILLED, TERMINATED)

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

  // Held while a request sets up a new run, from before it supersedes the run in flight until the
  // new run is started or has failed, and while a run is superseded. So two requests never set up
  // runs at once, and a run is never superseded halfway through its setup, which would leave an
  // engine that no service holds.
  private val runLock = new ReentrantLock()

  val resultService: ExecutionResultService =
    new ExecutionResultService(workflowId, computingUnitId, stateStore)
  val lifeCycleManager: WorkflowLifecycleManager = new WorkflowLifecycleManager(
    s"workflowId=$workflowId",
    cleanUpTimeout,
    () => cleanUpAfterIdle()
  )

  /**
    * What becomes of this service once nobody has used the workflow for the clean-up timeout: the
    * storage of the run it holds is cleared, and the service leaves the registry and lets go of
    * every subscription, shutting that run's engine down. A service that holds no run clears
    * nothing. The run is the one this service holds, not the newest of the workflow on its unit,
    * which another service, or an execution made and not yet started, may own.
    */
  private[service] def cleanUpAfterIdle(): Unit = {
    Option(executionService.getValue).foreach(run =>
      clearExecutionResources(run.workflowContext.executionId)
    )
    WorkflowService.workflowServiceMapping.remove(mkWorkflowStateId(workflowId))
    unsubscribeAll()
  }

  /**
    * Lets go of the run this service holds, as a new run is about to take its place. A run that
    * has not finished is killed: its engine is shut down, and the state KILLED and its end time
    * are recorded, which writes its execution's row once. A finished run is only let go of, and so
    * is a run that finishes while it is let go of: it keeps the state it finished in.
    *
    * The run is let go of before KILLED is recorded, so neither the sessions on the workflow nor
    * its idle clean-up hear of the kill: sessions see the new run take its place, as they did
    * before a superseded run was recorded, and the kill does not arm the clean-up. A run still
    * being set up is let go of only once its setup is over (see `runLock`).
    */
  def supersedeCurrentRun(): Unit = {
    runLock.lock()
    try {
      Option(executionService.getValue).foreach { run =>
        // Shuts its engine down too, when it has one.
        run.unsubscribeAll()
        val endTime = System.currentTimeMillis()
        var killed = false
        // Decided under the store's lock, against a state the engine may report at this moment.
        run.executionStateStore.metadataStore.updateState { metadataStore =>
          if (WorkflowService.FinishedStates.contains(metadataStore.state)) {
            metadataStore
          } else {
            killed = true
            updateWorkflowState(KILLED, metadataStore)
          }
        }
        if (killed) {
          logger.info(
            s"Execution ${run.workflowContext.executionId.id} of workflow ${workflowId.id} is " +
              "killed, as a new run takes its place."
          )
          run.executionStateStore.statsStore.updateState(_.withEndTimeStamp(endTime))
        }
      }
    } finally runLock.unlock()
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

  // Finds a run's cost hints. A seam, so a test can see which hints a new run is given.
  protected def costHintsLoader: CostHintsLoader = CostHintsLoader

  def initExecutionService(
      req: WorkflowExecuteRequest,
      userOpt: Option[User],
      sessionUri: URI
  ): Unit = {
    val span = TexeraTracer.tracer
      .spanBuilder("WorkflowService.initExecutionService")
      .setAttribute(SpanAttrs.WorkflowId, Long.box(workflowId.id))
      .startSpan()
    val scope = span.makeCurrent()
    // Until the new run is started or has failed: no other request supersedes it meanwhile.
    runLock.lock()
    try {

      // Validate before touching the execution already in flight: a request that is
      // going to be refused must not take the running one's subscriptions with it.
      // uid is NOT NULL in the DB; fail early here rather than letting the insert fail downstream.
      val uid = userOpt
        .map(_.getUid)
        .getOrElse(
          throw new IllegalArgumentException(
            "Cannot start execution: a user id (uid) is required but none was provided."
          )
        )
      val userEmail = userOpt.flatMap(user => Option(user.getEmail))
      val warehouseName = WorkflowService.resolveLakekeeperWarehouseName(req.warehouseId, uid)

      supersedeCurrentRun()

      val workflowContext: WorkflowContext = createWorkflowContext()
      workflowContext.warehouse = warehouseName
      // How long each operator took in the user's newest completed run of the workflow, for the
      // scheduler's cost model: saved with the plan, which the engine takes them from.
      workflowContext.costHints = costHintsLoader.load(workflowId.id, uid)

      // clean up results from previous run
      val previousExecutionId =
        WorkflowExecutionService.getLatestExecutionId(workflowId, req.computingUnitId)
      previousExecutionId.foreach(eid => {
        clearExecutionResources(eid)
      }) // TODO: change this behavior after enabling cache.

      workflowContext.executionId = ExecutionsMetadataPersistService.insertNewExecution(
        workflowContext.workflowId,
        uid,
        req.executionName,
        convertToJson(req.engineVersion),
        req.computingUnitId,
        req.warehouseId
      )
      span.setAttribute(SpanAttrs.ExecutionId, Long.box(workflowContext.executionId.id))
      // A run has started: record the start counter and stamp its start time.
      org.apache.texera.web.observability.WorkflowMetricsRecorder
        .onStart(workflowContext.executionId)

      // Where the run writes its replay log, and the replay log it replays: saved with its plan,
      // whose coordinator is configured from the plan read back.
      val replayLog = ApplicationConfig.faultToleranceLogRootFolder.map { root =>
        val writeLocation =
          root.resolve(s"${workflowContext.workflowId}/${workflowContext.executionId}/")
        ExecutionsMetadataPersistService.updateLogLocation(
          workflowContext.executionId,
          writeLocation.toString
        )
        writeLocation
      }
      val replay = req.replayFromExecution.flatMap { replayInfo =>
        val source = ExecutionIdentity(replayInfo.eid)
        ExecutionsMetadataPersistService
          .tryGetExistingExecution(source)
          .map(execution =>
            ReplaySource(source, new URI(execution.getLogLocation), replayInfo.interaction)
          )
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
            updateWorkflowState(FAILED, metadataStore)
              .addAllFatalErrors(fatalErrorsOf(t, operatorId, workerId))
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
          workflowContext,
          resultService,
          req,
          executionStateStore,
          errorHandler,
          uid,
          userEmail,
          sessionUri,
          replay,
          replayLog
        )
        // Kept with the run, so the clean-up stops following it once the run is let go of.
        execution.addSubscription(
          lifeCycleManager.registerCleanUpOnStateChange(executionStateStore)
        )
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
      runLock.unlock()
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

  /**
    * Cleans up all resources associated with a workflow execution.
    *
    * This method performs resource cleanup in the following sequence:
    *  1. Retrieves all document URIs associated with the execution
    *  2. Clears URI references from the execution registry
    *  3. Safely clears all result and console message documents
    *  4. Expires Iceberg snapshots for runtime statistics
    *  5. Deletes this execution's large binaries from the object store
    *
    * @param eid The execution identity to clean up resources for
    */
  private def clearExecutionResources(eid: ExecutionIdentity): Unit = {
    // Retrieve URIs for all resources associated with this execution
    val resultUris = ExecutionResultUris.getResultUrisByExecutionId(eid)
    val consoleMessagesUris = WorkflowExecutionsResource.getConsoleMessagesUriByExecutionId(eid)

    // Remove references from registry first
    WorkflowExecutionsResource.deleteConsoleMessageAndExecutionResultUris(eid)

    // Clean up all result and console message documents. While per-user warehouses are
    // disabled, cleanup must not reach into them (#6930) — those URIs are skipped.
    (resultUris ++ consoleMessagesUris).foreach { uri =>
      if (WarehouseReadGuard.skipWhileDisabled(uri)) {
        logger.info(s"skipping cleanup of $uri: per-user warehouses are disabled")
      } else
        try DocumentFactory.openDocument(uri)._1.clear()
        catch {
          case error: Throwable =>
            logger.debug(s"Error processing document at $uri: ${error.getMessage}")
        }
    }

    // Expire any Iceberg snapshots for runtime statistics
    WorkflowExecutionsResource.getRuntimeStatsUriByExecutionId(eid).foreach { uri =>
      if (WarehouseReadGuard.skipWhileDisabled(uri)) {
        logger.info(s"skipping snapshot expiry of $uri: per-user warehouses are disabled")
      } else
        try {
          DocumentFactory.openDocument(uri)._1 match {
            case iceberg: OnIceberg => iceberg.expireSnapshots()
            case other =>
              logger.error(
                s"Cannot expire snapshots: document from URI [$uri] is of type ${other.getClass.getName}. " +
                  s"Expected an instance of ${classOf[OnIceberg].getName}."
              )
          }
        } catch {
          case error: Throwable =>
            logger.debug(s"Error processing document at $uri: ${error.getMessage}")
        }
    }
    // Delete this execution's large binaries
    LargeBinaryManager.deleteByExecution(eid.id)
  }
}
