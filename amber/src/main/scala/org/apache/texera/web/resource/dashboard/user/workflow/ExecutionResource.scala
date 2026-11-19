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

package org.apache.texera.web.resource.dashboard.user.workflow

import io.dropwizard.auth.Auth
import org.apache.texera.auth.SessionUser
import org.apache.texera.web.model.http.request.execution.{
  CreateExecutionRequest,
  OperatorUpdateRequestBody
}
import org.apache.texera.web.model.http.response.execution.{
  CreateExecutionFailure,
  ExecutionConsoleResponse,
  ExecutionLogResponse,
  ExecutionStateResponse
}
import org.apache.texera.web.service.execution.{
  ExecutionCreator,
  ExecutionRecordReader,
  OperatorUpdates,
  WorkflowNotCompiled
}

import javax.annotation.security.RolesAllowed
import javax.ws.rs.core.{Context, HttpHeaders, MediaType, Response, UriInfo}
import javax.ws.rs.{
  Consumes,
  DefaultValue,
  GET,
  HeaderParam,
  POST,
  Path,
  PathParam,
  Produces,
  QueryParam
}

object ExecutionResource {

  // Jersey makes a resource for each request; these are the service's, shared by them all.
  private lazy val creator = new ExecutionCreator()
  private lazy val updates = new OperatorUpdates()
  private lazy val records = new ExecutionRecordReader()
}

/**
  * Executions as the Dashboard service creates them, before any computing unit is involved, the
  * changes made to their operators while they are paused, and what each one recorded: its
  * state, its log and its console output, which are answered whether or not its computing unit
  * is still there.
  *
  * Registered only by the Dashboard, as is [[WorkflowExecutionsResource]], whose path it
  * shares; Jersey merges the two, and none of their methods share a path and a method. The
  * first path segment after `/executions` is a workflow's id in that resource's routes and an
  * execution's id in this one's, whose last segments (`updates`, `state`, `log`, `console`) are
  * none of that resource's.
  *
  * A request that is not served is answered `{code, message}`, whatever its status.
  */
@Path("/executions")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class ExecutionResource(
    creator: ExecutionCreator,
    updates: OperatorUpdates,
    records: ExecutionRecordReader = new ExecutionRecordReader()
) {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() =
    this(ExecutionResource.creator, ExecutionResource.updates, ExecutionResource.records)

  /**
    * Creates an execution of a workflow, to run on a computing unit (see [[ExecutionCreator]]).
    *
    * @return 201 with `{eid, plan}`. Otherwise 400 when the request is malformed or names a
    *         warehouse or a replay it may not; 400 when the workflow is not one the compiler can
    *         read, and 400 with `eid` and `operatorErrors` beside the code and the message when
    *         it does not compile ([[CreateExecutionFailure]]), the execution recorded as failed
    *         in both; 403 without the right to read the workflow or to run workflows on the
    *         unit; 409 when the unit is terminated; 504 when the compile takes longer than its
    *         deadline and 503 when too many compiles wait or the compiling service cannot be
    *         reached; 400 when the plan is larger than a computing unit takes; 500 when the plan
    *         cannot be made for any other reason.
    */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def create(
      request: CreateExecutionRequest,
      @Auth user: SessionUser,
      @Context uriInfo: UriInfo,
      @HeaderParam(HttpHeaders.AUTHORIZATION) authorization: String
  ): Response =
    try {
      val created = creator.create(request, user.getUser, uriInfo.getRequestUri, authorization)
      Response.status(Response.Status.CREATED).entity(created).build()
    } catch {
      case failed: WorkflowNotCompiled =>
        val status = failed.getResponse.getStatus
        Response
          .status(status)
          .entity(
            CreateExecutionFailure(status, failed.getMessage, failed.eid, failed.operatorErrors)
          )
          .build()
    }

  /**
    * Makes a change to an operator of paused execution `eid` to run, for the client to hand to
    * the execution's computing unit, which applies it when the run resumes (see
    * [[OperatorUpdates]]).
    *
    * @return 201 with `{operatorId, update}`. Otherwise 400 when the request names no operator,
    *         holds no workflow the compiler reads, or asks for a change the operator cannot take
    *         while it runs or that is larger than a computing unit takes; 403 unless
    *         the caller created the execution and may still read its workflow and run workflows
    *         on its unit; 404 for an execution, or an operator in the workflow sent, there is
    *         not; 409 when the execution has ended; 504 when the compiling service does not
    *         answer by its deadline and 503 when it cannot be reached; 500 when the change cannot
    *         be made.
    */
  @POST
  @Path("/{eid}/updates")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def postUpdate(
      @PathParam("eid") eid: Long,
      request: OperatorUpdateRequestBody,
      @Auth user: SessionUser,
      @HeaderParam(HttpHeaders.AUTHORIZATION) authorization: String
  ): Response =
    Response
      .status(Response.Status.CREATED)
      .entity(updates.make(eid, request, user.getUser, authorization))
      .build()

  /**
    * The state of execution `eid` (see [[ExecutionRecordReader.state]]).
    *
    * @return 200 with an [[ExecutionStateResponse]]. Otherwise 403 unless the caller created the
    *         execution, or owns or was granted its workflow, also for an execution there is not.
    */
  @GET
  @Path("/{eid}/state")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def getState(@PathParam("eid") eid: Long, @Auth user: SessionUser): ExecutionStateResponse =
    records.state(eid, user.getUser)

  /**
    * The log of execution `eid`, the changes of its run's state as its engine recorded them,
    * and its closing record (see [[ExecutionRecordReader.log]]).
    *
    * @return 200 with an [[ExecutionLogResponse]]. Otherwise 403 as for the state; 409 when the
    *         log is in a warehouse this deployment cannot reach; 500 when the lake cannot be read.
    */
  @GET
  @Path("/{eid}/log")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def getLog(@PathParam("eid") eid: Long, @Auth user: SessionUser): ExecutionLogResponse =
    records.log(eid, user.getUser)

  /**
    * A page of the console output execution `eid` stored: the first `limit` messages after
    * message `afterSeq`, oldest first, of operator `operatorId` or, with none named, of all
    * operators (see [[ExecutionRecordReader.console]]). The next page is asked for with the
    * `lastSeq` of this one as its `afterSeq`.
    *
    * @return 200 with an [[ExecutionConsoleResponse]]; a page holds at most 5,000 messages,
    *         whatever `limit` asks for. Otherwise 400 for a negative `limit`; 403 as for the
    *         state; 409 when the console output is in a warehouse this deployment cannot reach;
    *         500 when the lake cannot be read.
    */
  @GET
  @Path("/{eid}/console")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def getConsole(
      @PathParam("eid") eid: Long,
      @QueryParam("operatorId") operatorId: String,
      @QueryParam("afterSeq") @DefaultValue("0") afterSeq: Long,
      @QueryParam("limit") @DefaultValue("1000") limit: Int,
      @Auth user: SessionUser
  ): ExecutionConsoleResponse =
    records.console(eid, user.getUser, Option(operatorId).filter(_.nonEmpty), afterSeq, limit)
}
