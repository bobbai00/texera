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

import com.google.protobuf.timestamp.Timestamp
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.PlanRecord
import org.apache.texera.amber.core.virtualidentity.{
  EmbeddedControlMessageIdentity,
  ExecutionIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlan, WorkflowContext}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.coordinator.{CoordinatorConfig, Workflow}
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.EmptyRequest
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.{
  FaultToleranceConfig,
  StateRestoreConfig
}
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.amber.operator.udf.UdfRepositoryDirectories
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.ExecutionEnvironmentService.EnvironmentNotInstalled
import org.apache.texera.web.service.WorkflowExecutionService.RunServices
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.{ComputingUnitMaster, SubscriptionManager, WebsocketInput}

import java.net.URI
import java.nio.file.Path
import java.time.Instant
import scala.collection.mutable
import scala.util.control.NonFatal
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
    * The configuration the coordinator of a run of `executionPlan` starts with: this unit's, with
    * the replay and the replay log the plan holds. The run replays the plan's replay log, up to
    * its interaction, and writes its own replay log where the plan says.
    */
  def coordinatorConfigOf(executionPlan: ExecutionPlan): CoordinatorConfig =
    CoordinatorConfig.default.copy(
      stateRestoreConfOpt = executionPlan.replay.map(replay =>
        StateRestoreConfig(
          readFrom = replay.logLocation,
          replayDestination = EmbeddedControlMessageIdentity(replay.interaction)
        )
      ),
      faultToleranceConfOpt =
        executionPlan.replayLog.map(location => FaultToleranceConfig(writeTo = location))
    )

  /**
    * `plan` as a computing unit that mounts datasets and models under `unitMountRoot` runs it:
    * the code of each operator that reads any holds the directory the unit mounts it at
    * ([[UdfRepositoryDirectories]]). Done once, when the plan is handed to the engine, so a plan
    * that reads what the unit cannot mount fails before any region runs.
    *
    * @param unitMountRoot None on a unit that mounts none
    * @throws IllegalStateException if an operator reads a dataset or model, and the unit mounts
    *                               none
    */
  def mountedUnder(plan: PhysicalPlan, unitMountRoot: Option[Path]): PhysicalPlan =
    plan.copy(operators = plan.operators.map(UdfRepositoryDirectories.mountedUnder(unitMountRoot)))

  /**
    * What a run is made of once it is set up: the plan as this unit runs it, under the run's
    * context, the client of the engine built on that plan, and the services around the run.
    */
  final case class RunServices(
      workflow: Workflow,
      client: AmberClient,
      reconfiguration: ExecutionReconfigurationService,
      stats: ExecutionStatsService,
      runtime: ExecutionRuntimeService,
      console: ExecutionConsoleService
  )
}

/**
  * One run of a workflow on this computing unit: of an execution the Dashboard service created,
  * of the plan read back from the execution's plan table in the lake. It is built on the context
  * its plan was read back with, and started from that plan ([[startStored]]): the engine, and
  * every service around the run, are built on the plan read back, and the Python environments
  * the plan names are installed on this unit before the engine starts. Its operators change,
  * while it is paused, only by the changes the Dashboard stored in its plan table.
  *
  * @param mountRoot            the directory this computing unit mounts datasets and models
  *                             under, which the code of the plan, and of every change to an
  *                             operator of it, is given to read them from; None on a unit that
  *                             mounts none. Production reads the unit's environment; a parameter
  *                             so a test can name one.
  * @param environmentInstaller installs the Python environments the plan names on this unit;
  *                             the run's workers are told the root it installs them under
  * @param createAmberRuntime   hands a plan to the engine, under its context and the
  *                             coordinator's configuration, and returns the engine's client,
  *                             which reports what fails to the handler it is given
  */
