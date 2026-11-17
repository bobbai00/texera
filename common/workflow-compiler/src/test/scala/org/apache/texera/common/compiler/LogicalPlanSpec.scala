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
import org.apache.texera.amber.core.storage.{
  DatasetVersionLister,
  InputLink,
  InputLinker,
  ListedFile,
  ScanFileResolver
}
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{InputFile, PlanInput, PortIdentity}
import org.apache.texera.amber.operator.aggregate.AggregateOpDesc
import org.apache.texera.amber.operator.hashJoin.HashJoinOpDesc
import org.apache.texera.amber.operator.keywordSearch.KeywordSearchOpDesc
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.FileScanOpDesc
import org.apache.texera.amber.operator.source.scan.json.JSONLScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.split.SplitOpDesc
import org.apache.texera.amber.operator.udf.python.DualInputPortsPythonUDFOpDescV2
import org.apache.texera.amber.operator.udf.python.source.PythonUDFSourceOpDescV2
import org.apache.texera.amber.operator.union.UnionOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlan, LogicalPlanPojo}
import org.scalatest.flatspec.AnyFlatSpec

import java.net.URI
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.Random

class LogicalPlanSpec extends AnyFlatSpec {

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  private def csv(): CSVScanSourceOpDesc = TestOperators.headerlessSmallCsvScanOpDesc()
  private def keyword(): KeywordSearchOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")

  /** Give an operator a readable, stable id so failure messages and graph
    * assertions read in terms of the operator's role rather than a UUID.
    */
  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(
      from: OperatorIdentity,
      to: OperatorIdentity,
      fromPort: Int = 0,
      toPort: Int = 0
  ): LogicalLink =
    LogicalLink(from, PortIdentity(fromPort), to, PortIdentity(toPort))

  // ---------------------------------------------------------------------------
  // A realistic, non-trivial workflow used by the graph-query tests below.
  //
  //   Sources (three different operator types):
  //     csv : CSV scan      json : JSONL scan      pySrc : Python UDF source
  //
  //   Edges (target port in parentheses):
  //     csv   ─▶ join  (0, "left")        join  ─▶ udf2  (0, "model")
  //     json  ─▶ join  (1, "right")       pySrc ─▶ udf2  (1, "tuples")
  //     udf2  ─▶ union (0)                json  ─▶ union (0)   ← fan-out: 2nd link into the SAME port
  //     union ─▶ split (0)
  //     split ─▶ aggA  (from out 0)       split ─▶ aggB  (from out 1)   ← two distinct OUTPUT ports
  //
  //   Shapes exercised: a join (two distinct input ports), a dual-input UDF
  //   (two distinct input ports), a union (two links merged into ONE input
  //   port), a split (two distinct output ports), and a fan-out source
  //   (json feeds both the join and the union).
  //   Sources (in-degree 0): csv, json, pySrc.   Terminals (out-degree 0): aggA, aggB.
  // ---------------------------------------------------------------------------

  private case class Rich(
      plan: LogicalPlan,
      csv: CSVScanSourceOpDesc,
      json: JSONLScanSourceOpDesc,
      pySrc: PythonUDFSourceOpDescV2,
      join: HashJoinOpDesc[String],
      udf2: DualInputPortsPythonUDFOpDescV2,
      union: UnionOpDesc,
      split: SplitOpDesc,
      aggA: AggregateOpDesc,
      aggB: AggregateOpDesc
  )

