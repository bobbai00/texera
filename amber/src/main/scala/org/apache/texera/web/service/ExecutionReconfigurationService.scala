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
import org.apache.texera.amber.core.storage.{
  ExecutionPlanStore,
  NoStoredPlanException,
  NoSuchUpdateException,
  PlanRecord,
  RepositoryMountManager
}
import org.apache.texera.amber.core.virtualidentity.{ActorVirtualIdentity, PhysicalOpIdentity}
import org.apache.texera.amber.core.workflow.{PhysicalOp, PhysicalPlanCodec, RepositoryMounts}
import org.apache.texera.amber.engine.architecture.coordinator.{UpdateExecutorCompleted, Workflow}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  UpdateExecutorRequest,
  WorkflowReconfigureRequest
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.web.SubscriptionManager
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.request.ModifyLogicRequest
import org.apache.texera.web.model.websocket.response.{
  ModifyLogicCompletedEvent,
  ModifyLogicResponse
}
import org.apache.texera.web.storage.{ExecutionReconfigurationStore, ExecutionStateStore}

import java.net.URI
import java.nio.file.Path
import java.util.UUID
import scala.util.control.NonFatal
import scala.util.{Failure, Success}

/**
  * Changes to the operators of a paused run, which the engine applies when the run resumes: a
  * change sent over the socket and made into an operator here ([[modifyOperatorLogic]]), or one
  * the Dashboard service made and stored in the execution's plan table ([[applyStoredUpdate]]).
  *
  * @param bindResources pins the datasets and models an edited operator names, the way the
  *                      compiler that made the workflow's plan pinned every operator: production
  *                      passes that compiler's bindResources. None for a run of a plan the
  *                      Dashboard made, which no compiler here made: its operators change only
  *                      through its plan table.
  * @param planUri       the plan table of the execution the run runs, where the Dashboard stores
  *                      the changes to its operators
  * @param creator       the user who created the execution: only the changes they stored apply,
  *                      when they ask for them
  * @param mountRoot     the directory this computing unit mounts datasets and models under, which
  *                      the code of a stored change must read them from
  */
