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

import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import io.reactivex.rxjava3.disposables.Disposable
import org.apache.texera.amber.core.WorkflowRuntimeException
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  DocumentFactory,
  ExecutionTables,
  VFSURIFactory
}
import org.apache.texera.amber.core.storage.result.{OperatorResultMetadata, WorkflowResultStore}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ActorVirtualIdentity,
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionPlan,
  GlobalPortIdentity,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PortIdentity,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  KILLED,
  PAUSED,
  RUNNING
}
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.amber.error.ErrorUtils.getStackTraceWithAllCauses
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.websocket.event.ExecutionDurationUpdateEvent
import org.apache.texera.web.WorkflowLifecycleManager
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WebResultUpdateEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.io.IOException
import java.util.UUID
import java.util.concurrent.{
  ConcurrentHashMap,
  CountDownLatch,
  Executors,
  TimeUnit,
  TimeoutException
}
import scala.collection.concurrent.TrieMap
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, ExecutionContext, Future}
import scala.jdk.CollectionConverters.ListHasAsScala

/**
  * Unit tests for the per-workflow service that outlives a single execution: it owns the
  * cross-execution state store, republishes each new execution to every connected client, and
  * decides what becomes of the previous execution's subscriptions when a new one arrives.
  *
  * Two collaborators are stubbed, both for reasons that would otherwise make these paths
  * untestable rather than merely inconvenient:
  *
  *   - `lifeCycleManager`. The real one schedules the clean-up through `AmberRuntime`'s global
  *     actor system, which no unit test starts, and its callback shuts down the execution's
  *     Amber client. Stubbing it also makes the two
  *     things `WorkflowService` actually contributes here observable: that `connect` registers a
  *     user, and that `disconnect` reports the *current execution's* state (the value that decides
  *     whether clean-up is postponed).
  *   - `resultService`, so that the third line of `unsubscribeAll` is pinned. A real
  *     `ExecutionResultService` holds no subscriptions until `attachToExecution` gives it a live
  *     Amber client, so "unsubscribed" would be indistinguishable from "never called".
  *
  * Executions are real `WorkflowExecutionService` instances with `resultService` passed as `null`
  * (the pattern `WorkflowExecutionServiceSpec` establishes: construction does no external work), so
  * the events observed here travel through the production diff handler.
  *
  * The idle clean-up cases pin that the service lets go of the run it holds and records how
  * that run ended, and that it clears no storage: what a run stored is the Dashboard service's
  * to expire (`ExecutionExpirySpec`).
  *
  * The superseded-run and idle clean-up cases run on executions of their own, on computing units
  * no other case uses.
  *
  * The cases of a start (`startExecution`) start their executions from plans made here, as text,
  * as a client hands them. Their runs record the plan they are started from instead of building
  * an engine (`StartService`): `WorkflowExecutionServiceSpec` owns what a run does with its plan,
  * and `ExecutionStartSpec` every check a start makes of a plan.
  */
class WorkflowServiceSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll {

  /** Long enough that a stray clean-up deadline could never fire inside a test run. */
  private val cleanUpTimeoutSecs = 3600

  private class TrackingDisposable extends Disposable {
    private var disposed = false

    override def dispose(): Unit = disposed = true

    override def isDisposed: Boolean = disposed
  }

  /** Records what `WorkflowService` reports, and never schedules the real clean-up. */
  private final class RecordingLifecycleManager
      extends WorkflowLifecycleManager("WorkflowServiceSpec", cleanUpTimeoutSecs, () => ()) {
    var increaseCount = 0
    val reportedStates: ArrayBuffer[Option[WorkflowAggregatedState]] = ArrayBuffer.empty

    override def increaseUserCount(): Unit = increaseCount += 1

    override def decreaseUserCount(currentWorkflowState: Option[WorkflowAggregatedState]): Unit =
      reportedStates += currentWorkflowState

    val registeredStores: ArrayBuffer[ExecutionStateStore] = ArrayBuffer.empty

    /** Each state that reached the clean-up, with the store it came from, in order. */
    val followedStates: ArrayBuffer[(ExecutionStateStore, WorkflowAggregatedState)] =
      ArrayBuffer.empty

    /**
      * The real one subscribes to the store's state observable, which replays the current state
      * to a new subscriber straight away; the resulting deadline is scheduled through
      * `AmberRuntime`'s actor system, null outside a started coordinator. Left in place, every
      * state update of a run a start publishes raises an NPE inside an RxJava consumer.
      *
      * Recorded rather than discarded, because this call is the single statement that arms the
      * whole deferred clean-up: stubbed to a no-op it would also be unkillable, and a build in
      * which a start never registers the deadline would look identical. The states the
      * subscription it returns delivers are recorded too, in place of arming the deadline, so a
      * case can see which states still reach the clean-up.
      */
    override def registerCleanUpOnStateChange(stateStore: ExecutionStateStore): Disposable = {
      registeredStores += stateStore
      stateStore.metadataStore.getStateObservable.subscribe { state: ExecutionMetadataStore =>
        followedStates += ((stateStore, state.state))
      }
    }
  }

