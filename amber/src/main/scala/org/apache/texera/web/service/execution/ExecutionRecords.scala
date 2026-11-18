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

import org.apache.texera.amber.core.storage.{ExecutionLogStore, ExecutionPlanStore}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.auth.util.WorkflowAccess
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_COMPUTING_UNIT,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTerminationReasonEnum
import org.apache.texera.dao.{SqlServer, WorkflowExecutionStatus}
import org.jooq.impl.{DSL, SQLDataType}
import org.jooq.{Condition, DSLContext, Field, Record}

import java.net.URI
import java.sql.Timestamp
import scala.jdk.CollectionConverters._

/**
  * How an execution ended, as its row records it once it is over.
  *
  * @param outcome   completed, failed or killed, as a code of [[WorkflowExecutionStatus.Ended]]
  * @param reason    why, in words for the user; None when the outcome says it all
  * @param endedAtMs when, in epoch milliseconds
  * @param fromLog   whether the outcome is the ending the execution's log holds; false for a
  *                  verdict the Dashboard service made without one
  */
final case class ClosingRecord(
    outcome: Short,
    reason: Option[String],
    endedAtMs: Long,
    fromLog: Boolean
)

/**
  * An execution's row, with what closing it reads beside it.
  *
  * @param wid                   its workflow, through its version
  * @param uid                   the user who created it
  * @param warehouse             the name of the warehouse it writes into; None when its row
  *                              names none, or names one that was deleted since
  * @param startingTimeMs        when it was created, in epoch milliseconds
  * @param notification          where its email goes, as JSON; None sends none
  * @param unitTerminatedAtMs    when its computing unit was terminated, if it was
  * @param unitTerminationReason why the unit was terminated
  * @param closing               how it ended; None while it is open
  */
final case class ExecutionRecord(
    eid: Long,
    wid: Long,
    uid: Int,
    cuid: Option[Int],
    warehouse: Option[String],
    startingTimeMs: Long,
    notification: Option[String],
    unitTerminatedAtMs: Option[Long],
    unitTerminationReason: Option[WorkflowComputingUnitTerminationReasonEnum],
    closing: Option[ClosingRecord]
) {
  def workflowId: WorkflowIdentity = WorkflowIdentity(wid)
  def executionId: ExecutionIdentity = ExecutionIdentity(eid)

  /** Its plan table, in the warehouse its row names. */
  def planUri: URI = ExecutionPlanStore.planUri(workflowId, executionId, warehouse)

  /** Its log table, in the warehouse its row names. */
  def logUri: URI = ExecutionLogStore.logUri(workflowId, executionId, warehouse)
}

/**
  * The rows of `workflow_executions` as the Dashboard service closes them and reads how they
  * ended. Only the Dashboard writes the closing record, and each write is one conditional
  * UPDATE, so of any number of replicas that try the same one, one does it.
  */
object ExecutionRecords {

  private def context: DSLContext = SqlServer.getInstance().createDSLContext()

  /** The executions with no closing record, oldest first. */
  def open(): Seq[ExecutionRecord] = select(WORKFLOW_EXECUTIONS.ENDED_AT.isNull)

  /**
    * The executions closed at or after `sinceMs` by a verdict of the Dashboard service, not by
    * an ending in their log, that still hold their results: the ones whose log may yet show how
    * they really ended. An execution that no unit ever started is closed with its results marked
    * expired, so it is never among them.
    */
  def closedByVerdictSince(sinceMs: Long): Seq[ExecutionRecord] =
    select(
      // Constants, not bind values, so the planner sees that idx_workflow_executions_verdict
      // covers the query.
      WORKFLOW_EXECUTIONS.ENDED_AT.isNotNull
        .and(WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG.eq(DSL.inline(java.lang.Boolean.FALSE)))
        .and(WORKFLOW_EXECUTIONS.RESULTS_EXPIRED_AT.isNull)
        .and(WORKFLOW_EXECUTIONS.ENDED_AT.ge(timeOf(sinceMs)))
    )

