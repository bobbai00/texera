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

package org.apache.amber.operator.udf.python

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.google.common.base.Preconditions
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.{Attribute, Schema}
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow._
import org.apache.amber.operator.LogicalOp
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.amber.operator.metadata.annotations.CommonOpDescAnnotation
import com.kjetland.jackson.jsonSchema.annotations.{
  JsonSchemaInject,
  JsonSchemaString,
  JsonSchemaInt
}

class DualInputPortsPythonUDFOpDescV2 extends LogicalOp {
  @JsonProperty(
    required = true,
    defaultValue =
      "# Choose from the following templates:\n" +
        "# \n" +
        "# from pytexera import *\n" +
        "# \n" +
        "# class ProcessTupleOperator(UDFOperatorV2):\n" +
        "#     \n" +
        "#     @overrides\n" +
        "#     def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:\n" +
        "#         yield tuple_\n" +
        "# \n" +
        "# class ProcessBatchOperator(UDFBatchOperator):\n" +
        "#     BATCH_SIZE = 10 # must be a positive integer\n" +
        "# \n" +
        "#     @overrides\n" +
        "#     def process_batch(self, batch: Batch, port: int) -> Iterator[Optional[BatchLike]]:\n" +
        "#         yield batch\n" +
        "# \n" +
        "# class ProcessTableOperator(UDFTableOperator):\n" +
        "# \n" +
        "#     @overrides\n" +
        "#     def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:\n" +
        "#         yield table\n"
  )
  @JsonSchemaTitle("Python script")
  @JsonPropertyDescription("Input your code here")
  var code: String = ""

  @JsonProperty(required = true, defaultValue = "1")
  @JsonSchemaTitle("Worker count")
  @JsonPropertyDescription("Specify how many parallel workers to launch")
  var workers: Int = Int.box(1)

  @JsonProperty
  @JsonSchemaTitle("Output column(s)")
  @JsonPropertyDescription(
    "The output schema of the UDF. When connected, defaults to the input schema from the tuples port."
  )
  @JsonSchemaInject(
    strings = Array(
      new JsonSchemaString(path = CommonOpDescAnnotation.autofill, value = "attributeList")
    ),
    ints = Array(
      // Port 1 is the "tuples" port, which provides the input schema
      new JsonSchemaInt(path = CommonOpDescAnnotation.autofillAttributeOnPort, value = 1)
    )
  )
  var outputColumns: List[Attribute] = List()

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    Preconditions.checkArgument(workers >= 1, "Need at least 1 worker.", Array())
    val physicalOp = if (workers > 1) {
      PhysicalOp
        .oneToOnePhysicalOp(
          workflowId,
          executionId,
          operatorIdentifier,
          OpExecWithCode(code, "python")
        )
        .withParallelizable(true)
        .withSuggestedWorkerNum(workers)
    } else {
      PhysicalOp
        .manyToOnePhysicalOp(
          workflowId,
          executionId,
          operatorIdentifier,
          OpExecWithCode(code, "python")
        )
        .withParallelizable(false)
    }
    physicalOp
      .withDerivePartition(_ => UnknownPartition())
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withPropagateSchema(
        SchemaPropagationFunc(inputSchemas => {
          Preconditions.checkArgument(inputSchemas.size == 2)

          // outputColumns is the source of truth for the output schema
          val outputSchema = if (outputColumns != null && outputColumns.nonEmpty) {
            Schema().add(outputColumns)
          } else {
            Schema()
          }

          Map(operatorInfo.outputPorts.head.id -> outputSchema)
        })
      )
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "2-in Python UDF",
      "User-defined function operator in Python script",
      OperatorGroupConstants.PYTHON_GROUP,
      inputPorts = List(
        InputPort(PortIdentity(), displayName = "model", allowMultiLinks = true),
        InputPort(
          PortIdentity(1),
          displayName = "tuples",
          allowMultiLinks = true,
          dependencies = List(PortIdentity(0))
        )
      ),
      outputPorts = List(OutputPort())
    )

}
