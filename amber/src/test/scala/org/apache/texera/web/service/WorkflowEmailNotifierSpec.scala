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

import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.web.resource.EmailMessage
import org.apache.texera.web.service.WorkflowEmailNotifier.{Corrected, Notification}
import org.scalatest.flatspec.AnyFlatSpec

import java.net.URI
import java.time.Instant
import java.util.{Locale, TimeZone, UUID}
import scala.collection.mutable

/**
  * Covers what [[WorkflowEmailNotifier]] sends about a run that ended, and the notification an
  * execution's row keeps. Concretely, these tests fail if:
  *   - the subject or content stop naming the workflow by the name in the notification, or stop
  *     linking to the page in it (the name carries a random suffix, so a hard-coded value cannot
  *     satisfy the assertions);
  *   - the email stops saying how the run ended, why, or when it ended, in UTC whatever the
  *     JVM's zone is (the default zone is set to a non-UTC one around the assertion, and the
  *     locale to US so the month's name is stable);
  *   - an email that corrects an earlier one stops saying what the earlier one said;
  *   - `workflowUrl` starts emitting `:80`/`:443`/no-port links, or drops the workflow id from the
  *     deep link, so the mail points somewhere the user cannot open;
  *   - an email that cannot be sent passes for one that was;
  *   - a notification no longer reads back as it was written, or a malformed one is read.
  *
  * The notifier reads nothing to build an email, so this suite needs no database, and it hands
  * each email to a function the suite gives it, so no test reaches a mail server.
  */
class WorkflowEmailNotifierSpec extends AnyFlatSpec {

  private val testWid: Int = 7000 + scala.util.Random.nextInt(1000)
  // Random suffix: the subject/content assertions can only pass if the notifier really used the
  // name it was given.
  private val testWorkflowName: String = "notifier_wf_" + UUID.randomUUID().toString.substring(0, 8)
  private val userEmail = "recipient@example.com"
  private val workflowPage = s"http://texera.example.com:8080/user/workspace/$testWid"
  private val endedAt = Instant.parse("2024-03-05T14:07:09Z").toEpochMilli

  private val completed = WorkflowExecutionStatus.Completed
  private val failed = WorkflowExecutionStatus.Failed
  private val killed = WorkflowExecutionStatus.Killed

  private def notification(email: String = userEmail): Notification =
    Notification(email, testWorkflowName, workflowPage)

  /** A notifier, and the emails it handed over to be sent, each with its recipient. */
  private class Outbox(answer: Either[String, Unit] = Right(())) {
    val sent = mutable.ListBuffer.empty[(EmailMessage, String)]
    val notifier = new WorkflowEmailNotifier((message, recipient) => {
      sent += ((message, recipient))
      answer
    })
  }

  /** `body`, with the JVM's zone away from UTC and its locale US. */
  private def awayFromUtc[T](body: => T): T = {
    val previousLocale = Locale.getDefault
    val previousZone = TimeZone.getDefault
    Locale.setDefault(Locale.US)
    TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"))
    try body
    finally {
      TimeZone.setDefault(previousZone)
      Locale.setDefault(previousLocale)
    }
  }

  // ─── workflowUrl ───────────────────────────────────────────────────────────

  "workflowUrl" should "omit the port when the request URI carries none" in {
    val url = WorkflowEmailNotifier.workflowUrl(
      new URI("http://texera.example.com/dashboard/user/workspace/9"),
      testWid.toLong
    )
    assert(url == s"http://texera.example.com/user/workspace/$testWid")
  }

  it should "omit an explicit port 80" in {
    val url =
      WorkflowEmailNotifier.workflowUrl(new URI("http://texera.example.com:80/dashboard"), testWid)
    assert(url == s"http://texera.example.com/user/workspace/$testWid")
  }