  private def richPlan(): Rich = {
    val csv = named(TestOperators.headerlessSmallCsvScanOpDesc(), "csv-source")
    val json = named(TestOperators.smallJSONLScanOpDesc(), "jsonl-source")
    val pySrc = named(TestOperators.pythonSourceOpDesc(5), "python-source")
    val join = named(TestOperators.joinOpDesc("country", "country"), "hash-join")
    val udf2 = named(new DualInputPortsPythonUDFOpDescV2(), "dual-input-udf")
    val union = named(new UnionOpDesc(), "union")
    val split = named(new SplitOpDesc(), "split")
    val aggA = named(new AggregateOpDesc(), "aggregate-a")
    val aggB = named(new AggregateOpDesc(), "aggregate-b")

    // Order matters for getUpstreamLinks: links are returned in construction order.
    val links = List(
      link(csv.operatorIdentifier, join.operatorIdentifier, toPort = 0), // join: left
      link(json.operatorIdentifier, join.operatorIdentifier, toPort = 1), // join: right
      link(join.operatorIdentifier, udf2.operatorIdentifier, toPort = 0), // udf2: model
      link(pySrc.operatorIdentifier, udf2.operatorIdentifier, toPort = 1), // udf2: tuples
      link(udf2.operatorIdentifier, union.operatorIdentifier, toPort = 0), // union <- udf2
      link(
        json.operatorIdentifier,
        union.operatorIdentifier,
        toPort = 0
      ), // union <- json (2nd into port 0)
      link(union.operatorIdentifier, split.operatorIdentifier, toPort = 0),
      link(split.operatorIdentifier, aggA.operatorIdentifier, fromPort = 0), // split: output 0
      link(split.operatorIdentifier, aggB.operatorIdentifier, fromPort = 1) // split: output 1
    )

    // Deliberately pass the operators in a NON-topological order so the
    // topological-sort test proves real reordering, not input identity.
    val operators = List[LogicalOp](aggB, split, union, udf2, join, csv, pySrc, json, aggA)

    Rich(LogicalPlan(operators, links), csv, json, pySrc, join, udf2, union, split, aggA, aggB)
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  "LogicalPlan" should "expose the operators and links it was constructed with" in {
    val a = csv()
    val b = keyword()
    val l = link(a.operatorIdentifier, b.operatorIdentifier)
    val plan = LogicalPlan(List(a, b), List(l))
    assert(plan.operators == List(a, b))
    assert(plan.links == List(l))
  }

  "LogicalPlan.apply(LogicalPlanPojo)" should
    "lift the POJO's operators and links, ignoring opsToViewResult / opsToReuseResult" in {
    val a = csv()
    val b = keyword()
    val l = link(a.operatorIdentifier, b.operatorIdentifier)
    val pojo = LogicalPlanPojo(
      operators = List(a, b),
      links = List(l),
      // `operatorId` is private — use the public OperatorIdentity wrapper.
      opsToViewResult = List(b.operatorIdentifier.id), // intentionally non-empty
      opsToReuseResult = List(a.operatorIdentifier.id)
    )
    val plan = LogicalPlan(pojo)
    assert(plan.operators == List(a, b))
    assert(plan.links == List(l))
  }

  // ---------------------------------------------------------------------------
  // getTopologicalOpIds
  // ---------------------------------------------------------------------------

  "LogicalPlan.getTopologicalOpIds" should "yield a topological order on a linear chain" in {
    val a = csv()
    val b = keyword()
    val plan = LogicalPlan(List(a, b), List(link(a.operatorIdentifier, b.operatorIdentifier)))
    val order = plan.getTopologicalOpIds.asScala.toList
    assert(order == List(a.operatorIdentifier, b.operatorIdentifier))
  }

  it should "honor every edge on a realistic plan (join, union, dual-input UDF, split fan-out)" in {
    val r = richPlan()
    val order = r.plan.getTopologicalOpIds.asScala.toList

    // Every operator appears exactly once.
    assert(order.size == r.plan.operators.size)
    assert(order.toSet == r.plan.operators.map(_.operatorIdentifier).toSet)

    // The defining property of a topological order: each edge points "forward".
    val positionOf = order.zipWithIndex.toMap
    r.plan.links.foreach { l =>
      assert(
        positionOf(l.fromOpId) < positionOf(l.toOpId),
        s"topological order violates edge ${l.fromOpId.id} -> ${l.toOpId.id}; " +
          s"order = ${order.map(_.id)}"
      )
    }
  }

  // ---------------------------------------------------------------------------
  // getOperator
  // ---------------------------------------------------------------------------

  "LogicalPlan.getOperator" should "return the operator with the requested identifier" in {
    val r = richPlan()
    assert(r.plan.getOperator(r.join.operatorIdentifier) eq r.join)
    assert(r.plan.getOperator(r.split.operatorIdentifier) eq r.split)
    assert(r.plan.getOperator(r.pySrc.operatorIdentifier) eq r.pySrc)
  }

  it should "throw NoSuchElementException for an unknown operator id" in {
    val a = csv()
    val plan = LogicalPlan(List(a), List.empty)
    intercept[NoSuchElementException] {
      plan.getOperator(OperatorIdentity("not-in-plan"))
    }
  }

  // ---------------------------------------------------------------------------
  // getTerminalOperatorIds
  // ---------------------------------------------------------------------------

  "LogicalPlan.getTerminalOperatorIds" should
    "return every out-degree-0 operator on a realistic plan (the two split sinks)" in {
    val r = richPlan()
    assert(
      r.plan.getTerminalOperatorIds.toSet ==
        Set(r.aggA.operatorIdentifier, r.aggB.operatorIdentifier)
    )
  }

  it should "return the single sink in a linear chain" in {
    val a = csv()
    val b = keyword()
    val plan = LogicalPlan(List(a, b), List(link(a.operatorIdentifier, b.operatorIdentifier)))
    assert(plan.getTerminalOperatorIds == List(b.operatorIdentifier))
  }

  it should "return every operator when there are no links" in {
    // An isolated set of operators with no edges — every operator has
    // out-degree 0 and is therefore terminal.
    val a = csv()
    val b = keyword()
    val plan = LogicalPlan(List(a, b), List.empty)
    assert(plan.getTerminalOperatorIds.toSet == Set(a.operatorIdentifier, b.operatorIdentifier))
  }

  it should "return an empty list for an empty plan" in {
    val plan = LogicalPlan(List.empty, List.empty)
    assert(plan.getTerminalOperatorIds.isEmpty)
  }

  // ---------------------------------------------------------------------------
  // getUpstreamLinks
  // ---------------------------------------------------------------------------

  "LogicalPlan.getUpstreamLinks" should
    "return both inbound links on their distinct ports for a join" in {
    val r = richPlan()
    val up = r.plan.getUpstreamLinks(r.join.operatorIdentifier)
    // Construction order: csv (left, port 0) then json (right, port 1).
    assert(up.map(_.fromOpId) == List(r.csv.operatorIdentifier, r.json.operatorIdentifier))
    assert(up.map(_.toPortId) == List(PortIdentity(0), PortIdentity(1)))
  }

  it should "return both inbound links on their distinct ports for a dual-input UDF" in {
    val r = richPlan()
    val up = r.plan.getUpstreamLinks(r.udf2.operatorIdentifier)
    assert(up.map(_.fromOpId) == List(r.join.operatorIdentifier, r.pySrc.operatorIdentifier))
    assert(up.map(_.toPortId) == List(PortIdentity(0), PortIdentity(1)))
  }

  it should "return every inbound link merged into a union's single input port, in order" in {
    val r = richPlan()
    val up = r.plan.getUpstreamLinks(r.union.operatorIdentifier)
    // udf2 and json both feed union's port 0; the result preserves construction order.
    assert(up.map(_.fromOpId) == List(r.udf2.operatorIdentifier, r.json.operatorIdentifier))
    assert(up.map(_.toPortId).toSet == Set(PortIdentity(0)))
  }

  it should "return an empty list for a source operator with no inbound links" in {
    val r = richPlan()
    assert(r.plan.getUpstreamLinks(r.csv.operatorIdentifier).isEmpty)
  }

  // ---------------------------------------------------------------------------
  // operatorsInsideLoopBlocks; loop-blocks.json holds cases the frontend's port runs too
  // ---------------------------------------------------------------------------

  private def loopStart(id: String): LogicalOp = named(new LoopStartOpDesc, id)
  private def loopEnd(id: String): LogicalOp = named(new LoopEndOpDesc, id)
  private def op(id: String): LogicalOp = named(new LimitOpDesc, id)

  /**
    * The ids of the operators inside a loop block, `edges` as "from" -> "to" ids, checked against
    * a walk from each operator, as are the LoopStarts around each (`enclosingLoopStarts`).
    */
  private def inside(operators: List[LogicalOp], edges: (String, String)*): Set[String] = {
    val plan = LogicalPlan(
      operators,
      edges.toList.map { case (from, to) => link(OperatorIdentity(from), OperatorIdentity(to)) }
    )
    val around = plan.enclosingLoopStarts.map { case (id, starts) => id.id -> starts.map(_.id) }
    val byWalk = enclosingByWalk(operators, edges)
    assert(
      around == byWalk,
      s"the walk finds $byWalk, not $around, in ${operators.map(_.operatorIdentifier.id)} " +
        s"with $edges"
    )
    plan.operatorsInsideLoopBlocks.map(_.id)
  }

  /**
    * Each operator with an enclosing LoopStart, and those LoopStarts, found another way: it walks
    * from each operator where `enclosingLoopStarts` folds over the plan.
    */
  private def enclosingByWalk(
      operators: List[LogicalOp],
      edges: Seq[(String, String)]
  ): Map[String, Set[String]] = {
    val typeOf = operators.map {
      case op: LoopStartOpDesc => op.operatorIdentifier.id -> "LoopStart"
      case op: LoopEndOpDesc   => op.operatorIdentifier.id -> "LoopEnd"
      case op                  => op.operatorIdentifier.id -> ""
    }.toMap
    // The `closes`-typed operators a walk from `origin` meets with no block open.
    def walk(origin: String, adjacency: Map[String, Seq[String]], opens: String, closes: String) = {
      def from(id: String, open: Int): Set[String] =
        adjacency.getOrElse(id, Nil).toSet.flatMap { next: String =>
          val change = if (typeOf(next) == opens) 1 else if (typeOf(next) == closes) -1 else 0
          from(next, (open + change).max(0)) ++ Option.when(change < 0 && open == 0)(next)
        }
      from(origin, if (typeOf(origin) == opens) 1 else 0)
    }
    typeOf.keySet
      .filter(walk(_, edges.groupMap(_._1)(_._2), "LoopStart", "LoopEnd").nonEmpty)
      .map(id => id -> walk(id, edges.groupMap(_._2)(_._1), "LoopEnd", "LoopStart"))
      .filter(_._2.nonEmpty)
      .toMap
  }

  "LogicalPlan.operatorsInsideLoopBlocks" should "find nothing unless a LoopStart and a LoopEnd close a block" in {
    assert(inside(List(op("a"), op("b")), "a" -> "b").isEmpty)
    assert(inside(List(loopStart("S"), op("a"), op("b")), "S" -> "a", "a" -> "b").isEmpty)
    assert(inside(List(op("a"), op("b"), loopEnd("E")), "a" -> "b", "b" -> "E").isEmpty)
  }

  it should "put the body of a straight block inside it, and neither control operator" in {
    // src -> S -> a -> b -> E -> sink
    val ops = List(op("src"), loopStart("S"), op("a"), op("b"), loopEnd("E"), op("sink"))
    val result =
      inside(ops, "src" -> "S", "S" -> "a", "a" -> "b", "b" -> "E", "E" -> "sink")
    assert(result == Set("a", "b"))
  }

  it should "put both branches of a block that branches and converges inside it" in {
    // S -> a -> E, S -> b -> c -> E
    val ops = List(loopStart("S"), op("a"), op("b"), op("c"), loopEnd("E"))
    val result = inside(ops, "S" -> "a", "a" -> "E", "S" -> "b", "b" -> "c", "c" -> "E")
    assert(result == Set("a", "b", "c"))
  }

  it should "leave out a dangling branch that never reaches the LoopEnd" in {
    // S -> a -> E, and S -> d -> e: the block never closes on the path through d and e.
    val ops = List(loopStart("S"), op("a"), loopEnd("E"), op("d"), op("e"))
    val result = inside(ops, "S" -> "a", "a" -> "E", "S" -> "d", "d" -> "e")
    assert(result == Set("a"))
  }

  it should "leave out a branch that joins the body from outside the block" in {
    // src2 -> a, where a is in the body of S ... E: src2 reaches E but no LoopStart reaches src2.
    val ops = List(loopStart("S"), op("a"), loopEnd("E"), op("src2"))
    val result = inside(ops, "S" -> "a", "a" -> "E", "src2" -> "a")
    assert(result == Set("a"))
  }

  it should "put a nested block's LoopStart and LoopEnd inside the outer block, and not the outer ones" in {
    // S0 -> x -> S1 -> a -> E1 -> y -> E0
    val ops =
      List(
        loopStart("S0"),
        op("x"),
        loopStart("S1"),
        op("a"),
        loopEnd("E1"),
        op("y"),
        loopEnd("E0")
      )
    val result =
      inside(ops, "S0" -> "x", "x" -> "S1", "S1" -> "a", "a" -> "E1", "E1" -> "y", "y" -> "E0")
    assert(result == Set("x", "S1", "a", "E1", "y"))
  }

  it should "not count a control operator inside its own block when an outer block is left open" in {
    // S0 -> x -> S1 -> a -> E1, where no LoopEnd closes S0's block: S1 is only in its own.
    val openAbove = List(loopStart("S0"), op("x"), loopStart("S1"), op("a"), loopEnd("E1"))
    assert(inside(openAbove, "S0" -> "x", "x" -> "S1", "S1" -> "a", "a" -> "E1") == Set("a"))
    // S -> a -> E -> b -> E2, where no LoopStart opens E2's block: E is only in its own.
    val openBelow = List(loopStart("S"), op("a"), loopEnd("E"), op("b"), loopEnd("E2"))
    assert(inside(openBelow, "S" -> "a", "a" -> "E", "E" -> "b", "b" -> "E2") == Set("a"))
  }

  it should "not leak one block into the next when blocks run in sequence" in {
    // S1 -> a -> E1 -> x -> S2 -> b -> E2: x is in neither block.
    val ops =
      List(
        loopStart("S1"),
        op("a"),
        loopEnd("E1"),
        op("x"),
        loopStart("S2"),
        op("b"),
        loopEnd("E2")
      )
    val result =
      inside(ops, "S1" -> "a", "a" -> "E1", "E1" -> "x", "x" -> "S2", "S2" -> "b", "b" -> "E2")
    assert(result == Set("a", "b"))
    // S1 -> a -> E1 -> S2 -> b -> E2: nor are E1 and S2, linked directly.
    val linked =
      List(loopStart("S1"), op("a"), loopEnd("E1"), loopStart("S2"), op("b"), loopEnd("E2"))
    assert(
      inside(linked, "S1" -> "a", "a" -> "E1", "E1" -> "S2", "S2" -> "b", "b" -> "E2") ==
        Set("a", "b")
    )
  }

  it should "agree with a walk from each operator on random graphs of loop and plain operators" in {
    val random = new Random(8640)
    (1 to 400).foreach { _ =>
      val size = 2 + random.nextInt(11)
      val density = Seq(0.15, 0.3, 0.5)(random.nextInt(3))
      val operators =
        (0 until size).map(i => Seq(loopStart _, loopEnd _, op _, op _)(random.nextInt(4))(s"n$i"))
      val edges =
        for (from <- 0 until size; to <- from + 1 until size if random.nextDouble() < density)
          yield s"n$from" -> s"n$to"
      // In shuffled order, so the plan's topological order differs from the ids'.
      inside(random.shuffle(operators).toList, random.shuffle(edges): _*)
    }
  }

  /**
    * The LoopStarts around each operator inside a block, outermost first, as the property panel
    * lists them: fewer LoopStarts around a LoopStart first, then by id.
    */
  private def outermostFirst(plan: LogicalPlan): Map[String, List[String]] = {
    val around = plan.enclosingLoopStarts.map { case (id, starts) => id.id -> starts.map(_.id) }
    around.map {
      case (id, starts) =>
        id -> starts.toList.sortBy(start => (around.get(start).map(_.size).getOrElse(0), start))
    }
  }

  "LogicalPlan.enclosingLoopStarts" should "give the answer of every case the frontend's port shares" in {
    // loop-blocks.json, which loop-block.util.spec.ts runs against the frontend's port too.
    val fixture = objectMapper.readTree(getClass.getResourceAsStream("/loop-blocks.json"))
    val cases = (fixture.get("cases").elements().asScala ++
      fixture.get("randomGraphs").elements().asScala).toList
    assert(cases.size > 100, "the fixture lost its cases")
    val mismatches = cases.flatMap { testCase =>
      val operators = testCase.get("operators").elements().asScala.toList.map { operator =>
        val id = operator.get("id").asText()
        operator.get("type").asText() match {
          case "Operator" => op(id)
          // Read by the backend's own JSON type name, which the frontend's operators carry and its
          // port matches, so the fixture cannot name a LoopStart or a LoopEnd any other way.
          case controlType =>
            val json = s"""{"operatorType": "$controlType"}"""
            val control = objectMapper.readValue(json, classOf[LogicalOp])
            assert(
              control.isInstanceOf[LoopStartOpDesc] || control.isInstanceOf[LoopEndOpDesc],
              s"$controlType reads as ${control.getClass.getSimpleName} in ${testCase.get("name")}"
            )
            named(control, id)
        }
      }
      val ends = testCase.get("links").elements().asScala.toList.map { link =>
        link.get("from").asText() -> link.get("to").asText()
      }
      // A second link into an operator arrives on a port of its own.
      val links = ends.zipWithIndex.map {
        case ((from, to), index) =>
          link(
            OperatorIdentity(from),
            OperatorIdentity(to),
            toPort = ends.take(index).count(_._2 == to)
          )
      }
      val expected = testCase
        .get("enclosingLoopStarts")
        .fields()
        .asScala
        .map(entry => entry.getKey -> entry.getValue.elements().asScala.map(_.asText()).toList)
        .toMap
      val answer = outermostFirst(LogicalPlan(operators, links))
      Option.when(answer != expected) {
        s"${testCase.get("name").asText()}: the fixture says ${objectMapper.writeValueAsString(expected)}, " +
          s"the plan ${objectMapper.writeValueAsString(answer)}"
      }
    }
    if (mismatches.nonEmpty) fail(mismatches.mkString("\n"))
  }

  // ---------------------------------------------------------------------------
  // refersToLoopVariables
  // ---------------------------------------------------------------------------

  /** src -> S -> a -> E, and src -> b, outside every block. */
  private def blockAndOutside(): LogicalPlan =
    LogicalPlan(
      List(op("src"), loopStart("S"), op("a"), loopEnd("E"), op("b")),
      List(
        link(OperatorIdentity("src"), OperatorIdentity("S")),
        link(OperatorIdentity("S"), OperatorIdentity("a")),
        link(OperatorIdentity("a"), OperatorIdentity("E")),
        link(OperatorIdentity("src"), OperatorIdentity("b"))
      )
    )

  private def searchFor(id: String, keyword: String): LogicalOp =
    named(TestOperators.keywordSearchOpDesc("column-1", keyword), id)

  /** A Limit as the editor sends one whose limit is the loop variable `n`: a typed reference. */
  private def limitOfN(id: String): LogicalOp =
    objectMapper.readValue(
      s"""{"operatorID": "$id", "operatorType": "Limit", "limit": "$$n"}""",
      classOf[LogicalOp]
    )

  "LogicalPlan.refersToLoopVariables" should "take a whole-string '$x' for a reference only inside a loop block" in {
    val plan = blockAndOutside()

    assert(plan.refersToLoopVariables(searchFor("a", "$x")))
    assert(!plan.refersToLoopVariables(searchFor("b", "$x")))
    // Not the whole string: a literal everywhere.
    assert(!plan.refersToLoopVariables(searchFor("a", "price $x")))
    assert(!plan.refersToLoopVariables(searchFor("a", "Asia")))
  }

  it should "take a typed reference, or a sidecar entry, for one wherever the operator is" in {
    val plan = blockAndOutside()

    assert(plan.refersToLoopVariables(limitOfN("a")))
    // Outside every block a typed reference fails the compile; it still refers to a variable.
    assert(plan.refersToLoopVariables(limitOfN("b")))
    // A compiled operator's sidecar lists its string references too.
    val compiled = searchFor("b", "Asia")
    compiled.stateReferences = Map("/keyword" -> "k")
    assert(plan.refersToLoopVariables(compiled))
    // An operator the plan does not have is inside no block.
    assert(!plan.refersToLoopVariables(searchFor("ghost", "$x")))
  }

  // ---------------------------------------------------------------------------
  // bindScanFiles
  // ---------------------------------------------------------------------------
  //
  // How a name becomes a URI is the resolver's business, and how a file gets a link
  // the linker's; both are passed in by the caller. Here the resolver is the fixture
  // resolver, which knows local files, unless a case gives another, and the linker
  // is one that records what it is asked to link.
  //
  // An operator's own error is appended to the error list by its id, and binding
  // CONTINUES (collect-all): the editing compile returns every bad operator's error
  // so the UI can surface them at once, and the compile before a run throws them
  // together. To force one deterministically, a scan fixture is pointed at a file
  // that does not exist.

  private def csvWithMissingFile(): CSVScanSourceOpDesc = {
    val op = TestOperators.headerlessSmallCsvScanOpDesc()
    // No such file on the local disk, so the fixture resolver refuses the name.
    op.fileName = Some("nonexistent-test-file.csv")
    op
  }

  /** The link `recordingLinker` makes for `file`. */
  private def linkOf(file: URI): InputLink =
    InputLink(
      s"http://texera-rustfs:9000/bucket${file.getPath}?X-Amz-Signature=5ecr3t",
      86400000L,
      412
    )

  /**
    * A linker of the files resolvers resolve, each as `linkFile` links it. It is asked for no
    * file of a listing: `bindScanFiles` links none.
    */
  private def linkerOf(linkFile: URI => InputLink): InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = linkFile(fileUri)
      override def linkListed(file: ListedFile): InputLink =
        fail(s"asked to link the listed file ${file.logicalPath}")
    }

