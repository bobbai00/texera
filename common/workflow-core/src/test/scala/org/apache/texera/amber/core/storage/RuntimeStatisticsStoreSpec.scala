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

import org.apache.iceberg.exceptions.ServiceUnavailableException
import org.apache.texera.amber.core.storage.RuntimeStatisticsStore._
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.sql.Timestamp
import java.util.concurrent.atomic.AtomicLong

/** Specs for [[RuntimeStatisticsStore]] on Iceberg's JDBC catalog (see [[EmbeddedJdbcCatalog]]). */
@NonParallelTest
class RuntimeStatisticsStoreSpec extends AnyFlatSpec with Matchers with EmbeddedJdbcCatalog {

  private val workflowId = WorkflowIdentity(12)

  // Executions below 100 are left to the specs that name one.
  private val nextExecutionId = new AtomicLong(100)

  private def freshStatisticsUri(warehouse: Option[String] = None): URI =
    statisticsUri(workflowId, ExecutionIdentity(nextExecutionId.getAndIncrement()), warehouse)

  private def createdStatistics(warehouse: Option[String] = None): URI = {
    val uri = freshStatisticsUri(warehouse)
    create(uri)
    uri
  }

  private val startMs = 1794873600000L

  /** The row of `operator` at commit `tick`: every column holds a value of its own. */
  private def row(operator: String, tick: Int): RuntimeStatisticsRow =
    RuntimeStatisticsRow(
      operatorId = operator,
      timeMs = startMs + tick * 30000L,
      inputTupleCnt = 1000L * tick + 1,
      inputTupleSize = 1000L * tick + 2,
      outputTupleCnt = 1000L * tick + 3,
      outputTupleSize = 1000L * tick + 4,
      dataProcessingTime = 1000L * tick + 5,
      controlProcessingTime = 1000L * tick + 6,
      idleTime = 1000L * tick + 7,
      numWorkers = tick + 8,
      status = tick + 9
    )

  private val operators = Seq("CSVFileScan-operator-1", "Filter-operator-2", "Sort-operator-3")

  private def tickRows(tick: Int): Seq[RuntimeStatisticsRow] = operators.map(row(_, tick))

  private def dataFileCount(uri: URI): Int =
    DocumentFactory
      .icebergTableOf(uri)
      .get
      .currentSnapshot()
      .summary()
      .get("total-data-files")
      .toInt

  // The columns of a statistics table before this store: its time was a timestamp.
  private val earlierSchema = new Schema(
    new Attribute("operatorId", AttributeType.STRING),
    new Attribute("time", AttributeType.TIMESTAMP),
    new Attribute("inputTupleCnt", AttributeType.LONG),
    new Attribute("inputTupleSize", AttributeType.LONG),
    new Attribute("outputTupleCnt", AttributeType.LONG),
    new Attribute("outputTupleSize", AttributeType.LONG),
    new Attribute("dataProcessingTime", AttributeType.LONG),
    new Attribute("controlProcessingTime", AttributeType.LONG),
    new Attribute("idleTime", AttributeType.LONG),
    new Attribute("numWorkers", AttributeType.INTEGER),
    new Attribute("status", AttributeType.INTEGER)
  )

  /** A statistics table as Texera made it before this store, with a row in it. */
  private def statisticsOfAnEarlierVersion(): URI = {
    val uri = freshStatisticsUri()
    val writer = DocumentFactory
      .createDocument(uri, earlierSchema)
      .asInstanceOf[VirtualDocument[Tuple]]
      .writer("runtime_statistics")
    writer.open()
    writer.putOne(
      Tuple(
        earlierSchema,
        Array[Any]("Filter-operator-2", new Timestamp(startMs), 1L, 2L, 3L, 4L, 5L, 6L, 7L, 8, 9)
      )
    )
    writer.close()
    uri
  }

