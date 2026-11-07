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

package org.apache.texera.amber.operator.builtin.expr

import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.sql.Timestamp

class ExpressionsSpec extends AnyFlatSpec with Matchers {

  private val readings = Schema(
    List(
      new Attribute("patient_id", AttributeType.STRING),
      new Attribute("taken_at", AttributeType.TIMESTAMP),
      new Attribute("glucose", AttributeType.DOUBLE),
      new Attribute("age", AttributeType.INTEGER),
      new Attribute("insulin", AttributeType.BOOLEAN),
      new Attribute("note text", AttributeType.STRING)
    )
  )

  private def at(local: String): Timestamp = Timestamp.valueOf(local)

  private def row(
      patient: String,
      takenAt: String,
      glucose: java.lang.Double,
      age: Integer,
      insulin: java.lang.Boolean,
      note: String = null
  ) =
    Tuple(
      readings,
      Array[Any](patient, if (takenAt == null) null else at(takenAt), glucose, age, insulin, note)
    )

  private val night = row("P-1", "2026-11-01 23:30:00", 64.0, 52, true, "after dinner")
  private val day = row("P-2", "2026-11-02 12:00:00", 180.5, 17, false)
  private val missing = row("P-3", null, null, null, null)

  private def eval(text: String, r: Tuple = night): Any = Expressions.value(text, readings)(r)
  private def holds(text: String, r: Tuple = night): Boolean =
    Expressions.condition(text, readings).holds(r)
  private def error(text: String): ExprError =
    intercept[ExprError](Expressions.value(text, readings))

  "A condition" should "keep a row only where it is true" in {
    holds("glucose < 70") shouldBe true
    holds("glucose < 70", day) shouldBe false
    holds("glucose < 70", missing) shouldBe false // NULL is not true
    holds("hour(taken_at) >= 22 or hour(taken_at) < 6") shouldBe true
    holds("hour(taken_at) >= 22 or hour(taken_at) < 6", day) shouldBe false
    holds("age >= 18 and insulin") shouldBe true
    holds("not insulin", day) shouldBe true
    holds("patient_id in ('P-1', 'P-9')") shouldBe true
    holds("patient_id not in ('P-1')", day) shouldBe true
    holds("glucose between 60 and 70") shouldBe true
    holds("\"note text\" like 'after%'") shouldBe true
    holds("\"note text\" is null", day) shouldBe true
    holds("taken_at >= '2026-11-02'", day) shouldBe true
  }

  it should "follow three-valued logic with NULLs" in {
    eval("glucose < 70 or true", missing) shouldBe true
    eval("glucose < 70 and false", missing) shouldBe false
    Option(eval("glucose < 70 and true", missing)) shouldBe None
    Option(eval("not (glucose < 70)", missing)) shouldBe None
    eval("glucose in (1, null)", night).asInstanceOf[AnyRef] shouldBe null
  }

  it should "be refused when it is a value, not a condition" in {
    intercept[ExprError](Expressions.condition("glucose + 1", readings)).getMessage should include(
      "not a condition"
    )
  }

  "A value" should "add integers as a long, mix in a double as a double, and divide as a double" in {
    val sum = Expressions.value("age + 1", readings)
    sum.tpe shouldBe AttributeType.LONG
    sum(night) shouldBe 53L
    Expressions.value("glucose * 2", readings)(night) shouldBe 128.0
    Expressions.value("age / 8", readings).tpe shouldBe AttributeType.DOUBLE
    eval("age / 8") shouldBe 6.5
    Option(eval("age / 0")) shouldBe None
    eval("-age") shouldBe -52L
    eval("age % 5") shouldBe 2L
  }

  it should "compute CASE, CAST and TRY_CAST" in {
    eval(
      "case when glucose < 70 then 'low' when glucose > 180 then 'high' else 'in range' end"
    ) shouldBe "low"
    eval(
      "case when glucose < 70 then 'low' when glucose > 180 then 'high' else 'in range' end",
      day
    ) shouldBe "high"
    eval("case when glucose > 1000 then 1 else 2.5 end") shouldBe 2.5
    eval("cast('12' as integer) + 1") shouldBe 13L
    Option(eval("try_cast('twelve' as double)")) shouldBe None
    intercept[ExprError](eval("cast('twelve' as double)")).getMessage should include(
      "cannot be read as a number"
    )
    eval("cast(age as text) || ' years'") shouldBe "52 years"
  }

