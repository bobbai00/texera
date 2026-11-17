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

import com.fasterxml.jackson.databind.node.ObjectNode
import com.typesafe.scalalogging.LazyLogging
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.storage.{
  ExecutionPlanStore,
  NoStoredPlanException,
  PlanRecord,
  PlanTooLargeException
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalOp, PhysicalPlanCodec}
import org.apache.texera.amber.operator.{LogicalOp, StateTransferFunc}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.{ComputingUnitAccess, WorkflowAccess}
import org.apache.texera.common.compiler.{RunBindings, WorkflowCompiler}
import org.apache.texera.common.compiler.model.{LogicalPlan, LogicalPlanPojo}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.{SqlServer, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.http.request.execution.OperatorUpdateRequestBody
import org.apache.texera.web.model.http.response.execution.OperatorUpdateResponse
import org.apache.texera.web.service.PlanToRun

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
import scala.util.control.NonFatal
import scala.util.{Failure, Success, Try}

object OperatorUpdates {

  /**
    * Builds the operator that an operator of the workflow an execution runs becomes once changed:
    * given the operator, the operator as changed, the workflow and the execution.
    */
  type Reconfigure =
    (LogicalOp, LogicalOp, WorkflowIdentity, ExecutionIdentity) => Try[
      (PhysicalOp, Option[StateTransferFunc])
    ]

  /** What a change to an execution's operator reads of the execution's row. */
  private case class ExecutionRow(
      wid: Long,
      uid: Int,
      cuid: Option[Int],
      status: Short,
      warehouse: Option[String]
  )
}

/**
  * Changes to an operator of a paused execution: what `POST /api/executions/{eid}/updates` on the
  * Dashboard service does. A change is made to run as the execution's plan was, for the user who
  * created the execution, and stored as one row of the execution's plan table. The computing unit
  * running the execution reads that row when it is asked to apply it, and applies it when the run
  * resumes.
  *
  * In this order:
  *  1. The request must name an operator by its id (400).
  *  1. The execution must exist (404); the caller must be the user who created it and still be
  *     allowed to read its workflow and to run workflows on its computing unit (403); and it must
  *     not have ended (409).
  *  1. Its plan is read from the lake: 404 without one, 409 while the per-user warehouse holding it
  *     is disabled. The operator must be in the workflow the plan was compiled from (404).
  *  1. The change must keep the operator's type, refer to no loop variable, be one the operator
  *     takes while it runs, keep the Python environment it runs in, and name only datasets and
  *     models the creator may read (400).
  *  1. The operator made to run, as its executor and what its code reads, is appended to the plan
  *     table under a new update id ([[PhysicalPlanCodec.encodeUpdate]]), with the change as the
  *     editor sent it. A change larger than the table keeps is refused (400).
  *
  * Refusals are thrown as the JAX-RS exceptions of their status, which the Dashboard answers as
  * `{"code", "message"}`.
  *
  * @param bindingsFor       what a change is bound to, for a user, as the execution's plan was
  * @param warehousesEnabled whether runs write into per-user warehouses
  * @param appendUpdate      appends the update row to the plan table at a URI
  * @param reconfigure       builds the operator a change makes of an operator; by default the
  *                          operator builds it itself ([[LogicalOp.runtimeReconfiguration]])
  */
class OperatorUpdates(
    bindingsFor: Integer => RunBindings = PlanToRun.bindingsFor,
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
    appendUpdate: (URI, PlanRecord, String) => Unit = ExecutionPlanStore.appendUpdate,
    reconfigure: OperatorUpdates.Reconfigure = (current, changed, workflowId, executionId) =>
      current.runtimeReconfiguration(workflowId, executionId, current, changed)
) extends LazyLogging {
  import OperatorUpdates.ExecutionRow

  /**
    * Stores the change `request` makes to an operator of execution `eid`, for `user`.
    *
    * @return the update stored: the id the computing unit is to apply it by, and the operator
    * @throws BadRequestException          (400) for a request that names no operator, or a change
    *                                      the running operator cannot take or that is larger than
    *                                      a change may be
    * @throws ForbiddenException           (403) unless `user` created the execution and may still
    *                                      read its workflow and run workflows on its unit
    * @throws NotFoundException            (404) for an execution, a stored plan or an operator of
    *                                      its workflow there is not
    * @throws WebApplicationException      (409) if the execution has ended, or its plan is in a
    *                                      per-user warehouse while those are disabled
    * @throws InternalServerErrorException (500) if the stored plan cannot be read or was made for
    *                                      another user or computing unit than the execution's
    *                                      row names, or the change cannot be stored. Any other
    *                                      failure, such as the database not answering while a
    *                                      dataset version is pinned, is thrown as it is.
    */
  def store(eid: Long, request: OperatorUpdateRequestBody, user: User): OperatorUpdateResponse = {
    val uid = Option(user).flatMap(u => Option(u.getUid)).getOrElse {
      throw new ForbiddenException("An operator is changed by a signed-in user.")
    }
    val changed = changedOperatorOf(request)
    val operatorId = changed.operatorIdentifier
    // The change as the editor sent it, written as each operator of the plan row's logical plan
    // is (LogicalPlanPojo.asSent), without the stateReferences sidecar or anything a compile
    // sets, and before it is made to run: the update's provenance. A change that refers to a loop
    // variable is refused below, so the change stored has no typed reference to put back.
    val logical = objectMapper.writeValueAsString(
      LogicalPlanPojo.asSent(objectMapper.valueToTree[ObjectNode](changed), changed)
    )

    val execution =
      executionOf(eid).getOrElse(throw new NotFoundException(s"There is no execution $eid."))
    val cuid = requireAllowed(eid, execution, uid)
    if (WorkflowExecutionStatus.Ended.contains(execution.status)) {
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
    val current = workflow.operators
      .find(_.operatorIdentifier == operatorId)
      .getOrElse {
        throw new NotFoundException(
          s"Operator ${operatorId.id} is not in the workflow execution $eid runs."
        )
      }
    val madeToRun = changeMadeToRun(workflow, running, current, changed, workflowId, executionId)
    val bound = boundFor(uid, running, madeToRun)

    val updateId = ExecutionPlanStore.UpdateEntryIdPrefix + UUID.randomUUID()
    try {
      appendUpdate(
        planUri,
        PlanRecord(
          entryId = updateId,
          body = PhysicalPlanCodec.updateToJson(
            PhysicalPlanCodec.encodeUpdate(executionId, updateId, bound)
          ),
          createdBy = uid.intValue(),
          computingUnitId = cuid,
          notification = None
        ),
        logical
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
  private def changedOperatorOf(request: OperatorUpdateRequestBody): LogicalOp = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    if (request == null) refuse("The request has no body.")
    val operator = Option(request.operator).getOrElse(refuse("The request names no operator."))
    if (Option(operator.operatorIdentifier.id).forall(_.isBlank)) {
      refuse("The operator to change has no id.")
    }
    operator
  }

  /**
    * Execution `eid`'s row: its workflow (through its version), creator, computing unit, status
    * and the name of the warehouse it writes into. None when there is no such execution.
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
            WORKFLOW_EXECUTIONS.STATUS,
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
          status = row.value4().shortValue(),
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
    * The workflow execution `eid` was compiled from, with the loop-variable references the editor
    * sent, and the plan it runs, both read from the plan row at `planUri`. 404 when there is no
    * plan row; 500 when it cannot be read, or was written for another user than `creator` or
    * another computing unit than `cuid`, which the execution's row names: the unit runs the plan
    * for the user and on the unit the plan row names, and would refuse a change stored for others.
    */
  private def storedPlanOf(
      eid: Long,
      planUri: URI,
      creator: Int,
      cuid: Int
  ): (LogicalPlan, ExecutionPlan) = {
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
      // The workflow modules of this mapper give each typed loop-variable reference back.
      val workflow = objectMapper.readValue(logical, classOf[LogicalPlanPojo])
      workflow.graphProblem().foreach(problem => throw new IllegalStateException(problem))
      (LogicalPlan(workflow), PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(record.body)))
    } catch {
      case NonFatal(failure) =>
        throw new InternalServerErrorException(
          s"The stored plan of execution $eid cannot be read.",
          failure
        )
    }
  }

  /**
    * `changed` made into the operator that takes `current`'s place in `running`, once it is found
    * to be a change the running operator can take. Otherwise 400, with why.
    */
  private def changeMadeToRun(
      workflow: LogicalPlan,
      running: ExecutionPlan,
      current: LogicalOp,
      changed: LogicalOp,
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    val name = current.operatorInfo.userFriendlyName
    // A descriptor builds the new operator from whatever it is handed, of any type: the running
    // worker would be given another operator's executor.
    if (changed.getClass != current.getClass) {
      refuse(
        s"Operator ${current.operatorIdentifier.id} is a $name; a change cannot make it a " +
          s"${changed.operatorInfo.userFriendlyName}."
      )
    }
    if (workflow.refersToLoopVariables(current) || workflow.refersToLoopVariables(changed)) {
      refuse(s"$name refers to loop variables, so it can't be changed while the workflow runs.")
    }
    // An operator that offers to be changed while it runs, and overrides nothing to take a
    // change, is left with LogicalOp's own runtimeReconfiguration, which throws rather than
    // answering a Failure; so does a descriptor that cannot build its operator from the change.
    // Either refuses the change, in the failure's words, or by its type when it has none. A fatal
    // error is thrown as it is.
    val reconfigured =
      Try(reconfigure(current, changed, workflowId, executionId)).flatten match {
        case Success((op, _)) => op
        case Failure(failure) => refuse(Option(failure.getMessage).getOrElse(failure.toString))
      }
    val runningOp = running.plan.operators.find(_.id == reconfigured.id).getOrElse {
      refuse(
        s"The change makes $name the operator ${reconfigured.id.logicalOpId.id}-" +
          s"${reconfigured.id.layerName}, which the running workflow does not have."
      )
    }
    // An update gives the running operator a new executor and what its code reads; its workers keep
    // the interpreter they run in, so a change of environment would never take effect. The running
    // operator's environment is as the plan resolved it, whatever its user keeps under its name
    // now: only asking for another is a change of it.
    if (
      reconfigured.pythonEnvironment.environmentName != runningOp.pythonEnvironment.environmentName
    ) {
      refuse("The operator's Python environment cannot change while the run is paused.")
    }
    reconfigured
  }

  /**
    * `op` with the datasets and models it names pinned for user `uid`, as the compile that made
    * `running` pinned the plan's ([[WorkflowCompiler.bindResources]]). A version that does not
    * exist or that the user may not read is the change's error (400); any other failure, such as
    * the database not answering, is thrown as it is.
    */
  private def boundFor(uid: Integer, running: ExecutionPlan, op: PhysicalOp): PhysicalOp = {
    val compiler = new WorkflowCompiler(running.context, bindingsFor(uid))
    try compiler.bindResources(op)
    catch {
      case error: FileNotFoundException => throw new BadRequestException(error.getMessage)
    }
  }
}
