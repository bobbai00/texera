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

import com.fasterxml.jackson.databind.JsonNode
import org.apache.iceberg.Table
import org.apache.iceberg.data.{GenericRecord, Record}
import org.apache.texera.amber.core.storage.result.ResultSchema.executionLogSchema
import org.apache.texera.amber.core.storage.result.iceberg.{
  IcebergAppender,
  IcebergReader,
  IcebergTidy
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.util.JSONUtils.objectMapper

import java.net.URI

/**
  * One row of an execution's log: a change of the run's state. Made with
  * [[ExecutionLogEntry.state]].
  *
  * @param seq    1, 2, 3, … in the order the engine made the rows.
  * @param timeMs when the engine made the row, in epoch milliseconds on its unit's clock.
  * @param kind   [[ExecutionLogStore.StateKind]], the one kind of row a log holds.
  * @param state  the state the run changed to, one of [[ExecutionLogStore.States]].
  * @param detail JSON that says why the state changed:
  *               `{"reason": "…", "errors": [{"type", "timeMs", "message", "details",
  *               "operatorId", "workerId"}]}` with either key or both, and None when the row
  *               says neither.
  */
final case class ExecutionLogEntry(
    seq: Long,
    timeMs: Long,
    kind: String,
    state: Option[String],
    detail: Option[String]
) {

  /**
    * Why the state changed, in at most [[ExecutionLogStore.MaxReasonLength]] characters: the
    * reason the row gives, else the message of its first error. None when it gives neither.
    */
  def reason: Option[String] = detail.flatMap(ExecutionLogDetail.reason)
}

object ExecutionLogEntry {

  def state(
      seq: Long,
      timeMs: Long,
      state: String,
      reason: Option[String] = None,
      errors: Seq[WorkflowFatalError] = Nil
  ): ExecutionLogEntry =
    ExecutionLogEntry(
      seq,
      timeMs,
      ExecutionLogStore.StateKind,
      Some(state),
      ExecutionLogDetail.of(reason.filter(_.nonEmpty), errors)
    )
}

/**
  * The newest state of an execution, as the properties of its log table repeat it.
  *
  * @param state       the state of the newest row; None before the first one.
  * @param stateSeq    that row's `seq`; 0 before the first one.
  * @param stateTimeMs that row's `timeMs`; 0 before the first one.
  * @param reason      that row's [[ExecutionLogEntry.reason]].
  * @param beatMs      the clock of the engine's unit, in epoch milliseconds, when the engine
  *                    last wrote to the log or showed there that it is alive.
  * @param beatEveryMs how often the engine shows that it is alive, in milliseconds.
  */
final case class ExecutionLabel(
    state: Option[String],
    stateSeq: Long,
    stateTimeMs: Long,
    reason: Option[String],
    beatMs: Long,
    beatEveryMs: Long
) {

  def ended: Boolean = state.exists(ExecutionLogStore.EndStates.contains)
}

private object ExecutionLogDetail {

  def of(reason: Option[String], errors: Seq[WorkflowFatalError]): Option[String] =
    Option.when(reason.nonEmpty || errors.nonEmpty) {
      val detail = objectMapper.createObjectNode()
      reason.foreach(detail.put("reason", _))
      if (errors.nonEmpty) {
        val array = detail.putArray("errors")
        errors.foreach { error =>
          array
            .addObject()
            .put("type", error.`type`.name)
            .put("timeMs", error.timestamp.seconds * 1000 + error.timestamp.nanos / 1000000)
            .put("message", error.message)
            .put("details", error.details)
            .put("operatorId", error.operatorId)
            .put("workerId", error.workerId)
        }
      }
      objectMapper.writeValueAsString(detail)
    }

  def reason(detail: String): Option[String] = {
    val node = objectMapper.readTree(detail)
    text(node.path("reason"))
      .orElse(text(node.path("errors").path(0).path("message")))
      .map(cut)
  }

  private def text(node: JsonNode): Option[String] = Option(node.textValue()).filter(_.nonEmpty)

  private def cut(reason: String): String =
    if (reason.length <= ExecutionLogStore.MaxReasonLength) reason
    else {
      // Never the first half alone of a character that takes two chars.
      val last = ExecutionLogStore.MaxReasonLength - 1
      reason.substring(0, if (Character.isHighSurrogate(reason.charAt(last))) last else last + 1)
    }
}

/**
  * Keeps each execution's log table, one of its [[ExecutionTables]], at the URI [[logUri]] names
  * (table `wid_<wid>_eid_<eid>_executionlog` in the execution's namespace, `execution-<eid>`).
  *
  * The engine appends a row for every change of the run's state (see [[ExecutionLogEntry]]), and
  * the commit that appends a row also sets the label: table properties that repeat the newest
  * state (see [[ExecutionLabel]]). So the state is read with one load of the table, and no
  * reader sees a label without its row. Between its appends the engine refreshes one of the
  * properties, the beat, which shows that it is alive.
  */
object ExecutionLogStore {

  val StateKind = "state"

  /** The states a log records, as the `state` of its rows. */
  val States: Seq[String] = Seq("READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "KILLED")

  /** The states an execution ends in. */
  val EndStates: Seq[String] = Seq("COMPLETED", "FAILED", "KILLED")

  // The label's table properties.
  val StateProperty = "texera.execution.state"
  val StateSeqProperty = "texera.execution.state-seq"
  val StateTimeProperty = "texera.execution.state-time-ms"
  val ReasonProperty = "texera.execution.reason"
  val BeatProperty = "texera.execution.beat-ms"
  val BeatEveryProperty = "texera.execution.beat-every-ms"

  /** The most characters of a reason that a row's [[ExecutionLogEntry.reason]] and the label keep. */
  val MaxReasonLength = 500

  def logUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createExecutionLogURI(wid, eid, warehouse)

  /**
    * Makes the log table, empty, with a first beat at `nowMs` and `beatEveryMs` in its label, in
    * one commit: no reader sees the table without its beat.
    */
  def create(uri: URI, nowMs: Long, beatEveryMs: Long): Unit = {
    requireLogUri(uri)
    DocumentFactory.createDocument(
      uri,
      executionLogSchema,
      Map(BeatProperty -> nowMs.toString, BeatEveryProperty -> beatEveryMs.toString)
    )
  }

  /**
    * Appends `entries`, whose `seq` rises, in one commit. The same commit sets the beat to
    * `nowMs` and the label's state to the last of them.
    *
    * An append that fails may have landed all the same, when the catalog's answer was lost.
    * Appending the entries again is safe: [[read]] returns one row per `seq`.
    */
  def append(uri: URI, entries: Seq[ExecutionLogEntry], nowMs: Long): Unit = {
    requireLogUri(uri)
    require(entries.nonEmpty, "an append to an execution log needs a row")
    require(
      entries.zip(entries.drop(1)).forall { case (earlier, later) => earlier.seq < later.seq },
      s"the rows of an append to an execution log need a rising seq, not " +
        entries.map(_.seq).mkString(", ")
    )
    entries.foreach(requireLogRow)
    val table = existingTable(uri)
    val newest = entries.last
    IcebergAppender.append(
      table,
      entries.map(toRecord(table, _)),
      s"${StateKind}_${entries.head.seq}",
      Map(
        StateProperty -> newest.state.get,
        StateSeqProperty -> newest.seq.toString,
        StateTimeProperty -> newest.timeMs.toString,
        ReasonProperty -> newest.reason.getOrElse(""),
        BeatProperty -> nowMs.toString
      )
    )
  }

  /** Sets the beat to `nowMs`, in a commit that adds no snapshot. */
  def beat(uri: URI, nowMs: Long): Unit = {
    requireLogUri(uri)
    IcebergAppender.setProperties(existingTable(uri), Map(BeatProperty -> nowMs.toString))
  }

  def label(uri: URI): Option[ExecutionLabel] = {
    requireLogUri(uri)
    DocumentFactory.icebergTableOf(uri).map { table =>
      val properties = table.properties()
      def number(property: String): Long =
        Option(properties.get(property)).flatMap(_.toLongOption).getOrElse(0L)
      ExecutionLabel(
        state = Option(properties.get(StateProperty)),
        stateSeq = number(StateSeqProperty),
        stateTimeMs = number(StateTimeProperty),
        reason = Option(properties.get(ReasonProperty)).filter(_.nonEmpty),
        beatMs = number(BeatProperty),
        beatEveryMs = number(BeatEveryProperty)
      )
    }
  }

  /** The rows in the order of their `seq`, one per `seq`. */
  def read(uri: URI): Seq[ExecutionLogEntry] = read(uri, afterPlan = () => ())

  /** [[read]], with the hook `afterPlan` that [[IcebergReader.read]] gives tests. */
  private[storage] def read(uri: URI, afterPlan: () => Unit): Seq[ExecutionLogEntry] = {
    requireLogUri(uri)
    DocumentFactory
      .icebergTableOf(uri)
      .map { table =>
        // An append that was tried again can have landed twice: the first row of a seq counts.
        IcebergReader.read(table, executionLogSchema.getAttributeNames, afterPlan = afterPlan)(
          _.map(toEntry).toList.distinctBy(_.seq).sortBy(_.seq)
        )
      }
      .getOrElse(Nil)
  }

  /**
    * Tidies the table (see [[IcebergTidy.tidy]]). For the table's writer alone, between its
    * appends, and with `atEnd` once it has appended its last row.
    */
  def tidy(uri: URI, atEnd: Boolean): Unit = {
    requireLogUri(uri)
    IcebergTidy.tidy(existingTable(uri), atEnd)
  }

  def drop(uri: URI): Unit = {
    requireLogUri(uri)
    DocumentFactory.dropTable(uri)
  }

  private def requireLogUri(uri: URI): Unit = {
    val components = VFSURIFactory.decodeURI(uri)
    // An extra segment would name another table, so the URI must equal the one rebuilt from it.
    require(
      components.resourceType == VFSResourceType.EXECUTION_LOG &&
        uri == logUri(components.workflowId, components.executionId, components.warehouse),
      s"not an execution log URI: $uri"
    )
  }

  private def requireLogRow(entry: ExecutionLogEntry): Unit =
    require(
      entry.kind == StateKind && entry.state.exists(States.contains),
      s"row ${entry.seq} is not a state row with one of the states ${States.mkString(", ")}: " +
        s"its kind is '${entry.kind}' and its state ${entry.state}"
    )

  private def existingTable(uri: URI): Table =
    DocumentFactory.icebergTableOf(uri).getOrElse(throw new NoSuchExecutionTableException(uri))

  private def toRecord(table: Table, entry: ExecutionLogEntry): Record = {
    val record = GenericRecord.create(table.schema())
    record.setField("seq", Long.box(entry.seq))
    record.setField("timeMs", Long.box(entry.timeMs))
    record.setField("kind", entry.kind)
    record.setField("state", entry.state.orNull)
    record.setField("detail", entry.detail.orNull)
    record
  }

  private def toEntry(record: Record): ExecutionLogEntry = {
    def required[T](column: String): T =
      Option(record.getField(column))
        .getOrElse(throw new IllegalStateException(s"an execution log row has no $column"))
        .asInstanceOf[T]
    ExecutionLogEntry(
      seq = required[Long]("seq"),
      timeMs = required[Long]("timeMs"),
      kind = required[String]("kind"),
      state = Option(record.getField("state")).map(_.asInstanceOf[String]),
      detail = Option(record.getField("detail")).map(_.asInstanceOf[String])
    )
  }
}
