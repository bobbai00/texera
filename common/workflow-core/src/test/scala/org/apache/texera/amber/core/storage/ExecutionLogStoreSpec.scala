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

package org.apache.texera.amber.core.storage

import com.google.protobuf.timestamp.Timestamp
import org.apache.iceberg.Table
import org.apache.iceberg.exceptions.ServiceUnavailableException
import org.apache.texera.amber.core.storage.ExecutionLogStore._
import org.apache.texera.amber.core.storage.result.iceberg.IcebergTidy
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.concurrent.atomic.{AtomicBoolean, AtomicLong}
import scala.jdk.CollectionConverters._

/**
  * Specs for [[ExecutionLogStore]] on Iceberg's JDBC catalog (see [[EmbeddedJdbcCatalog]]): that
  * a row and its label land in one commit is the catalog's doing.
  */
@NonParallelTest
class ExecutionLogStoreSpec extends AnyFlatSpec with Matchers with EmbeddedJdbcCatalog {

  private val workflowId = WorkflowIdentity(12)

  // Executions below 100 are left to the specs that name one.
  private val nextExecutionId = new AtomicLong(100)

  /** The log of a new execution, whose namespace is made. */
  private def freshLogUri(warehouse: Option[String] = None): URI =
    withNamespace(
      logUri(workflowId, ExecutionIdentity(nextExecutionId.getAndIncrement()), warehouse)
    )

  private val createdAtMs = 1794873600000L
  private val beatEveryMs = 30000L

  private def createdLog(warehouse: Option[String] = None): URI = {
    val uri = freshLogUri(warehouse)
    create(uri, createdAtMs, beatEveryMs)
    uri
  }

  /** The time of row `seq`: a second after the row before it. */
  private def timeOf(seq: Long): Long = createdAtMs + seq * 1000

  private def stateRow(
      seq: Long,
      state: String,
      reason: Option[String] = None,
      errors: Seq[WorkflowFatalError] = Nil
  ): ExecutionLogEntry = ExecutionLogEntry.state(seq, timeOf(seq), state, reason, errors)

  private def error(message: String): WorkflowFatalError =
    WorkflowFatalError(
      EXECUTION_FAILURE,
      Timestamp(seconds = 1794873600L, nanos = 123456789),
      message,
      "<stack trace>",
      "PythonUDFV2-operator-1",
      "Worker:WF12-PythonUDFV2-operator-1-main-0"
    )

  /** Appends each entry in a commit of its own, a second after the entry's time. */
  private def appendEach(uri: URI, entries: ExecutionLogEntry*): Unit =
    entries.foreach(entry => append(uri, Seq(entry), entry.timeMs + 1000))

  private def table(uri: URI): Table = DocumentFactory.icebergTableOf(uri).get

  private def snapshotCount(uri: URI): Int = table(uri).snapshots().asScala.size

  private def dataFileCount(uri: URI): Int =
    table(uri).currentSnapshot().summary().get("total-data-files").toInt

  // ---------------------------------------------------------------------------
  // ExecutionLogEntry
  // ---------------------------------------------------------------------------

  "ExecutionLogEntry.state" should "say why the state changed in its detail, and nothing when there is nothing to say" in {
    stateRow(1, "READY") shouldBe ExecutionLogEntry(1, timeOf(1), StateKind, Some("READY"), None)
    stateRow(2, "RUNNING", reason = Some("")).detail shouldBe None

    stateRow(3, "KILLED", reason = Some("replaced by execution 346")).detail shouldBe
      Some("""{"reason":"replaced by execution 346"}""")

    stateRow(
      4,
      "FAILED",
      reason = Some("the computing unit was stopped"),
      errors = Seq(error("java.lang.RuntimeException: boom"))
    ).detail shouldBe Some(
      """{"reason":"the computing unit was stopped","errors":[{"type":"EXECUTION_FAILURE",""" +
        """"timeMs":1794873600123,"message":"java.lang.RuntimeException: boom",""" +
        """"details":"<stack trace>","operatorId":"PythonUDFV2-operator-1",""" +
        """"workerId":"Worker:WF12-PythonUDFV2-operator-1-main-0"}]}"""
    )
  }

