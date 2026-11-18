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
import com.twitter.util.{Await, Duration}
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.amber.core.storage.ConsoleMessageStore
import org.apache.texera.amber.core.virtualidentity.ActorVirtualIdentity
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessageType.COMMAND
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType,
  EvaluatePythonExpressionRequest,
  DebugCommandRequest => AmberDebugCommandRequest
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.{
  EvaluatedValueList,
  ExecutionConsoleStore,
  OperatorConsole
}
import org.apache.texera.amber.util.VirtualIdentityUtils
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.event.python.ConsoleUpdateEvent
import org.apache.texera.web.model.websocket.request.python.{
  DebugCommandRequest,
  PythonExpressionEvaluateRequest
}
import org.apache.texera.web.model.websocket.response.python.PythonExpressionEvaluateResponse
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.{SubscriptionManager, WebsocketInput}

import java.time.Instant
import scala.collection.mutable
import scala.util.control.NonFatal

/**
  * Utility object for processing console messages
  * This is extracted to allow for easier testing and reuse
  */
object ConsoleMessageProcessor {

  /**
    * Processes a console message for display, performing truncation if needed.
    *
    * @param consoleMessage The original console message to process
    * @param displayLength The maximum display length for the message title
    * @return The truncated console message
    */
  def processConsoleMessage(
      consoleMessage: ConsoleMessage,
      displayLength: Int
  ): ConsoleMessage = {
    // Truncate message title if it exceeds the display length
    val title = consoleMessage.title
    if (title.getBytes.length > displayLength) {
      val truncateIndicator = "..."
      val truncatedTitle = title
        .take(displayLength - truncateIndicator.length) + truncateIndicator
      consoleMessage.copy(title = truncatedTitle)
    } else {
      consoleMessage
    }
  }

  /**
    * Updates the console store by adding a console message to an operator's console.
    *
    * @param consoleStore The console store to update
    * @param opId The operator ID
    * @param processedMessage The processed console message
    * @param bufferSize The maximum number of messages to keep in the buffer
    * @return The updated console store
    */
  def addMessageToOperatorConsole(
      consoleStore: ExecutionConsoleStore,
      opId: String,
      processedMessage: ConsoleMessage,
      bufferSize: Int
  ): ExecutionConsoleStore = {
    val opInfo = consoleStore.operatorConsole.getOrElse(opId, OperatorConsole())

    val updatedOpInfo = if (opInfo.consoleMessages.size < bufferSize) {
      opInfo.addConsoleMessages(processedMessage)
    } else {
      opInfo.withConsoleMessages(opInfo.consoleMessages.tail :+ processedMessage)
    }

    consoleStore.addOperatorConsole(opId -> updatedOpInfo)
  }
}

object ExecutionConsoleService {

  /** Who a message of the computing unit's own is from, as a console shows it. */
  val ComputingUnitSource = "computing unit"

  /**
    * The operator an execution's one console table is registered under in
    * `operator_executions`, where a console table per operator used to be: no operator has
    * this id.
    */
  val AllOperators = "*"
}

/**
  * The consoles of one run: each message is shown to the sessions on the workflow, cut to the
  * display length, from memory, and handed whole to the run's record, which stores it in the
  * lake on its own thread.
  */
