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

package org.apache.texera.amber.engine.common.executionrecord

import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError

import java.util.concurrent.ConcurrentLinkedQueue
import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.CollectionHasAsScala

/**
  * A recorder that writes nothing and keeps every change of state it is told, in order, for a
  * spec to see what a run hands its record.
  */
class RecordingExecutionRecorder extends ExecutionRecorder {
  import RecordingExecutionRecorder.StateChange

  private val told = new ConcurrentLinkedQueue[StateChange]()

  override def state(state: String, errors: Seq[WorkflowFatalError], reason: Option[String]): Unit =
    told.add(StateChange(state, errors, reason))

  override def awaitIdle(timeout: FiniteDuration): Boolean = true

  /** The changes of state it was told, oldest first. */
  def changes: Seq[StateChange] = told.asScala.toSeq

  /** The state and the reason of each change it was told, oldest first. */
  def states: Seq[(String, Option[String])] = changes.map(change => (change.state, change.reason))
}

object RecordingExecutionRecorder {
  final case class StateChange(
      state: String,
      errors: Seq[WorkflowFatalError],
      reason: Option[String]
  )
}
