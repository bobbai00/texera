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

package org.apache.texera.amber.operator.aggregate

import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple, TupleLike}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

/**
  * Both stages of an aggregation, end to end: two first-stage workers that each saw part of
  * every group (unevenly, as round-robin delivery leaves them), and the second stage that
  * merges what they emitted.
  */
class AggregateFinalOpExecSpec extends AnyFlatSpec with Matchers {

  private val input = Schema(
    List(
      new Attribute("city", AttributeType.STRING),
      new Attribute("sales", AttributeType.INTEGER)
    )
  )

  private def aggOp(fn: AggregationFunction, attr: String, result: String): AggregationOperation = {
    val a = new AggregationOperation()
    a.aggFunction = fn
    a.attribute = attr
    a.resultAttribute = result
    a
  }

  private val desc = {
    val d = new AggregateOpDesc
    d.groupByKeys = List("city")
    d.aggregations = List(
      aggOp(AggregationFunction.AVERAGE, "sales", "mean"),
      aggOp(AggregationFunction.COUNT, "sales", "n"),
      aggOp(AggregationFunction.SUM, "sales", "total"),
      aggOp(AggregationFunction.MIN, "sales", "low"),
      aggOp(AggregationFunction.MAX, "sales", "high")
    )
    d
  }
  private val descJson = objectMapper.writeValueAsString(desc)

  /** The first stage's output columns, as the plan propagates them. */
  private val partialSchema = Schema(
    new Attribute("city", AttributeType.STRING) ::
      desc.aggregations.flatMap(_.getPartialAttributes(AttributeType.INTEGER))
  )

  private def firstStage(rows: (String, Integer)*): List[TupleLike] = {
    val exec = new AggregateOpExec(descJson)
    exec.open()
    rows.foreach { case (city, sales) => exec.processTuple(Tuple(input, Array[Any](city, sales)), 0) }
    val out = exec.onFinish(0).toList
    exec.close()
    out
  }

  private def secondStage(partials: List[TupleLike]): Map[String, List[Any]] = {
    val exec = new AggregateFinalOpExec(descJson)
    exec.open()
    partials.foreach(p => exec.processTuple(Tuple(partialSchema, p.getFields.toArray), 0))
    val out = exec.onFinish(0).toList.map { t =>
      val fields = t.getFields.toList
      fields.head.asInstanceOf[String] -> fields.tail
    }.toMap
    exec.close()
    out
  }

  "The two stages of an aggregation" should "give the exact mean when a group splits unevenly" in {
    // Irvine: 10 and 60 on one worker, 20 on the other; its mean is 30, not 27.5.
    val worker1 = firstStage("Irvine" -> 10, "Irvine" -> 60, "Davis" -> 7)
    val worker2 = firstStage("Irvine" -> 20, "Davis" -> null, "Davis" -> 3)
    val result = secondStage(worker1 ++ worker2)

    result("Irvine") shouldBe List(30.0, 3, 90, 10, 60)
    result("Davis") shouldBe List(5.0, 2, 10, 3, 7)
  }

  it should "type the merged average as DOUBLE and keep the other results' types" in {
    desc.aggregations.map(_.getFinalAttribute(partialSchema)) shouldBe List(
      new Attribute("mean", AttributeType.DOUBLE),
      new Attribute("n", AttributeType.INTEGER),
      new Attribute("total", AttributeType.INTEGER),
      new Attribute("low", AttributeType.INTEGER),
      new Attribute("high", AttributeType.INTEGER)
    )
  }

  it should "emit nothing when no rows arrived" in {
    secondStage(firstStage() ++ firstStage()) shouldBe empty
  }
}
