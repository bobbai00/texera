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
import org.apache.texera.amber.core.storage.{ExecutionPlanStore, NoStoredPlanException, PlanRecord}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.PhysicalPlanCodec
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.UserWarehouseFlavorEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{UserDao, WorkflowDao, WorkflowVersionDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{User, Workflow, WorkflowVersion}
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import scala.jdk.CollectionConverters._

/**
  * Specs for [[ExecutionResources]]: where an execution's plan table is, found from its row, and
  * how plan tables are dropped once their executions are deleted. The rows are in `MockTexeraDB`;
  * the plan tables in the catalog the build's tests use (the Postgres JDBC catalog in CI), under
  * workflow ids no other suite uses.
  */
class ExecutionResourcesSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val testUid = 9431
  private val testWid = 9432
  private val otherWid = 9433

  // Explicit ids, so each plan table's name is this suite's own.
  private val defaultEid = 943101
  private val warehouseEid = 943102
  private val otherWorkflowEid = 943103

  private val warehouseName = s"user-$testUid-7"

  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    val cfg = getDSLContext.configuration()

    val user = new User
    user.setUid(testUid)
    user.setName("execution_resources_spec_user")
    user.setEmail(s"execution-resources-${UUID.randomUUID()}@example.com")
    new UserDao(cfg).insert(user)

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

    insertExecution(defaultEid, testWid, whid = None)
    insertExecution(warehouseEid, testWid, whid = Some(warehouse.getWhid))
    insertExecution(otherWorkflowEid, otherWid, whid = None)
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  private def insertExecution(eid: Int, wid: Int, whid: Option[Integer]): Unit = {
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
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .execute()
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
        kind = ExecutionPlanStore.PlanKind,
        formatVersion = PhysicalPlanCodec.FormatVersion,
        body = "{}",
        logical = "{}",
        createdAt = new Timestamp(System.currentTimeMillis()),
        createdBy = testUid,
        computingUnitId = 1,
        notification = None
      )
    )

  private def hasPlanTable(uri: URI): Boolean =
    try {
      ExecutionPlanStore.readPlan(uri)
      true
    } catch {
      case _: NoStoredPlanException => false
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
}