  /** A linker that links any file, and lists the files it was asked to link in `asked`. */
  private def recordingLinker(asked: ArrayBuffer[URI]): InputLinker =
    linkerOf { file =>
      asked += file
      linkOf(file)
    }

  /** A link a request could send with an operator, to a place of the sender's choosing. */
  private val sentLink = InputLink("http://169.254.169.254/latest/meta-data", Long.MaxValue, 1)

  "LogicalPlan.bindScanFiles" should
    "append a per-operator error for every failing scan source instead of throwing" in {
    // Two independent broken scans: BOTH are collected (binding does not stop at
    // the first failure), keyed by their distinct operator ids.
    val brokenA = csvWithMissingFile()
    val brokenB = csvWithMissingFile()
    val plan = LogicalPlan(List(brokenA, brokenB), List.empty)
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    plan.bindScanFiles(TestOperators.fixtureFileResolver, None, errors)
    assert(errors.size == 2, s"expected both failures captured, got: $errors")
    assert(
      errors.map(_._1).toSet ==
        Set(brokenA.operatorIdentifier, brokenB.operatorIdentifier)
    )
    // The resolver raises `org.apache.commons.vfs2.FileNotFoundException` for a
    // name it cannot resolve: that, and no other failure, is the operator's error.
    assert(errors.forall(_._2.isInstanceOf[FileNotFoundException]))
  }

