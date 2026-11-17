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

import com.sun.net.httpserver.{HttpExchange, HttpServer}
import io.lakefs.clients.sdk.ApiException
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.common.tags.NonParallelTest
import org.apache.texera.service.util.ObjectStorePresigner
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.net.{InetSocketAddress, URI, URLDecoder}
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.ConcurrentLinkedQueue
import scala.jdk.CollectionConverters._

/**
  * Spec for [[LakeFSInputLinker]]: what it asks LakeFS, the link it makes from the answer, and
  * which failures are a file that is not there; and that it asks nothing to link a file of a
  * listing.
  *
  * LakeFS is a loopback [[HttpServer]] that answers the one lookup a link to a resolved file
  * takes, `objects/stat`. Signing asks nothing, so the object store the links are signed for is
  * only a name here.
  *
  * Tagged [[NonParallelTest]] so the suite gets its own forked JVM: `beforeAll` repoints
  * `StorageConfig.lakefsEndpoint`, which `LakeFSStorageClient` captures once per JVM.
  */
@NonParallelTest
class LakeFSInputLinkerSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  /** One request LakeFS received: its path, and its query's parameters. */
  private case class Hit(path: String, query: Map[String, String])

  private val requests = new ConcurrentLinkedQueue[Hit]()
  private var lakefs: HttpServer = _

  private val commit = "97fd4c2a755b69b7c66d322eab40b7e5c2ad5d10"
  private def statPath(repository: String) =
    s"/api/v1/repositories/$repository/refs/$commit/objects/stat"

  /** What LakeFS answers for a file: a status and, for a file it has, its physical address. */
  private val answers: Map[(String, String), Either[Int, String]] = Map(
    ("dataset-12", "people.csv") -> Right("s3://texera-dataset/dataset-12/data/gdm5/c8a,_Zs"),
    ("dataset-12", "2024/q1/sales report.csv") -> Right("s3://texera-dataset/dataset-12/data/q1"),
    ("model-7", "weights/model.pt") -> Right("s3://texera-dataset/model-7/data/w"),
    ("dataset-12", "on-disk.csv") -> Right("local:///data/dataset-12/on-disk.csv"),
    ("dataset-12", "unreadable.csv") -> Left(500),
    ("dataset-12", "forbidden.csv") -> Left(401)
  )

  private def handle(exchange: HttpExchange): Unit =
    try {
      val uri = exchange.getRequestURI
      val query = Option(uri.getRawQuery).toSeq
        .flatMap(_.split('&'))
        .map { parameter =>
          val Array(name, value) = (parameter.split("=", 2) :+ "").take(2)
          URLDecoder.decode(name, StandardCharsets.UTF_8) ->
            URLDecoder.decode(value, StandardCharsets.UTF_8)
        }
        .toMap
      requests.add(Hit(uri.getPath, query))
      val repository = uri.getPath.split('/').lift(4).getOrElse("")
      val (status, body) =
        answers
          .get((repository, query.getOrElse("path", "")))
          .filter(_ => uri.getPath == statPath(repository)) match {
          case Some(Right(physicalAddress)) =>
            200 -> s"""{"path":"${query("path")}","path_type":"object","checksum":"chk",
                      |"physical_address":"$physicalAddress","mtime":1700000000,
                      |"size_bytes":412}""".stripMargin
          case Some(Left(status)) => status -> """{"message":"stubbed failure"}"""
          case None               => 404 -> """{"message":"not found"}"""
        }
      val bytes = body.getBytes(StandardCharsets.UTF_8)
      exchange.getResponseHeaders.set("Content-Type", "application/json")
      exchange.sendResponseHeaders(status, bytes.length.toLong)
      exchange.getResponseBody.write(bytes)
    } finally exchange.close()

  override def beforeAll(): Unit = {
    super.beforeAll()
    lakefs = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)
    lakefs.createContext("/", (exchange: HttpExchange) => handle(exchange))
    lakefs.start()
    // Before anything forces LakeFSStorageClient's client, which no other suite shares.
    StorageConfig.lakefsEndpoint = s"http://127.0.0.1:${lakefs.getAddress.getPort}/api/v1"
  }

  override def afterAll(): Unit = {
    // Already stopped, when the last test ran.
    try lakefs.stop(0)
    catch { case _: Exception => }
    finally super.afterAll()
  }

  override def beforeEach(): Unit = {
    super.beforeEach()
    requests.clear()
  }

  private val linker = new LakeFSInputLinker(
    new ObjectStorePresigner(
      new URI("http://texera-rustfs:9000"),
      "us-west-2",
      "texera_rustfs",
      "password"
    ),
    Duration.ofHours(2)
  )

  private def hits: List[Hit] = requests.asScala.toList

  "LakeFSInputLinker" should "link a dataset's file to its object, at the store its links are signed for" in {
    val before = System.currentTimeMillis()
    val link = linker.link(new URI(s"dataset:///dataset-12/$commit/people.csv"))
    val after = System.currentTimeMillis()

    val url = new URI(link.url)
    (url.getScheme, url.getHost, url.getPort) shouldBe (("http", "texera-rustfs", 9000))
    // Path-style: the bucket, then the key, of the file's physical address.
    url.getPath shouldBe "/texera-dataset/dataset-12/data/gdm5/c8a,_Zs"
    url.getRawQuery should include("X-Amz-Signature=")
    url.getRawQuery should include("X-Amz-Expires=7200")
    link.sizeBytes shouldBe 412
    // The link lasts the two hours it was made to, to the second the link itself names.
    link.expiresAtMs should be > before + Duration.ofHours(2).toMillis - 1000
    link.expiresAtMs should be <= after + Duration.ofHours(2).toMillis
  }

  it should "ask LakeFS once, where the file is, and not for a link of LakeFS's own" in {
    linker.link(new URI(s"dataset:///dataset-12/$commit/people.csv"))

    hits shouldBe List(Hit(statPath("dataset-12"), Map("path" -> "people.csv")))
  }

  it should "link a file by its whole path within the version, and a model's as a dataset's" in {
    linker.link(new URI("dataset", "", s"/dataset-12/$commit/2024/q1/sales+report.csv", null))
    val weights = linker.link(new URI(s"model:///model-7/$commit/weights/model.pt"))

    hits shouldBe List(
      Hit(statPath("dataset-12"), Map("path" -> "2024/q1/sales report.csv")),
      Hit(statPath("model-7"), Map("path" -> "weights/model.pt"))
    )
    new URI(weights.url).getPath shouldBe "/texera-dataset/model-7/data/w"
  }

  it should "report a file its version does not hold as not found" in {
    val missing = new URI(s"dataset:///dataset-12/$commit/missing.csv")

    val thrown = intercept[FileNotFoundException](linker.link(missing))

    thrown.getMessage should include(missing.toString)
    // So is a file of a repository or a commit LakeFS does not have.
    intercept[FileNotFoundException] {
      linker.link(new URI(s"dataset:///dataset-99/$commit/people.csv"))
    }
  }

  it should "throw a lookup LakeFS fails, or refuses, as it is: the file may well be there" in {
    Seq("unreadable.csv" -> 500, "forbidden.csv" -> 401).foreach {
      case (file, status) =>
        val thrown = intercept[ApiException] {
          linker.link(new URI(s"dataset:///dataset-12/$commit/$file"))
        }
        thrown.getCode shouldBe status
    }
  }

  it should "refuse to link a file that LakeFS keeps outside an S3 object store" in {
    val thrown = intercept[IllegalStateException] {
      linker.link(new URI(s"dataset:///dataset-12/$commit/on-disk.csv"))
    }

    thrown.getMessage shouldBe s"dataset:///dataset-12/$commit/on-disk.csv is kept at " +
      "local:///data/dataset-12/on-disk.csv, which is not in an S3 object store, so no link to " +
      "it can be signed."
  }

  it should "refuse a file LakeFS does not keep, without asking LakeFS" in {
    val thrown = intercept[UnsupportedOperationException] {
      linker.link(new URI("file:///etc/passwd"))
    }

    thrown.getMessage shouldBe "Unsupported URI scheme: file for linking an input file"
    hits shouldBe empty
  }

  it should "link a listed file to the object its listing names, asking LakeFS nothing" in {
    val listed = ListedFile(
      "/dataset/ada@texera.io/letters/v1/2024/q1/sales report.csv",
      "s3://texera-dataset/dataset-12/data/gdm5/c8a,_Zs",
      8192
    )
    val before = System.currentTimeMillis()
    val link = linker.linkListed(listed)
    val after = System.currentTimeMillis()

    val url = new URI(link.url)
    (url.getScheme, url.getHost, url.getPort) shouldBe (("http", "texera-rustfs", 9000))
    url.getPath shouldBe "/texera-dataset/dataset-12/data/gdm5/c8a,_Zs"
    url.getRawQuery should include("X-Amz-Signature=")
    url.getRawQuery should include("X-Amz-Expires=7200")
    // The size is the listing's: nothing was asked that could give another.
    link.sizeBytes shouldBe 8192
    link.expiresAtMs should be > before + Duration.ofHours(2).toMillis - 1000
    link.expiresAtMs should be <= after + Duration.ofHours(2).toMillis
    hits shouldBe empty
  }

  it should "link the files of a whole listing, each to its own object, asking LakeFS nothing" in {
    val listing = (1 to 10000).map { i =>
      ListedFile(s"/dataset/ada@texera.io/letters/v1/file-$i.txt", s"s3://texera-dataset/k/$i", i)
    }

    val links = listing.map(linker.linkListed)

    links.map(link => new URI(link.url).getPath) shouldBe
      (1 to 10000).map(i => s"/texera-dataset/k/$i")
    links.map(_.sizeBytes) shouldBe (1 to 10000)
    hits shouldBe empty
  }

  it should "refuse to link a listed file that LakeFS keeps outside an S3 object store" in {
    val thrown = intercept[IllegalStateException] {
      linker.linkListed(
        ListedFile(
          "/dataset/ada@texera.io/letters/v1/on-disk.csv",
          "local:///data/dataset-12/on-disk.csv",
          412
        )
      )
    }

    thrown.getMessage shouldBe "/dataset/ada@texera.io/letters/v1/on-disk.csv is kept at " +
      "local:///data/dataset-12/on-disk.csv, which is not in an S3 object store, so no link to " +
      "it can be signed."
    hits shouldBe empty
  }

  "The linker of a compile that makes no plan to run" should "link no file, resolved or listed" in {
    val resolved = intercept[IllegalStateException] {
      InputLinker.Unavailable.link(new URI(s"dataset:///dataset-12/$commit/people.csv"))
    }
    val listed = intercept[IllegalStateException] {
      InputLinker.Unavailable.linkListed(
        ListedFile("/dataset/ada@texera.io/letters/v1/a.txt", "s3://texera-dataset/k/a", 1)
      )
    }

    resolved.getMessage shouldBe "No linker for input files was given, so " +
      s"dataset:///dataset-12/$commit/people.csv cannot be linked."
    listed.getMessage shouldBe "No linker for input files was given, so " +
      "/dataset/ada@texera.io/letters/v1/a.txt cannot be linked."
    hits shouldBe empty
  }

  "The deployment's linker" should
    "sign for the endpoint, with the keys and for the lifetime the deployment is set up with" in {
    val link = LakeFSInputLinker.forDeployment.link(
      new URI(s"dataset:///dataset-12/$commit/people.csv")
    )

    val url = new URI(link.url)
    val endpoint = new URI(StorageConfig.inputLinksS3Endpoint)
    (url.getScheme, url.getHost, url.getPort) shouldBe
      ((endpoint.getScheme, endpoint.getHost, endpoint.getPort))
    url.getRawQuery should include(s"X-Amz-Expires=${StorageConfig.inputLinksTtlSeconds}&")
    url.getRawQuery should include(s"X-Amz-Credential=${StorageConfig.s3Username}%2F")
    url.getRawQuery should include(s"%2F${StorageConfig.s3Region}%2Fs3%2Faws4_request")
  }

  // Last: it takes LakeFS away.
  "LakeFSInputLinker" should "throw a lookup that LakeFS does not answer as it is" in {
    lakefs.stop(0)

    val thrown = intercept[ApiException] {
      linker.link(new URI(s"dataset:///dataset-12/$commit/people.csv"))
    }

    thrown.getCode shouldBe 0
    thrown.getCause shouldBe a[java.io.IOException]
  }
}
