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
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.PhysicalPlanCodec
import org.apache.texera.auth.util.{ComputingUnitAccess, WorkflowAccess}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{WORKFLOW_EXECUTIONS, WORKFLOW_VERSION}
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.http.request.execution.OperatorUpdateRequestBody
import org.apache.texera.web.model.http.response.execution.OperatorUpdateResponse
import org.apache.texera.web.service.execution.ComputingUnitClient.{
  Refused,
  Taken,
  Unanswered,
  Unreached
}
import org.apache.texera.web.service.execution.WorkflowCompilingService.{
  CompileRefused,
  CompileUnanswered,
  UpdateRequest
}

import java.util.Locale
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
  private case class ExecutionRow(wid: Long, uid: Int, cuid: Option[Int], ended: Boolean)
}

/**
  * Changes to an operator of a paused execution: what `POST /api/executions/{eid}/updates` on the
  * Dashboard service does. A change is made to run as the execution's plan was, by the workflow
  * compiling service and for the user who created the execution, and handed to the computing
  * unit running the execution, which checks that it fits the operator it runs and applies it
  * when the run resumes. No client carries it, and nothing of it is kept here.
  *
  * In this order:
  *  1. The request must name an operator by its id, and hold the workflow the execution runs
  *     (400).
  *  1. The execution must exist (404); the caller must be the user who created it and still be
  *     allowed to read its workflow and to run workflows on its computing unit (403); and it must
  *     not have ended (409).
  *  1. The compiling service is asked to make the change into the operator to run, with the
  *     caller's own token ([[WorkflowCompilingService.updateToRun]]). An operator that is not in
  *     the workflow sent is a 404, and a change the operator cannot take while it runs, or a
  *     workflow the compiler does not read ([[org.apache.texera.common.compiler.UpdateToRun]]),
  *     a 400. A service that does not answer by the deadline is a 504, and one that cannot be
  *     reached or has too many compiles waiting a 503.
  *  1. The operator made to run must be no larger than a computing unit takes
  *     ([[PhysicalPlanCodec.MaxPlanBytes]]; 400).
  *  1. The operator made to run, as its executor and what its code reads (as
  *     [[PhysicalPlanCodec.encodeUpdate]] writes one), is handed to the execution's computing
  *     unit, with the caller's own token ([[ComputingUnitClient.update]]), and the operator's
  *     id is answered (201). A unit that does not take the change is a 409, with the unit's
  *     reason; one that cannot be reached a 503, and one that does not answer a 504.
  *
  * Refusals are thrown as the JAX-RS exceptions of their status, which the Dashboard answers as
  * `{"code", "message"}`.
  */
class OperatorUpdates(
    compiling: WorkflowCompilingService = WorkflowCompilingService.forDeployment,
    units: ComputingUnitClient = ComputingUnitClient.forDeployment,
    compileDeadline: FiniteDuration = ExecutionCreator.CompileDeadline
) extends LazyLogging {
  import OperatorUpdates.{ExecutionRow, OperatorIdField}

  /**
    * Makes the change `request` asks for to an operator of execution `eid`, for `user`, in the
    * steps this class describes.
    *
    * @param authorization the request's `Authorization` header: the user's own token, which the
    *                      compiling service is asked for the change with, and the computing unit
    *                      handed it with
    * @throws WebApplicationException with the status of the step that refused the request; 500
    *                                 when the change cannot be made
    */
  def make(
      eid: Long,
      request: OperatorUpdateRequestBody,
      user: User,
      authorization: String
  ): OperatorUpdateResponse = {
    val uid = Option(user).flatMap(u => Option(u.getUid)).getOrElse {
      throw new ForbiddenException("An operator is changed by a signed-in user.")
    }
    val (changed, workflow) = changeOf(request)
    val operatorId = OperatorIdentity(changed.get(OperatorIdField).asText())

    val execution =
      executionOf(eid).getOrElse(throw new NotFoundException(s"There is no execution $eid."))
    val cuid = requireAllowed(eid, execution, uid)
    if (execution.ended) {
      throw new WebApplicationException(s"Execution $eid has ended.", Response.Status.CONFLICT)
    }
    val update = madeToRun(UpdateRequest(execution.wid, eid, workflow, changed), authorization)
    PhysicalPlanCodec.oversizeMiB(update).foreach { mib =>
      throw new BadRequestException(
        String.format(
          Locale.ROOT,
          "The change is %.1f MiB, and a change may be at most %d MiB.",
          Double.box(mib),
          Int.box(PhysicalPlanCodec.MaxPlanBytes / (1024 * 1024))
        )
      )
    }
    units.update(cuid, update, authorization) match {
      case Taken =>
        logger.info(
          s"Computing unit $cuid took a change to operator ${operatorId.id} of execution $eid, " +
            s"for user $uid."
        )
        OperatorUpdateResponse(operatorId.id)
      case Refused(why) =>
        throw new WebApplicationException(why, Response.Status.CONFLICT)
      case Unreached(cause) =>
        logger.warn(s"Computing unit $cuid could not be reached to change execution $eid.", cause)
        throw new WebApplicationException(
          s"The change to execution $eid could not be applied: computing unit $cuid could not " +
            "be reached.",
          Response.Status.SERVICE_UNAVAILABLE
        )
      case Unanswered(cause) =>
        logger.warn(s"Computing unit $cuid did not answer a change to execution $eid.", cause)
        throw new WebApplicationException(
          s"Computing unit $cuid did not answer whether it took the change to execution $eid.",
          Response.Status.GATEWAY_TIMEOUT
        )
    }
  }

  /**
    * The operator `request` changes and the workflow it is in, or 400 when it names no operator
    * by an id, or holds no workflow.
    */
  private def changeOf(request: OperatorUpdateRequestBody): (JsonNode, JsonNode) = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    if (request == null) refuse("The request has no body.")
    val operator = Option(request.operator)
      .filter(_.isObject)
      .getOrElse(refuse("The request names no operator."))
    if (Option(operator.get(OperatorIdField)).filter(_.isTextual).forall(_.asText().isBlank)) {
      refuse("The operator to change has no id.")
    }
    val workflow = Option(request.workflow)
      .filter(_.isObject)
      .getOrElse(refuse("The request holds no workflow to make the change in."))
    (operator, workflow)
  }

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
            WORKFLOW_EXECUTIONS.ENDED_AT
          )
          .from(WORKFLOW_EXECUTIONS)
          .join(WORKFLOW_VERSION)
          .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
          .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(id.toInt)))
          .fetchOne()
      ).map { row =>
        ExecutionRow(
          wid = row.value1().longValue(),
          uid = row.value2().intValue(),
          cuid = Option(row.value3()).map(_.intValue()),
          ended = row.value4() != null
        )
      }
    }

  /**
    * Refuses (403) a change by user `uid` to execution `eid` unless they created it, since its
    * plan was resolved with their access, and may still read its workflow and run workflows on
    * its computing unit.
    *
    * @return the execution's computing unit
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
    * The change `request` asks for, made into the operator to run by the compiling service. What
    * the service refuses with a 400 or a 404 is refused here with its words.
    */
  private def madeToRun(request: UpdateRequest, authorization: String): String = {
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
      // The update the unit is to apply is this execution's, of the operator the change names.
      val update = PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(made))
      val operatorId = request.operator.get(OperatorIdField).asText()
      if (update.executionId.id != eid || update.opId.logicalOpId.id != operatorId) {
        throw new IllegalStateException(
          s"The compiling service answered a change to operator ${update.opId.logicalOpId.id} " +
            s"of execution ${update.executionId.id}, asked for operator $operatorId of " +
            s"execution $eid."
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
