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

import org.apache.texera.amber.core.storage.{
  DatasetVersionLister,
  InputFileLocator,
  RepositoryVersionResolver,
  ScanFileResolver
}

/**
  * What a workflow is compiled for: to be edited, or to be run.
  *
  * Either way the compiler resolves the file each scan source names, compiles under the site's
  * settings, goes on past an operator's error so that it finds every operator's errors, and
  * throws, as it is, a failure that is no operator's error, such as the database not answering.
  */
sealed trait CompileFor {

  /** Resolves the file names of scan sources to URIs, as the plan's user may read them. */
  def files: ScanFileResolver

  def settings: CompileSettings
}

object CompileFor {

  /**
    * To show the schemas and the errors of a workflow that is being edited. The errors are
    * returned in the result, with `physicalPlan = None` when there is any. Nothing but the scan
    * sources' files is looked up: the editor compiles on every edit, and its plan is not run.
    */
  final case class Editing(files: ScanFileResolver, settings: CompileSettings) extends CompileFor

  /**
    * To make the plan of a run ([[PlanToRun]]). The errors are thrown together, as a
    * [[WorkflowCompilationFailed]], so a plan made to run has none. A file, a dataset version or
    * a Python environment that an operator names and that cannot be found is that operator's
    * error. Nothing here takes a secret: the links are signed later, from the addresses the plan
    * gives ([[PlanToRun]]).
    *
    * @param locator says where the files `files` resolved are kept
    * @param lister  lists the dataset versions File Listers name, with where each file is kept
    */
  final case class Run(
      files: ScanFileResolver,
      settings: CompileSettings,
      locator: InputFileLocator,
      lister: DatasetVersionLister,
      repositories: RepositoryVersionResolver,
      environments: PythonEnvironmentResolver
  ) extends CompileFor
}
