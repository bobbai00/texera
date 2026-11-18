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

import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  PAUSED,
  READY,
  RUNNING,
  TERMINATED
}
import org.apache.texera.amber.engine.common.executionrecord.ExecutionRecorder
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionBreakpointStore,
  ExecutionConsoleStore,
  ExecutionMetadataStore,
  ExecutionStatsStore
}
import org.apache.texera.web.observability.WorkflowMetricsRecorder

object ExecutionStateStore {

  /** The states a run ends in: a run in any other may still be running. */
  val EndStates: Set[WorkflowAggregatedState] = Set(COMPLETED, FAILED, KILLED, TERMINATED)

  /**
    * The state a run's log records for `state`: None for a request in flight (PAUSING, RESUMING)
    * and for what is no state of a run. TERMINATED, an ending the engine reports for no workflow
    * today, is recorded as KILLED, so that no ending is missing from a log.
    */
  private def logged(state: WorkflowAggregatedState): Option[String] =
    state match {
      case READY | RUNNING | PAUSED | COMPLETED | FAILED | KILLED => Some(state.name)
      case TERMINATED                                             => Some(KILLED.name)
      case _                                                      => None
    }
}

/**
  * The states of one run.
  *
  * @param recorder keeps the run's record in the lake
  */
class ExecutionStateStore(val recorder: ExecutionRecorder = ExecutionRecorder.none) {
  val statsStore = new StateStore(ExecutionStatsStore())
  val metadataStore = new StateStore(ExecutionMetadataStore())
  val consoleStore = new StateStore(ExecutionConsoleStore())
  val breakpointStore = new StateStore(ExecutionBreakpointStore())
  val reconfigurationStore = new StateStore(ExecutionReconfigurationStore())

  /** Where the run's results are, as its engine reports them. */
  val resultUris = new ResultUris

  def getAllStores: Iterable[StateStore[_]] = {
    Iterable(statsStore, consoleStore, breakpointStore, metadataStore, reconfigurationStore)
  }

  /** Whether the run has ended: nothing changes its state any more. */
  def hasEnded: Boolean = ExecutionStateStore.EndStates.contains(metadataStore.getState.state)

  /**
    * Changes the run's state to `state`, because of `errors` or for `reason`: the one way the
    * state of a run changes. The change is written to the run's log, and nowhere else: the
    * execution's row is the Dashboard service's, which closes it from the log. `errors` join the
    * run's errors; a change that ends the run also stamps its end time.
    *
    * A run ends once. One that has ended keeps the state, the errors and the end time it ended
    * with, whatever is asked of it after: nothing is recorded, and this answers false. Changes
    * are taken one at a time, so of two endings that race, the first is the run's.
    *
    * @return whether the run took the state
    */
  def transitionTo(
      state: WorkflowAggregatedState,
      errors: Seq[WorkflowFatalError] = Nil,
      reason: Option[String] = None
  ): Boolean = {
    var taken = false
    metadataStore.updateState { metadata =>
      if (ExecutionStateStore.EndStates.contains(metadata.state)) {
        metadata
      } else {
        taken = true
        ExecutionStateStore.logged(state).foreach(recorder.state(_, errors, reason))
        WorkflowMetricsRecorder.onStateChange(metadata.executionId, metadata.state, state)
        metadata.withState(state).addFatalErrors(errors: _*)
      }
    }
    if (taken && ExecutionStateStore.EndStates.contains(state)) {
      statsStore.updateState(_.withEndTimeStamp(System.currentTimeMillis()))
    }
    taken
  }
}
