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

package org.apache.amber.operator.visualization

import org.apache.amber.core.tuple.{AttributeType, Schema}

/**
  * Constants and utilities for visualization operators.
  * Provides common schema definitions and Python code snippets for Plotly-based visualizations.
  */
object VisualizationConstants {

  /**
    * Creates the standard output schema for visualization operators.
    * Includes both html-content (for display) and json-content (for programmatic access).
    *
    * @return Schema with html-content and json-content STRING attributes
    */
  def createVisualizationSchema(): Schema = {
    Schema()
      .add("html-content", AttributeType.STRING)
      .add("json-content", AttributeType.STRING)
  }

  /**
    * Python code snippet to convert a Plotly figure to both HTML and JSON,
    * and yield the result as a dictionary.
    *
    * Usage: Include this at the end of your process_table method after creating 'fig'.
    * Example:
    *   ${createPlotlyFigure()}
    *   ${VisualizationConstants.createOutputCode()}
    */
  val OutputCode: String =
    """
      |        html = plotly.io.to_html(fig, include_plotlyjs='cdn', auto_play=False)
      |        json_content = plotly.io.to_json(fig)
      |        yield {'html-content': html, 'json-content': json_content}
      |""".stripMargin

  /**
    * Python code snippet to yield an error result with empty JSON.
    *
    * Usage: Use this when returning an error message.
    * Example:
    *   yield self.render_error_with_json("error message")
    */
  val RenderErrorMethodCode: String =
    """
      |    def render_error_with_json(self, error_msg) -> dict:
      |        html = '''<h1>Visualization is not available.</h1>
      |                  <p>Reason: {} </p>
      |               '''.format(error_msg)
      |        return {'html-content': html, 'json-content': '{}'}
      |""".stripMargin
}
