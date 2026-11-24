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

import org.apache.texera.amber.core.executor.{InputFile, OpExecWithClassName, OperatorInputs}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionMode,
  ExecutionPlan,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PortIdentity,
  ReplaySource,
  WorkflowContext,
  WorkflowSettings
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.time.Instant

/**
  * The checks a computing unit makes of the plan a request to start an execution carries, before
  * it starts it: every refusal of [[ExecutionStart.check]], in its words. The plans are encoded
  * here, as the Dashboard service encodes them.
  */
class ExecutionStartSpec extends AnyFlatSpec with Matchers {

  private val wid = 9751L
  private val eid = 975001L
  private val uid = 9752
  private val ownWarehouse = s"user-$uid-3"

  private val now = Instant.parse("2026-11-16T12:00:00Z").toEpochMilli

  /** What executions' replay logs are resolved against on the unit of the checks below. */
  private val logRoot = new URI("file:///var/texera/replay-logs/")

  /** A source of one string column, of `workflow`'s execution `execution`. */
  private def source(name: String, workflow: Long = wid, execution: Long = eid): PhysicalOp =
    PhysicalOp
      .sourcePhysicalOp(
        PhysicalOpIdentity(OperatorIdentity(name), "main"),
        WorkflowIdentity(workflow),
        ExecutionIdentity(execution),
        OpExecWithClassName("unused")
      )
      .copy(outputPorts =
        Map(
          PortIdentity() -> (
            OutputPort(),
            List.empty,
            Right(Schema().add("line", AttributeType.STRING))
          )
        )
      )

