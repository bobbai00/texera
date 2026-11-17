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

package org.apache.texera.web.storage

import com.google.protobuf.timestamp.Timestamp
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder.StateChange
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionBreakpointStore,
  ExecutionConsoleStore,
  ExecutionMetadataStore,
  ExecutionStatsStore
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.util.concurrent.{Callable, CountDownLatch, Executors, TimeUnit}

/**
  * What a run's state store does in memory, and what it hands the run's recorder. The row a
  * change of state writes is `ExecutionsMetadataPersistServiceSpec`'s, where the database is.
  */
class ExecutionStateStoreSpec extends AnyFlatSpec with Matchers {

  private def error(message: String): WorkflowFatalError =
    WorkflowFatalError(EXECUTION_FAILURE, Timestamp(1794873600L, 0), message, "", "op", "worker")

  /** A store whose run is in `state`, as its changes of state left it, and its recorder. */
  private def storeIn(
      state: WorkflowAggregatedState*
  ): (ExecutionStateStore, RecordingExecutionRecorder) = {
    val recorder = new RecordingExecutionRecorder
    val store = new ExecutionStateStore(recorder)
    state.foreach(store.transitionTo(_) shouldBe true)
    (store, recorder)
  }

  "ExecutionStateStore" should "initialise each child store with the empty proto default" in {
    val s = new ExecutionStateStore
    s.statsStore.getState shouldBe ExecutionStatsStore()
    s.metadataStore.getState shouldBe ExecutionMetadataStore()
    s.consoleStore.getState shouldBe ExecutionConsoleStore()
    s.breakpointStore.getState shouldBe ExecutionBreakpointStore()
    s.reconfigurationStore.getState shouldBe ExecutionReconfigurationStore()
  }

  // Order is part of the contract: WorkflowLifecycleManager subscribes
  // to metadataStore by position-independent name, but ExecutionResultService
  // iterates getAllStores when wiring diff handlers in bulk, so a re-order
  // would shuffle which handler runs against which state.
  "getAllStores" should "return all five stores in stats/console/breakpoint/metadata/reconfiguration order" in {
    val s = new ExecutionStateStore
    val stores = s.getAllStores.toList
    stores should have size 5
    stores(0) should be theSameInstanceAs s.statsStore
    stores(1) should be theSameInstanceAs s.consoleStore
    stores(2) should be theSameInstanceAs s.breakpointStore
    stores(3) should be theSameInstanceAs s.metadataStore
    stores(4) should be theSameInstanceAs s.reconfigurationStore
  }

  it should "record nothing unless it is given a recorder" in {
    val s = new ExecutionStateStore
    s.transitionTo(RUNNING) shouldBe true
    s.metadataStore.getState.state shouldBe RUNNING
  }

  "transitionTo" should "store the state, add the errors, and tell the recorder of both with the reason" in {
    val (store, recorder) = storeIn()

    store.transitionTo(READY) shouldBe true
    store.transitionTo(RUNNING) shouldBe true
    store.transitionTo(PAUSED, reason = Some("paused by the user")) shouldBe true
    store.metadataStore.getState.state shouldBe PAUSED
    store.metadataStore.getState.fatalErrors shouldBe empty
    store.hasEnded shouldBe false

    store.transitionTo(FAILED, errors = Seq(error("first"), error("second"))) shouldBe true

    store.metadataStore.getState.state shouldBe FAILED
    store.metadataStore.getState.fatalErrors shouldBe Seq(error("first"), error("second"))
    store.hasEnded shouldBe true
    recorder.changes shouldBe Seq(
      StateChange("READY", Nil, None),
      StateChange("RUNNING", Nil, None),
      StateChange("PAUSED", Nil, Some("paused by the user")),
      StateChange("FAILED", Seq(error("first"), error("second")), None)
    )
  }

  it should "tell the recorder of the six states a log records, and of no request in flight" in {
    val (store, recorder) = storeIn()

    Seq(UNINITIALIZED, READY, RUNNING, PAUSING, PAUSED, RESUMING, RUNNING, UNKNOWN, COMPLETED)
      .foreach(store.transitionTo(_) shouldBe true)

    // The store holds each state in its turn; the log is told of those it records.
    recorder.states.map(_._1) shouldBe Seq("READY", "RUNNING", "PAUSED", "RUNNING", "COMPLETED")
    Seq(FAILED, KILLED).foreach { ending =>
      val (ended, told) = storeIn(RUNNING)
      ended.transitionTo(ending) shouldBe true
      told.states.map(_._1) shouldBe Seq("RUNNING", ending.name)
    }
  }

  it should "record TERMINATED, an ending the log has no word for, as KILLED" in {
    val (store, recorder) = storeIn(RUNNING)

    store.transitionTo(TERMINATED) shouldBe true

    store.metadataStore.getState.state shouldBe TERMINATED
    store.hasEnded shouldBe true
    recorder.states.map(_._1) shouldBe Seq("RUNNING", "KILLED")
  }

  it should "stamp the end time of a run when it ends, and at no other change" in {
    val (store, _) = storeIn(READY, RUNNING, PAUSING, PAUSED, RESUMING, RUNNING)
    store.statsStore.getState.endTimeStamp shouldBe 0L

    val before = System.currentTimeMillis()
    store.transitionTo(COMPLETED) shouldBe true
    val after = System.currentTimeMillis()

    store.statsStore.getState.endTimeStamp should (be >= before and be <= after)
  }

  it should "leave a run that has ended as it ended, whatever is asked of it" in {
    Seq(COMPLETED, FAILED, KILLED, TERMINATED).foreach { ending =>
      withClue(s"a run that is $ending: ") {
        val (store, recorder) = storeIn(RUNNING)
        store.transitionTo(ending, errors = Seq(error("why it ended"))) shouldBe true
        val ended = store.metadataStore.getState
        val endedAt = store.statsStore.getState.endTimeStamp
        val told = recorder.changes
        // The end time of a later ending would differ.
        Thread.sleep(5)

        Seq(READY, RUNNING, PAUSING, PAUSED, RESUMING, COMPLETED, FAILED, KILLED, TERMINATED)
          .foreach { asked =>
            withClue(s"asked to be $asked: ") {
              store.transitionTo(
                asked,
                errors = Seq(error("too late")),
                reason = Some("too late")
              ) shouldBe false
            }
          }

        store.metadataStore.getState shouldBe ended
        store.statsStore.getState.endTimeStamp shouldBe endedAt
        recorder.changes shouldBe told
      }
    }
  }

  it should "let the first of two endings that race be the run's, and tell the recorder of one" in {
    val threads = Executors.newFixedThreadPool(8)
    try (1 to 50).foreach { round =>
      val (store, recorder) = storeIn(RUNNING)
      val endings = Seq(COMPLETED, FAILED, KILLED, COMPLETED, FAILED, KILLED, COMPLETED, KILLED)
      val go = new CountDownLatch(1)
      val taken = endings.map { ending =>
        threads.submit(new Callable[Boolean] {
          override def call(): Boolean = {
            go.await()
            store.transitionTo(ending, reason = Some(s"raced to $ending"))
          }
        })
      }
      go.countDown()
      val answers = taken.map(_.get(30, TimeUnit.SECONDS))

      withClue(s"round $round: ") {
        answers.count(identity) shouldBe 1
        val winner = endings(answers.indexOf(true))
        store.metadataStore.getState.state shouldBe winner
        recorder.states shouldBe
          Seq(("RUNNING", None), (winner.name, Some(s"raced to $winner")))
      }
    } finally threads.shutdownNow()
  }
}
