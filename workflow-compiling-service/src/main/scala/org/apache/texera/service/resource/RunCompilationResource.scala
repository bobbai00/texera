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

package org.apache.texera.service.resource

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import jakarta.annotation.security.RolesAllowed
import jakarta.ws.rs.core.{MediaType, Response}
import jakarta.ws.rs.{
  BadRequestException,
  Consumes,
  NotFoundException,
  POST,
  Path,
  Produces,
  WebApplicationException
}
import org.apache.texera.amber.core.storage.{FileResolver, RepositoryVersionResolver}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{WorkflowContext, WorkflowSettings}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{
  CompileFor,
  NoSuchOperator,
  PlanToRun,
  UpdateToRun,
  WorkflowCompilationFailed,
  WorkflowRefused
}
import org.apache.texera.service.resource.RunCompilationResource._

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{
  ArrayBlockingQueue,
  ExecutionException,
  ExecutorService,
  RejectedExecutionException,
  ThreadPoolExecutor,
  TimeUnit,
  TimeoutException
}
import scala.collection.immutable.ListMap
import scala.concurrent.duration.{DurationInt, FiniteDuration}

object RunCompilationResource {

  /**
    * How long a compile may take: what the Dashboard service waits for a plan, which is half of
    * the 120 seconds each deployment's route gives the create of an execution.
    */
  val CompileDeadline: FiniteDuration = 60.seconds

  /** How many compiles run at once, and how many more may wait for one to begin. */
  private val CompileThreads = 8
  private val CompilesWaiting = 32

  /** The pool the compiles share. Its queue is bounded: work is refused once it is full. */
  private lazy val compiles: ExecutorService = {
    val count = new AtomicInteger()
    val pool = new ThreadPoolExecutor(
      CompileThreads,
      CompileThreads,
      1,
      TimeUnit.MINUTES,
      new ArrayBlockingQueue[Runnable](CompilesWaiting),
      (task: Runnable) => {
        val thread = new Thread(task, s"run-compile-${count.incrementAndGet()}")
        thread.setDaemon(true)
        thread
      }
    )
    pool.allowCoreThreadTimeOut(true)
    pool
  }

  /**
    * The body of `POST /compile/run`: the run, the workflow and the target that
    * [[PlanToRun.make]] makes a plan from.
    *
    * @param executionId      the execution, whose id stamps every operator and names where each
    *                         output port is stored
    * @param warehouse        the warehouse the execution writes into; None for the shared one
    * @param settings         the run's settings, but for the output ports whose results are
    *                         stored: those are the compiler's to find, so any sent are ignored
    * @param targetOperatorId the operator the run executes up to: only it and the operators
    *                         upstream of it are compiled. None for the whole workflow.
    */
  case class RunCompileRequest(
      workflowId: Long,
      executionId: Long,
      warehouse: Option[String],
      settings: WorkflowSettings,
      logicalPlan: LogicalPlanPojo,
      targetOperatorId: Option[String]
  )

  /**
    * What `POST /compile/run` answers (200), as a [[PlanToRun.Made]] holds it: the plan before
    * its files are linked, and the workflow it was compiled from.
    */
  case class RunCompileResponse(plan: String, logicalPlan: String)

  /**
    * The body of `POST /compile/update`: the change that [[UpdateToRun.make]] makes into an
    * operator to run, with what it is made from.
    *
    * @param logicalPlan the workflow the execution's plan was compiled from
    * @param operator    the operator as the editor holds it once changed
    * @param running     the physical operators the execution's plan runs for that operator
    */
  case class UpdateCompileRequest(
      workflowId: Long,
      executionId: Long,
      updateId: String,
      logicalPlan: LogicalPlanPojo,
      operator: LogicalOp,
      running: List[UpdateToRun.RunningOperator]
  )

  /**
    * What `POST /compile/update` answers (200), as an [[UpdateToRun.Made]] holds it: the
    * operator made to run, as the text of a stored update, and the change as it was sent.
    */
  case class UpdateCompileResponse(update: String, operator: String)

  /**
    * The body of the 400 a workflow that does not compile is answered with: the `code` and
    * `message` of every refusal of this service, and beside them the operators' errors, each as
    * the editor's compile writes an operator's, by the operator's id, in the order
    * [[WorkflowCompilationFailed]] holds them in.
    */
  case class CompilationRefusal(
      code: Int,
      message: String,
      operatorErrors: Map[String, WorkflowFatalError]
  )
}

