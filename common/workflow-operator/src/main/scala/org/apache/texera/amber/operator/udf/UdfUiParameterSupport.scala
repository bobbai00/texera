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

package org.apache.texera.amber.operator.udf

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.workflow.{BoundResources, RepositoryMounts, ResourceBinding}

/** Shared serialized UI-parameter property, and the datasets and models its values name. */
trait UdfUiParameterSupport {
  @JsonProperty
  @JsonSchemaTitle("Parameters")
  @JsonPropertyDescription(
    "Parameters inferred from active UiParameter declarations in the UDF script"
  )
  var uiParameters: List[UiUDFParameter] = List()

  protected def injectParameterValues(code: String, parameters: List[UiUDFParameter]): String
  protected def uiParameterLanguage: String

  /**
    * The code as every compile sees it: each value in place, a dataset or model as the version
    * path that was picked. Refuses a resource parameter with no version picked.
    */
  protected final def injectUiParameters(code: String): String = {
    resourceParameters(uiParameters).foreach(selectedVersionPath)
    injectParameterValues(code, uiParameters)
  }

  /**
    * What the plan made to run pins for this UDF, None when no parameter names a dataset or
    * model: each version path resolved to its repository commit, and the code rebuilt with the
    * commit's locator in the path's place. The computing unit that runs the plan puts the
    * directory it mounts the commit at there ([[UdfRepositoryDirectories]]).
    */
  protected final def resourceBinding(code: String): Option[ResourceBinding] =
    Option.when(resourceParameters(uiParameters).nonEmpty) {
      // Snapshot the compiled descriptor, so a later edit cannot change what this op binds.
      val parameters = uiParameters
      val language = uiParameterLanguage
      new ResourceBinding {
        override def bind(resolver: RepositoryVersionResolver): BoundResources = {
          val bound = parameters.map { parameter =>
            if (!isResource(parameter)) (parameter, None)
            else {
              val (repositoryName, commitHash) =
                resolver.resolve(selectedVersionPath(parameter))
              val locator = RepositoryMounts.locator(repositoryName, commitHash)
              val pinned = new UiUDFParameter
              pinned.attribute = parameter.attribute
              pinned.inputType = parameter.inputType
              pinned.value = locator
              (pinned, Some(locator))
            }
          }
          BoundResources(
            OpExecWithCode(injectParameterValues(code, bound.map(_._1)), language),
            bound.flatMap(_._2).toSet
          )
        }
      }
    }

  private def isResource(parameter: UiUDFParameter): Boolean =
    parameter != null && UiUdfParameterContract.resourceInputTypes.values.exists(
      _ == Option(parameter.inputType).getOrElse("")
    )

  private def resourceParameters(parameters: List[UiUDFParameter]): List[UiUDFParameter] =
    Option(parameters).getOrElse(Nil).filter(isResource)

  private def selectedVersionPath(parameter: UiUDFParameter): String =
    Option(parameter.value).map(_.trim).filter(_.nonEmpty).getOrElse {
      throw new RuntimeException(
        s"No ${parameter.inputType} selected for the parameter " +
          s"'${Option(parameter.attribute).map(_.getName).getOrElse("")}'."
      )
    }
}
