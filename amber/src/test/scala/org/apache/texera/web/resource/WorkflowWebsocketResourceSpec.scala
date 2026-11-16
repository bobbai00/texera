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
import com.fasterxml.jackson.databind.exc.InvalidTypeIdException
import com.google.protobuf.timestamp.Timestamp
import com.twitter.util.{Future, Promise}
import io.reactivex.rxjava3.disposables.Disposable
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.ClusterListener
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  RepositoryVersionResolver,
  ScanFileResolver,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  InputFile,
  PhysicalPlan,
  PhysicalPlanCodec,
  PlanInput,
  PortIdentity,
  WorkflowContext
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
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  READY,
  RUNNING
}
import org.apache.texera.amber.engine.architecture.rpc.coordinatorservice.CoordinatorServiceFs2Grpc
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.operator.TestOperators
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
  ModifyLogicRequest,
  OperatorUpdateRequest,
  ResultPaginationRequest,
  RetryRequest,
  TexeraWebSocketRequest,
  WorkflowExecuteRequest,
  WorkflowStartRequest
}
import org.apache.texera.web.model.websocket.response.ModifyLogicResponse
import org.apache.texera.web.service.execution.{CostHintsLoader, ExecutionCreator, OperatorUpdates}
import org.apache.texera.web.service.{
  ExecutionReconfigurationService,
  ExecutionResultService,
  WorkflowExecutionService,
  WorkflowService
}
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
import java.nio.file.Path
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
  * The endpoint itself is thin, but two pieces of it are real logic that nothing else guards:
  *
  *   - the write-access gate on `WorkflowExecuteRequest`. It is the only consumer of the privilege
  *     `myOnOpen` parsed off the handshake, and denying it must both surface an error to the client
  *     and rethrow. Note this branch is unreachable in single-node mode, where
  *     `ServletAwareConfigurator` hard-codes WRITE, but live under Kubernetes where the privilege
  *     comes from the `x-user-computing-unit-access` header.
  *   - the catch-all error mapper, which turns any exception into a `WorkflowFatalError`, routes it
  *     either to the execution's metadata store or (with no execution) straight to the socket, and
  *     then rethrows so the container sees it too. Both halves are asserted: dropping either the
  *     send or the rethrow would leave the other silently missing. `objectMapper.readValue` runs
  *     INSIDE the guarded region, so an unparseable frame is reported through that same mapper
  *     rather than escaping un-mapped with the client told nothing; both of the mapper's routing
  *     arms are asserted for a parse failure as well as for a handler failure.
  *   - the three-state distinction every execution-scoped arm has to make: no workflow, a workflow
  *     with no execution yet, and a live execution. `executionService` is a `BehaviorSubject`
  *     created without an initial value, so `getValue` is null until one is published, and reading
  *     it through `workflowStateOpt.map(...)` yields `Some(null)` — a shape that slips past a `case
  *     None` guard and NPEs on the next dereference. The middle state is covered for both
  *     `ModifyLogicRequest` and the `case other` fall-through; it is also the only input that tells
  *     `workflowStateOpt` apart from `executionStateOpt`, so it is what pins each guard's condition.
  *
  * Everything here drives a mocked `javax.websocket.Session` (the pattern `CollaborationResourceSpec`
  * established) and registers a `SessionState` directly, so no real workflow is created.
  *
  * Starting an execution the Dashboard created (`WorkflowStartRequest`) and applying a change it
  * stored (`OperatorUpdateRequest`) need more: each execution is created by `ExecutionCreator`, its
  * rows in `MockTexeraDB` and its plan in the catalog the build's tests use (the Postgres JDBC
  * catalog in CI), and is started on a `WorkflowService` whose sessions are subscribed for real,
  * so a session other than the sender's shows what reaches the workflow and what does not. Only
  * the engine is a `TestAmberClient` on this suite's actor system, which answers nothing. Its
  * coordinator tells every registered session of its regions (`RegionUpdateEvent`) once it is up,
  * so the cases that build one wait for that before they end. A refused start is checked to reach
  * its sender alone, to send no statement to the database, and to leave the run in flight as it
  * was; a start frame that does not bind too. A start over a socket whose URI carries the user's
  * access token, as a browser's does, is checked to log no line naming it.
  *
  * Deliberately not covered, because each would pin an accidental failure rather than a contract:
  *   - `myOnOpen`'s missing-`wid`/`cuid` and bogus-privilege paths, which fail with NPE /
  *     IndexOutOfBounds / IllegalArgumentException. A harmless improvement (a default, or a clear
  *     message) would break such a test.
  *   - `ResultPaginationRequest`'s real payload, which needs a DB; only the request/response
  *     pass-through is asserted here, against a stubbed result service.
  *   - what the mapper itself accepts and rejects, already owned by `TexeraWebSocketRequestSpec`;
  *     the malformed-frame cases here are about the endpoint's handling, not the binding rules.
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
    var initCalls: List[(WorkflowExecuteRequest, Option[User], URI)] = Nil

    /**
      * When set, `initExecutionService` publishes this execution and then fails — the shape a real
      * `executeWorkflow()` failure takes, and the only way to reach the endpoint's catch arm with an
      * execution that did NOT exist when the frame arrived.
      */
    var publishThenFail: Option[WorkflowExecutionService] = None

    val results = new StubResultService(workflowId, computingUnitId, stateStore)
    override val resultService: ExecutionResultService = results

    override def connect(onNext: TexeraWebSocketEvent => Unit): Disposable = Disposable.empty()
    override def connectToExecution(onNext: TexeraWebSocketEvent => Unit): Disposable =
      Disposable.empty()
    override def disconnect(): Unit = ()

    override def initExecutionService(
        req: WorkflowExecuteRequest,
        userOpt: Option[User],
        sessionUri: URI
    ): Unit = {
      initCalls = initCalls :+ ((req, userOpt, sessionUri))
      publishThenFail.foreach { execution =>
        executionService.onNext(execution)
        throw new IllegalStateException("failed while starting the execution")
      }
    }
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

    override def handleResultPagination(request: ResultPaginationRequest): TexeraWebSocketEvent = {
      captured = Some(request)
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
    * Production only builds an `ExecutionReconfigurationService` inside `executeWorkflow()`, but
    * the field it lands in is a public var, so a test can put a stub there directly. The two
    * `register*` overrides are the seams the service already ships for constructing it without a
    * live `AmberClient` (see `ExecutionReconfigurationServiceSpec`).
    */
  private class CapturingReconfigurationService(stateStore: ExecutionStateStore)
      extends ExecutionReconfigurationService(
        client = null,
        stateStore,
        workflow = null,
        bindResources = Some(identity),
        planUri = new URI("vfs:///wid/1/eid/1/plan"),
        creator = 42,
        mountRoot = None
      ) {
    var captured: Option[ModifyLogicRequest] = None

    override protected def registerWorkerCompletionCallback(): Unit = ()
    override protected def registerCompletionDiffHandler(): Unit = ()

    override def modifyOperatorLogic(request: ModifyLogicRequest): TexeraWebSocketEvent = {
      captured = Some(request)
      // Both fields are derived from the request that arrived, so the response the endpoint
      // forwards proves which request the service actually saw.
      ModifyLogicResponse(
        request.operator.operatorIdentifier.id,
        isValid = true,
        errorMessage = request.operator.asInstanceOf[LimitOpDesc].limit.toString
      )
    }
  }

  /**
    * A real execution, built the way `WorkflowExecutionServiceSpec`/`WorkflowServiceSpec` do:
    * construction does no external work, so the result service can be null.
    */
  private def newExecution(): WorkflowExecutionService =
    new WorkflowExecutionService(
      new WorkflowContext(),
      null,
      executeRequest,
      new ExecutionStateStore(),
      (_: Throwable) => (),
      Integer.valueOf(1), // uid; these tests never resolve a file
      None,
      new URI("vfs:///test"),
      replay = None,
      replayLog = None
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

  private def executeRequest: WorkflowExecuteRequest =
    objectMapper
      .readValue(
        """{"type":"WorkflowExecuteRequest","executionName":"exec","engineVersion":"v",
          |"logicalPlan":{"operators":[],"links":[],"opsToViewResult":[],"opsToReuseResult":[]},
          |"workflowSettings":{},"emailNotificationEnabled":false,"computingUnitId":1}""".stripMargin,
        classOf[TexeraWebSocketRequest]
      )
      .asInstanceOf[WorkflowExecuteRequest]

  private def frameOf(request: TexeraWebSocketRequest): String =
    objectMapper.writeValueAsString(request)

  /** Shared by the "forwarded" and "no workflow attached" halves of each guarded arm. */
  private val modifyLogicFrame =
    """{"type":"ModifyLogicRequest","operator":{"operatorType":"Limit","limit":7}}"""

  private val paginationFrame =
    """{"type":"ResultPaginationRequest","requestID":"req-77","operatorID":"op-88",
      |"pageIndex":3,"pageSize":25}""".stripMargin

  /** The `type` discriminator of each frame the endpoint wrote back. */
  private def sentTypes(sent: ArrayBuffer[String]): Seq[String] =
    sent.toSeq.map(objectMapper.readTree(_).get("type").asText())

  private def fatalErrorMessages(sent: ArrayBuffer[String]): Seq[String] =
    sent.toSeq
      .map(objectMapper.readTree)
      .filter(_.get("type").asText() == "WorkflowErrorEvent")
      .flatMap(_.get("fatalErrors").elements().asScala)
      .map(_.get("message").asText())

  // -- heartbeat ----------------------------------------------------------------

  "myOnMsg" should "answer a heartbeat without needing a workflow" in {
    val (session, sent) = mockSession()
    registerState(session, PrivilegeEnum.WRITE)

    resource.myOnMsg(session, frameOf(HeartBeatRequest()))

    sentTypes(sent) shouldBe Seq("HeartBeatResponse")
  }

  // -- the write-access gate ----------------------------------------------------

  it should "refuse a WorkflowExecuteRequest when the session has no write access" in {
    // READ, not WRITE: the gate must fire before any workflow lookup. The handler both reports the
    // failure to the client AND rethrows, so the container sees it too — assert both halves,
    // because dropping the rethrow (or the send) would leave one of them silently missing.
    val (session, sent) = mockSession(uid = Some(42))
    registerState(session, PrivilegeEnum.READ)

    val ex = intercept[IllegalStateException] {
      resource.myOnMsg(session, frameOf(executeRequest))
    }
    ex.getMessage should include("write access")

    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    val errors = objectMapper.readTree(sent.head).get("fatalErrors")
    errors.size() shouldBe 1
    // Every mapped error is stamped COMPILATION_ERROR with a placeholder operator; the frontend's
    // error panel keys on both.
    // The scalapb enum does not serialize as a bare string: it becomes an object, so the client
    // reads `type.name`. Pinning the nested shape is the point — flattening it would break the
    // frontend's error panel silently.
    errors.get(0).get("type").get("name").asText() shouldBe "COMPILATION_ERROR"
    errors.get(0).get("operatorId").asText() shouldBe "unknown operator"
    errors.get(0).get("message").asText() should include("write access")
    errors.get(0).get("details").asText() should not be empty
  }

  it should "refuse a WorkflowExecuteRequest with write access but no workflow attached" in {
    // WRITE, so the gate passes; the request then has nowhere to go. A distinct message is what
    // proves the gate is its own branch rather than the same failure reported twice.
    val (session, sent) = mockSession(uid = Some(42))
    registerState(session, PrivilegeEnum.WRITE)

    val ex = intercept[IllegalStateException] {
      resource.myOnMsg(session, frameOf(executeRequest))
    }
    ex.getMessage should include("workflow is not initialized")

    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    fatalErrorMessages(sent).head should include("workflow is not initialized")
  }

  it should "announce Initializing before handing the request to the workflow" in {
    val (session, sent) = mockSession(uid = Some(42))
    val state = registerState(session, PrivilegeEnum.WRITE)
    val workflow = new TestWorkflowService(9101L)
    state.subscribe(workflow)

    val request = executeRequest
    resource.myOnMsg(session, frameOf(request))

    // Order matters: the frontend flips its run button on this event, so it has to go out before
    // the (synchronous, potentially slow) init call rather than after it.
    sentTypes(sent) shouldBe Seq("WorkflowStateEvent")
    objectMapper.readTree(sent.head).get("state").asText() shouldBe "Initializing"

    workflow.initCalls should have size 1
    val (forwardedReq, forwardedUser, forwardedUri) = workflow.initCalls.head
    forwardedReq.executionName shouldBe request.executionName
    // The uid is read out of the session's user-properties map; a wrong key would silently
    // degrade every execution to anonymous.
    forwardedUser.map(_.getUid.intValue()) shouldBe Some(42)
    forwardedUri.toString should endWith("/wsapi/workflow-websocket")
  }

  // -- the default dispatch arm -------------------------------------------------

  it should "report a runtime command that arrives before any workflow is attached" in {
    // Anything that is not one of the four named requests falls through to `wsInput`, which only
    // exists once an execution has been created. This is the no-workflow state; the workflow-but-no-
    // execution state is the next case, and both have to report the same thing.
    val (session, sent) = mockSession(uid = Some(42))
    registerState(session, PrivilegeEnum.WRITE)

    val ex = intercept[IllegalStateException] {
      resource.myOnMsg(session, """{"type":"WorkflowPauseRequest"}""")
    }
    ex.getMessage should include("workflow execution is not initialized")

    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    fatalErrorMessages(sent).head should include("workflow execution is not initialized")
  }

  it should "hand an unrecognised runtime command to the execution's websocket input" in {
    // The other half of the same arm: with an execution attached the command is forwarded rather
    // than rejected, and the sender's uid rides along with it.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9102L)
    val execution = newExecution()
    attach(session, PrivilegeEnum.WRITE, workflow, Some(execution))

    val received = ArrayBuffer.empty[(TexeraWebSocketRequest, Option[Integer])]
    execution.wsInput.subscribe[TexeraWebSocketRequest]((req, uid) => received += ((req, uid)))

    // A payload-carrying request, deliberately. `WorkflowPauseRequest` is a field-less case class,
    // so its generated equals matches ANY instance: asserting on one would stay green with the
    // deserialized request dropped and a fresh constant forwarded in its place.
    resource.myOnMsg(session, """{"type":"RetryRequest","workers":["worker-a","worker-b"]}""")

    received should have size 1
    received.head._1 shouldBe RetryRequest(Seq("worker-a", "worker-b"))
    // Some(42), not None: None is what a missing user-properties entry yields anyway, so asserting
    // it would be green with the whole uid lookup deleted.
    received.head._2 shouldBe Some(Integer.valueOf(42))
    // Forwarding is the whole handling — nothing goes back to the socket, and no exception escapes.
    sent shouldBe empty
  }

  it should "report a runtime command that arrives with a workflow but no execution" in {
    // The third state of this arm, between the two above: a workflow IS attached, but nothing has
    // published an execution into it yet. `executionService` is a `BehaviorSubject` created without
    // an initial value, so `getValue` is null, and this is the input that pins how the arm reads it:
    // `workflowStateOpt.map(_.executionService.getValue)` would wrap that null into `Some(null)` and
    // walk straight past the `case None` guard that exists to report this very situation, NPEing on
    // `value.wsInput` instead. The message has to be the same one the no-workflow case above
    // produces: the client cannot act on the difference, and an NPE tells it nothing at all.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9107L)
    attach(session, PrivilegeEnum.WRITE, workflow)

    val ex = intercept[IllegalStateException] {
      resource.myOnMsg(session, """{"type":"WorkflowPauseRequest"}""")
    }
    ex.getMessage should include("workflow execution is not initialized")

    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    fatalErrorMessages(sent).head should include("workflow execution is not initialized")
  }

  // -- reconfiguration ----------------------------------------------------------

  it should "forward a ModifyLogicRequest to the execution's reconfiguration service" in {
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9103L)
    val execution = newExecution()
    val reconfiguration = new CapturingReconfigurationService(execution.executionStateStore)
    execution.executionReconfigurationService = reconfiguration
    attach(session, PrivilegeEnum.WRITE, workflow, Some(execution))

    resource.myOnMsg(session, modifyLogicFrame)

    // The deserialized operator has to arrive intact: asserting only that SOME ModifyLogicResponse
    // came back would stay green with a different (or default) request forwarded.
    val captured = reconfiguration.captured.getOrElse(fail("no request reached the service"))
    captured.operator shouldBe a[LimitOpDesc]
    captured.operator.asInstanceOf[LimitOpDesc].limit shouldBe 7

    sentTypes(sent) shouldBe Seq("ModifyLogicResponse")
    val response = objectMapper.readTree(sent.head)
    // Both values were computed by the stub FROM the request it received, so this pins the whole
    // round trip rather than the shape of a canned reply.
    response.get("opId").asText() shouldBe captured.operator.operatorIdentifier.id
    response.get("errorMessage").asText() shouldBe "7"
  }

  it should "ignore a ModifyLogicRequest that arrives before any workflow is attached" in {
    // The `if (workflowStateOpt.isDefined)` guard, observed false. Without this case the guard could
    // be replaced by `if (true)` and nothing would notice: the `.get` on the empty Option would
    // throw NoSuchElementException, the catch-all would turn it into a WorkflowErrorEvent, and the
    // rethrow would escape — so both assertions here have teeth.
    //
    // Silence is the assertion, and it is what separates this from the next case: with no workflow
    // there is nothing to reconfigure and nothing to say, whereas a workflow whose execution has not
    // started yet is a state the client can act on and is reported.
    val (session, sent) = mockSession(uid = Some(42))
    registerState(session, PrivilegeEnum.WRITE)

    noException should be thrownBy resource.myOnMsg(session, modifyLogicFrame)

    sent shouldBe empty
  }

  it should "report a ModifyLogicRequest that arrives before any execution exists" in {
    // The input that separates `workflowStateOpt.isDefined` from the execution actually being there:
    // a workflow with nothing published into its `executionService`. Reconfiguration needs the
    // execution, not the workflow, so the guard has to be about the execution — reading
    // `executionService.getValue` behind a workflow-shaped guard yields null and NPEs one dereference
    // later. Same message as the `case other` arm, for the same reason.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9108L)
    attach(session, PrivilegeEnum.WRITE, workflow)

    val ex = intercept[IllegalStateException] {
      resource.myOnMsg(session, modifyLogicFrame)
    }
    ex.getMessage should include("workflow execution is not initialized")

    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    fatalErrorMessages(sent).head should include("workflow execution is not initialized")
  }

  // -- pagination ---------------------------------------------------------------

  it should "answer a pagination request with what the result service returns" in {
    val (session, sent) = mockSession()
    val workflow = new TestWorkflowService(9104L)
    attach(session, PrivilegeEnum.WRITE, workflow)

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
    // `workflowStateOpt.foreach(...)`, observed empty. Replacing that with
    // `workflowStateOpt.get.resultService...` throws NoSuchElementException here, which the
    // catch-all turns into a WorkflowErrorEvent and then rethrows — so both assertions bite.
    val (session, sent) = mockSession()
    registerState(session, PrivilegeEnum.WRITE)

    noException should be thrownBy resource.myOnMsg(session, paginationFrame)

    sent shouldBe empty
  }

  // -- the error mapper and unparseable frames ----------------------------------

  it should "report an unparseable frame instead of letting it escape unmapped" in {
    // A stale or typo'd client sends an id nothing binds to. The mapper's own rejection is already
    // pinned by `TexeraWebSocketRequestSpec`; what this asserts is that the failure travels through
    // the endpoint's error mapper on its way out, exactly like a failure raised by a handler. The
    // rethrow AND the send are both asserted, for the same reason as the write-access gate: losing
    // either one leaves the other silently missing.
    val (session, sent) = mockSession(uid = Some(42))
    registerState(session, PrivilegeEnum.WRITE)

    val ex = intercept[InvalidTypeIdException] {
      resource.myOnMsg(session, """{"type":"NoSuchWebSocketRequest"}""")
    }
    ex.getMessage should include("NoSuchWebSocketRequest")

    // No execution is attached, so the mapper's socket arm is the one that runs.
    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    // The offending id has to reach the client: a generic "bad frame" would leave a stale frontend
    // with nothing to debug against.
    fatalErrorMessages(sent).head should include("NoSuchWebSocketRequest")
  }

  it should "record an unparseable frame in the execution's metadata store when one exists" in {
    // The other half of the mapper, reached by a parse failure rather than a handler failure: with an
    // execution attached the error is written to its metadata store and nothing goes to the socket.
    // Without this case, a fix that reported parse failures by sending directly from the parse site
    // instead of routing them through the mapper would look correct.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9109L)
    val execution = newExecution()
    attach(session, PrivilegeEnum.WRITE, workflow, Some(execution))

    intercept[InvalidTypeIdException] {
      resource.myOnMsg(session, """{"type":"NoSuchWebSocketRequest"}""")
    }

    val errors = execution.executionStateStore.metadataStore.getState.fatalErrors
    errors.map(_.`type`) shouldBe Seq(COMPILATION_ERROR)
    errors.head.message should include("NoSuchWebSocketRequest")
    sent shouldBe empty
  }

  // -- the error mapper's metadata-store arm ------------------------------------

  it should "record a failure in the execution's metadata store, replacing the stale compilation error" in {
    // With an execution attached the mapper writes into its metadata store instead of the socket,
    // and drops any earlier COMPILATION_ERROR so the panel shows one compilation failure at a time.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9105L)
    val execution = newExecution()
    attach(session, PrivilegeEnum.READ, workflow, Some(execution))

    val store = execution.executionStateStore.metadataStore
    // Two seeded errors of two different types. With only the new error in play the filter would
    // have nothing to remove, so deleting it entirely would leave the test green.
    store.updateState(
      _.addFatalErrors(
        WorkflowFatalError(
          COMPILATION_ERROR,
          Timestamp(Instant.now),
          "stale compilation",
          "",
          "op-a"
        ),
        WorkflowFatalError(EXECUTION_FAILURE, Timestamp(Instant.now), "runtime failure", "", "op-b")
      )
    )

    // READ access, so the write-access gate throws inside the try.
    intercept[IllegalStateException] {
      resource.myOnMsg(session, frameOf(executeRequest))
    }

    val errors = store.getState.fatalErrors
    // The unrelated execution failure survives; only the compilation error is superseded.
    errors.map(_.message) should contain("runtime failure")
    errors.map(_.message) should not contain "stale compilation"
    val compilationErrors = errors.filter(_.`type` == COMPILATION_ERROR)
    compilationErrors should have size 1
    compilationErrors.head.message should include("write access")
    // `details` is what the frontend's error panel shows a developer, and it has to be the stack
    // trace, not the message again: naming the throwing frame is what separates
    // `getStackTraceWithAllCauses(err)` from `err.toString` / `err.getMessage`, both of which would
    // satisfy any "is non-empty" check.
    compilationErrors.head.details should include("WorkflowWebsocketResource.myOnMsg")
    // A real clock reading, not `Timestamp.defaultInstance` — the panel orders errors by this.
    compilationErrors.head.timestamp.seconds should be > 0L

    // Nothing reaches the socket: this is the arm that replaces the WorkflowErrorEvent send.
    sent shouldBe empty
  }

  it should "route a failure raised while the execution is being created to the socket" in {
    // `executionStateOpt` is captured BEFORE the try, so it names the execution that existed when
    // the frame arrived. An execution created DURING the request therefore does not receive the
    // error — it goes to the socket instead. Recomputing that capture inside the catch (it is used
    // nowhere else) would reverse the routing, and no other case in this suite can see the
    // difference, because every other one either has an execution throughout or never gains one.
    val (session, sent) = mockSession(uid = Some(42))
    val workflow = new TestWorkflowService(9106L)
    val execution = newExecution()
    workflow.publishThenFail = Some(execution)
    // Attached with NO execution: the capture is None.
    attach(session, PrivilegeEnum.WRITE, workflow)

    intercept[IllegalStateException] {
      resource.myOnMsg(session, frameOf(executeRequest))
    }

    // The execution exists by the time the handler fails ...
    workflow.executionService.getValue shouldBe execution
    // ... and is nonetheless not where the error was recorded.
    execution.executionStateStore.metadataStore.getState.fatalErrors shouldBe empty
    sentTypes(sent) shouldBe Seq("WorkflowStateEvent", "WorkflowErrorEvent")
    fatalErrorMessages(sent).head should include("failed while starting the execution")
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
          // button state" and has to go out before the workflow subscription is established.
          sentTypes(sent) shouldBe Seq("WorkflowStateEvent", "ClusterStatusUpdateEvent")
          objectMapper.readTree(sent.head).get("state").asText() shouldBe "Uninitialized"
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

  /** The Dashboard's create, with the fixture resolvers and no cost hints. */
  private object FixtureCreator extends ExecutionCreator {
    override protected def fileResolverFor(uid: Integer): ScanFileResolver =
      TestOperators.fixtureFileResolver
    override protected def repositoryResolverFor(uid: Integer): RepositoryVersionResolver =
      TestOperators.fixtureRepositoryResolver
    override protected def mountRoot: Option[Path] = Some(TestOperators.fixtureMountRoot)
    override protected def replayLogRoot: Option[URI] = None
    override protected def warehousesEnabled: Boolean = false
    override protected def costHintsLoader: CostHintsLoader = NoHints
  }

  /** The Dashboard's store of a change to a paused operator, with the fixture resolver. */
  private object FixtureUpdates extends OperatorUpdates {
    override protected def repositoryResolverFor(uid: Integer): RepositoryVersionResolver =
      TestOperators.fixtureRepositoryResolver
    override protected def mountRoot: Option[Path] = Some(TestOperators.fixtureMountRoot)
    override protected def warehousesEnabled: Boolean = false
  }

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
      .getOrElse(fail("the execution was not created"))
    madePlans += new URI(response.planUri)
    madeStatistics += VFSURIFactory.createRuntimeStatisticsURI(
      WorkflowIdentity(storedWid),
      ExecutionIdentity(response.eid)
    )
    response
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

    /** The unit and the URI each start by id was asked with. */
    val asked: ArrayBuffer[(Int, URI)] = ArrayBuffer.empty

    override def startStoredExecution(
        executionId: Long,
        planUri: URI,
        user: User,
        cuid: Int,
        sessionUri: URI
    ): Either[String, WorkflowExecutionService] = {
      asked += ((cuid, sessionUri))
      super.startStoredExecution(executionId, planUri, user, cuid, sessionUri)
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
        Some(TestOperators.fixtureMountRoot)
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

  private def stateEvents(sent: ArrayBuffer[String]): Seq[String] =
    sent.toSeq
      .map(objectMapper.readTree)
      .filter(_.get("type").asText() == "WorkflowStateEvent")
      .map(_.get("state").asText())

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
      stateEvents(sent) shouldBe Seq("Initializing")
      stateEvents(otherSent) shouldBe Seq("Initializing")
      fatalErrorMessages(sent) shouldBe empty
      // The start was asked with the socket's unit, and with the socket's URI without its query,
      // which holds the user's access token: no line logged names the token.
      service.asked shouldBe Seq(
        (storedCuid, new URI("ws://localhost:8085/wsapi/workflow-websocket"))
      )
      val startLine = s"Execution ${execution.eid} of workflow $storedWid starts"
      logLines.count(_.contains(startLine)) shouldBe 1
      logLines.filter(_.contains(accessToken)) shouldBe empty
      logLines.filter(_.contains("access-token")) shouldBe empty
      // The engine is handed the plan the Dashboard stored, under the context it was read back
      // with, naming the socket's unit.
      service.engines should have size 1
      val engine = service.engines.head
      engine.context.cuid shouldBe Some(storedCuid)
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
    ExecutionPlanStore.writePlan(
      unknownFormatUri,
      ExecutionPlanStore.readPlan(unknownFormatUri).copy(formatVersion = 3)
    )
    val noPlanUri = ExecutionPlanStore
      .planUri(WorkflowIdentity(storedWid), ExecutionIdentity(firstCreatedEid - 1L), None)
    // An execution whose plan table holds the plan of another execution.
    val mislabeled = created()
    val mislabeledUri = new URI(mislabeled.planUri)
    ExecutionPlanStore.writePlan(
      mislabeledUri,
      ExecutionPlanStore
        .readPlan(mislabeledUri)
        .copy(body = ExecutionPlanStore.readPlan(new URI(execution.planUri)).body)
    )
    // An execution whose plan reads a file through a link that expired long ago, encoded by hand
    // until the Dashboard makes links (sub-part 16).
    val expired = created()
    val expiredUri = new URI(expired.planUri)
    val expiredRow = ExecutionPlanStore.readPlan(expiredUri)
    val expiry = 1000L
    ExecutionPlanStore.writePlan(
      expiredUri,
      expiredRow.copy(body =
        PhysicalPlanCodec.toJson(
          PhysicalPlanCodec.encode(
            PhysicalPlanCodec
              .decode(PhysicalPlanCodec.fromJson(expiredRow.body))
              .copy(inputs =
                Seq(PlanInput(OperatorIdentity("lines"), "lines.txt", InputFile(expiry, 3)))
              )
          )
        )
      )
    )
    val refusals: Seq[(String, Option[Int], PrivilegeEnum, Int, String, String)] = Seq(
      (
        "no write access",
        Some(creatorUid),
        PrivilegeEnum.READ,
        storedCuid,
        startFrame(execution.eid, execution.planUri),
        "you do not have write access to the computing unit"
      ),
      (
        "no user",
        None,
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(execution.eid, execution.planUri),
        "a signed-in user is required to start an execution"
      ),
      (
        "not a plan",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(execution.eid, s"vfs:///wid/$storedWid/eid/${execution.eid}/result"),
        "not an execution plan"
      ),
      (
        "no URI",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        s"""{"type":"WorkflowStartRequest","executionId":${execution.eid},"planUri":"::"}""",
        "not an execution plan"
      ),
      // Frames that do not bind: not reported into the run in flight, as other frames are.
      (
        "no execution id",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        s"""{"type":"WorkflowStartRequest","executionId":"abc","planUri":"${execution.planUri}"}""",
        "the request to start an execution could not be read"
      ),
      (
        "a plan table that is not a string",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        s"""{"type":"WorkflowStartRequest","executionId":${execution.eid},"planUri":{"x":1}}""",
        "the request to start an execution could not be read"
      ),
      (
        "another execution's plan",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(execution.eid, unknownFormat.planUri),
        s"the plan is execution ${unknownFormat.eid}'s, not ${execution.eid}'s"
      ),
      (
        "another workflow's plan",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(
          execution.eid,
          ExecutionPlanStore
            .planUri(WorkflowIdentity(otherWid), ExecutionIdentity(execution.eid), None)
            .toString
        ),
        s"the plan belongs to workflow $otherWid, not to this one"
      ),
      (
        "another user's warehouse",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
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
        "the plan is in another user's warehouse"
      ),
      (
        "the user's own warehouse, which this deployment does not serve",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
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
        s"execution ${execution.eid} keeps its plan in warehouse 'user-$creatorUid-1', and " +
          "per-user warehouses are disabled in this deployment"
      ),
      (
        "no stored plan",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(firstCreatedEid - 1L, noPlanUri.toString),
        s"execution ${firstCreatedEid - 1} has no stored plan"
      ),
      (
        "another format",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(unknownFormat.eid, unknownFormat.planUri),
        s"unknown plan format 3; this unit reads ${PhysicalPlanCodec.FormatVersion}"
      ),
      (
        "another user",
        Some(otherUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(execution.eid, execution.planUri),
        s"only the user who created execution ${execution.eid} may start it"
      ),
      (
        "another unit",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        secondCuid,
        startFrame(execution.eid, execution.planUri),
        s"execution ${execution.eid} was created for computing unit $storedCuid, not $secondCuid"
      ),
      (
        "another execution's plan in its plan table",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(mislabeled.eid, mislabeled.planUri),
        "the plan's ids do not match its location"
      ),
      (
        "an expired input link",
        Some(creatorUid),
        PrivilegeEnum.WRITE,
        storedCuid,
        startFrame(expired.eid, expired.planUri),
        s"input links expired at ${Instant.ofEpochMilli(expiry)}; run the workflow again"
      )
    )
    val service = new StoredStartService
    try {
      val inFlight = runInFlight(service)
      val inFlightState = inFlight.executionStateStore.metadataStore.getState
      val (_, otherSent) = sessionOn(service, uid = Some(otherUid))
      refusals.foreach {
        case (name, uid, access, cuid, frame, why) =>
          withClue(s"$name: ") {
            val (session, sent) = sessionOn(service, uid, access, cuid)
            sent.clear()
            otherSent.clear()

            val statements = recorder.record {
              noException should be thrownBy resource.myOnMsg(session, frame)
            }

            statements shouldBe empty
            sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
            val error = objectMapper.readTree(sent.head).get("fatalErrors").get(0)
            error.get("type").get("name").asText() shouldBe "EXECUTION_FAILURE"
            error.get("message").asText() shouldBe why
            error.get("operatorId").asText() shouldBe ""
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

    sentTypes(sent) shouldBe Seq("WorkflowErrorEvent")
    fatalErrorMessages(sent) shouldBe Seq("workflow is not initialized")
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

          fatalErrorMessages(repeatingSent) shouldBe
            Seq(s"execution ${execution.eid} was already started")
          sentTypes(repeatingSent) shouldBe Seq("WorkflowErrorEvent")
          (Seq(sent, otherSent, againSent).filterNot(_ eq repeatingSent).flatten) shouldBe empty
          service.executionService.getValue should be theSameInstanceAs run
          run.executionStateStore.metadataStore.getState.state shouldBe READY
          run.executionStateStore.metadataStore.getState.fatalErrors shouldBe empty
      }
      service.engines should have size 1
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
          "you do not have write access to the computing unit",
        sessionOn(service, uid = Some(otherUid)) ->
          s"only the user who created execution ${execution.eid} may change its operators",
        sessionOn(service, uid = None) ->
          s"only the user who created execution ${execution.eid} may change its operators"
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
        ("", false, s"execution ${execution.eid} has no change update-unknown")
      )
      // Queued for the resume: the running Limit, with the executor the change made.
      val queued =
        run.executionStateStore.reconfigurationStore.getState.unscheduledReconfigurations.map(_._1)
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
        ("", false, "execution 974997 is not running here"),
        ("", false, "execution 974997 is not running here"),
        ("", false, "execution 974999 is not running here")
      )
    } finally service.unsubscribeAll()
  }
}
