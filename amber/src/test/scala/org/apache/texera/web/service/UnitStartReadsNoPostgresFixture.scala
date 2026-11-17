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

import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  ExecutionResultUris
}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{CostHints, PortIdentity, WorkflowContext}
import org.apache.texera.amber.engine.architecture.coordinator.{CoordinatorConfig, Workflow}
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
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.common.compiler.RunBindings
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
import org.apache.texera.web.model.http.response.execution.CreateExecutionResponse
import org.apache.texera.web.model.websocket.event.python.ConsoleUpdateEvent
import org.apache.texera.web.model.websocket.event.{
  TexeraWebSocketEvent,
  WebResultUpdateEvent,
  WorkflowErrorEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.service.execution.{
  CostHintsLoader,
  ExecutionCreator,
  ExecutionResources
}
import org.apache.texera.web.storage.ExecutionStateStore
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.sql.Timestamp
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, Future, Promise}
import scala.util.Try

/**
  * Runs executions as a deployment runs them, and holds what a computing unit sends to Postgres
  * meanwhile against the rule of a self-contained engine: a unit starts a run without reading
  * Postgres, and until the run ends it touches only the three tables a run's state is kept in.
  *
  * An execution is created as the Dashboard service creates one (`ExecutionCreator`): its row is
  * inserted, and its plan is compiled for its creator and written to the lake, in the catalog
  * the build's tests use. It is then started by its id as a computing unit starts one
  * (`WorkflowService.startStoredExecution`), on a workflow service that a session is connected
  * to, and runs to its end on an engine of this suite's actor system. Every statement the unit
  * sends through jOOQ, from any thread, is recorded from the start until the session has been
  * sent the results of the completed run, which is the last thing a unit does for a run.
  *
  * A plan is bound to the fixtures (`TestUtils.fixtureBindings`), unless a suite binds it
  * otherwise: the files it reads are fixture files, linked to the fixture server, which stands in
  * for the object store.
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

  /** What the Dashboard binds each plan to. */
  protected def bindings: RunBindings = TestUtils.fixtureBindings

  private var recorder: StatementRecorder = _
  private var configuredLakefsEndpoint: String = _
  private val created = ArrayBuffer.empty[CreateExecutionResponse]

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
      created.foreach { execution =>
        Try(ExecutionResources.clearExecutionResources(ExecutionIdentity(execution.eid)))
        Try(ExecutionPlanStore.drop(new URI(execution.planUri)))
      }
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

  /** The Dashboard's create, bound as the suite binds its plans. */
  private object Dashboard
      extends ExecutionCreator(
        bindingsFor = _ => bindings,
        replayLogRoot = None,
        warehousesEnabled = false,
        costHints = NoHints,
        background = _.run()
      )

  /**
    * The workflow's service on the unit, as the unit makes one for the first session on the
    * workflow, but for the engine of each run, which is on this suite's actor system: no unit's
    * is started here.
    */
  private class UnitWorkflowService
      extends WorkflowService(WorkflowIdentity(wid.toLong), unitCuid, 3600) {
    override protected def storedRun(
        context: WorkflowContext,
        executionStateStore: ExecutionStateStore,
        onError: Throwable => Unit
    ): WorkflowExecutionService =
      new WorkflowExecutionService(
        context,
        resultService,
        executionStateStore,
        onError,
        Some(TestUtils.fixtureUnitMountRoot)
      ) {
        override protected def createAmberRuntime(
            workflow: Workflow,
            coordinatorConfig: CoordinatorConfig
        ): AmberClient =
          new AmberClient(
            system,
            workflow.context,
            workflow.physicalPlan,
            coordinatorConfig,
            onError
          )
      }
  }

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
    * @param execution  the execution, as the Dashboard created it
    * @param statements what the unit sent to Postgres meanwhile, in the order it was sent
    * @param states     the states of the run a session on the workflow was told, in order
    */
  protected case class Run(
      execution: CreateExecutionResponse,
      statements: Seq[Statement],
      states: Seq[String]
  ) {

    /** The rows the run stored as the result of operator `operatorId`. */
    def resultOf(operatorId: String): List[Tuple] = {
      val uri = ExecutionResultUris
        .getResultUriByLogicalPortId(
          ExecutionIdentity(execution.eid),
          OperatorIdentity(operatorId),
          PortIdentity()
        )
        .getOrElse(fail(s"the run stored no result of operator $operatorId"))
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
    * creator, then starts it on the unit by its id and waits for its run to end.
    */
  protected def run(operators: List[LogicalOp], links: List[LogicalLink]): Run = {
    val execution = Dashboard
      .create(
        CreateExecutionRequest(
          wid = wid.toLong,
          engineVersion = "1.4.0-spec",
          logicalPlan = LogicalPlanPojo(operators, links, List.empty, List.empty),
          workflowSettings = None,
          computingUnitId = unitCuid,
          warehouseId = None,
          replayFromExecution = None
        ),
        creator,
        new URI("http://texera.example/api/executions")
      )
    created += execution

    val service = new UnitWorkflowService
    val session = new Session
    val subscriptions =
      Seq(service.connect(session.receive), service.connectToExecution(session.receive))
    try {
      val statements = recorder.record {
        service
          .startStoredExecution(
            execution.eid,
            new URI(execution.planUri),
            creator,
            unitCuid,
            new URI("ws://texera.example/wsapi/workflow-websocket")
          )
          .left
          .foreach(why => fail(s"the start was refused: $why"))
        Await.result(session.ended, 3.minutes)
      }
      Run(execution, statements, session.states)
    } finally {
      subscriptions.foreach(_.dispose())
      service.unsubscribeAll()
    }
  }

  /** The tables a run's state is kept in: all that a unit may touch while it runs one. */
  private val RunStateTables =
    Set("workflow_executions", "operator_port_executions", "operator_executions")

  /** A statement as a failure names it: what it does, to which tables, and what sent it. */
  private def described(statement: Statement): String =
    s"${statement.verb} of ${statement.tables.mkString(", ")} by " +
      s"${statement.site.fold("unknown code")(_.toString)}: ${statement.sql}"

  /**
    * The state `statement` records for execution `eid`, as the code its row keeps, if it is a
    * write of the execution's status.
    */
  private def statusWritten(statement: Statement, eid: Long): Option[Int] = {
    val status = statement.sql.indexOf("\"status\" = ?")
    Option
      .when(statement.verb == "UPDATE" && status >= 0 && statement.values.contains(eid.toInt)) {
        statement.values(statement.sql.take(status).count(_ == '?'))
      }
      .collect { case code: Number => code.intValue() }
  }

  /**
    * Fails unless `run` kept to the rule: the unit recorded it READY, RUNNING and COMPLETED, in
    * one write each; until it had recorded it RUNNING, it read nothing, and only inserted into
    * or updated the three tables of a run's state; and until the run ended, it touched no other
    * table.
    */
  protected def assertStartedWithoutReading(run: Run): Unit = {
    val statements = run.statements
    val statusWrites = statements.zipWithIndex.flatMap {
      case (statement, index) => statusWritten(statement, run.execution.eid).map(index -> _)
    }
    withClue(s"the unit's writes of the run's status, of ${statements.map(described)}: ") {
      statusWrites.map(_._2) shouldBe Seq(READY, RUNNING, COMPLETED).map(
        Utils.maptoStatusCode(_).toInt
      )
    }
    run.states shouldBe Seq(READY, RUNNING, COMPLETED).map(nameOf)

    val (untilRunning, _) = statusWrites(1)
    val toStart = statements.take(untilRunning + 1)
    withClue("until the unit recorded the run RUNNING, it sent: ") {
      toStart
        .filterNot(statement => Set("INSERT", "UPDATE").contains(statement.verb))
        .map(described) shouldBe empty
    }
    withClue("until the run ended, the unit sent: ") {
      statements
        .filterNot(statement =>
          statement.tables.nonEmpty && statement.tables.subsetOf(RunStateTables) &&
            Set("INSERT", "UPDATE", "SELECT").contains(statement.verb)
        )
        .map(described) shouldBe empty
    }
  }
}