  it should "report a scan source that names no file, without asking the resolver" in {
    val unnamed = new CSVScanSourceOpDesc()
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    LogicalPlan(List(unnamed), List.empty).bindScanFiles(
      fileName => fail(s"asked to resolve $fileName"),
      None,
      errors
    )

    assert(errors.map(_._1).toList == List(unnamed.operatorIdentifier))
    assert(
      errors.head._2.toString == "java.lang.RuntimeException: No file selected. " +
        "Please select a file from the 'File' dropdown in the right panel."
    )
  }

  it should "set on each scan source the URI the given resolver returns for its file name" in {
    val resolved = new URI("dataset:///repository/commit/data.csv")
    val asked = ArrayBuffer.empty[String]
    val op = TestOperators.headerlessSmallCsvScanOpDesc()
    op.fileName = Some("/dataset/owner@texera.io/sales/v1/data.csv")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = LogicalPlan(List(op), List.empty).bindScanFiles(
      fileName => { asked += fileName; resolved },
      None,
      errors
    )

    assert(asked.toList == List("/dataset/owner@texera.io/sales/v1/data.csv"))
    assert(op.fileName.contains(resolved.toASCIIString))
    assert(errors.isEmpty)
    // Given no linker, it links nothing: the plan reads no input through a link.
    assert(inputs.isEmpty)
    assert(op.inputLinks.isEmpty)
  }

