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
import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.web.resource.{EmailMessage, GmailResource}
import org.hibernate.validator.internal.constraintvalidators.hv.EmailValidator
import play.api.libs.json.{JsError, JsObject, JsSuccess, Json, OFormat}

import java.net.URI
import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}
import scala.util.Try

object WorkflowEmailNotifier {

  /**
    * Where the email about a run goes and what it names: the `notification` column of the
    * execution's row, written when the execution is made and read when it is closed.
    *
    * @param workflowName the workflow's name when the execution was made
    * @param workflowUrl  the workflow's page in the Dashboard (see [[workflowUrl]])
    */
  final case class Notification(email: String, workflowName: String, workflowUrl: String)

  object Notification {
    private val fields = Set("email", "workflowName", "workflowUrl")
    private val format: OFormat[Notification] = Json.format[Notification]

    /** `notification` as the row keeps it: `{"email", "workflowName", "workflowUrl"}`. */
    def toJson(notification: Notification): String =
      Json.stringify(format.writes(notification))

    /**
      * The notification a row keeps, read back.
      *
      * @throws IllegalArgumentException unless `json` holds exactly the three fields, each a string
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
    * How a run was first said to have ended, when an email corrects that: the Dashboard service
    * closed it by a verdict of its own, and its log showed later how it really ended.
    */
  final case class Corrected(outcome: Short, reason: Option[String])

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

  /** The word an email says an outcome with. */
  private def nameOf(outcome: Short): String =
    outcome match {
      case WorkflowExecutionStatus.Completed => "Completed"
      case WorkflowExecutionStatus.Failed    => "Failed"
      case WorkflowExecutionStatus.Killed    => "Killed"
      case other =>
        throw new IllegalArgumentException(
          s"A run ends completed, failed or killed, not as $other."
        )
    }
}

/**
  * Emails the user of a run how the run ended, as its execution's
  * [[WorkflowEmailNotifier.Notification]] says. It reads nothing to build an email.
  *
  * @param deliver sends a message to an address, and answers why when it could not
  */
class WorkflowEmailNotifier(
    deliver: (EmailMessage, String) => Either[String, Unit] = GmailResource.sendEmail
) extends LazyLogging {
  import WorkflowEmailNotifier.{Corrected, Notification, nameOf}

  private val emailValidator = new EmailValidator()

  /**
    * Sends the email that a run of workflow `workflowId` ended as `outcome`, a code of
    * [[WorkflowExecutionStatus.Ended]], for `reason`, at `endedAtMs`. With `corrects`, the
    * email says that an earlier one reported that ending, and that this is how the run really
    * ended. Nothing is sent to an address that is not one, which is logged.
    *
    * @throws IllegalArgumentException if `outcome` is not an ending
    * @throws IllegalStateException    if the email could not be sent
    */
  def send(
      notification: Notification,
      workflowId: Long,
      outcome: Short,
      reason: Option[String],
      endedAtMs: Long,
      corrects: Option[Corrected] = None
  ): Unit = {
    val message = EmailMessage(
      receiver = notification.email,
      subject = s"[Texera] Workflow ${notification.workflowName} ($workflowId): ${nameOf(outcome)}",
      content = contentOf(notification, workflowId, outcome, reason, endedAtMs, corrects)
    )
    if (!emailValidator.isValid(notification.email, null)) {
      logger.warn(s"Invalid email address: ${notification.email}")
    } else {
      deliver(message, notification.email).left.foreach { why =>
        throw new IllegalStateException(why)
      }
    }
  }

  private def contentOf(
      notification: Notification,
      workflowId: Long,
      outcome: Short,
      reason: Option[String],
      endedAtMs: Long,
      corrects: Option[Corrected]
  ): String = {
    val opening = corrects match {
      case None => "The run of the workflow with the following details has ended:"
      case Some(earlier) =>
        val said = nameOf(earlier.outcome).toLowerCase + earlier.reason.fold("")(why => s" ($why)")
        s"An earlier email said that this run of your workflow had $said. Its computing unit " +
          "could not be reached for a while, and the run went on. This is how it ended:"
    }
    val details = Seq(
      s"- Workflow ID: $workflowId",
      s"- Workflow Name: ${notification.workflowName}",
      s"- State: ${nameOf(outcome)}"
    ) ++ reason.map(why => s"- Reason: $why") :+
      s"- Timestamp: ${formatTimestamp(Instant.ofEpochMilli(endedAtMs))}"
    // Joined line by line: a reason is the run's own words, which no template may reshape.
    (Seq("Hello,", "", opening, "") ++ details ++ Seq(
      "",
      s"You can view more details by visiting: ${notification.workflowUrl}",
      "",
      "Regards,",
      "Texera Team"
    )).mkString("\n")
  }

  private def formatTimestamp(instant: Instant): String =
    DateTimeFormatter
      .ofPattern("MMMM d, yyyy, h:mm:ss a '(UTC)'")
      .withZone(ZoneOffset.UTC)
      .format(instant)
}
