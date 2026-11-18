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
import org.apache.iceberg.exceptions.CommitFailedException
import org.apache.texera.amber.core.WorkflowRuntimeException
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.storage.{ExecutionPlanStore, PlanRecord}
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
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.amber.error.ErrorUtils.getStackTraceWithAllCauses
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder}
import org.apache.texera.dao.jooq.generated.Tables.{
  OPERATOR_EXECUTIONS,
  OPERATOR_PORT_EXECUTIONS,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTypeEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowVersion
}
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

import java.io.{IOException, UncheckedIOException}
import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.{CountDownLatch, Executors, TimeUnit, TimeoutException}
import scala.collection.concurrent.TrieMap
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, ExecutionContext, Future}
import scala.jdk.CollectionConverters.ListHasAsScala
import scala.util.Try

/**
  * Unit tests for the per-workflow service that outlives a single execution: it owns the
  * cross-execution state store, republishes each new execution to every connected client, and
  * decides what becomes of the previous execution's subscriptions when a new one arrives.
  *
  * Two collaborators are stubbed, both for reasons that would otherwise make these paths
  * untestable rather than merely inconvenient:
  *
  *   - `lifeCycleManager`. The real one schedules the clean-up through `AmberRuntime`'s global
  *     actor system, which no unit test starts, and its callback reads `workflow_executions` from
  *     the database and shuts down the execution's Amber client. Stubbing it also makes the two
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
  * The idle clean-up cases reach `ExecutionResources.clearExecutionResources`, which reaches real
  * storage, so only part of it is observable in process. Pinned here: which execution the service
  * clears, the one it holds, and that it deletes exactly that execution's registry rows;
  * `ExecutionResourcesSpec` owns what clearing an execution does to its documents. Admitted
  * survivors, listed so the coverage numbers are not mistaken for behaviour:
  *   - `LargeBinaryManager.deleteByExecution` (the last line). Its injectable overload is
  *     `private[util]` and the call site uses the one-arg one, so deleting the line, or handing
  *     it a different execution id, is invisible here. It also issues a REAL S3 delete against
  *     the configured endpoint on every run of this suite (`http://localhost:9000` by default).
  *     That is why the fixtures below pin explicit eids in the 941100 range instead of taking the
  *     `SERIAL`: a fresh `MockTexeraDB` database hands out eid 1, and `objects/1/` is the prefix
  *     `LargeBinaryManager` shares with its DEFAULT_EXECUTION_ID sentinel — a developer with
  *     `bin/local-dev.sh up` running would have that prefix recursively deleted for real.
  *   - the runtime-statistics block, and which arm of `WarehouseReadGuard.skipWhileDisabled`
  *     either loop takes. The URI columns are NULL in every fixture, so the loop bodies run zero
  *     times.
  *
  * The superseded-run and idle clean-up cases run on executions of their own, on computing units
  * no other case uses.
  *
  * The cases of a start by id (`startStoredExecution`) write their executions' plans to the lake,
  * in the catalog the build's tests use, and drop them after the suite. Their runs record the plan
  * they are started from instead of building an engine (`StoredStartService`):
  * `WorkflowExecutionServiceSpec` owns what a run does with its plan, and `StoredExecutionStartSpec`
  * every check a start makes.
  */
class WorkflowServiceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

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
  ) extends ExecutionResultService(workflowId, computingUnitId, stateStore) {
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
    * A service of the fixture workflow, made for computing unit `serviceCuid`, whose runs of
    * stored plans record what they are started from, and fail with `startFailure` if given,
    * instead of building an engine: `WorkflowExecutionServiceSpec` owns what a run does with its
    * plan. Its reads and claims go to the lake unless `read` or `claim` stands in for them.
    * `supersedeFailure` fails its supersede, and `buildFailure` the building of a run.
    * `whileStarting` runs while a run is started, which is while it is being set up. `started`
    * is what each run was started from: its plan, its plan row and its plan table. `records` is
    * what each run's record was told, by execution: a run's record is started before the run is
    * built, and is a [[RecordingExecutionRecorder]].
    */
  private final class StoredStartService(
      read: URI => PlanRecord = ExecutionPlanStore.readPlan,
      claim: URI => Unit = ExecutionPlanStore.claimStart,
      startFailure: Option[RuntimeException] = None,
      serviceCuid: Int = storedCuid,
      supersedeFailure: Option[RuntimeException] = None,
      buildFailure: Option[RuntimeException] = None,
      whileStarting: () => Unit = () => (),
      val started: ArrayBuffer[(ExecutionPlan, PlanRecord, URI)] = ArrayBuffer.empty,
      val records: TrieMap[Long, RecordingExecutionRecorder] = TrieMap.empty
  ) extends WorkflowService(
        WorkflowIdentity(testWid.toLong),
        serviceCuid,
        cleanUpTimeoutSecs,
        read,
        claim,
        newRun = (context, _, executionStateStore, errorHandler) => {
          buildFailure.foreach(failure => throw failure)
          new WorkflowExecutionService(context, null, executionStateStore, errorHandler, None) {
            override def startStored(
                executionPlan: ExecutionPlan,
                record: PlanRecord,
                planUri: URI
            ): Option[Throwable] = {
              started += ((executionPlan, record, planUri))
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
  // Fixtures: the user / workflow / workflow_version / workflow_computing_unit chain an
  // execution's row hangs off. workflow_executions.uid, .vid and .cuid are all foreign keys.
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

  // Executions carry explicit eids rather than the SERIAL's: see the header on
  // LargeBinaryManager.

  /** The superseded-run cases' execution, on `supersedeCuid`. */
  private val supersededEid = 941105

  /**
    * The execution the idle clean-up case's service holds, on `idleCuid`: older than
    * `newerIdleEid`, so a clean-up that took the newest execution of the unit would take the other.
    */
  private val heldIdleEid = 941106

  /** A newer execution of `testWid` on `idleCuid`, which the service does not hold. */
  private val newerIdleEid = 941107

  /**
    * Executions created for `storedCuid` and started by id: their plans are written to the lake
    * by the cases. One is started, one is refused, one's claim fails, and one fails once claimed.
    */
  private val startedEid = 941109
  private val refusedEid = 941110
  private val unclaimedEid = 941111
  private val failedEid = 941112

  /** The run a start by id supersedes, on `storedCuid`. */
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

  /** Records the statements the cases' code sends to the database. */
  private var recorder: StatementRecorder = _

  private var executingUser: User = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    val cfg = getDSLContext.configuration()

    executingUser = new User
    executingUser.setUid(testUid)
    executingUser.setName("workflow_service_spec_user")
    executingUser.setEmail(s"workflow-service-${UUID.randomUUID()}@example.com")
    new UserDao(cfg).insert(executingUser)

    val workflow = new Workflow
    workflow.setWid(testWid)
    workflow.setName("workflow_service_spec_workflow")
    workflow.setContent("{}")
    workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    new WorkflowDao(cfg).insert(workflow)

    val version = new WorkflowVersion
    version.setWid(testWid)
    version.setContent("{}")
    version.setCreationTime(new Timestamp(System.currentTimeMillis()))
    new WorkflowVersionDao(cfg).insert(version)

    val unitDao = new WorkflowComputingUnitDao(cfg)
    List(
      testCuid -> "workflow_service_spec_unit",
      supersedeCuid -> "workflow_service_spec_supersede_unit",
      idleCuid -> "workflow_service_spec_idle_unit",
      storedCuid -> "workflow_service_spec_stored_unit"
    ).foreach {
      case (cuid, name) =>
        val unit = new WorkflowComputingUnit
        unit.setCuid(cuid)
        unit.setUid(testUid)
        unit.setName(name)
        unit.setType(WorkflowComputingUnitTypeEnum.local)
        unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
        unitDao.insert(unit)
    }

    insertExecution(supersededEid, supersedeCuid, "superseded-run")
    insertExecution(heldIdleEid, idleCuid, "held-idle-run")
    insertExecution(newerIdleEid, idleCuid, "newer-idle-run")
    Seq(
      startedEid,
      refusedEid,
      unclaimedEid,
      failedEid,
      heldStoredEid,
      askedUnitEid,
      unpublishedEid,
      unbuiltEid,
      followedEid,
      followingEid,
      setUpEid,
      failedByWorkerEid,
      idlePausedEid
    ).foreach { eid =>
      insertExecution(eid, storedCuid, s"stored-run-$eid")
    }

    // A different row count per execution, so a clean-up that took the wrong one cannot be
    // mistaken for one that took the right one.
    (0 until 2).foreach { i =>
      registerOperator(heldIdleEid, s"held-idle-op-$i")
      registerPort(heldIdleEid, s"held-idle-port-$i")
    }
    registerOperator(newerIdleEid, "newer-idle-op")
    registerPort(newerIdleEid, "newer-idle-port")
  }

  /** The plan tables the cases write, in the catalog the build's tests use. */
  private val madePlans = ArrayBuffer.empty[URI]

  override protected def afterAll(): Unit =
    try madePlans.foreach(uri => Try(ExecutionPlanStore.drop(uri)))
    finally closeConnectionPool()

  /** An execution of the fixture workflow on unit `cuid`, recorded as completed. */
  private def insertExecution(eid: Int, cuid: Int, name: String): Unit =
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(
        WORKFLOW_EXECUTIONS.VID,
        getDSLContext
          .select(WORKFLOW_VERSION.VID)
          .from(WORKFLOW_VERSION)
          .where(WORKFLOW_VERSION.WID.eq(testWid))
          .fetchOneInto(classOf[Integer])
      )
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(testUid))
      .set(WORKFLOW_EXECUTIONS.CUID, Integer.valueOf(cuid))
      // Spelled out rather than left to the DDL's default, which is RUNNING: a case that records
      // another state for a run shows it against this one.
      .set(
        WORKFLOW_EXECUTIONS.STATUS,
        java.lang.Short.valueOf(Utils.maptoStatusCode(COMPLETED).toShort)
      )
      .set(WORKFLOW_EXECUTIONS.NAME, name)
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .execute()

  /** A console-message registry row. The URI column stays NULL: see the header comment. */
  private def registerOperator(eid: Int, operatorId: String): Unit =
    getDSLContext
      .insertInto(OPERATOR_EXECUTIONS)
      .set(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID, Integer.valueOf(eid))
      .set(OPERATOR_EXECUTIONS.OPERATOR_ID, operatorId)
      .execute()

  /** A result registry row. The URI column stays NULL: see the header comment. */
  private def registerPort(eid: Int, globalPortId: String): Unit =
    getDSLContext
      .insertInto(OPERATOR_PORT_EXECUTIONS)
      .set(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID, Integer.valueOf(eid))
      .set(OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID, globalPortId)
      .execute()

  private def operatorRowCount(eid: Int): Int =
    getDSLContext.fetchCount(
      OPERATOR_EXECUTIONS,
      OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(eid)
    )

  private def portRowCount(eid: Int): Int =
    getDSLContext.fetchCount(
      OPERATOR_PORT_EXECUTIONS,
      OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(eid)
    )

  private def executionRowCount(eid: Int): Int =
    getDSLContext.fetchCount(WORKFLOW_EXECUTIONS, WORKFLOW_EXECUTIONS.EID.eq(eid))

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

  private def statusOf(eid: Int): Int =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.STATUS)
      .from(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.eq(eid))
      .fetchOne(WORKFLOW_EXECUTIONS.STATUS)
      .intValue()

  /** The plan table of fixture execution `eid`, in the default warehouse. */
  private def planUriOf(eid: Int): URI =
    ExecutionPlanStore.planUri(
      WorkflowIdentity(testWid.toLong),
      ExecutionIdentity(eid.toLong),
      None
    )

  /**
    * Writes the plan row the Dashboard writes for execution `eid` of the fixture workflow, made for
    * the fixture user on `storedCuid`: a plan of one source, `lines`.
    *
    * @return the plan table
    */
  private def storePlanOf(eid: Int): URI = {
    val context = new WorkflowContext(
      WorkflowIdentity(testWid.toLong),
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
    val planUri = planUriOf(eid)
    madePlans += planUri
    ExecutionPlanStore.writePlan(
      planUri,
      PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        body = PhysicalPlanCodec.toJson(
          PhysicalPlanCodec.encode(ExecutionPlan(context, PhysicalPlan(Set(lines), Set.empty)))
        ),
        createdBy = testUid,
        computingUnitId = storedCuid,
        notification = None
      ),
      "{}"
    )
    planUri
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

  it should "record a live run it supersedes as killed, in one write of its row, and tell no client" in {
    val service = new TestWorkflowService(testWid.toLong, supersedeCuid)
    val previous = newExecution(Some(supersededEid))
    service.executionService.onNext(previous)
    previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    statusOf(supersededEid) shouldBe Utils
      .maptoStatusCode(COMPLETED)
      .toInt // as the fixture wrote it
    val clientEvents = ArrayBuffer.empty[TexeraWebSocketEvent]
    service.connectToExecution(clientEvents += _)
    clientEvents.clear()

    val before = System.currentTimeMillis()
    val statements = recorder.record(service.supersedeCurrentRun(replacingEid))
    val after = System.currentTimeMillis()

    // Its row reads Killed, written by one UPDATE that reads nothing, and so does its store.
    statements.map(_.verb) shouldBe Seq("UPDATE")
    statements.head.sql should include("workflow_executions")
    statements.head.sql.toLowerCase should not include "select"
    statusOf(supersededEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
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

  it should "only let go of a finished run it supersedes, writing nothing" in {
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

          recorder.record(service.supersedeCurrentRun(replacingEid)) shouldBe empty

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
    recorder.record(service.supersedeCurrentRun(replacingEid)) shouldBe empty
  }

  it should "clear the run it holds once idle, not the newest run of the workflow on its unit" in {
    // The service holds the older of two executions on its unit, as one whose run was made and
    // not yet started would sit behind a newer one.
    val service = new TestWorkflowService(testWid.toLong, idleCuid)
    val held = newExecution(Some(heldIdleEid))
    service.executionService.onNext(held)
    val ownSubscription = new TrackingDisposable
    service.addSubscription(ownSubscription)
    operatorRowCount(heldIdleEid) shouldBe 2
    portRowCount(heldIdleEid) shouldBe 2

    service.cleanUpAfterIdle()

    operatorRowCount(heldIdleEid) shouldBe 0
    portRowCount(heldIdleEid) shouldBe 0
    executionRowCount(heldIdleEid) shouldBe 1
    operatorRowCount(newerIdleEid) shouldBe 1
    portRowCount(newerIdleEid) shouldBe 1
    // and the service lets go of everything, the run it holds included, which never started
    ownSubscription.isDisposed shouldBe true
    service.results.unsubscribeCount shouldBe 1
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
        statusOf(heldIdleEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
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

        val statements = recorder.record(service.cleanUpAfterIdle())

        held.executionStateStore.metadataStore.getState.state shouldBe ended
        held.executionStateStore.statsStore.getState.endTimeStamp shouldBe 0L
        recordOf(held) shouldBe empty
        statements.filter(_.verb == "UPDATE") shouldBe empty
      }
    }
  }

  it should "clear nothing once idle when it holds no run" in {
    val service = new TestWorkflowService(testWid.toLong, idleCuid)
    val ownSubscription = new TrackingDisposable
    service.addSubscription(ownSubscription)

    recorder.record(service.cleanUpAfterIdle()) shouldBe empty

    operatorRowCount(newerIdleEid) shouldBe 1
    portRowCount(newerIdleEid) shouldBe 1
    ownSubscription.isDisposed shouldBe true
  }

  "WorkflowService.startStoredExecution" should
    "claim the execution, supersede the live run, and start a run of the plan read back on the unit asked" in {
    val planUri = storePlanOf(startedEid)
    val service = new StoredStartService()
    val held = holdRunningRun(service, heldStoredEid)
    val heldEvents = collectExecutionEvents(held)
    heldEvents.clear()

    val (started, logged) = linesLoggedBy("org.apache.texera.web") {
      service
        .startStoredExecution(startedEid, planUri, executingUser, storedCuid)
        .getOrElse(fail("the start was refused"))
    }

    // The start is logged, with the unit asked and the plan it starts from.
    logged.filter(_.contains(s"Execution $startedEid of workflow $testWid starts")) shouldBe Seq(
      s"Execution $startedEid of workflow $testWid starts on computing unit $storedCuid from its " +
        s"plan at $planUri."
    )
    // Claimed for its one start, in its plan table.
    ExecutionPlanStore.isStarted(planUri) shouldBe true
    // The run it held reads Killed, in its store, its row and its record, which names the
    // execution that took its place, and no session was told of it.
    held.executionStateStore.metadataStore.getState.state shouldBe KILLED
    statusOf(heldStoredEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
    recordOf(held) shouldBe Seq(("KILLED", Some(s"replaced by execution $startedEid")))
    heldEvents shouldBe empty
    // The new run is published in its place, and followed by the idle clean-up.
    service.executionService.getValue should be theSameInstanceAs started
    service.lifecycle.registeredStores.last should be theSameInstanceAs started.executionStateStore
    started.executionStateStore.metadataStore.getState.executionId shouldBe
      ExecutionIdentity(startedEid.toLong)
    // It was started from the plan read back from the lake, the row and the table, under the
    // context the plan was read back with: its ids and settings.
    service.started should have size 1
    val (executionPlan, record, startedFrom) = service.started.head
    startedFrom shouldBe planUri
    record shouldBe ExecutionPlanStore.readPlan(planUri)
    executionPlan.plan.operators.map(_.id) shouldBe
      Set(PhysicalOpIdentity(OperatorIdentity("lines"), "main"))
    started.workflowContext should be theSameInstanceAs executionPlan.context
    started.workflowContext.executionId shouldBe ExecutionIdentity(startedEid.toLong)
    started.workflowContext.workflowSettings.dataTransferBatchSize shouldBe 64

    // A second start of it is refused, however it comes, writing nothing and leaving the run
    // started as it is.
    val again = recorder.record {
      service.startStoredExecution(startedEid, planUri, executingUser, storedCuid) shouldBe
        Left(s"Execution $startedEid was already started.")
    }
    again shouldBe empty
    service.executionService.getValue should be theSameInstanceAs started
    service.started should have size 1
  }

  it should "refuse a start the plan row was not made for, writing nothing and leaving the held run alone" in {
    val planUri = storePlanOf(refusedEid)
    val service = new StoredStartService()
    val held = holdRunningRun(service, heldStoredEid)
    val stranger = new User
    stranger.setUid(Integer.valueOf(testUid + 1000))
    val refusals = Seq(
      (stranger, storedCuid, s"Only the user who created execution $refusedEid may start it."),
      (
        executingUser,
        testCuid,
        s"Execution $refusedEid was created for computing unit $storedCuid, not $testCuid."
      )
    )

    refusals.foreach {
      case (user, cuid, why) =>
        withClue(s"$why: ") {
          val statements = recorder.record {
            service.startStoredExecution(refusedEid, planUri, user, cuid) shouldBe Left(why)
          }
          statements shouldBe empty
        }
    }
    // An execution with no plan in the lake.
    recorder.record {
      service.startStoredExecution(
        heldStoredEid,
        planUriOf(heldStoredEid),
        executingUser,
        storedCuid
      ) shouldBe Left(s"Execution $heldStoredEid has no stored plan.")
    } shouldBe empty
    // A start checked for another workflow, which the agent's path would have asked another
    // service to start.
    val checked = WorkflowService
      .checkStoredStart(refusedEid, planUri, executingUser, storedCuid, socketWorkflowId = None)
      .getOrElse(fail("the start was refused"))
    checked.workflowId shouldBe WorkflowIdentity(testWid.toLong)
    recorder.record {
      service.startChecked(
        checked.copy(workflowId = WorkflowIdentity(testWid.toLong + 1))
      ) shouldBe Left(s"The plan belongs to workflow ${testWid + 1}, not to this one.")
    } shouldBe empty

    ExecutionPlanStore.isStarted(planUri) shouldBe false
    service.started shouldBe empty
    service.executionService.getValue should be theSameInstanceAs held
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
    held.executionStateStore.metadataStore.getState.fatalErrors shouldBe empty
  }

  it should "refuse what was asked of another unit, where it was told which unit it is, before reading the plan" in {
    val planUri = storePlanOf(refusedEid)
    // Asked of the unit the execution was created for, but this is not that unit: a request sent
    // to the wrong unit, whatever unit it names.
    WorkflowService.checkStoredStart(
      refusedEid,
      planUri,
      executingUser,
      storedCuid,
      socketWorkflowId = None,
      readPlan = _ => fail("the plan was read"),
      thisUnit = Some(storedCuid + 1)
    ) shouldBe Left(s"This is computing unit ${storedCuid + 1}, not $storedCuid.")
    // On the unit it was created for, it is checked as on a unit that was told nothing.
    Seq(Some(storedCuid), None).foreach { thisUnit =>
      WorkflowService
        .checkStoredStart(
          refusedEid,
          planUri,
          executingUser,
          storedCuid,
          socketWorkflowId = None,
          thisUnit = thisUnit
        )
        .map(_.executionId) shouldBe Right(refusedEid)
    }
    ExecutionPlanStore.isStarted(planUri) shouldBe false
  }

  it should "check which unit it is once a user asks, and before it looks at the plan table named" in {
    def askedOfAnotherUnit(user: User, planUri: URI): Either[String, WorkflowService.CheckedStart] =
      WorkflowService.checkStoredStart(
        refusedEid,
        planUri,
        user,
        storedCuid,
        socketWorkflowId = None,
        readPlan = _ => fail("the plan was read"),
        thisUnit = Some(storedCuid + 1)
      )

    // Nobody asks: refused for that, whichever unit it reached.
    askedOfAnotherUnit(null, planUriOf(refusedEid)) shouldBe
      Left("A signed-in user is required to start an execution.")
    // What is named is no plan table: the wrong unit says it is the wrong unit, and judges
    // nothing else of a request that was not for it.
    askedOfAnotherUnit(executingUser, new URI("vfs:///no/plan")) shouldBe
      Left(s"This is computing unit ${storedCuid + 1}, not $storedCuid.")
  }

  it should "answer a claim or a read the lake fails as a refusal, leaving the held run alone" in {
    val planUri = storePlanOf(unclaimedEid)
    def refusalOf(service: StoredStartService): Either[String, WorkflowExecutionService] = {
      val held = holdRunningRun(service, heldStoredEid)
      val answer =
        service.startStoredExecution(unclaimedEid, planUri, executingUser, storedCuid)
      service.executionService.getValue should be theSameInstanceAs held
      held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
      service.started shouldBe empty
      answer
    }

    // Every retry of the claim lost its commit to another commit on the table.
    refusalOf(
      new StoredStartService(claim = _ => throw new CommitFailedException("lost the race"))
    ) shouldBe Left(
      s"Execution $unclaimedEid could not be claimed for its start, as its plan was being " +
        "changed. Run the workflow again."
    )
    refusalOf(
      new StoredStartService(claim = _ => throw new IllegalStateException("catalog down"))
    ) shouldBe
      Left(s"Execution $unclaimedEid could not be claimed for its start. Run the workflow again.")
    refusalOf(
      new StoredStartService(
        read = _ => throw new UncheckedIOException(new IOException("catalog down"))
      )
    ) shouldBe
      Left(s"The plan of execution $unclaimedEid could not be read. Run the workflow again.")
    // A row the table holds that is no plan row, as `PlanRecord.fromTuple` refuses it: a second
    // try reads the same row.
    refusalOf(
      new StoredStartService(
        read = _ => throw new IllegalStateException("a plan table row has no body")
      )
    ) shouldBe
      Left(
        s"The stored plan of execution $unclaimedEid cannot be read: a plan table row has no body"
      )
    refusalOf(
      new StoredStartService(read = _ => throw new IllegalArgumentException())
    ) shouldBe Left(s"The stored plan of execution $unclaimedEid cannot be read.")
    ExecutionPlanStore.isStarted(planUri) shouldBe false
  }

  it should "report a run that fails once its execution is claimed as that run's failure" in {
    val planUri = storePlanOf(failedEid)
    val failure =
      new IllegalStateException("the engine is gone", new IOException("connection reset"))
    val service = new StoredStartService(startFailure = Some(failure))
    val held = holdRunningRun(service, heldStoredEid)

    val before = System.currentTimeMillis()
    val failed = service
      .startStoredExecution(failedEid, planUri, executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))
    val after = System.currentTimeMillis()

    // Published, superseding the held run, and failed, at the time it failed; its row reads
    // Failed.
    service.executionService.getValue should be theSameInstanceAs failed
    held.executionStateStore.metadataStore.getState.state shouldBe KILLED
    failed.executionStateStore.metadataStore.getState.state shouldBe
      WorkflowAggregatedState.FAILED
    failed.executionStateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
    statusOf(failedEid) shouldBe Utils.maptoStatusCode(WorkflowAggregatedState.FAILED).toInt
    ExecutionPlanStore.isStarted(planUri) shouldBe true
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
    val planUri = storePlanOf(failedByWorkerEid)
    val worker = ActorVirtualIdentity(s"Worker:WF$testWid-lines-main-0")
    val service = new StoredStartService(
      startFailure = Some(new WorkflowRuntimeException("the worker lost its input", Some(worker)))
    )

    val failed = service
      .startStoredExecution(failedByWorkerEid, planUri, executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))

    val errors = failed.executionStateStore.metadataStore.getState.fatalErrors
    errors.map(error => (error.`type`, error.operatorId, error.workerId)) shouldBe
      Seq((EXECUTION_FAILURE, "lines", worker.name))
    errors.head.message should include("the worker lost its input")
  }

  it should "start a run for the unit the start was asked of, not the one the workflow's service was made for" in {
    // The first session of a workflow makes its service, for that session's unit, and every later
    // session of the workflow shares it, on whichever unit (#7676).
    val planUri = storePlanOf(askedUnitEid)
    val service = new StoredStartService(serviceCuid = testCuid)
    service.computingUnitId shouldBe testCuid

    val (answer, logged) = linesLoggedBy("org.apache.texera.web") {
      service.startStoredExecution(askedUnitEid, planUri, executingUser, storedCuid)
    }

    // The plan row was made for the unit asked, so the start is not refused for the service's.
    answer.isRight shouldBe true
    service.started.map(_._2.computingUnitId) shouldBe Seq(storedCuid)
    logged.count(
      _.contains(
        s"Execution $askedUnitEid of workflow $testWid starts on computing unit $storedCuid"
      )
    ) shouldBe 1
  }

  it should "publish a run that fails before it is published, so its sessions see why" in {
    val planUri = storePlanOf(unpublishedEid)
    val service =
      new StoredStartService(supersedeFailure = Some(new IllegalStateException("cannot supersede")))
    val held = holdRunningRun(service, heldStoredEid)

    val failed = service
      .startStoredExecution(unpublishedEid, planUri, executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))

    // Claimed, so never to start: published FAILED in the held run's place, with the reason,
    // which every session on the workflow is sent, and its row reads Failed.
    ExecutionPlanStore.isStarted(planUri) shouldBe true
    service.executionService.getValue should be theSameInstanceAs failed
    failed.workflowContext.executionId shouldBe ExecutionIdentity(unpublishedEid.toLong)
    failed.executionStateStore.metadataStore.getState.state shouldBe
      WorkflowAggregatedState.FAILED
    failed.executionStateStore.metadataStore.getState.fatalErrors.map(_.message) shouldBe
      Seq("java.lang.IllegalStateException: cannot supersede")
    collectExecutionEvents(failed).collect { case errors: WorkflowErrorEvent => errors } should
      not be empty
    statusOf(unpublishedEid) shouldBe Utils.maptoStatusCode(WorkflowAggregatedState.FAILED).toInt
    recordOf(failed) shouldBe Seq(("FAILED", None))
    service.started shouldBe empty
    // The supersede failed before it touched the held run.
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
  }

  it should "answer a run that cannot even be built, keeping the held run, as its execution reads Failed" in {
    val planUri = storePlanOf(unbuiltEid)
    val service =
      new StoredStartService(buildFailure = Some(new IllegalStateException("cannot build")))
    val held = holdRunningRun(service, heldStoredEid)

    service.startStoredExecution(unbuiltEid, planUri, executingUser, storedCuid) shouldBe
      Left(
        s"Execution $unbuiltEid could not be started, because of an error on this computing unit."
      )

    // Claimed, so never to start, and recorded Failed; nothing is published, and the held run
    // goes on.
    ExecutionPlanStore.isStarted(planUri) shouldBe true
    statusOf(unbuiltEid) shouldBe Utils.maptoStatusCode(WorkflowAggregatedState.FAILED).toInt
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
    val service = new StoredStartService()
    def statesFollowed(run: WorkflowExecutionService): Seq[WorkflowAggregatedState] =
      service.lifecycle.followedStates.collect {
        case (store, state) if store eq run.executionStateStore => state
      }.toSeq
    val first = service
      .startStoredExecution(followedEid, storePlanOf(followedEid), executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))
    // As though its engine had started, so that the next run kills it.
    first.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    statesFollowed(first).last shouldBe RUNNING

    val second = service
      .startStoredExecution(followingEid, storePlanOf(followingEid), executingUser, storedCuid)
      .getOrElse(fail("the start was refused"))

    // Killed, but the kill did not reach the clean-up: on a workflow no session has open, it
    // would arm the deadline, which could then fire while the new run is set up.
    first.executionStateStore.metadataStore.getState.state shouldBe KILLED
    statusOf(followedEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
    statesFollowed(first) should not contain KILLED
    // The clean-up follows the new run.
    service.lifecycle.registeredStores.last should be theSameInstanceAs second.executionStateStore
    second.executionStateStore.metadataStore.updateState(_.withState(PAUSED))
    statesFollowed(second).last shouldBe PAUSED
  }

  it should "record the paused run it lets go of once idle as killed, without arming the clean-up again" in {
    val service = new StoredStartService()
    val run = service
      .startStoredExecution(idlePausedEid, storePlanOf(idlePausedEid), executingUser, storedCuid)
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
    statusOf(idlePausedEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
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
    val planUri = storePlanOf(setUpEid)
    val starting = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    // Holds the new run's setup where it is started, until released.
    val service = new StoredStartService(whileStarting = () => {
      starting.countDown()
      release.await(60, TimeUnit.SECONDS)
    })
    val threads = Executors.newFixedThreadPool(2)
    implicit val onThreads: ExecutionContext = ExecutionContext.fromExecutorService(threads)
    try {
      val setUp = Future(
        service.startStoredExecution(setUpEid, planUri, executingUser, storedCuid)
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
      statusOf(setUpEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
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
