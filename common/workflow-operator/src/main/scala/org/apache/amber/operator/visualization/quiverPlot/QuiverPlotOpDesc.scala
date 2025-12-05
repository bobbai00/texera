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

package org.apache.amber.operator.visualization.quiverPlot

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.{JsonSchemaInject, JsonSchemaTitle}
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.workflow.OutputPort.OutputMode
import org.apache.amber.core.workflow.{InputPort, OutputPort, PortIdentity}
import org.apache.amber.operator.PythonOperatorDescriptor
import org.apache.amber.operator.metadata.annotations.AutofillAttributeName
import org.apache.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.amber.operator.visualization.VisualizationConstants

@JsonSchemaInject(json = """
{
  "attributeTypeRules": {
    "value": {
      "enum": ["integer", "long", "double"]
    }
  }
}
""")
class QuiverPlotOpDesc extends PythonOperatorDescriptor {

  //property panel variable: 4 requires: {x,y,u,v}, all columns should only contain numerical data

  @JsonProperty(value = "x", required = true)
  @JsonSchemaTitle("x")
  @JsonPropertyDescription("Column for the x-coordinate of the starting point")
  @AutofillAttributeName var x: String = ""

  @JsonProperty(value = "y", required = true)
  @JsonSchemaTitle("y")
  @JsonPropertyDescription("Column for the y-coordinate of the starting point")
  @AutofillAttributeName var y: String = ""

  @JsonProperty(value = "u", required = true)
  @JsonSchemaTitle("u")
  @JsonPropertyDescription("Column for the vector component in the x-direction")
  @AutofillAttributeName var u: String = ""

  @JsonProperty(value = "v", required = true)
  @JsonSchemaTitle("v")
  @JsonPropertyDescription("Column for the vector component in the y-direction")
  @AutofillAttributeName var v: String = ""

  override def getOutputSchemas(
      inputSchemas: Map[PortIdentity, Schema]
  ): Map[PortIdentity, Schema] = {
    Map(operatorInfo.outputPorts.head.id -> VisualizationConstants.createVisualizationSchema())
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "Quiver Plot",
      "Visualize vector data in a Quiver Plot",
      OperatorGroupConstants.VISUALIZATION_SCIENTIFIC_GROUP,
      inputPorts = List(InputPort()),
      outputPorts = List(OutputPort(mode = OutputMode.SINGLE_SNAPSHOT))
    )

  //data cleaning for missing value
  def manipulateTable(): String = {
    s"""
       |        table = table.dropna() #remove missing values
       |""".stripMargin
  }

  override def generatePythonCode(): String = {
    val finalCode =
      s"""
         |from pytexera import *
         |import pandas as pd
         |import plotly.figure_factory as ff
         |import numpy as np
         |import plotly.io
         |import plotly.graph_objects as go
         |
         |class ProcessTableOperator(UDFTableOperator):
         |${VisualizationConstants.RenderErrorMethodCode}
         |
         |    @overrides
         |    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
         |        if table.empty:
         |            yield self.render_error_with_json("Input table is empty.")
         |            return
         |
         |        required_columns = {'${x}', '${y}', '${u}', '${v}'}
         |        if not required_columns.issubset(table.columns):
         |            yield self.render_error_with_json(f"Input table must contain columns: {', '.join(required_columns)}")
         |            return
         |
         |        ${manipulateTable()}
         |
         |        def type_check(value):
         |            return isinstance(value,(int,float))
         |        for col in required_columns:
         |            if not table[col].apply(type_check).all():
         |                yield self.render_error_with_json("Type error: All columns should only contain numerical data")
         |                return
         |
         |        try:
         |            #graph the quiver plot
         |            fig = ff.create_quiver(
         |                table['${x}'], table['${y}'],
         |                table['${u}'], table['${v}'],
         |                scale=0.1
         |            )
         |        except Exception as e:
         |            yield self.render_error_with_json(f"Plotly error: {str(e)}")
         |            return
         |${VisualizationConstants.OutputCode}
         |""".stripMargin
    finalCode
  }

}
