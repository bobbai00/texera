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
import org.apache.iceberg.expressions.{Expression, Expressions}
import org.apache.texera.amber.core.storage.result.iceberg.{
  IcebergAppender,
  IcebergReader,
  IcebergTidy
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}

import java.net.URI

/**
  * One console message of an execution, whole.
  *
  * @param seq        1, 2, 3, … in the order the engine received the execution's messages.
  * @param timeMs     the message's own time, in epoch milliseconds.
  * @param operatorId the logical operator the message is from.
  * @param msgType    the name of the message's `ConsoleMessageType`.
  */
final case class ConsoleRow(
    seq: Long,
    timeMs: Long,
    operatorId: String,
    workerId: String,
    msgType: String,
    source: String,
    title: String,
    message: String
)

/**
  * Keeps each execution's console output in the lake: one Iceberg table per execution, for all
  * its operators, in the warehouse the execution writes into, at the URI [[consoleUri]] names
  * (namespace `storage.iceberg.table.console-messages-namespace`, table
  * `wid_<wid>_eid_<eid>_consolemessages`). The engine that runs the execution is the table's
  * one writer.
  *
  * Every method takes only a URI [[consoleUri]] could have built, and refuses any other. To a
  * read, a table that is not there is empty; to a write it is a
  * [[NoSuchExecutionTableException]]. Any other failure of the catalog or the object store is
  * thrown as it is.
  */
object ConsoleMessageStore {

  private[storage] val schema: Schema = new Schema(
    new Attribute("seq", AttributeType.LONG),
    new Attribute("timeMs", AttributeType.LONG),
    new Attribute("operatorId", AttributeType.STRING),
    new Attribute("workerId", AttributeType.STRING),
    new Attribute("msgType", AttributeType.STRING),
    new Attribute("source", AttributeType.STRING),
    new Attribute("title", AttributeType.STRING),
    new Attribute("message", AttributeType.STRING)
  )

  /** The console table of execution `eid` of workflow `wid`, in `warehouse` (None: the default). */
  def consoleUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createConsoleMessagesURI(wid, eid, warehouse)

  /**
    * Makes the console table, empty. A table already at this URI can only be stale, since an
    * execution id is run once, so it is replaced.
    */
  def create(uri: URI): Unit = {
    requireConsoleUri(uri)
    DocumentFactory.createDocument(uri, schema)
  }

  /**
    * Appends `rows` in one commit; no rows, no commit. Their `seq` rises, within an append and
    * from one append to the next.
    *
    * An append that fails may have landed all the same, when the catalog's answer was lost.
    * Appending its rows again is safe, alone or with later ones: [[read]] takes a row whose
    * `seq` is not above those appended before it for a repeat.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
    */
  def append(uri: URI, rows: Seq[ConsoleRow]): Unit = {
    requireConsoleUri(uri)
    require(
      rows.zip(rows.drop(1)).forall { case (earlier, later) => earlier.seq < later.seq },
      "the rows of an append to an execution's console need a rising seq"
    )
    if (rows.nonEmpty) {
      val table = existingTable(uri)
      IcebergAppender.append(table, rows.map(toRecord(table, _)), s"console_${rows.head.seq}")
    }
  }

  /**
    * The first `limit` rows after row `afterSeq`, by `seq`, of `operatorId` or of all operators
    * (None), and whether more such rows follow them. One row per `seq`. Empty when the table
    * does not exist.
    *
    * A page does not cost the whole console: the data files whose rows all come at or before
    * `afterSeq` are not read, and the read stops once it has the page.
    */
  def read(
      uri: URI,
      operatorId: Option[String],
      afterSeq: Long,
      limit: Int
  ): (Seq[ConsoleRow], Boolean) = read(uri, operatorId, afterSeq, limit, afterPlan = () => ())

  /**
    * [[read]], running `afterPlan` between each plan of the table's files and the read of them,
    * the window in which a tidy can delete them. Tests tidy there.
    */
  private[storage] def read(
      uri: URI,
      operatorId: Option[String],
      afterSeq: Long,
      limit: Int,
      afterPlan: () => Unit
  ): (Seq[ConsoleRow], Boolean) = {
    requireConsoleUri(uri)
    require(limit >= 0, s"a read of an execution's console needs a limit of 0 or more, not $limit")
    val after = Expressions.greaterThan[java.lang.Long]("seq", afterSeq)
    val wanted = operatorId.fold[Expression](after) { operator =>
      Expressions.and(after, Expressions.equal("operatorId", operator))
    }
    DocumentFactory
      .icebergTableOf(uri)
      .map { table =>
        IcebergReader.read(table, schema.getAttributeNames, wanted, afterPlan) { records =>
          // Rows come in the order they were appended, which is the order of their seq. So
          // a row whose seq is not above those before it is a repeat, of an append that was
          // tried again and landed twice. And the read can stop at one row more than the
          // limit, which tells whether more follow, with the rest of the console unread.
          var last = afterSeq
          val page = records
            .map(toRow)
            .filter { row =>
              val next = row.seq > last && operatorId.forall(_ == row.operatorId)
              if (next) last = row.seq
              next
            }
            .take(if (limit == Int.MaxValue) limit else limit + 1)
            .toList
          (page.take(limit), page.size > limit)
        }
      }
      .getOrElse((Nil, false))
  }

  /**
    * Tidies the table (see [[IcebergTidy.tidy]]). For the table's writer alone, between its
    * appends, and with `atEnd` once it has appended its last row.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
    */
  def tidy(uri: URI, atEnd: Boolean): Unit = {
    requireConsoleUri(uri)
    IcebergTidy.tidy(existingTable(uri), atEnd)
  }

  /** Drops the table with its rows; nothing happens when there is no table. */
  def drop(uri: URI): Unit = {
    requireConsoleUri(uri)
    DocumentFactory.dropTable(uri)
  }

  private def requireConsoleUri(uri: URI): Unit = {
    val components = VFSURIFactory.decodeURI(uri)
    // Rebuilding the URI from what it decodes to refuses extra segments, which would address a
    // different table name in the console namespace: one operator's console table, say.
    require(
      components.resourceType == VFSResourceType.CONSOLE_MESSAGES &&
        uri == consoleUri(components.workflowId, components.executionId, components.warehouse),
      s"not the URI of an execution's console messages: $uri"
    )
  }

  private def existingTable(uri: URI): Table =
    DocumentFactory.icebergTableOf(uri).getOrElse(throw new NoSuchExecutionTableException(uri))

  private def toRecord(table: Table, row: ConsoleRow): Record = {
    val record = GenericRecord.create(table.schema())
    record.setField("seq", Long.box(row.seq))
    record.setField("timeMs", Long.box(row.timeMs))
    record.setField("operatorId", row.operatorId)
    record.setField("workerId", row.workerId)
    record.setField("msgType", row.msgType)
    record.setField("source", row.source)
    record.setField("title", row.title)
    record.setField("message", row.message)
    record
  }

  /** A column that holds no value comes out as 0 or empty. */
  private def toRow(record: Record): ConsoleRow = {
    def long(column: String): Long = Option(record.getField(column)).fold(0L)(_.asInstanceOf[Long])
    def text(column: String): String =
      Option(record.getField(column)).fold("")(_.asInstanceOf[String])
    ConsoleRow(
      seq = long("seq"),
      timeMs = long("timeMs"),
      operatorId = text("operatorId"),
      workerId = text("workerId"),
      msgType = text("msgType"),
      source = text("source"),
      title = text("title"),
      message = text("message")
    )
  }
}
