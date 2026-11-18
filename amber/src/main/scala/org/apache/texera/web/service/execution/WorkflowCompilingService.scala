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
import com.google.protobuf.timestamp.Timestamp
import org.apache.texera.amber.core.workflow.WorkflowSettings
import org.apache.texera.amber.core.workflowruntimestate.{FatalErrorType, WorkflowFatalError}
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.web.service.execution.WorkflowCompilingService._

import java.io.IOException
import java.net.URI
import java.net.http.{HttpClient, HttpRequest, HttpResponse, HttpTimeoutException}
import java.nio.charset.StandardCharsets
import java.time.Duration
import scala.collection.immutable.ListMap
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.Try

object WorkflowCompilingService {

  /**
    * The plan of a run, as the compiling service is asked for it: what
    * [[org.apache.texera.common.compiler.PlanToRun.make]] takes.
    *
    * @param warehouse        None for the shared one
    * @param logicalPlan      the workflow to run, as the request to create the execution sent it
    * @param targetOperatorId None for the whole workflow
    */
  final case class PlanRequest(
      workflowId: Long,
      executionId: Long,
      warehouse: Option[String],
      settings: WorkflowSettings,
      logicalPlan: JsonNode,
      targetOperatorId: Option[String]
  )

  /**
    * The plan of a run, as the compiling service made it.
    *
    * @param plan        the plan, as the text `PhysicalPlanCodec` writes, before its files are
    *                    linked: each file names where it is kept. It holds the credentials an
    *                    operator is set up with: keep it out of logs.
    * @param logicalPlan the workflow the plan was compiled from, as JSON text
    */
  final case class MadePlan(plan: String, logicalPlan: String)

  /**
    * A physical operator the execution's plan runs for the operator that changes, as
    * [[org.apache.texera.common.compiler.UpdateToRun.RunningOperator]] has it.
    */
  final case class RunningOperator(layerName: String, pythonEnvironment: Option[String])

  /**
    * A change to a paused operator, as the compiling service is asked to make it to run: what
    * [[org.apache.texera.common.compiler.UpdateToRun.make]] takes.
    *
    * @param updateId    the id the change is stored under
    * @param logicalPlan the workflow the execution's plan was compiled from
    */
  final case class UpdateRequest(
      workflowId: Long,
      executionId: Long,
      updateId: String,
      logicalPlan: JsonNode,
      operator: JsonNode,
      running: Seq[RunningOperator]
  )

  /**
    * A change made to run, as the compiling service made it.
    *
    * @param update   the operator made to run, as the text `PhysicalPlanCodec` writes an update
    * @param operator the change as it was sent, as JSON text
    */
  final case class MadeUpdate(update: String, operator: String)

  /**
    * The compiling service refused the request: it answered `status`, with why.
    *
    * @param status         400 for a workflow or a change no plan can be made of, 404 for a
    *                       change to an operator the workflow does not have, 503 when too many
    *                       compiles wait, 504 when the compile passed the service's own deadline;
    *                       any other for a failure of the service
    * @param operatorErrors by the operator's id, in the order of
    *                       [[org.apache.texera.common.compiler.WorkflowCompilationFailed]]; empty
    *                       unless the workflow does not compile
    */
  final class CompileRefused(
      val status: Int,
      message: String,
      val operatorErrors: Map[String, WorkflowFatalError] = Map.empty
  ) extends RuntimeException(message)

  /**
    * The compiling service gave no answer.
    *
    * @param timedOut whether it was reached and did not answer by the deadline; false when it
    *                 could not be reached at all
    */
  final class CompileUnanswered(val timedOut: Boolean, message: String, cause: Throwable)
      extends RuntimeException(message, cause)

  /** How long the Dashboard waits for a connection to the compiling service. */
  val ConnectTimeout: FiniteDuration = 5.seconds

  /**
    * The compiling service of this deployment, at
    * `web-server.workflow-compiling-service-endpoint`.
    */
  lazy val forDeployment: WorkflowCompilingService =
    new WorkflowCompilingServiceClient(
      URI.create(ApplicationConfig.workflowCompilingServiceEndpoint)
    )
}

/**
  * The workflow compiling service, as the Dashboard service asks it for what a run needs
  * compiled. Each request is made for a user, with the user's own token, so the service resolves
  * what a workflow names as that user may read it.
  */
trait WorkflowCompilingService {

  /**
    * @param authorization the `Authorization` header of the user the plan is made for
    * @throws CompileRefused    if the service refuses
    * @throws CompileUnanswered if it cannot be reached, or does not answer by the deadline
    */
  def planToRun(request: PlanRequest, authorization: String, deadline: FiniteDuration): MadePlan

  /** As [[planToRun]], for a change to a paused operator. */
  def updateToRun(
      request: UpdateRequest,
      authorization: String,
      deadline: FiniteDuration
  ): MadeUpdate
}

/**
  * The compiling service at `endpoint`, asked over HTTP: `POST /api/compile/run` and
  * `POST /api/compile/update`.
  *
  * @param endpoint the service's address, up to its port
  */
