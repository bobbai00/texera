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

package org.apache.amber.operator.join

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.{JsonSchemaInject, JsonSchemaTitle}
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow._
import org.apache.amber.operator.LogicalOp
import org.apache.amber.operator.hashJoin.JoinType
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.amber.operator.metadata.annotations.{
  AutofillAttributeName,
  AutofillAttributeNameOnPort1
}

@JsonSchemaInject(json = """
{
  "attributeTypeRules": {
    "buildAttributeName": {
      "const": {
        "$data": "probeAttributeName"
      }
    }
  }
}
""")
class JoinOpDesc extends LogicalOp {

  @JsonProperty(required = true)
  @JsonSchemaTitle("Left Input Attribute")
  @JsonPropertyDescription("attribute to be joined on the Left Input")
  var buildAttributeName: String = _

  @JsonProperty(required = true)
  @JsonSchemaTitle("Right Input Attribute")
  @JsonPropertyDescription("attribute to be joined on the Right Input")
  var probeAttributeName: String = _

  @JsonProperty(required = true, defaultValue = "inner")
  @JsonSchemaTitle("Join Type")
  @JsonPropertyDescription("select the join type to execute")
  var joinType: JoinType = JoinType.INNER

  private def generatePythonCode(): String = {
    // Pandas merge expects "left", "right", "outer", "inner"
    // but JoinType uses SQL-style "left outer", "right outer", "full outer"
    val joinTypeStr = joinType match {
      case JoinType.INNER       => "inner"
      case JoinType.LEFT_OUTER  => "left"
      case JoinType.RIGHT_OUTER => "right"
      case JoinType.FULL_OUTER  => "outer"
    }
    s"""from pytexera import *
       |import pandas as pd
       |
       |class ProcessTablesOperator(UDFMultiTableOperator):
       |    INPUT_PORTS = ["input_1", "input_2"]
       |
       |    def process_tables(self) -> Iterator[Optional[TableLike]]:
       |        left = self.input_1
       |        right = self.input_2
       |        left_key = "$buildAttributeName"
       |        right_key = "$probeAttributeName"
       |        join_type = "$joinTypeStr"
       |        result = left.merge(right, left_on=left_key, right_on=right_key, how=join_type, suffixes=("", "#@1"))
       |        if right_key != left_key and right_key in result.columns:
       |            result = result.drop(columns=[right_key])
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
      .withPartitionRequirement(List(None, None))
      .withIsOneToManyOp(true)
      .withPropagateSchema(SchemaPropagationFunc(propagateSchema))
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "Join",
      "join two inputs using Python pandas merge",
      OperatorGroupConstants.JOIN_GROUP,
      inputPorts = List(
        InputPort(PortIdentity(0), displayName = "left"),
        InputPort(
          PortIdentity(1),
          displayName = "right",
          dependencies = List(PortIdentity(0))
        )
      ),
      outputPorts = List(OutputPort(blocking = true))
    )
}
