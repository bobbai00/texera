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
import org.apache.texera.amber.core.storage.{
  FileResolver,
  RuntimeStatisticsStore,
  WarehouseReadGuard
}
import org.apache.texera.amber.core.virtualidentity._
import org.apache.texera.amber.engine.architecture.logreplay.{ReplayDestination, ReplayLogRecord}
import org.apache.texera.amber.engine.common.Utils.{maptoStatusCode, stringToAggregatedState}
import org.apache.texera.amber.engine.common.storage.SequentialRecordStorage
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.WorkflowAccess
import org.apache.texera.auth.{JwtParser, SessionUser}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.UserRoleEnum
import org.apache.texera.dao.jooq.generated.tables.daos.WorkflowExecutionsDao
import org.apache.texera.dao.jooq.generated.tables.pojos.{WorkflowExecutions, User => UserPojo}
import org.apache.texera.web.model.http.request.result.ResultExportRequest
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource._
import org.apache.texera.web.service.ResultExportService
import org.apache.texera.web.service.execution.{
  ExecutionExpiry,
  ExecutionRecords,
  OpenExecution,
  OpenExecutionStatuses
}
import org.jooq.{DSLContext, Record, SelectField}
import play.api.libs.json.Json

import java.net.URI
import java.sql.Timestamp
import javax.annotation.security.RolesAllowed
import javax.ws.rs._
import javax.ws.rs.core.{HttpHeaders, MediaType, Response}
import scala.collection.mutable
import scala.jdk.CollectionConverters._

object WorkflowExecutionsResource {
  private def context: DSLContext =
    SqlServer
      .getInstance()
      .createDSLContext()
  private def executionsDao = new WorkflowExecutionsDao(context.configuration)

  // Jersey makes a resource for each request; this is the service's, shared by them all.
  private lazy val openStatuses = new OpenExecutionStatuses()

  private def getExecutionById(eId: Integer): WorkflowExecutions = {
    executionsDao.fetchOneByEid(eId)
  }

  def userCanAccessExecution(uid: Integer, eid: Integer, requireWrite: Boolean): Boolean = {
    val owningWid = context
      .select(WORKFLOW_VERSION.WID)
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
      .where(WORKFLOW_EXECUTIONS.EID.eq(eid))
      .fetchOneInto(classOf[Integer])
    owningWid != null && (
      if (requireWrite) WorkflowAccess.hasWriteAccess(owningWid, uid)
      else WorkflowAccess.hasReadAccess(owningWid, uid)
    )
  }

  def validateUserCanAccessExecutions(
      uid: Integer,
      eids: Seq[Integer],
      requireWrite: Boolean
  ): Unit = {
    eids.distinct.foreach { eid =>
      if (!userCanAccessExecution(uid, eid, requireWrite)) {
        throw new ForbiddenException("No sufficient access privilege.")
      }
    }
  }

