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
import org.apache.texera.amber.core.storage.{ExecutionPlanStore, PlanRecord, PlanTooLargeException}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{ReplaySource, WorkflowContext, WorkflowSettings}
import org.apache.texera.auth.util.{ComputingUnitAccess, WorkflowAccess}
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{RunBindings, WorkflowCompilationFailed, WorkflowCompiler}
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{
  WORKFLOW_COMPUTING_UNIT,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.http.request.execution.{
  CreateExecutionRequest,
  ReplayExecutionInfo
}
import org.apache.texera.web.model.http.response.execution.{
  CreateExecutionFailure,
  CreateExecutionResponse
}
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowResource
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.service.{
  ExecutionsMetadataPersistService,
  PlanToRun,
  WorkflowEmailNotifier
}

import java.net.URI
import javax.ws.rs.core.Response
import javax.ws.rs.{
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  WebApplicationException
}
import scala.util.Try
import scala.util.control.NonFatal

object ExecutionCreator extends ExecutionCreator {

  /** The longest text the execution's row keeps as its name, and as its engine version. */
  val MaxColumnLength = 128

  /** What a create is made of, once its request is checked. */
  private case class CheckedRequest(
      wid: Long,
      computingUnitId: Int,
      executionName: String,
      environmentVersion: String,
      plan: LogicalPlanPojo,
      settings: WorkflowSettings,
      emailNotificationEnabled: Boolean,
      warehouseId: Option[Int],
      replay: Option[ReplayExecutionInfo]
  )

  /** A failure after the execution's row exists, with what to tell the user about it. */
  private final class ExecutionNotCreated(message: String, cause: Throwable)
      extends RuntimeException(message, cause)
}

/**
  * Creates executions: what `POST /api/executions` on the Dashboard service does. No computing
  * unit is involved: the unit the execution is created for later starts it from the plan written
  * here.
  *
  * In this order, which decides what a refused request leaves behind:
  *  1. The request is checked: a workflow, a computing unit, an engine version, settings a plan
  *     can be made to run under, and a workflow whose graph the compiler can read (with one
  *     target, the part of it up to the target, which is all that is compiled). Otherwise 400.
  *  1. The user must be able to read the workflow and run workflows on the unit (403, also for a
  *     unit that does not exist), and the unit must not be terminated (409).
  *  1. The warehouse the run writes into and the replay log it replays are checked (400).
  *  1. The execution's row is inserted, at status 0, with where it writes its replay log when
  *     replay logs are kept. No row is left by a request refused before this.
  *  1. The workflow is compiled for the user, Strict, under the site's settings as they stand and
  *     with the cost hints of their newest completed run of it, and the plan made
  *     ([[PlanToRun.make]]): each file a scan source reads is one the user may read, and the plan
  *     carries a link to it for the computing unit to read it through; each Python environment
  *     an operator names is one the user keeps, and the plan carries its packages for the unit
  *     to install. A workflow that does not compile, a scan of a file the user may not read or
  *     an operator in an environment the user does not have among them, marks the row FAILED and
  *     is answered with each operator's error (400). A plan that cannot be made for another
  *     reason, such as the database or the storage not answering while a file is resolved or
  *     linked, marks the row FAILED too (500).
  *  1. The plan is written to the execution's plan table, with the logical plan it was compiled
  *     from (as JSON that parses back to it, without what a compile sets,
  *     [[LogicalPlanPojo.toJson]]), the user, the unit and the email notification. A plan larger
  *     than the table keeps marks the row FAILED (400); so does a write that fails (500).
  *  1. The results of the workflow's earlier executions on the unit that have ended are cleared:
  *     the new execution replaces them. A run that may still be running is left alone.
  *
  * Refusals are thrown as the JAX-RS exceptions of their status, which the Dashboard answers as
  * `{"code", "message"}`.
  */
class ExecutionCreator extends LazyLogging {
  import ExecutionCreator.{CheckedRequest, ExecutionNotCreated, MaxColumnLength}

  /** What the plan is bound to, for user `uid`. A seam for a spec's fixtures. */
  protected def bindingsFor(uid: Integer): RunBindings = PlanToRun.bindingsFor(uid)

  /** Where runs keep their replay logs; None when they keep none. A seam for a spec. */
  protected def replayLogRoot: Option[URI] = ApplicationConfig.faultToleranceLogRootFolder

  /** Whether runs write into per-user warehouses. A seam for a spec. */
  protected def warehousesEnabled: Boolean = StorageConfig.warehouseEnabled

  /** Finds the cost hints a plan is saved with. */
  protected def costHintsLoader: CostHintsLoader = CostHintsLoader

  /** Writes the plan row. A seam, so a spec can make the write fail. */
  protected def writePlan(planUri: URI, record: PlanRecord, logical: String): Unit =
    ExecutionPlanStore.writePlan(planUri, record, logical)

  /**
    * Creates the execution `request` asks for, for `user`.
    *
    * @param requestUri the URI the request came to: the email notification links to the workflow
    *                   on its host
    * @return the execution created (Right), or, for a workflow that does not compile, the
    *         execution recorded as failed with each operator's error (Left)
    * @throws BadRequestException          (400) for a request that is malformed, names a warehouse
    *                                      the user may not write into, or a replay log there is
    *                                      not; and for a workflow whose plan is larger than a plan
    *                                      may be, whose execution is recorded as failed
    * @throws ForbiddenException           (403) unless the user may read the workflow and run
    *                                      workflows on the computing unit
    * @throws WebApplicationException      (409) if the computing unit is terminated
    * @throws InternalServerErrorException (500) if the plan could not be made or written for a
    *                                      reason other than the workflow's: the execution is
    *                                      recorded as failed
    */
  def create(
      request: CreateExecutionRequest,
      user: User,
      requestUri: URI
  ): Either[CreateExecutionFailure, CreateExecutionResponse] = {
    val uid = Option(user).flatMap(u => Option(u.getUid)).getOrElse {
      throw new ForbiddenException("An execution is created for a signed-in user.")
    }
    val checked = checkedRequest(request)
    val wid = WorkflowIdentity(checked.wid)
    requireAllowed(checked, uid)
    val warehouse =
      try {
        ExecutionResources.resolveLakekeeperWarehouseName(
          checked.warehouseId,
          uid,
          warehousesEnabled
        )
      } catch {
        case refused: IllegalArgumentException => throw new BadRequestException(refused.getMessage)
      }
    val replay = checked.replay.map(replaySourceOf(checked.wid, _))

    val eid = ExecutionsMetadataPersistService.insertCreatedExecution(
      wid,
      uid,
      checked.executionName,
      checked.environmentVersion,
      checked.computingUnitId,
      checked.warehouseId
    )
    logger.info(
      s"Execution ${eid.id} of workflow ${checked.wid} is created for user $uid on computing " +
        s"unit ${checked.computingUnitId}."
    )
    // From here the row exists: whatever fails marks it FAILED, so it does not stay at
    // Initializing although no unit will ever start it.
    failingTheExecution(eid) {
      val replayLog = replayLogRoot.map { root =>
        val location = root.resolve(s"${checked.wid}/${eid.id}/")
        ExecutionsMetadataPersistService.updateLogLocation(eid, location.toString)
        location
      }
      val context = new WorkflowContext(wid, eid, checked.settings, warehouse)
      // How long each operator took in the user's newest completed run of the workflow, for the
      // scheduler's cost model: saved with the plan, which the engine takes them from.
      context.costHints = costHintsLoader.load(checked.wid, uid)
      // The plan compiled, as an editor sends it, loop-variable references included: written
      // before the compile resolves its operators in place, and without what a compile sets,
      // whatever the request sent there.
      val logical = checked.plan.toJson
      val compiler = new WorkflowCompiler(context, bindingsFor(uid))
      val made =
        try Right(PlanToRun.make(compiler, checked.plan, replay, replayLog))
        catch { case failed: WorkflowCompilationFailed => Left(failed) }
      made match {
        case Left(failed) =>
          ExecutionsMetadataPersistService.markFailed(eid)
          logger.info(
            s"Execution ${eid.id} failed: the workflow does not compile. ${failed.getMessage}"
          )
          Left(
            CreateExecutionFailure(
              eid.id,
              failed.operatorErrors.map { case (operator, error) => operator.id -> error },
              List.empty
            )
          )
        case Right(savedPlan) =>
          val planUri = ExecutionPlanStore.planUri(wid, eid, warehouse)
          val notification = notificationFor(checked, user, requestUri)
          try {
            writePlan(
              planUri,
              PlanRecord(
                entryId = ExecutionPlanStore.PlanEntryId,
                body = savedPlan,
                createdBy = uid.intValue(),
                computingUnitId = checked.computingUnitId,
                notification = notification.map(Notification.toJson)
              ),
              logical
            )
          } catch {
            // The workflow's doing, not the lake's: answered as such below.
            case tooLarge: PlanTooLargeException => throw tooLarge
            case NonFatal(failure) =>
              throw new ExecutionNotCreated(
                s"Execution ${eid.id} could not be created: its plan could not be written to " +
                  "the lake.",
                failure
              )
          }
          ExecutionResources.clearFinishedExecutions(wid, checked.computingUnitId, eid)
          Right(
            CreateExecutionResponse(eid.id, checked.wid, checked.computingUnitId, planUri.toString)
          )
      }
    }
  }

  /**
    * `body`, which runs once execution `eid`'s row exists: any failure marks the row FAILED. A
    * plan too large to store is answered 400, with how large it is and may be. Any other failure
    * the JVM can go on after is answered 500, with the reason for the user when it is an
    * [[ExecutionNotCreated]]; a failure it cannot go on after is thrown as it is.
    */
  private def failingTheExecution[T](eid: ExecutionIdentity)(body: => T): T =
    try body
    catch {
      case failure: Throwable =>
        ExecutionsMetadataPersistService.markFailed(eid)
        failure match {
          case tooLarge: PlanTooLargeException =>
            throw new BadRequestException(
              s"Execution ${eid.id} could not be created. ${tooLarge.getMessage} A plan holds a " +
                "link to each file its operators read, so a workflow that lists fewer files " +
                "makes a smaller plan.",
              tooLarge
            )
          case notCreated: ExecutionNotCreated =>
            throw new InternalServerErrorException(notCreated.getMessage, notCreated.getCause)
          case NonFatal(other) =>
            throw new InternalServerErrorException(
              s"Execution ${eid.id} could not be created: its plan could not be made.",
              other
            )
          case fatal => throw fatal
        }
    }

  /**
    * The parts of `request` a create uses, with what it may leave out filled in, or 400 with what
    * is missing or wrong. The plan compiled is the one sent, or, with exactly one target, the
    * part of it upstream of the target.
    */
  private def checkedRequest(request: CreateExecutionRequest): CheckedRequest = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    if (request == null) refuse("The request has no body.")
    if (request.wid < 1 || request.wid > Int.MaxValue) {
      refuse(s"The request names no workflow: wid is ${request.wid}.")
    }
    if (request.computingUnitId < 1) {
      refuse(s"The request names no computing unit: computingUnitId is ${request.computingUnitId}.")
    }
    val executionName = Option(request.executionName).getOrElse("")
    if (executionName.length > MaxColumnLength) {
      refuse(s"The execution's name is longer than ${MaxColumnLength} characters.")
    }
    val engineVersion = Option(request.engineVersion).getOrElse {
      refuse("The request names no engine version.")
    }
    val environmentVersion = ExecutionsMetadataPersistService.environmentVersionOf(engineVersion)
    if (environmentVersion.length > MaxColumnLength) {
      refuse("The request's engine version is too long.")
    }
    val sent = Option(request.logicalPlan).getOrElse(refuse("The request has no logical plan."))
    sent.listProblem().foreach(problem => refuse(problem))
    // Lists a client may leave out, which the compiler reads.
    val whole = sent.copy(
      opsToViewResult = Option(sent.opsToViewResult).getOrElse(Nil),
      opsToReuseResult = Option(sent.opsToReuseResult).getOrElse(Nil)
    )
    // Only the plan compiled has to be a graph the compiler reads: with one target, a part of the
    // workflow the run does not reach is neither compiled nor checked.
    val plan = Option(request.targetOperatorIds).getOrElse(Nil) match {
      case List(target) => whole.upstreamOf(target)
      case _            => whole
    }
    plan.graphProblem().foreach(problem => refuse(problem))
    // Any output ports whose results are stored that the settings name are replaced by the ones
    // the compiler finds, which the plan is saved with.
    val settings = Option(request.workflowSettings).flatten.getOrElse(
      WorkflowSettings(dataTransferBatchSize = ApplicationConfig.defaultDataTransferBatchSize)
    )
    PlanToRun.settingsProblem(settings).foreach(problem => refuse(problem))
    val replay = Option(request.replayFromExecution).flatten
    replay.foreach { info =>
      if (info.interaction == null || info.interaction.isBlank) {
        refuse(s"The replay of execution ${info.eid} names no interaction to replay up to.")
      }
    }
    CheckedRequest(
      wid = request.wid,
      computingUnitId = request.computingUnitId,
      executionName = executionName,
      environmentVersion = environmentVersion,
      plan = plan,
      settings = settings,
      emailNotificationEnabled = request.emailNotificationEnabled,
      warehouseId = Option(request.warehouseId).flatten,
      replay = replay
    )
  }

  /**
    * Fails unless user `uid` may read the workflow and run workflows on the computing unit (403),
    * and the unit is not terminated (409). A unit that does not exist is one the user may not run
    * workflows on.
    */
  private def requireAllowed(request: CheckedRequest, uid: Integer): Unit = {
    val (wid, cuid) = (request.wid, request.computingUnitId)
    if (!WorkflowAccess.hasReadAccess(Integer.valueOf(wid.toInt), uid)) {
      throw new ForbiddenException(s"You do not have access to workflow $wid.")
    }
    if (
      ComputingUnitAccess.getComputingUnitAccess(Integer.valueOf(cuid), uid) != PrivilegeEnum.WRITE
    ) {
      throw new ForbiddenException(s"You may not run workflows on computing unit $cuid.")
    }
    val terminated = SqlServer
      .getInstance()
      .createDSLContext()
      .fetchExists(
        WORKFLOW_COMPUTING_UNIT,
        WORKFLOW_COMPUTING_UNIT.CUID
          .eq(Integer.valueOf(cuid))
          .and(WORKFLOW_COMPUTING_UNIT.TERMINATE_TIME.isNotNull)
      )
    if (terminated) {
      throw new WebApplicationException(
        s"computing unit $cuid is terminated",
        Response.Status.CONFLICT
      )
    }
  }

  /**
    * The replay log that `info` names, or 400: an execution of workflow `wid` that kept a replay
    * log, at an absolute URI.
    */
  private def replaySourceOf(wid: Long, info: ReplayExecutionInfo): ReplaySource = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    val source =
      Option
        .when(info.eid >= 1 && info.eid <= Int.MaxValue)(info.eid)
        .flatMap { eid =>
          Option(
            SqlServer
              .getInstance()
              .createDSLContext()
              .select(WORKFLOW_VERSION.WID, WORKFLOW_EXECUTIONS.LOG_LOCATION)
              .from(WORKFLOW_EXECUTIONS)
              .join(WORKFLOW_VERSION)
              .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
              .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(eid.toInt)))
              .fetchOne()
          )
        }
        .filter(_.value1().longValue() == wid)
        .getOrElse(refuse(s"Workflow $wid has no execution ${info.eid} to replay."))
    val location = Option(source.value2()).filter(_.nonEmpty).getOrElse {
      refuse(s"Execution ${info.eid} kept no replay log to replay.")
    }
    val logUri = Try(new URI(location)).toOption.filter(_.isAbsolute).getOrElse {
      refuse(s"The replay log of execution ${info.eid} is not at an absolute URI.")
    }
    ReplaySource(ExecutionIdentity(info.eid), logUri, info.interaction)
  }

  /**
    * Where the run's status emails go and what they name, when the request asks for them and the
    * user has an address: the workflow's name, and its page on the host the request came to.
    */
  private def notificationFor(
      request: CheckedRequest,
      user: User,
      requestUri: URI
  ): Option[Notification] =
    Option(user.getEmail)
      .filter(email => request.emailNotificationEnabled && !email.isBlank)
      .map { email =>
        Notification(
          email,
          WorkflowResource.getWorkflowName(Integer.valueOf(request.wid.toInt)),
          WorkflowEmailNotifier.workflowUrl(requestUri, request.wid)
        )
      }
}
