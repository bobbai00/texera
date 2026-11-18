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
  RuntimeStatisticsRow,
  RuntimeStatisticsStore,
  WarehouseReadGuard
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.CostHints
import org.apache.texera.dao.{SqlServer, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}

import java.net.URI
import java.util.concurrent.{
  CompletableFuture,
  ConcurrentHashMap,
  ExecutionException,
  TimeUnit,
  TimeoutException
}
import java.util.{Collections, LinkedHashMap => JLinkedHashMap, Map => JMap}
import scala.concurrent.duration.{Duration, DurationInt, FiniteDuration}
import scala.util.control.NonFatal

object CostHintsLoader {

  // The columns of the runtime statistics that costs are read from: the logical operator's id,
  // and the nanoseconds it spent processing data and control messages.
  private val CostColumns = Set("operatorId", "dataProcessingTime", "controlProcessingTime")

  /**
    * The rows of the runtime statistics at `uri`, with the columns costs are read from alone.
    * None from a table written before statistics were stored as they are now.
    */
  def statisticsAt(uri: URI): Seq[RuntimeStatisticsRow] =
    RuntimeStatisticsStore.read(uri, CostColumns)
}

/**
  * Finds the cost hints of a run: how long each logical operator of the workflow took in the
  * newest completed run of it by the same user, for the scheduler's cost model. The hints are
  * saved with the plan, and the engine takes them from the run's context: it reads no statistics
  * and no database to schedule a run.
  *
  * The costs come from that run's runtime statistics, which are where its row says its tables
  * are: the statistics table of its workflow and execution, in the warehouse it wrote into. An
  * operator's cost is the most data and control processing time any row of its statistics
  * records, in seconds. Only the user's own runs are read, so no statistics from another user's
  * warehouse reach this user's plan.
  *
  * A run's statistics no longer change once it has completed, and reading those of a long run
  * can take seconds, so the costs read from a run are kept, by its execution id, for the
  * `cacheCapacity` runs used most recently. A read that fails, or finds no cost, is not kept.
  * Loads that miss the same run at the same time share one read of its statistics, and its
  * outcome: a load that comes after the read ended reads again if it kept nothing. A load waits
  * for another's read for at most `waitLimit`, and gives its run no hints if the read takes longer:
  * a read that stalls holds up only the load that makes it.
  *
  * @param cacheCapacity  how many runs' costs to keep, at least 1
  * @param waitLimit      how long a load waits for the read another load makes, more than 0: by
  *                       default a quarter of the time a create is given
  * @param openStatistics reads the rows of the runtime statistics at a URI: each row's
  *                       operator and processing times
  */
