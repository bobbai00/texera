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

import java.nio.file.Path

/**
  * What a compile binds a plan to, on behalf of the user and the deployment the plan is made
  * for: the files, datasets and models its operators name, and the site's settings. A plan made
  * to run carries what these resolve to.
  *
  * @param files        resolves the file names of scan sources to URIs, as the plan's user may
  *                     read them.
  * @param inputLinker  links the files `files` resolved and the files `lister` listed, for the
  *                     executors that read them to read them through. Only a compile that makes
  *                     a plan to run asks it.
  * @param lister       lists the dataset versions File Listers name, as the plan's user may read
  *                     them. Only a compile that makes a plan to run asks it.
  * @param repositories pins the dataset and model versions operators name, for the plan's user.
  *                     Only a compile that makes a plan to run asks it.
  * @param mountRoot    the directory computing units mount repositories under. The plan's code
  *                     reads each version from below it, and the plan records it, as text,
  *                     beside what to mount
  *                     ([[org.apache.texera.amber.core.workflow.RepositoryMounts.root]]): the
  *                     engine checks its own root against that before mounting. None where
  *                     nothing is mounted: a plan made to run that reads a dataset or model
  *                     then fails.
  * @param settings     the site's settings the plan is compiled under.
  */
final case class RunBindings(
    files: ScanFileResolver,
    inputLinker: InputLinker,
    lister: DatasetVersionLister,
    repositories: RepositoryVersionResolver,
    mountRoot: Option[Path],
    settings: CompileSettings
)

object RunBindings {

  /**
    * The bindings of a compile that makes no plan to run, as the editor's is: it resolves files
    * and applies the site's settings, links no file ([[InputLinker.Unavailable]]), lists no
    * dataset version ([[DatasetVersionLister.Unavailable]]) and pins no dataset or model version
    * ([[RepositoryVersionResolver.Unavailable]], and no mount root).
    */
  def forEditing(files: ScanFileResolver, settings: CompileSettings): RunBindings =
    RunBindings(
      files = files,
      inputLinker = InputLinker.Unavailable,
      lister = DatasetVersionLister.Unavailable,
      repositories = RepositoryVersionResolver.Unavailable,
      mountRoot = None,
      settings = settings
    )
}
