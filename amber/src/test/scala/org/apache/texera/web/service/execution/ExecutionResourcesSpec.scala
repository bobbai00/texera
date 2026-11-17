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

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import org.apache.texera.amber.core.storage.result.ResultSchema
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  NoStoredPlanException,
  PlanRecord,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.jooq.generated.Tables.{
  OPERATOR_EXECUTIONS,
  OPERATOR_PORT_EXECUTIONS,
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.{
  UserWarehouseFlavorEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowVersion
}
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import scala.collection.mutable
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Specs for [[ExecutionResources]]: the warehouse an execution writes into, where its plan table
  * is, found from its row, how plan tables are dropped once their executions are deleted, and
  * which ended executions a new one clears. The rows are in `MockTexeraDB`; the plan, result and
  * console tables in the catalog the build's tests use (the Postgres JDBC catalog in CI), under
  * workflow ids and execution ids no other suite uses. Clearing an execution also deletes its large
  * binaries from the object store, under the prefix of its id, which is this suite's own.
  */
class ExecutionResourcesSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val testUid = 9431

  /** A user who owns no warehouse, and so may write into none. */
  private val intruderUid = 9434
  private val testWid = 9432
  private val otherWid = 9433

  // Explicit ids, so each plan table's name is this suite's own.
  private val defaultEid = 943101
  private val warehouseEid = 943102
  private val otherWorkflowEid = 943103

  private val warehouseName = s"user-$testUid-7"

  private var recorder: StatementRecorder = _

  /** The id of `testUid`'s warehouse, the row named `warehouseName`. */
  private var whid: Integer = _

  /** The computing units the clearing cases create executions for. */
  private val clearedUnit = 9441
  private val otherUnit = 9442
  private val idleUnit = 9443

  /** The result and console tables the clearing cases make, dropped after the suite. */
  private val madeTables = mutable.ListBuffer.empty[URI]

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    val cfg = getDSLContext.configuration()

    Seq(testUid -> "execution_resources_spec_user", intruderUid -> "execution_resources_intruder")
      .foreach {
        case (uid, name) =>
          val user = new User
          user.setUid(uid)
          user.setName(name)
          user.setEmail(s"execution-resources-${UUID.randomUUID()}@example.com")
          new UserDao(cfg).insert(user)
      }

    Seq(testWid, otherWid).foreach { wid =>
      val workflow = new Workflow
      workflow.setWid(wid)
      workflow.setName(s"execution_resources_spec_$wid")
      workflow.setContent("{}")
      workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
      workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
      new WorkflowDao(cfg).insert(workflow)
      val version = new WorkflowVersion
      version.setWid(wid)
      version.setContent("{}")
      version.setCreationTime(new Timestamp(System.currentTimeMillis()))
      new WorkflowVersionDao(cfg).insert(version)
    }

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUid)
    warehouse.setName("execution-resources-warehouse")
    warehouse.setLakekeeperWarehouseName(warehouseName)
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    whid = warehouse.getWhid

    insertExecution(defaultEid, testWid, whid = None)
    insertExecution(warehouseEid, testWid, whid = Some(warehouse.getWhid))
    insertExecution(otherWorkflowEid, otherWid, whid = None)

    Seq(clearedUnit, otherUnit, idleUnit).foreach { cuid =>
      val unit = new WorkflowComputingUnit
      unit.setCuid(cuid)
      unit.setUid(testUid)
      unit.setName(s"execution-resources-unit-$cuid")
      unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
      unit.setType(WorkflowComputingUnitTypeEnum.local)
      unit.setUri("local://test")
      unit.setResource("{}")
      new WorkflowComputingUnitDao(cfg).insert(unit)
    }
  }

  override protected def afterAll(): Unit =
    try madeTables.foreach(uri => Try(DocumentFactory.openDocument(uri)._1.clear()))
    finally closeConnectionPool()

  private def insertExecution(
      eid: Int,
      wid: Int,
      whid: Option[Integer],
      cuid: Option[Int] = None,
      status: Short = 1
  ): Unit = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(wid))
      .fetchOneInto(classOf[Integer])
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(testUid))
      .set(WORKFLOW_EXECUTIONS.WHID, whid.orNull)
      .set(WORKFLOW_EXECUTIONS.CUID, cuid.map(Integer.valueOf).orNull)
      .set(WORKFLOW_EXECUTIONS.STATUS, java.lang.Short.valueOf(status))
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .execute()
  }

  /** Gives execution `eid` of `wid` a console table, registered as an operator's console. */
  private def withConsole(wid: Int, eid: Int): URI = {
    val uri = VFSURIFactory.createConsoleMessagesURI(
      WorkflowIdentity(wid.toLong),
      ExecutionIdentity(eid.toLong),
      OperatorIdentity("console-op")
    )
    DocumentFactory.createDocument(uri, ResultSchema.consoleMessagesSchema)
    madeTables += uri
    getDSLContext
      .insertInto(OPERATOR_EXECUTIONS)
      .set(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID, Integer.valueOf(eid))
      .set(OPERATOR_EXECUTIONS.OPERATOR_ID, "console-op")
      .set(OPERATOR_EXECUTIONS.CONSOLE_MESSAGES_URI, uri.toString)
      .execute()
    uri
  }

  /** Gives execution `eid` of `wid` a result table, registered as a port's result. */
  private def withResult(wid: Int, eid: Int): URI = {
    val port = GlobalPortIdentity(
      PhysicalOpIdentity(OperatorIdentity("result-op"), "main"),
      PortIdentity()
    )
    val uri = VFSURIFactory.resultURI(
      VFSURIFactory.createPortBaseURI(
        WorkflowIdentity(wid.toLong),
        ExecutionIdentity(eid.toLong),
        port
      )
    )
    DocumentFactory.createDocument(uri, Schema().add("line", AttributeType.STRING))
    madeTables += uri
    getDSLContext
      .insertInto(OPERATOR_PORT_EXECUTIONS)
      .set(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID, Integer.valueOf(eid))
      .set(OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID, port.serializeAsString)
      .set(OPERATOR_PORT_EXECUTIONS.RESULT_URI, uri.toString)
      .execute()
    uri
  }

  private def hasTable(uri: URI): Boolean = Try(DocumentFactory.openDocument(uri)).isSuccess

  /** How many registry rows (results and consoles) execution `eid` has. */
  private def registered(eid: Int): Int =
    getDSLContext.fetchCount(
      OPERATOR_EXECUTIONS,
      OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(Integer.valueOf(eid))
    ) + getDSLContext.fetchCount(
      OPERATOR_PORT_EXECUTIONS,
      OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(Integer.valueOf(eid))
    )

  /** What ExecutionResources logs at INFO or above while `body` runs. */
  private def loggedWhile(body: => Unit): Seq[ILoggingEvent] = {
    val logger = LoggerFactory
      .getLogger(ExecutionResources.getClass)
      .asInstanceOf[LogbackLogger]
    val previousLevel = logger.getLevel
    val appender = new ListAppender[ILoggingEvent]
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.INFO)
    try {
      body
      appender.list.asScala.toList
    } finally {
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  private def planUri(wid: Int, eid: Int, warehouse: Option[String] = None): URI =
    ExecutionPlanStore.planUri(
      WorkflowIdentity(wid.toLong),
      ExecutionIdentity(eid.toLong),
      warehouse
    )

  private def writePlan(uri: URI): Unit =
    ExecutionPlanStore.writePlan(
      uri,
      PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        body = "{}",
        createdBy = testUid,
        computingUnitId = 1,
        notification = None
      ),
      "{}"
    )

  private def hasPlanTable(uri: URI): Boolean =
    try {
      ExecutionPlanStore.readPlan(uri)
      true
    } catch {
      case _: NoStoredPlanException => false
    }

  "ExecutionResources.resolveLakekeeperWarehouseName" should "require a pick while warehouses are enabled" in {
    // A run must name the warehouse it writes into, the same way it names a computing unit;
    // falling back to the shared default would route a caller that forgot to pick into shared
    // storage (#7751).
    val error = intercept[IllegalArgumentException] {
      ExecutionResources.resolveLakekeeperWarehouseName(None, testUid, enabled = true)
    }
    error.getMessage shouldBe "a warehouse must be selected for this execution"
  }

  it should "keep the shared default warehouse when nothing is picked and the feature is off" in {
    ExecutionResources.resolveLakekeeperWarehouseName(None, testUid, enabled = false) shouldBe None
  }

  it should "resolve an owned warehouse to its Lakekeeper name" in {
    ExecutionResources.resolveLakekeeperWarehouseName(Some(whid), testUid, enabled = true) shouldBe
      Some(warehouseName)
  }

  it should "refuse another user's warehouse" in {
    val error = intercept[IllegalArgumentException] {
      ExecutionResources.resolveLakekeeperWarehouseName(Some(whid), intruderUid, enabled = true)
    }
    error.getMessage shouldBe s"no warehouse with id $whid owned by this user"
  }

  it should "refuse an explicit pick while warehouses are disabled" in {
    // Never route the run into the shared warehouse silently (#6930).
    val error = intercept[IllegalArgumentException] {
      ExecutionResources.resolveLakekeeperWarehouseName(Some(whid), testUid, enabled = false)
    }
    error.getMessage shouldBe "per-user warehouses are disabled in this deployment"
  }

  "ExecutionResources.planUriOf" should "find the plan table of an execution that names no warehouse in the default one" in {
    ExecutionResources.planUriOf(ExecutionIdentity(defaultEid.toLong)) shouldBe
      Some(new URI(s"vfs:///wid/$testWid/eid/$defaultEid/plan"))
  }

  it should "find the plan table of an execution in the warehouse it writes into" in {
    ExecutionResources.planUriOf(ExecutionIdentity(warehouseEid.toLong)) shouldBe
      Some(new URI(s"vfs:///wh/$warehouseName/wid/$testWid/eid/$warehouseEid/plan"))
  }

  it should "find none for an execution that does not exist" in {
    ExecutionResources.planUriOf(ExecutionIdentity(943199L)) shouldBe None
  }

  "ExecutionResources.planUrisOf" should "find the plan tables of many executions in one SELECT, leaving out unknown ones" in {
    var found: Map[ExecutionIdentity, URI] = Map.empty
    val statements = recorder.record {
      found = ExecutionResources.planUrisOf(
        Seq(defaultEid, warehouseEid, otherWorkflowEid, 943199, defaultEid)
          .map(eid => ExecutionIdentity(eid.toLong))
      )
    }

    statements.map(_.verb) shouldBe Seq("SELECT")
    found shouldBe Map(
      ExecutionIdentity(defaultEid.toLong) -> planUri(testWid, defaultEid),
      ExecutionIdentity(warehouseEid.toLong) ->
        planUri(testWid, warehouseEid, Some(warehouseName)),
      ExecutionIdentity(otherWorkflowEid.toLong) -> planUri(otherWid, otherWorkflowEid)
    )
  }

  it should "ask nothing for no executions" in {
    recorder.record {
      ExecutionResources.planUrisOf(Seq.empty) shouldBe Map.empty
    } shouldBe empty
  }

  "ExecutionResources.dropPlanTables" should "drop each plan table, with its rows and its start claim" in {
    val claimed = planUri(testWid, defaultEid)
    val unclaimed = planUri(otherWid, otherWorkflowEid)
    writePlan(claimed)
    writePlan(unclaimed)
    ExecutionPlanStore.claimStart(claimed)

    ExecutionResources.dropPlanTables(Seq(claimed, unclaimed))

    hasPlanTable(claimed) shouldBe false
    hasPlanTable(unclaimed) shouldBe false
    // A table made again at a dropped one's name starts unclaimed.
    writePlan(claimed)
    try ExecutionPlanStore.isStarted(claimed) shouldBe false
    finally ExecutionPlanStore.drop(claimed)
  }

  it should "pass over a plan table that is not there" in {
    val missing = planUri(testWid, 943198)
    hasPlanTable(missing) shouldBe false
    noException should be thrownBy ExecutionResources.dropPlanTables(Seq(missing))
  }

  it should "leave a plan table in a per-user warehouse alone while those are disabled" in {
    assume(!StorageConfig.warehouseEnabled, "per-user warehouses are enabled in this deployment")
    // Under any catalog but the REST one, a warehouse's URI names the same table as the default's.
    val inWarehouse = planUri(testWid, warehouseEid, Some(warehouseName))
    writePlan(inWarehouse)
    try {
      ExecutionResources.dropPlanTables(Seq(inWarehouse))

      hasPlanTable(inWarehouse) shouldBe true
    } finally ExecutionPlanStore.drop(inWarehouse)
  }

  it should "log a drop that fails, and go on to the next" in {
    val notAPlan = new URI(s"vfs:///wid/$testWid/eid/$defaultEid/runtimestatistics")
    val plan = planUri(testWid, defaultEid)
    writePlan(plan)
    val logger = LoggerFactory
      .getLogger(ExecutionResources.getClass)
      .asInstanceOf[LogbackLogger]
    val previousLevel = logger.getLevel
    val appender = new ListAppender[ILoggingEvent]
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.WARN)
    try {
      noException should be thrownBy ExecutionResources.dropPlanTables(Seq(notAPlan, plan))

      val warnings = appender.list.asScala.filter(_.getLevel == Level.WARN)
      warnings.map(_.getFormattedMessage) shouldBe
        Seq(s"The plan table at $notAPlan could not be dropped.")
      warnings.head.getThrowableProxy.getMessage should include("not an execution plan URI")
      hasPlanTable(plan) shouldBe false
    } finally {
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
      ExecutionPlanStore.drop(plan)
    }
  }

  "ExecutionResources.clearFinishedExecutions" should
    "clear the ended executions of the workflow on the unit before the new one, and only those" in {
    // Ended, on the unit, holding results: a new execution replaces them.
    insertExecution(943111, testWid, None, Some(clearedUnit), status = 3) // COMPLETED
    insertExecution(943112, testWid, None, Some(clearedUnit), status = 4) // FAILED
    insertExecution(943113, testWid, None, Some(clearedUnit), status = 5) // KILLED
    // Still running, or about to be.
    insertExecution(943114, testWid, None, Some(clearedUnit), status = 1) // RUNNING
    insertExecution(943115, testWid, None, Some(clearedUnit), status = 2) // PAUSED
    insertExecution(943116, testWid, None, Some(clearedUnit), status = 0) // Initializing
    // Another unit's, another workflow's, the new execution itself, and one created after it.
    insertExecution(943117, testWid, None, Some(otherUnit), status = 3)
    insertExecution(943118, otherWid, None, Some(clearedUnit), status = 3)
    insertExecution(943119, testWid, None, Some(clearedUnit), status = 3)
    insertExecution(943121, testWid, None, Some(clearedUnit), status = 3)
    val consoles = Map(
      943111 -> withConsole(testWid, 943111),
      943113 -> withConsole(testWid, 943113),
      943114 -> withConsole(testWid, 943114),
      943115 -> withConsole(testWid, 943115),
      943116 -> withConsole(testWid, 943116),
      943117 -> withConsole(testWid, 943117),
      943118 -> withConsole(otherWid, 943118),
      943119 -> withConsole(testWid, 943119),
      943121 -> withConsole(testWid, 943121)
    )
    val result = withResult(testWid, 943112)
    // Ended before the new execution, on the unit, with nothing left to clear: passed over, and
    // so not among the executions logged as cleared below.
    insertExecution(943110, testWid, None, Some(clearedUnit), status = 3)

    val logged = loggedWhile {
      ExecutionResources.clearFinishedExecutions(
        WorkflowIdentity(testWid.toLong),
        clearedUnit,
        ExecutionIdentity(943119L)
      )
    }

    Seq(943111, 943112, 943113).foreach(eid => registered(eid) shouldBe 0)
    Seq(consoles(943111), result, consoles(943113)).foreach(uri => hasTable(uri) shouldBe false)
    Seq(943114, 943115, 943116, 943117, 943118, 943119, 943121).foreach { eid =>
      registered(eid) shouldBe 1
      hasTable(consoles(eid)) shouldBe true
    }
    logged.map(_.getFormattedMessage).filter(_.startsWith("Cleared")) shouldBe
      Seq(943111, 943112, 943113).map(eid =>
        s"Cleared the results of execution $eid, as execution 943119 of workflow $testWid on " +
          s"computing unit $clearedUnit replaces it."
      )
    // The executions themselves stay, in the states they ended in.
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.EID, WORKFLOW_EXECUTIONS.STATUS)
      .from(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.between(Integer.valueOf(943111), Integer.valueOf(943113)))
      .orderBy(WORKFLOW_EXECUTIONS.EID)
      .fetch()
      .asScala
      .map(row => (row.value1().intValue(), row.value2().intValue()))
      .toList shouldBe List((943111, 3), (943112, 4), (943113, 5))
  }

  it should "log an execution that cannot be cleared, and go on to the next" in {
    insertExecution(943131, otherWid, None, Some(otherUnit), status = 3)
    insertExecution(943132, otherWid, None, Some(otherUnit), status = 3)
    // A console location that is not a URI: clearing 943131 fails before it deletes anything.
    getDSLContext
      .insertInto(OPERATOR_EXECUTIONS)
      .set(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID, Integer.valueOf(943131))
      .set(OPERATOR_EXECUTIONS.OPERATOR_ID, "broken-op")
      .set(OPERATOR_EXECUTIONS.CONSOLE_MESSAGES_URI, "not a uri")
      .execute()
    val console = withConsole(otherWid, 943132)

    val logged = loggedWhile {
      noException should be thrownBy ExecutionResources.clearFinishedExecutions(
        WorkflowIdentity(otherWid.toLong),
        otherUnit,
        ExecutionIdentity(943133L)
      )
    }

    val warnings = logged.filter(_.getLevel == Level.WARN)
    warnings.map(_.getFormattedMessage) shouldBe
      Seq("The results of execution 943131 could not be cleared.")
    warnings.head.getThrowableProxy should not be null
    registered(943131) shouldBe 1
    registered(943132) shouldBe 0
    hasTable(console) shouldBe false
  }

  it should "clear nothing, and say so, when the executions cannot be listed" in {
    val logged = loggedWhile {
      noException should be thrownBy ExecutionResources.clearFinishedExecutions(
        WorkflowIdentity(Int.MaxValue.toLong + 1),
        clearedUnit,
        ExecutionIdentity(1L)
      )
    }

    logged.filter(_.getLevel == Level.WARN).map(_.getFormattedMessage) shouldBe Seq(
      s"The ended executions of workflow ${Int.MaxValue.toLong + 1} on computing unit " +
        s"$clearedUnit could not be listed, so their results are kept."
    )
  }

  it should "list the executions to clear in one SELECT" in {
    insertExecution(943141, testWid, None, Some(idleUnit), status = 4)

    val statements = recorder.record {
      ExecutionResources.clearFinishedExecutions(
        WorkflowIdentity(testWid.toLong),
        idleUnit,
        ExecutionIdentity(943142L)
      )
    }

    // 943141 holds nothing to clear, so the listing is all that is sent.
    statements.map(_.verb) shouldBe Seq("SELECT")
  }
}
