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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.clustering.ClusterListener
import org.apache.texera.amber.core.virtualidentity.WorkflowIdentity
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.websocket.event.{RequestRefusedEvent, WorkflowStateEvent}
import org.apache.texera.web.model.websocket.request._
import org.apache.texera.web.model.websocket.response._
import org.apache.texera.web.service.{WorkflowExecutionService, WorkflowService}
import org.apache.texera.web.{ServletAwareConfigurator, SessionState}

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
    * that session, and to it alone, with a [[RequestRefusedEvent]]: a frame that reads as no
    * request, a request that is refused (its sender may not change runs on the computing unit,
    * or there is nothing for it to act on) and a request that fails, also where it fails in the
    * run it was handed to. None of these is written into the run in flight, which every session
    * on the workflow sees, and none closes the session.
    */
  @OnMessage
  def myOnMsg(session: Session, message: String): Unit = {
    val sender = SessionState.getState(session.getId)
    Try(objectMapper.readValue(message, classOf[TexeraWebSocketRequest])).toOption
      .flatMap(Option(_)) match {
      case None =>
        // Not in the mapper's words, which quote the frame: it may hold what its sender would
        // not have logged.
        val kind = typeNamedBy(message)
        val why = kind.fold("The request could not be read.")(kind =>
          s"The request could not be read as a $kind."
        )
        logger.info(s"Refused a frame: $why")
        sender.send(RequestRefusedEvent(kind, None, why))
      case Some(request) =>
        val kind = request.getClass.getSimpleName
        def refused(why: String) = RequestRefusedEvent(Some(kind), executionNamedBy(request), why)
        try handle(session, sender, request).foreach { why =>
          logger.info(s"Refused a $kind: $why")
          sender.send(request match {
            // A change to an operator is answered as a change that does not apply.
            case _: OperatorUpdateRequest => ModifyLogicResponse("", isValid = false, why)
            case _                        => refused(why)
          })
        } catch {
          // What a run cannot do says so itself.
          case unsupported: UnsupportedOperationException if unsupported.getMessage != null =>
            logger.info(s"Refused a $kind: ${unsupported.getMessage}")
            sender.send(refused(unsupported.getMessage))
          case NonFatal(failure) =>
            logger.error(s"A $kind failed.", failure)
            sender.send(
              refused(
                "The request failed on this computing unit: " +
                  Option(failure.getMessage).getOrElse(failure.getClass.getSimpleName)
              )
            )
        }
    }
  }

  private def executionNamedBy(request: TexeraWebSocketRequest): Option[Long] =
    request match {
      case named: ExecutionRequest => Some(named.executionId)
      case _                       => None
    }

  /**
    * Does what `request` asks, for the session `sender` that sent it. A heartbeat and a read of
    * results are open to every session. Every other request changes a run, so it is its sender's
    * to make only with WRITE on the socket's computing unit: a start, a change to an operator, and
    * every command to a run. A change, a pause, a resume and a kill name the execution whose run
    * they are for, and are refused unless the workflow's service holds that run; a checkpoint, a
    * retry, a skip, a debug command and an expression to evaluate go to the run it holds.
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
        Some("You do not have write access to the computing unit.")
      case start: WorkflowStartRequest =>
        startExecution(sender, workflow, user, start)
      case update: OperatorUpdateRequest =>
        applyUpdate(sender, run, user, update)
      case command =>
        val asked = command match {
          case named: ExecutionRequest => runOf(named, run).toRight(notRunningHere(named))
          case _                       => run.toRight("No execution of this workflow is running here.")
        }
        asked.map(_.wsInput.onNext(command, user.map(_.getUid))).left.toOption
    }
  }

  /** The run of the execution `request` names, when it is the run `held`. */
  private def runOf(
      request: ExecutionRequest,
      held: Option[WorkflowExecutionService]
  ): Option[WorkflowExecutionService] =
    held.filter(_.workflowContext.executionId.id == request.executionId)

  private def notRunningHere(request: ExecutionRequest): String =
    s"Execution ${request.executionId} is not running here."

  /**
    * Starts the execution `start` names, which the Dashboard service created, from the plan it
    * carries, on this socket's workflow and computing unit, for the socket's user
    * ([[WorkflowService.startExecution]]). Once started, the run reaches every session on the
    * workflow, as a run does.
    *
    * @return why the start is refused, if it is
    */
  private def startExecution(
      sender: SessionState,
      workflow: Option[WorkflowService],
      user: Option[User],
      start: WorkflowStartRequest
  ): Option[String] =
    try {
      logger.info(s"Asked to start execution ${start.executionId}.")
      val started = for {
        user <- user.toRight("A signed-in user is required to start an execution.")
        workflow <- workflow.toRight("This connection is not open on a workflow.")
        cuid <- sender.getComputingUnitId.toRight(
          "This connection is not open on a computing unit."
        )
        execution <- workflow.startExecution(start.executionId, start.plan, user, cuid)
      } yield execution
      started.left.toOption
    } catch {
      case NonFatal(failure) =>
        logger.error(s"Execution ${start.executionId} could not be started.", failure)
        Some(WorkflowService.notStarted(start.executionId))
    }

  /**
    * Applies the change to an operator that `update` carries, which the Dashboard service made to
    * run, to the run of its execution on this socket's workflow
    * ([[org.apache.texera.web.service.ExecutionReconfigurationService.applyUpdate]]), and answers
    * `sender` whether it applies.
    *
    * @return why the change is refused, if its execution has no run here
    */
  private def applyUpdate(
      sender: SessionState,
      run: Option[WorkflowExecutionService],
      user: Option[User],
      update: OperatorUpdateRequest
  ): Option[String] =
    runOf(update, run).flatMap(_.services) match {
      case Some(services) =>
        sender.send(
          services.reconfiguration.applyUpdate(update.update, user.map(_.getUid.intValue()))
        )
        None
      case None => Some(notRunningHere(update))
    }

  /**
    * The type of request `frame`, which binds to no request, says it is, when it says one that
    * reads as a type's name.
    */
  private def typeNamedBy(frame: String): Option[String] =
    Try(objectMapper.readTree(frame)).toOption
      .flatMap(Option(_))
      .flatMap(json => Option(json.get("type")))
      .filter(_.isTextual)
      .map(_.asText())
      .filter(_.matches("[A-Za-z][A-Za-z0-9]{0,63}"))
}
