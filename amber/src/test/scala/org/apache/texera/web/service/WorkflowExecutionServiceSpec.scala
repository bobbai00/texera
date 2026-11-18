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
import com.twitter.util.{Future, Promise}
import io.reactivex.rxjava3.disposables.Disposable
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.core.executor.{
  InputFile,
  OpExecWithClassName,
  OpExecWithCode,
  OperatorInputs
}
import org.apache.texera.amber.core.storage.{ExecutionPlanStore, PlanRecord}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  EmbeddedControlMessageIdentity,
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionMode,
  ExecutionPlan,
  GlobalPortIdentity,
  InputPort,
  OutputPort,
  PhysicalLink,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PortIdentity,
  PythonEnvironment,
  PythonEnvironmentRef,
  ReplaySource,
  RepositoryMounts,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.coordinator.{
  CoordinatorConfig,
  Workflow => EngineWorkflow
}
import org.apache.texera.amber.engine.architecture.pythonworker.environment.{
  FakePython,
  ProcessOutcome,
  PythonEnvironmentInstaller
}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.StartWorkflowResponse
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  PAUSED,
  READY,
  RUNNING,
  TERMINATED
}
import org.apache.texera.amber.engine.architecture.rpc.coordinatorservice.CoordinatorServiceFs2Grpc
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.{
  FaultToleranceConfig,
  StateRestoreConfig
}
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder.{
  Console,
  StateChange
}
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.PythonUdfUiParameterInjector
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.WORKFLOW_EXECUTIONS
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
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.model.websocket.request.{
  WorkflowCheckpointRequest,
  WorkflowKillRequest
}
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}

import java.lang.reflect.{InvocationHandler, Method, Proxy}
import java.net.URI
import java.nio.file.{Files, Path, Paths}
import java.sql.{Timestamp => SqlTimestamp}
import java.time.Instant
import java.util.concurrent.{CountDownLatch, ExecutorService, Executors, TimeUnit}
import java.util.{Comparator, UUID}
import scala.collection.concurrent.TrieMap
import scala.collection.mutable
import scala.collection.mutable.ListBuffer
import scala.reflect.ClassTag
import scala.util.Using

/**
  * Regression guard for the consolidated init-error reporting path (#5921):
  * `WorkflowExecutionService` registers its metadata-store diff handler at
  * construction, so a fatalErrors update -- e.g. the one `errorHandler` records
  * when `startStored` fails -- surfaces as a `WorkflowErrorEvent` through the
  * normal websocket-event observable.
  *
  * The unused `resultService` is passed as `null` on purpose: construction must
  * stay side-effect-free (all throwing work is in `startStored`), so a future
  * change that dereferences it during construction would fail here.
  *
  * The suite also owns two paths that need more scaffolding than that:
  *
  *   - `unsubscribeAll`, the session-teardown contract. This is what makes the
  *     suite carry a TestKit `ActorSystem` and `MockTexeraDB`: the method walks the
  *     four services of a run that is set up, and `ExecutionStatsService`'s constructor
  *     creates its iceberg runtime-statistics table and stamps the URI onto a
  *     `workflow_executions` row. There is no second home for the test -- one spec file
  *     per source class -- and stubbing the services out would leave the four teardown
  *     calls unobserved, which is the entire content of the method.
  *
  *   - `startStored`, the start of a run from the plan read back from its execution's plan
  *     table. Its runs are built as a computing unit builds one to start it by id (`StoredRun`),
  *     on a plan encoded and read back here, for a unit that mounts under `unitMountRoot`. Only
  *     the engine is stood in for, by the `createAmberRuntime` the service is given, which hands
  *     back a client on this suite's actor system that answers nothing unless a test answers it:
  *     every service is built around the plan, and nothing starts. They read nothing from the
  *     lake but the changes one case stores in the fixture execution's plan table, in the catalog
  *     the build's tests use (the Postgres JDBC catalog in CI). What a real engine does with the
  *     plan is exercised by the integration suites. The runs of plans that name Python
  *     environments install them on a `FakePython`, under a directory of this suite's: no
  *     interpreter and no pip runs. A run's record keeps what it is told and writes nothing, so
  *     the runs leave no statistics and no console in the lake.
  *
  * Two further gaps are deliberately described and NOT pinned, because a test that
  * froze the current behaviour would cement it:
  *
  *   - A recovery that ends in failure. `createStateEvent` carves out COMPLETED only,
  *     while the flag itself is lowered only by a `WorkflowRecoveryStatus(false)` from
  *     the engine, which an execution that dies mid-recovery need not ever send. Such an
  *     execution reaches FAILED with the flag still raised and is announced as
  *     "Recovering" from then on.
  *
  *   - `ExecutionReconfigurationService.registerWorkerCompletionCallback` discards the
  *     `Disposable` its `registerCallback` returns instead of handing it to
  *     `addSubscription`, so that one callback outlives the teardown below. Not this
  *     class's defect, and not this suite's to pin.
  */
