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

package org.apache.amber.operator.projection

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow._
import org.apache.amber.operator.LogicalOp
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}

class TableProjectionOpDesc extends LogicalOp {

  @JsonProperty(required = true, defaultValue = "false")
  @JsonSchemaTitle("Drop Option")
  @JsonPropertyDescription("check to drop the selected attributes")
  var isDrop: Boolean = false

  var attributes: List[AttributeUnit] = List()

  private def generatePythonCode(): String = {
    val columns = attributes.map { attr =>
      s"""("${attr.getOriginalAttribute}", "${attr.getAlias}")"""
    }.mkString(", ")

    s"""from pytexera import *
       |import pandas as pd
       |
       |class ProcessTablesOperator(UDFMultiTableOperator):
       |    INPUT_PORTS = ["input_1"]
       |
       |    def process_tables(self) -> Iterator[Optional[TableLike]]:
       |        table = self.input_1
       |        is_drop = ${ if (isDrop) "True" else "False" }
       |        columns = [$columns]
       |        if is_drop:
       |            drop_cols = [orig for orig, alias in columns]
       |            yield table.drop(columns=drop_cols, errors="ignore")
       |        else:
       |            orig_cols = [orig for orig, alias in columns]
       |            result = table[orig_cols].copy()
       |            rename_map = {orig: alias for orig, alias in columns if orig != alias}
       |            if rename_map:
       |                result = result.rename(columns=rename_map)
       |            yield result
       |""".stripMargin
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    PhysicalOp
      .manyToOnePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(generatePythonCode(), "python")
      )
      .withParallelizable(false)
      .withDerivePartition(_ => UnknownPartition())
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withPartitionRequirement(List(None))
      .withIsOneToManyOp(true)
      .withPropagateSchema(
        SchemaPropagationFunc(_ => Map(operatorInfo.outputPorts.head.id -> Schema()))
      )
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "Table Projection",
      "Keeps or drops columns using Python pandas",
      OperatorGroupConstants.CLEANING_GROUP,
      inputPorts = List(InputPort()),
      outputPorts = List(OutputPort(blocking = true))
    )
}
