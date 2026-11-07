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

import com.fasterxml.jackson.annotation.JsonIgnore
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow._
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.builtin.expr.{ExprError, Expressions, Names}
import org.apache.texera.amber.operator.metadata.OperatorInfo
import org.apache.texera.amber.util.JSONUtils.objectMapper

/** How a built-in operator's rows spread over workers. */
sealed trait Split
object Split {

  /** Any row on any worker: the input's batches go wherever there is room. */
  case object Anywhere extends Split

  /** Rows with the same values in these columns go to the same worker. */
  final case class ByKey(columns: List[String]) extends Split

  /** Everything on one worker. */
  case object OneWorker extends Split
}

/** A setting that is wrong, named, with what is wrong with it in the setting's terms. */
final class SettingError(val setting: String, message: String) extends RuntimeException(s"$setting: $message")

/**
  * A built-in operator: a name, its inputs and a few flat settings, as a workflow's line says it,
  * `set adults: filter(people, where="age >= 18")`. The class is the contract: its JSON
  * properties are the settings, `outputColumns` works out its output columns from its inputs' and says
  * what is wrong in a setting's terms, `split` says how its rows spread over workers, and
  * `executor` names what runs on each worker.
  */
abstract class BuiltinOp extends LogicalOp {

  /** The operator's name in a workflow's line: `filter`. */
  @JsonIgnore def name: String

  /** What it does, in one line, for the palette and for the agent. */
  @JsonIgnore def summary: String

  /** Its inputs, by name: one for most, `left` and `right` for a join. */
  @JsonIgnore def inputNames: List[String] = List("input")

  /** Whether its one input takes several links, whose rows arrive as one input (union). */
  @JsonIgnore def manyLinks: Boolean = false

  /** The output columns, from the input columns, in input order. */
  def outputColumns(inputs: List[Schema]): Schema

  @JsonIgnore def split: Split = Split.Anywhere

  /** The class of the worker's executor; it reads this operator's JSON. */
  @JsonIgnore def executor: String

  override def getPhysicalOp(workflowId: WorkflowIdentity, executionId: ExecutionIdentity): PhysicalOp = {
    val ports = operatorInfo.inputPorts
    val op = PhysicalOp
      .oneToOnePhysicalOp(workflowId, executionId, operatorIdentifier, OpExecWithClassName(executor, objectMapper.writeValueAsString(this)))
      .withInputPorts(ports)
      .withOutputPorts(operatorInfo.outputPorts)
      .withPropagateSchema(
        SchemaPropagationFunc(in => Map(operatorInfo.outputPorts.head.id -> outputColumns(ports.map(p => in(p.id)))))
      )
    split match {
      case Split.Anywhere => op
      case Split.ByKey(keys) =>
        op.withPartitionRequirement(ports.map(_ => Option(HashPartition(keys))))
          .withDerivePartition(_ => HashPartition(keys))
      case Split.OneWorker => op.withParallelizable(false)
    }
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      name,
      summary,
      BuiltinOp.Group,
      inputPorts = inputNames.zipWithIndex.map {
        case (input, i) =>
          InputPort(PortIdentity(i), displayName = if (inputNames.size > 1) input else "", disallowMultiLinks = !manyLinks)
      },
      outputPorts = List(OutputPort())
    )
}

object BuiltinOp {

  /** The palette's group of the built-in operators. */
  val Group = "Core"

  /** A setting's expression checked against the input's columns, its error named by the setting. */
  def checked[T](setting: String)(compile: => T): T =
    try compile
    catch { case e: ExprError => throw new SettingError(setting, e.getMessage) }

  /** A column a setting names, which must be one of the input's. */
  def column(setting: String, name: String, input: Schema): String =
    if (input.containsAttribute(name)) name
    else throw new SettingError(setting, Names.missing(name, input.getAttributeNames))

  /** The columns a setting names, each one of the input's. */
  def columnsOf(setting: String, names: Seq[String], input: Schema): List[String] =
    Option(names).toList.flatten.map(n => column(setting, n, input))

  /**
    * A list of named expressions, `name = expression` each, in order: what compute makes and what
    * aggregate outputs. A name is a word, or any text in double quotes.
    */
  def named(setting: String, entries: Seq[String]): List[(String, String)] = {
    val list = Option(entries).toList.flatten
    if (list.isEmpty) throw new SettingError(setting, "name at least one, as in n = count(*)")
    val pairs = list.map { entry =>
      val text = Option(entry).getOrElse("").trim
      val (name, rest) =
        if (text.startsWith("\"")) {
          val end = text.indexOf('"', 1)
          if (end < 0) throw new SettingError(setting, s"'$text': the name is not closed with a \"")
          (text.substring(1, end), text.substring(end + 1).trim)
        } else {
          val word = text.takeWhile(c => c.isLetterOrDigit || c == '_')
          (word, text.substring(word.length).trim)
        }
      if (name.isEmpty || !rest.startsWith("=") || rest.startsWith("=="))
        throw new SettingError(setting, s"'$text' needs a name: write it as name = expression")
      name -> rest.substring(1).trim
    }
    pairs.groupBy(_._1).collectFirst { case (n, xs) if xs.size > 1 => n }.foreach { n =>
      throw new SettingError(setting, s"""two of them are named "$n"""")
    }
    pairs
  }

  /** The type of a computed column, checked once so the error names the setting. */
  def typeOf(setting: String, expression: String, input: Schema): AttributeType =
    checked(setting)(Expressions.value(expression, input).tpe)
}
