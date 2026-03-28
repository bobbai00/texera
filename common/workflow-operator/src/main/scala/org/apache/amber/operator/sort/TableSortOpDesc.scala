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

package org.apache.amber.operator.sort

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow._
import org.apache.amber.operator.LogicalOp
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}

class TableSortOpDesc extends LogicalOp {
  @JsonProperty(required = true)
  @JsonPropertyDescription("column to perform sorting on")
  var attributes: List[SortCriteriaUnit] = _

  private def generatePythonCode(): String = {
    val attributeNames = "[" + attributes
      .map(c => s""""${c.attributeName}"""")
      .mkString(", ") + "]"
    val sortOrders = "[" + attributes
      .map { c =>
        c.sortPreference match {
          case SortPreference.ASC  => "True"
          case SortPreference.DESC => "False"
        }
      }
      .mkString(", ") + "]"

    s"""from pytexera import *
       |import pandas as pd
       |
       |class ProcessTablesOperator(UDFMultiTableOperator):
       |    INPUT_PORTS = ["input_1"]
       |
       |    def process_tables(self) -> Iterator[Optional[TableLike]]:
       |        table = self.input_1
       |        sort_columns = $attributeNames
       |        ascending_orders = $sortOrders
       |        yield table.sort_values(by=sort_columns, ascending=ascending_orders)
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
      "Table Sort",
      "Sort based on columns and sorting methods using Python pandas",
      OperatorGroupConstants.SORT_GROUP,
      inputPorts = List(InputPort()),
      outputPorts = List(OutputPort(blocking = true))
    )
}
