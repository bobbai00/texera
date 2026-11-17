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
import io.opentelemetry.api.trace.{Span, StatusCode}
import io.reactivex.rxjava3.disposables.{CompositeDisposable, Disposable}
import io.reactivex.rxjava3.subjects.BehaviorSubject
import org.apache.iceberg.exceptions.CommitFailedException
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.observability.{SpanAttrs, TexeraTracer}
import org.apache.texera.amber.core.WorkflowRuntimeException
import org.apache.texera.amber.core.storage.{
  ExecutionAlreadyStartedException,
  ExecutionPlanStore,
  NoStoredPlanException,
  PlanRecord,
  RepositoryMountManager
}
import org.apache.texera.amber.core.virtualidentity.WorkflowIdentity
import org.apache.texera.amber.core.workflow.{ExecutionPlan, WorkflowContext}
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
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.service.WorkflowService.mkWorkflowStateId
import org.apache.texera.web.service.execution.{ExecutionResources, StoredExecutionStart}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.apache.texera.web.{SubscriptionManager, WorkflowLifecycleManager}

import java.net.URI
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import scala.jdk.CollectionConverters.IterableHasAsScala
import scala.util.control.NonFatal

object WorkflowService extends LazyLogging {
  private val workflowServiceMapping = new ConcurrentHashMap[String, WorkflowService]()

  /**
    * A start of execution `executionId` by its id that passed every check made before the
    * execution is claimed ([[checkStoredStart]]): the plan table at `planUri`, of workflow
    * `workflowId`; its plan row `record`, made for the user who asks and for computing unit
    * `cuid`; and the plan the row holds, read back.
    */
  final case class CheckedStart(
      executionId: Long,
      planUri: URI,
      workflowId: WorkflowIdentity,
      cuid: Int,
      record: PlanRecord,
      executionPlan: ExecutionPlan
  )

  /**
    * Checks a request of `user` to start execution `executionId`, which the Dashboard service
    * created, on computing unit `cuid`, from the plan stored in its plan table at `planUri`, in
    * this order:
    *  1. A user is required.
    *  1. The URI is checked before any catalog is opened ([[StoredExecutionStart.checkUri]]).
    *  1. The plan row is read with `readPlan`, and checked: made for `user` and `cuid`, of the
    *     execution the table is of, with no input link expired
    *     ([[StoredExecutionStart.checkRecord]]).
    *
    * It reads the plan row and writes nothing.
    *
    * @param socketWorkflowId the workflow of the socket the request came over; None for a request
    *                         that came another way, which starts the workflow the URI names
    * @return why the start is refused (Left), or what it starts (Right)
    */
  def checkStoredStart(
      executionId: Long,
      planUri: URI,
      user: User,
      cuid: Int,
      socketWorkflowId: Option[Long],
      readPlan: URI => PlanRecord = ExecutionPlanStore.readPlan
  ): Either[String, CheckedStart] =
    for {
      uid <- Option(user)
        .flatMap(user => Option(user.getUid))
        .map(_.intValue())
        .toRight("a signed-in user is required to start an execution")
      location <- StoredExecutionStart.checkUri(planUri, executionId, socketWorkflowId, uid)
      record <- storedPlanRow(executionId, planUri, readPlan)
      executionPlan <- StoredExecutionStart.checkRecord(
        record,
        location,
        uid,
        cuid,
        System.currentTimeMillis()
      )
    } yield CheckedStart(executionId, planUri, location.workflowId, cuid, record, executionPlan)

