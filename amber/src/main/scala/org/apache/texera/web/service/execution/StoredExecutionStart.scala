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
  VFSUriComponents,
  WarehouseReadGuard,
  WarehouseUnavailableException
}
import org.apache.texera.amber.core.workflow.{ExecutionPlan, PhysicalPlanCodec}
import org.apache.texera.common.config.StorageConfig

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
    * warehouse or in one of the user's own (`user-<uid>-<digits>`), which this deployment serves.
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
      } else if (location.warehouse.exists(warehouse => !isOwnWarehouse(warehouse, uid))) {
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
    * of the workflow, execution and warehouse the table is of; and none of the links the plan
    * reads its inputs through may have expired by `nowMs`.
    *
    * The plan is read only once the row was found to be one the user may start here.
    *
    * @param location the plan table's workflow, execution and warehouse, as [[checkUri]] gave them
    * @param uid      the user who asks to start the execution
    * @param cuid     the computing unit asked to start it: this one
    * @param nowMs    the time, in milliseconds since the epoch
    * @return the plan the row holds, with the context it runs under, which names no computing unit
    */
  def checkRecord(
      record: PlanRecord,
      location: VFSUriComponents,
      uid: Int,
      cuid: Int,
      nowMs: Long
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
          plan.inputs.map(_.expiresAtMs).minOption.filter(_ <= nowMs) match {
            case Some(expiry) =>
              Left(
                s"input links expired at ${Instant.ofEpochMilli(expiry)}; run the workflow again"
              )
            case None => Right(plan)
          }
        }
      }
    }
  }

  /**
    * `uri` without the parts that can carry a secret, for a log line: its user info, query and
    * fragment. A socket's URI carries the user's access token in its query. A URI that is not a
    * hierarchical one, which may be a secret whole, is the empty URI.
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

  /** Whether `warehouse` is one of user `uid`'s own, as the Dashboard names them. */
  private def isOwnWarehouse(warehouse: String, uid: Int): Boolean =
    warehouse.matches(s"user-$uid-[0-9]+")

  /** The plan `body` holds, or why it cannot be read. */
  private def planOf(body: String, executionId: Long): Either[String, ExecutionPlan] =
    try Right(PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(body)))
    catch {
      case refused: IllegalArgumentException => Left(refused.getMessage)
      case NonFatal(failure) =>
        Left(s"the stored plan of execution $executionId cannot be read: $failure")
    }
}
