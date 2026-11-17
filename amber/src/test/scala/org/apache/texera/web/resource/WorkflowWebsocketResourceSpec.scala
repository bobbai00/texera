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

package org.apache.texera.web.resource

import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.fasterxml.jackson.annotation.JsonSubTypes
import com.google.protobuf.timestamp.Timestamp
import com.twitter.util.{Future, Promise}
import io.reactivex.rxjava3.disposables.Disposable
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.ClusterListener
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.storage.{DocumentFactory, ExecutionPlanStore, VFSURIFactory}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  PhysicalPlan,
  PhysicalPlanCodec,
  PlanInput,
  PortIdentity,
  WorkflowContext
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.EXECUTION_FAILURE
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.engine.architecture.coordinator.{
  CoordinatorConfig,
  Workflow => EngineWorkflow
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  KILLED,
  PAUSED,
  READY,
  RUNNING
}
import org.apache.texera.amber.engine.architecture.rpc.coordinatorservice.CoordinatorServiceFs2Grpc
import org.apache.texera.amber.engine.common.Utils
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder}
import org.apache.texera.dao.jooq.generated.Tables.{WORKFLOW_EXECUTIONS, WORKFLOW_OF_USER}
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
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
import org.apache.texera.web.{SessionState, WorkflowLifecycleManager}
import org.apache.texera.web.model.http.request.execution.{
  CreateExecutionRequest,
  OperatorUpdateRequestBody
}
import org.apache.texera.web.model.http.response.execution.CreateExecutionResponse
import org.apache.texera.web.model.websocket.event.{PaginatedResultEvent, TexeraWebSocketEvent}
import org.apache.texera.web.model.websocket.request.{
  HeartBeatRequest,
  OperatorUpdateRequest,
  ResultPaginationRequest,
  TexeraWebSocketRequest,
  WorkflowStartRequest
}
import org.apache.texera.web.service.execution.{CostHintsLoader, ExecutionCreator, OperatorUpdates}
import org.apache.texera.web.service.{
  ExecutionResultService,
  WorkflowExecutionService,
  WorkflowService
}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.scalamock.scalatest.MockFactory
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Seconds, Span}
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}
import org.slf4j.LoggerFactory

import java.lang.reflect.{InvocationHandler, Method, Proxy}
import java.net.URI
import java.sql.{Timestamp => SqlTimestamp}
import java.time.Instant
import java.util.UUID
import java.util.concurrent.{Future => JFuture}
import javax.websocket.{RemoteEndpoint, Session}
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters.{
  IteratorHasAsScala,
  ListHasAsScala,
  MapHasAsJava,
  SeqHasAsJava
}
import scala.reflect.ClassTag
import scala.util.Try

/**
  * Unit tests for the websocket endpoint's message handling.
  *
  * The endpoint itself is thin, but three pieces of it are real logic that nothing else guards:
  *
  *   - the write-access gate. A heartbeat and a read of results are open to every session; every
  *     other request changes a run, and is its sender's to make only with WRITE on the socket's
  *     computing unit, the privilege `myOnOpen` parsed off the handshake. The gate cannot fire in
  *     single-node mode, where `ServletAwareConfigurator` hard-codes WRITE, but is live under
  *     Kubernetes, where the privilege comes from the `x-user-computing-unit-access` header. The
  *     requests it covers are checked against the mapper's registry, so a request type added
  *     later has to be placed on one side of the gate here.
  *   - what becomes of a frame that is not done. A frame that binds to no request, a request that
  *     is refused and a request that fails are each answered to the session that sent them, and
  *     to it alone, with a `RequestRefusedEvent`: nothing is written into the run in flight,
  *     which every session on the workflow sees, and nothing is thrown, which would have the
  *     container close the session.
  *   - the three-state distinction every command to a run has to make: no workflow, a workflow
  *     with no run yet, and a held run. `executionService` is a `BehaviorSubject` created without
  *     an initial value, so `getValue` is null until one is published, and reading it through
  *     `workflow.map(...)` yields `Some(null)` — a shape that slips past a `case None` guard and
  *     NPEs on the next dereference. The middle state is the only input that tells the workflow
  *     apart from its run, so it is what pins the guard's condition.
  *
  * The cases of a single session drive a mocked `javax.websocket.Session` (the pattern
  * `CollaborationResourceSpec` established) and register a `SessionState` directly, on a
  * workflow service that subscribes nothing, so no real workflow is created.
  *
  * The cases that show what reaches the other sessions on a workflow, starting an execution the
  * Dashboard created (`WorkflowStartRequest`), killing its run (`WorkflowKillRequest`) and
  * applying a change it stored (`OperatorUpdateRequest`) among them, need more: each execution is
  * created by `ExecutionCreator`, its rows in `MockTexeraDB` and its plan in the catalog the
  * build's tests use (the Postgres JDBC catalog in CI), and is started on a `WorkflowService`
  * whose sessions are subscribed for real, so a session other than the sender's shows what
  * reaches the workflow and what does not. Only the engine is a `TestAmberClient` on this suite's
  * actor system, which answers nothing. Its coordinator tells every registered session of its
  * regions (`RegionUpdateEvent`) once it is up, so the cases that build one wait for that before
  * they end. A refused start is checked to reach its sender alone, to send no statement to the
  * database, and to leave the run in flight as it was; a frame that does not bind too. A start
  * over a socket whose URI carries the user's access token, as a browser's does, is checked to
  * log no line naming it.
  *
  * Deliberately not covered, because each would pin an accidental failure rather than a contract:
  *   - `myOnOpen`'s missing-`wid`/`cuid` and bogus-privilege paths, which fail with NPE /
  *     IndexOutOfBounds / IllegalArgumentException. A harmless improvement (a default, or a clear
  *     message) would break such a test.
  *   - `ResultPaginationRequest`'s real payload, which needs a DB; only the request/response
  *     pass-through is asserted here, against a stubbed result service.
  *   - what the mapper itself accepts and rejects, already owned by `TexeraWebSocketRequestSpec`;
  *     the malformed-frame cases here are about the endpoint's handling, not the binding rules.
  *   - what a command does once the run takes it, owned by `ExecutionRuntimeServiceSpec`. Only a
  *     kill is followed through here, to what every session is told and the execution's row.
  */