  it should "link each file it resolved, for a plan made to run, under its resolved name" in {
    val csvFile = new URI("dataset:///repository/commit/data.csv")
    val jsonlFile = new URI("model:///models/commit/a%20b/rows.jsonl")
    val scanCsv = named(TestOperators.headerlessSmallCsvScanOpDesc(), "scan-csv")
    scanCsv.fileName = Some("/dataset/owner@texera.io/sales/v1/data.csv")
    val scanJsonl = named(TestOperators.smallJSONLScanOpDesc(), "scan-jsonl")
    scanJsonl.fileName = Some("/model/owner@texera.io/models/v2/a b/rows.jsonl")
    val linked = ArrayBuffer.empty[URI]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = LogicalPlan(List(scanCsv, keyword(), scanJsonl), List.empty).bindScanFiles(
      fileName => if (fileName.startsWith("/dataset/")) csvFile else jsonlFile,
      Some(recordingLinker(linked)),
      errors
    )

    assert(errors.isEmpty)
    // The linker is handed what the resolver resolved, and nothing else.
    assert(linked.toList == List(csvFile, jsonlFile))
    // The executor looks its link up by the name it knows its file by.
    assert(scanCsv.inputLinks == Map(scanCsv.fileName.get -> linkOf(csvFile)))
    assert(scanJsonl.inputLinks == Map(scanJsonl.fileName.get -> linkOf(jsonlFile)))
    // What the plan lists as read from outside the run: each file, with its link's expiry and
    // the file's size, and never the link.
    assert(
      inputs == Seq(
        PlanInput(OperatorIdentity("scan-csv"), csvFile.toASCIIString, InputFile(86400000L, 412)),
        PlanInput(
          OperatorIdentity("scan-jsonl"),
          jsonlFile.toASCIIString,
          InputFile(86400000L, 412)
        )
      )
    )
  }

  it should "drop the links a scan source arrived with, whether or not it links its file" in {
    Seq(None, Some(recordingLinker(ArrayBuffer.empty))).foreach { linker =>
      val scan = csv()
      // As a request could send it: a link under the very name the file resolves to.
      val resolvedName = TestOperators.fixtureFileResolver.resolve(scan.fileName.get).toASCIIString
      scan.inputLinks = Map(resolvedName -> sentLink, "another-name" -> sentLink)

      LogicalPlan(List(scan), List.empty).bindScanFiles(
        TestOperators.fixtureFileResolver,
        linker,
        ArrayBuffer.empty
      )

      assert(scan.fileName.contains(resolvedName))
      assert(
        scan.inputLinks == linker.map(_ => resolvedName -> linkOf(new URI(resolvedName))).toMap,
        s"with ${linker.fold("no linker")(_ => "a linker")}"
      )
    }
  }

  it should "link no file whose name did not resolve, whatever the name is" in {
    // A request names a file by a URI of its own making, of a dataset its user may
    // not read, and sends a link with it. A user's resolver resolves no such name.
    val refusesResolvedNames: ScanFileResolver =
      fileName => throw new FileNotFoundException(fileName)
    val scan = csv()
    scan.fileName = Some("dataset:///another-users-repository/commit/secret.csv")
    scan.inputLinks = Map("dataset:///another-users-repository/commit/secret.csv" -> sentLink)
    val linked = ArrayBuffer.empty[URI]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = LogicalPlan(List(scan), List.empty).bindScanFiles(
      refusesResolvedNames,
      Some(recordingLinker(linked)),
      errors
    )

    assert(errors.map(_._1).toList == List(scan.operatorIdentifier))
    assert(linked.isEmpty, "the linker was handed a file the resolver did not resolve")
    assert(scan.inputLinks.isEmpty)
    assert(inputs.isEmpty)
  }

  it should "report a file the linker does not find as its scan source's error" in {
    val missing = csv()
    val found = csv()
    val notFound = new FileNotFoundException("no such file in the version")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    val missingFile = TestOperators.fixtureFileResolver.resolve(missing.fileName.get)
    var asked = 0

    val inputs = LogicalPlan(List(missing, found), List.empty).bindScanFiles(
      TestOperators.fixtureFileResolver,
      Some(linkerOf { file =>
        asked += 1
        if (asked == 1) throw notFound else linkOf(file)
      }),
      errors
    )

    assert(errors.toList == List((missing.operatorIdentifier, notFound)))
    assert(missing.fileName.contains(missingFile.toASCIIString), "the name was resolved")
    assert(missing.inputLinks.isEmpty)
    // The scan after it is linked all the same.
    assert(inputs.map(_.logicalOperatorId) == Seq(found.operatorIdentifier))
    assert(found.inputLinks.size == 1)
  }

  it should "throw, as it is, a failure of the resolver or the linker that is no scan's error" in {
    // The database or the storage not answering says nothing about the file: reported on
    // the scan, it would read as the user's mistake.
    val outage = new java.io.IOException("the storage did not answer")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val fromResolver = intercept[java.io.IOException] {
      LogicalPlan(List(csv()), List.empty).bindScanFiles(_ => throw outage, None, errors)
    }
    val fromLinker = intercept[java.io.IOException] {
      LogicalPlan(List(csv()), List.empty).bindScanFiles(
        TestOperators.fixtureFileResolver,
        Some(linkerOf(_ => throw outage)),
        errors
      )
    }

    assert(fromResolver eq outage)
    assert(fromLinker eq outage)
    assert(errors.isEmpty)
  }

