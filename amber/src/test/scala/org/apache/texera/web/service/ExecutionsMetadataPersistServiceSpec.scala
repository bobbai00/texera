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

package org.apache.texera.web.service

import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.dao.{MockTexeraDB, SqlServer, StatementRecorder}
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.UserWarehouseFlavorEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowVersion
}
import org.jooq.exception.DataAccessException
import org.jooq.impl.{DSL, DefaultExecuteListenerProvider}
import org.jooq.{ExecuteContext, ExecuteListener}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.net.URI
import java.sql.Timestamp
import java.util.UUID

class ExecutionsMetadataPersistServiceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  // Randomise the seeded wid/uid so a parallel run of unrelated specs that
  // happen to seed the same ids wouldn't collide on the embedded postgres.
  private val testWid = 7000 + scala.util.Random.nextInt(1000)
  private val testUid = 7000 + scala.util.Random.nextInt(1000)

  private var workflowDao: WorkflowDao = _
  private var workflowVersionDao: WorkflowVersionDao = _
  private var workflowExecutionsDao: WorkflowExecutionsDao = _
  private var userDao: UserDao = _
  private var computingUnitDao: WorkflowComputingUnitDao = _
  private var seededVid: Integer = _
  private var seededCuid: Integer = _
  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
  }

  override protected def afterAll(): Unit = {
    closeConnectionPool()
  }

  override protected def beforeEach(): Unit = {
    val cfg = getDSLContext.configuration()
    workflowDao = new WorkflowDao(cfg)
    workflowVersionDao = new WorkflowVersionDao(cfg)
    workflowExecutionsDao = new WorkflowExecutionsDao(cfg)
    userDao = new UserDao(cfg)
    computingUnitDao = new WorkflowComputingUnitDao(cfg)
    cleanup()

    val user = new User
    user.setUid(testUid)
    user.setName("metadata_persist_spec_user")
    user.setEmail(s"user_${UUID.randomUUID()}@example.com")
    userDao.insert(user)

    val workflow = new Workflow
    workflow.setWid(testWid)
    workflow.setName(s"wf_${UUID.randomUUID().toString.substring(0, 8)}")
    workflow.setContent("{}")
    workflow.setDescription("")
    workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    workflowDao.insert(workflow)

    // Seed one version explicitly so insertCreatedExecution's getLatestVersion
    // takes the happy "max(existing)" branch instead of falling into the
    // back-compat "insert one for you" branch (which would drag in
    // WorkflowVersionResource.insertNewVersion's diff/aggregate logic).
    val version = new WorkflowVersion
    version.setWid(testWid)
    version.setContent("{}")
    version.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflowVersionDao.insert(version)
    seededVid = version.getVid

    // workflow_executions.cuid has a FK to workflow_computing_unit; seed one
    // so an execution inserted for it doesn't trip the constraint.
    val cu = new WorkflowComputingUnit
    cu.setUid(testUid)
    cu.setName("test-cu")
    computingUnitDao.insert(cu)
    seededCuid = cu.getCuid
  }

  override protected def afterEach(): Unit = cleanup()

  private def cleanup(): Unit = {
    getDSLContext
      .deleteFrom(WORKFLOW_EXECUTIONS)
      .where(
        WORKFLOW_EXECUTIONS.VID.in(
          getDSLContext
            .select(WORKFLOW_VERSION.VID)
            .from(WORKFLOW_VERSION)
            .where(WORKFLOW_VERSION.WID.eq(testWid))
        )
      )
      .execute()
    getDSLContext
      .deleteFrom(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(testWid))
      .execute()
    getDSLContext.deleteFrom(WORKFLOW).where(WORKFLOW.WID.eq(testWid)).execute()
    getDSLContext
      .deleteFrom(WORKFLOW_COMPUTING_UNIT)
      .where(WORKFLOW_COMPUTING_UNIT.UID.eq(testUid))
      .execute()
    getDSLContext.deleteFrom(USER).where(USER.UID.eq(testUid)).execute()
  }

  // -- environmentVersionOf -----------------------------------------------------

  "environmentVersionOf" should "record the engine version as a JSON object" in {
    // Persisted as the execution's environment version, so the key is part of the stored format.
    ExecutionsMetadataPersistService.environmentVersionOf("1.2.3") shouldBe
      """{"engine_version":"1.2.3"}"""
    // Quoted and escaped as JSON: a version is text the caller sends.
    ExecutionsMetadataPersistService.environmentVersionOf("""1.4 "beta" \ é""") shouldBe
      """{"engine_version":"1.4 \"beta\" \\ é"}"""
    ExecutionsMetadataPersistService.environmentVersionOf("") shouldBe """{"engine_version":""}"""
  }

  // -- insertCreatedExecution -------------------------------------------------

  "insertCreatedExecution" should "record an execution as open, and starting now" in {
    val before = System.currentTimeMillis()
    val (id, _) = ExecutionsMetadataPersistService.insertCreatedExecution(
      WorkflowIdentity(testWid.toLong),
      testUid,
      executionName = "created-execution",
      environmentVersion = """{"engine_version":"1.4.0"}""",
      computingUnitId = seededCuid,
      warehouseId = None,
      replayLogRoot = None
    )
    val after = System.currentTimeMillis()

    val stored = workflowExecutionsDao.fetchOneByEid(id.id.toInt)
    stored.getStartingTime.getTime should (be >= (before - 1000) and be <= (after + 1000))
    stored.getVid shouldBe seededVid
    stored.getUid shouldBe testUid
    stored.getCuid shouldBe seededCuid
    stored.getName shouldBe "created-execution"
    stored.getEnvironmentVersion shouldBe """{"engine_version":"1.4.0"}"""
    stored.getWhid shouldBe null
    // Nothing has run it, and nothing has closed it: no replay log, no ending.
    stored.getLogLocation shouldBe null
    stored.getOutcome shouldBe null
    stored.getOutcomeReason shouldBe null
    stored.getEndedAt shouldBe null
    stored.getOutcomeFromLog shouldBe false
  }

  it should "keep the column's default name for an empty name" in {
    val (id, _) = ExecutionsMetadataPersistService.insertCreatedExecution(
      WorkflowIdentity(testWid.toLong),
      testUid,
      executionName = "",
      environmentVersion = "env",
      computingUnitId = seededCuid,
      warehouseId = None,
      replayLogRoot = None
    )

    workflowExecutionsDao.fetchOneByEid(id.id.toInt).getName shouldBe "Untitled Execution"
  }

  it should "record the warehouse the execution writes into" in {
    val row = getDSLContext.newRecord(USER_WAREHOUSE)
    row.setUid(testUid)
    row.setName("created-warehouse")
    row.setLakekeeperWarehouseName(s"user-$testUid-created-warehouse")
    row.setLakekeeperWarehouseId(UUID.randomUUID())
    row.setFlavor(UserWarehouseFlavorEnum.local)
    row.store()

    val (id, _) = ExecutionsMetadataPersistService.insertCreatedExecution(
      WorkflowIdentity(testWid.toLong),
      testUid,
      executionName = "warehouse-run",
      environmentVersion = "env",
      computingUnitId = seededCuid,
      warehouseId = Some(row.getWhid),
      replayLogRoot = None
    )

    workflowExecutionsDao.fetchOneByEid(id.id.toInt).getWhid shouldBe row.getWhid
  }

  it should "tie the execution to the newest version of the workflow, in one INSERT after it" in {
    val newer = new WorkflowVersion
    newer.setWid(testWid)
    newer.setContent("{}")
    newer.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflowVersionDao.insert(newer)

    var id: ExecutionIdentity = null
    val statements = recorder.record {
      id = ExecutionsMetadataPersistService
        .insertCreatedExecution(
          WorkflowIdentity(testWid.toLong),
          testUid,
          executionName = "newest",
          environmentVersion = "env",
          computingUnitId = seededCuid,
          warehouseId = None,
          replayLogRoot = None
        )
        ._1
    }

    workflowExecutionsDao.fetchOneByEid(id.id.toInt).getVid shouldBe newer.getVid
    // The latest version is looked up, then the row is inserted and its id returned.
    statements.map(_.verb) shouldBe Seq("SELECT", "INSERT")
  }

  it should "record where the execution writes its replay log with its row" in {
    val root = new URI("file:///tmp/texera-spec-replay-logs/")
    var created: (ExecutionIdentity, Option[URI]) = null
    val statements = recorder.record {
      created = ExecutionsMetadataPersistService.insertCreatedExecution(
        WorkflowIdentity(testWid.toLong),
        testUid,
        executionName = "logged",
        environmentVersion = "env",
        computingUnitId = seededCuid,
        warehouseId = None,
        replayLogRoot = Some(root)
      )
    }

    val (id, replayLog) = created
    // <root>/<wid>/<eid>/, as the root resolves it (java.net.URI drops the empty authority).
    replayLog shouldBe Some(new URI(s"file:/tmp/texera-spec-replay-logs/$testWid/${id.id}/"))
    workflowExecutionsDao.fetchOneByEid(id.id.toInt).getLogLocation shouldBe replayLog.get.toString
    statements.map(_.verb) shouldBe Seq("SELECT", "INSERT", "UPDATE")
  }

  it should "leave no row when the location of its replay log cannot be recorded" in {
    val before = workflowExecutionsDao.fetchByVid(seededVid).size()
    val refusingUpdates = getDSLContext
      .configuration()
      .derive(new DefaultExecuteListenerProvider(new ExecuteListener {
        override def executeStart(ctx: ExecuteContext): Unit =
          if (ctx.sql().trim.toLowerCase.startsWith("update")) {
            throw new DataAccessException("the update is refused")
          }
      }))
    SqlServer.getInstance().replaceDSLContext(DSL.using(refusingUpdates))
    try {
      a[DataAccessException] should be thrownBy
        ExecutionsMetadataPersistService.insertCreatedExecution(
          WorkflowIdentity(testWid.toLong),
          testUid,
          executionName = "unlogged",
          environmentVersion = "env",
          computingUnitId = seededCuid,
          warehouseId = None,
          replayLogRoot = Some(new URI("file:///tmp/texera-spec-replay-logs/"))
        )
    } finally SqlServer.getInstance().replaceDSLContext(getDSLContext)

    workflowExecutionsDao.fetchByVid(seededVid).size() shouldBe before
  }

  it should "keep execution history when its warehouse is deleted (whid SET NULL)" in {
    val row = getDSLContext.newRecord(USER_WAREHOUSE)
    row.setUid(testUid)
    row.setName("doomed-warehouse")
    row.setLakekeeperWarehouseName(s"user-$testUid-doomed-warehouse")
    row.setLakekeeperWarehouseId(UUID.randomUUID())
    row.setFlavor(UserWarehouseFlavorEnum.local)
    row.store()

    val (id, _) = ExecutionsMetadataPersistService.insertCreatedExecution(
      WorkflowIdentity(testWid.toLong),
      testUid,
      executionName = "history-run",
      environmentVersion = "env",
      computingUnitId = seededCuid,
      warehouseId = Some(row.getWhid),
      replayLogRoot = None
    )

    getDSLContext.deleteFrom(USER_WAREHOUSE).where(USER_WAREHOUSE.WHID.eq(row.getWhid)).execute()

    val stored = workflowExecutionsDao.fetchOneByEid(id.id.toInt)
    stored should not be null
    stored.getWhid shouldBe null
  }

  it should "refuse a computing unit that does not exist, and write nothing" in {
    val before = workflowExecutionsDao.fetchByVid(seededVid).size()

    a[DataAccessException] should be thrownBy
      ExecutionsMetadataPersistService.insertCreatedExecution(
        WorkflowIdentity(testWid.toLong),
        testUid,
        executionName = "nowhere",
        environmentVersion = "env",
        computingUnitId = Int.MaxValue,
        warehouseId = None,
        replayLogRoot = None
      )

    workflowExecutionsDao.fetchByVid(seededVid).size() shouldBe before
  }
}
