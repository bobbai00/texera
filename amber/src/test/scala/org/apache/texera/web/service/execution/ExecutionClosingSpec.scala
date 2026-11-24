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
import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTerminationReasonEnum
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTerminationReasonEnum.{
  GARBAGE_COLLECTED,
  USER_REQUESTED
}
import org.apache.texera.web.service.execution.ExecutionClosing._
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

/** Specs for the closing job's decisions, which read and write nothing. */
class ExecutionClosingSpec extends AnyFlatSpec with Matchers {

  private val createdAtMs = 1794873600000L
  private val nowMs = createdAtMs + 60000L

  private val settings = Settings(
    intervalSeconds = 30,
    lostAfterSeconds = 180,
    neverStartedAfterSeconds = 600,
    reviseVerdictForSeconds = 3600,
    resultTtlSeconds = 86400,
    expiryIntervalSeconds = 7200,
    warehousesEnabled = false
  )

  private def execution(
      warehouse: Option[String] = None,
      terminated: Option[WorkflowComputingUnitTerminationReasonEnum] = None,
      unitTerminatedAtMs: Option[Long] = None,
      closing: Option[ClosingRecord] = None
  ): ExecutionRecord =
    ExecutionRecord(
      eid = 345,
      wid = 12,
      uid = 1,
      cuid = Some(3),
      warehouse = warehouse,
      startingTimeMs = createdAtMs,
      notification = None,
      unitTerminatedAtMs = unitTerminatedAtMs.orElse(terminated.map(_ => nowMs - 1000L)),
      unitTerminationReason = terminated,
      closing = closing,
      resultsExpiredAtMs = None
    )

  private def label(
      state: Option[String] = Some("RUNNING"),
      reason: Option[String] = None,
      stateTimeMs: Long = createdAtMs + 5000L,
      beatMs: Long = createdAtMs + 30000L,
      beatEveryMs: Long = 30000L
  ): ExecutionLabel =
    ExecutionLabel(state, state.fold(0L)(_ => 3L), stateTimeMs, reason, beatMs, beatEveryMs)

  private def decided(
      read: Read,
      watch: Option[Watch] = None,
      of: ExecutionRecord = execution(),
      settings: Settings = settings,
      nowMs: Long = nowMs
  ): (Decision, Option[Watch]) = decide(of, read, watch, settings, nowMs)

  /** The decisions of `ticks` ticks in a row that each read `read`, from no watch. */
  private def decisionsOver(ticks: Int, read: Read, settings: Settings = settings): Seq[Decision] =
    Iterator
      .iterate((Option.empty[Decision], Option.empty[Watch])) {
        case (_, watch) =>
          val (decision, next) = decided(read, watch, settings = settings)
          (Some(decision), next)
      }
      .slice(1, ticks + 1)
      .flatMap(_._1)
      .toSeq

  // --- before anything is read ---

  "ExecutionClosing.withoutReading" should "close an execution in a per-user warehouse while those are disabled" in {
    withoutReading(execution(warehouse = Some("user-1-7")), settings) shouldBe Some(
      CloseUnavailable
    )
  }

  it should "close an execution whose row names no warehouse while warehouses are enabled: its warehouse was deleted" in {
    withoutReading(execution(), settings.copy(warehousesEnabled = true)) shouldBe
      Some(CloseUnavailable)
  }

  it should "leave an execution whose warehouse can be reached to be read" in {
    withoutReading(execution(), settings) shouldBe None
    withoutReading(
      execution(warehouse = Some("user-1-7")),
      settings.copy(warehousesEnabled = true)
    ) shouldBe None
  }

  it should "close an unreachable execution whatever became of its unit" in {
    withoutReading(
      execution(warehouse = Some("user-1-7"), terminated = Some(USER_REQUESTED)),
      settings
    ) shouldBe Some(CloseUnavailable)
  }

  // --- an ending in the label ---