  it should "leave operators that are no scan source untouched (no errors, no resolution)" in {
    // KeywordSearch is not a ScanSourceOpDesc, so it is skipped entirely.
    val k = keyword()
    val plan = LogicalPlan(List(k), List.empty)
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    val inputs = plan.bindScanFiles(
      fileName => fail(s"asked to resolve $fileName"),
      Some(linkerOf(file => fail(s"asked to link $file"))),
      errors
    )
    assert(errors.isEmpty)
    assert(inputs.isEmpty)
  }

  it should "leave the links of a File Scan From Input alone: its files are listed, not named" in {
    val fileScan = new FileScanOpDesc
    val links = Map("/dataset/ada@texera.io/letters/v1/a.txt" -> sentLink)
    fileScan.inputLinks = links

    LogicalPlan(List(fileScan), List.empty).bindScanFiles(
      fileName => fail(s"asked to resolve $fileName"),
      Some(linkerOf(file => fail(s"asked to link $file"))),
      ArrayBuffer.empty
    )

    assert(fileScan.inputLinks == links)
  }

  // ---------------------------------------------------------------------------
  // bindListedFiles
  // ---------------------------------------------------------------------------
  //
  // Which files a dataset version holds is the lister's business, and how a file gets a
  // link the linker's; both are passed in by the caller. Here the lister lists the
  // versions a case gives it and records what it is asked, and the linker links any
  // listed file and records it.

  private val lettersPath = "/dataset/ada@texera.io/letters/v1"
  private val almanacPath = "/dataset/ada@texera.io/almanac/v2"

  /** The file at `path` within the version at `versionPath`, as a listing holds it. */
  private def listedFile(versionPath: String, path: String, sizeBytes: Long = 412): ListedFile =
    ListedFile(
      s"$versionPath/$path",
      s"s3://texera-dataset/${path.hashCode.toHexString}",
      sizeBytes
    )

  private val letters =
    Seq(listedFile(lettersPath, "b.txt", 2), listedFile(lettersPath, "a.txt", 1))
  private val almanac = Seq(listedFile(almanacPath, "2024/moon.csv", 3))

  /**
    * A lister of `versions`: it lists the first files of each, as many as it is asked for, and
    * refuses any other version as one that is not there. `asked` lists what it was asked.
    */
  private def listerOf(
      versions: Map[String, Seq[ListedFile]],
      asked: ArrayBuffer[(String, Int)] = ArrayBuffer.empty
  ): DatasetVersionLister =
    (versionPath, atMost) => {
      asked += ((versionPath, atMost))
      versions
        .getOrElse(versionPath, throw new FileNotFoundException(versionPath))
        .take(atMost)
    }

  private val bothVersions = Map(lettersPath -> letters, almanacPath -> almanac)

  /** The link `listedFileLinker` makes for `file`. */
  private def linkOf(file: ListedFile): InputLink =
    InputLink(
      s"http://texera-rustfs:9000/${file.physicalAddress.stripPrefix("s3://")}?X-Amz-Signature=5ecr3t",
      86400000L,
      file.sizeBytes
    )

