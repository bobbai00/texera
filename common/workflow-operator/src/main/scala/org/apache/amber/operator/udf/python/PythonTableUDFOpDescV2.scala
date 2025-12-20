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
import org.apache.amber.operator.{
  LogicalOp,
  PortDescription,
  PythonCodeValidator,
  StateTransferFunc
}
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.amber.operator.metadata.annotations.CommonOpDescAnnotation
import com.kjetland.jackson.jsonSchema.annotations.{
  JsonSchemaInject,
  JsonSchemaString,
  JsonSchemaInt
}

import scala.util.{Success, Try}

/**
  * PythonTableUDF operator for processing multiple input tables together.
  *
  * This operator provides a simplified API for combining data from multiple sources.
  * Input tables are automatically stored as named attributes based on the port display names
  * configured in the workflow (e.g., self.products, self.merchants).
  *
  * Example usage in Python:
  * {{{
  * from pytexera import *
  *
  * class ProcessTablesOperator(UDFMultiTableOperator):
  *
  *     def process_tables(self) -> Iterator[Optional[TableLike]]:
  *         # Access input tables via self.<port_name>
  *         # Port names come from the workflow's port display names
  *         merged = self.products.merge(self.merchants, on='id')
  *         yield merged
  * }}}
  */
class PythonTableUDFOpDescV2 extends LogicalOp {
  @JsonProperty(
    required = true,
    defaultValue =
      "from pytexera import *\n\n" +
        "class ProcessTablesOperator(UDFMultiTableOperator):\n" +
        "\n" +
        "    def process_tables(self) -> Iterator[Optional[TableLike]]:\n" +
        "        # Access tables via self.<port_name>\n" +
        "        # Port names come from the workflow's port display names\n" +
        "        # All tables are pandas DataFrames\n" +
        "        yield self.input_0\n"
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
    "The output schema of the UDF. When connected, defaults to the input schema."
  )
  @JsonSchemaInject(
    strings = Array(
      new JsonSchemaString(path = CommonOpDescAnnotation.autofill, value = "attributeList")
    ),
    ints = Array(
      new JsonSchemaInt(path = CommonOpDescAnnotation.autofillAttributeOnPort, value = 0)
    )
  )
  var outputColumns: List[Attribute] = List()

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    Preconditions.checkArgument(workers >= 1, "Need at least 1 worker.", Array())
    val opInfo = this.operatorInfo
    val partitionRequirement: List[Option[PartitionInfo]] = if (inputPorts != null) {
      inputPorts.map(p => Option(p.partitionRequirement))
    } else {
      opInfo.inputPorts.map(_ => None)
    }

    // Validate code for file I/O operations
    val validatedCode =
      try {
        PythonCodeValidator.validateNoFileIO(code)
        code
      } catch {
        case ex: Throwable =>
          PythonCodeValidator.generatePythonCodeForRaisingException(ex)
      }

    val propagateSchema = (inputSchemas: Map[PortIdentity, Schema]) => {
      // outputColumns is the source of truth for the output schema
      val outputSchema = if (outputColumns != null && outputColumns.nonEmpty) {
        Schema().add(outputColumns)
      } else {
        Schema()
      }

      Map(operatorInfo.outputPorts.head.id -> outputSchema)
    }

    // PythonTableUDF always uses manyToOne since it needs to collect all data
    val physicalOp = PhysicalOp
      .manyToOnePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(validatedCode, "python")
      )
      .withParallelizable(false)

    physicalOp
      .withDerivePartition(_ => UnknownPartition())
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withPartitionRequirement(partitionRequirement)
      .withIsOneToManyOp(true)
      .withPropagateSchema(SchemaPropagationFunc(propagateSchema))
  }

  override def operatorInfo: OperatorInfo = {
    val inputPortInfo = if (inputPorts != null) {
      inputPorts.zipWithIndex.map {
        case (portDesc: PortDescription, idx) =>
          // For PythonTableUDF, each port depends on ALL previous ports.
          // This ensures all tables are fully collected before process_tables() is called.
          val previousPortDependencies = (0 until idx).map(PortIdentity(_)).toList
          // Use displayName if provided and non-empty, otherwise use default "input_N"
          val effectiveDisplayName =
            if (portDesc.displayName != null && portDesc.displayName.nonEmpty)
              portDesc.displayName
            else
              s"input_$idx"
          InputPort(
            PortIdentity(idx),
            displayName = effectiveDisplayName,
            allowMultiLinks = portDesc.allowMultiInputs,
            dependencies = previousPortDependencies
          )
      }
    } else {
      List(InputPort(PortIdentity(), displayName = "input_0", allowMultiLinks = true))
    }
    val outputPortInfo = if (outputPorts != null) {
      outputPorts.zipWithIndex.map {
        case (portDesc, idx) => OutputPort(PortIdentity(idx), displayName = portDesc.displayName)
      }
    } else {
      List(OutputPort())
    }

    OperatorInfo(
      "Python Table UDF",
      "Process multiple input tables together with named port access",
      OperatorGroupConstants.PYTHON_GROUP,
      inputPortInfo,
      outputPortInfo,
      dynamicInputPorts = true,
      dynamicOutputPorts = true,
      supportReconfiguration = true,
      allowPortCustomization = true
    )
  }

  override def runtimeReconfiguration(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      oldLogicalOp: LogicalOp,
      newLogicalOp: LogicalOp
  ): Try[(PhysicalOp, Option[StateTransferFunc])] = {
    Success(newLogicalOp.getPhysicalOp(workflowId, executionId), None)
  }
}
