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
import org.apache.texera.common.config.{ApplicationConfig, EnvironmentalVariable}
import org.apache.texera.observability.{SpanAttrs, TexeraTracer}
import org.apache.texera.amber.core.WorkflowRuntimeException
import org.apache.texera.amber.core.storage.RepositoryMountManager
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
import org.apache.texera.web.service.execution.ExecutionStart
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.apache.texera.web.{SubscriptionManager, WorkflowLifecycleManager}

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import scala.jdk.CollectionConverters.IterableHasAsScala
import scala.util.control.NonFatal

object WorkflowService extends LazyLogging {
  private val workflowServiceMapping = new ConcurrentHashMap[String, WorkflowService]()

  /**
    * The executions whose start this computing unit took since it came up: each starts once,
    * however often it is asked to ([[WorkflowService.startChecked]]).
    */
  val startedExecutions: java.util.Set[java.lang.Long] = ConcurrentHashMap.newKeySet()

  /**
    * A start of an execution that passed every check made before it is taken ([[checkStart]]),
    * with the plan it carried, read. The plan names the execution and its workflow.
    *
    * @param computingUnitId the computing unit the start was asked of
    * @param startedBy       the user who asked to start it: only they may change its operators
    */
  final case class CheckedStart(
      executionPlan: ExecutionPlan,
      computingUnitId: Int,
      startedBy: Int
  ) {
    def executionId: Long = executionPlan.context.executionId.id
    def workflowId: WorkflowIdentity = executionPlan.context.workflowId
  }

  /**
    * The computing unit this process is, where whatever started it said so (a unit the unit
    * manager creates is given its id). A unit nothing told, as in a single-node deployment, has
    * none, and takes the unit a request names.
    */
  lazy val configuredUnitId: Option[Int] =
    sys.env.get(EnvironmentalVariable.ENV_CU_ID).map(_.trim).flatMap(_.toIntOption)

  /**
    * What a start is answered when its run could not even be built.
    *
    * @param executionId the execution the start was of; None where its plan did not say
    */
  def notStarted(executionId: Option[Long]): String =
    executionId.fold("The execution")(id => s"Execution $id") +
      " could not be started, because of an error on this computing unit."

  /**
    * Checks a request of `user` to start an execution on computing unit `cuid`, from `plan`, the
    * plan the request carries, which names the execution and its workflow. A user is required,
    * and a unit that knows which unit it is starts only what was asked of that unit. The plan is
    * read and checked by [[ExecutionStart.check]]. Nothing is read or written.
    *
    * @param thisUnit the computing unit this one is, where it was told ([[configuredUnitId]]);
    *                 None where it was not, and `cuid` is then all it has to go by
    * @return why the start is refused (Left), or what it starts (Right)
    */
  def checkStart(
      plan: String,
      user: User,
      cuid: Int,
      thisUnit: Option[Int] = configuredUnitId
  ): Either[String, CheckedStart] =
    for {
      uid <- Option(user)
        .flatMap(user => Option(user.getUid))
        .map(_.intValue())
        .toRight("A signed-in user is required to start an execution.")
      _ <-
        thisUnit
          .filter(_ != cuid)
          .map(own => s"This is computing unit $own, not $cuid.")
          .toLeft(())
      executionPlan <- ExecutionStart.check(plan, uid, System.currentTimeMillis())
    } yield CheckedStart(executionPlan, cuid, uid)

