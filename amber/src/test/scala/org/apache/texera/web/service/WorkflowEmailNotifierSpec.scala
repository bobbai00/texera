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

import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.web.resource.EmailMessage
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.scalatest.PrivateMethodTester
import org.scalatest.flatspec.AnyFlatSpec

import java.net.URI
import java.time.Instant
import java.util.{Locale, TimeZone, UUID}

/**
  * Covers the parts of [[WorkflowEmailNotifier]] that decide *whether* to notify and *what* the
  * notification says, and the notification a plan row keeps. Concretely, these tests fail if:
  *   - the subject or content stop naming the workflow by the name in the notification the
  *     notifier is given, or stop linking to the page in it (the name carries a random suffix, so
  *     a hard-coded value cannot satisfy the subject/content assertions);
  *   - `workflowUrl` starts emitting `:80`/`:443`/no-port links, or drops the workflow id from the
  *     deep link, so the mail points somewhere the user cannot open;
  *   - `formatTimestamp` stops pinning UTC or changes the human-readable pattern (the JVM default
  *     zone is deliberately set to non-UTC around the assertion; the locale is pinned to US so the
  *     expected month/day text is stable across environments);
  *   - the terminal-state set stops covering a state that ends or suspends an execution, which
  *     would silently drop the only email a user gets for that run;
  *   - a notification no longer reads back as it was written, or a malformed one is read.
  *
  * The notifier reads nothing to build an email, so this suite needs no database. SMTP is never
  * exercised: only the pure message-building helpers and the state predicate are invoked, so no
  * test here reaches `GmailResource.sendEmail`.
  */
class WorkflowEmailNotifierSpec extends AnyFlatSpec with PrivateMethodTester {

  private val testWid: Int = 7000 + scala.util.Random.nextInt(1000)
  // Random suffix: the subject/content assertions can only pass if the notifier really used the
  // name it was given.
  private val testWorkflowName: String = "notifier_wf_" + UUID.randomUUID().toString.substring(0, 8)
  private val userEmail = "recipient@example.com"

  private val createEmailMessage = PrivateMethod[EmailMessage](Symbol("createEmailMessage"))
  private val createEmailSubject = PrivateMethod[String](Symbol("createEmailSubject"))
  private val createEmailContent = PrivateMethod[String](Symbol("createEmailContent"))
  private val formatTimestamp = PrivateMethod[String](Symbol("formatTimestamp"))
  private val isValidEmail = PrivateMethod[Boolean](Symbol("isValidEmail"))

  /** Builds a notifier for the test workflow, linking to its page on the host of `requestUri`. */
  private def notifierFor(
      requestUri: String,
      email: String = userEmail
  ): WorkflowEmailNotifier =
    new WorkflowEmailNotifier(
      testWid.toLong,
      Notification(
        email,
        testWorkflowName,
        WorkflowEmailNotifier.workflowUrl(new URI(requestUri), testWid.toLong)
      )
    )

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

  // ─── createEmailSubject / createEmailContent ───────────────────────────────

  "createEmailSubject" should "carry the workflow name it is given" in {
    val subject = notifierFor("http://texera.example.com") invokePrivate
      createEmailSubject(COMPLETED)
    assert(subject == s"[Texera] Workflow $testWorkflowName ($testWid) Status: ${COMPLETED.name}")
  }

  "createEmailContent" should "list the name it is given, the id, the state and the link" in {
    val content = notifierFor("http://texera.example.com:8080/dashboard") invokePrivate
      createEmailContent(FAILED)

    // stripMargin + trim: a broken margin would leave the "|" prefixes and leading blank line.
    assert(content.startsWith("Hello,"))
    assert(content.contains(s"- Workflow ID: $testWid"))
    assert(content.contains(s"- Workflow Name: $testWorkflowName"))
    assert(content.contains(s"- State: ${FAILED.name}"))
    assert(
      content.contains(s"visiting: http://texera.example.com:8080/user/workspace/$testWid"),
      s"dashboard link missing from content:\n$content"
    )
    assert(
      content.linesIterator.exists(line =>
        line.startsWith("- Timestamp: ") && line.endsWith("(UTC)")
      ),
      s"no UTC timestamp line in content:\n$content"
    )
  }

