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
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OperatorExecutor}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema, Tuple, TupleLike}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, PhysicalOpIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow._
import org.apache.texera.amber.util.JSONUtils.objectMapper

import scala.collection.mutable
import scala.jdk.CollectionConverters._

/**
  * `join(left, right, on=["patient_id"], how="inner")`: rows of the two inputs whose keys are
  * equal. A key is a column both inputs have, or `left_name = right_name`. `how` is inner, left,
  * right or full (keeping the rows of a side without a match, with NULLs for the other side), or
  * semi and anti (the left rows with a match, or without one, each once, with the left's columns).
  * The output has the left's columns, then the right's but its keys. A right column whose name
  * the left also has is an error, named, so nothing is renamed behind anyone's back.
  *
  * It runs in two steps, as Amber's hash join does: every left row first, kept by key on the
  * worker of its key, then the right rows, matched as they arrive. NULL keys never match.
  */
class JoinOp extends BuiltinOp {
  @JsonProperty(required = true)
  @JsonSchemaTitle("On")
  @JsonPropertyDescription("The keys: a column both inputs have, or left_column = right_column")
  var on: java.util.List[String] = new java.util.ArrayList()

  @JsonProperty(defaultValue = "inner")
  @JsonSchemaTitle("How")
  @JsonPropertyDescription("inner, left, right, full, semi or anti")
  var how: String = "inner"

  @JsonIgnore override def name = "join"
  @JsonIgnore override def summary = "Match the rows of two inputs on key columns."
  @JsonIgnore override def inputNames: List[String] = List("left", "right")
  @JsonIgnore override def executor: String = classOf[JoinProbeExec].getName

  /** The key pairs, (left column, right column). */
  @JsonIgnore def keyPairs: List[(String, String)] = {
    val keys = Option(on).map(_.asScala.toList).getOrElse(Nil)
    if (keys.isEmpty) throw new SettingError("on", "name at least one key column")
    keys.map { k =>
      k.split("=", 2).map(_.trim).toList match {
        case List(l, r) if l.nonEmpty && r.nonEmpty => l -> r
        case List(both) if both.nonEmpty             => both -> both
        case _                                       => throw new SettingError("on", s"'$k' is not a column, nor left_column = right_column")
      }
    }
  }

  /** Whether the output carries the right's columns: not for semi and anti. */
  @JsonIgnore def withRight: Boolean = how != "semi" && how != "anti"

  override def outputColumns(inputs: List[Schema]): Schema = {
    val (left, right) = (inputs.head, inputs(1))
    if (!JoinOp.kinds.contains(how)) throw new SettingError("how", "inner, left, right, full, semi or anti")
    val pairs = keyPairs
    pairs.foreach {
      case (l, r) =>
        BuiltinOp.column("on", l, left)
        BuiltinOp.column("on", r, right)
        val (lt, rt) = (left.getAttribute(l).getType, right.getAttribute(r).getType)
        if (lt != rt && !(JoinOp.numeric.contains(lt) && JoinOp.numeric.contains(rt)))
          throw new SettingError("on", s"$l and $r hold different kinds of values; make them one kind with compute first")
    }
    if (!withRight) return left
    val rightKeys = pairs.map(_._2).toSet
    val rights = right.getAttributes.filterNot(a => rightKeys.contains(a.getName))
    rights.find(a => left.containsAttribute(a.getName)).foreach { a =>
      throw new SettingError("on", s"""both inputs have a column named "${a.getName}"; rename one with project first""")
    }
    Schema(left.getAttributes ++ rights)
  }

