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
import org.apache.texera.amber.core.workflow.PhysicalPlanCodec
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

import java.net.URI
import java.nio.file.Path
import java.util.UUID
import scala.util.control.NonFatal

/**
  * Changes to the operators of a paused run, which the engine applies when the run resumes: the
  * changes the Dashboard service made and stored in the execution's plan table
  * ([[applyStoredUpdate]]).
  *
  * @param planUri   the plan table of the execution the run runs, where the Dashboard stores the
  *                  changes to its operators
  * @param creator   the user who created the execution: only the changes they stored apply, when
  *                  they ask for them
  * @param mountRoot the directory this computing unit mounts datasets and models under, which the
  *                  code of a stored change is given to read them from; None on a unit that
  *                  mounts none
  */
class ExecutionReconfigurationService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    workflow: Workflow,
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

  /**
    * Queues the change to an operator that the Dashboard service stored as `updateId` in the plan
    * table of the execution this run runs, to be applied when the run resumes
    * ([[performReconfigurationOnResume]]).
    *
    * Only the execution's creator may ask for it, and the change must be one they stored, for
    * this execution, of an operator the running plan has, which reads no dataset or model unless
    * this unit mounts them. The operator queued is the running one with the change's executor,
    * its code given where this unit mounts what it reads; the rest of it, its ports and links
    * included, stays as the running plan has it.
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
        val stored = running.copy(
          opExecInitInfo = update.opExecInitInfo,
          repositoryMounts = update.repositoryMounts
        )
        // A change that reads what this unit cannot mount is refused here, rather than failing
        // the run on resume.
        val changed =
          try UdfRepositoryDirectories.mountedUnder(mountRoot)(stored)
          catch {
            case refused @ (_: IllegalStateException | _: IllegalArgumentException) =>
              return refuse(operator, refused.getMessage)
          }
        stateStore.reconfigurationStore.updateState(old =>
          old.copy(unscheduledReconfigurations = old.unscheduledReconfigurations :+ changed)
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