  /**
    * A linker of listed files, which lists those it was asked to link in `asked`. It is asked
    * for no file by its URI: `bindListedFiles` links only what was listed.
    */
  private def listedFileLinker(asked: ArrayBuffer[ListedFile] = ArrayBuffer.empty): InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = fail(s"asked to link $fileUri")
      override def linkListed(file: ListedFile): InputLink = {
        asked += file
        linkOf(file)
      }
    }

  /** A linker that is asked for nothing. */
  private val linksNothing: InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = fail(s"asked to link $fileUri")
      override def linkListed(file: ListedFile): InputLink =
        fail(s"asked to link the listed file ${file.logicalPath}")
    }

  private def fileLister(id: String, versionPath: String): FileListerSourceOpDesc = {
    val op = named(new FileListerSourceOpDesc, id)
    op.datasetVersionPath = versionPath
    op
  }

  private def fileScan(id: String): FileScanOpDesc = named(new FileScanOpDesc, id)

  /** The inputs a File Scan From Input of id `id` reads when `files` are linked for it. */
  private def inputsOf(id: String, files: Seq[ListedFile]): Seq[PlanInput] =
    files.map(file =>
      PlanInput(OperatorIdentity(id), file.logicalPath, InputFile(86400000L, file.sizeBytes))
    )

  private val noFileListerUpstream =
    "java.lang.IllegalArgumentException: File Scan From Input reads only the files a File " +
      "Lister upstream of it lists. Link a File Lister to its input, directly or through other " +
      "operators."

  "LogicalPlan.bindListedFiles" should
    "set on each File Lister the listing of its version, for a plan made to run" in {
    val lettersLister = fileLister("letters", lettersPath)
    val almanacLister = fileLister("almanac", almanacPath)
    val asked = ArrayBuffer.empty[(String, Int)]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = LogicalPlan(List(lettersLister, keyword(), almanacLister), List.empty)
      .bindListedFiles(Some(listerOf(bothVersions, asked)), linksNothing, 100, errors)

    assert(errors.isEmpty)
    // Each version is listed once, asked for one file more than may be listed.
    assert(asked.toList == List((lettersPath, 101), (almanacPath, 101)))
    // The files by their logical paths, in the order they were listed: not sorted again.
    assert(lettersLister.listing.contains(List(s"$lettersPath/b.txt", s"$lettersPath/a.txt")))
    assert(almanacLister.listing.contains(List(s"$almanacPath/2024/moon.csv")))
    // A File Lister reads no file: with nothing downstream to read them, nothing is linked.
    assert(inputs.isEmpty)
  }

  it should "link, for each File Scan From Input, the files listed upstream of it, by any path" in {
    // letters ─▶ direct          almanac ─▶ search ─▶ through
    // letters ─▶ union ◀─ almanac            union ─▶ both
    val lettersLister = fileLister("letters", lettersPath)
    val almanacLister = fileLister("almanac", almanacPath)
    val search = named(keyword(), "search")
    val union = named(new UnionOpDesc(), "union")
    val (direct, through, both) = (fileScan("direct"), fileScan("through"), fileScan("both"))
    val plan = LogicalPlan(
      List(both, lettersLister, direct, search, almanacLister, through, union),
      List(
        link(lettersLister.operatorIdentifier, direct.operatorIdentifier),
        link(almanacLister.operatorIdentifier, search.operatorIdentifier),
        link(search.operatorIdentifier, through.operatorIdentifier),
        link(lettersLister.operatorIdentifier, union.operatorIdentifier),
        link(almanacLister.operatorIdentifier, union.operatorIdentifier),
        link(union.operatorIdentifier, both.operatorIdentifier)
      )
    )
    val linked = ArrayBuffer.empty[ListedFile]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs =
      plan.bindListedFiles(Some(listerOf(bothVersions)), listedFileLinker(linked), 100, errors)

    assert(errors.isEmpty)
    // The executor looks a link up by the name an input tuple carries: the logical path.
    def linksOf(files: Seq[ListedFile]) = files.map(file => file.logicalPath -> linkOf(file)).toMap
    assert(direct.inputLinks == linksOf(letters))
    assert(through.inputLinks == linksOf(almanac))
    assert(both.inputLinks == linksOf(letters ++ almanac))
    // The linker is handed what was listed, a file for each operator that reads it.
    assert(linked.toList == (letters ++ almanac) ++ letters ++ almanac)
    // What the plan lists as read from outside the run: each file each operator reads, with
    // its link's expiry and the file's size, and never the link.
    assert(
      inputs == inputsOf("both", letters ++ almanac) ++ inputsOf("direct", letters) ++
        inputsOf("through", almanac)
    )
  }

  it should "link a file that two File Listers upstream list once" in {
    val first = fileLister("first", lettersPath)
    val second = fileLister("second", lettersPath)
    val scan = fileScan("scan")
    val plan = LogicalPlan(
      List(first, second, scan),
      List(
        link(first.operatorIdentifier, scan.operatorIdentifier),
        link(second.operatorIdentifier, scan.operatorIdentifier)
      )
    )
    val linked = ArrayBuffer.empty[ListedFile]

    // Two files between them: no more than it can read.
    val inputs = plan.bindListedFiles(
      Some(listerOf(bothVersions)),
      listedFileLinker(linked),
      2,
      ArrayBuffer.empty
    )

    assert(linked.toList == letters)
    assert(inputs == inputsOf("scan", letters))
  }

  it should "list and link nothing for a compile that makes no plan to run" in {
    val lister = fileLister("letters", lettersPath)
    val scan = fileScan("scan")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = LogicalPlan(
      List(lister, scan),
      List(link(lister.operatorIdentifier, scan.operatorIdentifier))
    ).bindListedFiles(None, linksNothing, 100, errors)

    assert(errors.isEmpty)
    assert(lister.listing.isEmpty)
    assert(scan.inputLinks.isEmpty)
    assert(inputs.isEmpty)
  }

  it should "drop the listing and the links an operator arrived with, whatever becomes of it" in {
    Seq(None, Some(listerOf(bothVersions))).foreach { lister =>
      val sent = fileLister("letters", lettersPath)
      // As a request could send them: a listing of the sender's choosing, and links to it.
      sent.listing = Some(List("/dataset/another@texera.io/secrets/v1/keys.txt"))
      val sentLinks = Map(
        "/dataset/another@texera.io/secrets/v1/keys.txt" -> sentLink,
        s"$lettersPath/a.txt" -> sentLink
      )
      // One scan below the File Lister, and one that is reported: no File Lister feeds it.
      val (scan, unfed) = (fileScan("scan"), fileScan("unfed"))
      scan.inputLinks = sentLinks
      unfed.inputLinks = sentLinks

      LogicalPlan(
        List(sent, scan, unfed),
        List(link(sent.operatorIdentifier, scan.operatorIdentifier))
      ).bindListedFiles(lister, listedFileLinker(), 100, ArrayBuffer.empty)

      withClue(s"with ${lister.fold("no lister")(_ => "a lister")}: ") {
        assert(sent.listing == lister.map(_ => letters.map(_.logicalPath).toList))
        assert(
          scan.inputLinks ==
            lister.fold(Map.empty[String, InputLink])(_ =>
              letters.map(file => file.logicalPath -> linkOf(file)).toMap
            )
        )
        assert(unfed.inputLinks.isEmpty)
      }
    }
  }

  it should "report a File Scan From Input with no File Lister upstream, in every compile" in {
    Seq(None, Some(listerOf(bothVersions))).foreach { lister =>
      // Names from a Text Input, no input at all, and a File Lister that is in the plan but
      // not upstream; then one that a File Lister does feed.
      val names = named(new TextInputSourceOpDesc, "names")
      val elsewhere = fileLister("elsewhere", lettersPath)
      val (fed, alone, beside) = (fileScan("fed"), fileScan("alone"), fileScan("beside"))
      val search = named(keyword(), "search")
      val listed = fileScan("listed")
      val plan = LogicalPlan(
        List(names, elsewhere, fed, alone, beside, search, listed),
        List(
          link(names.operatorIdentifier, fed.operatorIdentifier),
          link(beside.operatorIdentifier, search.operatorIdentifier),
          link(elsewhere.operatorIdentifier, listed.operatorIdentifier)
        )
      )
      val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

      val inputs = plan.bindListedFiles(lister, listedFileLinker(), 100, errors)

      withClue(s"with ${lister.fold("no lister")(_ => "a lister")}: ") {
        assert(errors.map(_._1.id).toList == List("fed", "alone", "beside"))
        assert(errors.forall(_._2.toString == noFileListerUpstream))
        assert(inputs.map(_.logicalOperatorId.id).toSet == lister.map(_ => "listed").toSet)
      }
    }
  }

  it should "report a File Lister that names no dataset version, without asking for one" in {
    Seq(false, true).foreach { makesPlanToRun =>
      val unset = fileLister("unset", null)
      val blank = fileLister("blank", "  ")
      val scan = fileScan("scan")
      val asked = ArrayBuffer.empty[(String, Int)]
      val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

      LogicalPlan(
        List(unset, blank, scan),
        List(link(unset.operatorIdentifier, scan.operatorIdentifier))
      ).bindListedFiles(
        Option.when(makesPlanToRun)(listerOf(bothVersions, asked)),
        linksNothing,
        100,
        errors
      )

      withClue(s"for a plan ${if (makesPlanToRun) "made" else "not made"} to run: ") {
        // The File Scan From Input has no error of its own: a File Lister is upstream of it.
        assert(errors.map(_._1.id).toList == List("unset", "blank"))
        assert(
          errors.forall(
            _._2.toString == "java.lang.IllegalArgumentException: No dataset version " +
              "selected. Please select one in the 'Dataset' field in the right panel."
          )
        )
        assert(asked.isEmpty)
        assert(unset.listing.isEmpty && blank.listing.isEmpty)
      }
    }
  }

  it should "report a version the lister does not find on its File Lister, and go on" in {
    val missingPath = "/dataset/ada@texera.io/no-such-dataset/v1"
    val missing = fileLister("missing", missingPath)
    val found = fileLister("found", lettersPath)
    val scan = fileScan("scan")
    val plan = LogicalPlan(
      List(missing, found, scan),
      List(
        link(missing.operatorIdentifier, scan.operatorIdentifier),
        link(found.operatorIdentifier, scan.operatorIdentifier)
      )
    )
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    plan.bindListedFiles(Some(listerOf(bothVersions)), listedFileLinker(), 100, errors)

    // The error is the File Lister's alone, in words that name the version.
    assert(errors.map(_._1.id).toList == List("missing"))
    assert(
      errors.head._2.toString == "java.lang.IllegalArgumentException: Dataset version " +
        s"$missingPath was not found: it does not exist, or you do not have access to it."
    )
    assert(errors.head._2.getCause.isInstanceOf[FileNotFoundException])
    assert(missing.listing.isEmpty)
    // The File Lister after it is listed all the same.
    assert(found.listing.contains(letters.map(_.logicalPath).toList))
  }

  it should "report a File Lister whose version holds more files than may be listed" in {
    val within = fileLister("within", lettersPath)
    val beyond = fileLister("beyond", almanacPath)
    val asked = ArrayBuffer.empty[(String, Int)]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    // Two files may be listed: the letters are two, and the almanac here is three.
    val versions = Map(
      lettersPath -> letters,
      almanacPath -> Seq("a", "b", "c").map(listedFile(almanacPath, _))
    )

    LogicalPlan(List(within, beyond), List.empty)
      .bindListedFiles(Some(listerOf(versions, asked)), linksNothing, 2, errors)

    // One file beyond what may be listed is asked for, which is how a larger version is told.
    assert(asked.toList == List((lettersPath, 3), (almanacPath, 3)))
    assert(within.listing.contains(letters.map(_.logicalPath).toList))
    assert(errors.map(_._1.id).toList == List("beyond"))
    assert(
      errors.head._2.toString == "java.lang.IllegalArgumentException: Dataset version " +
        s"$almanacPath holds more files than the 2 a File Lister can list."
    )
    assert(beyond.listing.isEmpty)
  }

  it should "report a File Scan From Input with more files listed upstream than it can read" in {
    def plan(): (LogicalPlan, FileScanOpDesc) = {
      val lettersLister = fileLister("letters", lettersPath)
      val almanacLister = fileLister("almanac", almanacPath)
      val scan = fileScan("scan")
      // It arrives with a link, as a request could send one.
      scan.inputLinks = Map(s"$lettersPath/a.txt" -> sentLink)
      (
        LogicalPlan(
          List(lettersLister, almanacLister, scan),
          List(
            link(lettersLister.operatorIdentifier, scan.operatorIdentifier),
            link(almanacLister.operatorIdentifier, scan.operatorIdentifier)
          )
        ),
        scan
      )
    }

    // Each version is within what a File Lister may list; the three files between them are
    // one more than a File Scan From Input may read.
    val (tooMany, unlinked) = plan()
    val linked = ArrayBuffer.empty[ListedFile]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    val inputs =
      tooMany.bindListedFiles(Some(listerOf(bothVersions)), listedFileLinker(linked), 2, errors)

    assert(errors.map(_._1.id).toList == List("scan"))
    assert(
      errors.head._2.toString == "java.lang.IllegalArgumentException: The File Listers " +
        "upstream of File Scan From Input list 3 files, and it can read at most 2."
    )
    assert(linked.isEmpty && inputs.isEmpty && unlinked.inputLinks.isEmpty)

    // At exactly as many as it can read, they are linked.
    val (withinLimit, scan) = plan()
    val none = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    withinLimit.bindListedFiles(Some(listerOf(bothVersions)), listedFileLinker(), 3, none)
    assert(none.isEmpty)
    assert(scan.inputLinks.size == 3)
  }

  it should "ask for as many files as there can be when no fewer may be listed" in {
    val asked = ArrayBuffer.empty[(String, Int)]

    LogicalPlan(List(fileLister("letters", lettersPath)), List.empty).bindListedFiles(
      Some(listerOf(bothVersions, asked)),
      linksNothing,
      Int.MaxValue,
      ArrayBuffer.empty
    )

    assert(asked.toList == List((lettersPath, Int.MaxValue)))
  }

  it should "throw, as it is, a failure of the lister or the linker that is no operator's error" in {
    // The database or the storage not answering says nothing about the version: reported on
    // the File Lister, it would read as the user's mistake.
    val outage = new java.io.IOException("the storage did not answer")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    def plan(): LogicalPlan = {
      val lister = fileLister("letters", lettersPath)
      val scan = fileScan("scan")
      LogicalPlan(
        List(lister, scan),
        List(link(lister.operatorIdentifier, scan.operatorIdentifier))
      )
    }

    val fromLister = intercept[java.io.IOException] {
      plan().bindListedFiles(Some((_, _) => throw outage), linksNothing, 100, errors)
    }
    val fromLinker = intercept[java.io.IOException] {
      plan().bindListedFiles(
        Some(listerOf(bothVersions)),
        new InputLinker {
          override def link(fileUri: URI): InputLink = fail(s"asked to link $fileUri")
          override def linkListed(file: ListedFile): InputLink = throw outage
        },
        100,
        errors
      )
    }

    assert(fromLister eq outage)
    assert(fromLinker eq outage)
    assert(errors.isEmpty)
  }

  it should "leave operators that list and read no listed file untouched" in {
    // A scan source's link is bindScanFiles' to make, and to drop.
    val scan = csv()
    scan.inputLinks = Map("dataset:///repository/commit/data.csv" -> sentLink)
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = LogicalPlan(List(scan, keyword()), List.empty).bindListedFiles(
      Some((versionPath, _) => fail(s"asked to list $versionPath")),
      linksNothing,
      100,
      errors
    )

    assert(errors.isEmpty)
    assert(inputs.isEmpty)
    assert(scan.inputLinks == Map("dataset:///repository/commit/data.csv" -> sentLink))
  }

  // ---------------------------------------------------------------------------
  // applyCompileSettings
  // ---------------------------------------------------------------------------

  "LogicalPlan.applyCompileSettings" should
    "set the column limit on every CSV scan, in place of any it held" in {
    val unset = csv()
    val sent = csv()
    sent.maxColumns = Some(100000)
    val plan = LogicalPlan(List(unset, sent, keyword()), List.empty)

    plan.applyCompileSettings(CompileSettings.Default.copy(csvParserMaxColumns = 77))

    assert(unset.maxColumns.contains(77))
    assert(sent.maxColumns.contains(77))
  }

  it should "leave an operator that reads no setting of the site's as it is" in {
    val others = List(keyword(), TestOperators.smallJSONLScanOpDesc(), new LimitOpDesc())
    val before = others.map(objectMapper.writeValueAsString)

    LogicalPlan(others, List.empty)
      .applyCompileSettings(CompileSettings.Default.copy(csvParserMaxColumns = 77))

    assert(others.map(objectMapper.writeValueAsString) == before)
  }
}
