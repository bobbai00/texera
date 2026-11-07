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

import com.fasterxml.jackson.annotation.{JsonIgnore, JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.core.executor.OperatorExecutor
import org.apache.texera.amber.core.tuple.{Attribute, Schema, Tuple, TupleLike}
import org.apache.texera.amber.operator.builtin.expr.{AggregateState, Aggregated, Env, Expressions}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import scala.collection.mutable
import scala.jdk.CollectionConverters._

/**
  * `aggregate(t, by=["patient_id"], outputs=["lows = count_if(glucose < 70)", "mean = avg(glucose)"])`:
  * one row per group of the `by` columns (one row in all when there are none), with each output
  * computed over the group's rows. Rows are spread over workers by the `by` columns, so each
  * worker holds whole groups and every aggregate is exact, the median included.
  */
class AggregateOp extends BuiltinOp {
  @JsonProperty
  @JsonSchemaTitle("By")
  @JsonPropertyDescription("The columns whose values make a group; absent: one group of every row")
  var by: java.util.List[String] = _

  @JsonProperty(required = true)
  @JsonSchemaTitle("Outputs")
  @JsonPropertyDescription(
    "Output columns in order, each name = an aggregate over the group's rows: mean = avg(glucose)"
  )
  var outputs: java.util.List[String] = new java.util.ArrayList()

  @JsonIgnore override def name = "aggregate"
  @JsonIgnore override def summary =
    "One row per group, with counts, sums, means and other aggregates."
  @JsonIgnore def keys: List[String] = Option(by).map(_.asScala.toList).getOrElse(Nil)
  @JsonIgnore override def split: Split = if (keys.isEmpty) Split.OneWorker else Split.ByKey(keys)

  /** Each output, compiled against the input's columns. */
  def compiled(input: Schema): List[(String, Aggregated)] = {
    val named = BuiltinOp.named("outputs", Option(outputs).map(_.asScala.toList).getOrElse(Nil))
    named.foreach {
      case (n, _) =>
        if (keys.contains(n))
          throw new SettingError(n, s"""$n is also a by column; name the output otherwise""")
    }
    named.map { case (n, e) => n -> BuiltinOp.checked(n)(Expressions.aggregate(e, input)) }
  }

  override def outputColumns(inputs: List[Schema]): Schema = {
    val input = inputs.head
    val groups = BuiltinOp.columnsOf("by", keys, input).map(input.getAttribute)
    Schema(groups ++ compiled(input).map { case (n, a) => new Attribute(n, a.tpe) })
  }
  @JsonIgnore override def executor: String = classOf[AggregateExec].getName
}

class AggregateExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[AggregateOp])
  private var outputs: Array[Aggregated] = _
  private var keyIndices: Array[Int] = _
  private val groups = mutable.LinkedHashMap[List[Any], Array[Array[AggregateState]]]()
  private val env = new Env

  private def start(schema: Schema): Unit =
    if (outputs == null) {
      outputs = op.compiled(schema).map(_._2).toArray
      keyIndices = op.keys.map(schema.getIndex).toArray
    }

  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    start(tuple.getSchema)
    val key = keyIndices.map(i => tuple.getField[Any](i)).toList
    val states = groups.getOrElseUpdate(key, outputs.map(_.newStates()))
    var i = 0
    while (i < outputs.length) { outputs(i).add(states(i), tuple, env); i += 1 }
    Iterator.empty
  }

  // No row in, no row out: a worker that saw nothing has no group, not even the one of no by.
  override def onFinish(port: Int): Iterator[TupleLike] =
    groups.iterator.map {
      case (key, states) => TupleLike(key ++ outputs.indices.map(i => outputs(i).result(states(i))))
    }
}