/**
  * The compiles a run needs, which the Dashboard service asks for with the token of the user the
  * run is for: the plan of an execution it creates ([[PlanToRun]]), and a change to an operator
  * of a paused one ([[UpdateToRun]]). Whatever a plan names is resolved here as that user may
  * read it.
  *
  * Nothing here takes one of the object store's keys: a plan says where each file its operators
  * read is kept, and the Dashboard service signs the links from that.
  *
  * A request that is refused is answered `{code, message}`: 400 when the workflow or the change
  * is not one a plan can be made of (with `operatorErrors` beside them when operators have
  * errors, [[CompilationRefusal]]), 404 for a change to an operator the workflow does not
  * have, 504 when a compile takes longer than its deadline, and 503 when too many wait.
  *
  * @param bindingsFor     what a run's plan is bound to, for a user
  * @param repositoriesFor pins the dataset and model versions a change names, for a user
  */
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
@RolesAllowed(Array("REGULAR", "ADMIN"))
@Path("/compile")
class RunCompilationResource(
    bindingsFor: Integer => CompileFor.Run,
    repositoriesFor: Integer => RepositoryVersionResolver,
    compiles: ExecutorService,
    compileDeadline: FiniteDuration
) extends LazyLogging {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() =
    this(
      PlanToRun.bindingsFor,
      FileResolver.repositoryVersionResolverForUser,
      RunCompilationResource.compiles,
      RunCompilationResource.CompileDeadline
    )

  /**
    * Makes the plan of a run, for the caller ([[PlanToRun.make]]), on the pool of compiles and
    * under the deadline ([[withinDeadline]]).
    */
  @POST
  @Path("/run")
  def compileRun(request: RunCompileRequest, @Auth user: SessionUser): Response = {
    if (request == null) throw new BadRequestException("The request has no body.")
    if (request.workflowId < 1) throw new BadRequestException("The request names no workflow.")
    if (request.executionId < 1) throw new BadRequestException("The request names no execution.")
    val settings = Option(request.settings).getOrElse {
      throw new BadRequestException("The request has no settings to run the workflow under.")
    }
    val run = new WorkflowContext(
      WorkflowIdentity(request.workflowId),
      ExecutionIdentity(request.executionId),
      settings,
      Option(request.warehouse).flatten
    )
    val uid = user.getUid
    try {
      val made = withinDeadline {
        PlanToRun.make(
          run,
          bindingsFor(uid),
          request.logicalPlan,
          Option(request.targetOperatorId).flatten
        )
      }
      Response.ok(RunCompileResponse(made.plan, made.logicalPlan)).build()
    } catch {
      case failed: WorkflowCompilationFailed =>
        logger.info(
          s"No plan for execution ${request.executionId}: the workflow does not compile. " +
            failed.getMessage
        )
        Response
          .status(Response.Status.BAD_REQUEST)
          .entity(
            CompilationRefusal(
              Response.Status.BAD_REQUEST.getStatusCode,
              failed.getMessage,
              ListMap.from(failed.operatorErrors.map {
                case (operator, error) => operator.id -> error
              })
            )
          )
          .build()
      case refused: WorkflowRefused => throw new BadRequestException(refused.getMessage)
    }
  }

  /**
    * Makes a change to an operator of a paused execution into the operator to run in its place,
    * for the caller, who created the execution ([[UpdateToRun.make]]), as [[compileRun]] makes a
    * plan.
    */
  @POST
  @Path("/update")
  def compileUpdate(request: UpdateCompileRequest, @Auth user: SessionUser): Response = {
    if (request == null) throw new BadRequestException("The request has no body.")
    val uid = user.getUid
    try {
      val made = withinDeadline {
        UpdateToRun.make(
          WorkflowIdentity(request.workflowId),
          ExecutionIdentity(request.executionId),
          request.updateId,
          request.logicalPlan,
          request.operator,
          Option(request.running).getOrElse(Nil),
          repositoriesFor(uid)
        )
      }
      Response.ok(UpdateCompileResponse(made.update, made.operator)).build()
    } catch {
      case missing: NoSuchOperator  => throw new NotFoundException(missing.getMessage)
      case refused: WorkflowRefused => throw new BadRequestException(refused.getMessage)
    }
  }

  /**
    * `compile`, run on a thread of the pool of compiles while the request's thread waits for it,
    * for no longer than the deadline. A compile reads what the workflow's operators name, such as
    * the files of its scans or the database of a SQL source, at addresses the request chose: a
    * source that does not answer holds one of the pool's threads, not the service's.
    *
    * @throws WebApplicationException 504 if the deadline passes, and the compile is then
    *                                 interrupted; 503 if as many compiles as the pool holds wait
    *                                 already
    */
  private def withinDeadline[T](compile: => T): T = {
    val compiling =
      try compiles.submit[T](() => compile)
      catch {
        case _: RejectedExecutionException =>
          throw new WebApplicationException(
            "Too many workflows are being compiled. Try again in a moment.",
            Response.Status.SERVICE_UNAVAILABLE
          )
      }
    try compiling.get(compileDeadline.toMillis, TimeUnit.MILLISECONDS)
    catch {
      case failed: ExecutionException => throw failed.getCause
      case _: TimeoutException =>
        compiling.cancel(true)
        throw new WebApplicationException(
          s"Compiling the workflow took longer than $compileDeadline.",
          Response.Status.GATEWAY_TIMEOUT
        )
      case interrupted: InterruptedException =>
        compiling.cancel(true)
        throw interrupted
    }
  }
}
