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

package org.apache.texera.common.compiler

import org.apache.texera.amber.core.workflow.PythonEnvironment

/**
  * Resolves the name of a Python environment, as an operator asks for one, to what the plan's
  * user keeps under it: the packages a computing unit is to install.
  */
trait PythonEnvironmentResolver {

  /**
    * @throws PythonEnvironmentNotResolved if the plan's user has no environment of that name, or
    *                                      has one whose packages pip may not read
    */
  def resolve(name: String): PythonEnvironment
}

/**
  * Why the Python environment an operator names cannot be made part of a plan to run: the error of
  * that operator, in words for the user who runs the workflow.
  */
final class PythonEnvironmentNotResolved(message: String) extends RuntimeException(message)

object PythonEnvironmentNotResolved {

  /** The plan's user keeps no environment under `name`: environments are each user's own. */
  def noSuchEnvironment(name: String): PythonEnvironmentNotResolved =
    new PythonEnvironmentNotResolved(
      s"You have no Python environment named '$name'. Each user keeps their own environments, " +
        "so to run this workflow, create one with this name."
    )

  /** The environment the plan's user keeps under `name` holds packages pip may not read. */
  def notInstallable(name: String, problem: String): PythonEnvironmentNotResolved =
    new PythonEnvironmentNotResolved(s"Python environment '$name' cannot be installed: $problem")
}
