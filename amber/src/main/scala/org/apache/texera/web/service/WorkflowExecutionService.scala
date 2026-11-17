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
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessageType.ERROR
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.EmptyRequest
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
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.{ComputingUnitMaster, SubscriptionManager, WebsocketInput}

import java.net.URI
import java.nio.file.Path
import java.time.Instant
import scala.collection.mutable
import scala.util.control.NonFatal

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
}

/**
  * One run of a workflow on this computing unit: of an execution the Dashboard service created,
  * of the plan read back from the execution's plan table in the lake. It is built on the context
  * its plan was read back with, and started from that plan ([[startStored]]): the engine, and
  * every service around the run, are built on the plan read back, and the Python environments
  * the plan names are installed on this unit before the engine starts. Its operators change,
  * while it is paused, only by the changes the Dashboard stored in its plan table.
  *
  * @param mountRoot the directory this computing unit mounts datasets and models under, which
  *                  the code of the plan, and of every change to an operator of it, is given to
  *                  read them from; None on a unit that mounts none. Production reads the unit's
  *                  environment; a parameter so a test can name one.
  */
class WorkflowExecutionService(
    val workflowContext: WorkflowContext,
    resultService: ExecutionResultService,
    val executionStateStore: ExecutionStateStore,
    errorHandler: Throwable => Unit,
    mountRoot: Option[Path]
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

  val wsInput = new WebsocketInput(errorHandler)

  // The run's state, as every session on the workflow is told it, with the execution the run is
  // of: a session that did not start the run learns from it which execution it watches.
  private def createStateEvent(state: ExecutionMetadataStore): WorkflowStateEvent = {
    val stateName =
      if (state.isRecovering && state.state != COMPLETED) "Recovering"
      else Utils.aggregatedStateToString(state.state)
    WorkflowStateEvent(stateName, Some(workflowContext.executionId.id))
  }

  var workflow: Workflow = _
  var client: AmberClient = _
  var executionReconfigurationService: ExecutionReconfigurationService = _
  var executionStatsService: ExecutionStatsService = _
  var executionRuntimeService: ExecutionRuntimeService = _
  var executionConsoleService: ExecutionConsoleService = _

  /**
    * Starts the run from `executionPlan`, the plan the plan row `record` of the plan table at
    * `planUri` holds, read back. The execution was claimed for this start, and the run's context
    * is the one the plan was read back with. The plan's code is given the directories this unit
    * mounts the datasets and models it reads at ([[WorkflowExecutionService.mountedUnder]]): a
    * plan that reads any fails here on a unit that mounts none. The run replays what the plan
    * replays, writes its replay log where the plan says, and sends its status emails where the
    * row says. The engine and every service around the run are built on that plan, and the run
    * is READY. The engine is asked to start once the Python environments the plan names are
    * ready on this unit: at once when it names none, and otherwise on a thread of the unit's
    * installer, after this has returned, and only if the run still waits for it then. A run that
    * was killed or superseded meanwhile is left as it ended, while its installs go on for the
    * runs after it; a run whose environment cannot be installed ends FAILED, with pip's words as
    * its error.
    *
    * @return Some(failure) when the run fails before its engine is built, once reported through
    *         the error handler; None once the run is set up
    */
  def startStored(
      executionPlan: ExecutionPlan,
      record: PlanRecord,
      planUri: URI
  ): Option[Throwable] = {
    val (plan, notification) =
      try {
        (
          WorkflowExecutionService.mountedUnder(executionPlan.plan, mountRoot),
          record.notification.map(Notification.fromJson)
        )
      } catch {
        case err: Throwable =>
          // The run ends here, reported, before anything is built for it.
          errorHandler(err)
          return Some(err)
      }
    // The run, and every service built around it below, use the plan as this unit runs it.
    workflow = Workflow(workflowContext, plan)
    val coordinatorConfig = WorkflowExecutionService.coordinatorConfigOf(executionPlan)

    client = createAmberRuntime(workflow, coordinatorConfig)
    executionReconfigurationService = new ExecutionReconfigurationService(
      client,
      executionStateStore,
      workflow,
      planUri,
      record.createdBy,
      mountRoot
    )
    executionStatsService = new ExecutionStatsService(client, executionStateStore, workflow.context)
    executionRuntimeService = new ExecutionRuntimeService(
      client,
      executionStateStore,
      wsInput,
      executionReconfigurationService,
      coordinatorConfig.faultToleranceConfOpt,
      workflowContext.workflowId.id,
      notification
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
    val environments = new ExecutionEnvironmentService(
      workflow.physicalPlan,
      executionConsoleService,
      environmentInstaller,
      () => awaitsStart
    )
    environments.prepare().whenComplete { (_, failure) =>
      try {
        if (awaitsStart) failure match {
          case null                                  => startEngine()
          case notInstalled: EnvironmentNotInstalled => failBeforeStart(notInstalled)
          case other                                 => errorHandler(other)
        }
      } catch {
        case NonFatal(err) => errorHandler(err)
      }
    }
    None
  }

  /**
    * Whether the run is set up and still waits for its engine to start: nothing has killed,
    * superseded or failed it since.
    */
  private def awaitsStart: Boolean =
    client.isActive &&
      !WorkflowService.FinishedStates.contains(executionStateStore.metadataStore.getState.state)

  private def startEngine(): Unit =
    client.coordinatorInterface
      .startWorkflow(EmptyRequest(), ())
      .onFailure(err => {
        errorHandler(err)
      })
      .onSuccess(resp =>
        executionStateStore.metadataStore.updateState(metadataStore =>
          // A run that ended before its start was answered (it failed, completed, was killed or
          // was superseded) keeps the state it ended in.
          if (WorkflowService.FinishedStates.contains(metadataStore.state)) {
            metadataStore
          } else {
            updateWorkflowState(resp.workflowState, metadataStore)
          }
        )
      )

  /**
    * Ends the run before its engine starts, as one of its Python environments could not be
    * installed: FAILED, with why as its error, which names the first operator that runs in the
    * environment, and then on the console of every operator that does. The consoles are
    * committed here, as the engine will report no end. A run that ended meanwhile keeps the
    * state it ended in, and is told nothing.
    */
  private def failBeforeStart(notInstalled: EnvironmentNotInstalled): Unit = {
    val failedAt = System.currentTimeMillis()
    var failed = false
    // Decided under the store's lock, against a kill that may arrive at this moment.
    executionStateStore.metadataStore.updateState { metadataStore =>
      if (WorkflowService.FinishedStates.contains(metadataStore.state)) {
        metadataStore
      } else {
        failed = true
        updateWorkflowState(FAILED, metadataStore).addFatalErrors(
          WorkflowFatalError(
            EXECUTION_FAILURE,
            Timestamp(Instant.now),
            notInstalled.getMessage,
            notInstalled.details,
            notInstalled.operators.head.id
          )
        )
      }
    }
    if (failed) {
      logger.info(
        s"Execution ${workflowContext.executionId.id} fails before its engine starts: " +
          notInstalled.getMessage
      )
      client.shutdown()
      executionStateStore.statsStore.updateState(_.withEndTimeStamp(failedAt))
      notInstalled.operators.foreach { operator =>
        executionConsoleService.addUnitMessage(
          operator.id,
          ERROR,
          notInstalled.title,
          notInstalled.details
        )
      }
      executionConsoleService.commitMessages()
    }
  }

  // Installs the Python environments the plan names on this unit. A seam, so a test can stand in
  // for pip.
  protected def environmentInstaller: PythonEnvironmentInstaller =
    PythonEnvironmentInstaller.forThisUnit

  // Hands the plan to the engine. A seam, so a test can set a run up in full, every service
  // built around its plan, without an engine to start it.
  protected def createAmberRuntime(
      workflow: Workflow,
      coordinatorConfig: CoordinatorConfig
  ): AmberClient =
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
