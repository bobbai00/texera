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
import org.apache.texera.amber.core.storage.{InputLinker, LakeFSInputLinker}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  ExecutionPlan,
  PhysicalPlanCodec,
  ReplaySource,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.auth.util.{ComputingUnitAccess, WorkflowAccess}
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}
import org.apache.texera.dao.{SqlServer, WorkflowExecutionStatus}
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
import org.apache.texera.web.model.http.response.execution.CreateExecutionResponse
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowResource
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.service.execution.ComputingUnitClient.{
  Refused,
  Taken,
  Unanswered,
  Unreached
}
import org.apache.texera.web.service.execution.WorkflowCompilingService.{
  CompileRefused,
  CompileUnanswered,
  PlanRequest
}
import org.apache.texera.web.service.{ExecutionsMetadataPersistService, WorkflowEmailNotifier}

import java.net.URI
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{
  BlockingQueue,
  Executor,
  LinkedBlockingQueue,
  ThreadPoolExecutor,
  TimeUnit
}
import javax.ws.rs.core.Response
import javax.ws.rs.{
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  WebApplicationException
}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.util.Try
import scala.util.control.NonFatal

object ExecutionCreator {

  /** The longest text the execution's row keeps as its name, and as its engine version. */
  val MaxColumnLength = 128

  /**
    * How long the compiling service may take to answer a workflow's plan: half of the 120
    * seconds each deployment's route gives a create, which leaves the rest for the cost hints
    * before it and the plan's links and write after it.
    */
  val CompileDeadline: FiniteDuration = 60.seconds

  /**
    * A pool of at most `threads` daemon threads named after `name`, which holds the work they
    * are all busy with in `waiting`, refuses work once that is full, and lets go of a thread
    * that has had none for a minute.
    */
  private def daemonThreads(
      name: String,
      threads: Int,
      waiting: BlockingQueue[Runnable]
  ): ThreadPoolExecutor = {
    val count = new AtomicInteger()
    val pool = new ThreadPoolExecutor(
      threads,
      threads,
      1,
      TimeUnit.MINUTES,
      waiting,
      (task: Runnable) => {
        val thread = new Thread(task, s"$name-${count.incrementAndGet()}")
        thread.setDaemon(true)
        thread
      }
    )
    pool.allowCoreThreadTimeOut(true)
    pool
  }

  /** What a create is made of, once its request is checked. */
  private case class CheckedRequest(
      wid: Long,
      computingUnitId: Int,
      executionName: String,
      environmentVersion: String,
      plan: JsonNode,
      target: Option[String],
      settings: WorkflowSettings,
      emailNotificationEnabled: Boolean,
      warehouseId: Option[Int],
      replay: Option[ReplayExecutionInfo]
  )
}

/**
  * The workflow of a create does not compile (400): execution `eid` is recorded as failed.
  *
  * @param operatorErrors by the operator's id; see
  *                       [[org.apache.texera.common.compiler.WorkflowCompilationFailed]]
  */
final class WorkflowNotCompiled(
    val eid: Long,
    val operatorErrors: Map[String, WorkflowFatalError],
    message: String
) extends BadRequestException(message)