  /**
    * Computes which operators in a workflow are restricted due to dataset access controls.
    *
    * This function:
    * 1. Parses the workflow JSON to find all operators and their dataset dependencies
    * 2. Identifies operators using non-downloadable datasets that the user doesn't own
    * 3. Uses BFS to propagate restrictions through the workflow graph
    * 4. Returns a map of operator IDs to the restricted datasets they depend on
    *
    * @param wid The workflow ID
    * @param currentUser The current user making the export request
    * @return Map of operator ID -> Set of (ownerEmail, datasetName) tuples that block its export
    */
  private def getNonDownloadableOperatorMap(
      wid: Int,
      currentUser: UserPojo
  ): Map[String, Set[(String, String)]] = {
    // Load workflow
    val workflowRecord = context
      .select(WORKFLOW.CONTENT)
      .from(WORKFLOW)
      .where(WORKFLOW.WID.eq(wid).and(WORKFLOW.CONTENT.isNotNull).and(WORKFLOW.CONTENT.ne("")))
      .fetchOne()

    if (workflowRecord == null) {
      return Map.empty
    }

    val content = workflowRecord.value1()

    val rootNode =
      try {
        objectMapper.readTree(content)
      } catch {
        case _: Exception => return Map.empty
      }

    val operatorsNode = rootNode.path("operators")
    val linksNode = rootNode.path("links")

    // Collect all datasets used by operators (that user doesn't own)
    val operatorDatasets = mutable.Map.empty[String, (String, String)]

    operatorsNode.elements().asScala.foreach { operatorNode =>
      val operatorId = operatorNode.path("operatorID").asText("")
      if (operatorId.nonEmpty) {
        val fileNameNode = operatorNode.path("operatorProperties").path("fileName")
        if (fileNameNode.isTextual) {
          FileResolver.parseDatasetOwnerAndName(fileNameNode.asText()).foreach {
            case (ownerEmail, datasetName) =>
              val isOwner =
                Option(currentUser.getEmail)
                  .exists(_.equalsIgnoreCase(ownerEmail))
              if (!isOwner) {
                operatorDatasets.update(operatorId, (ownerEmail, datasetName))
              }
          }
        }
      }
    }

    if (operatorDatasets.isEmpty) {
      return Map.empty
    }

    // Query all datasets
    val uniqueDatasets = operatorDatasets.values.toSet
    val conditions = uniqueDatasets.map {
      case (ownerEmail, datasetName) =>
        USER.EMAIL.equalIgnoreCase(ownerEmail).and(DATASET.NAME.equalIgnoreCase(datasetName))
    }

    val nonDownloadableDatasets = context
      .select(USER.EMAIL, DATASET.NAME)
      .from(DATASET)
      .join(USER)
      .on(DATASET.OWNER_UID.eq(USER.UID))
      .where(conditions.reduce((a, b) => a.or(b)))
      .and(DATASET.IS_DOWNLOADABLE.eq(false))
      .fetch()
      .asScala
      .map(record => (record.value1(), record.value2()))
      .toSet

    // Filter to only operators with non-downloadable datasets
    val restrictedSourceMap = operatorDatasets.filter {
      case (_, dataset) =>
        nonDownloadableDatasets.contains(dataset)
    }

    // Build dependency graph
    val adjacency = mutable.Map.empty[String, mutable.ListBuffer[String]]

    linksNode.elements().asScala.foreach { linkNode =>
      val sourceId = linkNode.path("source").path("operatorID").asText("")
      val targetId = linkNode.path("target").path("operatorID").asText("")
      if (sourceId.nonEmpty && targetId.nonEmpty) {
        adjacency.getOrElseUpdate(sourceId, mutable.ListBuffer.empty[String]) += targetId
      }
    }

    // BFS to propagate restrictions
    val restrictionMap = mutable.Map.empty[String, Set[(String, String)]]
    val queue = mutable.Queue.empty[(String, Set[(String, String)])]

    restrictedSourceMap.foreach {
      case (operatorId, dataset) =>
        queue.enqueue(operatorId -> Set(dataset))
    }

    while (queue.nonEmpty) {
      val (currentOperatorId, datasetSet) = queue.dequeue()
      val existing = restrictionMap.getOrElse(currentOperatorId, Set.empty)
      val merged = existing ++ datasetSet
      if (merged != existing) {
        restrictionMap.update(currentOperatorId, merged)
        adjacency
          .get(currentOperatorId)
          .foreach(_.foreach(nextOperator => queue.enqueue(nextOperator -> merged)))
      }
    }

    restrictionMap.toMap
  }

