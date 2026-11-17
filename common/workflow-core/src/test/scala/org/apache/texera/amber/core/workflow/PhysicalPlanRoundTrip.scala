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

package org.apache.texera.amber.core.workflow

import org.scalatest.Assertions

/**
  * Saves a plan with [[PhysicalPlanCodec]], reads it back, and fails unless what comes back is
  * the plan that was saved. For the codec's spec, and for the specs of what makes plans to run.
  */
object PhysicalPlanRoundTrip extends Assertions {

  // Stands in for every operator's schema propagation function: the one field of a plan that is
  // not saved.
  private val propagation = SchemaPropagationFunc(schemas => schemas)

  /**
    * Saves `plan`, made to run under `context`, with no replay, replay log or input, and reads it
    * back, as `assertRoundTrips(ExecutionPlan(context, plan))`.
    *
    * @return the JSON text
    */
  def assertRoundTrips(context: WorkflowContext, plan: PhysicalPlan): String =
    assertRoundTrips(ExecutionPlan(context, plan))

  /**
    * Saves `plan` and reads it back from the message and from its JSON text. Fails unless both
    * reads give `plan` (see [[assertSameExecutionPlan]]), and saving what was read gives the same
    * message again.
    *
    * @return the JSON text
    */
  def assertRoundTrips(plan: ExecutionPlan): String = {
    val stored = PhysicalPlanCodec.encode(plan)
    val json = PhysicalPlanCodec.toJson(stored)
    val parsed = PhysicalPlanCodec.fromJson(json)
    assert(parsed == stored, s"the JSON reads back to another message:\n$json")
    Seq("the message" -> stored, "its JSON" -> parsed).foreach {
      case (source, message) =>
        withClue(s"read from $source: ") {
          val read = PhysicalPlanCodec.decode(message)
          assertSameExecutionPlan(plan, read)
          val savedAgain = PhysicalPlanCodec.encode(read)
          assert(savedAgain == stored, "saving the plan read back gives another message")
        }
    }
    json
  }

  /**
    * Fails unless `read` is `original` as a saved plan reads back: the same context (see
    * [[assertSameContext]]) and physical plan (see [[assertSamePlan]]), replay and replay log,
    * and inputs, in the order a saved plan lists them: by the operator's id, then the name.
    */
  def assertSameExecutionPlan(original: ExecutionPlan, read: ExecutionPlan): Unit = {
    assertSameContext(original.context, read.context)
    assertSamePlan(original.plan, read.plan)
    assert(read.replay == original.replay)
    assert(read.replayLog == original.replayLog)
    assert(
      read.inputs == original.inputs.sortBy(input => (input.logicalOperatorId.id, input.name)),
      "the inputs differ, or are not in the order of their operators' ids, then their names"
    )
  }

  /** Fails unless `read` has the ids, settings, warehouse and cost hints of `original`. */
  def assertSameContext(original: WorkflowContext, read: WorkflowContext): Unit = {
    assert(read.workflowId == original.workflowId)
    assert(read.executionId == original.executionId)
    assert(read.workflowSettings == original.workflowSettings)
    assert(
      read.workflowSettings.outputPortsNeedingStorage.toList ==
        original.workflowSettings.outputPortsNeedingStorage.toList,
      "the stored ports are iterated in another order"
    )
    assert(read.warehouse == original.warehouse)
    assert(read.costHints == original.costHints)
  }

  /**
    * Fails unless `read` is `original` but for each operator's schema propagation function, with
    * each operator's ports, and each port's links (compared with the operators), in the order
    * `original` has them.
    */
  def assertSamePlan(original: PhysicalPlan, read: PhysicalPlan): Unit = {
    assert(withoutPropagation(read) == withoutPropagation(original), "the plans differ")
    original.operators.foreach { op =>
      val readOp = read.getOperator(op.id)
      withClue(s"operator ${op.id.logicalOpId.id}-${op.id.layerName}: ") {
        assert(readOp.inputPorts.keys.toList == op.inputPorts.keys.toList)
        assert(readOp.outputPorts.keys.toList == op.outputPorts.keys.toList)
        // An Attribute equals one whose name differs only in case; a saved name does not.
        assert(exactSchemas(readOp) == exactSchemas(op))
      }
    }
  }

  private def withoutPropagation(plan: PhysicalPlan): PhysicalPlan =
    PhysicalPlan(plan.operators.map(_.copy(propagateSchema = propagation)), plan.links)

  private def exactSchemas(op: PhysicalOp): List[Any] =
    (op.inputPorts.toList ++ op.outputPorts.toList).map {
      case (id, (port, _, schema)) =>
        (port, id, schema.toOption.map(_.attributes.map(a => (a.getName, a.getType))))
    }
}
