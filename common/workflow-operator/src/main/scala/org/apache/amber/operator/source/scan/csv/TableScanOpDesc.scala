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

package org.apache.amber.operator.source.scan.csv

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.fasterxml.jackson.databind.annotation.JsonDeserialize
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow.{OutputPort, PhysicalOp, SchemaPropagationFunc}
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.amber.operator.source.SourceOperatorDescriptor
import org.apache.amber.operator.source.scan.FileDecodingMethod

class TableScanOpDesc extends SourceOperatorDescriptor {

  @JsonProperty(required = true)
  @JsonSchemaTitle("File")
  @JsonDeserialize(contentAs = classOf[java.lang.String])
  var fileName: Option[String] = None

  @JsonProperty(defaultValue = "UTF_8", required = true)
  @JsonSchemaTitle("File Encoding")
  @JsonPropertyDescription("decoding charset to use on input")
  var fileEncoding: FileDecodingMethod = FileDecodingMethod.UTF_8

  @JsonProperty(defaultValue = ",")
  @JsonSchemaTitle("Delimiter")
  @JsonPropertyDescription("delimiter to separate each line into fields")
  var customDelimiter: String = ","

  @JsonProperty(defaultValue = "true")
  @JsonSchemaTitle("Header")
  @JsonPropertyDescription("whether the CSV file contains a header line")
  var hasHeader: Boolean = true

  @JsonProperty()
  @JsonSchemaTitle("Limit")
  @JsonPropertyDescription("max output count")
  @JsonDeserialize(contentAs = classOf[Int])
  var limit: Option[Int] = None

  private def generatePythonCode(): String = {
    val encodingStr = fileEncoding.name().toLowerCase.replace("_", "-")
    val delimiterStr = customDelimiter
    val nrowsStr = limit match {
      case Some(n) => s", nrows=$n"
      case None    => ""
    }
    val headerStr = if (hasHeader) "0" else "None"

    s"""from pytexera import *
       |import pandas as pd
       |
       |class GenerateOperator(UDFSourceOperator):
       |    @overrides
       |    def produce(self) -> Iterator[Union[TupleLike, TableLike, None]]:
       |        yield pd.read_csv(
       |            "${fileName.getOrElse("")}",
       |            delimiter="$delimiterStr",
       |            header=$headerStr,
       |            encoding="$encodingStr"$nrowsStr
       |        )
       |""".stripMargin
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    PhysicalOp
      .sourcePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(generatePythonCode(), "python")
      )
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withIsOneToManyOp(true)
      .withPropagateSchema(
        SchemaPropagationFunc(_ => Map(operatorInfo.outputPorts.head.id -> Schema()))
      )
      .withLocationPreference(Option.empty)
      .withParallelizable(false)
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "Table File Scan",
      "Scan data from a CSV file using Python pandas",
      OperatorGroupConstants.INPUT_GROUP,
      inputPorts = List.empty,
      outputPorts = List(OutputPort(blocking = true))
    )

  override def sourceSchema(): Schema = Schema()
}
