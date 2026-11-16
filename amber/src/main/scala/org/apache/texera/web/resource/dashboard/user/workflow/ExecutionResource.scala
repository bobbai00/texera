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
import org.apache.texera.web.model.http.request.execution.CreateExecutionRequest
import org.apache.texera.web.service.execution.ExecutionCreator

import javax.annotation.security.RolesAllowed
import javax.ws.rs.core.{Context, MediaType, Response, UriInfo}
import javax.ws.rs.{Consumes, POST, Path, Produces}

/**
  * Executions as the Dashboard service creates them, before any computing unit is involved.
  *
  * Registered only by the Dashboard. It shares its path with [[WorkflowExecutionsResource]],
  * which a computing unit registers too; Jersey merges the two, and none of their methods share a
  * path and a method.
  */
@Path("/executions")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class ExecutionResource {

  /** Creates the executions. A seam, so a spec can create them with fixtures of its own. */
  protected def creator: ExecutionCreator = ExecutionCreator

  /**
    * Creates an execution of a workflow, to run on a computing unit: checks the caller's rights,
    * compiles the workflow for them, records the execution and writes its plan to the lake (see
    * [[ExecutionCreator]]).
    *
    * @return 201 with `{eid, wid, computingUnitId, planUri}`; 400 with `{eid, operatorErrors,
    *         errors}` when the workflow does not compile, the execution then recorded as failed.
    *         A refused request is answered `{code, message}`: 400 when it is malformed or names a
    *         warehouse or a replay it may not, 403 without the right to read the workflow or to
    *         run workflows on the unit, 409 when the unit is terminated; 500 when the plan cannot
    *         be made or written for any other reason.
    */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def create(
      request: CreateExecutionRequest,
      @Auth user: SessionUser,
      @Context uriInfo: UriInfo
  ): Response =
    creator.create(request, user.getUser, uriInfo.getRequestUri) match {
      case Right(created) => Response.status(Response.Status.CREATED).entity(created).build()
      case Left(failed)   => Response.status(Response.Status.BAD_REQUEST).entity(failed).build()
    }
}
