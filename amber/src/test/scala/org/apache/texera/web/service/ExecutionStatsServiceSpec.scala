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

import io.reactivex.rxjava3.disposables.Disposable
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.core.storage.{DocumentFactory, RuntimeStatisticsStore}
import org.apache.texera.amber.core.virtualidentity.{
  ActorVirtualIdentity,
  ExecutionIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{PhysicalPlan, PortIdentity, WorkflowContext}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.engine.architecture.coordinator.{
  CoordinatorConfig,
  ExecutionStatsUpdate,
  FatalError,
  RuntimeStatisticsPersist,
  WorkerAssignmentUpdate,
  WorkflowRecoveryStatus
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.architecture.worker.statistics.{
  PortTupleMetricsMapping,
  TupleMetrics
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder.StateChange
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionStatsStore,
  OperatorMetrics,
  OperatorStatistics
}
import org.apache.texera.web.model.websocket.event.{
  ExecutionDurationUpdateEvent,
  OperatorAggregatedMetrics,
  OperatorStatisticsUpdateEvent,
  TexeraWebSocketEvent,
  WorkerAssignmentUpdateEvent
}
import org.apache.texera.web.storage.{ExecutionStateStore, StateStore}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers

import java.net.URI
import scala.collection.mutable
import scala.collection.mutable.ListBuffer
import scala.reflect.ClassTag

/**
  * The service owns two independent outputs: the websocket diff handlers that tell the frontend
  * what each operator is doing, and what it hands the run's record, which stores the statistics
  * the Dashboard replays after the execution is over (`ExecutionRecorderSpec` has what the
  * record does with them).
  *
  * Everything here runs against an empty-plan AmberClient, so no engine is involved: the test
  * fires the client events straight into the callbacks the service registered.
  *
  * The ids below are no other suite's, so the statistics table they name is this suite's to look
  * for (CostHintsLoaderSpec owns wids 9521 to 9539). They also differ from each other, so a URI
  * built from the wrong identity is a visibly different URI.
  */
class ExecutionStatsServiceSpec
    extends TestKit(ActorSystem("ExecutionStatsServiceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll {

  private val testWid: Integer = 9107
  private val testEid: Integer = 9108

  private val statsUri: URI = RuntimeStatisticsStore.statisticsUri(
    WorkflowIdentity(testWid.longValue()),
    ExecutionIdentity(testEid.longValue()),
    None
  )

  override protected def beforeAll(): Unit = {
    // Whatever an earlier build of this suite left in the catalog the tests share.
    RuntimeStatisticsStore.drop(statsUri)
  }

  override protected def afterAll(): Unit = {
    try TestKit.shutdownActorSystem(system)
    finally super.afterAll()
  }

  /** Empty-plan client that captures every callback the service registers, keyed by event type. */
  private final class TestAmberClient
      extends AmberClient(
        system,
        new WorkflowContext(),
        PhysicalPlan(Set.empty, Set.empty),
        CoordinatorConfig(None, None, None, None),
        _ => ()
      ) {
    var shutdownCount = 0
    private val callbacks = mutable.Map.empty[Class[_], Any => Unit]

    override def shutdown(): Unit = {
      shutdownCount += 1
      super.shutdown()
    }

    override def registerCallback[T](callback: T => Unit)(implicit ct: ClassTag[T]): Disposable = {
      callbacks(ct.runtimeClass) = callback.asInstanceOf[Any => Unit]
      Disposable.empty()
    }

    /** Delivers an engine event the way the client's observable would. */
    def fire[T <: AnyRef](event: T)(implicit ct: ClassTag[T]): Unit =
      callbacks(ct.runtimeClass)(event)

    def dispose(): Unit = super.shutdown()
  }

  private final class Fixture(
      val client: TestAmberClient,
      val stateStore: ExecutionStateStore,
      val service: ExecutionStatsService,
      val recorder: RecordingExecutionRecorder
  ) {
    def close(): Unit = {
      service.unsubscribeAll()
      client.dispose()
    }
  }

  private def withService(body: Fixture => Unit): Unit = {
    val client = new TestAmberClient
    val recorder = new RecordingExecutionRecorder
    val stateStore = new ExecutionStateStore(recorder)
    val service = new ExecutionStatsService(client, stateStore)
    val fixture = new Fixture(client, stateStore, service, recorder)
    try body(fixture)
    finally fixture.close()
  }

  /**
    * One batch of websocket events is published per state update, so a test that cares about
    * what a *second* update publishes has to subscribe before the first one. Subscribing later
    * would also replay the diff between the default state and the current one as a batch.
    */
  private def recordBatches(
      store: StateStore[ExecutionStatsStore]
  )(body: => Unit): Seq[Iterable[TexeraWebSocketEvent]] = {
    val batches = ListBuffer.empty[Iterable[TexeraWebSocketEvent]]
    val subscription = store.getWebsocketEventObservable
      .subscribe((batch: Iterable[TexeraWebSocketEvent]) => batches += batch)
    try body
    finally subscription.dispose()
    batches.toSeq
  }

  private def metrics(
      state: WorkflowAggregatedState,
      inputs: Seq[(Int, Long, Long)] = Seq.empty,
      outputs: Seq[(Int, Long, Long)] = Seq.empty,
      numWorkers: Int = 1,
      dataProcessingTime: Long = 0,
      controlProcessingTime: Long = 0,
      idleTime: Long = 0
  ): OperatorMetrics = {
    def portMetrics(ports: Seq[(Int, Long, Long)]): Seq[PortTupleMetricsMapping] =
      ports.map {
        case (port, count, size) =>
          PortTupleMetricsMapping(PortIdentity(port), TupleMetrics(count, size))
      }

    OperatorMetrics(
      state,
      OperatorStatistics(
        portMetrics(inputs),
        portMetrics(outputs),
        numWorkers,
        dataProcessingTime,
        controlProcessingTime,
        idleTime
      )
    )
  }

  private def statisticsEvents(
      batch: Iterable[TexeraWebSocketEvent]
  ): Map[String, OperatorAggregatedMetrics] =
    batch.collect { case e: OperatorStatisticsUpdateEvent => e.operatorStatistics }.flatten.toMap

  "the operator statistics callback" should
    "publish per-port and aggregate metrics for every operator" in {
    // Input and output are two symmetrical groups of fields on the same event; the frontend
    // shows them as separate columns, so they are given distinct counts, sizes and port ids
    // here to make crossing them visible.
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.client.fire(
          ExecutionStatsUpdate(
            Map(
              "opA" -> metrics(
                RUNNING,
                inputs = Seq((0, 3L, 30L), (1, 4L, 40L)),
                outputs = Seq((2, 5L, 50L)),
                numWorkers = 2,
                dataProcessingTime = 11L,
                controlProcessingTime = 12L,
                idleTime = 13L
              ),
              // A second operator, because the handler maps over every reported operator and one
              // operator cannot show that: `operatorInfo.collect` could be reduced to
              // `operatorInfo.take(1).collect` and a single-operator fixture would not notice.
              "opB" -> metrics(
                COMPLETED,
                inputs = Seq((0, 9L, 90L)),
                outputs = Seq((1, 8L, 80L)),
                numWorkers = 4,
                dataProcessingTime = 21L,
                controlProcessingTime = 22L,
                idleTime = 23L
              )
            )
          )
        )
      }

      val published = statisticsEvents(batches.flatten)
      published.keySet shouldBe Set("opA", "opB")
      val opA = published("opA")
      opA.operatorState shouldBe "Running"
      opA.aggregatedInputRowCount shouldBe 7L
      opA.aggregatedInputSize shouldBe 70L
      opA.inputPortMetrics shouldBe Map("0" -> 3L, "1" -> 4L)
      opA.aggregatedOutputRowCount shouldBe 5L
      opA.aggregatedOutputSize shouldBe 50L
      opA.outputPortMetrics shouldBe Map("2" -> 5L)
      opA.numWorkers shouldBe 2L
      opA.aggregatedDataProcessingTime shouldBe 11L
      opA.aggregatedControlProcessingTime shouldBe 12L
      opA.aggregatedIdleTime shouldBe 13L

      val opB = published("opB")
      opB.operatorState shouldBe "Completed"
      opB.aggregatedInputRowCount shouldBe 9L
      opB.aggregatedOutputRowCount shouldBe 8L
      opB.numWorkers shouldBe 4L
    }
  }

  it should "publish nothing when the reported metrics repeat" in {
    // The frontend redraws the whole statistics panel per event, so re-announcing identical
    // numbers is pure churn on every heartbeat of a long-running execution.
    withService { f =>
      val reported = Map("opA" -> metrics(RUNNING, inputs = Seq((0, 1L, 10L))))

      val batches = recordBatches(f.stateStore.statsStore) {
        f.client.fire(ExecutionStatsUpdate(reported))
        // Same metrics, plus a change the duration handler reacts to, so a second batch is
        // published at all -- it just must not carry a statistics event.
        f.stateStore.statsStore.updateState(_.withOperatorInfo(reported).withStartTimeStamp(1L))
      }

      batches should have size 2
      statisticsEvents(batches.head).keySet shouldBe Set("opA")
      // Collected by event TYPE, not by payload: flattening the payload map would treat a
      // present-but-empty OperatorStatisticsUpdateEvent as "nothing published", when it is in fact
      // churn on the websocket. This matches the two sibling "publish nothing" tests below.
      batches.last.collect { case e: OperatorStatisticsUpdateEvent => e } shouldBe empty
    }
  }

  it should "sum multi-port output metrics and zero-out empty ports consistently" in {
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.client.fire(
          ExecutionStatsUpdate(
            Map(
              "multiOut" -> metrics(
                RUNNING,
                inputs = Seq.empty,
                outputs = Seq((0, 2L, 20L), (1, 5L, 55L)),
                numWorkers = 3
              )
            )
          )
        )
      }

      val published = statisticsEvents(batches.flatten)
      val multiOut = published("multiOut")
      multiOut.aggregatedInputRowCount shouldBe 0L
      multiOut.aggregatedInputSize shouldBe 0L
      multiOut.inputPortMetrics shouldBe Map.empty
      multiOut.aggregatedOutputRowCount shouldBe 7L
      multiOut.aggregatedOutputSize shouldBe 75L
      multiOut.outputPortMetrics shouldBe Map("0" -> 2L, "1" -> 5L)
    }
  }

  "the worker assignment callback" should
    "publish one event per operator carrying that operator's workers" in {
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.client.fire(
          WorkerAssignmentUpdate(
            Map("opA" -> Seq("worker-a-0", "worker-a-1"), "opB" -> Seq("worker-b-0"))
          )
        )
      }

      val assignments = batches.flatten.collect {
        case e: WorkerAssignmentUpdateEvent => e.operatorId -> e.workerIds
      }
      assignments.toMap shouldBe Map(
        "opA" -> Seq("worker-a-0", "worker-a-1"),
        "opB" -> Seq("worker-b-0")
      )
    }
  }

  it should "publish nothing when the assignment is unchanged" in {
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.client.fire(WorkerAssignmentUpdate(Map("opA" -> Seq("worker-a-0"))))
        // A later statistics update changes the state without touching the assignment.
        f.client.fire(ExecutionStatsUpdate(Map("opA" -> metrics(RUNNING))))
      }

      batches should have size 2
      batches.head.collect { case e: WorkerAssignmentUpdateEvent => e } should have size 1
      batches.last.collect { case e: WorkerAssignmentUpdateEvent => e } shouldBe empty
    }
  }

  "the execution duration handler" should "report the time elapsed so far while running" in {
    withService { f =>
      val startedAgo = 1500L
      val before = System.currentTimeMillis()
      val batches = recordBatches(f.stateStore.statsStore) {
        f.stateStore.statsStore.updateState(
          _.withStartTimeStamp(System.currentTimeMillis() - startedAgo)
        )
      }
      val elapsedDuringUpdate = System.currentTimeMillis() - before

      val durations = batches.flatten.collect { case e: ExecutionDurationUpdateEvent => e }
      durations should have size 1
      durations.head.isRunning shouldBe true
      // The frontend keeps ticking the clock forward from this value, so it is measured
      // against now rather than against the (still unset) end timestamp.
      //
      // Bounded on BOTH sides on purpose. A lower bound alone is satisfied by any arithmetic that
      // grows the number, so `currentTime - startTimeStamp` could become `currentTime +
      // startTimeStamp` -- roughly 111 years -- and still pass.
      durations.head.duration should be >= startedAgo
      durations.head.duration should be <= startedAgo + elapsedDuringUpdate
    }
  }

  it should "report the total duration once the execution has ended" in {
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.stateStore.statsStore.updateState(_.withStartTimeStamp(1000L).withEndTimeStamp(4200L))
      }

      val durations = batches.flatten.collect { case e: ExecutionDurationUpdateEvent => e }
      durations should have size 1
      durations.head.duration shouldBe 3200L
      durations.head.isRunning shouldBe false
    }
  }

  it should "publish nothing when neither timestamp moved" in {
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.stateStore.statsStore.updateState(_.withStartTimeStamp(1000L))
        f.client.fire(ExecutionStatsUpdate(Map("opA" -> metrics(RUNNING))))
      }

      batches should have size 2
      batches.head.collect { case e: ExecutionDurationUpdateEvent => e } should have size 1
      batches.last.collect { case e: ExecutionDurationUpdateEvent => e } shouldBe empty
    }
  }

  "the recovery status callback" should "mirror the reported flag onto the metadata store" in {
    withService { f =>
      f.client.fire(WorkflowRecoveryStatus(isRecovering = true))
      f.stateStore.metadataStore.getState.isRecovering shouldBe true

      // Both directions: the frontend leaves its recovery banner up until this flips back.
      f.client.fire(WorkflowRecoveryStatus(isRecovering = false))
      f.stateStore.metadataStore.getState.isRecovering shouldBe false
    }
  }

  "a fatal error" should "stop the client and record the failure against the reporting operator" in {
    withService { f =>
      val cause = new RuntimeException("stats-service-boom")

      f.client.fire(FatalError(cause, Some(ActorVirtualIdentity("Worker:WF1-udf1-main-0"))))

      // The engine is already lost when it reports a fatal error; leaving the client running
      // would keep the execution's actors alive behind a failed workflow.
      f.client.shutdownCount shouldBe 1
      f.stateStore.statsStore.getState.endTimeStamp should be > 0L
      f.stateStore.metadataStore.getState.state shouldBe FAILED

      val errors = f.stateStore.metadataStore.getState.fatalErrors
      errors should have size 1
      errors.head.`type` shouldBe EXECUTION_FAILURE
      // The error panel groups by operator and links to the worker; the two are separate
      // fields derived from the same actor id.
      errors.head.operatorId shouldBe "udf1"
      errors.head.workerId shouldBe "Worker:WF1-udf1-main-0"
      errors.head.message shouldBe cause.toString
      errors.head.details should include("stats-service-boom")
      // The run's record is told of its end, with the error.
      f.recorder.changes shouldBe Seq(StateChange("FAILED", errors, None))
    }
  }

  it should "leave a run that has ended as it ended, though its engine reports a failure after that" in {
    withService { f =>
      f.stateStore.transitionTo(COMPLETED) shouldBe true
      val asItEnded = f.stateStore.metadataStore.getState
      val endedAt = f.stateStore.statsStore.getState.endTimeStamp
      // The end time of a later ending would differ.
      Thread.sleep(5)

      f.client.fire(FatalError(new RuntimeException("after the end"), None))

      f.client.shutdownCount shouldBe 1
      f.stateStore.metadataStore.getState shouldBe asItEnded
      f.stateStore.statsStore.getState.endTimeStamp shouldBe endedAt
      f.recorder.states shouldBe Seq(("COMPLETED", None))
    }
  }

  "the persistence callback" should "hand the run's record each report of the engine, as it came" in {
    withService { f =>
      val first = Map(
        "opA" -> metrics(RUNNING, inputs = Seq((0, 1L, 10L))),
        "opB" -> metrics(
          COMPLETED,
          inputs = Seq((0, 3L, 30L)),
          outputs = Seq((1, 4L, 40L)),
          numWorkers = 2,
          dataProcessingTime = 7L,
          controlProcessingTime = 8L,
          idleTime = 9L
        )
      )
      // opB is gone from the second report, as happens once an operator completes and stops
      // being polled: the record is told what the engine said, and keeps opB's numbers itself.
      val second = Map("opA" -> metrics(COMPLETED))

      f.client.fire(RuntimeStatisticsPersist(first))
      f.client.fire(RuntimeStatisticsPersist(second))

      f.recorder.samples shouldBe Seq(first, second)
      // The record is told on the thread the engine's event came on: the service has no thread
      // of its own, and waits for no lake.
      f.recorder.tellers.distinct shouldBe Seq(Thread.currentThread())
    }
  }

  it should "show the sessions nothing: what they are shown comes with the engine's other event" in {
    withService { f =>
      val batches = recordBatches(f.stateStore.statsStore) {
        f.client.fire(RuntimeStatisticsPersist(Map("opA" -> metrics(RUNNING))))
      }

      batches shouldBe empty
      f.stateStore.statsStore.getState.operatorInfo shouldBe empty
    }
  }

  it should "leave what the sessions are shown out of the run's record" in {
    // The engine reports to the sessions twice a second, and to the record every two.
    withService { f =>
      f.client.fire(ExecutionStatsUpdate(Map("opA" -> metrics(RUNNING))))

      f.recorder.samples shouldBe empty
    }
  }

  "the service" should "write nothing to the lake itself: the run's record makes the statistics table" in {
    // The record here keeps what it is told and writes nothing, so a table could only be the
    // service's own.
    withService { f =>
      f.client.fire(RuntimeStatisticsPersist(Map("opA" -> metrics(RUNNING))))
      f.client.fire(ExecutionStatsUpdate(Map("opA" -> metrics(COMPLETED))))
      f.stateStore.transitionTo(COMPLETED) shouldBe true

      DocumentFactory.documentExists(statsUri) shouldBe false
    }
  }
}