  private final class RecordingResultService(
      workflowId: WorkflowIdentity,
      computingUnitId: Int,
      stateStore: WorkflowStateStore
  ) extends ExecutionResultService(workflowId, stateStore) {
    var unsubscribeCount = 0

    override def unsubscribeAll(): Unit = {
      unsubscribeCount += 1
      super.unsubscribeAll()
    }
  }

  private final class TestWorkflowService(id: Long, cuid: Int = 1)
      extends WorkflowService(WorkflowIdentity(id), computingUnitId = cuid, cleanUpTimeoutSecs) {
    val lifecycle = new RecordingLifecycleManager
    override val lifeCycleManager: WorkflowLifecycleManager = lifecycle
    val results = new RecordingResultService(workflowId, computingUnitId, stateStore)
    override val resultService: ExecutionResultService = results
  }

  /**
    * A service of the fixture workflow, made for computing unit `serviceCuid`, whose runs record
    * what they are started from, and fail with `startFailure` if given, instead of building an
    * engine: `WorkflowExecutionServiceSpec` owns what a run does with its plan. It keeps which
    * executions it started apart from every other service's. `supersedeFailure` fails its
    * supersede, and `buildFailure` the building of a run. `whileStarting` runs while a run is
    * started, which is while it is being set up. `started` is what each run was started from: its
    * plan, and the user who started it. `records` is what each run's record was told, by
    * execution: a run's record is started before the run is built, and is a
    * [[RecordingExecutionRecorder]].
    */
  private final class StartService(
      startFailure: Option[RuntimeException] = None,
      serviceCuid: Int = storedCuid,
      supersedeFailure: Option[RuntimeException] = None,
      buildFailure: Option[RuntimeException] = None,
      whileStarting: () => Unit = () => (),
      val started: ArrayBuffer[(ExecutionPlan, Int)] = ArrayBuffer.empty,
      val records: TrieMap[Long, RecordingExecutionRecorder] = TrieMap.empty
  ) extends WorkflowService(
        WorkflowIdentity(testWid.toLong),
        serviceCuid,
        cleanUpTimeoutSecs,
        started = ConcurrentHashMap.newKeySet(),
        newRun = (context, _, executionStateStore, errorHandler) => {
          buildFailure.foreach(failure => throw failure)
          new WorkflowExecutionService(context, null, executionStateStore, errorHandler, None) {
            override def startPlan(
                executionPlan: ExecutionPlan,
                startedBy: Int
            ): Option[Throwable] = {
              started += ((executionPlan, startedBy))
              whileStarting()
              startFailure.foreach(failure => throw failure)
              None
            }
          }
        },
        startRecord = context =>
          records.getOrElseUpdate(context.executionId.id, new RecordingExecutionRecorder)
      ) {
    val lifecycle = new RecordingLifecycleManager
    override val lifeCycleManager: WorkflowLifecycleManager = lifecycle

    override def supersedeCurrentRun(replacedBy: ExecutionIdentity): Unit =
      supersedeFailure.fold(super.supersedeCurrentRun(replacedBy))(failure => throw failure)
  }

  // ---------------------------------------------------------------------------
  // Fixtures: the ids of the workflow, the user, the computing units and the executions the
  // cases run. A unit has no database, so none of them has a row anywhere.
  // ---------------------------------------------------------------------------

  // A different literal for each id domain, so a transposition of two of them cannot go unseen.
  private val testWid = 9411
  private val testUid = 9413

  /** A unit no fixture execution was created for. */
  private val testCuid = 9414

  /** The unit the superseded-run cases run on. */
  private val supersedeCuid = 9418

  /** The unit the idle clean-up cases run on. */
  private val idleCuid = 9419

  /** The unit the executions started by id were created for. */
  private val storedCuid = 9423

  // The executions' ids are the suite's own: the tables the cases make in the lake are named
  // after them.

  /** The superseded-run cases' execution, on `supersedeCuid`. */
  private val supersededEid = 941105

  /** The execution the idle clean-up cases' service holds, on `idleCuid`. */
  private val heldIdleEid = 941106

  /**
    * Executions created for `storedCuid` and started from their plans: one is started, one is
    * refused, and one fails once its start is taken.
    */
  private val startedEid = 941109
  private val refusedEid = 941110
  private val failedEid = 941112

  /** The run a start supersedes, on `storedCuid`. */
  private val heldStoredEid = 941113

  /**
    * Executions created for `storedCuid` too: one started on a service made for another unit, one
    * whose supersede fails before its run is published, and one whose run cannot be built.
    */
  private val askedUnitEid = 941114
  private val unpublishedEid = 941115
  private val unbuiltEid = 941116

  /**
    * And three more: one whose run the idle clean-up follows until the run of the next
    * supersedes it, and one another request tries to supersede while its run is being set up.
    */
  private val followedEid = 941117
  private val followingEid = 941118
  private val setUpEid = 941119

  /** And one whose run fails with a failure a worker raised. */
  private val failedByWorkerEid = 941120

  /** And one whose run the idle clean-up finds paused. */
  private val idlePausedEid = 941121

  private val executingUser: User = {
    val user = new User
    user.setUid(testUid)
    user.setName("workflow_service_spec_user")
    user.setEmail(s"workflow-service-${UUID.randomUUID()}@example.com")
    user
  }