  // Note the assertion keeps `http://` even for the https-conventional :443. workflowUrl hardcodes
  // the scheme and never reads the request URI's; that is today's behaviour, not an endorsement of
  // it. A fix that preserved the scheme would surface here.
  it should "omit an explicit port 443" in {
    val url =
      WorkflowEmailNotifier.workflowUrl(new URI("http://texera.example.com:443/dashboard"), testWid)
    assert(url == s"http://texera.example.com/user/workspace/$testWid")
  }

  it should "keep a non-default port" in {
    val url = WorkflowEmailNotifier.workflowUrl(new URI("http://localhost:8080/dashboard"), testWid)
    assert(url == s"http://localhost:8080/user/workspace/$testWid")
  }

  it should "link to the host of the websocket session a run was started over" in {
    val url = WorkflowEmailNotifier.workflowUrl(
      new URI("ws://texera.example.com:8080/wsapi/workflow-websocket?wid=1&cuid=2"),
      testWid
    )
    assert(url == s"http://texera.example.com:8080/user/workspace/$testWid")
  }

  // ─── send ──────────────────────────────────────────────────────────────────

  "send" should "email the address in the notification how the run ended, why and when" in {
    val outbox = new Outbox
    awayFromUtc {
      outbox.notifier.send(notification(), testWid, failed, Some("unit lost"), endedAt)
    }

    assert(outbox.sent.size == 1)
    val (message, recipient) = outbox.sent.head
    assert(recipient == userEmail)
    assert(message.receiver == userEmail)
    assert(message.subject == s"[Texera] Workflow $testWorkflowName ($testWid): Failed")
    // Had the time been written in the JVM's zone, it would read 6:07:09 AM.
    assert(
      message.content ==
        s"""Hello,
           |
           |The run of the workflow with the following details has ended:
           |
           |- Workflow ID: $testWid
           |- Workflow Name: $testWorkflowName
           |- State: Failed
           |- Reason: unit lost
           |- Timestamp: March 5, 2024, 2:07:09 PM (UTC)
           |
           |You can view more details by visiting: $workflowPage
           |
           |Regards,
           |Texera Team""".stripMargin
    )
  }

  it should "name each ending in the subject and the content" in {
    Seq(completed -> "Completed", failed -> "Failed", killed -> "Killed").foreach {
      case (outcome, name) =>
        val outbox = new Outbox
        outbox.notifier.send(notification(), testWid, outcome, None, endedAt)

        val message = outbox.sent.head._1
        assert(message.subject == s"[Texera] Workflow $testWorkflowName ($testWid): $name")
        assert(message.content.linesIterator.contains(s"- State: $name"))
    }
  }

  it should "leave the reason's line out when the run gave none" in {
    val outbox = new Outbox
    outbox.notifier.send(notification(), testWid, completed, None, endedAt)

    assert(!outbox.sent.head._1.content.contains("Reason"))
  }

  // A reason is the run's own words: an error message can hold a line that starts like the
  // margin of a template.
  it should "write a reason of several lines as it is" in {
    val reason = "ValueError: bad row\n  | 1 | x\n  | 2 | y"
    val outbox = new Outbox
    outbox.notifier.send(notification(), testWid, failed, Some(reason), endedAt)

    assert(outbox.sent.head._1.content.contains(s"- Reason: $reason\n- Timestamp: "))
  }

  it should "say what an earlier email said when it corrects one" in {
    val outbox = new Outbox
    outbox.notifier.send(
      notification(),
      testWid,
      completed,
      None,
      endedAt,
      corrects = Some(Corrected(failed, Some("unit lost")))
    )

    val message = outbox.sent.head._1
    assert(message.subject == s"[Texera] Workflow $testWorkflowName ($testWid): Completed")
    assert(
      message.content.startsWith(
        "Hello,\n\nAn earlier email said that this run of your workflow had failed (unit " +
          "lost). Its computing unit could not be reached for a while, and the run went on. " +
          "This is how it ended:\n\n"
      )
    )
    assert(message.content.linesIterator.contains("- State: Completed"))
    assert(!message.content.contains("has ended:"))
  }

