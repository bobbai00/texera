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
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  EmptyRequest,
  TakeGlobalCheckpointRequest
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.{
  EmptyReturn,
  TakeGlobalCheckpointResponse
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.architecture.rpc.coordinatorservice.CoordinatorServiceFs2Grpc
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.FaultToleranceConfig
import org.apache.texera.web.WebsocketInput
import org.apache.texera.web.model.websocket.request.{
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
import scala.collection.mutable.ListBuffer
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
      val errors: ListBuffer[Throwable]
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
    val stateStore = new ExecutionStateStore
    val errors = ListBuffer.empty[Throwable]
    val wsInput = new WebsocketInput(errors += _)
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
      errors
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

      f.wsInput.onNext(WorkflowPauseRequest(), None)

      f.stateStore.metadataStore.getState.state shouldBe PAUSING
      f.errors shouldBe empty
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

      f.wsInput.onNext(WorkflowResumeRequest(), None)
      f.stateStore.metadataStore.getState.state shouldBe RESUMING

      resumeResult.setValue(EmptyReturn())
      f.stateStore.metadataStore.getState.state shouldBe RUNNING
      f.errors shouldBe empty
    } finally f.close()
  }

  it should "kill the client and record a terminal timestamp when killed from the websocket" in {
    // A run in any state it has not ended in, the ones before its engine starts included.
    Seq(UNINITIALIZED, READY, RUNNING, PAUSING, PAUSED, RESUMING).foreach { live =>
      withClue(s"a run that is $live: ") {
        val f = fixture()
        try {
          f.stateStore.metadataStore.updateState(_.withState(live))

          val before = System.currentTimeMillis()
          f.wsInput.onNext(WorkflowKillRequest(), None)
          val after = System.currentTimeMillis()

          f.client.shutdownCount shouldBe 1
          f.stateStore.metadataStore.getState.state shouldBe KILLED
          f.stateStore.statsStore.getState.endTimeStamp should (be >= before and be <= after)
          f.errors shouldBe empty
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

          f.wsInput.onNext(WorkflowKillRequest(), None)

          f.stateStore.metadataStore.getState shouldBe asItEnded
          f.stateStore.statsStore.getState.endTimeStamp shouldBe endedAt
          f.errors shouldBe empty
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

      f.wsInput.onNext(WorkflowKillRequest(), None)

      f.stateStore.metadataStore.getState.state shouldBe COMPLETED
      f.stateStore.statsStore.getState.endTimeStamp shouldBe completedAt
      f.errors shouldBe empty
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
      f.errors shouldBe empty
    } finally f.close()
  }

  it should "report a checkpoint request without fault-tolerance storage instead of dispatching it" in {
    val f = fixture(logConf = None)
    try {
      f.wsInput.onNext(WorkflowCheckpointRequest(), None)

      f.errors should have size 1
      f.errors.head.getMessage should include("Fault tolerance log folder is not established")
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
      f.errors shouldBe empty
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
