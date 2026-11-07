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

package org.apache.texera.amber.operator.builtin

import org.apache.texera.amber.core.executor.OperatorExecutor
import org.apache.texera.amber.core.tuple.{
  Attribute,
  AttributeType,
  Schema,
  SchemaEnforceable,
  Tuple
}
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class BuiltinOpsSpec extends AnyFlatSpec with Matchers {
  import AttributeType._

  private def schema(cols: (String, AttributeType)*) =
    Schema(cols.map { case (n, t) => new Attribute(n, t) }.toList)
  private val readings = schema("patient_id" -> STRING, "hour" -> INTEGER, "glucose" -> DOUBLE)
  private val labs = schema("patient_id" -> STRING, "a1c" -> DOUBLE)
  private def r(s: Schema, values: Any*) = Tuple(s, values.toArray)
  private val rows = List(
    r(readings, "P-1", 23, 64.0),
    r(readings, "P-1", 2, 58.0),
    r(readings, "P-2", 12, 181.0),
    r(readings, "P-2", 23, null),
    r(readings, "P-3", 3, 99.0)
  )

  /** An operator as a workflow's JSON gives it, read back the way the engine reads it. */
  private def op[T <: LogicalOp](json: String): T =
    objectMapper.readValue(json, classOf[LogicalOp]).asInstanceOf[T]

  /** Runs an executor over rows on one port, then finishes; the output as the given schema enforces it. */
  private def run(
      exec: OperatorExecutor,
      out: Schema,
      inputs: (Int, List[Tuple])*
  ): List[List[Any]] = {
    exec.open()
    val produced = inputs.toList.flatMap {
      case (port, tuples) => tuples.flatMap(t => exec.processTuple(t, port)) ++ exec.onFinish(port)
    }
    exec.close()
    produced.map {
      case t: Tuple             => t.getFields.toList
      case s: SchemaEnforceable => s.enforceSchema(out).getFields.toList
      case other                => fail(s"not a row: $other")
    }
  }
  private def json(o: LogicalOp): String = objectMapper.writeValueAsString(o)

  "A built-in" should "be read from its line's JSON by its name, with flat settings" in {
    val f = op[FilterOp](
      """{"operatorType": "filter", "operatorID": "night", "where": "hour >= 22 or hour < 6"}"""
    )
    f.where shouldBe "hour >= 22 or hour < 6"
    f.operatorInfo.operatorGroupName shouldBe "Core"
    f.operatorInfo.inputPorts.map(_.disallowMultiLinks) shouldBe List(true)
    op[UnionOp]("""{"operatorType": "union"}""").operatorInfo.inputPorts
      .map(_.disallowMultiLinks) shouldBe List(false)
    op[JoinOp]("""{"operatorType": "join", "on": ["patient_id"]}""").operatorInfo.inputPorts
      .map(_.displayName) shouldBe List("left", "right")
  }

  "filter" should "keep the rows where the condition is true, and name the setting of a mistake" in {
    val f = op[FilterOp]("""{"operatorType": "filter", "where": "hour >= 22 or hour < 6"}""")
    f.outputColumns(List(readings)) shouldBe readings
    run(new FilterExec(json(f)), readings, 0 -> rows)
      .map(_.head) shouldBe List("P-1", "P-1", "P-2", "P-3")
    val wrong = op[FilterOp]("""{"operatorType": "filter", "where": "hours > 22"}""")
    intercept[SettingError](
      wrong.outputColumns(List(readings))
    ).getMessage shouldBe """where: the input has no column "hours"; did you mean "hour"?"""
  }

  "project" should "keep, drop and rename columns" in {
    val p = op[ProjectOp](
      """{"operatorType": "project", "keep": ["glucose", "patient_id"], "rename": {"glucose": "mg_dl"}}"""
    )
    p.outputColumns(List(readings)) shouldBe schema("mg_dl" -> DOUBLE, "patient_id" -> STRING)
    run(new ProjectExec(json(p)), p.outputColumns(List(readings)), 0 -> rows.take(1)) shouldBe List(
      List(64.0, "P-1")
    )
    op[ProjectOp]("""{"operatorType": "project", "drop": ["hour"]}""").outputColumns(
      List(readings)
    ) shouldBe schema("patient_id" -> STRING, "glucose" -> DOUBLE)
    intercept[SettingError](
      op[ProjectOp]("""{"operatorType": "project", "keep": ["a"], "drop": ["b"]}""").outputColumns(
        List(readings)
      )
    ).setting shouldBe "keep"
    intercept[SettingError](
      op[ProjectOp]("""{"operatorType": "project", "rename": {"hour": "glucose"}}""").outputColumns(
        List(readings)
      )
    ).getMessage should include("two columns would be named")
  }

  "compute" should "replace a column it names and add the others, typed by their expressions" in {
    val c = op[ComputeOp](
      """{"operatorType": "compute", "columns": ["glucose = round(glucose / 18.016, 1)", "low = glucose < 70"]}"""
    )
    val out = c.outputColumns(List(readings))
    out shouldBe schema(
      "patient_id" -> STRING,
      "hour" -> INTEGER,
      "glucose" -> DOUBLE,
      "low" -> BOOLEAN
    )
    run(new ComputeExec(json(c)), out, 0 -> rows.take(2)) shouldBe List(
      List("P-1", 23, 3.6, true),
      List("P-1", 2, 3.2, true)
    )
    intercept[SettingError](
      op[ComputeOp]("""{"operatorType": "compute", "columns": ["x = glucose +"]}""").outputColumns(
        List(readings)
      )
    ).setting shouldBe "x"
  }

  "aggregate" should "give one row per group, exact over the group's rows" in {
    val a = op[AggregateOp](
      """{"operatorType": "aggregate", "by": ["patient_id"], "outputs": ["n = count(*)", "lows = count_if(glucose < 70)", "mean = avg(glucose)"]}"""
    )
    val out = a.outputColumns(List(readings))
    out shouldBe schema("patient_id" -> STRING, "n" -> LONG, "lows" -> LONG, "mean" -> DOUBLE)
    a.split shouldBe Split.ByKey(List("patient_id"))
    run(new AggregateExec(json(a)), out, 0 -> rows) shouldBe List(
      List("P-1", 2L, 2L, 61.0),
      List("P-2", 2L, 0L, 181.0),
      List("P-3", 1L, 0L, 99.0)
    )
    op[AggregateOp](
      """{"operatorType": "aggregate", "outputs": ["n = count(*)"]}"""
    ).split shouldBe Split.OneWorker
    intercept[SettingError](
      op[AggregateOp]("""{"operatorType": "aggregate", "outputs": ["m = glucose"]}""")
        .outputColumns(List(readings))
    ).getMessage should include("needs an aggregate")
  }

  "join" should "match on keys, keep the unmatched rows its kind keeps, and never match NULL keys" in {
    val left = List(r(labs, "P-1", 7.1), r(labs, "P-9", 6.0), r(labs, null, 5.5))
    val right =
      List(r(readings, "P-1", 23, 64.0), r(readings, "P-2", 12, 181.0), r(readings, null, 1, 1.0))
    def joined(how: String): List[List[Any]] = {
      val j = op[JoinOp](s"""{"operatorType": "join", "on": ["patient_id"], "how": "$how"}""")
      run(new JoinProbeExec(json(j)), j.outputColumns(List(labs, readings)), 0 -> left, 1 -> right)
    }
    val j = op[JoinOp]("""{"operatorType": "join", "on": ["patient_id"]}""")
    j.outputColumns(List(labs, readings)) shouldBe schema(
      "patient_id" -> STRING,
      "a1c" -> DOUBLE,
      "hour" -> INTEGER,
      "glucose" -> DOUBLE
    )
    joined("inner") shouldBe List(List("P-1", 7.1, 23, 64.0))
    joined("left").toSet shouldBe Set(
      List("P-1", 7.1, 23, 64.0),
      List("P-9", 6.0, null, null),
      List(null, 5.5, null, null)
    )
    joined("right").toSet shouldBe Set(
      List("P-1", 7.1, 23, 64.0),
      List("P-2", null, 12, 181.0),
      List(null, null, 1, 1.0)
    )
    joined("full").size shouldBe 5
    joined("semi") shouldBe List(List("P-1", 7.1))
    joined("anti").toSet shouldBe Set(List("P-9", 6.0), List(null, 5.5))
    val clash = schema("patient_id" -> STRING, "a1c" -> DOUBLE)
    intercept[SettingError](
      j.outputColumns(List(labs, clash))
    ).getMessage shouldBe """on: both inputs have a column named "a1c"; rename one with project first"""
    intercept[SettingError](
      op[JoinOp]("""{"operatorType": "join", "on": ["patient_id"], "how": "outer"}""")
        .outputColumns(List(labs, readings))
    ).setting shouldBe "how"
    op[JoinOp](
      """{"operatorType": "join", "on": ["patient_id = patient_id"]}"""
    ).keyPairs shouldBe List("patient_id" -> "patient_id")
  }

  "distinct, sort and limit" should "keep first rows per key, order rows, and keep a window of them" in {
    val d = op[DistinctOp]("""{"operatorType": "distinct", "columns": ["patient_id"]}""")
    run(new DistinctExec(json(d)), readings, 0 -> rows)
      .map(_.head) shouldBe List("P-1", "P-2", "P-3")
    val s = op[SortOp]("""{"operatorType": "sort", "by": ["glucose desc"], "nulls": "first"}""")
    s.outputColumns(List(readings)) shouldBe readings
    run(new SortExec(json(s)), readings, 0 -> rows)
      .map(_(2)) shouldBe List(null, 181.0, 99.0, 64.0, 58.0)
    val asc = op[SortOp]("""{"operatorType": "sort", "by": ["patient_id", "hour desc"]}""")
    run(new SortExec(json(asc)), readings, 0 -> rows).map(t => (t.head, t(1))) shouldBe List(
      ("P-1", 23),
      ("P-1", 2),
      ("P-2", 23),
      ("P-2", 12),
      ("P-3", 3)
    )
    val l = op[LimitOp]("""{"operatorType": "limit", "n": 2, "offset": 1}""")
    run(new LimitExec(json(l)), readings, 0 -> rows).map(_(1)) shouldBe List(2, 12)
    intercept[SettingError](
      op[LimitOp]("""{"operatorType": "limit", "n": 0}""").outputColumns(List(readings))
    ).setting shouldBe "n"
  }
}

class NamedExpressionsSpec extends AnyFlatSpec with Matchers {
  "Named expressions" should "keep their order and take a quoted name" in {
    BuiltinOp.named(
      "outputs",
      List(
        "n = count(*)",
        "\"low share\" = count_if(glucose < 70) / count(*)",
        "is_70 = glucose = 70"
      )
    ) shouldBe
      List(
        "n" -> "count(*)",
        "low share" -> "count_if(glucose < 70) / count(*)",
        "is_70" -> "glucose = 70"
      )
  }

  it should "say what is missing" in {
    intercept[SettingError](
      BuiltinOp.named("outputs", List("count(*)"))
    ).getMessage shouldBe "outputs: 'count(*)' needs a name: write it as name = expression"
    intercept[SettingError](
      BuiltinOp.named("outputs", List("n = count(*)", "n = sum(x)"))
    ).getMessage shouldBe "outputs: two of them are named \"n\""
    intercept[SettingError](BuiltinOp.named("columns", Nil)).getMessage should include(
      "name at least one"
    )
  }
}
