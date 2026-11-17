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

import org.apache.texera.amber.core.storage.{
  ExecutionPlanStore,
  PlanRecord,
  UserWarehouse,
  VFSUriComponents,
  WarehouseReadGuard,
  WarehouseUnavailableException
}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlanCodec}
import org.apache.texera.common.config.{ApplicationConfig, StorageConfig}

import java.net.URI
import java.time.Instant
import scala.util.Try
import scala.util.control.NonFatal

/**
  * What a computing unit checks before it starts an execution the Dashboard service created: the
  * plan table a start request names ([[checkUri]]), and the plan row read from it
  * ([[checkRecord]]). Each check answers why the start is refused (Left), in words for the user
  * who asked to start it, or what the start goes on with (Right).
  *
  * The checks read nothing. [[checkUri]] runs before the unit opens any catalog, so that a URI
  * sent with a request cannot make the unit open a table of another execution, workflow or user;
  * [[checkRecord]] runs on the row the unit then read.
  */
object StoredExecutionStart {

  /** Why a start that names anything but an execution's plan table is refused. */
  val NotAPlan = "not an execution plan"

  /** `text`, the plan table a start request names, as a URI; refused unless it is one. */
  def planUriOf(text: String): Either[String, URI] =
    Option(text).flatMap(text => Try(new URI(text)).toOption).toRight(NotAPlan)

  /**
    * Checks the plan table a request to start execution `executionId` names, before anything is
    * read from it: it must be a plan table, as [[ExecutionPlanStore.planUri]] builds one, of that
    * execution; of the socket's workflow when the request came over a socket; and in the default
    * warehouse or in one of the user's own ([[UserWarehouse]]), which this deployment serves.
    *
    * @param socketWorkflowId the workflow of the socket the request came over; None for a request
    *                         that came another way, which starts the workflow the URI names
    * @param uid              the user who asks to start the execution
    * @return the URI's workflow, execution and warehouse, which [[checkRecord]] checks the plan
    *         row against
    */
  def checkUri(
      planUri: URI,
      executionId: Long,
      socketWorkflowId: Option[Long],
      uid: Int,
      warehousesEnabled: Boolean = StorageConfig.warehouseEnabled
  ): Either[String, VFSUriComponents] =
    ExecutionPlanStore.planTableOf(planUri).toRight(NotAPlan).flatMap { location =>
      val (workflowId, planExecutionId) = (location.workflowId.id, location.executionId.id)
      if (planExecutionId != executionId) {
        Left(s"the plan is execution $planExecutionId's, not $executionId's")
      } else if (socketWorkflowId.exists(_ != workflowId)) {
        Left(s"the plan belongs to workflow $workflowId, not to this one")
      } else if (location.warehouse.exists(!UserWarehouse.isOwnedBy(_, uid))) {
        Left("the plan is in another user's warehouse")
      } else if (location.warehouse.isDefined && !warehousesEnabled) {
        // Opened while the switch is off, the user's warehouse would be the shared one, where
        // the plan is not: refused instead of answered as a plan that is not there (#6930).
        Left(
          s"execution $executionId keeps its plan in warehouse '${location.warehouse.get}', and " +
            "per-user warehouses are disabled in this deployment"
        )
      } else {
        try {
          // What every read of a per-user warehouse passes, the cases above included.
          WarehouseReadGuard.assertReadable(planUri, warehousesEnabled)
          Right(location)
        } catch {
          case refused: WarehouseUnavailableException => Left(refused.getMessage)
        }
      }
    }

  /**
    * Checks the plan row `record`, read from the plan table at `location` (which [[checkUri]]
    * passed), before the execution is started from it, and reads the plan it holds. The row must
    * be made for user `uid` and for computing unit `cuid`; its plan must be one this unit reads,
    * of the workflow, execution and warehouse the table is of; the replay log it replays and the
    * one it writes must be where this unit keeps replay logs; and none of the links its
    * operators read their files through may have expired by `nowMs`.
    *
    * The plan is read only once the row was found to be one the user may start here.
    *
    * @param location      the plan table's workflow, execution and warehouse, as [[checkUri]]
    *                      gave them
    * @param uid           the user who asks to start the execution
    * @param cuid          the computing unit asked to start it: this one
    * @param nowMs         the time, in milliseconds since the epoch
    * @param replayLogRoot what executions' replay logs are resolved against on this unit; None
    *                      when it keeps none
    * @return the plan the row holds, with the context it runs under, which names no computing unit
    */
  def checkRecord(
      record: PlanRecord,
      location: VFSUriComponents,
      uid: Int,
      cuid: Int,
      nowMs: Long,
      replayLogRoot: Option[URI] = ApplicationConfig.faultToleranceLogRootFolder
  ): Either[String, ExecutionPlan] = {
    val executionId = location.executionId.id
    if (record.createdBy != uid) {
      Left(s"only the user who created execution $executionId may start it")
    } else if (record.computingUnitId != cuid) {
      Left(
        s"execution $executionId was created for computing unit ${record.computingUnitId}, " +
          s"not $cuid"
      )
    } else {
      planOf(record.body, executionId).flatMap { plan =>
        val context = plan.context
        if (
          context.workflowId != location.workflowId ||
          context.executionId != location.executionId ||
          context.warehouse != location.warehouse
        ) {
          Left("the plan's ids do not match its location")
        } else {
          misplacedReplayLog(plan, replayLogRoot)
            .orElse(
              plan.plan.operators.iterator
                .flatMap(_.inputs.files)
                .map(_.expiresAtMs)
                .minOption
                .filter(_ <= nowMs)
                .map { expiry =>
                  s"input links expired at ${Instant.ofEpochMilli(expiry)}; run the workflow again"
                }
            )
            .toLeft(plan)
        }
      }
    }
  }

  /**
    * Why `plan` may not replay, or write, a replay log it names, on a unit whose replay logs are
    * resolved against `root`. A plan's replay logs are opened by whatever their URIs name, so one
    * anywhere else would have the unit read or write a place it was not set up to.
    */
  private def misplacedReplayLog(plan: ExecutionPlan, root: Option[URI]): Option[String] = {
    val where = root match {
      case Some(_) => "outside where this computing unit keeps replay logs"
      case None    => "and this computing unit keeps no replay logs"
    }
    def misplaced(log: URI): Boolean = !root.exists(isBelow(_, log))
    plan.replay
      .map(_.logLocation)
      .filter(misplaced)
      .map(log => s"the plan replays the log at ${withoutSecrets(log)}, $where")
      .orElse(
        plan.replayLog
          .filter(misplaced)
          .map(log => s"the plan writes its replay log to ${withoutSecrets(log)}, $where")
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
    * `uri` without the parts that can carry a secret, for a log line or a refusal: its user
    * info, query and fragment. A socket's URI carries the user's access token in its query. A
    * URI that is not a hierarchical one, which may be a secret whole, is the empty URI.
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

  /** The plan `body` holds, or why it cannot be read. */
  private def planOf(body: String, executionId: Long): Either[String, ExecutionPlan] =
    try Right(PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(body)))
    catch {
      case refused: IllegalArgumentException => Left(refused.getMessage)
      case NonFatal(failure) =>
        Left(s"the stored plan of execution $executionId cannot be read: $failure")
    }
}
