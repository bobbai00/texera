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

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.dao.{MockTexeraDB, SqlServer, StatementRecorder, WorkflowExecutionStatus}
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
  WorkflowExecutions,
  WorkflowVersion
}
import org.apache.texera.web.storage.ExecutionStateStore
import org.jooq.exception.DataAccessException
import org.jooq.impl.{DSL, DefaultConfiguration, DefaultExecuteListenerProvider}
import org.jooq.{ConnectionProvider, ExecuteContext, ExecuteListener, SQLDialect}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}
import org.slf4j.LoggerFactory

import java.net.URI
import java.sql.{Connection, SQLException, Timestamp}
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.jdk.CollectionConverters._

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

  // Helper: insert an execution row tied to the seeded version and return its eid.
  private def seedExecution(status: Byte = 0): Integer = {
    val exec = new WorkflowExecutions
    exec.setVid(seededVid)
    exec.setUid(testUid)
    exec.setStatus(status)
    exec.setResult("")
    exec.setStartingTime(new Timestamp(System.currentTimeMillis()))
    exec.setBookmarked(false)
    exec.setName("seeded execution")
    exec.setEnvironmentVersion("test-env")
    workflowExecutionsDao.insert(exec)
    exec.getEid
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

  "insertCreatedExecution" should
    "record an execution as Created, not the column's default, Running, and starting now" in {
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
    stored.getStatus shouldBe WorkflowExecutionStatus.Created
    stored.getStartingTime.getTime should (be >= (before - 1000) and be <= (after + 1000))
    stored.getVid shouldBe seededVid
    stored.getUid shouldBe testUid
    stored.getCuid shouldBe seededCuid
    stored.getName shouldBe "created-execution"
    stored.getEnvironmentVersion shouldBe """{"engine_version":"1.4.0"}"""
    stored.getWhid shouldBe null
    // Nothing has run it: no update, no replay log, no statistics.
    stored.getLastUpdateTime shouldBe null
    stored.getLogLocation shouldBe null
    stored.getRuntimeStatsUri shouldBe null
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

  // -- markFailed ---------------------------------------------------------------

  "markFailed" should "record FAILED and when, in one UPDATE by eid" in {
    val eid = seedExecution(status = 0)
    val other = seedExecution(status = 0)
    val before = System.currentTimeMillis()

    val statements = recorder.record {
      ExecutionsMetadataPersistService.markFailed(ExecutionIdentity(eid.longValue()))
    }

    statements.map(_.verb) shouldBe Seq("UPDATE")
    val failed = workflowExecutionsDao.fetchOneByEid(eid)
    failed.getStatus shouldBe maptoStatusCode(WorkflowAggregatedState.FAILED)
    failed.getLastUpdateTime.getTime should be >= (before - 1000)
    workflowExecutionsDao.fetchOneByEid(other).getStatus shouldBe 0.toByte
  }

  // -- tryUpdateExistingExecution ---------------------------------------------

  "tryUpdateExistingExecution" should "apply the update function to the stored row" in {
    val eid = seedExecution(status = 0)
    ExecutionsMetadataPersistService.tryUpdateExistingExecution(
      ExecutionIdentity(eid.longValue())
    ) { exec =>
      exec.setStatus(2.toByte) // PAUSED
      exec.setName("renamed via update")
    }
    val after = workflowExecutionsDao.fetchOneByEid(eid)
    after.getStatus shouldBe 2.toByte
    after.getName shouldBe "renamed via update"
  }

  it should "swallow the update error for an unknown eid and leave existing rows untouched" in {
    // Pin the silent-failure contract: fetchOneByEid returns null, the
    // update closure NPEs on it, the catch logs "Unable to update execution"
    // and continues. The seeded row stays untouched.
    val eid = seedExecution(status = 1)
    noException should be thrownBy
      ExecutionsMetadataPersistService.tryUpdateExistingExecution(
        ExecutionIdentity(-1L)
      ) { exec => exec.setStatus(9.toByte) }
    val after = workflowExecutionsDao.fetchOneByEid(eid)
    after.getStatus shouldBe 1.toByte
  }

  // -- updateStatus -------------------------------------------------------------
  //
  // The unit records a run's state with it while the run starts and goes on, so it is one UPDATE
  // by eid that reads nothing first.

  // A whole second, so the time read back compares equal at any precision the column keeps.
  private val changedAt = Timestamp.valueOf("2026-11-15 10:20:30")

  /**
    * Runs `body` with the production code pointed at a database it cannot reach, and returns how
    * often it tried to connect, so a test can tell a swallowed failure from no attempt at all.
    */
  private def whileDatabaseUnreachable(body: => Unit): Int = {
    val attempts = new AtomicInteger()
    val unreachable = new DefaultConfiguration()
    unreachable.set(SQLDialect.POSTGRES)
    unreachable.set(new ConnectionProvider {
      override def acquire(): Connection = {
        attempts.incrementAndGet()
        throw new SQLException("database unavailable")
      }
      override def release(connection: Connection): Unit = ()
    })
    SqlServer.getInstance().replaceDSLContext(DSL.using(unreachable))
    try body
    finally SqlServer.getInstance().replaceDSLContext(getDSLContext)
    attempts.get()
  }

  /**
    * Runs `body` and returns its result with what the service logged meanwhile on this thread, at
    * INFO and above. The level is set here, whatever the logging configuration says, so a line
    * logged below WARN is caught too and shows up with its level.
    */
  private def loggedByService[T](body: => T): (T, Seq[ILoggingEvent]) = {
    val logger = LoggerFactory
      .getLogger(ExecutionsMetadataPersistService.getClass.getName)
      .asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val previousLevel = logger.getLevel
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.INFO)
    try {
      val result = body
      (result, appender.list.asScala.toList)
    } finally {
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  /**
    * Gives every column of an execution's row that a write could clobber a value of its own, the
    * way a rename, a bookmark, the statistics writer or a warehouse choice would have, so a write
    * that touches a column it should leave alone changes it.
    */
  private def fillEveryColumn(eid: Integer): Unit = {
    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUid)
    warehouse.setName(s"warehouse-of-$eid")
    warehouse.setLakekeeperWarehouseName(s"user-$testUid-warehouse-of-$eid")
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.CUID, seededCuid)
      .set(WORKFLOW_EXECUTIONS.RESULT, "a result")
      .set(WORKFLOW_EXECUTIONS.LAST_UPDATE_TIME, Timestamp.valueOf("2026-11-14 09:00:00"))
      .set(WORKFLOW_EXECUTIONS.BOOKMARKED, java.lang.Boolean.TRUE)
      .set(WORKFLOW_EXECUTIONS.NAME, "renamed by its owner")
      .set(WORKFLOW_EXECUTIONS.LOG_LOCATION, "file:///logs/earlier/")
      .set(WORKFLOW_EXECUTIONS.RUNTIME_STATS_URI, "vfs:///runtime-stats")
      .set(WORKFLOW_EXECUTIONS.RUNTIME_STATS_SIZE, java.lang.Long.valueOf(42L))
      .set(WORKFLOW_EXECUTIONS.WHID, warehouse.getWhid)
      .where(WORKFLOW_EXECUTIONS.EID.eq(eid))
      .execute()
  }

  /** The columns of an execution's row whose values `write` changes. */
  private def columnsChangedBy(eid: Integer)(write: => Unit): Set[String] = {
    def row = getDSLContext.fetchOne(WORKFLOW_EXECUTIONS, WORKFLOW_EXECUTIONS.EID.eq(eid))
    val before = row
    write
    val after = row
    WORKFLOW_EXECUTIONS
      .fields()
      .map(_.getName)
      .filter(column => before.get(column) != after.get(column))
      .toSet
  }

  "updateStatus" should "write the status and its time in one UPDATE by eid" in {
    val eid = seedExecution(status = 0)
    val statements = recorder.record {
      ExecutionsMetadataPersistService.updateStatus(
        ExecutionIdentity(eid.longValue()),
        3.toByte,
        changedAt
      )
    }
    statements.map(_.verb) shouldBe Seq("UPDATE")
    statements.head.sql should include("workflow_executions")
    statements.head.sql.toLowerCase should not include "select"
    val after = workflowExecutionsDao.fetchOneByEid(eid)
    after.getStatus shouldBe 3.toByte
    after.getLastUpdateTime shouldBe changedAt
  }

  it should "write no other column, so it cannot undo another writer's change to the row" in {
    // The status used to be written by reading the row and writing all of it back, which undid a
    // rename, a bookmark or a statistics URI written in between.
    val eid = seedExecution(status = 0)
    fillEveryColumn(eid)
    val changed = columnsChangedBy(eid) {
      ExecutionsMetadataPersistService.updateStatus(
        ExecutionIdentity(eid.longValue()),
        3.toByte,
        changedAt
      )
    }
    changed shouldBe Set("status", "last_update_time")
  }

  it should "leave every other execution's row as it was" in {
    val target = seedExecution(status = 0)
    val other = seedExecution(status = 1)
    ExecutionsMetadataPersistService.updateStatus(
      ExecutionIdentity(target.longValue()),
      4.toByte,
      changedAt
    )
    val untouched = workflowExecutionsDao.fetchOneByEid(other)
    untouched.getStatus shouldBe 1.toByte
    untouched.getLastUpdateTime shouldBe null
  }

  it should "update nothing and not fail for an unknown eid, without looking it up first" in {
    val eid = seedExecution(status = 1)
    val statements = recorder.record {
      noException should be thrownBy
        ExecutionsMetadataPersistService.updateStatus(ExecutionIdentity(-1L), 4.toByte, changedAt)
    }
    statements.map(_.verb) shouldBe Seq("UPDATE")
    workflowExecutionsDao.fetchOneByEid(eid).getStatus shouldBe 1.toByte
  }

  it should "log and swallow a failure, so a run does not fail over its status" in {
    val eid = seedExecution(status = 1)
    val (attempts, logged) = loggedByService {
      whileDatabaseUnreachable {
        noException should be thrownBy
          ExecutionsMetadataPersistService.updateStatus(
            ExecutionIdentity(eid.longValue()),
            4.toByte,
            changedAt
          )
      }
    }
    attempts should be > 0
    logged.map(_.getLevel) shouldBe Seq(Level.WARN)
    logged.head.getFormattedMessage should startWith(s"Unable to update execution $eid.")
    logged.head.getFormattedMessage should include("database unavailable")
    workflowExecutionsDao.fetchOneByEid(eid).getStatus shouldBe 1.toByte
  }

  // -- ExecutionStateStore.updateWorkflowState --------------------------------
  //
  // updateWorkflowState writes the status through updateStatus and bumps the
  // in-memory ExecutionMetadataStore's `state`. Exercising it here keeps the
  // DB-backed setup (workflow/version/execution rows) in one place; the
  // pure-logic ExecutionStateStoreSpec sibling has no DB dependency.

  "ExecutionStateStore.updateWorkflowState" should "set status via maptoStatusCode and return the metadata store with new state" in {
    val eid = seedExecution(status = 0)
    val before = workflowExecutionsDao.fetchOneByEid(eid)
    val beforeTs = before.getLastUpdateTime
    val store = ExecutionMetadataStore(
      state = WorkflowAggregatedState.UNINITIALIZED,
      executionId = ExecutionIdentity(eid.longValue())
    )
    val updated =
      ExecutionStateStore.updateWorkflowState(WorkflowAggregatedState.COMPLETED, store)
    updated.state shouldBe WorkflowAggregatedState.COMPLETED

    val after = workflowExecutionsDao.fetchOneByEid(eid)
    after.getStatus shouldBe maptoStatusCode(WorkflowAggregatedState.COMPLETED)
    // lastUpdateTime is set unconditionally to System.currentTimeMillis().
    // Asserting it advanced past the seeded null/older value catches a
    // regression that stops writing the time.
    Option(beforeTs) match {
      case Some(t) => after.getLastUpdateTime.getTime should be >= t.getTime
      case None    => after.getLastUpdateTime should not be null
    }
  }

  it should "write a state change with one UPDATE and no SELECT" in {
    // A run reports its state as it starts; doing so must not read Postgres.
    val eid = seedExecution(status = 0)
    val store = ExecutionMetadataStore(executionId = ExecutionIdentity(eid.longValue()))
    val statements = recorder.record {
      ExecutionStateStore.updateWorkflowState(WorkflowAggregatedState.RUNNING, store)
    }
    statements.map(_.verb) shouldBe Seq("UPDATE")
    workflowExecutionsDao.fetchOneByEid(eid).getStatus shouldBe
      maptoStatusCode(WorkflowAggregatedState.RUNNING)
  }

  it should "write -1 for a state that has no code of its own" in {
    val eid = seedExecution(status = 1)
    val store = ExecutionMetadataStore(executionId = ExecutionIdentity(eid.longValue()))
    ExecutionStateStore.updateWorkflowState(WorkflowAggregatedState.PAUSING, store)
    workflowExecutionsDao.fetchOneByEid(eid).getStatus shouldBe (-1).toByte
  }

  it should "still return a metadataStore with the new state when the eid is unknown" in {
    // updateWorkflowState first calls updateStatus (an UPDATE that matches no
    // row and swallows any failure) and then unconditionally returns
    // metadataStore.withState(state). Document this so a future refactor
    // that makes the failure surface (e.g. via Try / Either) has a spec to
    // migrate.
    val store = ExecutionMetadataStore(
      state = WorkflowAggregatedState.UNINITIALIZED,
      executionId = ExecutionIdentity(-1L)
    )
    val updated =
      ExecutionStateStore.updateWorkflowState(WorkflowAggregatedState.FAILED, store)
    updated.state shouldBe WorkflowAggregatedState.FAILED
  }
}
