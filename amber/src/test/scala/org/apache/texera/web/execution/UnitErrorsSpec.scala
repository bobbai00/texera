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

package org.apache.texera.web.execution

import com.google.protobuf.timestamp.Timestamp
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionConsoleStore,
  OperatorConsole
}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import javax.ws.rs.WebApplicationException
import javax.ws.rs.core.{MediaType, Response}

class UnitErrorsSpec extends AnyFlatSpec with Matchers {

  private val mapper = new UnitErrorMapper

  private def answer(e: RuntimeException): (Int, com.fasterxml.jackson.databind.JsonNode) = {
    val response = mapper.toResponse(e)
    response.getMediaType.toString shouldBe MediaType.APPLICATION_JSON
    (response.getStatus, objectMapper.readTree(objectMapper.writeValueAsString(response.getEntity)))
  }

  "the unit's error mapper" should "answer a refusal in the contract's shape and the engine's words" in {
    val (status, body) =
      answer(new WebApplicationException("no table e_1.avg", Response.Status.NOT_FOUND))
    status shouldBe 404
    // The contract's code is a string; Dropwizard's own mapper answers a number.
    body.get("code").isTextual shouldBe true
    body.get("code").asText shouldBe "not_found"
    body.get("message").asText shouldBe "no table e_1.avg"
  }

  it should "name every status a client can branch on" in {
    Seq(
      Response.Status.BAD_REQUEST -> "invalid",
      Response.Status.UNAUTHORIZED -> "unauthorized",
      Response.Status.FORBIDDEN -> "forbidden",
      Response.Status.NOT_FOUND -> "not_found",
      Response.Status.CONFLICT -> "conflict",
      Response.Status.INTERNAL_SERVER_ERROR -> "internal"
    ).foreach {
      case (status, code) =>
        val (got, body) = answer(new WebApplicationException("why", status))
        got shouldBe status.getStatusCode
        body.get("code").asText shouldBe code
    }
  }

  it should "still say something for a refusal without a message of its own" in {
    val (status, body) = answer(new WebApplicationException(Response.Status.NOT_FOUND))
    status shouldBe 404
    body.get("message").asText should not be empty
  }

  it should "keep what the refusal itself carried: a 401 still says how to authenticate" in {
    val challenge = Response
      .status(Response.Status.UNAUTHORIZED)
      .header("WWW-Authenticate", "Bearer realm=\"unit\"")
      .entity("Credentials are required to access this resource.")
      .build()
    val response = mapper.toResponse(new WebApplicationException(challenge))
    response.getStatus shouldBe 401
    response.getHeaderString("WWW-Authenticate") shouldBe "Bearer realm=\"unit\""
    val body = objectMapper.readTree(objectMapper.writeValueAsString(response.getEntity))
    body.get("code").asText shouldBe "unauthorized"
  }

  it should "leave an answer that is not an error as it is" in {
    val moved = Response.status(Response.Status.SEE_OTHER).header("Location", "/elsewhere").build()
    mapper.toResponse(new WebApplicationException(moved)) should be theSameInstanceAs moved
  }

  it should "answer an engine failure with the failure's words" in {
    val (status, body) = answer(new IllegalArgumentException("the table is corrupt"))
    status shouldBe 500
    body.get("code").asText shouldBe "internal"
    body.get("message").asText shouldBe "the table is corrupt"
  }

  it should "not lose an exception that has no message" in {
    val (status, body) = answer(new NullPointerException())
    status shouldBe 500
    body.get("message").asText should include("NullPointerException")
  }

  private def message(kind: ConsoleMessageType, title: String, details: String) =
    ConsoleMessage(
      workerId = "Worker:WF1-E1-udf-main-0",
      timestamp = Timestamp(1L, 0),
      msgType = kind,
      source = "udf:process_tuple:6",
      title = title,
      message = details
    )

  private def console(entries: (String, Seq[ConsoleMessage])*) =
    ExecutionConsoleStore(entries.map { case (op, ms) => op -> OperatorConsole(ms) }.toMap)

  "an operator's console" should "hold no error when it only printed" in {
    UnitApiResource.firstOperatorError(ExecutionConsoleStore()) shouldBe None
    UnitApiResource.firstOperatorError(
      console("udf" -> Seq(message(ConsoleMessageType.PRINT, "hello", "")))
    ) shouldBe None
  }

  it should "give up its error, wherever among the prints it is" in {
    val boom = message(ConsoleMessageType.ERROR, "ValueError: cursed", "Traceback ...")
    UnitApiResource.firstOperatorError(
      console(
        "quiet" -> Seq(message(ConsoleMessageType.PRINT, "hello", "")),
        "udf" -> Seq(message(ConsoleMessageType.PRINT, "before", ""), boom)
      )
    ) shouldBe Some(("udf", boom))
  }

  "an operator's error" should "become the run's fatal error, in its own words" in {
    val boom = message(ConsoleMessageType.ERROR, "ValueError: cursed", "Traceback ...")
    val fatal = UnitApiResource.fatalErrorOf("udf", boom)
    fatal.`type` shouldBe EXECUTION_FAILURE
    fatal.operatorId shouldBe "udf"
    fatal.workerId shouldBe boom.workerId
    fatal.message shouldBe "ValueError: cursed"
    fatal.details shouldBe "Traceback ..."
  }
}