  "ExecutionLogEntry.reason" should "be the row's reason, else its first error's message, else nothing" in {
    stateRow(1, "KILLED", Some("killed by the user"), Seq(error("boom"))).reason shouldBe
      Some("killed by the user")
    stateRow(2, "FAILED", errors = Seq(error("first"), error("second"))).reason shouldBe
      Some("first")
    stateRow(3, "PAUSED").reason shouldBe None
    // An error without a message says nothing.
    stateRow(4, "FAILED", errors = Seq(error(""))).reason shouldBe None
  }

  it should "keep at most 500 characters, and never half of a character" in {
    stateRow(1, "FAILED", errors = Seq(error("x" * 500))).reason shouldBe Some("x" * 500)
    stateRow(2, "FAILED", errors = Seq(error("x" * 501))).reason shouldBe Some("x" * 500)
    stateRow(3, "KILLED", reason = Some("y" * 2000)).reason shouldBe Some("y" * 500)
    // 😀 takes two chars; the 500th char would be its first half.
    stateRow(4, "FAILED", errors = Seq(error("x" * 499 + "😀"))).reason shouldBe Some("x" * 499)
    stateRow(5, "FAILED", errors = Seq(error("x" * 498 + "😀"))).reason shouldBe
      Some("x" * 498 + "😀")
  }

  // ---------------------------------------------------------------------------
  // logUri
  // ---------------------------------------------------------------------------

  "logUri" should "name the execution's log table, in its warehouse when it has one" in {
    logUri(workflowId, ExecutionIdentity(345), None) shouldBe
      new URI("vfs:///wid/12/eid/345/executionlog")
    logUri(workflowId, ExecutionIdentity(345), Some(warehouse)) shouldBe
      new URI(s"vfs:///wh/$warehouse/wid/12/eid/345/executionlog")
  }

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  "create" should "make an empty log whose label has a beat and no state" in {
    val uri = createdLog()

    label(uri) shouldBe Some(ExecutionLabel(None, 0, 0, None, createdAtMs, beatEveryMs))
    label(uri).get.ended shouldBe false
    read(uri) shouldBe empty
    snapshotCount(uri) shouldBe 0
  }

  it should "replace a stale table at the same execution, with its rows and its label" in {
    val uri = createdLog()
    appendEach(uri, stateRow(1, "READY"), stateRow(2, "RUNNING"), stateRow(3, "FAILED"))

    create(uri, createdAtMs + 5000, beatEveryMs = 1000)

    label(uri) shouldBe Some(ExecutionLabel(None, 0, 0, None, createdAtMs + 5000, 1000))
    read(uri) shouldBe empty
  }

  // ---------------------------------------------------------------------------
  // append / label
  // ---------------------------------------------------------------------------

  "append" should "set the label to the state row it appends, with the row's seq and time" in {
    val uri = createdLog()

    append(uri, Seq(stateRow(1, "READY")), nowMs = timeOf(1) + 7)

    label(uri) shouldBe
      Some(ExecutionLabel(Some("READY"), 1, timeOf(1), None, timeOf(1) + 7, beatEveryMs))
    read(uri) shouldBe Seq(stateRow(1, "READY"))
  }

  it should "append several rows in one commit, and label the last of them" in {
    val uri = createdLog()
    append(uri, Seq(stateRow(1, "READY")), timeOf(1))
    val snapshotsBefore = snapshotCount(uri)

    val rows = Seq(
      stateRow(2, "RUNNING"),
      stateRow(3, "PAUSED", reason = Some("paused by the user")),
      stateRow(4, "RUNNING")
    )
    append(uri, rows, nowMs = timeOf(5))

    snapshotCount(uri) shouldBe snapshotsBefore + 1
    label(uri) shouldBe
      Some(ExecutionLabel(Some("RUNNING"), 4, timeOf(4), None, timeOf(5), beatEveryMs))
    read(uri) shouldBe stateRow(1, "READY") +: rows
  }