  /**
    * The executions of workflow `wid` on computing unit `cuid` with no closing record that were
    * made before execution `before`, oldest first.
    */
  def openBefore(wid: Long, cuid: Int, before: Long): Seq[ExecutionRecord] =
    select(
      WORKFLOW_EXECUTIONS.ENDED_AT.isNull
        .and(WORKFLOW_VERSION.WID.eq(Integer.valueOf(Math.toIntExact(wid))))
        .and(WORKFLOW_EXECUTIONS.CUID.eq(Integer.valueOf(cuid)))
        .and(WORKFLOW_EXECUTIONS.EID.lt(Integer.valueOf(Math.toIntExact(before))))
    )

  /**
    * The condition that a row's status can be one of `codes`, as far as the row tells: it is
    * closed with one of them as its outcome, or, when `codes` has a code that is not an
    * ending, it is open. An open execution's status is in its log, so whoever asks narrows the
    * open rows found by what their logs say. No codes, no condition.
    */
  def statusAmong(codes: Set[Short]): Condition = {
    val (endings, others) = codes.partition(WorkflowExecutionStatus.Ended.contains)
    val closed =
      Option.when(endings.nonEmpty)(
        WORKFLOW_EXECUTIONS.OUTCOME.in(endings.toSeq.sorted.map(Short.box).asJava)
      )
    val open = Option.when(others.nonEmpty)(WORKFLOW_EXECUTIONS.ENDED_AT.isNull)
    (closed.toSeq ++ open).reduceOption(_.or(_)).getOrElse(DSL.noCondition())
  }

