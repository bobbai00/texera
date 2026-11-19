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

package org.apache.texera.common.compiler

import org.apache.texera.amber.core.executor.{InputFile, OperatorInputs}
import org.apache.texera.amber.core.storage.{LakeFSDatasetVersionLister, LakeFSInputFileLocator}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionMode,
  ExecutionPlan,
  GlobalPortIdentity,
  PhysicalPlanCodec,
  PhysicalPlanRoundTrip,
  PortIdentity,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.{FixtureInputs, LogicalOp, TestOperators}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.dao.MockTexeraDB
import org.jooq.exception.DataAccessException
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class PlanToRunSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll with MockTexeraDB {

  // What a plan is bound to holds the site's settings, which are read from the database.
  override protected def beforeAll(): Unit = initializeDBAndReplaceDSLContext()

  override protected def afterAll(): Unit = closeConnectionPool()

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

  // The scan reads a fixture on the local disk, which is where the fixture locator says it is
  // kept; no operator names a dataset, a model or a Python environment.
  private val fixtureBindings: CompileFor.Run = CompileFor.Run(
    files = TestOperators.fixtureFileResolver,
    settings = CompileSettings.Default,
    locator = FixtureInputs.locator,
    lister = FixtureInputs.lister,
    repositories = TestOperators.fixtureRepositoryResolver,
    environments = name => throw PythonEnvironmentNotResolved.noSuchEnvironment(name)
  )

  private def newCompiler(context: WorkflowContext): WorkflowCompiler =
    new WorkflowCompiler(context, fixtureBindings)

  private def pojo(operators: List[LogicalOp], links: List[LogicalLink]): LogicalPlanPojo =
    LogicalPlanPojo(operators, links, List.empty, List.empty)

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: LogicalOp, to: LogicalOp): LogicalLink =
    LogicalLink(from.operatorIdentifier, PortIdentity(), to.operatorIdentifier, PortIdentity())

  private def chain(operators: LogicalOp*): List[LogicalLink] =
    operators.sliding(2).collect { case Seq(from, to) => link(from, to) }.toList

  /** A scan and the keyword searches after it, one after another. */
  private def searches(count: Int): List[LogicalOp] =
    TestOperators.smallCsvScanOpDesc() ::
      List.fill(count)(TestOperators.keywordSearchOpDesc("Region", "Asia"))

  /** The plan `made`, read as the service that links its files reads it. */
  private def planOf(made: String): ExecutionPlan =
    PhysicalPlanCodec.decodeUnlinked(PhysicalPlanCodec.fromJson(made))

  /** scan -> search -> search-2, and beside them x -> y -> x, a cycle the first three never reach. */
  private def withCycleElsewhere(): LogicalPlanPojo = {
    val scan = named(TestOperators.smallCsvScanOpDesc(), "scan")
    val search = named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search")
    val second = named(TestOperators.keywordSearchOpDesc("Country", "China"), "search-2")
    val x = named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "x")
    val y = named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "y")
    LogicalPlanPojo(
      List(scan, search, second, x, y),
      List(link(scan, search), link(search, second), link(x, y), link(y, x)),
      List("search-2"),
      List("scan", "x")
    )
  }

  "PlanToRun.bindingsFor" should "bind a plan to where LakeFS keeps its files, with none of the object store's keys" in {
    PlanToRun.bindingsFor(7).locator should be theSameInstanceAs LakeFSInputFileLocator
  }

  it should "bind a plan to the listings of the dataset versions LakeFS keeps" in {
    PlanToRun.bindingsFor(7).lister shouldBe a[LakeFSDatasetVersionLister]
  }

  it should "bind a plan to the Python environments its user keeps at the Dashboard" in {
    // That it is the plan's user whose environments are found is `UserEnvironmentResolverSpec`'s.
    PlanToRun.bindingsFor(7).environments shouldBe a[UserEnvironmentResolver]
  }

  it should "throw, as it is, a read of the site's settings the database does not answer" in {
    // Bound to the defaults instead, a plan could run under another limit than the site's.
    whileDatabaseDoesNotAnswer {
      a[DataAccessException] should be thrownBy PlanToRun.bindingsFor(7)
    }
  }

  "PlanToRun.make" should
    "save the plan its compile makes for the run, with the ports whose results are stored" in {
    val operators = searches(1)
    val context = newContext()

    val made = PlanToRun.make(context, fixtureBindings, pojo(operators, chain(operators: _*)))

    // The plan as the compile makes it, and the ports the compile finds are stored.
    val compiled = newCompiler(newContext()).compile(pojo(operators, chain(operators: _*)))
    val storedPorts = compiled.outputPortsNeedingStorage
    storedPorts should not be empty

    val executionPlan = planOf(made)
    val planContext = executionPlan.context
    planContext.workflowId shouldBe context.workflowId
    planContext.executionId shouldBe context.executionId
    planContext.workflowSettings shouldBe
      newContext().workflowSettings.copy(outputPortsNeedingStorage = storedPorts)
    planContext.warehouse shouldBe context.warehouse
    PhysicalPlanRoundTrip.assertSamePlan(compiled.physicalPlan.get, executionPlan.plan)
    // What only the service that creates the execution has is left for it to add: the run's cost
    // hints, the replay log it replays and the one it writes.
    planContext.costHints shouldBe None
    executionPlan.replay shouldBe None
    executionPlan.replayLog shouldBe None
    // The file its scan reads is the one file the plan reads, where the locator says it is
    // kept, and with no link: a compile holds none of the object store's keys.
    val scanned = TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath)
    executionPlan.plan.operators.flatMap(op => op.inputs.files.map(op.id.logicalOpId -> _)) shouldBe
      Set(
        operators.head.operatorIdentifier ->
          InputFile(scanned.toASCIIString, physicalAddress = scanned.toString)
      )
  }

  it should "make a plan that only reads back as one whose files are still to be linked" in {
    val operators = searches(1)

    val made = PlanToRun.make(newContext(), fixtureBindings, pojo(operators, chain(operators: _*)))

    // A computing unit reads only a plan whose files have their links.
    val refusal = intercept[IllegalArgumentException] {
      PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(made))
    }
    refusal.getMessage should include("has no link to its file")
    // Linked, it is one.
    val unlinked = planOf(made)
    val linked = unlinked.copy(plan = unlinked.plan.linkedBy(FixtureInputs.linker))
    PhysicalPlanRoundTrip.assertRoundTrips(linked)
  }

  it should "save a plan that reads nothing from outside the run with no input" in {
    val text = new TextInputSourceOpDesc()
    text.textInput = "north\nsouth"

    val made = PlanToRun.make(newContext(), fixtureBindings, pojo(List(text), List.empty))

    planOf(made).plan.operators.map(_.inputs) shouldBe Set(OperatorInputs.defaultInstance)
  }

  it should "leave the run's context as it was, as the engine takes the settings from the plan" in {
    val operators = searches(1)
    val context = newContext()

    PlanToRun.make(context, fixtureBindings, pojo(operators, chain(operators: _*)))

    val untouched = newContext()
    context.workflowId shouldBe untouched.workflowId
    context.executionId shouldBe untouched.executionId
    context.workflowSettings shouldBe untouched.workflowSettings
    context.workflowSettings.outputPortsNeedingStorage shouldBe empty
    context.warehouse shouldBe untouched.warehouse
    context.costHints shouldBe untouched.costHints
  }

  it should "find the ports whose results are stored itself, whatever the run's settings name" in {
    val operators = searches(1)
    val context = newContext()
    val found = PlanToRun
      .make(newContext(), fixtureBindings, pojo(operators, chain(operators: _*)))
    val ports = planOf(found).context.workflowSettings.outputPortsNeedingStorage
    // Settings that name the scan's port, which the compile does not store.
    val scanPort = planOf(found).plan.operators
      .find(_.id.logicalOpId == operators.head.operatorIdentifier)
      .map(op => GlobalPortIdentity(op.id, op.outputPorts.keys.head))
      .get
    ports should not contain scanPort
    context.workflowSettings =
      context.workflowSettings.copy(outputPortsNeedingStorage = Set(scanPort))

    val made = PlanToRun.make(context, fixtureBindings, pojo(operators, chain(operators: _*)))

    planOf(made).context.workflowSettings.outputPortsNeedingStorage shouldBe ports
  }

  it should "save a workflow as the same text every time" in {
    // More than four operators, which the plan holds in no order of their own.
    val operators = searches(5)
    val made = List.fill(2) {
      PlanToRun.make(newContext(), fixtureBindings, pojo(operators, chain(operators: _*)))
    }
    made.distinct should have size 1
  }

  it should "compile a workflow whose request leaves out the results to view and reuse" in {
    val operators = searches(1)
    val sent = pojo(operators, chain(operators: _*))
      .copy(opsToViewResult = null, opsToReuseResult = null)

    val made = PlanToRun.make(newContext(), fixtureBindings, sent)

    planOf(made).plan.operators.map(_.id.logicalOpId) shouldBe
      operators.map(_.operatorIdentifier).toSet
  }

  it should "compile only the target and what is upstream of it, given a target" in {
    val made =
      PlanToRun.make(newContext(), fixtureBindings, withCycleElsewhere(), target = Some("search"))

    val plan = planOf(made)
    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan", "search")
    // The run views the target's result.
    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId) shouldBe
      Set(OperatorIdentity("search"))
  }

  it should "check only the part of the workflow it compiles, given a target" in {
    // Up to an operator on the cycle, the cycle is compiled; with no target, the whole workflow
    // is.
    Seq(Some("y"), None).foreach { target =>
      withClue(s"target $target: ") {
        the[WorkflowRefused] thrownBy {
          PlanToRun.make(newContext(), fixtureBindings, withCycleElsewhere(), target)
        } should have message "The workflow's links form a cycle: x -> y -> x."
      }
    }
  }

  it should "refuse a target the workflow does not have" in {
    Seq("ghost", "").foreach { target =>
      // Not the whole workflow in its place.
      the[WorkflowRefused] thrownBy {
        PlanToRun.make(newContext(), fixtureBindings, withCycleElsewhere(), Some(target))
      } should have message s"The workflow has no operator $target to run up to."
    }
  }

  it should "refuse a workflow that is no graph the compiler reads, as no operator's error" in {
    val operators = searches(1)
    val dangling = pojo(operators, chain(operators: _*)).copy(links =
      List(
        LogicalLink(
          operators.head.operatorIdentifier,
          PortIdentity(),
          OperatorIdentity("ghost"),
          PortIdentity()
        )
      )
    )
    val scanId = operators.head.operatorIdentifier.id
    Seq(
      dangling ->
        s"The link from $scanId to ghost names operator ghost, which the workflow does not have.",
      pojo(null, Nil) -> "The workflow lists no operators.",
      pojo(operators, null) -> "The workflow lists no links.",
      (null: LogicalPlanPojo) -> "The request has no logical plan."
    ).foreach {
      case (workflow, problem) =>
        withClue(s"$problem: ") {
          val refused = intercept[WorkflowRefused] {
            PlanToRun.make(newContext(), fixtureBindings, workflow)
          }
          refused.getMessage shouldBe problem
          refused should not be a[WorkflowCompilationFailed]
        }
    }
  }

  it should "fail with each operator's error on a workflow that does not compile" in {
    val scan = new CSVScanSourceOpDesc() // no file chosen

    val failure = intercept[WorkflowCompilationFailed] {
      PlanToRun.make(newContext(), fixtureBindings, pojo(List(scan), List.empty))
    }

    failure.operatorErrors.keySet shouldBe Set(scan.operatorIdentifier)
    failure.operatorErrors(scan.operatorIdentifier).message should include("No file selected")
  }

  it should "refuse a run whose batches hold no tuple, in the words of the editor's setting" in {
    val operators = searches(1)
    val context = newContext()
    context.workflowSettings = context.workflowSettings.copy(dataTransferBatchSize = 0)

    val failure = intercept[WorkflowRefused] {
      PlanToRun.make(context, fixtureBindings, pojo(operators, chain(operators: _*)))
    }

    failure.getMessage shouldBe
      "The workflow's Data Transfer Batch Size is 0; set it to 1 or more."
  }
}
