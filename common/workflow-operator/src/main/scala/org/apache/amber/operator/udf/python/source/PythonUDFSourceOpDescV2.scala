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

package org.apache.amber.operator.udf.python.source

import com.fasterxml.jackson.annotation.{
  JsonIgnoreProperties,
  JsonProperty,
  JsonPropertyDescription
}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow.{OutputPort, PhysicalOp, SchemaPropagationFunc}
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.amber.operator.source.SourceOperatorDescriptor

class PythonUDFSourceOpDescV2 extends SourceOperatorDescriptor {

  @JsonProperty(
    required = true,
    defaultValue =
      "from pytexera import *\n" +
        "import pandas as pd\n\n" +
        "class GenerateOperator(UDFSourceOperator):\n" +
        "    # This operator should read files and generate output tuples/dataframes for downstream to process\n" +
        "    # This operator should NOT do any data processing\n" +
        "    # File IO is allowed in this source operator\n\n" +
        "    @overrides\n" +
        "    def produce(self) -> Iterator[Union[TupleLike, TableLike, None]]:\n" +
        "        # Example 1: Read a file and yield as dataframe\n" +
        "        # df = pd.read_csv('/path/to/file.csv')\n" +
        "        # yield df\n\n" +
        "        # ONLY the tuple or dataframe with the same schema should be yield\n"+
        "        yield\n"
  )
  @JsonSchemaTitle("Python script")
  @JsonPropertyDescription("input your code here")
  var code: String = _

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    // Always use single worker, schema is empty - runtime inference handles actual schema
    PhysicalOp
      .sourcePhysicalOp(workflowId, executionId, operatorIdentifier, OpExecWithCode(code, "python"))
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withIsOneToManyOp(true)
      .withPropagateSchema(
        SchemaPropagationFunc(_ => Map(operatorInfo.outputPorts.head.id -> Schema()))
      )
      .withLocationPreference(Option.empty)
      .withParallelizable(false)
  }

  override def operatorInfo: OperatorInfo = {
    OperatorInfo(
      "1-out Python UDF",
      "Load the source data file as a single table to be processed by the downstream",
      OperatorGroupConstants.PYTHON_GROUP,
      List.empty, // No input ports for a source operator
      List(OutputPort()),
      supportReconfiguration = true
    )
  }

  override def sourceSchema(): Schema = Schema()
}
