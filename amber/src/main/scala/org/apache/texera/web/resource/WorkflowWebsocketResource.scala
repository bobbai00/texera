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
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.{
  COMPILATION_ERROR,
  EXECUTION_FAILURE
}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.error.ErrorUtils.getStackTraceWithAllCauses
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.websocket.event.{WorkflowErrorEvent, WorkflowStateEvent}
import org.apache.texera.web.model.websocket.request._
import org.apache.texera.web.model.websocket.response._
import org.apache.texera.web.service.{WorkflowExecutionService, WorkflowService}
import org.apache.texera.web.service.execution.StoredExecutionStart
import org.apache.texera.web.{ServletAwareConfigurator, SessionState}

import java.time.Instant
import javax.websocket._
import javax.websocket.server.ServerEndpoint
import scala.jdk.CollectionConverters.MapHasAsScala
import scala.util.Try
import scala.util.control.NonFatal

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
    val cuAccessEnum: PrivilegeEnum = PrivilegeEnum.valueOf(
      session.getUserProperties
        .get(HeaderField.UserComputingUnitAccess)
        .asInstanceOf[String]
    )

    sessionState.setUserComputingUnitAccess(cuAccessEnum)
    sessionState.setComputingUnitId(cuid)
    logger.info(
      s"Websocket connection opened for workflow $wid with computing unit $cuid and access $cuAccessEnum"
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
    val userOpt = session.getUserProperties.asScala
      .get(classOf[User].getName)
      .map(_.asInstanceOf[User])
    val uidOpt = userOpt.map(_.getUid)

    val sessionState = SessionState.getState(session.getId)
    val workflowStateOpt = sessionState.getCurrentWorkflowState
    val executionStateOpt = workflowStateOpt.flatMap(x => Option(x.executionService.getValue))
    try {
      // Inside the try on purpose: a frame the mapper cannot bind is an error like any other, and
      // has to travel back to the client through the same reporting path as a handler failure.
      // Except a start's: a start is answered to its sender alone (below), one that cannot be
      // read too.
      val request =
        try objectMapper.readValue(message, classOf[TexeraWebSocketRequest])
        catch {
          case NonFatal(unreadable) if isStartFrame(message) =>
            logger.info(s"A start that could not be read: ${unreadable.getMessage}")
            refuseStart(sessionState, "the request to start an execution could not be read")
            return
        }
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
        case start: WorkflowStartRequest =>
          // Answered here alone, never by the catch below: that one writes into the run in
          // flight, which every session on the workflow sees, and a refused start is its
          // sender's to see.
          startStoredExecution(session, sessionState, workflowStateOpt, userOpt, start)
        case update: OperatorUpdateRequest =>
          sessionState.send(applyStoredUpdate(sessionState, executionStateOpt, uidOpt, update))
        case workflowExecuteRequest: WorkflowExecuteRequest =>
          if (sessionState.getUserComputingUnitAccess != PrivilegeEnum.WRITE) {
            throw new IllegalStateException("User does not have write access to the computing unit")
          }
          workflowStateOpt match {
            case Some(workflow) =>
              sessionState.send(WorkflowStateEvent("Initializing"))
              synchronized {
                workflow.initExecutionService(
                  workflowExecuteRequest,
                  userOpt,
                  session.getRequestURI
                )
              }
            case None => throw new IllegalStateException("workflow is not initialized")
          }
        case other =>
          // `executionStateOpt`, not `workflowStateOpt.map(_.executionService.getValue)`: the latter
          // wraps a null execution into Some(null), which walks past the None arm below and NPEs.
          executionStateOpt match {
            case Some(value) => value.wsInput.onNext(other, uidOpt)
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

  /**
    * Starts the execution `start` names, which the Dashboard service created, on this socket's
    * workflow and computing unit, for the socket's user: a user with WRITE on the unit
    * ([[WorkflowService.startStoredExecution]]). Once started, the run reaches every session on
    * the workflow, as a run does. A start that is refused, or that fails before it is claimed,
    * writes nothing and is answered with one error, to this session alone; so is a start whose
    * run could not even be built, which its execution records as FAILED.
    */
  private def startStoredExecution(
      session: Session,
      sessionState: SessionState,
      workflowStateOpt: Option[WorkflowService],
      userOpt: Option[User],
      start: WorkflowStartRequest
  ): Unit = {
    val refusal =
      try {
        val started = for {
          _ <- Either.cond(
            sessionState.getUserComputingUnitAccess == PrivilegeEnum.WRITE,
            (),
            "you do not have write access to the computing unit"
          )
          user <- userOpt.toRight("a signed-in user is required to start an execution")
          workflow <- workflowStateOpt.toRight("workflow is not initialized")
          // Set with the socket's workflow: a socket with a workflow has its unit.
          cuid <- sessionState.getComputingUnitId.toRight("workflow is not initialized")
          planUri <- StoredExecutionStart.planUriOf(start.planUri)
          execution <- workflow.startStoredExecution(
            start.executionId,
            planUri,
            user,
            cuid,
            // The socket's URI carries the user's access token in its query: only the rest of it
            // goes on, to the run's log lines.
            StoredExecutionStart.withoutSecrets(session.getRequestURI)
          )
        } yield execution
        started.left.toOption
      } catch {
        case NonFatal(failure) =>
          logger.error(s"Execution ${start.executionId} could not be started.", failure)
          Some(
            s"execution ${start.executionId} could not be started, because of an error on this " +
              "computing unit"
          )
      }
    refusal.foreach { message =>
      logger.info(s"Refused to start execution ${start.executionId}: $message")
      refuseStart(sessionState, message)
    }
  }

  /** Answers a refused start to its sender alone, as one error, and writes nothing. */
  private def refuseStart(sessionState: SessionState, why: String): Unit =
    sessionState.send(
      WorkflowErrorEvent(
        Seq(WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), why, "", ""))
      )
    )

  /** Whether `message` is a frame of type `WorkflowStartRequest`, whatever else it holds. */
  private def isStartFrame(message: String): Boolean =
    Try(objectMapper.readTree(message)).toOption
      .flatMap(frame => Option(frame))
      .flatMap(frame => Option(frame.get("type")))
      .exists(_.asText() == classOf[WorkflowStartRequest].getSimpleName)

  /**
    * Applies the change to an operator that `update` names, which the Dashboard service stored, to
    * the run of its execution on this socket's workflow
    * ([[org.apache.texera.web.service.ExecutionReconfigurationService.applyStoredUpdate]]): asked
    * for by a user with WRITE on the unit, who created the execution.
    */
  private def applyStoredUpdate(
      sessionState: SessionState,
      executionStateOpt: Option[WorkflowExecutionService],
      uidOpt: Option[Integer],
      update: OperatorUpdateRequest
  ): ModifyLogicResponse = {
    def refuse(why: String): ModifyLogicResponse = ModifyLogicResponse("", isValid = false, why)
    if (sessionState.getUserComputingUnitAccess != PrivilegeEnum.WRITE) {
      refuse("you do not have write access to the computing unit")
    } else {
      executionStateOpt
        .filter(_.workflowContext.executionId.id == update.executionId)
        .flatMap(execution => Option(execution.executionReconfigurationService)) match {
        case Some(service) => service.applyStoredUpdate(update.updateId, uidOpt.map(_.intValue()))
        case None          => refuse(s"execution ${update.executionId} is not running here")
      }
    }
  }
}
