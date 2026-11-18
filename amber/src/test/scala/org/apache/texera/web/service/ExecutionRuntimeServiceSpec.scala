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

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import com.twitter.util.{Future, Promise}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.engine.architecture.coordinator.ExecutionStateUpdate
import org.apache.texera.amber.core.virtualidentity.ActorVirtualIdentity
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  EmptyRequest,
  RetryWorkflowRequest,
  TakeGlobalCheckpointRequest
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.{
  EmptyReturn,
  TakeGlobalCheckpointResponse
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.architecture.rpc.coordinatorservice.CoordinatorServiceFs2Grpc
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.FaultToleranceConfig
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.web.WebsocketInput
import org.apache.texera.web.model.websocket.request.{
  RetryRequest,
  SkipTupleRequest,
  WorkflowCheckpointRequest,
  WorkflowKillRequest,
  WorkflowPauseRequest,
  WorkflowResumeRequest
}
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.storage.ExecutionStateStore
import org.scalamock.scalatest.MockFactory
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Seconds, Span}
import org.slf4j.LoggerFactory

import java.net.URI
import scala.jdk.CollectionConverters._

class ExecutionRuntimeServiceSpec
    extends TestKit(ActorSystem("ExecutionRuntimeServiceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with MockFactory
    with Eventually
    with BeforeAndAfterAll {

  override def afterAll(): Unit = {
    try TestKit.shutdownActorSystem(system)
    finally super.afterAll()
  }

  /** The execution the commands of these cases name: what a run does with one is not its id's. */
  private val executionId = 31L

  /** Records resume wiring while skipping constructor-time client and workflow subscriptions. */
  private final class RecordingReconfigurationService
      extends ExecutionReconfigurationService(
        client = null,
        stateStore = null,
        workflow = null,
        planUri = new URI("vfs:///wid/1/eid/1/plan"),
        creator = 1,
        mountRoot = None
      ) {
    var resumeCallCount = 0

    override def performReconfigurationOnResume(): Unit = {
      resumeCallCount += 1
    }

    override protected def registerWorkerCompletionCallback(): Unit = {}

    override protected def registerCompletionDiffHandler(): Unit = {}
  }

  private final class Fixture(
      val client: RecordingExecutionClient,
      val coordinator: CoordinatorServiceFs2Grpc[Future, Unit],
      val stateStore: ExecutionStateStore,
      val wsInput: WebsocketInput,
      val reconfigurationService: RecordingReconfigurationService,
      val runtime: ExecutionRuntimeService,
      val recorder: RecordingExecutionRecorder
  ) {
    def close(): Unit = {
      runtime.unsubscribeAll()
      client.dispose()
    }
  }

  private def fixture(
      logConf: Option[FaultToleranceConfig] = Some(
        FaultToleranceConfig(new URI("file:///runtime-checkpoints/"))
      ),
      notification: Option[Notification] = None
  ): Fixture = {
    val coordinator = mock[CoordinatorServiceFs2Grpc[Future, Unit]]
    val client = new RecordingExecutionClient(system, Some(coordinator))
    val recorder = new RecordingExecutionRecorder
    val stateStore = new ExecutionStateStore(recorder)
    val wsInput = new WebsocketInput()
    val reconfigurationService = new RecordingReconfigurationService

    val runtime = new ExecutionRuntimeService(
      client,
      stateStore,
      wsInput,
      reconfigurationService,
      logConf,
      workflowId = 7L,
      notification = notification
    )
    new Fixture(
      client,
      coordinator,
      stateStore,
      wsInput,
      reconfigurationService,
      runtime,
      recorder
    )
  }

  "ExecutionRuntimeService" should "mark the runtime as pausing before sending a pause command" in {
    val f = fixture()
    try {
      (f.coordinator.pauseWorkflow _)
        .expects(EmptyRequest(), ())
        .onCall { (_: EmptyRequest, _: Unit) =>
          f.stateStore.metadataStore.getState.state shouldBe PAUSING
          Future.value(EmptyReturn())
        }

      f.wsInput.onNext(WorkflowPauseRequest(executionId), None)

      f.stateStore.metadataStore.getState.state shouldBe PAUSING
    } finally f.close()
  }

  it should "resume pending reconfiguration and transition to running after the RPC succeeds" in {
    val f = fixture()
    try {
      val resumeResult = Promise[EmptyReturn]()
      (f.coordinator.resumeWorkflow _)
        .expects(EmptyRequest(), ())
        .onCall { (_: EmptyRequest, _: Unit) =>
          f.reconfigurationService.resumeCallCount shouldBe 1
          resumeResult
        }

      f.wsInput.onNext(WorkflowResumeRequest(executionId), None)
      f.stateStore.metadataStore.getState.state shouldBe RESUMING

      resumeResult.setValue(EmptyReturn())
      f.stateStore.metadataStore.getState.state shouldBe RUNNING
    } finally f.close()
  }

  it should "record a pause and a resume as the states the run reaches, not as the requests in flight" in {
    val f = fixture()
    try {
      (f.coordinator.pauseWorkflow _)
        .expects(EmptyRequest(), ())
        .returning(Future.value(EmptyReturn()))
      (f.coordinator.resumeWorkflow _)
        .expects(EmptyRequest(), ())
        .returning(Future.value(EmptyReturn()))
      f.stateStore.transitionTo(RUNNING)

      f.wsInput.onNext(WorkflowPauseRequest(executionId), None)
      f.stateStore.metadataStore.getState.state shouldBe PAUSING
      f.client.fire(ExecutionStateUpdate(PAUSED))
      f.stateStore.metadataStore.getState.state shouldBe PAUSED
      f.wsInput.onNext(WorkflowResumeRequest(executionId), None)
      f.stateStore.metadataStore.getState.state shouldBe RUNNING

      f.recorder.states shouldBe
        Seq(("RUNNING", None), ("PAUSED", None), ("RUNNING", None))
    } finally f.close()
  }

  it should "leave a run that already ended as it ended when a pause or a resume arrives late" in {
    // Sent as the run ends, or by a page that still shows it running. The engine is asked
    // nothing, which the coordinator, expecting no call, would report as an error; the run is
    // not left PAUSING for good, and the changes queued for its operators are not applied.
    Seq(COMPLETED, FAILED, KILLED, TERMINATED).foreach { ended =>
      withClue(s"a run that is $ended: ") {
        val f = fixture()
        try {
          f.stateStore.metadataStore.updateState(_.withState(ended))
          val asItEnded = f.stateStore.metadataStore.getState

          f.wsInput.onNext(WorkflowPauseRequest(executionId), None)
          f.wsInput.onNext(WorkflowResumeRequest(executionId), None)

          f.stateStore.metadataStore.getState shouldBe asItEnded
          f.reconfigurationService.resumeCallCount shouldBe 0
          f.recorder.changes shouldBe empty
        } finally f.close()
      }
    }
  }

  it should "kill the client and record a terminal timestamp when killed from the websocket" in {
    // A run in any state it has not ended in, the ones before its engine starts included.
    Seq(UNINITIALIZED, READY, RUNNING, PAUSING, PAUSED, RESUMING).foreach { live =>
      withClue(s"a run that is $live: ") {
        val f = fixture()
        try {
          f.stateStore.metadataStore.updateState(_.withState(live))

          val before = System.currentTimeMillis()
          f.wsInput.onNext(WorkflowKillRequest(executionId), None)
          val after = System.currentTimeMillis()

          f.client.shutdownCount shouldBe 1
          f.stateStore.metadataStore.getState.state shouldBe KILLED
          f.stateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
          f.recorder.states shouldBe Seq(("KILLED", Some("killed by the user")))
        } finally f.close()
      }
    }
  }

  it should "leave a run that already ended as it ended when a kill arrives late" in {
    // A kill sent as the run ends, or by a client that still shows it running: the run keeps the
    // state it ended in and the time it ended at, which its execution's row and history show.
    val endedAt = 1234L
    Seq(COMPLETED, FAILED, KILLED, TERMINATED).foreach { ended =>
      withClue(s"a run that is $ended: ") {
        val f = fixture()
        try {
          f.stateStore.metadataStore.updateState(_.withState(ended))
          f.stateStore.statsStore.updateState(_.withEndTimeStamp(endedAt))
          val asItEnded = f.stateStore.metadataStore.getState

          f.wsInput.onNext(WorkflowKillRequest(executionId), None)

          f.stateStore.metadataStore.getState shouldBe asItEnded
          f.stateStore.statsStore.getState.endTimeStamp shouldBe endedAt
          f.recorder.changes shouldBe empty
        } finally f.close()
      }
    }
  }

  it should "leave a run that completed as completed when a kill follows the engine's report" in {
    val f = fixture()
    try {
      f.client.fire(ExecutionStateUpdate(COMPLETED))
      val completedAt = f.stateStore.statsStore.getState.endTimeStamp
      completedAt should be > 0L

      f.wsInput.onNext(WorkflowKillRequest(executionId), None)

      f.stateStore.metadataStore.getState.state shouldBe COMPLETED
      f.stateStore.statsStore.getState.endTimeStamp shouldBe completedAt
      f.recorder.states shouldBe Seq(("COMPLETED", None))
    } finally f.close()
  }

  it should "leave a run that was killed as killed when the engine's report of its end follows" in {
    val f = fixture()
    try {
      f.stateStore.transitionTo(RUNNING)
      f.wsInput.onNext(WorkflowKillRequest(executionId), None)
      val killedAt = f.stateStore.statsStore.getState.endTimeStamp
      // The end time of a later ending would differ.
      Thread.sleep(5)

      f.client.fire(ExecutionStateUpdate(COMPLETED))

      f.stateStore.metadataStore.getState.state shouldBe KILLED
      f.stateStore.statsStore.getState.endTimeStamp shouldBe killedAt
      f.recorder.states shouldBe Seq(("RUNNING", None), ("KILLED", Some("killed by the user")))
    } finally f.close()
  }

  it should "dispatch a non-estimation checkpoint request below the configured log URI" in {
    val f = fixture()
    try {
      var captured: TakeGlobalCheckpointRequest = null
      (f.coordinator.takeGlobalCheckpoint _)
        .expects(*, ())
        .onCall { (request: TakeGlobalCheckpointRequest, _: Unit) =>
          captured = request
          Future.value(TakeGlobalCheckpointResponse(0L))
        }

      f.wsInput.onNext(WorkflowCheckpointRequest(), None)

      captured should not be null
      captured.estimationOnly shouldBe false
      captured.checkpointId.id should startWith("Checkpoint_")
      val destination = new URI(captured.destination)
      destination.getScheme shouldBe "file"
      destination shouldBe new URI("file:///runtime-checkpoints/").resolve(
        captured.checkpointId.toString
      )
    } finally f.close()
  }

  it should "tell the sender of a checkpoint request that a unit without replay logs takes none" in {
    val f = fixture(logConf = None)
    try {
      f.stateStore.transitionTo(RUNNING)
      // Thrown to whoever handed the request in, which answers its session; the engine is asked
      // nothing, and the run goes on.
      the[UnsupportedOperationException] thrownBy
        f.wsInput.onNext(WorkflowCheckpointRequest(), None) should have message
        "This computing unit keeps no replay logs, so it cannot take a checkpoint."
      f.stateStore.metadataStore.getState.state shouldBe RUNNING
      f.stateStore.metadataStore.getState.fatalErrors shouldBe empty
    } finally f.close()
  }

  it should "have the workers named process their tuple once more, with the changes made meanwhile, and resume" in {
    val f = fixture()
    try {
      f.stateStore.transitionTo(PAUSED)
      val retried = Promise[EmptyReturn]()
      (f.coordinator.retryWorkflow _)
        .expects(
          RetryWorkflowRequest(
            Seq(ActorVirtualIdentity("worker-a"), ActorVirtualIdentity("worker-b"))
          ),
          ()
        )
        .onCall { (_: RetryWorkflowRequest, _: Unit) =>
          // A change to the operator that stopped is applied before its tuple is tried again.
          f.reconfigurationService.resumeCallCount shouldBe 1
          f.stateStore.metadataStore.getState.state shouldBe RESUMING
          retried
        }

      f.wsInput.onNext(RetryRequest(Seq("worker-a", "worker-b")), None)
      f.stateStore.metadataStore.getState.state shouldBe RESUMING

      retried.setValue(EmptyReturn())
      eventually(timeout(Span(5, Seconds))) {
        f.stateStore.metadataStore.getState.state shouldBe RUNNING
      }
    } finally f.close()
  }

  it should "leave a run that already ended as it ended when a retry arrives late" in {
    val f = fixture()
    try {
      f.stateStore.transitionTo(COMPLETED)
      val asItEnded = f.stateStore.metadataStore.getState

      // The coordinator, expecting no call, would report one as an error.
      f.wsInput.onNext(RetryRequest(Seq("worker-a")), None)

      f.stateStore.metadataStore.getState shouldBe asItEnded
      f.reconfigurationService.resumeCallCount shouldBe 0
    } finally f.close()
  }

  it should "not record a run as running when its engine fails to resume it, or to retry" in {
    val refusal = new IllegalStateException("the engine did not resume")
    val resumed = fixture()
    try {
      resumed.stateStore.transitionTo(PAUSED)
      (resumed.coordinator.resumeWorkflow _)
        .expects(EmptyRequest(), ())
        .returning(Future.exception(refusal))

      resumed.wsInput.onNext(WorkflowResumeRequest(executionId), None)

      // The engine is still paused, and the run's record still ends there.
      resumed.stateStore.metadataStore.getState.state should not be RUNNING
      resumed.recorder.states shouldBe Seq(("PAUSED", None))
    } finally resumed.close()

    val retried = fixture()
    try {
      retried.stateStore.transitionTo(PAUSED)
      (retried.coordinator.retryWorkflow _)
        .expects(RetryWorkflowRequest(Seq(ActorVirtualIdentity("worker-a"))), ())
        .returning(Future.exception(refusal))

      retried.wsInput.onNext(RetryRequest(Seq("worker-a")), None)

      retried.stateStore.metadataStore.getState.state should not be RUNNING
      retried.recorder.states shouldBe Seq(("PAUSED", None))
    } finally retried.close()
  }

  it should "tell the sender of a skip that the engine skips no tuple, and leave the run alone" in {
    val f = fixture()
    try {
      f.stateStore.transitionTo(PAUSED)
      the[UnsupportedOperationException] thrownBy
        f.wsInput.onNext(SkipTupleRequest(Array("worker-a")), None) should have message
        "Skipping a tuple is not supported."
      f.stateStore.metadataStore.getState.state shouldBe PAUSED
      f.stateStore.metadataStore.getState.fatalErrors shouldBe empty
    } finally f.close()
  }

  it should "apply a captured completed callback, stop the client, and stamp the end time" in {
    val f = fixture()
    try {
      f.client.hasCallback[ExecutionStateUpdate] shouldBe true
      f.client.fire(ExecutionStateUpdate(COMPLETED))

      f.client.shutdownCount shouldBe 1
      f.stateStore.metadataStore.getState.state shouldBe COMPLETED
      f.stateStore.statsStore.getState.endTimeStamp should be > 0L
    } finally f.close()
  }

  it should "send a run's status emails as the notification it is given says" in {
    // An address the notifier refuses, so no email leaves: it logs the address instead, which
    // shows the notifier was built from this notification. The notifier takes the notification
    // whole, so the name and page go with the address.
    val notification =
      Notification("not-an-email", "workflow-seven", "http://texera.example/user/workspace/7")
    val logger = LoggerFactory
      .getLogger(classOf[WorkflowEmailNotifier])
      .asInstanceOf[LogbackLogger]
    val previousLevel = logger.getLevel
    val appender = new ListAppender[ILoggingEvent]
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.WARN)
    val f = fixture(notification = Some(notification))
    try {
      f.runtime.notification shouldBe Some(notification)
      f.client.fire(ExecutionStateUpdate(COMPLETED))

      // The email is sent on the notification service's own thread.
      eventually(timeout(Span(10, Seconds))) {
        appender.list.asScala.map(_.getFormattedMessage).toList should contain(
          "Invalid email address: not-an-email"
        )
      }
    } finally {
      f.close()
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }
}
