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
import org.apache.texera.amber.core.storage.CatalogIdentity
import org.apache.texera.amber.core.virtualidentity.WorkflowIdentity
import org.apache.texera.amber.core.workflow.PhysicalPlanCodec
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.web.service.execution.ExecutionStart
import org.apache.texera.web.service.{WorkflowExecutionService, WorkflowService}

import javax.ws.rs.core.{Context, HttpHeaders, MediaType, Response}
import javax.ws.rs.{Consumes, POST, Path, Produces}
import scala.util.Try
import scala.util.control.NonFatal

/**
  * The body of `POST /api/execution/start`: start an execution the Dashboard service created.
  *
  * @param plan            the execution's plan, as the Dashboard service made it: it names the
  *                        execution and its workflow
  * @param computingUnitId the computing unit the execution was created for: this one
  * @param catalogToken    the execution's token for the lake's catalog, which every catalog
  *                        request about the execution carries; null where the lake takes none
  */
case class StartExecutionRequest(plan: String, computingUnitId: Int, catalogToken: String) {

  // Printed with neither its plan, which links to the execution's inputs, nor its token.
  override def toString: String =
    s"StartExecutionRequest(<plan>, $computingUnitId, " +
      s"${if (catalogToken == null) "null" else "<hidden>"})"
}

/**
  * The body of `POST /api/execution/update`: apply, when the paused run of an execution resumes,
  * a change to one of its operators.
  *
  * @param update the change, as the Dashboard service made it to run: it names the execution
  */
case class ApplyUpdateRequest(update: String)

/** Why a computing unit does not do what it was handed: the body of its 409. */
case class HandoverRefusal(message: String)

/**
  * What the Dashboard service hands a computing unit: the start of an execution, from its plan,
  * with the execution's token for the lake, and a change to an operator of a paused one. Each
  * names the user it is for ([[UnitCaller]]). No client reaches these routes: a deployment
  * routes only the unit's websocket to it.
  *
  * What is handed over and done is answered 204; what is refused, 409 with why
  * ([[HandoverRefusal]]), and nothing is written for it. A request that names no user is
  * answered 401.
  *
  * @param workflowServiceOf the service of a workflow's runs on this unit, for a computing unit:
  *                          the one the workflow's sessions share
  * @param holding           the run of an execution, with the service of its workflow, when this
  *                          unit holds it
  * @param tokenRequired     whether a start must carry its execution's token for the lake: so
  *                          on a REST catalog, which answers no request without one
  */
@Path("/execution")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class ExecutionHandoverResource(
    workflowServiceOf: (WorkflowIdentity, Int) => WorkflowService,
    holding: Long => Option[(WorkflowService, WorkflowExecutionService)],
    tokenRequired: Boolean = StorageConfig.icebergCatalogType == "rest"
) extends LazyLogging {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() = this(WorkflowService.getOrCreate(_, _), WorkflowService.holding)

  /**
    * Starts the execution the request's plan names, for the caller, on the service of the
    * plan's workflow: every session on that workflow sees the run. The execution starts once,
    * however often it is handed over.
    *
    * The start is checked ([[WorkflowService.checkStart]]) before the workflow's service is
    * asked for, so a start its checks refuse leaves no service behind. Then the token it carries
    * is held for its execution (`holdToken`), and it is started on that service
    * ([[WorkflowService.startChecked]]).
    *
    * @return 204 once the start is taken, also for a run that then fails: its failure is the
    *         run's, recorded and shown to its sessions. Otherwise 409 with why.
    */
  @POST
  @Path("/start")
  def start(request: StartExecutionRequest, @Context headers: HttpHeaders): Response = {
    val user = UnitCaller.required(headers)
    logger.info("Asked to start an execution from its plan.")
    val started =
      try {
        for {
          asked <- Option(request).toRight("The request has no body.")
          checked <- WorkflowService.checkStart(asked.plan, user, asked.computingUnitId)
          _ <- holdToken(checked.executionId, asked.catalogToken)
          run <- workflowServiceOf(checked.workflowId, asked.computingUnitId).startChecked(checked)
        } yield run
      } catch {
        case NonFatal(failure) =>
          val notStarted = WorkflowService.notStarted(
            Option(request).flatMap(asked => ExecutionStart.executionNamedBy(asked.plan))
          )
          logger.error(notStarted, failure)
          Left(notStarted)
      }
    answer("start an execution", started)
  }

  /**
    * Holds `token`, the token a start of execution `eid` carries, in this JVM: every catalog
    * request about the execution made here carries it, and the execution's workers are handed
    * it ([[CatalogIdentity]]). An execution keeps the token it was first started with: a later
    * start of it, which the unit refuses as already started, changes nothing. A start that
    * carries none is refused where a token is required.
    */
  private def holdToken(eid: Long, token: String): Either[String, Unit] =
    Option(token).filterNot(_.isBlank) match {
      case Some(held) =>
        if (CatalogIdentity.registered(eid).isEmpty) CatalogIdentity.register(eid, held)
        Right(())
      case None if tokenRequired => Left("The start carries no token for the lake.")
      case None                  => Right(())
    }

  /**
    * Queues the change the request carries for the run of the execution it names, which applies
    * it when it resumes
    * ([[org.apache.texera.web.service.ExecutionReconfigurationService.applyUpdate]]). Only the
    * user who started the execution may change its operators.
    *
    * @return 204 once the change is queued. Otherwise 409 with why: the change cannot be read,
    *         this unit holds no run of its execution, or the run does not take it.
    */
  @POST
  @Path("/update")
  def update(request: ApplyUpdateRequest, @Context headers: HttpHeaders): Response = {
    val user = UnitCaller.required(headers)
    val queued = for {
      change <- Option(request)
        .flatMap(asked => Option(asked.update))
        .filterNot(_.isBlank)
        .toRight("The request carries no change to apply.")
      eid <- executionChangedBy(change).toRight("The change cannot be read.")
      services <-
        holding(eid).flatMap(_._2.services).toRight(s"Execution $eid is not running here.")
      operator <- services.reconfiguration.applyUpdate(change, Some(user.getUid.intValue()))
    } yield operator
    answer("change an operator", queued)
  }

  /** The execution `update`, a change as the Dashboard service made it, names. */
  private def executionChangedBy(update: String): Option[Long] =
    Try(PhysicalPlanCodec.updateFromJson(update)).toOption.flatMap(_.executionId).map(_.id)

  private def answer(asked: String, done: Either[String, _]): Response =
    done match {
      case Left(why) =>
        logger.info(s"Refused to $asked: $why")
        Response.status(Response.Status.CONFLICT).entity(HandoverRefusal(why)).build()
      case Right(_) => Response.noContent().build()
    }
}
