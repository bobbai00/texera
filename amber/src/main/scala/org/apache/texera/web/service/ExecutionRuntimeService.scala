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
import org.apache.texera.amber.core.virtualidentity.EmbeddedControlMessageIdentity
import org.apache.texera.amber.engine.architecture.coordinator.ExecutionStateUpdate
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  EmptyRequest,
  TakeGlobalCheckpointRequest
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.FaultToleranceConfig
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.web.model.websocket.request._
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.{SubscriptionManager, WebsocketInput}

import java.util.UUID

/**
  * @param notification where the run's status emails go and what they name, as its execution's
  *                     plan row keeps them; None when the run sends none
  */
class ExecutionRuntimeService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    wsInput: WebsocketInput,
    reconfigurationService: ExecutionReconfigurationService,
    logConf: Option[FaultToleranceConfig],
    workflowId: Long,
    private[service] val notification: Option[Notification]
) extends SubscriptionManager
    with LazyLogging {

  private val emailNotificationService = notification.map(notification =>
    new EmailNotificationService(new WorkflowEmailNotifier(workflowId, notification))
  )

  //Receive skip tuple
  addSubscription(wsInput.subscribe((req: SkipTupleRequest, uidOpt) => {
    throw new RuntimeException("skipping tuple is temporarily disabled")
  }))

  // Receive execution state update from Amber
  addSubscription(client.registerCallback[ExecutionStateUpdate]((evt: ExecutionStateUpdate) => {
    stateStore.transitionTo(evt.state)

    emailNotificationService.foreach(_.processEmailNotificationIfNeeded(evt.state))

    if (evt.state == COMPLETED) {
      client.shutdown()
    }
  }))

  // Receive Pause. A run that has ended is not asked to pause.
  addSubscription(wsInput.subscribe((req: WorkflowPauseRequest, uidOpt) => {
    if (stateStore.transitionTo(PAUSING)) {
      client.coordinatorInterface.pauseWorkflow(EmptyRequest(), ())
    }
  }))

  // Receive Resume. A run that has ended is not asked to resume, and takes no change to its
  // operators.
  addSubscription(wsInput.subscribe((req: WorkflowResumeRequest, uidOpt) => {
    if (stateStore.transitionTo(RESUMING)) {
      reconfigurationService.performReconfigurationOnResume()
      client.coordinatorInterface
        .resumeWorkflow(EmptyRequest(), ())
        .onSuccess(_ => stateStore.transitionTo(RUNNING))
    }
  }))

  // Receive Kill
  addSubscription(wsInput.subscribe((req: WorkflowKillRequest, uidOpt) => {
    client.shutdown()
    stateStore.transitionTo(KILLED, reason = Some("killed by the user"))
  }))

  // Receive Interaction
  addSubscription(wsInput.subscribe((req: WorkflowCheckpointRequest, uidOpt) => {
    assert(
      logConf.nonEmpty,
      "Fault tolerance log folder is not established. Unable to take a global checkpoint."
    )
    val checkpointId = EmbeddedControlMessageIdentity(s"Checkpoint_${UUID.randomUUID().toString}")
    val uri = logConf.get.writeTo.resolve(checkpointId.toString)
    client.coordinatorInterface.takeGlobalCheckpoint(
      TakeGlobalCheckpointRequest(estimationOnly = false, checkpointId, uri.toString),
      ()
    )
  }))

  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    emailNotificationService.foreach(_.shutdown())
  }

}
