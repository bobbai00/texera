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

package org.apache.texera.web

import ch.qos.logback.classic.spi.{ILoggingEvent, IThrowableProxy}
import ch.qos.logback.classic.{Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ExecutionLogStore,
  ExecutionPlanStore,
  ExecutionTables,
  PlanRecord,
  RuntimeStatisticsStore
}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{PortIdentity, WorkflowContext}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  PAUSED,
  RUNNING
}
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.sleep.SleepOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.java.JavaUDFOpDesc
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.model.websocket.event.{
  PaginatedResultEvent,
  TexeraWebSocketEvent,
  WorkflowStateEvent
}
import org.apache.texera.web.model.websocket.request.{
  ResultPaginationRequest,
  WorkflowKillRequest,
  WorkflowPauseRequest,
  WorkflowResumeRequest
}
import org.apache.texera.web.service.{WorkflowExecutionService, WorkflowService}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}
import org.slf4j.LoggerFactory

import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import scala.annotation.tailrec
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Runs executions from start to end on a computing unit that has no database, as a unit has
  * none: it declares so (`SqlServer.withoutDatabase`), and whatever asks it for the database
  * from then on fails with the unit's reason.
  *
  * An execution is here what the Dashboard service leaves a unit to start: a plan row in the
  * execution's plan table in the lake, written straight with `ExecutionPlanStore.writePlan`, of
  * a small workflow made to run as every plan is. Nothing of it is in Postgres. It is started as
  * a unit starts one by its id (`WorkflowService.checkStoredStart`, then `startChecked`), on an
  * engine of this suite's actor system, and asked what a session's socket asks of a run: to
  * pause, to resume, to be killed, and for a page of a result. The run's record is the unit's
  * own, kept in the lake, in the catalog the build's tests use.
  *
  * Each case ends by checking that nothing the unit ran asked for the database: no error of the
  * run, and no line anything logged, holds the unit's reason. That catches a use whose failure
  * is caught and logged where it is made, as a write of a run's status used to be.
  */
