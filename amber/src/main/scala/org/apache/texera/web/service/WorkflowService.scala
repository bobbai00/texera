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
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, WorkflowContext}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  FAILED,
  KILLED
}
import org.apache.texera.amber.engine.common.executionrecord.ExecutionRecorder
import org.apache.texera.amber.error.ErrorUtils.{
  getOperatorFromActorIdOpt,
  getStackTraceWithAllCauses
}
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.observability.WorkflowMetricsRecorder
import org.apache.texera.web.service.WorkflowService.mkWorkflowStateId
import org.apache.texera.web.service.execution.{ExecutionResources, StoredExecutionStart}
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
    * `workflowId`; its plan row `record`, made for the user who asks and for the computing unit
    * asked; and the plan the row holds, read back.
    */
  final case class CheckedStart(
      executionId: Long,
      planUri: URI,
      workflowId: WorkflowIdentity,
      record: PlanRecord,
      executionPlan: ExecutionPlan
  )

  /** What a start is answered when its run could not even be built. */
  def notStarted(executionId: Long): String =
    s"Execution $executionId could not be started, because of an error on this computing unit."

  /**
    * Checks a request of `user` to start execution `executionId`, which the Dashboard service
    * created, on computing unit `cuid`, from the plan stored in its plan table at `planUri`, in
    * this order:
    *  1. A user is required.
    *  1. The URI is checked before any catalog is opened ([[StoredExecutionStart.checkUri]]).
    *  1. The plan row is read with `readPlan`, and checked: made for `user` and `cuid`, of the
    *     execution the table is of, with its replay logs where this unit keeps them and no input
    *     link expired ([[StoredExecutionStart.checkRecord]]).
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
        .toRight("A signed-in user is required to start an execution.")
      location <- StoredExecutionStart.checkUri(planUri, executionId, socketWorkflowId, uid)
      record <- storedPlanRow(executionId, planUri, readPlan)
      executionPlan <- StoredExecutionStart.checkRecord(
        record,
        location,
        uid,
        cuid,
        System.currentTimeMillis()
      )
    } yield CheckedStart(executionId, planUri, location.workflowId, record, executionPlan)

  /** The plan row of execution `executionId` at `planUri`, or why it cannot be had. */
  private def storedPlanRow(
      executionId: Long,
      planUri: URI,
      readPlan: URI => PlanRecord
  ): Either[String, PlanRecord] =
    try Right(readPlan(planUri))
    catch {
      case _: NoStoredPlanException => Left(StoredExecutionStart.noStoredPlan(executionId))
      // The row is there and is not one a plan table holds, such as a row with no body.
      case malformed @ (_: IllegalStateException | _: IllegalArgumentException) =>
        logger.warn(
          s"The plan row of execution $executionId at $planUri cannot be read.",
          malformed
        )
        Left(StoredExecutionStart.unreadablePlan(executionId, malformed))
      case NonFatal(failure) =>
        logger.warn(s"The plan of execution $executionId could not be read from $planUri.", failure)
        Left(s"The plan of execution $executionId could not be read. Run the workflow again.")
    }

  /**
    * Builds the run of a plan read back from the lake, before it is started: given the context
    * the plan was read back with, the result service of the run's workflow, the store of the
    * run's states and the handler of its errors.
    */
  type NewRun =
    (
        WorkflowContext,
        ExecutionResultService,
        ExecutionStateStore,
        Throwable => Unit
    ) => WorkflowExecutionService

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

/**
  * The runs of one workflow on this computing unit, one at a time, and what outlives a run: the
  * workflow's sessions and its results.
  *
  * @param readPlan    reads an execution's plan row from its plan table
  * @param claimStart  claims an execution for its one start, in its plan table
  * @param newRun      builds the run of a plan read back from the lake, before it is started
  * @param startRecord starts the record of a run that is about to be built, under its context
  */
