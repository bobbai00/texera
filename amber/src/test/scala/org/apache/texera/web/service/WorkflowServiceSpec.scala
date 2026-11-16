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
import com.google.protobuf.timestamp.{Timestamp => ProtoTimestamp}
import io.reactivex.rxjava3.disposables.Disposable
import org.apache.iceberg.exceptions.CommitFailedException
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.storage.{ExecutionPlanStore, PlanRecord}
import org.apache.texera.amber.core.storage.result.{OperatorResultMetadata, WorkflowResultStore}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  ExecutionPlan,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PortIdentity,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.{
  COMPILATION_ERROR,
  EXECUTION_FAILURE
}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  KILLED,
  PAUSED,
  RUNNING
}
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.amber.error.ErrorUtils.getStackTraceWithAllCauses
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.common.compiler.WorkflowCompilationFailed
import org.apache.texera.common.config.StorageConfig
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
  WorkflowExecutionsDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowExecutions,
  WorkflowVersion
}
import org.apache.texera.web.model.websocket.event.ExecutionDurationUpdateEvent
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.web.WorkflowLifecycleManager
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WebResultUpdateEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.model.websocket.request.WorkflowExecuteRequest
import org.apache.texera.web.service.execution.CostHintsLoader
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.io.{IOException, UncheckedIOException}
import java.net.URI
import java.sql.Timestamp
import java.time.Instant
import java.util.UUID
import java.util.concurrent.{CountDownLatch, Executors, TimeUnit, TimeoutException}
import scala.collection.immutable.VectorMap
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
  * The cost-hints cases also stub `costHintsLoader`, to see which hints a new run's context is
  * given: the real loader reads statistics from the lake, and `CostHintsLoaderSpec` covers it.
  * Every other case keeps the real one, which finds no completed run with statistics here. Two of
  * the cost-hints cases run `initExecutionService` end to end, stopped as the clean-up cases below
  * are. The cost-hints cases run only while per-user warehouses are off, as they are in CI: their
  * requests pick no warehouse, and the refusal they expect of a pick is the one of that setting.
  *
  * Executions are real `WorkflowExecutionService` instances with `resultService` passed as `null`
  * (the pattern `WorkflowExecutionServiceSpec` establishes: construction does no external work), so
  * the events observed here travel through the production diff handler.
  *
  * Two cases run `initExecutionService` end to end against `MockTexeraDB`, for the previous-run
  * clean-up it performs before inserting the new execution row. Both are steered into a
  * compilation failure (a CSV scan with no file selected, the recipe `SyncExecutionResourceSpec`
  * establishes) so the method stops inside `executeWorkflow` and never reaches
  * `ComputingUnitMaster.createAmberRuntime`, which builds an `AmberClient` on
  * `AmberRuntime.actorSystem` — null outside a started coordinator. That stopping point is
  * asserted rather than assumed: it rests entirely on `executeWorkflow`'s early `return`, and
  * without the assertion, removing that `return` would send this "unit" test into
  * `createAmberRuntime` on whatever actor system another suite left installed in the shared JVM,
  * still green, because `initExecutionService`'s catch-all absorbs the fallout.
  *
  * `clearExecutionResources` reaches real storage, so only part of it is observable in process.
  * Pinned here: which execution it selects (workflow *and* computing unit, newest only), that it
  * deletes exactly that execution's registry rows, and that it reads the registered URIs *before*
  * deleting the rows that hold them. Admitted survivors, listed so the coverage numbers are not
  * mistaken for behaviour:
  *   - `LargeBinaryManager.deleteByExecution` (the last line). Its injectable overload is
  *     `private[util]` and the call site uses the one-arg one, so deleting the line, or handing
  *     it a different execution id, is invisible here. It also issues a REAL S3 delete against
  *     the configured endpoint on every run of this suite (`http://localhost:9000` by default).
  *     That is why the fixtures below pin explicit eids in the 941100 range instead of taking the
  *     `SERIAL`: a fresh `MockTexeraDB` database hands out eid 1, and `objects/1/` is the prefix
  *     `LargeBinaryManager` shares with its DEFAULT_EXECUTION_ID sentinel — a developer with
  *     `bin/local-dev.sh up` running would have that prefix recursively deleted for real.
  *   - the runtime-statistics block. Its URI column is NULL in every fixture, so the loop body
  *     runs zero times; a non-NULL value there would abort the whole method (see below) before
  *     the execution insert this suite also pins.
  *   - which arm of `WarehouseReadGuard.skipWhileDisabled` either loop takes: both arms end in
  *     `DocumentFactory`, which needs a live Iceberg/LakeFS backend, and the loop body swallows
  *     every `Throwable`.
  *   - swapping the two URI reads with each other. That is an equivalent mutant, not a gap: the
  *     two lists are concatenated and every element is treated identically.
  *
  * Not a contract, and deliberately not pinned as one: `WarehouseReadGuard.skipWhileDisabled` and
  * `WorkflowExecutionsResource`'s `URI.create` both sit *outside* the per-URI catch, so a single
  * registry row whose URI does not decode aborts `initExecutionService` before the new execution
  * row is even inserted — after which the user can start no run at all of that workflow.
  * Best-effort clean-up should survive an undecodable row; this is a robustness gap worth fixing.
  * The read-order case below uses it only as the one in-process witness that the reads happen
  * while the rows still exist. If the gap is ever closed, re-point that case at whatever new
  * evidence shows the read happened — do not delete it, the ordering it pins is real.
  *
  * The superseded-run and idle clean-up cases run on executions of their own, on computing units
  * no other case uses, so neither moves the newest execution of a unit another case clears. Three
  * of the superseded-run cases supersede through `initExecutionService`, whose runs stop at the
  * compile as the clean-up cases' do.
  *
  * The cases of a start by id (`startStoredExecution`) write their executions' plans to the lake,
  * in the catalog the build's tests use, and drop them after the suite. Their runs record the plan
  * they are started from instead of building an engine (`StoredStartService`):
  * `WorkflowExecutionServiceSpec` owns what a run does with its plan, and `StoredExecutionStartSpec`
  * every check a start makes.
  *
  * Deliberately not covered:
  *   - the replay block of `initExecutionService`. It only computes the replay the run's plan is
  *     saved with, which the runs here, stopped at the compile, never save: on every path a unit
  *     test can reach it has no observable effect, and pinning it would mean reflecting into
  *     `WorkflowExecutionService`'s private field. `WorkflowExecutionServiceSpec` pins that a run
  *     saves the replay and replay log it is given, and starts its coordinator with the ones it
  *     reads back.
  *   - the fault-tolerance block of `initExecutionService`, gated on
  *     `ApplicationConfig.faultToleranceLogRootFolder`: a `val` on a Scala `object` with no
  *     override seam, read at class-initialization time in a JVM shared with every other suite.
  *   - `resolveLakekeeperWarehouseName`, owned by `ExecutionResourcesSpec`.
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
      * state update during `initExecutionService` raises an NPE inside an RxJava consumer.
      *
      * Recorded rather than discarded, because this call is the single statement that arms the
      * whole deferred clean-up: stubbed to a no-op it would also be unkillable, and a build in
      * which `initExecutionService` never registers the deadline would look identical. The states
      * the subscription it returns delivers are recorded too, in place of arming the deadline, so
      * a case can see which states still reach the clean-up.
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

  /** Gives every run `hints`, and records the workflow and user each run asks them for. */
  private final class RecordingCostHintsLoader(hints: Option[CostHints])
      extends CostHintsLoader(cacheCapacity = 1) {
    val asked: ArrayBuffer[(Long, Int)] = ArrayBuffer.empty

    override def load(wid: Long, uid: Int): Option[CostHints] = {
      asked += ((wid, uid))
      hints
    }
  }

  private final class TestWorkflowService(
      id: Long,
      cuid: Int = 1,
      hintsLoader: Option[CostHintsLoader] = None
  ) extends WorkflowService(WorkflowIdentity(id), computingUnitId = cuid, cleanUpTimeoutSecs) {
    val lifecycle = new RecordingLifecycleManager
    override val lifeCycleManager: WorkflowLifecycleManager = lifecycle
    val results = new RecordingResultService(workflowId, computingUnitId, stateStore)
    override val resultService: ExecutionResultService = results
    override protected def costHintsLoader: CostHintsLoader =
      hintsLoader.getOrElse(super.costHintsLoader)
  }

  /**
    * A service of the fixture workflow, made for computing unit `serviceCuid`, whose runs of
    * stored plans record what they are started from, and fail with `startFailure` if given,
    * instead of building an engine: `WorkflowExecutionServiceSpec` owns what a run does with its
    * plan. Its reads and claims go to the lake unless `read` or `claim` stands in for them.
    * `supersedeFailure` fails its supersede, and `buildFailure` the building of a run.
    */
  private final class StoredStartService(
      read: Option[URI => PlanRecord] = None,
      claim: Option[URI => Unit] = None,
      startFailure: Option[RuntimeException] = None,
      serviceCuid: Int = storedCuid,
      supersedeFailure: Option[RuntimeException] = None,
      buildFailure: Option[RuntimeException] = None
  ) extends WorkflowService(WorkflowIdentity(testWid.toLong), serviceCuid, cleanUpTimeoutSecs) {
    val lifecycle = new RecordingLifecycleManager
    override val lifeCycleManager: WorkflowLifecycleManager = lifecycle

    /** What each run was started from: its plan, its plan row and its plan table. */
    val started: ArrayBuffer[(ExecutionPlan, PlanRecord, URI)] = ArrayBuffer.empty

    override protected def readPlan(planUri: URI): PlanRecord =
      read.fold(super.readPlan(planUri))(_(planUri))
    override protected def claimStart(planUri: URI): Unit =
      claim.fold(super.claimStart(planUri))(_(planUri))
    override def supersedeCurrentRun(): Unit =
      supersedeFailure.fold(super.supersedeCurrentRun())(failure => throw failure)
    override protected def storedRun(
        context: WorkflowContext,
        executionStateStore: ExecutionStateStore,
        errorHandler: Throwable => Unit
    ): WorkflowExecutionService = {
      buildFailure.foreach(failure => throw failure)
      new WorkflowExecutionService(context, null, executionStateStore, errorHandler, None) {
        override def startStored(
            executionPlan: ExecutionPlan,
            record: PlanRecord,
            planUri: URI
        ): Option[Throwable] = {
          started += ((executionPlan, record, planUri))
          startFailure.foreach(failure => throw failure)
          None
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fixtures for the previous-run clean-up case. `initExecutionService` needs the whole
  // user / workflow / workflow_version / workflow_computing_unit chain before it can insert
  // its own execution row: workflow_executions.uid, .vid and .cuid are all foreign keys.
  // ---------------------------------------------------------------------------

  // Four id domains, four different literals. `getLatestExecutionID(wid, cuid)` binds two bare
  // `Integer`s into one predicate and `insertNewExecution` takes wid and uid side by side, so a
  // fixture that reused one number for all of them would make every transposition of those
  // arguments produce byte-identical SQL.
  private val testWid = 9411

  /** A second workflow that shares `testCuid`, so the WID leg of the predicate is not vacuous. */
  private val otherWid = 9412
  private val testUid = 9413

  /** The computing unit the run under test executes on. */
  private val testCuid = 9414

  /** A second computing unit of the same workflow, so the clean-up's scope is not vacuous. */
  private val otherCuid = 9415

  /** The unit the read-before-delete case runs on, kept apart from every other case's rows. */
  private val probeCuid = 9416

  /** The unit the cost-hints cases run on: no fixture execution ran on it. */
  private val hintsCuid = 9417

  /** The unit the superseded-run cases run on. */
  private val supersedeCuid = 9418

  /** The unit the idle clean-up cases run on. */
  private val idleCuid = 9419

  /** The unit the case of a new run superseding a live one runs on. */
  private val replaceCuid = 9420

  /** The unit the case of the idle clean-up letting go of a superseded run runs on. */
  private val followCuid = 9421

  /** The unit the case of superseding a run being set up runs on. */
  private val setUpCuid = 9422

  /** The unit the executions started by id were created for. */
  private val storedCuid = 9423

  // Executions carry explicit eids rather than the SERIAL's: see the header on
  // LargeBinaryManager. The relative order is load-bearing and is stated here rather than
  // inherited from insertion order.

  /** An older, superseded execution of (`testWid`, `testCuid`). Must survive untouched. */
  private val olderEid = 941100

  /** The newest execution of (`testWid`, `testCuid`): the run whose registry must be cleared. */
  private val previousEid = 941101

  /**
    * A LATER execution of the same workflow on a different computing unit. Its eid is larger than
    * `previousEid` on purpose: `getLatestExecutionID` picks the maximum eid *among the rows of
    * the requested computing unit*, so without the CUID leg this row would be chosen instead.
    */
  private val otherUnitEid = 941102

  /**
    * A LATER execution of a *different* workflow on the SAME computing unit. `workflow_computing_unit`
    * is keyed by uid and carries no wid, so one unit legitimately runs many workflows; without the
    * WID leg this row is what `getLatestExecutionID` returns, and a new run of `testWid` would
    * wipe an unrelated workflow's registry.
    */
  private val otherWorkflowEid = 941103

  /** The read-before-delete case's execution; the only fixture with a non-NULL URI column. */
  private val probeEid = 941104

  /** The superseded-run cases' execution, on `supersedeCuid`. */
  private val supersededEid = 941105

  /**
    * The execution the idle clean-up case's service holds, on `idleCuid`: older than
    * `newerIdleEid`, so a clean-up that took the newest execution of the unit would take the other.
    */
  private val heldIdleEid = 941106

  /** A newer execution of `testWid` on `idleCuid`, which the service does not hold. */
  private val newerIdleEid = 941107

  /** The execution of the live run a new run supersedes, on `replaceCuid`. */
  private val replacedEid = 941108

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

  private val fixtureEids: Seq[Integer] =
    Seq(
      olderEid,
      previousEid,
      otherUnitEid,
      otherWorkflowEid,
      probeEid,
      supersededEid,
      heldIdleEid,
      newerIdleEid,
      replacedEid,
      startedEid,
      refusedEid,
      unclaimedEid,
      failedEid,
      heldStoredEid,
      askedUnitEid,
      unpublishedEid,
      unbuiltEid
    ).map(Integer.valueOf)

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

    val workflowDao = new WorkflowDao(cfg)
    val versionDao = new WorkflowVersionDao(cfg)
    List(testWid -> "workflow_service_spec_workflow", otherWid -> "workflow_service_spec_other")
      .foreach {
        case (wid, name) =>
          val workflow = new Workflow
          workflow.setWid(wid)
          workflow.setName(name)
          workflow.setContent("{}")
          workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
          workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
          workflowDao.insert(workflow)

          val version = new WorkflowVersion
          version.setWid(wid)
          version.setContent("{}")
          version.setCreationTime(new Timestamp(System.currentTimeMillis()))
          versionDao.insert(version)
      }

    val unitDao = new WorkflowComputingUnitDao(cfg)
    List(
      testCuid -> "workflow_service_spec_unit",
      otherCuid -> "workflow_service_spec_other_unit",
      probeCuid -> "workflow_service_spec_probe_unit",
      hintsCuid -> "workflow_service_spec_hints_unit",
      supersedeCuid -> "workflow_service_spec_supersede_unit",
      idleCuid -> "workflow_service_spec_idle_unit",
      replaceCuid -> "workflow_service_spec_replace_unit",
      followCuid -> "workflow_service_spec_follow_unit",
      setUpCuid -> "workflow_service_spec_set_up_unit",
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

    insertExecution(olderEid, testWid, testCuid, "older-run")
    insertExecution(previousEid, testWid, testCuid, "previous-run")
    insertExecution(otherUnitEid, testWid, otherCuid, "other-unit-run")
    insertExecution(otherWorkflowEid, otherWid, testCuid, "other-workflow-run")
    insertExecution(probeEid, testWid, probeCuid, "probe-run")
    insertExecution(supersededEid, testWid, supersedeCuid, "superseded-run")
    insertExecution(heldIdleEid, testWid, idleCuid, "held-idle-run")
    insertExecution(newerIdleEid, testWid, idleCuid, "newer-idle-run")
    insertExecution(replacedEid, testWid, replaceCuid, "replaced-run")
    Seq(
      startedEid,
      refusedEid,
      unclaimedEid,
      failedEid,
      heldStoredEid,
      askedUnitEid,
      unpublishedEid,
      unbuiltEid
    ).foreach { eid =>
      insertExecution(eid, testWid, storedCuid, s"stored-run-$eid")
    }

    // Keep the SERIAL sequence ahead of our explicit fixture ids, so the execution that
    // production inserts below cannot land on eid 1 -- LargeBinaryManager's DEFAULT_EXECUTION_ID
    // sentinel, whose `objects/1/` prefix is shared rather than owned (see the header).
    //
    // The table name is qualified from the generated metadata rather than written bare:
    // `pg_get_serial_sequence` resolves its argument through the connection's search_path, and
    // only the throwaway connection that ran the DDL had `texera_db` on it. Every other statement
    // in this fixture goes through jOOQ, which qualifies for us -- a bare name here raises
    // `relation "workflow_executions" does not exist` and aborts the suite.
    getDSLContext.execute(
      "select setval(pg_get_serial_sequence(?, ?), ?, true)",
      s"${WORKFLOW_EXECUTIONS.getSchema.getName}.${WORKFLOW_EXECUTIONS.getName}",
      WORKFLOW_EXECUTIONS.EID.getName,
      Integer.valueOf(fixtureEids.map(_.intValue()).max)
    )

    // A different row count per execution, so a clean-up that took the wrong one cannot be
    // mistaken for one that took the right one.
    (0 until 3).foreach { i =>
      registerOperator(olderEid, s"older-op-$i")
      registerPort(olderEid, s"older-port-$i")
    }
    (0 until 2).foreach { i =>
      registerOperator(previousEid, s"prev-op-$i")
      registerPort(previousEid, s"prev-port-$i")
    }
    registerOperator(otherUnitEid, "other-op")
    registerPort(otherUnitEid, "other-port")
    (0 until 4).foreach { i =>
      registerOperator(otherWorkflowEid, s"other-wf-op-$i")
      registerPort(otherWorkflowEid, s"other-wf-port-$i")
    }
    registerOperator(probeEid, "probe-op")
    // The one non-NULL URI in the fixture: syntactically a URI, but not a `vfs` one, so
    // `VFSURIFactory.decodeURI` rejects it. See the header -- this is the witness that the
    // registry was read, not an assertion that malformed rows ought to be fatal.
    registerPort(probeEid, "probe-port", resultUri = "bogus:///stranded")
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

  private def versionIdOf(wid: Int): Integer =
    getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(wid))
      .fetchOneInto(classOf[Integer])

  private def insertExecution(eid: Int, wid: Int, cuid: Int, name: String): Unit =
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, versionIdOf(wid))
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(testUid))
      .set(WORKFLOW_EXECUTIONS.CUID, Integer.valueOf(cuid))
      // Spelled out rather than left to the DDL's default, which is RUNNING: what this suite
      // pins is a *finished* previous run being cleared. Whether a still-live execution's
      // registry may be wiped while `ExecutionResultService` is still serving from it is a
      // separate question production leaves open ("TODO: change this behavior after enabling
      // cache."), and nothing here should decide it.
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

  /** A result registry row. The URI column stays NULL unless a case needs otherwise. */
  private def registerPort(eid: Int, globalPortId: String, resultUri: String = null): Unit =
    getDSLContext
      .insertInto(OPERATOR_PORT_EXECUTIONS)
      .set(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID, Integer.valueOf(eid))
      .set(OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID, globalPortId)
      .set(OPERATOR_PORT_EXECUTIONS.RESULT_URI, resultUri)
      .execute()

  /** Executions this fixture did not seed: after a run, exactly the ones production inserted. */
  private def executionsOutsideFixture: Int =
    getDSLContext.fetchCount(WORKFLOW_EXECUTIONS, WORKFLOW_EXECUTIONS.EID.notIn(fixtureEids: _*))

  private def insertedExecution(): WorkflowExecutions =
    new WorkflowExecutionsDao(getDSLContext.configuration()).fetchOneByEid(
      getDSLContext
        .select(WORKFLOW_EXECUTIONS.EID)
        .from(WORKFLOW_EXECUTIONS)
        .where(WORKFLOW_EXECUTIONS.EID.notIn(fixtureEids: _*))
        .fetchOneInto(classOf[Integer])
    )

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
    * A run that was never started, as `initExecutionService` builds one; of execution `eid` when
    * given, which its context and its metadata store then name, as `initExecutionService` sets
    * them.
    */
  private def newExecution(eid: Option[Int] = None): WorkflowExecutionService = {
    val request = WorkflowExecuteRequest(
      executionName = "test",
      engineVersion = "test",
      logicalPlan = LogicalPlanPojo(List.empty, List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = 1,
      warehouseId = None
    )
    val context = new WorkflowContext()
    val stateStore = new ExecutionStateStore()
    eid.foreach { eid =>
      context.executionId = ExecutionIdentity(eid.toLong)
      stateStore.metadataStore.updateState(_.withExecutionId(ExecutionIdentity(eid.toLong)))
    }
    new WorkflowExecutionService(
      context,
      null,
      request,
      stateStore,
      (_: Throwable) => (),
      Integer.valueOf(1), // uid; these tests never resolve a file
      None,
      new URI("vfs:///test"),
      replay = None,
      replayLog = None
    )
  }

  private def statusOf(eid: Int): Int =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.STATUS)
      .from(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.eq(eid))
      .fetchOne(WORKFLOW_EXECUTIONS.STATUS)
      .intValue()

  /**
    * A request for a run of a CSV scan with no file selected, on unit `cuid`: as in the clean-up
    * case, the run is set up up to its compile, which fails, so no coordinator is needed.
    */
  private def runStoppedAtCompile(name: String, cuid: Int): WorkflowExecuteRequest = {
    val scan = new CSVScanSourceOpDesc()
    scan.setOperatorId("scan-op")
    WorkflowExecuteRequest(
      executionName = name,
      engineVersion = "test",
      logicalPlan = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = cuid,
      warehouseId = None
    )
  }

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
    val planUri = planUriOf(eid)
    madePlans += planUri
    ExecutionPlanStore.writePlan(
      planUri,
      PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        kind = ExecutionPlanStore.PlanKind,
        formatVersion = PhysicalPlanCodec.FormatVersion,
        body = PhysicalPlanCodec.toJson(
          PhysicalPlanCodec.encode(ExecutionPlan(context, PhysicalPlan(Set(lines), Set.empty)))
        ),
        logical = "{}",
        createdAt = new Timestamp(System.currentTimeMillis()),
        createdBy = testUid,
        computingUnitId = storedCuid,
        notification = None
      )
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

  private val startUri = new URI("ws://texera.example/wsapi/workflow-websocket")

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
    val statements = recorder.record(service.supersedeCurrentRun())
    val after = System.currentTimeMillis()

    // Its row reads Killed, written by one UPDATE that reads nothing, and so does its store.
    statements.map(_.verb) shouldBe Seq("UPDATE")
    statements.head.sql should include("workflow_executions")
    statements.head.sql.toLowerCase should not include "select"
    statusOf(supersededEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
    previous.executionStateStore.metadataStore.getState.state shouldBe KILLED
    previous.executionStateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
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

          recorder.record(service.supersedeCurrentRun()) shouldBe empty

          previous.executionStateStore.metadataStore.getState.state shouldBe finished
          previous.executionStateStore.statsStore.getState.endTimeStamp shouldBe 0L
          // let go of: its own subscriptions are gone
          previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
          events shouldBe empty
        }
      }
  }

  it should "do nothing when superseding while it holds no run" in {
    val service = new TestWorkflowService(testWid.toLong, supersedeCuid)
    recorder.record(service.supersedeCurrentRun()) shouldBe empty
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

  it should "clear nothing once idle when it holds no run" in {
    val service = new TestWorkflowService(testWid.toLong, idleCuid)
    val ownSubscription = new TrackingDisposable
    service.addSubscription(ownSubscription)

    recorder.record(service.cleanUpAfterIdle()) shouldBe empty

    operatorRowCount(newerIdleEid) shouldBe 1
    portRowCount(newerIdleEid) shouldBe 1
    ownSubscription.isDisposed shouldBe true
  }

  it should "refuse an invalid warehouse pick before detaching the previous execution" in {
    // The pick is resolved before the teardown: an agent (or a stale client)
    // asking for a warehouse the deployment will reject must not take the
    // execution already running down with it (#7751). With the feature off,
    // any explicit pick is refused (#6930), which is the cheapest way to make
    // resolution fail here.
    val service = new TestWorkflowService(9L)
    val previous = newExecution()
    service.executionService.onNext(previous)
    val events = collectExecutionEvents(previous)
    val request = WorkflowExecuteRequest(
      executionName = "test",
      engineVersion = "test",
      logicalPlan = LogicalPlanPojo(List.empty, List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = 1,
      warehouseId = Some(1)
    )

    val error = intercept[IllegalArgumentException] {
      service.initExecutionService(request, Some(executingUser), new URI("vfs:///session"))
    }
    error.getMessage should include("warehouse")

    previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    events should not be empty
  }

  it should "refuse to start an execution with no user id, leaving the previous one attached" in {
    val service = new TestWorkflowService(6L)
    val previous = newExecution()
    service.executionService.onNext(previous)
    val events = collectExecutionEvents(previous)
    val request = WorkflowExecuteRequest(
      executionName = "test",
      engineVersion = "test",
      logicalPlan = LogicalPlanPojo(List.empty, List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = 1,
      warehouseId = None
    )

    // uid is NOT NULL in the DB, so this has to fail before the execution row is inserted.
    val error = intercept[IllegalArgumentException] {
      service.initExecutionService(request, None, new URI("vfs:///session"))
    }
    error.getMessage should include("user id")

    // A request that is going to be refused must not take the running execution
    // with it: its subscriptions are still live.
    previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    events should not be empty
  }

  it should "clear the previous run's storage registry, on its computing unit only, before starting a new execution" in {
    // Registered result and console documents outlive the run that produced them; starting a new
    // execution is what drops them (there is no cache yet), so if the registry rows survive here
    // every re-run leaks a result table and a console-message document with no owner left to
    // delete them.
    //
    // The service is built on `otherCuid` while the request names `testCuid`. Production reads
    // the REQUEST's unit here, and the two really do diverge in the field: `getOrCreate` keys its
    // registry on the workflow id alone, so a second opener's computing unit is dropped and the
    // cached service's field goes stale while the request stays right (#7676). Collapsing them
    // into one value would make the scoping this test is named for unobservable.
    val service = new TestWorkflowService(testWid.toLong, otherCuid)
    val scan = new CSVScanSourceOpDesc()
    scan.setOperatorId("scan-op")
    val request = WorkflowExecuteRequest(
      executionName = "cleanup-spec-run",
      engineVersion = "test",
      // A CSV scan with no file selected: compilation rejects it, so this reaches the clean-up
      // and the execution insert for real, then stops inside executeWorkflow without needing a
      // coordinator to come up.
      logicalPlan = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = testCuid,
      warehouseId = None
    )

    operatorRowCount(previousEid) shouldBe 2
    portRowCount(previousEid) shouldBe 2
    executionsOutsideFixture shouldBe 0

    service.initExecutionService(request, Some(executingUser), new URI("vfs:///session"))

    val execution = service.executionService.getValue
    // Stopped exactly where the header says it stops: one fatal error, the compiler's. A second
    // one would mean the run fell through into `createAmberRuntime` on a null workflow.
    val fatalErrors = execution.executionStateStore.metadataStore.getState.fatalErrors
    fatalErrors should have size 1
    fatalErrors.head.message should include("No file selected")
    // The run's error handler records it as the editing compile reports it: the scan's own error,
    // on the scan, so the UI shows it there.
    fatalErrors.head.`type` shouldBe COMPILATION_ERROR
    fatalErrors.head.operatorId shouldBe "scan-op"

    // The clean-up deadline is armed, with this execution's own store. Nothing else in the method
    // touches `lifeCycleManager`, so without this the one statement that wires deferred clean-up
    // could be deleted from production unnoticed.
    service.lifecycle.registeredStores should have size 1
    service.lifecycle.registeredStores.head should be theSameInstanceAs
      execution.executionStateStore

    operatorRowCount(previousEid) shouldBe 0
    portRowCount(previousEid) shouldBe 0
    // The execution record itself stays. Both registry tables cascade on workflow_executions, so
    // deleting the row would empty them too -- while also erasing the run from the user's history.
    executionRowCount(previousEid) shouldBe 1

    // Scoped to the computing unit this REQUEST runs on. `otherUnitEid` is a newer execution of
    // the same workflow on another unit, so a clean-up that ignored the unit -- or that followed
    // the service's stale field instead -- would take these rows and leave the previous run's.
    operatorRowCount(otherUnitEid) shouldBe 1
    portRowCount(otherUnitEid) shouldBe 1

    // Scoped to this workflow too. `otherWorkflowEid` is the newest execution on `testCuid`, so
    // dropping the workflow leg of the predicate destroys an unrelated workflow's registry
    // instead -- a unit hosts many workflows, it is keyed by user, not by workflow.
    operatorRowCount(otherWorkflowEid) shouldBe 4
    portRowCount(otherWorkflowEid) shouldBe 4

    // Only the newest run of this (workflow, unit) is cleared, and only that one: `olderEid` is
    // superseded, and its rows witness both halves -- selecting the oldest instead of the newest
    // would strand `previousEid`'s documents, and widening the delete from "this execution" to
    // "up to this execution" would take every earlier run's registry with it.
    operatorRowCount(olderEid) shouldBe 3
    portRowCount(olderEid) shouldBe 3

    // The new execution row, recorded after the clean-up rather than deleted by it, and derived
    // from the request throughout.
    executionsOutsideFixture shouldBe 1
    val newRow = insertedExecution()
    newRow.getName shouldBe "cleanup-spec-run"
    newRow.getCuid.intValue() shouldBe testCuid
    newRow.getUid.intValue() shouldBe testUid
    newRow.getVid shouldBe versionIdOf(testWid)
    newRow.getEnvironmentVersion shouldBe """{"engine_version":"test"}"""
    // Past every fixture id, i.e. the sequence bump in `beforeAll` reached the sequence. A
    // `setval` that quietly resolved to NULL would leave the SERIAL at 1 -- the id whose S3
    // prefix `LargeBinaryManager` treats as a shared sentinel (see the header).
    newRow.getEid.intValue() should be > fixtureEids.map(_.intValue()).max
  }

  it should "read the previous run's registered URIs before it deletes the rows that hold them" in {
    // `clearExecutionResources` collects the result and console URIs and only then drops the
    // registry rows. Reversed, the collection comes back empty and every document the previous
    // run wrote is stranded with nothing left pointing at it -- and no assertion on row counts
    // can tell the two orders apart, because the rows are gone either way.
    //
    // The witness is `probeEid`'s registry row, whose URI the decoder rejects: reaching it at all
    // proves the read happened while the row still existed. That the rejection escapes the whole
    // method is a robustness gap in production, not a contract -- see the header.
    val service = new TestWorkflowService(testWid.toLong, probeCuid)
    val scan = new CSVScanSourceOpDesc()
    scan.setOperatorId("scan-op")
    val request = WorkflowExecuteRequest(
      executionName = "probe-spec-run",
      engineVersion = "test",
      logicalPlan = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = probeCuid,
      warehouseId = None
    )

    portRowCount(probeEid) shouldBe 1
    operatorRowCount(probeEid) shouldBe 1

    val error = intercept[IllegalArgumentException] {
      service.initExecutionService(request, Some(executingUser), new URI("vfs:///session"))
    }
    // From the decoder, not from the uid check the sibling case above exercises.
    error.getMessage should include("Invalid URI scheme")

    // ...and the registry rows are already gone by then, which is what places the read before the
    // delete rather than merely somewhere in the same method.
    portRowCount(probeEid) shouldBe 0
    operatorRowCount(probeEid) shouldBe 0
  }

  // The cost-hints cases are declared after the clean-up case on purpose: the first two insert
  // executions of their own, and that case counts the executions outside the fixture.
  it should "give a new run's context the cost hints of its user's runs of the workflow" in {
    assume(!StorageConfig.warehouseEnabled, "per-user warehouses are enabled in this deployment")
    // The plan is saved with the context's hints, and the engine takes them from the plan.
    val hints = Some(CostHints(ExecutionIdentity(previousEid.toLong), Map("scan-op" -> 2.5)))
    val loader = new RecordingCostHintsLoader(hints)
    val service = new TestWorkflowService(testWid.toLong, hintsCuid, Some(loader))
    val scan = new CSVScanSourceOpDesc()
    scan.setOperatorId("scan-op")
    val request = WorkflowExecuteRequest(
      executionName = "hints-spec-run",
      engineVersion = "test",
      // As in the clean-up case, the run stops at the compile, after its context is set up.
      logicalPlan = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = hintsCuid,
      warehouseId = None
    )

    service.initExecutionService(request, Some(executingUser), new URI("vfs:///session"))

    loader.asked shouldBe Seq((testWid.toLong, testUid))
    val execution = service.executionService.getValue
    execution.workflowContext.costHints shouldBe hints
    val fatalErrors = execution.executionStateStore.metadataStore.getState.fatalErrors
    fatalErrors should have size 1
    fatalErrors.head.message should include("No file selected")
  }

  it should "give a new run no cost hints when its user has none for the workflow" in {
    assume(!StorageConfig.warehouseEnabled, "per-user warehouses are enabled in this deployment")
    val loader = new RecordingCostHintsLoader(None)
    val service = new TestWorkflowService(otherWid.toLong, hintsCuid, Some(loader))
    val request = WorkflowExecuteRequest(
      executionName = "no-hints-spec-run",
      engineVersion = "test",
      logicalPlan =
        LogicalPlanPojo(List(new CSVScanSourceOpDesc()), List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = hintsCuid,
      warehouseId = None
    )

    service.initExecutionService(request, Some(executingUser), new URI("vfs:///session"))

    loader.asked shouldBe Seq((otherWid.toLong, testUid))
    val execution = service.executionService.getValue
    execution.workflowContext.costHints shouldBe None
    val fatalErrors = execution.executionStateStore.metadataStore.getState.fatalErrors
    fatalErrors should have size 1
    fatalErrors.head.message should include("No file selected")
  }

  it should "ask for no cost hints for a run it refuses" in {
    assume(!StorageConfig.warehouseEnabled, "per-user warehouses are enabled in this deployment")
    val loader = new RecordingCostHintsLoader(None)
    val service = new TestWorkflowService(testWid.toLong, hintsCuid, Some(loader))
    val request = WorkflowExecuteRequest(
      executionName = "refused-spec-run",
      engineVersion = "test",
      logicalPlan = LogicalPlanPojo(List.empty, List.empty, List.empty, List.empty),
      replayFromExecution = None,
      workflowSettings = WorkflowSettings(),
      emailNotificationEnabled = false,
      computingUnitId = hintsCuid,
      warehouseId = Some(1)
    )

    // a warehouse picked while per-user warehouses are off, then no user
    the[IllegalArgumentException] thrownBy
      service.initExecutionService(request, Some(executingUser), new URI("vfs:///session")) should
      have message "per-user warehouses are disabled in this deployment"
    val noUser = the[IllegalArgumentException] thrownBy
      service.initExecutionService(request.copy(warehouseId = None), None, new URI("vfs:///s"))
    noUser.getMessage should include("user id")
    loader.asked shouldBe empty
  }

  // The cases of a new run superseding the one held are declared after the clean-up case too, as
  // they insert executions of their own.
  it should "supersede the run it holds when it sets up a new one, recording a live one as killed" in {
    val service = new TestWorkflowService(testWid.toLong, replaceCuid)
    val previous = newExecution(Some(replacedEid))
    service.executionService.onNext(previous)
    previous.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    statusOf(replacedEid) shouldBe Utils.maptoStatusCode(COMPLETED).toInt // as the fixture wrote it
    val previousEvents = collectExecutionEvents(previous)
    // A new subscriber is first told the store's state, as a reconnecting client is.
    previousEvents.clear()

    val before = System.currentTimeMillis()
    service.initExecutionService(
      runStoppedAtCompile("replacing-run", replaceCuid),
      Some(executingUser),
      new URI("vfs:///session")
    )
    val after = System.currentTimeMillis()

    // The run it held reads Killed, in its store and in its execution's row, with its end time.
    previous.executionStateStore.metadataStore.getState.state shouldBe KILLED
    previous.executionStateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
    statusOf(replacedEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
    // It was let go of first, so a client of the workflow was not told of the kill.
    previousEvents shouldBe empty
    // The new run took its place, and stopped at its compile.
    val next = service.executionService.getValue
    next should not be theSameInstanceAs(previous)
    next.executionStateStore.metadataStore.getState.fatalErrors.map(_.message).mkString should
      include("No file selected")
  }

  it should "let the idle clean-up stop following a run once a new run supersedes it" in {
    val service = new TestWorkflowService(testWid.toLong, followCuid)
    def statesFollowed(run: WorkflowExecutionService): Seq[WorkflowAggregatedState] =
      service.lifecycle.followedStates.collect {
        case (store, state) if store eq run.executionStateStore => state
      }.toSeq
    service.initExecutionService(
      runStoppedAtCompile("followed-run", followCuid),
      Some(executingUser),
      new URI("vfs:///session")
    )
    val first = service.executionService.getValue
    // As though its engine had started, so that the next run kills it.
    first.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    statesFollowed(first).last shouldBe RUNNING

    service.initExecutionService(
      runStoppedAtCompile("following-run", followCuid),
      Some(executingUser),
      new URI("vfs:///session")
    )

    // Killed, but the kill did not reach the clean-up: on a workflow no session has open, it
    // would arm the deadline, which could then fire while the new run is set up.
    first.executionStateStore.metadataStore.getState.state shouldBe KILLED
    statesFollowed(first) should not contain KILLED
    // The clean-up follows the new run.
    val second = service.executionService.getValue
    service.lifecycle.registeredStores.last should be theSameInstanceAs second.executionStateStore
    statesFollowed(second) should contain(WorkflowAggregatedState.FAILED)
  }

  it should "let a run being set up finish its setup before another request supersedes it" in {
    val loading = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    // Holds the new run's setup where it looks up its cost hints, until released.
    val loader = new CostHintsLoader(cacheCapacity = 1) {
      override def load(wid: Long, uid: Int): Option[CostHints] = {
        loading.countDown()
        release.await(60, TimeUnit.SECONDS)
        None
      }
    }
    val service = new TestWorkflowService(testWid.toLong, setUpCuid, Some(loader))
    val threads = Executors.newFixedThreadPool(2)
    implicit val onThreads: ExecutionContext = ExecutionContext.fromExecutorService(threads)
    try {
      val setUp = Future(
        service.initExecutionService(
          runStoppedAtCompile("set-up-run", setUpCuid),
          Some(executingUser),
          new URI("vfs:///session")
        )
      )
      loading.await(60, TimeUnit.SECONDS) shouldBe true
      // Another request, such as the agent's, supersedes the run while it is being set up.
      val superseding = Future(service.supersedeCurrentRun())

      // It waits for the setup to end...
      a[TimeoutException] should be thrownBy Await.ready(superseding, 500.millis)
      release.countDown()
      Await.result(setUp, 60.seconds)
      Await.result(superseding, 60.seconds)

      // ...and then lets go of the run set up in full, which failed at its compile: the run keeps
      // its state, in its store and in its execution's row.
      val run = service.executionService.getValue
      run.executionStateStore.metadataStore.getState.state shouldBe WorkflowAggregatedState.FAILED
      statusOf(run.workflowContext.executionId.id.toInt) shouldBe
        Utils.maptoStatusCode(WorkflowAggregatedState.FAILED).toInt
    } finally {
      release.countDown()
      threads.shutdownNow()
    }
  }

  "WorkflowService.startStoredExecution" should
    "claim the execution, supersede the live run, and start a run of the plan read back on the unit asked" in {
    val planUri = storePlanOf(startedEid)
    val service = new StoredStartService()
    val held = holdRunningRun(service, heldStoredEid)
    val heldEvents = collectExecutionEvents(held)
    heldEvents.clear()
    // Asked with a URI that carries a secret, as a socket's does in its query.
    val askedAt = new URI(s"$startUri?wid=$testWid&access-token=secret-token#also-secret")

    val (started, logged) = linesLoggedBy("org.apache.texera.web") {
      service
        .startStoredExecution(startedEid, planUri, executingUser, storedCuid, askedAt)
        .getOrElse(fail("the start was refused"))
    }

    // The start is logged, where it was asked without what can carry a secret.
    logged.filter(_.contains(s"Execution $startedEid of workflow $testWid starts")) shouldBe Seq(
      s"Execution $startedEid of workflow $testWid starts on computing unit $storedCuid from its " +
        s"plan at $planUri, as asked at $startUri."
    )
    logged.filter(line => line.contains("secret")) shouldBe empty
    // Claimed for its one start, in its plan table.
    ExecutionPlanStore.isStarted(planUri) shouldBe true
    // The run it held reads Killed, in its store and its row, and no session was told of it.
    held.executionStateStore.metadataStore.getState.state shouldBe KILLED
    statusOf(heldStoredEid) shouldBe Utils.maptoStatusCode(KILLED).toInt
    heldEvents shouldBe empty
    // The new run is published in its place, and followed by the idle clean-up.
    service.executionService.getValue should be theSameInstanceAs started
    service.lifecycle.registeredStores.last should be theSameInstanceAs started.executionStateStore
    started.executionStateStore.metadataStore.getState.executionId shouldBe
      ExecutionIdentity(startedEid.toLong)
    // It was started from the plan read back from the lake, the row and the table, under the
    // context the plan was read back with: its ids and settings, and the unit the start was
    // asked of, without which a UDF's environment would fall back to the engine's interpreter.
    service.started should have size 1
    val (executionPlan, record, startedFrom) = service.started.head
    startedFrom shouldBe planUri
    record shouldBe ExecutionPlanStore.readPlan(planUri)
    executionPlan.plan.operators.map(_.id) shouldBe
      Set(PhysicalOpIdentity(OperatorIdentity("lines"), "main"))
    started.workflowContext should be theSameInstanceAs executionPlan.context
    started.workflowContext.cuid shouldBe Some(storedCuid)
    started.workflowContext.executionId shouldBe ExecutionIdentity(startedEid.toLong)
    started.workflowContext.workflowSettings.dataTransferBatchSize shouldBe 64

    // A second start of it is refused, however it comes, writing nothing and leaving the run
    // started as it is.
    val again = recorder.record {
      service.startStoredExecution(
        startedEid,
        planUri,
        executingUser,
        storedCuid,
        startUri
      ) shouldBe
        Left(s"execution $startedEid was already started")
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
      (stranger, storedCuid, s"only the user who created execution $refusedEid may start it"),
      (
        executingUser,
        testCuid,
        s"execution $refusedEid was created for computing unit $storedCuid, not $testCuid"
      )
    )

    refusals.foreach {
      case (user, cuid, why) =>
        withClue(s"$why: ") {
          val statements = recorder.record {
            service.startStoredExecution(refusedEid, planUri, user, cuid, startUri) shouldBe
              Left(why)
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
        storedCuid,
        startUri
      ) shouldBe Left(s"execution $heldStoredEid has no stored plan")
    } shouldBe empty
    // A start checked for another workflow, which the agent's path would have asked another
    // service to start.
    val checked = WorkflowService
      .checkStoredStart(refusedEid, planUri, executingUser, storedCuid, socketWorkflowId = None)
      .getOrElse(fail("the start was refused"))
    checked.workflowId shouldBe WorkflowIdentity(testWid.toLong)
    recorder.record {
      service.startChecked(
        checked.copy(workflowId = WorkflowIdentity(testWid.toLong + 1)),
        startUri
      ) shouldBe Left(s"the plan belongs to workflow ${testWid + 1}, not to this one")
    } shouldBe empty

    ExecutionPlanStore.isStarted(planUri) shouldBe false
    service.started shouldBe empty
    service.executionService.getValue should be theSameInstanceAs held
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
    held.executionStateStore.metadataStore.getState.fatalErrors shouldBe empty
  }

  it should "answer a claim or a read the lake fails as a refusal, to try again unless the row is malformed, leaving the held run alone" in {
    val planUri = storePlanOf(unclaimedEid)
    def refusalOf(service: StoredStartService): Either[String, WorkflowExecutionService] = {
      val held = holdRunningRun(service, heldStoredEid)
      val answer =
        service.startStoredExecution(unclaimedEid, planUri, executingUser, storedCuid, startUri)
      service.executionService.getValue should be theSameInstanceAs held
      held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
      service.started shouldBe empty
      answer
    }

    // Every retry of the claim lost its commit to another commit on the table.
    refusalOf(
      new StoredStartService(claim = Some(_ => throw new CommitFailedException("lost the race")))
    ) shouldBe Left(
      s"execution $unclaimedEid could not be claimed for its start, as its plan was being " +
        "changed; try starting it again"
    )
    refusalOf(
      new StoredStartService(claim = Some(_ => throw new IllegalStateException("catalog down")))
    ) shouldBe
      Left(s"execution $unclaimedEid could not be claimed for its start; try starting it again")
    refusalOf(
      new StoredStartService(
        read = Some(_ => throw new UncheckedIOException(new IOException("catalog down")))
      )
    ) shouldBe
      Left(s"the plan of execution $unclaimedEid could not be read; try starting it again")
    // A row the table holds that is no plan row, as `PlanRecord.fromTuple` refuses it: a second
    // try reads the same row.
    refusalOf(
      new StoredStartService(
        read = Some(_ => throw new IllegalStateException("a plan table row has no body"))
      )
    ) shouldBe
      Left(
        s"the stored plan of execution $unclaimedEid cannot be read: a plan table row has no body"
      )
    refusalOf(
      new StoredStartService(read = Some(_ => throw new IllegalArgumentException()))
    ) shouldBe Left(s"the stored plan of execution $unclaimedEid cannot be read")
    ExecutionPlanStore.isStarted(planUri) shouldBe false
  }

  it should "report a run that fails once its execution is claimed as that run's failure" in {
    val planUri = storePlanOf(failedEid)
    val service =
      new StoredStartService(startFailure = Some(new IllegalStateException("the engine is gone")))
    val held = holdRunningRun(service, heldStoredEid)

    val failed = service
      .startStoredExecution(failedEid, planUri, executingUser, storedCuid, startUri)
      .getOrElse(fail("the start was refused"))

    // Published, superseding the held run, and failed with the reason, which every session on the
    // workflow is sent; its row reads Failed.
    service.executionService.getValue should be theSameInstanceAs failed
    held.executionStateStore.metadataStore.getState.state shouldBe KILLED
    failed.executionStateStore.metadataStore.getState.state shouldBe
      WorkflowAggregatedState.FAILED
    failed.executionStateStore.metadataStore.getState.fatalErrors.map(_.message) shouldBe
      Seq("java.lang.IllegalStateException: the engine is gone")
    statusOf(failedEid) shouldBe Utils.maptoStatusCode(WorkflowAggregatedState.FAILED).toInt
    ExecutionPlanStore.isStarted(planUri) shouldBe true
  }

  it should "run on the unit the start was asked of, not the one the workflow's service was made for" in {
    // The first session of a workflow makes its service, for that session's unit, and every later
    // session of the workflow shares it, on whichever unit (#7676).
    val planUri = storePlanOf(askedUnitEid)
    val service = new StoredStartService(serviceCuid = testCuid)
    service.computingUnitId shouldBe testCuid

    val started = service
      .startStoredExecution(askedUnitEid, planUri, executingUser, storedCuid, startUri)
      .getOrElse(fail("the start was refused"))

    started.workflowContext.cuid shouldBe Some(storedCuid)
    service.started.map(_._1.context.cuid) shouldBe Seq(Some(storedCuid))
  }

  it should "publish a run that fails before it is published, so its sessions see why" in {
    val planUri = storePlanOf(unpublishedEid)
    val service =
      new StoredStartService(supersedeFailure = Some(new IllegalStateException("cannot supersede")))
    val held = holdRunningRun(service, heldStoredEid)

    val failed = service
      .startStoredExecution(unpublishedEid, planUri, executingUser, storedCuid, startUri)
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
    service.started shouldBe empty
    // The supersede failed before it touched the held run.
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
  }

  it should "answer a run that cannot even be built, keeping the held run, as its execution reads Failed" in {
    val planUri = storePlanOf(unbuiltEid)
    val service =
      new StoredStartService(buildFailure = Some(new IllegalStateException("cannot build")))
    val held = holdRunningRun(service, heldStoredEid)

    service.startStoredExecution(unbuiltEid, planUri, executingUser, storedCuid, startUri) shouldBe
      Left(
        s"execution $unbuiltEid could not be started, because of an error on this computing unit"
      )

    // Claimed, so never to start, and recorded Failed; nothing is published, and the held run
    // goes on.
    ExecutionPlanStore.isStarted(planUri) shouldBe true
    statusOf(unbuiltEid) shouldBe Utils.maptoStatusCode(WorkflowAggregatedState.FAILED).toInt
    service.executionService.getValue should be theSameInstanceAs held
    held.executionStateStore.metadataStore.getState.state shouldBe RUNNING
    service.started shouldBe empty
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

  "WorkflowService.fatalErrorsOf" should
    "report a workflow that does not compile as each operator's error, in the order it holds them" in {
    // Not in the order of the operators' ids: a compile lists them upstream first.
    def compileError(operator: String): (OperatorIdentity, WorkflowFatalError) =
      OperatorIdentity(operator) -> WorkflowFatalError(
        COMPILATION_ERROR,
        ProtoTimestamp(Instant.ofEpochSecond(1)),
        s"java.lang.RuntimeException: error of $operator",
        s"stack of $operator",
        operator
      )
    val operatorErrors = VectorMap(compileError("scan-b"), compileError("scan-a"))

    // The operator and worker given are those of a failure no worker raised.
    WorkflowService.fatalErrorsOf(
      new WorkflowCompilationFailed(operatorErrors),
      "unknown operator",
      ""
    ) shouldBe operatorErrors.values.toSeq
  }

  it should "report any other failure as one error, with its text and every cause's trace" in {
    val failure = new RuntimeException("outer", new IllegalStateException("inner"))

    val reported = WorkflowService.fatalErrorsOf(failure, "op-1", "worker-1")

    reported should have size 1
    reported.head.`type` shouldBe EXECUTION_FAILURE
    reported.head.message shouldBe "java.lang.RuntimeException: outer"
    reported.head.details shouldBe getStackTraceWithAllCauses(failure)
    reported.head.details should include("java.lang.IllegalStateException: inner")
    reported.head.operatorId shouldBe "op-1"
    reported.head.workerId shouldBe "worker-1"
  }
}