/**
  * Creates executions and starts them: what `POST /api/executions` on the Dashboard service
  * does. The execution's plan goes from here to the computing unit the execution is created
  * for, which starts it; no client carries it, and nothing of it is kept here.
  *
  * In this order, which decides what a refused request leaves behind:
  *  1. The request is checked: a workflow, a computing unit, an engine version, settings a plan
  *     can be made to run under, and a logical plan. Otherwise 400. The logical plan is not
  *     read here: what is wrong with it is the compiling service's to say.
  *  1. The user must be able to read the workflow and run workflows on the unit (403, also for a
  *     unit that does not exist), and the unit must not be terminated (409).
  *  1. The warehouse the run writes into and the replay log it replays, which is one of the
  *     user's own executions of the workflow, are checked (400).
  *  1. The execution's row is inserted, as Created, with where it writes its replay log when
  *     replay logs are kept, and where the email about how its run ended goes when the request
  *     asks for one. No row is left by a request refused before this.
  *  1. The workflow compiling service is asked for the plan of the user's run, with the user's
  *     own token ([[WorkflowCompilingService.planToRun]]): it compiles the workflow (with a
  *     target, the target and what is upstream of it) under the site's settings as they stand,
  *     and resolves what the workflow names as the user may read it
  *     ([[org.apache.texera.common.compiler.PlanToRun]]). A workflow that does not compile
  *     closes the row as failed, "compile error: …" with one operator's error, and is answered
  *     with each operator's error ([[WorkflowNotCompiled]], 400); so does a workflow the
  *     compiler cannot read, such as one whose links form a cycle or whose target it does not
  *     have, with why (400). A service that does not answer by the deadline closes the row as
  *     failed, "its plan could not be made" (504), and so does one that cannot be reached or
  *     has too many compiles waiting (503).
  *  1. What the plan needs that only this service has is added to it: a link to each file its
  *     operators read, signed with this service's keys to the object store; the cost hints of
  *     the user's newest completed run of the workflow; and the replay log it replays and the
  *     one it writes. A plan that cannot be made for another reason, such as the storage not
  *     answering while the cost hints are read, closes the row as failed too (500).
  *  1. A plan larger than a computing unit takes ([[PhysicalPlanCodec.MaxPlanBytes]]) closes the
  *     row as failed, "its plan is too large" (400).
  *  1. The result tables the plan names are recorded, a row each
  *     ([[ExecutionsMetadataPersistService.insertResultTables]]): the result service lists and
  *     reads the execution's results by them. A record that fails closes the row as failed,
  *     "its plan could not be made" (500).
  *  1. The execution's namespace is made in the warehouse it writes into, and on a REST catalog
  *     the token its unit writes there with ([[ExecutionCatalogAccess.open]]). A catalog that
  *     cannot do that closes the row as failed, "its plan could not be made" (500).
  *  1. The plan is handed to the computing unit, for the user, with the token
  *     ([[ComputingUnitClient.start]]), and the unit starts the execution: the execution's id is
  *     answered (201). A unit that refuses the start closes the row as failed, with the unit's
  *     reason (409), and so does a unit that cannot be reached (503). A unit that was sent the
  *     plan and does not answer may have started the execution: the row stays open (504), with
  *     its namespace and its token, and the closing job closes it by what its log shows.
  *  1. Off the request's thread, the workflow's earlier executions on the unit whose logs show
  *     an ending are closed, without waiting for the closing job: a run that ended seconds ago
  *     is replaced like any other. Then the results of its closed executions on the unit that a
  *     later one has replaced are expired ([[ExecutionExpiry.expireReplaced]]). The new
  *     execution replaces none until a unit runs it, which the closing job finds.
  *
  * A create fails in one way: with the JAX-RS exception of its status, which the Dashboard answers
  * as `{"code", "message"}`. One that fails once its row exists and before a unit may have the
  * plan closes the row itself ([[ExecutionRecords.close]]): no engine and no log will ever say
  * how such an execution ended. It also drops the execution's namespace, with any table a start
  * the unit refused made in it, and ends what its token can do ([[ExecutionCatalogAccess.drop]]).
  * No email is sent about it: the user is looking at the failure.
  *
  * @param units         hands the plan to the execution's computing unit
  * @param replayLogRoot where runs keep their replay logs; None when they keep none
  * @param background    runs what a create leaves to be done after it has answered
  * @param access        makes the execution's namespace and token, and drops them
  */