class WorkflowExecutionService(
    val workflowContext: WorkflowContext,
    resultService: ExecutionResultService,
    val executionStateStore: ExecutionStateStore,
    errorHandler: Throwable => Unit,
    mountRoot: Option[Path],
    environmentInstaller: PythonEnvironmentInstaller = PythonEnvironmentInstaller.forThisUnit,
    createAmberRuntime: (
        WorkflowContext,
        PhysicalPlan,
        CoordinatorConfig,
        Throwable => Unit
    ) => AmberClient = ComputingUnitMaster.createAmberRuntime
) extends SubscriptionManager
    with LazyLogging {

  // Wire error/state reporting first, before any other construction work, so a
  // fatalErrors update (recorded by errorHandler) always has an emitter.
  // Construction itself does no external work and cannot throw; the throwing
  // work lives in startStored(), whose failures reach the UI through this same
  // handler.
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

  val wsInput = new WebsocketInput()

  // The run's state, as every session on the workflow is told it, with the execution the run is
  // of: a session that did not start the run learns from it which execution it watches.
  private def createStateEvent(state: ExecutionMetadataStore): WorkflowStateEvent = {
    val stateName =
      if (state.isRecovering && state.state != COMPLETED) "Recovering"
      else Utils.aggregatedStateToString(state.state)
    WorkflowStateEvent(stateName, Some(workflowContext.executionId.id))
  }

  // Set once, by the start that sets the run up. Read on other threads than that start's.
  @volatile private var built: Option[RunServices] = None

  /**
    * What the run is made of, once [[startStored]] has set it up; None before that, and for a
    * run that could not be set up.
    */
  def services: Option[RunServices] = built

  /**
    * Starts the run from `executionPlan`, the plan the plan row `record` of the plan table at
    * `planUri` holds, read back. The execution was claimed for this start, and the run's context
    * is the one the plan was read back with. The plan's code is given the directories this unit
    * mounts the datasets and models it reads at ([[WorkflowExecutionService.mountedUnder]]): a
    * plan that reads any fails here on a unit that mounts none. The run replays what the plan
    * replays, and writes its replay log where the plan says. The engine and every service around
    * the run are built on that plan, and the run is READY. The engine is asked to start once the Python environments the plan names are
    * ready on this unit: at once when it names none, and otherwise on a thread of the unit's
    * installer, after this has returned, and only if the run still waits for it then. A run that
    * was killed or superseded meanwhile is left as it ended, while its installs go on for the
    * runs after it; a run whose environment cannot be installed ends FAILED, with pip's words as
    * its error.
    *
    * @return Some(failure) when the run could not be set up, once reported through the error
    *         handler: nothing is kept of it, and its engine, if one was built, is shut down.
    *         None once the run is set up
    */
  def startStored(
      executionPlan: ExecutionPlan,
      record: PlanRecord,
      planUri: URI
  ): Option[Throwable] =
    Try(setUp(executionPlan, record, planUri)) match {
      case Failure(failure) =>
        errorHandler(failure)
        Some(failure)
      case Success(run) =>
        built = Some(run)
        start(run)
        None
    }

  /**
    * Builds the engine and every service around the run on `executionPlan`, as this unit runs
    * it. All of them or none: when a service cannot be built, the engine built before it is shut
    * down.
    */
  private def setUp(executionPlan: ExecutionPlan, record: PlanRecord, planUri: URI): RunServices = {
    val workflow = Workflow(
      workflowContext,
      WorkflowExecutionService.mountedUnder(executionPlan.plan, mountRoot)
    )
    // The run's workers find its Python environments where this service installs them.
    val coordinatorConfig = WorkflowExecutionService
      .coordinatorConfigOf(executionPlan)
      .copy(pythonEnvironmentsRoot = environmentInstaller.root.toString)
    val client =
      createAmberRuntime(workflowContext, workflow.physicalPlan, coordinatorConfig, errorHandler)
    try {
      val reconfiguration = new ExecutionReconfigurationService(
        client,
        executionStateStore,
        workflow,
        planUri,
        record.createdBy,
        mountRoot
      )
      RunServices(
        workflow,
        client,
        reconfiguration,
        new ExecutionStatsService(client, executionStateStore, workflowContext),
        new ExecutionRuntimeService(
          client,
          executionStateStore,
          wsInput,
          reconfiguration,
          coordinatorConfig.faultToleranceConfOpt
        ),
        new ExecutionConsoleService(client, executionStateStore, wsInput, workflowContext)
      )
    } catch {
      case NonFatal(failure) =>
        client.shutdown()
        throw failure
    }
  }

  /**
    * Makes the run READY, and asks its engine to start once the Python environments its plan
    * names are ready.
    */
  private def start(run: RunServices): Unit = {
    logger.info("Starting the workflow execution.")
    resultService.attachToExecution(
      workflowContext.executionId,
      executionStateStore,
      run.workflow.physicalPlan,
      run.client
    )
    executionStateStore.transitionTo(READY)
    executionStateStore.statsStore.updateState(stats =>
      stats.withStartTimeStamp(System.currentTimeMillis())
    )
    val environments = new ExecutionEnvironmentService(
      run.workflow.physicalPlan,
      run.console,
      environmentInstaller,
      () => awaitsStart(run)
    )
    environments.prepare().whenComplete { (_, failure) =>
      try {
        if (awaitsStart(run)) failure match {
          case null                                  => startEngine(run)
          case notInstalled: EnvironmentNotInstalled => failBeforeStart(notInstalled)
          case other                                 => errorHandler(other)
        }
      } catch {
        case NonFatal(err) => errorHandler(err)
      }
    }
  }

  /**
    * Whether the run still waits for its engine to start: nothing has killed, superseded or
    * failed it since it was set up.
    */
  private def awaitsStart(run: RunServices): Boolean =
    run.client.isActive && !executionStateStore.hasEnded

  private def startEngine(run: RunServices): Unit =
    run.client.coordinatorInterface
      .startWorkflow(EmptyRequest(), ())
      .onFailure(err => {
        errorHandler(err)
      })
      .onSuccess(resp => executionStateStore.transitionTo(resp.workflowState))

  /**
    * Ends the run before its engine starts, as one of its Python environments could not be
    * installed: FAILED, with why as its error, which names the first operator that runs in the
    * environment and holds what the install wrote. A run that ended meanwhile keeps the state
    * it ended in.
    */
  private def failBeforeStart(notInstalled: EnvironmentNotInstalled): Unit = {
    val error = WorkflowFatalError(
      EXECUTION_FAILURE,
      Timestamp(Instant.now),
      notInstalled.getMessage,
      notInstalled.details,
      notInstalled.operators.head.id
    )
    if (end(FAILED, errors = Seq(error))) {
      logger.info(
        s"Execution ${workflowContext.executionId.id} fails before its engine starts: " +
          notInstalled.getMessage
      )
    }
  }

  /**
    * Ends the run in `state`, because of `errors` or for `reason`: its engine, if one was built,
    * is shut down. A run that has ended is left as it ended.
    *
    * @return whether this ended the run
    */
  def end(
      state: WorkflowAggregatedState,
      errors: Seq[WorkflowFatalError] = Nil,
      reason: Option[String] = None
  ): Boolean = {
    services.foreach(_.client.shutdown())
    executionStateStore.transitionTo(state, errors, reason)
  }

  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    services.foreach { run =>
      run.client.shutdown()
      run.runtime.unsubscribeAll()
      run.console.unsubscribeAll()
      run.stats.unsubscribeAll()
      run.reconfiguration.unsubscribeAll()
    }
  }

}
