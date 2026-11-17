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

import org.apache.texera.amber.core.storage.InputLink
import org.apache.texera.amber.core.storage.model.LinkDocument
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.{ByteArrayInputStream, IOException}
import java.net.{HttpURLConnection, URI, URL}
import java.nio.charset.StandardCharsets
import java.time.Duration

/**
  * What a real S3-compatible store (RustFS, in a container) makes of the links
  * [[ObjectStorePresigner]] signs, read the way a computing unit reads them ([[LinkDocument]]).
  *
  * The store is reached at two spellings of one address, `localhost` and `127.0.0.1`. They stand
  * for the two addresses a deployment's store has: the one its computing units reach it at, and
  * any other, such as the one browsers use, which LakeFS signs its own links for.
  */
@NonParallelTest
class PresignedLinkObjectStoreSpec
    extends AnyFlatSpec
    with Matchers
    with S3StorageTestBase
    with BeforeAndAfterAll {

  private val bucket = "presigned-link-object-store-spec"
  private val objectKey = "dataset-12/data/gdm5 a/b+c,_Zs é.csv"
  private val content = "id,name\n1,Ada\n2,Grace\n" * 4099

  private lazy val port = new URI(StorageConfig.s3Endpoint).getPort
  private lazy val unitsEndpoint = s"http://localhost:$port"
  private lazy val otherEndpoint = s"http://127.0.0.1:$port"

  private def presignerFor(endpoint: String): ObjectStorePresigner =
    new ObjectStorePresigner(
      new URI(endpoint),
      StorageConfig.s3Region,
      StorageConfig.s3Username,
      StorageConfig.s3Password
    )

  /** A document over `url`, as a computing unit that reads links from both addresses opens it. */
  private def document(url: String): LinkDocument =
    new LinkDocument(
      InputLink(url, System.currentTimeMillis() + 3600L * 1000, content.length.toLong),
      "people.csv",
      Seq(unitsEndpoint, otherEndpoint)
    )

  private def readFully(document: LinkDocument): String = {
    val stream = document.asInputStream()
    try new String(stream.readAllBytes(), StandardCharsets.UTF_8)
    finally stream.close()
  }

  /** The status the store answers a request of `method` to `url` with. */
  private def statusOf(method: String, url: String): Int = {
    val connection = new URL(url).openConnection().asInstanceOf[HttpURLConnection]
    try {
      connection.setRequestMethod(method)
      connection.getResponseCode
    } finally connection.disconnect()
  }

  override def beforeAll(): Unit = {
    super.beforeAll()
    S3StorageClient.createBucketIfNotExist(bucket)
    S3StorageClient.uploadObject(
      bucket,
      objectKey,
      new ByteArrayInputStream(content.getBytes(StandardCharsets.UTF_8))
    )
  }

  override def afterAll(): Unit = {
    try S3StorageClient.deleteDirectory(bucket, "dataset-12")
    catch { case _: Exception => } // best-effort: the container goes with the JVM
    super.afterAll()
  }

  "A link signed for the address its reader reaches the store at" should
    "read the object, with no credentials of the reader's" in {
    val signed = presignerFor(unitsEndpoint).presignGet(bucket, objectKey, Duration.ofHours(1))

    readFully(document(signed.url)) shouldBe content
  }

  it should "be refused by the store at any other address of it" in {
    // The signature covers the host, so a link cannot be pointed elsewhere once it is signed:
    // this is why a link is signed for the address its reader uses.
    val signed = presignerFor(unitsEndpoint).presignGet(bucket, objectKey, Duration.ofHours(1))
    val repointed = signed.url.replace(unitsEndpoint, otherEndpoint)

    intercept[IOException](readFully(document(repointed))).getMessage shouldBe
      "Could not read people.csv: the object store answered HTTP 403."
    // Signed for that address, the same object reads.
    readFully(
      document(presignerFor(otherEndpoint).presignGet(bucket, objectKey, Duration.ofHours(1)).url)
    ) shouldBe content
  }

  it should "read nothing once its signature or its object is changed" in {
    val signed = presignerFor(unitsEndpoint).presignGet(bucket, objectKey, Duration.ofHours(1))
    val (untilSignature, signature) = signed.url.splitAt(signed.url.length - 64)
    signature should fullyMatch regex "[0-9a-f]{64}"
    val forged = untilSignature + signature.reverse
    val anotherObject = signed.url.replace("dataset-12", "dataset-13")
    val unsigned = signed.url.takeWhile(_ != '?')

    Seq(forged, anotherObject, unsigned).foreach { url =>
      intercept[IOException](readFully(document(url))).getMessage shouldBe
        "Could not read people.csv: the object store answered HTTP 403."
    }
  }

  it should "let its holder read the object, and do nothing else to it" in {
    val signed = presignerFor(unitsEndpoint).presignGet(bucket, objectKey, Duration.ofHours(1))

    statusOf("DELETE", signed.url) shouldBe 403
    statusOf("PUT", signed.url) shouldBe 403
    readFully(document(signed.url)) shouldBe content
  }

  it should "be answered 404 when it is of an object the store does not have" in {
    // Signing asks the store nothing, so a link is made for an object that is not there.
    val signed =
      presignerFor(unitsEndpoint).presignGet(bucket, "dataset-12/gone.csv", Duration.ofHours(1))

    intercept[IOException](readFully(document(signed.url))).getMessage shouldBe
      "Could not read people.csv: the object store answered HTTP 404."
  }
}
