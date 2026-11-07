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
import org.apache.texera.amber.operator.builtin.expr.{Computed, Condition, Expressions, Values}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import scala.collection.mutable
import scala.jdk.CollectionConverters._

/** `filter(t, where="glucose < 70")`: keeps the rows where the condition is true. */
class FilterOp extends BuiltinOp {
  @JsonProperty(required = true)
  @JsonSchemaTitle("Where")
  @JsonPropertyDescription("A condition over the input's columns; the rows where it is true are kept: glucose < 70 and age >= 18")
  var where: String = ""

  @JsonIgnore override def name = "filter"
  @JsonIgnore override def summary = "Keep the rows where a condition is true."
  override def outputColumns(inputs: List[Schema]): Schema = {
    BuiltinOp.checked("where")(Expressions.condition(where, inputs.head))
    inputs.head
  }
  @JsonIgnore override def executor: String = classOf[FilterExec].getName
}

class FilterExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[FilterOp])
  private var condition: Condition = _
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    if (condition == null) condition = Expressions.condition(op.where, tuple.getSchema)
    if (condition.holds(tuple)) Iterator.single(tuple) else Iterator.empty
  }
}

/** `project(t, keep=[...], drop=[...], rename={old: new})`: chooses and renames columns. */
class ProjectOp extends BuiltinOp {
  @JsonProperty
  @JsonSchemaTitle("Keep")
  @JsonPropertyDescription("The columns to keep, in this order; absent: all of them")
  var keep: java.util.List[String] = _

  @JsonProperty
  @JsonSchemaTitle("Drop")
  @JsonPropertyDescription("The columns to leave out")
  var drop: java.util.List[String] = _

  @JsonProperty
  @JsonSchemaTitle("Rename")
  @JsonPropertyDescription("New names for columns: {old: new}")
  var rename: java.util.LinkedHashMap[String, String] = _

  @JsonIgnore override def name = "project"
  @JsonIgnore override def summary = "Keep, drop or rename columns."

  /** The input columns that stay, in order, with their output names. */
  def chosen(input: Schema): List[(Attribute, String)] = {
    val keeps = Option(keep).map(_.asScala.toList).filter(_.nonEmpty)
    val drops = Option(drop).map(_.asScala.toList).getOrElse(Nil)
    if (keeps.isDefined && drops.nonEmpty) throw new SettingError("keep", "use keep or drop, not both")
    val renames = Option(rename).map(_.asScala.toList).getOrElse(Nil)
    renames.foreach { case (from, _) => BuiltinOp.column("rename", from, input) }
    val staying = keeps match {
      case Some(names) => BuiltinOp.columnsOf("keep", names, input)
      case None =>
        BuiltinOp.columnsOf("drop", drops, input)
        input.getAttributeNames.filterNot(drops.contains)
    }
    val out = staying.map(n => input.getAttribute(n) -> renames.toMap.getOrElse(n, n))
    out.groupBy(_._2).collectFirst { case (n, xs) if xs.size > 1 => n }.foreach { n =>
      throw new SettingError("rename", s"""two columns would be named "$n"""")
    }
    out
  }

  override def outputColumns(inputs: List[Schema]): Schema =
    Schema(chosen(inputs.head).map { case (a, n) => new Attribute(n, a.getType) })
  @JsonIgnore override def executor: String = classOf[ProjectExec].getName
}

class ProjectExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[ProjectOp])
  private var indices: Array[Int] = _
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    if (indices == null) indices = op.chosen(tuple.getSchema).map { case (a, _) => tuple.getSchema.getIndex(a.getName) }.toArray
    Iterator.single(TupleLike(indices.map(i => tuple.getField[Any](i))))
  }
}

/** `compute(t, columns=["mmol = glucose / 18.016"])`: adds columns, or replaces them where a name is taken. */
class ComputeOp extends BuiltinOp {
  @JsonProperty(required = true)
  @JsonSchemaTitle("Columns")
  @JsonPropertyDescription("New columns in order, each name = an expression over the input's columns: mmol = glucose / 18.016")
  var columns: java.util.List[String] = new java.util.ArrayList()

  @JsonIgnore override def name = "compute"
  @JsonIgnore override def summary = "Add or replace columns computed from each row."

  /** Each output column, and the expression that makes it when it is computed. */
  def layout(input: Schema): List[(Attribute, Option[String])] = {
    val computed = BuiltinOp.named("columns", Option(columns).map(_.asScala.toList).getOrElse(Nil))
    val typed = computed.map { case (n, e) => n -> (new Attribute(n, BuiltinOp.typeOf(n, e, input)), e) }.toMap
    val replaced = input.getAttributes.map(a => typed.get(a.getName).map { case (t, e) => t -> Some(e) }.getOrElse(a -> None))
    val added = computed.collect { case (n, _) if !input.containsAttribute(n) => typed(n)._1 -> Some(typed(n)._2) }
    replaced ++ added
  }

  override def outputColumns(inputs: List[Schema]): Schema = Schema(layout(inputs.head).map(_._1))
  @JsonIgnore override def executor: String = classOf[ComputeExec].getName
}

class ComputeExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[ComputeOp])
  /** Per output column: a computation, or the input column it copies. */
  private var makers: Array[Either[Int, Computed]] = _
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    if (makers == null)
      makers = op.layout(tuple.getSchema).map {
        case (_, Some(e)) => Right(Expressions.value(e, tuple.getSchema))
        case (a, None)    => Left(tuple.getSchema.getIndex(a.getName))
      }.toArray
    Iterator.single(TupleLike(makers.map {
      case Left(i)  => tuple.getField[Any](i)
      case Right(c) => c(tuple)
    }))
  }
}