  "The statistics schema" should "hold a row's fields in order, with the time in epoch milliseconds" in {
    schema.getAttributeNames shouldBe List(
      "operatorId",
      "timeMs",
      "inputTupleCnt",
      "inputTupleSize",
      "outputTupleCnt",
      "outputTupleSize",
      "dataProcessingTime",
      "controlProcessingTime",
      "idleTime",
      "numWorkers",
      "status"
    )
    schema.getAttribute("operatorId").getType shouldBe AttributeType.STRING
    schema.getAttribute("timeMs").getType shouldBe AttributeType.LONG
    Seq("numWorkers", "status").foreach(
      schema.getAttribute(_).getType shouldBe AttributeType.INTEGER
    )
    Columns shouldBe schema.getAttributeNames.toSet
  }

  "statisticsUri" should "name the execution's statistics table, in its warehouse when it has one" in {
    statisticsUri(workflowId, ExecutionIdentity(345), None) shouldBe
      new URI("vfs:///wid/12/eid/345/runtimestatistics")
    statisticsUri(workflowId, ExecutionIdentity(345), Some(warehouse)) shouldBe
      new URI(s"vfs:///wh/$warehouse/wid/12/eid/345/runtimestatistics")
  }

  "append and read" should "keep every column of a row" in {
    val uri = createdStatistics()
    val rows = Seq(
      row("Filter-operator-2", tick = 1),
      // The largest values a column takes, and none at all.
      RuntimeStatisticsRow(
        "Grüße 日本語 😀",
        Long.MaxValue,
        Long.MaxValue,
        Long.MaxValue,
        Long.MaxValue,
        Long.MaxValue,
        Long.MaxValue,
        Long.MaxValue,
        Long.MaxValue,
        Int.MaxValue,
        Int.MaxValue
      ),
      RuntimeStatisticsRow("", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    )

    append(uri, rows)

    read(uri) shouldBe rows
  }

  it should "return the rows in the order they were appended" in {
    val uri = createdStatistics()
    (1 to 3).foreach(tick => append(uri, tickRows(tick)))

    read(uri) shouldBe (1 to 3).flatMap(tickRows)
  }

  it should "commit nothing for no rows" in {
    val uri = createdStatistics()
    append(uri, Nil)

    DocumentFactory.icebergTableOf(uri).get.currentSnapshot() shouldBe null
    read(uri) shouldBe empty
  }

  it should "read and write statistics whose URI names a warehouse" in {
    val uri = createdStatistics(Some(warehouse))
    uri.toString should startWith(s"vfs:///wh/$warehouse/wid/12/eid/")
    append(uri, tickRows(1))

    read(URI.create(uri.toString)) shouldBe tickRows(1)
  }

  "read" should "read only the columns it is asked for, and leave the others 0 or empty" in {
    val uri = createdStatistics()
    (1 to 2).foreach(tick => append(uri, tickRows(tick)))
    val full = (1 to 2).flatMap(tickRows)

    read(uri, Set("operatorId", "dataProcessingTime", "controlProcessingTime")) shouldBe full.map {
      row =>
        RuntimeStatisticsRow(
          row.operatorId,
          0,
          0,
          0,
          0,
          0,
          row.dataProcessingTime,
          row.controlProcessingTime,
          0,
          0,
          0
        )
    }
    read(uri, Set("timeMs", "numWorkers")) shouldBe full.map { row =>
      RuntimeStatisticsRow("", row.timeMs, 0, 0, 0, 0, 0, 0, 0, row.numWorkers, 0)
    }
    read(uri, Columns) shouldBe full
  }

  it should "refuse a column the statistics do not have" in {
    val uri = createdStatistics()
    append(uri, tickRows(1))

    val thrown = intercept[IllegalArgumentException](read(uri, Set("operatorId", "time")))
    thrown.getMessage should include("no column time")
  }

  it should "return every row when a tidy deletes the files it planned to read" in {
    val uri = createdStatistics()
    (1 to 3).foreach(tick => append(uri, tickRows(tick)))
    var plans = 0

    read(
      uri,
      Columns,
      afterPlan = () => {
        plans += 1
        if (plans == 1) tidy(uri, atEnd = true)
      }
    ) shouldBe (1 to 3).flatMap(tickRows)
    plans shouldBe 2
  }

  it should "take a table that is not there for no statistics" in {
    read(freshStatisticsUri()) shouldBe empty
    read(freshStatisticsUri(), Set("operatorId")) shouldBe empty
  }

  it should "take a statistics table of an earlier version for no statistics" in {
    val uri = statisticsOfAnEarlierVersion()

    read(uri) shouldBe empty
    read(uri, Set("operatorId", "dataProcessingTime", "controlProcessingTime")) shouldBe empty
    // The table is there, with its row: it is the store that passes it over.
    DocumentFactory.openDocument(uri)._1.getCount shouldBe 1
  }

  "create" should "replace a stale table at the same execution, also one of an earlier version" in {
    val uri = statisticsOfAnEarlierVersion()
    create(uri)
    read(uri) shouldBe empty
    append(uri, tickRows(1))
    read(uri) shouldBe tickRows(1)

    create(uri)
    read(uri) shouldBe empty
  }

  "tidy" should "leave the rows as they were, in order, in one data file" in {
    val uri = createdStatistics()
    (1 to 60).foreach(tick => append(uri, tickRows(tick)))
    val rows = (1 to 60).flatMap(tickRows)
    dataFileCount(uri) shouldBe 60

    tidy(uri, atEnd = false)
    read(uri) shouldBe rows
    dataFileCount(uri) shouldBe 1

    append(uri, tickRows(61))
    tidy(uri, atEnd = true)
    read(uri) shouldBe rows ++ tickRows(61)
    dataFileCount(uri) shouldBe 1
  }

  "drop" should "remove the table, and do nothing where there is none" in {
    val uri = createdStatistics()
    append(uri, tickRows(1))

    drop(uri)

    DocumentFactory.documentExists(uri) shouldBe false
    read(uri) shouldBe empty
    noException should be thrownBy drop(uri)
  }

  "A write" should "fail with NoSuchExecutionTableException where there is no table, and create none" in {
    val uri = freshStatisticsUri()
    intercept[NoSuchExecutionTableException](append(uri, tickRows(1))).uri shouldBe uri
    intercept[NoSuchExecutionTableException](tidy(uri, atEnd = false)).uri shouldBe uri
    DocumentFactory.documentExists(uri) shouldBe false
  }

  "Every operation" should "pass on a catalog failure, not take it for missing statistics" in {
    val uri = createdStatistics(Some(warehouse))
    append(uri, tickRows(1))
    val operations: Seq[(String, () => Any)] = Seq(
      "read" -> (() => read(uri)),
      "append" -> (() => append(uri, tickRows(2))),
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
    read(uri) shouldBe tickRows(1)
  }

  it should "refuse a URI that is not an execution's statistics URI, touching no table" in {
    val executionId = ExecutionIdentity(1)
    val otherTables = Seq(
      ExecutionLogStore.logUri(workflowId, executionId, None),
      VFSURIFactory.createConsoleMessagesURI(workflowId, executionId, None),
      // Segments the store did not write would address another table in its namespace.
      new URI("vfs:///wid/12/eid/1/opid/op/runtimestatistics"),
      new URI("vfs:///wid/12/eid/1/runtimeStatistics"),
      // A warehouse name that does not decode, so the URI would fall back to the default.
      new URI("vfs:///wh/user-1%2D7/wid/12/eid/1/runtimestatistics")
    )
    val operations: Seq[(String, URI => Any)] = Seq(
      "create" -> (uri => create(uri)),
      "append" -> (uri => append(uri, tickRows(1))),
      "read" -> (uri => read(uri)),
      "tidy" -> (uri => tidy(uri, atEnd = true)),
      "drop" -> (uri => drop(uri))
    )
    for (
      (name, operation) <- operations;
      uri <- otherTables :+ new URI("file:///wid/12/eid/1/runtimestatistics")
    )
      withClue(s"$name($uri): ") {
        an[IllegalArgumentException] should be thrownBy operation(uri)
      }
    otherTables.foreach { uri =>
      withClue(s"$uri: ") { DocumentFactory.documentExists(uri) shouldBe false }
    }
  }
}