  "ExecutionClosing.decide" should "close with the label's state, reason and time when the label shows an ending" in {
    Seq(
      ("COMPLETED", None, WorkflowExecutionStatus.Completed),
      ("FAILED", Some("java.lang.RuntimeException: boom"), WorkflowExecutionStatus.Failed),
      ("KILLED", Some("killed by the user"), WorkflowExecutionStatus.Killed)
    ).foreach {
      case (state, reason, outcome) =>
        val ended = label(Some(state), reason, stateTimeMs = createdAtMs + 42000L)
        decided(Read.Log(ended), watch = Some(Watch(ended.beatMs, 3))) shouldBe
          ((CloseEnded(Ending(outcome, reason, createdAtMs + 42000L)), None))
    }
  }

  it should "close with the label's ending though the unit was terminated" in {
    decided(
      Read.Log(label(Some("COMPLETED"))),
      of = execution(terminated = Some(GARBAGE_COLLECTED))
    )._1 shouldBe
      CloseEnded(Ending(WorkflowExecutionStatus.Completed, None, createdAtMs + 5000L))
  }

  // --- a read that failed ---

  it should "decide nothing on a read that failed, and count nothing" in {
    decided(Read.Failed) shouldBe ((Wait, None))
    val watch = Some(Watch(createdAtMs, 5))
    decided(Read.Failed, watch) shouldBe ((Wait, watch))
  }

  it should "decide nothing on a read that failed, however old the execution and though its unit was terminated" in {
    val old = nowMs + 30L * 24 * 3600 * 1000
    decided(Read.Failed, nowMs = old) shouldBe ((Wait, None))
    decided(Read.Failed, of = execution(terminated = Some(USER_REQUESTED)), nowMs = old) shouldBe
      ((Wait, None))
    // A watch that reached the threshold stays there, and still nothing is decided.
    val watch = Some(Watch(createdAtMs, 100))
    decided(Read.Failed, watch, nowMs = old) shouldBe ((Wait, watch))
  }

  // --- a terminated unit ---

  it should "lose the run of a unit its user terminated as 'unit terminated', at once" in {
    val terminated = execution(terminated = Some(USER_REQUESTED))
    decided(Read.Log(label()), of = terminated) shouldBe
      ((CheckRowsThenLose("unit terminated"), None))
    // Young, with no log: not left to wait to be started on a unit that is gone.
    decided(Read.NoLog, of = terminated)._1 shouldBe CheckRowsThenLose("unit terminated")
  }

  it should "lose the run of a unit terminated otherwise as 'unit lost', at once" in {
    decided(
      Read.Log(label()),
      of = execution(terminated = Some(GARBAGE_COLLECTED))
    )._1 shouldBe CheckRowsThenLose("unit lost")
    // A row stamped terminated before reasons were recorded.
    decided(
      Read.Log(label()),
      of = execution(unitTerminatedAtMs = Some(nowMs))
    )._1 shouldBe CheckRowsThenLose("unit lost")
  }

  // --- never started ---

  it should "wait for a unit to start an execution with no log" in {
    decided(Read.NoLog) shouldBe ((Wait, None))
    decided(Read.NoLog, nowMs = createdAtMs + 600000L - 1) shouldBe ((Wait, None))
  }

  it should "close an execution no unit started within the limit as never started, and not before" in {
    decided(Read.NoLog, nowMs = createdAtMs + 600000L) shouldBe ((CloseNeverStarted, None))
    decided(Read.NoLog, nowMs = createdAtMs + 900000L)._1 shouldBe CloseNeverStarted
    decided(
      Read.NoLog,
      settings = settings.copy(neverStartedAfterSeconds = 60),
      nowMs = createdAtMs + 60000L
    )._1 shouldBe CloseNeverStarted
  }

  it should "never close an execution with a log as never started, however old" in {
    decided(Read.Log(label(state = None)), nowMs = createdAtMs + 900000L)._1 shouldBe Wait
  }

  // --- watching the beat ---

  it should "start watching a beat it has not seen, and count each tick the beat stays" in {
    val seen = label(beatMs = createdAtMs + 30000L)
    decided(Read.Log(seen)) shouldBe ((Wait, Some(Watch(seen.beatMs, 0))))
    decided(Read.Log(seen), Some(Watch(seen.beatMs, 0))) shouldBe
      ((Wait, Some(Watch(seen.beatMs, 1))))
    decided(Read.Log(seen), Some(Watch(seen.beatMs, 4))) shouldBe
      ((Wait, Some(Watch(seen.beatMs, 5))))
  }

