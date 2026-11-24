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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ActorVirtualIdentity,
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  InputPort,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PythonEnvironmentRef,
  RepositoryMounts,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.coordinator.{UpdateExecutorCompleted, Workflow}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  UpdateExecutorRequest,
  WorkflowReconfigureRequest
}
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.PythonUdfUiParameterInjector
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.response.ModifyLogicCompletedEvent
import org.apache.texera.web.storage.{
  ExecutionReconfigurationStore,
  ExecutionStateStore,
  StateStore
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers

import java.nio.file.{Path, Paths}
import scala.collection.mutable
import scala.concurrent.duration.DurationInt

/**
  * Web-service-layer tests for ExecutionReconfigurationService.
  *
  * The end-to-end engine path (reconfigureWorkflow → Fries algorithm →
  * UpdateExecutor on workers) is covered by ReconfigurationSpec. This spec covers the
  * service's own wiring:
  *
  *   - `applyUpdate`, queueing a change the Dashboard made to run, as the Dashboard hands it over,
  *   - `performReconfigurationOnResume`, i.e. empty short-circuit, request construction
  *     and store reset semantics,
  *   - the two constructor-time subscriptions: the engine's UpdateExecutorCompleted
  *     callback, and the reconfiguration-store diff handler that announces newly
  *     reconfigured operators to the frontend.
  *
  * The tests that need a real `AmberClient` share a single one (see `sharedClient`): its
  * constructor spawns a ClientActor, which spawns a real engine Coordinator whose `initState`
  * runs a schedule search, probes `SqlServer` and iterates the JVM-global `SessionState` map.
  * One such engine per suite, torn down and awaited in `afterAll`, keeps that work from leaking
  * into whichever sibling suite this shared JVM runs next.
  */
class ExecutionReconfigurationServiceSpec
    extends TestKit(ActorSystem("ExecutionReconfigurationServiceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll {

  private var sharedClient: RecordingExecutionClient = _

  override def beforeAll(): Unit = {
    super.beforeAll()
    sharedClient = new RecordingExecutionClient(system)
  }

  override def afterAll(): Unit = {
    try {
      // Shutting the client down stops the ClientActor and, with it, the Coordinator it spawned;
      // awaiting full system termination is what actually keeps that Coordinator's schedule
      // search / DB probe / SessionState iteration from running as a straggler in a later suite.
      if (sharedClient != null) {
        sharedClient.dispose()
      }
      TestKit.shutdownActorSystem(system, 60.seconds, verifySystemShutdown = true)
    } finally super.afterAll()
  }

  // Deliberately different from WorkflowContext's defaults (1L / 1L) and from each other, so an
  // op built from the wrong identity is a visibly different op.
  private val testWorkflowId: WorkflowIdentity = WorkflowIdentity(9231L)
  private val testExecutionId: ExecutionIdentity = ExecutionIdentity(9232L)

  /** The user who started the execution the services here run. */
  private val starterUid = 9233
  // A format this unit does not read yet: the one after its own.
  private val nextFormat = PhysicalPlanCodec.FormatVersion + 1

  private def mkPhysicalOp(name: String): PhysicalOp =
    PhysicalOp(
      id = PhysicalOpIdentity(OperatorIdentity(name), "main"),
      workflowId = WorkflowIdentity(0L),
      executionId = ExecutionIdentity(0L),
      opExecInitInfo = OpExecWithClassName(s"$name.Class", "")
    )

  /** A worker of `opName`; the name shape is what VirtualIdentityUtils parses back into a
    * PhysicalOpIdentity, which is how the diff handler maps a worker to its logical operator.
    */
  private def mkWorker(opName: String, workerIndex: Int): ActorVirtualIdentity =
    ActorVirtualIdentity(s"Worker:WF1-$opName-main-$workerIndex")

  private def mkWorkflow(physicalOps: Set[PhysicalOp] = Set()): Workflow =
    Workflow(
      new WorkflowContext(workflowId = testWorkflowId, executionId = testExecutionId),
      PhysicalPlan(physicalOps, Set.empty)
    )

  /** Service variant that records dispatched requests and skips the AmberClient
    * registration / workflow-dependent diff handler so it can be constructed
    * without a live engine.
    */
  private class RecordingService(stateStore: ExecutionStateStore)
      extends ExecutionReconfigurationService(
        client = null,
        stateStore,
        workflow = null,
        starterUid,
        mountRoot = None
      ) {
    val captured: mutable.ArrayBuffer[WorkflowReconfigureRequest] = mutable.ArrayBuffer.empty
    val mounted: mutable.ArrayBuffer[Set[String]] = mutable.ArrayBuffer.empty
    override protected def dispatch(request: WorkflowReconfigureRequest): Unit =
      captured += request
    override protected def ensureMounted(locators: Set[String]): Unit = mounted += locators
    override protected def registerWorkerCompletionCallback(): Unit = ()
    override protected def registerCompletionDiffHandler(): Unit = ()
  }

  private final class LiveFixture(
      val client: RecordingExecutionClient,
      val stateStore: ExecutionStateStore,
      val service: ExecutionReconfigurationService
  )

  /** Builds a service with every seam left in place, so the constructor really registers the
    * engine callback and the diff handler and `dispatch` really goes through the client.
    */
  private def withLiveService(
      physicalOps: Set[PhysicalOp] = Set()
  )(body: LiveFixture => Unit): Unit = {
    sharedClient.reset()
    val stateStore = new ExecutionStateStore
    val service = new ExecutionReconfigurationService(
      sharedClient,
      stateStore,
      mkWorkflow(physicalOps),
      starterUid,
      mountRoot = None
    )
    try body(new LiveFixture(sharedClient, stateStore, service))
    finally service.unsubscribeAll()
  }

  /**
    * The store's diff subject is cold: handlers only run once something subscribes to the
    * websocket observable, and an update whose result equals the previous state is dropped
    * before the handlers see it. So a test that cares what a state change publishes has to
    * subscribe first and count batches, not just look for events.
    *
    * Subscribing is itself observable: StateStore prepends the default state and buffers pairs,
    * so a subscriber that attaches to an already-advanced store is handed a
    * (default, current) catch-up pair before anything else -- exactly what a browser
    * reconnecting to a running execution produces.
    */
  private def recordBatches(
      store: StateStore[ExecutionReconfigurationStore]
  )(body: => Unit): Seq[Iterable[TexeraWebSocketEvent]] = {
    val batches = mutable.ListBuffer.empty[Iterable[TexeraWebSocketEvent]]
    val subscription = store.getWebsocketEventObservable
      .subscribe((batch: Iterable[TexeraWebSocketEvent]) => batches += batch)
    try body
    finally subscription.dispose()
    batches.toSeq
  }

  private def announcedOps(batch: Iterable[TexeraWebSocketEvent]): List[String] =
    batch.collect { case e: ModifyLogicCompletedEvent => e.opIds }.flatten.toList

  // ---------------------------------------------------------------------------
  // A change the Dashboard made to run, as the client hands it on
  // ---------------------------------------------------------------------------

  /** The running operator a change is made to: a Limit, as the plan read back holds it. */
  private val runningLimit: PhysicalOp =
    PhysicalOp(
      id = PhysicalOpIdentity(OperatorIdentity("limit-a"), "main"),
      workflowId = testWorkflowId,
      executionId = testExecutionId,
      opExecInitInfo = OpExecWithClassName("limit.Class", """{"limit":1}""")
    ).withInputPorts(List(InputPort()))
      .withOutputPorts(List(OutputPort()))
      .withStorageLocations(None)

  private val changedExecutor = OpExecWithClassName("limit.Class", """{"limit":7}""")

  /** The change the Dashboard makes of `runningLimit`: a new executor. */
  private val changedLimit: PhysicalOp = runningLimit.copy(opExecInitInfo = changedExecutor)

  private val udfCode =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    def process_tuple(self, tuple_, port):
      |        yield tuple_
      |""".stripMargin

  /** A running UDF that reads no dataset, as the plan read back holds it. */
  private val runningUdf: PhysicalOp =
    PhysicalOp(
      id = PhysicalOpIdentity(OperatorIdentity("udf-a"), "main"),
      workflowId = testWorkflowId,
      executionId = testExecutionId,
      opExecInitInfo = OpExecWithCode(udfCode, "python")
    ).withInputPorts(List(InputPort()))
      .withOutputPorts(List(OutputPort()))
      .withStorageLocations(None)

  private val datasetLocator = "dataset-1:abc123"
  private val unitMountRoot = Paths.get("/mnt/texera-mounts")

  /** The UDF's code with a parameter DATA, whose value, as the injector writes it, is `data`. */
  private def udfReading(data: String): OpExecWithCode = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = data
    OpExecWithCode(PythonUdfUiParameterInjector.inject(udfCode, List(parameter)), "python")
  }

  /** The change the Dashboard makes of `runningUdf`: code that reads a dataset it pinned. */
  private val changedUdf: PhysicalOp =
    runningUdf.copy(
      opExecInitInfo = udfReading(datasetLocator),
      repositoryMounts = Some(RepositoryMounts(Set(datasetLocator)))
    )

  /**
    * A change of `op` as the Dashboard makes it, for execution `ofExecution`, with what a case
    * changes of its text.
    */
  private def changeOf(
      op: PhysicalOp,
      ofExecution: ExecutionIdentity = testExecutionId,
      edit: String => String = identity
  ): String =
    edit(
      PhysicalPlanCodec.updateToJson(
        PhysicalPlanCodec.encodeUpdate(ofExecution, op.copy(executionId = ofExecution))
      )
    )

  /**
    * A service over a running plan of `physicalOps`, on a unit that mounts datasets and models
    * under `mountRoot`: as a computing unit builds one for a run. It records what resuming would
    * dispatch and mount, and needs no engine.
    */
  private class ChangeService(
      stateStore: ExecutionStateStore,
      physicalOps: Set[PhysicalOp] = Set(runningLimit, runningUdf),
      mountRoot: Option[Path] = Some(unitMountRoot)
  ) extends ExecutionReconfigurationService(
        client = null,
        stateStore,
        mkWorkflow(physicalOps),
        starterUid,
        mountRoot
      ) {
    val captured: mutable.ArrayBuffer[WorkflowReconfigureRequest] = mutable.ArrayBuffer.empty
    val mounted: mutable.ArrayBuffer[Set[String]] = mutable.ArrayBuffer.empty
    override protected def dispatch(request: WorkflowReconfigureRequest): Unit =
      captured += request
    override protected def ensureMounted(locators: Set[String]): Unit = mounted += locators
    override protected def registerWorkerCompletionCallback(): Unit = ()
    override protected def registerCompletionDiffHandler(): Unit = ()
  }

  /** A change asked for by the user who started the execution. */
  private val asStarter: Option[Int] = Some(starterUid)

  "applyUpdate" should
    "queue a change the Dashboard made, which resuming dispatches with its executor and mounts" in {
    val stateStore = new ExecutionStateStore
    val service = new ChangeService(stateStore)

    service.applyUpdate(changeOf(changedUdf), asStarter) shouldBe
      Right("udf-a")
    service.applyUpdate(changeOf(changedLimit), asStarter) shouldBe
      Right("limit-a")

    // The running operator, with the change's executor and what its code reads, in the order the
    // changes came: a user can change several operators during one pause, so the queue has to
    // accumulate. The rest of the operator stays as the running plan has it, where its output
    // port is stored included, which a change does not carry, and the code holds the directory
    // this unit mounts the dataset at where the change names the dataset.
    val readingMounted = udfReading(unitMountRoot.resolve("dataset-1").resolve("abc123").toString)
    val queued = stateStore.reconfigurationStore.getState.unscheduledReconfigurations
    queued shouldBe List(changedUdf.copy(opExecInitInfo = readingMounted), changedLimit)
    queued.head.copy(
      opExecInitInfo = runningUdf.opExecInitInfo,
      repositoryMounts = None
    ) shouldBe runningUdf
    runningUdf.storageLocations should have size 1
    queued.map(_.storageLocations) shouldBe
      List(runningUdf.storageLocations, runningLimit.storageLocations)

    service.performReconfigurationOnResume()

    service.mounted shouldBe Seq(Set(datasetLocator))
    service.captured should have size 1
    service.captured.head.reconfiguration shouldBe Seq(
      UpdateExecutorRequest(runningUdf.id, readingMounted),
      UpdateExecutorRequest(runningLimit.id, changedExecutor)
    )
  }

  it should "refuse a change it cannot apply, queueing nothing and keeping what was queued" in {
    val stateStore = new ExecutionStateStore
    val service = new ChangeService(stateStore)
    val alreadyQueued = mkPhysicalOp("already-queued")
    stateStore.reconfigurationStore.updateState(_ =>
      ExecutionReconfigurationStore(unscheduledReconfigurations = List(alreadyQueued))
    )
    val inNextFormat = changeOf(
      changedLimit,
      edit = _.replaceFirst(
        s""""formatVersion": ${PhysicalPlanCodec.FormatVersion},""",
        s""""formatVersion": $nextFormat,"""
      )
    )
    val notInPlan = mkPhysicalOp("filter-z").copy(
      workflowId = testWorkflowId,
      executionId = testExecutionId
    )
    val refusals: Seq[(String, Either[String, String])] = Seq(
      "" -> Left("The request carries no change to apply."),
      (null: String) -> Left("The request carries no change to apply."),
      changeOf(changedLimit, ofExecution = ExecutionIdentity(9299L)) ->
        Left("The change is execution 9299's, not 9232's."),
      inNextFormat ->
        Left(
          s"The operator update is in format version $nextFormat, but this reader reads version " +
            s"${PhysicalPlanCodec.FormatVersion}."
        ),
      changeOf(notInPlan) ->
        Left("Operator filter-z-main is not in the running plan."),
      // A change that asks for an environment the running operator does not run in: its workers
      // would keep the interpreter they have.
      changeOf(changedLimit.withPythonEnvironment(PythonEnvironmentRef.Named("ml"))) ->
        Left("The operator's Python environment cannot change while the run is paused.")
    )

    refusals.foreach {
      case (change, refusal) =>
        withClue(s"$change: ") { service.applyUpdate(change, asStarter) shouldBe refusal }
    }
    // A text that is not a change, in the codec's words.
    service.applyUpdate("not a change", asStarter).left.getOrElse("") should
      startWith("The operator update is not JSON")

    stateStore.reconfigurationStore.getState.unscheduledReconfigurations shouldBe
      List(alreadyQueued)
  }

  it should "refuse a change anyone but the user who started the execution asks for, before reading it" in {
    val stateStore = new ExecutionStateStore
    val service = new ChangeService(stateStore)
    Seq(Some(starterUid + 1), None).foreach { requester =>
      withClue(s"$requester: ") {
        // Not read: a text that is no change is refused as one from the wrong user.
        service.applyUpdate("not a change", requester) shouldBe
          Left("Only the user who started execution 9232 may change its operators.")
      }
    }
    stateStore.reconfigurationStore.getState.unscheduledReconfigurations shouldBe empty
  }

  it should "refuse a change that reads a dataset this unit cannot give its code" in {
    val mounts = Some(RepositoryMounts(Set(datasetLocator)))
    val refusals: Seq[(PhysicalOp, Option[Path], Either[String, String])] = Seq(
      // On a unit that mounts none.
      (
        changedUdf,
        None,
        Left(
          "Operator udf-a reads datasets or models (dataset-1:abc123), which this computing " +
            "unit cannot mount."
        )
      ),
      // Whose code does not name the dataset the change says it reads.
      (
        runningUdf.copy(repositoryMounts = mounts),
        Some(unitMountRoot),
        Left(
          "The code of operator udf-a does not name dataset-1:abc123, which its plan says it " +
            "reads."
        )
      ),
      // Of an operator that has no code to name it.
      (
        changedLimit.copy(repositoryMounts = mounts),
        Some(unitMountRoot),
        Left(
          "Operator limit-a reads datasets or models (dataset-1:abc123), but it is no UDF " +
            "whose code names them."
        )
      )
    )
    refusals.foreach {
      case (change, unitRoot, refusal) =>
        withClue(s"${change.id.logicalOpId.id} under $unitRoot: ") {
          val stateStore = new ExecutionStateStore
          val service = new ChangeService(stateStore, mountRoot = unitRoot)

          service.applyUpdate(changeOf(change), asStarter) shouldBe refusal
          // Nothing is queued, so a resume does not fail the run on it.
          stateStore.reconfigurationStore.getState.unscheduledReconfigurations shouldBe empty
          service.performReconfigurationOnResume()
          service.captured shouldBe empty
        }
    }
    // A change that reads nothing needs no mount.
    val nowhere = new ChangeService(new ExecutionStateStore, mountRoot = None)
    nowhere.applyUpdate(changeOf(changedLimit), asStarter) shouldBe Right("limit-a")
  }

  it should "take a change that asks for the environment the running operator runs in" in {
    val inMl = runningUdf.withPythonEnvironment(PythonEnvironmentRef.Named("ml"))
    val service = new ChangeService(new ExecutionStateStore, physicalOps = Set(inMl))

    service.applyUpdate(
      changeOf(changedUdf.withPythonEnvironment(PythonEnvironmentRef.Named("ml"))),
      asStarter
    ) shouldBe Right("udf-a")
  }

  "performReconfigurationOnResume" should
    "return without dispatching when no reconfigurations are pending" in {
    val stateStore = new ExecutionStateStore()
    val service = new RecordingService(stateStore)

    noException should be thrownBy service.performReconfigurationOnResume()

    service.captured shouldBe empty
    val state = stateStore.reconfigurationStore.getState
    state.unscheduledReconfigurations shouldBe empty
    state.currentReconfigId shouldBe None
    state.completedReconfigurations shouldBe empty
  }

  it should "mount what a changed operator names, and send its bound code" in {
    val stateStore = new ExecutionStateStore()
    val service = new RecordingService(stateStore)
    val bound = OpExecWithClassName("bound.Class", "")
    // As an accepted change queues it: bound already, holding only data.
    val op = mkPhysicalOp("op-1").copy(
      opExecInitInfo = bound,
      repositoryMounts = Some(RepositoryMounts(Set(datasetLocator)))
    )
    stateStore.reconfigurationStore.updateState(_ =>
      ExecutionReconfigurationStore(unscheduledReconfigurations = List(op))
    )

    service.performReconfigurationOnResume()

    service.mounted shouldBe Seq(Set(datasetLocator))
    service.captured.head.reconfiguration.map(_.newExecInitInfo) shouldBe Seq(bound)
  }

  it should "dispatch one request carrying every pending reconfiguration and reset the store" in {
    val stateStore = new ExecutionStateStore()
    val service = new RecordingService(stateStore)

    val op1 = mkPhysicalOp("op-1")
    val op2 = mkPhysicalOp("op-2")
    // A worker that completed in the PREVIOUS round, i.e. the state a second pause/resume cycle
    // actually starts from.
    val staleWorker = mkWorker("op-1", 0)
    stateStore.reconfigurationStore.updateState(_ =>
      ExecutionReconfigurationStore(
        unscheduledReconfigurations = List(op1, op2),
        completedReconfigurations = Set(staleWorker)
      )
    )

    service.performReconfigurationOnResume()

    service.captured should have size 1
    val request = service.captured.head
    request.reconfigurationId should not be empty
    request.reconfiguration.map(_.targetOpId) should contain theSameElementsInOrderAs Seq(
      op1.id,
      op2.id
    )
    request.reconfiguration.map(_.newExecInitInfo) should contain theSameElementsInOrderAs Seq(
      op1.opExecInitInfo,
      op2.opExecInitInfo
    )
    // Neither names a repository, so nothing is mounted.
    service.mounted shouldBe empty

    val state = stateStore.reconfigurationStore.getState
    state.unscheduledReconfigurations shouldBe empty
    state.currentReconfigId shouldBe Some(request.reconfigurationId)
    // The new round starts from an empty completed set. Carrying the previous round's workers
    // over would make their re-completion `old + worker` produce an equal store, which
    // StateStore drops before any diff handler runs -- the frontend would never be told the
    // second round finished.
    state.completedReconfigurations shouldBe empty
  }

  it should "use a fresh reconfigurationId on each dispatch" in {
    val stateStore = new ExecutionStateStore()
    val service = new RecordingService(stateStore)

    def queueAndDispatch(opName: String): String = {
      stateStore.reconfigurationStore.updateState(old =>
        old.copy(unscheduledReconfigurations = List(mkPhysicalOp(opName)))
      )
      service.performReconfigurationOnResume()
      service.captured.last.reconfigurationId
    }

    val firstId = queueAndDispatch("op-a")
    val secondId = queueAndDispatch("op-b")

    firstId should not be secondId
    stateStore.reconfigurationStore.getState.currentReconfigId shouldBe Some(secondId)
  }

  it should "send the request to the coordinator over the client's grpc interface" in {
    // The tests above run against an overridden `dispatch`, which leaves the one line that
    // actually reaches the engine untested. This one keeps the real dispatch.
    withLiveService() { f =>
      val op1 = mkPhysicalOp("dispatched-op-1")
      val op2 = mkPhysicalOp("dispatched-op-2")
      f.stateStore.reconfigurationStore.updateState(_ =>
        ExecutionReconfigurationStore(unscheduledReconfigurations = List(op1, op2))
      )

      f.service.performReconfigurationOnResume()

      f.client.coordinatorCalls should have size 1
      val (calledMethod, payload) = f.client.coordinatorCalls.head
      // Named explicitly: the coordinator interface carries every control command, and reaching
      // the engine through any other one would not start a Fries round.
      calledMethod shouldBe "reconfigureWorkflow"
      val captured = payload.asInstanceOf[WorkflowReconfigureRequest]
      captured.reconfiguration.map(_.targetOpId) should contain theSameElementsInOrderAs Seq(
        op1.id,
        op2.id
      )
      captured.reconfiguration.map(_.newExecInitInfo) should contain theSameElementsInOrderAs Seq(
        op1.opExecInitInfo,
        op2.opExecInitInfo
      )
      // The id the engine is told to reconfigure under is the one the store now tracks; a
      // mismatch would leave the completion diff handler waiting on a round that never reports.
      f.stateStore.reconfigurationStore.getState.currentReconfigId shouldBe
        Some(captured.reconfigurationId)
    }
  }

  "onWorkerReconfigured" should
    "add the worker id to completedReconfigurations so the diff handler can fire" in {
    val stateStore = new ExecutionStateStore()
    val service = new RecordingService(stateStore)

    val w1 = ActorVirtualIdentity("Worker:WF1-E1-op-main-0")
    val w2 = ActorVirtualIdentity("Worker:WF1-E1-op-main-1")
    service.onWorkerReconfigured(w1)
    service.onWorkerReconfigured(w2)
    // duplicate completion is idempotent (Set semantics).
    service.onWorkerReconfigured(w1)

    stateStore.reconfigurationStore.getState.completedReconfigurations should contain theSameElementsAs Set(
      w1,
      w2
    )
  }

  "the worker completion callback" should
    "announce the logical operator of every worker that reports in" in {
    // Driven only through the engine event, so it also pins that the constructor registered the
    // callback for UpdateExecutorCompleted and passed the reported worker on.
    withLiveService(physicalOps = Set(mkPhysicalOp("opA"), mkPhysicalOp("opB"))) { f =>
      val batches = recordBatches(f.stateStore.reconfigurationStore) {
        f.client.fire(UpdateExecutorCompleted(mkWorker("opA", 0)))
        f.client.fire(UpdateExecutorCompleted(mkWorker("opB", 0)))
        f.client.fire(UpdateExecutorCompleted(mkWorker("opA", 1)))
      }

      batches should have size 3
      announcedOps(batches.head) shouldBe List("opA")
      // Only the worker that just reported is announced; publishing the whole completed set
      // would re-announce opA here.
      announcedOps(batches(1)) shouldBe List("opB")
      // opA's SECOND worker announces opA a second time. Recorded as OBSERVED behaviour, not as
      // an endorsed contract: the engine emits one UpdateExecutorCompleted per worker
      // (ReconfigurationHandler.notifyOnComplete) and the handler maps each straight to its
      // logical operator, so an N-worker operator produces N ModifyLogicCompletedEvents and the
      // frontend shows N "reconfiguration on operator(s) opA complete" toasts -- the first while
      // opA's remaining workers are still running the old executor. That contradicts the comment
      // above ExecutionReconfigurationService.registerCompletionDiffHandler, which says the
      // frontend is notified "when all workers of an operator complete reconfiguration". One of
      // the two is wrong; whichever is corrected, this assertion has to be revisited.
      announcedOps(batches(2)) shouldBe List("opA")

      f.stateStore.reconfigurationStore.getState.completedReconfigurations shouldBe
        Set(mkWorker("opA", 0), mkWorker("opB", 0), mkWorker("opA", 1))
    }
  }

  it should "announce every operator that completed before the client attached" in {
    // WorkflowService re-subscribes the websocket observable on every browser attach, and
    // StateStore replays a (default, current) pair to each new subscriber, so a client joining a
    // running execution is handed one diff carrying every worker that has finished so far. It is
    // the only path that produces a multi-worker diff, and therefore the only thing that
    // distinguishes announcing the whole diff from announcing one of its members.
    withLiveService(physicalOps = Set(mkPhysicalOp("opA"), mkPhysicalOp("opB"))) { f =>
      f.client.fire(UpdateExecutorCompleted(mkWorker("opA", 0)))
      f.client.fire(UpdateExecutorCompleted(mkWorker("opB", 0)))

      val batches = recordBatches(f.stateStore.reconfigurationStore) {
        // nothing to drive: the catch-up pair is delivered synchronously on subscribe.
      }

      batches should have size 1
      // Order-insensitive: the diff is a Set.
      announcedOps(batches.head) should contain theSameElementsAs List("opA", "opB")
    }
  }

  it should "announce nothing to a client that attaches after a new round has started" in {
    // Same catch-up pair, but this time it straddles a round boundary (reconfigId None -> Some).
    // It is not a completion report, so the joining client must not be told that opA finished.
    withLiveService(physicalOps = Set(mkPhysicalOp("opA"), mkPhysicalOp("opB"))) { f =>
      f.stateStore.reconfigurationStore.updateState(_ =>
        ExecutionReconfigurationStore(unscheduledReconfigurations = List(mkPhysicalOp("opA")))
      )
      f.service.performReconfigurationOnResume()
      f.client.fire(UpdateExecutorCompleted(mkWorker("opA", 0)))

      val batches = recordBatches(f.stateStore.reconfigurationStore) {
        f.client.fire(UpdateExecutorCompleted(mkWorker("opB", 0)))
      }

      batches should have size 2
      batches.head shouldBe empty
      // ...and the subscription really is live, so the empty batch above is a decision, not a
      // dead handler: the next genuine completion is announced.
      announcedOps(batches.last) shouldBe List("opB")
    }
  }

  it should "publish nothing to announce when the completed set is untouched" in {
    withLiveService(physicalOps = Set(mkPhysicalOp("opA"))) { f =>
      val batches = recordBatches(f.stateStore.reconfigurationStore) {
        // A real announcement first, so the empty batch below cannot be explained by a dead
        // subscription, a handler that was never registered, or a state that never changed.
        f.client.fire(UpdateExecutorCompleted(mkWorker("opA", 0)))
        // Queueing a change, as an accepted one is, changes the store without completing anything.
        f.stateStore.reconfigurationStore.updateState(old =>
          old.copy(unscheduledReconfigurations =
            old.unscheduledReconfigurations :+ mkPhysicalOp("opA")
          )
        )
      }

      batches should have size 2
      announcedOps(batches.head) shouldBe List("opA")
      batches.last shouldBe empty
    }
  }

  it should "stop announcing completions once the service is unsubscribed" in {
    val workerA = mkWorker("opA", 0)
    val workerB = mkWorker("opB", 0)
    withLiveService(physicalOps = Set(mkPhysicalOp("opA"), mkPhysicalOp("opB"))) { f =>
      val batches = recordBatches(f.stateStore.reconfigurationStore) {
        f.client.fire(UpdateExecutorCompleted(workerA))
        f.service.unsubscribeAll()
        // Driven through the service's own entry point rather than the engine event on purpose.
        // What this test is about is the diff handler's disposable reaching the
        // SubscriptionManager; the engine callback is a separate subscription with its own
        // disposable (covered by the test below), and routing through it would leave the empty
        // batch explainable by either one being released.
        f.service.onWorkerReconfigured(workerB)
      }

      batches should have size 2
      announcedOps(batches.head) shouldBe List("opA")
      // The store still publishes -- the second completion did change the state, as the
      // assertion below confirms -- but the handler is gone, which is only true if the
      // constructor handed its disposable to the subscription manager.
      batches.last shouldBe empty
      f.stateStore.reconfigurationStore.getState.completedReconfigurations shouldBe
        Set(workerA, workerB)
    }
  }

  it should "release the engine subscription once the service is unsubscribed" in {
    val workerA = mkWorker("opA", 0)
    val workerB = mkWorker("opB", 0)
    withLiveService(physicalOps = Set(mkPhysicalOp("opA"), mkPhysicalOp("opB"))) { f =>
      // A live registration first, so a disposed one below cannot be confused with one that was
      // never made.
      f.client.fire(UpdateExecutorCompleted(workerA))
      f.stateStore.reconfigurationStore.getState.completedReconfigurations shouldBe Set(workerA)

      f.service.unsubscribeAll()

      // The Disposable `registerCallback` handed back has to reach the SubscriptionManager, the
      // same way the diff handler's does; this is the only thing that can release it. The
      // client's own `shutdown` is not an alternative: it flips `isActive` and poison-pills the
      // ClientActor but never touches `registeredObservables`, so the subject keeps the
      // subscriber -- and with it this service, its state store and its Workflow -- attached for
      // as long as the AmberClient is reachable, which WorkflowExecutionService keeps it.
      f.client.disposedCallbacks should contain(classOf[UpdateExecutorCompleted])

      // ...and the detached callback is inert: a late engine event does not write into the store
      // of a finished execution.
      f.client.fireIfRegistered(UpdateExecutorCompleted(workerB))
      f.stateStore.reconfigurationStore.getState.completedReconfigurations shouldBe Set(workerA)
    }
  }
}
