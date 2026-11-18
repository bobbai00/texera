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

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.state.StateReferencing
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  OperatorUpdate,
  PhysicalOp,
  PhysicalPlanCodec,
  PortIdentity,
  RepositoryMounts
}
import org.apache.texera.amber.operator.filter.{
  ComparisonType,
  FilterPredicate,
  SpecializedFilterOpDesc
}
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.{
  LambdaAttributeUnit,
  PythonLambdaFunctionOpDesc,
  PythonUDFOpDescV2,
  PythonUdfUiParameterInjector
}
import org.apache.texera.amber.operator.{LogicalOp, StateTransferFunc, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.UpdateToRun.RunningOperator
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import scala.util.{Failure, Try}

/**
  * A change to an operator of a paused execution, made into the operator to run in its place:
  * what is made, and what is refused and how. That the Dashboard service asks for one and
  * stores it is `OperatorUpdatesSpec`'s.
  */
class UpdateToRunSpec extends AnyFlatSpec with Matchers {

  private val workflowId = WorkflowIdentity(7)
  private val executionId = ExecutionIdentity(42)
  private val updateId = "update-1"

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  private val udfCode =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    @overrides
      |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
      |        yield tuple_
      |""".stripMargin

  /** The UDF's code once changed, tagging what it changes. */
  private def changedCode(tag: String): String =
    udfCode.replace("yield tuple_", s"""tuple_["Region"] = "$tag"
      |        yield tuple_""".stripMargin)

  private def udf(
      id: String = "udf",
      code: String = udfCode,
      environment: Option[String] = None,
      parameters: List[UiUDFParameter] = Nil
  ): PythonUDFOpDescV2 = {
    val op = named(TestOperators.pythonOpDesc(), id)
    op.code = code
    environment.foreach { name =>
      op.defaultEnv = false
      op.envName = name
    }
    op.uiParameters = parameters
    op
  }

  private def limit(id: String, rows: Int): LimitOpDesc = {
    val op = named(new LimitOpDesc, id)
    op.limit = rows
    op
  }

  /** A scan of a fixture file, then a Python UDF on what it reads, then a Limit. */
  private def udfPlan(environment: Option[String] = None): LogicalPlanPojo =
    LogicalPlanPojo(
      List(
        named(TestOperators.smallCsvScanOpDesc(), "scan"),
        udf(environment = environment),
        limit("limit", 5)
      ),
      List(link("scan", "udf"), link("udf", "limit")),
      List.empty,
      List.empty
    )

  /** A Python Lambda that adds the column `Derived`, worked out by `expression`. */
  private def lambda(expression: String): PythonLambdaFunctionOpDesc = {
    val op = named(new PythonLambdaFunctionOpDesc, "lambda")
    op.lambdaAttributeUnits = List(
      new LambdaAttributeUnit("Add New Column", expression, "Derived", AttributeType.INTEGER)
    )
    op
  }

  private def filter(id: String, value: String): SpecializedFilterOpDesc = {
    val op = named(new SpecializedFilterOpDesc, id)
    op.predicates = List(new FilterPredicate("line", ComparisonType.EQUAL_TO, value))
    op
  }

  /** A Limit parsed as the editor sends one whose limit is the loop variable `name`. */
  private def limitReferring(id: String, name: String): LogicalOp =
    objectMapper.readValue(
      s"""{"operatorID":"$id","limit":"$$$name","operatorType":"Limit"}""",
      classOf[LogicalOp]
    )

  /**
    * lines -> pre -> start -> typed -> limit2 -> filter -> bound -> end, as the plan row of an
    * execution keeps the workflow it was compiled from: `typed`, `limit2`, `filter` and `bound`
    * are inside the loop block; `typed` refers to the loop variable `n` with a typed reference,
    * and `bound` to `x` with the whole string "$x"; `pre`, outside every block, holds the
    * literal "$x".
    */
  private def loopPlan(): LogicalPlanPojo = {
    val lines = named(new TextInputSourceOpDesc(), "lines")
    lines.textInput = "0\n1"
    val start = named(new LoopStartOpDesc(), "start")
    start.initialization = "i = 0"
    start.output = "table.iloc[i]"
    val end = named(new LoopEndOpDesc(), "end")
    end.update = "i += 1"
    end.condition = "i < len(table)"
    val ops = List(
      lines,
      filter("pre", "$x"),
      start,
      limitReferring("typed", "n"),
      limit("limit2", 3),
      filter("filter", "Asia"),
      filter("bound", "$x"),
      end
    )
    val ids = ops.map(_.operatorIdentifier.id)
    // Written and parsed, as the workflow kept beside a plan is.
    objectMapper.readValue(
      LogicalPlanPojo(
        ops,
        ids.zip(ids.tail).map { case (from, to) => link(from, to) },
        List.empty,
        List.empty
      ).toJson,
      classOf[LogicalPlanPojo]
    )
  }

  private def datasetParameter(value: String): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = value
    parameter
  }

  /** What the plan runs for an operator of one layer, in the engine's own environment. */
  private val main = Seq(RunningOperator("main", None))

  /** What an operator answers when it is asked to build the operator a change makes of it. */
  private type Reconfiguration = Try[(PhysicalOp, Option[StateTransferFunc])]

  /** The change made to run, as the compiling service makes it. */
  private def make(
      changed: LogicalOp,
      workflow: LogicalPlanPojo = udfPlan(),
      running: Seq[RunningOperator] = main,
      repositories: RepositoryVersionResolver = TestOperators.fixtureRepositoryResolver,
      reconfiguration: Option[() => Reconfiguration] = None
  ): UpdateToRun.Made =
    UpdateToRun.make(
      workflowId,
      executionId,
      updateId,
      workflow,
      changed,
      running,
      repositories,
      (current, changed, workflowId, executionId) =>
        reconfiguration.fold(
          current.runtimeReconfiguration(workflowId, executionId, current, changed)
        )(_())
    )

  private def decoded(made: UpdateToRun.Made): OperatorUpdate =
    PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(made.update))

  /** The message `body` is refused with, as a change no update can be made of. */
  private def refused(body: => Any): String = {
    val refusal = intercept[WorkflowRefused](body)
    refusal should not be a[NoSuchOperator]
    refusal.getMessage
  }

  private val udfOpId = PhysicalOpIdentity(OperatorIdentity("udf"), "main")

  "UpdateToRun.make" should "make a change into the operator to run, saved under the update's id" in {
    val made = make(udf(code = changedCode("v2")))

    // What a unit applies: the new code for the running operator, of this execution.
    decoded(made) shouldBe OperatorUpdate(
      executionId,
      updateId,
      udfOpId,
      OpExecWithCode(changedCode("v2"), "python"),
      None
    )
    // The change as the editor sent it.
    val sent = objectMapper.readValue(made.operator, classOf[LogicalOp])
    sent shouldBe a[PythonUDFOpDescV2]
    sent.operatorIdentifier shouldBe OperatorIdentity("udf")
    sent.asInstanceOf[PythonUDFOpDescV2].code shouldBe changedCode("v2")
    objectMapper.readTree(made.operator).has(StateReferencing.SIDECAR_PROPERTY) shouldBe false
  }

  it should "make a change to an operator that is built from its descriptor" in {
    val update = decoded(make(limit("limit", 9)))

    update.opId shouldBe PhysicalOpIdentity(OperatorIdentity("limit"), "main")
    objectMapper
      .readValue(
        update.opExecInitInfo.asInstanceOf[OpExecWithClassName].descString,
        classOf[LimitOpDesc]
      )
      .limit shouldBe 9
  }

  it should "pin the datasets a changed UDF names, as its plan was pinned" in {
    val changed = udf(
      code = changedCode("v2"),
      parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))
    )

    val update = decoded(make(changed))

    update.repositoryMounts shouldBe Some(RepositoryMounts(Set("dataset-1:d4t4")))
    // The code names the repository commit: the unit that runs it knows where it mounts it.
    update.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(
        changedCode("v2"),
        List(datasetParameter("dataset-1:d4t4"))
      ),
      "python"
    )
  }

  it should "change an operator inside a loop block that refers to no loop variable, and a '$x' literal outside every block" in {
    make(filter("filter", "Europe"), workflow = loopPlan())
    // Outside every block "$y" is the literal it is everywhere else.
    val literal = make(filter("pre", "$y"), workflow = loopPlan())

    objectMapper
      .readTree(literal.operator)
      .get("predicates")
      .get(0)
      .get("value")
      .asText() shouldBe "$y"
  }

  it should "refuse a change that refers to loop variables, or of an operator that does" in {
    def loopRefusal(name: String) =
      s"$name refers to loop variables, so it can't be changed while the workflow runs."

    // The running operator refers to `n`.
    refused(make(limit("typed", 7), workflow = loopPlan())) shouldBe loopRefusal("Limit")
    // The change refers to `n`, as the editor sends "$n" in an Int property.
    refused(make(limitReferring("limit2", "n"), workflow = loopPlan())) shouldBe
      loopRefusal("Limit")
    // Inside a loop block a whole-string "$x" refers to a loop variable.
    refused(make(filter("filter", "$x"), workflow = loopPlan())) shouldBe loopRefusal("Filter")
    // The running Filter `bound` holds "$x" inside the block. The workflow kept beside a plan
    // keeps it as the string it is, with no sidecar (a parse records only typed references), so
    // only the operator's place in the block tells that it refers to a loop variable.
    loopPlan().operators
      .find(_.operatorIdentifier.id == "bound")
      .get
      .stateReferences shouldBe empty
    refused(make(filter("bound", "Europe"), workflow = loopPlan())) shouldBe loopRefusal("Filter")
  }

  it should "refuse an operator that cannot be changed while it runs" in {
    refused(make(named(TestOperators.smallCsvScanOpDesc(), "scan"))) shouldBe
      "operator CSVScanSourceOpDesc does not support reconfiguration"
  }

  it should "refuse an operator that offers a change while it runs and has no way to take one" in {
    // The editor unlocks a Python Lambda for a change (supportReconfiguration), yet the operator
    // is left with LogicalOp's own runtimeReconfiguration, which throws.
    val workflow = LogicalPlanPojo(
      List(
        named(TestOperators.smallCsvScanOpDesc(), "scan"),
        lambda("tuple_['Units Sold'] * 2")
      ),
      List(link("scan", "lambda")),
      List.empty,
      List.empty
    )

    refused(make(lambda("tuple_['Units Sold'] * 3"), workflow = workflow)) shouldBe
      "operator PythonLambdaFunctionOpDesc does not support reconfiguration"
  }

  it should "refuse a change its operator fails on, in the failure's words or by its type" in {
    // No descriptor of the build answers a Failure, or throws with no message: an override may.
    val outcomes: Seq[(String, () => Reconfiguration)] = Seq(
      "this operator takes no change" ->
        (() => Failure(new RuntimeException("this operator takes no change"))),
      "this operator blew up while being reconfigured" ->
        (() => throw new IllegalStateException("this operator blew up while being reconfigured")),
      "java.lang.IllegalStateException" -> (() => throw new IllegalStateException())
    )

    outcomes.foreach {
      case (refusal, outcome) =>
        refused(make(limit("limit", 7), reconfiguration = Some(outcome))) shouldBe refusal
    }
  }

  it should "throw, as it is, a fatal error of the operator a change is made to" in {
    // Not the change's refusal: it is thrown on, so the user is not told the change was at fault.
    an[InterruptedException] should be thrownBy make(
      limit("limit", 7),
      reconfiguration = Some(() => throw new InterruptedException("stop"))
    )
  }

  it should "refuse a change the operator cannot be built from" in {
    val blank = udf(code = changedCode("v2"), environment = Some("ml"))
    blank.envName = "  "

    refused(
      make(
        blank,
        workflow = udfPlan(environment = Some("ml")),
        running = Seq(RunningOperator("main", Some("ml")))
      )
    ) shouldBe
      "Virtual Environment name is required when not using the default Python environment."
  }

  it should "refuse a change that makes an operator one of another type" in {
    refused(make(limit("udf", 3))) shouldBe
      "Operator udf is a Python UDF; a change cannot make it a Limit."
  }

  it should "refuse a change that makes an operator the running plan does not have" in {
    // A plan whose Limit runs as the layer "other": a change builds it as "main", which the unit
    // would refuse to apply. So with a plan that runs nothing for the operator.
    Seq(Seq(RunningOperator("other", None)), Seq.empty, null).foreach { running =>
      refused(make(limit("limit", 7), running = running)) shouldBe
        "The change makes Limit the operator limit-main, which the running workflow does not have."
    }
  }

  it should "refuse a change of the Python environment the operator runs in" in {
    val refusal = "The operator's Python environment cannot change while the run is paused."
    val inMl = Seq(RunningOperator("main", Some("ml")))
    def mlPlan = udfPlan(environment = Some("ml"))

    refused(make(udf(environment = Some("ml")))) shouldBe refusal
    refused(make(udf(), workflow = mlPlan, running = inMl)) shouldBe refusal
    refused(make(udf(environment = Some("other")), workflow = mlPlan, running = inMl)) shouldBe
      refusal
    // The same environment, written as the editor may, is no change of it.
    make(
      udf(code = changedCode("v2"), environment = Some("  ml  ")),
      workflow = mlPlan,
      running = inMl
    )
  }

  it should "refuse a dataset version the execution's creator cannot read" in {
    val unreadable = "/dataset/owner@x.com/secret/v1"

    refused(make(udf(parameters = List(datasetParameter(unreadable))))) should include(unreadable)
  }

  it should "throw, as it is, a failure to pin a version that is not the change's error" in {
    // A version that does not exist, or that the creator may not read, is the change's error. A
    // database that does not answer is not: it is thrown as it is, so it is not taken for the
    // user's mistake.
    val databaseDown = new IllegalStateException("the database did not answer")
    val asked = scala.collection.mutable.ListBuffer.empty[String]
    val changed = udf(
      code = changedCode("v2"),
      parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))
    )

    val thrown = intercept[IllegalStateException] {
      make(
        changed,
        repositories = versionPath => {
          asked += versionPath
          throw databaseDown
        }
      )
    }

    thrown should be theSameInstanceAs databaseDown
    asked.toList shouldBe List("/dataset/owner@x.com/sales/v1")
    // A version that is not there is the change's error, whatever it is thrown as.
    refused(
      make(changed, repositories = path => throw new FileNotFoundException(s"no $path"))
    ) should include("no /dataset/owner@x.com/sales/v1")
  }

  it should "pin nothing for a change that names no dataset or model" in {
    make(limit("limit", 7), repositories = path => fail(s"asked to pin $path"))
  }

  it should "refuse an operator the execution's workflow does not have, as one that is not there" in {
    the[NoSuchOperator] thrownBy make(limit("ghost", 7)) should have message
      "Operator ghost is not in the workflow execution 42 runs."
    // A workflow compiled up to the UDF: the Limit after it is not in what the execution runs.
    the[NoSuchOperator] thrownBy make(
      limit("limit", 7),
      workflow = udfPlan().upstreamOf("udf")
    ) should have message "Operator limit is not in the workflow execution 42 runs."
  }

  it should "refuse a change that names no operator, before it reads the workflow" in {
    val noId = limit("limit", 7)
    noId.setOperatorId(" ")
    val nullId = limit("limit", 7)
    nullId.setOperatorId(null)

    refused(make(null, workflow = null)) shouldBe "The request names no operator."
    refused(make(noId, workflow = null)) shouldBe "The operator to change has no id."
    refused(make(nullId, workflow = null)) shouldBe "The operator to change has no id."
  }

  it should "fail, not refuse the change, on a workflow that is none a plan was compiled from" in {
    // What is kept beside a plan is a workflow the compiler read: one that is not is no mistake
    // of the change's.
    val cyclic = udfPlan().copy(links = List(link("udf", "limit"), link("limit", "udf")))

    the[IllegalStateException] thrownBy make(limit("limit", 7), workflow = cyclic) should
      have message "The workflow's links form a cycle: udf -> limit -> udf."
    an[IllegalStateException] should be thrownBy make(limit("limit", 7), workflow = null)
  }
}
