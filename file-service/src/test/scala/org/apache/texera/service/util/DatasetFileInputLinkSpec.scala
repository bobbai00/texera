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

package org.apache.texera.service.util

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.storage.{
  InputLink,
  LakeFSDatasetVersionLister,
  LakeFSInputLinker,
  ListedFile
}
import org.apache.texera.amber.core.storage.model.LinkDocument
import org.apache.texera.amber.core.storage.util.LakeFSStorageClient
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.service.MockLakeFS
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.ByteArrayInputStream
import java.net.{URI, URLEncoder}
import java.nio.charset.StandardCharsets
import java.time.Duration

/**
  * A dataset's files, linked and read as a run reads them, against a real LakeFS and a real
  * object store (RustFS), each in a container: the Dashboard service's half
  * ([[LakeFSInputLinker]]: where LakeFS keeps a file, and a link to that object signed here;
  * [[LakeFSDatasetVersionLister]]: the files of a version, with where LakeFS keeps each) and the
  * computing unit's half ([[LinkDocument]]: a file's bytes, from the object store alone).
  */
class DatasetFileInputLinkSpec extends AnyFlatSpec with Matchers with MockLakeFS {

  private val repositoryName = s"input-link-spec-${System.nanoTime()}"
  private val fileRelativePath = "2026/people & places.csv"
  private val content = "id,name\n1,Ada\n2,Grace\n" * 4099
  private val notesRelativePath = "notes.txt"
  private val notes = "kept beside the people"
  private var versionHash: String = _

  override def afterStart(): Unit = {
    super.afterStart()
    LakeFSStorageClient.initRepo(repositoryName)
    Seq(fileRelativePath -> content, notesRelativePath -> notes).foreach {
      case (file, text) =>
        LakeFSStorageClient.writeFileToRepo(
          repositoryName,
          file,
          new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8))
        )
    }
    versionHash = LakeFSStorageClient.createCommit(repositoryName, "main", "add people").getId
  }

  /** The version as a File Lister names it, and its lister, for a user who may read it. */
  private val versionPath = "/dataset/ada@texera.io/people/v1"
  private val lister = new LakeFSDatasetVersionLister(_ => (repositoryName, versionHash))

  /** `file` of the version, as `FileResolver` resolves its name: each segment URL-encoded. */
  private def resolved(file: String): URI = {
    val segments = file.split('/').map(URLEncoder.encode(_, StandardCharsets.UTF_8))
    new URI("dataset", "", s"/$repositoryName/$versionHash/${segments.mkString("/")}", null)
  }

  /** A linker that signs for the object store at `endpoint`, with this service's own keys. */
  private def linkerFor(endpoint: String): LakeFSInputLinker =
    new LakeFSInputLinker(
      new ObjectStorePresigner(
        new URI(endpoint),
        StorageConfig.s3Region,
        StorageConfig.s3Username,
        StorageConfig.s3Password
      ),
      Duration.ofHours(1)
    )

  /** What a computing unit that reads links from `storeEndpoint` reads through `link`. */
  private def readThrough(link: InputLink, storeEndpoint: String): String = {
    val stream = new LinkDocument(link, fileRelativePath, Seq(storeEndpoint)).asInputStream()
    try new String(stream.readAllBytes(), StandardCharsets.UTF_8)
    finally stream.close()
  }

  "A link to a dataset's file" should
    "be to the object LakeFS keeps the file in, at the store the linker signs for" in {
    val before = System.currentTimeMillis()
    val link = linkerFor(objectStoreEndpoint).link(resolved(fileRelativePath))

    link.expiresAtMs should be > before + Duration.ofMinutes(59).toMillis
    link.expiresAtMs should be <= System.currentTimeMillis() + Duration.ofHours(1).toMillis
    val url = new URI(link.url)
    s"${url.getScheme}://${url.getHost}:${url.getPort}" shouldBe objectStoreEndpoint
    // Path-style, in the bucket LakeFS keeps its repositories in.
    url.getPath should startWith(s"/${StorageConfig.lakefsBucketName}/$repositoryName/")
  }

  it should "read the file's bytes from the object store" in {
    val link = linkerFor(objectStoreEndpoint).link(resolved(fileRelativePath))

    readThrough(link, objectStoreEndpoint) shouldBe content
  }

  it should "not be one LakeFS signs, which is for another address of the store" in {
    // LakeFS presigns for the one address it is set up with (here `localhost`, as for a browser).
    // Read at any other address of the same store, its link is refused: the host is signed.
    val lakefsLink = LakeFSStorageClient.getFilePresignedUrl(
      repositoryName,
      versionHash,
      fileRelativePath
    )
    new URI(lakefsLink).getHost shouldBe "localhost"
    val port = new URI(objectStoreEndpoint).getPort
    val unitsEndpoint = s"http://127.0.0.1:$port"

    val repointed = InputLink(
      lakefsLink.replace(s"localhost:$port", s"127.0.0.1:$port"),
      System.currentTimeMillis() + Duration.ofMinutes(10).toMillis
    )

    intercept[java.io.IOException](readThrough(repointed, unitsEndpoint)).getMessage shouldBe
      s"Could not read $fileRelativePath: the object store answered HTTP 403."
    // The linker's own link, signed for that address, reads.
    readThrough(linkerFor(unitsEndpoint).link(resolved(fileRelativePath)), unitsEndpoint) shouldBe
      content
  }

  it should "not be made for a file the version does not hold" in {
    val missing = resolved("2026/no such file.csv")

    intercept[FileNotFoundException](linkerFor(objectStoreEndpoint).link(missing)).getMessage should
      include(missing.toString)
  }

  "A listing of a dataset version" should
    "hold each file of the version, with the object LakeFS keeps it in" in {
    val listed = lister.list(versionPath, atMost = 100)

    // In the order of the files' paths, each named under the version's path.
    listed.map(_.logicalPath) shouldBe
      Seq(s"$versionPath/$fileRelativePath", s"$versionPath/$notesRelativePath")
    every(listed.map(_.physicalAddress)) should
      startWith(s"s3://${StorageConfig.lakefsBucketName}/$repositoryName/")
    // Asked for fewer files than the version holds, it lists the first.
    lister.list(versionPath, atMost = 1) shouldBe listed.take(1)
  }

  it should "give each file a link that reads the file's bytes from the object store" in {
    val linker = linkerFor(objectStoreEndpoint)

    val links = lister.list(versionPath, atMost = 100).map(linker.linkListed)

    links.map(readThrough(_, objectStoreEndpoint)) shouldBe Seq(content, notes)
    // To the object LakeFS names when asked for the file by itself.
    new URI(links.head.url).getPath shouldBe
      new URI(linker.link(resolved(fileRelativePath)).url).getPath
  }

  // Last: it takes LakeFS away.
  "A link to a dataset's file" should "still read once LakeFS is gone" in {
    val link = linkerFor(objectStoreEndpoint).link(resolved(fileRelativePath))
    val listed: Seq[ListedFile] = lister.list(versionPath, atMost = 100)
    lakefs.stop()

    readThrough(link, objectStoreEndpoint) shouldBe content
    // And a file listed while LakeFS answered is linked, and read, without it.
    val linkedSince = listed.map(linkerFor(objectStoreEndpoint).linkListed)
    linkedSince.map(readThrough(_, objectStoreEndpoint)) shouldBe Seq(content, notes)
  }
}
