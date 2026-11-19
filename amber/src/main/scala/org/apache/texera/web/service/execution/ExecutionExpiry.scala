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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.{
  ExecutionLabel,
  ExecutionLogStore,
  ExecutionTables,
  WarehouseReadGuard
}
import org.apache.texera.amber.engine.architecture.logreplay.ReplayLogRecord
import org.apache.texera.amber.engine.common.storage.SequentialRecordStorage
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.service.util.LargeBinaryManager

import java.net.URI
import scala.annotation.tailrec
import scala.util.control.NonFatal

object ExecutionExpiry {

  /** How many executions a pass by age reads at a time, unless told otherwise. */
  val BatchSize = 200

  /** For [[ExecutionExpiry.expireReplaced]]: every execution, up to the newest. */
  val UpToNewest: Long = Int.MaxValue.toLong

  /** The Dashboard service's own, shared by its routes and its jobs. */
  lazy val forDeployment: ExecutionExpiry = new ExecutionExpiry()

  def deleteReplayLog(location: String): Unit =
    SequentialRecordStorage.getStorage[ReplayLogRecord](Some(new URI(location))).deleteStorage()
}

/**
  * Drops what executions keep outside their rows once it is no longer wanted, at the Dashboard
  * service. A computing unit drops nothing.
  *
  * Expiring an execution's results ([[expire]]) drops what its run produced: the result table
  * and the state table of each output port, its console table and its large binaries. Its log
  * and its statistics stay, so the history still tells how it ran, and its row is marked
  * with when its results went and what it still holds. Results expire when a unit has started a
  * later execution of the workflow ([[expireReplaced]]), which the unit shows from then on, and
  * when they are older than results are kept ([[expirePast]]), which also deletes the
  * execution's replay log. Deleting an execution drops everything it keeps ([[dropAll]]).
  *
  * An execution's tables are found by their names, which lists whole namespaces
  * ([[ExecutionTables]]).
  *
  * Any number of Dashboard replicas may expire the same execution: dropping a table that is
  * gone does nothing, and of several that mark its row, one does. Tables in a per-user
  * warehouse are left alone while those are disabled (#6930), and such an execution is not
  * marked.
  *
  * A lake call that throws is thrown on by [[expire]] and [[dropAll]], never taken for "nothing
  * there": the row is then not marked, so whoever asked can ask again.
  *
  * @param now the Dashboard service's clock, in epoch milliseconds
  */
