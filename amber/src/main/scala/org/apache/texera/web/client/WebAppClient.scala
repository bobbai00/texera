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

package org.apache.texera.web.client

import com.fasterxml.jackson.annotation.JsonProperty
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.config.EnvironmentalVariable
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import java.io.IOException
import java.net.URI
import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/**
  * HTTP client CU Master uses to delegate DB writes to texera-web-application.
  * Forwards the originating user's JWT so the target endpoint authorizes the
  * call against the same user the request was initiated for.
  */
object WebAppClient extends LazyLogging {

  private val MaxAttempts = 3
  private val InitialBackoffMillis = 200L

  private lazy val baseUrl: String =
    EnvironmentalVariable
      .get(EnvironmentalVariable.ENV_TEXERA_DASHBOARD_SERVICE_ENDPOINT)
      .getOrElse("http://localhost:8080")
      .stripSuffix("/")

  private lazy val httpClient: HttpClient =
    HttpClient
      .newBuilder()
      .connectTimeout(Duration.ofSeconds(10))
      .build()

  /**
    * Allocates a new workflow_executions row via web-app and returns its eid.
    */
  def createExecution(
      jwt: String,
      workflowId: WorkflowIdentity,
      executionName: String,
      engineVersion: String,
      computingUnitId: Integer
  ): ExecutionIdentity = {
    val body = CreateExecutionRequestBody(
      workflowId = workflowId.id,
      executionName = executionName,
      engineVersion = engineVersion,
      computingUnitId = computingUnitId
    )
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/create"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Content-Type", "application/json")
      .header("Accept", "application/json")
      .POST(
        HttpRequest.BodyPublishers
          .ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)
      )
      .build()
    val responseBody = sendWithRetry(request)
    val parsed = objectMapper.readValue(responseBody, classOf[CreateExecutionResponseBody])
    ExecutionIdentity(parsed.eid)
  }

  /**
    * Reads a workflow_executions row from web-app, returning None if not found.
    */
  def getExecution(
      jwt: String,
      eid: ExecutionIdentity
  ): Option[GetExecutionResponseBody] = {
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/by_eid/${eid.id}"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Accept", "application/json")
      .GET()
      .build()
    var lastError: Throwable = null
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        response.statusCode() match {
          case 200 =>
            return Some(
              objectMapper.readValue(response.body(), classOf[GetExecutionResponseBody])
            )
          case 404 => return None
          case status if status >= 400 && status < 500 =>
            throw new RuntimeException(
              s"Web-app rejected GET ${request.uri()} ($status): ${response.body()}"
            )
          case status =>
            lastError = new RuntimeException(
              s"Web-app returned $status from ${request.uri()}: ${response.body()}"
            )
        }
      } catch {
        case e: IOException => lastError = e
        case e: InterruptedException =>
          Thread.currentThread().interrupt()
          throw e
      }
      if (attempt < MaxAttempts) {
        Thread.sleep(InitialBackoffMillis * (1L << (attempt - 1)))
      }
      attempt += 1
    }
    throw new RuntimeException(
      s"GET ${request.uri()} failed after $MaxAttempts attempts",
      lastError
    )
  }

  /**
    * Records the byte size of an operator port's result document.
    */
  def updateOperatorPortResultSize(
      jwt: String,
      eid: ExecutionIdentity,
      globalPortId: String,
      size: Long
  ): Unit = {
    val body = UpdateOperatorPortResultSizeRequestBody(globalPortId, size)
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/${eid.id}/operator-port-result-size"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Content-Type", "application/json")
      .POST(
        HttpRequest.BodyPublishers
          .ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)
      )
      .build()
    sendWithRetry(request)
  }

  /**
    * Triggers web-app to recompute the runtime-stats document size for an
    * execution. Web-app reads the URI, opens the Iceberg document, and writes
    * the new size; no payload from the caller.
    */
  def recomputeRuntimeStatsSize(jwt: String, eid: ExecutionIdentity): Unit = {
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/${eid.id}/runtime-stats-size"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .POST(HttpRequest.BodyPublishers.noBody())
      .build()
    sendWithRetry(request)
  }

  /**
    * Triggers web-app to recompute the console-message document size for an
    * operator within an execution.
    */
  def recomputeConsoleMessageSize(
      jwt: String,
      eid: ExecutionIdentity,
      operatorId: String
  ): Unit = {
    val body = RecomputeConsoleMessageSizeRequestBody(operatorId)
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/${eid.id}/operator-console-size"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Content-Type", "application/json")
      .POST(
        HttpRequest.BodyPublishers
          .ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)
      )
      .build()
    sendWithRetry(request)
  }

  /**
    * Applies a partial update to a workflow_executions row. Only non-None
    * fields are sent; the server applies them and ignores absent ones.
    */
  def updateExecution(
      jwt: String,
      eid: ExecutionIdentity,
      status: Option[Short] = None,
      lastUpdateTime: Option[Long] = None,
      logLocation: Option[String] = None,
      runtimeStatsUri: Option[String] = None,
      runtimeStatsSize: Option[Int] = None,
      result: Option[String] = None
  ): Unit = {
    val body = UpdateExecutionRequestBody(
      status = status,
      lastUpdateTime = lastUpdateTime,
      logLocation = logLocation,
      runtimeStatsUri = runtimeStatsUri,
      runtimeStatsSize = runtimeStatsSize,
      result = result
    )
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/${eid.id}/update"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Content-Type", "application/json")
      .POST(
        HttpRequest.BodyPublishers
          .ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)
      )
      .build()
    sendWithRetry(request)
  }

  private def sendWithRetry(request: HttpRequest): String = {
    var lastError: Throwable = null
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        val status = response.statusCode()
        if (status >= 200 && status < 300) return response.body()
        if (status >= 400 && status < 500) {
          throw new RuntimeException(
            s"Web-app rejected request to ${request.uri()} ($status): ${response.body()}"
          )
        }
        lastError = new RuntimeException(
          s"Web-app returned $status from ${request.uri()}: ${response.body()}"
        )
      } catch {
        case e: IOException => lastError = e
        case e: InterruptedException =>
          Thread.currentThread().interrupt()
          throw e
      }
      if (attempt < MaxAttempts) {
        Thread.sleep(InitialBackoffMillis * (1L << (attempt - 1)))
      }
      attempt += 1
    }
    throw new RuntimeException(
      s"Web-app call to ${request.uri()} failed after $MaxAttempts attempts",
      lastError
    )
  }

  /**
    * Per-execution JWT registry. Engine-internal code (e.g. region coordinators)
    * typically has eid in scope but no service-level reference to the JWT;
    * looking it up here decouples those layers from auth plumbing.
    * WorkflowService stores at execution start and clears at lifecycle end.
    */
  private val jwtsByEid = new ConcurrentHashMap[Long, String]()

  def storeJwt(eid: ExecutionIdentity, jwt: String): Unit =
    jwtsByEid.put(eid.id, jwt)

  def removeJwt(eid: ExecutionIdentity): Unit =
    jwtsByEid.remove(eid.id)

  /**
    * Returns the registered JWT for an execution, or None if not registered
    * (e.g. tests that run engine code without a real WebSocket session).
    * Engine-internal callers that hit web-app should silently skip when None.
    */
  def jwtFor(eid: ExecutionIdentity): Option[String] =
    Option(jwtsByEid.get(eid.id))

  /**
    * Inserts a row into operator_port_executions linking an output port to its
    * Iceberg result document URI.
    */
  def insertOperatorPortResultUri(
      jwt: String,
      eid: ExecutionIdentity,
      globalPortId: String,
      uri: URI
  ): Unit = {
    val body = OperatorPortResultUriBody(globalPortId, uri.toString)
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/by_eid/${eid.id}/operator-port-result-uri"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Content-Type", "application/json")
      .POST(
        HttpRequest.BodyPublishers
          .ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)
      )
      .build()
    sendWithRetry(request)
  }

  /**
    * Inserts a row into operator_executions linking an operator to its
    * Iceberg console-messages document URI.
    */
  def insertOperatorConsoleUri(
      jwt: String,
      eid: ExecutionIdentity,
      operatorId: String,
      uri: URI
  ): Unit = {
    val body = OperatorConsoleUriBody(operatorId, uri.toString)
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/by_eid/${eid.id}/operator-console-uri"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Content-Type", "application/json")
      .POST(
        HttpRequest.BodyPublishers
          .ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)
      )
      .build()
    sendWithRetry(request)
  }

  /**
    * Returns all URIs CU Master needs for a single execution: per-port result
    * URIs, per-operator console URIs, and the runtime stats URI.
    */
  def getExecutionUris(
      jwt: String,
      eid: ExecutionIdentity
  ): ExecutionUrisBody = {
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/by_eid/${eid.id}/uris"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Accept", "application/json")
      .GET()
      .build()
    val responseBody = sendWithRetry(request)
    objectMapper.readValue(responseBody, classOf[ExecutionUrisBody])
  }

  /**
    * Looks up the result URI of a specific output port within an execution.
    */
  def getOperatorPortResultUri(
      jwt: String,
      eid: ExecutionIdentity,
      logicalOpId: String,
      portId: Int,
      portInternal: Boolean
  ): Option[URI] = {
    val query =
      s"logicalOpId=${URI.create(logicalOpId).toASCIIString}&portId=$portId&portInternal=$portInternal"
    val request = HttpRequest
      .newBuilder()
      .uri(
        URI.create(
          s"$baseUrl/api/executions/by_eid/${eid.id}/operator-port-result-uri?$query"
        )
      )
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Accept", "application/json")
      .GET()
      .build()
    val responseBody = sendWithRetry(request)
    objectMapper
      .readValue(responseBody, classOf[OptionalUriBody])
      .uri
      .map(URI.create)
  }

  /**
    * Looks up the console-messages URI for a specific operator in an execution.
    */
  def getOperatorConsoleUri(
      jwt: String,
      eid: ExecutionIdentity,
      operatorId: String
  ): Option[URI] = {
    val query = s"operatorId=$operatorId"
    val request = HttpRequest
      .newBuilder()
      .uri(
        URI.create(
          s"$baseUrl/api/executions/by_eid/${eid.id}/operator-console-uri?$query"
        )
      )
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Accept", "application/json")
      .GET()
      .build()
    val responseBody = sendWithRetry(request)
    objectMapper
      .readValue(responseBody, classOf[OptionalUriBody])
      .uri
      .map(URI.create)
  }

  /**
    * Returns the most recent execution id for (workflowId, computingUnitId).
    */
  def getLatestExecutionId(
      jwt: String,
      workflowId: WorkflowIdentity,
      computingUnitId: Int
  ): Option[ExecutionIdentity] = {
    val request = HttpRequest
      .newBuilder()
      .uri(
        URI.create(
          s"$baseUrl/api/executions/latest-eid?wid=${workflowId.id}&cuid=$computingUnitId"
        )
      )
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .header("Accept", "application/json")
      .GET()
      .build()
    val responseBody = sendWithRetry(request)
    objectMapper
      .readValue(responseBody, classOf[OptionalEidBody])
      .eid
      .map(ExecutionIdentity.apply)
  }

  /**
    * Removes operator_port_executions and operator_executions rows for an
    * execution. Called by clearExecutionResources before re-running a workflow.
    */
  def clearOperatorUris(jwt: String, eid: ExecutionIdentity): Unit = {
    val request = HttpRequest
      .newBuilder()
      .uri(URI.create(s"$baseUrl/api/executions/by_eid/${eid.id}/uris/clear"))
      .timeout(Duration.ofSeconds(30))
      .header("Authorization", s"Bearer $jwt")
      .POST(HttpRequest.BodyPublishers.noBody())
      .build()
    sendWithRetry(request)
  }

  private case class CreateExecutionRequestBody(
      @JsonProperty("workflowId") workflowId: Long,
      @JsonProperty("executionName") executionName: String,
      @JsonProperty("engineVersion") engineVersion: String,
      @JsonProperty("computingUnitId") computingUnitId: Integer
  )

  private case class CreateExecutionResponseBody(@JsonProperty("eid") eid: Long)

  case class GetExecutionResponseBody(
      @JsonProperty("eid") eid: Long,
      @JsonProperty("status") status: Option[Short],
      @JsonProperty("lastUpdateTime") lastUpdateTime: Option[Long],
      @JsonProperty("logLocation") logLocation: Option[String],
      @JsonProperty("runtimeStatsUri") runtimeStatsUri: Option[String]
  )

  private case class UpdateOperatorPortResultSizeRequestBody(
      @JsonProperty("globalPortId") globalPortId: String,
      @JsonProperty("size") size: Long
  )

  private case class RecomputeConsoleMessageSizeRequestBody(
      @JsonProperty("operatorId") operatorId: String
  )

  private case class OperatorPortResultUriBody(
      @JsonProperty("globalPortId") globalPortId: String,
      @JsonProperty("uri") uri: String
  )

  private case class OperatorConsoleUriBody(
      @JsonProperty("operatorId") operatorId: String,
      @JsonProperty("uri") uri: String
  )

  case class ExecutionUrisBody(
      @JsonProperty("resultUris") resultUris: List[String],
      @JsonProperty("consoleMessageUris") consoleMessageUris: List[String],
      @JsonProperty("runtimeStatsUri") runtimeStatsUri: Option[String]
  )

  private case class OptionalUriBody(@JsonProperty("uri") uri: Option[String])

  private case class OptionalEidBody(@JsonProperty("eid") eid: Option[Long])

  private case class UpdateExecutionRequestBody(
      @JsonProperty("status") status: Option[Short],
      @JsonProperty("lastUpdateTime") lastUpdateTime: Option[Long],
      @JsonProperty("logLocation") logLocation: Option[String],
      @JsonProperty("runtimeStatsUri") runtimeStatsUri: Option[String],
      @JsonProperty("runtimeStatsSize") runtimeStatsSize: Option[Int],
      @JsonProperty("result") result: Option[String]
  )
}