  /** The plan row of execution `executionId` at `planUri`, or why it cannot be had. */
  private def storedPlanRow(
      executionId: Long,
      planUri: URI,
      readPlan: URI => PlanRecord
  ): Either[String, PlanRecord] =
    try Right(readPlan(planUri))
    catch {
      case _: NoStoredPlanException => Left(s"execution $executionId has no stored plan")
      // The row is there and is not one a plan table holds, such as a row with no body: a
      // second try reads the same row.
      case malformed @ (_: IllegalStateException | _: IllegalArgumentException) =>
        logger.warn(
          s"The plan row of execution $executionId at $planUri cannot be read.",
          malformed
        )
        Left(
          s"the stored plan of execution $executionId cannot be read" +
            Option(malformed.getMessage).fold("")(why => s": $why")
        )
      case NonFatal(failure) =>
        logger.warn(s"The plan of execution $executionId could not be read from $planUri.", failure)
        Left(s"the plan of execution $executionId could not be read; try starting it again")
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

  // Held while a start sets up a new run, from before it claims the execution until the new run
  // is started or has failed, and while a run is superseded. So two starts never set up runs at
  // once, and a run is never superseded halfway through its setup, which would leave an engine
  // that no service holds.
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
      ExecutionResources.clearExecutionResources(run.workflowContext.executionId)
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

  // Read an execution's plan row, and claim the execution for its one start, in its plan table.
  // Seams, so a test can see what a start asks of the lake, or make it fail there.
  protected def readPlan(planUri: URI): PlanRecord = ExecutionPlanStore.readPlan(planUri)
  protected def claimStart(planUri: URI): Unit = ExecutionPlanStore.claimStart(planUri)

  /**
    * The run of a plan read back from the lake, under `context`, before it is started. A seam, so
    * a test can give the run an engine of its own.
    */
  protected def storedRun(
      context: WorkflowContext,
      executionStateStore: ExecutionStateStore,
      errorHandler: Throwable => Unit
  ): WorkflowExecutionService =
    new WorkflowExecutionService(
      context,
      resultService,
      executionStateStore,
      errorHandler,
      RepositoryMountManager.mountRoot
    )

  /**
    * Starts execution `executionId` of this workflow, which the Dashboard service created, from
    * the plan stored in its plan table at `planUri`, for `user` on computing unit `cuid`: the unit
    * the request to start it came to. The start is checked first
    * ([[WorkflowService.checkStoredStart]]: the user, the URI before any catalog is opened, then
    * the plan row), then started ([[startChecked]]).
    *
    * @param sessionUri the URI the request came to, for the run's log lines
    * @return why the start was refused (Left), or the run started (Right), which may have failed
    *         before its engine started
    */
  def startStoredExecution(
      executionId: Long,
      planUri: URI,
      user: User,
      cuid: Int,
      sessionUri: URI
  ): Either[String, WorkflowExecutionService] =
    WorkflowService
      .checkStoredStart(executionId, planUri, user, cuid, Some(workflowId.id), readPlan)
      .flatMap(startChecked(_, sessionUri))

  /**
    * Starts the execution `start` names, a start of this workflow that passed its checks
    * ([[WorkflowService.checkStoredStart]]). Under the lock a new run is set up under (`runLock`),
    * the execution is claimed for its one start (a second start is refused, however it comes),
    * and the run this service holds is superseded. The run is built on the plan read back, under
    * the context it was read back with, given the unit the start was checked for, published to
    * the workflow's sessions, and started ([[WorkflowExecutionService.startStored]]).
    *
    * A start refused before its claim writes nothing, leaves the run this service holds as it is,
    * and is answered only to the caller. Once the execution is claimed, what fails is the run's
    * failure: reported through its error handler to every session on the workflow, and recorded.
    *
    * @param sessionUri the URI the request came to, for the run's log lines
    * @return why the start was refused, or why its run could not even be built (Left); or the run
    *         started (Right), which may have failed before its engine started
    */
  def startChecked(
      start: WorkflowService.CheckedStart,
      sessionUri: URI
  ): Either[String, WorkflowExecutionService] =
    if (start.workflowId != workflowId) {
      Left(s"the plan belongs to workflow ${start.workflowId.id}, not to this one")
    } else {
      val span = TexeraTracer.tracer
        .spanBuilder("WorkflowService.startStoredExecution")
        .setAttribute(SpanAttrs.WorkflowId, Long.box(workflowId.id))
        .setAttribute(SpanAttrs.ExecutionId, Long.box(start.executionId))
        .startSpan()
      val scope = span.makeCurrent()
      // Until the new run is started or has failed: no other request supersedes it meanwhile.
      runLock.lock()
      try {
        claimForStart(start.executionId, start.planUri).flatMap { _ =>
          startClaimedRun(start, sessionUri, span)
        }
      } finally {
        runLock.unlock()
        scope.close()
        span.end()
      }
    }

  /** Claims execution `executionId` for its one start, or says why it cannot be. */
  private def claimForStart(executionId: Long, planUri: URI): Either[String, Unit] =
    try Right(claimStart(planUri))
    catch {
      case started: ExecutionAlreadyStartedException => Left(started.getMessage)
      case _: NoStoredPlanException                  => Left(s"execution $executionId has no stored plan")
      // Every retry of the claim lost its commit to another commit on the plan table, such as a
      // change to a paused operator: a later start can win.
      case _: CommitFailedException =>
        Left(
          s"execution $executionId could not be claimed for its start, as its plan was being " +
            "changed; try starting it again"
        )
      case NonFatal(failure) =>
        logger.warn(s"Execution $executionId could not be claimed at $planUri.", failure)
        Left(s"execution $executionId could not be claimed for its start; try starting it again")
    }

  /**
    * Builds the run of the execution `start` names, which was just claimed for its start,
    * supersedes the run this service holds, publishes the new run in its place, and starts it.
    * Everything after the claim is the new run's: what fails is reported through its error
    * handler, which records it, and the run is published so its sessions see why. Only a run that
    * could not even be built is not published: the run this service holds stays, and the start
    * is answered why (Left), as the execution reads FAILED.
    */
  private def startClaimedRun(
      start: WorkflowService.CheckedStart,
      sessionUri: URI,
      span: Span
  ): Either[String, WorkflowExecutionService] = {
    val context = start.executionPlan.context
    val executionId = context.executionId
    val executionStateStore = new ExecutionStateStore()
    executionStateStore.metadataStore.updateState(_.withExecutionId(executionId))
    val errorHandler = runErrorHandler(executionStateStore)
    var built: Option[WorkflowExecutionService] = None
    var published = false
    try {
      // Until sub-part 20 removes the per-unit Python environments: a UDF finds its environment
      // on the unit its run's context names, and a plan read back names none, so without this a
      // UDF's environment would fall back to the engine's interpreter, silently. This is the unit
      // the start was asked of and checked for, which the plan row was made for.
      context.cuid = Some(start.cuid)
      org.apache.texera.web.observability.WorkflowMetricsRecorder.onStart(executionId)
      val execution = storedRun(context, executionStateStore, errorHandler)
      built = Some(execution)
      logger.info(
        s"Execution ${executionId.id} of workflow ${workflowId.id} starts on computing unit " +
          s"${start.cuid} from its plan at ${start.planUri}, as asked at " +
          s"${StoredExecutionStart.withoutSecrets(sessionUri)}."
      )
      supersedeCurrentRun()
      // Kept with the run, so the clean-up stops following it once the run is let go of.
      execution.addSubscription(lifeCycleManager.registerCleanUpOnStateChange(executionStateStore))
      executionService.onNext(execution)
      published = true
      execution.startStored(start.executionPlan, start.record, start.planUri).foreach { setupErr =>
        span.recordException(setupErr)
        span.setStatus(StatusCode.ERROR)
      }
      Right(execution)
    } catch {
      case NonFatal(failure) =>
        span.recordException(failure)
        span.setStatus(StatusCode.ERROR)
        errorHandler(failure)
        built match {
          case Some(execution) =>
            // The execution is claimed and will not start: its sessions are shown why.
            if (!published) executionService.onNext(execution)
            Right(execution)
          case None =>
            Left(
              s"execution ${start.executionId} could not be started, because of an error on " +
                "this computing unit"
            )
        }
    }
  }

  /**
    * Records what fails in a run in its `executionStateStore`: the run ends FAILED, at the time it
    * failed, with the failure as its error, of the operator and worker that raised it when a
    * worker did, which every session on the workflow is sent.
    */
  private def runErrorHandler(executionStateStore: ExecutionStateStore): Throwable => Unit = { t =>
    {
      val fromActorOpt = t match {
        case ex: WorkflowRuntimeException =>
          ex.relatedWorkerId
        case other =>
          None
      }
      val (operatorId, workerId) = getOperatorFromActorIdOpt(fromActorOpt)
      logger.error("error during execution", t)
      // Do NOT touch a setup span here: this handler is passed into
      // WorkflowExecutionService and invoked asynchronously (runtime,
      // websocket, startWorkflow callbacks) after the setup has
      // returned and its span has already ended, so recording onto it
      // would be a silent no-op. The failure is surfaced via the metadata
      // store below; setup-span errors are recorded where the run is set up.
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

  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    Option(executionService.getValue).foreach(_.unsubscribeAll())
    resultService.unsubscribeAll()
  }
}
