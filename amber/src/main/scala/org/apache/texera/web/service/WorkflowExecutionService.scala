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
import org.apache.texera.amber.core.storage.{PlanRecord, RepositoryMountManager}
import org.apache.texera.amber.core.virtualidentity.{
  EmbeddedControlMessageIdentity,
  ExecutionIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlan, WorkflowContext}
import org.apache.texera.amber.engine.architecture.coordinator.{CoordinatorConfig, Workflow}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.EmptyRequest
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.{
  FaultToleranceConfig,
  StateRestoreConfig
}
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.{ComputingUnitMaster, SubscriptionManager, WebsocketInput}

import java.net.URI
import java.nio.file.Path
import scala.collection.mutable

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

/**
  * One run of a workflow on this computing unit: of an execution the Dashboard service created,
  * of the plan read back from the execution's plan table in the lake. It is built on the context
  * its plan was read back with, and started from that plan ([[startStored]]): the engine, and
  * every service around the run, are built on the plan read back. Its operators change, while it
  * is paused, only by the changes the Dashboard stored in its plan table.
  *
  * @param mountRoot the directory this computing unit mounts datasets and models under: the
  *                  plan's code reads them from below it, and the plan, and every change to an
  *                  operator of it, is checked against it before it runs. Production reads the
  *                  unit's environment; a parameter so a test can name one.
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

  // Runtime starts from here:
  logger.info("Initialing an AmberClient, runtime starting...")
  var client: AmberClient = _
  var executionReconfigurationService: ExecutionReconfigurationService = _
  var executionStatsService: ExecutionStatsService = _
  var executionRuntimeService: ExecutionRuntimeService = _
  var executionConsoleService: ExecutionConsoleService = _

  /**
    * Starts the run from `executionPlan`, the plan the plan row `record` of the plan table at
    * `planUri` holds, read back. The execution was claimed for this start, and the run's context
    * is the one the plan was read back with. The engine must be able to run the plan on this unit
    * ([[WorkflowExecutionService.requireRunnableUnder]]). The run replays what the plan replays,
    * writes its replay log where the plan says, and sends its status emails where the row says.
    * The engine and every service around the run are built on the plan read back, the run is
    * READY, and the engine is asked to start.
    *
    * @return Some(failure) when the run fails before its engine is built, once reported through
    *         the error handler; None once the run is started
    */
  def startStored(
      executionPlan: ExecutionPlan,
      record: PlanRecord,
      planUri: URI
  ): Option[Throwable] = {
    val notification =
      try {
        WorkflowExecutionService.requireRunnableUnder(executionPlan.plan, mountRoot)
        record.notification.map(Notification.fromJson)
      } catch {
        case err: Throwable =>
          // The run ends here, reported, before anything is built for it.
          errorHandler(err)
          return Some(err)
      }
    // The run, and every service built around it below, use the plan read back.
    workflow = Workflow(workflowContext, executionPlan.plan)
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
    None
  }

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