class WorkflowWebsocketResourceSpec
    extends TestKit(ActorSystem("WorkflowWebsocketResourceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with MockFactory
    with Eventually
    with BeforeAndAfterEach
    with BeforeAndAfterAll
    with MockTexeraDB {

  private var resource: WorkflowWebsocketResource = _
  private val registeredSessions = ArrayBuffer[String]()

  override protected def beforeEach(): Unit = {
    resource = new WorkflowWebsocketResource()
  }

  // SessionState's registry is a JVM-global map. Remove only the ids this test registered, so the
  // suite cannot disturb (or be disturbed by) SessionStateSpec running in the same JVM.
  //
  // Best-effort: `getState` throws NoSuchElementException on an id that is already gone, and the
  // myOnClose test removes its own entry by design.
  //
  // This runs the real production teardown — `removeState` disposes the session's rx subscriptions
  // and calls `WorkflowService.disconnect` — rather than swapping in a workflow-less stand-in
  // first. That matters: a swap removes the registry entry but leaves the ORIGINAL state's
  // subscription undisposed, so the mock session stays reachable from the workflow's state store
  // for the life of the JVM. The reason a swap looked necessary is that `disconnect` drops the user
  // count to zero and reaches `AmberRuntime.scheduleCallThroughActorSystem`, whose actor system is
  // null in a unit JVM; the myOnOpen tests take a user count of their own on the service they
  // create precisely so that this call never reaches zero. See `holdWorkflowService`.
  override protected def afterEach(): Unit = {
    registeredSessions.foreach { id =>
      scala.util.Try(SessionState.removeState(id))
      // Checked, not assumed. `removeState` unsubscribes BEFORE it removes, so anything that throws
      // in `unsubscribe` — a user count reaching zero and touching the null actor system being the
      // one that bites here — leaves the mock session in the JVM-global registry for the rest of
      // the run, where a later suite's cluster broadcast would call an expired mock.
      withClue(s"session $id was still registered after afterEach: ") {
        scala.util.Try(SessionState.getState(id)).isFailure shouldBe true
      }
    }
    registeredSessions.clear()
  }

  /**
    * Returns the shared `WorkflowService` for `wid`, creating it if needed, and takes a user count
    * on it that is never released.
    *
    * Two things follow, both wanted. `myOnOpen` must JOIN this instance rather than build its own,
    * which is what makes the identity assertions below meaningful; and the count never reaches zero
    * in `afterEach`, so the real teardown can run without touching a null actor system.
    *
    * The cost is one `WorkflowService` per wid left in `WorkflowService.workflowServiceMapping` with
    * a user count of 1 for the life of the JVM. Nothing test-scoped is reachable from it once the
    * session is removed, and the wid namespace 9701xx is reserved for this suite — note that
    * `getOrCreate` keys that map on the workflow id ALONE (`mkWorkflowStateId`), so a sibling suite
    * reusing one of these ids would silently get this instance back.
    */
  private def holdWorkflowService(wid: Long, cuid: Int): WorkflowService = {
    val service = WorkflowService.getOrCreate(WorkflowIdentity(wid), cuid)
    service.lifeCycleManager.increaseUserCount()
    service
  }

  /**
    * A mocked session. `sent` collects everything the endpoint writes back, which is the only
    * observable for most of these handlers.
    */
  private def mockSession(
      id: String = UUID.randomUUID().toString,
      uid: Option[Int] = None,
      cuAccess: String = PrivilegeEnum.WRITE.name(),
      wid: Long = 1L,
      cuid: Int = 1,
      requestUri: URI = new URI("ws://localhost/wsapi/workflow-websocket")
  ): (Session, ArrayBuffer[String]) = {
    val sent = ArrayBuffer[String]()

    val async = mock[RemoteEndpoint.Async]
    (async
      .sendText(_: String))
      .expects(*)
      .onCall { (text: String) =>
        sent += text
        null.asInstanceOf[JFuture[Void]]
      }
      .anyNumberOfTimes()

    val properties = new java.util.HashMap[String, Object]()
    properties.put(HeaderField.UserComputingUnitAccess, cuAccess)
    uid.foreach { u =>
      val user = new User()
      user.setUid(Integer.valueOf(u))
      properties.put(classOf[User].getName, user)
    }

    // What `myOnOpen` parses the workflow and computing-unit ids out of.
    val parameters: java.util.Map[String, java.util.List[String]] =
      Map("wid" -> Seq(wid.toString).asJava, "cuid" -> Seq(cuid.toString).asJava).asJava

    val session = mock[Session]
    (() => session.getId).expects().returning(id).anyNumberOfTimes()
    (() => session.getAsyncRemote).expects().returning(async).anyNumberOfTimes()
    (() => session.getUserProperties).expects().returning(properties).anyNumberOfTimes()
    (() => session.getRequestParameterMap).expects().returning(parameters).anyNumberOfTimes()
    (() => session.getRequestURI)
      .expects()
      .returning(requestUri)
      .anyNumberOfTimes()

    (session, sent)
  }

  /**
    * Registers a SessionState for `session` and remembers it for cleanup. `cuid` is the unit the
    * socket was opened for, as `myOnOpen` records it.
    */
  private def registerState(
      session: Session,
      access: PrivilegeEnum,
      cuid: Option[Int] = None
  ): SessionState = {
    val state = new SessionState(session)
    state.setUserComputingUnitAccess(access)
    cuid.foreach(state.setComputingUnitId)
    SessionState.setState(session.getId, state)
    registeredSessions += session.getId
    state
  }

  /**
    * Stands in for a real WorkflowService. Overriding the three subscription members keeps the
    * lifecycle manager out of it: a real `disconnect()` drops the user count to zero and reaches
    * `AmberRuntime.scheduleCallThroughActorSystem`, whose actor system is null in a unit JVM.
    */
  private class TestWorkflowService(id: Long) extends WorkflowService(WorkflowIdentity(id), 1, 10) {
    val results = new StubResultService(workflowId, computingUnitId, stateStore)
    override val resultService: ExecutionResultService = results

    override def connect(onNext: TexeraWebSocketEvent => Unit): Disposable = Disposable.empty()
    override def connectToExecution(onNext: TexeraWebSocketEvent => Unit): Disposable =
      Disposable.empty()
    override def disconnect(): Unit = ()
  }

  /**
    * The real `handleResultPagination` resolves the latest execution out of the database and opens
    * an Iceberg document; the endpoint's own contribution is only that the request travels in and
    * the returned event travels back out. The echoed fields make both directions observable.
    *
    * The table and schema carry values on purpose. Production ships a companion
    * `PaginatedResultEvent(req, table, schema)` that rebuilds requestID/operatorID/pageIndex FROM the
    * request, so an endpoint that called the service and then constructed its own event would match
    * on those three fields anyway. These two payload fields are the only ones that can only have
    * come from the returned event.
    */
  private class StubResultService(
      workflowId: WorkflowIdentity,
      computingUnitId: Int,
      stateStore: WorkflowStateStore
  ) extends ExecutionResultService(workflowId, computingUnitId, stateStore) {
    var captured: Option[ResultPaginationRequest] = None

    /** When set, every read fails with what it makes, as the real one fails when its storage does. */
    var failWith: Option[() => Throwable] = None

    override def handleResultPagination(request: ResultPaginationRequest): TexeraWebSocketEvent = {
      captured = Some(request)
      failWith.foreach(failure => throw failure())
      PaginatedResultEvent(
        request.requestID,
        request.operatorID,
        request.pageIndex,
        List(objectMapper.createObjectNode().put("c", 5)),
        List(new Attribute("c", AttributeType.INTEGER)),
        request.portIndex,
        1
      )
    }
  }

  /**
    * A run that was never started, built the way `WorkflowExecutionServiceSpec` and
    * `WorkflowServiceSpec` do: construction does no external work, so the result service can be
    * null.
    */
  private def newExecution(): WorkflowExecutionService =
    new WorkflowExecutionService(
      new WorkflowContext(),
      null,
      new ExecutionStateStore(),
      (_: Throwable) => (),
      None
    )

  /** A session state holding `workflow`, with `execution` published into it when given. */
  private def attach(
      session: Session,
      access: PrivilegeEnum,
      workflow: TestWorkflowService,
      execution: Option[WorkflowExecutionService] = None
  ): SessionState = {
    val state = registerState(session, access)
    state.subscribe(workflow)
    execution.foreach(workflow.executionService.onNext)
    state
  }

  private def frameOf(request: TexeraWebSocketRequest): String =
    objectMapper.writeValueAsString(request)

  private val paginationFrame =
    """{"type":"ResultPaginationRequest","requestID":"req-77","operatorID":"op-88",
      |"pageIndex":3,"pageSize":25}""".stripMargin

  /**
    * A frame of each command to a run, by its type: every request but a heartbeat, a read of
    * results, a start and a change to an operator. Each carries a payload where its type has one.
    */
  private val commandFrames: Seq[(String, String)] = Seq(
    "WorkflowPauseRequest" -> """{"type":"WorkflowPauseRequest"}""",
    "WorkflowResumeRequest" -> """{"type":"WorkflowResumeRequest"}""",
    "WorkflowKillRequest" -> """{"type":"WorkflowKillRequest"}""",
    "WorkflowCheckpointRequest" -> """{"type":"WorkflowCheckpointRequest"}""",
    "RetryRequest" -> """{"type":"RetryRequest","workers":["worker-a","worker-b"]}""",
    "SkipTupleRequest" -> """{"type":"SkipTupleRequest","workerIds":["worker-a"]}""",
    "DebugCommandRequest" ->
      """{"type":"DebugCommandRequest","operatorId":"op-dbg","workerId":"worker-a","cmd":"n"}""",
    "PythonExpressionEvaluateRequest" ->
      """{"type":"PythonExpressionEvaluateRequest","expression":"len(tuple_)","operatorId":"op-eval"}"""
  )

  /** The `type` discriminator of each frame the endpoint wrote back. */
  private def sentTypes(sent: ArrayBuffer[String]): Seq[String] =
    sent.toSeq.map(objectMapper.readTree(_).get("type").asText())

  private def fatalErrorMessages(sent: ArrayBuffer[String]): Seq[String] =
    sent.toSeq
      .map(objectMapper.readTree)
      .filter(_.get("type").asText() == "WorkflowErrorEvent")
      .flatMap(_.get("fatalErrors").elements().asScala)
      .map(_.get("message").asText())

  /**
    * Fails unless `sent` holds one frame: the answer to a request that was not done, which says
    * `why` and names the type of the request and the execution it named, where it named them.
    */
  private def assertRefused(
      sent: ArrayBuffer[String],
      why: String,
      request: Option[String],
      executionId: Option[Long] = None
  ): Unit = {
    sentTypes(sent) shouldBe Seq("RequestRefusedEvent")
    val refusal = objectMapper.readTree(sent.head)
    refusal.get("message").asText() shouldBe why
    Option(refusal.get("request")).map(_.asText()) shouldBe request
    Option(refusal.get("executionId")).map(_.asLong()) shouldBe executionId
    // Nothing else: a client reads no error of a run out of it.
    refusal.fieldNames().asScala.toSet shouldBe
      Set("type", "message") ++ request.map(_ => "request") ++ executionId.map(_ => "executionId")
  }

  // -- heartbeat ----------------------------------------------------------------

  "myOnMsg" should "answer a heartbeat without needing a workflow, or WRITE on the unit" in {
    val (session, sent) = mockSession()
    registerState(session, PrivilegeEnum.READ)

    resource.myOnMsg(session, frameOf(HeartBeatRequest()))

    sentTypes(sent) shouldBe Seq("HeartBeatResponse")
  }

  // -- pagination ---------------------------------------------------------------

  it should "answer a pagination request with what the result service returns, without WRITE on the unit" in {
    val (session, sent) = mockSession()
    val workflow = new TestWorkflowService(9104L)
    // READ: a read of results changes no run, so the write-access gate does not cover it.
    attach(session, PrivilegeEnum.READ, workflow)

    resource.myOnMsg(session, paginationFrame)

    // Four distinct field values, so the request cannot have been rebuilt from defaults on the way
    // in; the endpoint has to pass the deserialized one straight through.
    val captured =
      workflow.results.captured.getOrElse(fail("no request reached the result service"))
    captured.requestID shouldBe "req-77"
    captured.operatorID shouldBe "op-88"
    captured.pageIndex shouldBe 3
    captured.pageSize shouldBe 25

    sentTypes(sent) shouldBe Seq("PaginatedResultEvent")
    val event = objectMapper.readTree(sent.head)
    event.get("requestID").asText() shouldBe "req-77"
    event.get("operatorID").asText() shouldBe "op-88"
    event.get("pageIndex").asInt() shouldBe 3
    // The other direction, and the half the three fields above cannot see: those are all
    // reconstructible from the request, and production has a `PaginatedResultEvent(req, ...)`
    // companion that does exactly that. The table and schema exist only in the event the service
    // returned, so they are what proves the endpoint forwards the RETURN VALUE.
    event.get("table").get(0).get("c").asInt() shouldBe 5
    event.get("schema").get(0).get("attributeName").asText() shouldBe "c"
  }

  it should "ignore a pagination request that arrives before any workflow is attached" in {
    // `workflow.foreach(...)`, observed empty. Replacing that with `workflow.get.resultService...`
    // throws NoSuchElementException here, which the endpoint answers as a request that failed —
    // so the assertion bites.
    val (session, sent) = mockSession()
    registerState(session, PrivilegeEnum.WRITE)

    noException should be thrownBy resource.myOnMsg(session, paginationFrame)

    sent shouldBe empty
  }

  // -- a request that fails -----------------------------------------------------

  it should "answer a request that fails to its sender alone, with the failure, leaving the run in flight as it was" in {
    // A read of results fails when its storage does, or when the results are in a warehouse this
    // deployment no longer serves. The session that asked is told the failure in its own words,
    // so the refusal of a disabled warehouse reaches it; the run in flight, which the read was
    // of, is not touched, and the session stays open.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9105L)
    val execution = newExecution()
    attach(session, PrivilegeEnum.READ, workflow, Some(execution))
    val store = execution.executionStateStore.metadataStore
    store.updateState(
      _.withState(RUNNING).addFatalErrors(
        WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), "runtime failure", "", "op-b")
      )
    )
    val inFlight = store.getState
    workflow.results.failWith = Some(() =>
      new IllegalStateException("the results are in a warehouse this deployment does not serve")
    )

    val logLines = texeraLogLinesOf {
      noException should be thrownBy resource.myOnMsg(session, paginationFrame)
    }

    assertRefused(
      sent,
      "The request failed on this computing unit: the results are in a warehouse this " +
        "deployment does not serve",
      request = Some("ResultPaginationRequest")
    )
    // Where it failed is for the unit's log, not for the session.
    logLines.count(_.contains("A ResultPaginationRequest failed.")) shouldBe 1
    store.getState shouldBe inFlight
  }

  it should "name the kind of a failure that has no words of its own" in {
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9106L)
    attach(session, PrivilegeEnum.READ, workflow)
    workflow.results.failWith = Some(() => new NoSuchElementException)

    noException should be thrownBy resource.myOnMsg(session, paginationFrame)

    assertRefused(
      sent,
      "The request failed on this computing unit: NoSuchElementException",
      request = Some("ResultPaginationRequest")
    )
  }

  // -- frames that bind to no request -------------------------------------------

  it should "answer a frame that binds to no request to its sender alone, writing nothing and leaving the run in flight as it was" in {
    // A stale or typo'd client. The mapper's own rejections are pinned by
    // `TexeraWebSocketRequestSpec`; what this asserts is what the endpoint makes of them. The type
    // the frame claims reaches the client, when it reads as a type's name: a generic "bad frame"
    // would leave a stale frontend with nothing to debug against. The mapper's own words, which
    // quote the frame, reach neither the client nor the log.
    // Each frame, with the type it says it is, when it says one that reads as a type's name.
    val frames: Seq[(String, String, Option[String])] = Seq(
      ("an unknown type", """{"type":"NoSuchWebSocketRequest"}""", Some("NoSuchWebSocketRequest")),
      (
        "a logical plan to compile and run, which a unit does not take",
        """{"type":"WorkflowExecuteRequest","executionName":"exec","engineVersion":"v",
          |"logicalPlan":{"operators":[{"operatorType":"Limit","limit":7,"password":"hunter2"}],
          |"links":[],"opsToViewResult":[],"opsToReuseResult":[]},"workflowSettings":{},
          |"emailNotificationEnabled":false,"computingUnitId":1}""".stripMargin,
        Some("WorkflowExecuteRequest")
      ),
      (
        "an operator to change, sent whole, which a unit does not take",
        """{"type":"ModifyLogicRequest","operator":{"operatorType":"Limit","limit":7}}""",
        Some("ModifyLogicRequest")
      ),
      (
        // As the shipped client sends it: `workers`, where the request declares `workerIds`.
        "a known type whose fields do not bind",
        """{"type":"SkipTupleRequest","workers":["worker-a"]}""",
        Some("SkipTupleRequest")
      ),
      ("no type", """{"requestID":"req-1","operatorID":"op-2"}""", None),
      ("a type that is not text", """{"type":7}""", None),
      (
        "a type that does not read as a type's name",
        """{"type":"WorkflowPauseRequest\nand a line of its own"}""",
        None
      ),
      ("a type longer than any type's name", s"""{"type":"${"R" * 65}"}""", None),
      ("JSON that is no object", "null", None),
      ("no JSON at all", "pause the workflow", None),
      ("an empty frame", "", None)
    )
    val service = new StoredStartService
    try {
      val inFlight = runInFlight(service)
      val inFlightState = inFlight.executionStateStore.metadataStore.getState
      val commands = ArrayBuffer.empty[TexeraWebSocketRequest]
      inFlight.wsInput.subscribe[TexeraWebSocketRequest]((request, _) => commands += request)
      val (session, sent) = sessionOn(service)
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      frames.foreach {
        case (name, frame, kind) =>
          withClue(s"$name: ") {
            sent.clear()
            otherSent.clear()

            var statements: Seq[StatementRecorder.Statement] = Nil
            val logLines = texeraLogLinesOf {
              statements = recorder.record {
                noException should be thrownBy resource.myOnMsg(session, frame)
              }
            }

            statements shouldBe empty
            assertRefused(
              sent,
              kind.fold("The request could not be read.")(kind =>
                s"The request could not be read as a $kind."
              ),
              request = kind
            )
            otherSent shouldBe empty
            commands shouldBe empty
            service.executionService.getValue should be theSameInstanceAs inFlight
            inFlight.executionStateStore.metadataStore.getState shouldBe inFlightState
            logLines.filter(_.contains("hunter2")) shouldBe empty
            logLines.filter(_.contains("and a line of its own")) shouldBe empty
          }
      }
    } finally service.unsubscribeAll()
  }

  // -- the write-access gate ----------------------------------------------------

  it should "refuse every request that changes a run to a session without WRITE on the unit, to that session alone" in {
    // The gate covers every request the mapper registers but the two reads. Checked against the
    // registry, so a request type added later is either refused here or declared a read.
    val changing: Seq[(String, String)] = commandFrames ++ Seq(
      "WorkflowStartRequest" -> frameOf(WorkflowStartRequest(974999L, "vfs:///x")),
      "OperatorUpdateRequest" -> frameOf(OperatorUpdateRequest(974999L, "update-1"))
    )
    val registered = classOf[TexeraWebSocketRequest]
      .getAnnotation(classOf[JsonSubTypes])
      .value()
      .map(_.value().getSimpleName)
      .toSet
    changing.map(_._1).toSet shouldBe registered -- Set(
      "HeartBeatRequest",
      "ResultPaginationRequest"
    )

    val noWriteAccess = "You do not have write access to the computing unit."
    val service = new StoredStartService
    try {
      val inFlight = runInFlight(service)
      val inFlightState = inFlight.executionStateStore.metadataStore.getState
      val commands = ArrayBuffer.empty[TexeraWebSocketRequest]
      inFlight.wsInput.subscribe[TexeraWebSocketRequest]((request, _) => commands += request)
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      // READ is what a unit shared for reading gives; NONE is a session's privilege until one is
      // read off its handshake.
      for (access <- Seq(PrivilegeEnum.READ, PrivilegeEnum.NONE); (kind, frame) <- changing) {
        withClue(s"a $kind with $access: ") {
          val (session, sent) = sessionOn(service, access = access)
          sent.clear()
          otherSent.clear()

          val statements = recorder.record {
            noException should be thrownBy resource.myOnMsg(session, frame)
          }

          statements shouldBe empty
          if (kind == "OperatorUpdateRequest") {
            // Refused as a change that does not apply, which the editor shows as one.
            modifyLogicResponses(sent) shouldBe Seq(("", false, noWriteAccess))
            sent should have size 1
          } else {
            assertRefused(
              sent,
              noWriteAccess,
              request = Some(kind),
              // A start names its execution, which the refusal names in turn.
              executionId = Some(974999L).filter(_ => kind == "WorkflowStartRequest")
            )
          }
          otherSent shouldBe empty
          commands shouldBe empty
          service.executionService.getValue should be theSameInstanceAs inFlight
          inFlight.executionStateStore.metadataStore.getState shouldBe inFlightState
        }
      }
    } finally service.unsubscribeAll()
  }

  // -- commands to the run ------------------------------------------------------

  it should "hand each command of a session with WRITE on to the run's websocket input, with its sender" in {
    commandFrames.foreach {
      case (kind, frame) =>
        withClue(s"a $kind: ") {
          val (session, sent) = mockSession(uid = Some(42))
          val workflow = new TestWorkflowService(9102L)
          val execution = newExecution()
          attach(session, PrivilegeEnum.WRITE, workflow, Some(execution))
          val received = ArrayBuffer.empty[(TexeraWebSocketRequest, Option[Integer])]
          execution.wsInput.subscribe[TexeraWebSocketRequest]((req, uid) =>
            received += ((req, uid))
          )

          resource.myOnMsg(session, frame)

          // The request as it was sent, not a fresh one of its type: the frames that carry a
          // payload are what tell the two apart. `SkipTupleRequest` holds an array, which no
          // `equals` compares by content, so it is compared as it is written.
          received.map(_._1).map(frameOf) shouldBe
            Seq(frameOf(objectMapper.readValue(frame, classOf[TexeraWebSocketRequest])))
          received.head._1.getClass.getSimpleName shouldBe kind
          // Some(42), not None: None is what a missing user-properties entry yields anyway, so
          // asserting it would be green with the whole uid lookup deleted.
          received.head._2 shouldBe Some(Integer.valueOf(42))
          // Handing it on is the whole handling: nothing goes back to the socket.
          sent shouldBe empty
        }
    }
  }

  it should "refuse a command that arrives before any workflow is attached, to its sender" in {
    // Commands go to the run's `wsInput`, which only exists once a run is held. This is the
    // no-workflow state; the workflow-but-no-run state is the next case, and both have to report
    // the same thing.
    val (session, sent) = mockSession(uid = Some(42))
    registerState(session, PrivilegeEnum.WRITE)

    noException should be thrownBy
      resource.myOnMsg(session, """{"type":"WorkflowPauseRequest"}""")

    assertRefused(
      sent,
      "No execution of this workflow is running here.",
      request = Some("WorkflowPauseRequest")
    )
  }

  it should "refuse a command that arrives with a workflow but no run, to its sender" in {
    // The state between no workflow and a held run: a workflow IS attached, but nothing has
    // published a run into it yet. `executionService` is a `BehaviorSubject` created without an
    // initial value, so `getValue` is null, and this is the input that pins how the endpoint
    // reads it: `workflow.map(_.executionService.getValue)` would wrap that null into `Some(null)`
    // and walk straight past the `case None` guard that exists to report this very situation,
    // NPEing on `run.wsInput` instead. The message has to be the same one the no-workflow case
    // above produces: the client cannot act on the difference.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9107L)
    attach(session, PrivilegeEnum.WRITE, workflow)

    noException should be thrownBy
      resource.myOnMsg(session, """{"type":"WorkflowPauseRequest"}""")

    assertRefused(
      sent,
      "No execution of this workflow is running here.",
      request = Some("WorkflowPauseRequest")
    )
  }

  // -- session lifecycle --------------------------------------------------------

  "myOnOpen" should "bind the session to the requested workflow, computing unit and privilege" in {
    // Two rows, because one cannot tell a real parse from a constant: the ids differ from each
    // other and from 1, and the privilege differs between rows.
    Seq((970101L, 7, PrivilegeEnum.READ), (970102L, 13, PrivilegeEnum.WRITE)).foreach {
      case (wid, cuid, access) =>
        withClue(s"wid=$wid cuid=$cuid access=$access: ") {
          val (session, sent) = mockSession(cuAccess = access.name(), wid = wid, cuid = cuid)
          // The service this call has to JOIN. Created up front so the assertion below can be about
          // instance identity rather than field values.
          val shared = holdWorkflowService(wid, cuid)
          // Registered before the call so afterEach still cleans up if myOnOpen throws.
          registeredSessions += session.getId

          // A sentinel node count, so the event's payload is pinned to the global the endpoint is
          // supposed to read rather than to 0, which is that global's initializer. Restored in a
          // finally, the way ClusterListenerSpec handles the same var — amber serialises its suites
          // (amber/build.sbt: `Tags.limit(Tags.Test, 1)`), so the window is this call alone.
          val previousNodeCount = ClusterListener.numWorkerNodesInCluster
          ClusterListener.numWorkerNodesInCluster = 4242
          try resource.myOnOpen(session, null)
          finally ClusterListener.numWorkerNodesInCluster = previousNodeCount

          val state = SessionState.getState(session.getId)
          // The same INSTANCE, not merely the same ids. `WorkflowService.getOrCreate` is what makes
          // one workflow shared by every client that opens it; `new WorkflowService(...)` in its
          // place would satisfy every field assertion below while silently handing each websocket a
          // private workflow of its own — i.e. deleting multi-user collaboration.
          state.getCurrentWorkflowState.getOrElse(
            fail("no workflow bound")
          ) should be theSameInstanceAs shared
          state.getCurrentWorkflowState.map(s => (s.workflowId.id, s.computingUnitId)) shouldBe
            Some((wid, cuid))
          // READ/WRITE, never NONE: NONE is SessionState's own field default, so feeding it would
          // pass with the privilege never being set at all.
          state.getUserComputingUnitAccess shouldBe access
          // The unit a start over this socket runs on.
          state.getComputingUnitId shouldBe Some(cuid)

          // Ordered, not merely present. The state event is the "hack to refresh frontend run
          // button state" and has to go out before the workflow subscription is established. It
          // is the state of no run, and names no execution: this workflow's service holds none.
          sentTypes(sent) shouldBe Seq("WorkflowStateEvent", "ClusterStatusUpdateEvent")
          objectMapper.readTree(sent.head).get("state").asText() shouldBe "Uninitialized"
          objectMapper.readTree(sent.head).has("executionId") shouldBe false
          objectMapper.readTree(sent(1)).get("numWorkers").asInt() shouldBe 4242
        }
    }
  }

  it should "join a workflow that already exists, ignoring the computing unit it was opened with" in {
    // The cached arm of `getOrCreate`, which the rows above never take. `workflowServiceMapping` is
    // keyed on `mkWorkflowStateId(workflowId)` — the workflow id ALONE — so `computingUnitId` is
    // used only when the entry is constructed and is silently dropped for every later opener.
    //
    // This is characterization, not endorsement: a second websocket asking for the same workflow on
    // a DIFFERENT computing unit is bound to the first one's, with nothing reported. Recorded here
    // because it is the behaviour the endpoint actually has, and because the test above cannot see
    // it — both of its rows construct.
    val existing = holdWorkflowService(wid = 970103L, cuid = 5)
    val (session, _) = mockSession(cuAccess = PrivilegeEnum.WRITE.name(), wid = 970103L, cuid = 99)
    registeredSessions += session.getId

    resource.myOnOpen(session, null)

    val bound = SessionState
      .getState(session.getId)
      .getCurrentWorkflowState
      .getOrElse(fail("no workflow bound"))
    // Identity is the assertion, deliberately: it is what pins the cached arm (keying `getOrCreate`
    // on wid+cuid would construct a second service and fail this). The dropped computing unit id is
    // described above but NOT asserted -- pinning it would turn a defect into a contract and make
    // this spec an obstacle to fixing it.
    bound should be theSameInstanceAs existing
    // The socket keeps its own unit, which a start of an execution over it runs on.
    SessionState.getState(session.getId).getComputingUnitId shouldBe Some(99)
  }

  it should "tell a session that opens on a workflow whose service holds a run which execution it is of" in {
    // A page that did not start the run, as after a reload or in another tab: it is told the
    // run's state as it stands, with the execution, which it needs to change a paused operator.
    val shared = holdWorkflowService(wid = 970104L, cuid = 5)
    val run = newExecution()
    run.workflowContext.executionId = ExecutionIdentity(970199L)
    run.executionStateStore.metadataStore.updateState(_.withState(PAUSED))
    shared.executionService.onNext(run)
    val (session, sent) = mockSession(wid = 970104L, cuid = 5)
    registeredSessions += session.getId

    try resource.myOnOpen(session, null)
    // The service stays in the JVM's registry: left holding a run that has ended, which the
    // cluster's node-failure recovery skips.
    finally run.executionStateStore.metadataStore.updateState(_.withState(COMPLETED))

    // First the state of no run, then the state of the run the service holds.
    val states = sent.toSeq
      .map(objectMapper.readTree)
      .filter(_.get("type").asText() == "WorkflowStateEvent")
      .takeWhile(_.get("state").asText() != "Completed")
    states.map(_.get("state").asText()) shouldBe Seq("Uninitialized", "Paused")
    states.head.has("executionId") shouldBe false
    states(1).get("executionId").asLong() shouldBe 970199L
  }

  "myOnClose" should "drop the state registered under that session id" in {
    val (session, _) = mockSession()
    val state = registerState(session, PrivilegeEnum.WRITE)
    SessionState.getState(session.getId) shouldBe state

    resource.myOnClose(session, null)

    // getState throws once the entry is gone, which is how the endpoint's own handlers would fail
    // if a frame arrived after close.
    a[NoSuchElementException] should be thrownBy SessionState.getState(session.getId)
  }

  // -- starting an execution the Dashboard created ------------------------------

  // Users, workflows and units of the start cases, reserved for this suite (9741xx), with the
  // executions they create after 974000.
  private val creatorUid = 9741
  private val otherUid = 9742
  private val storedWid = 9741L
  private val otherWid = 9742L
  private val storedCuid = 9745
  private val secondCuid = 9746
  private val firstCreatedEid = 974000
  // A format this unit does not read yet: the one after its own.
  private val nextFormat = PhysicalPlanCodec.FormatVersion + 1

  /** Every plan and runtime-statistics table the start cases make, dropped after the suite. */
  private val madePlans = ArrayBuffer.empty[URI]
  private val madeStatistics = ArrayBuffer.empty[URI]

  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    val cfg = getDSLContext.configuration()
    Seq(creatorUid, otherUid).foreach { uid =>
      val user = new User
      user.setUid(Integer.valueOf(uid))
      user.setName(s"websocket-spec-user-$uid")
      user.setEmail(s"websocket-spec-$uid@example.com")
      user.setRole(UserRoleEnum.REGULAR)
      new UserDao(cfg).insert(user)
    }
    Seq(storedWid, otherWid).foreach { wid =>
      val workflow = new Workflow
      workflow.setWid(Integer.valueOf(wid.toInt))
      workflow.setName(s"websocket-spec-workflow-$wid")
      workflow.setContent("{}")
      workflow.setDescription("")
      workflow.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
      workflow.setLastModifiedTime(new SqlTimestamp(System.currentTimeMillis()))
      new WorkflowDao(cfg).insert(workflow)
      val version = new WorkflowVersion
      version.setWid(Integer.valueOf(wid.toInt))
      version.setContent("{}")
      version.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
      new WorkflowVersionDao(cfg).insert(version)
      getDSLContext
        .insertInto(WORKFLOW_OF_USER)
        .set(WORKFLOW_OF_USER.UID, Integer.valueOf(creatorUid))
        .set(WORKFLOW_OF_USER.WID, Integer.valueOf(wid.toInt))
        .execute()
    }
    Seq(storedCuid, secondCuid).foreach { cuid =>
      val unit = new WorkflowComputingUnit
      unit.setCuid(Integer.valueOf(cuid))
      unit.setUid(Integer.valueOf(creatorUid))
      unit.setName(s"websocket-spec-unit-$cuid")
      unit.setCreationTime(new SqlTimestamp(System.currentTimeMillis()))
      unit.setType(WorkflowComputingUnitTypeEnum.local)
      unit.setUri("local://test")
      unit.setResource("{}")
      new WorkflowComputingUnitDao(cfg).insert(unit)
    }
    // Executions created below take ids after this one. The table is qualified from the
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
      madeStatistics.foreach(uri => Try(DocumentFactory.openDocument(uri)._1.clear()))
      TestKit.shutdownActorSystem(system)
    } finally {
      closeConnectionPool()
      super.afterAll()
    }

  private object NoHints extends CostHintsLoader(1) {
    override def load(wid: Long, uid: Int): Option[CostHints] = None
  }

  /** The Dashboard's create, with the fixture bindings and no cost hints. */
  private object FixtureCreator
      extends ExecutionCreator(
        bindingsFor = _ => TestUtils.fixtureBindings,
        replayLogRoot = None,
        warehousesEnabled = false,
        costHints = NoHints,
        background = _.run()
      )

  /** The Dashboard's store of a change to a paused operator, with the fixture bindings. */
  private object FixtureUpdates
      extends OperatorUpdates(
        bindingsFor = _ => TestUtils.fixtureBindings,
        warehousesEnabled = false
      )

  private def userOf(uid: Int): User = {
    val user = new User
    user.setUid(Integer.valueOf(uid))
    user.setEmail(s"websocket-spec-$uid@example.com")
    user
  }

  /** Lines of text into a Limit of 2, which can be changed while the run is paused. */
  private def linesToLimit(): LogicalPlanPojo = {
    val lines = new TextInputSourceOpDesc
    lines.setOperatorId("lines")
    lines.textInput = "a\nb\nc"
    val limit = new LimitOpDesc
    limit.setOperatorId("limit")
    limit.limit = 2
    LogicalPlanPojo(
      List(lines, limit),
      List(
        LogicalLink(
          lines.operatorIdentifier,
          PortIdentity(),
          limit.operatorIdentifier,
          PortIdentity()
        )
      ),
      List.empty,
      List.empty
    )
  }

  /** An execution of `storedWid` the creator created at the Dashboard for `storedCuid`. */
  private def created(): CreateExecutionResponse = {
    val response = FixtureCreator
      .create(
        CreateExecutionRequest(
          wid = storedWid,
          engineVersion = "1.4.0-spec",
          logicalPlan = linesToLimit(),
          workflowSettings = None,
          computingUnitId = storedCuid,
          warehouseId = None,
          replayFromExecution = None
        ),
        userOf(creatorUid),
        new URI("http://texera.example/api/executions")
      )
    madePlans += new URI(response.planUri)
    madeStatistics += VFSURIFactory.createRuntimeStatisticsURI(
      WorkflowIdentity(storedWid),
      ExecutionIdentity(response.eid)
    )
    response
  }

  /** Writes the plan row at `planUri` again, with the body `change` makes of its own. */
  private def rewritePlan(planUri: URI, change: String => String): Unit = {
    val (record, logical) = ExecutionPlanStore.readPlanWithLogical(planUri)
    ExecutionPlanStore.writePlan(planUri, record.copy(body = change(record.body)), logical)
  }

  /**
    * An engine on this suite's actor system that answers nothing: the run it is built for is set
    * up in full, every service around its plan, and never starts.
    */
  private final class TestAmberClient
      extends AmberClient(
        system,
        new WorkflowContext(),
        PhysicalPlan(Set.empty, Set.empty),
        CoordinatorConfig(None, None, None, None),
        _ => ()
      ) {
    override def registerCallback[T](callback: T => Unit)(implicit ct: ClassTag[T]): Disposable =
      Disposable.empty()

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
                case _          => Promise[Any]()
              }
          }
        )
        .asInstanceOf[CoordinatorServiceFs2Grpc[Future, Unit]]
  }

  /**
    * The workflow's service, as `getOrCreate` makes one for the first session on `serviceCuid`,
    * but for the engine of each run, which is a [[TestAmberClient]], and for the idle clean-up,
    * which it never arms. Sessions subscribe to it for real.
    */
  private class StoredStartService(serviceCuid: Int = storedCuid)
      extends WorkflowService(WorkflowIdentity(storedWid), serviceCuid, 3600) {
    override val lifeCycleManager: WorkflowLifecycleManager =
      new WorkflowLifecycleManager("WorkflowWebsocketResourceSpec", 3600, () => ()) {
        override def increaseUserCount(): Unit = ()
        override def decreaseUserCount(state: Option[WorkflowAggregatedState]): Unit = ()
        override def registerCleanUpOnStateChange(stateStore: ExecutionStateStore): Disposable =
          Disposable.empty()
      }

    /** The workflow each run's engine was handed. */
    val engines: ArrayBuffer[EngineWorkflow] = ArrayBuffer.empty

    /** The unit each start by id was asked with. */
    val asked: ArrayBuffer[Int] = ArrayBuffer.empty

    override def startStoredExecution(
        executionId: Long,
        planUri: URI,
        user: User,
        cuid: Int
    ): Either[String, WorkflowExecutionService] = {
      asked += cuid
      super.startStoredExecution(executionId, planUri, user, cuid)
    }

    override protected def storedRun(
        context: WorkflowContext,
        executionStateStore: ExecutionStateStore,
        errorHandler: Throwable => Unit
    ): WorkflowExecutionService =
      new WorkflowExecutionService(
        context,
        resultService,
        executionStateStore,
        errorHandler,
        Some(TestUtils.fixtureUnitMountRoot)
      ) {
        override protected def createAmberRuntime(
            workflow: EngineWorkflow,
            coordinatorConfig: CoordinatorConfig
        ): AmberClient = {
          engines += workflow
          new TestAmberClient
        }
      }
  }

  /** A session of `uid` on `service`'s workflow and `cuid`, subscribed to it. */
  private def sessionOn(
      service: WorkflowService,
      uid: Option[Int] = Some(creatorUid),
      access: PrivilegeEnum = PrivilegeEnum.WRITE,
      cuid: Int = storedCuid,
      requestUri: URI = new URI("ws://localhost/wsapi/workflow-websocket")
  ): (Session, ArrayBuffer[String]) = {
    val (session, sent) =
      mockSession(uid = uid, wid = storedWid, cuid = cuid, requestUri = requestUri)
    registerState(session, access, Some(cuid)).subscribe(service)
    (session, sent)
  }

  private def startFrame(executionId: Long, planUri: String): String =
    frameOf(WorkflowStartRequest(executionId, planUri))

  /** Each state the session was told, with the execution it was told the state is of. */
  private def stateEvents(sent: ArrayBuffer[String]): Seq[(String, Option[Long])] =
    sent.toSeq
      .map(objectMapper.readTree)
      .filter(_.get("type").asText() == "WorkflowStateEvent")
      .map(event => (event.get("state").asText(), Option(event.get("executionId")).map(_.asLong())))

  /** Waits until the coordinator of a run just built has told `sent`'s session of its regions. */
  private def awaitEngineUp(sent: ArrayBuffer[String]): Unit =
    eventually(timeout(Span(30, Seconds))) {
      sentTypes(sent) should contain("RegionUpdateEvent")
    }

  /**
    * A run of another execution of the workflow (974999), in flight on `service`. It never built
    * its engine.
    */
  private def runInFlight(service: WorkflowService): WorkflowExecutionService = {
    val run = newExecution()
    run.workflowContext.executionId = ExecutionIdentity(974999L)
    run.executionStateStore.metadataStore.updateState(
      _.withExecutionId(ExecutionIdentity(974999L)).withState(RUNNING)
    )
    service.executionService.onNext(run)
    run
  }

  /** Each `ModifyLogicResponse` the session was sent, as (opId, isValid, errorMessage). */
  private def modifyLogicResponses(sent: ArrayBuffer[String]): Seq[(String, Boolean, String)] =
    sent.toSeq
      .map(objectMapper.readTree)
      .filter(_.get("type").asText() == "ModifyLogicResponse")
      .map(response =>
        (
          response.get("opId").asText(),
          response.get("isValid").asBoolean(),
          response.get("errorMessage").asText()
        )
      )

  /** A browser's access token, as it opens a socket with it in the URI's query. */
  private val accessToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3ZWJzb2NrZXQtc3BlYyJ9.c2lnbmF0dXJl"

  /**
    * Runs `body` and answers what it ran with: the lines Texera's own loggers wrote meanwhile,
    * every level, from any thread, each with the message of what it logged as its cause.
    */
  private def texeraLogLinesOf(body: => Unit): Seq[String] = {
    val logger = LoggerFactory.getLogger("org.apache.texera").asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val previousLevel = logger.getLevel
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.ALL)
    try {
      body
      appender.list.asScala.toList.map { event =>
        event.getFormattedMessage +
          Option(event.getThrowableProxy).fold("")(cause => s" ${cause.getMessage}")
      }
    } finally {
      logger.setLevel(previousLevel)
      logger.detachAppender(appender)
      appender.stop()
    }
  }

  "WorkflowStartRequest" should
    "start the execution from its stored plan, for every session on the workflow, on the socket's unit" in {
    val execution = created()
    // A service made for another unit, as the workflow's first session on that unit leaves one
    // (#7676): the run is on the unit of the socket the start came over, which the execution was
    // created for.
    val service = new StoredStartService(serviceCuid = secondCuid)
    try {
      val socketUri = new URI(
        s"ws://localhost:8085/wsapi/workflow-websocket?wid=$storedWid&uid=$creatorUid" +
          s"&cuid=$storedCuid&access-token=$accessToken"
      )
      val (session, sent) = sessionOn(service, requestUri = socketUri)
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      sent.clear()
      otherSent.clear()

      val logLines = texeraLogLinesOf {
        resource.myOnMsg(session, startFrame(execution.eid, execution.planUri))
        awaitEngineUp(sent)
        awaitEngineUp(otherSent)
      }

      val planUri = new URI(execution.planUri)
      ExecutionPlanStore.isStarted(planUri) shouldBe true
      // The run is set up in full on the plan read back, and READY: every session is told so.
      val run = service.executionService.getValue
      run.workflowContext.executionId shouldBe ExecutionIdentity(execution.eid)
      run.executionStateStore.metadataStore.getState.state shouldBe READY
      // Each is told which execution the run is of, the session that did not start it too.
      stateEvents(sent) shouldBe Seq(("Initializing", Some(execution.eid)))
      stateEvents(otherSent) shouldBe Seq(("Initializing", Some(execution.eid)))
      fatalErrorMessages(sent) shouldBe empty
      // The start was asked with the socket's unit. The socket's URI holds the user's access
      // token in its query: no line logged names the token.
      service.asked shouldBe Seq(storedCuid)
      logLines.count(_.contains(s"Asked to start execution ${execution.eid}.")) shouldBe 1
      val startLine =
        s"Execution ${execution.eid} of workflow $storedWid starts on computing unit $storedCuid"
      logLines.count(_.contains(startLine)) shouldBe 1
      logLines.filter(_.contains(accessToken)) shouldBe empty
      logLines.filter(_.contains("access-token")) shouldBe empty
      // The engine is handed the plan the Dashboard stored, under the context it was read back
      // with.
      service.engines should have size 1
      val engine = service.engines.head
      service.computingUnitId shouldBe secondCuid
      engine.context.executionId shouldBe ExecutionIdentity(execution.eid)
      val stored = PhysicalPlanCodec
        .decode(PhysicalPlanCodec.fromJson(ExecutionPlanStore.readPlan(planUri).body))
        .plan
      engine.physicalPlan.operators.map(op => (op.id, op.opExecInitInfo)) shouldBe
        stored.operators.map(op => (op.id, op.opExecInitInfo))
      engine.physicalPlan.links shouldBe stored.links
      engine.physicalPlan.operators.map(_.id.logicalOpId.id) shouldBe Set("lines", "limit")
    } finally service.unsubscribeAll()
  }

  it should "refuse a start to its sender alone, writing nothing and leaving the run in flight as it was" in {
    val execution = created()
    val unknownFormat = created()
    val unknownFormatUri = new URI(unknownFormat.planUri)
    rewritePlan(
      unknownFormatUri,
      _.replaceFirst(
        s""""formatVersion": ${PhysicalPlanCodec.FormatVersion},""",
        s""""formatVersion": $nextFormat,"""
      )
    )
    val noPlanUri = ExecutionPlanStore
      .planUri(WorkflowIdentity(storedWid), ExecutionIdentity(firstCreatedEid - 1L), None)
    // An execution whose plan table holds the plan of another execution.
    val mislabeled = created()
    val mislabeledUri = new URI(mislabeled.planUri)
    rewritePlan(mislabeledUri, _ => ExecutionPlanStore.readPlan(new URI(execution.planUri)).body)
    // An execution whose plan reads a file through a link that expired long ago, encoded by hand:
    // the Dashboard makes no link that has expired.
    val expired = created()
    val expiredUri = new URI(expired.planUri)
    val expiry = 1000L
    rewritePlan(
      expiredUri,
      body =>
        PhysicalPlanCodec.toJson(
          PhysicalPlanCodec.encode(
            PhysicalPlanCodec
              .decode(PhysicalPlanCodec.fromJson(body))
              .copy(inputs = Seq(PlanInput(OperatorIdentity("lines"), "lines.txt", expiry)))
          )
        )
    )

    /**
      * A start that is refused, saying `why`: the frame, and who sends it over which socket.
      *
      * @param names the execution the refusal names: the one the start names, when its frame binds
      */
    case class Refused(
        name: String,
        frame: String,
        why: String,
        uid: Option[Int] = Some(creatorUid),
        access: PrivilegeEnum = PrivilegeEnum.WRITE,
        cuid: Int = storedCuid,
        names: Option[Long] = Some(execution.eid)
    )
    val refusals = Seq(
      Refused(
        "no write access",
        startFrame(execution.eid, execution.planUri),
        "You do not have write access to the computing unit.",
        access = PrivilegeEnum.READ
      ),
      Refused(
        "no user",
        startFrame(execution.eid, execution.planUri),
        "A signed-in user is required to start an execution.",
        uid = None
      ),
      Refused(
        "not a plan",
        startFrame(execution.eid, s"vfs:///wid/$storedWid/eid/${execution.eid}/result"),
        "The request does not name an execution's plan."
      ),
      Refused(
        "no URI",
        s"""{"type":"WorkflowStartRequest","executionId":${execution.eid},"planUri":"::"}""",
        "The request does not name an execution's plan."
      ),
      // Frames that do not bind.
      Refused(
        "no execution id",
        s"""{"type":"WorkflowStartRequest","executionId":"abc","planUri":"${execution.planUri}"}""",
        "The request could not be read as a WorkflowStartRequest.",
        names = None
      ),
      Refused(
        "a plan table that is not a string",
        s"""{"type":"WorkflowStartRequest","executionId":${execution.eid},"planUri":{"x":1}}""",
        "The request could not be read as a WorkflowStartRequest.",
        names = None
      ),
      Refused(
        "another execution's plan",
        startFrame(execution.eid, unknownFormat.planUri),
        s"The plan is execution ${unknownFormat.eid}'s, not ${execution.eid}'s."
      ),
      Refused(
        "another workflow's plan",
        startFrame(
          execution.eid,
          ExecutionPlanStore
            .planUri(WorkflowIdentity(otherWid), ExecutionIdentity(execution.eid), None)
            .toString
        ),
        s"The plan belongs to workflow $otherWid, not to this one."
      ),
      Refused(
        "another user's warehouse",
        startFrame(
          execution.eid,
          ExecutionPlanStore
            .planUri(
              WorkflowIdentity(storedWid),
              ExecutionIdentity(execution.eid),
              Some(s"user-$otherUid-1")
            )
            .toString
        ),
        "The plan is in another user's warehouse."
      ),
      Refused(
        "the user's own warehouse, which this deployment does not serve",
        startFrame(
          execution.eid,
          ExecutionPlanStore
            .planUri(
              WorkflowIdentity(storedWid),
              ExecutionIdentity(execution.eid),
              Some(s"user-$creatorUid-1")
            )
            .toString
        ),
        s"Execution ${execution.eid} keeps its plan in warehouse 'user-$creatorUid-1', and " +
          "per-user warehouses are disabled in this deployment."
      ),
      Refused(
        "no stored plan",
        startFrame(firstCreatedEid - 1L, noPlanUri.toString),
        s"Execution ${firstCreatedEid - 1} has no stored plan.",
        names = Some(firstCreatedEid - 1L)
      ),
      Refused(
        "another format",
        startFrame(unknownFormat.eid, unknownFormat.planUri),
        s"The plan is in format version $nextFormat, but this reader reads version " +
          s"${PhysicalPlanCodec.FormatVersion}.",
        names = Some(unknownFormat.eid)
      ),
      Refused(
        "another user",
        startFrame(execution.eid, execution.planUri),
        s"Only the user who created execution ${execution.eid} may start it.",
        uid = Some(otherUid)
      ),
      Refused(
        "another unit",
        startFrame(execution.eid, execution.planUri),
        s"Execution ${execution.eid} was created for computing unit $storedCuid, not $secondCuid.",
        cuid = secondCuid
      ),
      Refused(
        "another execution's plan in its plan table",
        startFrame(mislabeled.eid, mislabeled.planUri),
        "The plan's ids do not match its location.",
        names = Some(mislabeled.eid)
      ),
      Refused(
        "an expired input link",
        startFrame(expired.eid, expired.planUri),
        s"The plan's input links expired at ${Instant.ofEpochMilli(expiry)}. Run the workflow " +
          "again.",
        names = Some(expired.eid)
      )
    )
    val service = new StoredStartService
    try {
      val inFlight = runInFlight(service)
      val inFlightState = inFlight.executionStateStore.metadataStore.getState
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      refusals.foreach { refused =>
        withClue(s"${refused.name}: ") {
          val (session, sent) = sessionOn(service, refused.uid, refused.access, refused.cuid)
          sent.clear()
          otherSent.clear()

          val statements = recorder.record {
            noException should be thrownBy resource.myOnMsg(session, refused.frame)
          }

          statements shouldBe empty
          assertRefused(sent, refused.why, Some("WorkflowStartRequest"), refused.names)
          otherSent shouldBe empty
          service.executionService.getValue should be theSameInstanceAs inFlight
          inFlight.executionStateStore.metadataStore.getState shouldBe inFlightState
        }
      }
      ExecutionPlanStore.isStarted(new URI(execution.planUri)) shouldBe false
      Seq(unknownFormatUri, mislabeledUri, expiredUri).foreach { uri =>
        ExecutionPlanStore.isStarted(uri) shouldBe false
      }
      service.engines shouldBe empty
    } finally service.unsubscribeAll()
  }

  it should "refuse a start on a socket with no workflow, to that socket" in {
    val (session, sent) = mockSession(uid = Some(creatorUid), wid = storedWid, cuid = storedCuid)
    registerState(session, PrivilegeEnum.WRITE)

    noException should be thrownBy resource.myOnMsg(session, startFrame(974998L, "vfs:///x"))

    assertRefused(
      sent,
      "This connection is not open on a workflow.",
      Some("WorkflowStartRequest"),
      Some(974998L)
    )
  }

  it should "refuse a start on a socket with no computing unit, to that socket" in {
    val (session, sent) = mockSession(uid = Some(creatorUid), wid = storedWid, cuid = storedCuid)
    registerState(session, PrivilegeEnum.WRITE).subscribe(new TestWorkflowService(9109L))

    noException should be thrownBy resource.myOnMsg(session, startFrame(974998L, "vfs:///x"))

    assertRefused(
      sent,
      "This connection is not open on a computing unit.",
      Some("WorkflowStartRequest"),
      Some(974998L)
    )
  }

  it should "refuse a second start of an execution to its sender alone, leaving the run started as it was" in {
    val execution = created()
    val service = new StoredStartService
    try {
      val (session, sent) = sessionOn(service)
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      resource.myOnMsg(session, startFrame(execution.eid, execution.planUri))
      awaitEngineUp(sent)
      awaitEngineUp(otherSent)
      val run = service.executionService.getValue
      // A double click, or the same start from another socket of the creator, as on a reconnect.
      val (again, againSent) = sessionOn(service)
      Seq((session, sent), (again, againSent)).foreach {
        case (repeating, repeatingSent) =>
          sent.clear()
          otherSent.clear()
          againSent.clear()

          recorder.record {
            resource.myOnMsg(repeating, startFrame(execution.eid, execution.planUri))
          } shouldBe empty

          assertRefused(
            repeatingSent,
            s"Execution ${execution.eid} was already started.",
            Some("WorkflowStartRequest"),
            Some(execution.eid)
          )
          (Seq(sent, otherSent, againSent).filterNot(_ eq repeatingSent).flatten) shouldBe empty
          service.executionService.getValue should be theSameInstanceAs run
          run.executionStateStore.metadataStore.getState.state shouldBe READY
          run.executionStateStore.metadataStore.getState.fatalErrors shouldBe empty
      }
      service.engines should have size 1
    } finally service.unsubscribeAll()
  }

  // -- a kill, through to the run it is for -------------------------------------

  private def statusOf(executionId: Long): Int =
    getDSLContext
      .select(WORKFLOW_EXECUTIONS.STATUS)
      .from(WORKFLOW_EXECUTIONS)
      .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(executionId.toInt)))
      .fetchOne(WORKFLOW_EXECUTIONS.STATUS)
      .intValue()

  "WorkflowKillRequest" should "kill the run in flight, for every session on the workflow, and record it killed" in {
    val execution = created()
    val service = new StoredStartService
    try {
      val (session, sent) = sessionOn(service)
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      resource.myOnMsg(session, startFrame(execution.eid, execution.planUri))
      awaitEngineUp(sent)
      awaitEngineUp(otherSent)
      val run = service.executionService.getValue
      sent.clear()
      otherSent.clear()

      resource.myOnMsg(session, """{"type":"WorkflowKillRequest"}""")

      run.executionStateStore.metadataStore.getState.state shouldBe KILLED
      statusOf(execution.eid) shouldBe Utils.maptoStatusCode(KILLED).toInt
      stateEvents(sent) shouldBe Seq(("Killed", Some(execution.eid)))
      stateEvents(otherSent) shouldBe Seq(("Killed", Some(execution.eid)))
    } finally service.unsubscribeAll()
  }

  it should "leave a run that already ended as it is recorded, when it arrives late" in {
    val execution = created()
    val service = new StoredStartService
    try {
      val (session, sent) = sessionOn(service)
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      resource.myOnMsg(session, startFrame(execution.eid, execution.planUri))
      awaitEngineUp(sent)
      awaitEngineUp(otherSent)
      val run = service.executionService.getValue
      // The run completes, as its engine reports it, while a client still shows it running.
      run.executionStateStore.metadataStore.updateState(updateWorkflowState(COMPLETED, _))
      statusOf(execution.eid) shouldBe Utils.maptoStatusCode(COMPLETED).toInt
      val completed = run.executionStateStore.metadataStore.getState
      sent.clear()
      otherSent.clear()

      val statements = recorder.record {
        noException should be thrownBy
          resource.myOnMsg(session, """{"type":"WorkflowKillRequest"}""")
      }

      // Nothing is written, and no session is told anything: the run stays completed, in its
      // store and in its execution's row.
      statements shouldBe empty
      run.executionStateStore.metadataStore.getState shouldBe completed
      statusOf(execution.eid) shouldBe Utils.maptoStatusCode(COMPLETED).toInt
      sent shouldBe empty
      otherSent shouldBe empty
    } finally service.unsubscribeAll()
  }

  // -- applying a change the Dashboard stored -----------------------------------

  "OperatorUpdateRequest" should "apply a change the Dashboard stored to the run started from its plan" in {
    val execution = created()
    val service = new StoredStartService
    try {
      val (session, sent) = sessionOn(service)
      resource.myOnMsg(session, startFrame(execution.eid, execution.planUri))
      awaitEngineUp(sent)
      val run = service.executionService.getValue
      val changed = new LimitOpDesc
      changed.setOperatorId("limit")
      changed.limit = 7
      val update = FixtureUpdates.store(
        execution.eid,
        OperatorUpdateRequestBody(changed),
        userOf(creatorUid)
      )
      val updateFrame = frameOf(OperatorUpdateRequest(execution.eid, update.updateId))
      // Only the creator, with WRITE on the unit, applies it: a session without WRITE, another
      // user's and one of no user on the same run are refused, and queue nothing.
      Seq(
        sessionOn(service, access = PrivilegeEnum.READ) ->
          "You do not have write access to the computing unit.",
        sessionOn(service, uid = Some(otherUid)) ->
          s"Only the user who created execution ${execution.eid} may change its operators.",
        sessionOn(service, uid = None) ->
          s"Only the user who created execution ${execution.eid} may change its operators."
      ).foreach {
        case ((refusedSession, refusedSent), why) =>
          withClue(s"$why: ") {
            refusedSent.clear()
            resource.myOnMsg(refusedSession, updateFrame)
            modifyLogicResponses(refusedSent) shouldBe Seq(("", false, why))
            run.executionStateStore.reconfigurationStore.getState.unscheduledReconfigurations shouldBe
              empty
          }
      }
      sent.clear()

      resource.myOnMsg(session, updateFrame)
      resource.myOnMsg(session, frameOf(OperatorUpdateRequest(execution.eid, "update-unknown")))

      modifyLogicResponses(sent) shouldBe Seq(
        ("limit", true, ""),
        ("", false, s"Execution ${execution.eid} has no change update-unknown.")
      )
      // Queued for the resume: the running Limit, with the executor the change made.
      val queued =
        run.executionStateStore.reconfigurationStore.getState.unscheduledReconfigurations
      queued.map(_.id) shouldBe List(PhysicalOpIdentity(OperatorIdentity("limit"), "main"))
      objectMapper
        .readTree(queued.head.opExecInitInfo.asInstanceOf[OpExecWithClassName].descString)
        .get("limit")
        .asInt() shouldBe 7
    } finally service.unsubscribeAll()
  }

  it should "answer a change for an execution that is not running here as not applied" in {
    val service = new StoredStartService
    try {
      val (session, sent) = sessionOn(service)
      // No run at all, then a run of another execution, then one of this execution that never
      // built its engine.
      resource.myOnMsg(session, frameOf(OperatorUpdateRequest(974997L, "update-1")))
      runInFlight(service)
      resource.myOnMsg(session, frameOf(OperatorUpdateRequest(974997L, "update-1")))
      resource.myOnMsg(session, frameOf(OperatorUpdateRequest(974999L, "update-1")))

      modifyLogicResponses(sent) shouldBe Seq(
        ("", false, "Execution 974997 is not running here."),
        ("", false, "Execution 974997 is not running here."),
        ("", false, "Execution 974999 is not running here.")
      )
    } finally service.unsubscribeAll()
  }
}
