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
  * totals since the execution started.
  *
  * @param operatorId            the logical operator.
  * @param timeMs                when the sample was stored, in epoch milliseconds; the rows of
  *                              one append share it.
  * @param dataProcessingTime    nanoseconds spent processing data.
  * @param controlProcessingTime nanoseconds spent processing control messages.
  * @param idleTime              nanoseconds spent idle.
  * @param status                the operator's state, as its status code.
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
  * Keeps each execution's runtime statistics in the lake: one Iceberg table per execution, in
  * the warehouse the execution writes into, at the URI [[statisticsUri]] names (namespace
  * `storage.iceberg.table.runtime-statistics-namespace`, table
  * `wid_<wid>_eid_<eid>_runtimestatistics`). The engine that runs the execution is the table's
  * one writer.
  *
  * Every method takes only a URI [[statisticsUri]] could have built, and refuses any other. To
  * a read, a table that is not there is empty; to a write it is a
  * [[NoSuchExecutionTableException]]. Any other failure of the catalog or the object store is
  * thrown as it is.
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

  /** The statistics table of execution `eid` of workflow `wid`, in `warehouse` (None: the default). */
  def statisticsUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createRuntimeStatisticsURI(wid, eid, warehouse)

  /**
    * Makes the statistics table, empty. A table already at this URI can only be stale, since an
    * execution id is run once, so it is replaced.
    */
  def create(uri: URI): Unit = {
    requireStatisticsUri(uri)
    DocumentFactory.createDocument(uri, schema)
  }

  /**
    * Appends `rows` in one commit; no rows, no commit.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
    */
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
    * Empty when the table does not exist, and when it has no `timeMs` column: that is a
    * statistics table from before statistics were stored through this store, with other
    * columns under the same name.
    */
  def read(uri: URI, columns: Set[String] = Columns): Seq[RuntimeStatisticsRow] =
    read(uri, columns, afterPlan = () => ())

  /**
    * [[read]], running `afterPlan` between each plan of the table's files and the read of them,
    * the window in which a tidy can delete them. Tests tidy there.
    */
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

  /**
    * Tidies the table (see [[IcebergTidy.tidy]]). For the table's writer alone, between its
    * appends, and with `atEnd` once it has appended its last row.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
    */
  def tidy(uri: URI, atEnd: Boolean): Unit = {
    requireStatisticsUri(uri)
    IcebergTidy.tidy(existingTable(uri), atEnd)
  }

  /** Drops the table with its rows; nothing happens when there is no table. */
  def drop(uri: URI): Unit = {
    requireStatisticsUri(uri)
    DocumentFactory.dropTable(uri)
  }

  private def requireStatisticsUri(uri: URI): Unit = {
    val components = VFSURIFactory.decodeURI(uri)
    // Rebuilding the URI from what it decodes to refuses extra segments, which would address a
    // different table name in the statistics namespace.
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
