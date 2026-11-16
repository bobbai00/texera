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
import com.fasterxml.jackson.databind.node.ObjectNode
import com.google.protobuf.timestamp.Timestamp
import com.twitter.util.{Future, Promise}
import io.reactivex.rxjava3.disposables.Disposable
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.iceberg.Table
import org.apache.iceberg.catalog.{Catalog, Namespace, SupportsNamespaces, TableIdentifier}
import org.apache.iceberg.exceptions.ServiceUnavailableException
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.storage.{
  ExecutionAlreadyStartedException,
  ExecutionPlanStore,
  IcebergCatalogInstance,
  PlanRecord,
  RepositoryVersionResolver
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  EmbeddedControlMessageIdentity,
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  BoundResources,
  CostHints,
  ExecutionMode,
  ExecutionPlan,
  GlobalPortIdentity,
  InputFile,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PlanInput,
  PortIdentity,
  ReplaySource,
  RepositoryMounts,
  ResourceBinding,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.{
  COMPILATION_ERROR,
  EXECUTION_FAILURE
}
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.coordinator.{
  CoordinatorConfig,
  Workflow => EngineWorkflow
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.StartWorkflowResponse
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  READY,
  RUNNING,
  TERMINATED
}
import org.apache.texera.amber.engine.architecture.rpc.coordinatorservice.CoordinatorServiceFs2Grpc
import org.apache.texera.amber.engine.architecture.worker.WorkflowWorker.{
  FaultToleranceConfig,
  StateRestoreConfig
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.{PythonUDFOpDescV2, PythonUdfUiParameterInjector}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.enums.{PrivilegeEnum, WorkflowComputingUnitTypeEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  DatasetDao,
  DatasetUserAccessDao,
  DatasetVersionDao,
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  Dataset,
  DatasetUserAccess,
  DatasetVersion,
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowExecutions,
  WorkflowVersion
}
import org.apache.texera.web.WebsocketInput
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.common.compiler.{WorkflowCompilationFailed, WorkflowCompiler}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlan, LogicalPlanPojo}
import org.apache.texera.common.config.EnvironmentalVariable
import org.apache.texera.web.model.websocket.request.{
  ModifyLogicRequest,
  WorkflowCheckpointRequest,
  WorkflowExecuteRequest
}
import org.apache.texera.web.model.websocket.response.ModifyLogicResponse
import org.apache.texera.web.service.WorkflowEmailNotifier.Notification
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.lang.reflect.{InvocationHandler, Method, Proxy}
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Paths
import java.security.MessageDigest
import java.sql.{Timestamp => SqlTimestamp}
import java.time.Instant
import java.util.UUID
import scala.collection.mutable
import scala.collection.mutable.ListBuffer
import scala.jdk.CollectionConverters._
import scala.reflect.ClassTag
import scala.util.Try

/**
  * Regression guard for the consolidated init-error reporting path (#5921):
  * `WorkflowExecutionService` registers its metadata-store diff handler at
  * construction, so a fatalErrors update -- e.g. the one `errorHandler` records
  * when `executeWorkflow` fails -- surfaces as a `WorkflowErrorEvent` through the
  * normal websocket-event observable.
  *
  * The unused `resultService` is passed as `null` on purpose: construction must
  * stay side-effect-free (all throwing work is in `executeWorkflow`), so a future
  * change that dereferences it during construction would fail here.
  *
  * The suite also owns two paths that need more scaffolding than that:
  *
  *   - `executeWorkflow`'s compilation-failure arm, driven for real (not simulated
  *     through `errorHandler`) with a CSV scan that has no file selected -- the
  *     recipe `SyncExecutionResourceSpec` establishes and `WorkflowServiceSpec`
  *     reuses. Compilation rejects it inside `LogicalPlan.resolveScanSourceOpFileName`
  *     before `FileResolver` is reached, and again where its schema needs the file it does
  *     not have, before any file is opened, so no storage is involved, and the early
  *     `return` stops the method before `ComputingUnitMaster.createAmberRuntime`,
  *     which would build an `AmberClient` on `AmberRuntime.actorSystem` -- null
  *     outside a started coordinator, and whatever another suite left behind inside
  *     the shared serial JVM.
  *
  *   - `unsubscribeAll`, the session-teardown contract. This is what makes the
  *     suite carry a TestKit `ActorSystem` and `MockTexeraDB`: the method walks the
  *     four runtime services, and `ExecutionStatsService`'s constructor creates its
  *     iceberg runtime-statistics table and stamps the URI onto a `workflow_executions`
  *     row, so a non-null value for that field cannot be had more cheaply. There is
  *     no second home for the test -- one spec file per source class -- and stubbing
  *     the services out would leave the four teardown calls unobserved, which is the
  *     entire content of the method.
  *
  * The runtime half of `executeWorkflow` (everything from `createAmberRuntime` on) is out of
  * reach of those tests for the reason above and is exercised by the integration suites. The
  * tests of the plan a run makes reach it only through the service's `createAmberRuntime` seam,
  * which hands back a client on this suite's actor system that answers nothing: every service is
  * built around the plan, and nothing starts. They run as `testUid`, against two private datasets
  * of another user, one of them shared with `testUid`, on a unit that mounts under
  * `unitMountRoot` — so they pin what the run's compiler is given (its user, the unit's root)
  * and that a paused edit is bound by that same compiler. Its `makePlanToRun` seam records the
  * plan a run saves, or hands the run one a test made, and its `writePlan` seam can store a plan
  * row of a test's own in the run's place, so they also pin that the engine is handed only the
  * plan read back from the execution's plan table, and runs under the settings, replay and replay
  * log saved with it. These runs write their plan to the lake: the plan table of the fixture
  * execution, in the catalog the build's tests use (the Postgres JDBC catalog in CI), which each
  * run replaces. The runs of a plan the Dashboard made (`startStored`) are built as a unit builds
  * one to start it by id (`StoredRun`), on a plan encoded and read back here, with the same engine
  * seam; they read nothing from the lake but the changes one case stores in that plan table.
  *
  * Known, pre-existing: `ExecutionStatsService` never shuts down its private
  * `metricsPersistThread` (it does not override `unsubscribeAll`), so the teardown
  * test below leaks one single-thread executor into the shared JVM, as every
  * construction of that service already does.
  *
  * Three further gaps are deliberately described and NOT pinned, because a test that
  * froze the current behaviour would cement it:
  *
  *   - Partial construction. `executeWorkflow` assigns `client` first and the four
  *     services after it, and `WorkflowService` catches whatever they throw while
  *     leaving the half-built service published. `unsubscribeAll` then passes its
  *     `client != null` guard and NPEs on the first null service, aborting teardown.
  *
  *   - A recovery that ends in failure. `createStateEvent` carves out COMPLETED only,
  *     while the flag itself is lowered only by a `WorkflowRecoveryStatus(false)` from
  *     the engine, which an execution that dies mid-recovery need not ever send. Such an
  *     execution reaches FAILED with the flag still raised and is announced as
  *     "Recovering" from then on.
  *
  *   - `ExecutionReconfigurationService.registerWorkerCompletionCallback` discards the
  *     `Disposable` its `registerCallback` returns instead of handing it to
  *     `addSubscription`, so that one callback outlives the teardown below. Not this
  *     class's defect, and not this suite's to pin.
  */
class WorkflowExecutionServiceSpec
    extends TestKit(ActorSystem("WorkflowExecutionServiceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  // Distinct from every other suite's ids: the statistics URI is derived from wid/eid and
  // `createDocument` truncates whatever table already sits at it (ExecutionStatsServiceSpec
  // owns 9107/9108).
  private val testUid: Integer = 9207
  private val testWid: Integer = 9207
  private val testEid: Integer = 9208

  /**
    * The computing unit the fixture execution ran on. A different literal from `testWid` on
    * purpose: `getLatestExecutionID(wid, cuid)` binds two bare `Integer`s into one predicate, so a
    * fixture that reused one number for both would make a transposition of the two arguments
    * produce byte-identical SQL.
    */
  private val testCuid: Integer = 9209

  /** A computing unit with no executions, so the cuid leg of the predicate is not vacuous. */
  private val otherCuid: Integer = 9210

  /**
    * Owner of two private datasets: the one at `readableVersionPath` is shared with `testUid` for
    * reading, the one at `unreadableVersionPath` with no one.
    */
  private val datasetOwnerUid: Integer = 9211
  private val datasetOwnerEmail = s"u$datasetOwnerUid@example.com"
  private val readableVersionPath = s"/dataset/$datasetOwnerEmail/shared_sales/v1"
  private val unreadableVersionPath = s"/dataset/$datasetOwnerEmail/private_sales/v1"
  private val readableLocator = "dataset-9221:5ha7ed01"

  /** The directory the computing unit of the runs below mounts datasets and models under. */
  private val unitMountRoot = Paths.get("/mnt/texera-mounts")

  /** The error a scan with no file chosen fails to compile with. */
  private val noFileSelected =
    "No file selected. Please select a file from the 'File' dropdown in the right panel."

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()

    // Set explicitly rather than left to the SERIAL default: the computing-unit and execution
    // rows below bind `testUid` into their `uid` foreign keys, so a generated value would leave
    // them pointing at a user that does not exist.
    val user = new User
    user.setUid(testUid)
    user.setName("workflow-execution-test-user")
    user.setEmail(s"u$testUid@example.com")
    new UserDao(getDSLContext.configuration()).insert(user)

    val workflow = new Workflow
    workflow.setWid(testWid)
    workflow.setName(s"workflow-execution-test-$testWid")
    workflow.setContent("{}")
    workflow.setDescription("")
    workflow.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new SqlTimestamp(System.currentTimeMillis()))
    new WorkflowDao(getDSLContext.configuration()).insert(workflow)

    val version = new WorkflowVersion
    version.setWid(testWid)
    version.setContent("{}")
    version.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
    new WorkflowVersionDao(getDSLContext.configuration()).insert(version)

    val computingUnitDao = new WorkflowComputingUnitDao(getDSLContext.configuration())
    List(testCuid -> "workflow-execution-test-unit", otherCuid -> "workflow-execution-idle-unit")
      .foreach {
        case (cuid, name) =>
          val unit = new WorkflowComputingUnit
          unit.setCuid(cuid)
          unit.setUid(testUid)
          unit.setName(name)
          unit.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
          unit.setType(WorkflowComputingUnitTypeEnum.local)
          unit.setUri("local://test")
          unit.setResource("{}")
          computingUnitDao.insert(unit)
      }

    // `ExecutionStatsService`'s constructor stamps the runtime-statistics URI onto this row,
    // reaching it from the workflow through workflow_version. `cuid` is set because
    // `getLatestExecutionID` matches on it and a NULL cuid matches no value at all.
    val execution = new WorkflowExecutions
    execution.setEid(testEid)
    execution.setVid(version.getVid)
    execution.setUid(testUid)
    execution.setCuid(testCuid)
    execution.setStatus(0.toByte)
    execution.setStartingTime(new SqlTimestamp(System.currentTimeMillis()))
    execution.setBookmarked(false)
    execution.setName("workflow-execution-test-execution")
    execution.setEnvironmentVersion("test-env")
    new WorkflowExecutionsDao(getDSLContext.configuration()).insert(execution)

    val datasetOwner = new User
    datasetOwner.setUid(datasetOwnerUid)
    datasetOwner.setName("workflow-execution-dataset-owner")
    datasetOwner.setEmail(datasetOwnerEmail)
    new UserDao(getDSLContext.configuration()).insert(datasetOwner)
    Seq(
      (9221, "shared_sales", "dataset-9221", "5ha7ed01"),
      (9222, "private_sales", "dataset-9222", "9r1va7e2")
    ).foreach {
      case (did, name, repositoryName, versionHash) =>
        val dataset = new Dataset
        dataset.setDid(did)
        dataset.setName(name)
        dataset.setRepositoryName(repositoryName)
        dataset.setDescription("")
        dataset.setIsPublic(false)
        dataset.setOwnerUid(datasetOwnerUid)
        new DatasetDao(getDSLContext.configuration()).insert(dataset)
        val version = new DatasetVersion
        version.setDvid(did)
        version.setDid(did)
        version.setName("v1")
        version.setCreatorUid(datasetOwnerUid)
        version.setVersionHash(versionHash)
        new DatasetVersionDao(getDSLContext.configuration()).insert(version)
    }
    val grant = new DatasetUserAccess
    grant.setDid(9221)
    grant.setUid(testUid)
    grant.setPrivilege(PrivilegeEnum.READ)
    new DatasetUserAccessDao(getDSLContext.configuration()).insert(grant)
  }

  override protected def afterAll(): Unit = {
    try {
      // The plan table the runs below write, in the catalog the build's tests share.
      ExecutionPlanStore.drop(
        ExecutionPlanStore.planUri(
          WorkflowIdentity(testWid.longValue()),
          ExecutionIdentity(testEid.longValue()),
          None
        )
      )
      TestKit.shutdownActorSystem(system)
    } finally {
      closeConnectionPool()
      super.afterAll()
    }
  }

  private def buildService(
      store: ExecutionStateStore,
      errorHandler: Throwable => Unit = (_: Throwable) => (),
      logicalPlan: LogicalPlanPojo =
        LogicalPlanPojo(List.empty, List.empty, List.empty, List.empty),
      settings: WorkflowSettings = WorkflowSettings()
  ): WorkflowExecutionService = {
    val request = WorkflowExecuteRequest(
      executionName = "test",
      engineVersion = "test",
      logicalPlan = logicalPlan,
      replayFromExecution = None,
      workflowSettings = settings,
      emailNotificationEnabled = false,
      computingUnitId = 0,
      warehouseId = None
    )
    new WorkflowExecutionService(
      new WorkflowContext(),
      null,
      request,
      store,
      errorHandler,
      Integer.valueOf(1), // uid; these tests never resolve a file
      None,
      new URI("vfs:///test"),
      replay = None,
      replayLog = None
    )
  }

  /** Subscribe to the metadata store's websocket-event stream and collect events. */
  private def collectEvents(
      store: ExecutionStateStore
  ): mutable.ArrayBuffer[TexeraWebSocketEvent] = {
    val events = mutable.ArrayBuffer.empty[TexeraWebSocketEvent]
    store.metadataStore.getWebsocketEventObservable.subscribe {
      (evts: Iterable[TexeraWebSocketEvent]) => events ++= evts
    }
    events
  }

  /** A subscription whose only job is to report whether the manager holding it let it go. */
  private final class Tracker {
    var disposed = false
    val disposable: Disposable = Disposable.fromAction(() => disposed = true)
  }

  /**
    * Empty-plan client, the shape both `ExecutionRuntimeServiceSpec` and
    * `ExecutionStatsServiceSpec` use: real enough for the services' constructors, with the
    * engine-facing callbacks stubbed so nothing is registered against a live coordinator.
    */
  private final class TestAmberClient
      extends AmberClient(
        system,
        new WorkflowContext(),
        PhysicalPlan(Set.empty, Set.empty),
        CoordinatorConfig(None, None, None, None),
        _ => ()
      ) {
    var shutdownCount = 0

    override def shutdown(): Unit = {
      shutdownCount += 1
      super.shutdown()
    }

    override def registerCallback[T](callback: T => Unit)(implicit ct: ClassTag[T]): Disposable =
      Disposable.empty()

    /** The answer to the last request of each name asked of the engine, for a test to give. */
    val answers: mutable.Map[String, Promise[Any]] = mutable.Map.empty

    // Nothing asked of the engine is answered unless a test answers it, so a run set up on this
    // client never starts.
    override val coordinatorInterface: CoordinatorServiceFs2Grpc[Future, Unit] =
      Proxy
        .newProxyInstance(
          classOf[CoordinatorServiceFs2Grpc[Future, Unit]].getClassLoader,
          Array(classOf[CoordinatorServiceFs2Grpc[Future, Unit]]),
          new InvocationHandler {
            override def invoke(proxy: Any, method: Method, args: Array[AnyRef]): AnyRef =
              method.getName match {
                case "hashCode" => Integer.valueOf(System.identityHashCode(proxy))
                case "equals"   => java.lang.Boolean.valueOf(proxy.asInstanceOf[AnyRef] eq args(0))
                case "toString" => "UnansweredCoordinatorInterface"
                case request =>
                  val answer = Promise[Any]()
                  answers(request) = answer
                  answer
              }
          }
        )
        .asInstanceOf[CoordinatorServiceFs2Grpc[Future, Unit]]
  }

  /** The URI a run's start request came to: its emails link to the workflow on this host. */
  private val sessionUri = new URI("ws://texera.example:8080/wsapi/workflow-websocket")

  /** The page of the fixture workflow, on the host of `sessionUri`. */
  private val workflowPage = s"http://texera.example:8080/user/workspace/$testWid"

  /** The replay log of the execution before the fixture's, replayed up to one interaction. */
  private val replaySource = ReplaySource(
    ExecutionIdentity(testEid.longValue() - 1),
    new URI(s"file:///var/texera/logs/$testWid/${testEid - 1}/"),
    "interaction-7"
  )

  /** Where the fixture execution writes its replay log. */
  private val replayLogLocation = new URI(s"file:///var/texera/logs/$testWid/$testEid/")

  /** A catalog that fails every call, the way a REST catalog that cannot answer does. */
  private object UnavailableCatalog extends Catalog with SupportsNamespaces {
    private def unavailable(): Nothing =
      throw new ServiceUnavailableException("the catalog is unavailable")
    override def listTables(namespace: Namespace): java.util.List[TableIdentifier] = unavailable()
    override def dropTable(identifier: TableIdentifier, purge: Boolean): Boolean = unavailable()
    override def renameTable(from: TableIdentifier, to: TableIdentifier): Unit = unavailable()
    override def loadTable(identifier: TableIdentifier): Table = unavailable()
    override def createNamespace(
        namespace: Namespace,
        metadata: java.util.Map[String, String]
    ): Unit = unavailable()
    override def listNamespaces(namespace: Namespace): java.util.List[Namespace] = unavailable()
    override def loadNamespaceMetadata(namespace: Namespace): java.util.Map[String, String] =
      unavailable()
    override def dropNamespace(namespace: Namespace): Boolean = unavailable()
    override def setProperties(
        namespace: Namespace,
        properties: java.util.Map[String, String]
    ): Boolean = unavailable()
    override def removeProperties(
        namespace: Namespace,
        properties: java.util.Set[String]
    ): Boolean = unavailable()
  }

  /**
    * `body`, run with [[UnavailableCatalog]] in place of the default warehouse's catalog, which is
    * then put back. Safe in this module: its suites run one at a time.
    */
  private def whileCatalogUnavailable[T](body: => T): T = {
    val catalog = IcebergCatalogInstance.getInstance()
    IcebergCatalogInstance.replaceInstance(UnavailableCatalog)
    try body
    finally IcebergCatalogInstance.replaceInstance(catalog)
  }

  /**
    * A run of `logicalPlan` by `testUid`, on a unit that mounts under `unitMountRoot`, that goes
    * through `executeWorkflow` as production does: the plan is made, written to the fixture
    * execution's plan table and read back, and every service is built around it. Only the engine
    * is a `TestAmberClient`, so nothing starts.
    *
    * @param handPlan    makes the plan the run is handed in place of the one it makes, if given,
    *                    from the run's own compiler
    * @param settings    the settings the run's request asks for
    * @param replay      the replay log the run replays
    * @param replayLog   where the run writes its replay log
    * @param emails      whether the run's request asks for status emails
    * @param userEmail   the run's user's address, if known
    * @param storeInstead what the run stores, given the plan row it would store
    */
  private final class StubbedRun(
      logicalPlan: LogicalPlanPojo,
      handPlan: Option[WorkflowCompiler => PlanToRun] = None,
      settings: WorkflowSettings = WorkflowSettings(),
      replay: Option[ReplaySource] = None,
      replayLog: Option[URI] = None,
      emails: Boolean = false,
      userEmail: Option[String] = None,
      storeInstead: Option[PlanRecord => PlanRecord] = None
  ) {
    val errors: ListBuffer[Throwable] = ListBuffer.empty
    // the plan the run was handed, saved; the plan row it wrote; the workflow the engine was then
    // handed, the configuration its coordinator was given, and whether the plan table carried the
    // start claim by then
    var planToRun: Option[PlanToRun] = None
    var written: Option[PlanRecord] = None
    var engineWorkflow: Option[EngineWorkflow] = None
    var coordinatorConfig: Option[CoordinatorConfig] = None
    var startedBeforeEngine: Option[Boolean] = None
    val resultService =
      new ExecutionResultService(
        WorkflowIdentity(testWid.longValue()),
        testCuid,
        new WorkflowStateStore()
      )
    val service: WorkflowExecutionService = new WorkflowExecutionService(
      runContext(),
      resultService,
      WorkflowExecuteRequest(
        executionName = "test",
        engineVersion = "test",
        logicalPlan = logicalPlan,
        replayFromExecution = None,
        workflowSettings = settings,
        emailNotificationEnabled = emails,
        computingUnitId = testCuid,
        warehouseId = None
      ),
      new ExecutionStateStore(),
      errors += _,
      testUid,
      userEmail,
      sessionUri,
      replay,
      replayLog,
      mountRoot = Some(unitMountRoot)
    ) {
      override protected def makePlanToRun(compiler: WorkflowCompiler): PlanToRun = {
        val made = handPlan.fold(super.makePlanToRun(compiler))(_(compiler))
        planToRun = Some(made)
        made
      }

      override protected def writePlan(planTable: URI, record: PlanRecord): Unit = {
        val stored = storeInstead.fold(record)(_(record))
        written = Some(stored)
        super.writePlan(planTable, stored)
      }

      override protected def createAmberRuntime(
          workflow: EngineWorkflow,
          config: CoordinatorConfig
      ): AmberClient = {
        engineWorkflow = Some(workflow)
        coordinatorConfig = Some(config)
        startedBeforeEngine = planUri.map(ExecutionPlanStore.isStarted)
        new TestAmberClient
      }
    }

    /** The plan row in the run's plan table, as the lake now holds it. */
    def storedRow: PlanRecord =
      ExecutionPlanStore.readPlan(service.planUri.getOrElse(fail("the run stored no plan")))

    def close(): Unit = {
      service.unsubscribeAll()
      resultService.unsubscribeAll()
    }
  }

  private val udfId = "dataset-udf"

  private val udfCode =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    def process_tuple(self, tuple_, port):
      |        yield tuple_
      |""".stripMargin

  private def datasetParameter(value: String): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = value
    parameter
  }

  /** A Python UDF that reads the dataset version at `versionPath`. */
  private def datasetUdf(versionPath: String): PythonUDFOpDescV2 = {
    val udf = new PythonUDFOpDescV2
    udf.setOperatorId(udfId)
    udf.code = udfCode
    udf.retainInputColumns = true
    udf.uiParameters = List(datasetParameter(versionPath))
    udf
  }

  /** Lines of text into a Python UDF that reads the dataset version at `versionPath`. */
  private def datasetUdfPlan(versionPath: String): LogicalPlanPojo = {
    val text = new TextInputSourceOpDesc
    text.textInput = "a\nb"
    val udf = datasetUdf(versionPath)
    LogicalPlanPojo(
      List(text, udf),
      List(
        LogicalLink(text.operatorIdentifier, PortIdentity(), udf.operatorIdentifier, PortIdentity())
      ),
      List.empty,
      List.empty
    )
  }

  private def sourceOp(name: String): PhysicalOp =
    PhysicalOp.sourcePhysicalOp(
      PhysicalOpIdentity(OperatorIdentity(name), "main"),
      WorkflowIdentity(testWid.longValue()),
      ExecutionIdentity(testEid.longValue()),
      OpExecWithClassName("unused")
    )

  /** The context a run of the fixture execution starts with, before its request's settings. */
  private def runContext(): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(testWid.longValue()),
      executionId = ExecutionIdentity(testEid.longValue())
    )

  /** A lone text input, a workflow other than any request's below. */
  private def loneTextPlan(): LogicalPlanPojo = {
    val text = new TextInputSourceOpDesc
    text.setOperatorId("lone-text")
    text.textInput = "a"
    LogicalPlanPojo(List(text), List.empty, List.empty, List.empty)
  }

  /** A compiler for the run under `context` that resolves nothing but fixture files. */
  private def compilerFor(context: WorkflowContext): WorkflowCompiler =
    new WorkflowCompiler(
      context,
      TestOperators.fixtureFileResolver,
      RepositoryVersionResolver.Unavailable,
      Some(unitMountRoot)
    )

  /** A source whose one output port, of one string column, has its results stored. */
  private val storedSource: PhysicalOp =
    sourceOp("stored-text").copy(outputPorts =
      Map(
        PortIdentity() -> (
          OutputPort(),
          List.empty,
          Right(Schema().add("line", AttributeType.STRING))
        )
      )
    )

  /** The context a plan of `storedSource` alone is saved for in the readPlanToRun tests. */
  private def savedPlanContext(): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(testWid.longValue()),
      executionId = ExecutionIdentity(testEid.longValue()),
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 50,
        executionMode = ExecutionMode.PIPELINED,
        outputPortsNeedingStorage = Set(GlobalPortIdentity(storedSource.id, PortIdentity()))
      ),
      warehouse = Some("warehouse-1")
    )

  private def saved(context: WorkflowContext, plan: PhysicalPlan): String =
    saved(ExecutionPlan(context, plan))

  private def saved(executionPlan: ExecutionPlan): String =
    PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(executionPlan))

  /** `savedPlan`, handed to the engine with the logical plan of `loneTextPlan`. */
  private def handed(savedPlan: String): PlanToRun =
    PlanToRun(savedPlan, LogicalPlan(loneTextPlan()))

  /** The context of the run `savedPlanContext` saves for, as its request sets it up. */
  private def requestedContext(): WorkflowContext = {
    val run = savedPlanContext()
    // Only the plan knows the ports whose results are stored.
    run.workflowSettings = run.workflowSettings.copy(outputPortsNeedingStorage = Set.empty)
    run
  }

  /** Collects the events the logger named `loggerName` emits at `level` or above during `body`. */
  private def eventsLoggedAt(loggerName: String, level: Level)(body: => Any): Seq[ILoggingEvent] = {
    val logger = LoggerFactory.getLogger(loggerName).asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val previousLevel = logger.getLevel
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(level)
    try {
      body
      appender.list.asScala.toList
    } finally {
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  "WorkflowExecutionService" should
    "surface a recorded fatal error as a WorkflowErrorEvent via the metadata-store handler" in {
    val store = new ExecutionStateStore()
    buildService(store) // registers the diff handler at construction
    val events = collectEvents(store)

    val err =
      WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), "boom during init", "", "", "")
    store.metadataStore.updateState(_.addFatalErrors(err))

    val errorEvents = events.collect { case e: WorkflowErrorEvent => e }
    errorEvents should have size 1
    errorEvents.head.fatalErrors should contain(err)
    // The other half of the handler's contract: an update that moves only `fatalErrors` must not
    // also announce a state. `StateStore` filters out updates that change nothing at all, so the
    // guard's whole job is this case -- a write that moves some other field while `state` and
    // `isRecovering` stand still. Without it, recording an error also republishes a redundant
    // WorkflowStateEvent to the session.
    events.collect { case e: WorkflowStateEvent => e } shouldBe empty
  }

  it should "apply the request's workflow settings to the shared workflow context" in {
    // The one thing construction does besides wiring the handler, and it is not inert: the
    // context is what the compiler and the schedule generator read later, so a dropped assignment
    // silently runs every execution on WorkflowContext's defaults while the request's settings --
    // batch size, execution mode, and the output ports that need materialized storage -- are
    // ignored. The value has to be a non-default one, or the context's own default would answer.
    val settings = WorkflowSettings(dataTransferBatchSize = 137)
    val service = buildService(new ExecutionStateStore(), settings = settings)

    service.workflowContext.workflowSettings shouldBe settings
  }

  it should "report fatal errors recorded at successive phases through the same handler" in {
    val store = new ExecutionStateStore()
    // Mirror WorkflowService's real errorHandler, which records into the
    // metadata store. The service invokes this same handler at every phase
    // (compile, runtime creation, startWorkflow failure), so invoking it
    // repeatedly here stands in for failures arising at different phases.
    val recordError: Throwable => Unit = t =>
      store.metadataStore.updateState(metadataStore =>
        updateWorkflowState(FAILED, metadataStore).addFatalErrors(
          WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), t.toString, "", "", "")
        )
      )
    buildService(store, recordError)
    val events = collectEvents(store)

    recordError(new RuntimeException("init phase"))
    recordError(new RuntimeException("runtime phase"))

    val errorEvents = events.collect { case e: WorkflowErrorEvent => e }
    errorEvents should have size 2
    errorEvents.last.fatalErrors.map(_.message) should contain allOf (
      "java.lang.RuntimeException: init phase",
      "java.lang.RuntimeException: runtime phase"
    )
  }

  it should "emit a WorkflowStateEvent when the execution state changes" in {
    val store = new ExecutionStateStore()
    buildService(store)
    val events = collectEvents(store)

    store.metadataStore.updateState(_.withState(RUNNING))

    events.collect { case e: WorkflowStateEvent => e } should not be empty
    // The mirror of the assertion in the fatal-error test: a state-only update must not push an
    // empty WorkflowErrorEvent at the frontend. This is the suite's only update that leaves
    // `fatalErrors` alone, so it is the only place the errors guard can be observed suppressing.
    events.collect { case e: WorkflowErrorEvent => e } shouldBe empty
  }

  it should "report a recovering execution as Recovering instead of as its aggregated state" in {
    // Recovery is a banner the frontend keeps up over whatever the engine is otherwise doing:
    // the execution really is RUNNING throughout, and the three updates are kept apart so that the
    // recovery flag has to carry the second and third events on its own -- the aggregated state
    // does not move with it, and a handler that only watched `state` would go quiet exactly when
    // the banner needs to go up.
    //
    // The flag is driven in BOTH directions on purpose. Raising it is what a guard that merely
    // read `newState.isRecovering` would also do; only clearing it separates that from the
    // `!=` the guard actually needs, and a missing third event is the banner never coming down.
    val store = new ExecutionStateStore()
    buildService(store)
    val events = collectEvents(store)

    store.metadataStore.updateState(_.withState(RUNNING))
    store.metadataStore.updateState(_.withIsRecovering(true))
    store.metadataStore.updateState(_.withIsRecovering(false))

    events.collect { case e: WorkflowStateEvent => e } shouldBe
      Seq(
        WorkflowStateEvent("Running"),
        WorkflowStateEvent("Recovering"),
        WorkflowStateEvent("Running")
      )
  }

  it should "report the aggregated state of a completed execution still marked as recovering" in {
    // The recovery flag is not cleared on the way to COMPLETED, so without the COMPLETED
    // carve-out a finished execution would be announced as still recovering and the frontend
    // would never take the banner down.
    //
    // COMPLETED is the only sentinel this pins, and deliberately so. `createStateEvent`'s
    // carve-out lists exactly that one terminal state, so an execution that dies mid-recovery
    // (FAILED / KILLED with the flag still raised) is still announced as "Recovering" -- see the
    // note in the class header. Adding FAILED to the expectation here would cement that; adding
    // it to the guard is a production question, not this suite's to answer.
    val store = new ExecutionStateStore()
    buildService(store)
    val events = collectEvents(store)

    store.metadataStore.updateState(_.withState(COMPLETED).withIsRecovering(true))

    events.collect { case e: WorkflowStateEvent => e } shouldBe
      Seq(WorkflowStateEvent("Completed"))
  }

  it should "report a compilation failure and leave the workflow and the client unset" in {
    val store = new ExecutionStateStore()
    val errors = ListBuffer.empty[Throwable]
    val scan = new CSVScanSourceOpDesc()
    scan.setOperatorId("scan-op")
    val service = buildService(
      store,
      errors += _,
      LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)
    )

    // This is the assertion that pins the early `return`, and it has to wrap the call itself:
    // without the `return` the run falls through to `createAmberRuntime`, dereferences the still
    // null `workflow` on the way in, and throws out of `executeWorkflow` -- which is also what
    // keeps a "unit" test out of the live-runtime half on whatever actor system the shared JVM
    // holds.
    var setupFailure: Option[Throwable] = None
    noException should be thrownBy { setupFailure = service.executeWorkflow() }

    // The compilation failure is returned (not thrown) so the caller can record it on the
    // still-open setup span, on top of reaching the UI through errorHandler: one failure, which
    // names the operator with its error.
    val failure = setupFailure.getOrElse(fail("the run was set up"))
    failure shouldBe a[WorkflowCompilationFailed]
    failure.asInstanceOf[WorkflowCompilationFailed].operatorErrors.keySet shouldBe
      Set(OperatorIdentity("scan-op"))
    failure.getMessage shouldBe
      "The workflow does not compile: 1 operator has an error.\n" +
        s"scan-op: java.lang.RuntimeException: $noFileSelected"

    errors shouldBe Seq(failure)
    // Documentation, not a pin: both fields are still at their `_` defaults on this path, because
    // the only assignments to them sit after the throw and after the `return`. Neither assertion
    // can fail while those above hold -- they record the post-condition the early return leaves
    // behind, and they are the suite's only read of `workflow`.
    service.workflow shouldBe null
    service.client shouldBe null
  }

  it should "send one error event with every operator's compile error, each on its operator" in {
    val store = new ExecutionStateStore()
    // As WorkflowService's errorHandler records a failure no worker raised.
    val recordError: Throwable => Unit = t =>
      store.metadataStore.updateState(metadataStore =>
        updateWorkflowState(FAILED, metadataStore)
          .addAllFatalErrors(WorkflowService.fatalErrorsOf(t, "unknown operator", ""))
      )
    val scans = List("scan-a", "scan-b").map { id =>
      val scan = new CSVScanSourceOpDesc() // no file chosen
      scan.setOperatorId(id)
      scan
    }
    val service =
      buildService(store, recordError, LogicalPlanPojo(scans, List.empty, List.empty, List.empty))
    val events = collectEvents(store)

    service.executeWorkflow().getOrElse(fail("the run was set up")) shouldBe
      a[WorkflowCompilationFailed]

    // The errors the editing compile shows, in the workflow's order: each names its operator,
    // which the UI shows it on, and holds that operator's stack trace.
    val errorEvents = events.collect { case e: WorkflowErrorEvent => e }
    errorEvents should have size 1
    errorEvents.head.fatalErrors.map(error =>
      (error.`type`, error.operatorId, error.message)
    ) shouldBe
      Seq(
        (COMPILATION_ERROR, "scan-a", s"java.lang.RuntimeException: $noFileSelected"),
        (COMPILATION_ERROR, "scan-b", s"java.lang.RuntimeException: $noFileSelected")
      )
    all(errorEvents.head.fatalErrors.map(_.details)) should include("resolveScanSourceOpFileName")
  }

  it should "shut the client down and unsubscribe every runtime service on teardown" in {
    // The end of a websocket session. Everything the execution owns has to be let go here:
    // the engine client, and the four services that hold callbacks on it and diff handlers on
    // the shared state store. A survivor keeps publishing into a store nobody reads.
    //
    // What is asserted is the SET of teardown effects, not their order. `AmberClient.shutdown`
    // only flips a flag and posts a PoisonPill, so whether it runs before or after the four
    // unsubscribes changes only a race against the client actor's mailbox -- nothing a
    // deterministic test can observe, and not an order any contract here states.
    val store = new ExecutionStateStore()
    val service = buildService(store)
    val events = collectEvents(store)

    val client = new TestAmberClient
    val wsInput = new WebsocketInput(_ => ())
    // `workflow` is only dereferenced by the reconfiguration diff handler when a
    // reconfiguration actually completes, which is not what this test drives.
    val reconfigurationService =
      new ExecutionReconfigurationService(
        client,
        store,
        workflow = null,
        bindResources = Some(identity),
        planUri = ExecutionPlanStore.planUri(
          WorkflowIdentity(testWid.longValue()),
          ExecutionIdentity(testEid.longValue()),
          None
        ),
        creator = testUid,
        mountRoot = None
      )
    val statsService = new ExecutionStatsService(
      client,
      store,
      new WorkflowContext(
        workflowId = WorkflowIdentity(testWid.longValue()),
        executionId = ExecutionIdentity(testEid.longValue())
      )
    )
    val runtimeService = new ExecutionRuntimeService(
      client,
      store,
      wsInput,
      reconfigurationService,
      logConf = None,
      workflowId = testWid.longValue(),
      notification = None
    )
    val consoleService = new ExecutionConsoleService(client, store, wsInput, new WorkflowContext())

    service.client = client
    service.executionReconfigurationService = reconfigurationService
    service.executionStatsService = statsService
    service.executionRuntimeService = runtimeService
    service.executionConsoleService = consoleService

    // One tracker per manager, so a teardown call that goes missing names its own service.
    val ownTracker = new Tracker
    val reconfigurationTracker = new Tracker
    val statsTracker = new Tracker
    val runtimeTracker = new Tracker
    val consoleTracker = new Tracker
    service.addSubscription(ownTracker.disposable)
    reconfigurationService.addSubscription(reconfigurationTracker.disposable)
    statsService.addSubscription(statsTracker.disposable)
    runtimeService.addSubscription(runtimeTracker.disposable)
    consoleService.addSubscription(consoleTracker.disposable)

    service.unsubscribeAll()

    withClue("the engine client: ") { client.shutdownCount shouldBe 1 }
    withClue("the execution's own subscriptions: ") { ownTracker.disposed shouldBe true }
    withClue("executionRuntimeService: ") { runtimeTracker.disposed shouldBe true }
    withClue("executionConsoleService: ") { consoleTracker.disposed shouldBe true }
    withClue("executionStatsService: ") { statsTracker.disposed shouldBe true }
    withClue("executionReconfigurationService: ") {
      reconfigurationTracker.disposed shouldBe true
    }

    // The constructor-registered diff handler is part of "its own subscriptions": after teardown
    // the store is inert, which is what stops a closed session from still producing websocket
    // events for its (now disconnected) client.
    events.clear()
    store.metadataStore.updateState(_.withState(RUNNING))
    events shouldBe empty
  }

  it should "leave a never-started execution alone on teardown" in {
    // `unsubscribeAll` also runs for an execution that failed to compile, where the client and all
    // four service fields are still null: teardown of that execution must not throw, and its own
    // subscriptions must still be let go.
    //
    // Which field the guard reads is NOT observed here, and cannot honestly be. The two states
    // that would separate the five candidates are (client set, services null) -- whose current
    // behaviour is an NPE, so pinning it would cement the partial-construction defect noted in the
    // class header -- and (client null, services set), which the assignment order in
    // `executeWorkflow` makes unreachable.
    val store = new ExecutionStateStore()
    val service = buildService(store)
    val events = collectEvents(store)
    val ownTracker = new Tracker
    service.addSubscription(ownTracker.disposable)

    noException should be thrownBy service.unsubscribeAll()

    ownTracker.disposed shouldBe true
    events.clear()
    store.metadataStore.updateState(_.withState(RUNNING))
    events shouldBe empty
  }

  it should "make the run's plan as its user, refusing a dataset they cannot read before it starts" in {
    val run = new StubbedRun(datasetUdfPlan(unreadableVersionPath))
    try {
      val setupFailure = run.service.executeWorkflow()

      // The read check's refusal, which reads as if the version did not exist: the error of the
      // UDF that names it, reported like any other compile failure, with no engine built.
      val failure = setupFailure.getOrElse(fail("the run was set up"))
      failure shouldBe a[WorkflowCompilationFailed]
      val operatorErrors = failure.asInstanceOf[WorkflowCompilationFailed].operatorErrors
      operatorErrors.keySet shouldBe Set(OperatorIdentity(udfId))
      operatorErrors(OperatorIdentity(udfId)).message should startWith(
        s"${classOf[FileNotFoundException].getName}: "
      )
      operatorErrors(OperatorIdentity(udfId)).message should include(unreadableVersionPath)
      failure.getMessage should include(s"$udfId: ${classOf[FileNotFoundException].getName}: ")
      run.errors shouldBe Seq(failure)
      run.service.workflow shouldBe null
      run.service.client shouldBe null
    } finally run.close()
  }

  it should "make the run's plan as its user and for this unit, and bind a paused edit the same way" in {
    val run = new StubbedRun(datasetUdfPlan(readableVersionPath))
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty

      // The engine was handed only data: the final code, reading the version where this unit
      // mounts it, and the repository to mount there.
      val udf = run.service.workflow.physicalPlan
        .getPhysicalOpsOfLogicalOp(OperatorIdentity(udfId))
        .head
      udf.resourceBinding shouldBe None
      udf.repositoryMounts shouldBe Some(
        RepositoryMounts(unitMountRoot.toString, Set(readableLocator))
      )
      udf.opExecInitInfo shouldBe OpExecWithCode(
        PythonUdfUiParameterInjector.inject(
          udfCode,
          List(datasetParameter(unitMountRoot.resolve("dataset-9221").resolve("5ha7ed01").toString))
        ),
        "python"
      )

      // An edit made while the run is paused is bound by the same compiler: for the same user,
      // so a version they cannot read refuses it, and under the same root.
      val reconfiguration = run.service.executionReconfigurationService
      reconfiguration.modifyOperatorLogic(
        ModifyLogicRequest(datasetUdf(unreadableVersionPath))
      ) match {
        case refused: ModifyLogicResponse =>
          refused.isValid shouldBe false
          refused.errorMessage should include(unreadableVersionPath)
        case other => fail(s"expected a ModifyLogicResponse, got $other")
      }
      reconfiguration.modifyOperatorLogic(
        ModifyLogicRequest(datasetUdf(readableVersionPath))
      ) shouldBe ModifyLogicResponse(udfId, isValid = true, "")
      val queued =
        run.service.executionStateStore.reconfigurationStore.getState.unscheduledReconfigurations
          .map(_._1)
      queued.map(op => (op.opExecInitInfo, op.repositoryMounts, op.resourceBinding)) shouldBe
        List((udf.opExecInitInfo, udf.repositoryMounts, None))
    } finally run.close()
  }

  it should "hand the engine, and the services built around the run, the plan read back from the plan table it saved it to" in {
    val run = new StubbedRun(datasetUdfPlan(readableVersionPath))
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      val planToRun = run.planToRun.getOrElse(fail("no plan was made"))
      val engineWorkflow = run.engineWorkflow.getOrElse(fail("the engine was handed no workflow"))

      // The saved plan is the body of the plan row in the execution's plan table.
      run.service.planUri shouldBe Some(
        ExecutionPlanStore.planUri(
          WorkflowIdentity(testWid.longValue()),
          ExecutionIdentity(testEid.longValue()),
          None
        )
      )
      run.storedRow.body shouldBe planToRun.savedPlan
      val executionPlan =
        PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(run.storedRow.body))
      val planContext = executionPlan.context
      engineWorkflow.physicalPlan shouldBe executionPlan.plan
      // Read back, not compiled: no operator keeps the schema function its compile gave it, which
      // the saved text does not hold.
      engineWorkflow.physicalPlan.operators.map(_.propagateSchema) shouldBe
        Set(PhysicalPlanCodec.ReadBackSchemaPropagation)
      // Every service is built around that same workflow, under the run's own context, whose
      // settings, stored results included, are the ones the plan was saved with.
      run.service.workflow should be theSameInstanceAs engineWorkflow
      engineWorkflow.context should be theSameInstanceAs run.service.workflowContext
      engineWorkflow.logicalPlan should be theSameInstanceAs planToRun.logicalPlan
      planContext.workflowSettings shouldBe run.service.workflowContext.workflowSettings
      planContext.workflowSettings.outputPortsNeedingStorage should not be empty
    } finally run.close()
  }

  it should "run the plan it is handed, not one compiled again from its request" in {
    val run = new StubbedRun(
      datasetUdfPlan(readableVersionPath),
      handPlan = Some(compiler => PlanToRun.make(compiler, loneTextPlan()))
    )
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      run.engineWorkflow.map(_.physicalPlan.operators.map(_.id.logicalOpId)) shouldBe
        Some(Set(OperatorIdentity("lone-text")))
      run.service.workflow.logicalPlan.getTerminalOperatorIds shouldBe
        List(OperatorIdentity("lone-text"))
    } finally run.close()
  }

  it should "run under the settings saved with the plan it is handed, made under a context of its own" in {
    // As a plan made elsewhere would be, by the Dashboard service say: for the run's ids, under a
    // context the run does not share.
    val makerContext = runContext()
    val run = new StubbedRun(
      datasetUdfPlan(readableVersionPath),
      handPlan = Some(_ => PlanToRun.make(compilerFor(makerContext), loneTextPlan()))
    )
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      val planToRun = run.planToRun.getOrElse(fail("no plan was handed"))
      val planContext =
        PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(planToRun.savedPlan)).context
      val storedPorts = planContext.workflowSettings.outputPortsNeedingStorage
      storedPorts.map(_.opId.logicalOpId) shouldBe Set(OperatorIdentity("lone-text"))

      // The engine runs under the run's own context, which took the saved settings, stored ports
      // included, as only the plan knows them...
      val engineWorkflow = run.engineWorkflow.getOrElse(fail("the engine was handed no workflow"))
      engineWorkflow.context should be theSameInstanceAs run.service.workflowContext
      engineWorkflow.context.workflowSettings shouldBe planContext.workflowSettings
      // ...and making the plan left the context it was made under as it was.
      makerContext.workflowSettings shouldBe WorkflowSettings()
    } finally run.close()
  }

  it should "refuse a plan saved for another run before it builds the engine" in {
    val otherExecution = testEid.longValue() + 100
    val run = new StubbedRun(
      datasetUdfPlan(readableVersionPath),
      handPlan = Some { _ =>
        val otherRun = runContext()
        otherRun.executionId = ExecutionIdentity(otherExecution)
        PlanToRun.make(compilerFor(otherRun), loneTextPlan())
      }
    )
    try {
      val failure = run.service.executeWorkflow().getOrElse(fail("the run was set up"))

      failure shouldBe an[IllegalStateException]
      failure.getMessage should include(s"its execution is $otherExecution, the run's is $testEid")
      run.errors shouldBe Seq(failure)
      run.engineWorkflow shouldBe None
      run.service.workflow shouldBe null
      run.service.client shouldBe null
      // The refused plan's settings were not taken.
      run.service.workflowContext.workflowSettings shouldBe WorkflowSettings()
    } finally run.close()
  }

  it should "refuse a run whose batches hold no tuple, naming the editor's setting, before it starts" in {
    // The editor asks for at least 1; a request made otherwise used to run with batches of one.
    val run = new StubbedRun(loneTextPlan(), settings = WorkflowSettings(dataTransferBatchSize = 0))
    try {
      val failure = run.service.executeWorkflow().getOrElse(fail("the run was set up"))

      failure shouldBe an[IllegalArgumentException]
      failure.getMessage shouldBe
        "The workflow's Data Transfer Batch Size is 0; set it to 1 or more."
      run.errors shouldBe Seq(failure)
      run.planToRun shouldBe None
      run.written shouldBe None
      run.service.planUri shouldBe None
      run.engineWorkflow shouldBe None
      run.service.workflow shouldBe null
    } finally run.close()
  }

  it should "refuse a saved plan it cannot read before it builds the engine" in {
    val run = new StubbedRun(
      datasetUdfPlan(readableVersionPath),
      handPlan = Some(_ => handed("not a plan"))
    )
    try {
      val failure = run.service.executeWorkflow().getOrElse(fail("the run was set up"))

      failure shouldBe an[IllegalArgumentException]
      failure.getMessage should include("not JSON")
      run.errors shouldBe Seq(failure)
      run.engineWorkflow shouldBe None
      run.service.workflow shouldBe null
    } finally run.close()
  }

  it should "store the run's plan row: its plan, the plan its request sent, its user and its unit" in {
    // A scan whose file the compile resolves in place, as it resolves every scan's.
    val scan = new CSVScanSourceOpDesc()
    scan.setOperatorId("sent-scan")
    scan.fileName = Some(TestOperators.CountrySalesSmallCsvPath)
    scan.customDelimiter = Some(",")
    scan.hasHeader = true
    val sent = LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)
    // As the request sent it, but for each operator's loop-variable sidecar, which the row leaves
    // out (the references it records are written in place; the scan has none).
    val asSent = objectMapper.readTree(objectMapper.writeValueAsString(sent))
    asSent
      .get("operators")
      .elements()
      .asScala
      .foreach(_.asInstanceOf[ObjectNode].remove("stateReferences"))
    val run = new StubbedRun(
      sent,
      // The request's own plan, compiled where the scan's file can be found.
      handPlan = Some(_ => PlanToRun.make(compilerFor(runContext()), sent))
    )
    try {
      val before = System.currentTimeMillis()
      run.service.executeWorkflow() shouldBe None
      val after = System.currentTimeMillis()
      run.errors shouldBe empty

      val row = run.storedRow
      row.entryId shouldBe ExecutionPlanStore.PlanEntryId
      row.kind shouldBe ExecutionPlanStore.PlanKind
      row.formatVersion shouldBe PhysicalPlanCodec.FormatVersion
      row.body shouldBe run.planToRun.map(_.savedPlan).getOrElse(fail("no plan was made"))
      row.createdAt.getTime should (be >= before and be <= after)
      row.createdBy shouldBe testUid.intValue()
      // The unit the run's request names, which the execution's row names too.
      row.computingUnitId shouldBe testCuid.intValue()
      row.notification shouldBe None
      // The plan as the request sent it, not as the compile left it.
      scan.fileName.getOrElse(fail("the scan lost its file")) should startWith("file:")
      objectMapper.readTree(row.logical) shouldBe asSent
      row.logical should include(TestOperators.CountrySalesSmallCsvPath)
      run.written shouldBe Some(row)
    } finally run.close()
  }

  it should "store where the run's status emails go when its request asks for them, and send them there" in {
    val email = s"u$testUid@example.com"
    val notification = Notification(email, s"workflow-execution-test-$testWid", workflowPage)
    Seq(
      (true, Some(email)) -> Some(notification),
      // The user's address is not known.
      (true, None) -> None,
      // The request asks for no emails.
      (false, Some(email)) -> None
    ).foreach {
      case ((emails, userEmail), expected) =>
        withClue(s"emails asked for: $emails, the user's address: $userEmail: ") {
          val run = new StubbedRun(loneTextPlan(), emails = emails, userEmail = userEmail)
          try {
            run.service.executeWorkflow() shouldBe None
            run.errors shouldBe empty
            run.storedRow.notification shouldBe expected.map(_ =>
              s"""{"email":"$email","workflowName":"workflow-execution-test-$testWid",""" +
                s""""workflowUrl":"$workflowPage"}"""
            )
            run.service.executionRuntimeService.notification shouldBe expected
          } finally run.close()
        }
    }
  }

  it should "run the plan row it reads back from the plan table, not the one it wrote" in {
    // Another plan for the run, of another workflow, and another notification, stored in place of
    // the run's own: the run takes both from the lake.
    val otherPlan = PlanToRun.make(compilerFor(runContext()), loneTextPlan()).savedPlan
    val otherNotification =
      Notification("someone@example.com", "another workflow", "http://elsewhere/user/workspace/1")
    val run = new StubbedRun(
      datasetUdfPlan(readableVersionPath),
      storeInstead = Some(
        _.copy(body = otherPlan, notification = Some(Notification.toJson(otherNotification)))
      )
    )
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      run.planToRun.map(_.savedPlan) should not be Some(otherPlan)
      run.engineWorkflow.map(_.physicalPlan.operators.map(_.id.logicalOpId)) shouldBe
        Some(Set(OperatorIdentity("lone-text")))
      run.service.executionRuntimeService.notification shouldBe Some(otherNotification)
    } finally run.close()
  }

  it should "claim the execution's one start in its plan table before it builds the engine" in {
    val run = new StubbedRun(loneTextPlan())
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      run.startedBeforeEngine shouldBe Some(true)
      val planUri = run.service.planUri.getOrElse(fail("the run stored no plan"))
      ExecutionPlanStore.isStarted(planUri) shouldBe true
      // so a second start of the execution is refused
      an[ExecutionAlreadyStartedException] should be thrownBy ExecutionPlanStore.claimStart(planUri)
    } finally run.close()
  }

  it should "save the run's replay and replay log with its plan, and start its coordinator with them" in {
    val run = new StubbedRun(
      loneTextPlan(),
      replay = Some(replaySource),
      replayLog = Some(replayLogLocation)
    )
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      val stored = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(run.storedRow.body))
      stored.replay shouldBe Some(replaySource)
      stored.replayLog shouldBe Some(replayLogLocation)

      val config = run.coordinatorConfig.getOrElse(fail("the engine was not built"))
      config.stateRestoreConfOpt shouldBe Some(
        StateRestoreConfig(
          replaySource.logLocation,
          EmbeddedControlMessageIdentity("interaction-7")
        )
      )
      config.faultToleranceConfOpt shouldBe Some(FaultToleranceConfig(replayLogLocation))
      // The run checkpoints into its replay log: a checkpoint request is taken.
      run.service.wsInput.onNext(WorkflowCheckpointRequest(), None)
      run.errors shouldBe empty
    } finally run.close()
  }

  it should "take the replay and replay log from the plan it reads back, not from its request" in {
    // A plan that replays and writes a replay log, stored in place of the run's, which does neither.
    val replaying = PlanToRun
      .make(
        compilerFor(runContext()),
        loneTextPlan(),
        Some(replaySource),
        Some(replayLogLocation)
      )
      .savedPlan
    val run = new StubbedRun(loneTextPlan(), storeInstead = Some(_.copy(body = replaying)))
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      val config = run.coordinatorConfig.getOrElse(fail("the engine was not built"))
      config.stateRestoreConfOpt shouldBe Some(
        StateRestoreConfig(
          replaySource.logLocation,
          EmbeddedControlMessageIdentity("interaction-7")
        )
      )
      config.faultToleranceConfOpt shouldBe Some(FaultToleranceConfig(replayLogLocation))
    } finally run.close()
  }

  it should "start a run that replays nothing and writes no replay log with neither" in {
    val run = new StubbedRun(loneTextPlan())
    try {
      run.service.executeWorkflow() shouldBe None
      run.errors shouldBe empty
      val config = run.coordinatorConfig.getOrElse(fail("the engine was not built"))
      config.stateRestoreConfOpt shouldBe None
      config.faultToleranceConfOpt shouldBe None
      // So it cannot checkpoint: a checkpoint request is refused.
      run.service.wsInput.onNext(WorkflowCheckpointRequest(), None)
      run.errors.map(_.getMessage) should have size 1
      run.errors.head.getMessage should include("Fault tolerance log folder is not established")
    } finally run.close()
  }

  it should "fail the run through its error handler when its plan cannot be written, before it builds the engine" in {
    val run = new StubbedRun(loneTextPlan())
    try {
      val failure = whileCatalogUnavailable {
        run.service.executeWorkflow().getOrElse(fail("the run was set up"))
      }

      failure shouldBe a[ServiceUnavailableException]
      run.errors shouldBe Seq(failure)
      run.service.planUri shouldBe None
      run.engineWorkflow shouldBe None
      run.service.workflow shouldBe null
      run.service.client shouldBe null
    } finally run.close()
  }

  it should "refuse a plan row whose notification it cannot read, before it builds the engine" in {
    val run = new StubbedRun(
      loneTextPlan(),
      storeInstead = Some(_.copy(notification = Some("""{"email":"someone@example.com"}""")))
    )
    try {
      val failure = run.service.executeWorkflow().getOrElse(fail("the run was set up"))

      failure shouldBe an[IllegalArgumentException]
      failure.getMessage shouldBe
        "The execution's notification is not {email, workflowName, workflowUrl}: " +
          "workflowName, workflowUrl missing or not a string."
      run.errors shouldBe Seq(failure)
      run.engineWorkflow shouldBe None
      run.service.workflow shouldBe null
    } finally run.close()
  }

  it should "keep the state a run ended in when its start is answered after that" in {
    def answerStart(run: StubbedRun): Unit =
      run.service.client
        .asInstanceOf[TestAmberClient]
        .answers("startWorkflow")
        .setValue(StartWorkflowResponse(RUNNING))
    // A run killed, superseded or ended otherwise before the engine answered its start.
    Seq(KILLED, COMPLETED, FAILED, TERMINATED).foreach { ended =>
      withClue(s"a run that is $ended: ") {
        val run = new StubbedRun(loneTextPlan())
        try {
          run.service.executeWorkflow() shouldBe None
          run.service.executionStateStore.metadataStore.updateState(_.withState(ended))

          answerStart(run)

          run.service.executionStateStore.metadataStore.getState.state shouldBe ended
        } finally run.close()
      }
    }
    // A run still starting takes the state the answer gives.
    val run = new StubbedRun(loneTextPlan())
    try {
      run.service.executeWorkflow() shouldBe None
      run.service.executionStateStore.metadataStore.getState.state shouldBe READY
      answerStart(run)
      run.service.executionStateStore.metadataStore.getState.state shouldBe RUNNING
    } finally run.close()
  }

  /**
    * A run of a plan the Dashboard made, built as a computing unit builds one to start it by id:
    * on the context the plan was read back with, for this unit, with no compiler. As in
    * `StubbedRun`, only the engine is a `TestAmberClient`, so nothing starts.
    */
  private final class StoredRun(executionPlan: ExecutionPlan) {
    val errors: ListBuffer[Throwable] = ListBuffer.empty
    var engineWorkflow: Option[EngineWorkflow] = None
    var coordinatorConfig: Option[CoordinatorConfig] = None
    // the engine the run was given; `client` would name the service's own field below
    var engine: Option[TestAmberClient] = None
    val resultService =
      new ExecutionResultService(
        WorkflowIdentity(testWid.longValue()),
        testCuid,
        new WorkflowStateStore()
      )
    val store = new ExecutionStateStore()
    store.metadataStore.updateState(_.withExecutionId(executionPlan.context.executionId))
    val service: WorkflowExecutionService = new WorkflowExecutionService(
      executionPlan.context,
      resultService,
      store,
      errors += _,
      Some(unitMountRoot)
    ) {
      override protected def createAmberRuntime(
          workflow: EngineWorkflow,
          config: CoordinatorConfig
      ): AmberClient = {
        engineWorkflow = Some(workflow)
        coordinatorConfig = Some(config)
        val built = new TestAmberClient
        engine = Some(built)
        built
      }
    }

    def close(): Unit = {
      service.unsubscribeAll()
      resultService.unsubscribeAll()
    }
  }

  /** `executionPlan`'s plan row, as the Dashboard writes it for `testUid` on `testCuid`. */
  private def planRowOf(
      executionPlan: ExecutionPlan,
      notification: Option[String] = None
  ): PlanRecord =
    PlanRecord(
      entryId = ExecutionPlanStore.PlanEntryId,
      kind = ExecutionPlanStore.PlanKind,
      formatVersion = PhysicalPlanCodec.FormatVersion,
      body = PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(executionPlan)),
      logical = "{}",
      createdAt = new SqlTimestamp(System.currentTimeMillis()),
      createdBy = testUid,
      computingUnitId = testCuid,
      notification = notification
    )

  /** `executionPlan` read back from its plan row, as a unit reads it, given the unit's id. */
  private def readBack(executionPlan: ExecutionPlan): ExecutionPlan = {
    val plan = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(planRowOf(executionPlan).body))
    plan.context.cuid = Some(testCuid)
    plan
  }

  private val storedPlanTable =
    ExecutionPlanStore.planUri(
      WorkflowIdentity(testWid.longValue()),
      ExecutionIdentity(testEid.longValue()),
      None
    )

  /** The context the Dashboard saves a plan of `storedSource` under, in the default warehouse. */
  private def dashboardPlanContext(): WorkflowContext = {
    val context = savedPlanContext()
    context.warehouse = None
    context
  }

  "WorkflowExecutionService.startStored" should
    "build the engine and every service around the run on the plan it is handed, and make the run READY" in {
    val notification = Notification("u@example.com", "the workflow", workflowPage)
    val executionPlan = readBack(
      ExecutionPlan(
        dashboardPlanContext(),
        PhysicalPlan(Set(storedSource), Set.empty),
        replay = Some(replaySource),
        replayLog = Some(replayLogLocation)
      )
    )
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(
        executionPlan,
        planRowOf(executionPlan, Some(Notification.toJson(notification))),
        storedPlanTable
      ) shouldBe None
      run.errors shouldBe empty

      // The engine is handed the plan as it was handed to the run, under its context: the one it
      // was read back with, naming this unit.
      val engineWorkflow = run.engineWorkflow.getOrElse(fail("the engine was handed no workflow"))
      engineWorkflow.physicalPlan should be theSameInstanceAs executionPlan.plan
      engineWorkflow.context should be theSameInstanceAs executionPlan.context
      engineWorkflow.context.cuid shouldBe Some(testCuid)
      run.coordinatorConfig shouldBe Some(
        WorkflowExecutionService.coordinatorConfigOf(executionPlan)
      )
      run.service.planUri shouldBe Some(storedPlanTable)
      // Its status emails go where the plan row says.
      run.service.executionRuntimeService.notification shouldBe Some(notification)
      // Every service is built, the run is READY, and the engine was asked to start.
      run.service.executionStatsService should not be null
      run.service.executionConsoleService should not be null
      run.store.metadataStore.getState.state shouldBe READY
      run.engine.getOrElse(fail("no engine")).answers.keySet should contain("startWorkflow")

      // No compiler here: an operator changes only by the changes the Dashboard stored.
      val limit = new LimitOpDesc
      limit.setOperatorId("stored-text")
      run.service.executionReconfigurationService.modifyOperatorLogic(
        ModifyLogicRequest(limit)
      ) shouldBe ModifyLogicResponse(
        "stored-text",
        isValid = false,
        s"Execution $testEid runs the plan the Dashboard made for it: change its operators " +
          "through the Dashboard."
      )
      run.store.reconfigurationStore.getState.unscheduledReconfigurations shouldBe empty
    } finally run.close()
  }

  it should "refuse a plan this unit cannot run, through the error handler, before it builds the engine" in {
    val mounting = storedSource.copy(repositoryMounts =
      Some(RepositoryMounts("/mnt/another-root", Set(readableLocator)))
    )
    val readingInputs = ExecutionPlan(
      dashboardPlanContext(),
      PhysicalPlan(Set(storedSource), Set.empty),
      inputs = Seq(
        PlanInput(OperatorIdentity("stored-text"), "lines.csv", InputFile(Long.MaxValue, 3))
      )
    )
    Seq(
      readBack(ExecutionPlan(dashboardPlanContext(), PhysicalPlan(Set(mounting), Set.empty))) ->
        "under /mnt/another-root",
      readBack(readingInputs) -> "reads 1 input from outside the run"
    ).foreach {
      case (executionPlan, why) =>
        withClue(s"$why: ") {
          val run = new StoredRun(executionPlan)
          try {
            val failure = run.service
              .startStored(executionPlan, planRowOf(executionPlan), storedPlanTable)
              .getOrElse(fail("the run started"))
            failure shouldBe an[IllegalStateException]
            failure.getMessage should include(why)
            run.errors shouldBe Seq(failure)
            run.engineWorkflow shouldBe None
            run.service.workflow shouldBe null
            run.service.client shouldBe null
          } finally run.close()
        }
    }
  }

  it should "refuse a plan row whose notification it cannot read, before it builds the engine" in {
    val executionPlan =
      readBack(ExecutionPlan(dashboardPlanContext(), PhysicalPlan(Set(storedSource), Set.empty)))
    val run = new StoredRun(executionPlan)
    try {
      val failure = run.service
        .startStored(
          executionPlan,
          planRowOf(executionPlan, Some("""{"email": 1}""")),
          storedPlanTable
        )
        .getOrElse(fail("the run started"))
      failure shouldBe an[IllegalArgumentException]
      run.errors shouldBe Seq(failure)
      run.engineWorkflow shouldBe None
    } finally run.close()
  }

  it should "make no plan of its own for a run of a stored plan" in {
    val executionPlan =
      readBack(ExecutionPlan(dashboardPlanContext(), PhysicalPlan(Set(storedSource), Set.empty)))
    val run = new StoredRun(executionPlan)
    try {
      the[IllegalStateException] thrownBy run.service.executeWorkflow() should have message
        s"Execution $testEid runs the plan the Dashboard made for it: this unit makes no plan for it."
      run.errors shouldBe empty
    } finally run.close()
  }

  it should "check a change the Dashboard stored against this unit's mount root, as it checks the plan" in {
    val executionPlan =
      readBack(ExecutionPlan(dashboardPlanContext(), PhysicalPlan(Set(storedSource), Set.empty)))
    val record = planRowOf(executionPlan)
    // The plan table, holding the plan row and the changes, in the catalog the build's tests use.
    ExecutionPlanStore.writePlan(storedPlanTable, record)
    def storedChange(mountRoot: String): String = {
      val updateId = s"update-${UUID.randomUUID()}"
      val changed = storedSource.copy(
        opExecInitInfo = OpExecWithClassName("changed"),
        repositoryMounts = Some(RepositoryMounts(mountRoot, Set(readableLocator)))
      )
      ExecutionPlanStore.appendUpdate(
        storedPlanTable,
        PlanRecord(
          entryId = updateId,
          kind = ExecutionPlanStore.UpdateKind,
          formatVersion = PhysicalPlanCodec.FormatVersion,
          body = PhysicalPlanCodec.updateToJson(
            PhysicalPlanCodec
              .encodeUpdate(ExecutionIdentity(testEid.longValue()), updateId, changed)
          ),
          logical = "{}",
          createdAt = new SqlTimestamp(System.currentTimeMillis()),
          createdBy = testUid,
          computingUnitId = testCuid,
          notification = None
        )
      )
      updateId
    }
    val run = new StoredRun(executionPlan)
    try {
      run.service.startStored(executionPlan, record, storedPlanTable) shouldBe None
      val reconfiguration = run.service.executionReconfigurationService
      val creator = Some(testUid.intValue())

      reconfiguration
        .applyStoredUpdate(storedChange(unitMountRoot.toString), creator)
        .isValid shouldBe true
      val elsewhere = reconfiguration.applyStoredUpdate(storedChange("/mnt/another-root"), creator)
      elsewhere.isValid shouldBe false
      elsewhere.errorMessage should include("under /mnt/another-root")
      elsewhere.errorMessage should include(s"mounts them under $unitMountRoot")
      run.store.reconfigurationStore.getState.unscheduledReconfigurations should have size 1
    } finally run.close()
  }

  "WorkflowExecutionService.readPlanToRun" should
    "read back the plan saved for the run, which runs under its saved settings, whatever computing unit the run is on" in {
    val plan = PhysicalPlan(Set(storedSource), Set.empty)
    val savedPlan = saved(savedPlanContext(), plan)
    val run = requestedContext()
    run.cuid = Some(testCuid)

    val executionPlan = WorkflowExecutionService.readPlanToRun(savedPlan, run, Some(unitMountRoot))

    executionPlan.plan shouldBe PhysicalPlanCodec
      .decode(PhysicalPlanCodec.fromJson(savedPlan))
      .plan
    executionPlan.replay shouldBe None
    executionPlan.replayLog shouldBe None
    executionPlan.inputs shouldBe empty
    // Read back with the context it was saved under, which names no unit...
    executionPlan.context should not be theSameInstanceAs(run)
    executionPlan.context.cuid shouldBe None
    // ...while the run's own context takes the saved settings, the ports whose results are stored
    // included, and keeps its computing unit.
    run.workflowSettings shouldBe savedPlanContext().workflowSettings
    run.workflowSettings.outputPortsNeedingStorage.toList shouldBe
      savedPlanContext().workflowSettings.outputPortsNeedingStorage.toList
    run.cuid shouldBe Some(testCuid)
    run.costHints shouldBe None
  }

  it should "run under the cost hints saved with the plan, in place of any the run had" in {
    val hints = CostHints(ExecutionIdentity(testEid.longValue() - 1), Map("stored-text" -> 4.5))
    val planContext = savedPlanContext()
    planContext.costHints = Some(hints)
    val savedPlan = saved(planContext, PhysicalPlan(Set(storedSource), Set.empty))
    Seq(None, Some(CostHints(ExecutionIdentity(1), Map("other" -> 1.0)))).foreach { before =>
      withClue(s"the run's own hints were $before: ") {
        val run = requestedContext()
        run.costHints = before

        WorkflowExecutionService.readPlanToRun(savedPlan, run, Some(unitMountRoot))

        run.costHints shouldBe Some(hints)
      }
    }
    // and a plan saved with none leaves the run with none
    val run = requestedContext()
    run.costHints = Some(hints)
    WorkflowExecutionService.readPlanToRun(
      saved(savedPlanContext(), PhysicalPlan(Set(storedSource), Set.empty)),
      run,
      Some(unitMountRoot)
    )
    run.costHints shouldBe None
  }

  it should "refuse a plan saved for another run, naming what differs, and leave the run's context alone" in {
    val planContext = savedPlanContext()
    planContext.costHints = Some(CostHints(ExecutionIdentity(1), Map("stored-text" -> 1.0)))
    val savedPlan = saved(planContext, PhysicalPlan(Set(storedSource), Set.empty))
    val nextWid = testWid.longValue() + 1
    val nextEid = testEid.longValue() + 1
    val differences: Seq[(WorkflowContext => Unit, String)] = Seq(
      (
        _.workflowId = WorkflowIdentity(nextWid),
        s"its workflow is $testWid, the run's is $nextWid"
      ),
      (
        _.executionId = ExecutionIdentity(nextEid),
        s"its execution is $testEid, the run's is $nextEid"
      ),
      (
        run => run.workflowSettings = run.workflowSettings.copy(dataTransferBatchSize = 51),
        "its data transfer batch size is 50, the run's is 51"
      ),
      (
        run =>
          run.workflowSettings =
            run.workflowSettings.copy(executionMode = ExecutionMode.MATERIALIZED),
        "its execution mode is PIPELINED, the run's is MATERIALIZED"
      ),
      (_.warehouse = None, "its warehouse is warehouse-1, the run's is the default one")
    )
    for ((change, difference) <- differences) {
      val run = requestedContext()
      change(run)
      val settings = run.workflowSettings
      withClue(s"$difference: ") {
        val failure = the[IllegalStateException] thrownBy
          WorkflowExecutionService.readPlanToRun(savedPlan, run, Some(unitMountRoot))
        failure.getMessage shouldBe
          s"The plan handed to execution ${run.executionId.id} is not its own: $difference."
        run.workflowSettings shouldBe settings
        run.costHints shouldBe None
      }
    }
  }

  it should "refuse text that is not a saved plan" in {
    val run = requestedContext()
    val failure = the[IllegalArgumentException] thrownBy
      WorkflowExecutionService.readPlanToRun("{}", run, Some(unitMountRoot))
    failure.getMessage should include("format version")
    run.workflowSettings shouldBe requestedContext().workflowSettings
  }

  it should "refuse a plan this unit cannot run, whose code reads datasets under another root, and leave the run's context alone" in {
    // The source whose results are stored, its code reading a dataset under another root; saved
    // with settings that store its results, which the run's lack, and with cost hints.
    val mounting = storedSource.copy(
      repositoryMounts = Some(RepositoryMounts("/plan/root", Set(readableLocator)))
    )
    val planContext = savedPlanContext()
    planContext.costHints = Some(CostHints(ExecutionIdentity(1), Map("stored-text" -> 1.0)))
    val savedPlan = saved(planContext, PhysicalPlan(Set(mounting), Set.empty))
    val run = requestedContext()

    val failure = the[IllegalStateException] thrownBy
      WorkflowExecutionService.readPlanToRun(savedPlan, run, Some(unitMountRoot))
    failure.getMessage should include("/plan/root")
    failure.getMessage should include(unitMountRoot.toString)
    // Neither the saved settings, stored ports included, nor the saved cost hints were taken.
    run.workflowSettings shouldBe requestedContext().workflowSettings
    run.costHints shouldBe None
  }

  it should "read back the replay and replay log saved with the plan, which the run's coordinator starts with" in {
    val plan = PhysicalPlan(Set(storedSource), Set.empty)
    Seq(
      (Some(replaySource), Some(replayLogLocation)),
      (Some(replaySource), None),
      (None, Some(replayLogLocation))
    ).foreach {
      case (replay, replayLog) =>
        withClue(s"replay $replay, replay log $replayLog: ") {
          val run = requestedContext()
          val executionPlan = WorkflowExecutionService.readPlanToRun(
            saved(ExecutionPlan(savedPlanContext(), plan, replay, replayLog)),
            run,
            Some(unitMountRoot)
          )
          executionPlan.replay shouldBe replay
          executionPlan.replayLog shouldBe replayLog
          run.workflowSettings shouldBe savedPlanContext().workflowSettings
        }
    }
  }

  it should "refuse a plan that reads inputs, which it does not take from a saved plan, and leave the run's context alone" in {
    val plan = PhysicalPlan(Set(storedSource), Set.empty)
    val planContext = savedPlanContext()
    planContext.costHints = Some(CostHints(ExecutionIdentity(1), Map("stored-text" -> 1.0)))
    def input(name: String): PlanInput =
      PlanInput(OperatorIdentity("stored-text"), name, InputFile(Long.MaxValue, 1L))
    Seq(
      ExecutionPlan(planContext, plan, inputs = Seq(input("a.csv"))) ->
        "reads 1 input from outside the run",
      ExecutionPlan(
        planContext,
        plan,
        Some(replaySource),
        Some(replayLogLocation),
        Seq(input("a.csv"), input("b.csv"))
      ) -> "reads 2 inputs from outside the run"
    ).foreach {
      case (executionPlan, asked) =>
        withClue(s"$asked: ") {
          val run = requestedContext()
          val failure = the[IllegalStateException] thrownBy
            WorkflowExecutionService.readPlanToRun(saved(executionPlan), run, Some(unitMountRoot))
          failure.getMessage shouldBe
            s"The plan handed to execution $testEid $asked, which the engine does not take " +
              "from a saved plan."
          run.workflowSettings shouldBe requestedContext().workflowSettings
          run.costHints shouldBe None
        }
    }
  }

  it should "log the saved plan's size, and at debug level the plan without what executors are given" in {
    // What an executor is given can hold an operator's credentials: a SQL source's password in its
    // settings, a token in a UDF's code.
    val settings = """{"host":"db.example","password":"hunter2"}"""
    val code = "token = 's3cr3t-t0ken'"
    val plan = PhysicalPlan(
      Set(
        sourceOp("reads-a-database")
          .copy(opExecInitInfo = OpExecWithClassName("org.example.SqlSourceOpExec", settings)),
        sourceOp("runs-code").copy(opExecInitInfo = OpExecWithCode(code, "python"))
      ),
      Set.empty
    )
    val savedPlan = saved(requestedContext(), plan)
    def sha256(text: String): String =
      MessageDigest
        .getInstance("SHA-256")
        .digest(text.getBytes(StandardCharsets.UTF_8))
        .map(byte => f"$byte%02x")
        .mkString

    val events = eventsLoggedAt(WorkflowExecutionService.getClass.getName, Level.DEBUG) {
      WorkflowExecutionService.readPlanToRun(savedPlan, requestedContext(), Some(unitMountRoot))
    }

    events.filter(_.getLevel == Level.INFO).map(_.getFormattedMessage) shouldBe Seq(
      s"Execution $testEid runs a saved plan of " +
        s"${savedPlan.getBytes(StandardCharsets.UTF_8).length} bytes."
    )
    val debug = events.filter(_.getLevel == Level.DEBUG).map(_.getFormattedMessage)
    debug should have size 1
    debug.head should startWith(
      s"The saved plan of execution $testEid, without what its executors are given:\n"
    )
    // The plan, with each executor's class or language, but its settings and code left out.
    debug.head should include("org.example.SqlSourceOpExec")
    debug.head should include("python")
    debug.head should include(
      s"(left out: ${settings.length} characters, SHA-256 ${sha256(settings)})"
    )
    debug.head should include(s"(left out: ${code.length} characters, SHA-256 ${sha256(code)})")
    debug.head should not include "hunter2"
    debug.head should not include "s3cr3t"
  }

  it should "leave the user name and password in a replay log's location out of the debug log" in {
    // A replay log can be kept where a URI's user info signs in: sftp://user:password@host/...
    val plan = PhysicalPlan(Set(storedSource), Set.empty)
    def replayFrom(location: String): Option[ReplaySource] =
      Some(ReplaySource(ExecutionIdentity(1), new URI(location), "interaction-1"))

    /** What the run logs at debug level for `savedPlan`, whether or not it goes on to run it. */
    def debugLogOf(savedPlan: String): String = {
      val events = eventsLoggedAt(WorkflowExecutionService.getClass.getName, Level.DEBUG) {
        Try(
          WorkflowExecutionService.readPlanToRun(savedPlan, requestedContext(), Some(unitMountRoot))
        )
      }
      val debug = events.filter(_.getLevel == Level.DEBUG).map(_.getFormattedMessage)
      debug should have size 1
      debug.head
    }

    val withPassword = saved(
      ExecutionPlan(
        savedPlanContext(),
        plan,
        replay = replayFrom("sftp://texera:hunter2@logs.example:2222/replay/40/"),
        replayLog = Some(new URI("file:///var/texera/logs/42/"))
      )
    )
    withPassword should include("hunter2") // the saved plan holds it, as the store needs it
    val logged = debugLogOf(withPassword)
    logged should include("\"sftp://(user info left out)@logs.example:2222/replay/40/\"")
    // A location with no user info is logged as it is.
    logged should include("\"file:///var/texera/logs/42/\"")
    logged should not include "hunter2"

    // A user name alone is left out too.
    val withUser = saved(
      ExecutionPlan(
        savedPlanContext(),
        plan,
        replayLog = Some(new URI("sftp://texera@logs.example/replay/42/"))
      )
    )
    val loggedWithUser = debugLogOf(withUser)
    loggedWithUser should include("\"sftp://(user info left out)@logs.example/replay/42/\"")
    loggedWithUser should not include "texera@"

    // Where that is not a URI, which reading the plan refuses, all of it is left out.
    val notAUri = PhysicalPlanCodec.toJson(
      PhysicalPlanCodec
        .encode(ExecutionPlan(savedPlanContext(), plan))
        .withReplayLogLocation("sftp://texera:hunter 2@logs.example/replay/42/")
    )
    val loggedNotAUri = debugLogOf(notAUri)
    loggedNotAUri should include("\"replayLogLocation\": \"(left out: not a URI)\"")
    loggedNotAUri should not include "hunter"
  }

  "WorkflowExecutionService.coordinatorConfigOf" should
    "start the coordinator replaying the plan's replay log, and writing its own where the plan says" in {
    val config = WorkflowExecutionService.coordinatorConfigOf(
      ExecutionPlan(
        savedPlanContext(),
        PhysicalPlan(Set(storedSource), Set.empty),
        Some(replaySource),
        Some(replayLogLocation)
      )
    )

    config.stateRestoreConfOpt shouldBe Some(
      StateRestoreConfig(
        readFrom = replaySource.logLocation,
        replayDestination = EmbeddedControlMessageIdentity(replaySource.interaction)
      )
    )
    config.faultToleranceConfOpt shouldBe Some(FaultToleranceConfig(writeTo = replayLogLocation))
    // The rest is this unit's own.
    config.copy(stateRestoreConfOpt = None, faultToleranceConfOpt = None) shouldBe
      CoordinatorConfig.default
  }

  it should "start the coordinator of a plan that replays nothing and writes no replay log as this unit's" in {
    WorkflowExecutionService.coordinatorConfigOf(
      ExecutionPlan(savedPlanContext(), PhysicalPlan(Set(storedSource), Set.empty))
    ) shouldBe CoordinatorConfig.default
  }

  "WorkflowExecutionService.requireRunnableUnder" should
    "accept a plan whose operators hold only data, reading under this unit's root" in {
    val plan = PhysicalPlan(
      Set(
        sourceOp("reads-nothing"),
        sourceOp("reads-a-dataset").copy(
          repositoryMounts = Some(RepositoryMounts("/mnt/texera-mounts/", Set(readableLocator)))
        )
      ),
      Set.empty
    )
    noException should be thrownBy
      WorkflowExecutionService.requireRunnableUnder(plan, Some(unitMountRoot))
  }

  it should "accept a plan that mounts nothing on a unit that mounts nothing" in {
    noException should be thrownBy WorkflowExecutionService.requireRunnableUnder(
      PhysicalPlan(Set(sourceOp("reads-nothing")), Set.empty),
      None
    )
  }

  it should "refuse a plan whose code reads its datasets under another root" in {
    val plan = PhysicalPlan(
      Set(
        sourceOp("reads-a-dataset").copy(
          repositoryMounts = Some(RepositoryMounts("/plan/root", Set(readableLocator)))
        )
      ),
      Set.empty
    )
    val failure = the[IllegalStateException] thrownBy
      WorkflowExecutionService.requireRunnableUnder(plan, Some(unitMountRoot))
    failure.getMessage should include("/plan/root")
    failure.getMessage should include(unitMountRoot.toString)
    // Nor can a unit that mounts nothing run it.
    val nowhere = the[IllegalStateException] thrownBy
      WorkflowExecutionService.requireRunnableUnder(plan, None)
    nowhere.getMessage should include(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT)
    nowhere.getMessage should include(readableLocator)
  }

  it should "refuse a plan with an operator left to bind, without binding it" in {
    var forced = 0
    val binding: ResourceBinding = (_, _) => {
      forced += 1
      BoundResources(OpExecWithClassName("bound"), Set(readableLocator))
    }
    val plan = PhysicalPlan(
      Set(sourceOp("unbound-udf").withResourceBinding(Some(binding))),
      Set.empty
    )
    val failure = the[IllegalStateException] thrownBy
      WorkflowExecutionService.requireRunnableUnder(plan, Some(unitMountRoot))
    failure.getMessage should include("unbound-udf")
    forced shouldBe 0
  }

  // The companion's one expression, exercised directly rather than only through the two result
  // services that call it. Transposing its two arguments -- both bare `Integer`s bound into one
  // predicate -- does reach those siblings, and hard (30 of their tests fail on it), so this is not
  // a hole in the module's coverage. It is the class that owns the method stating its own contract,
  // and failing first and by name when that contract breaks.
  "WorkflowExecutionService.getLatestExecutionId" should
    "resolve the newest execution of a workflow on a given computing unit" in {
    WorkflowExecutionService.getLatestExecutionId(
      WorkflowIdentity(testWid.longValue()),
      testCuid.intValue()
    ) shouldBe Some(ExecutionIdentity(testEid.longValue()))
  }

  it should "find no execution for a computing unit the workflow has not run on" in {
    // Same workflow row as the case above, so only the cuid leg can produce this None -- which is
    // what keeps that leg from being vacuous. The transposition of the two arguments dies in the
    // case above, where the swapped pair selects no row at all.
    WorkflowExecutionService.getLatestExecutionId(
      WorkflowIdentity(testWid.longValue()),
      otherCuid.intValue()
    ) shouldBe None
  }
}