class ComputingUnitWithoutDatabaseSpec
    extends TestKit(ActorSystem("ComputingUnitWithoutDatabaseSpec", AmberRuntime.pekkoConfig))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll
    with Eventually {

  // A run's engine starts, and its record reaches the lake, within seconds.
  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(60, Seconds), interval = Span(50, Millis))

  // No other suite's ids: the tables the runs make in the lake are named after them.
  private val workflowId = WorkflowIdentity(9883L)
  private val unitCuid = 9884
  private val creator: User = {
    val user = new User
    user.setUid(Integer.valueOf(9885))
    user.setName("unit-without-database-creator")
    user
  }

  private val completedEid = 988301L
  private val pausedEid = 988302L
  private val failedEid = 988303L
  private val thrownEid = 988304L
  private val executionIds = Seq(completedEid, pausedEid, failedEid, thrownEid)

  /** Every line logged while the suite runs, by anything. */
  private val logged = new ListAppender[ILoggingEvent]
  private def rootLogger: LogbackLogger =
    LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).asInstanceOf[LogbackLogger]

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    system.actorOf(Props[SingleNodeListener](), "cluster-info")
    logged.start()
    rootLogger.addAppender(logged)
    // Whatever an earlier build of this suite left in the catalog the tests share.
    dropTables()
    // As a computing unit declares when it boots.
    SqlServer.withoutDatabase(ComputingUnitMaster.NoDatabase)
  }

  override protected def afterAll(): Unit =
    try {
      rootLogger.detachAppender(logged)
      logged.stop()
      dropTables()
    } finally {
      TestKit.shutdownActorSystem(system)
      super.afterAll()
    }

  private def dropTables(): Unit =
    executionIds.foreach { eid =>
      Try(
        ExecutionTables.dropNamed(
          workflowId,
          ExecutionIdentity(eid),
          None,
          ExecutionTables.AllKinds
        )
      )
    }

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  /** A source of `lines` lines, `line-1` to `line-<lines>`, one row each. */
  private def linesSource(id: String, lines: Int): TextInputSourceOpDesc = {
    val source = named(new TextInputSourceOpDesc(), id)
    source.textInput = (1 to lines).map(line => s"line-$line").mkString("\n")
    source
  }

  /** An operator that takes `seconds` over each row; a negative time is one it throws on. */
  private def sleeping(id: String, seconds: Int): SleepOpDesc = {
    val sleep = named(new SleepOpDesc(), id)
    sleep.sleepTime = seconds
    sleep
  }

  /**
    * Writes the plan row of execution `eid`, of the workflow of `operators` and `links`, to the
    * execution's plan table, as the Dashboard service leaves it for the unit asked to run it.
    *
    * @return the plan table
    */
  private def storePlan(eid: Long, operators: List[LogicalOp], links: List[LogicalLink]): URI = {
    val context = new WorkflowContext(workflowId, ExecutionIdentity(eid))
    val planUri = ExecutionPlanStore.planUri(workflowId, ExecutionIdentity(eid), None)
    ExecutionPlanStore.writePlan(
      planUri,
      PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        body = TestUtils.savedPlan(context, LogicalPlanPojo(operators, links, List(), List())),
        createdBy = creator.getUid,
        computingUnitId = unitCuid
      ),
      "{}"
    )
    planUri
  }

  /**
    * The service of the workflow on the unit, as the unit makes one for the first session on the
    * workflow, but for the engine of each run, which is on this suite's actor system: no unit's
    * is started here. A session is connected to it, which keeps what it is sent.
    */
  private final class UnitSession {
    val service = new WorkflowService(
      workflowId,
      unitCuid,
      3600,
      newRun = new WorkflowExecutionService(
        _,
        _,
        _,
        _,
        None,
        createAmberRuntime = new AmberClient(system, _, _, _, _)
      )
    )
    private val sent = new CopyOnWriteArrayList[TexeraWebSocketEvent]()
    private val subscriptions =
      Seq(service.connect(sent.add(_)), service.connectToExecution(sent.add(_)))

    /** The states of the run the session was told, in order. */
    def statesTold: Seq[String] =
      sent.asScala.collect { case WorkflowStateEvent(state, _) => state }.toSeq

    /** Starts execution `eid` from its plan at `planUri`, as a start by id over a socket does. */
    def start(eid: Long, planUri: URI): WorkflowExecutionService =
      WorkflowService
        .checkStoredStart(eid, planUri, creator, unitCuid, socketWorkflowId = Some(workflowId.id))
        .flatMap(service.startChecked)
        .fold(why => fail(s"the start of execution $eid was refused: $why"), identity)

    def close(): Unit = {
      subscriptions.foreach(_.dispose())
      service.unsubscribeAll()
    }
  }

  private def withSession[T](body: UnitSession => T): T = {
    val session = new UnitSession
    try body(session)
    finally session.close()
  }

  private def stateOf(run: WorkflowExecutionService): WorkflowAggregatedState =
    run.executionStateStore.metadataStore.getState.state

  /** Sends `request` to `run`, as the unit's socket hands on what a session asks of a run. */
  private def ask(
      run: WorkflowExecutionService,
      request: org.apache.texera.web.model.websocket.request.TexeraWebSocketRequest
  ): Unit = run.wsInput.onNext(request, Some(creator.getUid))

  /**
    * The log of execution `eid`, as the lake holds it once the record of `run` has nothing left
    * to write: the state and the reason of each row, in order.
    */
  private def logOf(run: WorkflowExecutionService, eid: Long): Seq[(String, Option[String])] = {
    withClue(s"the record of execution $eid had something left to write: ") {
      run.executionStateStore.recorder.awaitIdle(1.minute) shouldBe true
    }
    val logUri = ExecutionLogStore.logUri(workflowId, ExecutionIdentity(eid), None)
    val rows = ExecutionLogStore.read(logUri)
    rows.map(_.seq) shouldBe (1L to rows.size.toLong)
    // The label says what the last row says, to whoever reads only the label.
    val label = ExecutionLogStore.label(logUri).getOrElse(fail(s"execution $eid has no log"))
    (label.state, label.reason) shouldBe ((rows.last.state, rows.last.reason))
    rows.map(row => (row.state.getOrElse(fail(s"a row of the log has no state: $row")), row.reason))
  }

  @tailrec
  private def holdsReason(thrown: IThrowableProxy): Boolean =
    thrown != null && (Option(thrown.getMessage).exists(_.contains(ComputingUnitMaster.NoDatabase))
      || holdsReason(thrown.getCause))

  /**
    * Fails if anything asked this unit for the database since the suite began: a line logged
    * holds the reason such a use fails with, or an error of `run` does.
    */
  private def assertNothingAskedForTheDatabase(run: Option[WorkflowExecutionService]): Unit = {
    val lines = logged.synchronized(logged.list.asScala.toList).filter { event =>
      event.getFormattedMessage.contains(ComputingUnitMaster.NoDatabase) ||
      holdsReason(event.getThrowableProxy)
    }
    withClue("the unit was asked for the database, as these lines logged show: ") {
      lines.map(event => s"${event.getLoggerName}: ${event.getFormattedMessage}") shouldBe empty
    }
    run.foreach { run =>
      val errors = run.executionStateStore.metadataStore.getState.fatalErrors
      withClue("the run failed for want of a database: ") {
        errors.filter(error =>
          (error.message + error.details).contains(ComputingUnitMaster.NoDatabase)
        ) shouldBe empty
      }
    }
    // The unit has no database still: nothing opened one meanwhile.
    (the[IllegalStateException] thrownBy SqlServer.getInstance()).getMessage shouldBe
      ComputingUnitMaster.NoDatabase
  }

  private def page(session: UnitSession, operatorId: String, pageIndex: Int) =
    session.service.resultService.handleResultPagination(
      ResultPaginationRequest("page", operatorId, pageIndex, pageSize = 5)
    ) match {
      case event: PaginatedResultEvent => event
      case other                       => fail(s"expected a page of a result, got $other")
    }

  "A computing unit with no database" should
    "run an execution to its end, record it in the lake, and serve pages of its result" in withSession {
    session =>
      val planUri = storePlan(completedEid, List(linesSource("lines", 7)), List())

      val run = session.start(completedEid, planUri)
      eventually(stateOf(run) shouldBe COMPLETED)

      logOf(run, completedEid) shouldBe
        Seq(("READY", None), ("RUNNING", None), ("COMPLETED", None))
      session.statesTold shouldBe Seq("Initializing", "Running", "Completed")
      // Its statistics and its console are tables of the lake too, made by its record.
      val executionId = ExecutionIdentity(completedEid)
      ExecutionTables.exists(
        RuntimeStatisticsStore.statisticsUri(workflowId, executionId, None)
      ) shouldBe true
      ExecutionTables.exists(
        ConsoleMessageStore.consoleUri(workflowId, executionId, None)
      ) shouldBe true
      // The pages of the result of the run the unit holds, found where its engine reported it.
      val first = page(session, "lines", pageIndex = 1)
      first.table.map(_.get("line").asText()) shouldBe (1 to 5).map(line => s"line-$line")
      first.totalTuples shouldBe 7
      page(session, "lines", pageIndex = 2).table.map(_.get("line").asText()) shouldBe
        Seq("line-6", "line-7")
      assertNothingAskedForTheDatabase(Some(run))
  }

  it should "answer an empty page for a workflow it holds no run of, looking nowhere for one" in withSession {
    session =>
      // The workflow has an execution that stored this result, which the case above ran: a
      // unit that restarted since holds no run of it, and its results are the Dashboard's to
      // serve.
      val request = ResultPaginationRequest("page", "lines", pageIndex = 1, pageSize = 5)

      session.service.resultService.handleResultPagination(request) shouldBe
        PaginatedResultEvent(request, List.empty, List.empty)
      assertNothingAskedForTheDatabase(None)
  }

  it should "pause, resume and kill a run as its sessions ask, recording each state it was in" in withSession {
    session =>
      // Two minutes of work, unless it is killed.
      val planUri = storePlan(
        pausedEid,
        List(linesSource("lines", 120), sleeping("slow", seconds = 1)),
        List(link("lines", "slow"))
      )

      val run = session.start(pausedEid, planUri)
      eventually(stateOf(run) shouldBe RUNNING)
      ask(run, WorkflowPauseRequest(pausedEid))
      eventually(stateOf(run) shouldBe PAUSED)
      ask(run, WorkflowResumeRequest(pausedEid))
      eventually(stateOf(run) shouldBe RUNNING)
      ask(run, WorkflowKillRequest(pausedEid))
      eventually(stateOf(run) shouldBe KILLED)

      // A request in flight (pausing, resuming) is a state of the session's, not of the log's.
      logOf(run, pausedEid) shouldBe Seq(
        ("READY", None),
        ("RUNNING", None),
        ("PAUSED", None),
        ("RUNNING", None),
        ("KILLED", Some("killed by the user"))
      )
      val told = session.statesTold
      told.head shouldBe "Initializing"
      told.last shouldBe "Killed"
      told should contain allOf ("Pausing", "Paused", "Resuming")
      assertNothingAskedForTheDatabase(Some(run))
  }

  it should "record a run that fails in an operator as failed, with what the operator failed on" in withSession {
    session =>
      // Code that no Java compiler takes: the operator's worker fails as it makes its executor.
      val broken = named(new JavaUDFOpDesc(), "broken")
      broken.code = "public class JavaUDFOpExec { this is not Java }"
      val planUri = storePlan(
        failedEid,
        List(linesSource("lines", 3), broken),
        List(link("lines", "broken"))
      )

      val run = session.start(failedEid, planUri)
      eventually(stateOf(run) shouldBe FAILED)

      // The run's one error is the compiler's, of the operator's code.
      val errors = run.executionStateStore.metadataStore.getState.fatalErrors
      errors should have size 1
      errors.head.message should include("Error at line")
      // It may fail before the engine's answer to its start, which would have read RUNNING.
      val log = logOf(run, failedEid)
      log.head shouldBe (("READY", None))
      log.init.tail.foreach(_ shouldBe (("RUNNING", None)))
      // The log's reason is the error's message, as much of it as a label holds.
      val (ending, reason) = log.last
      ending shouldBe "FAILED"
      errors.head.message should startWith(reason.getOrElse(fail("the log gives no reason")))
      session.statesTold.last shouldBe "Failed"
      assertNothingAskedForTheDatabase(Some(run))
  }

  it should "keep what an operator throws on a row on its console, in the lake, and kill the run when asked" in withSession {
    session =>
      val planUri = storePlan(
        thrownEid,
        List(linesSource("lines", 3), sleeping("throws", seconds = -1)),
        List(link("lines", "throws"))
      )

      val run = session.start(thrownEid, planUri)
      // The operator's worker reports what its executor threw, and waits: the run goes on.
      def thrown =
        run.executionStateStore.consoleStore.getState.operatorConsole
          .get("throws")
          .toSeq
          .flatMap(_.consoleMessages)
      eventually(thrown should not be empty)
      stateOf(run) should not be FAILED
      ask(run, WorkflowKillRequest(thrownEid))
      eventually(stateOf(run) shouldBe KILLED)

      val log = logOf(run, thrownEid)
      log.head shouldBe (("READY", None))
      log.last shouldBe (("KILLED", Some("killed by the user")))
      val (console, _) = ConsoleMessageStore.read(
        ConsoleMessageStore.consoleUri(workflowId, ExecutionIdentity(thrownEid), None),
        operatorId = Some("throws"),
        afterSeq = 0L,
        limit = 100
      )
      console.map(_.msgType) should contain("ERROR")
      console.map(_.title) should contain(thrown.head.title)
      assertNothingAskedForTheDatabase(Some(run))
  }
}