  it should "follow every change of state, and forget the reason of the state before" in {
    val uri = createdLog()
    val run = Seq(
      stateRow(1, "READY"),
      stateRow(2, "RUNNING"),
      stateRow(3, "PAUSED", reason = Some("paused by the user")),
      stateRow(4, "RUNNING"),
      stateRow(5, "COMPLETED")
    )
    run.foreach { row =>
      append(uri, Seq(row), row.timeMs)
      withClue(s"after row ${row.seq}: ") {
        label(uri) shouldBe Some(
          ExecutionLabel(row.state, row.seq, row.timeMs, row.reason, row.timeMs, beatEveryMs)
        )
      }
    }
    read(uri) shouldBe run
  }

  it should "label a failure that gives no reason with its first error's message, cut to 500 characters" in {
    val uri = createdLog()
    val failed = stateRow(1, "FAILED", errors = Seq(error("é" * 600), error("second")))

    append(uri, Seq(failed), timeOf(1))

    label(uri).get.reason shouldBe Some("é" * 500)
    // The row keeps both errors whole.
    read(uri).head.detail.get should (include("é" * 600) and include("second"))
  }

  it should "show the execution as ended for the three endings only" in {
    States.foreach { state =>
      val uri = createdLog()
      append(uri, Seq(stateRow(1, state)), timeOf(1))
      withClue(s"$state: ") {
        label(uri).get.ended shouldBe Seq("COMPLETED", "FAILED", "KILLED").contains(state)
      }
    }
  }

  it should "refuse rows that are not a log's, and append nothing" in {
    val uri = createdLog()
    append(uri, Seq(stateRow(1, "READY")), timeOf(1))
    val refused: Seq[Seq[ExecutionLogEntry]] = Seq(
      Nil,
      // The seq of the rows of one append rises.
      Seq(stateRow(3, "RUNNING"), stateRow(2, "PAUSED")),
      Seq(stateRow(2, "RUNNING"), stateRow(2, "PAUSED")),
      // A row is a state row, with one of the six states.
      Seq(stateRow(2, "PAUSING")),
      Seq(stateRow(2, "running")),
      Seq(stateRow(2, "RUNNING").copy(state = None)),
      Seq(stateRow(2, "RUNNING").copy(kind = "beat"))
    )
    refused.foreach { entries =>
      withClue(s"$entries: ") {
        an[IllegalArgumentException] should be thrownBy append(uri, entries, timeOf(2))
      }
    }
    read(uri) shouldBe Seq(stateRow(1, "READY"))
    label(uri).get.beatMs shouldBe timeOf(1)
  }

  it should "let no reader see a label without its row, or a row without its label" in {
    val uri = createdLog()
    val appends = 40
    val done = new AtomicBoolean(false)
    val loads = new AtomicLong()
    val apart = new AtomicLong()
    // Every state row is one more row, so in a table loaded at any moment the label's seq is
    // the number of rows.
    val readers = (1 to 3).map { _ =>
      new Thread(() =>
        while (!done.get()) {
          val loaded = table(uri)
          val labelled = Option(loaded.properties().get(StateSeqProperty)).fold(0L)(_.toLong)
          val rows = Option(loaded.currentSnapshot())
            .fold(0L)(_.summary().get("total-records").toLong)
          loads.incrementAndGet()
          if (labelled != rows) apart.incrementAndGet()
        }
      )
    }
    readers.foreach(_.start())
    try (1 to appends).foreach { seq =>
      append(uri, Seq(stateRow(seq, if (seq % 2 == 0) "PAUSED" else "RUNNING")), timeOf(seq))
    } finally {
      done.set(true)
      readers.foreach(_.join())
    }

    apart.get() shouldBe 0
    loads.get() should be > appends.toLong
    label(uri).get.stateSeq shouldBe appends
  }

  // ---------------------------------------------------------------------------
  // beat
  // ---------------------------------------------------------------------------

