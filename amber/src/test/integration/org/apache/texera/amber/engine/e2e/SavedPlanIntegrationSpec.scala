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

package org.apache.texera.amber.engine.e2e

import com.twitter.util.Duration
import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.{ImplicitSender, TestKit}
import org.apache.pekko.util.Timeout
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Tuple}
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{ExecutionMode, PortIdentity, WorkflowSettings}
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.amber.engine.e2e.TestUtils.{
  cleanupWorkflowExecutionData,
  initiateTexeraDBForTestCases,
  runFromCompiledAndSavedPlans,
  setUpWorkflowExecutionData,
  workflowContext
}
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.python.{
  DualInputPortsPythonUDFOpDescV2,
  PythonUDFOpDescV2
}
import org.apache.texera.amber.operator.udf.r.RUDFSourceOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.amber.tags.IntegrationTest
import org.apache.texera.common.compiler.model.LogicalLink
import org.apache.texera.common.config.{PythonUtils, UdfConfig}
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach, Outcome, Retries}

import java.nio.file.{Files, Paths}
import scala.concurrent.duration.DurationInt
import scala.io.Source
import scala.util.{Try, Using}

/**
  * [[SavedPlanSpec]] for the operators whose workers are Python processes: Python UDFs with one
  * input, with two (the second waiting for the first), and with none, a loop, and an R UDF where R
  * is installed. Each workflow runs from the plan its compile made and from that plan saved and
  * read back, and the two runs must give the same results, as multisets, and the expected ones.
  *
  * Tagged @IntegrationTest because it spawns Python workers; routed to the `amber-integration` CI
  * job.
  */
