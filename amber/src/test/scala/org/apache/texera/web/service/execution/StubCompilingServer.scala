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

import com.fasterxml.jackson.databind.JsonNode
import com.sun.net.httpserver.{HttpExchange, HttpServer}
import org.apache.texera.amber.core.workflow.{ExecutionMode, WorkflowSettings}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.web.service.execution.StubCompilingServer.{Answer, Request}
import org.apache.texera.web.service.execution.WorkflowCompilingService.{
  CompileRefused,
  PlanRequest,
  UpdateRequest
}

import java.net.{InetAddress, InetSocketAddress, URI}
import java.nio.charset.StandardCharsets
import java.util.concurrent.{ConcurrentLinkedQueue, Executors}
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters._

object StubCompilingServer {

  /** A request the server was sent: its path, its `Authorization` header and its JSON body. */
  final case class Request(path: String, authorization: String, body: JsonNode)

  /** What the server answers a request: a status, and a body. */
  final case class Answer(status: Int, body: String)

  /**
    * A server that answers as the workflow compiling service does: `POST /api/compile/run` and
    * `POST /api/compile/update`, compiled by `service` for the user the request's
    * `Authorization` header names, and a refusal as `{code, message}`, with `operatorErrors`
    * beside them for a workflow that does not compile.
    */
  def compiling(
      service: FixtureCompilingService = new FixtureCompilingService()
  ): StubCompilingServer =
    new StubCompilingServer(request =>
      try {
        val body = request.body
        def text(field: String): Option[String] = Option(body.get(field)).map(_.asText())
        val answer = objectMapper.createObjectNode()
        request.path match {
          case "/api/compile/run" =>
            val settings = body.get("settings")
            val plan = service.planToRun(
              PlanRequest(
                body.get("workflowId").asLong(),
                body.get("executionId").asLong(),
                text("warehouse"),
                WorkflowSettings(
                  settings.get("dataTransferBatchSize").asInt(),
                  ExecutionMode.valueOf(settings.get("executionMode").asText())
                ),
                body.get("logicalPlan"),
                text("targetOperatorId")
              ),
              request.authorization,
              1.minute
            )
            answer.put("plan", plan)
          case "/api/compile/update" =>
            val update = service.updateToRun(
              UpdateRequest(
                body.get("workflowId").asLong(),
                body.get("executionId").asLong(),
                body.get("logicalPlan"),
                body.get("operator")
              ),
              request.authorization,
              1.minute
            )
            answer.put("update", update)
          case other => throw new CompileRefused(404, s"HTTP 404 Not Found: $other")
        }
        Answer(200, objectMapper.writeValueAsString(answer))
      } catch {
        case refused: CompileRefused =>
          val refusal = objectMapper
            .createObjectNode()
            .put("code", refused.status)
            .put("message", refused.getMessage)
          if (refused.operatorErrors.nonEmpty) {
            val errors = refusal.putObject("operatorErrors")
            refused.operatorErrors.foreach {
              case (operator, error) =>
                errors.set[JsonNode](operator, objectMapper.valueToTree[JsonNode](error))
            }
          }
          Answer(refused.status, objectMapper.writeValueAsString(refusal))
      }
    )
}

/**
  * Stands in, in specs, for the workflow compiling service as it is reached over HTTP: a server
  * on the loopback interface that answers each request as `answer` says, and keeps what it was
  * sent.
  */
class StubCompilingServer(answer: Request => Answer) extends AutoCloseable {

  private val sent = new ConcurrentLinkedQueue[Request]()
  private val server =
    HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress, 0), 0)
  server.createContext("/", (exchange: HttpExchange) => serve(exchange))
  // Daemon threads, so that an answer a spec keeps waiting holds no JVM open.
  server.setExecutor(Executors.newCachedThreadPool { task =>
    val thread = new Thread(task, "stub-compiling-service")
    thread.setDaemon(true)
    thread
  })
  server.start()

  /** Where the server listens: the endpoint a client of the compiling service is given. */
  val endpoint: URI = URI.create(s"http://127.0.0.1:${server.getAddress.getPort}")

  /** The requests the server was sent, oldest first. */
  def requests: List[Request] = sent.asScala.toList

  override def close(): Unit = server.stop(0)

  private def serve(exchange: HttpExchange): Unit =
    try {
      val body = new String(exchange.getRequestBody.readAllBytes(), StandardCharsets.UTF_8)
      val request = Request(
        exchange.getRequestURI.getPath,
        exchange.getRequestHeaders.getFirst("Authorization"),
        objectMapper.readTree(body)
      )
      sent.add(request)
      val Answer(status, text) = answer(request)
      val bytes = text.getBytes(StandardCharsets.UTF_8)
      exchange.getResponseHeaders.set("Content-Type", "application/json")
      // A length of 0 would mean a body of no declared length, so an empty body has none.
      exchange.sendResponseHeaders(status, if (bytes.isEmpty) -1 else bytes.length.toLong)
      if (bytes.nonEmpty) exchange.getResponseBody.write(bytes)
    } catch {
      // The client stopped waiting.
      case _: java.io.IOException =>
    } finally exchange.close()
}
