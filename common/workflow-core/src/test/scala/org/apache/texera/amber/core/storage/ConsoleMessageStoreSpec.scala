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

import org.apache.iceberg.catalog.TableIdentifier
import org.apache.iceberg.exceptions.{NotFoundException, ServiceUnavailableException}
import org.apache.texera.amber.core.storage.ConsoleMessageStore._
import org.apache.texera.amber.core.tuple.AttributeType
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.concurrent.atomic.AtomicLong
import scala.jdk.CollectionConverters._
import scala.util.Using

/** Specs for [[ConsoleMessageStore]] on Iceberg's JDBC catalog (see [[EmbeddedJdbcCatalog]]). */
@NonParallelTest
class ConsoleMessageStoreSpec extends AnyFlatSpec with Matchers with EmbeddedJdbcCatalog {

  private val workflowId = WorkflowIdentity(12)

  // Executions below 100 are left to the specs that name one.
  private val nextExecutionId = new AtomicLong(100)

  private def freshConsoleUri(warehouse: Option[String] = None): URI =
    consoleUri(workflowId, ExecutionIdentity(nextExecutionId.getAndIncrement()), warehouse)

  private def createdConsole(warehouse: Option[String] = None): URI = {
    val uri = freshConsoleUri(warehouse)
    create(uri)
    uri
  }

  private val udf = "PythonUDFV2-operator-1"
  private val sink = "PythonUDFV2-operator-2"

  private def row(seq: Long, operator: String = udf, message: String = ""): ConsoleRow =
    ConsoleRow(
      seq = seq,
      timeMs = 1794873600000L + seq,
      operatorId = operator,
      workerId = s"Worker:WF12-$operator-main-0",
      msgType = "PRINT",
      source = "udf.py:ProcessTupleOperator:process_tuple:7",
      title = s"line $seq",
      message = message
    )

  private def rows(seqs: Seq[Long], operator: String = udf): Seq[ConsoleRow] =
    seqs.map(row(_, operator))

  /** Every row of every operator. */
  private def readAll(uri: URI): Seq[ConsoleRow] = read(uri, None, afterSeq = 0, limit = 1000)._1

  private def dataFileCount(uri: URI): Int =
    DocumentFactory
      .icebergTableOf(uri)
      .get
      .currentSnapshot()
      .summary()
      .get("total-data-files")
      .toInt

  /** Deletes the data file whose name starts with `prefix` from the store, not from the table. */
  private def deleteDataFile(uri: URI, prefix: String): Unit = {
    val table = DocumentFactory.icebergTableOf(uri).get
    val location = Using.resource(table.newScan().planFiles()) {
      _.asScala.map(_.file().location()).find(_.contains(s"/$prefix")).get
    }
    table.io().deleteFile(location)
  }

  "The console schema" should "hold a row's fields in order, with the time in epoch milliseconds" in {
    schema.getAttributeNames shouldBe
      List("seq", "timeMs", "operatorId", "workerId", "msgType", "source", "title", "message")
    Seq("seq", "timeMs").foreach(schema.getAttribute(_).getType shouldBe AttributeType.LONG)
    Seq("operatorId", "workerId", "msgType", "source", "title", "message").foreach(
      schema.getAttribute(_).getType shouldBe AttributeType.STRING
    )
  }

  "consoleUri" should "name the one console table of an execution, in its warehouse when it has one" in {
    consoleUri(workflowId, ExecutionIdentity(345), None) shouldBe
      new URI("vfs:///wid/12/eid/345/consolemessages")
    consoleUri(workflowId, ExecutionIdentity(345), Some(warehouse)) shouldBe
      new URI(s"vfs:///wh/$warehouse/wid/12/eid/345/consolemessages")
  }

