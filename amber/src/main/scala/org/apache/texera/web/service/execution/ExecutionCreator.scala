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
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.auth.util.{ComputingUnitAccess, WorkflowAccess}
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{CompileFor, WorkflowCompilationFailed}
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
import org.apache.texera.web.service.{
  ExecutionsMetadataPersistService,
  PlanToRun,
  WorkflowEmailNotifier
}

import java.net.URI
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{
  ArrayBlockingQueue,
  BlockingQueue,
  ExecutionException,
  Executor,
  ExecutorService,
  LinkedBlockingQueue,
  RejectedExecutionException,
  ThreadPoolExecutor,
  TimeUnit,
  TimeoutException
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
    * How long a workflow's compile may take: half of the 120 seconds each deployment's route
    * gives a create, which leaves the rest for the cost hints before it and the plan's write
    * after it.
    */
  val CompileDeadline: FiniteDuration = 60.seconds

  /** How many creates compile at once, and how many more may wait for a compile to begin. */
  private val CompileThreads = 8
  private val CompilesWaiting = 32

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
      plan: LogicalPlanPojo,
      settings: WorkflowSettings,
      emailNotificationEnabled: Boolean,
      warehouseId: Option[Int],
      replay: Option[ReplayExecutionInfo]
  )
}

/**
  * The workflow of a create does not compile (400): execution `eid` is recorded as failed.
  *
  * @param operatorErrors the first error of each operator that has one, by the operator's id
  */
final class WorkflowNotCompiled(
    val eid: Long,
    val operatorErrors: Map[String, WorkflowFatalError],
    message: String
) extends BadRequestException(message)

/**
  * Creates executions: what `POST /api/executions` on the Dashboard service does. No computing
  * unit is involved: the unit the execution is created for later starts it from the plan written
  * here.
  *
  * In this order, which decides what a refused request leaves behind:
  *  1. The request is checked: a workflow, a computing unit, an engine version, settings a plan
  *     can be made to run under, and a workflow whose graph the compiler can read (with a target,
  *     which must be one of its operators, the part of it up to the target, which is all that is
  *     compiled). Otherwise 400.
  *  1. The user must be able to read the workflow and run workflows on the unit (403, also for a
  *     unit that does not exist), and the unit must not be terminated (409).
  *  1. The warehouse the run writes into and the replay log it replays, which is one of the
  *     user's own executions of the workflow, are checked (400).
  *  1. The execution's row is inserted, as Created, with where it writes its replay log when
  *     replay logs are kept, and where the email about how its run ended goes when the request
  *     asks for one. No row is left by a request refused before this.
  *  1. The workflow is compiled for the user's run, under the site's settings as they stand and
  *     with the cost hints of their newest completed run of it, and the plan made
  *     ([[PlanToRun.make]]): each file a scan source reads is one the user may read, and the plan
  *     carries a link to it for the computing unit to read it through; each Python environment
  *     an operator names is one the user keeps, and the plan carries its packages for the unit
  *     to install. A workflow that does not compile, a scan of a file the user may not read or
  *     an operator in an environment the user does not have among them, closes the row as
  *     failed, "compile error: …" with one operator's error, and is answered with each
  *     operator's error ([[WorkflowNotCompiled]], 400). The compile runs on a pool of its own
  *     with a deadline, and one that passes it closes the row as failed, "its plan could not be
  *     made" (504). A plan that cannot be made for another reason, such as the database or the
  *     storage not answering while a file is resolved or linked, closes the row so too (500).
  *  1. The plan is written to the execution's plan table, with the logical plan it was compiled
  *     from (as JSON that parses back to it, [[LogicalPlanPojo.toJson]]), the user and the unit.
  *     A plan larger than the table keeps closes the row as failed, "its plan could not be
  *     stored" (400); so does a write that fails (500).
  *  1. Off the request's thread, the workflow's earlier executions on the unit whose logs show
  *     an ending are closed, without waiting for the closing job: a run that ended seconds ago
  *     is replaced like any other. Then the results of its closed executions on the unit that a
  *     later one has replaced are cleared ([[ExecutionResources.clearReplacedExecutions]]). The
  *     new execution replaces none until a unit runs it.
  *
  * A create fails in one way: with the JAX-RS exception of its status, which the Dashboard answers
  * as `{"code", "message"}`. One that fails once its row exists closes the row itself
  * ([[ExecutionRecords.close]]): no engine and no log will ever say how such an execution
  * ended. No email is sent about it: the user is looking at the failure. Until every reader
  * takes an ending from the closing record, the row's status is FAILED as well.
  *
  * @param bindingsFor       what a plan is bound to, for a user
  * @param replayLogRoot     where runs keep their replay logs; None when they keep none
  * @param warehousesEnabled whether runs write into per-user warehouses
  * @param costHints         finds the cost hints a plan is saved with
  * @param writePlan         writes the plan row, and the logical plan it was compiled from, to
  *                          the plan table at a URI
  * @param background        runs what a create leaves to be done after it has answered
  * @param closer            closes the earlier executions a create finds ended
  * @param compiles          runs the compiles, a bounded number at once
  * @param compileDeadline   how long a compile may take
  */
