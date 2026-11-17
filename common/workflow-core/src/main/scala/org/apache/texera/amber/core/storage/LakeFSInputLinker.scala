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

import io.lakefs.clients.sdk.ApiException
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.storage.FileResolver.{
  DATASET_FILE_URI_SCHEME,
  MODEL_FILE_URI_SCHEME
}
import org.apache.texera.amber.core.storage.model.LakeFSFileDocument
import org.apache.texera.amber.core.storage.util.LakeFSStorageClient
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.service.util.ObjectStorePresigner

import java.net.{HttpURLConnection, URI}
import java.time.Duration

object LakeFSInputLinker {

  /** The schemes of the files LakeFS keeps, as `FileResolver` resolves their names. */
  private val LakeFSSchemes = Set(DATASET_FILE_URI_SCHEME, MODEL_FILE_URI_SCHEME)

  /**
    * The linker of this deployment. Its links are signed for the object store as computing units
    * reach it (`storage.input-links.s3-endpoint`), with this service's own keys to the store,
    * and last `storage.input-links.ttl-seconds`.
    */
  lazy val forDeployment: LakeFSInputLinker =
    new LakeFSInputLinker(
      new ObjectStorePresigner(
        URI.create(StorageConfig.inputLinksS3Endpoint),
        StorageConfig.s3Region,
        StorageConfig.s3Username,
        StorageConfig.s3Password
      ),
      Duration.ofSeconds(StorageConfig.inputLinksTtlSeconds)
    )
}

/**
  * Links the files of datasets and models, which LakeFS keeps in the object store. A GET of the
  * object that holds a file's bytes is signed here, by `presigner`. LakeFS signs links too, but
  * for the one address it is set up with, which is the address browsers reach the store at.
  *
  * Which object holds a file, LakeFS says: it is asked for a file a resolver resolved, and has
  * already answered for a file of a listing.
  *
  * @param presigner signs the links, for the object store as their readers reach it
  * @param lifetime  how long a link works
  */
class LakeFSInputLinker(presigner: ObjectStorePresigner, lifetime: Duration) extends InputLinker {

  /**
    * @param fileUri {dataset|model}:///{repositoryName}/{versionHash}/{file}, as `FileResolver`
    *                resolves a file's name
    * @throws org.apache.commons.vfs2.FileNotFoundException if the version holds no such file
    */
  override def link(fileUri: URI): InputLink = {
    if (!LakeFSInputLinker.LakeFSSchemes.contains(fileUri.getScheme)) {
      throw new UnsupportedOperationException(
        s"Unsupported URI scheme: ${fileUri.getScheme} for linking an input file"
      )
    }
    val (repositoryName, versionHash, fileRelativePath) = LakeFSFileDocument.locate(fileUri)
    val file =
      try LakeFSStorageClient.statObject(repositoryName, versionHash, fileRelativePath.toString)
      catch {
        case missing: ApiException if missing.getCode == HttpURLConnection.HTTP_NOT_FOUND =>
          throw new FileNotFoundException(fileUri)
      }
    linkTo(fileUri.toString, file.getPhysicalAddress, file.getSizeBytes.longValue())
  }

  /** Links `file` from the address its listing gives, with no request to LakeFS. */
  override def linkListed(file: ListedFile): InputLink =
    linkTo(file.logicalPath, file.physicalAddress, file.sizeBytes)

  /** Signs a GET of the object at `physicalAddress`, which holds the file called `name`. */
  private def linkTo(name: String, physicalAddress: String, sizeBytes: Long): InputLink = {
    if (!physicalAddress.startsWith("s3://")) {
      throw new IllegalStateException(
        s"$name is kept at $physicalAddress, which is not in an S3 object store, so no link " +
          "to it can be signed."
      )
    }
    val (bucket, key) = LakeFSStorageClient.parsePhysicalAddress(physicalAddress)
    val signed = presigner.presignGet(bucket, key, lifetime)
    InputLink(signed.url, signed.expiresAt.toEpochMilli, sizeBytes)
  }
}
