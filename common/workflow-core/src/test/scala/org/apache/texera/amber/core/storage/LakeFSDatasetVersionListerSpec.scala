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
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.{PrivilegeEnum, UserRoleEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  DatasetUserAccessDao,
  DatasetVersionDao,
  UserDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  Dataset,
  DatasetUserAccess,
  DatasetVersion,
  User
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.net.{InetSocketAddress, URLDecoder}
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentLinkedQueue
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters._

/**
  * Spec for [[LakeFSDatasetVersionLister]]: the version it lists, for whom, what it asks LakeFS
  * and what it makes of the answer.
  *
  * LakeFS is a loopback [[HttpServer]] that answers the one request a listing takes,
  * `objects/ls`, page by page. The datasets and who may read them are rows of `MockTexeraDB`,
  * for the cases that list as a user; the others are handed a resolver of their own.
  *
  * Tagged [[NonParallelTest]] so the suite gets its own forked JVM: `beforeAll` repoints
  * `StorageConfig.lakefsEndpoint`, which `LakeFSStorageClient` captures once per JVM.
  */
@NonParallelTest
class LakeFSDatasetVersionListerSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  /** One request LakeFS received: its path, and its query's parameters. */
  private case class Hit(path: String, query: Map[String, String])

  private val requests = new ConcurrentLinkedQueue[Hit]()
  private var lakefs: HttpServer = _

  private val commit = "97fd4c2a755b69b7c66d322eab40b7e5c2ad5d10"
  private def lsPath(repository: String) =
    s"/api/v1/repositories/$repository/refs/$commit/objects/ls"

  /** The files LakeFS holds at `commit` of each repository, in the order it lists them. */
  private val files: Map[String, Seq[(String, Long)]] = Map(
    "dataset-12" -> Seq(
      "2024/q1/sales report.csv" -> 8192L,
      "a.txt" -> 3L,
      "données/été.csv" -> 0L
    ),
    "dataset-13" -> Seq("public.txt" -> 7L),
    "dataset-empty" -> Seq.empty,
    "dataset-large" -> (0 until 2500).map(i => f"part-$i%04d.csv" -> i.toLong)
  )

  /** Where LakeFS keeps a file: an object of its own naming, not the file's path. */
  private def physicalAddress(repository: String, file: String): String =
    s"s3://texera-dataset/$repository/data/${Integer.toHexString(file.hashCode)}"

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
        files.get(repository).filter(_ => uri.getPath == lsPath(repository)) match {
          case Some(held) =>
            // Pages as LakeFS does: the `amount` asked for, after the file `after` names.
            val from = query
              .get("after")
              .filter(_.nonEmpty)
              .fold(0)(after => held.indexWhere(_._1 == after) + 1)
            val page = held.slice(from, from + query("amount").toInt)
            val hasMore = from + page.size < held.size
            val results = page.map {
              case (file, size) =>
                s"""{"path":${quoted(file)},"path_type":"object","checksum":"chk",
                 |"physical_address":${quoted(physicalAddress(repository, file))},
                 |"mtime":1700000000,"size_bytes":$size}""".stripMargin
            }
            200 -> s"""{"pagination":{"has_more":$hasMore,
                    |"next_offset":${quoted(page.lastOption.fold("")(_._1))},
                    |"results":${page.size},"max_per_page":1000},
                    |"results":[${results.mkString(",")}]}""".stripMargin
          case None if repository == "dataset-broken" => 500 -> """{"message":"stubbed failure"}"""
          case None                                   => 404 -> """{"message":"not found"}"""
        }
      val bytes = body.getBytes(StandardCharsets.UTF_8)
      exchange.getResponseHeaders.set("Content-Type", "application/json")
      exchange.sendResponseHeaders(status, bytes.length.toLong)
      exchange.getResponseBody.write(bytes)
    } finally exchange.close()

  private def quoted(text: String): String = "\"" + text + "\""

  // Three users around two datasets of `owner`'s, each with a version v1: `granted` holds a READ
  // grant on the private one, `stranger` holds nothing.
  private val owner = userNamed(1, "ada")
  private val granted = userNamed(2, "grace")
  private val stranger = userNamed(3, "edsger")

  private def userNamed(uid: Int, name: String): User = {
    val user = new User
    user.setUid(Integer.valueOf(uid))
    user.setName(name)
    user.setRole(UserRoleEnum.REGULAR)
    user.setEmail(s"$name@texera.io")
    user
  }

  private def insertDataset(did: Int, name: String, repository: String, isPublic: Boolean): Unit = {
    val dataset = new Dataset
    dataset.setDid(Integer.valueOf(did))
    dataset.setName(name)
    dataset.setRepositoryName(repository)
    dataset.setDescription("")
    dataset.setIsPublic(isPublic)
    dataset.setOwnerUid(owner.getUid)
    new DatasetDao(getDSLContext.configuration()).insert(dataset)
    val version = new DatasetVersion
    version.setDid(Integer.valueOf(did))
    version.setName("v1")
    version.setCreatorUid(owner.getUid)
    version.setVersionHash(commit)
    new DatasetVersionDao(getDSLContext.configuration()).insert(version)
  }

  private val lettersPath = "/dataset/ada@texera.io/letters/v1"

  override def beforeAll(): Unit = {
    super.beforeAll()
    lakefs = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)
    lakefs.createContext("/", (exchange: HttpExchange) => handle(exchange))
    lakefs.start()
    // Before anything forces LakeFSStorageClient's client, which no other suite shares.
    StorageConfig.lakefsEndpoint = s"http://127.0.0.1:${lakefs.getAddress.getPort}/api/v1"

    initializeDBAndReplaceDSLContext()
    val userDao = new UserDao(getDSLContext.configuration())
    Seq(owner, granted, stranger).foreach(userDao.insert)
    insertDataset(12, "letters", "dataset-12", isPublic = false)
    insertDataset(13, "almanac", "dataset-13", isPublic = true)
    val grant = new DatasetUserAccess
    grant.setDid(Integer.valueOf(12))
    grant.setUid(granted.getUid)
    grant.setPrivilege(PrivilegeEnum.READ)
    new DatasetUserAccessDao(getDSLContext.configuration()).insert(grant)
  }

  override def afterAll(): Unit = {
    try {
      lakefs.stop(0)
      closeConnectionPool()
    } finally super.afterAll()
  }

  override def beforeEach(): Unit = {
    super.beforeEach()
    requests.clear()
  }

  private def hits: List[Hit] = requests.asScala.toList

  /** A lister that pins every version path to `repository`, and lists the paths it was asked. */
  private def listerOf(
      repository: String,
      asked: ArrayBuffer[String] = ArrayBuffer.empty
  ): LakeFSDatasetVersionLister =
    new LakeFSDatasetVersionLister(versionPath => {
      asked += versionPath
      (repository, commit)
    })

  "LakeFSDatasetVersionLister" should
    "list the files of a version, each by its logical path, with where LakeFS keeps it" in {
    val listed = listerOf("dataset-12").list(lettersPath, atMost = 100)

    // In LakeFS's order, which is the order of the files' paths as it keeps them.
    listed shouldBe Seq(
      ListedFile(
        s"$lettersPath/2024/q1/sales report.csv",
        physicalAddress("dataset-12", "2024/q1/sales report.csv")
      ),
      ListedFile(s"$lettersPath/a.txt", physicalAddress("dataset-12", "a.txt")),
      ListedFile(s"$lettersPath/données/été.csv", physicalAddress("dataset-12", "données/été.csv"))
    )
    // One request: the commit that backs the version, asked for no more than is wanted.
    hits shouldBe List(Hit(lsPath("dataset-12"), Map("amount" -> "100")))
  }

  it should "list a version that holds no file as an empty listing" in {
    listerOf("dataset-empty").list(lettersPath, atMost = 100) shouldBe empty
  }

  it should "list the first files of a version that holds more than it is asked for" in {
    val listed = listerOf("dataset-large").list(lettersPath, atMost = 1201)

    listed.map(_.logicalPath) shouldBe (0 until 1201).map(i => f"$lettersPath/part-$i%04d.csv")
    // LakeFS is asked for a full page, then only for what is still wanted of the next.
    hits.map(_.query("amount")) shouldBe List("1000", "201")
    hits.map(_.query.get("after")) shouldBe List(None, Some("part-0999.csv"))
  }

  it should "name the files under the version's own path, however the version was named" in {
    Seq(
      // Without the prefix, as paths stored before it existed.
      "/ada@texera.io/letters/v1",
      // With what follows the version dropped.
      "/dataset/ada@texera.io/letters/v1/",
      "/dataset/ada@texera.io/letters/v1/2024/q1",
      "dataset/ada@texera.io/letters/v1"
    ).foreach { versionPath =>
      withClue(s"$versionPath: ") {
        val asked = ArrayBuffer.empty[String]

        val listed = listerOf("dataset-12", asked).list(versionPath, atMost = 100)

        // The version is pinned, and so its reader checked, by the same path.
        asked.toList shouldBe List(lettersPath)
        listed.map(_.logicalPath).head shouldBe s"$lettersPath/2024/q1/sales report.csv"
      }
    }
  }

  it should "refuse a path that names no dataset version, asking nothing about it" in {
    val asked = ArrayBuffer.empty[String]
    Seq(
      // Stops short of a version, with the prefix and without.
      "/dataset/ada@texera.io/letters",
      "/ada@texera.io/letters",
      // Another kind of resource's.
      "/model/ada@texera.io/letters/v1",
      "/model/ada@texera.io/letters",
      "",
      "/",
      null
    ).foreach { versionPath =>
      withClue(s"$versionPath: ") {
        val thrown = intercept[FileNotFoundException] {
          listerOf("dataset-12", asked).list(versionPath, atMost = 100)
        }

        thrown.getMessage should include(
          s"Invalid dataset version path '$versionPath'; expected " +
            "/dataset/ownerEmail/datasetName/versionName"
        )
      }
    }
    asked shouldBe empty
    hits shouldBe empty
  }

  it should "take an unknown first segment for the owner of a path with no prefix" in {
    val asked = ArrayBuffer.empty[String]

    listerOf("dataset-12", asked).list("/notAResourceType/ada/letters", atMost = 1)

    asked.toList shouldBe List("/dataset/notAResourceType/ada/letters")
  }

  it should "refuse a version its resolver does not pin, without asking LakeFS" in {
    val notReadable = new FileNotFoundException(lettersPath)
    val lister = new LakeFSDatasetVersionLister(_ => throw notReadable)

    val thrown = intercept[FileNotFoundException](lister.list(lettersPath, atMost = 100))

    thrown should be theSameInstanceAs notReadable
    hits shouldBe empty
  }

  it should "throw a listing LakeFS fails, or does not have, as it is: the version may well be there" in {
    Seq("dataset-broken" -> 500, "dataset-gone" -> 404).foreach {
      case (repository, status) =>
        val thrown = intercept[ApiException](listerOf(repository).list(lettersPath, atMost = 100))

        thrown.getCode shouldBe status
    }
  }

  "The lister of a user" should "list a private dataset's version for its owner and for a user granted read access" in {
    Seq(owner, granted).foreach { reader =>
      withClue(s"${reader.getName}: ") {
        val listed =
          LakeFSDatasetVersionLister.forUser(reader.getUid).list(lettersPath, atMost = 100)

        listed.map(_.logicalPath) shouldBe Seq(
          s"$lettersPath/2024/q1/sales report.csv",
          s"$lettersPath/a.txt",
          s"$lettersPath/données/été.csv"
        )
      }
    }
    hits.map(_.path).distinct shouldBe List(lsPath("dataset-12"))
  }

  it should "refuse a private dataset's version to any other user, without asking LakeFS for it" in {
    val forStranger = LakeFSDatasetVersionLister.forUser(stranger.getUid)

    intercept[FileNotFoundException](forStranger.list(lettersPath, atMost = 100))
    // By any spelling of its path.
    intercept[FileNotFoundException](forStranger.list("/ada@texera.io/letters/v1", atMost = 100))
    intercept[FileNotFoundException] {
      LakeFSDatasetVersionLister.forUser(null).list(lettersPath, atMost = 100)
    }

    hits shouldBe empty
  }

  it should "list a public dataset's version for a user with no grant on it" in {
    val listed = LakeFSDatasetVersionLister
      .forUser(stranger.getUid)
      .list("/dataset/ada@texera.io/almanac/v1", atMost = 100)

    listed shouldBe Seq(
      ListedFile(
        "/dataset/ada@texera.io/almanac/v1/public.txt",
        physicalAddress("dataset-13", "public.txt")
      )
    )
  }

  it should "refuse a version, a dataset or an owner that does not exist, without asking LakeFS" in {
    Seq(
      "/dataset/ada@texera.io/letters/v9",
      "/dataset/ada@texera.io/no-such-dataset/v1",
      "/dataset/nobody@texera.io/letters/v1"
    ).foreach { versionPath =>
      withClue(s"$versionPath: ") {
        intercept[FileNotFoundException] {
          LakeFSDatasetVersionLister.forUser(owner.getUid).list(versionPath, atMost = 100)
        }
      }
    }
    hits shouldBe empty
  }

}