  it should "resolve to a table named after the workflow and the execution, in the console namespace" in {
    Seq(None, Some(warehouse)).foreach { warehouse =>
      val uri = consoleUri(workflowId, ExecutionIdentity(345), warehouse)
      VFSURIFactory.decodeURI(uri).resourceType shouldBe VFSResourceType.CONSOLE_MESSAGES

      create(uri)

      IcebergCatalogInstance
        .getInstance(warehouse)
        .tableExists(
          TableIdentifier.of(
            StorageConfig.icebergTableConsoleMessagesNamespace,
            "wid_12_eid_345_consolemessages"
          )
        ) shouldBe true
    }
  }

  "append and read" should "keep every column of a row, and a long message whole" in {
    val uri = createdConsole()
    val longMessage = "Grüße 日本語 😀\n" + "x" * 100000
    val stored = Seq(
      row(1, message = longMessage),
      ConsoleRow(2, Long.MaxValue, sink, "", "ERROR", "", "", ""),
      // What the engine stores when it had to drop messages: no operator.
      ConsoleRow(3, 0, "", "", "ERROR", "(engine)", "12 console messages were not stored", "")
    )

    append(uri, stored)

    readAll(uri) shouldBe stored
    readAll(uri).head.message should have length longMessage.length
  }

  it should "return the rows of several appends by seq" in {
    val uri = createdConsole()
    append(uri, rows(1L to 3L))
    append(uri, rows(Seq(4L)))
    append(uri, rows(5L to 6L))

    readAll(uri) shouldBe rows(1L to 6L)
  }

  it should "return one row per seq when an append landed twice" in {
    val uri = createdConsole()
    // The first try's answer was lost, so its rows are appended again, with those since.
    append(uri, rows(1L to 3L))
    append(uri, rows(1L to 5L))
    append(uri, rows(6L to 7L))

    readAll(uri) shouldBe rows(1L to 7L)
    read(uri, None, afterSeq = 2, limit = 3) shouldBe (rows(3L to 5L), true)
  }

  it should "take a row whose seq is not above those appended before it for a repeat" in {
    val uri = createdConsole()
    append(uri, rows(5L to 6L))
    // Not what the engine does: it appends in the order of seq. It is what lets a read stop
    // at the end of its page.
    append(uri, rows(3L to 4L))
    append(uri, rows(7L to 8L))

    readAll(uri) shouldBe rows(5L to 8L)
  }

  it should "commit nothing for no rows" in {
    val uri = createdConsole()
    append(uri, Nil)

    DocumentFactory.icebergTableOf(uri).get.currentSnapshot() shouldBe null
    read(uri, None, afterSeq = 0, limit = 10) shouldBe (Nil, false)
  }

  it should "refuse rows whose seq does not rise, and append nothing" in {
    val uri = createdConsole()
    Seq(Seq(row(2), row(1)), Seq(row(1), row(1))).foreach { refused =>
      an[IllegalArgumentException] should be thrownBy append(uri, refused)
    }
    readAll(uri) shouldBe empty
  }

  it should "read and write a console whose URI names a warehouse" in {
    val uri = createdConsole(Some(warehouse))
    uri.toString should startWith(s"vfs:///wh/$warehouse/wid/12/eid/")
    append(uri, rows(1L to 2L))

    readAll(URI.create(uri.toString)) shouldBe rows(1L to 2L)
  }

  "read" should "return the rows of one operator only when it is asked for one" in {
    val uri = createdConsole()
    val mixed = (1L to 10L).map(seq => row(seq, if (seq % 2 == 0) sink else udf))
    append(uri, mixed.take(5))
    append(uri, mixed.drop(5))

    read(uri, Some(udf), afterSeq = 0, limit = 100) shouldBe (mixed.filter(
      _.operatorId == udf
    ), false)
    read(uri, Some(sink), afterSeq = 4, limit = 100) shouldBe
      (mixed.filter(row => row.operatorId == sink && row.seq > 4), false)
    read(uri, Some("Filter-operator-3"), afterSeq = 0, limit = 100) shouldBe (Nil, false)
    read(uri, None, afterSeq = 0, limit = 100) shouldBe (mixed, false)
  }

