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

package org.apache.texera.common.compiler.model

import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{PortIdentity, WorkflowContext}
import org.apache.texera.amber.operator.keywordSearch.KeywordSearchOpDesc
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.{FixtureInputs, LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.{
  CompileFor,
  CompileSettings,
  PythonEnvironmentNotResolved,
  WorkflowCompilationFailed,
  WorkflowCompiler
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import scala.jdk.CollectionConverters._

class LogicalPlanPojoSpec extends AnyFlatSpec with Matchers {

  private def op(id: String): LogicalOp = {
    val logicalOp = new KeywordSearchOpDesc()
    logicalOp.setOperatorId(id)
    logicalOp
  }

  private def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  private def plan(operators: List[LogicalOp], links: List[LogicalLink]): LogicalPlanPojo =
    LogicalPlanPojo(operators, links, List.empty, List.empty)

  private def ids(pojo: LogicalPlanPojo): List[String] = pojo.operators.map(_.operatorIdentifier.id)

  // --- upstreamOf ---

  "LogicalPlanPojo.upstreamOf" should
    "keep the target and the operators upstream of it, in the plan's order, with their links" in {
    // a -> b -> c, d -> c, c -> z, and an unrelated e.
    val whole = LogicalPlanPojo(
      operators = List(op("e"), op("a"), op("b"), op("z"), op("c"), op("d")),
      links = List(link("a", "b"), link("c", "z"), link("b", "c"), link("d", "c")),
      opsToViewResult = List("z"),
      opsToReuseResult = List("a", "e", "z")
    )

    val upToC = whole.upstreamOf("c")

    // "z" is downstream of the target and "e" unrelated: a run up to "c" runs neither.
    ids(upToC) shouldBe List("a", "b", "c", "d")
    upToC.links shouldBe List(link("a", "b"), link("b", "c"), link("d", "c"))
    // The run views the target's result, and can reuse only results of operators it keeps.
    upToC.opsToViewResult shouldBe List("c")
    upToC.opsToReuseResult shouldBe List("a")
  }

  it should "keep an operator two paths share once" in {
    // a -> b -> d and a -> c -> d.
    val diamond = plan(
      List(op("a"), op("b"), op("c"), op("d")),
      List(link("a", "b"), link("a", "c"), link("b", "d"), link("c", "d"))
    )

    val upToD = diamond.upstreamOf("d")

    ids(upToD) shouldBe List("a", "b", "c", "d")
    upToD.links should have size 4
  }

  it should "keep only the target when nothing is upstream of it" in {
    val upToA = plan(List(op("a"), op("b")), List(link("a", "b"))).upstreamOf("a")

    ids(upToA) shouldBe List("a")
    upToA.links shouldBe empty
    upToA.opsToViewResult shouldBe List("a")
  }

  it should "return a plan that has no such operator whole, as it is" in {
    val whole = LogicalPlanPojo(List(op("a"), op("b")), List(link("a", "b")), List("b"), List("a"))

    whole.upstreamOf("ghost") should be theSameInstanceAs whole
    whole.upstreamOf("") should be theSameInstanceAs whole
  }

  it should "end on links that form a cycle" in {
    // The compiler refuses such a plan (graphProblem); cutting it must not loop forever.
    val cyclic = plan(List(op("a"), op("b"), op("c")), List(link("a", "b"), link("b", "a")))

    ids(cyclic.upstreamOf("b")) shouldBe List("a", "b")
  }

  it should "leave the plan it cuts as it was" in {
    val whole = plan(List(op("a"), op("b")), List(link("a", "b")))

    whole.upstreamOf("a")

    ids(whole) shouldBe List("a", "b")
    whole.links shouldBe List(link("a", "b"))
  }

  // --- graphProblem ---

  "LogicalPlanPojo.graphProblem" should "find none in a plan the compiler reads" in {
    plan(
      List(op("a"), op("b"), op("c"), op("d")),
      List(link("a", "b"), link("a", "c"), link("b", "d"), link("c", "d"))
    ).graphProblem() shouldBe None
    plan(List.empty, List.empty).graphProblem() shouldBe None
    // Lists of results naming operators the plan does not have are the compiler's to pass over.
    LogicalPlanPojo(List(op("a")), List.empty, List("ghost"), List("ghost")).graphProblem() shouldBe
      None
  }

  it should "find a plan with no list of operators or links" in {
    plan(null, List.empty).graphProblem() shouldBe Some("The workflow lists no operators.")
    plan(List.empty, null).graphProblem() shouldBe Some("The workflow lists no links.")
  }

  it should "find an operator or a link that is null" in {
    plan(List(op("a"), null), List.empty).graphProblem() shouldBe
      Some("The workflow lists an operator that is null.")
    plan(List(op("a")), List(null)).graphProblem() shouldBe
      Some("The workflow lists a link that is null.")
  }

  it should "find an operator with no id" in {
    val unnamed = new LimitOpDesc()
    unnamed.setOperatorId(null)
    val blank = new LimitOpDesc()
    blank.setOperatorId("")

    plan(List(op("a"), unnamed), List.empty).graphProblem() shouldBe
      Some("The workflow has a LimitOpDesc with no operator id.")
    plan(List(blank), List.empty).graphProblem() shouldBe
      Some("The workflow has a LimitOpDesc with no operator id.")
  }

  it should "find an operator listed twice" in {
    plan(List(op("a"), op("b"), op("a"), op("b")), List.empty).graphProblem() shouldBe
      Some("Operator a is in the workflow twice.")
  }

  it should "find a link that names an operator the plan does not have" in {
    plan(List(op("a")), List(link("a", "ghost"))).graphProblem() shouldBe
      Some("The link from a to ghost names operator ghost, which the workflow does not have.")
    plan(List(op("a")), List(link("ghost", "a"))).graphProblem() shouldBe
      Some("The link from ghost to a names operator ghost, which the workflow does not have.")
  }

  it should "find a link that names no port" in {
    val noOutput = LogicalLink(OperatorIdentity("a"), null, OperatorIdentity("b"), PortIdentity())
    val noInput = LogicalLink(OperatorIdentity("a"), PortIdentity(), OperatorIdentity("b"), null)

    plan(List(op("a"), op("b")), List(noOutput)).graphProblem() shouldBe
      Some("The link from a to b names no output port of a.")
    plan(List(op("a"), op("b")), List(noInput)).graphProblem() shouldBe
      Some("The link from a to b names no input port of b.")
  }

  it should "find links that form a cycle, and name the operators along it" in {
    // s -> a -> b -> c -> a, and c -> t: the cycle is a, b, c.
    val cyclic = plan(
      List(op("s"), op("a"), op("b"), op("c"), op("t")),
      List(link("s", "a"), link("a", "b"), link("b", "c"), link("c", "a"), link("c", "t"))
    )

    cyclic.graphProblem() shouldBe Some("The workflow's links form a cycle: a -> b -> c -> a.")
    plan(List(op("a"), op("b")), List(link("a", "b"), link("b", "a"))).graphProblem() shouldBe
      Some("The workflow's links form a cycle: a -> b -> a.")
  }

  it should "find no cycle where paths only meet again" in {
    // Two paths from a to d, and a long chain after: no operator is reached from itself.
    val chain = (1 to 5000).map(i => op(s"n$i")).toList
    val chainLinks = chain
      .sliding(2)
      .collect {
        case List(from, to) => link(from.operatorIdentifier.id, to.operatorIdentifier.id)
      }
      .toList
    plan(
      List(op("a"), op("b"), op("c"), op("d")) ++ chain,
      List(link("a", "b"), link("a", "c"), link("b", "d"), link("c", "d"), link("d", "n1")) ++
        chainLinks
    ).graphProblem() shouldBe None
  }

  it should "report the first problem it finds, the plan's own before its links'" in {
    plan(List(op("a"), op("a")), List(link("a", "ghost"))).graphProblem() shouldBe
      Some("Operator a is in the workflow twice.")
  }

  it should "find the plans the compiler fails on outside any operator" in {
    // What the check stands for: given these, a compile throws no operator's error.
    def compiles(pojo: LogicalPlanPojo): Either[Throwable, Unit] =
      try {
        new WorkflowCompiler(
          new WorkflowContext(),
          CompileFor.Run(
            files = TestOperators.fixtureFileResolver,
            settings = CompileSettings.Default,
            locator = FixtureInputs.locator,
            lister = FixtureInputs.lister,
            repositories = TestOperators.fixtureRepositoryResolver,
            environments = name => throw PythonEnvironmentNotResolved.noSuchEnvironment(name)
          )
        ).compile(pojo)
        Right(())
      } catch { case failure: Throwable => Left(failure) }
    val cyclic = plan(List(op("a"), op("b")), List(link("a", "b"), link("b", "a")))
    val dangling = plan(List(op("a")), List(link("a", "ghost")))

    Seq(cyclic, dangling).foreach { pojo =>
      pojo.graphProblem() should not be empty
      compiles(pojo) match {
        case Left(_: WorkflowCompilationFailed) => fail("an operator's error, not the graph's")
        case Left(_)                            => succeed
        case Right(_)                           => fail(s"${pojo.graphProblem()} compiled")
      }
    }
  }

  // --- listProblem ---

  "LogicalPlanPojo.listProblem" should "find a list that is missing or holds null, and nothing else" in {
    plan(null, List.empty).listProblem() shouldBe Some("The workflow lists no operators.")
    plan(List.empty, null).listProblem() shouldBe Some("The workflow lists no links.")
    plan(List(op("a"), null), List.empty).listProblem() shouldBe
      Some("The workflow lists an operator that is null.")
    plan(List(op("a")), List(null)).listProblem() shouldBe
      Some("The workflow lists a link that is null.")
    // What graphProblem finds besides is for a plan whose lists can be read, cut first if need be.
    val unnamed = new LimitOpDesc()
    unnamed.setOperatorId(null)
    Seq(
      plan(List(unnamed), List.empty),
      plan(List(op("a"), op("a")), List.empty),
      plan(List(op("a")), List(link("a", "ghost"))),
      plan(List(op("a"), op("b")), List(link("a", "b"), link("b", "a")))
    ).foreach { pojo =>
      pojo.graphProblem() should not be empty
      pojo.listProblem() shouldBe None
    }
  }

  // --- toJson ---

  "LogicalPlanPojo.toJson" should "parse back to the plan, its operators' loop-variable references included" in {
    // A Limit as the editor sends it in a loop block: "$n" where its Int goes, and a search whose
    // String keeps "$k" as it is.
    val limit = objectMapper.readValue(
      """{"operatorID":"limit","operatorType":"Limit","limit":"$n"}""",
      classOf[LogicalOp]
    )
    val search = op("search")
    search.asInstanceOf[KeywordSearchOpDesc].keyword = "$k"
    val sent =
      LogicalPlanPojo(List(search, limit), List(link("search", "limit")), List("limit"), Nil)
    limit.stateReferences shouldBe Map("/limit" -> "n")

    val json = sent.toJson

    val written = objectMapper.readTree(json)
    written.get("operators").get(1).get("limit").asText() shouldBe "$n"
    written.get("operators").get(0).get("keyword").asText() shouldBe "$k"
    written.get("operators").elements().asScala.exists(_.has("stateReferences")) shouldBe false
    val read = objectMapper.readValue(json, classOf[LogicalPlanPojo])
    ids(read) shouldBe List("search", "limit")
    read.operators.map(_.stateReferences) shouldBe List(Map.empty, Map("/limit" -> "n"))
    read.links shouldBe sent.links
    read.opsToViewResult shouldBe List("limit")
    // Written as it is, the plan reads back with the placeholder and without the reference.
    val lossy =
      objectMapper.readValue(objectMapper.writeValueAsString(sent), classOf[LogicalPlanPojo])
    lossy.operators(1).stateReferences shouldBe empty
    lossy.operators(1).asInstanceOf[LimitOpDesc].limit shouldBe 0
  }

  it should "write a plan with no reference as a mapper does, but for the empty sidecars" in {
    val pojo = plan(List(op("a"), op("b")), List(link("a", "b")))

    val written = objectMapper.readTree(pojo.toJson)
    val expected = objectMapper.readTree(objectMapper.writeValueAsString(pojo))
    expected.get("operators").elements().asScala.foreach {
      _.asInstanceOf[ObjectNode].remove("stateReferences")
    }

    written shouldBe expected
  }

  it should "write a null where the plan lists one in place of an operator" in {
    val written = objectMapper.readTree(plan(List(op("a"), null), List.empty).toJson)

    written.get("operators").get(0).get("operatorID").asText() shouldBe "a"
    written.get("operators").get(1).isNull shouldBe true
  }

  // --- the wire form ---

  "LogicalPlanPojo" should "write only its four lists, so a plan written is read back" in {
    val pojo = LogicalPlanPojo(List(op("a")), List.empty, List("a"), Nil)

    val written = objectMapper.readTree(objectMapper.writeValueAsString(pojo))

    written.fieldNames().asScala.toList shouldBe
      List("operators", "links", "opsToViewResult", "opsToReuseResult")
    val read =
      objectMapper.readValue(objectMapper.writeValueAsString(pojo), classOf[LogicalPlanPojo])
    ids(read) shouldBe List("a")
    read.opsToViewResult shouldBe List("a")
  }
}
