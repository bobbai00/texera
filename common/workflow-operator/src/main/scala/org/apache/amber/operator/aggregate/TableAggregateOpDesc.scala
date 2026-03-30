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

package org.apache.amber.operator.aggregate

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow._
import org.apache.amber.operator.LogicalOp
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}

import javax.validation.constraints.{NotNull, Size}

class TableAggregateOpDesc extends LogicalOp {
  @JsonProperty(value = "aggregations", required = true)
  @JsonPropertyDescription("multiple aggregation functions")
  @NotNull(message = "aggregation cannot be null")
  @Size(min = 1, message = "aggregations cannot be empty")
  var aggregations: List[AggregationOperation] = List()

  @JsonProperty("groupByKeys")
  @JsonSchemaTitle("Group By Keys")
  @JsonPropertyDescription("group by columns")
  var groupByKeys: List[String] = List()

  private def generatePythonCode(): String = {
    if (groupByKeys == null) groupByKeys = List()

    val aggMap = aggregations
      .map { agg =>
        val func = agg.aggFunction match {
          case AggregationFunction.SUM     => "\"sum\""
          case AggregationFunction.COUNT   => "\"count\""
          case AggregationFunction.AVERAGE => "\"mean\""
          case AggregationFunction.MIN     => "\"min\""
          case AggregationFunction.MAX     => "\"max\""
          case AggregationFunction.CONCAT  => "lambda x: \",\".join(x.astype(str))"
        }
        s"""("${agg.attribute}", ${func}, "${agg.resultAttribute}")"""
      }
      .mkString(", ")

    val groupByList = groupByKeys.map(k => s""""$k"""").mkString(", ")

    s"""from pytexera import *
       |import pandas as pd
       |
       |class ProcessTablesOperator(UDFMultiTableOperator):
       |    INPUT_PORTS = ["input_1"]
       |
       |    def process_tables(self) -> Iterator[Optional[TableLike]]:
       |        table = self.input_1
       |        agg_specs = [$aggMap]
       |        group_by_keys = [$groupByList]
       |        agg_dict = {}
       |        rename_map = {}
       |        for attr, func, result_name in agg_specs:
       |            if attr not in agg_dict:
       |                agg_dict[attr] = []
       |            agg_dict[attr].append(func)
       |            rename_map[(attr, func if isinstance(func, str) else "custom")] = result_name
       |        if group_by_keys:
       |            grouped = table.groupby(group_by_keys, as_index=False)
       |        else:
       |            grouped = table
       |        # Build named aggregation for precise control
       |        named_aggs = {}
       |        for attr, func, result_name in agg_specs:
       |            named_aggs[result_name] = pd.NamedAgg(column=attr, aggfunc=func)
       |        if group_by_keys:
       |            result = table.groupby(group_by_keys, as_index=False).agg(**named_aggs)
       |        else:
       |            result = table.agg(**named_aggs).to_frame().T
       |        yield result
       |""".stripMargin
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    val fullCode = generatePythonCode()

    val propagateSchema = (_: Map[PortIdentity, Schema]) => {
      Map(operatorInfo.outputPorts.head.id -> Schema())
    }

    PhysicalOp
      .manyToOnePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(fullCode, "python")
      )
      .withParallelizable(false)
      .withDerivePartition(_ => UnknownPartition())
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withPartitionRequirement(List(None))
      .withIsOneToManyOp(true)
      .withPropagateSchema(SchemaPropagationFunc(propagateSchema))
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "Table Aggregate",
      "Calculate aggregation values using Python pandas",
      OperatorGroupConstants.AGGREGATE_GROUP,
      inputPorts = List(InputPort()),
      outputPorts = List(OutputPort(blocking = true))
    )
}
