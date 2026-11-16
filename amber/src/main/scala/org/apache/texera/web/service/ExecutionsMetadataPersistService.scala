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

package org.apache.texera.web.service

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  FAILED,
  READY
}
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.dao.SqlServer
import org.jooq.exception.DataAccessException
import org.apache.texera.dao.jooq.generated.Tables.WORKFLOW_EXECUTIONS
import org.apache.texera.dao.jooq.generated.tables.daos.WorkflowExecutionsDao
import org.apache.texera.dao.jooq.generated.tables.pojos.WorkflowExecutions
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowVersionResource._
import play.api.libs.json.Json

import java.sql.Timestamp

/**
  * This global object handles inserting a new entry to the DB to store metadata information about every workflow execution
  * It also updates the entry if an execution status is updated
  */
object ExecutionsMetadataPersistService extends LazyLogging {
  private def context =
    SqlServer
      .getInstance()
      .createDSLContext()
  private def workflowExecutionsDao =
    new WorkflowExecutionsDao(
      context.configuration
    )

  /**
    * This method inserts a new entry of a workflow execution in the database and returns the generated eId
    *
    * @param workflowId the given workflow
    * @param uid        user id that initiated the execution
    * @return generated execution ID
    */

  def insertNewExecution(
      workflowId: WorkflowIdentity,
      uid: Integer,
      executionName: String,
      environmentVersion: String,
      computingUnitId: Integer,
      warehouseId: Option[Int] = None
  ): ExecutionIdentity = {
    // first retrieve the latest version of this workflow
    val vid = getLatestVersion(workflowId.id.toInt)
    val newExecution = new WorkflowExecutions()
    if (executionName != "") {
      newExecution.setName(executionName)
    }
    newExecution.setVid(vid)
    newExecution.setUid(uid)
    newExecution.setStartingTime(new Timestamp(System.currentTimeMillis()))
    newExecution.setEnvironmentVersion(environmentVersion)

    // Set computing unit ID if provided
    newExecution.setCuid(computingUnitId)
    // The warehouse this run writes into (#6870); null = the shared default warehouse.
    warehouseId.foreach(id => newExecution.setWhid(id))

    try {
      workflowExecutionsDao.insert(newExecution)
    } catch {
      // A NOT NULL column (e.g. uid, vid, cuid) was null. Postgres reports this
      // as SQLState 23502; surface a readable message instead of the raw
      // jOOQ/JDBC stack trace, while preserving the original as the cause.
      case e: DataAccessException if e.sqlState() == "23502" =>
        throw new IllegalArgumentException(
          "Cannot persist workflow execution: a required field (uid, vid, or cuid) was null.",
          e
        )
    }
    ExecutionIdentity(newExecution.getEid.longValue())
  }

  /**
    * What an execution's row keeps as its environment version: the version of the engine (the
    * frontend's, or the agent's) that asked for it, as `{"engine_version": …}`. The key is part of
    * the stored format.
    */
  def environmentVersionOf(engineVersion: String): String =
    Json.stringify(Json.obj("engine_version" -> engineVersion))

  /**
    * Records a new execution of the latest version of workflow `workflowId`, created by user `uid`
    * to run on computing unit `computingUnitId`, and returns its id: the row the Dashboard inserts
    * when it creates an execution, before the execution's plan is made.
    *
    * The row is at status 0 (Initializing), set here rather than left to the column's default,
    * which is 1 (Running): no unit runs the execution yet. Its starting time is now. An empty
    * `executionName` keeps the column's default name.
    *
    * @param environmentVersion what the row keeps as the version of the engine that asked for it
    * @param warehouseId        the user_warehouse the execution writes into; None for the shared
    *                           default warehouse
    */
  def insertCreatedExecution(
      workflowId: WorkflowIdentity,
      uid: Integer,
      executionName: String,
      environmentVersion: String,
      computingUnitId: Integer,
      warehouseId: Option[Int]
  ): ExecutionIdentity = {
    val vid = getLatestVersion(Math.toIntExact(workflowId.id))
    val insert = context
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, uid)
      .set(WORKFLOW_EXECUTIONS.CUID, computingUnitId)
      .set(WORKFLOW_EXECUTIONS.STATUS, Short.box(maptoStatusCode(READY).toShort))
      .set(WORKFLOW_EXECUTIONS.STARTING_TIME, new Timestamp(System.currentTimeMillis()))
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, environmentVersion)
      .set(WORKFLOW_EXECUTIONS.WHID, warehouseId.map(Integer.valueOf).orNull)
    val named =
      if (executionName.nonEmpty) insert.set(WORKFLOW_EXECUTIONS.NAME, executionName) else insert
    ExecutionIdentity(named.returning(WORKFLOW_EXECUTIONS.EID).fetchOne().getEid.longValue())
  }

  /**
    * Records that execution `eid` failed before any unit ran it (FAILED, with the time of the
    * failure as its last update), the way [[updateStatus]] records any status.
    */
  def markFailed(eid: ExecutionIdentity): Unit =
    updateStatus(eid, maptoStatusCode(FAILED), new Timestamp(System.currentTimeMillis()))

  def tryGetExistingExecution(executionId: ExecutionIdentity): Option[WorkflowExecutions] = {
    try {
      Option(workflowExecutionsDao.fetchOneByEid(executionId.id.toInt))
    } catch {
      case t: Throwable =>
        logger.info("Unable to get execution. Error = " + t.getMessage)
        None
    }
  }

  def tryUpdateExistingExecution(
      executionId: ExecutionIdentity
  )(updateFunc: WorkflowExecutions => Unit): Unit = {
    try {
      val execution = workflowExecutionsDao.fetchOneByEid(executionId.id.toInt)
      updateFunc(execution)
      workflowExecutionsDao.update(execution)
    } catch {
      case t: Throwable =>
        logger.info("Unable to update execution. Error = " + t.getMessage)
    }
  }

  /**
    * Records an execution's status and when it changed, in one UPDATE by eid.
    *
    * It reads nothing first, so a run reports its state without reading Postgres, and it writes
    * no other column of the row. An unknown eid updates nothing. A failure is logged and
    * swallowed: a run must not fail because its status could not be stored.
    */
  def updateStatus(eid: ExecutionIdentity, status: Byte, at: Timestamp): Unit =
    tryUpdate(eid) {
      context
        .update(WORKFLOW_EXECUTIONS)
        .set(WORKFLOW_EXECUTIONS.STATUS, Short.box(status.toShort))
        .set(WORKFLOW_EXECUTIONS.LAST_UPDATE_TIME, at)
        .where(WORKFLOW_EXECUTIONS.EID.eq(eid.id.toInt))
        .execute()
    }

  /** Records where an execution writes its replay log, the way [[updateStatus]] records status. */
  def updateLogLocation(eid: ExecutionIdentity, location: String): Unit =
    tryUpdate(eid) {
      context
        .update(WORKFLOW_EXECUTIONS)
        .set(WORKFLOW_EXECUTIONS.LOG_LOCATION, location)
        .where(WORKFLOW_EXECUTIONS.EID.eq(eid.id.toInt))
        .execute()
    }

  // A failure leaves the row with a stale status or location, which an operator should see, so it
  // is a warning. It is never routine: an unknown eid matches no row instead of failing.
  private def tryUpdate(eid: ExecutionIdentity)(update: => Unit): Unit =
    try update
    catch {
      case t: Throwable =>
        logger.warn(s"Unable to update execution ${eid.id}. Error = ${t.getMessage}")
    }
}