class ExecutionCreator(
    compiling: WorkflowCompilingService = WorkflowCompilingService.forDeployment,
    units: ComputingUnitClient = ComputingUnitClient.forDeployment,
    linker: InputLinker = LakeFSInputLinker.forDeployment,
    replayLogRoot: Option[URI] = ApplicationConfig.faultToleranceLogRootFolder,
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
    costHints: CostHintsLoader = new CostHintsLoader(),
    background: Executor = ExecutionCreator.daemonThreads(
      "execution-replacing",
      threads = 1,
      waiting = new LinkedBlockingQueue[Runnable]()
    ),
    closer: ExecutionCloser = new ExecutionCloser(),
    compileDeadline: FiniteDuration = ExecutionCreator.CompileDeadline,
    expiry: ExecutionExpiry = ExecutionExpiry.forDeployment,
    access: ExecutionCatalogAccess = ExecutionCatalogAccess.forDeployment
) extends LazyLogging {
  import ExecutionCreator.{CheckedRequest, MaxColumnLength}
  import PhysicalPlanCodec.MaxPlanBytes

  /**
    * Creates the execution `request` asks for, for `user`, in the steps this class describes.
    *
    * @param requestUri    the URI the request came to: the email about the run links to the
    *                      workflow on its host
    * @param authorization the request's `Authorization` header: the user's own token, which the
    *                      compiling service is asked for the plan with
    * @throws WebApplicationException with the status of the step that refused the request or
    *                                 failed; a [[WorkflowNotCompiled]] when the workflow does not
    *                                 compile
    */
  def create(
      request: CreateExecutionRequest,
      user: User,
      requestUri: URI,
      authorization: String
  ): CreateExecutionResponse = {
    val uid = Option(user).flatMap(u => Option(u.getUid)).getOrElse {
      throw new ForbiddenException("An execution is created for a signed-in user.")
    }
    val checked = checkedRequest(request)
    val wid = WorkflowIdentity(checked.wid)
    requireAllowed(checked, uid)
    val warehouse =
      try {
        ExecutionWarehouse.resolveLakekeeperWarehouseName(
          checked.warehouseId,
          uid,
          warehousesEnabled
        )
      } catch {
        case refused: IllegalArgumentException => throw new BadRequestException(refused.getMessage)
      }
    val replay = checked.replay.map(replaySourceOf(checked.wid, uid, _))
    // Kept in the row, which only this service reads: an address is no part of the plan a
    // computing unit is handed.
    val notification = notificationFor(checked, user, requestUri).map(Notification.toJson)

    val (eid, replayLog) = ExecutionsMetadataPersistService.insertCreatedExecution(
      wid,
      uid,
      checked.executionName,
      checked.environmentVersion,
      checked.computingUnitId,
      checked.warehouseId,
      replayLogRoot,
      notification
    )
    logger.info(
      s"Execution ${eid.id} of workflow ${checked.wid} is created for user $uid on computing " +
        s"unit ${checked.computingUnitId}."
    )
    // From here the row exists: whatever fails before a unit may have the plan closes it as
    // failed, with why, so it does not stay open although no unit can ever start it.
    val (plan, resultTables) = closingOnFailure(eid, warehouse, planNotMade) {
      val hints = costHints.load(checked.wid, uid)
      val made = compiling.planToRun(
        PlanRequest(
          checked.wid,
          eid.id,
          warehouse,
          checked.settings,
          checked.plan,
          checked.target
        ),
        authorization,
        compileDeadline
      )
      val linked = linkedPlan(made, wid, eid, warehouse, hints, replay, replayLog)
      (PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(linked)), linked.resultTables)
    }
    closingOnFailure(eid, warehouse, _ => ExecutionClosing.PlanTooLarge)(requireFits(eid, plan))
    closingOnFailure(eid, warehouse, planNotMade)(
      ExecutionsMetadataPersistService.insertResultTables(eid, resultTables)
    )
    val catalogToken =
      closingOnFailure(eid, warehouse, planNotMade)(access.open(eid.id, warehouse))
    handOver(eid, checked.computingUnitId, plan, uid, warehouse, catalogToken)
    background.execute(() => {
      closeEndedBefore(eid, wid, checked.computingUnitId)
      expiry.expireReplaced(wid.id, checked.computingUnitId, eid.id)
    })
    CreateExecutionResponse(eid.id)
  }

  /**
    * Hands `plan`, the plan of execution `eid`, to computing unit `cuid`, which starts the
    * execution, with the token its catalog requests carry. A unit that refuses it, or that
    * nothing reached, never has the plan: the row is closed as failed, with why. A unit that was
    * sent the plan and did not answer may run it: the row is left open.
    *
    * @param warehouse the warehouse the execution writes into
    * @throws WebApplicationException 409 with the unit's reason, 503, or 504
    */
  private def handOver(
      eid: ExecutionIdentity,
      cuid: Int,
      plan: String,
      uid: Int,
      warehouse: Option[String],
      catalogToken: Option[String]
  ): Unit =
    units.start(cuid, plan, uid, catalogToken) match {
      case Taken =>
        logger.info(s"Execution ${eid.id} is started on computing unit $cuid.")
      case Refused(why) =>
        logger.info(s"Computing unit $cuid did not start execution ${eid.id}: $why")
        closeUnstartable(eid, ExecutionClosing.notStartedByUnit(why), warehouse)
        throw new WebApplicationException(
          s"Execution ${eid.id} could not be started on computing unit $cuid. $why",
          Response.Status.CONFLICT
        )
      case Unreached(cause) =>
        logger.warn(
          s"Computing unit $cuid could not be reached to start execution ${eid.id}.",
          cause
        )
        closeUnstartable(eid, ExecutionClosing.UnitUnreachable, warehouse)
        throw new WebApplicationException(
          s"Execution ${eid.id} could not be started: computing unit $cuid could not be reached.",
          Response.Status.SERVICE_UNAVAILABLE
        )
      case Unanswered(cause) =>
        logger.warn(
          s"Computing unit $cuid did not answer whether it started execution ${eid.id}.",
          cause
        )
        throw new WebApplicationException(
          s"Computing unit $cuid did not answer whether it started execution ${eid.id}. " +
            "It may be running.",
          Response.Status.GATEWAY_TIMEOUT
        )
    }

  /**
    * Refuses (400) the plan of execution `eid` when it is larger than a computing unit takes
    * ([[MaxPlanBytes]]): the workflow's doing, as the files it lists make the plan.
    */
  private def requireFits(eid: ExecutionIdentity, plan: String): Unit =
    PhysicalPlanCodec.oversizeMiB(plan).foreach { mib =>
      throw new BadRequestException(
        String.format(
          Locale.ROOT,
          "Execution %d could not be created. Its plan is %.1f MiB, and a plan may be at most " +
            "%d MiB. A plan holds a link to each file its operators read, so a workflow that " +
            "lists fewer files makes a smaller plan.",
          Long.box(eid.id),
          Double.box(mib),
          Int.box(MaxPlanBytes / (1024 * 1024))
        )
      )
    }

  /**
    * Closes each execution of workflow `wid` on computing unit `cuid` made before `eid` that is
    * still open although its log shows an ending, as the closing job would on its next tick.
    * One whose log shows no ending is left as it is: it may be running, or no unit has started
    * it yet. So is one whose warehouse cannot be reached
    * ([[ExecutionClosing.warehouseUnavailable]]), which the closing job closes without reading it.
    *
    * Nothing here is thrown: an execution that cannot be looked at stays open for the job.
    */
  private def closeEndedBefore(eid: ExecutionIdentity, wid: WorkflowIdentity, cuid: Int): Unit =
    try {
      ExecutionRecords
        .openBefore(wid.id, cuid, eid.id)
        .filterNot(earlier =>
          ExecutionClosing.warehouseUnavailable(earlier.warehouse, warehousesEnabled)
        )
        .foreach { earlier =>
          try closer.closeIfEnded(earlier)
          catch {
            case NonFatal(failure) =>
              logger.warn(
                s"Execution ${earlier.eid}, made before execution ${eid.id}, could not be " +
                  s"looked at, so it is left to the closing job: $failure"
              )
          }
        }
    } catch {
      case NonFatal(failure) =>
        logger.warn(
          s"The open executions of workflow ${wid.id} on computing unit $cuid could not be " +
            "listed, so they are left to the closing job.",
          failure
        )
    }

  /**
    * `step`, a step of the create of execution `eid`, which writes into `warehouse`, after its
    * row exists and before its plan is handed to a unit. When it fails, the row is closed as
    * failed for `reason` of the failure ([[closeUnstartable]]), and the create fails with
    * [[answerTo]] the failure.
    */
  private def closingOnFailure[T](
      eid: ExecutionIdentity,
      warehouse: Option[String],
      reason: Throwable => String
  )(step: => T): T =
    try step
    catch {
      case NonFatal(failure) =>
        closeUnstartable(eid, reason(failure), warehouse)
        throw answerTo(eid, failure)
    }

  /**
    * Closes the row of execution `eid`, whose create failed, as failed for `reason`: as one no
    * unit ever started, which it is, so nothing looks for its results. Then drops its namespace
    * in `warehouse`, with any table a start its unit refused made, and ends what its token can
    * do ([[ExecutionCatalogAccess.drop]]): no unit runs it. A close or a drop that fails is
    * logged, not thrown, since the caller is owed the create's own failure: the closing job then
    * closes a row left open as never started.
    */
  private def closeUnstartable(
      eid: ExecutionIdentity,
      reason: String,
      warehouse: Option[String]
  ): Unit = {
    try {
      ExecutionRecords.close(
        eid.id,
        WorkflowExecutionStatus.Failed,
        Some(reason),
        System.currentTimeMillis(),
        fromLog = false,
        unstartable = true
      )
    } catch {
      case NonFatal(unclosed) =>
        logger.warn(s"Execution ${eid.id}, whose create failed, could not be closed.", unclosed)
    }
    try access.drop(eid.id, warehouse)
    catch {
      case NonFatal(undropped) =>
        logger.warn(
          s"The namespace of execution ${eid.id}, whose create failed, could not be dropped.",
          undropped
        )
    }
  }

  /**
    * The plan the compiling service made for execution `eid` of workflow `wid`, `made`, as the
    * computing unit runs it: each file its operators read linked, at the address the plan gives
    * it, and the run's cost hints, the replay log it replays and the one it writes added.
    */
  private def linkedPlan(
      made: String,
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String],
      hints: Option[CostHints],
      replay: Option[ReplaySource],
      replayLog: Option[URI]
  ): ExecutionPlan = {
    val unlinked = PhysicalPlanCodec.decodeUnlinked(PhysicalPlanCodec.fromJson(made))
    val context = unlinked.context
    if (context.workflowId != wid || context.executionId != eid || context.warehouse != warehouse) {
      throw new IllegalStateException(
        s"The compiling service answered the plan of execution ${context.executionId.id} of " +
          s"workflow ${context.workflowId.id}, asked for execution ${eid.id}'s."
      )
    }
    context.costHints = hints
    ExecutionPlan(context, unlinked.plan.linkedBy(linker), replay, replayLog)
  }

  /** Why an execution whose plan could not be made is closed, given what failed. */
  private def planNotMade(failure: Throwable): String =
    failure match {
      case refused: CompileRefused if refused.status == Response.Status.BAD_REQUEST.getStatusCode =>
        // One operator's error, the same one whenever the workflow is compiled; of a workflow
        // the compiler cannot read, why.
        ExecutionClosing.compileError(
          if (refused.operatorErrors.isEmpty) refused.getMessage
          else refused.operatorErrors.minBy(_._1)._2.message
        )
      case _ => ExecutionClosing.PlanNotMade
    }

  /**
    * What a create answers when `failure` stops it after execution `eid`'s row exists, with the
    * statuses the class comment lists: the answer a step chose for its own failure, and
    * otherwise 500, with the failure as its cause.
    */
  private def answerTo(eid: ExecutionIdentity, failure: Throwable): WebApplicationException = {
    def notCreated(why: String, status: Response.Status): WebApplicationException =
      new WebApplicationException(s"Execution ${eid.id} could not be created: $why", status)
    def tookTooLong: WebApplicationException =
      notCreated(
        s"compiling the workflow took longer than $compileDeadline.",
        Response.Status.GATEWAY_TIMEOUT
      )
    failure match {
      case refused: CompileRefused if refused.status == Response.Status.BAD_REQUEST.getStatusCode =>
        if (refused.operatorErrors.isEmpty) new BadRequestException(refused.getMessage)
        else {
          logger.info(
            s"Execution ${eid.id} failed: the workflow does not compile. ${refused.getMessage}"
          )
          new WorkflowNotCompiled(eid.id, refused.operatorErrors, refused.getMessage)
        }
      case refused: CompileRefused
          if refused.status == Response.Status.SERVICE_UNAVAILABLE.getStatusCode =>
        notCreated(
          "too many workflows are being compiled. Try again in a moment.",
          Response.Status.SERVICE_UNAVAILABLE
        )
      case refused: CompileRefused
          if refused.status == Response.Status.GATEWAY_TIMEOUT.getStatusCode =>
        tookTooLong
      case unanswered: CompileUnanswered if unanswered.timedOut => tookTooLong
      case unanswered: CompileUnanswered =>
        logger.warn(s"Execution ${eid.id} failed: ${unanswered.getMessage}", unanswered)
        notCreated(
          "the workflow compiling service could not be reached. Try again in a moment.",
          Response.Status.SERVICE_UNAVAILABLE
        )
      case answer: WebApplicationException => answer
      case other =>
        new InternalServerErrorException(
          s"Execution ${eid.id} could not be created: its plan could not be made.",
          other
        )
    }
  }

  /**
    * The parts of `request` a create uses, with what it may leave out filled in, or 400 with what
    * is missing or wrong. The logical plan is taken as it was sent.
    */
  private def checkedRequest(request: CreateExecutionRequest): CheckedRequest = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    if (request == null) refuse("The request has no body.")
    if (request.wid < 1 || request.wid > Int.MaxValue) {
      refuse("The request names no workflow.")
    }
    if (request.computingUnitId < 1) {
      refuse("The request names no computing unit to run the workflow on.")
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
      refuse(
        "The request's engine version is longer than the " +
          s"${MaxColumnLength - ExecutionsMetadataPersistService.environmentVersionOf("").length} " +
          "characters an execution keeps."
      )
    }
    val plan = Option(request.logicalPlan)
      .filter(_.isObject)
      .getOrElse(refuse("The request has no logical plan."))
    // Any output ports whose results are stored that the settings name are replaced by the ones
    // the compiler finds, which the plan is saved with.
    val settings = Option(request.workflowSettings).flatten.getOrElse(
      WorkflowSettings(dataTransferBatchSize = ApplicationConfig.defaultDataTransferBatchSize)
    )
    WorkflowSettings.problemOf(settings).foreach(problem => refuse(problem))
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
      target = Option(request.targetOperatorId).flatten,
      settings = settings,
      emailNotificationEnabled = request.emailNotificationEnabled,
      warehouseId = Option(request.warehouseId).flatten,
      replay = replay
    )
  }

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
        s"Computing unit $cuid is terminated.",
        Response.Status.CONFLICT
      )
    }
  }

  /**
    * The replay log that `info` names, or 400: an execution of workflow `wid` that user `uid`
    * ran themselves and that kept a replay log, at an absolute URI. A log holds what its run
    * read, so it is replayed only by the user who made it.
    */
  private def replaySourceOf(wid: Long, uid: Integer, info: ReplayExecutionInfo): ReplaySource = {
    def refuse(message: String): Nothing = throw new BadRequestException(message)
    val source =
      Option
        .when(info.eid >= 1 && info.eid <= Int.MaxValue)(info.eid)
        .flatMap { eid =>
          Option(
            SqlServer
              .getInstance()
              .createDSLContext()
              .select(
                WORKFLOW_VERSION.WID,
                WORKFLOW_EXECUTIONS.UID,
                WORKFLOW_EXECUTIONS.LOG_LOCATION
              )
              .from(WORKFLOW_EXECUTIONS)
              .join(WORKFLOW_VERSION)
              .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
              .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(eid.toInt)))
              .fetchOne()
          )
        }
        .filter(_.value1().longValue() == wid)
        .getOrElse(refuse(s"Workflow $wid has no execution ${info.eid} to replay."))
    if (source.value2() != uid) {
      refuse(s"Execution ${info.eid} is another user's: only your own executions can be replayed.")
    }
    val location = Option(source.value3()).filter(_.nonEmpty).getOrElse {
      refuse(s"Execution ${info.eid} kept no replay log to replay.")
    }
    val logUri = Try(new URI(location)).toOption.filter(_.isAbsolute).getOrElse {
      refuse(s"The replay log of execution ${info.eid} is not at an absolute URI.")
    }
    ReplaySource(ExecutionIdentity(info.eid), logUri, info.interaction)
  }

  /**
    * Where the email about how the run ended goes and what it names, when the request asks for
    * one and the user has an address: the workflow's name, and its page on the host the request
    * came to.
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
