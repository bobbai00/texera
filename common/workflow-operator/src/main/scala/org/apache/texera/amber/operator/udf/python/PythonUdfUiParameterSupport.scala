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

package org.apache.texera.amber.operator.udf.python

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.operator.udf.python.PythonUdfUiParameterSupport._

/** Shared serialized UI-parameter property and code-injection hook for Python UDF descriptors. */
trait PythonUdfUiParameterSupport {
  @JsonProperty
  @JsonSchemaTitle("Parameters")
  @JsonPropertyDescription(
    "Parameters inferred from active self.UiParameter(...) calls in the Python script"
  )
  var uiParameters: List[UiUDFParameter] = List()

  /**
    * The code the workers run, with each parameter's value injected. A parameter that names a
    * dataset or model carries a file reference the catalog already resolved for this run (a
    * presigned URL in place of `dataset://<rid>@<version>/<path>`), so the code reads it like any
    * URL; the engine resolves nothing itself.
    */
  protected final def injectUiParameters(code: String): String = {
    resourceParameters(uiParameters).foreach(selectedResource)
    PythonUdfUiParameterInjector.inject(code, uiParameters)
  }
}

object PythonUdfUiParameterSupport {
  // The kinds of resource a parameter's value can name; keep in sync with pytexera's Resource.
  private val ResourceInputTypes: Set[String] = Set("model", "dataset")

  private def isResource(parameter: UiUDFParameter): Boolean =
    parameter != null && ResourceInputTypes.contains(Option(parameter.inputType).getOrElse(""))

  private def resourceParameters(parameters: List[UiUDFParameter]): List[UiUDFParameter] =
    Option(parameters).getOrElse(Nil).filter(isResource)

  // Checked on every compile, so an unchosen resource shows while editing rather than at run time.
  private def selectedResource(parameter: UiUDFParameter): String =
    Option(parameter.value)
      .map(_.trim)
      .filter(_.nonEmpty)
      .getOrElse(
        throw new RuntimeException(
          s"No ${parameter.inputType} selected for the parameter " +
            s"'${Option(parameter.attribute).map(_.getName).getOrElse("")}'."
        )
      )
}