class ExecutionCreator(
    bindingsFor: Integer => CompileFor.Run = PlanToRun.bindingsFor,
    replayLogRoot: Option[URI] = ApplicationConfig.faultToleranceLogRootFolder,
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
    costHints: CostHintsLoader = new CostHintsLoader(),
    writePlan: (URI, PlanRecord, String) => Unit = ExecutionPlanStore.writePlan,
    background: Executor = ExecutionCreator.daemonThreads(
      "execution-clearing",
      threads = 1,
      waiting = new LinkedBlockingQueue[Runnable]()
    ),
    closer: ExecutionCloser = new ExecutionCloser(),
    compiles: ExecutorService = ExecutionCreator.daemonThreads(
      "execution-compile",
      ExecutionCreator.CompileThreads,
      waiting = new ArrayBlockingQueue[Runnable](ExecutionCreator.CompilesWaiting)
    ),
    compileDeadline: FiniteDuration = ExecutionCreator.CompileDeadline
) extends LazyLogging {
  import ExecutionCreator.{CheckedRequest, MaxColumnLength}

  /**
    * Creates the execution `request` asks for, for `user`, in the steps this class describes.
    *
    * @param requestUri the URI the request came to: the email about the run links to the
    *                   workflow on its host
    * @return the execution created
    * @throws WebApplicationException with the status of the step that refused the request or
    *                                 failed; a [[WorkflowNotCompiled]] when the workflow does not
    *                                 compile
    */
  def create(
      request: CreateExecutionRequest,
      user: User,
      requestUri: URI
  ): CreateExecutionResponse = {
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
    // From here the row exists: whatever fails closes it as failed, with why, so it does not
    // stay open although no unit can ever start it.
    val (planUri, record, logical) = closingOnFailure(eid, planNotMade) {
      val context = new WorkflowContext(wid, eid, checked.settings, warehouse)
      // How long each operator took in the user's newest completed run of the workflow, for the
      // scheduler's cost model: saved with the plan, which the engine takes them from.
      context.costHints = costHints.load(checked.wid, uid)
      // The plan compiled, as the request sent it, loop-variable references included: written
      // before the compile resolves its operators in place.
      val logical = checked.plan.toJson
      val bindings = bindingsFor(uid)
      val savedPlan = withinDeadline(eid) {
        PlanToRun.make(context, bindings, checked.plan, replay, replayLog)
      }
      val record = PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        body = savedPlan,
        createdBy = uid.intValue(),
        computingUnitId = checked.computingUnitId
      )
      (ExecutionPlanStore.planUri(wid, eid, warehouse), record, logical)
    }
    closingOnFailure(eid, _ => ExecutionClosing.PlanNotStored) {
      try writePlan(planUri, record, logical)
      catch {
        // The workflow's doing, not the lake's.
        case tooLarge: PlanTooLargeException =>
          throw new BadRequestException(
            s"Execution ${eid.id} could not be created. ${tooLarge.getMessage} A plan holds a " +
              "link to each file its operators read, so a workflow that lists fewer files " +
              "makes a smaller plan.",
            tooLarge
          )
        case NonFatal(failure) =>
          throw new InternalServerErrorException(
            s"Execution ${eid.id} could not be created: its plan could not be written to " +
              "the lake.",
            failure
          )
      }
    }
    background.execute(() => {
      closeEndedBefore(eid, wid, checked.computingUnitId)
      ExecutionResources.clearReplacedExecutions(wid, checked.computingUnitId)
    })
    CreateExecutionResponse(eid.id, planUri.toString)
  }

  /**
    * Closes each execution of workflow `wid` on computing unit `cuid` made before `eid` that is
    * still open although its log shows an ending, as the closing job would on its next tick.
    * One whose log shows no ending is left as it is: it may be running, or no unit has started
    * it yet. So is one whose tables are in a warehouse this deployment cannot reach, which the
    * closing job closes without reading it.
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
    * `step`, a step of the create of execution `eid` after its row exists. When it fails, the
    * row is closed as failed for `reason` of the failure, and marked FAILED for the lists that
    * still read its status, and the create fails with [[answerTo]] the failure.
    *
    * The row is closed as one no unit ever started, which it is: nothing looks for its results.
    * A close that fails is logged, not thrown, since the caller is owed the create's own
    * failure; the closing job then closes the row as never started.
    */
  private def closingOnFailure[T](eid: ExecutionIdentity, reason: Throwable => String)(
      step: => T
  ): T =
    try step
    catch {
      case NonFatal(failure) =>
        ExecutionsMetadataPersistService.markFailed(eid)
        try {
          ExecutionRecords.close(
            eid.id,
            WorkflowExecutionStatus.Failed,
            Some(reason(failure)),
            System.currentTimeMillis(),
            fromLog = false,
            neverStarted = true
          )
        } catch {
          case NonFatal(unclosed) =>
            logger.warn(s"Execution ${eid.id}, whose create failed, could not be closed.", unclosed)
        }
        throw answerTo(eid, failure)
    }

  /** Why an execution whose plan could not be made is closed, given what failed. */
  private def planNotMade(failure: Throwable): String =
    failure match {
      case failed: WorkflowCompilationFailed =>
        // One operator's error, the same one whenever the workflow is compiled.
        ExecutionClosing.compileError(failed.operatorErrors.minBy(_._1.id)._2.message)
      case _ => ExecutionClosing.PlanNotMade
    }

  /**
    * `compile`, the compile of execution `eid`'s workflow, run on a thread of the pool of
    * compiles while the request's thread waits for it, for no longer than the deadline. A compile
    * reads what the workflow's operators name, such as the files of its scans or the database of
    * a SQL source, at addresses the request chose: a source that does not answer holds one of the
    * pool's threads, not the service's.
    *
    * @throws WebApplicationException (504) if the deadline passes, when the compile is
    *                                 interrupted, or (503) if as many compiles as the pool holds
    *                                 wait already
    */
  private def withinDeadline[T](eid: ExecutionIdentity)(compile: => T): T = {
    val compiling =
      try compiles.submit[T](() => compile)
      catch {
        case _: RejectedExecutionException =>
          throw new WebApplicationException(
            s"Execution ${eid.id} could not be created: too many workflows are being compiled. " +
              "Try again in a moment.",
            Response.Status.SERVICE_UNAVAILABLE
          )
      }
    try compiling.get(compileDeadline.toMillis, TimeUnit.MILLISECONDS)
    catch {
      case failed: ExecutionException => throw failed.getCause
      case _: TimeoutException =>
        compiling.cancel(true)
        throw new WebApplicationException(
          s"Execution ${eid.id} could not be created: compiling the workflow took longer than " +
            s"$compileDeadline.",
          Response.Status.GATEWAY_TIMEOUT
        )
      case interrupted: InterruptedException =>
        compiling.cancel(true)
        throw interrupted
    }
  }

  /**
    * What a create answers when `failure` stops it after execution `eid`'s row exists: each
    * operator's error for a workflow that does not compile (400), the answer a step chose for
    * its own failure (400 for a plan too large to store), and otherwise 500, with the failure as
    * its cause.
    */
  private def answerTo(eid: ExecutionIdentity, failure: Throwable): WebApplicationException =
    failure match {
      case failed: WorkflowCompilationFailed =>
        logger.info(
          s"Execution ${eid.id} failed: the workflow does not compile. ${failed.getMessage}"
        )
        new WorkflowNotCompiled(
          eid.id,
          failed.operatorErrors.map { case (operator, error) => operator.id -> error },
          failed.getMessage
        )
      case answer: WebApplicationException => answer
      case other =>
        new InternalServerErrorException(
          s"Execution ${eid.id} could not be created: its plan could not be made.",
          other
        )
    }

  /**
    * The parts of `request` a create uses, with what it may leave out filled in, or 400 with what
    * is missing or wrong. The plan compiled is the one sent, or, with a target, the target and
    * the part of the plan upstream of it.
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
    val sent = Option(request.logicalPlan).getOrElse(refuse("The request has no logical plan."))
    sent.listProblem().foreach(problem => refuse(problem))
    // Lists a client may leave out, which the compiler reads.
    val whole = sent.copy(
      opsToViewResult = Option(sent.opsToViewResult).getOrElse(Nil),
      opsToReuseResult = Option(sent.opsToReuseResult).getOrElse(Nil)
    )
    // Only the plan compiled has to be a graph the compiler reads: with a target, a part of the
    // workflow the run does not reach is neither compiled nor checked.
    val plan = Option(request.targetOperatorId).flatten match {
      case Some(target) =>
        if (!whole.operators.exists(_.operatorIdentifier.id == target)) {
          refuse(s"The workflow has no operator $target to run up to.")
        }
        whole.upstreamOf(target)
      case None => whole
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
