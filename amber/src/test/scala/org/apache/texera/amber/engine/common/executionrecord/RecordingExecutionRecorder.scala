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
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessage
import org.apache.texera.amber.engine.common.executionruntimestate.OperatorMetrics

import java.util.concurrent.ConcurrentLinkedQueue
import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.CollectionHasAsScala

/**
  * A recorder that writes nothing and keeps everything it is told, in order, for a spec to see
  * what a run hands its record, and on which thread.
  */
class RecordingExecutionRecorder extends ExecutionRecorder {
  import RecordingExecutionRecorder._

  private val everything = new ConcurrentLinkedQueue[Told]()
  private val callers = new ConcurrentLinkedQueue[Thread]()

  private def keep(told: Told): Unit = {
    everything.add(told)
    callers.add(Thread.currentThread())
  }

  override def state(state: String, errors: Seq[WorkflowFatalError], reason: Option[String]): Unit =
    keep(StateChange(state, errors, reason))

  override def statistics(metrics: Map[String, OperatorMetrics]): Unit = keep(Statistics(metrics))

  override def console(operatorId: String, message: ConsoleMessage): Unit =
    keep(Console(operatorId, message))

  override def awaitIdle(timeout: FiniteDuration): Boolean = true

  /** Everything it was told, oldest first. */
  def told: Seq[Told] = everything.asScala.toSeq

  /** The thread that told it each thing, oldest first. */
  def tellers: Seq[Thread] = callers.asScala.toSeq

  /** The changes of state it was told, oldest first. */
  def changes: Seq[StateChange] = told.collect { case change: StateChange => change }

  /** The state and the reason of each change it was told, oldest first. */
  def states: Seq[(String, Option[String])] = changes.map(change => (change.state, change.reason))

  /** The operators' numbers it was told, oldest first. */
  def samples: Seq[Map[String, OperatorMetrics]] =
    told.collect { case Statistics(metrics) => metrics }

  /** The console messages it was told, each with its operator, oldest first. */
  def consoles: Seq[(String, ConsoleMessage)] =
    told.collect { case Console(operatorId, message) => (operatorId, message) }
}

object RecordingExecutionRecorder {

  /** One thing a recorder was told. */
  sealed trait Told

  final case class StateChange(
      state: String,
      errors: Seq[WorkflowFatalError],
      reason: Option[String]
  ) extends Told

  final case class Statistics(metrics: Map[String, OperatorMetrics]) extends Told

  final case class Console(operatorId: String, message: ConsoleMessage) extends Told
}