class WorkflowCompilingServiceClient(
    endpoint: URI,
    connectTimeout: FiniteDuration = WorkflowCompilingService.ConnectTimeout
) extends WorkflowCompilingService {

  private val mapper = new ObjectMapper()
  private val http = HttpClient
    .newBuilder()
    .version(HttpClient.Version.HTTP_1_1)
    .connectTimeout(Duration.ofMillis(connectTimeout.toMillis))
    .build()

  override def planToRun(
      request: PlanRequest,
      authorization: String,
      deadline: FiniteDuration
  ): MadePlan = {
    val body = mapper.createObjectNode()
    body.put("workflowId", request.workflowId)
    body.put("executionId", request.executionId)
    request.warehouse.foreach(body.put("warehouse", _))
    body
      .putObject("settings")
      .put("dataTransferBatchSize", request.settings.dataTransferBatchSize)
      .put("executionMode", request.settings.executionMode.name())
    body.set[JsonNode]("logicalPlan", request.logicalPlan)
    request.targetOperatorId.foreach(body.put("targetOperatorId", _))
    val answer = post("/api/compile/run", body, authorization, deadline)
    MadePlan(textOf(answer, "plan"), textOf(answer, "logicalPlan"))
  }

  override def updateToRun(
      request: UpdateRequest,
      authorization: String,
      deadline: FiniteDuration
  ): MadeUpdate = {
    val body = mapper.createObjectNode()
    body.put("workflowId", request.workflowId)
    body.put("executionId", request.executionId)
    body.put("updateId", request.updateId)
    body.set[JsonNode]("logicalPlan", request.logicalPlan)
    body.set[JsonNode]("operator", request.operator)
    val running = body.putArray("running")
    request.running.foreach { op =>
      val layer = running.addObject().put("layerName", op.layerName)
      op.pythonEnvironment.foreach(layer.put("pythonEnvironment", _))
    }
    val answer = post("/api/compile/update", body, authorization, deadline)
    MadeUpdate(textOf(answer, "update"), textOf(answer, "operator"))
  }

  /**
    * The JSON the service answers a POST of `body` to `path` with, when it answers 200. Any
    * other status is a [[CompileRefused]], with the message the answer gives.
    */
  private def post(
      path: String,
      body: JsonNode,
      authorization: String,
      deadline: FiniteDuration
  ): JsonNode = {
    val request = HttpRequest
      .newBuilder(endpoint.resolve(path))
      .timeout(Duration.ofMillis(deadline.toMillis))
      .header("Content-Type", "application/json")
      .header("Accept", "application/json")
      .header("Authorization", Option(authorization).getOrElse(""))
      .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
      .build()
    val response =
      try http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
      catch {
        // A connection that is not made in time is a service that was not reached.
        case notConnected: java.net.http.HttpConnectTimeoutException =>
          throw unreached(notConnected)
        case late: HttpTimeoutException =>
          throw new CompileUnanswered(
            timedOut = true,
            s"The workflow compiling service did not answer within $deadline.",
            late
          )
        case failure: IOException => throw unreached(failure)
      }
    val answer = Try(mapper.readTree(response.body())).toOption.filter(_ != null)
    if (response.statusCode() == 200) {
      answer.filter(_.isObject).getOrElse {
        throw new IllegalStateException("The workflow compiling service answered no JSON object.")
      }
    } else {
      val message = answer
        .flatMap(json => Option(json.get("message")))
        .filter(_.isTextual)
        .map(_.asText())
        .getOrElse(s"The workflow compiling service answered ${response.statusCode()}.")
      val operatorErrors = answer
        .flatMap(json => Option(json.get("operatorErrors")))
        .filter(_.isObject)
        .map { errors =>
          // In the order the service wrote them: an operator before those downstream of it.
          ListMap.from(
            errors.fields().asScala.map(error => error.getKey -> errorOf(error.getValue))
          )
        }
        .getOrElse(Map.empty[String, WorkflowFatalError])
      throw new CompileRefused(response.statusCode(), message, operatorErrors)
    }
  }

  private def unreached(cause: Throwable): CompileUnanswered =
    new CompileUnanswered(
      timedOut = false,
      s"The workflow compiling service at $endpoint could not be reached.",
      cause
    )

  /** The text `answer` holds under `field`, which every answer of its kind has. */
  private def textOf(answer: JsonNode, field: String): String =
    Option(answer.get(field)).filter(_.isTextual).map(_.asText()).getOrElse {
      throw new IllegalStateException(s"The workflow compiling service's answer has no $field.")
    }

  /**
    * An operator's error, read as the compiling service writes one:
    * `{type: {name}, timestamp: {seconds, nanos}, message, details, operatorId, workerId}`.
    */
  private def errorOf(error: JsonNode): WorkflowFatalError =
    WorkflowFatalError(
      FatalErrorType
        .fromName(error.path("type").path("name").asText())
        .getOrElse(FatalErrorType.COMPILATION_ERROR),
      Timestamp(
        error.path("timestamp").path("seconds").asLong(),
        error.path("timestamp").path("nanos").asInt()
      ),
      error.path("message").asText(""),
      error.path("details").asText(""),
      error.path("operatorId").asText(""),
      error.path("workerId").asText("")
    )
}
