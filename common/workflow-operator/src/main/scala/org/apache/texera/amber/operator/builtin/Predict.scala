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
import com.kjetland.jackson.jsonSchema.annotations.{JsonSchemaInject, JsonSchemaTitle}
import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow._
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.builtin.expr.Names
import org.apache.texera.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}

import scala.jdk.CollectionConverters._

/** What a model version reads and puts out, as its manifest says; the catalog fills it in. */
class ModelContract {
  @JsonProperty var framework: String = ""
  @JsonProperty var entry: String = ""
  @JsonProperty var inputs: java.util.List[Attribute] = new java.util.ArrayList()
  @JsonProperty var outputs: java.util.List[Attribute] = new java.util.ArrayList()
  @JsonProperty var needs: String = _
  @JsonProperty var grouped: Boolean = false
}

/**
  * `predict(cohort, model="texera://models/<rid>@2")`: a model version run on rows. The catalog
  * pins the model to a version and fills in the version's contract and its files, presigned for
  * the run; the line names only the model and, for a model that reads whole groups, `by`.
  *
  * The input must have every column the model reads, of a type it can read, which is checked
  * before anything runs. A model that reads rows one by one adds its outputs to every row, on
  * as many workers as there are; one that reads whole groups puts out its outputs for each group
  * after the group's keys, every group whole on one worker. It runs on Python workers, each of
  * which fetches the version's files and loads the model once.
  */
class PredictOp extends LogicalOp with PythonEnvironment {
  @JsonProperty(required = true)
  @JsonSchemaTitle("Model")
  @JsonPropertyDescription("The model version: texera://models/<rid>@<version>")
  var model: String = ""

  @JsonProperty
  @JsonSchemaTitle("By")
  @JsonPropertyDescription(
    "The columns whose rows reach the model together, each group on one worker: for a model that reads whole groups"
  )
  var by: java.util.List[String] = _

  @JsonProperty
  @JsonSchemaTitle("Contract")
  @JsonSchemaInject(json = """{"options": {"hidden": true}}""")
  @JsonPropertyDescription("What the version reads and puts out, filled in by the catalog")
  var contract: ModelContract = _

  @JsonProperty
  @JsonSchemaTitle("Files")
  @JsonSchemaInject(json = """{"options": {"hidden": true}}""")
  @JsonPropertyDescription("The version's files, by path, filled in by the catalog")
  var files: java.util.Map[String, String] = _

  @JsonIgnore def keys: List[String] = Option(by).map(_.asScala.toList).getOrElse(Nil)

  @JsonIgnore private def contractHere: ModelContract =
    Option(contract).getOrElse(
      throw new SettingError(
        "model",
        "the model's contract is not here: name a model version, as texera://models/<rid>@<version>"
      )
    )

  /** The input's columns and the model's outputs, or for a grouped model the keys and outputs. */
  def outputColumns(inputSchemas: List[Schema]): Schema = {
    val input = inputSchemas.head
    val c = contractHere
    if (c.grouped && keys.isEmpty)
      throw new SettingError(
        "by",
        "this model reads whole groups, such as one patient's readings: name the columns that make a group"
      )
    // Python reads columns by their exact names, whatever the engine forgives.
    val names = input.getAttributeNames
    keys.foreach { k =>
      if (!names.contains(k)) throw new SettingError("by", Names.missing(k, names))
    }
    c.inputs.asScala.foreach { wanted =>
      if (!names.contains(wanted.getName))
        throw new SettingError(
          "model",
          s"the model reads ${wanted.getName}: ${Names.missing(wanted.getName, names)}"
        )
      val have = input.getAttribute(wanted.getName).getType
      if (!PredictOp.fits(have, wanted.getType))
        throw new SettingError(
          "model",
          s"the model reads ${wanted.getName} as ${wanted.getType.getName}, and the input's is ${have.getName}: convert it in a compute first"
        )
    }
    val outputs = c.outputs.asScala.toList
    if (c.grouped) Schema(keys.map(input.getAttribute) ++ outputs)
    else {
      outputs.foreach { o =>
        if (input.containsAttribute(o.getName))
          throw new SettingError(
            "model",
            s"the model adds ${o.getName}, a column the input already has: rename that column with project first"
          )
      }
      input.add(outputs)
    }
  }

  /** The module a Python worker runs: an operator that loads the version and calls it. */
  @JsonIgnore def module: String = {
    val c = contractHere
    val base = if (c.grouped) "ModelTableOperator" else "ModelBatchOperator"
    def pairs(columns: java.util.List[Attribute]) =
      columns.asScala.map(a => List(a.getName, a.getType.getName).asJava).asJava
    List(
      "from pytexera import *",
      s"from pytexera import $base",
      "",
      "",
      s"class ProcessModelOperator($base):",
      s"    model = ${PythonModule.text(model)}",
      s"    framework = ${PythonModule.text(c.framework)}",
      s"    entry = ${PythonModule.text(c.entry)}",
      s"    files = __import__('json').loads(${PythonModule
        .json(Option(files).getOrElse(new java.util.HashMap[String, String]()))})",
      s"    inputs = __import__('json').loads(${PythonModule.json(pairs(c.inputs))})",
      s"    outputs = __import__('json').loads(${PythonModule.json(pairs(c.outputs))})",
      s"    keys = __import__('json').loads(${PythonModule.json(keys.asJava)})",
      ""
    ).mkString("\n")
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    val ports = operatorInfo.inputPorts
    val op = PhysicalOp
      .oneToOnePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(module, "python")
      )
      .withPveName(pveName)
      .withInputPorts(ports)
      .withOutputPorts(operatorInfo.outputPorts)
      .withIsOneToManyOp(true)
      .withDerivePartition(_ => UnknownPartition())
      .withPropagateSchema(
        SchemaPropagationFunc(in =>
          Map(operatorInfo.outputPorts.head.id -> outputColumns(ports.map(p => in(p.id))))
        )
      )
    if (keys.isEmpty) op
    else op.withPartitionRequirement(ports.map(_ => Option(HashPartition(keys))))
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "predict",
      "Run a model version on rows: the outputs its contract names, for each row or each group.",
      OperatorGroupConstants.MACHINE_LEARNING_GROUP,
      inputPorts = List(InputPort()),
      outputPorts = List(OutputPort())
    )
}

object PredictOp {

  private val Numbers = Set(AttributeType.INTEGER, AttributeType.LONG, AttributeType.DOUBLE)

  /** Whether a column of one type gives a model what it reads as another: numbers are numbers. */
  def fits(have: AttributeType, wanted: AttributeType): Boolean =
    have == wanted || (Numbers(have) && Numbers(wanted))
}
