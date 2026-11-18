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

import org.apache.iceberg.Table
import org.apache.iceberg.data.{GenericRecord, Record}
import org.apache.texera.amber.core.storage.result.iceberg.{
  IcebergAppender,
  IcebergReader,
  IcebergTidy
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}

import java.net.URI

/**
  * The statistics of one operator of an execution at one time. Counts, sizes and times are
  * totals since the execution started; the three times are in nanoseconds.
  *
  * @param operatorId the logical operator.
  * @param timeMs     when the sample was stored, in epoch milliseconds; the rows of one append
  *                   share it.
  * @param status     the operator's state, as its status code.
  */
final case class RuntimeStatisticsRow(
    operatorId: String,
    timeMs: Long,
    inputTupleCnt: Long,
    inputTupleSize: Long,
    outputTupleCnt: Long,
    outputTupleSize: Long,
    dataProcessingTime: Long,
    controlProcessingTime: Long,
    idleTime: Long,
    numWorkers: Int,
    status: Int
)

/**
  * Keeps each execution's runtime statistics table, one of its [[ExecutionTables]], at the URI
  * [[statisticsUri]] names (namespace `storage.iceberg.table.runtime-statistics-namespace`,
  * table `wid_<wid>_eid_<eid>_runtimestatistics`).
  */
object RuntimeStatisticsStore {

  private[storage] val schema: Schema = new Schema(
    new Attribute("operatorId", AttributeType.STRING),
    new Attribute("timeMs", AttributeType.LONG),
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

  /** The table's columns, which are the fields of [[RuntimeStatisticsRow]]. */
  val Columns: Set[String] = schema.getAttributeNames.toSet

  def statisticsUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createRuntimeStatisticsURI(wid, eid, warehouse)

  def create(uri: URI): Unit = {
    requireStatisticsUri(uri)
    DocumentFactory.createDocument(uri, schema)
  }

  /** Appends `rows` in one commit; no rows, no commit. */
  def append(uri: URI, rows: Seq[RuntimeStatisticsRow]): Unit = {
    requireStatisticsUri(uri)
    if (rows.nonEmpty) {
      val table = existingTable(uri)
      IcebergAppender.append(table, rows.map(toRecord(table, _)), "statistics")
    }
  }

  /**
    * The rows in the order they were appended. Only `columns` are read from the table; every
    * other field of a row is 0 or empty.
    *
    * Empty when the table has no `timeMs` column: that is a statistics table that was not
    * written through this store, with other columns under the same name.
    */
  def read(uri: URI, columns: Set[String] = Columns): Seq[RuntimeStatisticsRow] =
    read(uri, columns, afterPlan = () => ())

  /** [[read]], with the hook `afterPlan` that [[IcebergReader.read]] gives tests. */
  private[storage] def read(
      uri: URI,
      columns: Set[String],
      afterPlan: () => Unit
  ): Seq[RuntimeStatisticsRow] = {
    requireStatisticsUri(uri)
    require(
      columns.subsetOf(Columns),
      s"runtime statistics have no column ${(columns -- Columns).mkString(", ")}"
    )
    DocumentFactory
      .icebergTableOf(uri)
      .filter(_.schema().findField("timeMs") != null)
      .map { table =>
        IcebergReader.read(table, columns.toSeq, afterPlan = afterPlan)(_.map(toRow).toList)
      }
      .getOrElse(Nil)
  }

  /** Tidies the table, as [[ExecutionLogStore.tidy]] tidies the log. */
  def tidy(uri: URI, atEnd: Boolean): Unit = {
    requireStatisticsUri(uri)
    IcebergTidy.tidy(existingTable(uri), atEnd)
  }

  def drop(uri: URI): Unit = {
    requireStatisticsUri(uri)
    DocumentFactory.dropTable(uri)
  }

  private def requireStatisticsUri(uri: URI): Unit = {
    val components = VFSURIFactory.decodeURI(uri)
    // An extra segment would name another table, so the URI must equal the one rebuilt from it.
    require(
      components.resourceType == VFSResourceType.RUNTIME_STATISTICS &&
        uri == statisticsUri(components.workflowId, components.executionId, components.warehouse),
      s"not a runtime statistics URI: $uri"
    )
  }

  private def existingTable(uri: URI): Table =
    DocumentFactory.icebergTableOf(uri).getOrElse(throw new NoSuchExecutionTableException(uri))

  private def toRecord(table: Table, row: RuntimeStatisticsRow): Record = {
    val record = GenericRecord.create(table.schema())
    record.setField("operatorId", row.operatorId)
    record.setField("timeMs", Long.box(row.timeMs))
    record.setField("inputTupleCnt", Long.box(row.inputTupleCnt))
    record.setField("inputTupleSize", Long.box(row.inputTupleSize))
    record.setField("outputTupleCnt", Long.box(row.outputTupleCnt))
    record.setField("outputTupleSize", Long.box(row.outputTupleSize))
    record.setField("dataProcessingTime", Long.box(row.dataProcessingTime))
    record.setField("controlProcessingTime", Long.box(row.controlProcessingTime))
    record.setField("idleTime", Long.box(row.idleTime))
    record.setField("numWorkers", Int.box(row.numWorkers))
    record.setField("status", Int.box(row.status))
    record
  }

  /** A column that was not read, or holds no value, comes out as 0 or empty. */
  private def toRow(record: Record): RuntimeStatisticsRow = {
    def long(column: String): Long = Option(record.getField(column)).fold(0L)(_.asInstanceOf[Long])
    def int(column: String): Int = Option(record.getField(column)).fold(0)(_.asInstanceOf[Int])
    RuntimeStatisticsRow(
      operatorId = Option(record.getField("operatorId")).fold("")(_.asInstanceOf[String]),
      timeMs = long("timeMs"),
      inputTupleCnt = long("inputTupleCnt"),
      inputTupleSize = long("inputTupleSize"),
      outputTupleCnt = long("outputTupleCnt"),
      outputTupleSize = long("outputTupleSize"),
      dataProcessingTime = long("dataProcessingTime"),
      controlProcessingTime = long("controlProcessingTime"),
      idleTime = long("idleTime"),
      numWorkers = int("numWorkers"),
      status = int("status")
    )
  }
}
