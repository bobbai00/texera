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
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.storage.{FileResolver, RepositoryMountManager}
import org.apache.texera.amber.core.storedplan.StoredPhysicalPlan
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{
  ExecutionPlan,
  PhysicalPlan,
  PhysicalPlanCodec,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.coordinator.{CoordinatorConfig, Workflow}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.EmptyRequest
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.model.websocket.request.WorkflowExecuteRequest
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.{ComputingUnitMaster, SubscriptionManager, WebsocketInput}
import org.apache.texera.common.compiler.WorkflowCompiler

import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.security.MessageDigest
import scala.collection.mutable
import scala.util.{Failure, Success, Try}

object WorkflowExecutionService extends LazyLogging {
  def getLatestExecutionId(
      workflowId: WorkflowIdentity,
      computingUnitId: Int
  ): Option[ExecutionIdentity] = {
    WorkflowExecutionsResource
      .getLatestExecutionID(workflowId.id.toInt, computingUnitId)
      .map(eid => new ExecutionIdentity(eid.longValue()))
  }

  /**
    * The workflow the engine runs for the run under `context`: the physical plan `planToRun`
    * saved, read back, run under the settings read back with it. The engine starts here, from the
    * saved text and the logical plan; it is never handed the plan a compile made, so what runs is
    * what was saved.
    *
    * The plan must be the run's own: saved for its workflow and execution, with the batch size
    * and execution mode its request asks for, and its warehouse. The computing unit is the run's
    * own too, as a saved plan names none. The output ports whose results are stored are the
    * plan's, which the compile that made it found, and so are the cost hints: `context` takes
    * the saved settings, stored ports included, and the saved cost hints. And the engine must be
    * able to run the plan on this unit ([[requireRunnableUnder]]). A plan that replays, writes a
    * replay log or reads inputs from outside the run is refused rather than run without them:
    * here the run's coordinator configuration says where it replays from and writes its replay
    * log, and nothing checks an input's link before the run starts. A plan refused leaves
    * `context` as it was.
    *
    * Logs the saved plan's size, and at debug level the saved plan without what may hold
    * credentials: each executor's settings or code, and the user info of a replay log's location.
    *
    * @param unitMountRoot the directory this computing unit mounts datasets and models under
    * @throws IllegalArgumentException if the saved plan is not one the engine reads
    * @throws IllegalStateException    if the plan is another run's, cannot run on this unit, or
    *                                  replays, writes a replay log or reads inputs
    */
  def workflowToRun(
      planToRun: PlanToRun,
      context: WorkflowContext,
      unitMountRoot: Option[Path]
  ): Workflow = {
    val executionId = context.executionId.id
    val savedPlan = planToRun.savedPlan
    logger.info(
      s"Execution $executionId runs a saved plan of " +
        s"${savedPlan.getBytes(StandardCharsets.UTF_8).length} bytes."
    )
    val stored = PhysicalPlanCodec.fromJson(savedPlan)
    logger.debug(
      s"The saved plan of execution $executionId, without what its executors are given:\n" +
        PhysicalPlanCodec.toJson(withoutCredentials(stored))
    )
    val executionPlan = PhysicalPlanCodec.decode(stored)
    requirePlanOf(context, executionPlan.context)
    requireRunnableUnder(executionPlan.plan, unitMountRoot)
    requireNoReplayOrInputs(executionId, executionPlan)
    context.workflowSettings = executionPlan.context.workflowSettings
    context.costHints = executionPlan.context.costHints
    Workflow(context, planToRun.logicalPlan, executionPlan.plan)
  }

  /**
    * Fails unless `planContext`, the context a saved plan was read back with, agrees with
    * `runContext` on all the run's request fixes: the workflow and execution, the batch size and
    * execution mode, and the warehouse. The output ports whose results are stored and the cost
    * hints are left out: the run takes the plan's, as only what made the plan knows them.
    */
  private def requirePlanOf(runContext: WorkflowContext, planContext: WorkflowContext): Unit = {
    def differ[A](what: String, saved: A, run: A)(show: A => String): Option[String] =
      Option.when(saved != run)(s"its $what is ${show(saved)}, the run's is ${show(run)}")
    val (inPlan, inRun) = (planContext.workflowSettings, runContext.workflowSettings)
    val differences = Seq(
      differ("workflow", planContext.workflowId.id, runContext.workflowId.id)(_.toString),
      differ("execution", planContext.executionId.id, runContext.executionId.id)(_.toString),
      differ(
        "data transfer batch size",
        inPlan.dataTransferBatchSize,
        inRun.dataTransferBatchSize
      )(_.toString),
      differ("execution mode", inPlan.executionMode, inRun.executionMode)(_.toString),
      differ("warehouse", planContext.warehouse, runContext.warehouse)(
        _.getOrElse("the default one")
      )
    ).flatten
    if (differences.nonEmpty) {
      throw new IllegalStateException(
        s"The plan handed to execution ${runContext.executionId.id} is not its own: " +
          s"${differences.mkString("; ")}."
      )
    }
  }

  /**
    * Fails if `executionPlan` asks for what the engine does not take from a saved plan: a replay
    * or a replay log, which the run's coordinator configuration gives here, or inputs from
    * outside the run, whose links nothing here checks before the run starts. Run without them,
    * such a plan would run otherwise than it was saved.
    */
  private def requireNoReplayOrInputs(executionId: Long, executionPlan: ExecutionPlan): Unit = {
    val inputs = executionPlan.inputs.size
    val asked = Seq(
      executionPlan.replay.map(replay =>
        s"replays the log of execution ${replay.sourceExecutionId.id}"
      ),
      executionPlan.replayLog.map(_ => "writes a replay log"),
      Option.when(inputs > 0)(
        s"reads $inputs ${if (inputs == 1) "input" else "inputs"} from outside the run"
      )
    ).flatten
    if (asked.nonEmpty) {
      val said =
        if (asked.size == 1) asked.head else s"${asked.init.mkString(", ")} and ${asked.last}"
      throw new IllegalStateException(
        s"The plan handed to execution $executionId $said, which the engine does not take from " +
          "a saved plan."
      )
    }
  }

  /**
    * `stored` without what may hold credentials, for the log: each executor's settings (an
    * operator's descriptor) or code is replaced by its length and SHA-256 digest, as they may hold
    * the operator's credentials, a SQL source's password say; and the location of each replay
    * log, the one the run replays and the one it writes, loses its user info (see
    * [[withoutUserInfo]]). The rest of the plan, what the engine schedules by, is kept.
    */
  private def withoutCredentials(stored: StoredPhysicalPlan): StoredPhysicalPlan = {
    def digest(content: String): String = {
      val sha256 = MessageDigest
        .getInstance("SHA-256")
        .digest(content.getBytes(StandardCharsets.UTF_8))
        .map(byte => f"$byte%02x")
        .mkString
      s"(left out: ${content.length} characters, SHA-256 $sha256)"
    }
    stored.copy(
      operators = stored.operators.map { op =>
        op.copy(opExecInitInfo = op.opExecInitInfo match {
          case OpExecWithClassName(className, descString) =>
            OpExecWithClassName(className, digest(descString))
          case OpExecWithCode(code, language) => OpExecWithCode(digest(code), language)
          case none                           => none
        })
      },
      replay =
        stored.replay.map(replay => replay.withLogLocation(withoutUserInfo(replay.logLocation))),
      replayLogLocation = stored.replayLogLocation.map(withoutUserInfo)
    )
  }

  /**
    * `location` with the user info of its authority left out, for the log: a log store can sign
    * in with it (sftp://user:password@host/...). All of `location` is left out if it is not a URI,
    * as the user info cannot be told apart then.
    */
  private def withoutUserInfo(location: String): String =
    Try(new URI(location)) match {
      case Failure(_) => "(left out: not a URI)"
      case Success(uri) =>
        val authority = Option(uri.getRawAuthority).getOrElse("")
        val userInfoEnd = authority.lastIndexOf('@')
        if (userInfoEnd < 0) location
        else {
          // The authority comes right after the first "//", as a scheme holds no slash.
          val start = location.indexOf("//") + 2
          location.substring(0, start) + "(user info left out)" +
            authority.substring(userInfoEnd) + location.substring(start + authority.length)
        }
    }

  /**
    * Fails unless the engine can run `plan` on a computing unit that mounts datasets and models
    * under `unitMountRoot`: no operator is left to bind, and every operator reads what it mounts
    * under that root. Checked once, when the plan is handed to the engine, so a plan the engine
    * cannot run fails before any region runs rather than partway through; each region checks
    * again before it mounts.
    *
    * @throws IllegalStateException if the engine cannot run the plan here
    */
  def requireRunnableUnder(plan: PhysicalPlan, unitMountRoot: Option[Path]): Unit =
    plan.operators.foreach { op =>
      op.requireResourcesBound()
      op.repositoryMounts.foreach(RepositoryMountManager.requireMountableUnder(_, unitMountRoot))
    }
}

class WorkflowExecutionService(
    coordinatorConfig: CoordinatorConfig,
    val workflowContext: WorkflowContext,
    resultService: ExecutionResultService,
    request: WorkflowExecuteRequest,
    val executionStateStore: ExecutionStateStore,
    errorHandler: Throwable => Unit,
    uid: Integer,
    userEmailOpt: Option[String],
    sessionUri: URI,
    // The directory this computing unit mounts datasets and models under: the plan's code reads
    // them from below it, and the plan is checked against it before it runs. Production reads
    // the unit's environment; a parameter so a test can name one.
    mountRoot: Option[Path] = RepositoryMountManager.mountRoot
) extends SubscriptionManager
    with LazyLogging {

  // Wire error/state reporting first, before any other construction work, so a
  // fatalErrors update (recorded by errorHandler) always has an emitter.
  // Construction itself does no external work and cannot throw; the throwing
  // work lives in executeWorkflow(), whose failures reach the UI through this
  // same handler.
  addSubscription(
    executionStateStore.metadataStore.registerDiffHandler((oldState, newState) => {
      val outputEvents = new mutable.ArrayBuffer[TexeraWebSocketEvent]()

      if (newState.state != oldState.state || newState.isRecovering != oldState.isRecovering) {
        outputEvents.append(createStateEvent(newState))
      }

      if (newState.fatalErrors != oldState.fatalErrors) {
        outputEvents.append(WorkflowErrorEvent(newState.fatalErrors))
      }

      outputEvents
    })
  )

  workflowContext.workflowSettings = request.workflowSettings
  val wsInput = new WebsocketInput(errorHandler)

  private def createStateEvent(state: ExecutionMetadataStore): WorkflowStateEvent = {
    if (state.isRecovering && state.state != COMPLETED) {
      WorkflowStateEvent("Recovering")
    } else {
      WorkflowStateEvent(Utils.aggregatedStateToString(state.state))
    }
  }

  var workflow: Workflow = _

  // Runtime starts from here:
  logger.info("Initialing an AmberClient, runtime starting...")
  var client: AmberClient = _
  var executionReconfigurationService: ExecutionReconfigurationService = _
  var executionStatsService: ExecutionStatsService = _
  var executionRuntimeService: ExecutionRuntimeService = _
  var executionConsoleService: ExecutionConsoleService = _

  // Returns Some(err) when setup fails synchronously (e.g. compilation) after the
  // failure has already been surfaced to the UI via errorHandler, so the caller can
  // mark its still-open setup span; None once the run has started, after which
  // runtime failures arrive asynchronously through errorHandler and belong to later
  // execution work rather than this setup.
  def executeWorkflow(): Option[Throwable] = {
    // Makes the plan to run, for this run's user: it reads only the files, datasets and models
    // they may read, and its code reads each dataset and model where this unit mounts it. An
    // operator changed while the run is paused is bound by it too.
    val compiler = new WorkflowCompiler(
      workflowContext,
      FileResolver.forUser(uid),
      FileResolver.repositoryVersionResolverForUser(uid),
      mountRoot
    )
    try {
      // The plan is made and saved; the engine's half starts from what was saved, and the run,
      // and every service built around it below, use the plan read back from it.
      workflow =
        WorkflowExecutionService.workflowToRun(makePlanToRun(compiler), workflowContext, mountRoot)
    } catch {
      case err: Throwable =>
        // stop here: `workflow` is still null, so falling through would NPE
        // below and mask the reported error, of the compile or of the plan read back
        errorHandler(err)
        return Some(err)
    }

    client = createAmberRuntime(workflow)
    executionReconfigurationService = new ExecutionReconfigurationService(
      client,
      executionStateStore,
      workflow,
      compiler.bindResources
    )
    executionStatsService = new ExecutionStatsService(client, executionStateStore, workflow.context)
    executionRuntimeService = new ExecutionRuntimeService(
      client,
      executionStateStore,
      wsInput,
      executionReconfigurationService,
      coordinatorConfig.faultToleranceConfOpt,
      workflowContext.workflowId.id,
      request.emailNotificationEnabled,
      userEmailOpt,
      sessionUri
    )
    executionConsoleService =
      new ExecutionConsoleService(client, executionStateStore, wsInput, workflow.context)

    logger.info("Starting the workflow execution.")
    resultService.attachToExecution(
      workflow.context.executionId,
      executionStateStore,
      workflow.physicalPlan,
      client
    )
    executionStateStore.metadataStore.updateState(metadataStore =>
      updateWorkflowState(READY, metadataStore)
        .withFatalErrors(Seq.empty)
    )
    executionStateStore.statsStore.updateState(stats =>
      stats.withStartTimeStamp(System.currentTimeMillis())
    )
    client.coordinatorInterface
      .startWorkflow(EmptyRequest(), ())
      .onFailure(err => {
        errorHandler(err)
      })
      .onSuccess(resp =>
        executionStateStore.metadataStore.updateState(metadataStore =>
          if (metadataStore.state != FAILED) {
            updateWorkflowState(resp.workflowState, metadataStore)
          } else {
            metadataStore
          }
        )
      )
    None
  }

  // Makes the plan this run runs and saves it: the half of starting a run that is meant to move
  // to the Dashboard service. A seam, so a test can hand the engine a saved plan of its own.
  protected def makePlanToRun(compiler: WorkflowCompiler): PlanToRun =
    PlanToRun.make(compiler, request.logicalPlan)

  // Hands the plan to the engine. A seam, so a test can set a run up in full, every service
  // built around its plan, without an engine to start it.
  protected def createAmberRuntime(workflow: Workflow): AmberClient =
    ComputingUnitMaster.createAmberRuntime(
      workflow.context,
      workflow.physicalPlan,
      coordinatorConfig,
      errorHandler
    )

  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    if (client != null) {
      // runtime created
      client.shutdown()
      executionRuntimeService.unsubscribeAll()
      executionConsoleService.unsubscribeAll()
      executionStatsService.unsubscribeAll()
      executionReconfigurationService.unsubscribeAll()
    }

  }

}
