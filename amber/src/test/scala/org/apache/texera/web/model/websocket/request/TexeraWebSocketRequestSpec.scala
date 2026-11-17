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

package org.apache.texera.web.model.websocket.request

import com.fasterxml.jackson.annotation.JsonSubTypes
import com.fasterxml.jackson.databind.exc.InvalidTypeIdException
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.web.model.websocket.request.python.{
  DebugCommandRequest,
  PythonExpressionEvaluateRequest
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

/**
  * Pins the client -> server half of the websocket wire contract.
  *
  * `WorkflowWebsocketResource.myOnMsg` deserializes every inbound frame with
  * `objectMapper.readValue(message, classOf[TexeraWebSocketRequest])`, so this spec
  * uses the very same `JSONUtils.objectMapper` (DefaultScalaModule + NoCtorDeserModule
  * + Include.NON_ABSENT). A fresh `new ObjectMapper()` would test fiction: without
  * DefaultScalaModule none of the Scala case classes below bind at all.
  *
  * Why the discriminator strings are asserted literally: `TexeraWebSocketRequest`
  * carries `@JsonTypeInfo(use = Id.NAME, include = As.PROPERTY, property = "type")`
  * and every `@JsonSubTypes.Type` entry omits `name =`, so Jackson's
  * `TypeNameIdResolver` falls back to the BARE SIMPLE CLASS NAME as the wire id.
  * The Angular client hard-codes those same strings; from
  * `frontend/src/app/workspace/types/workflow-websocket.interface.ts`:
  *
  *   "Each type definition MUST follow the following rules:
  *    in either TexeraWebsocketRequestTypeMap or TexeraWebsocketEventTypeMap
  *    add a map entry:
  *    1. key is the 'type' string, it must be the same as corresponding backend class name
  *    2. value is the payload this request/event needs"
  *
  * The keys of `TexeraWebsocketRequestTypeMap` there are
  * `HeartBeatRequest`, `OperatorUpdateRequest`, `ResultPaginationRequest`,
  * `RetryRequest`, `SkipTupleRequest`, `WorkflowStartRequest`, `WorkflowKillRequest`,
  * `WorkflowPauseRequest`, `WorkflowCheckpointRequest`, `WorkflowResumeRequest`,
  * `PythonExpressionEvaluateRequest` and `DebugCommandRequest`. Renaming a Scala class
  * in this package compiles cleanly on both sides and silently breaks the UI at
  * runtime -- that is the breakage this spec exists to catch.
  *
  * `ResultPaginationRequest`'s default arguments are the highest-value pin here and sit
  * on the live pagination path: the TS `PaginationRequest` declares `columnOffset?`,
  * `columnLimit?` and `columnSearch?` as OPTIONAL, so real frames omit them and the
  * server must fill in 0 / Int.MaxValue / None. Those defaults only materialize because
  * DefaultScalaModule calls the synthetic `$lessinit$greater$default$N` methods -- drop
  * that module and `columnLimit` binds to 0, so result pagination would silently return
  * zero columns for every request instead of failing loudly.
  */
class TexeraWebSocketRequestSpec extends AnyFlatSpec with Matchers {

  private def read(json: String): TexeraWebSocketRequest =
    objectMapper.readValue(json, classOf[TexeraWebSocketRequest])

  private def frame(typeId: String, fields: String): String =
    if (fields.isEmpty) s"""{"type":"$typeId"}""" else s"""{"type":"$typeId",$fields}"""

  // A start and a change, as the browser sends them once the Dashboard created the execution
  // and stored the change.
  private val startFields =
    """"executionId":345,"planUri":"vfs:///wh/user-1-7/wid/12/eid/345/plan""""
  private val updateFields = """"executionId":345,"updateId":"update-4f6c""""

  /**
    * (wire type id, extra JSON fields, expected concrete class). The payloads are
    * built from each subtype's own declared field names, so the table pins what the
    * *server* accepts; the expected class proves the id resolved to the right
    * subtype rather than to a same-shaped sibling.
    *
    * Note this is deliberately not a claim that every payload here matches what the
    * shipped Angular client sends. `SkipTupleRequest` is a known divergence — the
    * client sends `workers` (execute-workflow.service.ts) while the case class
    * declares `workerIds`, and the shared mapper never disables
    * FAIL_ON_UNKNOWN_PROPERTIES, so the real client frame would be rejected. That
    * is a production naming bug, not something to encode as an expectation here;
    * the feature is disabled anyway (ExecutionRuntimeService throws
    * "skipping tuple is temporarily disabled" before reading the field).
    */
  private val registeredRequests: List[(String, String, Class[_ <: TexeraWebSocketRequest])] =
    List(
      ("HeartBeatRequest", "", classOf[HeartBeatRequest]),
      (
        "ResultPaginationRequest",
        """"requestID":"req-1","operatorID":"op-2","pageIndex":3,"pageSize":25""",
        classOf[ResultPaginationRequest]
      ),
      ("RetryRequest", """"workers":["worker-1"]""", classOf[RetryRequest]),
      ("SkipTupleRequest", """"workerIds":["worker-1"]""", classOf[SkipTupleRequest]),
      ("WorkflowStartRequest", startFields, classOf[WorkflowStartRequest]),
      ("OperatorUpdateRequest", updateFields, classOf[OperatorUpdateRequest]),
      ("WorkflowKillRequest", "", classOf[WorkflowKillRequest]),
      ("WorkflowPauseRequest", "", classOf[WorkflowPauseRequest]),
      ("WorkflowResumeRequest", "", classOf[WorkflowResumeRequest]),
      ("WorkflowCheckpointRequest", "", classOf[WorkflowCheckpointRequest]),
      (
        "PythonExpressionEvaluateRequest",
        """"expression":"1 + 1","operatorId":"op-eval"""",
        classOf[PythonExpressionEvaluateRequest]
      ),
      (
        "DebugCommandRequest",
        """"operatorId":"op-dbg","workerId":"worker-dbg","cmd":"break 12"""",
        classOf[DebugCommandRequest]
      )
    )

  // The "type" strings the SERVER accepts, i.e. the backend registry. Spelled out
  // rather than derived so a rename shows up as a set diff instead of quietly
  // re-deriving.
  private val expectedTypeIds: Set[String] = Set(
    "HeartBeatRequest",
    "ResultPaginationRequest",
    "RetryRequest",
    "SkipTupleRequest",
    "WorkflowStartRequest",
    "OperatorUpdateRequest",
    "WorkflowKillRequest",
    "WorkflowPauseRequest",
    "WorkflowResumeRequest",
    "WorkflowCheckpointRequest",
    "PythonExpressionEvaluateRequest",
    "DebugCommandRequest"
  )

  "TexeraWebSocketRequest @JsonSubTypes" should
    "register exactly the wire type ids the server accepts" in {
    val subTypes = classOf[TexeraWebSocketRequest].getAnnotation(classOf[JsonSubTypes])
    subTypes should not be null
    subTypes.value().map(_.value().getSimpleName).toSet shouldBe expectedTypeIds
  }

  it should "leave every subtype unnamed so the wire id stays the simple class name" in {
    // Adding `name = "..."` to any entry would change that subtype's wire id without
    // touching the class name, which the Angular map keys on.
    val named = classOf[TexeraWebSocketRequest]
      .getAnnotation(classOf[JsonSubTypes])
      .value()
      .filter(_.name().nonEmpty)
      .map(t => s"${t.value().getSimpleName}=${t.name()}")
    named.toList shouldBe empty
  }

  "every registered request type" should "deserialize through the polymorphic base" in {
    registeredRequests.map(_._1).toSet shouldBe expectedTypeIds
    registeredRequests.foreach {
      case (typeId, fields, expected) =>
        withClue(s"""type id "$typeId": """) {
          read(frame(typeId, fields)).getClass shouldBe expected
        }
    }
  }

  "an unknown type id" should "be rejected instead of silently ignored" in {
    // A stale or typo'd client is a real path; it must fail loudly at the mapper
    // rather than bind to some same-shaped sibling. The id is deliberately one that
    // exists nowhere on either side, so the test cannot be misread as a claim about
    // any real type.
    val ex = intercept[InvalidTypeIdException](read("""{"type":"NoSuchWebSocketRequest"}"""))
    ex.getMessage should include("NoSuchWebSocketRequest")
  }

  "the ResultExportRequest id" should "not be accepted over the websocket" in {
    // The backend class of that name is an HTTP model (web/model/http/request/result/,
    // reached through WorkflowExecutionsResource.exportResultToDataset) and is not a
    // TexeraWebSocketRequest subtype. If result export is ever moved onto the socket,
    // this test is the reminder that the subtype has to be registered too.
    val ex = intercept[InvalidTypeIdException](read("""{"type":"ResultExportRequest"}"""))
    ex.getMessage should include("ResultExportRequest")
  }

  "a request to compile and run a workflow on the unit" should "not be accepted over the websocket" in {
    // A unit only starts executions the Dashboard service created, and only applies changes it
    // stored: a client that sends it a logical plan to run, or an operator to change, is refused
    // by the mapper, whatever the frame holds.
    Seq(
      "WorkflowExecuteRequest" -> (""""executionName":"exec","engineVersion":"v",""" +
        """"logicalPlan":{"operators":[],"links":[],"opsToViewResult":[],"opsToReuseResult":[]},""" +
        """"workflowSettings":{},"emailNotificationEnabled":false,"computingUnitId":3"""),
      "ModifyLogicRequest" -> """"operator":{"operatorType":"Limit","limit":7}"""
    ).foreach {
      case (typeId, fields) =>
        withClue(s"""type id "$typeId": """) {
          val ex = intercept[InvalidTypeIdException](read(frame(typeId, fields)))
          ex.getTypeId shouldBe typeId
        }
    }
  }

  "a frame with no type property" should "be rejected" in {
    val ex = intercept[InvalidTypeIdException](
      read("""{"requestID":"req-1","operatorID":"op-2","pageIndex":3,"pageSize":25}""")
    )
    // The exception type is the contract here; the message check stays deliberately
    // loose (just the property name) because Jackson's exact wording is version-specific.
    ex.getMessage should include("type")
  }

  "ResultPaginationRequest" should "fill in the three optional column fields when absent" in {
    // The TS PaginationRequest marks these optional, so most real frames omit them.
    val req = read(
      frame(
        "ResultPaginationRequest",
        """"requestID":"req-1","operatorID":"op-2","pageIndex":3,"pageSize":25"""
      )
    ).asInstanceOf[ResultPaginationRequest]
    req.requestID shouldBe "req-1"
    req.operatorID shouldBe "op-2"
    req.pageIndex shouldBe 3
    req.pageSize shouldBe 25
    req.columnOffset shouldBe 0
    req.columnLimit shouldBe Int.MaxValue
    req.columnSearch shouldBe None
  }

  it should "let explicit column values override the defaults" in {
    val req = read(
      frame(
        "ResultPaginationRequest",
        """"requestID":"req-9","operatorID":"op-8","pageIndex":2,"pageSize":50,""" +
          """"columnOffset":4,"columnLimit":6,"columnSearch":"city""""
      )
    ).asInstanceOf[ResultPaginationRequest]
    req.columnOffset shouldBe 4
    req.columnLimit shouldBe 6
    req.columnSearch shouldBe Some("city")
  }

  "WorkflowStartRequest" should "bind the execution and its plan table, and write them back the same" in {
    val req = read(frame("WorkflowStartRequest", startFields)).asInstanceOf[WorkflowStartRequest]
    req shouldBe WorkflowStartRequest(345L, "vfs:///wh/user-1-7/wid/12/eid/345/plan")
    // What the server writes is what it reads: the type id, then both fields.
    val written = objectMapper.readTree(objectMapper.writeValueAsString(req))
    written.get("type").asText() shouldBe "WorkflowStartRequest"
    written.get("executionId").asLong() shouldBe 345L
    written.get("planUri").asText() shouldBe "vfs:///wh/user-1-7/wid/12/eid/345/plan"
    read(objectMapper.writeValueAsString(req)) shouldBe req
  }

  it should "bind an execution id past the Int range" in {
    read(frame("WorkflowStartRequest", s""""executionId":${Int.MaxValue + 1L},"planUri":"p""""))
      .asInstanceOf[WorkflowStartRequest]
      .executionId shouldBe Int.MaxValue + 1L
  }

  it should "leave a missing plan table to the start's own check" in {
    // The endpoint refuses it as "not an execution plan"; the mapper only binds.
    read(frame("WorkflowStartRequest", """"executionId":345""")) shouldBe
      WorkflowStartRequest(345L, null)
  }

  "OperatorUpdateRequest" should "bind the execution and the change's id, and write them back the same" in {
    val req = read(frame("OperatorUpdateRequest", updateFields)).asInstanceOf[OperatorUpdateRequest]
    req shouldBe OperatorUpdateRequest(345L, "update-4f6c")
    val written = objectMapper.readTree(objectMapper.writeValueAsString(req))
    written.get("type").asText() shouldBe "OperatorUpdateRequest"
    written.get("executionId").asLong() shouldBe 345L
    written.get("updateId").asText() shouldBe "update-4f6c"
    read(objectMapper.writeValueAsString(req)) shouldBe req
  }

  "the python request payloads" should "bind each wire field to the matching parameter" in {
    // All values differ, so any transposition (or a renamed JSON property) fails.
    val evaluate = read(
      frame(
        "PythonExpressionEvaluateRequest",
        """"expression":"len(tuple_)","operatorId":"op-eval""""
      )
    ).asInstanceOf[PythonExpressionEvaluateRequest]
    evaluate.expression shouldBe "len(tuple_)"
    evaluate.operatorId shouldBe "op-eval"

    val debug = read(
      frame(
        "DebugCommandRequest",
        """"operatorId":"op-dbg","workerId":"worker-dbg","cmd":"break 12""""
      )
    ).asInstanceOf[DebugCommandRequest]
    debug.operatorId shouldBe "op-dbg"
    debug.workerId shouldBe "worker-dbg"
    debug.cmd shouldBe "break 12"
  }
}
