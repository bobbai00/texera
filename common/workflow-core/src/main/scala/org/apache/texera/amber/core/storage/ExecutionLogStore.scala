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
import org.apache.texera.amber.core.workflow.GlobalPortIdentity
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps

import java.net.URI

/**
  * One row of an execution's log: a change of the run's state, or one of its stored output
  * ports. Made with [[ExecutionLogEntry.state]] or [[ExecutionLogEntry.output]].
  *
  * @param seq    1, 2, 3, … in the order the engine made the rows.
  * @param timeMs when the engine made the row, in epoch milliseconds on its unit's clock.
  * @param kind   [[ExecutionLogStore.StateKind]] or [[ExecutionLogStore.OutputKind]].
  * @param state  on a state row, the state the run changed to, one of
  *               [[ExecutionLogStore.States]]; None on an output row.
  * @param detail JSON. On a state row, why the state changed:
  *               `{"reason": "…", "errors": [{"type", "timeMs", "message", "details",
  *               "operatorId", "workerId"}]}` with either key or both, and None when the row
  *               says neither. On an output row, `{"portId", "uri", "outputMode"}`.
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
    * reason a state row gives, else the message of its first error. None when it gives
    * neither, and on an output row.
    */
  def reason: Option[String] =
    if (kind == ExecutionLogStore.StateKind) detail.flatMap(ExecutionLogDetail.reason)
    else None

  /** The stored output port an output row records; None on a state row. */
  def output: Option[ExecutionOutput] =
    if (kind == ExecutionLogStore.OutputKind) detail.map(ExecutionLogDetail.output)
    else None
}

object ExecutionLogEntry {

  /** The row of a change to `state`, with why: a reason in words, the errors behind it, or neither. */
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
      ExecutionLogDetail.ofState(reason.filter(_.nonEmpty), errors)
    )

  /** The row of a stored output port. */
  def output(seq: Long, timeMs: Long, output: ExecutionOutput): ExecutionLogEntry =
    ExecutionLogEntry(
      seq,
      timeMs,
      ExecutionLogStore.OutputKind,
      None,
      Some(ExecutionLogDetail.ofOutput(output))
    )
}

/**
  * A stored output port of an execution, as its log records it.
  *
  * @param uri        the port's result table.
  * @param outputMode the name of the port's `OutputPort.OutputMode`.
  */
final case class ExecutionOutput(port: GlobalPortIdentity, uri: URI, outputMode: String)

/**
  * The newest state of an execution, as the properties of its log table repeat it.
  *
  * @param state       the state of the newest state row; None before the first one.
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

  /** Whether the execution is over: its newest state is one of [[ExecutionLogStore.EndStates]]. */
  def ended: Boolean = state.exists(ExecutionLogStore.EndStates.contains)
}

/** The JSON of a log row's `detail`. */
private object ExecutionLogDetail {

  def ofState(reason: Option[String], errors: Seq[WorkflowFatalError]): Option[String] =
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

  def ofOutput(output: ExecutionOutput): String =
    objectMapper.writeValueAsString(
      objectMapper
        .createObjectNode()
        .put("portId", output.port.serializeAsString)
        .put("uri", output.uri.toString)
        .put("outputMode", output.outputMode)
    )

  def reason(detail: String): Option[String] = {
    val node = objectMapper.readTree(detail)
    text(node.path("reason"))
      .orElse(text(node.path("errors").path(0).path("message")))
      .map(cut)
  }

