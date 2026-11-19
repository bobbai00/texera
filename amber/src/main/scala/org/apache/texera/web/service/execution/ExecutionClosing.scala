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

import org.apache.texera.amber.core.storage.{ExecutionLabel, ExecutionLogStore}
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}
import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTerminationReasonEnum

/**
  * What the closing job does about an execution, decided from what it read. Nothing here reads
  * or writes anything: [[ExecutionCloser]] acts on a decision, and [[ExecutionClosingJob]] puts
  * the two together.
  *
  * An execution is closed with the ending its log holds. One whose log holds none is closed by
  * a verdict of the Dashboard service's own, when its warehouse is gone, when its computing
  * unit was terminated or shows no sign of life, or when no unit started it in time. A verdict
  * gives way to the log: an execution closed as lost whose log shows an ending later is given
  * that ending ([[revisable]]).
  */
object ExecutionClosing {

  // Why the Dashboard service closed an execution whose log holds no ending: at its create,
  // which failed, or at the closing job.
  val PlanNotMade = "its plan could not be made"
  val PlanTooLarge = "its plan is too large"
  val UnitLost = "unit lost"
  val UnitTerminated = "unit terminated"
  val NeverStarted = "never started"
  val WarehouseUnavailable = "its warehouse is no longer available"

  /**
    * Why an execution whose workflow does not compile is closed: the message of an operator's
    * error, cut to [[ExecutionLogStore.MaxReasonLength]] characters.
    */
  def compileError(message: String): String = {
    val limit = ExecutionLogStore.MaxReasonLength
    // Never the first half alone of a character that takes two chars.
    val kept =
      if (message.length <= limit) message
      else if (Character.isHighSurrogate(message.charAt(limit - 1))) message.take(limit - 1)
      else message.take(limit)
    s"compile error: $kept"
  }

  /**
    * @param intervalSeconds          how often the job looks at the open executions
    * @param lostAfterSeconds         how long a unit may show no sign of life before its run is
    *                                 closed as lost
    * @param neverStartedAfterSeconds how long an execution may wait for a unit to start it
    * @param reviseVerdictForSeconds  how long after a verdict the job still reads the log for
    *                                 an ending to put in its place
    * @param resultTtlSeconds         how long after an execution ended its results are kept
    * @param expiryIntervalSeconds    how often the job looks for results older than that
    * @param warehousesEnabled        whether runs write into per-user warehouses
    */
  final case class Settings(
      intervalSeconds: Int,
      lostAfterSeconds: Int,
      neverStartedAfterSeconds: Int,
      reviseVerdictForSeconds: Int,
      resultTtlSeconds: Int,
      expiryIntervalSeconds: Int,
      warehousesEnabled: Boolean
  ) {
    require(
      intervalSeconds > 0,
      s"execution-closing.interval-seconds must be > 0 (got $intervalSeconds)"
    )
    require(
      lostAfterSeconds >= 0,
      s"execution-closing.lost-after-seconds must be >= 0 (got $lostAfterSeconds)"
    )
    require(
      neverStartedAfterSeconds >= 0,
      s"execution-closing.never-started-after-seconds must be >= 0 (got $neverStartedAfterSeconds)"
    )
    require(
      reviseVerdictForSeconds >= 0,
      s"execution-closing.revise-verdict-for-seconds must be >= 0 (got $reviseVerdictForSeconds)"
    )
    require(
      resultTtlSeconds >= 0,
      s"result-cleanup.ttl-in-seconds must be >= 0 (got $resultTtlSeconds)"
    )
    require(
      expiryIntervalSeconds > 0,
      "result-cleanup.collection-check-interval-in-seconds must be > 0 " +
        s"(got $expiryIntervalSeconds)"
    )
  }

  object Settings {

