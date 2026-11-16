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

import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{
  ExecutionMode,
  PhysicalPlanCodec,
  PortIdentity,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.compiler.{CompilationErrorHandling, WorkflowCompiler}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class PlanToRunSpec extends AnyFlatSpec with Matchers {

  private def newContext(): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(31),
      executionId = ExecutionIdentity(32),
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 77,
        executionMode = ExecutionMode.MATERIALIZED
      ),
      cuid = Some(33),
      warehouse = Some("warehouse-34")
    )

  // The scan reads a fixture on the local disk, and no operator names a dataset or model.
  private def newCompiler(context: WorkflowContext): WorkflowCompiler =
    new WorkflowCompiler(
      context,
      TestOperators.fixtureFileResolver,
      TestOperators.fixtureRepositoryResolver,
      Some(TestOperators.fixtureMountRoot)
    )

  private def pojo(operators: List[LogicalOp], links: List[LogicalLink]): LogicalPlanPojo =
    LogicalPlanPojo(operators, links, List.empty, List.empty)

  private def chain(operators: LogicalOp*): List[LogicalLink] =
    operators
      .sliding(2)
      .collect {
        case Seq(from, to) =>
          LogicalLink(
            from.operatorIdentifier,
            PortIdentity(),
            to.operatorIdentifier,
            PortIdentity()
          )
      }
      .toList

  /** A scan and the keyword searches after it, one after another. */
  private def searches(count: Int): List[LogicalOp] =
    TestOperators.smallCsvScanOpDesc() ::
      List.fill(count)(TestOperators.keywordSearchOpDesc("Region", "Asia"))

  "PlanToRun.make" should
    "save the plan its compile makes for its compiler's run, with the ports whose results are stored" in {
    val operators = searches(1)
    val context = newContext()

    val planToRun = PlanToRun.make(newCompiler(context), pojo(operators, chain(operators: _*)))

    // The plan as the compile makes it, and the ports whose results are stored.
    val compiledContext = newContext()
    val compiled = Workflow.fromCompilationResult(
      compiledContext,
      newCompiler(compiledContext).compile(
        pojo(operators, chain(operators: _*)),
        CompilationErrorHandling.Strict
      )
    )
    val storedPorts = compiledContext.workflowSettings.outputPortsNeedingStorage
    storedPorts should not be empty

    val (planContext, plan) =
      PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(planToRun.savedPlan))
    planContext.workflowId shouldBe context.workflowId
    planContext.executionId shouldBe context.executionId
    planContext.workflowSettings shouldBe
      newContext().workflowSettings.copy(outputPortsNeedingStorage = storedPorts)
    planContext.warehouse shouldBe context.warehouse
    // A plan does not choose the computing unit it runs on.
    planContext.cuid shouldBe None
    TestUtils.assertReadBackFrom(compiled.physicalPlan, plan)

    // The logical plan comes with it, for an operator changed while the run is paused.
    planToRun.logicalPlan.getTerminalOperatorIds shouldBe List(operators.last.operatorIdentifier)
  }

  it should "leave the run's context as it was, as the engine takes the settings from the plan" in {
    val operators = searches(1)
    val context = newContext()

    PlanToRun.make(newCompiler(context), pojo(operators, chain(operators: _*)))

    val untouched = newContext()
    context.workflowId shouldBe untouched.workflowId
    context.executionId shouldBe untouched.executionId
    context.workflowSettings shouldBe untouched.workflowSettings
    context.workflowSettings.outputPortsNeedingStorage shouldBe empty
    context.cuid shouldBe untouched.cuid
    context.warehouse shouldBe untouched.warehouse
  }

  it should "save a workflow as the same text every time" in {
    // More than four operators, which the plan holds in no order of their own.
    val operators = searches(5)
    val made = List.fill(2) {
      PlanToRun.make(newCompiler(newContext()), pojo(operators, chain(operators: _*)))
    }
    made.map(_.savedPlan).distinct should have size 1
  }

  it should "fail on a workflow that does not compile, saving nothing" in {
    val scan = new CSVScanSourceOpDesc() // no file chosen

    val failure = intercept[Throwable] {
      PlanToRun.make(newCompiler(newContext()), pojo(List(scan), List.empty))
    }

    failure.getMessage should include("No file selected")
  }

  it should "refuse a run whose batches hold no tuple, in the words of the editor's setting" in {
    val operators = searches(1)
    val context = newContext()
    context.workflowSettings = context.workflowSettings.copy(dataTransferBatchSize = 0)

    val failure = intercept[IllegalArgumentException] {
      PlanToRun.make(newCompiler(context), pojo(operators, chain(operators: _*)))
    }

    failure.getMessage shouldBe
      "The workflow's Data Transfer Batch Size is 0; set it to 1 or more."
  }
}