  def output(detail: String): ExecutionOutput = {
    val node = objectMapper.readTree(detail)
    ExecutionOutput(
      GlobalPortIdentitySerde.deserializeFromString(node.path("portId").asText()),
      URI.create(node.path("uri").asText()),
      node.path("outputMode").asText()
    )
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
  * Keeps each execution's log in the lake: one Iceberg table per execution, in the warehouse the
  * execution writes into, at the URI [[logUri]] names (namespace
  * `storage.iceberg.table.execution-log-namespace`, table `wid_<wid>_eid_<eid>_executionlog`).
  *
  * The engine that runs the execution is the table's one writer. It appends a row for every
  * change of the run's state and for every stored output port (see [[ExecutionLogEntry]]), and
  * the commit that appends a state row also sets the label: table properties that repeat the
  * newest state (see [[ExecutionLabel]]). So the state is read with one load of the table, and
  * no reader sees a label without its row. Between its appends the engine refreshes one of the
  * properties, the beat, which shows that it is alive.
  *
  * Every method takes only a URI [[logUri]] could have built, and refuses any other. To a read,
  * a table that is not there is an answer, None or Nil; to a write it is a
  * [[NoSuchExecutionTableException]]. Any other failure of the catalog or the object store is
  * thrown as it is, so a lake that cannot answer is never taken for a missing log.
  */
object ExecutionLogStore {

  val StateKind = "state"
  val OutputKind = "output"

  /** The states a log records, as the `state` of its state rows. */
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

  /** The log table of execution `eid` of workflow `wid`, in `warehouse` (None: the default). */
  def logUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createExecutionLogURI(wid, eid, warehouse)

  /**
    * Makes the log table, empty, with a first beat at `nowMs` and `beatEveryMs` in its label. A
    * table already at this URI can only be stale, since an execution id is run once, so it is
    * replaced.
    */
  def create(uri: URI, nowMs: Long, beatEveryMs: Long): Unit = {
    requireLogUri(uri)
    DocumentFactory.createDocument(uri, executionLogSchema)
    IcebergAppender.setProperties(
      existingTable(uri),
      Map(BeatProperty -> nowMs.toString, BeatEveryProperty -> beatEveryMs.toString)
    )
  }

  /**
    * Appends `entries`, whose `seq` rises, in one commit. The same commit sets the beat to
    * `nowMs` and, when `entries` holds a state row, the label's state to the last one.
    *
    * An append that fails may have landed all the same, when the catalog's answer was lost.
    * Appending the entries again is safe: [[read]] returns one row per `seq`.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
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
    val state = entries.findLast(_.kind == StateKind).map { entry =>
      Map(
        StateProperty -> entry.state.get,
        StateSeqProperty -> entry.seq.toString,
        StateTimeProperty -> entry.timeMs.toString,
        ReasonProperty -> entry.reason.getOrElse("")
      )
    }
    IcebergAppender.append(
      table,
      entries.map(toRecord(table, _)),
      s"${entries.head.kind}_${entries.head.seq}",
      state.getOrElse(Map.empty) + (BeatProperty -> nowMs.toString)
    )
  }

  /**
    * Sets the beat to `nowMs`, in a commit that adds no snapshot.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
    */
  def beat(uri: URI, nowMs: Long): Unit = {
    requireLogUri(uri)
    IcebergAppender.setProperties(existingTable(uri), Map(BeatProperty -> nowMs.toString))
  }

  /** The label, read with one load of the table; None when the table does not exist. */
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

  /** The rows by `seq`, one per `seq`; Nil when the table does not exist. */
  def read(uri: URI): Seq[ExecutionLogEntry] = read(uri, afterPlan = () => ())

  /**
    * [[read]], running `afterPlan` between each plan of the table's files and the read of them,
    * the window in which a tidy can delete them. Tests tidy there.
    */
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

  /** The stored output ports the log records, each once; Nil when the table does not exist. */
  def outputs(uri: URI): Seq[ExecutionOutput] = read(uri).flatMap(_.output).distinctBy(_.port)

  /**
    * Tidies the table (see [[IcebergTidy.tidy]]). For the table's writer alone, between its
    * appends, and with `atEnd` once it has appended its last row.
    *
    * @throws NoSuchExecutionTableException if the table does not exist.
    */
  def tidy(uri: URI, atEnd: Boolean): Unit = {
    requireLogUri(uri)
    IcebergTidy.tidy(existingTable(uri), atEnd)
  }

  /** Drops the table with its rows and its label; nothing happens when there is no table. */
  def drop(uri: URI): Unit = {
    requireLogUri(uri)
    DocumentFactory.dropTable(uri)
  }

  private def requireLogUri(uri: URI): Unit = {
    val components = VFSURIFactory.decodeURI(uri)
    // Rebuilding the URI from what it decodes to refuses extra segments, which would address a
    // different table name in the log namespace.
    require(
      components.resourceType == VFSResourceType.EXECUTION_LOG &&
        uri == logUri(components.workflowId, components.executionId, components.warehouse),
      s"not an execution log URI: $uri"
    )
  }

  private def requireLogRow(entry: ExecutionLogEntry): Unit =
    require(
      entry.kind match {
        case StateKind  => entry.state.exists(States.contains)
        case OutputKind => entry.state.isEmpty && entry.detail.nonEmpty
        case _          => false
      },
      s"row ${entry.seq} is neither a state row with one of the states ${States.mkString(", ")} " +
        s"nor an output row: its kind is '${entry.kind}' and its state ${entry.state}"
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