  /**
    * The executions of workflow `wid`, newest first, as user `uid` sees them (see
    * [[WorkflowExecutionEntry]]): those whose status is one of `statusCodes`, when any are
    * given.
    *
    * A closed execution's status is in its row, so the codes of an ending narrow the query.
    * An open one's is in its log: any other code asks for the open executions too, whose logs
    * are then read, and those found in a status that was not asked for are left out. A filter
    * of endings only reads no log, so an execution whose log shows an ending is among them
    * once the closing job has recorded it.
    */
  def getWorkflowExecutions(
      wid: Integer,
      context: DSLContext,
      uid: Integer,
      statusCodes: Set[Byte] = Set.empty,
      statuses: OpenExecutionStatuses = openStatuses
  ): List[WorkflowExecutionEntry] =
    entriesOf(
      wid,
      uid,
      statuses,
      entryRows(context)
        .where(
          WORKFLOW_VERSION.WID
            .eq(wid)
            .and(ExecutionRecords.statusAmong(statusCodes.map(_.toShort)))
        )
        .orderBy(WORKFLOW_EXECUTIONS.EID.desc())
        .fetch()
        .asScala
        .toSeq
    ).filter(entry => statusCodes.isEmpty || statusCodes.contains(entry.status))

  /**
    * The newest execution of workflow `wid`, as user `uid` sees it: of its newest version that
    * has any, the one made last. None when the workflow has no execution.
    */
  def getLatestWorkflowExecution(
      wid: Integer,
      context: DSLContext,
      uid: Integer,
      statuses: OpenExecutionStatuses = openStatuses
  ): Option[WorkflowExecutionEntry] =
    entriesOf(
      wid,
      uid,
      statuses,
      entryRows(context)
        .where(WORKFLOW_VERSION.WID.eq(wid))
        .orderBy(WORKFLOW_EXECUTIONS.VID.desc(), WORKFLOW_EXECUTIONS.EID.desc())
        .limit(1)
        .fetch()
        .asScala
        .toSeq
    ).headOption