  it should "start over on a beat that moved, forward or back" in {
    val watch = Some(Watch(createdAtMs + 30000L, 5))
    decided(Read.Log(label(beatMs = createdAtMs + 60000L)), watch) shouldBe
      ((Wait, Some(Watch(createdAtMs + 60000L, 0))))
    // The unit's clock is its own: a beat that went back is still a sign of life.
    decided(Read.Log(label(beatMs = createdAtMs)), watch) shouldBe
      ((Wait, Some(Watch(createdAtMs, 0))))
  }

  it should "lose a run whose beat stood still for the ticks of lost-after-seconds, and not one tick sooner" in {
    // 180 s at 30 s a tick: the tick that first sees the beat, then six that see it unchanged.
    val decisions = decisionsOver(8, Read.Log(label()))
    decisions.take(6) shouldBe Seq.fill(6)(Wait)
    decisions(6) shouldBe CheckRowsThenLose("unit lost")
    // Still lost on the next tick, if that close did not happen.
    decisions(7) shouldBe CheckRowsThenLose("unit lost")
  }

  it should "never lose a run whose beat moves" in {
    val watched = (1 to 50).foldLeft(Option.empty[Watch]) { (watch, tick) =>
      val (decision, next) = decided(Read.Log(label(beatMs = createdAtMs + tick * 30000L)), watch)
      decision shouldBe Wait
      next
    }
    watched shouldBe Some(Watch(createdAtMs + 50 * 30000L, 0))
  }

  it should "watch a log with no state yet like any other" in {
    val unstated = label(state = None)
    decided(Read.Log(unstated)) shouldBe ((Wait, Some(Watch(unstated.beatMs, 0))))
    decisionsOver(7, Read.Log(unstated)).last shouldBe CheckRowsThenLose("unit lost")
  }

  it should "forget the watch of an execution it stops watching" in {
    val watch = Some(Watch(createdAtMs, 2))
    decided(Read.NoLog, watch)._2 shouldBe None
    decided(Read.Log(label(Some("COMPLETED"))), watch)._2 shouldBe None
    decided(Read.Log(label()), watch, of = execution(terminated = Some(USER_REQUESTED)))._2 shouldBe
      None
  }

  // --- the threshold ---

  "ExecutionClosing.lostAfterTicks" should "be lost-after-seconds in ticks, rounded up" in {
    lostAfterTicks(settings, beatEveryMs = 30000L) shouldBe 6
    lostAfterTicks(settings.copy(lostAfterSeconds = 181), 30000L) shouldBe 7
    lostAfterTicks(settings.copy(lostAfterSeconds = 179), 30000L) shouldBe 6
    lostAfterTicks(settings.copy(intervalSeconds = 45), 30000L) shouldBe 4
    lostAfterTicks(settings.copy(intervalSeconds = 400), 30000L) shouldBe 1
  }

  it should "never be less than four of the unit's beats" in {
    // Four beats of 60 s are 240 s: 8 ticks of 30 s, more than the 6 of lost-after-seconds.
    lostAfterTicks(settings, beatEveryMs = 60000L) shouldBe 8
    lostAfterTicks(settings, beatEveryMs = 61000L) shouldBe 9
    lostAfterTicks(settings.copy(lostAfterSeconds = 0), beatEveryMs = 30000L) shouldBe 4
    // Exactly as long as lost-after-seconds.
    lostAfterTicks(settings, beatEveryMs = 45000L) shouldBe 6
  }

  it should "be lost-after-seconds alone for a label that says no beat interval, or a nonsensical one" in {
    lostAfterTicks(settings, beatEveryMs = 0L) shouldBe 6
    lostAfterTicks(settings, beatEveryMs = -5000L) shouldBe 6
    lostAfterTicks(settings.copy(lostAfterSeconds = 0), beatEveryMs = 0L) shouldBe 0
  }

  it should "be what a slow-beating unit's run is lost after" in {
    val slow = Read.Log(label(beatEveryMs = 60000L))
    val decisions = decisionsOver(9, slow)
    decisions.take(8) shouldBe Seq.fill(8)(Wait)
    decisions(8) shouldBe CheckRowsThenLose("unit lost")
  }