  "beat" should "move the beat alone, in a commit that adds no snapshot" in {
    val uri = createdLog()
    append(uri, Seq(stateRow(1, "RUNNING", reason = Some("resumed"))), timeOf(1))
    val before = label(uri).get
    val snapshotBefore = table(uri).currentSnapshot().snapshotId()

    beat(uri, nowMs = timeOf(1) + 30000)

    label(uri) shouldBe Some(before.copy(beatMs = timeOf(1) + 30000))
    snapshotCount(uri) shouldBe 1
    table(uri).currentSnapshot().snapshotId() shouldBe snapshotBefore
    read(uri) shouldBe Seq(stateRow(1, "RUNNING", reason = Some("resumed")))
  }

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  "read" should "return every row as it was appended, by seq" in {
    val uri = createdLog()
    val stackTrace =
      "java.lang.RuntimeException: Grüße 日本語 😀\n" + "\tat a.b.C.d(C.scala:1)\n" * 20000
    val rows = Seq(
      stateRow(1, "READY"),
      stateRow(2, "RUNNING"),
      stateRow(3, "PAUSED", reason = Some("paused by the user")),
      stateRow(4, "FAILED", errors = Seq(error("boom").copy(details = stackTrace)))
    )
    append(uri, rows.take(1), timeOf(1))
    append(uri, rows.slice(1, 3), timeOf(3))
    append(uri, rows.drop(3), timeOf(4))

    read(uri) shouldBe rows
    read(uri).last.detail.get should include("Grüße 日本語 😀")
  }

  it should "return one row per seq when an append landed twice" in {
    val uri = createdLog()
    val first = Seq(stateRow(1, "READY"), stateRow(2, "RUNNING"))
    // The first try's answer was lost, so the same rows are appended again, with a row more.
    append(uri, first, timeOf(2))
    append(uri, first :+ stateRow(3, "PAUSED"), timeOf(3))
    append(uri, Seq(stateRow(4, "KILLED")), timeOf(4))

    read(uri) shouldBe first ++ Seq(stateRow(3, "PAUSED"), stateRow(4, "KILLED"))
    snapshotCount(uri) shouldBe 3
  }

  it should "return every row when a tidy deletes the files it planned to read" in {
    val uri = createdLog()
    val rows = Seq(stateRow(1, "READY"), stateRow(2, "RUNNING"), stateRow(3, "COMPLETED"))
    appendEach(uri, rows: _*)
    var plans = 0

    read(
      uri,
      afterPlan = () => {
        plans += 1
        if (plans == 1) tidy(uri, atEnd = true)
      }
    ) shouldBe rows
    plans shouldBe 2
  }

  // ---------------------------------------------------------------------------
  // tidy
  // ---------------------------------------------------------------------------

  "tidy" should "leave the rows and the label as they were, in one data file when the log is over" in {
    val uri = createdLog()
    val rows = (1L to 59L).map(seq => stateRow(seq, if (seq % 2 == 0) "PAUSED" else "RUNNING")) :+
      stateRow(60, "KILLED", reason = Some("killed by the user"))
    appendEach(uri, rows: _*)
    val labelBefore = label(uri)
    dataFileCount(uri) shouldBe 60

    tidy(uri, atEnd = false)
    read(uri) shouldBe rows
    label(uri) shouldBe labelBefore
    dataFileCount(uri) shouldBe 1
    snapshotCount(uri) should be >= IcebergTidy.RetainSnapshots

    tidy(uri, atEnd = true)
    read(uri) shouldBe rows
    label(uri) shouldBe labelBefore
    dataFileCount(uri) shouldBe 1
    snapshotCount(uri) shouldBe 1
  }

  // ---------------------------------------------------------------------------
  // drop
  // ---------------------------------------------------------------------------

  "drop" should "remove the table with its rows and its label" in {
    val uri = createdLog()
    appendEach(uri, stateRow(1, "READY"))

    drop(uri)

    DocumentFactory.documentExists(uri) shouldBe false
    label(uri) shouldBe None
    read(uri) shouldBe empty
  }

  it should "do nothing where there is no table" in {
    val uri = freshLogUri()
    noException should be thrownBy drop(uri)
    DocumentFactory.documentExists(uri) shouldBe false
  }