  /**
    * A run that was never started, as a start builds one; of execution `eid` when given, which
    * its context and its metadata store then name, as a start sets them. Its record keeps what it
    * is told ([[recordOf]]).
    */
  private def newExecution(eid: Option[Int] = None): WorkflowExecutionService = {
    val context = new WorkflowContext()
    val stateStore = new ExecutionStateStore(new RecordingExecutionRecorder)
    eid.foreach { eid =>
      context.executionId = ExecutionIdentity(eid.toLong)
      stateStore.metadataStore.updateState(_.withExecutionId(ExecutionIdentity(eid.toLong)))
    }
    new WorkflowExecutionService(context, null, stateStore, (_: Throwable) => (), None)
  }

  /** What the record of `run` was told: the state and the reason of each change, in order. */
  private def recordOf(run: WorkflowExecutionService): Seq[(String, Option[String])] =
    run.executionStateStore.recorder match {
      case recording: RecordingExecutionRecorder => recording.states
      case other                                 => fail(s"the run's record is a $other")
    }

  /** An execution that takes the place of the superseded-run cases' runs. */
  private val replacingEid = ExecutionIdentity(941199L)

  /**
    * The plan the Dashboard answers for execution `eid` of workflow `wid`, the fixture workflow
    * unless said: a plan of one source, `lines`.
    */
  private def planOf(eid: Int, wid: Long = testWid.toLong): String = {
    val context = new WorkflowContext(
      WorkflowIdentity(wid),
      ExecutionIdentity(eid.toLong),
      WorkflowSettings(dataTransferBatchSize = 64)
    )
    val lines = PhysicalOp
      .sourcePhysicalOp(
        PhysicalOpIdentity(OperatorIdentity("lines"), "main"),
        context.workflowId,
        context.executionId,
        OpExecWithClassName("unused")
      )
      .copy(outputPorts =
        Map(
          PortIdentity() -> (
            OutputPort(),
            List.empty,
            Right(Schema().add("line", AttributeType.STRING))
          )
        )
      )
      .withStorageLocations(None)
    PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.encode(ExecutionPlan(context, PhysicalPlan(Set(lines), Set.empty)))
    )
  }

  /** A run of fixture execution `eid` that is running, held by `service`. */
  private def holdRunningRun(service: WorkflowService, eid: Int): WorkflowExecutionService = {
    val held = newExecution(Some(eid))
    service.executionService.onNext(held)
    held.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    held
  }

  /**
    * Runs `body` and answers what it gave, with the lines the loggers under `name` wrote
    * meanwhile, every level, from any thread, each with the message of what it logged as its
    * cause.
    */
  private def linesLoggedBy[T](name: String)(body: => T): (T, Seq[String]) = {
    val logger = LoggerFactory.getLogger(name).asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val previousLevel = logger.getLevel
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.ALL)
    try {
      val result = body
      val lines = appender.list.asScala.toList.map { event =>
        event.getFormattedMessage +
          Option(event.getThrowableProxy).fold("")(cause => s" ${cause.getMessage}")
      }
      (result, lines)
    } finally {
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  /** Collects the events an execution's metadata store emits, in subscription order. */
  private def collectExecutionEvents(
      execution: WorkflowExecutionService
  ): ArrayBuffer[TexeraWebSocketEvent] = {
    val events = ArrayBuffer.empty[TexeraWebSocketEvent]
    execution.executionStateStore.metadataStore.getWebsocketEventObservable.subscribe {
      (evts: Iterable[TexeraWebSocketEvent]) => events ++= evts
    }
    events
  }

  "WorkflowService" should "forward workflow-level events to a connected client until the subscription is disposed" in {
    val service = new TestWorkflowService(2L)
    val events = ArrayBuffer.empty[TexeraWebSocketEvent]
    // The production diff handler on the result store is registered by
    // ExecutionResultService.attachToExecution, which needs a live client; register one here so the
    // store has something to emit and the wiring `connect` sets up is observable.
    // TWO events from a single diff on purpose: the forwarding closure does `evts.foreach(onNext)`,
    // and a one-event diff cannot tell that from `evts.headOption.foreach(onNext)`. Multi-event
    // diffs are real -- WorkflowExecutionService's own handler appends a state event and an error
    // event together.
    service.stateStore.resultStore.registerDiffHandler((_, _) =>
      Iterable(
        WebResultUpdateEvent(Map.empty, Map.empty),
        WebResultUpdateEvent(Map.empty, Map.empty)
      )
    )

    val disposable = service.connect(events += _)
    service.lifecycle.increaseCount shouldBe 1

    val update: WorkflowResultStore => WorkflowResultStore =
      _ => WorkflowResultStore(Map(OperatorIdentity("op") -> OperatorResultMetadata(1)))
    service.stateStore.resultStore.updateState(update)
    events should have size 2

    disposable.dispose()
    service.stateStore.resultStore.updateState(_ => WorkflowResultStore(Map.empty))
    events should have size 2
  }

  it should "forward events from the newest execution only, and stop when disposed" in {
    val service = new TestWorkflowService(3L)
    val events = ArrayBuffer.empty[TexeraWebSocketEvent]
    val disposable = service.connectToExecution(events += _)

    val first = newExecution()
    service.executionService.onNext(first)
    first.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    events.collect { case e: WorkflowStateEvent => e.state } should contain("Running")

    // Publishing a second execution must drop the first execution's subscriptions; otherwise a
    // stale run keeps pushing state events into a client that has moved on.
    val second = newExecution()
    service.executionService.onNext(second)
    events.clear()
    first.executionStateStore.metadataStore.updateState(_.withState(PAUSED))
    events shouldBe empty

    second.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    events should have size 1

    // A second store, because the subscription is built by mapping over getAllStores: driving only
    // the metadata store would let the fan-out be narrowed to that one store, silently cutting a
    // connected client off from stats, console, breakpoint and reconfiguration events. The stats
    // store's production diff handler is registered by ExecutionStatsService, which is not attached
    // here, so one is registered directly to give the store something to emit.
    events.clear()
    // Two events from the one diff, for the same reason as the workflow-level test above: the
    // execution-side closure also does `events.foreach(onNext)`, and a single-event diff cannot
    // distinguish that from `events.headOption.foreach(onNext)`.
    second.executionStateStore.statsStore.registerDiffHandler((_, _) =>
      Iterable(
        ExecutionDurationUpdateEvent(7L, isRunning = true),
        ExecutionDurationUpdateEvent(8L, isRunning = true)
      )
    )
    second.executionStateStore.statsStore.updateState(_.withStartTimeStamp(1234L))
    events.collect { case e: ExecutionDurationUpdateEvent => e } should have size 2

    // Cleared so the assertion below counts only what arrives AFTER dispose, rather than being
    // sensitive to how many events the checks above happened to accumulate.
    events.clear()
    disposable.dispose()
    second.executionStateStore.metadataStore.updateState(_.withState(PAUSED))
    events shouldBe empty

    // Not asserted here, deliberately: dropping the outer `disposable` (the executionService
    // handle) from the "DO NOT OPTIMIZE" composite leaks that subscription but changes no
    // observable behaviour, because the already-disposed localDisposable immediately disposes
    // anything a later callback adds to it. A test for it would assert on subscriber bookkeeping
    // rather than on behaviour.
  }

  it should "report the current execution's state when a client disconnects" in {
    val service = new TestWorkflowService(4L)

    service.disconnect()
    service.lifecycle.reportedStates shouldBe Seq(None)

    val execution = newExecution()
    service.executionService.onNext(execution)
    execution.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    service.disconnect()
    // A running execution is what postpones the clean-up deadline, so the state has to travel.
    service.lifecycle.reportedStates.last shouldBe Some(RUNNING)

    // A second, different state. With RUNNING as the only non-empty case, the read could be
    // replaced by the constant RUNNING and this test would still pass -- and that constant would
    // postpone clean-up for every workflow that ever held an execution, since
    // WorkflowLifecycleManager.decreaseUserCount branches on exactly this value.
    execution.executionStateStore.metadataStore.updateState(_.withState(COMPLETED))
    service.disconnect()
    service.lifecycle.reportedStates.last shouldBe Some(COMPLETED)
  }

  it should "count a request among those watching the workflow while it runs, and let go of it as of a session" in {
    val service = new TestWorkflowService(6L)
    val execution = newExecution()
    service.executionService.onNext(execution)
    execution.executionStateStore.metadataStore.updateState(_.withState(RUNNING))

    service.watching {
      // Counted before the request does anything, and until it is over.
      service.lifecycle.increaseCount shouldBe 1
      service.lifecycle.reportedStates shouldBe empty
      "answered"
    } shouldBe "answered"
    // Let go of as a session that disconnects is, with the state its run is in: a run still
    // running is what keeps the clean-up from being armed for a workflow nobody watches.
    service.lifecycle.increaseCount shouldBe 1
    service.lifecycle.reportedStates shouldBe Seq(Some(RUNNING))

    // A request that fails is let go of too, and its failure is its caller's.
    val failure = new IllegalStateException("the request failed")
    (the[IllegalStateException] thrownBy service.watching[Unit](throw failure)) should
      be theSameInstanceAs failure
    service.lifecycle.increaseCount shouldBe 2
    service.lifecycle.reportedStates shouldBe Seq(Some(RUNNING), Some(RUNNING))
  }

  it should "dispose its own, the execution's and the result service's subscriptions" in {
    val service = new TestWorkflowService(5L)
    val ownSubscription = new TrackingDisposable
    service.addSubscription(ownSubscription)
    val execution = newExecution()
    service.executionService.onNext(execution)
    val events = collectExecutionEvents(execution)

    service.unsubscribeAll()

    ownSubscription.isDisposed shouldBe true
    service.results.unsubscribeCount shouldBe 1
    execution.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    events shouldBe empty
  }

  it should "record a live run it supersedes as killed, and tell no client" in {
    val service = new TestWorkflowService(testWid.toLong, supersedeCuid)
    val previous = newExecution(Some(supersededEid))
    service.executionService.onNext(previous)
    previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    val clientEvents = ArrayBuffer.empty[TexeraWebSocketEvent]
    service.connectToExecution(clientEvents += _)
    clientEvents.clear()

    val before = System.currentTimeMillis()
    service.supersedeCurrentRun(replacingEid)
    val after = System.currentTimeMillis()

    // Its store reads Killed.
    previous.executionStateStore.metadataStore.getState.state shouldBe KILLED
    previous.executionStateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
    // Its record says what took its place.
    recordOf(previous) shouldBe Seq(("KILLED", Some("replaced by execution 941199")))
    // It was let go of first, so a connected client heard nothing of the kill, and hears nothing
    // of it after.
    clientEvents shouldBe empty
    previous.executionStateStore.metadataStore.updateState(_.withState(PAUSED))
    clientEvents shouldBe empty
  }

  it should "only let go of a finished run it supersedes, recording nothing" in {
    Seq(COMPLETED, WorkflowAggregatedState.FAILED, KILLED, WorkflowAggregatedState.TERMINATED)
      .foreach { finished =>
        withClue(s"a run that is $finished: ") {
          val service = new TestWorkflowService(testWid.toLong, supersedeCuid)
          val previous = newExecution(Some(supersededEid))
          service.executionService.onNext(previous)
          previous.executionStateStore.metadataStore.updateState(_.withState(finished))
          val events = collectExecutionEvents(previous)
          // A new subscriber is first told the store's state, as a reconnecting client is.
          events.clear()

          service.supersedeCurrentRun(replacingEid)

          previous.executionStateStore.metadataStore.getState.state shouldBe finished
          previous.executionStateStore.statsStore.getState.endTimeStamp shouldBe 0L
          recordOf(previous) shouldBe empty
          // let go of: its own subscriptions are gone
          previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
          events shouldBe empty
        }
      }
  }

  it should "do nothing when superseding while it holds no run" in {
    val service = new TestWorkflowService(testWid.toLong, supersedeCuid)
    service.supersedeCurrentRun(replacingEid)
    Option(service.executionService.getValue) shouldBe None
  }

  it should "let go of the run it holds once idle, and leave what the run stored where it is" in {
    val service = new TestWorkflowService(testWid.toLong, idleCuid)
    val held = newExecution(Some(heldIdleEid))
    service.executionService.onNext(held)
    val ownSubscription = new TrackingDisposable
    service.addSubscription(ownSubscription)
    // What the run stored: the result of a port, and its console.
    val (wid, eid) = (WorkflowIdentity(testWid.toLong), ExecutionIdentity(heldIdleEid.toLong))
    val result = VFSURIFactory.resultURI(
      VFSURIFactory.createPortBaseURI(
        wid,
        eid,
        GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("lines"), "main"), PortIdentity())
      )
    )
    DocumentFactory.createDocument(result, Schema().add("line", AttributeType.STRING))
    val console = ConsoleMessageStore.consoleUri(wid, eid, None)
    ConsoleMessageStore.create(console)
    try {
      service.cleanUpAfterIdle()

      // A unit drops nothing.
      Seq(result, console).foreach { uri =>
        withClue(s"$uri: ") { ExecutionTables.exists(uri) shouldBe true }
      }
      // and the service lets go of everything, the run it holds included, which never started
      ownSubscription.isDisposed shouldBe true
      service.results.unsubscribeCount shouldBe 1
    } finally Seq(result, console).foreach(ExecutionTables.drop)
  }

  it should "record a run that has not ended as killed once idle, saying that nobody watched it" in {
    Seq(WorkflowAggregatedState.READY, PAUSED).foreach { state =>
      withClue(s"a run that is $state: ") {
        val service = new TestWorkflowService(testWid.toLong, idleCuid)
        val held = newExecution(Some(heldIdleEid))
        service.executionService.onNext(held)
        held.executionStateStore.metadataStore.updateState(_.withState(state))
        val events = collectExecutionEvents(held)
        events.clear()

        val before = System.currentTimeMillis()
        service.cleanUpAfterIdle()
        val after = System.currentTimeMillis()

        held.executionStateStore.metadataStore.getState.state shouldBe KILLED
        held.executionStateStore.statsStore.getState.endTimeStamp should
          (be >= before and be <= after)
        recordOf(held) shouldBe
          Seq(("KILLED", Some(s"stopped: nobody watched it for $cleanUpTimeoutSecs s")))
        // It was let go of first: nothing that followed its state heard of the kill.
        events shouldBe empty
      }
    }
  }

  it should "leave a run that has ended as it ended once idle" in {
    Seq(COMPLETED, WorkflowAggregatedState.FAILED, KILLED).foreach { ended =>
      withClue(s"a run that is $ended: ") {
        val service = new TestWorkflowService(testWid.toLong, idleCuid)
        val held = newExecution(Some(heldIdleEid))
        service.executionService.onNext(held)
        held.executionStateStore.metadataStore.updateState(_.withState(ended))

        service.cleanUpAfterIdle()

        held.executionStateStore.metadataStore.getState.state shouldBe ended
        held.executionStateStore.statsStore.getState.endTimeStamp shouldBe 0L
        recordOf(held) shouldBe empty
      }
    }
  }

  it should "let go of its subscriptions once idle when it holds no run" in {
    val service = new TestWorkflowService(testWid.toLong, idleCuid)
    val ownSubscription = new TrackingDisposable
    service.addSubscription(ownSubscription)

    service.cleanUpAfterIdle()

    ownSubscription.isDisposed shouldBe true
  }

  "WorkflowService.startExecution" should
    "take the execution's start, supersede the live run, and start a run of the plan on the unit asked" in {
    val plan = planOf(startedEid)
    val service = new StartService()
    val held = holdRunningRun(service, heldStoredEid)
    val heldEvents = collectExecutionEvents(held)
    heldEvents.clear()

    val (started, logged) = linesLoggedBy("org.apache.texera.web") {
      service
        .startExecution(plan, executingUser, storedCuid)
        .getOrElse(fail("the start was refused"))
    }

    // The start is logged, with the unit asked.
    logged.filter(_.contains(s"Execution $startedEid of workflow $testWid starts")) shouldBe Seq(
      s"Execution $startedEid of workflow $testWid starts on computing unit $storedCuid."
    )
    // The run it held reads Killed, in its store and its record, which names the execution
    // that took its place, and no session was told of it.
    held.executionStateStore.metadataStore.getState.state shouldBe KILLED
    recordOf(held) shouldBe Seq(("KILLED", Some(s"replaced by execution $startedEid")))
    heldEvents shouldBe empty
    // The new run is published in its place, and followed by the idle clean-up.
    service.executionService.getValue should be theSameInstanceAs started
    service.lifecycle.registeredStores.last should be theSameInstanceAs started.executionStateStore
    started.executionStateStore.metadataStore.getState.executionId shouldBe
      ExecutionIdentity(startedEid.toLong)
    // It was started from the plan the start carried, for the user who asked, under the context
    // the plan was read with: its ids and settings.
    service.started should have size 1
    val (executionPlan, startedBy) = service.started.head
    startedBy shouldBe testUid
    executionPlan.plan.operators.map(_.id) shouldBe
      Set(PhysicalOpIdentity(OperatorIdentity("lines"), "main"))
    started.workflowContext should be theSameInstanceAs executionPlan.context
    started.workflowContext.executionId shouldBe ExecutionIdentity(startedEid.toLong)
    started.workflowContext.workflowSettings.dataTransferBatchSize shouldBe 64

    // A second start of it is refused, however it comes, leaving the run started as it is.
    service.startExecution(plan, executingUser, storedCuid) shouldBe
      Left(s"Execution $startedEid was already started.")
    service.executionService.getValue should be theSameInstanceAs started
    service.started should have size 1
  }

  it should "refuse a start whose plan it cannot run, leaving the held run alone" in {
    val service = new StartService()
    val held = holdRunningRun(service, heldStoredEid)

    // No plan, and the plan of another workflow: this service starts only its own workflow's.
    val ofAnotherWorkflow = planOf(refusedEid, wid = testWid.toLong + 1)
    service.startExecution("", executingUser, storedCuid) shouldBe
      Left("The request carries no plan.")
    service.startExecution(ofAnotherWorkflow, executingUser, storedCuid) shouldBe
      Left(s"The plan belongs to workflow ${testWid + 1}, not to this one.")
    // A start checked for another workflow, which the agent's path would have asked another
    // service to start. What it starts is what its plan names.
    val checked = WorkflowService
      .checkStart(ofAnotherWorkflow, executingUser, storedCuid, socketWorkflowId = None)
      .getOrElse(fail("the start was refused"))
    checked.workflowId shouldBe WorkflowIdentity(testWid.toLong + 1)
    checked.executionId shouldBe refusedEid
    service.startChecked(checked) shouldBe
      Left(s"The plan belongs to workflow ${testWid + 1}, not to this one.")

    service.started shouldBe empty
    service.executionService.getValue should be theSameInstanceAs held
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
    held.executionStateStore.metadataStore.getState.fatalErrors shouldBe empty
  }

  it should "refuse what was asked of another unit, where it was told which unit it is, before reading the plan" in {
    // Asked of the unit the execution was created for, but this is not that unit: a request sent
    // to the wrong unit, whatever unit it names. Its plan is not read: none would be.
    WorkflowService.checkStart(
      "not a plan",
      executingUser,
      storedCuid,
      socketWorkflowId = None,
      thisUnit = Some(storedCuid + 1)
    ) shouldBe Left(s"This is computing unit ${storedCuid + 1}, not $storedCuid.")
    // On the unit it was created for, it is checked as on a unit that was told nothing.
    Seq(Some(storedCuid), None).foreach { thisUnit =>
      WorkflowService
        .checkStart(
          planOf(refusedEid),
          executingUser,
          storedCuid,
          socketWorkflowId = None,
          thisUnit = thisUnit
        )
        .map(_.executionId) shouldBe Right(refusedEid)
    }
  }

  it should "check that a user asks before which unit it is" in {
    WorkflowService.checkStart(
      planOf(refusedEid),
      null,
      storedCuid,
      socketWorkflowId = None,
      thisUnit = Some(storedCuid + 1)
    ) shouldBe Left("A signed-in user is required to start an execution.")
  }

  it should "report a run that fails once its start is taken as that run's failure" in {
    val plan = planOf(failedEid)
    val failure =
      new IllegalStateException("the engine is gone", new IOException("connection reset"))
    val service = new StartService(startFailure = Some(failure))
    val held = holdRunningRun(service, heldStoredEid)

    val before = System.currentTimeMillis()
    val failed = service
      .startExecution(plan, executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))
    val after = System.currentTimeMillis()

    // Published, superseding the held run, and failed, at the time it failed.
    service.executionService.getValue should be theSameInstanceAs failed
    held.executionStateStore.metadataStore.getState.state shouldBe KILLED
    failed.executionStateStore.metadataStore.getState.state shouldBe
      WorkflowAggregatedState.FAILED
    failed.executionStateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
    // The failure is the run's one error, which every session on the workflow is sent: its text,
    // and the trace of it and of every cause. No worker raised it, so it is no operator's.
    val errors = failed.executionStateStore.metadataStore.getState.fatalErrors
    errors should have size 1
    errors.head.`type` shouldBe EXECUTION_FAILURE
    errors.head.message shouldBe "java.lang.IllegalStateException: the engine is gone"
    errors.head.details shouldBe getStackTraceWithAllCauses(failure)
    errors.head.details should include("java.io.IOException: connection reset")
    errors.head.operatorId shouldBe "unknown operator"
    errors.head.workerId shouldBe ""
    errors.head.timestamp.seconds should (be >= before / 1000 and be <= after / 1000)
    // The run's record, started before the run was built, holds its end with that error.
    val recorded = service.records(failedEid.toLong).changes
    recorded.map(change => (change.state, change.reason)) shouldBe Seq(("FAILED", None))
    recorded.head.errors shouldBe errors
  }

  it should "report a failure a worker raised as its operator's error, naming the worker" in {
    val plan = planOf(failedByWorkerEid)
    val worker = ActorVirtualIdentity(s"Worker:WF$testWid-lines-main-0")
    val service = new StartService(
      startFailure = Some(new WorkflowRuntimeException("the worker lost its input", Some(worker)))
    )

    val failed = service
      .startExecution(plan, executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))

    val errors = failed.executionStateStore.metadataStore.getState.fatalErrors
    errors.map(error => (error.`type`, error.operatorId, error.workerId)) shouldBe
      Seq((EXECUTION_FAILURE, "lines", worker.name))
    errors.head.message should include("the worker lost its input")
  }

  it should "start a run for the unit the start was asked of, not the one the workflow's service was made for" in {
    // The first session of a workflow makes its service, for that session's unit, and every later
    // session of the workflow shares it, on whichever unit (#7676).
    val plan = planOf(askedUnitEid)
    val service = new StartService(serviceCuid = testCuid)
    service.computingUnitId shouldBe testCuid

    val (answer, logged) = linesLoggedBy("org.apache.texera.web") {
      service.startExecution(plan, executingUser, storedCuid)
    }

    answer.isRight shouldBe true
    service.started should have size 1
    logged.count(
      _.contains(
        s"Execution $askedUnitEid of workflow $testWid starts on computing unit $storedCuid"
      )
    ) shouldBe 1
  }

  it should "publish a run that fails before it is published, so its sessions see why" in {
    val plan = planOf(unpublishedEid)
    val service =
      new StartService(supersedeFailure = Some(new IllegalStateException("cannot supersede")))
    val held = holdRunningRun(service, heldStoredEid)

    val failed = service
      .startExecution(plan, executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))

    // Its start taken, so never to start again: published FAILED in the held run's place, with
    // the reason, which every session on the workflow is sent.
    service.executionService.getValue should be theSameInstanceAs failed
    failed.workflowContext.executionId shouldBe ExecutionIdentity(unpublishedEid.toLong)
    failed.executionStateStore.metadataStore.getState.state shouldBe
      WorkflowAggregatedState.FAILED
    failed.executionStateStore.metadataStore.getState.fatalErrors.map(_.message) shouldBe
      Seq("java.lang.IllegalStateException: cannot supersede")
    collectExecutionEvents(failed).collect { case errors: WorkflowErrorEvent => errors } should
      not be empty
    recordOf(failed) shouldBe Seq(("FAILED", None))
    service.started shouldBe empty
    // The supersede failed before it touched the held run.
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
  }

  it should "answer a run that cannot even be built, keeping the held run, as its record reads FAILED" in {
    val plan = planOf(unbuiltEid)
    val service =
      new StartService(buildFailure = Some(new IllegalStateException("cannot build")))
    val held = holdRunningRun(service, heldStoredEid)

    service.startExecution(plan, executingUser, storedCuid) shouldBe
      Left(
        s"Execution $unbuiltEid could not be started, because of an error on this computing unit."
      )
    // Its start taken, so never to start again.
    service.startExecution(plan, executingUser, storedCuid) shouldBe
      Left(s"Execution $unbuiltEid was already started.")

    // Recorded Failed; nothing is published, and the held run goes on.
    service.executionService.getValue should be theSameInstanceAs held
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
    service.started shouldBe empty
    // Its record was started before the run was to be built, and holds why it was not.
    val recorded = service.records(unbuiltEid.toLong).changes
    recorded.map(_.state) shouldBe Seq("FAILED")
    recorded.head.errors.map(_.message) shouldBe Seq(
      "java.lang.IllegalStateException: cannot build"
    )
  }

  it should "let the idle clean-up stop following a run once the run of another execution supersedes it" in {
    val service = new StartService()
    def statesFollowed(run: WorkflowExecutionService): Seq[WorkflowAggregatedState] =
      service.lifecycle.followedStates.collect {
        case (store, state) if store eq run.executionStateStore => state
      }.toSeq
    val first = service
      .startExecution(planOf(followedEid), executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))
    // As though its engine had started, so that the next run kills it.
    first.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    statesFollowed(first).last shouldBe RUNNING

    val second = service
      .startExecution(planOf(followingEid), executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))

    // Killed, but the kill did not reach the clean-up: on a workflow no session has open, it
    // would arm the deadline, which could then fire while the new run is set up.
    first.executionStateStore.metadataStore.getState.state shouldBe KILLED
    statesFollowed(first) should not contain KILLED
    // The clean-up follows the new run.
    service.lifecycle.registeredStores.last should be theSameInstanceAs second.executionStateStore
    second.executionStateStore.metadataStore.updateState(_.withState(PAUSED))
    statesFollowed(second).last shouldBe PAUSED
  }

  it should "record the paused run it lets go of once idle as killed, without arming the clean-up again" in {
    val service = new StartService()
    val run = service
      .startExecution(planOf(idlePausedEid), executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))
    run.executionStateStore.transitionTo(RUNNING) shouldBe true
    run.executionStateStore.transitionTo(PAUSED) shouldBe true
    def statesFollowed: Seq[WorkflowAggregatedState] =
      service.lifecycle.followedStates.collect {
        case (store, state) if store eq run.executionStateStore => state
      }.toSeq
    statesFollowed.last shouldBe PAUSED

    service.cleanUpAfterIdle()

    run.executionStateStore.metadataStore.getState.state shouldBe KILLED
    service.records(idlePausedEid.toLong).states shouldBe Seq(
      ("RUNNING", None),
      ("PAUSED", None),
      ("KILLED", Some(s"stopped: nobody watched it for $cleanUpTimeoutSecs s"))
    )
    // The run was let go of before its kill was recorded. Had the clean-up heard of the kill, it
    // would have armed itself again, on a workflow nobody has open, to run once more.
    statesFollowed should not contain KILLED
  }

  it should "let a run being set up finish its setup before another request supersedes it" in {
    val plan = planOf(setUpEid)
    val starting = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    // Holds the new run's setup where it is started, until released.
    val service = new StartService(whileStarting = () => {
      starting.countDown()
      release.await(60, TimeUnit.SECONDS)
    })
    val threads = Executors.newFixedThreadPool(2)
    implicit val onThreads: ExecutionContext = ExecutionContext.fromExecutorService(threads)
    try {
      val setUp = Future(
        service.startExecution(plan, executingUser, storedCuid)
      )
      starting.await(60, TimeUnit.SECONDS) shouldBe true
      // The run is published by now, and still being set up.
      val run = service.executionService.getValue
      run.workflowContext.executionId shouldBe ExecutionIdentity(setUpEid.toLong)
      // Another request, such as the agent's, supersedes the run while it is being set up.
      val superseding = Future(service.supersedeCurrentRun(replacingEid))

      // It waits for the setup to end...
      a[TimeoutException] should be thrownBy Await.ready(superseding, 500.millis)
      run.executionStateStore.metadataStore.getState.state should not be KILLED
      release.countDown()
      Await.result(setUp, 60.seconds) shouldBe Right(run)
      Await.result(superseding, 60.seconds)

      // ...and then lets go of the run set up in full, recording it killed.
      run.executionStateStore.metadataStore.getState.state shouldBe KILLED
    } finally {
      release.countDown()
      threads.shutdownNow()
    }
  }

  "WorkflowService.getOrCreate" should "reuse one service per workflow and publish it in the registry" in {
    // The services created here stay in the JVM-wide registry (nothing but the DB-backed clean-up
    // callback removes them). That is safe as long as no execution is published into them:
    // ClusterListener's node-failure recovery skips services whose executionService has no value.
    val workflowId = WorkflowIdentity(8L)
    val service = WorkflowService.getOrCreate(workflowId, computingUnitId = 2, cleanUpTimeoutSecs)

    service.workflowId shouldBe workflowId
    service.computingUnitId shouldBe 2
    WorkflowService.getOrCreate(workflowId, computingUnitId = 3, cleanUpTimeoutSecs) should
      be theSameInstanceAs service
    WorkflowService.getAllWorkflowServices should contain(service)

    val other =
      WorkflowService.getOrCreate(WorkflowIdentity(9L), computingUnitId = 2, cleanUpTimeoutSecs)
    other should not be theSameInstanceAs(service)
  }

  "WorkflowService.mkWorkflowStateId" should "key the registry by workflow id alone" in {
    val stateId = WorkflowService.mkWorkflowStateId(WorkflowIdentity(42L))
    stateId should include("42")
    stateId shouldBe WorkflowService.mkWorkflowStateId(WorkflowIdentity(42L))
    stateId should not be WorkflowService.mkWorkflowStateId(WorkflowIdentity(43L))
  }
}
