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
import org.apache.texera.amber.core.executor.{OpExecWithClassName, SourceOperatorExecutor}
import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.core.tuple.{Attribute, Schema, Tuple, TupleLike}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow._
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import scala.jdk.CollectionConverters._

/**
  * `stored`: the rows an earlier run stored for a port, read back. The catalog puts it in place
  * of an operator whose result it reuses: the operator keeps its id, what reads it reads the
  * stored rows, and what only fed it does not run. It names the table where the catalog
  * recorded it, by warehouse, namespace and name, with the columns the catalog read from the
  * lake, so the plan compiles without opening the table.
  */
class StoredOp extends LogicalOp {
  @JsonProperty
  @JsonSchemaTitle("Warehouse")
  @JsonPropertyDescription(
    "The warehouse, by its name in the lake catalog; empty: the unit's default"
  )
  var warehouse: String = ""

  @JsonProperty(required = true)
  @JsonSchemaTitle("Namespace")
  @JsonPropertyDescription("The namespace of the run that stored it")
  var namespace: String = ""

  @JsonProperty(required = true)
  @JsonSchemaTitle("Table")
  @JsonPropertyDescription("The table the port's rows are stored in")
  var table: String = ""

  @JsonProperty(required = true)
  @JsonSchemaTitle("Columns")
  @JsonPropertyDescription("The table's columns, in order")
  var columns: java.util.List[Attribute] = new java.util.ArrayList()

  @JsonProperty
  @JsonSchemaTitle("From")
  @JsonPropertyDescription("The port whose result this is, as its URI")
  var from: String = ""

  @JsonIgnore def schema: Schema = {
    val cols = Option(columns).map(_.asScala.toList).getOrElse(Nil)
    if (cols.isEmpty) throw new SettingError("columns", "the stored table's columns are not here")
    Schema(cols)
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp =
    PhysicalOp
      .sourcePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithClassName(classOf[StoredExec].getName, objectMapper.writeValueAsString(this))
      )
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withParallelizable(false)
      .withPropagateSchema(
        SchemaPropagationFunc(_ => Map(operatorInfo.outputPorts.head.id -> schema))
      )

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "stored",
      "Read the rows an earlier run stored for a port; the catalog puts it in place of a result it reuses.",
      OperatorGroupConstants.UTILITY_GROUP,
      inputPorts = Nil,
      outputPorts = List(OutputPort())
    )
}

class StoredExec(descString: String) extends SourceOperatorExecutor {
  private val op = objectMapper.readValue(descString, classOf[StoredOp])

  override def produceTuple(): Iterator[TupleLike] = {
    val (document, _) =
      DocumentFactory.openTable(Option(op.warehouse).filter(_.nonEmpty), op.namespace, op.table)
    // Each row as its values in order, under the columns the plan compiled with.
    document.get().map {
      case t: Tuple => TupleLike(t.getFields.toList.asJava)
      case other    => throw new IllegalStateException(s"not a row: $other")
    }
  }
}