  // ---------------------------------------------------------------------------
  // a log that is not there, and a catalog that fails
  // ---------------------------------------------------------------------------

  "A read" should "take a table that is not there for an empty log" in {
    val uri = freshLogUri()
    label(uri) shouldBe None
    read(uri) shouldBe empty
  }

  "A write" should "fail with NoSuchExecutionTableException where there is no table, and create none" in {
    val uri = freshLogUri()
    val writes: Seq[(String, () => Unit)] = Seq(
      "append" -> (() => append(uri, Seq(stateRow(1, "READY")), timeOf(1))),
      "beat" -> (() => beat(uri, timeOf(1))),
      "tidy" -> (() => tidy(uri, atEnd = true))
    )
    writes.foreach {
      case (name, write) =>
        withClue(s"$name: ") {
          intercept[NoSuchExecutionTableException](write()).uri shouldBe uri
        }
    }
    DocumentFactory.documentExists(uri) shouldBe false
  }

  "Every operation" should "pass on a catalog failure, not take it for a missing log" in {
    val uri = createdLog(Some(warehouse))
    appendEach(uri, stateRow(1, "READY"), stateRow(2, "RUNNING"))
    val labelBefore = label(uri)
    val operations: Seq[(String, () => Any)] = Seq(
      "label" -> (() => label(uri)),
      "read" -> (() => read(uri)),
      "append" -> (() => append(uri, Seq(stateRow(3, "PAUSED")), timeOf(3))),
      "beat" -> (() => beat(uri, timeOf(3))),
      "tidy" -> (() => tidy(uri, atEnd = true)),
      "drop" -> (() => drop(uri))
    )
    whileCatalogUnavailable {
      operations.foreach {
        case (name, operation) =>
          withClue(s"$name: ") {
            a[ServiceUnavailableException] should be thrownBy operation()
          }
      }
    }
    // The log is as it was.
    label(uri) shouldBe labelBefore
    read(uri) shouldBe Seq(stateRow(1, "READY"), stateRow(2, "RUNNING"))
  }

  it should "read and write a log whose URI names a warehouse, also when the URI comes as text" in {
    val uri = createdLog(Some(warehouse))
    uri.toString should startWith(s"vfs:///wh/$warehouse/wid/12/eid/")
    appendEach(uri, stateRow(1, "READY"))

    read(URI.create(uri.toString)) shouldBe Seq(stateRow(1, "READY"))
    label(URI.create(uri.toString)).get.state shouldBe Some("READY")
  }

  it should "refuse a URI that is not an execution's log URI, touching no table" in {
    val executionId = ExecutionIdentity(1)
    val otherTables = Seq(
      VFSURIFactory.createConsoleMessagesURI(workflowId, executionId),
      VFSURIFactory.createRuntimeStatisticsURI(workflowId, executionId),
      // Segments the store did not write would address another table of the execution.
      new URI("vfs:///wid/12/eid/1/opid/op/executionlog"),
      new URI("vfs:///wid/12/eid/1/EXECUTIONLOG"),
      // A warehouse name that does not decode, so the URI would fall back to the default.
      new URI("vfs:///wh/user-1%2D7/wid/12/eid/1/executionlog")
    )
    val operations: Seq[(String, URI => Any)] = Seq(
      "create" -> (uri => create(uri, createdAtMs, beatEveryMs)),
      "append" -> (uri => append(uri, Seq(stateRow(1, "READY")), timeOf(1))),
      "beat" -> (uri => beat(uri, timeOf(1))),
      "label" -> (uri => label(uri)),
      "read" -> (uri => read(uri)),
      "tidy" -> (uri => tidy(uri, atEnd = true)),
      "drop" -> (uri => drop(uri))
    )
    for (
      (name, operation) <- operations;
      uri <- otherTables :+ new URI("file:///wid/12/eid/1/executionlog")
    )
      withClue(s"$name($uri): ") {
        an[IllegalArgumentException] should be thrownBy operation(uri)
      }
    otherTables.foreach { uri =>
      withClue(s"$uri: ") { DocumentFactory.documentExists(uri) shouldBe false }
    }
  }
}
