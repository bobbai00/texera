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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.{ExecutionLabel, ExecutionLogEntry, ExecutionLogStore}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.http.response.execution.{
  ExecutionClosingResponse,
  ExecutionLogEntryResponse,
  ExecutionLogResponse,
  ExecutionStateResponse
}

import java.net.URI
import javax.ws.rs.core.Response
import javax.ws.rs.{ForbiddenException, InternalServerErrorException, WebApplicationException}
import scala.util.control.NonFatal

/**
  * Reads what one execution recorded, for a user: what `GET /api/executions/{eid}/state` and
  * `GET /api/executions/{eid}/log` on the Dashboard service answer. A closed execution's state
  * is its closing record; an open one's is the label of its log in the lake. No computing unit
  * is asked, so both answer for a run whose unit is gone.
  *
  * The caller must have created the execution, or own or have been granted its workflow
  * ([[ExecutionRecords.mayRead]]). Otherwise, and for an execution there is not, the answer is
  * 403, so execution ids cannot be probed.
  *
  * @param label             reads the label of the log at a URI; None when there is no log
  * @param rows              reads the rows of the log at a URI
  * @param warehousesEnabled whether runs write into per-user warehouses
  */
class ExecutionRecordReader(
    label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
    rows: URI => Seq[ExecutionLogEntry] = ExecutionLogStore.read,
    warehousesEnabled: Boolean = StorageConfig.warehouseEnabled
) extends LazyLogging {

  /**
    * The state of execution `eid`, for `user` (see [[ExecutionStateResponse]]). An open
    * execution whose log cannot be read, because the lake does not answer or its warehouse
    * cannot be reached, has status -1: that is not known to be any state.
    *
    * @throws ForbiddenException (403) unless `user` may read the execution
    */
  def state(eid: Long, user: User): ExecutionStateResponse = {
    val execution = readable(eid, user)
    execution.closing match {
      case Some(closing) =>
        ExecutionStateResponse(
          eid,
          closing.outcome,
          open = false,
          closing.reason,
          closing.endedAtMs
        )
      case None =>
        val unread =
          ExecutionStateResponse(
            eid,
            WorkflowExecutionStatus.Unknown,
            open = true,
            None,
            execution.startingTimeMs
          )
        if (unavailable(execution)) unread
        else
          try {
            val found = label(execution.logUri)
            ExecutionStateResponse(
              eid,
              ExecutionStatus.ofOpen(found),
              open = true,
              found.flatMap(_.reason),
              // A state's time is from the unit's clock: never before the execution was made.
              found
                .filter(_.state.nonEmpty)
                .fold(execution.startingTimeMs)(shown =>
                  math.max(shown.stateTimeMs, execution.startingTimeMs)
                )
            )
          } catch {
            case NonFatal(failure) =>
              logger.warn(s"The log of execution $eid could not be read: $failure")
              unread
          }
    }
  }

  /**
    * The log of execution `eid` and its closing record, for `user` (see
    * [[ExecutionLogResponse]]).
    *
    * @throws ForbiddenException           (403) unless `user` may read the execution
    * @throws WebApplicationException      (409) if the log is in a warehouse this deployment
    *                                      cannot reach: it is not answered as a log with no rows
    * @throws InternalServerErrorException (500) if the lake cannot be read
    */
  def log(eid: Long, user: User): ExecutionLogResponse = {
    val execution = readable(eid, user)
    if (unavailable(execution)) {
      throw new WebApplicationException(
        s"The log of execution $eid is in a warehouse that is no longer available" +
          execution.warehouse.fold(".")(name =>
            s": per-user warehouses are disabled in this deployment, and it is in '$name'."
          ),
        Response.Status.CONFLICT
      )
    }
    val entries =
      try rows(execution.logUri)
      catch {
        case NonFatal(failure) =>
          throw new InternalServerErrorException(
            s"The log of execution $eid could not be read.",
            failure
          )
      }
    ExecutionLogResponse(
      eid,
      entries.map(entryOf),
      execution.closing.map(closing =>
        ExecutionClosingResponse(
          closing.outcome,
          closing.reason,
          closing.endedAtMs,
          closing.fromLog
        )
      )
    )
  }

  /** Execution `eid`'s row, or 403 when there is none or `user` may not read it. */
  private def readable(eid: Long, user: User): ExecutionRecord =
    Option(user)
      .flatMap(signedIn => Option(signedIn.getUid))
      .flatMap(uid => ExecutionRecords.find(eid).filter(ExecutionRecords.mayRead(uid, _)))
      .getOrElse(throw new ForbiddenException(s"You may not read execution $eid."))

  private def unavailable(execution: ExecutionRecord): Boolean =
    ExecutionClosing.warehouseUnavailable(execution.warehouse, warehousesEnabled)

  /** A log row as the route answers it: its columns, and what its detail says beside them. */
  private def entryOf(entry: ExecutionLogEntry): ExecutionLogEntryResponse = {
    val detail = entry.detail.map(objectMapper.readTree)
    ExecutionLogEntryResponse(
      seq = entry.seq,
      timeMs = entry.timeMs,
      kind = entry.kind,
      state = entry.state,
      reason = detail.flatMap(node => Option(node.path("reason").textValue())),
      errors = detail.map(_.path("errors")).filter(_.isArray)
    )
  }
}
