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

import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import io.dropwizard.setup.Bootstrap
import org.apache.texera.amber.core.executor.{ExecFactory, OpExecWithClassName}
import org.apache.texera.amber.core.state.StateReferencing
import org.apache.texera.amber.core.storage.result.ResultSchema
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  InputLink,
  InputLinker,
  ListedFile,
  NoStoredPlanException,
  PlanRecord,
  VFSURIFactory
}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  ExecutionMode,
  ExecutionPlan,
  GlobalPortIdentity,
  PhysicalPlanCodec,
  PlanInput,
  PortIdentity,
  PreferCoordinator,
  PythonEnvironment,
  PythonEnvironmentRef,
  ReplaySource,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.COMPILATION_ERROR
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.projection.{AttributeUnit, ProjectionOpDesc}
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.{FileScanOpDesc, FileScanSourceOpDesc}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.compiler.RunBindings
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.dao.{MockTexeraDB, SiteSettings, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables.{
  COMPUTING_UNIT_USER_ACCESS,
  DATASET_USER_ACCESS,
  OPERATOR_EXECUTIONS,
  SITE_SETTINGS,
  USER_WAREHOUSE,
  VIRTUAL_ENVIRONMENTS,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_OF_USER,
  WORKFLOW_USER_ACCESS,
  WORKFLOW_VERSION
}
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
  UserWarehouseFlavorEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  DatasetVersionDao,
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  Dataset,
  DatasetVersion,
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowExecutions,
  WorkflowVersion
}
import org.apache.texera.web.model.http.request.execution.{
  CreateExecutionRequest,
  ReplayExecutionInfo
}
import org.apache.texera.web.model.http.response.execution.{
  CreateExecutionFailure,
  CreateExecutionResponse
}
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.service.WorkflowService
import org.apache.texera.web.service.execution.{CostHintsLoader, ExecutionCreator}
import org.apache.texera.web.{TexeraWebApplication, TexeraWebConfiguration}
import org.jooq.JSONB
import org.jooq.exception.DataAccessException
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.lang.reflect.Proxy
import java.net.URI
import java.nio.charset.StandardCharsets
import java.sql.Timestamp
import javax.ws.rs.core.{Response, UriInfo}
import javax.ws.rs.{BadRequestException, InternalServerErrorException, WebApplicationException}
import scala.collection.mutable
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Creating an execution at the Dashboard service, through [[ExecutionResource]].
  *
  * The rows are in `MockTexeraDB`; plans, results and consoles are tables of the catalog the
  * build's tests use (the Postgres JDBC catalog in CI), named after this suite's own workflow and
  * execution ids. The executions it creates take ids after 962000, set in `beforeAll`, so their
  * plan tables and their large binaries' prefixes are this suite's own too. Plans are compiled
  * with the fixture resolvers and linker of `TestOperators` (scan files on the local disk, read
  * through links to its server) unless a case binds them otherwise, and the cost hints, the
  * replay log root and the warehouse switch are the creator's seams.
  *
  * Users: `creatorUid` owns the workflows and most units; `readerUid` may only read
  * `testWid`, only read `unitCuid`, and owns `readerCuid`; `strangerUid` has no right to
  * `testWid` and owns `strangerCuid`.
  */
class ExecutionResourceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val creatorUid = 9601
  private val readerUid = 9602
  private val strangerUid = 9603
  private val creatorEmail = "creator-9601@example.com"

  private val testWid = 9611
  private val otherWid = 9612
  private val workflowName = "execution-resource-spec-workflow"

  private val unitCuid = 9621
  private val readerCuid = 9622
  private val terminatedCuid = 9623
  private val otherUnitCuid = 9624
  private val strangerCuid = 9625
  private val unknownCuid = 9699

  /**
    * Executions of the fixtures: a replay log to replay, none, one of another workflow, and one
    * at a location that is not an absolute URI.
    */
  private val replaySourceEid = 961901
  private val noLogEid = 961902
  private val otherWorkflowEid = 961903
  private val relativeLogEid = 961904
  private val replayLog = s"file:///tmp/texera-spec-replay-logs/$testWid/$replaySourceEid/"

  /** The executions this suite creates start after this id, far below 969001. */
  private val firstCreatedEid = 962000

  private val creatorWarehouse = s"user-$creatorUid-spec"
  private var creatorWhid: Integer = _
  private var strangerWhid: Integer = _

  // A private dataset of the creator's, with one version, and a file of it as a scan names it and
  // as the creator's resolver resolves it.
  private val notesDid = 9631
  private val notesVersionHash = "5f0c7a1be2d94c3fa6b87d10e4c9a2b35d6e7f80"
  private val notesPath = s"/dataset/$creatorEmail/execution-resource-notes/v1/2026/notes.txt"
  private val notesUri = new URI(s"dataset:///dataset-$notesDid/$notesVersionHash/2026/notes.txt")

  private val requestUri = new URI("http://texera.example:4200/api/executions")
  private val logRoot = new URI("file:///tmp/texera-spec-replay-logs/")

  /** Every plan, result and console table this suite makes, dropped after it. */
  private val madePlans = mutable.ListBuffer.empty[URI]
  private val madeTables = mutable.ListBuffer.empty[URI]

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val cfg = getDSLContext.configuration()

    Seq(
      creatorUid -> creatorEmail,
      readerUid -> "reader-9602@example.com",
      strangerUid -> "stranger-9603@example.com"
    ).foreach {
      case (uid, email) =>
        val user = new User
        user.setUid(uid)
        user.setName(s"execution-resource-user-$uid")
        user.setEmail(email)
        user.setRole(UserRoleEnum.REGULAR)
        new UserDao(cfg).insert(user)
    }

    Seq(testWid -> workflowName, otherWid -> "execution-resource-spec-other").foreach {
      case (wid, name) =>
        val workflow = new Workflow
        workflow.setWid(wid)
        workflow.setName(name)
        workflow.setContent("{}")
        workflow.setDescription("")
        workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
        workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
        new WorkflowDao(cfg).insert(workflow)
        val version = new WorkflowVersion
        version.setWid(wid)
        version.setContent("{}")
        version.setCreationTime(new Timestamp(System.currentTimeMillis()))
        new WorkflowVersionDao(cfg).insert(version)
        getDSLContext
          .insertInto(WORKFLOW_OF_USER)
          .set(WORKFLOW_OF_USER.UID, Integer.valueOf(creatorUid))
          .set(WORKFLOW_OF_USER.WID, Integer.valueOf(wid))
          .execute()
    }
    getDSLContext
      .insertInto(WORKFLOW_USER_ACCESS)
      .set(WORKFLOW_USER_ACCESS.UID, Integer.valueOf(readerUid))
      .set(WORKFLOW_USER_ACCESS.WID, Integer.valueOf(testWid))
      .set(WORKFLOW_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()

    Seq(
      (unitCuid, creatorUid, false),
      (readerCuid, readerUid, false),
      (terminatedCuid, creatorUid, true),
      (otherUnitCuid, creatorUid, false),
      (strangerCuid, strangerUid, false)
    ).foreach {
      case (cuid, owner, terminated) =>
        val unit = new WorkflowComputingUnit
        unit.setCuid(cuid)
        unit.setUid(owner)
        unit.setName(s"execution-resource-unit-$cuid")
        unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
        if (terminated) unit.setTerminateTime(new Timestamp(System.currentTimeMillis()))
        unit.setType(WorkflowComputingUnitTypeEnum.local)
        unit.setUri("local://test")
        unit.setResource("{}")
        new WorkflowComputingUnitDao(cfg).insert(unit)
    }
    getDSLContext
      .insertInto(COMPUTING_UNIT_USER_ACCESS)
      .set(COMPUTING_UNIT_USER_ACCESS.CUID, Integer.valueOf(unitCuid))
      .set(COMPUTING_UNIT_USER_ACCESS.UID, Integer.valueOf(readerUid))
      .set(COMPUTING_UNIT_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()

    val notes = new Dataset
    notes.setDid(notesDid)
    notes.setOwnerUid(creatorUid)
    notes.setName("execution-resource-notes")
    notes.setRepositoryName(s"dataset-$notesDid")
    notes.setIsPublic(false)
    notes.setDescription("")
    new DatasetDao(cfg).insert(notes)
    val notesVersion = new DatasetVersion
    notesVersion.setDid(notesDid)
    notesVersion.setCreatorUid(creatorUid)
    notesVersion.setName("v1")
    notesVersion.setVersionHash(notesVersionHash)
    new DatasetVersionDao(cfg).insert(notesVersion)

    creatorWhid = insertWarehouse(creatorUid, creatorWarehouse)
    strangerWhid = insertWarehouse(strangerUid, s"user-$strangerUid-spec")

    insertExecution(replaySourceEid, testWid, unitCuid, status = 3, logLocation = Some(replayLog))
    insertExecution(noLogEid, testWid, unitCuid, status = 3)
    insertExecution(otherWorkflowEid, otherWid, unitCuid, status = 3, logLocation = Some(replayLog))
    insertExecution(relativeLogEid, testWid, unitCuid, status = 3, Some("relative/logs/"))

    // Executions created below take ids after every fixture's. The table is qualified from the
    // generated metadata, as the connection's search_path does not hold texera_db.
    getDSLContext.execute(
      "select setval(pg_get_serial_sequence(?, ?), ?, true)",
      s"${WORKFLOW_EXECUTIONS.getSchema.getName}.${WORKFLOW_EXECUTIONS.getName}",
      WORKFLOW_EXECUTIONS.EID.getName,
      Integer.valueOf(firstCreatedEid)
    )
  }

  override protected def afterAll(): Unit =
    try {
      madePlans.foreach(uri => Try(ExecutionPlanStore.drop(uri)))
      madeTables.foreach(uri => Try(DocumentFactory.openDocument(uri)._1.clear()))
    } finally {
      closeConnectionPool()
      super.afterAll()
    }

  // --- fixtures ---

  private def insertWarehouse(uid: Int, name: String): Integer = {
    val row = getDSLContext.newRecord(USER_WAREHOUSE)
    row.setUid(uid)
    row.setName(name)
    row.setLakekeeperWarehouseName(name)
    row.setLakekeeperWarehouseId(java.util.UUID.randomUUID())
    row.setFlavor(UserWarehouseFlavorEnum.local)
    row.store()
    row.getWhid
  }

  private def insertExecution(
      eid: Int,
      wid: Int,
      cuid: Int,
      status: Short,
      logLocation: Option[String] = None
  ): Unit = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(wid)))
      .fetchOneInto(classOf[Integer])
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(creatorUid))
      .set(WORKFLOW_EXECUTIONS.CUID, Integer.valueOf(cuid))
      .set(WORKFLOW_EXECUTIONS.STATUS, java.lang.Short.valueOf(status))
      .set(WORKFLOW_EXECUTIONS.LOG_LOCATION, logLocation.orNull)
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

  private def hasTable(uri: URI): Boolean = Try(DocumentFactory.openDocument(uri)).isSuccess

  private def consolesOf(eid: Int): Int =
    getDSLContext.fetchCount(
      OPERATOR_EXECUTIONS,
      OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(Integer.valueOf(eid))
    )

  private def executionCount: Int = getDSLContext.fetchCount(WORKFLOW_EXECUTIONS)

  private def row(eid: Long): WorkflowExecutions =
    new WorkflowExecutionsDao(getDSLContext.configuration())
      .fetchOneByEid(Integer.valueOf(eid.toInt))

  /** The cost hints the creator is handed, and the (workflow, user) each load asked for. */
  private class RecordingHints(hints: Option[CostHints]) extends CostHintsLoader(1) {
    val asked: mutable.ListBuffer[(Long, Int)] = mutable.ListBuffer.empty
    override def load(wid: Long, uid: Int): Option[CostHints] = {
      asked += ((wid, uid))
      hints
    }
  }

  /** Cost hints that cannot be found, for a reason that is not the workflow's: `failure`. */
  private class FailingHints(failure: RuntimeException) extends RecordingHints(None) {
    override def load(wid: Long, uid: Int): Option[CostHints] = throw failure
  }

  /**
    * The creator under test, bound to the fixture files, links and versions in place of a
    * user's, and with seams set as the case needs. `resolvedFor` records the user each plan was
    * bound for. The site's settings stay the ones the database holds.
    *
    * @param bindings what a plan is bound to, given what the deployment binds it to for its
    *                 user; the fixtures', unless a case gives another
    */
  private class FixtureCreator(
      logRoot: Option[URI] = None,
      warehouses: Boolean = false,
      val hints: RecordingHints = new RecordingHints(None),
      failWrite: Option[RuntimeException] = None,
      bindings: RunBindings => RunBindings = _ => TestUtils.fixtureBindings
  ) extends ExecutionCreator {
    val resolvedFor: mutable.ListBuffer[Integer] = mutable.ListBuffer.empty
    override protected def bindingsFor(uid: Integer): RunBindings = {
      resolvedFor += uid
      val forUser = super.bindingsFor(uid)
      bindings(forUser).copy(settings = forUser.settings)
    }
    override protected def replayLogRoot: Option[URI] = logRoot
    override protected def warehousesEnabled: Boolean = warehouses
    override protected def costHintsLoader: CostHintsLoader = hints
    override protected def writePlan(planUri: URI, record: PlanRecord, logical: String): Unit =
      failWrite match {
        case Some(failure) => throw failure
        case None          => super.writePlan(planUri, record, logical)
      }
  }

  private def sessionUser(uid: Int): SessionUser = {
    val user = new User
    user.setUid(uid)
    user.setName(s"execution-resource-user-$uid")
    user.setEmail(if (uid == creatorUid) creatorEmail else s"user-$uid@example.com")
    user.setRole(UserRoleEnum.REGULAR)
    new SessionUser(user)
  }

  private val uriInfo: UriInfo =
    Proxy
      .newProxyInstance(
        classOf[UriInfo].getClassLoader,
        Array[Class[_]](classOf[UriInfo]),
        (_, method, _) =>
          method.getName match {
            case "getRequestUri" => requestUri
            case other           => throw new UnsupportedOperationException(other)
          }
      )
      .asInstanceOf[UriInfo]

  private def post(
      request: CreateExecutionRequest,
      uid: Int = creatorUid,
      creator: FixtureCreator = new FixtureCreator()
  ): Response = {
    val fixture = creator
    new ExecutionResource {
      override protected def creator: ExecutionCreator = fixture
    }.create(request, sessionUser(uid), uriInfo)
  }

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  /** A scan of a fixture file, then a search on what it reads. */
  private def searchPlan(): LogicalPlanPojo =
    LogicalPlanPojo(
      List(
        named(TestOperators.smallCsvScanOpDesc(), "scan"),
        named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search")
      ),
      List(link("scan", "search")),
      List.empty,
      List.empty
    )

  /** A scan with no file chosen, then a search on what it would read. */
  private def brokenPlan(): LogicalPlanPojo =
    LogicalPlanPojo(
      List(
        named(new CSVScanSourceOpDesc(), "scan"),
        named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search")
      ),
      List(link("scan", "search")),
      List.empty,
      List.empty
    )

  private val sentSettings = WorkflowSettings(77, ExecutionMode.MATERIALIZED)

  private def request(
      plan: LogicalPlanPojo = searchPlan(),
      wid: Long = testWid,
      cuid: Int = unitCuid,
      settings: Option[WorkflowSettings] = Some(sentSettings),
      emailNotificationEnabled: Boolean = false,
      warehouseId: Option[Int] = None,
      replay: Option[ReplayExecutionInfo] = None,
      targets: List[String] = Nil
  ): CreateExecutionRequest =
    CreateExecutionRequest(
      wid = wid,
      executionName = "spec-execution",
      engineVersion = "1.4.0-spec",
      logicalPlan = plan,
      workflowSettings = settings,
      emailNotificationEnabled = emailNotificationEnabled,
      computingUnitId = cuid,
      warehouseId = warehouseId,
      replayFromExecution = replay,
      targetOperatorIds = targets
    )

  /** The execution a 201 created; its plan table is dropped after the suite. */
  private def created(response: Response): CreateExecutionResponse = {
    withClue(s"${response.getEntity}: ") { response.getStatus shouldBe 201 }
    val execution = response.getEntity.asInstanceOf[CreateExecutionResponse]
    madePlans += new URI(execution.planUri)
    execution
  }

  private def compileFailure(response: Response): CreateExecutionFailure = {
    response.getStatus shouldBe 400
    response.getEntity.asInstanceOf[CreateExecutionFailure]
  }

  /** The plan row of `execution`, and its body decoded. */
  private def storedPlan(execution: CreateExecutionResponse): (PlanRecord, ExecutionPlan) = {
    val record = ExecutionPlanStore.readPlan(new URI(execution.planUri))
    (record, PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(record.body)))
  }

  /** The logical plan kept beside the plan row of `execution`: what its plan was compiled from. */
  private def logicalPlanOf(execution: CreateExecutionResponse): String =
    ExecutionPlanStore.readPlanWithLogical(new URI(execution.planUri))._2

  /** The id of the execution created last. */
  private def newestEid: Int =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.EID)
      .from(WORKFLOW_EXECUTIONS)
      .orderBy(WORKFLOW_EXECUTIONS.EID.desc())
      .limit(1)
      .fetchOneInto(classOf[Integer])
      .intValue()

  /**
    * `plan` as an editor sends it, written as JSON: but for each operator's loop-variable sidecar,
    * which a parse sets from scratch, and for what a compile sets on an operator (a scan's column
    * limit, the links to the files it reads, a File Lister's listing), all of which the plan row
    * leaves out.
    */
  private def asSent(plan: LogicalPlanPojo): JsonNode = {
    val tree = objectMapper.readTree(objectMapper.writeValueAsString(plan))
    tree.get("operators").elements().asScala.foreach { operator =>
      Seq(StateReferencing.SIDECAR_PROPERTY, "maxColumns", "inputLinks", "listing")
        .foreach(operator.asInstanceOf[ObjectNode].remove)
    }
    tree
  }

  /** The descriptor the stored `plan` gives the executor of operator `id`, as JSON. */
  private def descriptorOf(plan: ExecutionPlan, id: String): JsonNode =
    plan.plan.getPhysicalOpsOfLogicalOp(OperatorIdentity(id)).head.opExecInitInfo match {
      case OpExecWithClassName(_, descString) => objectMapper.readTree(descString)
      case other                              => fail(s"the executor of $id is $other")
    }

  /** The links the stored `plan` gives the executor of scan `id`, by the name of each file. */
  private def linksOf(plan: ExecutionPlan, id: String): Map[String, InputLink] =
    descriptorOf(plan, id)
      .get("inputLinks")
      .fields()
      .asScala
      .map(entry => entry.getKey -> objectMapper.treeToValue(entry.getValue, classOf[InputLink]))
      .toMap

  /** A scan of the creator's private dataset file, which reads nothing of it to compile. */
  private def notesPlan(): LogicalPlanPojo = {
    val scan = named(new FileScanSourceOpDesc(), "notes")
    scan.fileName = Some(notesPath)
    LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)
  }

  /** A link as the deployment's linker signs one. */
  private val signedLink = InputLink(
    "http://texera-rustfs:9000/texera-dataset/dataset-9631/data/gdm5?X-Amz-Signature=5ecr3t",
    System.currentTimeMillis() + 3600L * 1000
  )

  /** A linker of the files resolvers resolve, each as `link` links it, and of no listed file. */
  private def linkerOf(linkFile: URI => InputLink): InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = linkFile(fileUri)
      override def linkListed(file: ListedFile): InputLink =
        fail(s"asked to link the listed file ${file.logicalPath}")
    }

  /**
    * A creator bound as the deployment binds a plan for its user, files resolved as the user may
    * read them, but for the links, which `link` makes in place of LakeFS and the object store.
    */
  private def creatorLinkingWith(link: URI => InputLink): FixtureCreator =
    new FixtureCreator(bindings = _.copy(inputLinker = linkerOf(link)))

  /** The dataset version of the creator's private dataset, as a File Lister names it. */
  private val notesVersionPath = s"/dataset/$creatorEmail/execution-resource-notes/v1"

  /** A File Lister of the version at `versionPath`, then a File Scan From Input of its files. */
  private def listedPlan(versionPath: String): LogicalPlanPojo = {
    val lister = named(new FileListerSourceOpDesc(), "lister")
    lister.datasetVersionPath = versionPath
    LogicalPlanPojo(
      List(lister, named(new FileScanOpDesc(), "scan")),
      List(link("lister", "scan")),
      List.empty,
      List.empty
    )
  }

  /** The operators of the logical plan kept for `execution`, as JSON objects. */
  private def logicalOperators(execution: CreateExecutionResponse): List[JsonNode] =
    objectMapper.readTree(logicalPlanOf(execution)).get("operators").elements().asScala.toList

  /**
    * The message of the refusal `body` throws, which answers `status`; the refusal must leave no
    * execution behind.
    */
  private def refused(status: Int)(body: => Any): String = {
    val before = executionCount
    val refusal = intercept[WebApplicationException](body)
    refusal.getResponse.getStatus shouldBe status
    executionCount shouldBe before
    refusal.getMessage
  }

  private lazy val dashboardMapper: ObjectMapper = {
    val application = new TexeraWebApplication
    val bootstrap = new Bootstrap[TexeraWebConfiguration](application)
    application.initialize(bootstrap)
    bootstrap.getObjectMapper
  }

  // --- created ---

  "ExecutionResource.create" should
    "record the execution as Created, write its plan for the creator and answer 201" in {
    val creator = new FixtureCreator()
    val sent = request()
    val sentPlan = asSent(sent.logicalPlan)
    val before = System.currentTimeMillis()

    val execution = created(post(sent, creator = creator))

    execution.eid should be > firstCreatedEid.toLong
    execution.wid shouldBe testWid
    execution.computingUnitId shouldBe unitCuid
    execution.planUri shouldBe
      s"vfs:///wid/$testWid/eid/${execution.eid}/plan"

    val stored = row(execution.eid)
    // Created, which no reader takes for a run in progress: the column's default is Running, and
    // Initializing is what the unit records once it has started the execution.
    stored.getStatus shouldBe WorkflowExecutionStatus.Created
    stored.getStartingTime.getTime should be >= (before - 1000)
    stored.getUid shouldBe creatorUid
    stored.getCuid shouldBe unitCuid
    stored.getWhid shouldBe null
    stored.getName shouldBe "spec-execution"
    stored.getEnvironmentVersion shouldBe """{"engine_version":"1.4.0-spec"}"""
    stored.getLogLocation shouldBe null
    stored.getLastUpdateTime shouldBe null

    val (record, plan) = storedPlan(execution)
    record.entryId shouldBe ExecutionPlanStore.PlanEntryId
    record.createdBy shouldBe creatorUid
    record.computingUnitId shouldBe unitCuid
    record.notification shouldBe None
    // The logical plan as the request sent it, before the compile resolved its scan's file.
    objectMapper.readTree(logicalPlanOf(execution)) shouldBe sentPlan
    logicalPlanOf(execution) should include(TestOperators.CountrySalesSmallCsvPath)

    plan.context.workflowId shouldBe WorkflowIdentity(testWid)
    plan.context.executionId shouldBe ExecutionIdentity(execution.eid)
    plan.context.warehouse shouldBe None
    plan.context.workflowSettings.dataTransferBatchSize shouldBe 77
    plan.context.workflowSettings.executionMode shouldBe ExecutionMode.MATERIALIZED
    // The compiler found the ports whose results are stored: those of the last operator.
    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId) shouldBe
      Set(OperatorIdentity("search"))
    plan.plan.operators.map(_.id.logicalOpId) shouldBe
      Set(OperatorIdentity("scan"), OperatorIdentity("search"))
    plan.replay shouldBe None
    plan.replayLog shouldBe None
    // The scan's file is the plan's one input, read through the link the scan's executor is
    // given, which lasts as long as the plan says.
    val scanned = TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath)
    val links = linksOf(plan, "scan")
    links.keySet shouldBe Set(scanned.toASCIIString)
    val link = links(scanned.toASCIIString)
    link.expiresAtMs should be > System.currentTimeMillis()
    plan.inputs shouldBe Seq(
      PlanInput(OperatorIdentity("scan"), scanned.toASCIIString, link.expiresAtMs)
    )

    // Compiled as the creator may read files, datasets and models.
    creator.resolvedFor.toSet shouldBe Set(Integer.valueOf(creatorUid))
  }

  it should "save the cost hints of the creator's runs of the workflow with the plan" in {
    val hints = CostHints(ExecutionIdentity(replaySourceEid), Map("scan" -> 2.5, "gone" -> 0.0))
    val creator = new FixtureCreator(hints = new RecordingHints(Some(hints)))

    val (_, plan) = storedPlan(created(post(request(), creator = creator)))

    plan.context.costHints shouldBe Some(hints)
    creator.hints.asked.toList shouldBe List((testWid.toLong, creatorUid))
  }

  it should "keep where the run writes its replay log, in the row and in the plan" in {
    val execution =
      created(post(request(), creator = new FixtureCreator(logRoot = Some(logRoot))))

    // <root>/<wid>/<eid>/, as the root resolves it (java.net.URI drops the empty authority).
    val location = s"file:/tmp/texera-spec-replay-logs/$testWid/${execution.eid}/"
    row(execution.eid).getLogLocation shouldBe location
    storedPlan(execution)._2.replayLog shouldBe Some(new URI(location))
  }

  it should "save the replay log the run replays with the plan" in {
    val execution = created(
      post(request(replay = Some(ReplayExecutionInfo(replaySourceEid, "interaction-1"))))
    )

    storedPlan(execution)._2.replay shouldBe Some(
      ReplaySource(ExecutionIdentity(replaySourceEid), new URI(replayLog), "interaction-1")
    )
  }

  it should "write into the creator's warehouse while per-user warehouses are enabled" in {
    val execution = created(
      post(
        request(warehouseId = Some(creatorWhid)),
        creator = new FixtureCreator(warehouses = true)
      )
    )

    execution.planUri shouldBe
      s"vfs:///wh/$creatorWarehouse/wid/$testWid/eid/${execution.eid}/plan"
    row(execution.eid).getWhid shouldBe creatorWhid
    storedPlan(execution)._2.context.warehouse shouldBe Some(creatorWarehouse)
  }

  it should "give the run the default settings when the request sends none" in {
    val (_, plan) = storedPlan(created(post(request(settings = None))))

    plan.context.workflowSettings.dataTransferBatchSize shouldBe
      ApplicationConfig.defaultDataTransferBatchSize
    plan.context.workflowSettings.executionMode shouldBe WorkflowSettings().executionMode
    plan.context.workflowSettings.outputPortsNeedingStorage should not be empty
  }

  it should "find the ports whose results are stored itself, whatever the request says" in {
    val ghost =
      GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("ghost"), "main"), PortIdentity())
    val sent = Some(sentSettings.copy(outputPortsNeedingStorage = Set(ghost)))

    val (_, plan) = storedPlan(created(post(request(settings = sent))))

    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId) shouldBe
      Set(OperatorIdentity("search"))
  }

  it should "save the plan under the site's CSV column limit as it stands, whatever the request says" in {
    // The limit is fixed in the plan when the execution is created: the unit that runs it asks
    // the site for none.
    val scan = named(TestOperators.smallCsvScanOpDesc(), "scan")
    scan.maxColumns = Some(100000)
    SiteSettings.upsert(getDSLContext, "csv_parser_max_columns", "731", "spec")
    try {
      val sent = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)

      val (_, plan) = storedPlan(created(post(request(plan = sent))))

      plan.plan.getPhysicalOpsOfLogicalOp(OperatorIdentity("scan")).head.opExecInitInfo match {
        case OpExecWithClassName(_, descString) =>
          objectMapper.readTree(descString).get("maxColumns").asInt() shouldBe 731
        case other => fail(s"the scan's executor is $other")
      }
    } finally {
      getDSLContext
        .deleteFrom(SITE_SETTINGS)
        .where(SITE_SETTINGS.KEY.eq("csv_parser_max_columns"))
        .execute()
    }
  }

  it should "link each file the creator may read, in the plan it stores and nowhere else" in {
    val linked = mutable.ListBuffer.empty[URI]
    val creator = creatorLinkingWith { file =>
      linked += file
      signedLink
    }

    val execution = created(post(request(plan = notesPlan()), creator = creator))
    val (record, plan) = storedPlan(execution)

    // Resolved for the creator, by the name as typed, and that file linked.
    linked.toList shouldBe List(notesUri)
    linksOf(plan, "notes") shouldBe Map(notesUri.toASCIIString -> signedLink)
    descriptorOf(plan, "notes").get("fileName").asText() shouldBe notesUri.toASCIIString
    plan.inputs shouldBe Seq(
      PlanInput(OperatorIdentity("notes"), notesUri.toASCIIString, signedLink.expiresAtMs)
    )
    // The link is a secret of the plan to run. The logical plan beside it is the workflow as
    // its user wrote it: the file by its name, and no link.
    record.body should include("X-Amz-Signature=5ecr3t")
    logicalPlanOf(execution) should not include "X-Amz-Signature"
    val logical = logicalOperators(execution).head
    logical.get("fileName").asText() shouldBe notesPath
    logical.has("inputLinks") shouldBe false
  }

  it should "refuse a file its creator may not read as the scan's error, and make no link to it" in {
    // The reader may read the workflow and run it on a unit of their own, but not the dataset
    // its scan names, which is the creator's and private.
    val linked = mutable.ListBuffer.empty[URI]
    val creator = creatorLinkingWith { file =>
      linked += file
      signedLink
    }
    def createdByReader(): Response =
      post(request(plan = notesPlan(), cuid = readerCuid), uid = readerUid, creator = creator)

    val failure = compileFailure(createdByReader())

    failure.operatorErrors.keySet shouldBe Set("notes")
    val error = failure.operatorErrors("notes")
    error.`type` shouldBe COMPILATION_ERROR
    error.message should startWith("org.apache.commons.vfs2.FileNotFoundException")
    error.message should include(notesPath)
    linked shouldBe empty
    row(failure.eid).getStatus shouldBe 4.toByte
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
      ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(failure.eid), None)
    )

    // Once the dataset is shared with the reader, the same request makes a plan with its link.
    getDSLContext
      .insertInto(DATASET_USER_ACCESS)
      .set(DATASET_USER_ACCESS.DID, Integer.valueOf(notesDid))
      .set(DATASET_USER_ACCESS.UID, Integer.valueOf(readerUid))
      .set(DATASET_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()
    try {
      val (_, plan) = storedPlan(created(createdByReader()))

      linked.toList shouldBe List(notesUri)
      linksOf(plan, "notes") shouldBe Map(notesUri.toASCIIString -> signedLink)
    } finally {
      getDSLContext
        .deleteFrom(DATASET_USER_ACCESS)
        .where(DATASET_USER_ACCESS.DID.eq(Integer.valueOf(notesDid)))
        .execute()
    }
  }

  // --- Python environments ---

  /** Saves `packages`, a JSON object, as user `uid`'s environment `name`. */
  private def saveEnvironment(uid: Int, name: String, packages: String): Unit =
    getDSLContext
      .insertInto(VIRTUAL_ENVIRONMENTS)
      .set(VIRTUAL_ENVIRONMENTS.UID, Integer.valueOf(uid))
      .set(VIRTUAL_ENVIRONMENTS.NAME, name)
      .set(VIRTUAL_ENVIRONMENTS.PACKAGES, JSONB.valueOf(packages))
      .execute()

  /** A text source, then a Python UDF, `udf`, that asks to run in the environment `name`. */
  private def udfPlanIn(name: String): LogicalPlanPojo = {
    val text = named(new TextInputSourceOpDesc(), "text")
    text.textInput = "one\ntwo"
    val udf = named(TestOperators.pythonOpDesc(), "udf")
    udf.defaultEnv = false
    udf.envName = name
    LogicalPlanPojo(List(text, udf), List(link("text", "udf")), List.empty, List.empty)
  }

  /**
    * A creator bound to the fixtures, but for the environments, which are resolved as the
    * deployment resolves them for its user: from the rows the user keeps.
    */
  private def creatorOfOwnEnvironments(): FixtureCreator =
    new FixtureCreator(
      bindings = forUser => TestUtils.fixtureBindings.copy(environments = forUser.environments)
    )

  /** The environment the stored plan of `execution` gives its operator `udf`. */
  private def environmentOf(execution: CreateExecutionResponse): PythonEnvironmentRef =
    storedPlan(execution)._2.plan
      .getOperator(PhysicalOpIdentity(OperatorIdentity("udf"), "main"))
      .pythonEnvironment

  it should "resolve the Python environment a UDF names to its creator's own, and store what it holds in the plan" in {
    // Two users keep an environment under one name, each their own packages.
    saveEnvironment(
      creatorUid,
      "shared-name",
      """{"Tabulate": "==0.9.0", "typing_extensions": ""}"""
    )
    saveEnvironment(readerUid, "shared-name", """{"requests": ">=2.0"}""")
    val creator = creatorOfOwnEnvironments()

    val execution = created(post(request(plan = udfPlanIn("shared-name")), creator = creator))

    // The creator's, as canonical lines: what the unit that runs the plan installs.
    val creators = PythonEnvironment("shared-name", Seq("tabulate==0.9.0", "typing-extensions"))
    environmentOf(execution) shouldBe PythonEnvironmentRef.Resolved(creators)
    val (_, plan) = storedPlan(execution)
    // Its workers run where the unit installs environments.
    plan.plan
      .getOperator(PhysicalOpIdentity(OperatorIdentity("udf"), "main"))
      .locationPreference shouldBe Some(PreferCoordinator)
    // The logical plan beside it is the workflow as its user wrote it: the name alone.
    val logical = logicalOperators(execution).find(_.get("operatorID").asText() == "udf").get
    logical.get("envName").asText() shouldBe "shared-name"
    logicalPlanOf(execution) should not include "tabulate"
    // The reader, who may run the workflow on a unit of their own, gets their own environment
    // of that name.
    val readers = created(
      post(request(plan = udfPlanIn("shared-name"), cuid = readerCuid), readerUid, creator)
    )
    environmentOf(readers) shouldBe
      PythonEnvironmentRef.Resolved(PythonEnvironment("shared-name", Seq("requests>=2.0")))
    creator.resolvedFor.toList shouldBe List(
      Integer.valueOf(creatorUid),
      Integer.valueOf(readerUid)
    )
  }

  it should "refuse an environment its creator does not keep as the UDF's error, another user's included" in {
    saveEnvironment(strangerUid, "strangers-own", """{"tabulate": "==0.9.0"}""")

    Seq("strangers-own", "kept-by-nobody").foreach { name =>
      withClue(s"$name: ") {
        val failure = compileFailure(
          post(request(plan = udfPlanIn(name)), creator = creatorOfOwnEnvironments())
        )

        failure.operatorErrors.keySet shouldBe Set("udf")
        val error = failure.operatorErrors("udf")
        error.`type` shouldBe COMPILATION_ERROR
        error.operatorId shouldBe "udf"
        error.message shouldBe "org.apache.texera.common.compiler.PythonEnvironmentNotResolved: " +
          s"You have no Python environment named '$name'."
        // No plan is made to run in another environment, or in none.
        row(failure.eid).getStatus shouldBe 4.toByte
        a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
          ExecutionPlanStore.planUri(
            WorkflowIdentity(testWid),
            ExecutionIdentity(failure.eid),
            None
          )
        )
      }
    }
  }

  it should "refuse an environment saved with packages pip may not read as the UDF's error" in {
    // Rows saved before packages were checked, or written by hand.
    saveEnvironment(creatorUid, "with-an-extra", """{"tabulate": "==0.9.0", "pkg[extra]": ""}""")
    saveEnvironment(creatorUid, "with-an-option", """{"--index-url=https://example.com": ""}""")
    saveEnvironment(creatorUid, "not-an-object", """["tabulate==0.9.0"]""")

    def errorOf(name: String): String =
      compileFailure(post(request(plan = udfPlanIn(name)), creator = creatorOfOwnEnvironments()))
        .operatorErrors("udf")
        .message

    errorOf("with-an-extra") should endWith(
      "Python environment 'with-an-extra' cannot be installed: Package \"pkg[extra]\" is not " +
        "valid: it contains '['."
    )
    errorOf("with-an-option") should endWith(
      "Python environment 'with-an-option' cannot be installed: Package " +
        "\"--index-url=https://example.com\" is not valid: it starts with '-'."
    )
    errorOf("not-an-object") should endWith(
      "Python environment 'not-an-object' cannot be installed: its packages are not stored as " +
        "names with version bounds."
    )
  }

  it should "answer 500, not the UDF's error, when an environment cannot be resolved for a reason not the workflow's" in {
    val databaseDown = new DataAccessException("the database does not answer")
    val creator = new FixtureCreator(
      bindings = _ => TestUtils.fixtureBindings.copy(environments = _ => throw databaseDown)
    )

    val failure = intercept[InternalServerErrorException] {
      post(request(plan = udfPlanIn("ml")), creator = creator)
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getCause shouldBe databaseDown
    row(newestEid.toLong).getStatus shouldBe 4.toByte
  }

  it should "keep nothing a request sent for what a compile sets, in the plan or beside it" in {
    // As a request could send them: a column limit of its own, and links to a place of its own
    // choosing, under the scan's file as typed and as it resolves.
    val sentLink = InputLink("http://169.254.169.254/latest/meta-data", Long.MaxValue)
    val resolved = TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath).toASCIIString
    val scan = named(TestOperators.smallCsvScanOpDesc(), "scan")
    scan.maxColumns = Some(100000)
    scan.inputLinks = Map(resolved -> sentLink, TestOperators.CountrySalesSmallCsvPath -> sentLink)
    val sent = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)

    val execution = created(post(request(plan = sent)))
    val (record, plan) = storedPlan(execution)

    // The executor is given the compile's own link, to the fixture's server, and the site's
    // limit.
    val links = linksOf(plan, "scan")
    links.keySet shouldBe Set(resolved)
    links(resolved).url should startWith("http://127.0.0.1:")
    descriptorOf(plan, "scan").get("maxColumns").asInt() shouldBe
      CSVScanSourceOpDesc.DefaultMaxColumns
    record.body should not include "169.254.169.254"
    // And the logical plan kept beside it holds neither property, whatever was sent for it.
    logicalPlanOf(execution) should not include "169.254.169.254"
    val logical = logicalOperators(execution).head
    logical.has("fileName") shouldBe true
    logical.has("maxColumns") shouldBe false
    logical.has("inputLinks") shouldBe false
  }

  it should "list each File Lister's dataset version and link the files listed, in the plan it stores and nowhere else" in {
    // As a request could send it: with a listing and a link of its own choosing.
    val sent = listedPlan(TestOperators.fixtureDatasetVersionPath)
    val sentLink = InputLink("http://169.254.169.254/latest/meta-data", Long.MaxValue)
    sent.operators.head.asInstanceOf[FileListerSourceOpDesc].listing =
      Some(List("/dataset/another@example.com/secrets/v1/keys.txt"))
    sent.operators(1).asInstanceOf[FileScanOpDesc].inputLinks =
      Map("/dataset/another@example.com/secrets/v1/keys.txt" -> sentLink)
    val files = TestOperators.fixtureDatasetFiles.map {
      case (file, _) => s"${TestOperators.fixtureDatasetVersionPath}/$file"
    }

    val execution = created(post(request(plan = sent)))
    val (record, plan) = storedPlan(execution)

    // The File Lister's executor is given the version's listing, and the File Scan From Input's
    // a link to each file listed: the compile's own, to the fixture's server.
    descriptorOf(plan, "lister").get("listing").elements().asScala.map(_.asText()).toList shouldBe
      files
    val links = linksOf(plan, "scan")
    links.keySet shouldBe files.toSet
    links.values.foreach(_.url should startWith("http://127.0.0.1:"))
    plan.inputs shouldBe
      files.map(file => PlanInput(OperatorIdentity("scan"), file, links(file).expiresAtMs))
    record.body should not include "169.254.169.254"
    record.body should not include "secrets"
    // The logical plan kept beside it is the workflow as its user wrote it: the dataset version
    // by its path, and neither what it lists nor a link.
    val logicalPlan = logicalPlanOf(execution)
    logicalPlan should not include "169.254.169.254"
    logicalPlan should not include "secrets"
    files.foreach(file => logicalPlan should not include file)
    val List(lister, scan) = logicalOperators(execution)
    lister.get("datasetVersionPath").asText() shouldBe TestOperators.fixtureDatasetVersionPath
    lister.has("listing") shouldBe false
    scan.has("inputLinks") shouldBe false
  }

  it should "refuse a dataset version its creator may not read as the File Lister's error, and list nothing of it" in {
    // Bound as the deployment binds a plan for its user. The reader may read the workflow and
    // run it on a unit of their own, but not the dataset its File Lister names, which is the
    // creator's and private: the version is refused before the storage is asked what it holds.
    def createdByReader(): Response =
      post(
        request(plan = listedPlan(notesVersionPath), cuid = readerCuid),
        uid = readerUid,
        creator = new FixtureCreator(bindings = identity)
      )

    val failure = compileFailure(createdByReader())

    failure.operatorErrors.keySet shouldBe Set("lister")
    val error = failure.operatorErrors("lister")
    error.`type` shouldBe COMPILATION_ERROR
    error.message shouldBe s"java.lang.IllegalArgumentException: Dataset version " +
      s"$notesVersionPath was not found: it does not exist, or you do not have access to it."
    row(failure.eid).getStatus shouldBe 4.toByte
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
      ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(failure.eid), None)
    )

    // Once the dataset is shared with the reader, the version is the reader's to list, and the
    // storage is asked for its files. No LakeFS holds this dataset, so that request fails:
    // as the server's failure, not as an error of the File Lister's.
    getDSLContext
      .insertInto(DATASET_USER_ACCESS)
      .set(DATASET_USER_ACCESS.DID, Integer.valueOf(notesDid))
      .set(DATASET_USER_ACCESS.UID, Integer.valueOf(readerUid))
      .set(DATASET_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()
    try {
      val storageFailure = intercept[InternalServerErrorException](createdByReader())

      storageFailure.getMessage shouldBe
        s"Execution $newestEid could not be created: its plan could not be made."
    } finally {
      getDSLContext
        .deleteFrom(DATASET_USER_ACCESS)
        .where(DATASET_USER_ACCESS.DID.eq(Integer.valueOf(notesDid)))
        .execute()
    }
  }

  it should "refuse a File Scan From Input that no File Lister is upstream of, as its error" in {
    // The file's path typed by hand, where a File Lister would list it.
    val names = named(new TextInputSourceOpDesc(), "names")
    names.textInput = s"${TestOperators.fixtureDatasetVersionPath}/line_numbers.txt"
    val plan = LogicalPlanPojo(
      List(names, named(new FileScanOpDesc(), "scan")),
      List(link("names", "scan")),
      List.empty,
      List.empty
    )

    val failure = compileFailure(post(request(plan = plan)))

    failure.operatorErrors.keySet shouldBe Set("scan")
    failure.operatorErrors("scan").message shouldBe "java.lang.IllegalArgumentException: File " +
      "Scan From Input reads only the files a File Lister upstream of it lists. Link a File " +
      "Lister to its input, directly or through other operators."
    row(failure.eid).getStatus shouldBe 4.toByte
  }

  /** A dataset version as a File Lister names it, which only [[creatorListing]] lists. */
  private val archiveVersionPath = s"/dataset/$creatorEmail/sensor-archive-2026/v12"

  /**
    * A creator whose File Listers list `files` files of a dataset version, and whose links to
    * them are `linkLength` characters long. The object store signs links of 400 to 600.
    */
  private def creatorListing(files: Int, linkLength: Int): FixtureCreator = {
    val expiresAtMs = System.currentTimeMillis() + 3600L * 1000
    new FixtureCreator(
      bindings = _ =>
        TestUtils.fixtureBindings.copy(
          lister = (versionPath, atMost) =>
            (1 to files).take(atMost).map { i =>
              ListedFile(
                f"$versionPath/site-042/2026/11/readings-$i%06d.parquet",
                f"s3://texera-dataset/dataset-9631/data/gq0e7ts6d4ks72q1bql0/cq0e7ts6d4ks$i%06d"
              )
            },
          inputLinker = new InputLinker {
            override def link(fileUri: URI): InputLink = fail(s"asked to link the file $fileUri")
            override def linkListed(file: ListedFile): InputLink =
              InputLink(
                (s"http://texera-rustfs:9000/${file.physicalAddress.stripPrefix("s3://")}" +
                  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=").padTo(linkLength, 'a'),
                expiresAtMs
              )
          }
        )
    )
  }

  it should "store a plan of as many files as an operator may list, linked as the object store signs links, which a computing unit reads back and starts from" in {
    val files = ApplicationConfig.maxListedFiles
    val execution = created(
      post(
        request(plan = listedPlan(archiveVersionPath)),
        creator = creatorListing(files, linkLength = 600)
      )
    )
    val planUri = new URI(execution.planUri)

    // About 10 MiB for the 10,000 files an operator may list by default.
    val stored = ExecutionPlanStore.readPlan(planUri)
    stored.body.getBytes(StandardCharsets.UTF_8).length should be <=
      ExecutionPlanStore.MaxBodyBytes
    // What a unit checks before it starts the execution passes, on the plan read back whole.
    val plan = WorkflowService
      .checkStoredStart(
        execution.eid,
        planUri,
        sessionUser(creatorUid).getUser,
        unitCuid,
        Some(testWid.toLong)
      )
      .fold(why => fail(s"the start was refused: $why"), _.executionPlan)
    plan.inputs should have size files
    val links = linksOf(plan, "scan")
    links should have size files
    links.values.map(_.url.length).toSet shouldBe Set(600)
    // A worker builds the scan's executor from the descriptor it is handed.
    val OpExecWithClassName(className, descriptor) =
      plan.plan.getPhysicalOpsOfLogicalOp(OperatorIdentity("scan")).head.opExecInitInfo: @unchecked
    noException should be thrownBy ExecFactory.newExecFromJavaClassName(className, descriptor)
  }

  it should "compile only the target and what is upstream of it, given one target" in {
    val whole = LogicalPlanPojo(
      List(
        named(TestOperators.smallCsvScanOpDesc(), "scan"),
        named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search"),
        named(TestOperators.keywordSearchOpDesc("Country", "China"), "search-2")
      ),
      List(link("scan", "search"), link("search", "search-2")),
      List("search-2"),
      List.empty
    )

    val execution = created(post(request(plan = whole, targets = List("search"))))
    val (_, plan) = storedPlan(execution)

    plan.plan.operators.map(_.id.logicalOpId) shouldBe
      Set(OperatorIdentity("scan"), OperatorIdentity("search"))
    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId) shouldBe
      Set(OperatorIdentity("search"))
    // The logical plan kept is the one compiled.
    val logical = objectMapper.readTree(logicalPlanOf(execution))
    logical.get("operators").elements().asScala.map(_.get("operatorID").asText()).toList shouldBe
      List("scan", "search")
    logical.get("opsToViewResult").elements().asScala.map(_.asText()).toList shouldBe
      List("search")
  }

  it should "compile the whole workflow given no target, several, or one it does not have" in {
    def three(): LogicalPlanPojo =
      LogicalPlanPojo(
        List(
          named(TestOperators.smallCsvScanOpDesc(), "scan"),
          named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search"),
          named(TestOperators.keywordSearchOpDesc("Country", "China"), "search-2")
        ),
        List(link("scan", "search"), link("search", "search-2")),
        List.empty,
        List.empty
      )

    Seq(Nil, List("scan", "search"), List("ghost")).foreach { targets =>
      val (_, plan) = storedPlan(created(post(request(plan = three(), targets = targets))))
      withClue(s"targets $targets: ") {
        plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan", "search", "search-2")
      }
    }
  }

  it should "check only the part of the workflow it compiles, given one target" in {
    // scan -> search, the target, and elsewhere two operators whose links form a cycle: a run up
    // to the target never reaches them.
    def withCycleElsewhere(): LogicalPlanPojo =
      LogicalPlanPojo(
        List(
          named(TestOperators.smallCsvScanOpDesc(), "scan"),
          named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "search"),
          named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "x"),
          named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "y")
        ),
        List(link("scan", "search"), link("x", "y"), link("y", "x")),
        List.empty,
        List.empty
      )

    val (_, plan) =
      storedPlan(created(post(request(plan = withCycleElsewhere(), targets = List("search")))))

    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan", "search")
    // Up to an operator on the cycle, the cycle is compiled; with no target, or one the workflow
    // does not have, the whole workflow is.
    Seq(List("y"), Nil, List("ghost")).foreach { targets =>
      withClue(s"targets $targets: ") {
        refused(400)(post(request(plan = withCycleElsewhere(), targets = targets))) shouldBe
          "The workflow's links form a cycle: x -> y -> x."
      }
    }
  }

  it should "compile a workflow whose request leaves out the results to view and reuse" in {
    val sent = searchPlan().copy(opsToViewResult = null, opsToReuseResult = null)

    val (_, plan) = storedPlan(created(post(request(plan = sent))))

    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan", "search")
  }

  it should "let a user who may read a workflow run it on a unit of their own" in {
    val creator = new FixtureCreator()

    val execution = created(post(request(cuid = readerCuid), uid = readerUid, creator = creator))

    row(execution.eid).getUid shouldBe readerUid
    storedPlan(execution)._1.createdBy shouldBe readerUid
    storedPlan(execution)._1.computingUnitId shouldBe readerCuid
    creator.resolvedFor.toSet shouldBe Set(Integer.valueOf(readerUid))
  }

  it should "keep where the run's status emails go when the request asks for them" in {
    val execution = created(post(request(emailNotificationEnabled = true)))

    storedPlan(execution)._1.notification.map(Notification.fromJson) shouldBe Some(
      Notification(
        creatorEmail,
        workflowName,
        s"http://texera.example:4200/user/workspace/$testWid"
      )
    )
  }

  it should "keep no notification for a user with no email address, or a blank one" in {
    Seq(null, "", "  ").foreach { email =>
      val noAddress = sessionUser(creatorUid)
      noAddress.getUser.setEmail(email)
      val fixture = new FixtureCreator()

      val response = new ExecutionResource {
        override protected def creator: ExecutionCreator = fixture
      }.create(request(emailNotificationEnabled = true), noAddress, uriInfo)

      withClue(s"email '$email': ") {
        storedPlan(created(response))._1.notification shouldBe None
      }
    }
  }

  it should "keep the plan's loop-variable references in its logical plan, as the editor sent them" in {
    // TextInput -> LoopStart -> Projection -> Limit("$n") -> LoopEnd, the Limit parsed as the
    // editor sends it: the parse puts 0 in its Int property and records "$n" in its sidecar.
    val lines = new TextInputSourceOpDesc()
    lines.textInput = "0\n1"
    val start = new LoopStartOpDesc()
    start.initialization = "i = 0"
    start.output = "table.iloc[i]"
    val project = new ProjectionOpDesc()
    project.attributes = List(new AttributeUnit("line", ""))
    project.isDrop = false
    val limit =
      objectMapper.readValue("""{"limit":"$n","operatorType":"Limit"}""", classOf[LogicalOp])
    val end = new LoopEndOpDesc()
    end.update = "i += 1"
    end.condition = "i < len(table)"
    val ids = List("lines", "start", "project", "limit", "end")
    val sent = LogicalPlanPojo(
      ids.zip(List(lines, start, project, limit, end)).map { case (id, op) => named(op, id) },
      ids.zip(ids.tail).map { case (from, to) => link(from, to) },
      List.empty,
      List.empty
    )
    limit.stateReferences shouldBe Map("/limit" -> "n")

    val execution = created(post(request(plan = sent)))

    val written = logicalOperators(execution)
    written.map(_.get("operatorID").asText()) shouldBe ids
    written.find(_.get("operatorID").asText() == "limit").map(_.get("limit").asText()) shouldBe
      Some("$n")
    written.filter(_.has(StateReferencing.SIDECAR_PROPERTY)) shouldBe empty
    // Parsed again, as a change to a paused operator is compiled against it, the plan has the
    // reference: written as it is, it would have read back "limit": 0 and no reference.
    val parsedBack =
      objectMapper.readValue(logicalPlanOf(execution), classOf[LogicalPlanPojo]).operators
    parsedBack.map(_.operatorIdentifier.id) shouldBe ids
    parsedBack.map(_.stateReferences) shouldBe
      List(Map.empty, Map.empty, Map.empty, Map("/limit" -> "n"), Map.empty)
  }

  // --- the workflow does not compile ---

  it should "answer 400 with each operator's error, and record the execution FAILED" in {
    val before = System.currentTimeMillis()

    val failure = compileFailure(post(request(plan = brokenPlan())))

    failure.operatorErrors.keys.head shouldBe "scan"
    failure.operatorErrors("scan").message should include("No file selected")
    failure.operatorErrors.foreach {
      case (operator, error) =>
        error.`type` shouldBe COMPILATION_ERROR
        error.operatorId shouldBe operator
    }
    failure.errors shouldBe empty
    val failed = row(failure.eid)
    failed.getStatus shouldBe 4.toByte
    failed.getLastUpdateTime.getTime should be >= (before - 1000)
    // No plan was made, so none was written.
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
      ExecutionPlanStore
        .planUri(WorkflowIdentity(testWid), ExecutionIdentity(failure.eid), None)
    )
  }

  it should "write the operators' errors as the compiling service writes them" in {
    val failure = compileFailure(post(request(plan = brokenPlan())))

    val written = dashboardMapper.readTree(dashboardMapper.writeValueAsString(failure))

    written.get("eid").asLong() shouldBe failure.eid
    // The scan, the cause of the search's error, first.
    written.get("operatorErrors").fieldNames().asScala.toList shouldBe List("scan", "search")
    val scanError = written.get("operatorErrors").get("scan")
    scanError.get("type").get("name").asText() shouldBe "COMPILATION_ERROR"
    scanError.get("timestamp").get("seconds").isNumber shouldBe true
    scanError.get("timestamp").get("nanos").isNumber shouldBe true
    scanError.get("message").asText() should include("No file selected")
    scanError.get("operatorId").asText() shouldBe "scan"
    scanError.has("details") shouldBe true
    scanError.has("workerId") shouldBe true
    written.get("errors").isArray shouldBe true
    written.get("errors").size() shouldBe 0
  }

  it should "list the operators' errors in the order of the workflow, and write them in it" in {
    // Five scans with no file chosen, each before a search on what it would read, listed in an
    // order that is not sorted: an operator comes before those downstream of it.
    val scans = List("e", "b", "d", "a", "c")
    val plan = LogicalPlanPojo(
      scans.map(id => named(new CSVScanSourceOpDesc(), id)) ++
        scans.map(id => named(TestOperators.keywordSearchOpDesc("Region", "Asia"), s"search-$id")),
      scans.map(id => link(id, s"search-$id")),
      List.empty,
      List.empty
    )
    val inWorkflowOrder = List(
      "e",
      "b",
      "d",
      "a",
      "c",
      "search-e",
      "search-b",
      "search-d",
      "search-a",
      "search-c"
    )

    val failure = compileFailure(post(request(plan = plan)))

    failure.operatorErrors.keys.toList shouldBe inWorkflowOrder
    dashboardMapper
      .readTree(dashboardMapper.writeValueAsString(failure))
      .get("operatorErrors")
      .fieldNames()
      .asScala
      .toList shouldBe inWorkflowOrder
  }

  it should "write the execution it created as {eid, wid, computingUnitId, planUri}" in {
    val execution = created(post(request()))

    val written = dashboardMapper.readTree(dashboardMapper.writeValueAsString(execution))

    written.fieldNames().asScala.toSet shouldBe Set("eid", "wid", "computingUnitId", "planUri")
    written.get("eid").asLong() shouldBe execution.eid
    written.get("planUri").asText() shouldBe execution.planUri
  }

  // --- the plan cannot be made or written ---

  it should "answer 500 and record the execution FAILED when its plan cannot be written" in {
    val lakeDown = new RuntimeException("the catalog does not answer")
    val before = executionCount

    val failure = intercept[InternalServerErrorException] {
      post(request(), creator = new FixtureCreator(failWrite = Some(lakeDown)))
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getCause shouldBe lakeDown
    executionCount shouldBe before + 1
    val eid = newestEid
    failure.getMessage shouldBe
      s"Execution $eid could not be created: its plan could not be written to the lake."
    row(eid.toLong).getStatus shouldBe 4.toByte
  }

  it should "answer 400 with how large the plan is and may be, and record the execution FAILED, when its plan is larger than its table keeps" in {
    // A thousand files, whose links alone fill what a plan may hold.
    val before = executionCount

    val failure = intercept[BadRequestException] {
      post(
        request(plan = listedPlan(archiveVersionPath)),
        creator = creatorListing(1000, linkLength = ExecutionPlanStore.MaxBodyBytes / 1000)
      )
    }

    failure.getResponse.getStatus shouldBe 400
    executionCount shouldBe before + 1
    val eid = newestEid
    failure.getMessage should fullyMatch regex
      s"Execution $eid could not be created\\. The plan is 1[67]\\.[0-9] MiB, and a stored plan " +
        "may be at most 16 MiB\\. A plan holds a link to each file its operators read, so a " +
        "workflow that lists fewer files makes a smaller plan\\."
    row(eid.toLong).getStatus shouldBe 4.toByte
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
      ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(eid), None)
    )
  }

  it should "answer 500 and record the execution FAILED when its plan cannot be made for a reason not the workflow's" in {
    // An ended run of the workflow on the unit, whose results a new execution would replace.
    insertExecution(961921, testWid, unitCuid, status = 3)
    val console = withConsole(testWid, 961921)
    val databaseDown = new RuntimeException("db down")
    val before = executionCount

    val failure = intercept[InternalServerErrorException] {
      post(request(), creator = new FixtureCreator(hints = new FailingHints(databaseDown)))
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getCause shouldBe databaseDown
    executionCount shouldBe before + 1
    val eid = newestEid
    failure.getMessage shouldBe
      s"Execution $eid could not be created: its plan could not be made."
    row(eid.toLong).getStatus shouldBe 4.toByte
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
      ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(eid.toLong), None)
    )
    // Nothing replaced it, so the earlier run keeps its results.
    consolesOf(961921) shouldBe 1
    hasTable(console) shouldBe true
  }

  it should "answer 500, not the scan's error, when a file cannot be resolved or linked for a reason not the workflow's" in {
    // The database or the storage not answering says nothing about the file a scan names: it is
    // the server's failure, and not an error of the workflow for its user to fix.
    val databaseDown = new DataAccessException("the database does not answer")
    val storageDown = new java.io.IOException("the storage does not answer")
    Seq[(RunBindings => RunBindings, Exception)](
      (_ => TestUtils.fixtureBindings.copy(files = _ => throw databaseDown), databaseDown),
      (
        _ => TestUtils.fixtureBindings.copy(inputLinker = linkerOf(_ => throw storageDown)),
        storageDown
      )
    ).foreach {
      case (bindings, outage) =>
        val before = executionCount

        val failure = intercept[InternalServerErrorException] {
          post(request(), creator = new FixtureCreator(bindings = bindings))
        }

        failure.getResponse.getStatus shouldBe 500
        failure.getCause shouldBe outage
        executionCount shouldBe before + 1
        val eid = newestEid
        failure.getMessage shouldBe
          s"Execution $eid could not be created: its plan could not be made."
        row(eid.toLong).getStatus shouldBe 4.toByte
        a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(
          ExecutionPlanStore
            .planUri(WorkflowIdentity(testWid), ExecutionIdentity(eid.toLong), None)
        )
    }
  }

  // --- clearing earlier runs ---

  it should "clear the workflow's ended runs on the unit, but not when its workflow does not compile" in {
    insertExecution(961911, testWid, unitCuid, status = 3) // completed: replaced
    insertExecution(961912, testWid, unitCuid, status = 1) // still running
    insertExecution(961913, testWid, otherUnitCuid, status = 3) // another unit's
    insertExecution(961914, otherWid, unitCuid, status = 3) // another workflow's
    // Created after the new one, as by a create that overtook a slow one: not the new one's to
    // replace.
    insertExecution(969001, testWid, unitCuid, status = 3)
    val consoles = Seq(
      961911 -> withConsole(testWid, 961911),
      961912 -> withConsole(testWid, 961912),
      961913 -> withConsole(testWid, 961913),
      961914 -> withConsole(otherWid, 961914),
      969001 -> withConsole(testWid, 969001)
    ).toMap

    // A workflow that does not compile leaves the previous results on screen.
    compileFailure(post(request(plan = brokenPlan())))
    consoles.foreach {
      case (eid, console) =>
        consolesOf(eid) shouldBe 1
        hasTable(console) shouldBe true
    }

    created(post(request()))

    consolesOf(961911) shouldBe 0
    hasTable(consoles(961911)) shouldBe false
    Seq(961912, 961913, 961914, 969001).foreach { eid =>
      consolesOf(eid) shouldBe 1
      hasTable(consoles(eid)) shouldBe true
    }
    // Cleared, not deleted: the execution stays in the history as it ended.
    row(961911).getStatus shouldBe 3.toByte
  }

  // --- refused: rights ---

  it should "refuse a user who may not read the workflow" in {
    refused(403) {
      post(request(cuid = strangerCuid), uid = strangerUid)
    } shouldBe s"You do not have access to workflow $testWid."
    // Nor a workflow that does not exist.
    refused(403)(post(request(wid = 9698))) shouldBe "You do not have access to workflow 9698."
  }

  it should "refuse a user who may not run workflows on the unit" in {
    refused(403) {
      post(request(cuid = unitCuid), uid = readerUid)
    } shouldBe s"You may not run workflows on computing unit $unitCuid."
    refused(403) {
      post(request(cuid = strangerCuid))
    } shouldBe s"You may not run workflows on computing unit $strangerCuid."
  }

  it should "refuse a unit that does not exist as one the user may not use" in {
    refused(403) {
      post(request(cuid = unknownCuid))
    } shouldBe s"You may not run workflows on computing unit $unknownCuid."
  }

  it should "refuse a terminated unit with 409" in {
    refused(409) {
      post(request(cuid = terminatedCuid))
    } shouldBe s"computing unit $terminatedCuid is terminated"
  }

  // --- refused: warehouse ---

  it should "refuse a warehouse the run may not write into, by each rule" in {
    refused(400) {
      post(request(warehouseId = None), creator = new FixtureCreator(warehouses = true))
    } shouldBe "a warehouse must be selected for this execution"
    refused(400) {
      post(
        request(warehouseId = Some(strangerWhid)),
        creator = new FixtureCreator(warehouses = true)
      )
    } shouldBe s"no warehouse with id $strangerWhid owned by this user"
    refused(400) {
      post(request(warehouseId = Some(creatorWhid)), creator = new FixtureCreator())
    } shouldBe "per-user warehouses are disabled in this deployment"
  }

  // --- refused: replay ---

  it should "refuse a replay of another workflow's run, of no run, or of a run whose log it cannot read" in {
    refused(400) {
      post(request(replay = Some(ReplayExecutionInfo(otherWorkflowEid, "interaction-1"))))
    } shouldBe s"Workflow $testWid has no execution $otherWorkflowEid to replay."
    refused(400) {
      post(request(replay = Some(ReplayExecutionInfo(969999, "interaction-1"))))
    } shouldBe s"Workflow $testWid has no execution 969999 to replay."
    refused(400) {
      post(request(replay = Some(ReplayExecutionInfo(Long.MaxValue, "interaction-1"))))
    } shouldBe s"Workflow $testWid has no execution ${Long.MaxValue} to replay."
    refused(400) {
      post(request(replay = Some(ReplayExecutionInfo(noLogEid, "interaction-1"))))
    } shouldBe s"Execution $noLogEid kept no replay log to replay."
    // A replay log is read from where its row says, which must be a location with a scheme.
    refused(400) {
      post(request(replay = Some(ReplayExecutionInfo(relativeLogEid, "interaction-1"))))
    } shouldBe s"The replay log of execution $relativeLogEid is not at an absolute URI."
    refused(400) {
      post(request(replay = Some(ReplayExecutionInfo(replaySourceEid, " "))))
    } shouldBe s"The replay of execution $replaySourceEid names no interaction to replay up to."
  }

  // --- refused: malformed ---

  it should "refuse a workflow whose links form a cycle or name an operator it does not have" in {
    val cyclic = LogicalPlanPojo(
      List(
        named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "a"),
        named(TestOperators.keywordSearchOpDesc("Region", "Asia"), "b")
      ),
      List(link("a", "b"), link("b", "a")),
      List.empty,
      List.empty
    )
    val dangling = searchPlan().copy(links = List(link("scan", "ghost")))

    refused(400)(post(request(plan = cyclic))) shouldBe
      "The workflow's links form a cycle: a -> b -> a."
    refused(400)(post(request(plan = dangling))) shouldBe
      "The link from scan to ghost names operator ghost, which the workflow does not have."
  }

  it should "refuse a request that names no workflow, unit, engine version or plan" in {
    refused(400)(post(null)) shouldBe "The request has no body."
    refused(400)(post(request(wid = 0))) shouldBe "The request names no workflow: wid is 0."
    refused(400)(post(request(wid = Int.MaxValue.toLong + 1))) shouldBe
      s"The request names no workflow: wid is ${Int.MaxValue.toLong + 1}."
    refused(400)(post(request(cuid = 0))) shouldBe
      "The request names no computing unit: computingUnitId is 0."
    refused(400)(post(request().copy(engineVersion = null))) shouldBe
      "The request names no engine version."
    refused(400)(post(request(plan = null))) shouldBe "The request has no logical plan."
  }

  it should "refuse a name or an engine version longer than the row keeps" in {
    refused(400)(post(request().copy(executionName = "n" * 129))) shouldBe
      s"The execution's name is longer than ${ExecutionCreator.MaxColumnLength} characters."
    refused(400)(post(request().copy(engineVersion = "v" * 120))) shouldBe
      "The request's engine version is too long."
    // The longest name the row keeps is taken.
    row(created(post(request().copy(executionName = "n" * 128))).eid).getName shouldBe "n" * 128
  }

  it should "refuse batches of fewer than one tuple, in the words of the editor's setting" in {
    refused(400)(
      post(request(settings = Some(sentSettings.copy(dataTransferBatchSize = 0))))
    ) shouldBe
      "The workflow's Data Transfer Batch Size is 0; set it to 1 or more."
  }

  it should "refuse before it reads anything when the request is malformed" in {
    val creator = new FixtureCreator(hints = new RecordingHints(None))

    refused(400)(post(request(wid = 0), creator = creator))

    creator.resolvedFor shouldBe empty
    creator.hints.asked shouldBe empty
  }

  it should "be served at POST /executions, to regular users and admins" in {
    val create = classOf[ExecutionResource].getMethods.find(_.getName == "create").get

    classOf[ExecutionResource].getAnnotation(classOf[javax.ws.rs.Path]).value() shouldBe
      "/executions"
    create.getAnnotation(classOf[javax.ws.rs.POST]) should not be null
    create.getAnnotation(classOf[javax.ws.rs.Path]) shouldBe null
    create.getAnnotation(classOf[javax.annotation.security.RolesAllowed]).value().toSet shouldBe
      Set("REGULAR", "ADMIN")
  }
}