  // --- a verdict gives way to the log ---

  private def verdict(endedAtMs: Long = nowMs - 60000L, fromLog: Boolean = false) =
    Some(ClosingRecord(WorkflowExecutionStatus.Failed, Some(UnitLost), endedAtMs, fromLog))

  "ExecutionClosing.revisable" should "keep reading the log of an execution closed by a verdict within the window" in {
    revisable(execution(closing = verdict()), settings, nowMs) shouldBe true
    revisable(execution(closing = verdict(nowMs - 3600000L)), settings, nowMs) shouldBe true
  }

  it should "stop once the verdict is older than the window" in {
    revisable(execution(closing = verdict(nowMs - 3600001L)), settings, nowMs) shouldBe false
    revisable(
      execution(closing = verdict()),
      settings.copy(reviseVerdictForSeconds = 59),
      nowMs
    ) shouldBe false
    reviseSinceMs(settings, nowMs) shouldBe nowMs - 3600000L
  }

  it should "leave an outcome that is from the log, and an open execution" in {
    revisable(execution(closing = verdict(fromLog = true)), settings, nowMs) shouldBe false
    revisable(execution(), settings, nowMs) shouldBe false
  }

  it should "leave a verdict whose log is in a warehouse that cannot be reached" in {
    revisable(
      execution(warehouse = Some("user-1-7"), closing = verdict()),
      settings,
      nowMs
    ) shouldBe
      false
    revisable(
      execution(closing = verdict()),
      settings.copy(warehousesEnabled = true),
      nowMs
    ) shouldBe
      false
    revisable(
      execution(warehouse = Some("user-1-7"), closing = verdict()),
      settings.copy(warehousesEnabled = true),
      nowMs
    ) shouldBe true
  }

  "ExecutionClosing.endingIn" should "be the ending a label shows, and none while the run is not over" in {
    endingIn(label(Some("COMPLETED"), stateTimeMs = 7L)) shouldBe
      Some(Ending(WorkflowExecutionStatus.Completed, None, 7L))
    endingIn(label(Some("FAILED"), Some("boom"), 8L)) shouldBe
      Some(Ending(WorkflowExecutionStatus.Failed, Some("boom"), 8L))
    endingIn(label(Some("KILLED"), Some("replaced by execution 346"), 9L)) shouldBe
      Some(Ending(WorkflowExecutionStatus.Killed, Some("replaced by execution 346"), 9L))
    Seq(Some("READY"), Some("RUNNING"), Some("PAUSED"), None).foreach { state =>
      endingIn(label(state)) shouldBe None
    }
  }

  // --- small rules ---

  "ExecutionClosing.endedAtWithin" should "keep a unit's time between the execution's creation and now" in {
    endedAtWithin(createdAtMs + 5000L, createdAtMs, nowMs) shouldBe createdAtMs + 5000L
    endedAtWithin(nowMs + 3600000L, createdAtMs, nowMs) shouldBe nowMs
    endedAtWithin(createdAtMs - 3600000L, createdAtMs, nowMs) shouldBe createdAtMs
    endedAtWithin(0L, createdAtMs, nowMs) shouldBe createdAtMs
    // A creation the database stamped ahead of this service's clock wins over now.
    endedAtWithin(createdAtMs, nowMs + 1000L, nowMs) shouldBe nowMs + 1000L
  }

  "ExecutionClosing.compileError" should "say the operator's error, cut to the length a reason keeps" in {
    compileError(
      "The CSV scan names no file."
    ) shouldBe "compile error: The CSV scan names no file."
    compileError("") shouldBe "compile error: "
    val long = "x" * 600
    compileError(long) shouldBe "compile error: " + "x" * ExecutionLogStore.MaxReasonLength
    compileError("x" * 500) shouldBe "compile error: " + "x" * 500
  }

  it should "never cut a character that takes two chars in half" in {
    val pair = "😀"
    pair.length shouldBe 2
    compileError("x" * 499 + pair + "tail") shouldBe "compile error: " + "x" * 499
    compileError("x" * 498 + pair + "tail") shouldBe "compile error: " + "x" * 498 + pair
  }

