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

import org.apache.texera.amber.core.executor.{InputFile, OperatorInputs}
import org.apache.texera.amber.core.storage.{LakeFSDatasetVersionLister, LakeFSInputLinker}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  ExecutionMode,
  PhysicalPlanCodec,
  PortIdentity,
  ReplaySource,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.compiler.{
  CompilationErrorHandling,
  WorkflowCompilationFailed,
  WorkflowCompiler
}
import org.apache.texera.web.service.execution.UserEnvironmentResolver
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI

class PlanToRunSpec extends AnyFlatSpec with Matchers {

  private def newContext(): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(31),
      executionId = ExecutionIdentity(32),
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 77,
        executionMode = ExecutionMode.MATERIALIZED
      ),
      warehouse = Some("warehouse-34")
    )

  // The scan reads a fixture on the local disk, through a link of the fixture linker's, and no
  // operator names a dataset or model.
  private def newCompiler(context: WorkflowContext): WorkflowCompiler =
    new WorkflowCompiler(context, TestUtils.fixtureBindings)

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

  "PlanToRun.bindingsFor" should "bind a plan to the links the deployment's linker signs" in {
    PlanToRun.bindingsFor(7).inputLinker should be theSameInstanceAs LakeFSInputLinker.forDeployment
  }

  it should "bind a plan to the listings of the dataset versions LakeFS keeps" in {
    PlanToRun.bindingsFor(7).lister shouldBe a[LakeFSDatasetVersionLister]
  }

  it should "bind a plan to the Python environments its user keeps at the Dashboard" in {
    // That it is the plan's user whose environments are found is `ExecutionResourceSpec`'s.
    PlanToRun.bindingsFor(7).environments shouldBe a[UserEnvironmentResolver]
  }

  "PlanToRun.make" should
    "save the plan its compile makes for its compiler's run, with the ports whose results are stored" in {
    val operators = searches(1)
    val context = newContext()

    val savedPlan = PlanToRun.make(newCompiler(context), pojo(operators, chain(operators: _*)))

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

    val executionPlan = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(savedPlan))
    val planContext = executionPlan.context
    planContext.workflowId shouldBe context.workflowId
    planContext.executionId shouldBe context.executionId
    planContext.workflowSettings shouldBe
      newContext().workflowSettings.copy(outputPortsNeedingStorage = storedPorts)
    planContext.warehouse shouldBe context.warehouse
    planContext.costHints shouldBe None
    TestUtils.assertReadBackFrom(compiled.physicalPlan, executionPlan.plan)
    // Given no replay or replay log, the plan replays nothing and writes no replay log.
    executionPlan.replay shouldBe None
    executionPlan.replayLog shouldBe None
    // The file its scan reads is the one file the plan reads through a link: the scan's own.
    val scanned = TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath)
    val link = TestOperators.fixtureInputLinker.link(scanned)
    executionPlan.plan.operators.flatMap(op => op.inputs.files.map(op.id.logicalOpId -> _)) shouldBe
      Set(
        operators.head.operatorIdentifier ->
          InputFile(scanned.toASCIIString, link.url, link.expiresAtMs)
      )
  }

  it should "save a plan that reads nothing from outside the run with no input" in {
    val text = new TextInputSourceOpDesc()
    text.textInput = "north\nsouth"

    val savedPlan = PlanToRun.make(newCompiler(newContext()), pojo(List(text), List.empty))

    PhysicalPlanCodec
      .decode(PhysicalPlanCodec.fromJson(savedPlan))
      .plan
      .operators
      .map(_.inputs) shouldBe Set(OperatorInputs.defaultInstance)
  }

  it should "save the run's cost hints with the plan, whatever operators they name" in {
    val operators = searches(1)
    val context = newContext()
    val hints = CostHints(
      ExecutionIdentity(30),
      Map(operators.head.operatorIdentifier.id -> 2.5, "an-operator-removed-since" -> 0.0)
    )
    context.costHints = Some(hints)

    val savedPlan = PlanToRun.make(newCompiler(context), pojo(operators, chain(operators: _*)))

    PhysicalPlanCodec
      .decode(PhysicalPlanCodec.fromJson(savedPlan))
      .context
      .costHints shouldBe Some(hints)
    context.costHints shouldBe Some(hints)
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
    context.warehouse shouldBe untouched.warehouse
    context.costHints shouldBe untouched.costHints
  }

  it should "save a workflow as the same text every time" in {
    // More than four operators, which the plan holds in no order of their own.
    val operators = searches(5)
    val made = List.fill(2) {
      PlanToRun.make(newCompiler(newContext()), pojo(operators, chain(operators: _*)))
    }
    made.distinct should have size 1
  }

  it should "fail with each operator's error on a workflow that does not compile" in {
    val scan = new CSVScanSourceOpDesc() // no file chosen

    val failure = intercept[WorkflowCompilationFailed] {
      PlanToRun.make(newCompiler(newContext()), pojo(List(scan), List.empty))
    }

    failure.operatorErrors.keySet shouldBe Set(scan.operatorIdentifier)
    failure.operatorErrors(scan.operatorIdentifier).message should include("No file selected")
  }

  it should "save the replay and the replay log it is given with the plan" in {
    val operators = searches(1)
    val replay = ReplaySource(
      ExecutionIdentity(30),
      new URI("file:///var/texera/logs/31/30/"),
      "interaction-1"
    )
    val replayLog = new URI("file:///var/texera/logs/31/32/")

    val savedPlan = PlanToRun.make(
      newCompiler(newContext()),
      pojo(operators, chain(operators: _*)),
      Some(replay),
      Some(replayLog)
    )

    val executionPlan = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(savedPlan))
    executionPlan.replay shouldBe Some(replay)
    executionPlan.replayLog shouldBe Some(replayLog)
  }

  it should "refuse to save a replay or a replay log the engine could not find" in {
    val operators = searches(1)
    def make(replay: Option[ReplaySource], replayLog: Option[URI]): String =
      PlanToRun.make(
        newCompiler(newContext()),
        pojo(operators, chain(operators: _*)),
        replay,
        replayLog
      )
    val log = new URI("file:///var/texera/logs/31/30/")
    Seq(
      (None, Some(new URI("logs/31/32/"))) ->
        "The plan writes its replay log to 'logs/31/32/', which is not an absolute URI.",
      (Some(ReplaySource(ExecutionIdentity(30), new URI("logs/31/30/"), "i")), None) ->
        "The plan replays the log of execution 30 at 'logs/31/30/', which is not an absolute URI.",
      (Some(ReplaySource(ExecutionIdentity(30), log, " ")), None) ->
        "The plan replays the log of execution 30 up to an interaction it does not name.",
      (Some(ReplaySource(ExecutionIdentity(0), log, "i")), None) ->
        "The plan replays the log of execution 0, but an execution's id is at least 1."
    ).foreach {
      case ((replay, replayLog), message) =>
        withClue(s"$message: ") {
          the[IllegalArgumentException] thrownBy make(replay, replayLog) should have message
            message
        }
    }
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
