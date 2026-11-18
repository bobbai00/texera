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

package org.apache.texera.web.resource.dashboard.admin.execution

import io.dropwizard.auth.Auth
import org.apache.texera.auth.SessionUser
import org.apache.texera.auth.util.WorkflowAccess
import org.apache.texera.dao.{SqlServer, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.web.resource.dashboard.admin.execution.AdminExecutionResource._
import org.apache.texera.web.service.execution.{
  ExecutionRecords,
  OpenExecution,
  OpenExecutionStatuses
}
import org.jooq.impl.DSL

import javax.annotation.security.RolesAllowed
import javax.ws.rs._
import javax.ws.rs.core.MediaType
import scala.jdk.CollectionConverters._

/**
  * This file handles various request related to saved-executions.
  */

object AdminExecutionResource {
  private def context =
    SqlServer
      .getInstance()
      .createDSLContext()

  // Jersey makes a resource for each request; this is the service's, shared by them all.
  private lazy val openStatuses = new OpenExecutionStatuses()

  /**
    * The latest execution of a workflow, as the admin page lists it.
    *
    * @param executionStatus the name of its status: how it ended once it is closed, and while
    *                        it is open the newest state in its log, CREATED when no unit has
    *                        written a state, UNKNOWN when its log cannot be read
    * @param executionTime   how long it has taken, in seconds: until it ended, or until now
    *                        while it is open
    * @param endTime         when it ended, in epoch milliseconds; 0 while it is open
    */
  case class dashboardExecution(
      workflowName: String,
      workflowId: Integer,
      userName: String,
      userId: Integer,
      executionId: Integer,
      executionStatus: String,
      executionTime: Double,
      executionName: String,
      startTime: Long,
      endTime: Long,
      access: Boolean
  )

  /** The names the admin page shows and filters by, for each status an execution can have. */
  private val statusNames: Seq[(Short, String)] = Seq(
    WorkflowExecutionStatus.Created -> "CREATED",
    WorkflowExecutionStatus.Initializing -> "READY",
    WorkflowExecutionStatus.Running -> "RUNNING",
    WorkflowExecutionStatus.Paused -> "PAUSED",
    WorkflowExecutionStatus.Completed -> "COMPLETED",
    WorkflowExecutionStatus.Failed -> "FAILED",
    WorkflowExecutionStatus.Killed -> "KILLED"
  )

  def mapToName(code: Short): String =
    statusNames.collectFirst { case (`code`, name) => name }.getOrElse("UNKNOWN")

  def mapToStatus(status: String): Int =
    statusNames.collectFirst { case (code, `status`) => code.toInt }.getOrElse(-1)

  val sortFieldMapping = Map(
    "workflow_name" -> WORKFLOW.NAME,
    "execution_name" -> WORKFLOW_EXECUTIONS.NAME,
    "initiator" -> USER.NAME,
    // An open execution has no end: Postgres sorts it as later than any.
    "end_time" -> WORKFLOW_EXECUTIONS.ENDED_AT
  )

}

@Produces(Array(MediaType.APPLICATION_JSON))
@Path("/admin/execution")
@RolesAllowed(Array("ADMIN"))
class AdminExecutionResource(openStatuses: OpenExecutionStatuses, now: () => Long) {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() = this(AdminExecutionResource.openStatuses, () => System.currentTimeMillis())

  @GET
  @Path("/totalWorkflow")
  @Produces()
  def getTotalWorkflows: Int = {
    context
      .select(
        DSL.countDistinct(WORKFLOW_VERSION.WID)
      )
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_EXECUTIONS.VID.eq(WORKFLOW_VERSION.VID))
      .fetchOne(0, classOf[Int])
  }

  /**
    * This method retrieves latest execution of each workflow for specified page.
    * The returned executions are sorted and filtered according to the parameters.
    *
    * A closed execution's status is in its row; an open one's is read from its log. So a
    * filter that names only endings is applied by the query, as the page is. One that names
    * a status of an open execution takes every open execution the query finds, reads their
    * logs, and cuts the page from those found in a status it names.
    */
  @GET
  @Path("/executionList/{pageSize}/{pageIndex}/{sortField}/{sortDirection}")
  @Produces(Array(MediaType.APPLICATION_JSON))
  def listWorkflows(
      @Auth current_user: SessionUser,
      @PathParam("pageSize") page_size: Int = 20,
      @PathParam("pageIndex") page_index: Int = 0,
      @PathParam("sortField") sortField: String = "end_time",
      @PathParam("sortDirection") sortDirection: String = "desc",
      @QueryParam("filter") filter: java.util.List[String]
  ): List[dashboardExecution] = {
    val filter_status = filter.asScala.map(mapToStatus).filter(_ != -1).map(_.toShort).toSet
    // Whether the filter names a status of an open execution, which only its log tells.
    val asksOpen = !filter_status.subsetOf(WorkflowExecutionStatus.Ended)

    val hasAccessField = DSL
      .field(WORKFLOW_VERSION.WID.in(WorkflowAccess.accessibleWids(current_user.getUid)))
      .as("has_access")

    // Base query that retrieves latest execution info for each workflow, filtered, without
    // sorting or paging.
    val executions_apply_filter = context
      .select(
        WORKFLOW_EXECUTIONS.UID,
        USER.NAME,
        WORKFLOW_VERSION.WID,
        WORKFLOW.NAME,
        WORKFLOW_EXECUTIONS.EID,
        WORKFLOW_EXECUTIONS.STARTING_TIME,
        WORKFLOW_EXECUTIONS.ENDED_AT,
        WORKFLOW_EXECUTIONS.OUTCOME,
        WORKFLOW_EXECUTIONS.NAME,
        USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME,
        hasAccessField
      )
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_EXECUTIONS.VID.eq(WORKFLOW_VERSION.VID))
      .join(USER)
      .on(WORKFLOW_EXECUTIONS.UID.eq(USER.UID))
      .join(WORKFLOW)
      .on(WORKFLOW.WID.eq(WORKFLOW_VERSION.WID))
      .naturalJoin(
        context
          .select(
            DSL.max(WORKFLOW_EXECUTIONS.EID).as("eid")
          )
          .from(WORKFLOW_EXECUTIONS)
          .join(WORKFLOW_VERSION)
          .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
          .groupBy(WORKFLOW_VERSION.WID)
      )
      .leftJoin(USER_WAREHOUSE)
      .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
      .where(ExecutionRecords.statusAmong(filter_status))

    // Apply sorting if user specified.
    val executions_apply_order =
      if (sortField != "NO_SORTING") {
        executions_apply_filter.orderBy(
          if (sortDirection == "desc") sortFieldMapping.getOrElse(sortField, WORKFLOW.NAME).desc()
          else sortFieldMapping.getOrElse(sortField, WORKFLOW.NAME).asc()
        )
      } else {
        executions_apply_filter
      }

    val pageOffset = page_index * page_size
    val executions =
      (if (asksOpen) executions_apply_order.fetch()
       else executions_apply_order.limit(page_size).offset(pageOffset).fetch()).asScala.toSeq

    val open = openStatuses.of(
      executions
        .filter(_.get(WORKFLOW_EXECUTIONS.ENDED_AT) == null)
        .map(workflowRecord =>
          OpenExecution(
            workflowRecord.get(WORKFLOW_EXECUTIONS.EID).longValue(),
            workflowRecord.get(WORKFLOW_VERSION.WID).longValue(),
            Option(workflowRecord.get(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)),
            workflowRecord.get(WORKFLOW_EXECUTIONS.STARTING_TIME).getTime
          )
        )
    )

    // Calculate the statistics needed for each execution.
    val listed = executions.map(workflowRecord => {
      val startingTime =
        workflowRecord.get(WORKFLOW_EXECUTIONS.STARTING_TIME).getTime
      val eid = workflowRecord.get(WORKFLOW_EXECUTIONS.EID)
      val endedAt = Option(workflowRecord.get(WORKFLOW_EXECUTIONS.ENDED_AT)).map(_.getTime)
      val status = endedAt match {
        case Some(_) => workflowRecord.get(WORKFLOW_EXECUTIONS.OUTCOME).shortValue()
        case None    => open(eid.longValue()).status
      }

      val timeDifferenceSeconds = (endedAt.getOrElse(now()) - startingTime) / 1000.0
      val hasAccess = java.lang.Boolean.TRUE.equals(workflowRecord.get(hasAccessField))
      status -> dashboardExecution(
        workflowRecord.get(WORKFLOW.NAME),
        workflowRecord.get(WORKFLOW_VERSION.WID),
        workflowRecord.get(USER.NAME),
        workflowRecord.get(WORKFLOW_EXECUTIONS.UID),
        eid,
        mapToName(status),
        timeDifferenceSeconds,
        workflowRecord.get(WORKFLOW_EXECUTIONS.NAME),
        startingTime,
        endedAt.getOrElse(0L),
        hasAccess
      )
    })

    (if (asksOpen)
       listed
         .filter { case (status, _) => filter_status.contains(status) }
         .slice(pageOffset, pageOffset + page_size)
     else listed).map(_._2).toList
  }
}