  override def getPhysicalPlan(workflowId: WorkflowIdentity, executionId: ExecutionIdentity): PhysicalPlan = {
    val pairs = keyPairs
    val leftPort = operatorInfo.inputPorts.head
    val rightPort = operatorInfo.inputPorts(1)
    val kept = OutputPort(PortIdentity(0, internal = true), blocking = true)
    val build = PhysicalOp
      .oneToOnePhysicalOp(PhysicalOpIdentity(operatorIdentifier, "build"), workflowId, executionId, OpExecWithClassName(classOf[JoinBuildExec].getName, objectMapper.writeValueAsString(this)))
      .withInputPorts(List(leftPort))
      .withOutputPorts(List(kept))
      .withPartitionRequirement(List(Option(HashPartition(pairs.map(_._1)))))
      .withPropagateSchema(SchemaPropagationFunc(in => Map(kept.id -> in(leftPort.id))))
      .withParallelizable(true)
    val keptIn = InputPort(PortIdentity(0, internal = true))
    val probeIn = InputPort(rightPort.id, dependencies = List(keptIn.id))
    val probe = PhysicalOp
      .oneToOnePhysicalOp(PhysicalOpIdentity(operatorIdentifier, "probe"), workflowId, executionId, OpExecWithClassName(executor, objectMapper.writeValueAsString(this)))
      .withInputPorts(List(keptIn, probeIn))
      .withOutputPorts(operatorInfo.outputPorts)
      .withPartitionRequirement(List(Option(HashPartition(pairs.map(_._1))), Option(HashPartition(pairs.map(_._2)))))
      .withDerivePartition(_ => HashPartition(pairs.map(_._1)))
      .withParallelizable(true)
      .withPropagateSchema(SchemaPropagationFunc(in => Map(operatorInfo.outputPorts.head.id -> outputColumns(List(in(keptIn.id), in(probeIn.id))))))
    PhysicalPlan(operators = Set(build, probe), links = Set(PhysicalLink(build.id, kept.id, probe.id, keptIn.id)))
  }
}

object JoinOp {
  val kinds: Set[String] = Set("inner", "left", "right", "full", "semi", "anti")
  private val numeric = Set(AttributeType.INTEGER, AttributeType.LONG, AttributeType.DOUBLE)
}

/** The join's first step: the left rows, passed on to be kept by key. */
class JoinBuildExec(descString: String) extends OperatorExecutor {
  // The one settings object a worker needs, though passing rows on reads none of it.
  private val op = objectMapper.readValue(descString, classOf[JoinOp])
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = Iterator.single(tuple)
}

/**
  * The join's second step: the left rows kept by key (port 0), then each right row matched as it
  * arrives (port 1). Rows are put together by column name, so a side without a match is NULL.
  */
class JoinProbeExec(descString: String) extends OperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[JoinOp])
  /** The left rows by key; those with a NULL key under `null`, kept only to be output unmatched. */
  private val kept = mutable.LinkedHashMap[List[Any], mutable.ArrayBuffer[Tuple]]()
  private val matched = mutable.Set[List[Any]]()
  private var leftKeys: List[Int] = _
  private var rightKeys: List[Int] = _

  private def keyOf(t: Tuple, indices: List[Int]): List[Any] = indices.map(i => t.getField[Any](i))
  private def named(t: Tuple, skip: Set[String] = Set.empty): Seq[(String, Any)] =
    t.getSchema.getAttributeNames.filterNot(skip.contains).map(n => n -> t.getField[Any](n))

  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] =
    if (port == 0) {
      if (leftKeys == null) leftKeys = op.keyPairs.map(p => tuple.getSchema.getIndex(p._1))
      val key = keyOf(tuple, leftKeys)
      kept.getOrElseUpdate(if (key.contains(null)) null else key, mutable.ArrayBuffer()) += tuple
      Iterator.empty
    } else {
      if (rightKeys == null) rightKeys = op.keyPairs.map(p => tuple.getSchema.getIndex(p._2))
      val key = keyOf(tuple, rightKeys)
      val lefts = if (key.contains(null)) None else kept.get(key)
      lefts.foreach(_ => matched += key)
      if (!op.withRight) Iterator.empty
      else {
        val rights = named(tuple, op.keyPairs.map(_._2).toSet)
        lefts match {
          case Some(rows) => rows.iterator.map(l => TupleLike((named(l) ++ rights).toMap))
          case None if op.how == "right" || op.how == "full" =>
            // The left's keys take the right's values, so the row says which key it is.
            val keys = op.keyPairs.map { case (l, r) => l -> tuple.getField[Any](r) }
            Iterator.single(TupleLike((keys ++ rights).toMap))
          case None => Iterator.empty
        }
      }
    }

  override def onFinish(port: Int): Iterator[TupleLike] =
    if (port != 1) Iterator.empty
    else {
      def unmatched = kept.iterator.collect { case (k, rows) if k == null || !matched.contains(k) => rows }.flatten
      op.how match {
        case "semi"          => kept.iterator.collect { case (k, rows) if k != null && matched.contains(k) => rows }.flatten
        case "anti"          => unmatched
        case "left" | "full" => unmatched.map(l => TupleLike(named(l).toMap))
        case _               => Iterator.empty
      }
    }
}