  it should "say an earlier ending that had no reason without one" in {
    val outbox = new Outbox
    outbox.notifier.send(
      notification(),
      testWid,
      killed,
      Some("killed by the user"),
      endedAt,
      corrects = Some(Corrected(failed, None))
    )

    val content = outbox.sent.head._1.content
    assert(content.contains("said that this run of your workflow had failed. Its computing"))
    assert(content.linesIterator.contains("- Reason: killed by the user"))
  }

  it should "send nothing to an address that is not one" in {
    Seq("not-an-email", "user@").foreach { address =>
      val outbox = new Outbox
      outbox.notifier.send(notification(address), testWid, completed, None, endedAt)
      assert(outbox.sent.isEmpty, s"for '$address'")
    }
  }

  it should "fail when the email cannot be sent, with why" in {
    val outbox = new Outbox(Left("Failed to send email: connection refused"))

    val failure = intercept[IllegalStateException] {
      outbox.notifier.send(notification(), testWid, completed, None, endedAt)
    }
    assert(failure.getMessage == "Failed to send email: connection refused")
    assert(outbox.sent.size == 1)
  }

  it should "refuse a state that is no ending, and send nothing" in {
    Seq[Short](
      WorkflowExecutionStatus.Initializing,
      WorkflowExecutionStatus.Running,
      WorkflowExecutionStatus.Paused,
      WorkflowExecutionStatus.Created,
      WorkflowExecutionStatus.Unknown
    ).foreach { status =>
      val outbox = new Outbox
      val failure = intercept[IllegalArgumentException] {
        outbox.notifier.send(notification(), testWid, status, None, endedAt)
      }
      assert(failure.getMessage == s"A run ends completed, failed or killed, not as $status.")
      assert(outbox.sent.isEmpty)
    }
  }

  // ─── Notification ──────────────────────────────────────────────────────────

  "Notification" should "write the three fields an execution's row keeps, and read them back" in {
    val url = s"http://texera.example.com:8080/user/workspace/$testWid"
    val notification = Notification(userEmail, "Sales \"Q3\" — ünïcode", url)

    val json = Notification.toJson(notification)

    assert(
      json == s"""{"email":"$userEmail","workflowName":"Sales \\"Q3\\" — ünïcode",""" +
        s""""workflowUrl":"$url"}"""
    )
    assert(Notification.fromJson(json) == notification)
    // The fields may come in any order and with any spacing.
    assert(
      Notification.fromJson(
        s"""{ "workflowUrl": "$url", "email": "$userEmail", "workflowName": "n" }"""
      ) ==
        Notification(userEmail, "n", url)
    )
  }

  it should "refuse a notification that is not exactly the three fields, each a string" in {
    val complete = s""""email":"$userEmail","workflowName":"n","workflowUrl":"u""""
    Seq(
      "" -> "it is not JSON",
      "{\"email\":" -> "it is not JSON",
      "[]" -> "it is not an object",
      "\"just text\"" -> "it is not an object",
      "{}" -> "email, workflowName, workflowUrl missing or not a string",
      s"""{"email":"$userEmail","workflowName":"n"}""" -> "workflowUrl missing or not a string",
      s"""{"email":null,"workflowName":"n","workflowUrl":"u"}""" ->
        "email missing or not a string",
      s"""{"email":7,"workflowName":"n","workflowUrl":"u"}""" ->
        "email missing or not a string",
      s"""{$complete,"cc":"x","bcc":"y"}""" -> "it has bcc, cc"
    ).foreach {
      case (json, why) =>
        val failure = intercept[IllegalArgumentException](Notification.fromJson(json))
        assert(
          failure.getMessage ==
            s"The execution's notification is not {email, workflowName, workflowUrl}: $why.",
          s"for $json"
        )
    }
  }
}
