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
import org.apache.texera.amber.core.storage.{DocumentFactory, WarehouseReadGuard}
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.ExecutionIdentity
import org.apache.texera.amber.core.workflow.CostHints
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.COMPLETED
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{WORKFLOW_EXECUTIONS, WORKFLOW_VERSION}

import java.net.URI
import java.util.{Collections, LinkedHashMap => JLinkedHashMap, Map => JMap}
import scala.util.control.NonFatal

/**
  * Finds the cost hints of a run: how long each logical operator of the workflow took in the
  * newest completed run of it by the same user, for the scheduler's cost model. The hints are
  * saved with the plan, and the engine takes them from the run's context: it reads no statistics
  * and no database to schedule a run.
  *
  * The costs come from that run's runtime statistics. An operator's cost is the most data and
  * control processing time any row of its statistics records, in seconds. Only the user's own
  * runs are read, so no statistics from another user's warehouse reach this user's plan.
  *
  * A run's statistics no longer change once it has completed, and reading those of a long run
  * can take seconds, so the costs read from a run are kept, by its execution id, for the
  * `cacheCapacity` runs used most recently. A read that fails, or finds no cost, is not kept.
  * Loads that miss at the same time each read the statistics.
  *
  * @param cacheCapacity how many runs' costs to keep, at least 1
  */
class CostHintsLoader(cacheCapacity: Int) extends LazyLogging {
  require(cacheCapacity >= 1, s"Cost hints are kept for at least 1 run, not $cacheCapacity.")

  // The columns of the runtime statistics (ResultSchema.runtimeStatisticsSchema) that costs are
  // read from: the logical operator's id, and the nanoseconds it spent processing data and
  // control messages.
  private val OperatorIdField = "operatorId"
  private val DataProcessingTimeField = "dataProcessingTime"
  private val ControlProcessingTimeField = "controlProcessingTime"

  // The costs read from each run, by its execution id, the least recently used first.
  private val kept: JMap[java.lang.Long, CostHints] = Collections.synchronizedMap(
    new JLinkedHashMap[java.lang.Long, CostHints](16, 0.75f, true) {
      override def removeEldestEntry(eldest: JMap.Entry[java.lang.Long, CostHints]): Boolean =
        size() > cacheCapacity
    }
  )

  /**
    * The cost hints of a run of workflow `wid` by user `uid`: the costs in the statistics of the
    * user's newest completed run of the workflow, by starting time, of those that recorded
    * statistics. None when there is no such run, when its statistics are in a per-user warehouse
    * while those are disabled, when they name no operator, or when they cannot be read, which is
    * logged: the run is then scheduled without hints.
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
    * The id and statistics location of the user's newest completed run of the workflow that
    * recorded statistics, if there is one. A run whose id is below 1, which a plan is not saved
    * with the costs of, is passed over.
    */
  private def newestCompletedRun(wid: Long, uid: Int): Option[(ExecutionIdentity, String)] =
    Option(
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(WORKFLOW_EXECUTIONS.EID, WORKFLOW_EXECUTIONS.RUNTIME_STATS_URI)
        .from(WORKFLOW_EXECUTIONS)
        .join(WORKFLOW_VERSION)
        .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
        .where(
          WORKFLOW_VERSION.WID
            .eq(Integer.valueOf(Math.toIntExact(wid)))
            .and(WORKFLOW_EXECUTIONS.UID.eq(Integer.valueOf(uid)))
            .and(
              WORKFLOW_EXECUTIONS.STATUS
                .eq(java.lang.Short.valueOf(maptoStatusCode(COMPLETED).toShort))
            )
            .and(WORKFLOW_EXECUTIONS.RUNTIME_STATS_URI.isNotNull)
            .and(WORKFLOW_EXECUTIONS.RUNTIME_STATS_URI.ne(""))
            .and(WORKFLOW_EXECUTIONS.EID.ge(Integer.valueOf(1)))
        )
        .orderBy(WORKFLOW_EXECUTIONS.STARTING_TIME.desc(), WORKFLOW_EXECUTIONS.EID.desc())
        .limit(1)
        .fetchOne()
    ).map(run => (ExecutionIdentity(run.value1().longValue()), run.value2()))

  /**
    * The costs in the statistics of run `source` at `location`, read once and then kept. None if
    * they are in a per-user warehouse while those are disabled: they are not read then.
    */
  private def costsOf(source: ExecutionIdentity, location: String): Option[CostHints] = {
    val uri = new URI(location)
    if (WarehouseReadGuard.skipWhileDisabled(uri)) {
      logger.info(
        s"The statistics of execution ${source.id} are not read for cost hints: they are in a " +
          "per-user warehouse, and per-user warehouses are disabled."
      )
      None
    } else
      Option(kept.get(source.id)).orElse {
        val read = readCosts(source, uri)
        read.foreach(kept.put(source.id, _))
        read
      }
  }

  /** The costs the statistics at `uri` of run `source` record; None if they name no operator. */
  private def readCosts(source: ExecutionIdentity, uri: URI): Option[CostHints] = {
    val start = System.nanoTime()
    val seconds = openStatistics(uri).foldLeft(Map.empty[String, Double]) { (costs, row) =>
      val operatorId = row.getField[String](OperatorIdField)
      // A plan is not saved with the cost of an operator with no id.
      if (operatorId == null || operatorId.isEmpty) costs
      else {
        val processingNanos =
          row.getField[Long](DataProcessingTimeField) + row.getField[Long](
            ControlProcessingTimeField
          )
        costs.updated(
          operatorId,
          math.max(costs.getOrElse(operatorId, 0.0), processingNanos / 1e9)
        )
      }
    }
    logger.info(
      s"Read the statistics of execution ${source.id} for cost hints in " +
        s"${(System.nanoTime() - start) / 1000000} ms: ${seconds.size} operators."
    )
    Option.when(seconds.nonEmpty)(CostHints(source, seconds))
  }

  /**
    * The rows of the runtime statistics at `uri`. A seam, so a test can count the statistics
    * read.
    */
  protected def openStatistics(uri: URI): Iterator[Tuple] =
    DocumentFactory.openDocument(uri)._1.get().map(_.asInstanceOf[Tuple])
}

/** The cost hints of the runs this service starts, kept for the 256 runs used most recently. */
object CostHintsLoader extends CostHintsLoader(cacheCapacity = 256)
