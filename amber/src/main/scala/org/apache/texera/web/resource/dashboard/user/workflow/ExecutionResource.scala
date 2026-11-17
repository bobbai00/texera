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
import org.apache.texera.web.model.http.response.execution.CreateExecutionFailure
import org.apache.texera.web.service.execution.{
  ExecutionCreator,
  OperatorUpdates,
  WorkflowNotCompiled
}

import javax.annotation.security.RolesAllowed
import javax.ws.rs.core.{Context, MediaType, Response, UriInfo}
import javax.ws.rs.{Consumes, POST, Path, PathParam, Produces}

object ExecutionResource {

  // Jersey makes a resource for each request; these are the service's, shared by them all.
  private lazy val creator = new ExecutionCreator()
  private lazy val updates = new OperatorUpdates()
}

/**
  * Executions as the Dashboard service creates them, before any computing unit is involved, and
  * the changes made to their operators while they are paused.
  *
  * Registered only by the Dashboard. It shares its path with [[WorkflowExecutionsResource]],
  * which a computing unit registers too; Jersey merges the two, and none of their methods share a
  * path and a method. The first path segment after `/executions` is a workflow's id in that
  * resource's routes and an execution's id in this one's.
  *
  * A request that is not served is answered `{code, message}`, whatever its status.
  *
  * @param creator creates the executions
  * @param updates stores the changes to paused operators
  */
@Path("/executions")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class ExecutionResource(creator: ExecutionCreator, updates: OperatorUpdates) {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() = this(ExecutionResource.creator, ExecutionResource.updates)

  /**
    * Creates an execution of a workflow, to run on a computing unit: checks the caller's rights,
    * compiles the workflow for them, records the execution and writes its plan to the lake (see
    * [[ExecutionCreator]]).
    *
    * @return 201 with `{eid, planUri}`. Otherwise 400 when the request is malformed or names a
    *         warehouse or a replay it may not, and 400 with `eid` and `operatorErrors` beside
    *         the code and the message when the workflow does not compile, the execution then
    *         recorded as failed ([[CreateExecutionFailure]]); 403 without the right to read the
    *         workflow or to run workflows on the unit; 409 when the unit is terminated; 504 when
    *         the compile takes longer than its deadline and 503 when too many compiles wait; 500
    *         when the plan cannot be made or written for any other reason.
    */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def create(
      request: CreateExecutionRequest,
      @Auth user: SessionUser,
      @Context uriInfo: UriInfo
  ): Response =
    try {
      val created = creator.create(request, user.getUser, uriInfo.getRequestUri)
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
    * Stores a change to an operator of paused execution `eid`, made to run for the user who
    * created the execution, for its computing unit to apply when the run resumes (see
    * [[OperatorUpdates]]).
    *
    * @return 201 with `{updateId, operatorId}`. Otherwise 400 when the request names no operator
    *         or the running operator cannot take the change; 403 unless the caller created the
    *         execution and may still read its workflow and run workflows on its unit; 404 for an
    *         execution, a stored plan or an operator there is not; 409 when the execution has
    *         ended or its plan is in a per-user warehouse while those are disabled; 500 when the
    *         plan cannot be read, was made for another user or unit, or the change cannot be
    *         stored.
    */
  @POST
  @Path("/{eid}/updates")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def postUpdate(
      @PathParam("eid") eid: Long,
      request: OperatorUpdateRequestBody,
      @Auth user: SessionUser
  ): Response =
    Response
      .status(Response.Status.CREATED)
      .entity(updates.store(eid, request, user.getUser))
      .build()
}
