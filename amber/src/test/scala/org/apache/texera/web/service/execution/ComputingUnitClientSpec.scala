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
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.{UserRoleEnum, WorkflowComputingUnitTypeEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{UserDao, WorkflowComputingUnitDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{User, WorkflowComputingUnit}
import org.apache.texera.web.service.execution.ComputingUnitClient.{
  Handover,
  Refused,
  Taken,
  Unanswered,
  Unreached
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.http.{HttpConnectTimeoutException, HttpTimeoutException}
import java.net.{ConnectException, InetAddress, InetSocketAddress, URI}
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import java.util.concurrent.{ConcurrentLinkedQueue, Executors}
import scala.concurrent.duration.{Duration, DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * How the Dashboard service reaches a computing unit ([[ComputingUnitClient]]): where it finds
  * one, what it sends it over HTTP ([[HttpComputingUnitClient]]), and what it makes of each way
  * a unit answers or does not. The unit is a server on the loopback interface that answers as
  * a case says; the rows of the units whose addresses are read are in `MockTexeraDB`.
  */
class ComputingUnitClientSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val mapper = new ObjectMapper()

  private val ownerUid = 9771
  private val clusterCuid = 9772
  private val localCuid = 9773
  private val unrecordedCuid = 9774
  private val unknownCuid = 9779
  private val clusterAddress = "computing-unit-9772.unit-svc.unit-pool.svc.cluster.local:8085"

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val cfg = getDSLContext.configuration()
    val owner = new User
    owner.setUid(ownerUid)
    owner.setName(s"unit-client-spec-user-$ownerUid")
    owner.setEmail(s"unit-client-spec-$ownerUid@example.com")
    owner.setRole(UserRoleEnum.REGULAR)
    new UserDao(cfg).insert(owner)
    Seq(
      (clusterCuid, WorkflowComputingUnitTypeEnum.kubernetes, clusterAddress),
      // As the editor records a local unit: where a browser opens its websocket.
      (localCuid, WorkflowComputingUnitTypeEnum.local, "http://localhost:8080/wsapi"),
      // As the unit manager leaves a unit it has not addressed yet.
      (unrecordedCuid, WorkflowComputingUnitTypeEnum.kubernetes, "")
    ).foreach {
      case (cuid, unitType, uri) =>
        val unit = new WorkflowComputingUnit
        unit.setCuid(cuid)
        unit.setUid(ownerUid)
        unit.setName(s"unit-client-spec-unit-$cuid")
        unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
        unit.setType(unitType)
        unit.setUri(uri)
        unit.setResource("{}")
        new WorkflowComputingUnitDao(cfg).insert(unit)
    }
  }

  override protected def afterAll(): Unit =
    try closeConnectionPool()
    finally super.afterAll()

  /** A request a unit was sent. */
  private case class Sent(
      method: String,
      path: String,
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

  private val authorization = "Bearer the-users-own-token"

  // --- what it sends ---

  "HttpComputingUnitClient.start" should
    "post the plan to the unit's start route, as the user, and take a 204 as the plan taken" in {
    val plan = """{"formatVersion": 1, "executionId": {"id": "345"}, "operators": []}"""
    Using.resource(new StubUnit(204)) { unit =>
      val client = new ClientOf(unit.address)

      client.start(7, plan, authorization) shouldBe Taken

      // The unit asked is the one found at the address of the unit the plan is for.
      client.lookedUp.toList shouldBe List(7)
      unit.requests.map(sent =>
        (sent.method, sent.path, sent.authorization, sent.contentType)
      ) shouldBe List(("POST", "/api/execution/start", authorization, "application/json"))
      // The plan as one JSON string, and the unit it is for, as the route reads them.
      val body = unit.requests.head.body
      body.fieldNames().asScala.toSet shouldBe Set("plan", "computingUnitId")
      body.get("plan").asText() shouldBe plan
      body.get("computingUnitId").asInt() shouldBe 7
    }
  }

  "HttpComputingUnitClient.update" should
    "post the change to the unit's update route, as the user, and take a 204 as the change taken" in {
    val change = """{"formatVersion": 1, "executionId": {"id": "345"}, "opId": "limit"}"""
    Using.resource(new StubUnit(204)) { unit =>
      val client = new ClientOf(unit.address)

      client.update(7, change, authorization) shouldBe Taken

      client.lookedUp.toList shouldBe List(7)
      unit.requests.map(sent =>
        (sent.method, sent.path, sent.authorization, sent.contentType)
      ) shouldBe List(("POST", "/api/execution/update", authorization, "application/json"))
      val body = unit.requests.head.body
      body.fieldNames().asScala.toSet shouldBe Set("update")
      body.get("update").asText() shouldBe change
    }
  }

  // --- what it makes of the unit's answer ---

  /** What a hand-over to a unit that answers `status` with `body` comes to. */
  private def answered(status: Int, body: String = ""): Handover =
    Using.resource(new StubUnit(status, body)) { unit =>
      new ClientOf(unit.address).start(7, "{}", authorization)
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
      new ClientOf(unit.address, deadline = 300.millis).start(7, "{}", authorization) match {
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

    new ClientOf(gone).start(7, "{}", authorization) match {
      case Unreached(cause) => cause shouldBe a[ConnectException]
      case other            => fail(s"the hand-over came to $other")
    }
  }

  it should "not have reached a unit no address is recorded for, or whose address cannot be read" in {
    new HttpComputingUnitClient(_ => None).start(7, "{}", authorization) match {
      case Unreached(cause) =>
        cause shouldBe a[NoSuchElementException]
        cause.getMessage shouldBe "No address is recorded for computing unit 7."
      case other => fail(s"the hand-over came to $other")
    }
    val databaseDown = new IllegalStateException("db down")
    new HttpComputingUnitClient(_ => throw databaseDown).update(7, "{}", authorization) shouldBe
      Unreached(databaseDown)
  }

  // --- where a unit is ---

  "ComputingUnitClient.address" should
    "be the address a unit Kubernetes runs records, over HTTP unless it names a scheme" in {
    val configured = "http://workflow-runtime-coordinator-service:8085"
    def addressOf(recorded: String): Option[URI] =
      ComputingUnitClient.address(WorkflowComputingUnitTypeEnum.kubernetes, recorded, configured)

    addressOf(clusterAddress) shouldBe Some(new URI(s"http://$clusterAddress"))
    addressOf(s"  $clusterAddress\n") shouldBe Some(new URI(s"http://$clusterAddress"))
    addressOf("https://units.example:8443") shouldBe Some(new URI("https://units.example:8443"))
    // The routes resolve against it.
    addressOf(clusterAddress).map(_.resolve("/api/execution/start")) shouldBe
      Some(new URI(s"http://$clusterAddress/api/execution/start"))
  }

  it should "be none for a unit Kubernetes runs that records no address" in {
    Seq("", "   ", null).foreach { recorded =>
      withClue(s"'$recorded': ") {
        ComputingUnitClient.address(
          WorkflowComputingUnitTypeEnum.kubernetes,
          recorded,
          "http://workflow-runtime-coordinator-service:8085"
        ) shouldBe None
      }
    }
  }

  it should "be the deployment's one unit for a local unit, whatever it records" in {
    val configured = "http://workflow-runtime-coordinator-service:8085"
    // A local unit records where a browser reaches it, which says nothing to a service.
    Seq("http://localhost:8080/wsapi", "local://test", "", null).foreach { recorded =>
      withClue(s"$recorded: ") {
        ComputingUnitClient.address(
          WorkflowComputingUnitTypeEnum.local,
          recorded,
          configured
        ) shouldBe Some(new URI(configured))
      }
    }
  }

  "ComputingUnitClient.addressOf" should
    "read a unit's address off its record, and find none where the record gives none or there is no record" in {
    val configured = new URI(ApplicationConfig.computingUnitEndpoint)

    ComputingUnitClient.addressOf(clusterCuid) shouldBe Some(new URI(s"http://$clusterAddress"))
    ComputingUnitClient.addressOf(localCuid) shouldBe Some(configured)
    ComputingUnitClient.addressOf(unrecordedCuid) shouldBe None
    ComputingUnitClient.addressOf(unknownCuid) shouldBe None
  }
}
