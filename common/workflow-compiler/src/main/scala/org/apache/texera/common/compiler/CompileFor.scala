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
  InputLinker,
  RepositoryVersionResolver,
  ScanFileResolver
}

/**
  * What a workflow is compiled for: to be edited, or to be run. It decides what the compiler
  * does with the errors of the workflow's operators, and what it looks up for the plan, on
  * behalf of the user and the deployment the plan is made for.
  *
  * Either way the compiler resolves the file each scan source names and compiles under the
  * site's settings; goes on past an operator's error, so that it finds every operator's errors;
  * and throws, as it is, a failure that is no operator's error, such as the database or the
  * storage not answering.
  */
sealed trait CompileFor {

  /** Resolves the file names of scan sources to URIs, as the plan's user may read them. */
  def files: ScanFileResolver

  /** The site's settings the plan is compiled under. */
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
    * To make the plan of a run. The errors are thrown together, as a
    * [[WorkflowCompilationFailed]] that holds each operator's first error, so a plan made to run
    * has none. The plan carries everything its operators read and name, found here once, so
    * what runs it looks nothing up: a file that cannot be linked, a dataset version that cannot
    * be listed or pinned and a Python environment that cannot be resolved are errors of the
    * operators that name them.
    *
    * @param inputLinker  links the files `files` resolved and the files `lister` listed, for the
    *                     executors that read them to read them through
    * @param lister       lists the dataset versions File Listers name, as the plan's user may
    *                     read them
    * @param repositories pins the dataset and model versions operators name, for the plan's user
    * @param environments resolves the Python environments operators name to what the plan's user
    *                     keeps under those names
    */
  final case class Run(
      files: ScanFileResolver,
      settings: CompileSettings,
      inputLinker: InputLinker,
      lister: DatasetVersionLister,
      repositories: RepositoryVersionResolver,
      environments: PythonEnvironmentResolver
  ) extends CompileFor
}