class ExecutionConsoleService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    wsInput: WebsocketInput,
    workflowContext: WorkflowContext
) extends SubscriptionManager
    with LazyLogging {

  registerCallbackOnPythonConsoleMessage()

  val bufferSize: Int = ApplicationConfig.operatorConsoleBufferSize
  val consoleMessageDisplayLength: Int = ApplicationConfig.consoleMessageDisplayLength

  // The run's record stores the console in one table of the execution. It is registered where
  // the clean-up of an execution's results looks for console tables. A run does not fail over
  // it: the console table of an execution that is not registered is left in the lake.
  try {
    WorkflowExecutionsResource.insertOperatorExecutions(
      workflowContext.executionId.id,
      ExecutionConsoleService.AllOperators,
      ConsoleMessageStore.consoleUri(
        workflowContext.workflowId,
        workflowContext.executionId,
        workflowContext.warehouse
      )
    )
  } catch {
    case NonFatal(failure) =>
      // A warning of one line, the stack trace at debug level.
      logger.warn(
        s"The console table of execution ${workflowContext.executionId.id} could not be " +
          s"registered for the clean-up of the execution's results: $failure"
      )
      logger.debug(
        s"Registering the console table of execution ${workflowContext.executionId.id} failed.",
        failure
      )
  }

  addSubscription(
    stateStore.consoleStore.registerDiffHandler((oldState, newState) => {
      val output = new mutable.ArrayBuffer[TexeraWebSocketEvent]()
      // For each operator, check if it has new python console message or breakpoint events
      newState.operatorConsole
        .foreach {
          case (opId, info) =>
            val oldConsole = oldState.operatorConsole.getOrElse(opId, new OperatorConsole())
            val diff = info.consoleMessages.diff(oldConsole.consoleMessages)
            output.append(ConsoleUpdateEvent(opId, diff))

            info.evaluateExprResults.keys
              .filterNot(oldConsole.evaluateExprResults.contains)
              .foreach { key =>
                output.append(
                  PythonExpressionEvaluateResponse(key, info.evaluateExprResults(key).values)
                )
              }
        }
      output
    })
  )

  protected def registerCallbackOnPythonConsoleMessage(): Unit = {
    addSubscription(
      client
        .registerCallback[ConsoleMessage]((evt: ConsoleMessage) => {
          stateStore.consoleStore.updateState { consoleStore =>
            val opId =
              VirtualIdentityUtils.getPhysicalOpId(
                ActorVirtualIdentity(evt.workerId)
              )
            addConsoleMessage(consoleStore, opId.logicalOpId.id, evt)
          }
        })
    )

  }

  /**
    * Adds a message of the computing unit's own to the console of operator `operatorId`: what the
    * unit did for the operator, and not one of its workers. It is shown, and kept, as a worker's
    * message is.
    */
  def addUnitMessage(
      operatorId: String,
      msgType: ConsoleMessageType,
      title: String,
      message: String = ""
  ): Unit =
    stateStore.consoleStore.updateState { consoleStore =>
      addConsoleMessage(
        consoleStore,
        operatorId,
        ConsoleMessage(
          workerId = "",
          timestamp = Timestamp(Instant.now),
          msgType = msgType,
          source = ExecutionConsoleService.ComputingUnitSource,
          title = title,
          message = message
        )
      )
    }

  /**
    * Processes a console message for display, performing truncation if needed.
    * This method uses the shared implementation in ConsoleMessageProcessor.
    *
    * @param consoleMessage The original console message to process
    * @return The truncated console message
    */
  def processConsoleMessage(consoleMessage: ConsoleMessage): ConsoleMessage = {
    // Do not truncate debugger messages
    if (consoleMessage.msgType == ConsoleMessageType.DEBUGGER) {
      return consoleMessage
    }
    ConsoleMessageProcessor.processConsoleMessage(consoleMessage, consoleMessageDisplayLength)
  }

  /**
    * Updates the console store by adding a console message to an operator's console.
    * This method uses the shared implementation in ConsoleMessageProcessor.
    *
    * @param consoleStore The console store to update
    * @param opId The operator ID
    * @param processedMessage The processed console message
    * @return The updated console store
    */
  def addMessageToOperatorConsole(
      consoleStore: ExecutionConsoleStore,
      opId: String,
      processedMessage: ConsoleMessage
  ): ExecutionConsoleStore = {
    ConsoleMessageProcessor.addMessageToOperatorConsole(
      consoleStore,
      opId,
      processedMessage,
      bufferSize
    )
  }

  private[this] def addConsoleMessage(
      consoleStore: ExecutionConsoleStore,
      opId: String,
      consoleMessage: ConsoleMessage
  ): ExecutionConsoleStore = {
    // The run's record keeps the message whole, and stores it at its next commit.
    stateStore.recorder.console(opId, consoleMessage)

    // Process the message (truncate if needed) and update store
    val truncatedMessage = processConsoleMessage(consoleMessage)
    addMessageToOperatorConsole(consoleStore, opId, truncatedMessage)
  }

  //Receive evaluate python expression
  addSubscription(wsInput.subscribe((req: PythonExpressionEvaluateRequest, uidOpt) => {
    val result = Await.result(
      client.coordinatorInterface.evaluatePythonExpression(
        EvaluatePythonExpressionRequest(req.expression, req.operatorId),
        ()
      ),
      Duration.fromSeconds(10)
    )
    stateStore.consoleStore.updateState(consoleStore => {
      val opInfo = consoleStore.operatorConsole.getOrElse(req.operatorId, OperatorConsole())
      consoleStore.addOperatorConsole(
        (
          req.operatorId,
          opInfo.addEvaluateExprResults((req.expression, EvaluatedValueList(result.values)))
        )
      )
    })

    // TODO: remove the following hack after fixing the frontend
    // currently frontend is not prepared for re-receiving the eval-expr messages
    // so we add it to the state and remove it from the state immediately
    stateStore.consoleStore.updateState(consoleStore => {
      val opInfo = consoleStore.operatorConsole.getOrElse(req.operatorId, OperatorConsole())
      consoleStore.addOperatorConsole((req.operatorId, opInfo.clearEvaluateExprResults))
    })
  }))

  //Receive debug command
  addSubscription(wsInput.subscribe((req: DebugCommandRequest, uidOpt) => {
    stateStore.consoleStore.updateState { consoleStore =>
      val newMessage = new ConsoleMessage(
        req.workerId,
        Timestamp(Instant.now),
        COMMAND,
        "USER-" + uidOpt.getOrElse("UNKNOWN"),
        req.cmd,
        ""
      )
      addConsoleMessage(consoleStore, req.operatorId, newMessage)
    }

    client.coordinatorInterface.debugCommand(AmberDebugCommandRequest(req.workerId, req.cmd), ())

  }))

}
