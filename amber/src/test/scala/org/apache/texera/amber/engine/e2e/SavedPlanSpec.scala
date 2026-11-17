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

import org.apache.texera.amber.core.executor.{ExecFactory, OpExecWithCode}
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{ExecutionMode, PortIdentity, WorkflowSettings}
import org.apache.texera.amber.engine.e2e.TestUtils.{
  buildFromCompiledAndSavedPlans,
  runAfresh,
  runFromCompiledAndSavedPlans,
  workflowContext
}
import org.apache.texera.amber.operator.aggregate.AggregationFunction
import org.apache.texera.amber.operator.distinct.DistinctOpDesc
import org.apache.texera.amber.operator.filter.{
  ComparisonType,
  FilterPredicate,
  SpecializedFilterOpDesc
}
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.projection.{AttributeUnit, ProjectionOpDesc}
import org.apache.texera.amber.operator.set.difference.DifferenceOpDesc
import org.apache.texera.amber.operator.set.intersect.IntersectOpDesc
import org.apache.texera.amber.operator.set.symmetricDifference.SymmetricDifferenceOpDesc
import org.apache.texera.amber.operator.sort.{
  SortCriteriaUnit,
  SortPreference,
  StableMergeSortOpDesc
}
import org.apache.texera.amber.operator.sortPartitions.SortPartitionsOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.java.JavaUDFOpDesc
import org.apache.texera.amber.operator.union.UnionOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.common.compiler.model.LogicalLink
import org.scalatest.matchers.should.Matchers

import scala.collection.mutable.ListBuffer
import scala.io.Source
import scala.util.{Try, Using}

/**
  * Every operator gives the same result from a saved plan as from a fresh compile. Each workflow
  * below runs twice: from the plan its compile made, and from that plan saved as text and read
  * back, as every run runs (`TestUtils.runFromCompiledAndSavedPlans`). The second plan must be the
  * first read back, field for field, and the two runs must give the same results, as multisets,
  * and the results this spec works out from the fixture file itself.
  *
  * Between them the workflows use each part of a plan the engine reads: a filter; a projection
  * that keeps the hash partitioning of the join before it for the join after it; a global and a
  * group-by aggregate (two layers, the second with a fixed partitioning); a hash join, whose probe
  * waits for its build; sorting on one worker and in ranges; distinct; the three set operations,
  * with two input ports each; a union of two links into one port; a limit; a Java UDF, which
  * cannot compile in a JVM sbt runs tests in and so must fail alike from both plans there (see its
  * case); and a join in the materialized execution mode. Python UDFs and a loop are in
  * [[SavedPlanIntegrationSpec]].
  *
  * `specId` 7: 1 to 6 are the other e2e and integration specs', and 8 is
  * SavedPlanIntegrationSpec's.
  */
class SavedPlanSpec extends RetryingDatabaseE2ESpec("SavedPlanSpec", specId = 7) with Matchers {