  /** The rows of `workflow_executions`, each with what an entry of a history is made of. */
  private def entryRows(context: DSLContext) =
    context
      .select(entryColumns.asJava)
      .from(WORKFLOW_EXECUTIONS)
      .join(WORKFLOW_VERSION)
      .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
      .join(USER)
      .on(WORKFLOW_EXECUTIONS.UID.eq(USER.UID))
      .leftJoin(USER_WAREHOUSE)
      .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))

  /** What an entry of a history, and its status, are made of. */
  private val entryColumns: Seq[SelectField[_]] = Seq(
    WORKFLOW_EXECUTIONS.EID,
    WORKFLOW_EXECUTIONS.VID,
    WORKFLOW_EXECUTIONS.CUID,
    WORKFLOW_EXECUTIONS.WHID,
    WORKFLOW_EXECUTIONS.UID,
    USER.NAME,
    USER.AVATAR,
    WORKFLOW_EXECUTIONS.STARTING_TIME,
    WORKFLOW_EXECUTIONS.BOOKMARKED,
    WORKFLOW_EXECUTIONS.NAME,
    WORKFLOW_EXECUTIONS.LOG_LOCATION,
    USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME,
    WORKFLOW_EXECUTIONS.OUTCOME,
    WORKFLOW_EXECUTIONS.OUTCOME_REASON,
    WORKFLOW_EXECUTIONS.ENDED_AT
  )

  /**
    * The entries of `rows`, executions of workflow `wid` selected by [[entryRows]], in their
    * order, for user `uid`. The logs of the open ones are read for their status.
    */
  private def entriesOf(
      wid: Integer,
      uid: Integer,
      statuses: OpenExecutionStatuses,
      rows: Seq[Record]
  ): List[WorkflowExecutionEntry] = {
    val open = statuses.of(
      rows
        .filter(_.get(WORKFLOW_EXECUTIONS.ENDED_AT) == null)
        .map(row =>
          OpenExecution(
            row.get(WORKFLOW_EXECUTIONS.EID).longValue(),
            wid.longValue(),
            Option(row.get(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)),
            row.get(WORKFLOW_EXECUTIONS.STARTING_TIME).getTime
          )
        )
    )
    // As ExecutionRecords.mayRead, asked once for the list.
    lazy val granted = WorkflowAccess.hasGrantedAccess(wid, uid)
    rows.map { row =>
      val eid = row.get(WORKFLOW_EXECUTIONS.EID)
      val own = row.get(WORKFLOW_EXECUTIONS.UID) == uid
      val (status, completionTime) = Option(row.get(WORKFLOW_EXECUTIONS.ENDED_AT)) match {
        case Some(endedAt) => (row.get(WORKFLOW_EXECUTIONS.OUTCOME).shortValue(), endedAt)
        case None =>
          val shown = open(eid.longValue())
          (shown.status, new Timestamp(shown.stateTimeMs))
      }
      WorkflowExecutionEntry(
        eId = eid,
        vId = row.get(WORKFLOW_EXECUTIONS.VID),
        cuId = row.get(WORKFLOW_EXECUTIONS.CUID),
        whId = row.get(WORKFLOW_EXECUTIONS.WHID),
        userName = row.get(USER.NAME),
        avatar = row.get(USER.AVATAR),
        status = status.toByte,
        reason = if (own || granted) row.get(WORKFLOW_EXECUTIONS.OUTCOME_REASON) else null,
        startingTime = row.get(WORKFLOW_EXECUTIONS.STARTING_TIME),
        completionTime = completionTime,
        bookmarked = row.get(WORKFLOW_EXECUTIONS.BOOKMARKED),
        name = row.get(WORKFLOW_EXECUTIONS.NAME),
        logLocation = if (own) row.get(WORKFLOW_EXECUTIONS.LOG_LOCATION) else null
      )
    }.toList
  }

  /**
    * Deletes the executions `eids`: first everything each keeps in the lake
    * ([[ExecutionExpiry.dropAll]]), then its row, so that a table that cannot be dropped leaves
    * a row to find it by. An id with no row is passed over. None is deleted while one of them is
    * open: without its row, nothing would find the tables its unit goes on writing.
    *
    * @throws WebApplicationException 409 if one of them is still open
    */
  def removeAllExecutionFiles(
      eids: Array[Integer],
      expiry: ExecutionExpiry = ExecutionExpiry.forDeployment
  ): Unit = {
    val executions = eids.toSeq.distinct.flatMap(eid => ExecutionRecords.find(eid.longValue()))
    executions.find(_.closing.isEmpty).foreach { open =>
      throw new WebApplicationException(
        s"execution ${open.eid} is still open; kill it first",
        Response.Status.CONFLICT
      )
    }
    executions.foreach { execution =>
      expiry.dropAll(execution.eid)
      context
        .deleteFrom(WORKFLOW_EXECUTIONS)
        .where(
          WORKFLOW_EXECUTIONS.EID
            .eq(Integer.valueOf(execution.eid.toInt))
            .and(WORKFLOW_EXECUTIONS.ENDED_AT.isNotNull)
        )
        .execute()
    }
  }

  /**
    * An execution as a workflow's history lists it, for one user.
    *
    * @param status         a code of [[org.apache.texera.dao.WorkflowExecutionStatus]]: how it
    *                       ended, once it is closed; while it is open, what its log shows
    *                       ([[org.apache.texera.web.service.execution.OpenStatus]])
    * @param reason         why it ended as it did, when its closing record says, for a user
    *                       who may read what it recorded (`ExecutionRecords.mayRead`); else null
    * @param completionTime when it ended, once it is closed; while it is open, when it took the
    *                       state it is in, or when it was created while its log shows no state
    *                       or cannot be read. Never null.
    * @param logLocation    where its replay log is, for the user who created it, the only one
    *                       who can replay it; else null
    */
  case class WorkflowExecutionEntry(
      eId: Integer,
      vId: Integer,
      cuId: Integer,
      whId: Integer,
      userName: String,
      avatar: String,
      status: Byte,
      reason: String,
      startingTime: Timestamp,
      completionTime: Timestamp,
      bookmarked: Boolean,
      name: String,
      logLocation: String
  )

  case class WorkflowRuntimeStatistics(
      operatorId: String,
      timestamp: Timestamp,
      inputTupleCount: Long,
      inputTupleSize: Long,
      outputTupleCount: Long,
      outputTupleSize: Long,
      dataProcessingTime: Long,
      controlProcessingTime: Long,
      idleTime: Long,
      numWorkers: Int,
      status: Int
  )
}

