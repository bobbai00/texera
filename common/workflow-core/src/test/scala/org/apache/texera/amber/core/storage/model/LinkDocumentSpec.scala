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

package org.apache.texera.amber.core.storage.model

import com.sun.net.httpserver.{HttpExchange, HttpServer}
import org.apache.texera.amber.core.storage.InputLink
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.io.IOException
import java.net.{InetSocketAddress, ServerSocket, URI}
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.{ConcurrentLinkedQueue, ExecutorService, Executors}
import scala.jdk.CollectionConverters._

/**
  * Spec for [[LinkDocument]]: which links it follows, how it reads a file through one, and what
  * it says when it cannot.
  *
  * Two loopback [[HttpServer]]s stand in for addresses a link can point at. `store` is the object
  * store: the one endpoint the documents here may read from. `elsewhere` is any other address a
  * plan could name; it records what reaches it, which must be nothing. No object store, and no
  * Docker, is involved: what a real store makes of a signed link is
  * `PresignedLinkObjectStoreSpec`'s to show.
  */
class LinkDocumentSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  /** One request a server received: its method, and its path and query as they were sent. */
  private case class Hit(method: String, file: String)

  private val storeHits = new ConcurrentLinkedQueue[Hit]()
  private val elsewhereHits = new ConcurrentLinkedQueue[Hit]()
  private var store: HttpServer = _
  private var elsewhere: HttpServer = _
  private var pool: ExecutorService = _

  /** The time, in milliseconds since the epoch, until which `/late-refusal` holds its 403. */
  @volatile private var refuseAfterMs = 0L

  private val content = "id,name\n1,Ada\n2,Grace\n" * 211
  private val signature = "X-Amz-Signature=5ecr3t5ecr3t"
  private val query = s"X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&$signature"

  private def storeEndpoint = s"http://127.0.0.1:${store.getAddress.getPort}"
  private def elsewhereEndpoint = s"http://127.0.0.1:${elsewhere.getAddress.getPort}"

  private def serveStore(exchange: HttpExchange): Unit =
    try {
      val uri = exchange.getRequestURI
      storeHits.add(Hit(exchange.getRequestMethod, uri.getRawPath + "?" + uri.getRawQuery))
      val bytes = content.getBytes(StandardCharsets.UTF_8)
      uri.getPath match {
        case "/datasets/people.csv" =>
          exchange.sendResponseHeaders(200, bytes.length.toLong)
          exchange.getResponseBody.write(bytes)
        case "/datasets/cut-short.csv" =>
          // Closing short of the declared length makes the JDK server drop the connection.
          exchange.sendResponseHeaders(200, bytes.length.toLong)
          exchange.getResponseBody.write(bytes, 0, bytes.length / 2)
        case "/datasets/moved.csv" =>
          exchange.getResponseHeaders.set("Location", s"$elsewhereEndpoint/datasets/people.csv")
          exchange.sendResponseHeaders(302, -1)
        case "/late-refusal" =>
          while (System.currentTimeMillis() < refuseAfterMs) Thread.sleep(5)
          exchange.sendResponseHeaders(403, -1)
        case "/refused" => exchange.sendResponseHeaders(403, -1)
        case "/failing" => exchange.sendResponseHeaders(500, -1)
        case _          => exchange.sendResponseHeaders(404, -1)
      }
    } finally exchange.close()

  override def beforeAll(): Unit = {
    super.beforeAll()
    pool = Executors.newFixedThreadPool(4)
    store = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)
    store.createContext("/", (exchange: HttpExchange) => serveStore(exchange))
    store.setExecutor(pool)
    store.start()
    elsewhere = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)
    elsewhere.createContext(
      "/",
      (exchange: HttpExchange) =>
        try {
          elsewhereHits.add(Hit(exchange.getRequestMethod, exchange.getRequestURI.toString))
          exchange.sendResponseHeaders(200, -1)
        } finally exchange.close()
    )
    elsewhere.setExecutor(pool)
    elsewhere.start()
  }

  override def afterAll(): Unit = {
    try {
      if (store != null) store.stop(0)
      if (elsewhere != null) elsewhere.stop(0)
      if (pool != null) pool.shutdownNow()
    } finally super.afterAll()
  }

  override def beforeEach(): Unit = {
    super.beforeEach()
    storeHits.clear()
    elsewhereHits.clear()
  }

  private val hourMs = 3600L * 1000

  /** A link to `url` that expires `lastsMs` from now. */
  private def linkTo(url: String, lastsMs: Long = hourMs): InputLink =
    InputLink(url, System.currentTimeMillis() + lastsMs)

  /** A document over the store's `path`, by a link that expires `lastsMs` from now. */
  private def document(path: String, lastsMs: Long = hourMs): LinkDocument =
    new LinkDocument(
      linkTo(s"$storeEndpoint$path?$query", lastsMs),
      "people.csv",
      Seq(storeEndpoint)
    )

  private def readFully(document: LinkDocument): String = {
    val stream = document.asInputStream()
    try new String(stream.readAllBytes(), StandardCharsets.UTF_8)
    finally stream.close()
  }

  /** Every message of `failure` and of what caused it. */
  private def messagesOf(failure: Throwable): Seq[String] =
    Iterator.iterate(failure)(_.getCause).takeWhile(_ != null).map(_.toString).toSeq

  /** The temp files [[LinkDocument.asFile]] has left on disk. */
  private def copies: Set[String] =
    Option(new java.io.File(System.getProperty("java.io.tmpdir")).list())
      .map(_.toSet)
      .getOrElse(Set.empty[String])
      .filter(_.startsWith("inputFile"))

  // -----------------------------------------------------------------------------------------
  // Reading
  // -----------------------------------------------------------------------------------------

  "LinkDocument" should "read the file with one GET of the link, sent as the link spells it" in {
    readFully(document("/datasets/people.csv")) shouldBe content

    // The signature covers the path and the query, so neither may be rewritten on the way.
    storeHits.asScala.toList shouldBe List(Hit("GET", s"/datasets/people.csv?$query"))
  }

  it should "fail the read, not end it early, when the body stops short" in {
    val thrown = intercept[IOException](readFully(document("/datasets/cut-short.csv")))

    thrown.getMessage should include("Download of people.csv ended after")
    thrown.getMessage should include(s"of ${content.length} bytes")
  }

  it should "say where the link points without its query" in {
    document("/datasets/people.csv").getURI shouldBe new URI(s"$storeEndpoint/datasets/people.csv")
  }

  // -----------------------------------------------------------------------------------------
  // Which links are followed
  // -----------------------------------------------------------------------------------------

  it should "refuse a link to any other address, before anything connects to it" in {
    val storePort = store.getAddress.getPort
    val otherAddresses = Seq(
      // another port of the store's host, where another server listens
      s"$elsewhereEndpoint/datasets/people.csv?$query" -> elsewhereEndpoint,
      // another host
      s"http://169.254.169.254:$storePort/latest/meta-data?$query" ->
        s"http://169.254.169.254:$storePort",
      // the store's address as user info of another host
      s"http://127.0.0.1:$storePort@localhost:${elsewhere.getAddress.getPort}/x?$query" ->
        s"http://localhost:${elsewhere.getAddress.getPort}",
      // another scheme to the store's host and port
      s"https://127.0.0.1:$storePort/datasets/people.csv?$query" -> s"https://127.0.0.1:$storePort"
    )
    otherAddresses.foreach {
      case (url, pointsAt) =>
        val thrown = intercept[IllegalArgumentException] {
          new LinkDocument(linkTo(url), "people.csv", Seq(storeEndpoint))
        }
        thrown.getMessage shouldBe s"Refusing to read people.csv: its link points at $pointsAt, " +
          s"and input files are read only from $storeEndpoint."
    }
    storeHits shouldBe empty
    elsewhereHits shouldBe empty
  }

  it should "refuse a link that is no http or https URL of a host" in {
    val file = Files.createTempFile("link-document-spec", ".csv")
    try {
      Seq(file.toUri.toString, "ftp://127.0.0.1/people.csv", "people.csv", "http:///people.csv", "")
        .foreach { url =>
          val thrown = intercept[IllegalArgumentException] {
            new LinkDocument(linkTo(url), "people.csv", Seq(storeEndpoint))
          }
          thrown.getMessage shouldBe "Refusing to read people.csv: its link points at no http " +
            s"or https address, and input files are read only from $storeEndpoint."
        }
    } finally Files.deleteIfExists(file)
  }

  it should "read from an allowed endpoint however its scheme, host and port are spelled" in {
    val port = store.getAddress.getPort
    // The setting may spell the host in capitals, end in a slash, or list several endpoints.
    val allowed = Seq("https://objects.example.org", s"HTTP://LOCALHOST:$port/")
    val link = linkTo(s"http://localhost:$port/datasets/people.csv?$query")

    readFully(new LinkDocument(link, "people.csv", allowed)) shouldBe content
    // A port left out is the scheme's own: an endpoint at 443 allows an https link with none.
    noException should be thrownBy new LinkDocument(
      linkTo(s"https://objects.example.org/bucket/key?$query"),
      "people.csv",
      Seq("https://OBJECTS.example.org:443")
    )
  }

  it should "refuse to read anything when an endpoint it is given is no http or https URL" in {
    val thrown = intercept[IllegalStateException] {
      new LinkDocument(linkTo(s"$storeEndpoint/x?$query"), "people.csv", Seq("texera-rustfs:9000"))
    }

    thrown.getMessage shouldBe "'texera-rustfs:9000' is set as an object-store endpoint to " +
      "read input files from, but it is not an http or https URL."
  }

  it should "not follow a redirect the store answers with" in {
    val thrown = intercept[IOException](readFully(document("/datasets/moved.csv")))

    thrown.getMessage shouldBe "Could not read people.csv: the object store answered HTTP 302."
    elsewhereHits shouldBe empty
  }

  // -----------------------------------------------------------------------------------------
  // Expiry
  // -----------------------------------------------------------------------------------------

  /** A document over the store's `path`, by a link that expires at `expiresAtMs`. */
  private def expiringAt(expiresAtMs: Long, path: String = "/datasets/people.csv"): LinkDocument =
    new LinkDocument(
      InputLink(s"$storeEndpoint$path?$query", expiresAtMs),
      "people.csv",
      Seq(storeEndpoint)
    )

  it should "refuse to read through an expired link, naming when it expired, without asking the store" in {
    val document = expiringAt(Instant.parse("2024-02-29T12:00:00Z").toEpochMilli)

    val thrown = intercept[IOException](document.asInputStream())

    thrown.getMessage shouldBe
      "The link to people.csv expired at 2024-02-29T12:00:00Z; run the workflow again."
    intercept[IOException](document.asFile()).getMessage shouldBe thrown.getMessage
    storeHits shouldBe empty
  }

  it should "take a link that expires now for expired" in {
    intercept[IOException](expiringAt(System.currentTimeMillis()).asInputStream()).getMessage should
      startWith("The link to people.csv expired at ")
    storeHits shouldBe empty
  }

  it should "report a link the store refuses once it has expired as expired" in {
    // The link is good when the read starts, and expires before the store answers: the store's
    // refusal is then the link's expiry, whichever of the two clocks noticed first.
    val expiresAtMs = System.currentTimeMillis() + 1000
    refuseAfterMs = expiresAtMs + 50

    val thrown = intercept[IOException](expiringAt(expiresAtMs, "/late-refusal").asInputStream())

    thrown.getMessage shouldBe s"The link to people.csv expired at " +
      s"${Instant.ofEpochMilli(expiresAtMs)}; run the workflow again."
    storeHits.asScala.map(_.method).toList shouldBe List("GET")
  }

  it should "report a refusal of a link that has not expired as the store's answer" in {
    val thrown = intercept[IOException](readFully(document("/refused")))

    thrown.getMessage shouldBe "Could not read people.csv: the object store answered HTTP 403."
  }

  // -----------------------------------------------------------------------------------------
  // Failures
  // -----------------------------------------------------------------------------------------

  it should "report any answer but the file by its status" in {
    Seq("/datasets/gone.csv" -> 404, "/failing" -> 500).foreach {
      case (path, status) =>
        intercept[IOException](readFully(document(path))).getMessage shouldBe
          s"Could not read people.csv: the object store answered HTTP $status."
    }
  }

  it should "report a store that does not answer, naming its address" in {
    val closedPort = {
      val socket = new ServerSocket(0)
      try socket.getLocalPort
      finally socket.close()
    }
    val endpoint = s"http://127.0.0.1:$closedPort"
    val document = new LinkDocument(linkTo(s"$endpoint/x?$query"), "people.csv", Seq(endpoint))

    val thrown = intercept[IOException](document.asInputStream())

    thrown.getMessage shouldBe
      s"Could not read people.csv: the object store at $endpoint did not answer."
    thrown.getCause shouldBe a[java.net.ConnectException]
  }

  it should "keep the link's query out of every failure it reports" in {
    val closedPort = {
      val socket = new ServerSocket(0)
      try socket.getLocalPort
      finally socket.close()
    }
    val unreachable = s"http://127.0.0.1:$closedPort"
    val failures = Seq[() => Any](
      () => readFully(document("/datasets/gone.csv")),
      () => readFully(document("/refused")),
      () => readFully(document("/failing")),
      () => readFully(document("/datasets/moved.csv")),
      () => readFully(document("/datasets/cut-short.csv")),
      () => document("/datasets/cut-short.csv").asFile(),
      () => document("/datasets/people.csv", lastsMs = -1).asInputStream(),
      () =>
        new LinkDocument(linkTo(s"$elsewhereEndpoint/x?$query"), "people.csv", Seq(storeEndpoint)),
      () =>
        new LinkDocument(linkTo(s"$unreachable/x?$query"), "people.csv", Seq(unreachable))
          .asInputStream()
    ).map(failing => intercept[Exception](failing()))

    failures.flatMap(messagesOf).foreach { message =>
      message should not include signature
      message should not include "X-Amz"
    }
    // Nor does the link itself, written into a log line or a message.
    linkTo(s"$storeEndpoint/datasets/people.csv?$query").toString should not include "X-Amz"
  }

  // -----------------------------------------------------------------------------------------
  // asFile / close
  // -----------------------------------------------------------------------------------------

  "asFile" should "copy the file once, and hand the same copy to every later call" in {
    val document = this.document("/datasets/people.csv")
    val first = document.asFile()
    try {
      new String(Files.readAllBytes(first.toPath), StandardCharsets.UTF_8) shouldBe content

      document.asFile() shouldBe first
      storeHits.asScala.toList should have size 1
    } finally document.close()
  }

  it should "keep handing out its copy after the link has expired" in {
    val expiresAtMs = System.currentTimeMillis() + 1000
    val document = expiringAt(expiresAtMs)
    try {
      val copy = document.asFile()
      Thread.sleep(math.max(0L, expiresAtMs + 50 - System.currentTimeMillis()))

      document.asFile() shouldBe copy
      Files.size(copy.toPath) shouldBe content.length.toLong
      // The link itself is of no more use.
      intercept[IOException](document.asInputStream())
    } finally document.close()
  }

  it should "fail, and leave no partial copy, when the read is cut short" in {
    val before = copies

    intercept[IOException](document("/datasets/cut-short.csv").asFile())

    (copies -- before) shouldBe empty
  }

  "close" should "remove the copy, and do nothing for a document that made none" in {
    val document = this.document("/datasets/people.csv")
    val copy = document.asFile()
    Files.size(copy.toPath) shouldBe content.length.toLong

    document.close()

    Files.exists(copy.toPath) shouldBe false
    noException should be thrownBy document.close()
    noException should be thrownBy this.document("/datasets/people.csv").close()
    // Asked again, the file is copied again: the document does not hand out a file that is gone.
    val again = document.asFile()
    try Files.size(again.toPath) shouldBe content.length.toLong
    finally document.close()
  }
}
