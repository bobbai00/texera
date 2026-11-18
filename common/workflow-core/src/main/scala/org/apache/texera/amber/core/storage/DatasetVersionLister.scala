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

package org.apache.texera.amber.core.storage

/**
  * A file of a dataset version, as a listing of the version holds it.
  *
  * @param logicalPath     the file's name to users: the path of its version, then its path
  *                        within it (/dataset/ownerEmail/datasetName/versionName/dir/file.csv)
  * @param physicalAddress the object that holds the file's bytes (s3://bucket/key)
  */
final case class ListedFile(logicalPath: String, physicalAddress: String)

/**
  * Lists the files of dataset versions, when a plan is made to run. A plan carries what a
  * listing holds (see [[org.apache.texera.amber.core.workflow.ExecutionPlan]]).
  */
trait DatasetVersionLister {

  /**
    * @param versionPath /dataset/ownerEmail/datasetName/versionName
    * @return the version's files, ordered by their paths: at most the first `atMost`
    * @throws org.apache.commons.vfs2.FileNotFoundException if the path names no dataset version
    *                                                       this lister's user may read
    */
  def list(versionPath: String, atMost: Int): Seq[ListedFile]
}
