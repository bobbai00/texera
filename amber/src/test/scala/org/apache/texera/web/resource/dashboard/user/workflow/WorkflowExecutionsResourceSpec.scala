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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.serialization.SerializationExtension
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.core.storage.model.BufferedItemWriter
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  NoStoredPlanException,
  PlanRecord,
  RuntimeStatisticsRow,
  RuntimeStatisticsStore,
  WarehouseUnavailableException
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{
  EmbeddedControlMessageIdentity,
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.apache.texera.auth.{JwtAuth, SessionUser}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder, WorkflowExecutionStatus}
import org.apache.texera.amber.core.workflow.OutputPort.OutputMode
import org.apache.texera.dao.jooq.generated.enums.UserWarehouseFlavorEnum
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowUserAccessDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  Dataset,
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowExecutions,
  WorkflowUserAccess,
  WorkflowVersion
}
import org.apache.texera.amber.engine.architecture.coordinator.OperatorPortResultUriAvailable
import org.apache.texera.amber.engine.architecture.logreplay.{ReplayDestination, ReplayLogRecord}
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.amber.engine.common.storage.VFSRecordStorage
import org.apache.texera.web.model.http.request.result.{OperatorExportInfo, ResultExportRequest}
import org.apache.texera.web.model.http.response.result.ResultExportResponse
import org.apache.texera.web.service.ExecutionResultService
import org.jose4j.jwt.JwtClaims
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach, PrivateMethodTester}
import play.api.libs.json.Json

import javax.ws.rs.{
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  WebApplicationException
}
import javax.ws.rs.core.Response
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.TimeUnit
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, ExecutionContext, Future}

