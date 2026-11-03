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

import com.sun.net.httpserver.HttpServer
import org.apache.texera.amber.core.storage.DocumentFactory
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.IOException
import java.net.{InetSocketAddress, URI}
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/**
  * The unit reads dataset files through URLs the catalog presigned for the run, so this document
  * is the engine's whole view of a dataset: fetched once, then read as a local file.
  */
class ReadonlyHttpFileDocumentSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll {

  private val csv = "Id,Species\n1,Iris-setosa\n"
  private val served = new AtomicInteger(0)
  private val server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0)
  server.createContext(
    "/datasets/iris.csv",
    exchange => {
      served.incrementAndGet()
      val body = csv.getBytes(UTF_8)
      exchange.sendResponseHeaders(200, body.length)
      exchange.getResponseBody.write(body)
      exchange.close()
    }
  )
  server.createContext(
    "/datasets/expired.csv",
    exchange => {
      val body =
        "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>".getBytes(
          UTF_8
        )
      exchange.sendResponseHeaders(403, body.length)
      exchange.getResponseBody.write(body)
      exchange.close()
    }
  )

  override protected def beforeAll(): Unit = server.start()
  override protected def afterAll(): Unit = server.stop(0)

  private def url(path: String) =
    new URI(s"http://127.0.0.1:${server.getAddress.getPort}$path?X-Amz-Signature=abc")

  "ReadonlyHttpFileDocument" should "download a presigned file once and read it as a file and as a stream" in {
    val before = served.get()
    val document = new ReadonlyHttpFileDocument(url("/datasets/iris.csv"))

    val file = document.asFile()
    new String(Files.readAllBytes(file.toPath), UTF_8) shouldBe csv
    // The temporary copy keeps the extension: some operators pick their reader by it.
    file.getName should endWith(".csv")
    new String(document.asInputStream().readAllBytes(), UTF_8) shouldBe csv
    document.asFile() shouldBe file
    served.get() - before shouldBe 1
  }

  it should "fail with the status and the storage's explanation when the URL is refused" in {
    val error =
      intercept[IOException](new ReadonlyHttpFileDocument(url("/datasets/expired.csv")).asFile())
    error.getMessage should include("403")
    error.getMessage should include("Request has expired")
  }

  it should "not offer tuple access, which a raw file does not have" in {
    val document = new ReadonlyHttpFileDocument(url("/datasets/iris.csv"))
    a[NotImplementedError] should be thrownBy document.getCount
    a[NotImplementedError] should be thrownBy document.get()
  }

  "DocumentFactory.openReadonlyDocument" should "open http and https URLs as HTTP file documents" in {
    DocumentFactory
      .openReadonlyDocument(url("/datasets/iris.csv")) shouldBe a[ReadonlyHttpFileDocument]
    DocumentFactory.openReadonlyDocument(
      new URI("https://storage.example.org/d/iris.csv")
    ) shouldBe a[ReadonlyHttpFileDocument]
  }
}
