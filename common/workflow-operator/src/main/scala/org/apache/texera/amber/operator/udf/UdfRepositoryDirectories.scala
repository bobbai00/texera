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

import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.storage.RepositoryMountManager
import org.apache.texera.amber.core.workflow.PhysicalOp
import org.apache.texera.amber.operator.udf.java.JavaUdfUiParameterInjector
import org.apache.texera.amber.operator.udf.python.PythonUdfUiParameterInjector
import org.apache.texera.amber.operator.udf.r.RUdfUiParameterInjector

import _root_.java.nio.file.Path

/**
  * Gives the code of a UDF the directories its datasets and models are mounted at.
  *
  * A plan is made for no computing unit in particular, and each unit mounts repositories under a
  * directory of its own. So a plan's code holds, as the value of a parameter that names a
  * dataset or model, the locator of the repository it was pinned to ([[UdfUiParameterSupport]]),
  * and the unit that runs the plan puts the directory it mounts that repository at in the
  * locator's place, before a worker is handed the code.
  */
object UdfRepositoryDirectories {

  // How the code of each language holds a parameter's value, as its injector writes it.
  private val writtenIn: Map[String, String => String] = Map(
    "python" -> PythonUdfUiParameterInjector.stringExpression,
    "r-tuple" -> RUdfUiParameterInjector.rString,
    "r-table" -> RUdfUiParameterInjector.rString,
    "java" -> JavaUdfUiParameterInjector.stringExpression
  )

  /**
    * `op` as a computing unit that mounts repositories under `root` runs it: where the code of
    * its plan holds the locator of a repository it reads, the directory the unit mounts that
    * repository at. An operator that reads none is returned as it is.
    *
    * @param root the directory the unit mounts repositories under; None on a unit that mounts
    *             none
    * @throws IllegalStateException    if `op` reads a repository and the unit mounts none
    * @throws IllegalArgumentException if `op` is not a UDF whose code holds the locator of each
    *                                  repository it reads
    */
  def mountedUnder(root: Option[Path])(op: PhysicalOp): PhysicalOp =
    op.repositoryMounts.fold(op) { mounts =>
      val name = op.id.logicalOpId.id
      val locators = mounts.locators.toSeq.sorted
      val unitRoot = root.getOrElse(
        throw new IllegalStateException(
          s"Operator $name reads datasets or models (${locators.mkString(", ")}), which this " +
            "computing unit cannot mount."
        )
      )
      op.opExecInitInfo match {
        case OpExecWithCode(code, language) if writtenIn.contains(language) =>
          val written = writtenIn(language)
          val mounted = locators.foldLeft(code) { (mounting, locator) =>
            if (!mounting.contains(written(locator))) {
              throw new IllegalArgumentException(
                s"The code of operator $name does not name $locator, which its plan says it reads."
              )
            }
            val directory = RepositoryMountManager.mountPoint(unitRoot, locator).toString
            mounting.replace(written(locator), written(directory))
          }
          op.copy(opExecInitInfo = OpExecWithCode(mounted, language))
        case _ =>
          throw new IllegalArgumentException(
            s"Operator $name reads datasets or models (${locators.mkString(", ")}), but it is no " +
              "UDF whose code names them."
          )
      }
    }
}