  /**
    * Builds the run of a plan, before it is started: given the context the plan was read with,
    * the result service of the run's workflow, the store of the run's states and the handler of
    * its errors.
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

  /**
    * The run of execution `eid`, with the service of its workflow, when a service on this unit
    * holds it: from its start until another run takes its place or the service is cleaned up.
    */
  def holding(eid: Long): Option[(WorkflowService, WorkflowExecutionService)] =
    getAllWorkflowServices.iterator
      .flatMap(service => Option(service.executionService.getValue).map(service -> _))
      .find { case (_, run) => run.workflowContext.executionId.id == eid }

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
  * @param started     the executions whose start this unit took
  *                    ([[WorkflowService.startedExecutions]])
  * @param startRecord starts the record of a run that is about to be built, under its context
  */
class WorkflowService(
    val workflowId: WorkflowIdentity,
    val computingUnitId: Int,
    cleanUpTimeout: Int,
    started: java.util.Set[java.lang.Long] = WorkflowService.startedExecutions,
    newRun: WorkflowService.NewRun =
      new WorkflowExecutionService(_, _, _, _, RepositoryMountManager.mountRoot),
    startRecord: WorkflowContext => ExecutionRecorder = ExecutionRecorder.start
) extends SubscriptionManager
    with LazyLogging {

  // state across execution:
  val stateStore = new WorkflowStateStore()
  var executionService: BehaviorSubject[WorkflowExecutionService] = BehaviorSubject.create()

  // Held while a start sets up a new run, from before it takes the execution's start until the
  // new run is set up or has failed, and while a run is superseded. So two starts never set up
  // runs at once, and a run is never superseded halfway through its setup, which would leave an
  // engine that no service holds. It is not held while a run that is set up waits for its Python
  // environments: such a run can be superseded, and then never starts its engine.
  private val runLock = new ReentrantLock()

  val resultService: ExecutionResultService =
    new ExecutionResultService(workflowId, stateStore)
  val lifeCycleManager: WorkflowLifecycleManager = new WorkflowLifecycleManager(
    s"workflowId=$workflowId",
    cleanUpTimeout,
    () => cleanUpAfterIdle()
  )

  /**
    * What becomes of this service once nobody has used the workflow for the clean-up timeout: the
    * service leaves the registry and lets go of every subscription, shutting the engine of the
    * run it holds down. A run that has not ended is then recorded KILLED, as nobody watched it.
    * What the run stored stays: see [[execution.ExecutionExpiry]] for when it is dropped.
    */
  private[service] def cleanUpAfterIdle(): Unit = {
    val held = Option(executionService.getValue)
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
    * Counts its caller among those watching this workflow for as long as `body` runs, as an open
    * session is counted. A request that waits on a run watches it: the clean-up of a run nobody
    * watches must leave it alone, also before it is RUNNING (a run installing a Python
    * environment is READY for as long as the install takes).
    */
  def watching[A](body: => A): A = {
    lifeCycleManager.increaseUserCount()
    try body
    finally disconnect()
  }

  /**
    * Starts the execution `start` names, a start that passed its checks
    * ([[WorkflowService.checkStart]]); one of another workflow's execution is refused. Under
    * `runLock`, the execution's one start is taken (a
    * second start is refused, however it comes), and its run takes the place of the run this
    * service holds ([[startRun]]).
    *
    * A start refused before it is taken writes nothing, leaves the run this service holds as it
    * is, and is answered only to the caller. Once it is taken, what fails is the run's failure:
    * reported through its error handler to every session on the workflow, and recorded.
    *
    * @return why the start was refused, or why its run could not even be built (Left); or the run
    *         started (Right), which may have failed before its engine started
    */
  def startChecked(start: WorkflowService.CheckedStart): Either[String, WorkflowExecutionService] =
    if (start.workflowId != workflowId) {
      Left(ExecutionStart.ofAnotherWorkflow(start.workflowId.id))
    } else {
      val span = TexeraTracer.tracer
        .spanBuilder("WorkflowService.startExecution")
        .setAttribute(SpanAttrs.WorkflowId, Long.box(workflowId.id))
        .setAttribute(SpanAttrs.ExecutionId, Long.box(start.executionId))
        .startSpan()
      val scope = span.makeCurrent()
      // Until the new run is set up or has failed: no other request supersedes it meanwhile.
      runLock.lock()
      try {
        if (started.add(start.executionId)) startRun(start, span)
        else Left(s"Execution ${start.executionId} was already started.")
      } finally {
        runLock.unlock()
        scope.close()
        span.end()
      }
    }

  /**
    * Builds the run of the execution `start` names, whose start was just taken, supersedes the
    * run this service holds, publishes the new run in its place, and starts it.
    * A run that fails is still published, so its sessions see why. Only a run that could not even
    * be built is not: the run this service holds stays, and the start is answered why (Left), as
    * the execution reads FAILED.
    */
  private def startRun(
      start: WorkflowService.CheckedStart,
      span: Span
  ): Either[String, WorkflowExecutionService] = {
    val context = start.executionPlan.context
    val executionId = context.executionId
    // Recorded from here on: whatever fails once the start is taken is in its log.
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
          s"${start.computingUnitId}."
      )
      supersedeCurrentRun(executionId)
      // Kept with the run, so the clean-up stops following it once the run is let go of.
      execution.addSubscription(lifeCycleManager.registerCleanUpOnStateChange(executionStateStore))
      executionService.onNext(execution)
      published = true
      execution.startPlan(start.executionPlan, start.startedBy).foreach { setupErr =>
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
            // The execution's start is taken and it will not start: its sessions are shown why.
            if (!published) executionService.onNext(execution)
            Right(execution)
          case None => Left(WorkflowService.notStarted(Some(start.executionId)))
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
