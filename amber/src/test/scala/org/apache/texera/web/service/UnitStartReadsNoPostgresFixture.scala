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

import org.apache.iceberg.catalog.TableIdentifier
import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionLogStore,
  IcebergCatalogInstance
}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{CostHints, PhysicalPlanCodec, PortIdentity}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessageType.ERROR
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  READY,
  RUNNING
}
import org.apache.texera.amber.engine.common.{AmberRuntime, Utils}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.{FixtureInputs, LogicalOp}
import org.apache.texera.common.compiler.CompileFor
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.StatementRecorder.Statement
import org.apache.texera.dao.jooq.generated.Tables.{WORKFLOW_EXECUTIONS, WORKFLOW_OF_USER}
import org.apache.texera.dao.jooq.generated.enums.{UserRoleEnum, WorkflowComputingUnitTypeEnum}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  WorkflowComputingUnit,
  WorkflowVersion,
  Workflow => WorkflowRow
}
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder}
import org.apache.texera.web.model.http.request.execution.CreateExecutionRequest
import org.apache.texera.web.model.websocket.event.python.ConsoleUpdateEvent
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WebResultUpdateEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.service.execution.{
  CostHintsLoader,
  CreatedExecution,
  ExecutionCreator,
  ExecutionExpiry,
  FixtureCompilingService,
  RecordingComputingUnits
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.sql.Timestamp
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, Future, Promise}
import scala.jdk.CollectionConverters.IterableHasAsScala
import scala.util.Try

/**
  * Runs executions as a deployment runs them, and holds what a computing unit sends to Postgres
  * meanwhile against the rule that a unit keeps nothing there: nothing. A unit starts and runs a
  * run without a statement to Postgres, and keeps the run's record in the lake.
  *
  * An execution is created as the Dashboard service creates one (`ExecutionCreator`): its row is
  * inserted, and its plan is compiled for its creator and handed over. It is then started with
  * that plan as a computing unit starts what it is handed (`WorkflowService.checkStart`, then
  * `startChecked`), on a workflow service that a session is connected to, and runs to its end on
  * an engine of this suite's actor system. Every statement the unit
  * sends through jOOQ, from any thread, is recorded from the start until the session has been
  * sent the results of the completed run, which is the last thing a unit does for a run. The
  * run's record is kept in the lake as a unit keeps it, in the same catalog.
  *
  * A plan is bound to the fixtures (`TestUtils.fixtureBindings`), unless a suite binds it
  * otherwise: the files it reads are fixture files, which the Dashboard links to the fixture
  * server, which stands in for the object store.
  *
  * LakeFS is out of the unit's reach: for the whole suite its address is one nothing listens at,
  * so a unit that asked LakeFS for a file would fail its run. `LakeFSStorageClient` keeps the
  * address it first connects to for the life of its JVM, which this module's suites share, so a
  * suite that reads a dataset's file names one that no LakeFS holds: wherever the client
  * points, the file's bytes come through the plan's link or not at all.
  *
  * @param actorSystemName the name of the suite's actor system, which runs its engines
  */
