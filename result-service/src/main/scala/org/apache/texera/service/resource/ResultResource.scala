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

import com.fasterxml.jackson.databind.node.ObjectNode
import io.dropwizard.auth.Auth
import jakarta.annotation.security.RolesAllowed
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.{
  BadRequestException,
  DefaultValue,
  ForbiddenException,
  GET,
  NotFoundException,
  Path,
  PathParam,
  Produces,
  QueryParam,
  ServiceUnavailableException
}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionLogStore,
  ExecutionTables,
  VFSResourceType,
  VFSURIFactory,
  WarehouseReadGuard,
  WarehouseUnavailableException
}
import org.apache.texera.amber.core.tuple.{Attribute, Schema, Tuple, TupleUtils}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.OutputPort.OutputMode
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.auth.SessionUser
import org.apache.texera.auth.util.ComputingUnitAccess
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.service.resource.ResultResource._
import org.jooq.DSLContext

import java.net.URI
import java.util.Locale

object ResultResource {
  // A page is read into memory in a service everyone shares, so one request must not be able to
  // ask for a whole table. This is far above the rows a result panel shows at once.
  private val MaxPageSize = 1000

  private def context: DSLContext = SqlServer.getInstance().createDSLContext()

  case class LatestExecution(eid: Integer)

  /** One result of an execution. `outputMode` is empty for a table that records none. */
  case class PortResult(
      operatorId: String,
      portIndex: Int,
      outputMode: Option[String],
      rowCount: Long
  )

  case class ResultPage(table: List[ObjectNode], schema: List[Attribute], rowCount: Long)

  /** An execution a caller may read, with where its tables are. */
  private case class ReadableExecution(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String]
  )

  /** A result an execution stored: the result table of one of its external output ports. */
  private case class StoredResult(port: GlobalPortIdentity, uri: URI)
}

/**
  * Reads the results of an execution, running or finished. Each read loads the table's current
  * snapshot, so the pages of a running execution are as fresh as what it has committed.
  *
  * An execution's results are the result tables of its external output ports, found by the
  * tables' names ([[ExecutionTables.portTables]]). Each table records the output mode of its port
  * ([[ExecutionTables.outputModeOf]]): a visualization's content is sent whole.
  *
  * @param warehousesEnabled whether per-user warehouses are on here: a result in one is not read
  *                          while they are off (503)
  */
@Path("/results")
@Produces(Array(MediaType.APPLICATION_JSON))
@RolesAllowed(Array("REGULAR", "ADMIN"))
class ResultResource(warehousesEnabled: Boolean) {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() = this(StorageConfig.warehouseEnabled)

  /**
    * The caller's own latest finished execution of a workflow: the newest one that is closed. It
    * names only an execution the caller started, so it needs no access check of its own.
    */
  @GET
  @Path("/workflows/{wid}/latest-execution")
  def getLatestExecution(
      @PathParam("wid") wid: Integer,
      @Auth user: SessionUser
  ): LatestExecution = {
    val eid = context
      .select(WORKFLOW_EXECUTIONS.EID)
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
      .where(WORKFLOW_VERSION.WID.eq(wid))
      .and(WORKFLOW_EXECUTIONS.UID.eq(user.getUid))
      .and(WORKFLOW_EXECUTIONS.ENDED_AT.isNotNull)
      .orderBy(WORKFLOW_EXECUTIONS.EID.desc())
      .limit(1)
      .fetchOneInto(classOf[Integer])
    if (eid == null) {
      throw new NotFoundException(s"you have no finished execution of workflow $wid")
    }
    LatestExecution(eid)
  }

  /** The results of an execution, with the rows each holds. */
  @GET
  @Path("/executions/{eid}")
  def getResults(@PathParam("eid") eid: Integer, @Auth user: SessionUser): List[PortResult] =
    storedResults(readableExecution(eid, user))
      .flatMap(result =>
        // A table dropped since it was listed is a result no longer stored.
        rowCountOf(result.uri).map(rows =>
          PortResult(
            result.port.opId.logicalOpId.id,
            result.port.portId.id,
            ExecutionTables.outputModeOf(result.uri).map(_.name),
            rows
          )
        )
      )
      .sortBy(result => (result.operatorId, result.portIndex))

  /** One page of an operator's result. `pageIndex` starts from 1. */
  @GET
  @Path("/executions/{eid}/operators/{operatorId}/pages")
  def getPage(
      @PathParam("eid") eid: Integer,
      @PathParam("operatorId") operatorId: String,
      @QueryParam("port") @DefaultValue("0") port: Int,
      @QueryParam("pageIndex") @DefaultValue("1") pageIndex: Int,
      @QueryParam("pageSize") @DefaultValue("10") pageSize: Int,
      @QueryParam("columnOffset") @DefaultValue("0") columnOffset: Int,
      @QueryParam("columnLimit") @DefaultValue("2147483647") columnLimit: Int,
      @QueryParam("columnSearch") @DefaultValue("") columnSearch: String,
      @Auth user: SessionUser
  ): ResultPage = {
    val execution = readableExecution(eid, user)
    if (
      pageIndex < 1 || pageSize < 1 || pageSize > MaxPageSize || columnOffset < 0 ||
      columnLimit < 0 || pageIndex.toLong * pageSize > Int.MaxValue
    ) {
      throw new BadRequestException("the page or column range is out of bounds")
    }

    val result = storedResult(execution, operatorId, port)
    val (document, schema) = openResult(result.uri, operatorId)
    val columns = schema.getAttributeNames
      .filter(_.toLowerCase(Locale.ROOT).contains(columnSearch.toLowerCase(Locale.ROOT)))
      .drop(columnOffset)
      .take(columnLimit)
    val from = pageSize * (pageIndex - 1)
    // A visualization is HTML in a single cell, so it is sent whole, as the computing unit's result
    // push sends it. A table that records no output mode is not treated as a visualization.
    val visualization =
      ExecutionTables.outputModeOf(result.uri).contains(OutputMode.SINGLE_SNAPSHOT)
    // Convert one row at a time, so building a page keeps at most one decoded row in memory. The
    // JSON keeps only a preview of each long value, except in a visualization.
    val table = document
      .getRange(from, from + pageSize, Some(columns))
      .map(row => TupleUtils.convertTuplesToJson(List(row), visualization).head)
      .toList
    ResultPage(
      table,
      columns.map(schema.getAttribute),
      document.getCount
    )
  }