  /**
    * The plan of a run of the sources `reads` names, each with the files it reads through links,
    * as the Dashboard writes it: of `lines` alone, which reads none, unless a case gives others.
    */
  private def planText(
      workflow: Long = wid,
      execution: Long = eid,
      warehouse: Option[String] = None,
      reads: Map[String, Seq[InputFile]] = Map("lines" -> Seq.empty),
      replay: Option[URI] = None,
      replayLog: Option[URI] = None
  ): String =
    PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.encode(
        ExecutionPlan(
          new WorkflowContext(
            WorkflowIdentity(workflow),
            ExecutionIdentity(execution),
            WorkflowSettings(dataTransferBatchSize = 77, executionMode = ExecutionMode.PIPELINED),
            warehouse = warehouse
          ),
          PhysicalPlan(
            reads.map {
              case (name, files) =>
                source(name, workflow, execution)
                  .withStorageLocations(warehouse)
                  .withInputs(OperatorInputs(files = files))
            }.toSet,
            Set.empty
          ),
          replay = replay.map(ReplaySource(ExecutionIdentity(execution - 1), _, "interaction-1")),
          replayLog = replayLog
        )
      )
    )

  private def check(
      plan: String = planText(),
      socketWorkflow: Option[Long] = Some(wid),
      user: Int = uid,
      nowMs: Long = now,
      warehousesEnabled: Boolean = true,
      replayLogRoot: Option[URI] = Some(logRoot)
  ): Either[String, ExecutionPlan] =
    ExecutionStart.check(
      plan,
      socketWorkflow,
      user,
      nowMs,
      warehousesEnabled,
      replayLogRoot
    )

  /** The file `name` as a plan's operator reads it, through a link that lasts to `expiresAtMs`. */
  private def file(name: String, expiresAtMs: Long): InputFile =
    InputFile(name, s"http://texera-rustfs:9000/texera-dataset/$name", expiresAtMs)

  // --- the plan, and whose it is ---

  "ExecutionStart.check" should "read the plan of the execution, with its context, in the default warehouse or the user's own" in {
    val plan = check().getOrElse(fail("refused"))
    plan.context.workflowId shouldBe WorkflowIdentity(wid)
    plan.context.executionId shouldBe ExecutionIdentity(eid)
    plan.context.workflowSettings.dataTransferBatchSize shouldBe 77
    plan.context.warehouse shouldBe None
    plan.plan.operators.map(_.id) shouldBe Set(
      PhysicalOpIdentity(OperatorIdentity("lines"), "main")
    )

    val inOwnWarehouse =
      check(planText(warehouse = Some(ownWarehouse))).getOrElse(fail("refused"))
    inOwnWarehouse.context.warehouse shouldBe Some(ownWarehouse)
    // A request that came over no socket starts the workflow the plan names.
    check(socketWorkflow = None).isRight shouldBe true
  }

  it should "refuse a request that carries no plan" in {
    Seq(null, "", "  \n").foreach { plan =>
      withClue(s"[$plan]: ") {
        check(plan) shouldBe Left("The request carries no plan.")
      }
    }
  }

  it should "refuse a plan it cannot read, in the codec's words" in {
    check("not a plan").left.getOrElse(fail("read")) should startWith("The plan is not JSON")
    // A plan in a format this unit does not read yet is refused for its format, whatever it
    // holds that this unit does not know.
    val nextFormat = planText().replaceFirst(
      s""""formatVersion": ${PhysicalPlanCodec.FormatVersion},""",
      s""""formatVersion": ${PhysicalPlanCodec.FormatVersion + 1}, "aFieldOfTheNextFormat": 1,"""
    )
    nextFormat should not be planText()
    check(nextFormat) shouldBe Left(
      s"The plan is in format version ${PhysicalPlanCodec.FormatVersion + 1}, but this reader " +
        s"reads version ${PhysicalPlanCodec.FormatVersion}."
    )
  }

  it should "start whichever execution the plan names: the request names none beside it" in {
    check(planText(execution = eid + 1)).map(_.context.executionId) shouldBe
      Right(ExecutionIdentity(eid + 1))
  }

  it should "refuse, over a socket, the plan of another workflow" in {
    check(planText(workflow = wid + 1)) shouldBe
      Left(s"The plan belongs to workflow ${wid + 1}, not to this one.")
  }

  it should "refuse a plan that writes into another user's warehouse, before it asks whether warehouses are on" in {
    Seq(
      s"user-${uid + 1}-3",
      s"user-${uid}7-3", // another user, whose id starts with this one's
      s"user-$uid-",
      s"user-$uid-3x",
      "shared",
      s"user-$uid"
    ).foreach { warehouse =>
      withClue(s"$warehouse: ") {
        Seq(true, false).foreach { enabled =>
          check(planText(warehouse = Some(warehouse)), warehousesEnabled = enabled) shouldBe
            Left("The plan writes into another user's warehouse.")
        }
      }
    }
  }

  it should "refuse a plan that writes into the user's own warehouse while per-user warehouses are disabled" in {
    check(planText(warehouse = Some(ownWarehouse)), warehousesEnabled = false) shouldBe
      Left(
        s"Execution $eid writes into warehouse '$ownWarehouse', and per-user warehouses are " +
          "disabled in this deployment."
      )
    // The default warehouse is written into either way.
    check(warehousesEnabled = false).isRight shouldBe true
  }

  it should "check the workflow first, then the warehouse" in {
    val everythingWrong = planText(workflow = wid + 1, warehouse = Some("shared"))
    check(everythingWrong) shouldBe
      Left(s"The plan belongs to workflow ${wid + 1}, not to this one.")
    check(everythingWrong, socketWorkflow = None) shouldBe
      Left("The plan writes into another user's warehouse.")
  }

  // --- the input links ---

  it should "refuse a plan whose earliest input link has expired, naming when" in {
    val earliest = now - 1000
    // Whichever operator reads through the link, and wherever it is among the operator's files.
    val reads = Map(
      "lines" -> Seq(file("a.csv", now + 60000)),
      "numbers" -> Seq(file("b.csv", now + 30000), file("c.csv", earliest))
    )
    check(planText(reads = reads)) shouldBe Left(
      s"The plan's input links expired at ${Instant.ofEpochMilli(earliest)}. Run the workflow " +
        "again."
    )
    // A link that expires now has expired.
    check(planText(reads = Map("lines" -> Seq(file("a.csv", now))))) shouldBe Left(
      s"The plan's input links expired at ${Instant.ofEpochMilli(now)}. Run the workflow again."
    )
  }

  it should "pass a plan whose input links have not expired, and one that reads no input" in {
    val reads = Map("lines" -> Seq(file("a.csv", now + 1)))
    val plan = check(planText(reads = reads)).getOrElse(fail("refused"))
    plan.plan.operators.map(_.inputs) shouldBe Set(OperatorInputs(files = reads("lines")))
    check().map(_.plan.operators.map(_.inputs)) shouldBe
      Right(Set(OperatorInputs.defaultInstance))
  }

  // --- the replay logs ---

  it should "pass a plan that replays and writes replay logs where this unit keeps them" in {
    // As the Dashboard names an execution's log, and in the other spelling of the same place.
    val replayed = logRoot.resolve(s"$wid/${eid - 1}/")
    val written = new URI(s"file:/var/texera/replay-logs/$wid/$eid/")
    val plan = check(planText(replay = Some(replayed), replayLog = Some(written)))
      .getOrElse(fail("refused"))
    plan.replay.map(_.logLocation) shouldBe Some(replayed)
    plan.replayLog shouldBe Some(written)

    // A root that names no directory is resolved against as the Dashboard resolves against it.
    val noSlash = new URI("file:///var/texera/replay-logs")
    check(
      planText(replayLog = Some(noSlash.resolve(s"$wid/$eid/"))),
      replayLogRoot = Some(noSlash)
    ).isRight shouldBe true
    // A plan that names no replay log needs the unit to keep none.
    check(replayLogRoot = None).isRight shouldBe true
  }

  it should "refuse a plan that replays, or writes, a replay log anywhere else" in {
    // Each with how the refusal names it: without a query, which may hold a secret.
    val elsewhere = Seq(
      "file:///etc/texera/" -> "file:/etc/texera/",
      // a directory beside the unit's, whose name starts as its name does
      "file:///var/texera/replay-logs-old/1/2/" -> "file:/var/texera/replay-logs-old/1/2/",
      // a path that steps out of the unit's directory, plainly and escaped
      "file:///var/texera/replay-logs/../secrets/" -> "file:/var/texera/replay-logs/../secrets/",
      "file:///var/texera/replay-logs/%2e%2e/secrets/" ->
        "file:/var/texera/replay-logs/../secrets/",
      // the same path on another host, in another scheme, and with more than a path
      "file://another-host/var/texera/replay-logs/1/2/" ->
        "file://another-host/var/texera/replay-logs/1/2/",
      "hdfs://namenode:8020/var/texera/replay-logs/1/2/" ->
        "hdfs://namenode:8020/var/texera/replay-logs/1/2/",
      "file:///var/texera/replay-logs/1/2/?version=3" -> "file:/var/texera/replay-logs/1/2/",
      "http://169.254.169.254/latest/meta-data/" -> "http://169.254.169.254/latest/meta-data/"
    )
    elsewhere.foreach {
      case (log, shown) =>
        withClue(s"$log: ") {
          check(planText(replay = Some(new URI(log)))) shouldBe Left(
            s"The plan replays the log at $shown, outside where this computing unit keeps " +
              "replay logs."
          )
          check(planText(replayLog = Some(new URI(log)))) shouldBe Left(
            s"The plan writes its replay log to $shown, outside where this computing unit " +
              "keeps replay logs."
          )
        }
    }
  }

  it should "refuse a plan that names a replay log on a unit that keeps none" in {
    val log = Some(logRoot.resolve(s"$wid/$eid/"))
    val shown = s"file:/var/texera/replay-logs/$wid/$eid/"
    check(planText(replay = log), replayLogRoot = None) shouldBe
      Left(s"The plan replays the log at $shown, and this computing unit keeps no replay logs.")
    check(planText(replayLog = log), replayLogRoot = None) shouldBe Left(
      s"The plan writes its replay log to $shown, and this computing unit keeps no replay logs."
    )
  }

  it should "check the plan's replay logs before its input links" in {
    val plan = planText(
      reads = Map("lines" -> Seq(file("a.csv", now - 1000))),
      replayLog = Some(new URI("file:///etc/texera/"))
    )
    check(plan).left.getOrElse(fail("passed")) should
      startWith("The plan writes its replay log to file:/etc/texera/")
  }

  // --- the execution a plan names, for the answer to a start that is not done ---

  "ExecutionStart.executionNamedBy" should "say which execution a plan's text names, without checking the plan" in {
    ExecutionStart.executionNamedBy(planText()) shouldBe Some(eid)
    ExecutionStart.executionNamedBy(planText(execution = eid + 1)) shouldBe Some(eid + 1)
    // A plan the start refuses still says whose it is.
    val refused = planText(workflow = wid + 1, warehouse = Some("shared"))
    check(refused).isLeft shouldBe true
    ExecutionStart.executionNamedBy(refused) shouldBe Some(eid)
  }

  it should "say none for a text that reads as no plan, or as a plan that names none" in {
    Seq(null, "", "  \n", "not a plan", "[]", "{}").foreach { text =>
      withClue(s"[$text]: ") {
        ExecutionStart.executionNamedBy(text) shouldBe None
      }
    }
    // A plan in a format this unit does not read names nothing it can go by.
    ExecutionStart.executionNamedBy(
      planText().replaceFirst(
        s""""formatVersion": ${PhysicalPlanCodec.FormatVersion},""",
        s""""formatVersion": ${PhysicalPlanCodec.FormatVersion + 1},"""
      )
    ) shouldBe None
  }

  // --- withoutSecrets ---

  "ExecutionStart.withoutSecrets" should "keep the scheme, host, port and path of a URI, and drop its query" in {
    val token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXhlcmEifQ.c2lnbmF0dXJl"
    ExecutionStart.withoutSecrets(
      new URI(
        s"ws://localhost:8085/wsapi/workflow-websocket?wid=12&uid=1&cuid=3&access-token=$token"
      )
    ) shouldBe new URI("ws://localhost:8085/wsapi/workflow-websocket")
    ExecutionStart.withoutSecrets(
      new URI(s"wss://texera.example/wsapi/workflow-websocket?access-token=$token#$token")
    ) shouldBe new URI("wss://texera.example/wsapi/workflow-websocket")
    // Escapes in the path stay as they were.
    ExecutionStart.withoutSecrets(new URI("ws://[::1]:8080/a%20b?x=1")) shouldBe
      new URI("ws://[::1]:8080/a%20b")
  }

  it should "drop user info, and keep nothing of a URI that is not hierarchical" in {
    ExecutionStart.withoutSecrets(new URI("ws://user:secret@host/path")) shouldBe
      new URI("ws://host/path")
    // An authority that names no host keeps what follows its user info.
    ExecutionStart.withoutSecrets(new URI("x://user:secret@not_a_host/path")) shouldBe
      new URI("x://not_a_host/path")
    ExecutionStart.withoutSecrets(new URI("mailto:secret@example.com")) shouldBe
      new URI("")
    ExecutionStart.withoutSecrets(null) shouldBe new URI("")
  }
}