  it should "return the rows after a seq, as many as the limit, and say whether more follow" in {
    val uri = createdConsole()
    (0 until 4).foreach(batch => append(uri, rows((batch * 5 + 1L) to (batch * 5 + 5L))))

    read(uri, None, afterSeq = 0, limit = 7) shouldBe (rows(1L to 7L), true)
    // The next page starts after the last row of the page before.
    read(uri, None, afterSeq = 7, limit = 7) shouldBe (rows(8L to 14L), true)
    read(uri, None, afterSeq = 14, limit = 7) shouldBe (rows(15L to 20L), false)
    read(uri, None, afterSeq = 20, limit = 7) shouldBe (Nil, false)
    // As many rows as the limit: no more follow.
    read(uri, None, afterSeq = 0, limit = 20) shouldBe (rows(1L to 20L), false)
    read(uri, None, afterSeq = 0, limit = 19) shouldBe (rows(1L to 19L), true)
    read(uri, None, afterSeq = 0, limit = Int.MaxValue) shouldBe (rows(1L to 20L), false)
    read(uri, None, afterSeq = 0, limit = 0) shouldBe (Nil, true)
    read(uri, None, afterSeq = 20, limit = 0) shouldBe (Nil, false)
  }

  it should "count the limit in the rows of the operator it is asked for" in {
    val uri = createdConsole()
    val mixed = (1L to 12L).map(seq => row(seq, if (seq % 3 == 0) sink else udf))
    append(uri, mixed)

    read(uri, Some(sink), afterSeq = 0, limit = 3) shouldBe
      (Seq(row(3, sink), row(6, sink), row(9, sink)), true)
    read(uri, Some(sink), afterSeq = 9, limit = 3) shouldBe (Seq(row(12, sink)), false)
  }

  it should "not read the data files whose rows all come before the rows it is asked for" in {
    val uri = createdConsole()
    append(uri, rows(1L to 5L))
    append(uri, rows(6L to 10L))
    // With the first file gone from the store, only a read that leaves it alone succeeds.
    deleteDataFile(uri, "console_1_")

    read(uri, None, afterSeq = 5, limit = 10) shouldBe (rows(6L to 10L), false)
    a[NotFoundException] should be thrownBy read(uri, None, afterSeq = 4, limit = 10)
  }

  it should "not read the data files that come after the page it is asked for" in {
    val uri = createdConsole()
    append(uri, rows(1L to 5L))
    append(uri, rows(6L to 10L))
    append(uri, rows(11L to 15L))
    // With the last file gone from the store, only a read that stops before it succeeds.
    deleteDataFile(uri, "console_11_")

    // Row 6 tells that more follow the first page, and row 10 that more follow the second.
    read(uri, None, afterSeq = 0, limit = 5) shouldBe (rows(1L to 5L), true)
    read(uri, None, afterSeq = 5, limit = 4) shouldBe (rows(6L to 9L), true)
    // Whether more follow row 10 is in the file that is gone.
    a[NotFoundException] should be thrownBy read(uri, None, afterSeq = 5, limit = 5)
  }

  it should "refuse a limit below 0" in {
    val uri = createdConsole()
    an[IllegalArgumentException] should be thrownBy read(uri, None, afterSeq = 0, limit = -1)
  }

  it should "return every row when a tidy deletes the files it planned to read" in {
    val uri = createdConsole()
    (1L to 3L).foreach(seq => append(uri, rows(Seq(seq))))
    var plans = 0

    read(
      uri,
      None,
      afterSeq = 0,
      limit = 10,
      afterPlan = () => {
        plans += 1
        if (plans == 1) tidy(uri, atEnd = true)
      }
    ) shouldBe (rows(1L to 3L), false)
    plans shouldBe 2
  }

