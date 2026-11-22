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

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import io.dropwizard.setup.Bootstrap
import org.apache.texera.amber.core.executor.{
  ExecFactory,
  ExecutorInputs,
  FileListing,
  InputFile,
  OpExecWithClassName,
  OperatorInputs
}
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ConsoleRow,
  DocumentFactory,
  ExecutionLabel,
  ExecutionLogEntry,
  ExecutionLogStore,
  InputFileLocator,
  InputLink,
  InputLinker,
  ListedFile,
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
  PortIdentity,
  PreferCoordinator,
  PythonEnvironment,
  PythonEnvironmentRef,
  ReplaySource,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.{
  COMPILATION_ERROR,
  EXECUTION_FAILURE
}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.{FileScanOpDesc, FileScanSourceOpDesc}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.{FixtureInputs, LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.compiler.{CompileFor, PlanToRun}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.dao.{MockTexeraDB, SiteSettings, WorkflowExecutionStatus}
import org.apache.texera.dao.jooq.generated.Tables.{
  COMPUTING_UNIT_USER_ACCESS,
  DATASET_USER_ACCESS,
  OPERATOR_PORT_EXECUTIONS,
  SITE_SETTINGS,
  USER_WAREHOUSE,
  VIRTUAL_ENVIRONMENTS,
  WORKFLOW,
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
  CreateExecutionResponse,
  ExecutionClosingResponse,
  ExecutionConsoleMessageResponse,
  ExecutionConsoleResponse,
  ExecutionLogEntryResponse,
  ExecutionLogResponse,
  ExecutionStateResponse
}
import org.apache.texera.web.resource.EmailMessage
import org.apache.texera.web.service.{ExecutionsMetadataPersistService, WorkflowEmailNotifier}
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.service.WorkflowService
import org.apache.texera.web.service.execution.WorkflowCompilingService.CompileRefused
import org.apache.texera.web.service.execution.{
  ClosingRecord,
  CostHintsLoader,
  ExecutionCloser,
  ExecutionCreator,
  ExecutionExpiry,
  ExecutionRecordReader,
  ExecutionRecords,
  FixtureCompilingService,
  OperatorUpdates,
  StubCompilingServer,
  WorkflowCompilingService,
  WorkflowCompilingServiceClient
}
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
import java.util.concurrent.Executor
import javax.ws.rs.core.{Response, UriInfo}
import javax.ws.rs.{
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  WebApplicationException
}
import scala.collection.mutable
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.{Try, Using}

/**
  * Creating an execution at the Dashboard service, through [[ExecutionResource]].
  *
  * The rows are in `MockTexeraDB`; results and consoles are tables of the catalog the build's
  * tests use (the Postgres JDBC catalog in CI), named after this suite's own workflow and
  * execution ids. The executions it creates take ids after 962000, set in `beforeAll`, so their
  * tables and their large binaries' prefixes are this suite's own too. The compiling
  * service is a fixture that compiles in this JVM ([[FixtureCompilingService]]), with the
  * fixture resolvers of `TestOperators` (scan files on the local disk) unless a case binds
  * them otherwise, or a server a case asks over HTTP ([[StubCompilingServer]]); files are
  * linked to the fixture server, and the cost hints, the replay log root and the warehouse
  * switch are the creator's seams.
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
  private val clearingCuid = 9626
  private val sharedCuid = 9627
  private val closingCuid = 9628
  private val closingOtherCuid = 9629
  private val lastRunCuid = 9630
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

  /** Every plan, log, result and console table this suite makes, dropped after it. */
  private val madePlans = mutable.ListBuffer.empty[URI]
  private val madeLogs = mutable.ListBuffer.empty[URI]
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
      (strangerCuid, strangerUid, false),
      (clearingCuid, creatorUid, false),
      (sharedCuid, creatorUid, false),
      (closingCuid, creatorUid, false),
      (closingOtherCuid, creatorUid, false),
      (lastRunCuid, creatorUid, false)
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
    Seq(unitCuid -> PrivilegeEnum.READ, sharedCuid -> PrivilegeEnum.WRITE).foreach {
      case (cuid, privilege) =>
        getDSLContext
          .insertInto(COMPUTING_UNIT_USER_ACCESS)
          .set(COMPUTING_UNIT_USER_ACCESS.CUID, Integer.valueOf(cuid))
          .set(COMPUTING_UNIT_USER_ACCESS.UID, Integer.valueOf(readerUid))
          .set(COMPUTING_UNIT_USER_ACCESS.PRIVILEGE, privilege)
          .execute()
    }

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
      madeLogs.foreach(uri => Try(ExecutionLogStore.drop(uri)))
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

  /**
    * Execution `eid`, as a unit left it at `status`: one that ended is closed as it ended,
    * unless it is to be `open`, as it is until the closing job has looked at it.
    */
  private def insertExecution(
      eid: Int,
      wid: Int,
      cuid: Int,
      status: Short,
      logLocation: Option[String] = None,
      uid: Int = creatorUid,
      open: Boolean = false,
      whid: Option[Integer] = None
  ): Unit = {
    val closed = !open && WorkflowExecutionStatus.Ended.contains(status)
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(wid)))
      .fetchOneInto(classOf[Integer])
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(uid))
      .set(WORKFLOW_EXECUTIONS.CUID, Integer.valueOf(cuid))
      .set(WORKFLOW_EXECUTIONS.LOG_LOCATION, logLocation.orNull)
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.WHID, whid.orNull)
      .set(WORKFLOW_EXECUTIONS.OUTCOME, if (closed) java.lang.Short.valueOf(status) else null)
      .set(
        WORKFLOW_EXECUTIONS.ENDED_AT,
        if (closed) new Timestamp(System.currentTimeMillis()) else null
      )
      .execute()
  }

  /** Gives execution `eid` of `wid` its console table. */
  private def withConsole(wid: Int, eid: Int): URI = {
    val uri = ConsoleMessageStore.consoleUri(
      WorkflowIdentity(wid.toLong),
      ExecutionIdentity(eid.toLong),
      None
    )
    ConsoleMessageStore.create(uri)
    madeTables += uri
    uri
  }

  private def hasTable(uri: URI): Boolean = Try(DocumentFactory.openDocument(uri)).isSuccess

  private def executionCount: Int = getDSLContext.fetchCount(WORKFLOW_EXECUTIONS)

  private def row(eid: Long): WorkflowExecutions =
    new WorkflowExecutionsDao(getDSLContext.configuration())
      .fetchOneByEid(Integer.valueOf(eid.toInt))

  /** The result tables recorded for execution `eid`: each port, its table and output mode. */
  private def resultRowsOf(eid: Long): Seq[(String, String, String)] =
    getDSLContext
      .select(
        OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID,
        OPERATOR_PORT_EXECUTIONS.RESULT_URI,
        OPERATOR_PORT_EXECUTIONS.OUTPUT_MODE
      )
      .from(OPERATOR_PORT_EXECUTIONS)
      .where(OPERATOR_PORT_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(Integer.valueOf(eid.toInt)))
      .orderBy(OPERATOR_PORT_EXECUTIONS.GLOBAL_PORT_ID)
      .fetch()
      .asScala
      .map(row => (row.value1(), row.value2(), row.value3().getLiteral))
      .toSeq

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

  /** The emails the closers of this suite would have sent: none leaves it. */
  private val sentEmails = mutable.ListBuffer.empty[EmailMessage]

  /**
    * A closer whose emails are noted in `sentEmails`, on the thread that closes, and whose lake
    * calls are the stores' unless `label` is given.
    */
  private def recordingCloser(
      label: URI => Option[ExecutionLabel] = ExecutionLogStore.label
  ): ExecutionCloser =
    new ExecutionCloser(
      label = label,
      emails = new WorkflowEmailNotifier((message, _) => {
        sentEmails.synchronized(sentEmails += message)
        Right(())
      }),
      emailThread = _.run()
    )

  /** An expiry whose lake calls are the stores', and which deletes no large binary. */
  private val expiryWithoutBinaries =
    new ExecutionExpiry(warehousesEnabled = false, deleteBinaries = _ => ())

  /**
    * The creator under test, set up as the case needs. Its compiling service compiles in this
    * JVM, bound to the fixture files and versions in place of a user's, and its files are
    * linked to the fixture server. `resolvedFor` records the user each plan was bound for. The
    * site's settings stay the ones the database holds,
    * and what a create leaves for after its answer is done before it returns, unless a case
    * says otherwise.
    *
    * @param bindings  what the compiling service binds a plan to, given what the deployment
    *                  binds it to for its user; the fixtures', unless a case gives another
    * @param linker    signs the plan's links; the fixture server's, unless a case gives another
    * @param compiling the compiling service, for a case that asks one of its own
    */
  private class FixtureCreator(
      logRoot: Option[URI] = None,
      warehouses: Boolean = false,
      val hints: RecordingHints = new RecordingHints(None),
      bindings: CompileFor.Run => CompileFor.Run = _ => TestUtils.fixtureBindings,
      linker: InputLinker = FixtureInputs.linker,
      background: Executor = _.run(),
      closer: ExecutionCloser = recordingCloser(),
      expiry: ExecutionExpiry = expiryWithoutBinaries,
      compileDeadline: FiniteDuration = ExecutionCreator.CompileDeadline,
      val resolvedFor: mutable.ListBuffer[Integer] = mutable.ListBuffer.empty,
      compiling: Option[WorkflowCompilingService] = None
  ) extends ExecutionCreator(
        compiling = compiling.getOrElse(
          new FixtureCompilingService(bindingsFor = uid => {
            resolvedFor += uid
            val forUser = PlanToRun.bindingsFor(uid)
            bindings(forUser).copy(settings = forUser.settings)
          })
        ),
        linker = linker,
        replayLogRoot = logRoot,
        warehousesEnabled = warehouses,
        costHints = hints,
        background = background,
        closer = closer,
        compileDeadline = compileDeadline,
        expiry = expiry
      )

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
  ): Response =
    new ExecutionResource(creator, new OperatorUpdates())
      .create(request, sessionUser(uid), uriInfo, FixtureCompilingService.authorizationOf(uid))

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
      target: Option[String] = None
  ): CreateExecutionRequest =
    CreateExecutionRequest(
      wid = wid,
      executionName = "spec-execution",
      engineVersion = "1.4.0-spec",
      logicalPlan = Option(plan).map(TestUtils.sentPlan).orNull,
      workflowSettings = settings,
      emailNotificationEnabled = emailNotificationEnabled,
      computingUnitId = cuid,
      warehouseId = warehouseId,
      replayFromExecution = replay,
      targetOperatorId = target
    )

  /** The execution a 201 created. */
  private def created(response: Response): CreateExecutionResponse = {
    withClue(s"${response.getEntity}: ") { response.getStatus shouldBe 201 }
    response.getEntity.asInstanceOf[CreateExecutionResponse]
  }

  private def compileFailure(response: Response): CreateExecutionFailure = {
    response.getStatus shouldBe 400
    response.getEntity.asInstanceOf[CreateExecutionFailure]
  }

  /** The plan the create of `execution` answered, read as a computing unit reads it. */
  private def planOf(execution: CreateExecutionResponse): ExecutionPlan =
    PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(execution.plan))

  /** The id of the execution created last. */
  private def newestEid: Int =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.EID)
      .from(WORKFLOW_EXECUTIONS)
      .orderBy(WORKFLOW_EXECUTIONS.EID.desc())
      .limit(1)
      .fetchOneInto(classOf[Integer])
      .intValue()

  /** The descriptor `plan` gives the executor of operator `id`, as JSON. */
  private def descriptorOf(plan: ExecutionPlan, id: String): JsonNode =
    plan.plan.getPhysicalOpsOfLogicalOp(OperatorIdentity(id)).head.opExecInitInfo match {
      case OpExecWithClassName(_, descString) => objectMapper.readTree(descString)
      case other                              => fail(s"the executor of $id is $other")
    }

  /** What `plan` says operator `id` reads from outside the run. */
  private def inputsOf(plan: ExecutionPlan, id: String): OperatorInputs =
    plan.plan.getPhysicalOpsOfLogicalOp(OperatorIdentity(id)).head.inputs

  /** A scan of the creator's private dataset file, which reads nothing of it to compile. */
  private def notesPlan(): LogicalPlanPojo = {
    val scan = named(new FileScanSourceOpDesc(), "notes")
    scan.fileName = Some(notesPath)
    LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)
  }

  /** Where LakeFS keeps the creator's dataset file, as the compiling service finds it. */
  private val notesAddress = "s3://texera-dataset/dataset-9631/data/gdm5"

  /** A link as the deployment's linker signs one. */
  private val signedLink = InputLink(
    "http://texera-rustfs:9000/texera-dataset/dataset-9631/data/gdm5?X-Amz-Signature=5ecr3t",
    System.currentTimeMillis() + 3600L * 1000
  )

  /** What a scan of the creator's dataset file reads in a plan whose linker made `signedLink`. */
  private def readThroughSignedLink: OperatorInputs =
    OperatorInputs(files =
      Seq(InputFile(notesUri.toASCIIString, signedLink.url, signedLink.expiresAtMs))
    )

  /**
    * A creator whose compiling service binds a plan as the deployment binds it for its user,
    * files resolved as the user may read them, but for where a file is kept, which `locate`
    * says in place of LakeFS, and whose links `link` signs in place of the object store's keys.
    */
  private def creatorLinkingWith(
      link: String => InputLink,
      locate: URI => String = _ => notesAddress
  ): FixtureCreator =
    new FixtureCreator(
      bindings = _.copy(locator = (file => locate(file)): InputFileLocator),
      linker = address => link(address)
    )

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

  /**
    * The message of the 400 `body` throws for a workflow the compiling service cannot read. The
    * service is asked once the execution's row exists, so the refusal leaves the execution
    * behind, failed, and closed by its create with why.
    */
  private def refusedByCompiler(body: => Any): String = {
    val before = executionCount
    val since = System.currentTimeMillis()
    val refusal = intercept[BadRequestException](body)
    refusal.getResponse.getStatus shouldBe 400
    executionCount shouldBe before + 1
    val eid = newestEid.toLong
    closedAtCreate(eid, s"compile error: ${refusal.getMessage}", since)
    refusal.getMessage
  }

  /**
    * Fails unless the create of execution `eid`, which failed after `since`, closed the row
    * itself: as failed for `reason`, by no log, and as an execution no unit ever started, whose
    * results are marked expired and which holds nothing.
    */
  private def closedAtCreate(eid: Long, reason: String, since: Long): Unit = {
    val closed = row(eid)
    closed.getOutcome shouldBe WorkflowExecutionStatus.Failed
    closed.getOutcomeReason shouldBe reason
    closed.getOutcomeFromLog shouldBe false
    closed.getEndedAt.getTime should be >= (since - 1000)
    closed.getEndedAt.getTime should be <= (System.currentTimeMillis() + 1000)
    closed.getResultsExpiredAt shouldBe closed.getEndedAt
    closed.getStoredBytes shouldBe 0L
  }

  private lazy val dashboardMapper: ObjectMapper = {
    val application = new TexeraWebApplication
    val bootstrap = new Bootstrap[TexeraWebConfiguration](application)
    application.initialize(bootstrap)
    bootstrap.getObjectMapper
  }

  // --- created ---

  "ExecutionResource.create" should
    "record the execution as Created, and answer 201 with its plan made for the creator" in {
    val creator = new FixtureCreator()
    val sent = request()
    val before = System.currentTimeMillis()

    val execution = created(post(sent, creator = creator))

    execution.eid should be > firstCreatedEid.toLong

    val stored = row(execution.eid)
    // Open: nothing of its closing record is written until it is over.
    stored.getOutcome shouldBe null
    stored.getOutcomeReason shouldBe null
    stored.getEndedAt shouldBe null
    stored.getOutcomeFromLog shouldBe false
    stored.getResultsExpiredAt shouldBe null
    stored.getStoredBytes shouldBe null
    stored.getStartingTime.getTime should be >= (before - 1000)
    stored.getUid shouldBe creatorUid
    stored.getCuid shouldBe unitCuid
    stored.getWhid shouldBe null
    stored.getName shouldBe "spec-execution"
    stored.getEnvironmentVersion shouldBe """{"engine_version":"1.4.0-spec"}"""
    stored.getLogLocation shouldBe null

    val plan = planOf(execution)
    // The request asked for no email.
    stored.getNotification shouldBe null

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
    // The scan's file is the one file the plan reads through a link, which the plan gives the
    // scan to read and which has not expired.
    val scanned = TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath)
    val files = inputsOf(plan, "scan").files
    files.map(_.name) shouldBe Seq(scanned.toASCIIString)
    files.head.expiresAtMs should be > System.currentTimeMillis()
    inputsOf(plan, "search") shouldBe OperatorInputs.defaultInstance

    // The link took the place of where the plan said the file is kept.
    files.head.physicalAddress shouldBe empty
    execution.plan should not include "physicalAddress"

    // Where the run writes each result the plan keeps, recorded for the result service: the
    // last operator's, in the table the plan names for its port.
    plan.resultTables.map(_.port.opId.logicalOpId) shouldBe Seq(OperatorIdentity("search"))
    resultRowsOf(execution.eid) shouldBe plan.resultTables.map(table =>
      (
        table.port.serializeAsString,
        table.uri.toString,
        ExecutionsMetadataPersistService.outputModeEnumOf(table.mode).getLiteral
      )
    )

    // Compiled as the creator may read files, datasets and models.
    creator.resolvedFor.toSet shouldBe Set(Integer.valueOf(creatorUid))
  }

  it should "save the cost hints of the creator's runs of the workflow with the plan" in {
    val hints = CostHints(ExecutionIdentity(replaySourceEid), Map("scan" -> 2.5, "gone" -> 0.0))
    val creator = new FixtureCreator(hints = new RecordingHints(Some(hints)))

    val plan = planOf(created(post(request(), creator = creator)))

    plan.context.costHints shouldBe Some(hints)
    creator.hints.asked.toList shouldBe List((testWid.toLong, creatorUid))
  }

  it should "keep where the run writes its replay log, in the row and in the plan" in {
    val execution =
      created(post(request(), creator = new FixtureCreator(logRoot = Some(logRoot))))

    // <root>/<wid>/<eid>/, as the root resolves it (java.net.URI drops the empty authority).
    val location = s"file:/tmp/texera-spec-replay-logs/$testWid/${execution.eid}/"
    row(execution.eid).getLogLocation shouldBe location
    planOf(execution).replayLog shouldBe Some(new URI(location))
  }

  it should "save the replay log the run replays with the plan" in {
    val execution = created(
      post(request(replay = Some(ReplayExecutionInfo(replaySourceEid, "interaction-1"))))
    )

    planOf(execution).replay shouldBe Some(
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

    row(execution.eid).getWhid shouldBe creatorWhid
    planOf(execution).context.warehouse shouldBe Some(creatorWarehouse)
  }

  it should "give the run the default settings when the request sends none" in {
    val plan = planOf(created(post(request(settings = None))))

    plan.context.workflowSettings.dataTransferBatchSize shouldBe
      ApplicationConfig.defaultDataTransferBatchSize
    plan.context.workflowSettings.executionMode shouldBe WorkflowSettings().executionMode
    plan.context.workflowSettings.outputPortsNeedingStorage should not be empty
  }

  it should "find the ports whose results are stored itself, whatever the request says" in {
    val ghost =
      GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("ghost"), "main"), PortIdentity())
    val sent = Some(sentSettings.copy(outputPortsNeedingStorage = Set(ghost)))

    val plan = planOf(created(post(request(settings = sent))))

    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId) shouldBe
      Set(OperatorIdentity("search"))
  }

  it should "save the plan under the site's CSV column limit as it stands" in {
    // The limit is fixed in the plan when the execution is created: the unit that runs it asks
    // the site for none.
    val scan = named(TestOperators.smallCsvScanOpDesc(), "scan")
    SiteSettings.upsert(getDSLContext, "csv_parser_max_columns", "731", "spec")
    try {
      val sent = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)

      val plan = planOf(created(post(request(plan = sent))))

      inputsOf(plan, "scan").csvParserMaxColumns shouldBe Some(731)
    } finally {
      getDSLContext
        .deleteFrom(SITE_SETTINGS)
        .where(SITE_SETTINGS.KEY.eq("csv_parser_max_columns"))
        .execute()
    }
  }

  it should "link each file the creator may read, in the plan it answers and nowhere else" in {
    val located = mutable.ListBuffer.empty[URI]
    val linked = mutable.ListBuffer.empty[String]
    val creator = creatorLinkingWith(
      link = { address =>
        linked += address
        signedLink
      },
      locate = { file =>
        located += file
        notesAddress
      }
    )

    val execution = created(post(request(plan = notesPlan()), creator = creator))
    val plan = planOf(execution)

    // Resolved for the creator, by the name as typed; that file located, and a link signed for
    // where it is kept.
    located.toList shouldBe List(notesUri)
    linked.toList shouldBe List(notesAddress)
    inputsOf(plan, "notes") shouldBe readThroughSignedLink
    descriptorOf(plan, "notes").get("fileName").asText() shouldBe notesUri.toASCIIString
    // The link is a secret of the plan to run, which holds it once: in what the scan reads, and
    // not in the scan's descriptor.
    execution.plan.split("X-Amz-Signature=5ecr3t", -1) should have length 2
    execution.plan should not include notesAddress
    descriptorOf(plan, "notes").toString should not include "X-Amz-Signature"
  }

  it should "refuse a file its creator may not read as the scan's error, and make no link to it" in {
    // The reader may read the workflow and run it on a unit of their own, but not the dataset
    // its scan names, which is the creator's and private.
    val linked = mutable.ListBuffer.empty[String]
    val creator = creatorLinkingWith { address =>
      linked += address
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
    row(failure.eid).getOutcome shouldBe 4

    // Once the dataset is shared with the reader, the same request makes a plan with its link.
    getDSLContext
      .insertInto(DATASET_USER_ACCESS)
      .set(DATASET_USER_ACCESS.DID, Integer.valueOf(notesDid))
      .set(DATASET_USER_ACCESS.UID, Integer.valueOf(readerUid))
      .set(DATASET_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()
    try {
      val plan = planOf(created(createdByReader()))

      linked.toList shouldBe List(notesAddress)
      inputsOf(plan, "notes") shouldBe readThroughSignedLink
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

  /** The environment the plan of `execution` gives its operator `udf`. */
  private def environmentOf(execution: CreateExecutionResponse): PythonEnvironmentRef =
    planOf(execution).plan
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
    val plan = planOf(execution)
    // Its workers run where the unit installs environments.
    plan.plan
      .getOperator(PhysicalOpIdentity(OperatorIdentity("udf"), "main"))
      .locationPreference shouldBe Some(PreferCoordinator)
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
          s"You have no Python environment named '$name'. Each user keeps their own " +
          "environments, so to run this workflow, create one with this name."
        // No plan is made to run in another environment, or in none.
        row(failure.eid).getOutcome shouldBe 4
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
    // The compiling service's own failure, of which the Dashboard has only the status.
    failure.getCause shouldBe a[CompileRefused]
    failure.getMessage shouldBe
      s"Execution $newestEid could not be created: its plan could not be made."
    row(newestEid.toLong).getOutcome shouldBe 4
  }

  it should "list each File Lister's dataset version and link the files listed, in the plan it stores and nowhere else" in {
    val files = FixtureInputs.datasetFiles.map {
      case (file, _) => s"${FixtureInputs.datasetVersionPath}/$file"
    }

    val execution =
      created(post(request(plan = listedPlan(FixtureInputs.datasetVersionPath))))
    val plan = planOf(execution)

    // The File Lister is given the version's listing to output, and the File Scan From Input a
    // link to each file listed, to the fixture's server.
    inputsOf(plan, "lister") shouldBe OperatorInputs(listing = Some(FileListing(files)))
    val read = inputsOf(plan, "scan")
    read.files.map(_.name) shouldBe files
    read.files.foreach(_.url should startWith("http://127.0.0.1:"))
    read.listing shouldBe None
    // Neither is in a descriptor: the File Lister's names the dataset version by its path, and
    // neither what it lists nor a link.
    val listerDescriptor = descriptorOf(plan, "lister").toString
    listerDescriptor should include(FixtureInputs.datasetVersionPath)
    listerDescriptor should not include "http://127.0.0.1:"
    files.foreach(file => listerDescriptor should not include file)
    descriptorOf(plan, "scan").toString should not include "http://127.0.0.1:"
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
    row(failure.eid).getOutcome shouldBe 4

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
    names.textInput = s"${FixtureInputs.datasetVersionPath}/line_numbers.txt"
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
    row(failure.eid).getOutcome shouldBe 4
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
          locator = (file => fail(s"asked where the file $file is kept")): InputFileLocator
        ),
      linker = address =>
        InputLink(
          (s"http://texera-rustfs:9000/${address.stripPrefix("s3://")}" +
            "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=").padTo(linkLength, 'a'),
          expiresAtMs
        )
    )
  }

  it should "answer a plan of as many files as an operator may list, linked as the object store signs links, which a computing unit reads and starts from" in {
    val files = ApplicationConfig.maxListedFiles
    val execution = created(
      post(
        request(plan = listedPlan(archiveVersionPath)),
        creator = creatorListing(files, linkLength = 600)
      )
    )

    // About 9 MiB for the 10,000 files an operator may list by default.
    execution.plan.getBytes(StandardCharsets.UTF_8).length should be <=
      PhysicalPlanCodec.MaxPlanBytes
    // What a unit checks before it starts the execution passes, on the plan whole.
    val plan = WorkflowService
      .checkStart(
        execution.eid,
        execution.plan,
        sessionUser(creatorUid).getUser,
        unitCuid,
        Some(testWid.toLong)
      )
      .fold(why => fail(s"the start was refused: $why"), _.executionPlan)
    val read = inputsOf(plan, "scan")
    read.files should have size files
    read.files.map(_.url.length).toSet shouldBe Set(600)
    // A worker builds the scan's executor from the descriptor and the inputs it is handed.
    val OpExecWithClassName(className, descriptor) =
      plan.plan.getPhysicalOpsOfLogicalOp(OperatorIdentity("scan")).head.opExecInitInfo: @unchecked
    noException should be thrownBy ExecFactory.newExecFromJavaClassName(
      className,
      descriptor,
      inputs = new ExecutorInputs(read, Seq("http://texera-rustfs:9000"))
    )
  }

  it should "compile only the target and what is upstream of it, given a target" in {
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

    val execution = created(post(request(plan = whole, target = Some("search"))))
    val plan = planOf(execution)

    plan.plan.operators.map(_.id.logicalOpId) shouldBe
      Set(OperatorIdentity("scan"), OperatorIdentity("search"))
    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId) shouldBe
      Set(OperatorIdentity("search"))
  }

  it should "refuse a target the workflow does not have, in the compiling service's words" in {
    refusedByCompiler(post(request(target = Some("ghost")))) shouldBe
      "The workflow has no operator ghost to run up to."
    // Not the whole workflow in its place.
    refusedByCompiler(post(request(target = Some("")))) shouldBe
      "The workflow has no operator  to run up to."
  }

  it should "check only the part of the workflow it compiles, given a target" in {
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

    val plan =
      planOf(created(post(request(plan = withCycleElsewhere(), target = Some("search")))))

    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan", "search")
    // Up to an operator on the cycle, the cycle is compiled; with no target, the whole workflow
    // is.
    Seq(Some("y"), None).foreach { target =>
      withClue(s"target $target: ") {
        refusedByCompiler(post(request(plan = withCycleElsewhere(), target = target))) shouldBe
          "The workflow's links form a cycle: x -> y -> x."
      }
    }
  }

  it should "compile a workflow whose request leaves out the results to view and reuse" in {
    val sent = searchPlan().copy(opsToViewResult = null, opsToReuseResult = null)

    val plan = planOf(created(post(request(plan = sent))))

    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan", "search")
  }

  it should "let any user run a public workflow on a unit of their own" in {
    // Upstream checked only the unit when a workflow was run, and its editor let whoever could
    // open a workflow run it: a public one is open to every user.
    refused(403)(post(request(cuid = strangerCuid), uid = strangerUid))
    getDSLContext
      .update(WORKFLOW)
      .set(WORKFLOW.IS_PUBLIC, java.lang.Boolean.TRUE)
      .where(WORKFLOW.WID.eq(Integer.valueOf(testWid)))
      .execute()
    try {
      val execution = created(post(request(cuid = strangerCuid), uid = strangerUid))

      row(execution.eid).getUid shouldBe strangerUid
    } finally {
      getDSLContext
        .update(WORKFLOW)
        .set(WORKFLOW.IS_PUBLIC, java.lang.Boolean.FALSE)
        .where(WORKFLOW.WID.eq(Integer.valueOf(testWid)))
        .execute()
    }
  }

  it should "let a user who may read a workflow run it on a unit of their own" in {
    val creator = new FixtureCreator()

    val execution = created(post(request(cuid = readerCuid), uid = readerUid, creator = creator))

    row(execution.eid).getUid shouldBe readerUid
    row(execution.eid).getCuid shouldBe readerCuid
    creator.resolvedFor.toSet shouldBe Set(Integer.valueOf(readerUid))
  }

  it should "keep where the email about the run goes in the execution's row, when the request asks for one" in {
    val execution = created(post(request(emailNotificationEnabled = true)))

    Option(row(execution.eid).getNotification).map(Notification.fromJson) shouldBe Some(
      Notification(
        creatorEmail,
        workflowName,
        s"http://texera.example:4200/user/workspace/$testWid"
      )
    )
  }

  // A computing unit runs the plan, and has no use for an address.
  it should "keep the user's address out of the plan" in {
    val execution = created(post(request(emailNotificationEnabled = true)))

    execution.plan should not include creatorEmail
  }

  it should "keep no notification for a user with no email address, or a blank one" in {
    Seq(null, "", "  ").foreach { email =>
      val noAddress = sessionUser(creatorUid)
      noAddress.getUser.setEmail(email)
      val fixture = new FixtureCreator()

      val response = new ExecutionResource(fixture, new OperatorUpdates())
        .create(
          request(emailNotificationEnabled = true),
          noAddress,
          uriInfo,
          FixtureCompilingService.authorizationOf(creatorUid)
        )

      withClue(s"email '$email': ") {
        row(created(response).eid).getNotification shouldBe null
      }
    }
  }

  // The user is looking at the failure.
  it should "send no email about an execution whose create fails, though it asked for one" in {
    val before = sentEmails.size

    val failure =
      compileFailure(post(request(plan = brokenPlan(), emailNotificationEnabled = true)))

    row(failure.eid).getNotification should not be null
    row(failure.eid).getEndedAt should not be null
    sentEmails.size shouldBe before
  }

  // --- the workflow does not compile ---

  it should "answer 400 with each operator's error, and record the execution FAILED" in {
    val before = System.currentTimeMillis()

    val failure = compileFailure(post(request(plan = brokenPlan())))

    failure.code shouldBe 400
    failure.message should startWith("The workflow does not compile: 2 operators have errors.")
    failure.operatorErrors.keySet shouldBe Set("scan", "search")
    failure.operatorErrors("scan").message should include("No file selected")
    failure.operatorErrors.foreach {
      case (operator, error) =>
        error.`type` shouldBe COMPILATION_ERROR
        error.operatorId shouldBe operator
    }
    // Closed by its create, with the error of one operator: the first by its id.
    closedAtCreate(
      failure.eid,
      s"compile error: ${failure.operatorErrors("scan").message}",
      since = before
    )
    // No plan was made, so none was written.
  }

  it should "write a workflow that does not compile as the refusal it is, with the execution and the operators' errors" in {
    val failure = compileFailure(post(request(plan = brokenPlan())))

    val written = dashboardMapper.readTree(dashboardMapper.writeValueAsString(failure))

    // The code and the message every refusal has, and the two fields only this one has.
    written.fieldNames().asScala.toSet shouldBe Set("code", "message", "eid", "operatorErrors")
    written.get("code").asInt() shouldBe 400
    written.get("message").asText() should startWith("The workflow does not compile: ")
    written.get("eid").asLong() shouldBe failure.eid
    // Each error as the compiling service writes an operator's.
    written.get("operatorErrors").fieldNames().asScala.toSet shouldBe Set("scan", "search")
    val scanError = written.get("operatorErrors").get("scan")
    scanError.get("type").get("name").asText() shouldBe "COMPILATION_ERROR"
    scanError.get("timestamp").get("seconds").isNumber shouldBe true
    scanError.get("timestamp").get("nanos").isNumber shouldBe true
    scanError.get("message").asText() should include("No file selected")
    scanError.get("operatorId").asText() shouldBe "scan"
    scanError.has("details") shouldBe true
    scanError.has("workerId") shouldBe true
  }

  it should "write the execution it created as {eid, plan}, the plan as its text" in {
    val execution = created(post(request()))

    val written = dashboardMapper.readTree(dashboardMapper.writeValueAsString(execution))

    written.fieldNames().asScala.toSet shouldBe Set("eid", "plan")
    written.get("eid").asLong() shouldBe execution.eid
    written.get("plan").isTextual shouldBe true
    written.get("plan").asText() shouldBe execution.plan
  }

  // --- the plan cannot be made ---

  it should "answer 400 with how large the plan is and may be, and record the execution FAILED, when its plan is larger than a computing unit takes" in {
    // A thousand files, whose links alone fill what a plan may hold.
    val before = executionCount
    val since = System.currentTimeMillis()

    val failure = intercept[BadRequestException] {
      post(
        request(plan = listedPlan(archiveVersionPath)),
        creator = creatorListing(1000, linkLength = PhysicalPlanCodec.MaxPlanBytes / 1000)
      )
    }

    failure.getResponse.getStatus shouldBe 400
    executionCount shouldBe before + 1
    val eid = newestEid
    failure.getMessage should fullyMatch regex
      s"Execution $eid could not be created\\. Its plan is 1[67]\\.[0-9] MiB, and a plan may be " +
        "at most 16 MiB\\. A plan holds a link to each file its operators read, so a workflow " +
        "that lists fewer files makes a smaller plan\\."
    closedAtCreate(eid.toLong, "its plan is too large", since)
    // No unit is handed its plan, so no result of it is recorded.
    resultRowsOf(eid.toLong) shouldBe empty
  }

  it should "answer 500 and record the execution FAILED when its plan cannot be made for a reason not the workflow's" in {
    // An ended run of the workflow on the unit that a later one replaced: a create that goes
    // through expires its results.
    insertExecution(961921, testWid, unitCuid, status = 3)
    insertExecution(961923, testWid, unitCuid, status = 1)
    val console = withConsole(testWid, 961921)
    logged(961923, "READY", "RUNNING")
    val databaseDown = new RuntimeException("db down")
    val before = executionCount
    val since = System.currentTimeMillis()

    val failure = intercept[InternalServerErrorException] {
      post(request(), creator = new FixtureCreator(hints = new FailingHints(databaseDown)))
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getCause shouldBe databaseDown
    executionCount shouldBe before + 1
    val eid = newestEid
    failure.getMessage shouldBe
      s"Execution $eid could not be created: its plan could not be made."
    closedAtCreate(eid.toLong, "its plan could not be made", since)
    // A create that fails expires nothing.
    hasTable(console) shouldBe true
    row(961921).getResultsExpiredAt shouldBe null
  }

  // --- the compiling service, asked over HTTP ---

  /** A creator that asks the compiling service at `endpoint`, as the deployment's creator does. */
  private def creatorAsking(
      endpoint: URI,
      deadline: FiniteDuration = ExecutionCreator.CompileDeadline,
      linker: InputLinker = FixtureInputs.linker
  ): FixtureCreator =
    new FixtureCreator(
      compiling = Some(new WorkflowCompilingServiceClient(endpoint, connectTimeout = 2.seconds)),
      compileDeadline = deadline,
      linker = linker
    )

  /**
    * The create of an execution of the search plan that the compiling service `answer`s: what
    * it answers `status`, with the execution left failed, and closed with `reason`.
    */
  private def refusedAfterAsking(
      status: Int,
      reason: String,
      deadline: FiniteDuration = ExecutionCreator.CompileDeadline
  )(answer: StubCompilingServer.Request => StubCompilingServer.Answer): String =
    Using.resource(new StubCompilingServer(answer)) { server =>
      val before = executionCount
      val since = System.currentTimeMillis()
      val failure = intercept[WebApplicationException] {
        post(request(), creator = creatorAsking(server.endpoint, deadline))
      }
      failure.getResponse.getStatus shouldBe status
      server.requests should have size 1
      executionCount shouldBe before + 1
      val eid = newestEid.toLong
      closedAtCreate(eid, reason, since)
      failure.getMessage
    }

  it should "ask the compiling service for the plan with the caller's own token, and sign a link to each file it names" in {
    val signed = mutable.ListBuffer.empty[String]
    val expiresAtMs = System.currentTimeMillis() + 2 * 3600L * 1000
    val linker: InputLinker = address => {
      signed += address
      InputLink(
        "http://texera-rustfs:9000/texera-dataset/sales?X-Amz-Signature=5ecr3t",
        expiresAtMs
      )
    }
    Using.resource(StubCompilingServer.compiling()) { server =>
      val creator = creatorAsking(server.endpoint, linker = linker)
      val sent = request()

      val execution = created(post(sent, creator = creator))

      // Asked once, as the caller: with the request's own Authorization header.
      val asked = server.requests.toList
      asked.map(ask => (ask.path, ask.authorization)) shouldBe
        List(("/api/compile/run", FixtureCompilingService.authorizationOf(creatorUid)))
      val body = asked.head.body
      body.fieldNames().asScala.toSet shouldBe
        Set("workflowId", "executionId", "settings", "logicalPlan")
      body.get("workflowId").asLong() shouldBe testWid
      body.get("executionId").asLong() shouldBe execution.eid
      body.get("settings") shouldBe objectMapper.readTree(
        """{"dataTransferBatchSize": 77, "executionMode": "MATERIALIZED"}"""
      )
      // The workflow as the request sent it: the Dashboard reads nothing in it.
      body.get("logicalPlan") shouldBe sent.logicalPlan

      // The link is signed for where the plan says the scan's file is kept, and takes the
      // address's place in the plan answered, with the expiry the linker gave it.
      val scanned = TestOperators.localFileUri(TestOperators.CountrySalesSmallCsvPath)
      signed.toList shouldBe List(scanned.toString)
      val plan = planOf(execution)
      inputsOf(plan, "scan").files shouldBe Seq(
        InputFile(
          scanned.toASCIIString,
          "http://texera-rustfs:9000/texera-dataset/sales?X-Amz-Signature=5ecr3t",
          expiresAtMs
        )
      )
      execution.plan.split("X-Amz-Signature=5ecr3t", -1) should have length 2
      execution.plan should not include "physicalAddress"
      // What a unit checks before it starts the execution passes.
      WorkflowService
        .checkStart(
          execution.eid,
          execution.plan,
          sessionUser(creatorUid).getUser,
          unitCuid,
          Some(testWid.toLong)
        )
        .isRight shouldBe true
    }
  }

  it should "send the warehouse and the target of the run to the compiling service" in {
    Using.resource(StubCompilingServer.compiling()) { server =>
      val creator = new FixtureCreator(
        warehouses = true,
        compiling = Some(new WorkflowCompilingServiceClient(server.endpoint))
      )

      val execution = created(
        post(
          request(warehouseId = Some(creatorWhid), target = Some("scan")),
          creator = creator
        )
      )

      val body = server.requests.toList.head.body
      body.get("warehouse").asText() shouldBe creatorWarehouse
      body.get("targetOperatorId").asText() shouldBe "scan"
      val plan = planOf(execution)
      plan.context.warehouse shouldBe Some(creatorWarehouse)
      plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("scan")
    }
  }

  it should "relay each operator's error as the compiling service answers it, and record the execution FAILED" in {
    Using.resource(StubCompilingServer.compiling()) { server =>
      val since = System.currentTimeMillis()

      val failure =
        compileFailure(post(request(plan = brokenPlan()), creator = creatorAsking(server.endpoint)))

      failure.code shouldBe 400
      failure.message should startWith("The workflow does not compile: 2 operators have errors.")
      // In the order the service wrote them: an operator before those downstream of it.
      failure.operatorErrors.keys.toList shouldBe List("scan", "search")
      failure.operatorErrors("scan").message should include("No file selected")
      failure.operatorErrors.foreach {
        case (operator, error) =>
          error.`type` shouldBe COMPILATION_ERROR
          error.operatorId shouldBe operator
          error.timestamp.seconds should be >= (since / 1000 - 1)
          error.details should not be empty
      }
      closedAtCreate(
        failure.eid,
        s"compile error: ${failure.operatorErrors("scan").message}",
        since
      )
    }
  }

  it should "relay what the compiling service says of a workflow it cannot read, and record the execution FAILED" in {
    refusedAfterAsking(400, "compile error: The workflow's links form a cycle: a -> b -> a.") { _ =>
      StubCompilingServer.Answer(
        400,
        """{"code": 400, "message": "The workflow's links form a cycle: a -> b -> a."}"""
      )
    } shouldBe "The workflow's links form a cycle: a -> b -> a."
  }

  it should "answer 504 and record the execution FAILED when the compiling service does not answer by the deadline" in {
    val message = refusedAfterAsking(504, "its plan could not be made", deadline = 500.millis) {
      _ =>
        Thread.sleep(3000)
        StubCompilingServer.Answer(200, "{}")
    }

    message shouldBe s"Execution $newestEid could not be created: compiling the workflow took " +
      "longer than 500 milliseconds."
  }

  it should "answer 504 when the compiling service gives a compile up at its own deadline" in {
    refusedAfterAsking(504, "its plan could not be made") { _ =>
      StubCompilingServer.Answer(
        504,
        """{"code": 504, "message": "Compiling the workflow took longer than 60 seconds."}"""
      )
    } shouldBe s"Execution $newestEid could not be created: compiling the workflow took longer " +
      "than 60 seconds."
  }

  it should "answer 503 and record the execution FAILED when the compiling service has too many compiles waiting" in {
    refusedAfterAsking(503, "its plan could not be made") { _ =>
      StubCompilingServer.Answer(
        503,
        """{"code": 503, "message": "Too many workflows are being compiled. Try again in a moment."}"""
      )
    } shouldBe s"Execution $newestEid could not be created: too many workflows are being " +
      "compiled. Try again in a moment."
  }

  it should "answer 503 and record the execution FAILED when the compiling service cannot be reached" in {
    // An address nothing listens at: the server that had it is closed.
    val server = new StubCompilingServer(_ => StubCompilingServer.Answer(200, "{}"))
    val endpoint = server.endpoint
    server.close()
    val before = executionCount
    val since = System.currentTimeMillis()

    val failure = intercept[WebApplicationException] {
      post(request(), creator = creatorAsking(endpoint))
    }

    failure.getResponse.getStatus shouldBe 503
    executionCount shouldBe before + 1
    val eid = newestEid
    failure.getMessage shouldBe s"Execution $eid could not be created: the workflow compiling " +
      "service could not be reached. Try again in a moment."
    closedAtCreate(eid.toLong, "its plan could not be made", since)
  }

  it should "answer 500 and record the execution FAILED when the compiling service fails, or answers what is no plan" in {
    Seq[(String, StubCompilingServer.Answer)](
      "its own failure" -> StubCompilingServer.Answer(
        500,
        """{"code": 500, "message": "There was an error processing your request."}"""
      ),
      "a refusal of the caller's token" -> StubCompilingServer.Answer(401, ""),
      "no JSON" -> StubCompilingServer.Answer(200, "<html>a proxy's page</html>"),
      "no plan" -> StubCompilingServer.Answer(200, """{}"""),
      "text that is no plan" ->
        StubCompilingServer.Answer(200, """{"plan": "{}"}""")
    ).foreach {
      case (what, answer) =>
        withClue(s"$what: ") {
          refusedAfterAsking(500, "its plan could not be made")(_ => answer) shouldBe
            s"Execution $newestEid could not be created: its plan could not be made."
        }
    }
  }

  it should "answer 500 when the compiling service answers the plan of another execution" in {
    // A plan as the service makes one, of an execution the Dashboard did not ask for.
    val others = TestUtils.fixtureCompiling
      .planToRun(
        WorkflowCompilingService.PlanRequest(
          testWid,
          firstCreatedEid - 1L,
          None,
          sentSettings,
          request().logicalPlan,
          None
        ),
        FixtureCompilingService.authorizationOf(creatorUid),
        ExecutionCreator.CompileDeadline
      )

    refusedAfterAsking(500, "its plan could not be made") { _ =>
      StubCompilingServer.Answer(
        200,
        objectMapper.writeValueAsString(
          objectMapper
            .createObjectNode()
            .put("plan", others)
        )
      )
    } shouldBe s"Execution $newestEid could not be created: its plan could not be made."
  }

  it should "answer 500, not the scan's error, when a file cannot be resolved, located or linked for a reason not the workflow's" in {
    // The database or the storage not answering says nothing about the file a scan names: it is
    // the server's failure, and not an error of the workflow for its user to fix.
    val databaseDown = new DataAccessException("the database does not answer")
    val storageDown = new java.io.IOException("the storage does not answer")
    val keysGone = new IllegalStateException("the object store's keys are gone")
    Seq[(FixtureCreator, Option[Exception])](
      // In the compiling service, of whose failure the Dashboard has only the status.
      new FixtureCreator(
        bindings = _ => TestUtils.fixtureBindings.copy(files = _ => throw databaseDown)
      ) -> None,
      new FixtureCreator(
        bindings = _ =>
          TestUtils.fixtureBindings
            .copy(locator = (_ => throw storageDown): InputFileLocator)
      ) -> None,
      // In the Dashboard itself, as it signs the plan's links.
      new FixtureCreator(linker = _ => throw keysGone) -> Some(keysGone)
    ).foreach {
      case (creator, cause) =>
        val before = executionCount

        val failure = intercept[InternalServerErrorException] {
          post(request(), creator = creator)
        }

        failure.getResponse.getStatus shouldBe 500
        cause match {
          case Some(own) => failure.getCause shouldBe own
          case None      => failure.getCause shouldBe a[CompileRefused]
        }
        executionCount shouldBe before + 1
        val eid = newestEid
        failure.getMessage shouldBe
          s"Execution $eid could not be created: its plan could not be made."
        row(eid.toLong).getOutcome shouldBe 4
    }
  }

  // --- expiring what earlier runs left ---

  it should "leave the results of the unit's last run alone until a unit has started a later execution" in {
    insertExecution(961911, testWid, clearingCuid, status = 3) // what the unit ran last
    insertExecution(961913, testWid, otherUnitCuid, status = 3) // another unit's
    insertExecution(961914, otherWid, clearingCuid, status = 3) // another workflow's
    val consoles = mutable.Map(
      961911L -> withConsole(testWid, 961911),
      961913L -> withConsole(testWid, 961913),
      961914L -> withConsole(otherWid, 961914)
    )
    def kept(eids: Long*): Unit =
      eids.foreach { eid =>
        withClue(s"execution $eid: ") {
          hasTable(consoles(eid)) shouldBe true
          row(eid).getResultsExpiredAt shouldBe null
        }
      }

    // A workflow that does not compile, then two executions that are created and not started,
    // as a reload or a Stop during the create leaves them: the unit still shows its last run.
    compileFailure(post(request(plan = brokenPlan(), cuid = clearingCuid)))
    val abandoned = created(post(request(cuid = clearingCuid)))
    val started = created(post(request(cuid = clearingCuid)))
    row(abandoned.eid).getEndedAt shouldBe null
    kept(961911, 961913, 961914)

    // The unit starts the second: its log names the run's first states.
    logged(started.eid, "READY", "RUNNING")
    consoles += started.eid -> withConsole(testWid, started.eid.toInt)
    created(post(request(cuid = clearingCuid)))

    hasTable(consoles(961911)) shouldBe false
    row(961911).getResultsExpiredAt should not be null
    row(961911).getStoredBytes shouldBe 0L
    kept(961913, 961914, started.eid)
    // Expired, not deleted: the execution stays in the history as it ended.
    row(961911).getOutcome shouldBe 3
  }

  it should "expire what a run replaced once it has answered, not while the request waits" in {
    insertExecution(961941, testWid, clearingCuid, status = 3)
    insertExecution(961942, testWid, clearingCuid, status = 1)
    val replaced = withConsole(testWid, 961941)
    logged(961942, "READY", "RUNNING")
    val left = mutable.ListBuffer.empty[Runnable]

    created(
      post(request(cuid = clearingCuid), creator = new FixtureCreator(background = left += _))
    )

    hasTable(replaced) shouldBe true
    left should have size 1

    left.foreach(_.run())

    hasTable(replaced) shouldBe false
  }

  it should "expire what a run of another user replaced on a unit they share" in {
    // The creator's last run on a unit the reader may also run workflows on, and the reader's
    // run after it.
    insertExecution(961931, testWid, sharedCuid, status = 3)
    insertExecution(961932, testWid, sharedCuid, status = 1, uid = readerUid)
    val creators = withConsole(testWid, 961931)
    val readers = withConsole(testWid, 961932)
    logged(961932, "READY", "RUNNING")

    val execution = created(post(request(cuid = sharedCuid), uid = readerUid))

    row(execution.eid).getUid shouldBe readerUid
    hasTable(creators) shouldBe false
    hasTable(readers) shouldBe true
  }

  // --- closing earlier runs ---

  /** Makes the log of execution `eid` and records `states` in it, a second apart. */
  private def logged(eid: Long, states: String*): URI = {
    val log = logOf(eid)
    states.zipWithIndex.foreach { case (state, index) => record(log, eid, index + 1, state) }
    log
  }

  it should "close an earlier execution whose log shows an ending while its row is still open, then expire what was replaced" in {
    // The unit ran three executions and has just ended the second; a fourth was created and
    // never started. The closing job has looked at none of them, so every row is open.
    val Seq(first, second, third, unstarted) =
      (1 to 4).map(_ => created(post(request(cuid = closingCuid))))
    logged(first.eid, "READY", "RUNNING", "COMPLETED")
    val failing = logged(second.eid, "READY", "RUNNING")
    record(failing, second.eid, 3, "FAILED", errors = Seq(boom))
    logged(third.eid, "READY", "RUNNING")
    val consoles = Seq(first, second, third)
      .map(execution => execution.eid -> withConsole(testWid, execution.eid.toInt))
      .toMap
    // Another unit's, whose log shows an ending too: not this create's to look at.
    val elsewhere = created(post(request(cuid = closingOtherCuid)))
    logged(elsewhere.eid, "READY", "RUNNING", "KILLED")
    Seq(first, second, third, unstarted, elsewhere).foreach { execution =>
      row(execution.eid).getEndedAt shouldBe null
    }

    val next = created(post(request(cuid = closingCuid)))

    // Closed with what their logs say, at a time between their creation and now.
    val closedFirst = ExecutionRecords.find(first.eid).get.closing.get
    closedFirst.copy(endedAtMs = 0L) shouldBe
      ClosingRecord(WorkflowExecutionStatus.Completed, None, 0L, fromLog = true)
    closedFirst.endedAtMs should (be >= createdAt(first.eid) and be <= System.currentTimeMillis())
    ExecutionRecords.find(second.eid).get.closing.get.copy(endedAtMs = 0L) shouldBe
      ClosingRecord(WorkflowExecutionStatus.Failed, Some(boom.message), 0L, fromLog = true)
    // What they hold was measured as they were closed: a plan and a log, at least.
    row(first.eid).getStoredBytes.longValue() should be > 0L
    row(second.eid).getStoredBytes.longValue() should be > 0L
    // The first, which later runs replaced, is expired: its log stays.
    hasTable(consoles(first.eid)) shouldBe false
    row(first.eid).getResultsExpiredAt should not be null
    hasTable(logOfUri(first.eid)) shouldBe true
    // The second, closed and replaced by the third's run as well, is expired too.
    hasTable(consoles(second.eid)) shouldBe false
    row(second.eid).getResultsExpiredAt should not be null
    // The one that runs is left open, and untouched; so are the ones no unit started, and
    // the other unit's.
    Seq(third, unstarted, next, elsewhere).foreach { execution =>
      withClue(s"execution ${execution.eid}: ") {
        val left = row(execution.eid)
        left.getEndedAt shouldBe null
        left.getOutcome shouldBe null
        left.getStoredBytes shouldBe null
      }
    }
    hasTable(consoles(third.eid)) shouldBe true
  }

  it should "keep the results of the run it has just closed, which the unit ran last, and expire those of the run before it" in {
    // The unit ran two executions, one after the other; the closing job has looked at neither.
    val Seq(before, last) = (1 to 2).map(_ => created(post(request(cuid = lastRunCuid))))
    logged(before.eid, "READY", "RUNNING", "COMPLETED")
    logged(last.eid, "READY", "RUNNING", "COMPLETED")
    val consoles = Seq(before, last)
      .map(execution => execution.eid -> withConsole(testWid, execution.eid.toInt))
      .toMap

    created(post(request(cuid = lastRunCuid)))

    Seq(before, last).foreach(execution => row(execution.eid).getEndedAt should not be null)
    hasTable(consoles(before.eid)) shouldBe false
    row(before.eid).getResultsExpiredAt should not be null
    // What the unit still shows, until it starts the execution just created.
    hasTable(consoles(last.eid)) shouldBe true
    row(last.eid).getResultsExpiredAt shouldBe null
  }

  it should "leave earlier executions to the closing job when their logs cannot be read" in {
    val ended = created(post(request(cuid = closingOtherCuid)))
    logged(ended.eid, "READY", "RUNNING", "COMPLETED")
    val unread = recordingCloser(label = lakeDown)

    created(post(request(cuid = closingOtherCuid), creator = new FixtureCreator(closer = unread)))

    row(ended.eid).getEndedAt shouldBe null
  }

  it should "not read the log of an earlier execution in a warehouse the deployment cannot reach" in {
    // Its log's URI would name the shared warehouse, where a log of that name is another's.
    insertExecution(961951, testWid, closingOtherCuid, status = 1, whid = Some(creatorWhid))
    val read = mutable.ListBuffer.empty[URI]
    val noting = recordingCloser(label = uri => {
      read.synchronized(read += uri)
      ExecutionLogStore.label(uri)
    })

    created(post(request(cuid = closingOtherCuid), creator = new FixtureCreator(closer = noting)))

    read.map(VFSURIFactory.decodeURI(_).executionId.id) should not contain 961951L
    row(961951).getEndedAt shouldBe null
  }

  it should "email the user of an earlier execution it closes how that one ended" in {
    val asked =
      created(post(request(cuid = closingOtherCuid, emailNotificationEnabled = true)))
    val unasked = created(post(request(cuid = closingOtherCuid)))
    val failing = logged(asked.eid, "READY", "RUNNING")
    record(failing, asked.eid, 3, "FAILED", errors = Seq(boom))
    logged(unasked.eid, "READY", "RUNNING", "COMPLETED")
    val before = sentEmails.size

    created(post(request(cuid = closingOtherCuid)))

    Seq(asked, unasked).foreach(execution => row(execution.eid).getEndedAt should not be null)
    val sent = sentEmails.drop(before).toList
    sent.map(email => (email.receiver, email.subject)) shouldBe
      List((creatorEmail, s"[Texera] Workflow $workflowName ($testWid): Failed"))
    sent.head.content should include(s"- Reason: ${boom.message}\n")
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
    } shouldBe s"Computing unit $terminatedCuid is terminated."
  }

  // --- refused: warehouse ---

  it should "refuse a warehouse the run may not write into, by each rule" in {
    refused(400) {
      post(request(warehouseId = None), creator = new FixtureCreator(warehouses = true))
    } shouldBe "A warehouse must be selected for this execution."
    refused(400) {
      post(
        request(warehouseId = Some(strangerWhid)),
        creator = new FixtureCreator(warehouses = true)
      )
    } shouldBe s"You have no warehouse with id $strangerWhid."
    refused(400) {
      post(request(warehouseId = Some(creatorWhid)), creator = new FixtureCreator())
    } shouldBe "Per-user warehouses are disabled in this deployment."
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

  it should "refuse a replay of another user's run of the workflow" in {
    // The reader may read the workflow, and so may run it, but the replay log is the creator's.
    refused(400) {
      post(
        request(cuid = readerCuid, replay = Some(ReplayExecutionInfo(replaySourceEid, "i-1"))),
        uid = readerUid
      )
    } shouldBe
      s"Execution $replaySourceEid is another user's: only your own executions can be replayed."
  }

  // --- refused: malformed ---

  it should "refuse a workflow whose links form a cycle or name an operator it does not have, in the compiling service's words" in {
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

    refusedByCompiler(post(request(plan = cyclic))) shouldBe
      "The workflow's links form a cycle: a -> b -> a."
    refusedByCompiler(post(request(plan = dangling))) shouldBe
      "The link from scan to ghost names operator ghost, which the workflow does not have."
  }

  it should "refuse a request that names no workflow, unit, engine version or plan" in {
    refused(400)(post(null)) shouldBe "The request has no body."
    refused(400)(post(request(wid = 0))) shouldBe "The request names no workflow."
    refused(400)(post(request(wid = Int.MaxValue.toLong + 1))) shouldBe
      "The request names no workflow."
    refused(400)(post(request(cuid = 0))) shouldBe
      "The request names no computing unit to run the workflow on."
    refused(400)(post(request().copy(engineVersion = null))) shouldBe
      "The request names no engine version."
    refused(400)(post(request(plan = null))) shouldBe "The request has no logical plan."
    // A logical plan is an object: the Dashboard reads nothing else of it.
    Seq(objectMapper.readTree("[]"), objectMapper.readTree("\"a plan\""), objectMapper.nullNode())
      .foreach { notAPlan =>
        refused(400)(post(request().copy(logicalPlan = notAPlan))) shouldBe
          "The request has no logical plan."
      }
  }

  it should "refuse a name or an engine version longer than the row keeps" in {
    refused(400)(post(request().copy(executionName = "n" * 129))) shouldBe
      s"The execution's name is longer than ${ExecutionCreator.MaxColumnLength} characters."
    refused(400)(post(request().copy(engineVersion = "v" * 120))) shouldBe
      "The request's engine version is longer than the 107 characters an execution keeps."
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

  // --- what an execution recorded: its state and its log ---

  /** The resource, reading what executions recorded through `records`. */
  private def recorded(
      records: ExecutionRecordReader = new ExecutionRecordReader(warehousesEnabled = false)
  ): ExecutionResource = new ExecutionResource(new FixtureCreator(), new OperatorUpdates(), records)

  /** When execution `eid` was created, as its row says. */
  private def createdAt(eid: Long): Long = row(eid).getStartingTime.getTime

  /** Where the log of execution `eid` is. */
  private def logOfUri(eid: Long, warehouse: Option[String] = None): URI =
    ExecutionLogStore.logUri(WorkflowIdentity(testWid), ExecutionIdentity(eid), warehouse)

  /** Makes the log of execution `eid`, empty, as its unit does when it starts the run. */
  private def logOf(eid: Long, warehouse: Option[String] = None): URI = {
    val uri = logOfUri(eid, warehouse)
    ExecutionLogStore.create(uri, createdAt(eid), 30000L)
    madeLogs += uri
    uri
  }

  /**
    * Appends row `seq` to the log at `log`: the run of execution `eid` changed to `state`,
    * `seq` seconds after the execution was created. Answers when.
    */
  private def record(
      log: URI,
      eid: Long,
      seq: Int,
      state: String,
      reason: Option[String] = None,
      errors: Seq[WorkflowFatalError] = Nil
  ): Long = {
    val atMs = createdAt(eid) + seq * 1000L
    ExecutionLogStore.append(
      log,
      Seq(ExecutionLogEntry.state(seq.toLong, atMs, state, reason, errors)),
      atMs
    )
    atMs
  }

  private val boom = WorkflowFatalError(
    EXECUTION_FAILURE,
    com.google.protobuf.timestamp.Timestamp(1794873600L, 500000000),
    "java.lang.RuntimeException: boom",
    "<trace>",
    "search",
    "Worker:WF9611-search-main-0"
  )

  private def lakeDown[T](uri: URI): T = throw new IllegalStateException(s"no answer for $uri")

  "ExecutionResource.getState" should "answer a closed execution from its closing record" in {
    val failure = compileFailure(post(request(plan = brokenPlan())))

    val state = recorded().getState(failure.eid, sessionUser(creatorUid))

    state shouldBe ExecutionStateResponse(
      eid = failure.eid,
      status = WorkflowExecutionStatus.Failed,
      open = false,
      reason = Some(s"compile error: ${failure.operatorErrors("scan").message}"),
      timeMs = row(failure.eid).getEndedAt.getTime
    )
  }

  it should "answer an open execution from the newest state in its log" in {
    val execution = created(post(request()))
    val log = logOf(execution.eid)
    val resource = recorded()
    def state = resource.getState(execution.eid, sessionUser(creatorUid))

    Seq("READY" -> 0, "RUNNING" -> 1, "PAUSED" -> 2, "RUNNING" -> 1).zipWithIndex.foreach {
      case ((recordedState, status), index) =>
        val atMs = record(log, execution.eid, index + 1, recordedState)
        withClue(s"$recordedState: ") {
          state shouldBe
            ExecutionStateResponse(execution.eid, status.toShort, open = true, None, atMs)
        }
    }
    // Ended, and not closed yet: the closing job has to tick first.
    val endedAtMs = record(log, execution.eid, 5, "FAILED", errors = Seq(boom))
    state shouldBe ExecutionStateResponse(
      execution.eid,
      WorkflowExecutionStatus.Failed,
      open = true,
      Some("java.lang.RuntimeException: boom"),
      endedAtMs
    )
    row(execution.eid).getEndedAt shouldBe null
  }

  it should "answer Created, as of the create, for an open execution no unit has written a state for" in {
    val execution = created(post(request()))
    val resource = recorded()
    val unstarted = ExecutionStateResponse(
      execution.eid,
      WorkflowExecutionStatus.Created,
      open = true,
      None,
      createdAt(execution.eid)
    )

    // No log at all, and then a log its unit has made and not written to.
    resource.getState(execution.eid, sessionUser(creatorUid)) shouldBe unstarted
    logOf(execution.eid)
    resource.getState(execution.eid, sessionUser(creatorUid)) shouldBe unstarted
  }

  it should "never answer a state's time before the execution was created" in {
    val execution = created(post(request()))
    val log = logOf(execution.eid)
    // A unit whose clock runs an hour behind.
    ExecutionLogStore.append(
      log,
      Seq(ExecutionLogEntry.state(1L, createdAt(execution.eid) - 3600000L, "RUNNING")),
      createdAt(execution.eid) - 3600000L
    )

    recorded().getState(execution.eid, sessionUser(creatorUid)) shouldBe ExecutionStateResponse(
      execution.eid,
      WorkflowExecutionStatus.Running,
      open = true,
      None,
      createdAt(execution.eid)
    )
  }

  it should "answer -1 for an open execution whose log cannot be read, and a closed one as ever" in {
    val open = created(post(request()))
    record(logOf(open.eid), open.eid, 1, "RUNNING")
    val closed = compileFailure(post(request(plan = brokenPlan())))
    val resource = recorded(new ExecutionRecordReader(label = lakeDown, warehousesEnabled = false))

    resource.getState(open.eid, sessionUser(creatorUid)) shouldBe ExecutionStateResponse(
      open.eid,
      WorkflowExecutionStatus.Unknown,
      open = true,
      None,
      createdAt(open.eid)
    )
    resource.getState(closed.eid, sessionUser(creatorUid)).status shouldBe
      WorkflowExecutionStatus.Failed
  }

  it should "answer -1, reading nothing, for an open execution in a warehouse that cannot be reached" in {
    val execution = created(
      post(
        request(warehouseId = Some(creatorWhid)),
        creator = new FixtureCreator(warehouses = true)
      )
    )
    val log = logOf(execution.eid, Some(creatorWarehouse))
    record(log, execution.eid, 1, "RUNNING")
    val read = mutable.ListBuffer.empty[URI]
    def reading(warehouses: Boolean) =
      recorded(
        new ExecutionRecordReader(
          label = uri => {
            read += uri
            ExecutionLogStore.label(uri)
          },
          warehousesEnabled = warehouses
        )
      )

    // Read while warehouses are off, its log would be looked for in the shared warehouse.
    reading(warehouses = false).getState(execution.eid, sessionUser(creatorUid)).status shouldBe
      WorkflowExecutionStatus.Unknown
    read shouldBe empty

    reading(warehouses = true).getState(execution.eid, sessionUser(creatorUid)).status shouldBe
      WorkflowExecutionStatus.Running
    read.toList shouldBe List(log)
  }

  it should "answer the ending the log gave in place of a verdict, once the verdict is revised" in {
    val execution = created(post(request()))
    val start = createdAt(execution.eid)
    val log = logOf(execution.eid)
    record(log, execution.eid, 1, "READY")
    record(log, execution.eid, 2, "RUNNING")
    val resource = recorded()
    def state = resource.getState(execution.eid, sessionUser(creatorUid))
    def closing = resource.getLog(execution.eid, sessionUser(creatorUid)).closing

    // The unit was cut off from the lake, and the closing job gave it up for lost.
    ExecutionRecords.close(
      execution.eid,
      WorkflowExecutionStatus.Failed,
      Some("unit lost"),
      start + 2000L,
      fromLog = false
    ) shouldBe true
    val lost = ExecutionStateResponse(
      execution.eid,
      WorkflowExecutionStatus.Failed,
      open = false,
      Some("unit lost"),
      start + 2000L
    )
    state shouldBe lost
    closing shouldBe Some(
      ExecutionClosingResponse(
        WorkflowExecutionStatus.Failed,
        Some("unit lost"),
        start + 2000L,
        false
      )
    )

    // It was not gone: the run ends. The verdict stands until the closing job reads the log.
    record(log, execution.eid, 9, "COMPLETED")
    state shouldBe lost
    new ExecutionCloser(now = () => start + 60000L)
      .reviseIfEnded(ExecutionRecords.find(execution.eid).get) shouldBe true

    state shouldBe ExecutionStateResponse(
      execution.eid,
      WorkflowExecutionStatus.Completed,
      open = false,
      None,
      start + 9000L
    )
    closing shouldBe
      Some(ExecutionClosingResponse(WorkflowExecutionStatus.Completed, None, start + 9000L, true))
    resource.getLog(execution.eid, sessionUser(creatorUid)).entries.map(_.state) shouldBe
      Seq(Some("READY"), Some("RUNNING"), Some("COMPLETED"))
  }

  "ExecutionResource.getLog" should "answer the rows of the log, oldest first, with why each state was taken, and no closing record while the execution is open" in {
    val execution = created(post(request()))
    val start = createdAt(execution.eid)
    val log = logOf(execution.eid)
    record(log, execution.eid, 1, "READY")
    record(log, execution.eid, 2, "RUNNING")
    record(log, execution.eid, 3, "PAUSED")
    record(log, execution.eid, 4, "FAILED", reason = Some("the run gave up"), errors = Seq(boom))

    val answered = recorded().getLog(execution.eid, sessionUser(creatorUid))

    answered.eid shouldBe execution.eid
    answered.closing shouldBe None
    answered.entries.take(3) shouldBe Seq(
      ExecutionLogEntryResponse(1L, start + 1000L, "state", Some("READY"), None, None),
      ExecutionLogEntryResponse(2L, start + 2000L, "state", Some("RUNNING"), None, None),
      ExecutionLogEntryResponse(3L, start + 3000L, "state", Some("PAUSED"), None, None)
    )
    val failed = answered.entries(3)
    failed.copy(errors = None) shouldBe ExecutionLogEntryResponse(
      4L,
      start + 4000L,
      "state",
      Some("FAILED"),
      Some("the run gave up"),
      None
    )
    failed.errors.map(objectMapper.writeValueAsString) shouldBe Some(
      """[{"type":"EXECUTION_FAILURE","timeMs":1794873600500,""" +
        """"message":"java.lang.RuntimeException: boom","details":"<trace>",""" +
        """"operatorId":"search","workerId":"Worker:WF9611-search-main-0"}]"""
    )
  }

  it should "answer a row that names only errors with its errors and no reason" in {
    val execution = created(post(request()))
    record(logOf(execution.eid), execution.eid, 1, "FAILED", errors = Seq(boom))

    val entries = recorded().getLog(execution.eid, sessionUser(creatorUid)).entries
    entries should have size 1
    val failed = entries.head

    failed.reason shouldBe None
    failed.errors.map(_.size()) shouldBe Some(1)
  }

  it should "answer the closing record beside the rows once the execution is closed" in {
    val execution = created(post(request()))
    val start = createdAt(execution.eid)
    val log = logOf(execution.eid)
    record(log, execution.eid, 1, "RUNNING")
    record(log, execution.eid, 2, "KILLED", reason = Some("killed by the user"))
    new ExecutionCloser(now = () => start + 60000L)
      .closeIfEnded(ExecutionRecords.find(execution.eid).get) shouldBe true

    val answered = recorded().getLog(execution.eid, sessionUser(creatorUid))

    answered.entries.map(_.seq) shouldBe Seq(1L, 2L)
    answered.entries.last.reason shouldBe Some("killed by the user")
    answered.closing shouldBe Some(
      ExecutionClosingResponse(
        WorkflowExecutionStatus.Killed,
        Some("killed by the user"),
        start + 2000L,
        fromLog = true
      )
    )
  }

  it should "answer no rows for an execution with no log" in {
    val unstarted = created(post(request()))
    val notCompiled = compileFailure(post(request(plan = brokenPlan())))
    val resource = recorded()

    resource.getLog(unstarted.eid, sessionUser(creatorUid)) shouldBe
      ExecutionLogResponse(unstarted.eid, Nil, None)
    val closed = resource.getLog(notCompiled.eid, sessionUser(creatorUid))
    closed.entries shouldBe Nil
    closed.closing shouldBe Some(
      ExecutionClosingResponse(
        WorkflowExecutionStatus.Failed,
        Some(s"compile error: ${notCompiled.operatorErrors("scan").message}"),
        row(notCompiled.eid).getEndedAt.getTime,
        fromLog = false
      )
    )
  }

  it should "answer 500, not a log with no rows, when the lake cannot be read" in {
    val execution = created(post(request()))
    record(logOf(execution.eid), execution.eid, 1, "RUNNING")
    val resource = recorded(new ExecutionRecordReader(rows = lakeDown, warehousesEnabled = false))

    val failure = intercept[InternalServerErrorException] {
      resource.getLog(execution.eid, sessionUser(creatorUid))
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getMessage shouldBe s"The log of execution ${execution.eid} could not be read."
    failure.getCause shouldBe an[IllegalStateException]
  }

  it should "answer 409, not a log with no rows, for a log in a warehouse that cannot be reached" in {
    val execution = created(
      post(
        request(warehouseId = Some(creatorWhid)),
        creator = new FixtureCreator(warehouses = true)
      )
    )
    record(logOf(execution.eid, Some(creatorWarehouse)), execution.eid, 1, "RUNNING")

    val refusal = intercept[WebApplicationException] {
      recorded().getLog(execution.eid, sessionUser(creatorUid))
    }

    refusal.getResponse.getStatus shouldBe 409
    refusal.getMessage shouldBe
      s"The log of execution ${execution.eid} is in a warehouse that is no longer available: " +
        s"per-user warehouses are disabled in this deployment, and it is in '$creatorWarehouse'."
    // With warehouses on, it is read where it is.
    recorded(new ExecutionRecordReader(warehousesEnabled = true))
      .getLog(execution.eid, sessionUser(creatorUid))
      .entries
      .map(_.state) shouldBe Seq(Some("RUNNING"))
  }

  // --- what an execution stored: its console output ---

  /** Makes the console table of execution `eid`, empty, as its unit does when it starts the run. */
  private def consoleOf(eid: Long, warehouse: Option[String] = None): URI = {
    val uri =
      ConsoleMessageStore.consoleUri(WorkflowIdentity(testWid), ExecutionIdentity(eid), warehouse)
    ConsoleMessageStore.create(uri)
    madeTables += uri
    uri
  }

  /** Message `seq` of an execution's console, printed by a worker of `operator`. */
  private def printed(seq: Long, operator: String): ConsoleRow =
    ConsoleRow(
      seq = seq,
      timeMs = 1794873600000L + seq,
      operatorId = operator,
      workerId = s"Worker:WF$testWid-$operator-main-0",
      msgType = "PRINT",
      source = s"$operator.py:process_tuple:$seq",
      title = s"line $seq",
      message = s"line $seq of $operator, in full"
    )

  private def answered(row: ConsoleRow): ExecutionConsoleMessageResponse =
    ExecutionConsoleMessageResponse(
      row.seq,
      row.timeMs,
      row.operatorId,
      row.workerId,
      row.msgType,
      row.source,
      row.title,
      row.message
    )

  /** An execution whose console holds messages 1 to 6, of `udf-a` and `udf-b` in turn. */
  private def executionWithConsole(): (Long, Seq[ConsoleRow]) = {
    val execution = created(post(request()))
    val rows = (1L to 6L).map(seq => printed(seq, if (seq % 2 == 1) "udf-a" else "udf-b"))
    val console = consoleOf(execution.eid)
    // Two commits of the run's record.
    ConsoleMessageStore.append(console, rows.take(4))
    ConsoleMessageStore.append(console, rows.drop(4))
    (execution.eid, rows)
  }

  /** A reader that reads no console, and keeps what each read asked for. */
  private class AskedMessages {
    val asked = mutable.ListBuffer.empty[(URI, Option[String], Long, Int)]

    val read: (URI, Option[String], Long, Int) => (Seq[ConsoleRow], Boolean) =
      (uri, operatorId, afterSeq, limit) => {
        asked += ((uri, operatorId, afterSeq, limit))
        (Nil, false)
      }
  }

  "ExecutionResource.getConsole" should "answer the console output the execution stored, oldest first, each message whole" in {
    val (eid, rows) = executionWithConsole()

    recorded().getConsole(eid, null, 0L, 1000, sessionUser(creatorUid)) shouldBe
      ExecutionConsoleResponse(eid, rows.map(answered), lastSeq = 6L, more = false)
  }

  it should "answer one operator's messages when the request names one, and every operator's when it names none" in {
    val (eid, rows) = executionWithConsole()
    val resource = recorded()
    def of(operatorId: String) =
      resource.getConsole(eid, operatorId, 0L, 1000, sessionUser(creatorUid))

    of("udf-b") shouldBe ExecutionConsoleResponse(
      eid,
      rows.filter(_.operatorId == "udf-b").map(answered),
      lastSeq = 6L,
      more = false
    )
    of("udf-a").messages.map(_.seq) shouldBe Seq(1L, 3L, 5L)
    of("udf-a").lastSeq shouldBe 5L
    of("no-such-operator") shouldBe ExecutionConsoleResponse(eid, Nil, lastSeq = 0L, more = false)
    // `?operatorId=`, as a client that filters by none sends it.
    of("").messages.map(_.seq) shouldBe (1L to 6L)
  }

  it should "answer the messages after afterSeq, a page of limit at a time, and whether more follow" in {
    val (eid, rows) = executionWithConsole()
    val resource = recorded()
    def page(afterSeq: Long, limit: Int, operatorId: String = null) =
      resource.getConsole(eid, operatorId, afterSeq, limit, sessionUser(creatorUid))

    val first = page(afterSeq = 0L, limit = 4)
    first shouldBe ExecutionConsoleResponse(eid, rows.take(4).map(answered), 4L, more = true)
    // The next page is asked for with the last one's lastSeq.
    val second = page(afterSeq = first.lastSeq, limit = 4)
    second shouldBe ExecutionConsoleResponse(eid, rows.drop(4).map(answered), 6L, more = false)
    // Past the end: nothing, and the same place to ask from again once the run prints more.
    page(afterSeq = second.lastSeq, limit = 4) shouldBe
      ExecutionConsoleResponse(eid, Nil, lastSeq = 6L, more = false)

    // A page that ends at the last message says that none follow.
    page(afterSeq = 2L, limit = 4).more shouldBe false
    page(afterSeq = 2L, limit = 3) shouldBe
      ExecutionConsoleResponse(eid, rows.slice(2, 5).map(answered), 5L, more = true)
    // One operator's pages skip the other's messages, and count only its own.
    page(afterSeq = 1L, limit = 1, operatorId = "udf-a") shouldBe
      ExecutionConsoleResponse(eid, Seq(answered(rows(2))), 3L, more = true)
    // A page of none tells whether there is anything after afterSeq.
    page(afterSeq = 5L, limit = 0) shouldBe ExecutionConsoleResponse(eid, Nil, 5L, more = true)
    page(afterSeq = 6L, limit = 0) shouldBe ExecutionConsoleResponse(eid, Nil, 6L, more = false)
  }

  it should "hold a page to 5,000 messages, whatever the limit asks for, and refuse a negative limit with 400" in {
    val execution = created(post(request()))
    val console = ConsoleMessageStore.consoleUri(
      WorkflowIdentity(testWid),
      ExecutionIdentity(execution.eid),
      None
    )
    val messages = new AskedMessages
    val resource =
      recorded(new ExecutionRecordReader(messages = messages.read, warehousesEnabled = false))
    def ask(limit: Int) =
      resource.getConsole(execution.eid, "udf-a", 17L, limit, sessionUser(creatorUid))

    Seq(1000, 4999, 5000, 5001, Int.MaxValue).foreach(ask)
    messages.asked.toList shouldBe
      Seq(1000, 4999, 5000, 5000, 5000).map(limit => (console, Some("udf-a"), 17L, limit))

    messages.asked.clear()
    val refusal = intercept[BadRequestException](ask(-1))
    refusal.getResponse.getStatus shouldBe 400
    refusal.getMessage shouldBe "A page holds 0 or more messages, not -1."
    messages.asked shouldBe empty
  }

  it should "answer no messages for an execution that stored none" in {
    val unstarted = created(post(request()))
    val notCompiled = compileFailure(post(request(plan = brokenPlan())))
    val silent = created(post(request()))
    consoleOf(silent.eid)
    // The lake outlives this suite's database: nothing an earlier run left is theirs.
    Seq(unstarted.eid, notCompiled.eid).foreach { eid =>
      ConsoleMessageStore.drop(
        ConsoleMessageStore.consoleUri(WorkflowIdentity(testWid), ExecutionIdentity(eid), None)
      )
    }
    val resource = recorded()

    // No console table, as for a run that no unit started, and one its run printed nothing to.
    Seq(unstarted.eid, notCompiled.eid, silent.eid).foreach { eid =>
      withClue(s"execution $eid: ") {
        resource.getConsole(eid, null, 0L, 1000, sessionUser(creatorUid)) shouldBe
          ExecutionConsoleResponse(eid, Nil, lastSeq = 0L, more = false)
      }
    }
  }

  it should "answer no messages, and read nothing, for an execution whose results have expired" in {
    val (eid, rows) = executionWithConsole()
    val messages = new AskedMessages
    val counting = (uri: URI, operatorId: Option[String], afterSeq: Long, limit: Int) => {
      messages.read(uri, operatorId, afterSeq, limit)
      ConsoleMessageStore.read(uri, operatorId, afterSeq, limit)
    }
    val resource =
      recorded(new ExecutionRecordReader(messages = counting, warehousesEnabled = false))
    def console = resource.getConsole(eid, null, 3L, 1000, sessionUser(creatorUid))

    // Closed, and its results not expired yet: its console is read as while it ran.
    ExecutionRecords.close(eid, WorkflowExecutionStatus.Completed, None, createdAt(eid), true)
    console.messages shouldBe rows.drop(3).map(answered)
    messages.asked should have size 1

    // Its row says that its results are gone, its console output with them.
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.RESULTS_EXPIRED_AT, new Timestamp(createdAt(eid) + 86400000L))
      .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(eid.toInt)))
      .execute()
    console shouldBe ExecutionConsoleResponse(eid, Nil, lastSeq = 3L, more = false)
    messages.asked should have size 1
  }

  it should "answer 500, not a console with no messages, when the lake cannot be read" in {
    val (eid, _) = executionWithConsole()
    val down =
      (uri: URI, _: Option[String], _: Long, _: Int) => lakeDown[(Seq[ConsoleRow], Boolean)](uri)
    val resource = recorded(new ExecutionRecordReader(messages = down, warehousesEnabled = false))

    val failure = intercept[InternalServerErrorException] {
      resource.getConsole(eid, null, 0L, 1000, sessionUser(creatorUid))
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getMessage shouldBe s"The console output of execution $eid could not be read."
    failure.getCause shouldBe an[IllegalStateException]
  }

  it should "answer 409, not a console with no messages, for one in a warehouse that cannot be reached" in {
    val execution = created(
      post(
        request(warehouseId = Some(creatorWhid)),
        creator = new FixtureCreator(warehouses = true)
      )
    )
    val console = consoleOf(execution.eid, Some(creatorWarehouse))
    ConsoleMessageStore.append(console, Seq(printed(1L, "udf-a")))

    val refusal = intercept[WebApplicationException] {
      recorded().getConsole(execution.eid, null, 0L, 1000, sessionUser(creatorUid))
    }

    refusal.getResponse.getStatus shouldBe 409
    refusal.getMessage shouldBe
      s"The console output of execution ${execution.eid} is in a warehouse that is no longer " +
        "available: per-user warehouses are disabled in this deployment, and it is in " +
        s"'$creatorWarehouse'."
    // With warehouses on, it is read where it is.
    recorded(new ExecutionRecordReader(warehousesEnabled = true))
      .getConsole(execution.eid, null, 0L, 1000, sessionUser(creatorUid))
      .messages shouldBe Seq(answered(printed(1L, "udf-a")))
  }

  it should "be served at GET /executions/{eid}/console, a page of 1,000 from the start unless the request says otherwise" in {
    val route = classOf[ExecutionResource].getMethods.find(_.getName == "getConsole").get
    route.getAnnotation(classOf[javax.ws.rs.GET]) should not be null
    route.getAnnotation(classOf[javax.ws.rs.Path]).value() shouldBe "/{eid}/console"
    route.getAnnotation(classOf[javax.annotation.security.RolesAllowed]).value().toSet shouldBe
      Set("REGULAR", "ADMIN")

    // Each query parameter by its name, with what it is when the request leaves it out.
    val parameters = route.getParameterAnnotations.toSeq.flatMap { annotations =>
      annotations.collectFirst { case query: javax.ws.rs.QueryParam => query.value() }.map { name =>
        name -> annotations.collectFirst {
          case default: javax.ws.rs.DefaultValue => default.value()
        }
      }
    }
    parameters shouldBe
      Seq("operatorId" -> None, "afterSeq" -> Some("0"), "limit" -> Some("1000"))
  }

  // --- who may read what an execution recorded ---

  /** The status of each of the three routes for `uid` asking about execution `eid`. */
  private def answersTo(uid: Int, eid: Long): Seq[Int] = {
    val resource = recorded()
    Seq[() => Any](
      () => resource.getState(eid, sessionUser(uid)),
      () => resource.getLog(eid, sessionUser(uid)),
      () => resource.getConsole(eid, null, 0L, 1000, sessionUser(uid))
    ).map { ask =>
      try {
        ask()
        200
      } catch {
        case refusal: ForbiddenException =>
          refusal.getMessage shouldBe s"You may not read execution $eid."
          refusal.getResponse.getStatus
      }
    }
  }

  "The state, the log and the console output of an execution" should "be answered to its creator, to the owner of its workflow and to a user the workflow was granted to" in {
    val ofOwner = created(post(request()))
    val ofReader = created(post(request(cuid = readerCuid), uid = readerUid))

    // The owner of the workflow created one, and may read the other; the reader was granted
    // the workflow, and created the other.
    answersTo(creatorUid, ofOwner.eid) shouldBe Seq(200, 200, 200)
    answersTo(creatorUid, ofReader.eid) shouldBe Seq(200, 200, 200)
    answersTo(readerUid, ofOwner.eid) shouldBe Seq(200, 200, 200)
    answersTo(readerUid, ofReader.eid) shouldBe Seq(200, 200, 200)
  }

  it should "be refused with 403 to a user with no right to the workflow" in {
    val execution = created(post(request()))

    answersTo(strangerUid, execution.eid) shouldBe Seq(403, 403, 403)
  }

  it should "be refused with 403 to a user who only sees the workflow because it is public" in {
    val execution = created(post(request()))
    getDSLContext
      .update(WORKFLOW)
      .set(WORKFLOW.IS_PUBLIC, java.lang.Boolean.TRUE)
      .where(WORKFLOW.WID.eq(Integer.valueOf(testWid)))
      .execute()
    try {
      // A log, and a console, can quote what the run read from its creator's private datasets.
      answersTo(strangerUid, execution.eid) shouldBe Seq(403, 403, 403)
      // Who ran the public workflow reads their own execution of it.
      val own = created(post(request(cuid = strangerCuid), uid = strangerUid))
      answersTo(strangerUid, own.eid) shouldBe Seq(200, 200, 200)
    } finally {
      getDSLContext
        .update(WORKFLOW)
        .set(WORKFLOW.IS_PUBLIC, java.lang.Boolean.FALSE)
        .where(WORKFLOW.WID.eq(Integer.valueOf(testWid)))
        .execute()
    }
  }

  it should "be refused with 403 for an execution there is not, as for one the user may not read" in {
    Seq(0L, -1L, 969999L, Int.MaxValue.toLong + 1, Long.MaxValue).foreach { eid =>
      withClue(s"execution $eid: ") { answersTo(creatorUid, eid) shouldBe Seq(403, 403, 403) }
    }
  }

  it should "be served at GET /executions/{eid}/state and /log, to regular users and admins" in {
    Seq("getState" -> "/{eid}/state", "getLog" -> "/{eid}/log").foreach {
      case (name, path) =>
        val route = classOf[ExecutionResource].getMethods.find(_.getName == name).get
        route.getAnnotation(classOf[javax.ws.rs.GET]) should not be null
        route.getAnnotation(classOf[javax.ws.rs.Path]).value() shouldBe path
        route.getAnnotation(classOf[javax.annotation.security.RolesAllowed]).value().toSet shouldBe
          Set("REGULAR", "ADMIN")
    }
  }

  // --- as written ---

  "A state" should "be written as {eid, status, open, reason, timeMs}, the reason null when there is none" in {
    val open = ExecutionStateResponse(345L, 1, open = true, None, 1794873600000L)
    val closed = ExecutionStateResponse(345L, 4, open = false, Some("unit lost"), 1794873600000L)

    dashboardMapper.readTree(dashboardMapper.writeValueAsString(open)) shouldBe
      objectMapper.readTree(
        """{"eid": 345, "status": 1, "open": true, "reason": null, "timeMs": 1794873600000}"""
      )
    dashboardMapper.readTree(dashboardMapper.writeValueAsString(closed)) shouldBe
      objectMapper.readTree(
        """{"eid": 345, "status": 4, "open": false, "reason": "unit lost",
          | "timeMs": 1794873600000}""".stripMargin
      )
  }

  "A log" should "be written with each row's own fields only, and a null closing while the execution is open" in {
    val errors = objectMapper.readTree("""[{"type": "EXECUTION_FAILURE", "message": "boom"}]""")
    val log = ExecutionLogResponse(
      345L,
      Seq(
        ExecutionLogEntryResponse(1L, 1794873600000L, "state", Some("READY"), None, None),
        ExecutionLogEntryResponse(
          2L,
          1794873601000L,
          "state",
          Some("FAILED"),
          Some("why"),
          Some(errors)
        )
      ),
      None
    )

    dashboardMapper.readTree(dashboardMapper.writeValueAsString(log)) shouldBe
      objectMapper.readTree(
        """{"eid": 345,
          | "entries": [
          |   {"seq": 1, "timeMs": 1794873600000, "kind": "state", "state": "READY"},
          |   {"seq": 2, "timeMs": 1794873601000, "kind": "state", "state": "FAILED",
          |    "reason": "why", "errors": [{"type": "EXECUTION_FAILURE", "message": "boom"}]}],
          | "closing": null}""".stripMargin
      )
  }

  it should "be written with its closing record as {outcome, reason, endedAtMs, fromLog}" in {
    val log = ExecutionLogResponse(
      345L,
      Nil,
      Some(ExecutionClosingResponse(4, Some("unit lost"), 1794873600000L, fromLog = false))
    )
    val byItsLog = log.copy(closing = Some(ExecutionClosingResponse(3, None, 1794873600000L, true)))

    dashboardMapper.readTree(dashboardMapper.writeValueAsString(log)) shouldBe
      objectMapper.readTree(
        """{"eid": 345, "entries": [],
          | "closing": {"outcome": 4, "reason": "unit lost", "endedAtMs": 1794873600000,
          |             "fromLog": false}}""".stripMargin
      )
    dashboardMapper.readTree(dashboardMapper.writeValueAsString(byItsLog)).get("closing") shouldBe
      objectMapper.readTree(
        """{"outcome": 3, "reason": null, "endedAtMs": 1794873600000, "fromLog": true}"""
      )
  }

  "A page of console output" should "be written as {eid, messages, lastSeq, more}, each message with its eight fields" in {
    val page = ExecutionConsoleResponse(
      345L,
      Seq(
        ExecutionConsoleMessageResponse(
          17L,
          1794873600000L,
          "udf-a",
          "Worker:WF12-udf-a-main-0",
          "PRINT",
          "udf-a.py:process_tuple:9",
          "hello",
          "hello, in full"
        )
      ),
      lastSeq = 17L,
      more = false
    )

    dashboardMapper.readTree(dashboardMapper.writeValueAsString(page)) shouldBe
      objectMapper.readTree(
        """{"eid": 345,
          | "messages": [
          |   {"seq": 17, "timeMs": 1794873600000, "operatorId": "udf-a",
          |    "workerId": "Worker:WF12-udf-a-main-0", "msgType": "PRINT",
          |    "source": "udf-a.py:process_tuple:9", "title": "hello",
          |    "message": "hello, in full"}],
          | "lastSeq": 17, "more": false}""".stripMargin
      )
    dashboardMapper.readTree(
      dashboardMapper.writeValueAsString(ExecutionConsoleResponse(345L, Nil, 0L, more = false))
    ) shouldBe
      objectMapper.readTree("""{"eid": 345, "messages": [], "lastSeq": 0, "more": false}""")
  }
}