case class ExecutionGroupBookmarkRequest(
    wid: Integer,
    eIds: Array[Integer],
    isBookmarked: Boolean
)

case class ExecutionGroupDeleteRequest(wid: Integer, eIds: Array[Integer])

case class ExecutionRenameRequest(wid: Integer, eId: Integer, executionName: String)

@Produces(Array(MediaType.APPLICATION_JSON, MediaType.APPLICATION_OCTET_STREAM, "application/zip"))
@Path("/executions")
class WorkflowExecutionsResource(openStatuses: OpenExecutionStatuses) {

  // No-arg constructor for Jersey reflection. Tests use the param-ful form.
  def this() = this(WorkflowExecutionsResource.openStatuses)

  @GET
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{wid}/latest")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def retrieveLatestExecutionEntry(
      @PathParam("wid") wid: Integer,
      @Auth sessionUser: SessionUser
  ): WorkflowExecutionEntry = {

    validateUserCanAccessWorkflow(sessionUser.getUser.getUid, wid)

    getLatestWorkflowExecution(wid, context, sessionUser.getUser.getUid, openStatuses).getOrElse {
      throw new ForbiddenException("Executions doesn't exist")
    }
  }

  @GET
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{wid}/interactions/{eid}")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def retrieveInteractionHistory(
      @PathParam("wid") wid: Integer,
      @PathParam("eid") eid: Integer,
      @Auth sessionUser: SessionUser
  ): List[String] = {
    val user = sessionUser.getUser
    if (!userCanAccessExecution(user.getUid, eid, requireWrite = false)) {
      List()
    } else {
      val logLocation = context
        .select(WORKFLOW_EXECUTIONS.LOG_LOCATION)
        .from(WORKFLOW_EXECUTIONS)
        .join(WORKFLOW_VERSION)
        .on(WORKFLOW_EXECUTIONS.VID.eq(WORKFLOW_VERSION.VID))
        .where(WORKFLOW_EXECUTIONS.EID.eq(eid).and(WORKFLOW_VERSION.WID.eq(wid)))
        .fetchOneInto(classOf[String])
      if (logLocation != null && logLocation.nonEmpty) {
        val storage =
          SequentialRecordStorage.getStorage[ReplayLogRecord](Some(new URI(logLocation)))
        val result = new mutable.ArrayBuffer[EmbeddedControlMessageIdentity]()
        storage.getReader("COORDINATOR").mkRecordIterator().foreach {
          case destination: ReplayDestination =>
            result.append(destination.id)
          case _ =>
        }
        result.map(_.id).toList
      } else {
        List()
      }
    }
  }

  /**
    * This method returns the executions of a workflow given by its ID
    *
    * @return executions[]
    */
  @GET
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{wid}")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def retrieveExecutionsOfWorkflow(
      @PathParam("wid") wid: Integer,
      @Auth sessionUser: SessionUser,
      @QueryParam("status") status: String
  ): List[WorkflowExecutionEntry] = {
    val user = sessionUser.getUser
    if (!WorkflowAccess.hasReadAccess(wid, user.getUid)) {
      List()
    } else {
      val statusCodes: Set[Byte] =
        Option(status)
          .map(_.trim)
          .filter(_.nonEmpty)
          .map { raw =>
            val tokens = raw.split(',').map(_.trim.toLowerCase).filter(_.nonEmpty)
            try {
              tokens.map(stringToAggregatedState).map(maptoStatusCode).toSet
            } catch {
              case e: IllegalArgumentException =>
                throw new BadRequestException(e.getMessage)
            }
          }
          .getOrElse(Set.empty[Byte])
      getWorkflowExecutions(wid, context, user.getUid, statusCodes, openStatuses)
    }
  }

  @GET
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{wid}/stats/{eid}")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def retrieveWorkflowRuntimeStatistics(
      @PathParam("wid") wid: Integer,
      @PathParam("eid") eid: Integer,
      @Auth sessionUser: SessionUser
  ): List[WorkflowRuntimeStatistics] = {
    validateUserCanAccessWorkflow(sessionUser.getUser.getUid, wid)

    // Where an execution's statistics are follows from its own row, which says whose it is.
    val execution = ExecutionRecords
      .findOf(wid.longValue(), eid.longValue())
      .getOrElse(throw new NotFoundException(s"Workflow $wid has no execution $eid."))
    val uri = execution.statisticsUri
    // Refuse to read per-user-warehouse statistics while the feature is off (#6930).
    WarehouseReadGuard.assertReadable(uri)

    // The rows as the run's record stored them, oldest first; none from a table that was not
    // written through RuntimeStatisticsStore, and none while the run has made no table.
    RuntimeStatisticsStore
      .read(uri)
      .map(row =>
        WorkflowRuntimeStatistics(
          operatorId = row.operatorId,
          timestamp = new Timestamp(row.timeMs),
          inputTupleCount = row.inputTupleCnt,
          inputTupleSize = row.inputTupleSize,
          outputTupleCount = row.outputTupleCnt,
          outputTupleSize = row.outputTupleSize,
          dataProcessingTime = row.dataProcessingTime,
          controlProcessingTime = row.controlProcessingTime,
          idleTime = row.idleTime,
          numWorkers = row.numWorkers,
          status = row.status
        )
      )
      .toList
  }

  /** Sets a group of executions' bookmarks to the payload passed in the body. */
  @PUT
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Path("/set_execution_bookmarks")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def setExecutionAreBookmarked(
      request: ExecutionGroupBookmarkRequest,
      @Auth sessionUser: SessionUser
  ): Unit = {
    validateUserCanAccessExecutions(
      sessionUser.getUser.getUid,
      request.eIds.toSeq,
      requireWrite = true
    )
    val eIdsList = request.eIds.toSeq.asJava
    if (request.isBookmarked) {
      // If currently bookmarked, un-bookmark (set bookmarked = false)
      context
        .update(WORKFLOW_EXECUTIONS)
        .set(WORKFLOW_EXECUTIONS.BOOKMARKED, java.lang.Boolean.valueOf(false))
        .where(WORKFLOW_EXECUTIONS.EID.in(eIdsList))
        .execute()
    } else {
      // If currently not bookmarked, bookmark (set bookmarked = true)
      context
        .update(WORKFLOW_EXECUTIONS)
        .set(WORKFLOW_EXECUTIONS.BOOKMARKED, java.lang.Boolean.valueOf(true))
        .where(WORKFLOW_EXECUTIONS.EID.in(eIdsList))
        .execute()
    }

  }

  /** Determine if the user is authorized to access the workflow, if not raise 401 */
  private def validateUserCanAccessWorkflow(uid: Integer, wid: Integer): Unit = {
    if (!WorkflowAccess.hasReadAccess(wid, uid))
      throw new WebApplicationException(Response.Status.UNAUTHORIZED)
  }

  private def workflowAccessDeniedResponse: Response =
    Response
      .status(Response.Status.UNAUTHORIZED)
      .`type`(MediaType.APPLICATION_JSON)
      .entity(Map("error" -> "No sufficient access privilege.").asJava)
      .build()

  /** Delete a group of executions */
  @PUT
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Path("/delete_executions")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def groupDeleteExecutionsOfWorkflow(
      request: ExecutionGroupDeleteRequest,
      @Auth sessionUser: SessionUser
  ): Unit = {
    validateUserCanAccessExecutions(
      sessionUser.getUser.getUid,
      request.eIds.toSeq,
      requireWrite = true
    )
    removeAllExecutionFiles(request.eIds)
  }

  /** Name a single execution * */
  @POST
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Path("/update_execution_name")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def updateWorkflowExecutionsName(
      request: ExecutionRenameRequest,
      @Auth sessionUser: SessionUser
  ): Unit = {
    validateUserCanAccessExecutions(
      sessionUser.getUser.getUid,
      Seq(request.eId),
      requireWrite = true
    )
    val execution = getExecutionById(request.eId)
    execution.setName(request.executionName)
    executionsDao.update(execution)
  }

  /**
    * Returns which operators are restricted from export due to dataset access controls.
    * This endpoint allows the frontend to check restrictions before attempting export.
    *
    * @param wid The workflow ID to check
    * @param user The authenticated user
    * @return JSON map of operator ID -> array of {ownerEmail, datasetName} that block its export
    */
  @GET
  @Path("/{wid}/result/downloadability")
  @Produces(Array(MediaType.APPLICATION_JSON))
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def getWorkflowResultDownloadability(
      @PathParam("wid") wid: Integer,
      @Auth user: SessionUser
  ): Response = {
    validateUserCanAccessWorkflow(user.getUser.getUid, wid)

    val datasetRestrictions = getNonDownloadableOperatorMap(wid, user.user)

    // Convert to frontend-friendly format: Map[operatorId -> Array[datasetLabel]]
    val restrictionMap = datasetRestrictions.map {
      case (operatorId, datasets) =>
        operatorId -> datasets.map {
          case (ownerEmail, datasetName) => s"$datasetName ($ownerEmail)"
        }.toArray
    }.asJava

    Response.ok(restrictionMap).build()
  }

  /**
    * An export that was not made, answered `{"error": message}`: with the status of the
    * refusal when it is one (404 for an execution that is not the workflow's, 410 for one
    * whose results have expired), else 500.
    */
  private def exportFailureResponse(failure: Exception): Response = {
    val status = failure match {
      case refusal: WebApplicationException => refusal.getResponse.getStatus
      case _                                => Response.Status.INTERNAL_SERVER_ERROR.getStatusCode
    }
    Response
      .status(status)
      .`type`(MediaType.APPLICATION_JSON)
      .entity(Map("error" -> failure.getMessage).asJava)
      .build()
  }

  /** The token of an `Authorization: Bearer <token>` header; empty when it carries none. */
  private def bearerTokenOf(authorization: String): String =
    Option(authorization)
      .map(_.trim.split("\\s+", 2))
      .collect { case Array(scheme, token) if scheme.equalsIgnoreCase("Bearer") => token.trim }
      .getOrElse("")

  /**
    * Exports results of execution `request.executionId` of the workflow into datasets, each
    * upload to the file service made with the caller's own token.
    */
  @POST
  @Path("/result/export/dataset")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def exportResultToDataset(
      request: ResultExportRequest,
      @HeaderParam(HttpHeaders.AUTHORIZATION) authorization: String,
      @Auth user: SessionUser
  ): Response = {
    if (!WorkflowAccess.hasReadAccess(request.workflowId, user.getUser.getUid)) {
      workflowAccessDeniedResponse
    } else {
      try {
        val resultExportService =
          new ResultExportService(WorkflowIdentity(request.workflowId), request.executionId)
        resultExportService.exportToDataset(bearerTokenOf(authorization), request)

      } catch {
        case ex: Exception => exportFailureResponse(ex)
      }
    }
  }

  @POST
  @Path("/result/export/local")
  @Consumes(Array(MediaType.APPLICATION_FORM_URLENCODED))
  def exportResultToLocal(
      @FormParam("request") requestJson: String,
      @FormParam("token") token: String
  ): Response = {

    try {
      val userOpt = JwtParser.parseToken(token)
      if (!userOpt.isPresent) {
        throw new RuntimeException("Invalid or expired token")
      }
      val user = userOpt.get()
      val role = user.getUser.getRole
      val RolesAllowed = Set(UserRoleEnum.REGULAR, UserRoleEnum.ADMIN)
      if (!RolesAllowed.contains(role)) {
        throw new RuntimeException("User role is not allowed to perform this download")
      }

      val request = Json.parse(requestJson).as[ResultExportRequest]
      if (!WorkflowAccess.hasReadAccess(request.workflowId, user.getUser.getUid)) {
        workflowAccessDeniedResponse
      } else {
        val resultExportService =
          new ResultExportService(WorkflowIdentity(request.workflowId), request.executionId)
        resultExportService.exportToLocal(request)
      }

    } catch {
      case ex: Exception => exportFailureResponse(ex)
    }
  }
}
