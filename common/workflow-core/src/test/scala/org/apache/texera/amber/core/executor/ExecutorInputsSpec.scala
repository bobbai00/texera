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

package org.apache.texera.amber.core.executor

import com.sun.net.httpserver.HttpServer
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.PhysicalOp
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.{InetAddress, InetSocketAddress}
import java.nio.charset.StandardCharsets

class ExecutorInputsSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll {

  private val signature = "X-Amz-Signature=5ecr3t5ecr3t"
  private var store: HttpServer = _

  private def storeEndpoint = s"http://127.0.0.1:${store.getAddress.getPort}"

  /** A file linked to the store, which serves "id,name" at any path. */
  private def linked(name: String): InputFile =
    InputFile(name, s"$storeEndpoint/bucket/$name?$signature", Long.MaxValue)

  override protected def beforeAll(): Unit = {
    store = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress, 0), 0)
    store.createContext(
      "/",
      exchange =>
        try {
          val bytes = "id,name".getBytes(StandardCharsets.UTF_8)
          exchange.sendResponseHeaders(200, bytes.length.toLong)
          exchange.getResponseBody.write(bytes)
        } finally exchange.close()
    )
    store.start()
  }

  override protected def afterAll(): Unit = store.stop(0)

  "ExecutorInputs" should "open a file by the name the executor knows it by, through the plan's link" in {
    val inputs = new ExecutorInputs(
      OperatorInputs(files = Seq(linked("a.csv"), linked("b.csv"))),
      Seq(storeEndpoint)
    )

    inputs.hasFile("b.csv") shouldBe true
    val document = inputs.open("b.csv")
    try new String(document.asInputStream().readAllBytes(), StandardCharsets.UTF_8) shouldBe
      "id,name"
    finally document.close()
  }

  it should "refuse a file the plan has no link to" in {
    val inputs =
      new ExecutorInputs(OperatorInputs(files = Seq(linked("a.csv"))), Seq(storeEndpoint))

    inputs.hasFile("other.csv") shouldBe false
    intercept[IllegalStateException](inputs.open("other.csv")).getMessage shouldBe
      "The operator has no link to other.csv: its plan was not made to run."
    intercept[IllegalStateException](ExecutorInputs.none.open("a.csv")).getMessage shouldBe
      "The operator has no link to a.csv: its plan was not made to run."
  }

  it should "follow a link only to the endpoints it is given" in {
    val file = linked("a.csv")
    val elsewhere = new ExecutorInputs(
      OperatorInputs(files = Seq(file)),
      Seq("http://texera-rustfs:9000")
    )
    val nowhere = new ExecutorInputs(OperatorInputs(files = Seq(file)), Seq.empty)

    Seq(elsewhere -> "http://texera-rustfs:9000", nowhere -> "").foreach {
      case (inputs, endpoints) =>
        intercept[IllegalArgumentException](inputs.open("a.csv")).getMessage shouldBe
          s"Refusing to read a.csv: its link points at $storeEndpoint, and input files are " +
            s"read only from $endpoints."
    }
  }

  it should "give the listing and the column limit the plan states, or none" in {
    val inputs = new ExecutorInputs(
      OperatorInputs(
        listing =
          Some(FileListing(Seq("/dataset/a@x.io/ds/v1/b.txt", "/dataset/a@x.io/ds/v1/a.txt"))),
        csvParserMaxColumns = Some(731)
      ),
      Seq.empty
    )

    inputs.listing shouldBe Some(Seq("/dataset/a@x.io/ds/v1/b.txt", "/dataset/a@x.io/ds/v1/a.txt"))
    inputs.csvParserMaxColumns shouldBe Some(731)
    // A version that holds no file is listed all the same.
    new ExecutorInputs(
      OperatorInputs(listing = Some(FileListing())),
      Seq.empty
    ).listing shouldBe Some(Seq.empty)
    ExecutorInputs.none.listing shouldBe None
    ExecutorInputs.none.csvParserMaxColumns shouldBe None
    ExecutorInputs.none.hasFile("a.csv") shouldBe false
  }

  "An input file" should "give its link, and print without the link's signature, whatever holds it" in {
    val file = linked("a.csv")
    file.link.url shouldBe file.url
    file.link.expiresAtMs shouldBe Long.MaxValue

    file.toString shouldBe
      s"InputFile(a.csv, $storeEndpoint/bucket/a.csv, expiresAtMs=${Long.MaxValue})"
    val inputs = OperatorInputs(files = Seq(file), csvParserMaxColumns = Some(512))
    val operator = PhysicalOp(
      PhysicalOpIdentity(OperatorIdentity("scan"), "main"),
      WorkflowIdentity(1),
      ExecutionIdentity(1),
      OpExecWithClassName("org.example.ScanOpExec", "{}")
    ).withInputs(inputs)
    Seq(inputs.toString, operator.toString, Seq(file).toString).foreach { printed =>
      printed should include(s"$storeEndpoint/bucket/a.csv")
      printed should not include "5ecr3t"
    }
  }
}