  /** Per-column statistics of an operator's result, from the table's manifests. */
  @GET
  @Path("/executions/{eid}/operators/{operatorId}/statistics")
  def getStatistics(
      @PathParam("eid") eid: Integer,
      @PathParam("operatorId") operatorId: String,
      @QueryParam("port") @DefaultValue("0") port: Int,
      @Auth user: SessionUser
  ): Map[String, Map[String, Any]] = {
    val execution = readableExecution(eid, user)
    openResult(storedResult(execution, operatorId, port).uri, operatorId)._1.getTableStatistics
  }

  /**
    * Execution `eid`, if the caller may read it: one they started, or one that ran on a computing
    * unit they can use, the boundary these results sit behind today, when they are read through
    * that unit. Access to the workflow is not enough, whether it is public or granted, since a run
    * reads datasets with the access of the user who started it, and anyone who can write a
    * workflow can grant reading it. An execution that does not exist gets the same refusal, so ids
    * cannot be probed.
    */
  private def readableExecution(eid: Integer, user: SessionUser): ReadableExecution = {
    val execution = context
      .select(
        WORKFLOW_EXECUTIONS.UID,
        WORKFLOW_EXECUTIONS.CUID,
        WORKFLOW_VERSION.WID,
        USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME
      )
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
      .leftJoin(USER_WAREHOUSE)
      .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
      .where(WORKFLOW_EXECUTIONS.EID.eq(eid))
      .fetchOne()
    val readable = execution != null && (
      execution.value1() == user.getUid ||
        Option(execution.value2()).exists(cuid =>
          ComputingUnitAccess.getComputingUnitAccess(cuid, user.getUid) != PrivilegeEnum.NONE
        )
    )
    if (!readable) {
      throw new ForbiddenException(s"you cannot read the results of execution $eid")
    }
    ReadableExecution(
      WorkflowIdentity(execution.value3().longValue),
      ExecutionIdentity(eid.longValue),
      Option(execution.value4())
    )
  }

  /**
    * The results `execution` stored, one for each external output port that has a table. All
    * three endpoints read them here, so they agree on which table belongs to which port.
    */
  private def storedResults(execution: ReadableExecution): List[StoredResult] =
    readingWarehouse {
      // Its warehouse, through a table every execution names, before any of it is listed.
      WarehouseReadGuard.assertReadable(
        ExecutionLogStore.logUri(execution.wid, execution.eid, execution.warehouse),
        warehousesEnabled
      )
      ExecutionTables
        .portTables(execution.wid, execution.eid, execution.warehouse)
        .toList
        .flatMap { uri =>
          val named = VFSURIFactory.decodeURI(uri)
          named.globalPortId
            .filter(port => named.resourceType == VFSResourceType.RESULT && !port.portId.internal)
            .map(StoredResult(_, uri))
        }
    }

  private def storedResult(
      execution: ReadableExecution,
      operatorId: String,
      port: Int
  ): StoredResult =
    storedResults(execution)
      .find(result =>
        ExecutionTables.isOutputOf(result.port, OperatorIdentity(operatorId), PortIdentity(port))
      )
      .getOrElse(throw new NotFoundException(s"no result for operator $operatorId, port $port"))

  private def openResult(uri: URI, operatorId: String): (VirtualDocument[Tuple], Schema) =
    readingWarehouse {
      try {
        WarehouseReadGuard.assertReadable(uri, warehousesEnabled)
        val document = DocumentFactory.openDocument(uri)
        (document._1.asInstanceOf[VirtualDocument[Tuple]], document._2.get)
      } catch {
        case e: IllegalArgumentException if isGone(e) =>
          throw new NotFoundException(s"the result of operator $operatorId is no longer stored")
      }
    }

  /** The rows of the table at `uri`; None when the table is gone. */
  private def rowCountOf(uri: URI): Option[Long] =
    try Some(DocumentFactory.openDocument(uri)._1.getCount)
    catch { case e: IllegalArgumentException if isGone(e) => None }

  /** Whether opening a table failed because there is no table. */
  private def isGone(failure: IllegalArgumentException): Boolean =
    Option(failure.getMessage).exists(_.contains("No storage is found"))

  /** `read`, answering 503 when it is in a per-user warehouse that is disabled here. */
  private def readingWarehouse[T](read: => T): T =
    try read
    catch {
      case e: WarehouseUnavailableException => throw new ServiceUnavailableException(e.getMessage)
    }
}
