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

package org.apache.texera.web.service.execution

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.sun.net.httpserver.{HttpExchange, HttpServer}
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.web.service.execution.ComputingUnitClient.{
  Handover,
  Refused,
  Taken,
  Unanswered,
  Unreached
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.http.{HttpConnectTimeoutException, HttpTimeoutException}
import java.net.{ConnectException, InetAddress, InetSocketAddress, URI}
import java.nio.charset.StandardCharsets
import java.util.concurrent.{ConcurrentLinkedQueue, Executors}
import scala.concurrent.duration.{Duration, DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * How the Dashboard service reaches a computing unit ([[ComputingUnitClient]]): what it sends
  * it over HTTP ([[HttpComputingUnitClient]]), and what it makes of each way a unit answers or
  * does not. The unit is a server on the loopback interface that answers as a case says. Where
  * a unit is found is the rule `ComputingUnitAddressSpec` pins, in `common/auth`.
  */
class ComputingUnitClientSpec extends AnyFlatSpec with Matchers {

  private val mapper = new ObjectMapper()

  /**
    * A request a unit was sent.
    *
    * @param userId        its `x-user-id` header; null when it has none
    * @param authorization its `Authorization` header; null when it has none
    */
  private case class Sent(
      method: String,
      path: String,
      userId: String,
      authorization: String,
      contentType: String,
      body: JsonNode
  )

  /**
    * A computing unit on the loopback interface, which answers each request `status` with
    * `body`, once `delay` has passed, and keeps what it was sent.
    */
  private class StubUnit(status: Int, body: String = "", delay: FiniteDuration = Duration.Zero)
      extends AutoCloseable {
    private val sent = new ConcurrentLinkedQueue[Sent]()
    private val server =
      HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress, 0), 0)
    server.createContext("/", (exchange: HttpExchange) => serve(exchange))
    // Daemon threads, so that an answer a case keeps waiting holds no JVM open.
    server.setExecutor(Executors.newCachedThreadPool { task =>
      val thread = new Thread(task, "stub-computing-unit")
      thread.setDaemon(true)
      thread
    })
    server.start()

    val address: URI = URI.create(s"http://127.0.0.1:${server.getAddress.getPort}")

    def requests: List[Sent] = sent.asScala.toList

    override def close(): Unit = server.stop(0)

    private def serve(exchange: HttpExchange): Unit =
      try {
        val headers = exchange.getRequestHeaders
        sent.add(
          Sent(
            exchange.getRequestMethod,
            exchange.getRequestURI.getPath,
            headers.getFirst(HeaderField.UserId),
            headers.getFirst("Authorization"),
            headers.getFirst("Content-Type"),
            mapper.readTree(exchange.getRequestBody.readAllBytes())
          )
        )
        Thread.sleep(delay.toMillis)
        val bytes = body.getBytes(StandardCharsets.UTF_8)
        // A length of 0 would mean a body of no declared length, so an empty body has none.
        exchange.sendResponseHeaders(status, if (bytes.isEmpty) -1 else bytes.length.toLong)
        if (bytes.nonEmpty) exchange.getResponseBody.write(bytes)
      } catch {
        // The client stopped waiting.
        case _: java.io.IOException =>
      } finally exchange.close()
  }

  /** A client that finds every unit at `address`, and notes the units it looked up. */
  private class ClientOf(
      address: URI,
      deadline: FiniteDuration = 5.seconds,
      val lookedUp: scala.collection.mutable.ListBuffer[Int] =
        scala.collection.mutable.ListBuffer.empty
  ) extends HttpComputingUnitClient(
        cuid => {
          lookedUp += cuid
          Some(address)
        },
        connectTimeout = 2.seconds,
        deadline = deadline
      )

  private val uid = 4711

  // --- what it sends ---

  "HttpComputingUnitClient.start" should
    "post the plan and the execution's catalog token to the unit's start route, for the user and with no token to verify, and take a 204 as the plan taken" in {
    val plan = """{"formatVersion": 1, "executionId": {"id": "345"}, "operators": []}"""
    Using.resource(new StubUnit(204)) { unit =>
      val client = new ClientOf(unit.address)

      client.start(7, plan, uid, Some("the-catalog-token-of-345")) shouldBe Taken

      // The unit asked is the one found at the address of the unit the plan is for.
      client.lookedUp.toList shouldBe List(7)
      // The user is named by id. No token goes to a unit to verify, which could verify none.
      unit.requests.map(sent =>
        (sent.method, sent.path, sent.userId, sent.authorization, sent.contentType)
      ) shouldBe List(("POST", "/api/execution/start", "4711", null, "application/json"))
      // The plan as one JSON string, the unit it is for, and the token the execution's catalog
      // requests carry, as the route reads them.
      val body = unit.requests.head.body
      body.fieldNames().asScala.toSet shouldBe Set("plan", "computingUnitId", "catalogToken")
      body.get("plan").asText() shouldBe plan
      body.get("computingUnitId").asInt() shouldBe 7
      body.get("catalogToken").asText() shouldBe "the-catalog-token-of-345"
    }
  }

  it should "send a null catalog token for a catalog that takes none" in {
    Using.resource(new StubUnit(204)) { unit =>
      new ClientOf(unit.address).start(7, "{}", uid, None) shouldBe Taken

      val body = unit.requests.head.body
      body.fieldNames().asScala.toSet shouldBe Set("plan", "computingUnitId", "catalogToken")
      body.get("catalogToken").isNull shouldBe true
    }
  }

  "HttpComputingUnitClient.update" should
    "post the change to the unit's update route, for the user and with no token, and take a 204 as the change taken" in {
    val change = """{"formatVersion": 1, "executionId": {"id": "345"}, "opId": "limit"}"""
    Using.resource(new StubUnit(204)) { unit =>
      val client = new ClientOf(unit.address)

      client.update(7, change, uid) shouldBe Taken

      client.lookedUp.toList shouldBe List(7)
      unit.requests.map(sent =>
        (sent.method, sent.path, sent.userId, sent.authorization, sent.contentType)
      ) shouldBe List(("POST", "/api/execution/update", "4711", null, "application/json"))
      val body = unit.requests.head.body
      body.fieldNames().asScala.toSet shouldBe Set("update")
      body.get("update").asText() shouldBe change
    }
  }

  // --- what it makes of the unit's answer ---

  /** What a hand-over to a unit that answers `status` with `body` comes to. */
  private def answered(status: Int, body: String = ""): Handover =
    Using.resource(new StubUnit(status, body)) { unit =>
      new ClientOf(unit.address).start(7, "{}", uid, None)
    }

  "A hand-over" should "be taken when the unit answers any 2xx" in {
    Seq(200, 204).foreach { status =>
      withClue(s"$status: ") { answered(status) shouldBe Taken }
    }
  }

  it should "be refused, with the message the unit gives, when the unit answers 409" in {
    answered(409, """{"message": "Execution 345 was already started."}""") shouldBe
      Refused("Execution 345 was already started.")
  }

  it should "be refused, naming the status, when a 4xx gives no message to read" in {
    Seq(
      (401, "Credentials are required to access this resource."),
      (404, ""),
      (409, """{"message": "  "}"""),
      (409, """{"message": 7}"""),
      (409, """{"code": 409}"""),
      (409, "null")
    ).foreach {
      case (status, body) =>
        withClue(s"$status $body: ") {
          answered(status, body) shouldBe Refused(s"The computing unit answered $status.")
        }
    }
  }

  it should "be left unanswered when the unit answers anything else: it may have taken it" in {
    Seq(500, 503, 302).foreach { status =>
      withClue(s"$status: ") {
        answered(status, """{"message": "boom"}""") match {
          case Unanswered(cause) =>
            cause.getMessage shouldBe s"The computing unit answered $status."
          case other => fail(s"the hand-over came to $other")
        }
      }
    }
  }

  it should "be left unanswered when the unit does not answer by the deadline" in {
    Using.resource(new StubUnit(204, delay = 3.seconds)) { unit =>
      new ClientOf(unit.address, deadline = 300.millis).start(7, "{}", uid, None) match {
        case Unanswered(late) =>
          late shouldBe an[HttpTimeoutException]
          // Sent, and not a connection that was never made.
          late should not be an[HttpConnectTimeoutException]
          unit.requests should have size 1
        case other => fail(s"the hand-over came to $other")
      }
    }
  }

  it should "not have reached a unit nothing listens for: nothing was sent" in {
    val gone = Using.resource(new StubUnit(204))(_.address)

    new ClientOf(gone).start(7, "{}", uid, None) match {
      case Unreached(cause) => cause shouldBe a[ConnectException]
      case other            => fail(s"the hand-over came to $other")
    }
  }

  it should "not have reached a unit no address is recorded for, or whose address cannot be read" in {
    new HttpComputingUnitClient(_ => None).start(7, "{}", uid, None) match {
      case Unreached(cause) =>
        cause shouldBe a[NoSuchElementException]
        cause.getMessage shouldBe "No address is recorded for computing unit 7."
      case other => fail(s"the hand-over came to $other")
    }
    val databaseDown = new IllegalStateException("db down")
    new HttpComputingUnitClient(_ => throw databaseDown).update(7, "{}", uid) shouldBe
      Unreached(databaseDown)
  }
}
