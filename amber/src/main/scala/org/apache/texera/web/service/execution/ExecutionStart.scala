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

import org.apache.texera.amber.core.storage.UserWarehouse
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlanCodec}
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}

import java.net.URI
import java.time.Instant
import scala.util.Try
import scala.util.control.NonFatal

/**
  * What a computing unit checks of the plan it is asked to start an execution from, before it
  * starts it ([[check]]). The plan is all the request carries: the Dashboard service made it
  * when it created the execution and hands it over itself, and it names the execution it is of.
  * The checks read nothing, and answer why the start is refused (Left), in words for the user
  * the execution was created for, or the plan read (Right).
  */
object ExecutionStart {

  def ofAnotherWorkflow(workflowId: Long): String =
    s"The plan belongs to workflow $workflowId, not to this one."

  /**
    * Reads `plan`, the plan a request to start an execution carries, and checks it. It must be a
    * plan this unit reads, which names its execution and its workflow; writing into the default
    * warehouse or one of the user's own ([[UserWarehouse]]), which this deployment serves;
    * replaying and writing replay logs only where this unit keeps them; and with none of the
    * links its operators read files through expired by `nowMs`.
    *
    * @param uid           the user who asks to start the execution
    * @param replayLogRoot what executions' replay logs are resolved against on this unit; None
    *                      when it keeps none
    * @return the plan, with the context it runs under, which names the execution and no
    *         computing unit
    */
  def check(
      plan: String,
      uid: Int,
      nowMs: Long,
      warehousesEnabled: Boolean = StorageConfig.warehouseEnabled,
      replayLogRoot: Option[URI] = ApplicationConfig.faultToleranceLogRootFolder
  ): Either[String, ExecutionPlan] =
    planOf(plan).flatMap { executionPlan =>
      val context = executionPlan.context
      val warehouse = context.warehouse
      if (warehouse.exists(!UserWarehouse.isOwnedBy(_, uid))) {
        Left("The plan writes into another user's warehouse.")
      } else if (warehouse.isDefined && !warehousesEnabled) {
        // Opened while the switch is off, the user's warehouse would be the shared one (#6930).
        Left(
          s"Execution ${context.executionId.id} writes into warehouse '${warehouse.get}', and " +
            "per-user warehouses are disabled in this deployment."
        )
      } else {
        misplacedReplayLog(executionPlan, replayLogRoot)
          .orElse(expiredLinks(executionPlan, nowMs))
          .toLeft(executionPlan)
      }
    }

  /**
    * The execution that `plan`, the text a request to start one carries, names, when the text
    * reads as a plan's and names one. Nothing of the plan is checked: this says which execution
    * a start that was not done was of, in the answer to it.
    */
  def executionNamedBy(plan: String): Option[Long] =
    Option(plan)
      .flatMap(text => Try(PhysicalPlanCodec.fromJson(text)).toOption)
      .flatMap(_.executionId)
      .map(_.id)

  /** Why `plan` cannot be started for the links it reads files through, expired by `nowMs`. */
  private def expiredLinks(plan: ExecutionPlan, nowMs: Long): Option[String] =
    plan.plan.operators.iterator
      .flatMap(_.inputs.files)
      .map(_.expiresAtMs)
      .minOption
      .filter(_ <= nowMs)
      .map { expiry =>
        s"The plan's input links expired at ${Instant.ofEpochMilli(expiry)}. Run the workflow again."
      }

  /**
    * Why `plan` may not replay, or write, a replay log it names, on a unit whose replay logs are
    * resolved against `root`. A plan's replay logs are opened by whatever their URIs name, so one
    * anywhere else would have the unit read or write a place it was not set up to.
    */
  private def misplacedReplayLog(plan: ExecutionPlan, root: Option[URI]): Option[String] = {
    val where = root match {
      case Some(_) => "outside where this computing unit keeps replay logs."
      case None    => "and this computing unit keeps no replay logs."
    }
    def misplaced(log: URI): Boolean = !root.exists(isBelow(_, log))
    plan.replay
      .map(_.logLocation)
      .filter(misplaced)
      .map(log => s"The plan replays the log at ${withoutSecrets(log)}, $where")
      .orElse(
        plan.replayLog
          .filter(misplaced)
          .map(log => s"The plan writes its replay log to ${withoutSecrets(log)}, $where")
      )
  }

  /**
    * Whether `location` is in the directory that locations are resolved against `root` in, as
    * the Dashboard resolves an execution's replay log (`<wid>/<eid>/`), or below it: the same
    * scheme and authority, a path under that directory with no step out of it, and nothing more.
    */
  private def isBelow(root: URI, location: URI): Boolean = {
    val directory = root.resolve(".").normalize()
    val normal = location.normalize()
    Option(directory.getScheme).exists(_.equalsIgnoreCase(normal.getScheme)) &&
    directory.getAuthority == normal.getAuthority &&
    normal.getQuery == null && normal.getFragment == null &&
    Option(normal.getPath).exists { path =>
      Option(directory.getPath).exists(path.startsWith) && !path.split('/').contains("..")
    }
  }

  /**
    * `uri` without the parts that can carry a secret, for a refusal: its user info, query and
    * fragment. A URI that is not a hierarchical one, which may be a secret whole, is the empty
    * URI.
    */
  def withoutSecrets(uri: URI): URI =
    Option(uri)
      .flatMap { uri =>
        Try {
          if (uri.getHost != null) {
            new URI(uri.getScheme, null, uri.getHost, uri.getPort, uri.getPath, null, null)
          } else {
            // No host: a relative URI, or an authority that names none, whose user info, if it
            // holds any, ends at its last '@'.
            val authority =
              Option(uri.getAuthority).map(authority =>
                authority.drop(authority.lastIndexOf('@') + 1)
              )
            new URI(uri.getScheme, authority.orNull, uri.getPath, null, null)
          }
        }.toOption
      }
      .getOrElse(new URI(null, null, null, null, null))

  /** The plan `text` holds, or why it cannot be read. */
  private def planOf(text: String): Either[String, ExecutionPlan] =
    Option(text).filterNot(_.isBlank).toRight("The request carries no plan.").flatMap { text =>
      try Right(PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(text)))
      catch {
        case refused: IllegalArgumentException => Left(refused.getMessage)
        case NonFatal(failure) =>
          Left("The plan cannot be read" + Option(failure.getMessage).fold(".")(why => s": $why"))
      }
    }
}