  /** Execution `eid`'s row; None when there is none. */
  def find(eid: Long): Option[ExecutionRecord] =
    Option
      .when(eid >= 1 && eid <= Int.MaxValue)(eid)
      .flatMap(id => select(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(id.toInt))).headOption)

  /**
    * Whether user `uid` may read what `execution` recorded, its log among it: the user created
    * it, or owns or was granted its workflow. Seeing a public workflow is not enough, since a
    * log can quote what a run read from private datasets.
    */
  def mayRead(uid: Integer, execution: ExecutionRecord): Boolean =
    execution.uid == uid.intValue() ||
      WorkflowAccess.hasGrantedAccess(Integer.valueOf(Math.toIntExact(execution.wid)), uid)

  /**
    * Closes execution `eid`, unless it is closed already.
    *
    * @param neverStarted no unit ever started it: its results are marked expired in the same
    *                     UPDATE, so nothing looks for tables it never made, and it holds no
    *                     bytes until its plan table, if it has one, is measured
    * @return whether this call closed it
    */
  def close(
      eid: Long,
      outcome: Short,
      reason: Option[String],
      endedAtMs: Long,
      fromLog: Boolean,
      neverStarted: Boolean = false
  ): Boolean = {
    requireOutcome(outcome)
    require(!(neverStarted && fromLog), "an execution that never started has no log to end in")
    val endedAt = timeOf(endedAtMs)
    val closing = context
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.OUTCOME, Short.box(outcome))
      .set(WORKFLOW_EXECUTIONS.OUTCOME_REASON, reason.orNull)
      .set(WORKFLOW_EXECUTIONS.ENDED_AT, endedAt)
      .set(WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG, Boolean.box(fromLog))
    val unstarted =
      if (neverStarted)
        closing
          .set(WORKFLOW_EXECUTIONS.RESULTS_EXPIRED_AT, endedAt)
          .set(WORKFLOW_EXECUTIONS.STORED_BYTES, Long.box(0L))
      else closing
    unstarted
      .where(rowOf(eid).and(WORKFLOW_EXECUTIONS.ENDED_AT.isNull))
      .execute() == 1
  }

  /**
    * Replaces the verdict execution `eid` was closed by with the ending its log holds, unless
    * its outcome is from its log already, or its results are marked expired.
    *
    * @return whether this call replaced it
    */
  def revise(eid: Long, outcome: Short, reason: Option[String], endedAtMs: Long): Boolean = {
    requireOutcome(outcome)
    context
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.OUTCOME, Short.box(outcome))
      .set(WORKFLOW_EXECUTIONS.OUTCOME_REASON, reason.orNull)
      .set(WORKFLOW_EXECUTIONS.ENDED_AT, timeOf(endedAtMs))
      .set(WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG, java.lang.Boolean.TRUE)
      .where(
        rowOf(eid)
          .and(WORKFLOW_EXECUTIONS.ENDED_AT.isNotNull)
          .and(WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG.isFalse)
          .and(WORKFLOW_EXECUTIONS.RESULTS_EXPIRED_AT.isNull)
      )
      .execute() == 1
  }

  /** Records what the tables of execution `eid` hold in the lake. */
  def setStoredBytes(eid: Long, bytes: Long): Unit =
    context
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.STORED_BYTES, Long.box(bytes))
      .where(rowOf(eid))
      .execute()

  /**
    * `ms`, epoch milliseconds, as a value for a timestamp column, to the millisecond. Bound as
    * a plain `Timestamp`, jOOQ casts it to the type it generated for the column, which keeps
    * whole seconds: an ending would no longer be at the time its log gives.
    */
  private def timeOf(ms: Long): Field[Timestamp] =
    DSL.value(new Timestamp(ms), SQLDataType.TIMESTAMP(3))

  private def rowOf(eid: Long): Condition =
    WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(Math.toIntExact(eid)))

  private def requireOutcome(outcome: Short): Unit =
    require(
      WorkflowExecutionStatus.Ended.contains(outcome),
      s"an execution ends completed, failed or killed, not as $outcome"
    )

  /** The rows that meet `condition`, each with its workflow, its warehouse and its unit. */
  private def select(condition: Condition): Seq[ExecutionRecord] =
    context
      .select(
        WORKFLOW_EXECUTIONS.EID,
        WORKFLOW_VERSION.WID,
        WORKFLOW_EXECUTIONS.UID,
        WORKFLOW_EXECUTIONS.CUID,
        USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME,
        WORKFLOW_EXECUTIONS.STARTING_TIME,
        WORKFLOW_EXECUTIONS.NOTIFICATION,
        WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME,
        WORKFLOW_COMPUTING_UNIT.TERMINATION_REASON,
        WORKFLOW_EXECUTIONS.OUTCOME,
        WORKFLOW_EXECUTIONS.OUTCOME_REASON,
        WORKFLOW_EXECUTIONS.ENDED_AT,
        WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG
      )
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
      .leftJoin(USER_WAREHOUSE)
      .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
      .leftJoin(WORKFLOW_COMPUTING_UNIT)
      .on(WORKFLOW_COMPUTING_UNIT.CUID.eq(WORKFLOW_EXECUTIONS.CUID))
      .where(condition)
      .orderBy(WORKFLOW_EXECUTIONS.EID)
      .fetch()
      .asScala
      .map(recordOf)
      .toSeq

  private def recordOf(row: Record): ExecutionRecord =
    ExecutionRecord(
      eid = row.get(WORKFLOW_EXECUTIONS.EID).longValue(),
      wid = row.get(WORKFLOW_VERSION.WID).longValue(),
      uid = row.get(WORKFLOW_EXECUTIONS.UID).intValue(),
      cuid = Option(row.get(WORKFLOW_EXECUTIONS.CUID)).map(_.intValue()),
      warehouse = Option(row.get(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)),
      startingTimeMs = row.get(WORKFLOW_EXECUTIONS.STARTING_TIME).getTime,
      notification = Option(row.get(WORKFLOW_EXECUTIONS.NOTIFICATION)),
      unitTerminatedAtMs = Option(row.get(WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME)).map(_.getTime),
      unitTerminationReason = Option(row.get(WORKFLOW_COMPUTING_UNIT.TERMINATION_REASON)),
      closing = Option(row.get(WORKFLOW_EXECUTIONS.ENDED_AT)).map { endedAt =>
        ClosingRecord(
          outcome = row.get(WORKFLOW_EXECUTIONS.OUTCOME).shortValue(),
          reason = Option(row.get(WORKFLOW_EXECUTIONS.OUTCOME_REASON)),
          endedAtMs = endedAt.getTime,
          fromLog = row.get(WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG).booleanValue()
        )
      }
    )
}