  // ─── formatTimestamp ───────────────────────────────────────────────────────

  "formatTimestamp" should "render a fixed instant in UTC, independent of the JVM defaults" in {
    val previousLocale = Locale.getDefault
    val previousZone = TimeZone.getDefault
    // Non-UTC default zone: had the formatter used ZoneId.systemDefault() the clock time below
    // would read 06:07 instead of 14:07.
    Locale.setDefault(Locale.US)
    TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"))
    try {
      val rendered = notifierFor("http://texera.example.com") invokePrivate
        formatTimestamp(Instant.parse("2024-03-05T14:07:09Z"))
      assert(rendered == "March 5, 2024, 2:07:09 PM (UTC)")
    } finally {
      TimeZone.setDefault(previousZone)
      Locale.setDefault(previousLocale)
    }
  }

  // ─── isValidEmail ──────────────────────────────────────────────────────────

  "isValidEmail" should "accept a well-formed address" in {
    assert(notifierFor("http://texera.example.com") invokePrivate isValidEmail("user@example.com"))
  }

  it should "reject an address with no '@' and one with an empty domain" in {
    val notifier = notifierFor("http://texera.example.com")
    assert(!(notifier invokePrivate isValidEmail("user-at-example.com")))
    assert(!(notifier invokePrivate isValidEmail("user@")))
  }

  // ─── shouldSendEmail ───────────────────────────────────────────────────────

  "shouldSendEmail" should "accept the states that end or suspend an execution" in {
    val notifier = notifierFor("http://texera.example.com")
    Seq(COMPLETED, PAUSED, FAILED, KILLED).foreach { state =>
      assert(notifier.shouldSendEmail(state), s"expected $state to trigger a notification")
    }
  }

  it should "decline the states an execution merely passes through" in {
    val notifier = notifierFor("http://texera.example.com")
    // TERMINATED / UNKNOWN are intentionally left out: whether they should notify is a product
    // question, and pinning today's answer would block a harmless change.
    val inFlight: Seq[WorkflowAggregatedState] =
      Seq(UNINITIALIZED, READY, RUNNING, PAUSING, RESUMING)
    inFlight.foreach { state =>
      assert(!notifier.shouldSendEmail(state), s"expected $state not to trigger a notification")
    }
  }

  // ─── createEmailMessage ────────────────────────────────────────────────────

  "createEmailMessage" should "address the recipient and carry the subject and content for the state" in {
    val notifier = notifierFor("http://texera.example.com:8080/dashboard")
    val message = notifier invokePrivate createEmailMessage(KILLED)

    assert(message.receiver == userEmail)
    // the assembled subject must match what the dedicated builder produces for the same state
    assert(message.subject == (notifier invokePrivate createEmailSubject(KILLED)))
    assert(message.content.contains(testWorkflowName))
    assert(message.content.contains(testWid.toString))
    assert(message.content.contains(KILLED.name))
  }

  // ─── sendStatusEmail ───────────────────────────────────────────────────────

  // Only the invalid-recipient arm is driven here: it returns before reaching
  // GmailResource.sendEmail, so no SMTP call is made. The valid-address arm would dispatch
  // for real, so it belongs to the integration tier.
  "sendStatusEmail" should "return without dispatching when the recipient address is invalid" in {
    val notifier = notifierFor("http://texera.example.com", email = "not-an-email")

    notifier.sendStatusEmail(COMPLETED) // must not throw and must not reach Gmail
    assert(!(notifier invokePrivate isValidEmail("not-an-email")))
  }

  // ─── Notification ──────────────────────────────────────────────────────────

  "Notification" should "write the three fields a plan row keeps, and read them back" in {
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