  /** Runs the workflow from its compiled plan and from its saved plan; see the class comment. */
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
      specId
    )

  private def link(from: LogicalOp, to: LogicalOp, toPort: Int = 0): LogicalLink =
    LogicalLink(
      from.operatorIdentifier,
      PortIdentity(),
      to.operatorIdentifier,
      PortIdentity(toPort)
    )

  /**
    * The rows of the small sales CSV, read as text without the engine: column name to value. The
    * file quotes nothing, and the scan trims the spaces around a value ("Moldova "), as this does.
    */
  private lazy val salesRows: List[Map[String, String]] =
    Using.resource(Source.fromFile(TestOperators.CountrySalesSmallCsvPath)) { source =>
      val lines = source.getLines().filter(_.nonEmpty).toList
      val header = lines.head.split(",", -1).map(_.trim).toList
      lines.tail.map(line => header.zip(line.split(",", -1).map(_.trim)).toMap)
    }

  /** The value of `column` in each of `rows`, as text. */
  private def column(rows: List[Tuple], column: String): List[String] =
    rows.map(_.getField[Any](column).toString)

  /** The value of `column` in each row of the fixture, as text. */
  private def expected(column: String, rows: List[Map[String, String]] = salesRows): List[String] =
    rows.map(_(column))

  /** The total of `Units Sold` in each region of the fixture. */
  private lazy val unitsByRegion: Map[String, Long] =
    salesRows.groupMapReduce(_("Region"))(_("Units Sold").toLong)(_ + _)

  private def projection(columns: (String, String)*): ProjectionOpDesc = {
    val op = new ProjectionOpDesc()
    op.attributes = columns.map { case (name, alias) => new AttributeUnit(name, alias) }.toList
    op
  }

  private def textInput(text: String): TextInputSourceOpDesc = {
    val op = new TextInputSourceOpDesc()
    op.textInput = text
    op
  }

  "A run from a saved plan" should "filter a scan as the compiled plan does" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val filter = new SpecializedFilterOpDesc()
    filter.predicates = List(new FilterPredicate("Region", ComparisonType.EQUAL_TO, "Asia"))

    val results = runBothWays(List(scan, filter), List(link(scan, filter)))

    column(results(filter.operatorIdentifier), "Order ID") should contain theSameElementsAs
      expected("Order ID", salesRows.filter(_("Region") == "Asia"))
  }

  it should "join two scans on a key, the probe waiting for the build" in {
    val left = TestOperators.smallCsvScanOpDesc()
    val right = TestOperators.smallCsvScanOpDesc()
    val join = TestOperators.joinOpDesc("Order ID", "Order ID")

    val results =
      runBothWays(List(left, right, join), List(link(left, join), link(right, join, toPort = 1)))

    // Order ID is unique, so the self-join pairs each row with itself, once.
    val joined = results(join.operatorIdentifier)
    column(joined, "Order ID") should contain theSameElementsAs expected("Order ID")
    column(joined, "Country") should contain theSameElementsAs expected("Country")
  }

  it should "join a projection of a join's output again, on the key the projection keeps" in {
    // The first join's output is hash-partitioned on Order ID, and the projection keeps that by
    // its rule (buildFromCompiledAndSavedPlans checks the saved plan holds the rule). As the
    // projection has an output link, the scheduler applies the rule and hands the kept
    // partitioning to the second join's input, which requires it, on as many workers. The rows
    // show that run gives the compiled plan's rows; they cannot tell a kept partitioning from one
    // made anew on the same key.
    val left = TestOperators.smallCsvScanOpDesc()
    val right = TestOperators.smallCsvScanOpDesc()
    val join = TestOperators.joinOpDesc("Order ID", "Order ID")
    val project = projection("Order ID" -> "Order ID", "Region" -> "Region")
    val third = TestOperators.smallCsvScanOpDesc()
    val joinAgain = TestOperators.joinOpDesc("Order ID", "Order ID")

    val results = runBothWays(
      List(left, right, join, project, third, joinAgain),
      List(
        link(left, join),
        link(right, join, toPort = 1),
        link(join, project),
        link(project, joinAgain),
        link(third, joinAgain, toPort = 1)
      )
    )

    // Order ID is unique, so each join pairs each row with itself, once; Region is the
    // projection's, as the build side's columns come first.
    results(joinAgain.operatorIdentifier).map(row =>
      (row.getField[Any]("Order ID").toString, row.getField[String]("Region"))
    ) should contain theSameElementsAs salesRows.map(row => (row("Order ID"), row("Region")))
  }

  it should "aggregate a whole scan in two layers" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val total = TestOperators.aggregateAndGroupByDesc("Units Sold", AggregationFunction.SUM, Nil)

    val results = runBothWays(List(scan, total), List(link(scan, total)))

    column(results(total.operatorIdentifier), "aggregate-result") shouldBe
      List(salesRows.map(_("Units Sold").toLong).sum.toString)
  }

  it should "aggregate a scan by group in two layers, the second partitioned on the group" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val byRegion =
      TestOperators.aggregateAndGroupByDesc("Units Sold", AggregationFunction.SUM, List("Region"))

    val results = runBothWays(List(scan, byRegion), List(link(scan, byRegion)))

    results(byRegion.operatorIdentifier)
      .map(row =>
        row.getField[String]("Region") -> row.getField[Any]("aggregate-result").toString.toLong
      ) should contain theSameElementsAs unitsByRegion
  }

  it should "sort a scan on one worker" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val sort = new StableMergeSortOpDesc()
    val byUnitsSold = new SortCriteriaUnit()
    byUnitsSold.attributeName = "Units Sold"
    byUnitsSold.sortPreference = SortPreference.DESC
    sort.keys = ListBuffer(byUnitsSold)

    val results = runBothWays(List(scan, sort), List(link(scan, sort)))

    // The sort's one worker writes its rows in order, and they are read back in that order.
    column(results(sort.operatorIdentifier), "Units Sold").map(_.toLong) shouldBe
      expected("Units Sold").map(_.toLong).sorted.reverse
  }

  it should "sort a scan in ranges, partitioned on the range of the sort key" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val sortPartitions = new SortPartitionsOpDesc()
    sortPartitions.sortAttributeName = "Units Sold"
    sortPartitions.domainMin = 0
    sortPartitions.domainMax = 10000

    val results = runBothWays(List(scan, sortPartitions), List(link(scan, sortPartitions)))

    column(results(sortPartitions.operatorIdentifier), "Order ID") should contain theSameElementsAs
      expected("Order ID")
  }

  it should "keep the distinct values of a projected column" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val regions = projection("Region" -> "Region")
    val distinct = new DistinctOpDesc()

    val results = runBothWays(
      List(scan, regions, distinct),
      List(link(scan, regions), link(regions, distinct))
    )

    column(results(distinct.operatorIdentifier), "Region") should contain theSameElementsAs
      expected("Region").distinct
  }

  it should "take the difference, the intersection and the symmetric difference of two inputs" in {
    val left = textInput("a\nb\nb\nc")
    val right = textInput("b\nc\nd")
    val difference = new DifferenceOpDesc()
    val intersect = new IntersectOpDesc()
    val symmetricDifference = new SymmetricDifferenceOpDesc()
    val setOperations = List(difference, intersect, symmetricDifference)

    val results = runBothWays(
      List(left, right) ++ setOperations,
      setOperations.flatMap(op => List(link(left, op), link(right, op, toPort = 1)))
    )

    column(results(difference.operatorIdentifier), "line") should contain theSameElementsAs
      List("a")
    column(results(intersect.operatorIdentifier), "line") should contain theSameElementsAs
      List("b", "c")
    column(results(symmetricDifference.operatorIdentifier), "line") should
      contain theSameElementsAs List("a", "d")
  }

  it should "union two scans linked into one port" in {
    val first = TestOperators.smallCsvScanOpDesc()
    val second = TestOperators.smallCsvScanOpDesc()
    val union = new UnionOpDesc()

    val results =
      runBothWays(List(first, second, union), List(link(first, union), link(second, union)))

    column(results(union.operatorIdentifier), "Order ID") should contain theSameElementsAs
      (expected("Order ID") ++ expected("Order ID"))
  }

  it should "limit a scan to its first rows" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val limit = new LimitOpDesc()
    limit.limit = 10

    val results = runBothWays(List(scan, limit), List(link(scan, limit)))

    // One scan worker feeds the limit's one worker, in the order of the file.
    column(results(limit.operatorIdentifier), "Order ID") should contain theSameElementsAs
      expected("Order ID").take(10)
  }

  it should "run a Java UDF's code as the compiled plan does" in {
    val scan = TestOperators.smallCsvScanOpDesc()
    val udf = new JavaUDFOpDesc()
    udf.retainInputColumns = true
    udf.code = """import org.apache.texera.amber.operator.map.MapOpExec;
        |import org.apache.texera.amber.core.tuple.Tuple;
        |import org.apache.texera.amber.core.tuple.TupleLike;
        |import scala.Function1;
        |import java.io.Serializable;
        |
        |public class JavaUDFOpExec extends MapOpExec {
        |    public JavaUDFOpExec () {
        |        this.setMapFunc((Function1<Tuple, TupleLike> & Serializable) this::processTuple);
        |    }
        |
        |    public TupleLike processTuple(Tuple tuple) {
        |        return tuple;
        |    }
        |}""".stripMargin

    // A worker compiles the code with javac, which sees the class path the JVM was started with.
    // Under sbt that holds only the sbt launcher (LoopIntegrationSpec has the same note), so the
    // code, which names Texera's classes, cannot compile from either plan; a JVM started with the
    // test class path, as an IDE starts one, compiles it.
    if (Try(ExecFactory.newExecFromJavaCode(udf.code)).isSuccess) {
      val results = runBothWays(List(scan, udf), List(link(scan, udf)))

      column(results(udf.operatorIdentifier), "Order ID") should contain theSameElementsAs
        expected("Order ID")
    } else {
      // No result to compare here. What the plan decides is the code the worker compiles: the
      // two plans hand it the same Java code, and the two runs must fail on the same errors in it.
      val (compiled, saved) = buildFromCompiledAndSavedPlans(
        List(scan, udf),
        List(link(scan, udf)),
        () => workflowContext(specId)
      )
      val executors = List(compiled, saved).map(
        _.physicalPlan.getPhysicalOpsOfLogicalOp(udf.operatorIdentifier).map(_.opExecInitInfo)
      )
      executors.distinct should have size 1
      executors.head should matchPattern {
        case List(OpExecWithCode(code, "java")) if code.contains("class JavaUDFOpExec") =>
      }
      val failures = List(compiled, saved).map { workflow =>
        intercept[Throwable](runAfresh(system, workflow, specId))
      }
      failures.head.getMessage should include(
        "package org.apache.texera.amber.operator.map does not exist"
      )
      failures.map(failure => (failure.getClass, failure.getMessage)).distinct should have size 1
    }
  }

  it should "join two scans in the materialized execution mode" in {
    val left = TestOperators.smallCsvScanOpDesc()
    val right = TestOperators.smallCsvScanOpDesc()
    val join = TestOperators.joinOpDesc("Order ID", "Order ID")
    val byRegion =
      TestOperators.aggregateAndGroupByDesc("Units Sold", AggregationFunction.SUM, List("Region"))

    val results = runBothWays(
      List(left, right, join, byRegion),
      List(link(left, join), link(right, join, toPort = 1), link(join, byRegion)),
      WorkflowSettings(dataTransferBatchSize = 400, executionMode = ExecutionMode.MATERIALIZED)
    )

    results(byRegion.operatorIdentifier)
      .map(row =>
        row.getField[String]("Region") -> row.getField[Any]("aggregate-result").toString.toLong
      ) should contain theSameElementsAs unitsByRegion
  }
}
