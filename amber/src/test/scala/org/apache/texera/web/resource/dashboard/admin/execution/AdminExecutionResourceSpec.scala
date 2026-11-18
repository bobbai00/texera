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

package org.apache.texera.web.resource.dashboard.admin.execution

import org.apache.texera.amber.core.storage.{ExecutionLabel, ExecutionLogStore}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables._
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowUserAccessDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  Workflow,
  WorkflowExecutions,
  WorkflowUserAccess,
  WorkflowVersion
}
import org.apache.texera.web.service.execution.OpenExecutionStatuses
import org.scalatest.BeforeAndAfterAll
import org.scalatest.BeforeAndAfterEach
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.{ConcurrentHashMap, ConcurrentLinkedQueue, TimeUnit}
import scala.jdk.CollectionConverters._

class AdminExecutionResourceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  // MockTexeraDB's embedded Postgres is a JVM singleton shared by all suites, which
  // run sequentially. Random ids keep this suite's rows from colliding with data other
  // suites may have left behind in that shared DB.
  private val testWid = 4000 + scala.util.Random.nextInt(1000)
  private val testUid = 4000 + scala.util.Random.nextInt(1000)
  private val secondWid = testWid + 1
  // Every workflow a case may seed.
  private val testWids = (testWid to testWid + 5).map(Integer.valueOf).asJava

  private var testUser: User = _
  private var testWorkflow: Workflow = _
  private var testVersion: WorkflowVersion = _

  private var userDao: UserDao = _
  private var workflowDao: WorkflowDao = _
  private var workflowVersionDao: WorkflowVersionDao = _
  private var workflowExecutionsDao: WorkflowExecutionsDao = _
  private var workflowUserAccessDao: WorkflowUserAccessDao = _

  // What the lake holds of the open executions: the label of each log, by the log's URI. A log
  // that is not here does not exist, and one in `unreadable` cannot be read.
  private val labels = new ConcurrentHashMap[URI, ExecutionLabel]()
  private val unreadable = ConcurrentHashMap.newKeySet[URI]()
  private val labelsRead = new ConcurrentLinkedQueue[URI]()

  // The resource's clock, which a case sets.
  @volatile private var now = System.currentTimeMillis()

  private val resource = new AdminExecutionResource(
    new OpenExecutionStatuses(
      label = uri => {
        labelsRead.add(uri)
        if (unreadable.contains(uri)) throw new IllegalStateException("the lake is out of reach")
        Option(labels.get(uri))
      },
      warehousesEnabled = false
    ),
    () => now
  )

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
  }

  override protected def afterAll(): Unit = {
    shutdownDB()
  }

  override protected def beforeEach(): Unit = {
    userDao = new UserDao(getDSLContext.configuration())
    workflowDao = new WorkflowDao(getDSLContext.configuration())
    workflowVersionDao = new WorkflowVersionDao(getDSLContext.configuration())
    workflowExecutionsDao = new WorkflowExecutionsDao(getDSLContext.configuration())
    workflowUserAccessDao = new WorkflowUserAccessDao(getDSLContext.configuration())

    cleanupTestData()

    testUser = new User
    testUser.setUid(testUid)
    testUser.setName("test_user")
    testUser.setEmail("admin_exec_test@example.com")

    testWorkflow = new Workflow
    testWorkflow.setWid(testWid)
    testWorkflow.setName("test_workflow_" + UUID.randomUUID().toString.substring(0, 8))
    testWorkflow.setContent("{}")
    testWorkflow.setDescription("test description")
    testWorkflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    testWorkflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))

    testVersion = new WorkflowVersion
    testVersion.setWid(testWid)
    testVersion.setContent("{}")
    testVersion.setCreationTime(new Timestamp(System.currentTimeMillis()))

    userDao.insert(testUser)
    workflowDao.insert(testWorkflow)
    workflowVersionDao.insert(testVersion)
  }

  override protected def afterEach(): Unit = {
    cleanupTestData()
  }

  private def cleanupTestData(): Unit = {
    val vidSubquery = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.in(testWids))

    getDSLContext
      .deleteFrom(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.VID.in(vidSubquery))
      .execute()
    getDSLContext
      .deleteFrom(WORKFLOW_USER_ACCESS)
      .where(WORKFLOW_USER_ACCESS.WID.in(testWids))
      .execute()
    getDSLContext
      .deleteFrom(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.in(testWids))
      .execute()
    getDSLContext.deleteFrom(WORKFLOW).where(WORKFLOW.WID.in(testWids)).execute()
    getDSLContext.deleteFrom(USER).where(USER.UID.eq(testUid)).execute()
    labels.clear()
    unreadable.clear()
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /**
    * An execution of version `vid`, created `startOffsetMillis` ago. It is closed, as
    * `outcome`, `durationMillis` after that; with no duration it is open.
    */
  private def seedExecution(
      name: String = "run",
      startOffsetMillis: Long = 0L,
      durationMillis: Option[Long] = Some(1000L),
      outcome: Short = 3,
      vid: Integer = testVersion.getVid
  ): WorkflowExecutions = {
    val execution = new WorkflowExecutions
    execution.setVid(vid)
    execution.setUid(testUser.getUid)
    execution.setLogLocation("")
    val created = (System.currentTimeMillis() - startOffsetMillis) / 1000L * 1000L
    execution.setStartingTime(new Timestamp(created))
    durationMillis.foreach { duration =>
      execution.setOutcome(outcome)
      execution.setEndedAt(new Timestamp(created + duration))
    }
    execution.setBookmarked(false)
    execution.setName(name)
    execution.setEnvironmentVersion("test-env-1.0")
    workflowExecutionsDao.insert(execution)
    // As stored: a time written through the DAO keeps whole seconds.
    workflowExecutionsDao.fetchOneByEid(execution.getEid)
  }

  /** An open execution. */
  private def seedOpenExecution(
      name: String = "open-run",
      startOffsetMillis: Long = 0L,
      vid: Integer = testVersion.getVid
  ): WorkflowExecutions =
    seedExecution(
      name = name,
      startOffsetMillis = startOffsetMillis,
      durationMillis = None,
      vid = vid
    )

  private def logUriOf(execution: WorkflowExecutions, wid: Int = testWid): URI =
    ExecutionLogStore.logUri(
      WorkflowIdentity(wid),
      ExecutionIdentity(execution.getEid.longValue()),
      None
    )

  /** Gives the log of `execution` a label whose newest state is `state`. */
  private def label(execution: WorkflowExecutions, state: String, wid: Int = testWid): Unit =
    labels.put(
      logUriOf(execution, wid),
      ExecutionLabel(Some(state), 1L, now, None, now, 30000L)
    )

  private def grantAccess(uid: Int, privilege: PrivilegeEnum): Unit = {
    val access = new WorkflowUserAccess
    access.setUid(uid)
    access.setWid(testWid)
    access.setPrivilege(privilege)
    workflowUserAccessDao.insert(access)
  }

  /** A workflow `wid` owned by testUser, with one version; returns the version's id. */
  private def seedWorkflow(wid: Int): Integer = {
    val workflow = new Workflow
    workflow.setWid(wid)
    workflow.setName(s"workflow_${wid - testWid}_" + UUID.randomUUID().toString.substring(0, 8))
    workflow.setContent("{}")
    workflow.setDescription("another")
    workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    workflowDao.insert(workflow)

    val version = new WorkflowVersion
    version.setWid(wid)
    version.setContent("{}")
    version.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflowVersionDao.insert(version)
    version.getVid
  }

  // Seeds a full second workflow (workflow + version + one execution) owned by
  // testUser, whose latest execution ends `endOffsetMillis` before "now". Used to
  // give the ordering test two workflows with distinct end times.
  private def seedSecondWorkflow(endOffsetMillis: Long): Unit =
    seedExecution(
      name = "second-run",
      startOffsetMillis = endOffsetMillis + 1000,
      vid = seedWorkflow(secondWid)
    )

  private def emptyFilter: java.util.List[String] = new java.util.ArrayList[String]()

  private def filterOf(statuses: String*): java.util.List[String] = {
    val list = new java.util.ArrayList[String]()
    statuses.foreach(list.add)
    list
  }

  // Calls the admin listing as testUser with the default page window; keeps each
  // call site under the 100-column limit and centralizes the fixed arguments.
  private def list(
      sortField: String = "NO_SORTING",
      filter: java.util.List[String] = emptyFilter,
      sortDirection: String = "desc",
      pageSize: Int = 20,
      pageIndex: Int = 0
  ): List[AdminExecutionResource.dashboardExecution] =
    resource.listWorkflows(
      new SessionUser(testUser),
      pageSize,
      pageIndex,
      sortField,
      sortDirection,
      filter
    )

  // ─── pure status lookups (no DB) ─────────────────────────────────────────────

  "AdminExecutionResource.mapToName" should "map known status codes and default the rest" in {
    AdminExecutionResource.mapToName(0) shouldBe "READY"
    AdminExecutionResource.mapToName(1) shouldBe "RUNNING"
    AdminExecutionResource.mapToName(2) shouldBe "PAUSED"
    AdminExecutionResource.mapToName(3) shouldBe "COMPLETED"
    AdminExecutionResource.mapToName(4) shouldBe "FAILED"
    AdminExecutionResource.mapToName(5) shouldBe "KILLED"
    AdminExecutionResource.mapToName(6) shouldBe "CREATED"
    AdminExecutionResource.mapToName(99) shouldBe "UNKNOWN"
  }

  "AdminExecutionResource.mapToStatus" should "invert mapToName and map unknowns to -1" in {
    Seq("READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "KILLED").zipWithIndex.foreach {
      case (name, code) => AdminExecutionResource.mapToStatus(name) shouldBe code
    }
    AdminExecutionResource.mapToStatus("CREATED") shouldBe 6
    AdminExecutionResource.mapToStatus("NOT_A_STATUS") shouldBe -1
  }

  // ─── getTotalWorkflows ───────────────────────────────────────────────────────

  "getTotalWorkflows" should "count distinct workflows that have executions" in {
    resource.getTotalWorkflows shouldBe 0

    // two executions on the same workflow still count as one distinct workflow
    seedExecution()
    seedExecution()
    resource.getTotalWorkflows shouldBe 1
  }

  // ─── listWorkflows ───────────────────────────────────────────────────────────

  "listWorkflows" should "return the seeded execution with the mapped status and access flag" in {
    seedExecution(name = "completed-run")
    grantAccess(testUser.getUid, PrivilegeEnum.READ)

    val rows = list()

    rows should have size 1
    val row = rows.head
    row.workflowId shouldBe testWid
    row.userName shouldBe "test_user"
    row.executionName shouldBe "completed-run"
    row.executionStatus shouldBe "COMPLETED"
    row.access shouldBe true
  }

  it should "name an execution that was created and not started, and filter by that name" in {
    seedOpenExecution(name = "created-run")

    list().map(_.executionStatus) shouldBe List("CREATED")
    list(filter = filterOf("CREATED")).map(_.executionName) shouldBe List("created-run")
    list(filter = filterOf("READY", "RUNNING")) shouldBe empty
  }

  it should "name a closed execution by its outcome, whatever its log says" in {
    Seq[(Short, String)]((3, "COMPLETED"), (4, "FAILED"), (5, "KILLED")).foreach {
      case (outcome, name) =>
        val execution = seedExecution(outcome = outcome)
        // Its log, if anything read it, would say otherwise.
        label(execution, "PAUSED")
        val before = labelsRead.size

        list().map(_.executionStatus) shouldBe List(name)
        labelsRead.size shouldBe before
    }
  }

  it should "say why a closed execution ended as it did, and nothing of one that is open" in {
    val lost = seedExecution(name = "lost-run", outcome = 4)
    lost.setOutcomeReason("unit lost")
    workflowExecutionsDao.update(lost)

    list().map(entry => (entry.executionStatus, entry.reason)) shouldBe List(
      ("FAILED", "unit lost")
    )

    // A newer execution of the workflow that ended with nothing to say, then one still open.
    seedExecution(name = "plain-run", startOffsetMillis = -1000L)
    list().map(entry => (entry.executionStatus, entry.reason)) shouldBe List(("COMPLETED", null))
    val open = seedOpenExecution(startOffsetMillis = -2000L)
    label(open, "RUNNING")
    list().map(entry => (entry.executionStatus, entry.reason)) shouldBe List(("RUNNING", null))
  }

  it should "name an open execution by the newest state in its log" in {
    Seq("READY" -> "READY", "RUNNING" -> "RUNNING", "PAUSED" -> "PAUSED", "FAILED" -> "FAILED")
      .foreach {
        case (state, name) =>
          label(seedOpenExecution(), state)
          list().map(_.executionStatus) shouldBe List(name)
      }
  }

  it should "name an open execution whose log cannot be read UNKNOWN" in {
    unreadable.add(logUriOf(seedOpenExecution()))

    list().map(_.executionStatus) shouldBe List("UNKNOWN")
  }

  it should "report how long a closed execution took, and when it ended" in {
    val execution = seedExecution(startOffsetMillis = 60000L, durationMillis = Some(42000L))

    val row = list().head
    row.startTime shouldBe execution.getStartingTime.getTime
    row.endTime shouldBe execution.getEndedAt.getTime
    row.endTime shouldBe row.startTime + 42000L
    row.executionTime shouldBe 42.0
  }

  it should "report how long an open execution has taken so far, and no end" in {
    val execution = seedOpenExecution()
    now = execution.getStartingTime.getTime + 7250L

    val row = list().head
    row.endTime shouldBe 0L
    row.executionTime shouldBe 7.25
  }

  it should "report access = false when the current user has no WORKFLOW_USER_ACCESS row" in {
    seedExecution()

    val rows = list()

    rows should have size 1
    rows.head.access shouldBe false
  }

  it should "report access = true for the owner without an access row" in {
    seedExecution()
    getDSLContext
      .insertInto(WORKFLOW_OF_USER)
      .set(WORKFLOW_OF_USER.UID, Integer.valueOf(testUid))
      .set(WORKFLOW_OF_USER.WID, Integer.valueOf(testWid))
      .execute()

    list().head.access shouldBe true
  }

  it should "keep only the latest execution per workflow" in {
    seedExecution(name = "older")
    val latest = seedExecution(name = "newer")

    val rows = list()

    rows should have size 1
    rows.head.executionId shouldBe latest.getEid
    rows.head.executionName shouldBe "newer"
  }

  it should "narrow the result to executions whose status is in the filter" in {
    // The listing returns the latest execution per workflow; a RUNNING latest passes a
    // RUNNING filter, and is excluded by a COMPLETED-only filter.
    label(seedOpenExecution(name = "running-run"), "RUNNING")

    list(filter = filterOf("RUNNING")) should have size 1
    list(filter = filterOf("COMPLETED")) shouldBe empty
    list(filter = filterOf("PAUSED", "CREATED")) shouldBe empty
    list(filter = filterOf("COMPLETED", "RUNNING")) should have size 1
  }

  it should "filter closed executions by their outcome, without reading the lake" in {
    // Failed, although its log says it runs.
    val failed = seedExecution(name = "failed-run", outcome = 4)
    label(failed, "RUNNING")
    val before = labelsRead.size

    list(filter = filterOf("FAILED")).map(_.executionName) shouldBe List("failed-run")
    list(filter = filterOf("FAILED", "KILLED")).map(_.executionName) shouldBe List("failed-run")
    list(filter = filterOf("COMPLETED")) shouldBe empty
    labelsRead.size shouldBe before
    list(filter = filterOf("RUNNING")) shouldBe empty
  }

  // The status of an open execution is not in its row, so the page cannot be cut by the query.
  it should "cut the page after filtering by the status of open executions" in {
    // Five workflows, by name: paused, running, completed, running, running.
    val states = Seq("PAUSED", "RUNNING", "COMPLETED", "RUNNING", "RUNNING")
    val wids = states.zipWithIndex.map {
      case (state, index) =>
        val wid = testWid + 1 + index
        val vid = seedWorkflow(wid)
        getDSLContext
          .update(WORKFLOW)
          .set(WORKFLOW.NAME, s"paged-$index")
          .where(WORKFLOW.WID.eq(Integer.valueOf(wid)))
          .execute()
        if (state == "COMPLETED") seedExecution(vid = vid)
        else label(seedOpenExecution(vid = vid), state, wid)
        wid
    }
    def page(index: Int) =
      list("workflow_name", filterOf("RUNNING"), "asc", pageSize = 2, pageIndex = index)
        .map(_.workflowId)

    page(0) shouldBe List(wids(1), wids(3))
    page(1) shouldBe List(wids(4))
    page(2) shouldBe empty
    list("workflow_name", filterOf("RUNNING", "COMPLETED"), "asc", pageSize = 2, pageIndex = 1)
      .map(_.workflowId) shouldBe List(wids(3), wids(4))
    // Without such a filter the query cuts the page.
    list("workflow_name", emptyFilter, "asc", pageSize = 2, pageIndex = 1)
      .map(_.workflowId) shouldBe List(wids(2), wids(3))
  }

  it should "order the results by the sort field and direction" in {
    // testWid's latest execution ends ~now; the second workflow's ends 10 minutes earlier.
    seedExecution(name = "recent")
    seedSecondWorkflow(endOffsetMillis = TimeUnit.MINUTES.toMillis(10))

    // desc by end_time -> the more recently finished workflow (testWid) comes first
    list(sortField = "end_time").map(_.workflowId) shouldBe List(testWid, secondWid)

    // asc by end_time -> the older one comes first
    list(sortField = "end_time", sortDirection = "asc").map(_.workflowId) shouldBe
      List(secondWid, testWid)
  }

  it should "order an open execution as ending after every closed one" in {
    seedExecution(name = "closed")
    seedOpenExecution(vid = seedWorkflow(secondWid), startOffsetMillis = 60000L)

    list(sortField = "end_time").map(_.workflowId) shouldBe List(secondWid, testWid)
    list(sortField = "end_time", sortDirection = "asc").map(_.workflowId) shouldBe
      List(testWid, secondWid)
  }
}
