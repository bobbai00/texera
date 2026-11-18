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
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ConsoleRow,
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore
}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.WorkflowExecutionStatus
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.http.response.execution.{
  ExecutionClosingResponse,
  ExecutionConsoleMessageResponse,
  ExecutionConsoleResponse,
  ExecutionLogEntryResponse,
  ExecutionLogResponse,
  ExecutionStateResponse
}

import java.net.URI
import javax.ws.rs.core.Response
import javax.ws.rs.{
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  WebApplicationException
}
import scala.util.control.NonFatal

object ExecutionRecordReader {

  /** The most console messages one page holds. */
  val MaxConsolePage = 5000
}

/**
  * Reads what one execution recorded, for a user: what `GET /api/executions/{eid}/state`,
  * `/log` and `/console` on the Dashboard service answer. A closed execution's state is its
  * closing record; an open one's is the label of its log in the lake. No computing unit is
  * asked, so each answers for a run whose unit is gone.
  *
  * The caller must have created the execution, or own or have been granted its workflow
  * ([[ExecutionRecords.mayRead]]). Otherwise, and for an execution there is not, the answer is
  * 403, so execution ids cannot be probed.
  *
  * @param label             reads the label of the log at a URI; None when there is no log
  * @param rows              reads the rows of the log at a URI
  * @param messages          reads a page of the console table at a URI: the first so many
  *                          messages after a `seq`, of one operator or of all, and whether more
  *                          follow
  * @param warehousesEnabled whether runs write into per-user warehouses
  */
class ExecutionRecordReader(
    label: URI => Option[ExecutionLabel] = ExecutionLogStore.label,
    rows: URI => Seq[ExecutionLogEntry] = ExecutionLogStore.read,
    messages: (URI, Option[String], Long, Int) => (Seq[ConsoleRow], Boolean) =
      ConsoleMessageStore.read,
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
              ExecutionStatus.stateTimeOfOpen(found, execution.startingTimeMs)
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

  /**
    * A page of the console output execution `eid` stored, for `user` (see
    * [[ExecutionConsoleResponse]]): the first `limit` messages after message `afterSeq`, of
    * operator `operatorId` or of all operators (None). A page holds at most
    * [[ExecutionRecordReader.MaxConsolePage]] messages, whatever `limit` asks for. An execution
    * whose results have expired holds no console output: its page is empty, and nothing is
    * read for it.
    *
    * @throws ForbiddenException           (403) unless `user` may read the execution
    * @throws BadRequestException          (400) if `limit` is negative
    * @throws WebApplicationException      (409) if the console output is in a warehouse this
    *                                      deployment cannot reach: it is not answered as none
    * @throws InternalServerErrorException (500) if the lake cannot be read
    */
  def console(
      eid: Long,
      user: User,
      operatorId: Option[String],
      afterSeq: Long,
      limit: Int
  ): ExecutionConsoleResponse = {
    val execution = readable(eid, user)
    if (limit < 0) {
      throw new BadRequestException(s"A page holds 0 or more messages, not $limit.")
    }
    val (page, more) =
      if (execution.resultsExpiredAtMs.nonEmpty) (Nil, false)
      else
        storedMessages(
          execution,
          operatorId,
          afterSeq,
          math.min(limit, ExecutionRecordReader.MaxConsolePage)
        )
    ExecutionConsoleResponse(
      eid,
      page.map(row =>
        ExecutionConsoleMessageResponse(
          seq = row.seq,
          timeMs = row.timeMs,
          operatorId = row.operatorId,
          workerId = row.workerId,
          msgType = row.msgType,
          source = row.source,
          title = row.title,
          message = row.message
        )
      ),
      page.lastOption.fold(afterSeq)(_.seq),
      more
    )
  }

  /** A page of the console table of `execution`, read from the lake, or the 409 or the 500. */
  private def storedMessages(
      execution: ExecutionRecord,
      operatorId: Option[String],
      afterSeq: Long,
      limit: Int
  ): (Seq[ConsoleRow], Boolean) = {
    if (unavailable(execution)) {
      throw new WebApplicationException(
        s"The console output of execution ${execution.eid} is in a warehouse that is no " +
          "longer available" +
          execution.warehouse.fold(".")(name =>
            s": per-user warehouses are disabled in this deployment, and it is in '$name'."
          ),
        Response.Status.CONFLICT
      )
    }
    try messages(execution.consoleUri, operatorId, afterSeq, limit)
    catch {
      case NonFatal(failure) =>
        throw new InternalServerErrorException(
          s"The console output of execution ${execution.eid} could not be read.",
          failure
        )
    }
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