  "ExecutionClosing.notStartedByUnit" should "say the unit's reason, cut as a compile error is" in {
    notStartedByUnit("Execution 7 was already started.") shouldBe
      "its computing unit did not start it: Execution 7 was already started."
    notStartedByUnit("x" * 600) shouldBe
      "its computing unit did not start it: " + "x" * ExecutionLogStore.MaxReasonLength
    val pair = "😀"
    notStartedByUnit("x" * 499 + pair + "tail") shouldBe
      "its computing unit did not start it: " + "x" * 499
  }

  "ExecutionClosing.Settings" should "refuse an interval that is no interval, and negative limits" in {
    an[IllegalArgumentException] should be thrownBy settings.copy(intervalSeconds = 0)
    an[IllegalArgumentException] should be thrownBy settings.copy(intervalSeconds = -30)
    an[IllegalArgumentException] should be thrownBy settings.copy(lostAfterSeconds = -1)
    an[IllegalArgumentException] should be thrownBy settings.copy(neverStartedAfterSeconds = -1)
    an[IllegalArgumentException] should be thrownBy settings.copy(reviseVerdictForSeconds = -1)
    an[IllegalArgumentException] should be thrownBy settings.copy(resultTtlSeconds = -1)
    an[IllegalArgumentException] should be thrownBy settings.copy(expiryIntervalSeconds = 0)
    noException should be thrownBy settings.copy(
      lostAfterSeconds = 0,
      neverStartedAfterSeconds = 0,
      reviseVerdictForSeconds = 0,
      resultTtlSeconds = 0
    )
  }

  // --- results past their age ---

  "ExecutionClosing.pastAge" should "be the time results are kept before now, and for a verdict the time it is replaced for as well" in {
    pastAge(settings, nowMs) shouldBe
      PastAge(nowMs - 86400000L, verdictsBeforeMs = nowMs - 3600000L)
    pastAge(settings.copy(resultTtlSeconds = 0), nowMs) shouldBe
      PastAge(nowMs, verdictsBeforeMs = nowMs - 3600000L)
  }

  "ExecutionClosing.expiryDue" should "be due before the job's first pass, and then once every interval" in {
    expiryDue(settings, lastPassMs = None, nowMs) shouldBe true
    expiryDue(settings, Some(nowMs), nowMs) shouldBe false
    expiryDue(settings, Some(nowMs), nowMs + 7199999L) shouldBe false
    expiryDue(settings, Some(nowMs), nowMs + 7200000L) shouldBe true
    // A clock that was set back makes no pass due.
    expiryDue(settings, Some(nowMs), nowMs - 86400000L) shouldBe false
  }

  // --- status codes ---

  "ExecutionStatus.of" should "give every state a log records the code a unit records for it" in {
    ExecutionLogStore.States.map(ExecutionStatus.of) shouldBe Seq[Short](0, 1, 2, 3, 4, 5)
    ExecutionLogStore.EndStates.map(ExecutionStatus.of).toSet shouldBe WorkflowExecutionStatus.Ended
  }

  it should "refuse a state no log records" in {
    Seq("PAUSING", "RESUMING", "UNINITIALIZED", "TERMINATED", "running", "", "DONE").foreach {
      state =>
        withClue(s"'$state': ") {
          an[IllegalArgumentException] should be thrownBy ExecutionStatus.of(state)
        }
    }
  }

  "ExecutionStatus.ofOpen" should "be the code of the label's state, and Created while no unit wrote one" in {
    ExecutionStatus.ofOpen(Some(label(Some("READY")))) shouldBe WorkflowExecutionStatus.Initializing
    ExecutionStatus.ofOpen(Some(label(Some("RUNNING")))) shouldBe WorkflowExecutionStatus.Running
    ExecutionStatus.ofOpen(Some(label(Some("PAUSED")))) shouldBe WorkflowExecutionStatus.Paused
    // An ending the closing job has yet to record.
    ExecutionStatus.ofOpen(Some(label(Some("FAILED")))) shouldBe WorkflowExecutionStatus.Failed
    ExecutionStatus.ofOpen(Some(label(state = None))) shouldBe WorkflowExecutionStatus.Created
    ExecutionStatus.ofOpen(None) shouldBe WorkflowExecutionStatus.Created
  }
}