  it should "take a table that is not there for an empty console" in {
    read(freshConsoleUri(), None, afterSeq = 0, limit = 10) shouldBe (Nil, false)
    read(freshConsoleUri(), Some(udf), afterSeq = 5, limit = 10) shouldBe (Nil, false)
  }

  "create" should "replace a stale table at the same execution" in {
    val uri = createdConsole()
    append(uri, rows(1L to 3L))

    create(uri)

    readAll(uri) shouldBe empty
  }

  "tidy" should "leave the rows as they were, in one data file" in {
    val uri = createdConsole()
    (1L to 60L).foreach(seq => append(uri, rows(Seq(seq), if (seq % 2 == 0) sink else udf)))
    val stored = readAll(uri)
    stored.map(_.seq) shouldBe (1L to 60L)
    dataFileCount(uri) shouldBe 60

    tidy(uri, atEnd = false)
    readAll(uri) shouldBe stored
    dataFileCount(uri) shouldBe 1

    append(uri, rows(Seq(61L)))
    tidy(uri, atEnd = true)
    readAll(uri) shouldBe stored ++ rows(Seq(61L))
    read(uri, Some(sink), afterSeq = 50, limit = 3) shouldBe
      (Seq(52L, 54L, 56L).map(row(_, sink)), true)
    dataFileCount(uri) shouldBe 1
  }

  "drop" should "remove the table, and do nothing where there is none" in {
    val uri = createdConsole()
    append(uri, rows(1L to 2L))

    drop(uri)

    DocumentFactory.documentExists(uri) shouldBe false
    readAll(uri) shouldBe empty
    noException should be thrownBy drop(uri)
  }

  "A write" should "fail with NoSuchExecutionTableException where there is no table, and create none" in {
    val uri = freshConsoleUri()
    intercept[NoSuchExecutionTableException](append(uri, rows(1L to 2L))).uri shouldBe uri
    intercept[NoSuchExecutionTableException](tidy(uri, atEnd = false)).uri shouldBe uri
    DocumentFactory.documentExists(uri) shouldBe false
  }

  "Every operation" should "pass on a catalog failure, not take it for a missing console" in {
    val uri = createdConsole(Some(warehouse))
    append(uri, rows(1L to 2L))
    val operations: Seq[(String, () => Any)] = Seq(
      "read" -> (() => readAll(uri)),
      "append" -> (() => append(uri, rows(3L to 4L))),
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
    readAll(uri) shouldBe rows(1L to 2L)
  }

  it should "refuse a URI that is not an execution's console URI, touching no table" in {
    val executionId = ExecutionIdentity(1)
    val otherTables = Seq(
      // The console table of one operator, as Texera made them before this store.
      VFSURIFactory.createConsoleMessagesURI(workflowId, executionId, OperatorIdentity(udf)),
      ExecutionLogStore.logUri(workflowId, executionId, None),
      VFSURIFactory.createRuntimeStatisticsURI(workflowId, executionId),
      new URI("vfs:///wid/12/eid/1/consoleMessages"),
      // A warehouse name that does not decode, so the URI would fall back to the default.
      new URI("vfs:///wh/user-1%2D7/wid/12/eid/1/consolemessages")
    )
    val operations: Seq[(String, URI => Any)] = Seq(
      "create" -> (uri => create(uri)),
      "append" -> (uri => append(uri, rows(1L to 2L))),
      "read" -> (uri => readAll(uri)),
      "tidy" -> (uri => tidy(uri, atEnd = true)),
      "drop" -> (uri => drop(uri))
    )
    for (
      (name, operation) <- operations;
      uri <- otherTables :+ new URI("file:///wid/12/eid/1/consolemessages")
    )
      withClue(s"$name($uri): ") {
        an[IllegalArgumentException] should be thrownBy operation(uri)
      }
    otherTables.foreach { uri =>
      withClue(s"$uri: ") { DocumentFactory.documentExists(uri) shouldBe false }
    }
  }
}