class ExecutionExpiry(
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
    label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
    deleteBinaries: Long => Unit = LargeBinaryManager.deleteByExecution,
    deleteReplayLog: String => Unit = ExecutionExpiry.deleteReplayLog,
    now: () => Long = () => System.currentTimeMillis(),
    batchSize: Int = ExecutionExpiry.BatchSize
) extends LazyLogging {

  /**
    * Expires the results of execution `eid`, unless it is open or they are expired already.
    *
    * @param withReplayLog whether its replay log is deleted as well, and no longer named by its
    *                      row; a replay log that cannot be deleted is logged, and stays named
    * @return whether this call marked the row
    */
  def expire(eid: Long, withReplayLog: Boolean = false): Boolean =
    expire(eid, withReplayLog, pastAge = None, why = "")

  /**
    * Expires the results that are past `pastAge`, with their executions' replay logs, in the
    * order the executions were made. The age counts from the ending the row holds. An
    * execution closed by a verdict keeps its results for as long as the ending in its log may
    * replace the verdict, however short results are kept: its unit may only be cut off from the
    * lake, and still be writing them. Once its results are expired, a verdict stands.
    *
    * An execution that cannot be expired is logged and passed over, to be found again by a
    * later call.
    *
    * @return how many executions this call expired
    */
  def expirePast(pastAge: PastAge): Int = {
    @tailrec def from(afterEid: Long, expired: Int): Int = {
      val batch = ExecutionRecords.unexpiredPast(pastAge, afterEid, batchSize, warehousesEnabled)
      val expiredSoFar = expired + batch.count { execution =>
        tryExpire(execution.eid, withReplayLog = true, Some(pastAge), " by age").contains(true)
      }
      if (batch.size < batchSize) expiredSoFar
      else from(batch.last.eid, expiredSoFar)
    }
    from(afterEid = 0L, expired = 0)
  }

  /**
    * Expires the results that a later execution of workflow `wid` on computing unit `cuid` has
    * replaced: those of its closed executions made before the newest one, up to `replacedBy`
    * ([[ExecutionExpiry.UpToNewest]]: of them all), that a unit has started. An execution that
    * was only created replaces nothing: the unit still shows what it ran last, whose results
    * stay until it runs another. An open execution may still run, so it is left alone, and so
    * are the workflow's executions on other units.
    *
    * Whether a unit started an execution is what its log's label tells: it names a state.
    *
    * Nothing is thrown here: what fails is logged, and the results it was about are kept.
    *
    * @return false when something failed, so that whoever asked can ask again
    */
  def expireReplaced(wid: Long, cuid: Int, replacedBy: Long): Boolean =
    try {
      val held = ExecutionRecords.unexpiredBefore(wid, cuid, replacedBy)
      val replaced = held.headOption.toSeq.flatMap { oldest =>
        // Newest first: the first a unit has started is the one the unit shows.
        ExecutionRecords
          .madeAfter(wid, cuid, oldest.eid, replacedBy)
          .find(hasStarted)
          .toSeq
          .flatMap(shown => held.filter(_.eid < shown.eid).map(_ -> shown))
      }
      replaced
        .map {
          case (execution, shown) =>
            tryExpire(
              execution.eid,
              withReplayLog = false,
              pastAge = None,
              s", which execution ${shown.eid} replaced on computing unit $cuid"
            )
        }
        .forall(_.isDefined)
    } catch {
      case NonFatal(failure) =>
        logger.warn(
          s"What execution $replacedBy of workflow $wid replaced on computing unit $cuid could " +
            "not be told, so the earlier executions keep their results.",
          failure
        )
        false
    }

  /**
    * Drops everything execution `eid` keeps outside its row, whether it is open or closed: its
    * tables of every kind, its large binaries and its replay log. Every table is found by its
    * name, so one that nothing else names goes too. For when the execution is deleted: its row
    * is left to the caller. Nothing happens for an execution with no row. A replay log that
    * cannot be deleted is logged and left.
    */
  def dropAll(eid: Long): Unit =
    ExecutionRecords.find(eid).foreach { execution =>
      val dropped =
        if (inDisabledWarehouse(execution)) None
        else
          Some(
            ExecutionTables.dropNamed(
              execution.workflowId,
              execution.executionId,
              execution.warehouse,
              ExecutionTables.AllKinds
            )
          )
      deleteBinaries(eid)
      deleteReplayLogOf(eid)
      logger.info(
        s"Dropped what execution $eid of workflow ${execution.wid} kept: " +
          dropped.fold("its tables are left where they are, as per-user warehouses are disabled")(
            tables => s"${tables.size} tables"
          ) + "."
      )
    }

  /**
    * [[expire]], logging what fails instead of throwing it.
    *
    * @return whether the row was marked; None when the expiry failed
    */
  private def tryExpire(
      eid: Long,
      withReplayLog: Boolean,
      pastAge: Option[PastAge],
      why: String
  ): Option[Boolean] =
    try Some(expire(eid, withReplayLog, pastAge, why))
    catch {
      case NonFatal(failure) =>
        logger.warn(
          s"The results of execution $eid could not be expired, so it keeps them.",
          failure
        )
        None
    }

  /**
    * Drops what the run of execution `eid` produced, then marks its row, which is read again
    * for that: an execution is expired only while it is closed, holds results, and, with
    * `pastAge`, they are past that age.
    *
    * @param why why they are expired, as the log line goes on to say
    */
  private def expire(
      eid: Long,
      withReplayLog: Boolean,
      pastAge: Option[PastAge],
      why: String
  ): Boolean =
    ExecutionRecords.unexpired(eid, pastAge).exists { execution =>
      if (inDisabledWarehouse(execution)) {
        logger.info(
          s"Leaving the results of execution $eid where they are: per-user warehouses are disabled."
        )
        false
      } else {
        dropProduced(execution)
        if (withReplayLog) deleteReplayLogOf(eid)
        val kept = keptBytes(execution)
        val expired = ExecutionRecords.expire(eid, now(), kept, pastAge)
        if (expired) {
          logger.info(
            s"The results of execution $eid of workflow ${execution.wid} are expired$why; its " +
              s"log and statistics hold $kept bytes."
          )
        }
        expired
      }
    }

  private def inDisabledWarehouse(execution: ExecutionRecord): Boolean =
    WarehouseReadGuard.skipWhileDisabled(execution.logUri, warehousesEnabled)

  /** Drops the tables of what the run of `execution` produced, found by their names. */
  private def dropProduced(execution: ExecutionRecord): Unit = {
    ExecutionTables.dropNamed(
      execution.workflowId,
      execution.executionId,
      execution.warehouse,
      ExecutionTables.ProducedKinds
    )
    deleteBinaries(execution.eid)
  }

  /** The bytes of what an expired `execution` keeps: its log and its statistics. */
  private def keptBytes(execution: ExecutionRecord): Long =
    Seq(execution.logUri, execution.statisticsUri).map(ExecutionTables.storedBytes).sum

  /**
    * Deletes the replay log of execution `eid`, if its row names one, which it then no longer
    * does. A log that cannot be deleted is logged, and stays named.
    */
  private def deleteReplayLogOf(eid: Long): Unit =
    ExecutionRecords.replayLogOf(eid).foreach { location =>
      try {
        deleteReplayLog(location)
        ExecutionRecords.forgetReplayLog(eid)
      } catch {
        case NonFatal(failure) =>
          logger.warn(
            s"The replay log of execution $eid at $location could not be deleted, so it is left.",
            failure
          )
      }
    }

  /**
    * Whether a unit has started `execution`: its log's label names a state. An ending that was
    * recorded from its log says so without a read. One whose warehouse cannot be reached is not
    * read, and counts as not started.
    */
  private def hasStarted(execution: ExecutionRecord): Boolean =
    execution.closing.exists(_.fromLog) ||
      (!ExecutionClosing.warehouseUnavailable(execution.warehouse, warehousesEnabled) &&
        label(execution.logUri).exists(_.state.nonEmpty))
}