/** `union(a, b, ...)`: the rows of every input, which must have the same columns. */
class UnionOp extends BuiltinOp {
  @JsonIgnore override def name = "union"
  @JsonIgnore override def summary = "Stack the rows of several inputs that have the same columns."
  @JsonIgnore override def manyLinks = true
  override def outputColumns(inputs: List[Schema]): Schema = inputs.head
  @JsonIgnore override def executor: String = classOf[PassExec].getName
}

class PassExec(descString: String) extends OperatorExecutor {
  // The one settings object a worker needs, though passing rows on reads none of it.
  private val op = objectMapper.readValue(descString, classOf[UnionOp])
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = Iterator.single(tuple)
}

/** `distinct(t, columns=[...])`: one row per value of the columns (all of them when none are named). */
class DistinctOp extends BuiltinOp {
  @JsonProperty
  @JsonSchemaTitle("Columns")
  @JsonPropertyDescription("The columns whose values make a row the same as another; absent: all of them")
  var columns: java.util.List[String] = _

  @JsonIgnore override def name = "distinct"
  @JsonIgnore override def summary = "Keep the first row for each value of some columns."
  @JsonIgnore def keys: List[String] = Option(columns).map(_.asScala.toList).getOrElse(Nil)
  override def outputColumns(inputs: List[Schema]): Schema = {
    BuiltinOp.columnsOf("columns", keys, inputs.head)
    inputs.head
  }
  @JsonIgnore override def split: Split = if (keys.isEmpty) Split.OneWorker else Split.ByKey(keys)
  @JsonIgnore override def executor: String = classOf[DistinctExec].getName
}

class DistinctExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[DistinctOp])
  private val seen = mutable.HashSet[List[Any]]()
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    val key = if (op.keys.isEmpty) tuple.getFields.toList else op.keys.map(tuple.getField[Any](_))
    if (seen.add(key)) Iterator.single(tuple) else Iterator.empty
  }
}

/** `sort(t, by=["glucose desc", "patient_id"], nulls="last")`: orders the rows. */
class SortOp extends BuiltinOp {
  @JsonProperty(required = true)
  @JsonSchemaTitle("By")
  @JsonPropertyDescription("The columns to order by, each ascending, or descending with ' desc' after its name")
  var by: java.util.List[String] = new java.util.ArrayList()

  @JsonProperty(defaultValue = "last")
  @JsonSchemaTitle("Nulls")
  @JsonPropertyDescription("Where rows with NULL go: first or last")
  var nulls: String = "last"

  @JsonIgnore override def name = "sort"
  @JsonIgnore override def summary = "Order the rows by some columns."
  @JsonIgnore override def split: Split = Split.OneWorker

  /** Each key: its column and whether it is descending. */
  def keys(input: Schema): List[(String, Boolean)] = {
    val wanted = Option(by).map(_.asScala.toList).getOrElse(Nil)
    if (wanted.isEmpty) throw new SettingError("by", "name at least one column to order by")
    if (nulls != "first" && nulls != "last") throw new SettingError("nulls", "first or last")
    wanted.map { key =>
      val parts = key.trim.split("\\s+").toList
      val descending = parts.lastOption.exists(_.equalsIgnoreCase("desc"))
      val name = if (parts.size > 1 && (descending || parts.last.equalsIgnoreCase("asc"))) parts.init.mkString(" ") else key.trim
      BuiltinOp.column("by", name, input) -> descending
    }
  }
  override def outputColumns(inputs: List[Schema]): Schema = { keys(inputs.head); inputs.head }
  @JsonIgnore override def executor: String = classOf[SortExec].getName
}

class SortExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[SortOp])
  private val rows = mutable.ArrayBuffer[Tuple]()
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = { rows += tuple; Iterator.empty }
  override def onFinish(port: Int): Iterator[TupleLike] = {
    if (rows.isEmpty) return Iterator.empty
    val keys = op.keys(rows.head.getSchema).map { case (n, d) => (rows.head.getSchema.getIndex(n), d) }
    val nullsFirst = op.nulls == "first"
    val ordering = new Ordering[Tuple] {
      def compare(a: Tuple, b: Tuple): Int = {
        var result = 0
        val it = keys.iterator
        while (result == 0 && it.hasNext) {
          val (i, descending) = it.next()
          val (x, y) = (a.getField[Any](i), b.getField[Any](i))
          result =
            if (x == null && y == null) 0
            else if (x == null) (if (nullsFirst) -1 else 1)
            else if (y == null) (if (nullsFirst) 1 else -1)
            else if (descending) -Values.compare(x, y)
            else Values.compare(x, y)
        }
        result
      }
    }
    rows.sorted(ordering).iterator
  }
}

/** `limit(t, n=10, offset=0)`: the first rows. Sort first for a top n. */
class LimitOp extends BuiltinOp {
  @JsonProperty(required = true)
  @JsonSchemaTitle("N")
  @JsonPropertyDescription("How many rows to keep")
  var n: Int = 10

  @JsonProperty(defaultValue = "0")
  @JsonSchemaTitle("Offset")
  @JsonPropertyDescription("How many rows to skip first")
  var offset: Int = 0

  @JsonIgnore override def name = "limit"
  @JsonIgnore override def summary = "Keep the first n rows; sort first for a top n."
  @JsonIgnore override def split: Split = Split.OneWorker
  override def outputColumns(inputs: List[Schema]): Schema = {
    if (n < 1) throw new SettingError("n", "keep at least one row")
    if (offset < 0) throw new SettingError("offset", "cannot be negative")
    inputs.head
  }
  @JsonIgnore override def executor: String = classOf[LimitExec].getName
}

class LimitExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[LimitOp])
  private var index = 0L
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    val i = index
    index += 1
    if (i >= op.offset && i < op.offset.toLong + op.n) Iterator.single(tuple) else Iterator.empty
  }
}
