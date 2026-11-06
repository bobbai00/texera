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

package org.apache.texera.web.resource

import com.google.protobuf.timestamp.Timestamp
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.clustering.ClusterListener
import org.apache.texera.amber.core.virtualidentity.WorkflowIdentity
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.COMPILATION_ERROR
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.error.ErrorUtils.getStackTraceWithAllCauses
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.web.model.websocket.event.{WorkflowErrorEvent, WorkflowStateEvent}
import org.apache.texera.web.model.websocket.request._
import org.apache.texera.web.model.websocket.response._
import org.apache.texera.web.auth.UnitPrincipal
import org.apache.texera.web.service.WorkflowService
import org.apache.texera.web.{ServletAwareConfigurator, SessionState}

import java.time.Instant
import javax.websocket._
import javax.websocket.server.ServerEndpoint

@ServerEndpoint(
  value = "/wsapi/workflow-websocket",
  configurator = classOf[ServletAwareConfigurator]
)
class WorkflowWebsocketResource extends LazyLogging {

  @OnOpen
  def myOnOpen(session: Session, config: EndpointConfig): Unit = {
    val sessionState = new SessionState(session)
    SessionState.setState(session.getId, sessionState)
    val wid = session.getRequestParameterMap.get("wid").get(0).toLong
    val cuid = session.getRequestParameterMap.get("cuid").get(0).toInt
    val caller =
      WorkflowWebsocketResource.principalOf(session).map(_.name).getOrElse("an unverified caller")
    logger.info(
      s"Websocket connection opened for workflow $wid with computing unit $cuid by $caller"
    )
    // hack to refresh frontend run button state
    sessionState.send(WorkflowStateEvent("Uninitialized"))
    val workflowState =
      WorkflowService.getOrCreate(WorkflowIdentity(wid), cuid)
    sessionState.subscribe(workflowState)
    sessionState.send(ClusterStatusUpdateEvent(ClusterListener.numWorkerNodesInCluster))
  }

  @OnClose
  def myOnClose(session: Session, cr: CloseReason): Unit = {
    SessionState.removeState(session.getId)
  }

  @OnMessage
  def myOnMsg(session: Session, message: String): Unit = {
    val principalOpt = WorkflowWebsocketResource.principalOf(session)

    val sessionState = SessionState.getState(session.getId)
    val workflowStateOpt = sessionState.getCurrentWorkflowState
    val executionStateOpt = workflowStateOpt.flatMap(x => Option(x.executionService.getValue))
    try {
      // Inside the try on purpose: a frame the mapper cannot bind is an error like any other, and
      // has to travel back to the client through the same reporting path as a handler failure.
      val request = objectMapper.readValue(message, classOf[TexeraWebSocketRequest])
      request match {
        case heartbeat: HeartBeatRequest =>
          sessionState.send(HeartBeatResponse())
        case paginationRequest: ResultPaginationRequest =>
          workflowStateOpt.foreach(state =>
            sessionState.send(state.resultService.handleResultPagination(paginationRequest))
          )
        case modifyLogicRequest: ModifyLogicRequest =>
          if (workflowStateOpt.isDefined) {
            // Reconfiguration needs the execution, not merely the workflow. `executionService` is a
            // BehaviorSubject with no initial value, so reading it through a workflow-shaped guard
            // yields null and NPEs one dereference later.
            val executionService = executionStateOpt.getOrElse(
              throw new IllegalStateException("workflow execution is not initialized")
            )
            val modifyLogicResponse =
              executionService.executionReconfigurationService.modifyOperatorLogic(
                modifyLogicRequest
              )
            sessionState.send(modifyLogicResponse)
          }
        case workflowExecuteRequest: WorkflowExecuteRequest =>
          if (principalOpt.isEmpty) {
            throw new IllegalStateException("Sign in to run workflows on this computing unit")
          }
          workflowStateOpt match {
            case Some(workflow) =>
              sessionState.send(WorkflowStateEvent("Initializing"))
              synchronized {
                workflow.initExecutionService(
                  // The catalog names an execution's warehouse, after checking who may use
                  // it. A client on this route cannot: its run uses the unit's default.
                  workflowExecuteRequest.copy(warehouse = None),
                  principalOpt,
                  session.getRequestURI
                )
              }
            case None => throw new IllegalStateException("workflow is not initialized")
          }
        case other =>
          // `executionStateOpt`, not `workflowStateOpt.map(_.executionService.getValue)`: the latter
          // wraps a null execution into Some(null), which walks past the None arm below and NPEs.
          executionStateOpt match {
            case Some(value) => value.wsInput.onNext(other, principalOpt.map(_.subject))
            case None        => throw new IllegalStateException("workflow execution is not initialized")
          }
      }
    } catch {
      case err: Exception =>
        logger.error("error occurred in websocket", err)
        val errEvt = WorkflowFatalError(
          COMPILATION_ERROR,
          Timestamp(Instant.now),
          err.toString,
          getStackTraceWithAllCauses(err),
          "unknown operator"
        )
        if (executionStateOpt.isDefined) {
          executionStateOpt.get.executionStateStore.metadataStore.updateState { metadataStore =>
            metadataStore
              .withFatalErrors(metadataStore.fatalErrors.filter(e => e.`type` != COMPILATION_ERROR))
              .addFatalErrors(errEvt)
          }
        } else {
          sessionState.send(
            WorkflowErrorEvent(
              Seq(errEvt)
            )
          )
        }
        throw err
    }

  }
}

object WorkflowWebsocketResource {

  /** The caller the handshake verified, if any (see [[ServletAwareConfigurator]]). */
  def principalOf(session: Session): Option[UnitPrincipal] =
    Option(session.getUserProperties.get(ServletAwareConfigurator.PrincipalKey)).collect {
      case p: UnitPrincipal => p
    }
}
