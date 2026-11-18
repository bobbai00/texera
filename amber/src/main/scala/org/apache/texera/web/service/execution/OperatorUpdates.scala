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

import com.fasterxml.jackson.databind.JsonNode
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.{
  ExecutionPlanStore,
  NoStoredPlanException,
  PlanRecord,
  PlanTooLargeException
}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlanCodec}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.{ComputingUnitAccess, WorkflowAccess}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.http.request.execution.OperatorUpdateRequestBody
import org.apache.texera.web.model.http.response.execution.OperatorUpdateResponse
import org.apache.texera.web.service.execution.WorkflowCompilingService.{
  CompileRefused,
  CompileUnanswered,
  RunningOperator,
  UpdateRequest
}

import java.net.URI
import java.util.UUID
import javax.ws.rs.core.Response
import javax.ws.rs.{
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  WebApplicationException
}
import scala.concurrent.duration.FiniteDuration
import scala.util.control.NonFatal

object OperatorUpdates {

  /** The property an operator's JSON names its id by: all the Dashboard reads of a change. */
  private val OperatorIdField = "operatorID"

  /**
    * What a change to an execution's operator reads of the execution's row.
    *
    * @param ended whether the row has its closing record
    */
  private case class ExecutionRow(
      wid: Long,
      uid: Int,
      cuid: Option[Int],
      ended: Boolean,
      warehouse: Option[String]
  )
}

/**
  * Changes to an operator of a paused execution: what `POST /api/executions/{eid}/updates` on the
  * Dashboard service does. A change is made to run as the execution's plan was, by the workflow
  * compiling service and for the user who created the execution, and stored as one row of the
  * execution's plan table. The computing unit running the execution reads that row when it is
  * asked to apply it, and applies it when the run resumes.
  *
  * In this order:
  *  1. The request must name an operator by its id (400).
  *  1. The execution must exist (404); the caller must be the user who created it and still be
  *     allowed to read its workflow and to run workflows on its computing unit (403); and it must
  *     not have ended (409).
  *  1. Its plan is read from the lake: 404 without one, 409 while the per-user warehouse holding it
  *     is disabled.
  *  1. The compiling service is asked to make the change into the operator to run, with the
  *     caller's own token ([[WorkflowCompilingService.updateToRun]]). The operator must be in
  *     the workflow the plan was compiled from (404). The change must keep the operator's type,
  *     refer to no loop variable, be one the operator takes while it runs, keep the Python
  *     environment it runs in, and name only datasets and models the creator may read (400).
  *     A service that does not answer by the deadline is a 504, and one that cannot be reached
  *     or has too many compiles waiting a 503.
  *  1. The operator made to run, as its executor and what its code reads, is appended to the plan
  *     table under a new update id (as [[PhysicalPlanCodec.encodeUpdate]] saves one), with the
  *     change as the editor sent it. A change larger than the table keeps is refused (400).
  *
  * Refusals are thrown as the JAX-RS exceptions of their status, which the Dashboard answers as
  * `{"code", "message"}`.
  *
  * @param compiling         the workflow compiling service, which makes a change into the
  *                          operator to run
  * @param warehousesEnabled whether runs write into per-user warehouses
  * @param appendUpdate      appends the update row to the plan table at a URI
  * @param compileDeadline   how long the compiling service may take to answer a change
  */