class WorkflowService(
    val workflowId: WorkflowIdentity,
    val computingUnitId: Int,
    cleanUpTimeout: Int,
    readPlan: URI => PlanRecord = ExecutionPlanStore.readPlan,
    claimStart: URI => Unit = ExecutionPlanStore.claimStart,
    newRun: WorkflowService.NewRun =
      new WorkflowExecutionService(_, _, _, _, RepositoryMountManager.mountRoot),
    startRecord: WorkflowContext => ExecutionRecorder = ExecutionRecorder.start
) extends SubscriptionManager
    with LazyLogging {

  // state across execution:
  val stateStore = new WorkflowStateStore()
  var executionService: BehaviorSubject[WorkflowExecutionService] = BehaviorSubject.create()

  // Held while a start sets up a new run, from before it claims the execution until the new run
  // is set up or has failed, and while a run is superseded. So two starts never set up runs at
  // once, and a run is never superseded halfway through its setup, which would leave an engine
  // that no service holds. It is not held while a run that is set up waits for its Python
  // environments: such a run can be superseded, and then never starts its engine.
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
    * every subscription, shutting that run's engine down. A run that has not ended is then
    * recorded KILLED, as nobody watched it. A service that holds no run clears nothing. The run
    * is the one this service holds, not the newest of the workflow on its unit, which another
    * service, or an execution made and not yet started, may own.
    */
  private[service] def cleanUpAfterIdle(): Unit = {
    val held = Option(executionService.getValue)
    held.foreach(run => ExecutionResources.clearExecutionResources(run.workflowContext.executionId))
    WorkflowService.workflowServiceMapping.remove(mkWorkflowStateId(workflowId))
    unsubscribeAll()
    // Once the run is let go of, as when it is superseded: the kill does not arm the clean-up
    // that records it.
    held.foreach(
      _.executionStateStore.transitionTo(
        KILLED,
        reason = Some(s"stopped: nobody watched it for $cleanUpTimeout s")
      )
    )
  }

  /**
    * Lets go of the run this service holds, as the run of execution `replacedBy` is about to
    * take its place. A run that has not ended is killed: its engine is shut down, and it is
    * recorded KILLED. A run that has ended is only let go of, and so is a run that ends while it
    * is let go of: it keeps the state it ended in.
    *
    * The run is let go of before KILLED is recorded, so neither the sessions on the workflow nor
    * its idle clean-up hear of the kill: sessions see the new run take its place, and the kill
    * does not arm the clean-up. A run still being set up is let go of only once its setup is over
    * (see `runLock`).
    */
  def supersedeCurrentRun(replacedBy: ExecutionIdentity): Unit = {
    runLock.lock()
    try {
      Option(executionService.getValue).foreach { run =>
        // Shuts its engine down too, when it has one.
        run.unsubscribeAll()
        val killed = run.executionStateStore.transitionTo(
          KILLED,
          reason = Some(s"replaced by execution ${replacedBy.id}")
        )
        if (killed) {
          logger.info(
            s"Execution ${run.workflowContext.executionId.id} of workflow ${workflowId.id} is " +
              s"killed, as execution ${replacedBy.id} takes its place."
          )
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

  /**
    * Starts execution `executionId` of this workflow, which the Dashboard service created, from
    * the plan stored in its plan table at `planUri`, for `user` on computing unit `cuid`: the unit
    * the request to start it came to. The start is checked first
    * ([[WorkflowService.checkStoredStart]]: the user, the URI before any catalog is opened, then
    * the plan row), then started ([[startChecked]]).
    *
    * @return why the start was refused (Left), or the run started (Right), which may have failed
    *         before its engine started
    */
  def startStoredExecution(
      executionId: Long,
      planUri: URI,
      user: User,
      cuid: Int
  ): Either[String, WorkflowExecutionService] =
    WorkflowService
      .checkStoredStart(executionId, planUri, user, cuid, Some(workflowId.id), readPlan)
      .flatMap(startChecked)

  /**
    * Starts the execution `start` names, a start of this workflow that passed its checks
    * ([[WorkflowService.checkStoredStart]]). Under the lock a new run is set up under (`runLock`),
    * the execution is claimed for its one start (a second start is refused, however it comes),
    * and the run this service holds is superseded. The run is built on the plan read back, under
    * the context it was read back with, published to the workflow's sessions, and started
    * ([[WorkflowExecutionService.startStored]]).
    *
    * A start refused before its claim writes nothing, leaves the run this service holds as it is,
    * and is answered only to the caller. Once the execution is claimed, what fails is the run's
    * failure: reported through its error handler to every session on the workflow, and recorded.
    *
    * @return why the start was refused, or why its run could not even be built (Left); or the run
    *         started (Right), which may have failed before its engine started
    */
  def startChecked(start: WorkflowService.CheckedStart): Either[String, WorkflowExecutionService] =
    if (start.workflowId != workflowId) {
      Left(StoredExecutionStart.ofAnotherWorkflow(start.workflowId.id))
    } else {
      val span = TexeraTracer.tracer
        .spanBuilder("WorkflowService.startStoredExecution")
        .setAttribute(SpanAttrs.WorkflowId, Long.box(workflowId.id))
        .setAttribute(SpanAttrs.ExecutionId, Long.box(start.executionId))
        .startSpan()
      val scope = span.makeCurrent()
      // Until the new run is set up or has failed: no other request supersedes it meanwhile.
      runLock.lock()
      try {
        claimForStart(start.executionId, start.planUri).flatMap(_ => startClaimedRun(start, span))
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
      case _: ExecutionAlreadyStartedException =>
        Left(s"Execution $executionId was already started.")
      case _: NoStoredPlanException => Left(StoredExecutionStart.noStoredPlan(executionId))
      // Every retry of the claim lost its commit to another commit on the plan table, such as a
      // change to a paused operator.
      case _: CommitFailedException =>
        Left(
          s"Execution $executionId could not be claimed for its start, as its plan was being " +
            "changed. Run the workflow again."
        )
      case NonFatal(failure) =>
        logger.warn(s"Execution $executionId could not be claimed at $planUri.", failure)
        Left(s"Execution $executionId could not be claimed for its start. Run the workflow again.")
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
      span: Span
  ): Either[String, WorkflowExecutionService] = {
    val context = start.executionPlan.context
    val executionId = context.executionId
    // Recorded from here on: whatever fails once the execution is claimed is in its log.
    val executionStateStore = new ExecutionStateStore(startRecord(context))
    executionStateStore.metadataStore.updateState(_.withExecutionId(executionId))
    val errorHandler = runErrorHandler(executionStateStore)
    var built: Option[WorkflowExecutionService] = None
    var published = false
    try {
      WorkflowMetricsRecorder.onStart(executionId)
      val execution = newRun(context, resultService, executionStateStore, errorHandler)
      built = Some(execution)
      logger.info(
        s"Execution ${executionId.id} of workflow ${workflowId.id} starts on computing unit " +
          s"${start.record.computingUnitId} from its plan at ${start.planUri}."
      )
      supersedeCurrentRun(executionId)
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
          case None => Left(WorkflowService.notStarted(start.executionId))
        }
    }
  }

  /**
    * Records what fails in a run in its `executionStateStore`: the run ends FAILED, at the time it
    * failed, with the failure as its error, of the operator and worker that raised it when a
    * worker did, which every session on the workflow is sent. What fails in a run that has ended
    * is logged, and leaves the run as it ended.
    */
  private def runErrorHandler(executionStateStore: ExecutionStateStore): Throwable => Unit = { t =>
    {
      val fromActorOpt = t match {
        case ex: WorkflowRuntimeException =>
          ex.relatedWorkerId
        case _ =>
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
      executionStateStore.transitionTo(
        FAILED,
        errors = Seq(
          WorkflowFatalError(
            EXECUTION_FAILURE,
            Timestamp(Instant.now),
            t.toString,
            getStackTraceWithAllCauses(t),
            operatorId,
            workerId
          )
        )
      )
    }
  }

  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    Option(executionService.getValue).foreach(_.unsubscribeAll())
    resultService.unsubscribeAll()
  }
}
