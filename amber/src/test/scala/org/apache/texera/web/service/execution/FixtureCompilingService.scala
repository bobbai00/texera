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

package org.apache.texera.web.service.execution

import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.common.compiler.{
  CompileFor,
  NoSuchOperator,
  PlanToRun,
  UpdateToRun,
  WorkflowCompilationFailed,
  WorkflowRefused
}
import org.apache.texera.web.service.execution.WorkflowCompilingService._

import scala.collection.immutable.ListMap
import scala.collection.mutable
import scala.concurrent.duration.FiniteDuration
import scala.util.control.NonFatal

object FixtureCompilingService {

  private val Scheme = "Bearer fixture-user-"

  /** The `Authorization` header a spec sends for user `uid`, which names the user to the fixture. */
  def authorizationOf(uid: Int): String = s"$Scheme$uid"

  /** The user `authorization` names, as [[authorizationOf]] wrote it. */
  def userOf(authorization: String): Integer =
    Integer.valueOf(authorization.stripPrefix(Scheme))
}

/**
  * Stands in, in specs, for the workflow compiling service: it compiles in this JVM what the
  * service compiles, with the code the service runs ([[PlanToRun]], [[UpdateToRun]]), for the
  * user the request's `Authorization` header names, and refuses as the service's answers read
  * ([[CompileRefused]] with the status the service answers). A failure that is no refusal is a
  * 500 of the service's, which says nothing of what failed.
  *
  * @param bindingsFor     what a plan is bound to, for a user: the fixtures', unless a spec
  *                        gives others
  * @param repositoriesFor pins the dataset and model versions a change names, for a user
  * @param reconfigure     builds the operator a change makes of an operator; the operator
  *                        itself, unless a spec gives another
  */
class FixtureCompilingService(
    bindingsFor: Integer => CompileFor.Run = _ => TestUtils.fixtureBindings,
    repositoriesFor: Integer => RepositoryVersionResolver = _ =>
      TestOperators.fixtureRepositoryResolver,
    reconfigure: UpdateToRun.Reconfigure = UpdateToRun.byTheOperator
) extends WorkflowCompilingService {

  /** Each plan asked for, with the `Authorization` header it was asked with. */
  val plansAsked: mutable.ListBuffer[(PlanRequest, String)] = mutable.ListBuffer.empty

  /** Each change asked for, likewise. */
  val updatesAsked: mutable.ListBuffer[(UpdateRequest, String)] = mutable.ListBuffer.empty

  override def planToRun(
      request: PlanRequest,
      authorization: String,
      deadline: FiniteDuration
  ): String =
    answering {
      plansAsked += ((request, authorization))
      PlanToRun.make(
        new WorkflowContext(
          WorkflowIdentity(request.workflowId),
          ExecutionIdentity(request.executionId),
          request.settings,
          request.warehouse
        ),
        bindingsFor(FixtureCompilingService.userOf(authorization)),
        objectMapper.treeToValue(request.logicalPlan, classOf[LogicalPlanPojo]),
        request.targetOperatorId
      )
    }

  override def updateToRun(
      request: UpdateRequest,
      authorization: String,
      deadline: FiniteDuration
  ): String =
    answering {
      updatesAsked += ((request, authorization))
      val workflow = objectMapper.treeToValue(request.logicalPlan, classOf[LogicalPlanPojo])
      val changed = objectMapper.treeToValue(request.operator, classOf[LogicalOp])
      val repositories = repositoriesFor(FixtureCompilingService.userOf(authorization))
      UpdateToRun.make(
        WorkflowIdentity(request.workflowId),
        ExecutionIdentity(request.executionId),
        workflow,
        changed,
        repositories,
        reconfigure
      )
    }

  /** What `compile` answers, or the refusal the service answers its failure with. */
  private def answering[T](compile: => T): T =
    try compile
    catch {
      case failed: WorkflowCompilationFailed =>
        throw new CompileRefused(
          400,
          failed.getMessage,
          ListMap.from(failed.operatorErrors.map { case (operator, error) => operator.id -> error })
        )
      case missing: NoSuchOperator  => throw new CompileRefused(404, missing.getMessage)
      case refused: WorkflowRefused => throw new CompileRefused(400, refused.getMessage)
      case NonFatal(_) =>
        throw new CompileRefused(500, "There was an error processing your request.")
    }
}