class WorkflowExecutionsResourceSpec
    extends AnyFlatSpec
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB
    with PrivateMethodTester {

  private val testWorkflowWid = 3000 + scala.util.Random.nextInt(1000)
  private val testUserId = 1000 + scala.util.Random.nextInt(1000)
  // A second workflow, so a test can hand an endpoint an execution id that is real
  // but belongs to a workflow other than the one in the request.
  private val foreignWid = 20000 + scala.util.Random.nextInt(1000)

  private var testWorkflow: Workflow = _
  private var testVersion: WorkflowVersion = _
  private var testUser: User = _
  private var userDao: UserDao = _
  private var workflowDao: WorkflowDao = _
  private var workflowVersionDao: WorkflowVersionDao = _
  private var workflowExecutionsDao: WorkflowExecutionsDao = _
  private var datasetDao: DatasetDao = _
  private var computingUnitDao: WorkflowComputingUnitDao = _
  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
  }

  override protected def beforeEach(): Unit = {
    testUser = new User
    testUser.setUid(testUserId)
    testUser.setName("test_user")
    testUser.setEmail("test@example.com")
    testUser.setAvatar("avatar_url")

    testWorkflow = new Workflow
    testWorkflow.setWid(testWorkflowWid)
    testWorkflow.setName("test_workflow_" + UUID.randomUUID().toString.substring(0, 8))
    testWorkflow.setContent("{}")
    testWorkflow.setDescription("test description")
    testWorkflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    testWorkflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))

    testVersion = new WorkflowVersion
    testVersion.setWid(testWorkflowWid)
    testVersion.setContent("{}")
    testVersion.setCreationTime(new Timestamp(System.currentTimeMillis()))

    workflowDao = new WorkflowDao(getDSLContext.configuration())
    workflowVersionDao = new WorkflowVersionDao(getDSLContext.configuration())
    userDao = new UserDao(getDSLContext.configuration())
    workflowExecutionsDao = new WorkflowExecutionsDao(getDSLContext.configuration())
    datasetDao = new DatasetDao(getDSLContext.configuration())
    computingUnitDao = new WorkflowComputingUnitDao(getDSLContext.configuration())

    cleanupTestData()

    userDao.insert(testUser)
    workflowDao.insert(testWorkflow)
    workflowVersionDao.insert(testVersion)
  }

  override protected def afterEach(): Unit = {
    cleanupTestData()
  }

  private def purgeWorkflow(wid: Int): Unit = {
    val vidSubquery = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(wid))

    // Child tables of WORKFLOW_EXECUTIONS must be wiped before the parent row.
    getDSLContext
      .deleteFrom(OPERATOR_PORT_EXECUTIONS)
      .where(
        OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.in(
          getDSLContext
            .select(WORKFLOW_EXECUTIONS.EID)
            .from(WORKFLOW_EXECUTIONS)
            .where(WORKFLOW_EXECUTIONS.VID.in(vidSubquery))
        )
      )
      .execute()

    getDSLContext
      .deleteFrom(OPERATOR_EXECUTIONS)
      .where(
        OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.in(
          getDSLContext
            .select(WORKFLOW_EXECUTIONS.EID)
            .from(WORKFLOW_EXECUTIONS)
            .where(WORKFLOW_EXECUTIONS.VID.in(vidSubquery))
        )
      )
      .execute()

    getDSLContext
      .deleteFrom(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.VID.in(vidSubquery))
      .execute()

    getDSLContext
      .deleteFrom(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(wid))
      .execute()

    // Access grants seeded by the endpoint tests must go before the workflow row.
    getDSLContext
      .deleteFrom(WORKFLOW_USER_ACCESS)
      .where(WORKFLOW_USER_ACCESS.WID.eq(wid))
      .execute()

    getDSLContext
      .deleteFrom(WORKFLOW)
      .where(WORKFLOW.WID.eq(wid))
      .execute()
  }

  private def cleanupTestData(): Unit = {
    purgeWorkflow(testWorkflowWid)
    purgeWorkflow(foreignWid)

    // Datasets / computing units / extra users may be seeded by individual cases.
    getDSLContext
      .deleteFrom(DATASET)
      .where(DATASET.OWNER_UID.in(getDSLContext.select(USER.UID).from(USER).where(USER.UID.ne(0))))
      .execute()

    getDSLContext
      .deleteFrom(WORKFLOW_COMPUTING_UNIT)
      .where(WORKFLOW_COMPUTING_UNIT.UID.eq(testUserId))
      .execute()

    getDSLContext
      .deleteFrom(USER)
      .where(USER.UID.eq(testUserId))
      .execute()
  }

  override protected def afterAll(): Unit = {
    closeConnectionPool()
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private def insertComputingUnit(): WorkflowComputingUnit = {
    val unit = new WorkflowComputingUnit
    unit.setUid(testUser.getUid)
    unit.setName("test-unit-" + UUID.randomUUID().toString.substring(0, 8))
    unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
    unit.setType(WorkflowComputingUnitTypeEnum.local)
    unit.setUri("local://test")
    unit.setResource("{}")
    computingUnitDao.insert(unit)
    unit
  }

  private def insertExecution(
      name: String = s"Execution-${UUID.randomUUID().toString.substring(0, 8)}",
      status: Byte = 0.toByte,
      result: String = "",
      logLocation: String = "",
      startOffsetMillis: Long = 0L,
      lastUpdateOffsetMillis: Option[Long] = None,
      cuid: Integer = null,
      runtimeStatsUri: String = null,
      whid: Integer = null
  ): WorkflowExecutions = {
    val execution = new WorkflowExecutions
    execution.setVid(testVersion.getVid)
    execution.setUid(testUser.getUid)
    execution.setStatus(status)
    execution.setResult(result)
    execution.setLogLocation(logLocation)
    val now = System.currentTimeMillis()
    execution.setStartingTime(new Timestamp(now - startOffsetMillis))
    lastUpdateOffsetMillis.foreach(off => execution.setLastUpdateTime(new Timestamp(now - off)))
    execution.setBookmarked(false)
    execution.setName(name)
    execution.setEnvironmentVersion("test-env-1.0")
    execution.setCuid(cuid)
    execution.setWhid(whid)
    execution.setRuntimeStatsUri(runtimeStatsUri)
    workflowExecutionsDao.insert(execution)
    execution
  }

  // An execution that is real, readable by testUser's session, and belongs to a
  // *different* workflow than `testWorkflowWid` — the shape an endpoint that
  // forgets to join execution -> version -> workflow would happily serve.
  private def insertForeignExecution(
      runtimeStatsUri: String = null,
      logLocation: String = ""
  ): WorkflowExecutions = {
    val workflow = new Workflow
    workflow.setWid(foreignWid)
    workflow.setName("foreign_workflow_" + UUID.randomUUID().toString.substring(0, 8))
    workflow.setContent("{}")
    workflow.setDescription("")
    workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    workflowDao.insert(workflow)

    val version = new WorkflowVersion
    version.setWid(foreignWid)
    version.setContent("{}")
    version.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflowVersionDao.insert(version)

    val execution = new WorkflowExecutions
    execution.setVid(version.getVid)
    execution.setUid(testUser.getUid)
    execution.setStatus(0.toByte)
    execution.setResult("")
    execution.setLogLocation(logLocation)
    execution.setStartingTime(new Timestamp(System.currentTimeMillis()))
    execution.setBookmarked(false)
    execution.setName("foreign-execution")
    execution.setEnvironmentVersion("test-env-1.0")
    execution.setRuntimeStatsUri(runtimeStatsUri)
    workflowExecutionsDao.insert(execution)
    execution
  }

  // `SequentialRecordWriter`/`Reader` hard-code `AmberRuntime.serde`, so the one case
  // that round-trips real replay records needs AmberRuntime initialized. Same
  // reflection-injection pattern as ReplayLogGeneratorSpec / ClientEventSpec, with two
  // narrowings, because amber runs every suite in one JVM: it is scoped to the single
  // case rather than beforeAll (the other DB-only cases pay nothing), and an
  // AmberRuntime another suite already initialized is reused as-is rather than swapped
  // out underneath it. Reading `AmberRuntime.serde` instead would lazily build an
  // ActorSystem nothing ever shuts down.
  private def withAmberSerde[T](body: => T): T = {
    def field(name: String) = {
      val f = AmberRuntime.getClass.getDeclaredField(name)
      f.setAccessible(true)
      f
    }
    val systemField = field("_actorSystem")
    val serdeField = field("_serde")
    val previousSystem = systemField.get(AmberRuntime)
    val previousSerde = serdeField.get(AmberRuntime)
    if (previousSerde != null) {
      body
    } else {
      val system = ActorSystem("WorkflowExecutionsResourceSpec-replay", AmberRuntime.pekkoConfig)
      systemField.set(AmberRuntime, system)
      serdeField.set(AmberRuntime, SerializationExtension(system))
      try body
      finally {
        serdeField.set(AmberRuntime, previousSerde)
        systemField.set(AmberRuntime, previousSystem)
        TestKit.shutdownActorSystem(system)
      }
    }
  }

  // Best-effort: on Windows a handle the reader failed to release would block the
  // delete, and leaving a temp file behind must not fail an otherwise green case.
  private def deleteRecursively(file: File): Unit = {
    if (file.isDirectory) Option(file.listFiles()).foreach(_.foreach(deleteRecursively))
    file.delete()
    ()
  }

  // Local convenience over the production callback: fixture rows the
  // lookup specs below need go through the same insert prod uses, so a
  // regression in the column list shows up here too.
  private def insertOperatorPortResult(
      eid: ExecutionIdentity,
      globalPortId: GlobalPortIdentity,
      uri: URI
  ): Unit =
    ExecutionResultService.persistOperatorPortResultUri(
      eid,
      OperatorPortResultUriAvailable(globalPortId, uri, OutputMode.SET_SNAPSHOT)
    )

  // ─── existing tests (preserved) ───────────────────────────────────────────

  "WorkflowExecutionsResource.getWorkflowExecutions" should "return executions with EIDs in descending order" in {
    val numExecutions = 10
    val executionIds = ArrayBuffer.empty[Integer]

    for (i <- 1 to numExecutions) {
      val execution = insertExecution(
        name = s"Execution ${i}",
        startOffsetMillis = TimeUnit.DAYS.toMillis(numExecutions - i)
      )
      executionIds.append(execution.getEid)
    }

    val result = WorkflowExecutionsResource.getWorkflowExecutions(testWorkflowWid, getDSLContext)

    assert(result.nonEmpty, "Result should not be empty")
    assert(
      result.size == numExecutions,
      s"Expected $numExecutions executions, but got ${result.size}"
    )

    for (i <- 0 until result.size - 1) {
      assert(
        result(i).eId > result(i + 1).eId,
        s"Executions are not in descending order: ${result(i).eId} should be > ${result(i + 1).eId}"
      )
    }

    val returnedIds = result.map(_.eId).toSet
    assert(
      executionIds.toSet.subsetOf(returnedIds),
      "All inserted execution IDs should be returned"
    )
  }

  // (The production callback body that writes operator_port_executions is
  // covered by `ExecutionResultServiceSpec.persistOperatorPortResultUri`.)

  // ─── new: status-filtered execution listing ───────────────────────────────

  "getWorkflowExecutions with statusCodes" should "narrow results to the requested codes" in {
    insertExecution(status = 1.toByte)
    insertExecution(status = 2.toByte)
    insertExecution(status = 1.toByte)

    val onlyStatusOne =
      WorkflowExecutionsResource.getWorkflowExecutions(
        testWorkflowWid,
        getDSLContext,
        Set(1.toByte)
      )
    assert(onlyStatusOne.size == 2)
    assert(onlyStatusOne.forall(_.status == 1.toByte))
  }

  // ─── new: getLatestExecutionID ────────────────────────────────────────────

  "getLatestExecutionID" should "return None when no executions exist for the (wid, cuid) pair" in {
    val result =
      WorkflowExecutionsResource.getLatestExecutionID(testWorkflowWid, Integer.valueOf(999))
    assert(result.isEmpty)
  }

  it should "return the largest EID for matching (wid, cuid)" in {
    // cuid has an FK to WORKFLOW_COMPUTING_UNIT — seed two units.
    val unitA = insertComputingUnit()
    val unitB = insertComputingUnit()

    val a = insertExecution(cuid = unitA.getCuid)
    val b = insertExecution(cuid = unitA.getCuid)
    // Distractor with a different cuid — should be ignored.
    insertExecution(cuid = unitB.getCuid)

    val result = WorkflowExecutionsResource.getLatestExecutionID(testWorkflowWid, unitA.getCuid)
    assert(result.isDefined)
    assert(result.get == math.max(a.getEid, b.getEid))
  }

  it should "pass over an execution that was created and not started" in {
    val unit = insertComputingUnit()
    val started = insertExecution(cuid = unit.getCuid)
    insertExecution(cuid = unit.getCuid, status = WorkflowExecutionStatus.Created.toByte)

    assert(
      WorkflowExecutionsResource
        .getLatestExecutionID(testWorkflowWid, unit.getCuid)
        .contains(started.getEid)
    )
  }

  // ─── new: getExpiredExecutionsWithResultOrLog ─────────────────────────────

  "getExpiredExecutionsWithResultOrLog" should "match rows that are stale by starting_time and have a result" in {
    // Stale-by-starting-time + has result → match.
    val expired = insertExecution(
      name = "expired-with-result",
      result = "some-result",
      startOffsetMillis = TimeUnit.SECONDS.toMillis(120)
    )
    // Fresh starting_time → must not match.
    insertExecution(name = "fresh", result = "some-result")
    // Stale but empty result+log → must not match.
    insertExecution(
      name = "stale-but-empty",
      startOffsetMillis = TimeUnit.SECONDS.toMillis(120)
    )

    val matched = WorkflowExecutionsResource.getExpiredExecutionsWithResultOrLog(60)

    val eids = matched.map(_.getEid).toSet
    assert(eids.contains(expired.getEid))
    assert(matched.forall(e => e.getResult.nonEmpty || Option(e.getLogLocation).exists(_.nonEmpty)))
  }

  it should "match rows that are stale by last_update_time and have a log_location" in {
    val expired = insertExecution(
      name = "log-stale",
      logLocation = "file:///tmp/log",
      lastUpdateOffsetMillis = Some(TimeUnit.SECONDS.toMillis(120))
    )
    insertExecution(
      name = "log-fresh",
      logLocation = "file:///tmp/log-2",
      lastUpdateOffsetMillis = Some(0L)
    )

    val matched = WorkflowExecutionsResource.getExpiredExecutionsWithResultOrLog(60)
    assert(matched.map(_.getEid).toSet.contains(expired.getEid))
  }

  // ─── new: insertOperatorExecutions ────────────────────────────────────────

  "insertOperatorExecutions" should "insert one OPERATOR_EXECUTIONS row" in {
    val execution = insertExecution()
    val uri = URI.create("vfs:///console-msg")

    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      "op-A",
      uri
    )

    val rows = getDSLContext
      .selectFrom(OPERATOR_EXECUTIONS)
      .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid))
      .and(OPERATOR_EXECUTIONS.OPERATOR_ID.eq("op-A"))
      .fetch()

    assert(rows.size() == 1)
    assert(rows.get(0).getConsoleMessagesUri == uri.toString)
  }

  it should "change nothing when the same operator of the execution is registered again" in {
    // A run registers its execution's one console table as it is set up, whatever was
    // registered before.
    val execution = insertExecution()
    val uri = URI.create("vfs:///console-msg")
    WorkflowExecutionsResource.insertOperatorExecutions(execution.getEid.longValue(), "*", uri)

    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      "*",
      URI.create("vfs:///another")
    )

    val rows = getDSLContext
      .selectFrom(OPERATOR_EXECUTIONS)
      .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid))
      .fetch()
    assert(rows.size() == 1)
    assert(rows.get(0).getConsoleMessagesUri == uri.toString)
  }

  // ─── new: updateRuntimeStatsUri ───────────────────────────────────────────

  "updateRuntimeStatsUri" should "set the runtime_stats_uri on the execution in one UPDATE by eid" in {
    val execution = insertExecution()
    val uri = URI.create("vfs:///runtime-stats")

    // The unit stamps the URI as a run starts, so it reads nothing, not even in a subselect.
    val statements = recorder.record {
      WorkflowExecutionsResource.updateRuntimeStatsUri(execution.getEid.longValue(), uri)
    }

    assert(statements.map(_.verb) == Seq("UPDATE"))
    assert(!statements.head.sql.toLowerCase.contains("select"))
    val refreshed = workflowExecutionsDao.fetchOneByEid(execution.getEid)
    assert(refreshed.getRuntimeStatsUri == uri.toString)
  }

  it should "leave every other execution untouched" in {
    val execution = insertExecution()
    val other = insertExecution()

    WorkflowExecutionsResource.updateRuntimeStatsUri(
      execution.getEid.longValue(),
      URI.create("vfs:///runtime-stats")
    )

    assert(workflowExecutionsDao.fetchOneByEid(other.getEid).getRuntimeStatsUri == null)
  }

  it should "update nothing for an unknown eid" in {
    val execution = insertExecution()

    WorkflowExecutionsResource.updateRuntimeStatsUri(-1L, URI.create("vfs:///runtime-stats"))

    assert(workflowExecutionsDao.fetchOneByEid(execution.getEid).getRuntimeStatsUri == null)
  }

  // ─── new: URI fetchers ────────────────────────────────────────────────────

  "getConsoleMessagesUriByExecutionId" should "return inserted URIs and filter empty entries" in {
    val execution = insertExecution()
    val eid = ExecutionIdentity(execution.getEid.longValue())

    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      "op-A",
      URI.create("vfs:///console-A")
    )
    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      "op-B",
      URI.create("vfs:///console-B")
    )
    // Empty-URI row — must be filtered.
    getDSLContext
      .insertInto(OPERATOR_EXECUTIONS)
      .columns(
        OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID,
        OPERATOR_EXECUTIONS.OPERATOR_ID,
        OPERATOR_EXECUTIONS.CONSOLE_MESSAGES_URI
      )
      .values(execution.getEid, "op-C", "")
      .execute()

    val uris = WorkflowExecutionsResource.getConsoleMessagesUriByExecutionId(eid)
    assert(uris.toSet == Set(URI.create("vfs:///console-A"), URI.create("vfs:///console-B")))
  }

  "getRuntimeStatsUriByExecutionId" should "return None when the stored URI is null or empty" in {
    val noUri = insertExecution()
    assert(
      WorkflowExecutionsResource
        .getRuntimeStatsUriByExecutionId(ExecutionIdentity(noUri.getEid.longValue()))
        .isEmpty
    )

    val emptyUri = insertExecution(runtimeStatsUri = "")
    assert(
      WorkflowExecutionsResource
        .getRuntimeStatsUriByExecutionId(ExecutionIdentity(emptyUri.getEid.longValue()))
        .isEmpty
    )
  }

  it should "return Some(URI) when the stored URI is non-empty" in {
    val withUri = insertExecution(runtimeStatsUri = "vfs:///stats")
    val result = WorkflowExecutionsResource.getRuntimeStatsUriByExecutionId(
      ExecutionIdentity(withUri.getEid.longValue())
    )
    assert(result.contains(URI.create("vfs:///stats")))
  }

  // ─── new: deleteConsoleMessageAndExecutionResultUris ──────────────────────

  "deleteConsoleMessageAndExecutionResultUris" should "purge both child tables for a given eid" in {
    val execution = insertExecution()
    val eid = ExecutionIdentity(execution.getEid.longValue())

    val globalPortId = GlobalPortIdentity(
      PhysicalOpIdentity(OperatorIdentity("op-purge"), "main"),
      PortIdentity(),
      input = false
    )
    insertOperatorPortResult(
      eid,
      globalPortId,
      URI.create("vfs:///r")
    )
    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      "op-purge",
      URI.create("vfs:///c")
    )

    WorkflowExecutionsResource.deleteConsoleMessageAndExecutionResultUris(eid)

    val resultRows = getDSLContext
      .fetchCount(
        OPERATOR_PORT_EXECUTIONS,
        OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid)
      )
    val consoleRows = getDSLContext
      .fetchCount(
        OPERATOR_EXECUTIONS,
        OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid)
      )
    assert(resultRows == 0)
    assert(consoleRows == 0)
  }

  // ─── new: removeAllExecutionFiles (DB delete branch) ──────────────────────

  "removeAllExecutionFiles" should "delete the listed executions from WORKFLOW_EXECUTIONS" in {
    val a = insertExecution()
    val b = insertExecution()
    // Distractor that should survive.
    val survivor = insertExecution()

    WorkflowExecutionsResource.removeAllExecutionFiles(Array(a.getEid, b.getEid))

    val survivors = workflowExecutionsDao.findAll()
    val survivorEids = survivors.toArray.map(_.asInstanceOf[WorkflowExecutions].getEid).toSet
    assert(!survivorEids.contains(a.getEid))
    assert(!survivorEids.contains(b.getEid))
    assert(survivorEids.contains(survivor.getEid))
  }

  /** Writes a plan table for `execution`, where its row says the plan is, and returns its URI. */
  private def storePlanOf(execution: WorkflowExecutions, warehouse: Option[String] = None): URI = {
    val uri = ExecutionPlanStore.planUri(
      WorkflowIdentity(testWorkflowWid.toLong),
      ExecutionIdentity(execution.getEid.longValue()),
      warehouse
    )
    ExecutionPlanStore.writePlan(
      uri,
      PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        body = "{}",
        createdBy = testUser.getUid,
        computingUnitId = 1,
        notification = None
      ),
      "{}"
    )
    uri
  }

  private def hasPlanTable(uri: URI): Boolean =
    try {
      ExecutionPlanStore.readPlan(uri)
      true
    } catch {
      case _: NoStoredPlanException => false
    }

  it should "drop the plan tables of the executions it removes, and no other's" in {
    val removed = insertExecution()
    val claimed = insertExecution()
    val kept = insertExecution()
    val removedPlan = storePlanOf(removed)
    val claimedPlan = storePlanOf(claimed)
    ExecutionPlanStore.claimStart(claimedPlan)
    val keptPlan = storePlanOf(kept)
    try {
      WorkflowExecutionsResource.removeAllExecutionFiles(Array(removed.getEid, claimed.getEid))

      assert(!hasPlanTable(removedPlan))
      assert(!hasPlanTable(claimedPlan))
      assert(hasPlanTable(keptPlan))
    } finally ExecutionPlanStore.drop(keptPlan)
  }

  it should "leave the plan table of an execution in a per-user warehouse alone while those are disabled" in {
    assume(!StorageConfig.warehouseEnabled, "per-user warehouses are enabled in this deployment")
    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUser.getUid)
    warehouse.setName("plan-drop-warehouse")
    warehouse.setLakekeeperWarehouseName(s"user-${testUser.getUid}-plan-drop-warehouse")
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    val execution = insertExecution(whid = warehouse.getWhid)
    // Under any catalog but the REST one, a warehouse's URI names the same table as the default's.
    val planUri = storePlanOf(execution, Some(warehouse.getLakekeeperWarehouseName))
    try {
      WorkflowExecutionsResource.removeAllExecutionFiles(Array(execution.getEid))

      assert(workflowExecutionsDao.fetchOneByEid(execution.getEid) == null)
      assert(hasPlanTable(planUri))
    } finally ExecutionPlanStore.drop(planUri)
  }

  private def grantAccess(uid: Integer, privilege: PrivilegeEnum): Unit = {
    val access = new WorkflowUserAccess
    access.setUid(uid)
    access.setWid(testWorkflowWid)
    access.setPrivilege(privilege)
    new WorkflowUserAccessDao(getDSLContext.configuration()).insert(access)
  }

  "validateUserCanAccessExecutions" should "authorize by the execution's workflow" in {
    grantAccess(testUserId, PrivilegeEnum.WRITE)
    val execution = insertExecution()
    val eid = execution.getEid
    val otherUserUid = testUserId + 100000

    WorkflowExecutionsResource.validateUserCanAccessExecutions(
      testUserId,
      Seq(eid),
      requireWrite = true
    )

    intercept[ForbiddenException] {
      WorkflowExecutionsResource.validateUserCanAccessExecutions(
        otherUserUid,
        Seq(eid),
        requireWrite = true
      )
    }

    assert(
      !WorkflowExecutionsResource.userCanAccessExecution(
        testUserId,
        eid + 999999,
        requireWrite = false
      )
    )
  }

  it should "handle read" in {
    val readUid = testUserId + 1
    val readUser = new User
    readUser.setUid(readUid)
    readUser.setName("read_only_user")
    readUser.setEmail("readonly-" + UUID.randomUUID().toString.substring(0, 8) + "@example.com")
    userDao.insert(readUser)
    grantAccess(readUid, PrivilegeEnum.READ)
    val execution = insertExecution()
    val eid = execution.getEid

    try {
      assert(WorkflowExecutionsResource.userCanAccessExecution(readUid, eid, requireWrite = false))
      assert(!WorkflowExecutionsResource.userCanAccessExecution(readUid, eid, requireWrite = true))
    } finally {
      getDSLContext
        .deleteFrom(WORKFLOW_USER_ACCESS)
        .where(WORKFLOW_USER_ACCESS.UID.eq(readUid))
        .execute()
      getDSLContext.deleteFrom(USER).where(USER.UID.eq(readUid)).execute()
    }
  }

  // ─── new: updateResultSizeAndCount ────────────────────────────────────────

  "updateResultSizeAndCount" should "set RESULT_SIZE and RESULT_COUNT on the matching (eid, globalPortId) row" in {
    val execution = insertExecution()
    val eid = ExecutionIdentity(execution.getEid.longValue())
    val globalPortId = GlobalPortIdentity(
      PhysicalOpIdentity(OperatorIdentity("op-size"), "main"),
      PortIdentity(),
      input = false
    )
    insertOperatorPortResult(
      eid,
      globalPortId,
      URI.create("vfs:///r")
    )

    WorkflowExecutionsResource.updateResultSizeAndCount(eid, globalPortId, 4096L, 25L)

    val row = getDSLContext
      .selectFrom(OPERATOR_PORT_EXECUTIONS)
      .where(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid))
      .and(OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID.eq(globalPortId.serializeAsString))
      .fetchOne()
    assert(row.getResultSize == 4096)
    assert(row.getResultCount == 25L)
  }

  it should "store a >2GiB size without truncation (#6978)" in {
    val execution = insertExecution()
    val eid = ExecutionIdentity(execution.getEid.longValue())
    val globalPortId = GlobalPortIdentity(
      PhysicalOpIdentity(OperatorIdentity("op-big-size"), "main"),
      PortIdentity(),
      input = false
    )
    insertOperatorPortResult(eid, globalPortId, URI.create("vfs:///big"))

    // 3 GiB exceeds Int.MaxValue; a Long->Int narrowing would wrap it negative.
    val threeGiB = 3L * 1024 * 1024 * 1024
    WorkflowExecutionsResource.updateResultSizeAndCount(eid, globalPortId, threeGiB, 0L)

    val row = getDSLContext
      .selectFrom(OPERATOR_PORT_EXECUTIONS)
      .where(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid))
      .and(OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID.eq(globalPortId.serializeAsString))
      .fetchOne()
    assert(row.getResultSize.longValue() == threeGiB)
  }

  // ─── new: updateRuntimeStatsSize / updateConsoleMessageSize ───────────────

  "updateRuntimeStatsSize" should "store a >2GiB size on the matching execution" in {
    val execution = insertExecution()
    val eid = ExecutionIdentity(execution.getEid.longValue())
    val threeGiB = 3L * 1024 * 1024 * 1024

    WorkflowExecutionsResource.updateRuntimeStatsSize(eid, threeGiB)

    val row = getDSLContext
      .selectFrom(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.eq(execution.getEid))
      .fetchOne()
    assert(row.getRuntimeStatsSize.longValue() == threeGiB)
  }

  it should "leave the size untouched when the execution has no runtime stats URI" in {
    val execution = insertExecution(runtimeStatsUri = null)

    WorkflowExecutionsResource.updateRuntimeStatsSize(
      ExecutionIdentity(execution.getEid.longValue())
    )

    val row = getDSLContext
      .selectFrom(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.eq(execution.getEid))
      .fetchOne()
    // The fixture never set a size, so a no-op leaves the column as inserted.
    assert(row.getRuntimeStatsSize == null)
  }

  it should "open the stored document for measuring when a runtime stats URI is present" in {
    // A URI is present, so the method must reach the document-open call. No
    // document backend exists in this unit environment, so the open fails on
    // the unsupported scheme — proving the branch executed and that the
    // failure propagates instead of degrading into a silent no-op.
    val execution = insertExecution(runtimeStatsUri = "mock:///runtime-stats")

    val ex = intercept[UnsupportedOperationException] {
      WorkflowExecutionsResource.updateRuntimeStatsSize(
        ExecutionIdentity(execution.getEid.longValue())
      )
    }
    assert(ex.getMessage.contains("mock"))
  }

  it should "measure the statistics table a run's record made, and nothing while there is none" in {
    val (exec, uri) = executionWithStatisticsUri()
    val eid = ExecutionIdentity(exec.getEid.longValue())
    def storedSize(): java.lang.Long =
      workflowExecutionsDao.fetchOneByEid(exec.getEid).getRuntimeStatsSize
    RuntimeStatisticsStore.drop(uri)

    // The record has not made the table yet: a result that comes first measures nothing, and
    // does not fail.
    WorkflowExecutionsResource.updateRuntimeStatsSize(eid)
    assert(storedSize() == null)

    RuntimeStatisticsStore.create(uri)
    try {
      RuntimeStatisticsStore.append(
        uri,
        Seq(RuntimeStatisticsRow("scan", 1794873600123L, 0, 0, 10, 100, 5000, 600, 70, 2, 1))
      )
      WorkflowExecutionsResource.updateRuntimeStatsSize(eid)
      assert(storedSize().longValue() > 0)
    } finally RuntimeStatisticsStore.drop(uri)
  }

  "updateConsoleMessageSize" should "store a >2GiB size on the matching (eid, opId) row" in {
    val execution = insertExecution()
    val eid = ExecutionIdentity(execution.getEid.longValue())
    val opId = OperatorIdentity("op-console-size")
    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      opId.id,
      URI.create("vfs:///console-big")
    )

    val threeGiB = 3L * 1024 * 1024 * 1024
    WorkflowExecutionsResource.updateConsoleMessageSize(eid, opId, threeGiB)

    val row = getDSLContext
      .selectFrom(OPERATOR_EXECUTIONS)
      .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid))
      .and(OPERATOR_EXECUTIONS.OPERATOR_ID.eq(opId.id))
      .fetchOne()
    assert(row.getConsoleMessagesSize.longValue() == threeGiB)
  }

  it should "leave the size untouched when the operator has no console messages URI" in {
    val execution = insertExecution()
    val opId = OperatorIdentity("op-no-console-uri")

    WorkflowExecutionsResource.updateConsoleMessageSize(
      ExecutionIdentity(execution.getEid.longValue()),
      opId
    )

    val row = getDSLContext
      .selectFrom(OPERATOR_EXECUTIONS)
      .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(execution.getEid))
      .and(OPERATOR_EXECUTIONS.OPERATOR_ID.eq(opId.id))
      .fetchOne()
    assert(row == null)
  }

  it should "open the stored document for measuring when a console messages URI is present" in {
    // Same shape as the runtime-stats case above: the stored URI forces the
    // document-open call, whose unsupported-scheme failure propagates.
    val execution = insertExecution()
    val opId = OperatorIdentity("op-console-uri")
    WorkflowExecutionsResource.insertOperatorExecutions(
      execution.getEid.longValue(),
      opId.id,
      URI.create("mock:///console")
    )

    val ex = intercept[UnsupportedOperationException] {
      WorkflowExecutionsResource.updateConsoleMessageSize(
        ExecutionIdentity(execution.getEid.longValue()),
        opId
      )
    }
    assert(ex.getMessage.contains("mock"))
  }

  // ─── new: getNonDownloadableOperatorMap (private — via PrivateMethodTester) ─

  "getNonDownloadableOperatorMap" should "flag operators reading non-downloadable datasets they don't own" in {
    // Owner of the non-downloadable dataset is a *different* user than testUser.
    val otherUser = new User
    val otherUid = testUserId + 1
    otherUser.setUid(otherUid)
    otherUser.setName("dataset-owner")
    otherUser.setEmail("owner@example.com")
    userDao.insert(otherUser)

    val dataset = new Dataset
    dataset.setOwnerUid(otherUid)
    dataset.setName("LockedDS")
    dataset.setRepositoryName("repo-locked")
    dataset.setIsPublic(false)
    dataset.setIsDownloadable(false)
    dataset.setDescription("")
    dataset.setCreationTime(new Timestamp(System.currentTimeMillis()))
    datasetDao.insert(dataset)

    // Workflow content: scan op A reading the locked dataset, then a downstream op B.
    val content =
      """{
        |  "operators": [
        |    {"operatorID": "scanA", "operatorProperties": {"fileName": "/dataset/owner@example.com/LockedDS/v1/data.csv"}},
        |    {"operatorID": "downstreamB", "operatorProperties": {}}
        |  ],
        |  "links": [
        |    {"source": {"operatorID": "scanA"}, "target": {"operatorID": "downstreamB"}}
        |  ]
        |}""".stripMargin
    testWorkflow.setContent(content)
    workflowDao.update(testWorkflow)

    val privateMethod =
      PrivateMethod[Map[String, Set[(String, String)]]](Symbol("getNonDownloadableOperatorMap"))
    val result = WorkflowExecutionsResource invokePrivate privateMethod(testWorkflowWid, testUser)

    assert(result.contains("scanA"))
    assert(result("scanA").contains(("owner@example.com", "LockedDS")))
    // BFS propagates the restriction to the downstream operator.
    assert(result.contains("downstreamB"))
  }

  it should "return an empty map when the workflow content is unparseable" in {
    testWorkflow.setContent("not-json")
    workflowDao.update(testWorkflow)

    val privateMethod =
      PrivateMethod[Map[String, Set[(String, String)]]](Symbol("getNonDownloadableOperatorMap"))
    val result = WorkflowExecutionsResource invokePrivate privateMethod(testWorkflowWid, testUser)
    assert(result.isEmpty)
  }

  it should "return an empty map when the workflow has no operators referencing datasets" in {
    val content =
      """{"operators": [{"operatorID": "x", "operatorProperties": {}}], "links": []}"""
    testWorkflow.setContent(content)
    workflowDao.update(testWorkflow)

    val privateMethod =
      PrivateMethod[Map[String, Set[(String, String)]]](Symbol("getNonDownloadableOperatorMap"))
    val result = WorkflowExecutionsResource invokePrivate privateMethod(testWorkflowWid, testUser)
    assert(result.isEmpty)
  }

  it should "skip restriction when the current user is the dataset owner" in {
    // The dataset is owned by testUser (test@example.com), and the operator points
    // to /test@example.com/MyDS/v1/file.csv → no restriction even though
    // is_downloadable=false.
    val dataset = new Dataset
    dataset.setOwnerUid(testUserId)
    dataset.setName("MyDS")
    dataset.setRepositoryName("repo-my")
    dataset.setIsPublic(false)
    dataset.setIsDownloadable(false)
    dataset.setDescription("")
    dataset.setCreationTime(new Timestamp(System.currentTimeMillis()))
    datasetDao.insert(dataset)

    val content =
      """{
        |  "operators": [
        |    {"operatorID": "scan", "operatorProperties": {"fileName": "/dataset/test@example.com/MyDS/v1/data.csv"}}
        |  ],
        |  "links": []
        |}""".stripMargin
    testWorkflow.setContent(content)
    workflowDao.update(testWorkflow)

    val privateMethod =
      PrivateMethod[Map[String, Set[(String, String)]]](Symbol("getNonDownloadableOperatorMap"))
    val result = WorkflowExecutionsResource invokePrivate privateMethod(testWorkflowWid, testUser)
    assert(result.isEmpty)
  }

  it should "return an empty map when no workflow row matches the id" in {
    // The content lookup returns no record, which the method must treat as
    // "nothing to restrict" rather than dereferencing the missing record.
    val privateMethod =
      PrivateMethod[Map[String, Set[(String, String)]]](Symbol("getNonDownloadableOperatorMap"))
    val result =
      WorkflowExecutionsResource invokePrivate privateMethod(testWorkflowWid + 999999, testUser)
    assert(result.isEmpty)
  }

  // ─── new: endpoint auth-annotation audit (#6977) ──────────────────────────

  "WorkflowExecutionsResource endpoints" should "all declare @RolesAllowed and take an @Auth user" in {
    val httpAnnotations: Seq[Class[_ <: java.lang.annotation.Annotation]] =
      Seq(
        classOf[javax.ws.rs.GET],
        classOf[javax.ws.rs.PUT],
        classOf[javax.ws.rs.POST],
        classOf[javax.ws.rs.DELETE]
      )
    val handlers = classOf[WorkflowExecutionsResource].getDeclaredMethods.toSeq
      .filter(m => httpAnnotations.exists(a => m.getAnnotation(a) != null))
    assert(handlers.nonEmpty)

    // exportResultToLocal authenticates manually: it serves a browser form-submit
    // download, which cannot carry an Authorization header, so the JWT arrives as
    // a form field and is verified in-method via JwtParser.parseToken (including
    // the role check). Any other handler must use the declarative annotations.
    val manuallyAuthenticated = Set("exportResultToLocal")

    val offenders = handlers.filterNot(m => manuallyAuthenticated.contains(m.getName)).filter { m =>
      val hasRoles =
        m.getAnnotation(classOf[javax.annotation.security.RolesAllowed]) != null
      val hasAuthParam = m.getParameterAnnotations.exists(
        _.exists(_.annotationType() == classOf[io.dropwizard.auth.Auth])
      )
      !(hasRoles && hasAuthParam)
    }
    assert(
      offenders.isEmpty,
      s"endpoints missing @RolesAllowed/@Auth: ${offenders.map(_.getName).sorted.mkString(", ")}"
    )
  }

  // The whitelist above exempts exportResultToLocal from the declarative-auth check, so
  // its transport contract is pinned here instead. The browser posts a hidden form
  // (frontend download.service.ts) with enctype application/x-www-form-urlencoded and
  // inputs named exactly "request" and "token"; renaming either parameter or dropping
  // @Consumes still compiles and still passes every direct-call case in this file, while
  // in production the handler stops receiving a body at all.
  it should "read exportResultToLocal's payload from the form fields the frontend posts" in {
    val exportToLocal = classOf[WorkflowExecutionsResource].getDeclaredMethods.toSeq
      .find(_.getName == "exportResultToLocal")
      .getOrElse(fail("exportResultToLocal handler not found"))

    val consumes = exportToLocal.getAnnotation(classOf[javax.ws.rs.Consumes])
    assert(consumes != null, "exportResultToLocal must declare @Consumes")
    assert(
      consumes.value().toSeq == Seq(javax.ws.rs.core.MediaType.APPLICATION_FORM_URLENCODED)
    )

    val formParamNames = exportToLocal.getParameterAnnotations.toSeq.map(
      _.collectFirst { case formParam: javax.ws.rs.FormParam => formParam.value() }
    )
    assert(formParamNames == Seq(Some("request"), Some("token")))
  }

  // ─── access-controlled instance endpoints (jOOQ metadata only) ─────────────
  // The result/log-URI and replay paths (DocumentFactory / ReplayLogRecord) are
  // out of scope; these cover the DB-metadata portion of each endpoint.

  private val resource = new WorkflowExecutionsResource

  private def session(user: User): SessionUser = new SessionUser(user)

  private def grantReadAccess(uid: Integer = testUserId): Unit =
    getDSLContext
      .insertInto(WORKFLOW_USER_ACCESS)
      .set(WORKFLOW_USER_ACCESS.WID, Integer.valueOf(testWorkflowWid))
      .set(WORKFLOW_USER_ACCESS.UID, uid)
      .set(WORKFLOW_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()

  private def grantWriteAccess(uid: Integer = testUserId): Unit =
    getDSLContext
      .insertInto(WORKFLOW_USER_ACCESS)
      .set(WORKFLOW_USER_ACCESS.WID, Integer.valueOf(testWorkflowWid))
      .set(WORKFLOW_USER_ACCESS.UID, uid)
      .set(WORKFLOW_USER_ACCESS.PRIVILEGE, PrivilegeEnum.WRITE)
      .execute()

  private def userWithoutAccess(): User = {
    val u = new User
    u.setUid(testUserId + 5000)
    u.setName("no_access_user")
    u.setEmail("noaccess@example.com")
    u
  }

  "retrieveExecutionsOfWorkflow" should "return an empty list when the user lacks read access" in {
    val result =
      resource.retrieveExecutionsOfWorkflow(testWorkflowWid, session(userWithoutAccess()), null)
    assert(result.isEmpty)
  }

  it should "return the workflow's executions for an authorized user" in {
    grantReadAccess()
    insertExecution()
    insertExecution()
    val result = resource.retrieveExecutionsOfWorkflow(testWorkflowWid, session(testUser), null)
    assert(result.size == 2)
  }

  // fetchInto maps onto WorkflowExecutionEntry POSITIONALLY (a case class has no no-arg
  // constructor, and jOOQ's mapConstructorParameterNames defaults to false), so `USER.AVATAR`
  // at projection position 5 lands on `avatar` despite the names differing — exactly as
  // `last_update_time` at position 9 lands on `completionTime`. Neither mapping was asserted
  // anywhere before, which is what makes an accidental column reorder silent. Pin both here.
  it should "map the owner's avatar and completion time onto the entry despite the name mismatch" in {
    grantReadAccess()
    insertExecution(lastUpdateOffsetMillis = Some(0L))
    val entry = resource.retrieveExecutionsOfWorkflow(testWorkflowWid, session(testUser), null).head
    assert(entry.userName == testUser.getName)
    assert(entry.avatar == "avatar_url")
    // `last_update_time` is populated, so a null here would mean position 9 never reached
    // `completionTime` — i.e. the mapping had silently become name-based.
    assert(entry.completionTime != null)
  }

  // The editor asks for these two states to decide whether to lock a workflow that is opened.
  it should "leave a created execution out of the running and initializing ones" in {
    grantReadAccess()
    val initializing = insertExecution(status = WorkflowExecutionStatus.Initializing.toByte)
    val running = insertExecution(status = WorkflowExecutionStatus.Running.toByte)
    insertExecution(status = WorkflowExecutionStatus.Created.toByte)

    val inProgress = resource.retrieveExecutionsOfWorkflow(
      testWorkflowWid,
      session(testUser),
      "running,initializing"
    )

    assert(inProgress.map(_.eId).toSet == Set(initializing.getEid, running.getEid))
    // It is still part of the workflow's history.
    assert(
      resource.retrieveExecutionsOfWorkflow(testWorkflowWid, session(testUser), null).size == 3
    )
  }

  it should "reject an invalid status filter with a BadRequestException" in {
    grantReadAccess()
    assertThrows[BadRequestException](
      resource.retrieveExecutionsOfWorkflow(
        testWorkflowWid,
        session(testUser),
        "definitely-not-a-status"
      )
    )
  }

  "retrieveLatestExecutionEntry" should "throw ForbiddenException when the workflow has no executions" in {
    grantReadAccess()
    assertThrows[ForbiddenException](
      resource.retrieveLatestExecutionEntry(testWorkflowWid, session(testUser))
    )
  }

  it should "return the most recently created execution entry" in {
    grantReadAccess()
    insertExecution(name = "first")
    val latest = insertExecution(name = "second")
    val entry = resource.retrieveLatestExecutionEntry(testWorkflowWid, session(testUser))
    // same VID, so the highest EID is the latest
    assert(entry.eId == latest.getEid)
    assert(entry.name == "second")
  }

  it should "expose the execution's warehouse (whId) for last-used preselection" in {
    grantReadAccess()
    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUser.getUid)
    warehouse.setName("latest-entry-warehouse")
    warehouse.setLakekeeperWarehouseName(s"user-${testUser.getUid}-latest-entry-warehouse")
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()

    insertExecution(name = "warehouse-run", whid = warehouse.getWhid)
    val entry = resource.retrieveLatestExecutionEntry(testWorkflowWid, session(testUser))
    assert(entry.whId == warehouse.getWhid)

    insertExecution(name = "default-run")
    val defaultEntry = resource.retrieveLatestExecutionEntry(testWorkflowWid, session(testUser))
    assert(defaultEntry.whId == null)
  }

  // The execution this case points at DOES have a replay log, and that log's scheme is
  // one the storage layer rejects. An empty list is therefore only reachable by
  // refusing before the lookup: drop the access check and the unauthorized caller
  // reaches SequentialRecordStorage and throws instead of returning nothing.
  "retrieveInteractionHistory" should "return an empty list when the user lacks read access" in {
    val exec = insertExecution(logLocation = "mock:///replay")
    val result =
      resource.retrieveInteractionHistory(
        testWorkflowWid,
        exec.getEid,
        session(userWithoutAccess())
      )
    assert(result.isEmpty)
  }

  it should "return an empty list when the requested execution does not exist" in {
    grantReadAccess()
    val result = resource.retrieveInteractionHistory(
      testWorkflowWid,
      Integer.valueOf(Int.MaxValue),
      session(testUser)
    )
    assert(result.isEmpty)
  }

  it should "return an empty list when the execution belongs to a different workflow" in {
    grantReadAccess()
    // Without the execution-to-workflow check, the endpoint tries to open this invalid
    // log URI. An empty result therefore proves it refused the foreign execution first.
    val foreign = insertForeignExecution(logLocation = "mock:///foreign-replay")
    val result =
      resource.retrieveInteractionHistory(testWorkflowWid, foreign.getEid, session(testUser))
    assert(result.isEmpty)
  }

  it should "return an empty list when the execution stored no replay log" in {
    // log_location is empty, so the replay-log storage must not be opened at all:
    // handing "" to SequentialRecordStorage would fail rather than yield nothing.
    grantReadAccess()
    val exec = insertExecution(logLocation = "")
    val result =
      resource.retrieveInteractionHistory(testWorkflowWid, exec.getEid, session(testUser))
    assert(result.isEmpty)
  }

  it should "return an empty list when log_location is NULL" in {
    // `log_location` is nullable with no default (sql/texera_ddl.sql), so jOOQ can hand
    // back null here. The null half of the guard is what keeps `null.nonEmpty` — an NPE
    // via augmentString — from reaching the caller; the empty-string case above cannot
    // observe it.
    grantReadAccess()
    val exec = insertExecution(logLocation = null)
    val result =
      resource.retrieveInteractionHistory(testWorkflowWid, exec.getEid, session(testUser))
    assert(result.isEmpty)
  }

  // The endpoint's only real product is the list of ECM ids read out of the replay log,
  // and nothing in the repo observed it — so a body that always answered `List()` was
  // indistinguishable from a working one. Write a real two-record log and read it back.
  it should "return the replay destinations recorded in the execution's log, in order" in {
    grantReadAccess()
    val root = Files.createTempDirectory("workflow-executions-resource-spec-replay-")
    try {
      val logUri = root.resolve("logs").toUri
      withAmberSerde {
        val storage = new VFSRecordStorage[ReplayLogRecord](logUri)
        // The endpoint reads the reserved "COORDINATOR" file out of the log folder.
        val writer = storage.getWriter("COORDINATOR")
        try {
          writer.writeRecord(ReplayDestination(EmbeddedControlMessageIdentity("ecm-1")))
          writer.writeRecord(ReplayDestination(EmbeddedControlMessageIdentity("ecm-2")))
          writer.flush()
        } finally {
          writer.close()
        }

        val exec = insertExecution(logLocation = logUri.toString)
        val result =
          resource.retrieveInteractionHistory(testWorkflowWid, exec.getEid, session(testUser))
        assert(result == List("ecm-1", "ecm-2"))
      }
    } finally {
      deleteRecursively(root.toFile)
    }
  }

  "setExecutionAreBookmarked" should "reject a user without access" in {
    val exec = insertExecution()
    assertThrows[ForbiddenException](
      resource.setExecutionAreBookmarked(
        ExecutionGroupBookmarkRequest(testWorkflowWid, Array(exec.getEid), isBookmarked = false),
        session(userWithoutAccess())
      )
    )
  }

  it should "refuse a read-only user with 403, since the frontend logs out on 401" in {
    grantReadAccess()
    val exec = insertExecution()
    assertThrows[ForbiddenException](
      resource.setExecutionAreBookmarked(
        ExecutionGroupBookmarkRequest(testWorkflowWid, Array(exec.getEid), isBookmarked = false),
        session(testUser)
      )
    )
    assert(workflowExecutionsDao.fetchOneByEid(exec.getEid).getBookmarked == false)
  }

  it should "bookmark executions that are currently un-bookmarked" in {
    grantWriteAccess()
    val exec = insertExecution() // bookmarked = false
    resource.setExecutionAreBookmarked(
      ExecutionGroupBookmarkRequest(testWorkflowWid, Array(exec.getEid), isBookmarked = false),
      session(testUser)
    )
    assert(workflowExecutionsDao.fetchOneByEid(exec.getEid).getBookmarked == true)
  }

  it should "un-bookmark executions that are currently bookmarked" in {
    grantWriteAccess()
    val exec = insertExecution()
    resource.setExecutionAreBookmarked(
      ExecutionGroupBookmarkRequest(testWorkflowWid, Array(exec.getEid), isBookmarked = true),
      session(testUser)
    )
    assert(workflowExecutionsDao.fetchOneByEid(exec.getEid).getBookmarked == false)
  }

  "updateWorkflowExecutionsName" should "rename the execution" in {
    grantWriteAccess()
    val exec = insertExecution(name = "old-name")
    resource.updateWorkflowExecutionsName(
      ExecutionRenameRequest(testWorkflowWid, exec.getEid, "new-name"),
      session(testUser)
    )
    assert(workflowExecutionsDao.fetchOneByEid(exec.getEid).getName == "new-name")
  }

  "groupDeleteExecutionsOfWorkflow" should "delete the execution rows" in {
    grantWriteAccess()
    val e1 = insertExecution()
    val e2 = insertExecution()
    resource.groupDeleteExecutionsOfWorkflow(
      ExecutionGroupDeleteRequest(testWorkflowWid, Array(e1.getEid, e2.getEid)),
      session(testUser)
    )
    assert(workflowExecutionsDao.fetchOneByEid(e1.getEid) == null)
    assert(workflowExecutionsDao.fetchOneByEid(e2.getEid) == null)
  }

  // The statistics of an execution are where its ids and its warehouse say, in the lake: the
  // row names no location, and the route asks no computing unit.

  /** Where the statistics of `execution`, an execution of workflow `wid`, are. */
  private def statisticsUriOf(execution: WorkflowExecutions, wid: Int = testWorkflowWid): URI =
    RuntimeStatisticsStore.statisticsUri(
      WorkflowIdentity(wid.longValue()),
      ExecutionIdentity(execution.getEid.longValue()),
      None
    )

  /** An execution of the test workflow, and where its statistics are. */
  private def executionWithStatistics(): (WorkflowExecutions, URI) = {
    val exec = insertExecution()
    (exec, statisticsUriOf(exec))
  }

  private val scanSample =
    RuntimeStatisticsRow("scan", 1794873600123L, 0, 0, 10, 100, 5, 6, 7, 2, 3)

  "retrieveWorkflowRuntimeStatistics" should "reject a user with no read access on the workflow" in {
    // The stored row is load-bearing: without the access check the call answers it.
    val (exec, uri) = executionWithStatistics()
    RuntimeStatisticsStore.create(uri)
    try {
      RuntimeStatisticsStore.append(uri, Seq(scanSample))

      val refusal = intercept[WebApplicationException](
        resource.retrieveWorkflowRuntimeStatistics(
          testWorkflowWid,
          exec.getEid,
          session(userWithoutAccess())
        )
      )
      assert(refusal.getResponse.getStatus == Response.Status.UNAUTHORIZED.getStatusCode)
    } finally RuntimeStatisticsStore.drop(uri)
  }

  // The read path must refuse an execution of another workflow, or read access on any
  // workflow would expose every other workflow's operator ids, tuple counts and timings
  // by execution id alone.
  it should "refuse an execution that is another workflow's, as one there is not" in {
    grantReadAccess()
    val foreign = insertForeignExecution()
    // Its statistics are there to be read, wherever a lookup that forgot the workflow looks.
    val uris = Seq(statisticsUriOf(foreign, foreignWid), statisticsUriOf(foreign))
    uris.foreach(RuntimeStatisticsStore.create)
    try {
      uris.foreach(RuntimeStatisticsStore.append(_, Seq(scanSample)))

      Seq(foreign.getEid.intValue(), foreign.getEid + 100000).foreach { eid =>
        val refusal = intercept[NotFoundException](
          resource.retrieveWorkflowRuntimeStatistics(testWorkflowWid, eid, session(testUser))
        )
        assert(refusal.getMessage == s"Workflow $testWorkflowWid has no execution $eid.")
        assert(refusal.getResponse.getStatus == 404)
      }
    } finally uris.foreach(RuntimeStatisticsStore.drop)
  }

  // Per-user warehouses are off in this deployment (#6930): a read of statistics
  // that live in one must fail loudly and name the warehouse, because opening it
  // anyway resolves to the shared default and looks like data loss.
  it should "refuse to read statistics stored in a per-user warehouse while the feature is off" in {
    grantReadAccess()
    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUser.getUid)
    warehouse.setName("statistics-warehouse")
    warehouse.setLakekeeperWarehouseName("byo")
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    val exec = insertExecution(whid = warehouse.getWhid)

    val ex = intercept[WarehouseUnavailableException](
      resource.retrieveWorkflowRuntimeStatistics(testWorkflowWid, exec.getEid, session(testUser))
    )
    assert(
      ex.getMessage ==
        "this result is stored in warehouse 'byo'; " +
          "per-user warehouses are disabled in this deployment"
    )
  }

  it should "read the statistics where the execution's ids say, whatever its row names as their location" in {
    grantReadAccess()
    // The column a unit used to write: left empty, and then naming a place nothing is at.
    val unnamed = insertExecution()
    val misnamed = insertExecution(runtimeStatsUri = "mock:///stats")
    val uris = Seq(unnamed, misnamed).map(statisticsUriOf(_))
    uris.foreach(RuntimeStatisticsStore.create)
    try {
      uris.foreach(RuntimeStatisticsStore.append(_, Seq(scanSample)))

      Seq(unnamed, misnamed).foreach { exec =>
        val rows =
          resource.retrieveWorkflowRuntimeStatistics(
            testWorkflowWid,
            exec.getEid,
            session(testUser)
          )
        assert(rows.map(_.operatorId) == Seq("scan"))
      }
    } finally uris.foreach(RuntimeStatisticsStore.drop)
  }

  it should "find the execution in one read of its row, without the column that named its statistics" in {
    grantReadAccess()
    val (exec, _) = executionWithStatistics()

    val statements = recorder.record {
      resource.retrieveWorkflowRuntimeStatistics(testWorkflowWid, exec.getEid, session(testUser))
    }

    assert(statements.forall(_.verb == "SELECT"))
    assert(statements.count(_.tables.contains("workflow_executions")) == 1)
    assert(!statements.exists(_.sql.toLowerCase.contains("runtime_stats_uri")))
  }

  /**
    * An execution of the test workflow whose row names where its statistics are, as a unit
    * that measures them reads it.
    */
  private def executionWithStatisticsUri(): (WorkflowExecutions, URI) = {
    val exec = insertExecution()
    val uri = RuntimeStatisticsStore.statisticsUri(
      WorkflowIdentity(testWorkflowWid.longValue()),
      ExecutionIdentity(exec.getEid.longValue()),
      None
    )
    exec.setRuntimeStatsUri(uri.toString)
    workflowExecutionsDao.update(exec)
    (exec, uri)
  }

  it should "return the rows a run's record stored, oldest first, each with its time to the millisecond" in {
    grantReadAccess()
    val (exec, uri) = executionWithStatistics()
    // Two commits of a run: the scan's numbers moved between them, the filter's state alone.
    val firstCommitMs = 1794873600123L
    val stored = Seq(
      RuntimeStatisticsRow("scan", firstCommitMs, 0, 0, 10, 100, 5000, 600, 70, 2, 1),
      RuntimeStatisticsRow("filter", firstCommitMs, 10, 100, 4, 40, 3000, 200, 10, 1, 1),
      RuntimeStatisticsRow("scan", firstCommitMs + 30456, 0, 0, 25, 250, 9000, 800, 90, 2, 3),
      RuntimeStatisticsRow("filter", firstCommitMs + 30456, 10, 100, 4, 40, 3000, 200, 10, 1, 3)
    )
    RuntimeStatisticsStore.create(uri)
    try {
      RuntimeStatisticsStore.append(uri, stored.take(2))
      RuntimeStatisticsStore.append(uri, stored.drop(2))

      val rows =
        resource.retrieveWorkflowRuntimeStatistics(testWorkflowWid, exec.getEid, session(testUser))

      assert(
        rows == stored.map(row =>
          WorkflowExecutionsResource.WorkflowRuntimeStatistics(
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
      )
      // Epoch milliseconds, as the browser is sent them: not rounded to the second.
      assert(rows.map(_.timestamp.getTime).distinct == Seq(firstCommitMs, firstCommitMs + 30456))
    } finally RuntimeStatisticsStore.drop(uri)
  }

  it should "return no rows for an execution whose statistics were stored before a run's record stored them" in {
    // An execution made before the upgrade: its table is where the store reads, with its time
    // a timestamp in a column of another name. It has no chart, and the request does not fail.
    grantReadAccess()
    val (exec, uri) = executionWithStatistics()
    val earlierSchema = new Schema(
      new Attribute("operatorId", AttributeType.STRING),
      new Attribute("time", AttributeType.TIMESTAMP),
      new Attribute("inputTupleCnt", AttributeType.LONG),
      new Attribute("inputTupleSize", AttributeType.LONG),
      new Attribute("outputTupleCnt", AttributeType.LONG),
      new Attribute("outputTupleSize", AttributeType.LONG),
      new Attribute("dataProcessingTime", AttributeType.LONG),
      new Attribute("controlProcessingTime", AttributeType.LONG),
      new Attribute("idleTime", AttributeType.LONG),
      new Attribute("numWorkers", AttributeType.INTEGER),
      new Attribute("status", AttributeType.INTEGER)
    )
    val writer = DocumentFactory
      .createDocument(uri, earlierSchema)
      .writer("an-earlier-version")
      .asInstanceOf[BufferedItemWriter[Tuple]]
    try {
      writer.open()
      writer.putOne(
        new Tuple(
          earlierSchema,
          Array("scan", new Timestamp(1794873600000L), 0L, 0L, 10L, 100L, 5000L, 600L, 70L, 2, 3)
        )
      )
      writer.close()

      assert(
        resource
          .retrieveWorkflowRuntimeStatistics(testWorkflowWid, exec.getEid, session(testUser))
          .isEmpty
      )
    } finally RuntimeStatisticsStore.drop(uri)
  }

  it should "return no rows for an execution whose statistics table is not there" in {
    // A run that has not made its tables yet, or whose tables were dropped.
    grantReadAccess()
    val (exec, uri) = executionWithStatistics()
    RuntimeStatisticsStore.drop(uri)

    assert(
      resource
        .retrieveWorkflowRuntimeStatistics(testWorkflowWid, exec.getEid, session(testUser))
        .isEmpty
    )
  }

  // ─── new: getWorkflowResultDownloadability ────────────────────────────────

  private val foreignOwnerEmail = "owner2@example.com"

  private def seedForeignDatasetOwner(): Integer = {
    val ownerUid = Integer.valueOf(testUserId + 2)
    getDSLContext.deleteFrom(USER).where(USER.UID.eq(ownerUid)).execute()
    val owner = new User
    owner.setUid(ownerUid)
    owner.setName("restricted_ds_owner")
    owner.setEmail(foreignOwnerEmail)
    userDao.insert(owner)
    ownerUid
  }

  private def seedForeignDataset(ownerUid: Integer, name: String, downloadable: Boolean): Unit = {
    val dataset = new Dataset
    dataset.setOwnerUid(ownerUid)
    dataset.setName(name)
    dataset.setRepositoryName(s"repo-$name")
    dataset.setIsPublic(false)
    dataset.setIsDownloadable(downloadable)
    dataset.setDescription("")
    dataset.setCreationTime(new Timestamp(System.currentTimeMillis()))
    datasetDao.insert(dataset)
  }

  private def scanOperator(operatorId: String, datasetName: String): String =
    s"""{"operatorID": "$operatorId", "operatorProperties": """ +
      s"""{"fileName": "/dataset/$foreignOwnerEmail/$datasetName/v1/data.csv"}}"""

  // Seeds three datasets owned by somebody other than testUser and wires the workflow as
  //
  //   scanA -> LockedDS  (foreign, NOT downloadable) --\
  //                                                     >-- downstreamB
  //   scanC -> LockedDS2 (foreign, NOT downloadable) --/
  //   scanD -> OpenDS    (foreign, downloadable)         (unrestricted, no links)
  //
  // scanD is what makes the is_downloadable predicate observable — every other dataset
  // fixture in this file is non-downloadable, so without it "restricted" and "foreign"
  // are the same set. The two restricted scans meeting at downstreamB are what make the
  // per-operator union observable, since one restricted source cannot tell a merge from
  // an overwrite.
  private def seedRestrictedWorkflow(): Unit = {
    val ownerUid = seedForeignDatasetOwner()
    seedForeignDataset(ownerUid, "LockedDS", downloadable = false)
    seedForeignDataset(ownerUid, "LockedDS2", downloadable = false)
    seedForeignDataset(ownerUid, "OpenDS", downloadable = true)

    testWorkflow.setContent(
      s"""{
         |  "operators": [
         |    ${scanOperator("scanA", "LockedDS")},
         |    ${scanOperator("scanC", "LockedDS2")},
         |    ${scanOperator("scanD", "OpenDS")},
         |    {"operatorID": "downstreamB", "operatorProperties": {}}
         |  ],
         |  "links": [
         |    {"source": {"operatorID": "scanA"}, "target": {"operatorID": "downstreamB"}},
         |    {"source": {"operatorID": "scanC"}, "target": {"operatorID": "downstreamB"}}
         |  ]
         |}""".stripMargin
    )
    workflowDao.update(testWorkflow)
  }

  "getWorkflowResultDownloadability" should "reject a user without read access" in {
    assertThrows[WebApplicationException](
      resource.getWorkflowResultDownloadability(testWorkflowWid, session(userWithoutAccess()))
    )
  }

  // The label format is a contract with the frontend, which renders the strings
  // verbatim, so it is pinned here rather than left to the caller to reconstruct.
  it should "label every restricted operator with 'datasetName (ownerEmail)'" in {
    grantReadAccess()
    seedRestrictedWorkflow()

    val response = resource.getWorkflowResultDownloadability(testWorkflowWid, session(testUser))
    assert(response.getStatus == 200)

    val body = response.getEntity.asInstanceOf[java.util.Map[String, Array[String]]]
    assert(body.get("scanA").toSeq == Seq(s"LockedDS ($foreignOwnerEmail)"))
    assert(body.get("scanC").toSeq == Seq(s"LockedDS2 ($foreignOwnerEmail)"))
    // Two restricted scans feed downstreamB, so its entry is the union of both; an
    // implementation that overwrote instead of merging would list whichever arrived
    // last, which is why the value type is a Set.
    assert(
      body.get("downstreamB").toSet ==
        Set(s"LockedDS ($foreignOwnerEmail)", s"LockedDS2 ($foreignOwnerEmail)")
    )
    // OpenDS is foreign too, but downloadable — so scanD is not restricted at all.
    assert(!body.containsKey("scanD"))
  }

  // Loop workflows put a LoopEnd -> LoopStart back edge into exactly the `links` array
  // this endpoint walks, so a cycle is not hypothetical. Propagation stops once an
  // operator's restriction set stops growing; without that check the queue cycles
  // forever and the request thread wedges, so the call is made off-thread and the case
  // fails on timeout instead of hanging the suite.
  it should "terminate on a workflow whose links form a cycle" in {
    grantReadAccess()
    val ownerUid = seedForeignDatasetOwner()
    seedForeignDataset(ownerUid, "CycleDS", downloadable = false)
    testWorkflow.setContent(
      s"""{
         |  "operators": [
         |    ${scanOperator("scanA", "CycleDS")},
         |    {"operatorID": "b", "operatorProperties": {}},
         |    {"operatorID": "c", "operatorProperties": {}}
         |  ],
         |  "links": [
         |    {"source": {"operatorID": "scanA"}, "target": {"operatorID": "b"}},
         |    {"source": {"operatorID": "b"}, "target": {"operatorID": "c"}},
         |    {"source": {"operatorID": "c"}, "target": {"operatorID": "scanA"}}
         |  ]
         |}""".stripMargin
    )
    workflowDao.update(testWorkflow)

    val call = Future(
      resource.getWorkflowResultDownloadability(testWorkflowWid, session(testUser))
    )(ExecutionContext.global)
    val response = Await.result(call, 30.seconds)

    val body = response.getEntity.asInstanceOf[java.util.Map[String, Array[String]]]
    assert(body.size() == 3)
    assert(body.containsKey("scanA") && body.containsKey("b") && body.containsKey("c"))
  }

  // ─── new: result-export endpoints ─────────────────────────────────────────

  private def exportRequest(
      operators: List[OperatorExportInfo],
      executionId: Long
  ): ResultExportRequest =
    ResultExportRequest(
      exportType = "csv",
      workflowId = testWorkflowWid,
      workflowName = "export-spec-workflow",
      operators = operators,
      datasetIds = List.empty,
      rowIndex = 0,
      columnIndex = 0,
      filename = "",
      executionId = executionId
    )

  private val oneOperator = List(OperatorExportInfo("op-1", "csv"))
  private val twoOperators =
    List(OperatorExportInfo("op-1", "csv"), OperatorExportInfo("op-2", "csv"))

  // Mirrors what JwtAuth.jwtClaims writes at issue time, so the token below is
  // one the production consumer accepts.
  private def tokenFor(role: UserRoleEnum): String = {
    val claims = new JwtClaims
    claims.setSubject(testUser.getName)
    claims.setClaim("userId", testUser.getUid)
    claims.setClaim("email", testUser.getEmail)
    claims.setClaim("role", role.name)
    claims.setClaim("avatar", testUser.getAvatar)
    claims.setExpirationTimeMinutesInTheFuture(10f)
    JwtAuth.jwtToken(claims)
  }

  private def errorOf(response: Response): String =
    response.getEntity.asInstanceOf[java.util.Map[String, String]].get("error")

  /** The form a browser posts to download `request`, as a regular user. */
  private def exportToLocal(request: ResultExportRequest): Response =
    resource.exportResultToLocal(
      Json.stringify(Json.toJson(request)),
      tokenFor(UserRoleEnum.REGULAR)
    )

  private def exportToDataset(request: ResultExportRequest): Response =
    resource.exportResultToDataset(
      request,
      s"Bearer ${tokenFor(UserRoleEnum.REGULAR)}",
      session(testUser)
    )

  /** Marks the results of `execution` expired, as the Dashboard's expiry does. */
  private def expireResultsOf(execution: WorkflowExecutions): Unit =
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.ENDED_AT, new Timestamp(System.currentTimeMillis() - 86400000L))
      .set(WORKFLOW_EXECUTIONS.OUTCOME, Short.box(WorkflowExecutionStatus.Completed))
      .set(WORKFLOW_EXECUTIONS.RESULTS_EXPIRED_AT, new Timestamp(System.currentTimeMillis()))
      .where(WORKFLOW_EXECUTIONS.EID.eq(execution.getEid))
      .execute()

  // This endpoint is reached by a browser form submit, which cannot carry an
  // Authorization header, so the JWT arrives as a form field and every failure
  // has to come back as a JSON body rather than as an escaping exception.
  "exportResultToLocal" should "answer an unverifiable token with a 500 JSON error" in {
    val response =
      resource.exportResultToLocal(Json.stringify(Json.toJson(exportRequest(Nil, 0))), "not-a-jwt")
    assert(response.getStatus == 500)
    assert(errorOf(response) == "Invalid or expired token")
  }

  it should "answer a verified token whose role is below REGULAR with a 500 JSON error" in {
    Seq(UserRoleEnum.RESTRICTED, UserRoleEnum.INACTIVE).foreach { role =>
      val response = resource.exportResultToLocal(
        Json.stringify(Json.toJson(exportRequest(Nil, 0))),
        tokenFor(role)
      )
      assert(response.getStatus == 500, s"role $role")
      assert(
        errorOf(response) == "User role is not allowed to perform this download",
        s"role $role"
      )
    }
  }

  // Both allowed roles, not just REGULAR: shrinking the allow-list locks admins out of
  // every result download, and a one-sided test cannot see a removal.
  it should "let every allowed role past the role gate" in {
    grantReadAccess()
    Seq(UserRoleEnum.REGULAR, UserRoleEnum.ADMIN).foreach { role =>
      val response = resource.exportResultToLocal(
        Json.stringify(Json.toJson(exportRequest(oneOperator, 0))),
        tokenFor(role)
      )
      assert(
        errorOf(response) != "User role is not allowed to perform this download",
        s"role $role was rejected by the role gate"
      )
    }
  }

  it should "parse the form-encoded request and export the execution it names once the token checks out" in {
    grantReadAccess()
    val execution = insertExecution()

    // Two operators, so the request takes the zip branch, which only reaches a 200 once
    // the workflow id and the execution id off the parsed body find an execution of the
    // workflow.
    val response = exportToLocal(exportRequest(twoOperators, execution.getEid.longValue()))
    assert(response.getStatus == 200)
    val disposition = response.getHeaderString("Content-Disposition")
    // The name is built from the request's own workflowName, so a body the endpoint
    // ignored in favour of a hard-coded request would not produce it.
    assert(disposition.startsWith("attachment; filename=\"export-spec-workflow-"))
    assert(disposition.endsWith(".zip\""))
  }

  it should "refuse a request that names no execution" in {
    grantReadAccess()
    val unnamed = Json.toJson(exportRequest(twoOperators, 1)).as[play.api.libs.json.JsObject] -
      "executionId"

    val response =
      resource.exportResultToLocal(Json.stringify(unnamed), tokenFor(UserRoleEnum.REGULAR))
    assert(response.getStatus == 500)
    assert(errorOf(response).contains("executionId"))
  }

  it should "deny a valid download request from a user without workflow read access" in {
    val execution = insertExecution()

    val response = exportToLocal(exportRequest(twoOperators, execution.getEid.longValue()))
    assert(response.getStatus == Response.Status.UNAUTHORIZED.getStatusCode)
  }

  // The execution is named by the request, so read access to one workflow must not reach
  // the results of another's execution, and an id that names none is answered the same.
  it should "answer 404 for an execution that is not the workflow's, in one file or in an archive" in {
    grantReadAccess()
    val foreign = insertForeignExecution().getEid.longValue()

    for (eid <- Seq(foreign, foreign + 100000L, 0L); operators <- Seq(oneOperator, twoOperators)) {
      val response = exportToLocal(exportRequest(operators, eid))
      assert(response.getStatus == 404, s"execution $eid, ${operators.size} operator(s)")
      assert(errorOf(response) == s"Workflow $testWorkflowWid has no execution $eid.")
    }
  }

  it should "answer 410 for an execution whose results have expired, in one file or in an archive" in {
    grantReadAccess()
    val execution = insertExecution()
    val eid = execution.getEid.longValue()
    // Not expired yet: an operator that stored nothing is the single-file branch's 500.
    assert(exportToLocal(exportRequest(oneOperator, eid)).getStatus == 500)
    assert(exportToLocal(exportRequest(twoOperators, eid)).getStatus == 200)

    expireResultsOf(execution)

    Seq(oneOperator, twoOperators).foreach { operators =>
      val response = exportToLocal(exportRequest(operators, eid))
      assert(response.getStatus == 410, s"${operators.size} operator(s)")
      assert(errorOf(response) == s"the results of execution $eid have expired")
    }
  }

  it should "report an operator that stored no result as a 500 JSON error" in {
    // One operator takes the streaming branch, whose "nothing stored" outcome is reported
    // through the JSON error body rather than as an escaping exception.
    grantReadAccess()
    val execution = insertExecution()

    val response = exportToLocal(exportRequest(oneOperator, execution.getEid.longValue()))
    assert(response.getStatus == 500)
    assert(errorOf(response) == "Failed to export operator")
  }

  "exportResultToDataset" should "report a per-operator failure inside a 200 response" in {
    grantReadAccess()
    val execution = insertExecution()

    val response = exportToDataset(exportRequest(oneOperator, execution.getEid.longValue()))
    assert(response.getStatus == 200)

    val body = response.getEntity.asInstanceOf[ResultExportResponse]
    assert(body.status == "error")
    // The execution was found — i.e. the workflow id and the execution id the request
    // named both reached the lookup — it just holds no result for op-1.
    assert(body.message.contains("No results to export"))
  }

  it should "deny an export request from a user without workflow read access" in {
    // No operators are needed: before the fix this returns a spurious 200 success
    // without consulting workflow access at all.
    val response = exportToDataset(exportRequest(Nil, 0))
    assert(response.getStatus == Response.Status.UNAUTHORIZED.getStatusCode)
  }

  it should "answer 404 for an execution that is not the workflow's, not a 200 that lists failures" in {
    grantReadAccess()
    val foreign = insertForeignExecution().getEid.longValue()

    Seq(foreign, foreign + 100000L, 0L).foreach { eid =>
      val response = exportToDataset(exportRequest(oneOperator, eid))
      assert(response.getStatus == 404, s"execution $eid")
      assert(errorOf(response) == s"Workflow $testWorkflowWid has no execution $eid.")
    }
  }

  it should "answer 410 for an execution whose results have expired, also with no operator to export" in {
    grantReadAccess()
    val execution = insertExecution()
    expireResultsOf(execution)

    Seq(oneOperator, Nil).foreach { operators =>
      val response = exportToDataset(exportRequest(operators, execution.getEid.longValue()))
      assert(response.getStatus == 410, s"${operators.size} operator(s)")
      assert(
        errorOf(response) == s"the results of execution ${execution.getEid} have expired"
      )
    }
  }

  // The file service decides an upload by the token it comes with, so the route has to
  // hand on the caller's own: the header's, whatever the scheme's case.
  it should "take the caller's token from the Authorization header" in {
    val bearerTokenOf = PrivateMethod[String](Symbol("bearerTokenOf"))

    assert((resource invokePrivate bearerTokenOf("Bearer abc.def.ghi")) == "abc.def.ghi")
    assert((resource invokePrivate bearerTokenOf("  bearer   abc.def.ghi ")) == "abc.def.ghi")
    assert((resource invokePrivate bearerTokenOf("Basic dXNlcjpwYXNz")) == "")
    assert((resource invokePrivate bearerTokenOf("abc.def.ghi")) == "")
    assert((resource invokePrivate bearerTokenOf(null)) == "")

    val exportToDataset = classOf[WorkflowExecutionsResource].getDeclaredMethods.toSeq
      .find(_.getName == "exportResultToDataset")
      .getOrElse(fail("exportResultToDataset handler not found"))
    val headerNames = exportToDataset.getParameterAnnotations.toSeq.flatMap(
      _.collectFirst { case header: javax.ws.rs.HeaderParam => header.value() }
    )
    assert(headerNames == Seq("Authorization"))
  }

}