class WorkflowExecutionServiceSpec
    extends TestKit(ActorSystem("WorkflowExecutionServiceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll
    with Eventually
    with MockTexeraDB {

  // For what the threads that install environments are about to do.
  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(10, Seconds), interval = Span(20, Millis))

  // Distinct from every other suite's ids (ExecutionStatsServiceSpec owns 9107/9108).
  private val testUid: Integer = 9207
  private val testWid: Integer = 9207
  private val testEid: Integer = 9208

  /**
    * The computing unit the fixture execution ran on. A different literal from `testWid` on
    * purpose: `getLatestExecutionID(wid, cuid)` binds two bare `Integer`s into one predicate, so a
    * fixture that reused one number for both would make a transposition of the two arguments
    * produce byte-identical SQL.
    */
  private val testCuid: Integer = 9209

  /** A computing unit with no executions, so the cuid leg of the predicate is not vacuous. */
  private val otherCuid: Integer = 9210

  /** A dataset version a plan's code reads, as the plan names it to be mounted. */
  private val datasetLocator = "dataset-9221:5ha7ed01"

  /** The directory the computing unit of the runs below mounts datasets and models under. */
  private val unitMountRoot = Paths.get("/mnt/texera-mounts")

  /** Where that unit mounts the dataset version. */
  private val datasetDirectory = "/mnt/texera-mounts/dataset-9221/5ha7ed01"

  /** A UDF source's code with a parameter DATA, whose value, as the injector writes it, is `data`. */
  private def udfReading(data: String): OpExecWithCode = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = data
    val code =
      """from pytexera import *
        |
        |class GenerateOperator(UDFSourceOperator):
        |    def produce(self):
        |        yield {"line": "a"}
        |""".stripMargin
    OpExecWithCode(PythonUdfUiParameterInjector.inject(code, List(parameter)), "python")
  }

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()

    // Set explicitly rather than left to the SERIAL default: the computing-unit and execution
    // rows below bind `testUid` into their `uid` foreign keys, so a generated value would leave
    // them pointing at a user that does not exist.
    val user = new User
    user.setUid(testUid)
    user.setName("workflow-execution-test-user")
    user.setEmail(s"u$testUid@example.com")
    new UserDao(getDSLContext.configuration()).insert(user)

    val workflow = new Workflow
    workflow.setWid(testWid)
    workflow.setName(s"workflow-execution-test-$testWid")
    workflow.setContent("{}")
    workflow.setDescription("")
    workflow.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new SqlTimestamp(System.currentTimeMillis()))
    new WorkflowDao(getDSLContext.configuration()).insert(workflow)

    val version = new WorkflowVersion
    version.setWid(testWid)
    version.setContent("{}")
    version.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
    new WorkflowVersionDao(getDSLContext.configuration()).insert(version)

    val computingUnitDao = new WorkflowComputingUnitDao(getDSLContext.configuration())
    List(testCuid -> "workflow-execution-test-unit", otherCuid -> "workflow-execution-idle-unit")
      .foreach {
        case (cuid, name) =>
          val unit = new WorkflowComputingUnit
          unit.setCuid(cuid)
          unit.setUid(testUid)
          unit.setName(name)
          unit.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
          unit.setType(WorkflowComputingUnitTypeEnum.local)
          unit.setUri("local://test")
          unit.setResource("{}")
          computingUnitDao.insert(unit)
      }

    // `ExecutionStatsService`'s constructor stamps the runtime-statistics URI onto this row,
    // reaching it from the workflow through workflow_version. `cuid` is set because
    // `getLatestExecutionID` matches on it and a NULL cuid matches no value at all.
    val execution = new WorkflowExecutions
    execution.setEid(testEid)
    execution.setVid(version.getVid)
    execution.setUid(testUid)
    execution.setCuid(testCuid)
    execution.setStatus(0.toByte)
    execution.setStartingTime(new SqlTimestamp(System.currentTimeMillis()))
    execution.setBookmarked(false)
    execution.setName("workflow-execution-test-execution")
    execution.setEnvironmentVersion("test-env")
    new WorkflowExecutionsDao(getDSLContext.configuration()).insert(execution)
  }

  override protected def afterAll(): Unit = {
    try {
      // The plan table one case below writes, in the catalog the build's tests share.
      ExecutionPlanStore.drop(storedPlanTable)
      installerThreads.shutdownNow()
      Using.resource(Files.walk(environmentsScratch)) { paths =>
        paths.sorted(Comparator.reverseOrder[Path]()).forEach(path => Files.deleteIfExists(path))
      }
      TestKit.shutdownActorSystem(system)
    } finally {
      closeConnectionPool()
      super.afterAll()
    }
  }

  /** The context of a run of the fixture execution. */
  private def runContext(): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(testWid.longValue()),
      executionId = ExecutionIdentity(testEid.longValue())
    )

  /** A run of the fixture execution that was never started, whose states `store` holds. */
  private def buildService(
      store: ExecutionStateStore,
      errorHandler: Throwable => Unit = (_: Throwable) => ()
  ): WorkflowExecutionService =
    new WorkflowExecutionService(runContext(), null, store, errorHandler, None)

  /** A state as the run of the fixture execution announces it, naming that execution. */
  private def stateEvent(state: String): WorkflowStateEvent =
    WorkflowStateEvent(state, Some(testEid.longValue()))

  /** Subscribe to the metadata store's websocket-event stream and collect events. */
  private def collectEvents(
      store: ExecutionStateStore
  ): mutable.ArrayBuffer[TexeraWebSocketEvent] = {
    val events = mutable.ArrayBuffer.empty[TexeraWebSocketEvent]
    store.metadataStore.getWebsocketEventObservable.subscribe {
      (evts: Iterable[TexeraWebSocketEvent]) => events ++= evts
    }
    events
  }

  /** A subscription whose only job is to report whether the manager holding it let it go. */
  private final class Tracker {
    var disposed = false
    val disposable: Disposable = Disposable.fromAction(() => disposed = true)
  }

  /**
    * The engine a stored run is given: the client the service specs share, whose coordinator
    * answers nothing unless a test answers it, so a run set up on it never starts.
    */
  private class UnansweredClient extends RecordingExecutionClient(system) {

    /** The answer to the last request of each name asked of the engine, for a test to give. */
    val answers: TrieMap[String, Promise[Any]] = TrieMap.empty

    /** The thread that last asked the engine each request. */
    val askedOn: TrieMap[String, Thread] = TrieMap.empty

    override val coordinatorInterface: CoordinatorServiceFs2Grpc[Future, Unit] =
      Proxy
        .newProxyInstance(
          classOf[CoordinatorServiceFs2Grpc[Future, Unit]].getClassLoader,
          Array(classOf[CoordinatorServiceFs2Grpc[Future, Unit]]),
          new InvocationHandler {
            override def invoke(proxy: Any, method: Method, args: Array[AnyRef]): AnyRef =
              method.getName match {
                case "hashCode" => Integer.valueOf(System.identityHashCode(proxy))
                case "equals"   => java.lang.Boolean.valueOf(proxy.asInstanceOf[AnyRef] eq args(0))
                case "toString" => "UnansweredCoordinatorInterface"
                case request =>
                  val answer = Promise[Any]()
                  askedOn(request) = Thread.currentThread()
                  answers(request) = answer
                  answer
              }
          }
        )
        .asInstanceOf[CoordinatorServiceFs2Grpc[Future, Unit]]
  }

  /** The replay log of the execution before the fixture's, replayed up to one interaction. */
  private val replaySource = ReplaySource(
    ExecutionIdentity(testEid.longValue() - 1),
    new URI(s"file:///var/texera/logs/$testWid/${testEid - 1}/"),
    "interaction-7"
  )

  /** Where the fixture execution writes its replay log. */
  private val replayLogLocation = new URI(s"file:///var/texera/logs/$testWid/$testEid/")

  private def sourceOp(name: String): PhysicalOp =
    PhysicalOp.sourcePhysicalOp(
      PhysicalOpIdentity(OperatorIdentity(name), "main"),
      WorkflowIdentity(testWid.longValue()),
      ExecutionIdentity(testEid.longValue()),
      OpExecWithClassName("unused")
    )

  /** A source whose one output port, of one string column, has its results stored. */
  private val storedSource: PhysicalOp =
    sourceOp("stored-text")
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

  /** The context the Dashboard saves a plan of `storedSource` alone under. */
  private def savedPlanContext(): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(testWid.longValue()),
      executionId = ExecutionIdentity(testEid.longValue()),
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 50,
        executionMode = ExecutionMode.PIPELINED,
        outputPortsNeedingStorage = Set(GlobalPortIdentity(storedSource.id, PortIdentity()))
      )
    )

  /** A plan of `storedSource` alone, as the Dashboard saves it. */
  private def storedSourcePlan(
      replay: Option[ReplaySource] = None,
      replayLog: Option[URI] = None
  ): ExecutionPlan =
    ExecutionPlan(savedPlanContext(), PhysicalPlan(Set(storedSource), Set.empty), replay, replayLog)

  "WorkflowExecutionService" should
    "surface a recorded fatal error as a WorkflowErrorEvent via the metadata-store handler" in {
    val store = new ExecutionStateStore()
    buildService(store) // registers the diff handler at construction
    val events = collectEvents(store)

    val err =
      WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), "boom during init", "", "", "")
    store.metadataStore.updateState(_.addFatalErrors(err))

    val errorEvents = events.collect { case e: WorkflowErrorEvent => e }
    errorEvents should have size 1
    errorEvents.head.fatalErrors should contain(err)
    // The other half of the handler's contract: an update that moves only `fatalErrors` must not
    // also announce a state. `StateStore` filters out updates that change nothing at all, so the
    // guard's whole job is this case -- a write that moves some other field while `state` and
    // `isRecovering` stand still. Without it, recording an error also republishes a redundant
    // WorkflowStateEvent to the session.
    events.collect { case e: WorkflowStateEvent => e } shouldBe empty
  }

  it should "report the error a run fails with through the same handler, and nothing that fails after it" in {
    val store = new ExecutionStateStore()
    // Mirror WorkflowService's real errorHandler, which ends the run FAILED with
    // the error. The service invokes this same handler at every phase (the
    // start, runtime creation, startWorkflow failure), so invoking it
    // repeatedly here stands in for failures arising at different phases.
    val recordError: Throwable => Unit = t =>
      store.transitionTo(
        FAILED,
        errors =
          Seq(WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), t.toString, "", "", ""))
      )
    buildService(store, recordError)
    val events = collectEvents(store)

    recordError(new RuntimeException("init phase"))
    // A run fails once: what fails in it after that is not another error of the run.
    recordError(new RuntimeException("runtime phase"))

    events.collect { case e: WorkflowErrorEvent => e.fatalErrors.map(_.message) } shouldBe
      Seq(Seq("java.lang.RuntimeException: init phase"))
    events.collect { case e: WorkflowStateEvent => e } shouldBe Seq(stateEvent("Failed"))
  }

  it should "emit a WorkflowStateEvent that names its execution when the execution state changes" in {
    val store = new ExecutionStateStore()
    buildService(store)
    val events = collectEvents(store)

    store.metadataStore.updateState(_.withState(RUNNING))

    // The state, and the execution the run is of: a session that did not start the run learns
    // from it which execution it watches.
    events.collect { case e: WorkflowStateEvent => e } shouldBe Seq(stateEvent("Running"))
    // The mirror of the assertion in the fatal-error test: a state-only update must not push an
    // empty WorkflowErrorEvent at the frontend. This is the suite's only update that leaves
    // `fatalErrors` alone, so it is the only place the errors guard can be observed suppressing.
    events.collect { case e: WorkflowErrorEvent => e } shouldBe empty
  }

  it should "tell a session that subscribes later the state as it stands, with its execution" in {
    // A browser that reconnects, or opens the workflow in another tab, while the run is paused:
    // subscribing hands it the state the run is in, and the execution to change operators of.
    val store = new ExecutionStateStore()
    buildService(store)
    store.metadataStore.updateState(_.withState(RUNNING))
    store.metadataStore.updateState(_.withState(PAUSED))

    collectEvents(store) shouldBe Seq(stateEvent("Paused"))
  }

  it should "report a recovering execution as Recovering instead of as its aggregated state" in {
    // Recovery is a banner the frontend keeps up over whatever the engine is otherwise doing:
    // the execution really is RUNNING throughout, and the three updates are kept apart so that the
    // recovery flag has to carry the second and third events on its own -- the aggregated state
    // does not move with it, and a handler that only watched `state` would go quiet exactly when
    // the banner needs to go up.
    //
    // The flag is driven in BOTH directions on purpose. Raising it is what a guard that merely
    // read `newState.isRecovering` would also do; only clearing it separates that from the
    // `!=` the guard actually needs, and a missing third event is the banner never coming down.
    val store = new ExecutionStateStore()
    buildService(store)
    val events = collectEvents(store)

    store.metadataStore.updateState(_.withState(RUNNING))
    store.metadataStore.updateState(_.withIsRecovering(true))
    store.metadataStore.updateState(_.withIsRecovering(false))

    events.collect { case e: WorkflowStateEvent => e } shouldBe
      Seq(stateEvent("Running"), stateEvent("Recovering"), stateEvent("Running"))
  }

  it should "report the aggregated state of a completed execution still marked as recovering" in {
    // The recovery flag is not cleared on the way to COMPLETED, so without the COMPLETED
    // carve-out a finished execution would be announced as still recovering and the frontend
    // would never take the banner down.
    //
    // COMPLETED is the only sentinel this pins, and deliberately so. `createStateEvent`'s
    // carve-out lists exactly that one terminal state, so an execution that dies mid-recovery
    // (FAILED / KILLED with the flag still raised) is still announced as "Recovering" -- see the
    // note in the class header. Adding FAILED to the expectation here would cement that; adding
    // it to the guard is a production question, not this suite's to answer.
    val store = new ExecutionStateStore()
    buildService(store)
    val events = collectEvents(store)

    store.metadataStore.updateState(_.withState(COMPLETED).withIsRecovering(true))

    events.collect { case e: WorkflowStateEvent => e } shouldBe Seq(stateEvent("Completed"))
  }

  it should "shut the client down and unsubscribe every runtime service on teardown" in {
    // The end of a websocket session. Everything the execution owns has to be let go here:
    // the engine client, and the four services that hold callbacks on it and diff handlers on
    // the shared state store. A survivor keeps publishing into a store nobody reads.
    //
    // What is asserted is the SET of teardown effects, not their order. `AmberClient.shutdown`
    // only flips a flag and posts a PoisonPill, so whether it runs before or after the four
    // unsubscribes changes only a race against the client actor's mailbox -- nothing a
    // deterministic test can observe, and not an order any contract here states.
    val executionPlan = readBack(storedSourcePlan())
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      val services = run.service.services.getOrElse(fail("the run was not set up"))
      val events = collectEvents(run.store)

      // One tracker per manager, so a teardown call that goes missing names its own service.
      val ownTracker = new Tracker
      val reconfigurationTracker = new Tracker
      val statsTracker = new Tracker
      val runtimeTracker = new Tracker
      val consoleTracker = new Tracker
      run.service.addSubscription(ownTracker.disposable)
      services.reconfiguration.addSubscription(reconfigurationTracker.disposable)
      services.stats.addSubscription(statsTracker.disposable)
      services.runtime.addSubscription(runtimeTracker.disposable)
      services.console.addSubscription(consoleTracker.disposable)

      run.service.unsubscribeAll()

      withClue("the engine client: ") { run.engine.get.shutdownCount shouldBe 1 }
      withClue("the execution's own subscriptions: ") { ownTracker.disposed shouldBe true }
      withClue("the runtime service: ") { runtimeTracker.disposed shouldBe true }
      withClue("the console service: ") { consoleTracker.disposed shouldBe true }
      withClue("the statistics service: ") { statsTracker.disposed shouldBe true }
      withClue("the reconfiguration service: ") { reconfigurationTracker.disposed shouldBe true }

      // The constructor-registered diff handler is part of "its own subscriptions": after
      // teardown the store is inert, which is what stops a closed session from still producing
      // websocket events for its (now disconnected) client.
      events.clear()
      run.store.metadataStore.updateState(_.withState(RUNNING))
      events shouldBe empty
    } finally run.close()
  }

  it should "leave a never-started execution alone on teardown" in {
    // `unsubscribeAll` also runs for a run that was never set up, which is made of nothing:
    // teardown of that run must not throw, and its own subscriptions must still be let go.
    val store = new ExecutionStateStore()
    val service = buildService(store)
    val events = collectEvents(store)
    val ownTracker = new Tracker
    service.addSubscription(ownTracker.disposable)

    noException should be thrownBy service.unsubscribeAll()

    ownTracker.disposed shouldBe true
    events.clear()
    store.metadataStore.updateState(_.withState(RUNNING))
    events shouldBe empty
  }

  /**
    * A run built as a computing unit builds one to start it by id: on the context its plan was
    * read back with, for this unit. Only the engine is an `UnansweredClient`, so nothing starts.
    *
    * @param installer installs the plan's Python environments; the unit's own when not given,
    *                  which a plan that names no environment asks nothing of
    * @param newEngine makes the engine the run is given
    */
  private final class StoredRun(
      executionPlan: ExecutionPlan,
      installer: Option[PythonEnvironmentInstaller] = None,
      mountRoot: Option[Path] = Some(unitMountRoot),
      newEngine: () => UnansweredClient = () => new UnansweredClient
  ) {
    val errors: ListBuffer[Throwable] = ListBuffer.empty
    var engineWorkflow: Option[EngineWorkflow] = None
    var coordinatorConfig: Option[CoordinatorConfig] = None
    // the engine the run was given; `client` would name the service's own field below
    var engine: Option[UnansweredClient] = None
    val resultService =
      new ExecutionResultService(
        WorkflowIdentity(testWid.longValue()),
        testCuid,
        new WorkflowStateStore()
      )
    val recorder = new RecordingExecutionRecorder
    val store = new ExecutionStateStore(recorder)
    store.metadataStore.updateState(_.withExecutionId(executionPlan.context.executionId))
    val service: WorkflowExecutionService = new WorkflowExecutionService(
      executionPlan.context,
      resultService,
      store,
      errors += _,
      mountRoot,
      installer.getOrElse(PythonEnvironmentInstaller.forThisUnit),
      createAmberRuntime = (context, plan, config, _) => {
        engineWorkflow = Some(EngineWorkflow(context, plan))
        coordinatorConfig = Some(config)
        val built = newEngine()
        engine = Some(built)
        built
      }
    )

    def close(): Unit = {
      service.unsubscribeAll()
      resultService.unsubscribeAll()
    }
  }

  /** `executionPlan`'s plan row, as the Dashboard writes it for `testUid` on `testCuid`. */
  private def planRowOf(
      executionPlan: ExecutionPlan,
      notification: Option[String] = None
  ): PlanRecord =
    PlanRecord(
      entryId = ExecutionPlanStore.PlanEntryId,
      body = PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(executionPlan)),
      createdBy = testUid,
      computingUnitId = testCuid,
      notification = notification
    )

  /** `executionPlan` read back from its plan row, as a unit reads it. */
  private def readBack(executionPlan: ExecutionPlan): ExecutionPlan =
    PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(planRowOf(executionPlan).body))

  /** The plan table of the fixture execution, in the default warehouse. */
  private val storedPlanTable =
    ExecutionPlanStore.planUri(
      WorkflowIdentity(testWid.longValue()),
      ExecutionIdentity(testEid.longValue()),
      None
    )

  "WorkflowExecutionService.startStored" should
    "build the engine and every service around the run on the plan it is handed, and make the run READY" in {
    val notification =
      Notification("u@example.com", "the workflow", "http://texera.example/user/workspace/9207")
    val executionPlan =
      readBack(storedSourcePlan(Some(replaySource), Some(replayLogLocation)))
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(
        executionPlan,
        planRowOf(executionPlan, Some(Notification.toJson(notification))),
        storedPlanTable
      ) shouldBe None
      run.errors shouldBe empty

      // The engine is handed the plan as it was handed to the run, under its context: the one it
      // was read back with. Read back, not compiled: no operator keeps a schema function a
      // compile gave it, which the saved text does not hold.
      val engineWorkflow = run.engineWorkflow.getOrElse(fail("the engine was handed no workflow"))
      engineWorkflow.physicalPlan shouldBe executionPlan.plan
      engineWorkflow.physicalPlan.operators.map(_.propagateSchema) shouldBe
        Set(PhysicalPlanCodec.ReadBackSchemaPropagation)
      engineWorkflow.context should be theSameInstanceAs executionPlan.context
      // Every service is built around that same plan, under that context.
      val services = run.service.services.getOrElse(fail("the run was not set up"))
      services.workflow.physicalPlan should be theSameInstanceAs engineWorkflow.physicalPlan
      services.workflow.context should be theSameInstanceAs engineWorkflow.context
      services.client should be theSameInstanceAs run.engine.get
      // The run replays what the plan replays, and writes its replay log where the plan says.
      run.coordinatorConfig shouldBe Some(
        WorkflowExecutionService.coordinatorConfigOf(executionPlan)
      )
      // Its status emails go where the plan row says.
      services.runtime.notification shouldBe Some(notification)
      // The run is READY, which its record is told, and the engine was asked to start.
      run.store.metadataStore.getState.state shouldBe READY
      run.recorder.states shouldBe Seq(("READY", None))
      run.engine.getOrElse(fail("no engine")).answers.keySet should contain("startWorkflow")
      // The run checkpoints into its replay log: a checkpoint request is taken.
      run.service.wsInput.onNext(WorkflowCheckpointRequest(), None)
      run.errors shouldBe empty
      run.engine.get.answers.keySet should contain("takeGlobalCheckpoint")
    } finally run.close()
  }

  it should "start a run whose plan replays nothing and writes no replay log with neither" in {
    val executionPlan = readBack(storedSourcePlan())
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      run.errors shouldBe empty
      val config = run.coordinatorConfig.getOrElse(fail("the engine was not built"))
      config.stateRestoreConfOpt shouldBe None
      config.faultToleranceConfOpt shouldBe None
      // Nor do its status emails go anywhere: its plan row names no one.
      run.service.services.get.runtime.notification shouldBe None
      // So it cannot checkpoint: a checkpoint request is refused.
      run.service.wsInput.onNext(WorkflowCheckpointRequest(), None)
      run.errors.map(_.getMessage) should have size 1
      run.errors.head.getMessage should include("Fault tolerance log folder is not established")
      run.engine.get.answers.keySet should not contain "takeGlobalCheckpoint"
    } finally run.close()
  }

  /** A plan of `storedSource` alone, a UDF whose code reads the dataset version. */
  private def datasetReadingPlan(): ExecutionPlan = {
    val reading = storedSource.copy(
      opExecInitInfo = udfReading(datasetLocator),
      repositoryMounts = Some(RepositoryMounts(Set(datasetLocator)))
    )
    readBack(ExecutionPlan(savedPlanContext(), PhysicalPlan(Set(reading), Set.empty)))
  }

  it should "run a plan's code with the directory this unit mounts each dataset at" in {
    val executionPlan = datasetReadingPlan()
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      run.errors shouldBe empty
      // The engine and the services around the run hold the one plan, which names the mount.
      val started = run.engineWorkflow.getOrElse(fail("the engine was not built")).physicalPlan
      started.getOperator(storedSource.id).opExecInitInfo shouldBe udfReading(datasetDirectory)
      started.getOperator(storedSource.id).repositoryMounts shouldBe
        Some(RepositoryMounts(Set(datasetLocator)))
      run.service.services.get.workflow.physicalPlan shouldBe started
    } finally run.close()
  }

  it should "refuse a plan that reads a dataset on a unit that mounts none, through the error handler, before it builds the engine" in {
    val executionPlan = datasetReadingPlan()
    val run = new StoredRun(executionPlan, mountRoot = None)
    try {
      val failure = run.service
        .startStored(executionPlan, planRowOf(executionPlan), storedPlanTable)
        .getOrElse(fail("the run started"))
      failure shouldBe an[IllegalStateException]
      failure.getMessage shouldBe s"Operator stored-text reads datasets or models " +
        s"($datasetLocator), which this computing unit cannot mount."
      run.errors shouldBe Seq(failure)
      run.engineWorkflow shouldBe None
      run.service.services shouldBe None
    } finally run.close()
  }

  it should "start a plan that reads files through links, handing the engine the plan as it is" in {
    // The links are the operator's own, among what the plan says it reads: the engine hands
    // them to the operator's executors, and the run does nothing else with them.
    def file(name: String): InputFile =
      InputFile(
        s"dataset:///dataset-12/9f3c/$name",
        s"http://texera-rustfs:9000/texera-dataset/$name?X-Amz-Signature=5ecr3t",
        Long.MaxValue
      )
    val reads = OperatorInputs(files = Seq(file("a.csv"), file("b.csv")))
    val executionPlan = readBack(
      ExecutionPlan(
        savedPlanContext(),
        PhysicalPlan(Set(storedSource.withInputs(reads)), Set.empty)
      )
    )
    executionPlan.plan.getOperator(storedSource.id).inputs shouldBe reads
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      run.errors shouldBe empty
      run.engineWorkflow.getOrElse(fail("the engine was handed no workflow")).physicalPlan shouldBe
        executionPlan.plan
      run.engine.getOrElse(fail("no engine")).answers.keySet should contain("startWorkflow")
    } finally run.close()
  }

  it should "refuse a plan row whose notification it cannot read, before it builds the engine" in {
    val executionPlan = readBack(storedSourcePlan())
    val run = new StoredRun(executionPlan)
    try {
      val failure = run.service
        .startStored(
          executionPlan,
          planRowOf(executionPlan, Some("""{"email":"someone@example.com"}""")),
          storedPlanTable
        )
        .getOrElse(fail("the run started"))
      failure shouldBe an[IllegalArgumentException]
      failure.getMessage shouldBe
        "The execution's notification is not {email, workflowName, workflowUrl}: " +
          "workflowName, workflowUrl missing or not a string."
      run.errors shouldBe Seq(failure)
      run.engineWorkflow shouldBe None
      run.service.services shouldBe None
    } finally run.close()
  }

  it should "shut the engine down and keep nothing of a run when a service around it cannot be built" in {
    val executionPlan = readBack(storedSourcePlan())
    // The console service, the last one built, registers for the operators' console messages.
    val engine = new UnansweredClient {
      override def registerCallback[T](callback: T => Unit)(implicit ct: ClassTag[T]): Disposable =
        if (ct.runtimeClass == classOf[ConsoleMessage]) {
          throw new IllegalStateException("the engine takes no console")
        } else super.registerCallback(callback)
    }
    val run = new StoredRun(executionPlan, newEngine = () => engine)
    try {
      val failure = run.service
        .startStored(executionPlan, planRowOf(executionPlan), storedPlanTable)
        .getOrElse(fail("the run was set up"))

      failure.getMessage shouldBe "the engine takes no console"
      run.errors shouldBe Seq(failure)
      // The engine built before that service is shut down, and the run is made of nothing.
      engine.shutdownCount shouldBe 1
      run.service.services shouldBe None
      run.store.metadataStore.getState.state should not be READY
      startWorkflowAsked(run) shouldBe false
      // So it can be let go of, as the start of the workflow's next run lets go of it.
      noException should be thrownBy run.service.unsubscribeAll()
      engine.shutdownCount shouldBe 1
    } finally run.close()
  }

  it should "keep the state a run ended in when its start is answered after that" in {
    def started(): StoredRun = {
      val executionPlan = readBack(storedSourcePlan())
      val run = new StoredRun(executionPlan)
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      run
    }
    def answerStart(run: StoredRun): Unit =
      run.engine
        .getOrElse(fail("no engine"))
        .answers("startWorkflow")
        .setValue(StartWorkflowResponse(RUNNING))
    // A run killed, superseded or ended otherwise before the engine answered its start.
    Seq(KILLED, COMPLETED, FAILED, TERMINATED).foreach { ended =>
      withClue(s"a run that is $ended: ") {
        val run = started()
        try {
          run.store.metadataStore.updateState(_.withState(ended))

          answerStart(run)

          run.store.metadataStore.getState.state shouldBe ended
          run.recorder.states shouldBe Seq(("READY", None))
        } finally run.close()
      }
    }
    // A run still starting takes the state the answer gives.
    val run = started()
    try {
      run.store.metadataStore.getState.state shouldBe READY
      answerStart(run)
      run.store.metadataStore.getState.state shouldBe RUNNING
      run.recorder.states shouldBe Seq(("READY", None), ("RUNNING", None))
    } finally run.close()
  }

  "WorkflowExecutionService.end" should
    "end a run in the state asked, with why, at the time it ends, and shut its engine down" in {
    val executionPlan = readBack(storedSourcePlan())
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None

      val before = System.currentTimeMillis()
      run.service.end(
        COMPLETED,
        reason = Some("stopped once its target operators finished")
      ) shouldBe
        true
      val after = System.currentTimeMillis()

      run.store.metadataStore.getState.state shouldBe COMPLETED
      run.store.statsStore.getState.endTimeStamp should (be >= before and be <= after)
      run.engine.get.shutdownCount shouldBe 1
      run.recorder.states shouldBe
        Seq(("READY", None), ("COMPLETED", Some("stopped once its target operators finished")))
      executionStatus() shouldBe Utils.maptoStatusCode(COMPLETED).toInt

      // A run ends once: asked again, it stays as it ended.
      val error =
        WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), "too late", "", "", "")
      run.service.end(FAILED, errors = Seq(error)) shouldBe false
      run.service.end(KILLED, reason = Some("stopped by its caller")) shouldBe false
      run.store.metadataStore.getState.state shouldBe COMPLETED
      run.store.metadataStore.getState.fatalErrors shouldBe empty
      run.recorder.changes should have size 2
      executionStatus() shouldBe Utils.maptoStatusCode(COMPLETED).toInt
    } finally run.close()
  }

  it should "end a run that was never set up, which has no engine to shut down" in {
    val recorder = new RecordingExecutionRecorder
    val store = new ExecutionStateStore(recorder)
    val service = buildService(store)
    val error =
      WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), "the node left", "", "", "")

    service.end(FAILED, errors = Seq(error)) shouldBe true

    store.metadataStore.getState.state shouldBe FAILED
    store.metadataStore.getState.fatalErrors shouldBe Seq(error)
    store.statsStore.getState.endTimeStamp should be > 0L
    recorder.changes shouldBe Seq(StateChange("FAILED", Seq(error), None))
  }

  it should "give a change the Dashboard stored the directory this unit mounts its dataset at, as it gives the plan" in {
    val executionPlan = readBack(storedSourcePlan())
    val record = planRowOf(executionPlan)
    // The plan table, holding the plan row and the change, in the catalog the build's tests use.
    ExecutionPlanStore.writePlan(storedPlanTable, record, "{}")
    val updateId = s"update-${UUID.randomUUID()}"
    val changed = storedSource.copy(
      opExecInitInfo = udfReading(datasetLocator),
      repositoryMounts = Some(RepositoryMounts(Set(datasetLocator)))
    )
    ExecutionPlanStore.appendUpdate(
      storedPlanTable,
      PlanRecord(
        entryId = updateId,
        body = PhysicalPlanCodec.updateToJson(
          PhysicalPlanCodec.encodeUpdate(ExecutionIdentity(testEid.longValue()), updateId, changed)
        ),
        createdBy = testUid,
        computingUnitId = testCuid,
        notification = None
      ),
      "{}"
    )
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, record, storedPlanTable) shouldBe None

      run.service.services.get.reconfiguration
        .applyStoredUpdate(updateId, Some(testUid.intValue()))
        .isValid shouldBe true
      run.store.reconfigurationStore.getState.unscheduledReconfigurations
        .map(_.opExecInitInfo) shouldBe List(udfReading(datasetDirectory))
    } finally run.close()
  }

  // ----- the plan's Python environments -----

  private val environmentsScratch: Path =
    Files.createTempDirectory("workflow-execution-service-spec")
  private val installerThreads: ExecutorService = Executors.newCachedThreadPool()

  private val ml = PythonEnvironment("ml", Seq("tabulate==0.9.0"))

  /** A unit's installer on `python`, under a root of its own, on threads that are not a test's. */
  private def installerOn(python: FakePython): PythonEnvironmentInstaller =
    python.installer(Files.createTempDirectory(environmentsScratch, "root"), installerThreads)

  /**
    * A plan of the fixture execution in which `<name>-first` feeds `<name>-second`, both running
    * in `environment`. The names are a case's own: an execution's operators each have one console.
    */
  private def environmentPlan(
      name: String,
      environment: PythonEnvironmentRef = PythonEnvironmentRef.Resolved(ml)
  ): ExecutionPlan = {
    val (workflowId, executionId) =
      (WorkflowIdentity(testWid.longValue()), ExecutionIdentity(testEid.longValue()))
    val lines = Schema().add("line", AttributeType.STRING)
    val firstId = PhysicalOpIdentity(OperatorIdentity(s"$name-first"), "main")
    val secondId = PhysicalOpIdentity(OperatorIdentity(s"$name-second"), "main")
    val link = PhysicalLink(firstId, PortIdentity(), secondId, PortIdentity())
    val first = PhysicalOp
      .sourcePhysicalOp(firstId, workflowId, executionId, OpExecWithClassName("unused"))
      .copy(
        outputPorts = Map(PortIdentity() -> (OutputPort(), List(link), Right(lines))),
        pythonEnvironment = environment
      )
      .withStorageLocations(None)
    val second = PhysicalOp
      .oneToOnePhysicalOp(secondId, workflowId, executionId, OpExecWithClassName("unused"))
      .copy(
        inputPorts = Map(PortIdentity() -> (InputPort(), List(link), Right(lines))),
        outputPorts = Map(PortIdentity() -> (OutputPort(), List.empty, Right(lines))),
        pythonEnvironment = environment
      )
      .withStorageLocations(None)
    ExecutionPlan(
      new WorkflowContext(
        workflowId,
        executionId,
        WorkflowSettings(
          dataTransferBatchSize = 50,
          executionMode = ExecutionMode.PIPELINED,
          outputPortsNeedingStorage = Set(GlobalPortIdentity(secondId, PortIdentity()))
        )
      ),
      PhysicalPlan(Set(first, second), Set(link))
    )
  }

  /** What the run's console of `operator` was told, in order. */
  private def consoleOf(run: StoredRun, operator: String): Seq[ConsoleMessage] =
    run.store.consoleStore.getState.operatorConsole.get(operator).toSeq.flatMap(_.consoleMessages)

  private def titlesOn(run: StoredRun, operator: String): Seq[String] =
    consoleOf(run, operator).map(_.title)

  private def startWorkflowAsked(run: StoredRun): Boolean =
    run.engine.getOrElse(fail("no engine")).answers.contains("startWorkflow")

  /** The status the fixture execution's row holds. */
  private def executionStatus(): Int =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.STATUS)
      .from(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.eq(testEid))
      .fetchOne(WORKFLOW_EXECUTIONS.STATUS)
      .intValue()

  it should "install its plan's Python environment before its engine starts, off the thread that asks" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val executionPlan = readBack(environmentPlan("installs"))
    val run = new StoredRun(executionPlan, Some(installerOn(python)))
    try {
      // The start returns while pip is still at work, on a thread of the installer's: the run is
      // set up and READY, its engine built and not started.
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      held.awaitBegun() shouldBe true
      run.store.metadataStore.getState.state shouldBe READY
      startWorkflowAsked(run) shouldBe false
      python.runs.map(_.thread) should not contain Thread.currentThread()
      eventually(
        titlesOn(run, "installs-first") shouldBe
          Seq("Installing Python environment 'ml' (1 package)")
      )

      held.letGo()

      // Once the environment is ready the engine is asked to start, on that thread too.
      eventually(startWorkflowAsked(run) shouldBe true)
      run.engine.get.askedOn("startWorkflow") should not be Thread.currentThread()
      Seq("installs-first", "installs-second").foreach { operator =>
        val told = consoleOf(run, operator)
        told.map(_.title).head shouldBe "Installing Python environment 'ml' (1 package)"
        told should have size 2
        told(1).title should startWith("Python environment 'ml' is ready (")
        told(1).message should include("tabulate==0.9.0")
        told(1).message should include("Successfully installed tabulate==0.9.0")
      }
      run.errors shouldBe empty
      run.store.metadataStore.getState.fatalErrors shouldBe empty
      run.store.metadataStore.getState.state shouldBe READY
    } finally run.close()
  }

  it should "start a run whose environment is installed already, telling its operators so" in {
    val python = new FakePython()
    val installer = installerOn(python)
    installer.ensure(ml, _ => ()).get(30, TimeUnit.SECONDS)
    val executionPlan = readBack(environmentPlan("reuses"))
    val run = new StoredRun(executionPlan, Some(installer))
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None

      eventually(startWorkflowAsked(run) shouldBe true)
      Seq("reuses-first", "reuses-second").foreach { operator =>
        titlesOn(run, operator) shouldBe Seq("Python environment 'ml' reused")
      }
      python.pipInstalls should have size 1
      run.errors shouldBe empty
    } finally run.close()
  }

  it should "fail a run whose environment cannot be installed, before its engine starts, with pip's words" in {
    val python = new FakePython()
    val pipSaid = Seq(
      "Collecting tabulate==0.9.0",
      "ERROR: Could not find a version that satisfies the requirement tabulate==0.9.0 (from " +
        "versions: none)",
      "ERROR: No matching distribution found for tabulate==0.9.0"
    )
    python.pipInstall = _ => ProcessOutcome(Some(1), pipSaid)
    val executionPlan = readBack(environmentPlan("fails"))
    val run = new StoredRun(executionPlan, Some(installerOn(python)))
    try {
      val before = System.currentTimeMillis()
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      val installing = Seq("Installing Python environment 'ml' (1 package)")
      eventually(run.store.metadataStore.getState.state shouldBe FAILED)
      val after = System.currentTimeMillis()

      // The run ends FAILED, when the install did, and its row says so. Its one error is pip's,
      // of the first operator that runs in the environment.
      val state = run.store.metadataStore.getState
      state.state shouldBe FAILED
      run.store.statsStore.getState.endTimeStamp should (be >= before and be <= after)
      executionStatus() shouldBe Utils.maptoStatusCode(FAILED).toInt
      state.fatalErrors should have size 1
      val error = state.fatalErrors.head
      error.`type` shouldBe EXECUTION_FAILURE
      error.message shouldBe
        "Python environment 'ml' could not be installed: Could not find a version that " +
          "satisfies the requirement tabulate==0.9.0 (from versions: none) No matching " +
          "distribution found for tabulate==0.9.0"
      error.details shouldBe pipSaid.mkString("\n")
      error.operatorId shouldBe "fails-first"
      error.workerId shouldBe ""
      // Its engine, built, was shut down without being asked to start. The workflow's own
      // failure is no failure of the unit's: the error handler is not asked.
      startWorkflowAsked(run) shouldBe false
      run.engine.get.shutdownCount shouldBe 1
      run.errors shouldBe empty
      // Its record is told of this end as of any other, with the error.
      run.recorder.changes shouldBe
        Seq(StateChange("READY", Nil, None), StateChange("FAILED", Seq(error), None))
      // The failure is reported once, as the run's error: no console repeats it.
      Seq("fails-first", "fails-second").foreach { operator =>
        consoleOf(run, operator).map(message => (message.msgType, message.title)) shouldBe
          installing.map((ConsoleMessageType.PRINT, _))
      }
      // The record was told what the consoles were told of the install before it was told of
      // the run's end, so it stores them with that end, although no engine reports it.
      val toldInOrder = run.recorder.told
      toldInOrder.last shouldBe StateChange("FAILED", Seq(error), None)
      toldInOrder.init.collect {
        case Console(operator, message) => (operator, message.title)
      } should contain theSameElementsAs
        Seq("fails-first", "fails-second").map((_, installing.head))
    } finally run.close()
  }

  it should "leave a run that is killed while its environment installs as it ended, and let the install go on" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val installer = installerOn(python)
    val executionPlan = readBack(environmentPlan("killed"))
    val run = new StoredRun(executionPlan, Some(installer))
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      held.awaitBegun() shouldBe true
      eventually(titlesOn(run, "killed-first") should have size 1)

      // Stop, while pip is at work.
      run.service.wsInput.onNext(WorkflowKillRequest(executionPlan.context.executionId.id), None)
      run.store.metadataStore.getState.state shouldBe KILLED
      run.recorder.states shouldBe Seq(("READY", None), ("KILLED", Some("killed by the user")))
      held.letGo()

      // The install is the unit's, and goes on to its end.
      eventually(installer.interpreterFor(Some(ml)) should not be empty)
      // The run stays as it was killed: its engine is never asked to start, nothing of the
      // install is its failure, and its consoles are told nothing more.
      Thread.sleep(300)
      run.store.metadataStore.getState.state shouldBe KILLED
      run.store.metadataStore.getState.fatalErrors shouldBe empty
      run.recorder.changes should have size 2
      startWorkflowAsked(run) shouldBe false
      run.errors shouldBe empty
      titlesOn(run, "killed-first") shouldBe Seq("Installing Python environment 'ml' (1 package)")
    } finally run.close()

    // The next run of the plan finds the environment installed, and starts.
    val nextPlan = readBack(environmentPlan("after-kill"))
    val next = new StoredRun(nextPlan, Some(installer))
    try {
      next.service.startStored(nextPlan, planRowOf(nextPlan), storedPlanTable) shouldBe None
      eventually(startWorkflowAsked(next) shouldBe true)
      titlesOn(next, "after-kill-first") shouldBe Seq("Python environment 'ml' reused")
      python.pipInstalls should have size 1
    } finally next.close()
  }

  it should "leave a run whose environment fails to install after it was killed as it was killed" in {
    val python = new FakePython()
    val begun = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    python.pipInstall = _ => {
      begun.countDown()
      release.await(30, TimeUnit.SECONDS)
      ProcessOutcome(Some(1), Seq("ERROR: No matching distribution found for tabulate==0.9.0"))
    }
    val installer = installerOn(python)
    val executionPlan = readBack(environmentPlan("killed-then-failed"))
    val run = new StoredRun(executionPlan, Some(installer))
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      begun.await(30, TimeUnit.SECONDS) shouldBe true
      eventually(titlesOn(run, "killed-then-failed-first") should have size 1)
      run.service.wsInput.onNext(WorkflowKillRequest(executionPlan.context.executionId.id), None)
      release.countDown()

      // The install fails once the run no longer waits for it: nothing of it reaches the run.
      Thread.sleep(300)
      run.store.metadataStore.getState.state shouldBe KILLED
      run.store.metadataStore.getState.fatalErrors shouldBe empty
      run.recorder.states shouldBe Seq(("READY", None), ("KILLED", Some("killed by the user")))
      titlesOn(run, "killed-then-failed-first") should have size 1
      run.errors shouldBe empty
    } finally run.close()
  }

  it should "start nothing for a run that is let go of while its environment installs" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val installer = installerOn(python)
    val executionPlan = readBack(environmentPlan("superseded"))
    val run = new StoredRun(executionPlan, Some(installer))
    try {
      run.service.startStored(executionPlan, planRowOf(executionPlan), storedPlanTable) shouldBe
        None
      held.awaitBegun() shouldBe true

      // As the start of the workflow's next run lets go of it.
      run.service.unsubscribeAll()
      held.letGo()

      eventually(installer.interpreterFor(Some(ml)) should not be empty)
      Thread.sleep(300)
      startWorkflowAsked(run) shouldBe false
      run.errors shouldBe empty
      run.store.metadataStore.getState.fatalErrors shouldBe empty
    } finally run.close()
  }

  "WorkflowExecutionService.coordinatorConfigOf" should
    "start the coordinator replaying the plan's replay log, and writing its own where the plan says" in {
    val config = WorkflowExecutionService.coordinatorConfigOf(
      ExecutionPlan(
        savedPlanContext(),
        PhysicalPlan(Set(storedSource), Set.empty),
        Some(replaySource),
        Some(replayLogLocation)
      )
    )

    config.stateRestoreConfOpt shouldBe Some(
      StateRestoreConfig(
        readFrom = replaySource.logLocation,
        replayDestination = EmbeddedControlMessageIdentity(replaySource.interaction)
      )
    )
    config.faultToleranceConfOpt shouldBe Some(FaultToleranceConfig(writeTo = replayLogLocation))
    // The rest is this unit's own.
    config.copy(stateRestoreConfOpt = None, faultToleranceConfOpt = None) shouldBe
      CoordinatorConfig.default
  }

  it should "start the coordinator of a plan that replays nothing and writes no replay log as this unit's" in {
    val config = WorkflowExecutionService.coordinatorConfigOf(
      ExecutionPlan(savedPlanContext(), PhysicalPlan(Set(storedSource), Set.empty))
    )

    config shouldBe CoordinatorConfig.default
    // Its workers read links from the endpoints this unit is set up with, and from no other.
    config.inputLinkEndpoints shouldBe StorageConfig.inputLinksAllowedEndpoints
  }

  "WorkflowExecutionService.mountedUnder" should
    "give each operator's code the directory this unit mounts what it reads at, and leave the rest of the plan as it is" in {
    val readsNothing = sourceOp("reads-nothing")
    val readsADataset = sourceOp("reads-a-dataset").copy(
      opExecInitInfo = udfReading(datasetLocator),
      repositoryMounts = Some(RepositoryMounts(Set(datasetLocator)))
    )
    val plan = PhysicalPlan(Set(readsNothing, readsADataset), Set.empty)

    WorkflowExecutionService.mountedUnder(plan, Some(unitMountRoot)) shouldBe
      PhysicalPlan(
        Set(readsNothing, readsADataset.copy(opExecInitInfo = udfReading(datasetDirectory))),
        Set.empty
      )
  }

  it should "return a plan that mounts nothing as it is, on a unit that mounts nothing" in {
    val plan = PhysicalPlan(Set(sourceOp("reads-nothing")), Set.empty)

    WorkflowExecutionService.mountedUnder(plan, None) shouldBe plan
  }

  it should "refuse a plan that reads a dataset on a unit that mounts nothing" in {
    val plan = PhysicalPlan(
      Set(
        sourceOp("reads-a-dataset").copy(
          opExecInitInfo = udfReading(datasetLocator),
          repositoryMounts = Some(RepositoryMounts(Set(datasetLocator)))
        )
      ),
      Set.empty
    )

    val failure = the[IllegalStateException] thrownBy
      WorkflowExecutionService.mountedUnder(plan, None)

    failure.getMessage shouldBe s"Operator reads-a-dataset reads datasets or models " +
      s"($datasetLocator), which this computing unit cannot mount."
  }

  // The companion's one expression, exercised directly rather than only through the two result
  // services that call it. Transposing its two arguments -- both bare `Integer`s bound into one
  // predicate -- does reach those siblings, and hard (30 of their tests fail on it), so this is not
  // a hole in the module's coverage. It is the class that owns the method stating its own contract,
  // and failing first and by name when that contract breaks.
  "WorkflowExecutionService.getLatestExecutionId" should
    "resolve the newest execution of a workflow on a given computing unit" in {
    WorkflowExecutionService.getLatestExecutionId(
      WorkflowIdentity(testWid.longValue()),
      testCuid.intValue()
    ) shouldBe Some(ExecutionIdentity(testEid.longValue()))
  }

  it should "find no execution for a computing unit the workflow has not run on" in {
    // Same workflow row as the case above, so only the cuid leg can produce this None -- which is
    // what keeps that leg from being vacuous. The transposition of the two arguments dies in the
    // case above, where the swapped pair selects no row at all.
    WorkflowExecutionService.getLatestExecutionId(
      WorkflowIdentity(testWid.longValue()),
      otherCuid.intValue()
    ) shouldBe None
  }
}