abstract class UnitStartReadsNoPostgresFixture(actorSystemName: String)
    extends TestKit(ActorSystem(actorSystemName, AmberRuntime.pekkoConfig))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  /**
    * The executions the suite creates take the ids after this one: a range of the suite's own,
    * as their plans and results are tables of a catalog every suite shares.
    */
  protected def firstCreatedEid: Int

  /** The workflow the suite's executions are of: its own, for the same reason. */
  protected def wid: Int

  protected val creatorUid = 9781
  protected val creatorEmail = "unit-start-creator@example.com"
  private val unitCuid = 9785

  /** What the compiling service binds each plan to. */
  protected def bindings: CompileFor.Run = TestUtils.fixtureBindings

  private var recorder: StatementRecorder = _
  private var configuredLakefsEndpoint: String = _
  private val created = ArrayBuffer.empty[CreatedExecution]

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    system.actorOf(Props[SingleNodeListener](), "cluster-info")
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    val cfg = getDSLContext.configuration()

    new UserDao(cfg).insert(creator)
    val workflow = new WorkflowRow
    workflow.setWid(wid)
    workflow.setName(s"unit-start-workflow-$wid")
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
    val unit = new WorkflowComputingUnit
    unit.setCuid(unitCuid)
    unit.setUid(creatorUid)
    unit.setName("unit-start-unit")
    unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
    unit.setType(WorkflowComputingUnitTypeEnum.local)
    unit.setUri("local://test")
    unit.setResource("{}")
    new WorkflowComputingUnitDao(cfg).insert(unit)
    // The table is qualified from the generated metadata, as the connection's search_path does
    // not hold texera_db.
    getDSLContext.execute(
      "select setval(pg_get_serial_sequence(?, ?), ?, true)",
      s"${WORKFLOW_EXECUTIONS.getSchema.getName}.${WORKFLOW_EXECUTIONS.getName}",
      WORKFLOW_EXECUTIONS.EID.getName,
      Integer.valueOf(firstCreatedEid)
    )

    // Nothing listens at LakeFS's address until the suite ends.
    configuredLakefsEndpoint = StorageConfig.lakefsEndpoint
    StorageConfig.lakefsEndpoint = "http://127.0.0.1:1/api/v1"
  }

  override protected def afterAll(): Unit =
    try {
      created.foreach(execution => Try(expiry.dropAll(execution.eid)))
      StorageConfig.lakefsEndpoint = configuredLakefsEndpoint
      TestKit.shutdownActorSystem(system)
    } finally {
      closeConnectionPool()
      super.afterAll()
    }

  private def creator: User = {
    val user = new User
    user.setUid(Integer.valueOf(creatorUid))
    user.setName("unit-start-creator")
    user.setEmail(creatorEmail)
    user.setRole(UserRoleEnum.REGULAR)
    user
  }

  private object NoHints extends CostHintsLoader(1) {
    override def load(wid: Long, uid: Int): Option[CostHints] = None
  }

  /** The Dashboard's expiry, which deletes no large binary: the suite's runs write none. */
  private val expiry = new ExecutionExpiry(warehousesEnabled = false, deleteBinaries = _ => ())

  /** The units' side of the Dashboard's create: each plan handed over, for the suite's unit. */
  private val handedOver = new RecordingComputingUnits()

  /** The Dashboard's create, its plans bound as the suite binds them. */
  private object Dashboard
      extends ExecutionCreator(
        compiling = new FixtureCompilingService(bindingsFor = _ => bindings),
        units = handedOver,
        linker = FixtureInputs.linker,
        replayLogRoot = None,
        warehousesEnabled = false,
        costHints = NoHints,
        background = _.run(),
        expiry = expiry
      )

  /**
    * The workflow's service on the unit, as the unit makes one for the first session on the
    * workflow, but for the engine of each run, which is on this suite's actor system: no unit's
    * is started here.
    */
  private def unitWorkflowService(): WorkflowService =
    new WorkflowService(
      WorkflowIdentity(wid.toLong),
      unitCuid,
      3600,
      newRun = new WorkflowExecutionService(
        _,
        _,
        _,
        _,
        Some(TestUtils.fixtureUnitMountRoot),
        createAmberRuntime = (context, plan, coordinatorConfig, onError) =>
          new AmberClient(
            system,
            context,
            plan,
            TestUtils.readingFixtureLinks(coordinatorConfig),
            onError
          )
      )
    )

  /**
    * A session on the workflow, as a browser's: it is sent what the workflow's service and its
    * run publish. `ended` completes once it has been sent the results of the completed run, and
    * fails if it is sent an error instead: the run's, or an operator's, whose worker reports
    * what its executor threw and pauses rather than end the run.
    *
    * The results of the completed run are those its end sends, on the thread that told the
    * session the run had completed. A periodic update of the results, which another thread
    * makes, may still be under way then, and is not the run's last word.
    */
  private class Session {
    private val sent = ArrayBuffer.empty[TexeraWebSocketEvent]
    private val done = Promise[Unit]()
    private var completedOn: Option[Thread] = None

    def receive(event: TexeraWebSocketEvent): Unit =
      synchronized {
        sent += event
        event match {
          case WorkflowStateEvent(state, _) if state == nameOf(COMPLETED) =>
            completedOn = Some(Thread.currentThread())
          case _: WebResultUpdateEvent if completedOn.contains(Thread.currentThread()) =>
            done.trySuccess(())
          case WorkflowErrorEvent(errors) if errors.nonEmpty =>
            failed(s"the run failed: ${errors.map(_.message).mkString("; ")}")
          case ConsoleUpdateEvent(operatorId, messages) if messages.exists(_.msgType == ERROR) =>
            val thrown = messages.filter(_.msgType == ERROR).map(_.title).mkString("; ")
            failed(s"operator $operatorId failed: $thrown")
          case _ =>
        }
      }

    private def failed(why: String): Unit = done.tryFailure(new IllegalStateException(why))

    def ended: Future[Unit] = done.future

    /** The states of the run the session was told, in order. */
    def states: Seq[String] =
      synchronized(sent.collect { case WorkflowStateEvent(state, _) => state }.toSeq)
  }

  private def nameOf(state: WorkflowAggregatedState): String = Utils.aggregatedStateToString(state)

  /**
    * A run of an execution of the suite's, from its start to its end.
    *
    * @param execution  the execution, as the Dashboard created it, with the plan it handed over
    * @param statements what the unit sent to Postgres meanwhile, in the order it was sent
    * @param states     the states of the run a session on the workflow was told, in order
    * @param recorded   whether the run's record had nothing left to write within a minute of
    *                   the run's end
    */
  protected case class Run(
      execution: CreatedExecution,
      statements: Seq[Statement],
      states: Seq[String],
      recorded: Boolean
  ) {

    /**
      * The rows the run stored as the result of operator `operatorId`, in the table its plan names
      * for the operator's first port: the table the Dashboard records for it.
      */
    def resultOf(operatorId: String): List[Tuple] = {
      val uri = PhysicalPlanCodec
        .decode(PhysicalPlanCodec.fromJson(execution.plan))
        .resultTables
        .find(table =>
          table.port.opId.logicalOpId == OperatorIdentity(operatorId) &&
            table.port.portId == PortIdentity()
        )
        .map(_.uri)
        .getOrElse(fail(s"the plan keeps no result of operator $operatorId"))
      DocumentFactory
        .openDocument(uri)
        ._1
        .asInstanceOf[VirtualDocument[Tuple]]
        .get()
        .toList
    }
  }

  protected def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  protected def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  /**
    * Creates an execution of the workflow of `operators` and `links` at the Dashboard, for the
    * creator, then starts it on the unit from the plan the Dashboard handed over and waits for
    * its run to end.
    */
  protected def run(operators: List[LogicalOp], links: List[LogicalLink]): Run = {
    val execution = handedOver.created(
      Dashboard.create(
        CreateExecutionRequest(
          wid = wid.toLong,
          engineVersion = "1.4.0-spec",
          logicalPlan =
            TestUtils.sentPlan(LogicalPlanPojo(operators, links, List.empty, List.empty)),
          workflowSettings = None,
          computingUnitId = unitCuid,
          warehouseId = None,
          replayFromExecution = None
        ),
        creator,
        new URI("http://texera.example/api/executions"),
        FixtureCompilingService.authorizationOf(creatorUid)
      )
    )
    created += execution

    val service = unitWorkflowService()
    val session = new Session
    val subscriptions =
      Seq(service.connect(session.receive), service.connectToExecution(session.receive))
    try {
      val statements = recorder.record {
        WorkflowService
          .checkStart(execution.plan, creator, unitCuid)
          .flatMap(service.startChecked)
          .left
          .foreach(why => fail(s"the start was refused: $why"))
        Await.result(session.ended, 3.minutes)
      }
      val recorded =
        service.executionService.getValue.executionStateStore.recorder.awaitIdle(1.minute)
      Run(execution, statements, session.states, recorded)
    } finally {
      subscriptions.foreach(_.dispose())
      service.unsubscribeAll()
    }
  }

  private def logUriOf(execution: CreatedExecution): URI =
    ExecutionLogStore.logUri(WorkflowIdentity(wid.toLong), ExecutionIdentity(execution.eid), None)

  /**
    * Fails unless the lake holds the log of `run`: a row for each state the run was in, in
    * order, with the label of the last, in a table tidied at the run's end, of one data file
    * and one snapshot.
    */
  protected def assertLogged(run: Run): Unit = {
    val logUri = logUriOf(run.execution)
    withClue("the run's record had something left to write: ") { run.recorded shouldBe true }
    val rows = ExecutionLogStore.read(logUri)
    rows.map(row => (row.seq, row.state, row.reason)) shouldBe Seq(
      (1L, Some("READY"), None),
      (2L, Some("RUNNING"), None),
      (3L, Some("COMPLETED"), None)
    )
    rows.map(_.timeMs) shouldBe sorted
    val label = ExecutionLogStore.label(logUri).getOrElse(fail("the execution has no log"))
    (label.state, label.stateSeq, label.stateTimeMs, label.reason, label.ended) shouldBe
      ((Some("COMPLETED"), 3L, rows.last.timeMs, None, true))
    label.beatEveryMs shouldBe StorageConfig.icebergTableCommitIntervalMs
    val table = IcebergCatalogInstance
      .getInstance()
      .loadTable(
        TableIdentifier.of(
          StorageConfig.icebergTableExecutionLogNamespace,
          s"wid_${wid}_eid_${run.execution.eid}_executionlog"
        )
      )
    table.snapshots().asScala should have size 1
    table.currentSnapshot().summary().get("total-data-files") shouldBe "1"
  }

  /** A statement as a failure names it: what it does, to which tables, and what sent it. */
  private def described(statement: Statement): String =
    s"${statement.verb} of ${statement.tables.mkString(", ")} by " +
      s"${statement.site.fold("unknown code")(_.toString)}: ${statement.sql}"

  /**
    * Fails unless `run` kept to the rule: from its start until its session was sent the results
    * of the completed run, the unit sent Postgres no statement, of any kind, and the session
    * was told the run READY, RUNNING and COMPLETED.
    */
  protected def assertRanWithoutPostgres(run: Run): Unit = {
    withClue("from the start of the run to its end, the unit sent: ") {
      run.statements.map(described) shouldBe empty
    }
    run.states shouldBe Seq(READY, RUNNING, COMPLETED).map(nameOf)
  }
}