@IntegrationTest
class SavedPlanIntegrationSpec
    extends TestKit(ActorSystem("SavedPlanIntegrationSpec", AmberRuntime.pekkoConfig))
    with ImplicitSender
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with Retries {

  // As in the other e2e specs: a run that does not observe COMPLETED in CI is retried once.
  override def withFixture(test: NoArgTest): Outcome =
    withRetry { super.withFixture(test) }

  implicit val timeout: Timeout = Timeout(5.seconds)

  // 1 to 6 are the other e2e and integration specs', 7 is SavedPlanSpec's.
  private val specId = 8

  override protected def beforeEach(): Unit = setUpWorkflowExecutionData(specId)

  override protected def afterEach(): Unit = cleanupWorkflowExecutionData(specId)

  override def beforeAll(): Unit = {
    system.actorOf(Props[SingleNodeListener](), "cluster-info")
    // as in the other e2e specs: load the JDBC driver explicitly, which CI occasionally misses
    Class.forName("org.postgresql.Driver")
    initiateTexeraDBForTestCases()
  }

  override def afterAll(): Unit = {
    TestKit.shutdownActorSystem(system)
  }

  /**
    * Runs the workflow from its compiled plan and from its saved plan; see [[SavedPlanSpec]]. A
    * Python worker takes seconds to start, so each run may take two minutes.
    */
  private def runBothWays(
      operators: List[LogicalOp],
      links: List[LogicalLink],
      settings: WorkflowSettings = WorkflowSettings()
  ): Map[OperatorIdentity, List[Tuple]] =
    runFromCompiledAndSavedPlans(
      system,
      operators,
      links,
      () => workflowContext(specId, settings),
      specId,
      Duration.fromMinutes(2)
    )

  private def link(from: LogicalOp, to: LogicalOp, toPort: Int = 0): LogicalLink =
    LogicalLink(
      from.operatorIdentifier,
      PortIdentity(),
      to.operatorIdentifier,
      PortIdentity(toPort)
    )

  /**
    * The units sold of each order of the small sales CSV, read as text without the engine. The
    * file quotes nothing, and the scan trims the spaces around a value, as this does.
    */
  private lazy val unitsSoldByOrder: Map[String, Int] =
    Using.resource(Source.fromFile(TestOperators.CountrySalesSmallCsvPath)) { source =>
      val lines = source.getLines().filter(_.nonEmpty).toList
      val header = lines.head.split(",", -1).map(_.trim).toList
      lines.tail
        .map(line => header.zip(line.split(",", -1).map(_.trim)).toMap)
        .map(row => row("Order ID") -> row("Units Sold").toInt)
        .toMap
    }

  /** Each row's `Order ID`, and its value of `column`, an integer. */
  private def byOrder(rows: List[Tuple], column: String): List[(String, Int)] =
    rows.map(row => row.getField[Any]("Order ID").toString -> row.getField[Int](column))

  private def textInput(text: String): TextInputSourceOpDesc = {
    val op = new TextInputSourceOpDesc()
    op.textInput = text
    op
  }

  "A run from a saved plan" should "run a Python UDF on two workers as the compiled plan does" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val udf = new PythonUDFOpDescV2()
    udf.workers = 2
    udf.retainInputColumns = true
    udf.outputColumns = List(new Attribute("double units", AttributeType.INTEGER))
    udf.code = """from pytexera import *
        |
        |class ProcessTupleOperator(UDFOperatorV2):
        |    @overrides
        |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        |        tuple_["double units"] = tuple_["Units Sold"] * 2
        |        yield tuple_
        |""".stripMargin

    val results = runBothWays(List(scan, udf), List(link(scan, udf)))

    byOrder(results(udf.operatorIdentifier), "double units") should contain theSameElementsAs
      unitsSoldByOrder.view.mapValues(_ * 2).toList
  }

  it should "run a two-input Python UDF, its second input waiting for its first" in {
    val factor = textInput("3")
    val scan = TestOperators.smallCsvScanOpDesc()
    val udf = new DualInputPortsPythonUDFOpDescV2()
    udf.retainInputColumns = true
    udf.outputColumns = List(new Attribute("scaled units", AttributeType.INTEGER))
    udf.code = """from pytexera import *
        |
        |class ProcessTupleOperator(UDFOperatorV2):
        |    factor = None
        |
        |    @overrides
        |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        |        if port == 0:
        |            self.factor = int(tuple_["line"])
        |        else:
        |            tuple_["scaled units"] = tuple_["Units Sold"] * self.factor
        |            yield tuple_
        |""".stripMargin

    val results = runBothWays(
      List(factor, scan, udf),
      List(link(factor, udf), link(scan, udf, toPort = 1))
    )

    byOrder(results(udf.operatorIdentifier), "scaled units") should contain theSameElementsAs
      unitsSoldByOrder.view.mapValues(_ * 3).toList
  }

  it should "run a Python source UDF" in {
    val source = TestOperators.pythonSourceOpDesc(numTuple = 5)

    val results = runBothWays(List(source), Nil)

    results(source.operatorIdentifier).map(_.getField[String]("field_1")) should
      contain theSameElementsAs (0 until 5).map(_.toString)
  }

  it should "run a loop, re-running its body's region on every iteration" in {
    // As LoopIntegrationSpec's first case: Loop Start emits row i of the table on iteration i,
    // and the outermost Loop End keeps every iteration's rows. Loops run materialized.
    val text = textInput("1\n2\n3")
    val start = new LoopStartOpDesc()
    start.initialization = "i = 0"
    start.output = "table.iloc[i]"
    val end = new LoopEndOpDesc()
    end.update = "i += 1"
    end.condition = "i < len(table)"

    val results = runBothWays(
      List(text, start, end),
      List(link(text, start), link(start, end)),
      WorkflowSettings(dataTransferBatchSize = 400, executionMode = ExecutionMode.MATERIALIZED)
    )

    results(end.operatorIdentifier).map(_.getField[String]("line")) should
      contain theSameElementsAs List("1", "2", "3")
  }

  it should "run an R source UDF, where R is installed" in {
    rUnavailable.foreach(reason => cancel(s"R UDFs cannot run here: $reason."))
    val source = new RUDFSourceOpDesc()
    source.columns = List(new Attribute("text", AttributeType.STRING))
    source.code = """function() {
        |  return (data.frame(text = c("a", "b", "c")))
        |}""".stripMargin

    val results = runBothWays(List(source), Nil)

    results(source.operatorIdentifier).map(_.getField[String]("text")) should
      contain theSameElementsAs List("a", "b", "c")
  }

  /**
    * Why an R UDF cannot run here, if it cannot: its worker, a Python process, needs R (the R
    * home udf.conf names, or `R` on the PATH) and the texera-rudf plugin (`texera_r`).
    */
  private lazy val rUnavailable: Option[String] = {
    val rHome = UdfConfig.rPath.trim
    val rOnPath = sys.env
      .getOrElse("PATH", "")
      .split(java.io.File.pathSeparator)
      .exists(directory => directory.nonEmpty && Files.isExecutable(Paths.get(directory, "R")))
    def pythonImports(module: String): Boolean =
      Try {
        new ProcessBuilder(PythonUtils.getPythonExecutable, "-c", s"import $module")
          .redirectErrorStream(true)
          .start()
          .waitFor() == 0
      }.getOrElse(false)
    if (rHome.isEmpty && !rOnPath) {
      Some("R is not installed (no R home in udf.conf or UDF_R_PATH, and no R on the PATH)")
    } else if (rHome.nonEmpty && !Files.isDirectory(Paths.get(rHome))) {
      Some(s"the R home udf.conf names, $rHome, is not a directory")
    } else if (!pythonImports("texera_r")) {
      Some(
        s"${PythonUtils.getPythonExecutable} cannot import texera_r, the texera-rudf plugin R " +
          "UDFs need"
      )
    } else {
      None
    }
  }
}