    def configured: Settings =
      Settings(
        intervalSeconds = ApplicationConfig.executionClosingIntervalInSecs,
        lostAfterSeconds = ApplicationConfig.executionClosingLostAfterInSecs,
        neverStartedAfterSeconds = ApplicationConfig.executionClosingNeverStartedAfterInSecs,
        reviseVerdictForSeconds = ApplicationConfig.executionClosingReviseVerdictForInSecs,
        resultTtlSeconds = ApplicationConfig.sinkStorageTTLInSecs,
        expiryIntervalSeconds = ApplicationConfig.sinkStorageCleanUpCheckIntervalInSecs,
        warehousesEnabled = StorageConfig.warehouseEnabled
      )
  }

  /** What a tick read of an execution in the lake. */
  sealed trait Read
  object Read {

    /** The lake could not answer. It says nothing of the execution, least of all "no log". */
    case object Failed extends Read

    final case class Log(label: ExecutionLabel) extends Read

    /** The execution has no log table: no unit has started it, or its unit could not make one. */
    case object NoLog extends Read
  }

  /**
    * What the job remembers of an open execution between its ticks: the beat it last saw, and for
    * how many of the job's own ticks in a row the beat has been that. The job never compares a
    * unit's clock with its own.
    */
  final case class Watch(beatMs: Long, unchangedTicks: Int)

  /**
    * How an execution's log says it ended.
    *
    * @param endedAtMs when, on its unit's clock
    */
  final case class Ending(outcome: Short, reason: Option[String], endedAtMs: Long)

  sealed trait Decision

  /** Nothing to do yet: look again on the next tick. */
  case object Wait extends Decision

  /** The log's label shows an ending: close with it. */
  final case class CloseEnded(ending: Ending) extends Decision

  /**
    * No unit started it in time: close it as never started. It is a verdict like the others: the
    * ending of a log that shows up later takes its place.
    */
  case object CloseNeverStarted extends Decision

  /** Its unit is gone: close it as failed for `reason`, unless the log's rows hold an ending. */
  final case class CheckRowsThenLose(reason: String) extends Decision

  /** Its tables are in a warehouse this deployment cannot reach: close it as failed. */
  case object CloseUnavailable extends Decision

  /**
    * Whether the tables of an execution that writes into `warehouse` cannot be reached: they
    * are in a per-user warehouse while those are disabled, or the row names none while they are
    * enabled, which is what deleting its warehouse leaves. Its URIs would then name the shared
    * warehouse, where its tables are not, so nothing of it is read.
    */
  def warehouseUnavailable(warehouse: Option[String], warehousesEnabled: Boolean): Boolean =
    warehouse.isDefined != warehousesEnabled

  /**
    * What is decided about `execution` before its lake is read: [[CloseUnavailable]], or None,
    * when it is to be read and [[decide]] decides.
    */
  def withoutReading(execution: ExecutionRecord, settings: Settings): Option[Decision] =
    Option.when(warehouseUnavailable(execution.warehouse, settings.warehousesEnabled))(
      CloseUnavailable
    )

  /**
    * What to do about the open `execution`, whose lake a tick read as `read`, and what the job
    * remembers of it for its next tick.
    *
    * A read that failed decides nothing and counts for nothing. An ending in the label closes
    * the execution. Otherwise a terminated unit loses it at once; an execution no unit started
    * is closed once it has waited for one long enough; and one a unit did start is watched: it
    * is lost when its beat has not changed for as many ticks in a row as
    * [[lostAfterTicks]] says.
    *
    * @param watch what the job remembers of the execution; None when it has not watched it
    * @param nowMs the Dashboard service's clock
    */
  def decide(
      execution: ExecutionRecord,
      read: Read,
      watch: Option[Watch],
      settings: Settings,
      nowMs: Long
  ): (Decision, Option[Watch]) =
    read match {
      case Read.Failed => (Wait, watch)
      case Read.Log(label) if label.ended =>
        (CloseEnded(endingOf(label)), None)
      case _ if execution.unitTerminatedAtMs.isDefined =>
        val byUser = execution.unitTerminationReason.contains(
          WorkflowComputingUnitTerminationReasonEnum.USER_REQUESTED
        )
        (CheckRowsThenLose(if (byUser) UnitTerminated else UnitLost), None)
      case Read.NoLog =>
        val waited = nowMs - execution.startingTimeMs
        (if (waited >= settings.neverStartedAfterSeconds * 1000L) CloseNeverStarted else Wait, None)
      case Read.Log(label) => watching(label.beatMs, label.beatEveryMs, watch, settings)
    }

