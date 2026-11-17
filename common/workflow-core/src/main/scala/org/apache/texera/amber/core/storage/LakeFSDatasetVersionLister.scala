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

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.storage.util.LakeFSStorageClient

object LakeFSDatasetVersionLister {

  /** The lister of the dataset versions user `uid` may read. */
  def forUser(uid: Integer): LakeFSDatasetVersionLister =
    new LakeFSDatasetVersionLister(FileResolver.repositoryVersionResolverForUser(uid))

  /**
    * The path of the dataset version `versionPath` names, as every file of the version is named
    * under it: /dataset/ownerEmail/datasetName/versionName. A path may leave the /dataset prefix
    * out, as paths stored before the prefix existed do, and whatever follows the version is
    * dropped.
    *
    * @throws FileNotFoundException if the path names no dataset version: it stops short of a
    *                               version, or it is the path of another kind of resource
    */
  private[storage] def canonicalVersionPath(versionPath: String): String = {
    val segments = Option(versionPath).getOrElse("").split("/").filter(_.nonEmpty)
    val ownerDatasetVersion = segments.headOption.flatMap(ResourceType.fromPrefix) match {
      case Some(ResourceType.Dataset) => segments.slice(1, 4)
      case Some(_)                    => Array.empty[String]
      case None                       => segments.take(3)
    }
    if (ownerDatasetVersion.length < 3) {
      throw new FileNotFoundException(
        s"Invalid dataset version path '$versionPath'; expected " +
          s"/${ResourceType.Dataset}/ownerEmail/datasetName/versionName"
      )
    }
    s"/${ResourceType.Dataset}/${ownerDatasetVersion.mkString("/")}"
  }
}

/**
  * Lists the versions of datasets, whose files LakeFS keeps: LakeFS is asked for the files of
  * the commit that backs a version, and answers where it keeps each.
  *
  * @param versions pins a dataset version to its repository and commit, for the user the
  *                 listings are made for: a version that user may not read is not listed
  */
class LakeFSDatasetVersionLister(versions: RepositoryVersionResolver) extends DatasetVersionLister {

  override def list(versionPath: String, atMost: Int): Seq[ListedFile] = {
    val canonicalPath = LakeFSDatasetVersionLister.canonicalVersionPath(versionPath)
    val (repositoryName, versionHash) = versions.resolve(canonicalPath)
    LakeFSStorageClient
      .retrieveObjectsOfVersion(repositoryName, versionHash, atMost)
      .map(file =>
        ListedFile(
          s"$canonicalPath/${file.getPath}",
          file.getPhysicalAddress,
          file.getSizeBytes.longValue()
        )
      )
  }
}