class OperatorUpdates(
    compiling: WorkflowCompilingService = WorkflowCompilingService.forDeployment,
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
    appendUpdate: (URI, PlanRecord, String) => Unit = ExecutionPlanStore.appendUpdate,
    compileDeadline: FiniteDuration = ExecutionCreator.CompileDeadline
) extends LazyLogging {
  import OperatorUpdates.{ExecutionRow, OperatorIdField}

  /**
    * Stores the change `request` makes to an operator of execution `eid`, for `user`.
    *
    * @param authorization the request's `Authorization` header: the user's own token, which the
    *                      compiling service is asked for the change with
    * @return the update stored: the id the computing unit is to apply it by, and the operator
    * @throws BadRequestException          (400) for a request that names no operator, or a change
    *                                      the running operator cannot take or that is larger than
    *                                      a change may be
    * @throws ForbiddenException           (403) unless `user` created the execution and may still
    *                                      read its workflow and run workflows on its unit
    * @throws NotFoundException            (404) for an execution, a stored plan or an operator of
    *                                      its workflow there is not
    * @throws WebApplicationException      (409) if the execution has ended, or its plan is in a
    *                                      per-user warehouse while those are disabled; (504) if
    *                                      the compiling service does not answer by the deadline,
    *                                      (503) if it cannot be reached or has too many compiles
    *                                      waiting
    * @throws InternalServerErrorException (500) if the stored plan cannot be read or was made for
    *                                      another user or computing unit than the execution's
    *                                      row names, or the change cannot be made or stored
    */
  def store(
      eid: Long,
      request: OperatorUpdateRequestBody,
      user: User,
      authorization: String
  ): OperatorUpdateResponse = {
    val uid = Option(user).flatMap(u => Option(u.getUid)).getOrElse {
      throw new ForbiddenException("An operator is changed by a signed-in user.")
    }
    val changed = changedOperatorOf(request)
    val operatorId = OperatorIdentity(changed.get(OperatorIdField).asText())

    val execution =
      executionOf(eid).getOrElse(throw new NotFoundException(s"There is no execution $eid."))
    val cuid = requireAllowed(eid, execution, uid)
    if (execution.ended) {
      throw new WebApplicationException(s"Execution $eid has ended.", Response.Status.CONFLICT)
    }
    // Opened while the switch is off, a per-user warehouse would be the shared one, where the plan
    // is not: refused instead of answered as a plan there is not (#6930).
    execution.warehouse.filterNot(_ => warehousesEnabled).foreach { warehouse =>
      throw new WebApplicationException(
        s"Execution $eid keeps its plan in warehouse '$warehouse', and per-user warehouses are " +
          "disabled in this deployment.",
        Response.Status.CONFLICT
      )
    }
    val workflowId = WorkflowIdentity(execution.wid)
    val executionId = ExecutionIdentity(eid)
    val planUri = ExecutionPlanStore.planUri(workflowId, executionId, execution.warehouse)
    val (workflow, running) = storedPlanOf(eid, planUri, execution.uid, cuid)
    val updateId = ExecutionPlanStore.UpdateEntryIdPrefix + UUID.randomUUID()
    val made = madeToRun(
      UpdateRequest(
        execution.wid,
        eid,
        updateId,
        workflow,
        changed,
        // What the plan runs for the operator: the compiling service, which does not hold the
        // plan, checks the change against it.
        running.plan.operators.toSeq
          .filter(_.id.logicalOpId == operatorId)
          .map(op => RunningOperator(op.id.layerName, op.pythonEnvironment.environmentName))
          .sortBy(_.layerName)
      ),
      authorization
    )
    try {
      appendUpdate(
        planUri,
        PlanRecord(
          entryId = updateId,
          body = made.update,
          createdBy = uid.intValue(),
          computingUnitId = cuid
        ),
        // The change as the editor sent it: the update's provenance.
        made.operator
      )
    } catch {
      // The execution was deleted, and its plan table dropped, after its plan was read and before
      // the append loaded the table. A drop after that load fails the write instead: 500.
      case _: NoStoredPlanException =>
        throw new NotFoundException(s"Execution $eid has no stored plan.")
      case tooLarge: PlanTooLargeException => throw new BadRequestException(tooLarge.getMessage)
      case NonFatal(failure) =>
        throw new InternalServerErrorException(
          s"The change to operator ${operatorId.id} of execution $eid could not be stored.",
          failure
        )
    }
    logger.info(
      s"Stored $updateId, a change to operator ${operatorId.id} of execution $eid, for user $uid."
    )
    OperatorUpdateResponse(updateId, operatorId.id)
  }

  /** The operator `request` changes, or 400 when it names none by an id. */
  private def changedOperatorOf(request: OperatorUpdateRequestBody): JsonNode = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    if (request == null) refuse("The request has no body.")
    val operator = Option(request.operator)
      .filter(_.isObject)
      .getOrElse(refuse("The request names no operator."))
    if (Option(operator.get(OperatorIdField)).filter(_.isTextual).forall(_.asText().isBlank)) {
      refuse("The operator to change has no id.")
    }
    operator
  }

  /**
    * Execution `eid`'s row: its workflow (through its version), creator, computing unit, whether
    * it has ended and the name of the warehouse it writes into. None when there is no such
    * execution.
    */
  private def executionOf(eid: Long): Option[ExecutionRow] =
    Option.when(eid >= 1 && eid <= Int.MaxValue)(eid).flatMap { id =>
      Option(
        SqlServer
          .getInstance()
          .createDSLContext()
          .select(
            WORKFLOW_VERSION.WID,
            WORKFLOW_EXECUTIONS.UID,
            WORKFLOW_EXECUTIONS.CUID,
            WORKFLOW_EXECUTIONS.ENDED_AT,
            USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME
          )
          .from(WORKFLOW_EXECUTIONS)
          .join(WORKFLOW_VERSION)
          .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
          .leftJoin(USER_WAREHOUSE)
          .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
          .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(id.toInt)))
          .fetchOne()
      ).map { row =>
        ExecutionRow(
          wid = row.value1().longValue(),
          uid = row.value2().intValue(),
          cuid = Option(row.value3()).map(_.intValue()),
          ended = row.value4() != null,
          warehouse = Option(row.value5())
        )
      }
    }

  /**
    * The computing unit execution `eid` runs on, once user `uid` is found to be allowed to change
    * its operators: the user who created it, since its plan was resolved with their access, and
    * who may still read its workflow and run workflows on the unit. Otherwise 403.
    */
  private def requireAllowed(eid: Long, execution: ExecutionRow, uid: Integer): Int = {
    if (execution.uid != uid.intValue()) {
      throw new ForbiddenException(
        s"Only the user who created execution $eid may change its operators."
      )
    }
    if (!WorkflowAccess.hasReadAccess(Integer.valueOf(Math.toIntExact(execution.wid)), uid)) {
      throw new ForbiddenException(s"You do not have access to workflow ${execution.wid}.")
    }
    val cuid = execution.cuid.getOrElse {
      throw new ForbiddenException(s"Execution $eid was created for no computing unit.")
    }
    if (
      ComputingUnitAccess.getComputingUnitAccess(Integer.valueOf(cuid), uid) != PrivilegeEnum.WRITE
    ) {
      throw new ForbiddenException(s"You may not run workflows on computing unit $cuid.")
    }
    cuid
  }

  /**
    * The workflow execution `eid` was compiled from, as the JSON stored beside its plan, and the
    * plan it runs, both read from the plan row at `planUri`. 404 when there is no
    * plan row; 500 when it cannot be read, or was written for another user than `creator` or
    * another computing unit than `cuid`, which the execution's row names: the unit runs the plan
    * for the user and on the unit the plan row names, and would refuse a change stored for others.
    */
  private def storedPlanOf(
      eid: Long,
      planUri: URI,
      creator: Int,
      cuid: Int
  ): (JsonNode, ExecutionPlan) = {
    val (record, logical) =
      try ExecutionPlanStore.readPlanWithLogical(planUri)
      catch {
        case _: NoStoredPlanException =>
          throw new NotFoundException(s"Execution $eid has no stored plan.")
        case NonFatal(failure) =>
          throw new InternalServerErrorException(
            s"The plan of execution $eid could not be read from the lake.",
            failure
          )
      }
    if (record.createdBy != creator || record.computingUnitId != cuid) {
      // The cause, which the Dashboard logs with the 500, says what each row names.
      throw new InternalServerErrorException(
        s"The stored plan of execution $eid was made for another user or computing unit.",
        new IllegalStateException(
          s"The plan row of execution $eid names user ${record.createdBy} and computing unit " +
            s"${record.computingUnitId}, but the execution's row names user $creator and unit " +
            s"$cuid."
        )
      )
    }
    try {
      val workflow = Option(objectMapper.readTree(logical)).filter(_.isObject).getOrElse {
        throw new IllegalStateException("The workflow the plan was compiled from is no object.")
      }
      (workflow, PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(record.body)))
    } catch {
      case NonFatal(failure) =>
        throw new InternalServerErrorException(
          s"The stored plan of execution $eid cannot be read.",
          failure
        )
    }
  }

  /**
    * The change `request` asks for, made into the operator to run by the compiling service, as
    * `authorization` lets it resolve what the change names. What the service refuses is refused
    * with its words: 404 for an operator the execution's workflow does not have, 400 for a change
    * the running operator cannot take.
    */
  private def madeToRun(
      request: UpdateRequest,
      authorization: String
  ): WorkflowCompilingService.MadeUpdate = {
    val eid = request.executionId
    def notMade(why: String, status: Response.Status): WebApplicationException =
      new WebApplicationException(
        s"The change to execution $eid could not be made: $why",
        status
      )
    def tookTooLong: WebApplicationException =
      notMade(
        s"the workflow compiling service took longer than $compileDeadline.",
        Response.Status.GATEWAY_TIMEOUT
      )
    try {
      val made = compiling.updateToRun(request, authorization, compileDeadline)
      // The update the unit is to apply is this execution's, of the operator the change names,
      // under the id it is stored by.
      val update = PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(made.update))
      val operatorId = request.operator.get(OperatorIdField).asText()
      if (
        update.executionId.id != eid || update.updateId != request.updateId ||
        update.opId.logicalOpId.id != operatorId
      ) {
        throw new IllegalStateException(
          s"The compiling service answered update ${update.updateId} of operator " +
            s"${update.opId.logicalOpId.id} of execution ${update.executionId.id}, asked for " +
            s"${request.updateId} of operator $operatorId of execution $eid."
        )
      }
      made
    } catch {
      case refused: CompileRefused if refused.status == Response.Status.BAD_REQUEST.getStatusCode =>
        throw new BadRequestException(refused.getMessage)
      case refused: CompileRefused if refused.status == Response.Status.NOT_FOUND.getStatusCode =>
        throw new NotFoundException(refused.getMessage)
      case refused: CompileRefused
          if refused.status == Response.Status.SERVICE_UNAVAILABLE.getStatusCode =>
        throw notMade(
          "too many workflows are being compiled. Try again in a moment.",
          Response.Status.SERVICE_UNAVAILABLE
        )
      case refused: CompileRefused
          if refused.status == Response.Status.GATEWAY_TIMEOUT.getStatusCode =>
        throw tookTooLong
      case unanswered: CompileUnanswered if unanswered.timedOut => throw tookTooLong
      case unanswered: CompileUnanswered =>
        logger.warn(s"A change to execution $eid failed: ${unanswered.getMessage}", unanswered)
        throw notMade(
          "the workflow compiling service could not be reached. Try again in a moment.",
          Response.Status.SERVICE_UNAVAILABLE
        )
      case NonFatal(failure) =>
        throw new InternalServerErrorException(
          s"The change to execution $eid could not be made.",
          failure
        )
    }
  }
}