  private def watching(
      beatMs: Long,
      beatEveryMs: Long,
      watch: Option[Watch],
      settings: Settings
  ): (Decision, Option[Watch]) = {
    val watched = watch match {
      case Some(Watch(`beatMs`, unchangedTicks)) => Watch(beatMs, unchangedTicks + 1)
      case _                                     => Watch(beatMs, 0)
    }
    val lost = watched.unchangedTicks >= lostAfterTicks(settings, beatEveryMs)
    (if (lost) CheckRowsThenLose(UnitLost) else Wait, Some(watched))
  }

  /**
    * For how many of the job's ticks in a row a beat must stay as it is before its unit is
    * lost: the ticks of `lost-after-seconds`, or of four of the unit's own beats if that is
    * longer, rounded up.
    */
  def lostAfterTicks(settings: Settings, beatEveryMs: Long): Int = {
    val lostAfterMs = math.max(settings.lostAfterSeconds * 1000L, 4L * math.max(beatEveryMs, 0L))
    val intervalMs = settings.intervalSeconds * 1000L
    Math.toIntExact((lostAfterMs + intervalMs - 1) / intervalMs)
  }

  /** The ending `label` shows; None while the execution it labels is not over. */
  def endingIn(label: ExecutionLabel): Option[Ending] = Option.when(label.ended)(endingOf(label))

  private def endingOf(label: ExecutionLabel): Ending =
    Ending(ExecutionStatus.of(label.state.get), label.reason, label.stateTimeMs)

  /**
    * When results are past their age at `nowMs`: their execution ended `ttl-in-seconds` ago or
    * earlier, and no ending in its log replaces a verdict any more ([[revisable]]).
    */
  def pastAge(settings: Settings, nowMs: Long): PastAge =
    PastAge(nowMs - settings.resultTtlSeconds * 1000L, reviseSinceMs(settings, nowMs))

  /**
    * Whether a pass over the results past their age is due at `nowMs`: the job has made none
    * yet, or made its last one, at `lastPassMs`, at least `expiryIntervalSeconds` ago.
    */
  def expiryDue(settings: Settings, lastPassMs: Option[Long], nowMs: Long): Boolean =
    lastPassMs.forall(last => nowMs - last >= settings.expiryIntervalSeconds * 1000L)

  /** The time a verdict must not be older than, at `nowMs`, for the job to still read its log. */
  def reviseSinceMs(settings: Settings, nowMs: Long): Long =
    nowMs - settings.reviseVerdictForSeconds * 1000L

  /**
    * Whether the log of `execution` is still read for an ending to put in place of the verdict
    * that closed it: a verdict closed it, no longer ago than `revise-verdict-for-seconds`, and
    * its warehouse can be reached. Only an ending in the label a tick reads ([[endingIn]])
    * replaces the verdict.
    */
  def revisable(execution: ExecutionRecord, settings: Settings, nowMs: Long): Boolean =
    execution.closing.exists(closing =>
      !closing.fromLog && closing.endedAtMs >= reviseSinceMs(settings, nowMs)
    ) && !warehouseUnavailable(execution.warehouse, settings.warehousesEnabled)

  /** `endedAtMs`, a time on a unit's clock, kept between `startingTimeMs` and `nowMs`. */
  def endedAtWithin(endedAtMs: Long, startingTimeMs: Long, nowMs: Long): Long =
    math.max(startingTimeMs, math.min(endedAtMs, nowMs))

  /** The text of an outcome, for a log line. */
  def nameOf(outcome: Short): String =
    outcome match {
      case WorkflowExecutionStatus.Completed => "completed"
      case WorkflowExecutionStatus.Failed    => "failed"
      case WorkflowExecutionStatus.Killed    => "killed"
      case other                             => s"status $other"
    }
}