class ExecutionReconfigurationService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    workflow: Workflow,
    bindResources: Option[PhysicalOp => PhysicalOp],
    planUri: URI,
    creator: Int,
    mountRoot: Option[Path]
) extends SubscriptionManager
    with LazyLogging {

  // monitors notification from the engine that a reconfiguration on a worker is completed
  registerWorkerCompletionCallback()

  // monitors the reconfiguration state (completed workers) change,
  // notifies the frontend when all workers of an operator complete reconfiguration
  registerCompletionDiffHandler()

  // handles reconfigure workflow logic from frontend
  // validate the modify logic request and notifies the frontend
  // reconfigurations can only come when the workflow is paused,
  // they are not actually performed until the workflow is resumed
  def modifyOperatorLogic(modifyLogicRequest: ModifyLogicRequest): TexeraWebSocketEvent =
    bindResources match {
      case Some(bind) => modifyOperatorLogic(modifyLogicRequest, bind)
      case None =>
        ModifyLogicResponse(
          modifyLogicRequest.operator.operatorIdentifier.id,
          isValid = false,
          s"Execution ${workflow.context.executionId.id} runs the plan the Dashboard made for it: " +
            "change its operators through the Dashboard."
        )
    }

  private def modifyOperatorLogic(
      modifyLogicRequest: ModifyLogicRequest,
      bind: PhysicalOp => PhysicalOp
  ): TexeraWebSocketEvent = {
    val newOp = modifyLogicRequest.operator
    val opId = newOp.operatorIdentifier
    val currentOp = workflow.logicalPlan.getOperator(opId)
    // The deployed operator carries the compiler's final references; the edit, the parse's typed
    // ones.
    if (
      workflow.logicalPlan.refersToLoopVariables(currentOp) ||
      workflow.logicalPlan.refersToLoopVariables(newOp)
    ) {
      ModifyLogicResponse(
        opId.id,
        isValid = false,
        s"${currentOp.operatorInfo.userFriendlyName} refers to loop variables, so it can't be " +
          "changed while the workflow runs."
      )
    } else {
      val reconfiguredPhysicalOp =
        currentOp
          .runtimeReconfiguration(
            workflow.context.workflowId,
            workflow.context.executionId,
            currentOp,
            newOp
          )
          // The edited operator joins a plan made to run, so what it names is pinned now, for
          // the plan's user: a version they cannot read refuses the edit.
          .map { case (op, stateTransfer) => (bind(op), stateTransfer) }
      reconfiguredPhysicalOp match {
        case Failure(exception) =>
          ModifyLogicResponse(opId.id, isValid = false, exception.getMessage)
        case Success(op) => {
          stateStore.reconfigurationStore.updateState(old =>
            old.copy(unscheduledReconfigurations = old.unscheduledReconfigurations :+ op)
          )
          ModifyLogicResponse(opId.id, isValid = true, "")
        }
      }
    }
  }

  /**
    * Queues the change to an operator that the Dashboard service stored as `updateId` in the plan
    * table of the execution this run runs, to be applied when the run resumes, as an edit sent over
    * the socket is ([[performReconfigurationOnResume]]).
    *
    * Only the execution's creator may ask for it, and the change must be one they stored, in the
    * format this unit reads, for this execution, of an operator the running plan has, whose code
    * reads its datasets and models where this unit mounts them. The operator queued is the
    * running one with the change's executor and what its code reads; the rest of it, its ports
    * and links included, stays as the running plan has it.
    *
    * @param requester the user who asks for the change; None for a request of no user
    * @return valid, naming the logical operator that changes; or invalid, saying why the change is
    *         refused, naming the operator once the change is read
    */
  def applyStoredUpdate(updateId: String, requester: Option[Int]): ModifyLogicResponse = {
    val executionId = workflow.context.executionId.id
    def refuse(operator: String, why: String): ModifyLogicResponse =
      ModifyLogicResponse(operator, isValid = false, why)
    val onlyTheCreator =
      s"only the user who created execution $executionId may change its operators"
    if (!requester.contains(creator)) {
      return refuse("", onlyTheCreator)
    }
    if (updateId == null || updateId.isBlank) {
      return refuse("", "the request names no change to apply")
    }
    // An update row: the store finds no other kind under an update's id.
    val record =
      try readUpdate(planUri, updateId)
      catch {
        case _: NoSuchUpdateException =>
          return refuse("", s"execution $executionId has no change $updateId")
        case _: NoStoredPlanException =>
          return refuse("", s"execution $executionId has no stored plan")
        case NonFatal(failure) =>
          logger.warn(s"Change $updateId of execution $executionId could not be read.", failure)
          return refuse("", s"change $updateId of execution $executionId could not be read")
      }
    if (record.formatVersion != PhysicalPlanCodec.FormatVersion) {
      return refuse(
        "",
        s"unknown update format ${record.formatVersion}; this unit reads " +
          s"${PhysicalPlanCodec.FormatVersion}"
      )
    }
    if (record.createdBy != creator) {
      return refuse("", onlyTheCreator)
    }
    val update =
      try PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(record.body))
      catch { case refused: IllegalArgumentException => return refuse("", refused.getMessage) }
    val operator = update.opId.logicalOpId.id
    if (update.executionId.id != executionId) {
      return refuse(
        operator,
        s"the change is execution ${update.executionId.id}'s, not $executionId's"
      )
    }
    if (update.updateId != updateId) {
      return refuse(operator, s"the change stored as $updateId names itself ${update.updateId}")
    }
    workflow.physicalPlan.operators.find(_.id == update.opId) match {
      case None => refuse(operator, s"operator ${show(update.opId)} is not in the running plan")
      case Some(running) =>
        val changed = running.copy(
          opExecInitInfo = update.opExecInitInfo,
          repositoryMounts = update.repositoryMounts
        )
        try {
          // The running operator's resources were bound when its plan was made, and a change
          // keeps them, so this holds on every started run; the queue takes bound operators only.
          changed.requireResourcesBound()
          // The Dashboard wrote the change's code against the root its deployment mounts under:
          // refused here when this unit mounts elsewhere, rather than failing the run on resume.
          changed.repositoryMounts.foreach(
            RepositoryMountManager.requireMountableUnder(_, mountRoot)
          )
        } catch {
          case refused @ (_: IllegalStateException | _: IllegalArgumentException) =>
            return refuse(operator, refused.getMessage)
        }
        stateStore.reconfigurationStore.updateState(old =>
          old.copy(unscheduledReconfigurations =
            old.unscheduledReconfigurations :+ ((changed, None))
          )
        )
        logger.info(
          s"Queued $updateId, a change to operator ${show(update.opId)} of execution $executionId."
        )
        ModifyLogicResponse(operator, isValid = true, "")
    }
  }

  // Reads a stored change. A seam, so a test can make the read fail.
  protected def readUpdate(planUri: URI, updateId: String): PlanRecord =
    ExecutionPlanStore.readUpdate(planUri, updateId)

  private def show(id: PhysicalOpIdentity): String = s"${id.logicalOpId.id}-${id.layerName}"

  // actually performs all reconfiguration requests the user made during pause
  // sends ModifyLogic messages to operators and workers,
  // see the Fries reconfiguration paper for the algorithm.
  // Note: StateTransferFunc is currently not threaded through to the engine —
  // the new UpdateExecutorRequest only carries (targetOpId, newOpExecInitInfo).
  def performReconfigurationOnResume(): Unit = {
    val reconfigurations = stateStore.reconfigurationStore.getState.unscheduledReconfigurations
    if (reconfigurations.isEmpty) {
      return
    }

    // Each queued operator was bound when its edit was accepted; none is bound here.
    reconfigurations.foreach { case (op, _) => op.requireResourcesBound() }

    val reconfigurationId = UUID.randomUUID().toString
    val updateExecutorRequests = reconfigurations.map {
      case (op, _) =>
        // An edited UDF may now name a repository, and its code already refers to the mount.
        op.repositoryMounts.foreach(ensureMounted)
        UpdateExecutorRequest(op.id, op.opExecInitInfo)
    }
    dispatch(
      WorkflowReconfigureRequest(
        reconfiguration = updateExecutorRequests,
        reconfigurationId = reconfigurationId
      )
    )

    // clear all un-scheduled reconfigurations, start a new reconfiguration ID
    stateStore.reconfigurationStore.updateState(_ =>
      ExecutionReconfigurationStore(currentReconfigId = Some(reconfigurationId))
    )
  }

  // Seam for unit testing without a computing unit to mount into.
  protected def ensureMounted(mounts: RepositoryMounts): Unit =
    RepositoryMountManager.ensureAllMounted(mounts)

  // Seam for unit testing the dispatch path without spinning up an AmberClient.
  protected def dispatch(request: WorkflowReconfigureRequest): Unit = {
    client.coordinatorInterface.reconfigureWorkflow(request, ())
  }

  // Seam for unit testing — production wires the engine's UpdateExecutorCompleted
  // events into the reconfiguration store so the diff handler above can fire
  // ModifyLogicCompletedEvent for the frontend.
  protected def registerWorkerCompletionCallback(): Unit = {
    addSubscription(
      client.registerCallback[UpdateExecutorCompleted]((evt: UpdateExecutorCompleted) => {
        onWorkerReconfigured(evt.id)
      })
    )
  }

  // Exposed (instead of inlined in the callback) so tests can drive the
  // completion path directly.
  private[service] def onWorkerReconfigured(worker: ActorVirtualIdentity): Unit = {
    stateStore.reconfigurationStore.updateState(old =>
      old.copy(completedReconfigurations = old.completedReconfigurations + worker)
    )
  }

  // Seam for unit testing — the diff handler dereferences workflow.physicalPlan
  // to map worker → logical op, which makes constructing a service in tests
  // require a full Workflow. Tests override to no-op.
  protected def registerCompletionDiffHandler(): Unit = {
    addSubscription(
      stateStore.reconfigurationStore.registerDiffHandler((oldState, newState) => {
        if (
          oldState.completedReconfigurations != newState.completedReconfigurations
          && oldState.currentReconfigId == newState.currentReconfigId
        ) {
          val diff = newState.completedReconfigurations -- oldState.completedReconfigurations
          val newlyCompletedOps = diff
            .map(workerId => workflow.physicalPlan.getPhysicalOpByWorkerId(workerId).id)
            .map(opId => opId.logicalOpId.id)
          if (newlyCompletedOps.nonEmpty) {
            List(ModifyLogicCompletedEvent(newlyCompletedOps.toList))
          } else {
            List()
          }
        } else {
          List()
        }
      })
    )
  }
}
