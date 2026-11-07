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
import com.fasterxml.jackson.databind.ObjectMapper
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.{Attribute, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow._
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.builtin.expr.Names
import org.apache.texera.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}

import scala.jdk.CollectionConverters._

/**
  * `function`: a Python function as an operator. A project keeps the Python it reuses as custom
  * operators whose code is a function under `@returns(...)`; the catalog compiles a workflow's
  * call to one into this operator, with the code, the function's name, its declared columns,
  * its keyword arguments and `by`. People and agents write the function, never this operator:
  * the class that runs it is the engine's.
  *
  * It runs on Python workers as a table operator: each worker calls the function once, with the
  * rows it got from each input as a DataFrame. With `by`, rows with the same values in those
  * columns go to the same worker, so every group reaches one call whole and the work spreads
  * over the workers; without it, one worker gets every row. A function that reads no table is
  * a source, called once. Either may yield DataFrames as it makes them instead of returning one.
  */
class FunctionOp extends LogicalOp {
  @JsonProperty(required = true)
  @JsonSchemaTitle("Code")
  @JsonPropertyDescription("The Python module that defines the function")
  var code: String = ""

  @JsonProperty(required = true)
  @JsonSchemaTitle("Function")
  @JsonPropertyDescription("The function's name in the code")
  var function: String = ""

  @JsonProperty(required = true)
  @JsonSchemaTitle("Returns")
  @JsonPropertyDescription("Its output columns in order, each a name and a type: patient_id string")
  var returns: java.util.List[String] = new java.util.ArrayList()

  @JsonProperty
  @JsonSchemaTitle("By")
  @JsonPropertyDescription(
    "The columns whose rows reach one call together, each group on one worker; absent: one worker gets every row"
  )
  var by: java.util.List[String] = _

  @JsonProperty
  @JsonSchemaTitle("Arguments")
  @JsonPropertyDescription("The function's keyword arguments, by name")
  var args: java.util.Map[String, Object] = _

  @JsonProperty
  @JsonSchemaTitle("Inputs")
  @JsonPropertyDescription("Its inputs in order, one table each, by the function's parameter names")
  var inputs: java.util.List[String] = java.util.Arrays.asList("")

  @JsonIgnore def keys: List[String] = Option(by).map(_.asScala.toList).getOrElse(Nil)

  /** Its inputs' names; none for a function that reads no table, which is a source. */
  @JsonIgnore def inputNames: List[String] =
    Option(inputs).map(_.asScala.toList).getOrElse(List(""))

  @JsonIgnore def isSource: Boolean = inputNames.isEmpty

  /** The declared columns, each a name and its type. */
  @JsonIgnore def columns: List[Attribute] = {
    val entries = Option(returns).map(_.asScala.toList).getOrElse(Nil)
    if (entries.isEmpty)
      throw new SettingError("returns", "name at least one column, as patient_id string")
    val parsed = entries.map { entry =>
      Option(entry).getOrElse("").trim.split("\\s+").toList match {
        case List(name, tpe) =>
          new Attribute(
            name,
            Names
              .typeNamed(tpe)
              .getOrElse(
                throw new SettingError(
                  "returns",
                  s"""'$entry': $tpe is not a type; use string, integer, long, double, boolean or timestamp"""
                )
              )
          )
        case _ =>
          throw new SettingError(
            "returns",
            s"""'$entry': write a column as its name and type, as patient_id string"""
          )
      }
    }
    parsed.groupBy(_.getName).collectFirst { case (n, xs) if xs.size > 1 => n }.foreach { n =>
      throw new SettingError("returns", s"$n is named twice")
    }
    parsed
  }

  /** The output columns: the declared ones, once `by` names columns every input has. */
  def outputColumns(inputSchemas: List[Schema]): Schema = {
    if (!FunctionOp.Identifier.matches(Option(function).getOrElse("")))
      throw new SettingError("function", s"""'$function' is not a Python function's name""")
    if (isSource && keys.nonEmpty)
      throw new SettingError("by", "a function that reads no table has no rows to group")
    inputSchemas.foreach(input => BuiltinOp.columnsOf("by", keys, input))
    Schema(columns)
  }

  /** The module a Python worker runs: the code, then the operator that calls the function. */
  @JsonIgnore def module: String = {
    val declared = columns.map(a => List(a.getName, a.getType.getName).asJava).asJava
    val arguments = Option(args).getOrElse(new java.util.HashMap[String, Object]())
    def literal(value: Object): String = PythonModule.json(value)
    val caller =
      if (isSource) List("class GenerateOperator(FunctionSourceOperator):")
      else List("class ProcessTableOperator(FunctionOperator):")
    val reads =
      if (isSource) Nil
      else
        List(
          s"    inputs = ${inputNames.size}",
          s"    grouped = ${if (keys.nonEmpty) "True" else "False"}"
        )
    (List(
      "from pytexera import *",
      "from pytexera import FunctionOperator, FunctionSourceOperator, returns",
      "",
      code,
      "",
      ""
    ) ++ caller ++ List(
      s"    function = staticmethod($function)",
      s"    columns = __import__('json').loads(${literal(declared)})",
      s"    arguments = __import__('json').loads(${literal(arguments)})"
    ) ++ reads ++ List("")).mkString("\n")
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    val exec = OpExecWithCode(module, "python")
    if (isSource) {
      PhysicalOp
        .sourcePhysicalOp(workflowId, executionId, operatorIdentifier, exec)
        .withInputPorts(Nil)
        .withOutputPorts(operatorInfo.outputPorts)
        .withIsOneToManyOp(true)
        .withPropagateSchema(
          SchemaPropagationFunc(_ => Map(operatorInfo.outputPorts.head.id -> outputColumns(Nil)))
        )
        .withLocationPreference(Option.empty)
        .withParallelizable(false)
    } else {
      val ports = operatorInfo.inputPorts
      val op = PhysicalOp
        .oneToOnePhysicalOp(workflowId, executionId, operatorIdentifier, exec)
        .withInputPorts(ports)
        .withOutputPorts(operatorInfo.outputPorts)
        .withIsOneToManyOp(true)
        .withDerivePartition(_ => UnknownPartition())
        .withPropagateSchema(
          SchemaPropagationFunc(in =>
            Map(operatorInfo.outputPorts.head.id -> outputColumns(ports.map(p => in(p.id))))
          )
        )
      if (keys.isEmpty) op.withParallelizable(false)
      else op.withPartitionRequirement(ports.map(_ => Option(HashPartition(keys))))
    }
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "function",
      "Call a project's Python function on each worker's rows, grouped by some columns, or as a source.",
      OperatorGroupConstants.PYTHON_GROUP,
      inputPorts = inputNames.zipWithIndex.map {
        case (input, i) =>
          InputPort(PortIdentity(i), displayName = if (inputNames.size > 1) input else "")
      },
      outputPorts = List(OutputPort())
    )
}

/** How the engine writes values into the Python modules its operators run. */
object PythonModule {

  /** JSON as written, nulls included: an argument set to null reaches Python as None. */
  private val Json = new ObjectMapper()

  /** A value as a Python string holding its JSON, for `json.loads`: JSON's escapes are Python's. */
  def json(value: Object): String = Json.writeValueAsString(Json.writeValueAsString(value))

  /** A text as a Python string. */
  def text(value: String): String = Json.writeValueAsString(value)
}

object FunctionOp {

  /** A Python identifier, which a function's name must be. */
  val Identifier = "[A-Za-z_][A-Za-z0-9_]*".r
}
