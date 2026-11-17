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
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.error.ErrorUtils.getStackTraceWithAllCauses
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
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
    // hack to refresh frontend run button state: the state of no run, before the session is told
    // the state of the run the workflow's service holds, if it holds one
    sessionState.send(WorkflowStateEvent("Uninitialized", executionId = None))
    val workflowState =
      WorkflowService.getOrCreate(WorkflowIdentity(wid), cuid)
    sessionState.subscribe(workflowState)
    sessionState.send(ClusterStatusUpdateEvent(ClusterListener.numWorkerNodesInCluster))
  }

  @OnClose
  def myOnClose(session: Session, cr: CloseReason): Unit = {
    SessionState.removeState(session.getId)
  }

  /**
    * Takes one frame from a session. Whatever the frame asks for that is not done is answered to
    * that session, and to it alone: a frame that reads as no request, a request that is refused
    * (its sender may not change runs on the computing unit, or there is nothing for it to act
    * on) and a request that fails. None of these is written into the run in flight, which every
    * session on the workflow sees, and none closes the session.
    */
  @OnMessage
  def myOnMsg(session: Session, message: String): Unit = {
    val sender = SessionState.getState(session.getId)
    Try(objectMapper.readValue(message, classOf[TexeraWebSocketRequest])).toOption
      .flatMap(Option(_)) match {
      case None =>
        // Not in the mapper's words, which quote the frame: it may hold what its sender would
        // not have logged.
        val why = notARequest(message)
        logger.info(s"Refused a frame: $why")
        sender.send(errorOf(why))
      case Some(request) =>
        val kind = request.getClass.getSimpleName
        try handle(session, sender, request).foreach { why =>
          logger.info(s"Refused a $kind: $why")
          sender.send(request match {
            // A change to an operator is answered as a change that does not apply.
            case _: OperatorUpdateRequest => ModifyLogicResponse("", isValid = false, why)
            case _                        => errorOf(why)
          })
        } catch {
          case NonFatal(failure) =>
            logger.error(s"A $kind failed.", failure)
            sender.send(errorOf(failure.toString, getStackTraceWithAllCauses(failure)))
        }
    }
  }

  /**
    * Does what `request` asks, for the session `sender` that sent it. A heartbeat and a read of
    * results are open to every session. Every other request changes a run, so it is its sender's
    * to make only with WRITE on the socket's computing unit: a start, a change to an operator, and
    * every command to the run the workflow's service holds (pause, resume, kill, checkpoint,
    * retry, skip, debug command, expression to evaluate).
    *
    * @return why the request is refused, if it is; None once it is done or handed on
    */
  private def handle(
      session: Session,
      sender: SessionState,
      request: TexeraWebSocketRequest
  ): Option[String] = {
    val user = session.getUserProperties.asScala
      .get(classOf[User].getName)
      .map(_.asInstanceOf[User])
    val workflow = sender.getCurrentWorkflowState
    // `executionService` is a BehaviorSubject with no initial value: null until a run is started.
    val run = workflow.flatMap(service => Option(service.executionService.getValue))
    request match {
      case _: HeartBeatRequest =>
        sender.send(HeartBeatResponse())
        None
      case pagination: ResultPaginationRequest =>
        workflow.foreach(service =>
          sender.send(service.resultService.handleResultPagination(pagination))
        )
        None
      case _ if sender.getUserComputingUnitAccess != PrivilegeEnum.WRITE =>
        Some("you do not have write access to the computing unit")
      case start: WorkflowStartRequest =>
        startStoredExecution(session, sender, workflow, user, start)
      case update: OperatorUpdateRequest =>
        applyStoredUpdate(sender, run, user, update)
      case command =>
        run match {
          case Some(run) =>
            run.wsInput.onNext(command, user.map(_.getUid))
            None
          case None => Some("workflow execution is not initialized")
        }
    }
  }

  /**
    * Starts the execution `start` names, which the Dashboard service created, on this socket's
    * workflow and computing unit, for the socket's user ([[WorkflowService.startStoredExecution]]).
    * Once started, the run reaches every session on the workflow, as a run does. A start that is
    * refused, or that fails before it is claimed, writes nothing; a start whose run could not
    * even be built is refused too, as its execution reads FAILED.
    *
    * @return why the start is refused, if it is
    */
  private def startStoredExecution(
      session: Session,
      sender: SessionState,
      workflow: Option[WorkflowService],
      user: Option[User],
      start: WorkflowStartRequest
  ): Option[String] =
    try {
      val started = for {
        user <- user.toRight("a signed-in user is required to start an execution")
        workflow <- workflow.toRight("workflow is not initialized")
        // Set with the socket's workflow: a socket with a workflow has its unit.
        cuid <- sender.getComputingUnitId.toRight("workflow is not initialized")
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

  /**
    * Applies the change to an operator that `update` names, which the Dashboard service stored, to
    * the run of its execution on this socket's workflow
    * ([[org.apache.texera.web.service.ExecutionReconfigurationService.applyStoredUpdate]]), and
    * answers `sender` whether it applies. Only the user who created the execution may ask for it.
    *
    * @return why the change is refused, if its execution has no run here
    */
  private def applyStoredUpdate(
      sender: SessionState,
      run: Option[WorkflowExecutionService],
      user: Option[User],
      update: OperatorUpdateRequest
  ): Option[String] =
    run
      .filter(_.workflowContext.executionId.id == update.executionId)
      .flatMap(execution => Option(execution.executionReconfigurationService)) match {
      case Some(service) =>
        sender.send(service.applyStoredUpdate(update.updateId, user.map(_.getUid.intValue())))
        None
      case None => Some(s"execution ${update.executionId} is not running here")
    }

  /**
    * What a session is sent for a request of its own that is not done: one error, of no operator,
    * saying why.
    */
  private def errorOf(why: String, details: String = ""): TexeraWebSocketEvent =
    WorkflowErrorEvent(
      Seq(WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), why, details, ""))
    )

  /**
    * Why `frame`, which binds to no request, is refused: naming the type of request it says it
    * is, when it says one that reads as a type's name.
    */
  private def notARequest(frame: String): String =
    Try(objectMapper.readTree(frame)).toOption
      .flatMap(Option(_))
      .flatMap(json => Option(json.get("type")))
      .filter(_.isTextual)
      .map(_.asText())
      .filter(_.matches("[A-Za-z][A-Za-z0-9]{0,63}"))
      .fold("the request could not be read")(kind => s"the request could not be read as a $kind")
}
