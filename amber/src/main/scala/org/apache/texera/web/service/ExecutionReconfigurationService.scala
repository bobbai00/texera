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
import org.apache.texera.amber.core.storage.RepositoryMountManager
import org.apache.texera.amber.core.virtualidentity.{ActorVirtualIdentity, PhysicalOpIdentity}
import org.apache.texera.amber.core.workflow.{OperatorUpdate, PhysicalOp, PhysicalPlanCodec}
import org.apache.texera.amber.engine.architecture.coordinator.{UpdateExecutorCompleted, Workflow}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  UpdateExecutorRequest,
  WorkflowReconfigureRequest
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.operator.udf.UdfRepositoryDirectories
import org.apache.texera.web.SubscriptionManager
import org.apache.texera.web.model.websocket.response.{
  ModifyLogicCompletedEvent,
  ModifyLogicResponse
}
import org.apache.texera.web.storage.{ExecutionReconfigurationStore, ExecutionStateStore}

import java.nio.file.Path
import java.util.UUID

/**
  * Changes to the operators of a paused run ([[OperatorUpdate]]), as the Dashboard service made
  * them to run ([[applyUpdate]]).
  *
  * @param startedBy the user who started the execution: only the changes they ask for apply
  * @param mountRoot the directory this computing unit mounts datasets and models under; None on
  *                  a unit that mounts none
  */
class ExecutionReconfigurationService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    workflow: Workflow,
    startedBy: Int,
    mountRoot: Option[Path]
) extends SubscriptionManager
    with LazyLogging {

  // monitors notification from the engine that a reconfiguration on a worker is completed
  registerWorkerCompletionCallback()

  // monitors the reconfiguration state (completed workers) change,
  // notifies the frontend when all workers of an operator complete reconfiguration
  registerCompletionDiffHandler()

  /**
    * Queues `update`, a change to an operator as the Dashboard service made it to run, to be
    * applied when the run resumes ([[performReconfigurationOnResume]]).
    *
    * Only the user who started the execution may ask for it, and the change must be this
    * execution's, of an operator the running plan has, keep the Python environment that operator
    * runs in, and read no dataset or model unless this unit mounts them.
    *
    * @param requester the user who asks for the change; None for a request of no user
    * @return valid, naming the logical operator that changes; or invalid, saying why the change is
    *         refused, naming the operator once the change is read
    */
  def applyUpdate(update: String, requester: Option[Int]): ModifyLogicResponse =
    changeOf(update, requester) match {
      case Left(why) => ModifyLogicResponse("", isValid = false, why)
      case Right(change) =>
        val operator = change.opId.logicalOpId.id
        changedBy(change) match {
          case Left(why) => ModifyLogicResponse(operator, isValid = false, why)
          case Right(changed) =>
            stateStore.reconfigurationStore.updateState(old =>
              old.copy(unscheduledReconfigurations = old.unscheduledReconfigurations :+ changed)
            )
            logger.info(
              s"Queued a change to operator ${show(change.opId)} of execution $executionId."
            )
            ModifyLogicResponse(operator, isValid = true, "")
        }
    }

  private def executionId: Long = workflow.context.executionId.id

  /**
    * The change `update` holds. Whether `requester` may ask is checked before it is read.
    *
    * @return why the change is refused (Left), or the change (Right)
    */
  private def changeOf(update: String, requester: Option[Int]): Either[String, OperatorUpdate] =
    for {
      _ <- Either.cond(
        requester.contains(startedBy),
        (),
        s"Only the user who started execution $executionId may change its operators."
      )
      text <- Option(update).filterNot(_.isBlank).toRight("The request carries no change to apply.")
      change <-
        try Right(PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(text)))
        catch { case refused: IllegalArgumentException => Left(refused.getMessage) }
    } yield change

  /**
    * The running operator as `update` changes it.
    *
    * @return why the change is refused (Left), or the changed operator (Right)
    */
  private def changedBy(update: OperatorUpdate): Either[String, PhysicalOp] =
    for {
      _ <- Either.cond(
        update.executionId.id == executionId,
        (),
        s"The change is execution ${update.executionId.id}'s, not $executionId's."
      )
      running <-
        workflow.physicalPlan.operators
          .find(_.id == update.opId)
          .toRight(s"Operator ${show(update.opId)} is not in the running plan.")
      // An update gives the running operator a new executor and what its code reads; its workers
      // keep the interpreter they run in, so a change of environment would never take effect.
      // The running operator's environment is as its plan resolved it, whatever its user keeps
      // under its name now: only asking for another is a change of it.
      _ <- Either.cond(
        update.pythonEnvironment == running.pythonEnvironment.environmentName,
        (),
        "The operator's Python environment cannot change while the run is paused."
      )
      stored = running.copy(
        opExecInitInfo = update.opExecInitInfo,
        repositoryMounts = update.repositoryMounts
      )
      // A change that reads what this unit cannot mount is refused here, rather than failing
      // the run on resume.
      changed <-
        try Right(UdfRepositoryDirectories.mountedUnder(mountRoot)(stored))
        catch {
          case refused @ (_: IllegalStateException | _: IllegalArgumentException) =>
            Left(refused.getMessage)
        }
    } yield changed

  private def show(id: PhysicalOpIdentity): String = s"${id.logicalOpId.id}-${id.layerName}"

  // actually performs all reconfiguration requests the user made during pause
  // sends ModifyLogic messages to operators and workers,
  // see the Fries reconfiguration paper for the algorithm.
  def performReconfigurationOnResume(): Unit = {
    val reconfigurations = stateStore.reconfigurationStore.getState.unscheduledReconfigurations
    if (reconfigurations.isEmpty) {
      return
    }

    val reconfigurationId = UUID.randomUUID().toString
    val updateExecutorRequests = reconfigurations.map { op =>
      // A changed UDF may now name a repository, and its code already refers to the mount.
      op.repositoryMounts.foreach(mounts => ensureMounted(mounts.locators))
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
  protected def ensureMounted(locators: Set[String]): Unit =
    RepositoryMountManager.ensureAllMounted(locators)

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
