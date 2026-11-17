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

package org.apache.texera.web.service

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.web.resource.{EmailMessage, GmailResource}
import org.hibernate.validator.internal.constraintvalidators.hv.EmailValidator
import play.api.libs.json.{JsError, JsObject, JsSuccess, Json, OFormat}

import java.net.URI
import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}
import scala.util.Try

object WorkflowEmailNotifier {

  /**
    * Where a run's status emails go and what they name: the `notification` column of its
    * execution's plan row, written when the execution is made and read when it starts.
    *
    * @param email        the address the emails go to
    * @param workflowName the workflow's name when the execution was made
    * @param workflowUrl  the workflow's page in the Dashboard (see [[workflowUrl]])
    */
  final case class Notification(email: String, workflowName: String, workflowUrl: String)

  object Notification {
    private val fields = Set("email", "workflowName", "workflowUrl")
    private val format: OFormat[Notification] = Json.format[Notification]

    /** `notification` as the plan row keeps it: `{"email", "workflowName", "workflowUrl"}`. */
    def toJson(notification: Notification): String =
      Json.stringify(format.writes(notification))

    /**
      * The notification a plan row keeps, read back.
      *
      * @throws IllegalArgumentException unless `json` is an object of exactly the three fields,
      *                                  each a string
      */
    def fromJson(json: String): Notification = {
      def refuse(why: String): Nothing =
        throw new IllegalArgumentException(
          s"The execution's notification is not {email, workflowName, workflowUrl}: $why."
        )
      Try(Json.parse(json)).toOption match {
        case Some(obj: JsObject) =>
          val unknown = obj.keys.diff(fields)
          if (unknown.nonEmpty) refuse(s"it has ${unknown.toSeq.sorted.mkString(", ")}")
          format.reads(obj) match {
            case JsSuccess(notification, _) => notification
            case JsError(errors) =>
              val fields = errors.map(_._1.toString.stripPrefix("/")).sorted.mkString(", ")
              refuse(s"$fields missing or not a string")
          }
        case Some(_) => refuse("it is not an object")
        case None    => refuse("it is not JSON")
      }
    }
  }

  /**
    * The page of workflow `workflowId` in the Dashboard, on the host and port of `requestUri`, the
    * URI the request that created the run's execution was sent to. Always `http`, and without the
    * port when that is 80, 443 or none.
    */
  def workflowUrl(requestUri: URI, workflowId: Long): String = {
    val host = requestUri.getHost
    val port = requestUri.getPort
    val path = s"/user/workspace/$workflowId"
    if (port == -1 || port == 80 || port == 443) {
      s"http://$host$path"
    } else {
      s"http://$host:$port$path"
    }
  }
}

/**
  * Emails a run's user when the run ends or pauses, as `notification` says: to its address, naming
  * the workflow by its name and linking to its page. It reads nothing to build an email.
  */
class WorkflowEmailNotifier(
    workflowId: Long,
    notification: WorkflowEmailNotifier.Notification
) extends EmailNotifier
    with LazyLogging {
  private val userEmail = notification.email
  private val workflowName = notification.workflowName
  private val emailValidator = new EmailValidator()

  private val TerminalStates: Set[WorkflowAggregatedState] = Set(
    COMPLETED,
    PAUSED,
    FAILED,
    KILLED
  )

  override def shouldSendEmail(workflowState: WorkflowAggregatedState): Boolean =
    TerminalStates.contains(workflowState)

  override def sendStatusEmail(state: WorkflowAggregatedState): Unit = {
    if (!isValidEmail(userEmail)) {
      logger.warn(s"Invalid email address: $userEmail")
      return
    }

    val emailMessage = createEmailMessage(state)

    try {
      GmailResource.sendEmail(emailMessage, userEmail)
    } catch {
      case e: Exception => println(s"Failed to send email: ${e.getMessage}")
    }
  }

  private def isValidEmail(email: String): Boolean = emailValidator.isValid(email, null)

  private def createEmailMessage(state: WorkflowAggregatedState): EmailMessage = {
    EmailMessage(
      receiver = userEmail,
      subject = createEmailSubject(state),
      content = createEmailContent(state)
    )
  }

  private def createEmailSubject(state: WorkflowAggregatedState): String =
    s"[Texera] Workflow $workflowName ($workflowId) Status: $state"

  private def createEmailContent(state: WorkflowAggregatedState): String = {
    val timestamp = formatTimestamp(Instant.now())

    s"""
       |Hello,
       |
       |The workflow with the following details has changed its state:
       |
       |- Workflow ID: $workflowId
       |- Workflow Name: $workflowName
       |- State: $state
       |- Timestamp: $timestamp
       |
       |You can view more details by visiting: ${notification.workflowUrl}
       |
       |Regards,
       |Texera Team
    """.stripMargin.trim
  }

  private def formatTimestamp(instant: Instant): String =
    DateTimeFormatter
      .ofPattern("MMMM d, yyyy, h:mm:ss a '(UTC)'")
      .withZone(ZoneOffset.UTC)
      .format(instant)
}
