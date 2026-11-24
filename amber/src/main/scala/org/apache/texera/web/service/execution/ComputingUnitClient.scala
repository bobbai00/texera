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

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.WORKFLOW_COMPUTING_UNIT
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTypeEnum
import org.apache.texera.web.service.execution.ComputingUnitClient._

import java.io.IOException
import java.net.http.{
  HttpClient,
  HttpConnectTimeoutException,
  HttpRequest,
  HttpResponse,
  HttpTimeoutException
}
import java.net.{ConnectException, URI}
import java.nio.charset.StandardCharsets
import java.time.Duration
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.util.Try
import scala.util.control.NonFatal

object ComputingUnitClient {

  /** What became of something the Dashboard service handed a computing unit. */
  sealed trait Handover

  /** The unit took it. */
  case object Taken extends Handover

  /** The unit answered that it does not take it, and why. */
  final case class Refused(why: String) extends Handover

  /** Nothing reached the unit: it has not got it. */
  final case class Unreached(cause: Throwable) extends Handover

  /** It was sent, and the unit did not say what became of it: it may have taken it. */
  final case class Unanswered(cause: Throwable) extends Handover

  /** How long the Dashboard service waits for a connection to a computing unit. */
  val ConnectTimeout: FiniteDuration = 5.seconds

  /**
    * How long a computing unit may take to answer what it is handed: a start answers once the
    * run is set up, which shuts down the engine of the run it replaces.
    */
  val Deadline: FiniteDuration = 30.seconds

  /** The computing units of this deployment, each at the address its record gives. */
  lazy val forDeployment: ComputingUnitClient = new HttpComputingUnitClient(addressOf)

  /**
    * Where the Dashboard service reaches computing unit `cuid`: None for a unit there is no
    * record of, and for one whose record gives no address.
    */
  def addressOf(cuid: Int): Option[URI] =
    Option(
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(WORKFLOW_COMPUTING_UNIT.TYPE, WORKFLOW_COMPUTING_UNIT.URI)
        .from(WORKFLOW_COMPUTING_UNIT)
        .where(WORKFLOW_COMPUTING_UNIT.CUID.eq(Integer.valueOf(cuid)))
        .fetchOne()
    ).flatMap(unit =>
      address(unit.value1(), unit.value2(), ApplicationConfig.computingUnitEndpoint)
    )

  /**
    * Where a computing unit of `unitType` is reached. A unit Kubernetes runs records the address
    * of its pod inside the cluster, which is where the gateway routes its websocket too: one
    * that records none is reached nowhere. A local unit records the address a browser reaches
    * it at, which says nothing to a service: it is the one unit of its deployment, at
    * `configured` (`web-server.computing-unit-endpoint`).
    */
  def address(
      unitType: WorkflowComputingUnitTypeEnum,
      recorded: String,
      configured: String
  ): Option[URI] =
    if (unitType == WorkflowComputingUnitTypeEnum.kubernetes) {
      Option(recorded)
        .map(_.trim)
        .filter(_.nonEmpty)
        .map(uri => new URI(if (uri.contains("://")) uri else s"http://$uri"))
    } else Some(new URI(configured))
}

/**
  * The computing units, as the Dashboard service hands them what it made for them: the plan of
  * an execution, which the unit starts, and a change to an operator of a paused one. Nothing a
  * client sends reaches a unit this way, and no client carries a plan or a change.
  */
trait ComputingUnitClient {

  /**
    * Hands `plan`, the plan of an execution created for computing unit `cuid`, to that unit,
    * which starts the execution it names.
    *
    * @param authorization the `Authorization` header of the user the execution is created for
    */
  def start(cuid: Int, plan: String, authorization: String): Handover

  /**
    * Hands `update`, a change to an operator of a paused execution, to computing unit `cuid`,
    * which runs it.
    *
    * @param authorization the `Authorization` header of the user who asks for the change
    */
  def update(cuid: Int, update: String, authorization: String): Handover
}

/**
  * Computing units over HTTP: `POST /api/execution/start` and `POST /api/execution/update`
  * on the unit (`org.apache.texera.web.resource.ExecutionHandoverResource`).
  *
  * @param addressOf where a computing unit is reached; None for a unit there is no record of
  * @param deadline  how long a unit may take to answer
  */
class HttpComputingUnitClient(
    addressOf: Int => Option[URI],
    connectTimeout: FiniteDuration = ConnectTimeout,
    deadline: FiniteDuration = Deadline
) extends ComputingUnitClient {

  private val mapper = new ObjectMapper()
  private val http = HttpClient
    .newBuilder()
    .version(HttpClient.Version.HTTP_1_1)
    .connectTimeout(Duration.ofMillis(connectTimeout.toMillis))
    .build()

  override def start(cuid: Int, plan: String, authorization: String): Handover =
    post(
      cuid,
      "/api/execution/start",
      mapper.createObjectNode().put("plan", plan).put("computingUnitId", cuid),
      authorization
    )

  override def update(cuid: Int, update: String, authorization: String): Handover =
    post(
      cuid,
      "/api/execution/update",
      mapper.createObjectNode().put("update", update),
      authorization
    )

  /**
    * What became of `body`, posted to `path` on computing unit `cuid`. A unit that answers 2xx
    * took it; one that answers 4xx refused it, with the message its answer gives. Any other
    * answer, and none by the deadline, leave open whether the unit took it.
    */
  private def post(cuid: Int, path: String, body: ObjectNode, authorization: String): Handover =
    Try(addressOf(cuid)).toEither match {
      case Left(failure) => Unreached(failure)
      case Right(None) =>
        Unreached(new NoSuchElementException(s"No address is recorded for computing unit $cuid."))
      case Right(Some(address)) =>
        try {
          val request = HttpRequest
            .newBuilder(address.resolve(path))
            .timeout(Duration.ofMillis(deadline.toMillis))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Authorization", Option(authorization).getOrElse(""))
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
            .build()
          val response =
            http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
          response.statusCode() / 100 match {
            case 2 => Taken
            case 4 =>
              Refused(
                Try(mapper.readTree(response.body())).toOption
                  .flatMap(Option(_))
                  .flatMap(json => Option(json.get("message")))
                  .filter(_.isTextual)
                  .map(_.asText())
                  .filterNot(_.isBlank)
                  .getOrElse(s"The computing unit answered ${response.statusCode()}.")
              )
            case _ =>
              Unanswered(new IOException(s"The computing unit answered ${response.statusCode()}."))
          }
        } catch {
          // A connection that is not made, in time or at all, sent nothing.
          case notConnected: HttpConnectTimeoutException => Unreached(notConnected)
          case notConnected: ConnectException            => Unreached(notConnected)
          case late: HttpTimeoutException                => Unanswered(late)
          case failure: IOException                      => Unanswered(failure)
          case interrupted: InterruptedException =>
            Thread.currentThread().interrupt()
            Unanswered(interrupted)
          case NonFatal(failure) => Unreached(failure)
        }
    }
}