  it should "use the function library" in {
    eval("round(glucose / 18.016, 2)") shouldBe 3.55
    eval("upper(patient_id)") shouldBe "P-1"
    eval("length(\"note text\")") shouldBe 12L
    eval("substr(patient_id, 3)") shouldBe "1"
    eval("coalesce(glucose, 0)", missing) shouldBe 0.0
    Option(eval("nullif(age, 52)")) shouldBe None
    eval("hour(taken_at)") shouldBe 23L
    eval("date_diff('hour', taken_at, '2026-11-02 05:30:00')") shouldBe 6L
    eval("date(taken_at)") shouldBe at("2026-11-01 00:00:00")
    eval("greatest(age, 60, 1)") shouldBe 60L
    eval("regexp_matches(patient_id, '^P-[0-9]+$')") shouldBe true
    eval("split_part('a/b/c', '/', 2)") shouldBe "b"
  }

  "A mistake" should "name the column and offer the closest one" in {
    val e = error("hour(taken) >= 22")
    e.getMessage shouldBe """the input has no column "taken"; did you mean "taken_at"?"""
    e.at shouldBe 5
    eval("Glucose * 2") shouldBe 128.0 // a different case still finds the one column
    intercept[ExprError](eval("\"Glucose\" * 2")).getMessage should include(
      "did you mean \"glucose\""
    ) // quoted is exact
  }

  it should "say what types do not go together, and how to fix it" in {
    error(
      "patient_id * 2"
    ).getMessage shouldBe "patient_id is text, not a number; read it as one with try_cast(patient_id AS double)"
    error("glucose < 'high'").getMessage should include("cannot be compared")
    error("avg(glucose)").getMessage should include("use it in aggregate's outputs")
    error("sqrt(glucose, 2)").getMessage shouldBe "sqrt takes 1 argument, not 2"
    error("sqr(glucose)").getMessage shouldBe "there is no function sqr; did you mean sqrt?"
    error("glucose < ").getMessage shouldBe "expected a value, found the end"
    error("'unclosed").getMessage should include("not closed")
    error("glucose ?").getMessage shouldBe "'?' has no meaning here"
  }

  "An aggregate" should "compute per group, skip NULLs, and combine aggregates" in {
    def over(text: String, rows: Tuple*): Any = {
      val agg = Expressions.aggregate(text, readings)
      val states = agg.newStates()
      val env = new Env
      rows.foreach(r => agg.add(states, r, env))
      agg.result(states)
    }
    over("avg(glucose)", night, day, missing) shouldBe 122.25
    over("count(*)", night, day, missing) shouldBe 3L
    over("count(glucose)", night, day, missing) shouldBe 2L
    over("count_if(glucose < 70) / count(*)", night, day, missing) shouldBe (1.0 / 3)
    over("count(distinct patient_id)", night, night, day) shouldBe 2L
    over("sum(age)", night, day, missing) shouldBe 69L
    over("min(taken_at)", night, day) shouldBe at("2026-11-01 23:30:00")
    over("max(patient_id)", night, day) shouldBe "P-2"
    over("median(glucose)", night, day, missing) shouldBe 122.25
    over("round(stddev(glucose), 3)", night, day) shouldBe 82.378
    Option(over("avg(glucose)", missing)) shouldBe None
    over("count(*)") shouldBe 0L
  }

  it should "be refused where no aggregate is, and on a column not aggregated" in {
    intercept[ExprError](Expressions.aggregate("glucose + 1", readings)).getMessage should include(
      "needs an aggregate"
    )
    intercept[ExprError](
      Expressions.aggregate("avg(patient_id)", readings)
    ).getMessage should include("avg needs numbers")
    intercept[ExprError](
      Expressions.aggregate("avg(avg(glucose))", readings)
    ).getMessage should include("aggregate")
  }
}
