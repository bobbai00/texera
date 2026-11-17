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
import org.apache.texera.amber.core.storage.result.iceberg.OnIceberg
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  ExecutionResultUris,
  WarehouseReadGuard
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.{SqlServer, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables.{
  OPERATOR_EXECUTIONS,
  OPERATOR_PORT_EXECUTIONS,
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.service.util.LargeBinaryManager
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.jooq.{Condition, Field}
import org.jooq.impl.DSL

import java.net.URI
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

/**
  * What an execution keeps outside its row: the warehouse it writes into, which is checked when
  * it is created ([[resolveLakekeeperWarehouseName]]); its plan table, found from its row and
  * dropped with it; and what it produced, which is cleared when a later execution of its workflow
  * on its unit replaces it ([[clearReplacedExecutions]]) or its unit is done with it.
  */
object ExecutionResources extends LazyLogging {

  /**
    * Maps an execution's chosen warehouse (its user_warehouse row id) to its Lakekeeper
    * warehouse name, checking that the requesting user owns it.
    *
    * With warehouses enabled a pick is **required**, the same way a computing unit is:
    * falling back to the shared default would make "a run writes into the user's own
    * warehouse" a UI convention rather than a system property, and would silently route
    * any caller that forgot to pick into shared storage (#7751).
    *
    * With warehouses disabled, an explicit pick is refused loudly rather than silently
    * routed into the shared warehouse, and no pick keeps the shared default (#6930).
    *
    * @throws IllegalArgumentException if the pick breaks one of these rules, in words the user
    *                                  can act on
    */
  def resolveLakekeeperWarehouseName(
      warehouseId: Option[Int],
      uid: Integer,
      enabled: Boolean = StorageConfig.warehouseEnabled
  ): Option[String] = {
    if (!enabled) {
      warehouseId.foreach(_ =>
        throw new IllegalArgumentException(
          "Per-user warehouses are disabled in this deployment."
        )
      )
      return None
    }
    if (warehouseId.isEmpty) {
      throw new IllegalArgumentException(
        "A warehouse must be selected for this execution."
      )
    }
    warehouseId.map(id => {
      val lakekeeperWarehouseName = SqlServer
        .getInstance()
        .createDSLContext()
        .select(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)
        .from(USER_WAREHOUSE)
        .where(USER_WAREHOUSE.WHID.eq(id).and(USER_WAREHOUSE.UID.eq(uid)))
        .fetchOne(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)
      if (lakekeeperWarehouseName == null) {
        throw new IllegalArgumentException(s"You have no warehouse with id $id.")
      }
      lakekeeperWarehouseName
    })
  }

  /**
    * Where execution `eid`'s plan table is: in the warehouse the execution writes into, or the
    * default one when it names none. None when there is no such execution.
    */
  def planUriOf(eid: ExecutionIdentity): Option[URI] = planUrisOf(Seq(eid)).get(eid)

  /**
    * [[planUriOf]] for each of `eids`, in one SELECT. An execution with no row is left out.
    *
    * A row whose warehouse was deleted names none (its `whid` is set to null), so its URI names
    * the default warehouse, where the plan table is not: dropping it there finds no table.
    */
  def planUrisOf(eids: Iterable[ExecutionIdentity]): Map[ExecutionIdentity, URI] =
    if (eids.isEmpty) Map.empty
    else
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(
          WORKFLOW_EXECUTIONS.EID,
          WORKFLOW_VERSION.WID,
          USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME
        )
        .from(WORKFLOW_EXECUTIONS)
        .join(WORKFLOW_VERSION)
        .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
        .leftJoin(USER_WAREHOUSE)
        .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
        .where(
          WORKFLOW_EXECUTIONS.EID.in(
            eids.map(eid => Integer.valueOf(Math.toIntExact(eid.id))).toSeq.distinct.asJava
          )
        )
        .fetch()
        .asScala
        .map { row =>
          val eid = ExecutionIdentity(row.value1().longValue())
          eid -> ExecutionPlanStore.planUri(
            WorkflowIdentity(row.value2().longValue()),
            eid,
            Option(row.value3())
          )
        }
        .toMap

  /**
    * Drops the plan tables at `planUris`, with their rows and their start claims, once the
    * executions they belong to are deleted. A table in a per-user warehouse is left alone while
    * those are disabled, as every clean-up leaves those warehouses alone (#6930). A drop that
    * fails is logged, not thrown: the executions are gone by then, so a failure can only leave a
    * table behind.
    */
  def dropPlanTables(planUris: Iterable[URI]): Unit =
    planUris.foreach { uri =>
      if (WarehouseReadGuard.skipWhileDisabled(uri)) {
        logger.info(s"Leaving the plan table at $uri: per-user warehouses are disabled.")
      } else {
        try ExecutionPlanStore.drop(uri)
        catch {
          case NonFatal(failure) =>
            logger.warn(s"The plan table at $uri could not be dropped.", failure)
        }
      }
    }

  /**
    * Clears what execution `eid` produced, keeping its row: its results, console messages and
    * large binaries, and the history of its runtime statistics.
    *
    * In this order:
    *  1. Retrieves all document URIs associated with the execution
    *  2. Clears URI references from the execution registry
    *  3. Safely clears all result and console message documents
    *  4. Expires Iceberg snapshots for runtime statistics
    *  5. Deletes this execution's large binaries from the object store
    *
    * A document that cannot be cleared is logged at debug level and passed over. Its plan table
    * stays: it is dropped only with the execution ([[dropPlanTables]]).
    */
  def clearExecutionResources(eid: ExecutionIdentity): Unit = {
    // Retrieve URIs for all resources associated with this execution
    val resultUris = ExecutionResultUris.getResultUrisByExecutionId(eid)
    val consoleMessagesUris = WorkflowExecutionsResource.getConsoleMessagesUriByExecutionId(eid)

    // Remove references from registry first
    WorkflowExecutionsResource.deleteConsoleMessageAndExecutionResultUris(eid)

    // Clean up all result and console message documents. While per-user warehouses are
    // disabled, cleanup must not reach into them (#6930) — those URIs are skipped.
    (resultUris ++ consoleMessagesUris).foreach { uri =>
      if (WarehouseReadGuard.skipWhileDisabled(uri)) {
        logger.info(s"skipping cleanup of $uri: per-user warehouses are disabled")
      } else
        try DocumentFactory.openDocument(uri)._1.clear()
        catch {
          case error: Throwable =>
            logger.debug(s"Error processing document at $uri: ${error.getMessage}")
        }
    }

    // Expire any Iceberg snapshots for runtime statistics
    WorkflowExecutionsResource.getRuntimeStatsUriByExecutionId(eid).foreach { uri =>
      if (WarehouseReadGuard.skipWhileDisabled(uri)) {
        logger.info(s"skipping snapshot expiry of $uri: per-user warehouses are disabled")
      } else
        try {
          DocumentFactory.openDocument(uri)._1 match {
            case iceberg: OnIceberg => iceberg.expireSnapshots()
            case other =>
              logger.error(
                s"Cannot expire snapshots: document from URI [$uri] is of type ${other.getClass.getName}. " +
                  s"Expected an instance of ${classOf[OnIceberg].getName}."
              )
          }
        } catch {
          case error: Throwable =>
            logger.debug(s"Error processing document at $uri: ${error.getMessage}")
        }
    }
    // Delete this execution's large binaries
    LargeBinaryManager.deleteByExecution(eid.id)
  }

  /**
    * Clears what the executions of workflow `wid` on computing unit `cuid` produced that a later
    * execution has replaced: those that have ended (completed, failed or killed), still hold
    * results or console messages, and are older than an execution of the workflow on the unit
    * that holds some of its own.
    *
    * A unit writes those as it runs an execution, so nothing is cleared for an execution that
    * was only created: the execution the unit ran last, whose results it still shows, keeps them
    * until a later one has results in their place. The status does not tell as much, since an
    * execution that failed at its create is recorded like one that failed on its unit. An
    * execution that may still run, whatever its state, is left alone, and so are the workflow's
    * runs on any other unit.
    *
    * Each is cleared by [[clearExecutionResources]]. Nothing here is thrown: an execution that
    * cannot be cleared, or a database that cannot list them, is logged, and keeps its results.
    */
  def clearReplacedExecutions(wid: WorkflowIdentity, cuid: Int): Unit = {
    val replaced =
      try replacedExecutions(wid, cuid)
      catch {
        case NonFatal(failure) =>
          logger.warn(
            s"The replaced executions of workflow ${wid.id} on computing unit $cuid could not " +
              "be listed, so their results are kept.",
            failure
          )
          Seq.empty
      }
    replaced.foreach { eid =>
      try {
        clearExecutionResources(eid)
        logger.info(
          s"Cleared the results of execution ${eid.id}, which a later execution of workflow " +
            s"${wid.id} on computing unit $cuid replaced."
        )
      } catch {
        case NonFatal(failure) =>
          logger.warn(s"The results of execution ${eid.id} could not be cleared.", failure)
      }
    }
  }

  /**
    * The executions [[clearReplacedExecutions]] clears, oldest first, in one SELECT: those of
    * `wid` (through its versions) on `cuid` that have ended, have a row in
    * `operator_port_executions` or `operator_executions`, and have a lower id than another
    * execution of `wid` on `cuid` with such a row.
    */
  private def replacedExecutions(wid: WorkflowIdentity, cuid: Int): Seq[ExecutionIdentity] = {
    val workflowId = Integer.valueOf(Math.toIntExact(wid.id))
    val later = WORKFLOW_EXECUTIONS.as("later")
    val laterVersion = WORKFLOW_VERSION.as("later_version")
    SqlServer
      .getInstance()
      .createDSLContext()
      .select(WORKFLOW_EXECUTIONS.EID)
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
      .where(
        WORKFLOW_VERSION.WID
          .eq(workflowId)
          .and(WORKFLOW_EXECUTIONS.CUID.eq(Integer.valueOf(cuid)))
          .and(WORKFLOW_EXECUTIONS.STATUS.in(WorkflowExecutionStatus.Ended.map(Short.box).asJava))
          .and(holdsResults(WORKFLOW_EXECUTIONS.EID))
          .and(
            DSL.exists(
              DSL
                .selectOne()
                .from(later)
                .join(laterVersion)
                .on(laterVersion.VID.eq(later.VID))
                .where(
                  laterVersion.WID
                    .eq(workflowId)
                    .and(later.CUID.eq(Integer.valueOf(cuid)))
                    .and(later.EID.gt(WORKFLOW_EXECUTIONS.EID))
                    .and(holdsResults(later.EID))
                )
            )
          )
      )
      .orderBy(WORKFLOW_EXECUTIONS.EID)
      .fetch()
      .asScala
      .map(row => ExecutionIdentity(row.value1().longValue()))
      .toSeq
  }

  /** Whether the execution whose id is `eid` has a result or a console registered. */
  private def holdsResults(eid: Field[Integer]): Condition =
    DSL
      .exists(
        DSL
          .selectOne()
          .from(OPERATOR_PORT_EXECUTIONS)
          .where(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(eid))
      )
      .or(
        DSL.exists(
          DSL
            .selectOne()
            .from(OPERATOR_EXECUTIONS)
            .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(eid))
        )
      )
}