class CostHintsLoader(
    cacheCapacity: Int = 256,
    waitLimit: FiniteDuration = 30.seconds,
    openStatistics: URI => Seq[RuntimeStatisticsRow] = CostHintsLoader.statisticsAt
) extends LazyLogging {
  require(cacheCapacity >= 1, s"Cost hints are kept for at least 1 run, not $cacheCapacity.")
  require(
    waitLimit > Duration.Zero,
    s"A load waits for another's read for more than no time, not $waitLimit."
  )

  // The reads of statistics under way, by the execution id of the run read. A load that misses a
  // run being read waits for that read rather than reading the statistics again.
  private val reading =
    new ConcurrentHashMap[java.lang.Long, CompletableFuture[Option[CostHints]]]()

  // The costs read from each run, by its execution id, the least recently used first.
  private val kept: JMap[java.lang.Long, CostHints] = Collections.synchronizedMap(
    new JLinkedHashMap[java.lang.Long, CostHints](16, 0.75f, true) {
      override def removeEldestEntry(eldest: JMap.Entry[java.lang.Long, CostHints]): Boolean =
        size() > cacheCapacity
    }
  )

  /**
    * The cost hints of a run of workflow `wid` by user `uid`: the costs in the statistics of the
    * user's newest run of the workflow, by starting time, that is closed as completed. None when
    * there is no such run, when its statistics are in a per-user warehouse while those are
    * disabled, when they name no operator, or when they cannot be read, which is logged: the run
    * is then scheduled without hints.
    */
  def load(wid: Long, uid: Int): Option[CostHints] =
    try {
      newestCompletedRun(wid, uid).flatMap { case (source, location) => costsOf(source, location) }
    } catch {
      case NonFatal(failure) =>
        // A warning of one line, the stack trace at debug level: a read that fails is not kept,
        // so every start of the workflow by the user reads and warns again.
        logger.warn(
          s"The cost hints of a run of workflow $wid by user $uid cannot be read, so the run is " +
            s"scheduled without them: $failure"
        )
        logger.debug(
          s"Reading the cost hints of a run of workflow $wid by user $uid failed.",
          failure
        )
        None
    }

  /**
    * The id and statistics location of the user's newest run of the workflow whose closing
    * record says it completed, if there is one. A run is completed for this once the Dashboard
    * service closed it, up to a tick of the closing job after its unit finished it. A run
    * whose id is below 1, which a plan is not saved with the costs of, is passed over.
    */
  private def newestCompletedRun(wid: Long, uid: Int): Option[(ExecutionIdentity, URI)] =
    Option(
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(WORKFLOW_EXECUTIONS.EID, USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)
        .from(WORKFLOW_EXECUTIONS)
        .join(WORKFLOW_VERSION)
        .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
        .leftJoin(USER_WAREHOUSE)
        .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
        .where(
          WORKFLOW_VERSION.WID
            .eq(Integer.valueOf(Math.toIntExact(wid)))
            .and(WORKFLOW_EXECUTIONS.UID.eq(Integer.valueOf(uid)))
            .and(WORKFLOW_EXECUTIONS.OUTCOME.eq(Short.box(WorkflowExecutionStatus.Completed)))
            .and(WORKFLOW_EXECUTIONS.EID.ge(Integer.valueOf(1)))
        )
        .orderBy(WORKFLOW_EXECUTIONS.STARTING_TIME.desc(), WORKFLOW_EXECUTIONS.EID.desc())
        .limit(1)
        .fetchOne()
    ).map { run =>
      val source = ExecutionIdentity(run.value1().longValue())
      (
        source,
        RuntimeStatisticsStore.statisticsUri(WorkflowIdentity(wid), source, Option(run.value2()))
      )
    }

  /**
    * The costs in the statistics of run `source` at `uri`, read once and then kept. None if
    * they are in a per-user warehouse while those are disabled: they are not read then.
    */
  private def costsOf(source: ExecutionIdentity, uri: URI): Option[CostHints] =
    if (WarehouseReadGuard.skipWhileDisabled(uri)) {
      logger.info(
        s"The statistics of execution ${source.id} are not read for cost hints: they are in a " +
          "per-user warehouse, and per-user warehouses are disabled."
      )
      None
    } else
      Option(kept.get(source.id)).orElse(readOnce(source, uri))

  /**
    * The costs the statistics at `uri` of run `source` record, read once by the loads that miss
    * them at the same time: the first reads, and keeps what it finds; the others wait for its
    * outcome, a failure included, for at most `waitLimit`, and find no costs if it takes longer.
    */
  private def readOnce(source: ExecutionIdentity, uri: URI): Option[CostHints] = {
    val mine = new CompletableFuture[Option[CostHints]]()
    Option(reading.putIfAbsent(source.id, mine)) match {
      case Some(underWay) =>
        try underWay.get(waitLimit.toMillis, TimeUnit.MILLISECONDS)
        catch {
          case waited: ExecutionException => throw waited.getCause
          case _: TimeoutException =>
            logger.warn(
              s"The statistics of execution ${source.id} are still being read for cost hints " +
                s"after $waitLimit, so the run is scheduled without them."
            )
            None
        }
      case None =>
        try {
          // A read that ended between this load's miss and its claim kept what it found.
          val read = Option(kept.get(source.id)).orElse {
            val found = readCosts(source, uri)
            found.foreach(kept.put(source.id, _))
            found
          }
          mine.complete(read)
          read
        } catch {
          case failure: Throwable =>
            mine.completeExceptionally(failure)
            throw failure
        } finally reading.remove(source.id, mine)
    }
  }

  /** The costs the statistics at `uri` of run `source` record; None if they name no operator. */
  private def readCosts(source: ExecutionIdentity, uri: URI): Option[CostHints] = {
    val start = System.nanoTime()
    val seconds = openStatistics(uri).foldLeft(Map.empty[String, Double]) { (costs, row) =>
      // A plan is not saved with the cost of an operator with no id.
      if (row.operatorId.isEmpty) costs
      else {
        val processingNanos = row.dataProcessingTime + row.controlProcessingTime
        costs.updated(
          row.operatorId,
          math.max(costs.getOrElse(row.operatorId, 0.0), processingNanos / 1e9)
        )
      }
    }
    logger.info(
      s"Read the statistics of execution ${source.id} for cost hints in " +
        s"${(System.nanoTime() - start) / 1000000} ms: ${seconds.size} operators."
    )
    Option.when(seconds.nonEmpty)(CostHints(source, seconds))
  }
}
