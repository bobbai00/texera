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
  *                        within the version
  *                        (/dataset/ownerEmail/datasetName/versionName/directory/file.csv)
  * @param physicalAddress the object that holds the file's bytes, in the store that keeps the
  *                        dataset's files (s3://bucket/key)
  * @param sizeBytes       the file's size in bytes
  */
final case class ListedFile(logicalPath: String, physicalAddress: String, sizeBytes: Long)

/**
  * Lists the files of dataset versions, when a plan is made to run. A plan carries what a
  * listing holds, so the computing unit that runs the plan asks no service which files a version
  * has, or where they are kept.
  */
trait DatasetVersionLister {

  /**
    * Lists the files of the dataset version at `versionPath`.
    *
    * @param versionPath /dataset/ownerEmail/datasetName/versionName
    * @param atMost      the most files to list
    * @return the version's files, ordered by their paths; of a version that holds more than
    *         `atMost`, the first `atMost`
    * @throws org.apache.commons.vfs2.FileNotFoundException if the path names no dataset version
    *                                                       this lister's user may read. Any other
    *                                                       failure, such as the storage not
    *                                                       answering, is thrown as it is.
    */
  def list(versionPath: String, atMost: Int): Seq[ListedFile]
}

object DatasetVersionLister {

  /**
    * Lists nothing. For a compile that makes no plan to run, which never asks; a plan made to run
    * with it fails on the first version it lists rather than running without the listing.
    */
  val Unavailable: DatasetVersionLister = (versionPath, _) =>
    throw new IllegalStateException(
      s"No lister of dataset versions was given, so $versionPath cannot be listed."
    )
}
