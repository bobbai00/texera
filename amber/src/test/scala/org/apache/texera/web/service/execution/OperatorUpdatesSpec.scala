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

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import io.dropwizard.setup.Bootstrap
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  CostHints,
  OperatorUpdate,
  PhysicalOp,
  PhysicalPlanCodec,
  PortIdentity,
  RepositoryMounts
}
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.filter.{
  ComparisonType,
  FilterPredicate,
  SpecializedFilterOpDesc
}
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.{
  LambdaAttributeUnit,
  PythonLambdaFunctionOpDesc,
  PythonUDFOpDescV2,
  PythonUdfUiParameterInjector
}
import org.apache.texera.amber.operator.{FixtureInputs, LogicalOp, StateTransferFunc, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.{
  COMPUTING_UNIT_USER_ACCESS,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_OF_USER,
  WORKFLOW_USER_ACCESS,
  WORKFLOW_VERSION
}
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
import org.apache.texera.web.model.http.request.execution.{
  CreateExecutionRequest,
  OperatorUpdateRequestBody
}
import org.apache.texera.web.model.http.response.execution.{
  CreateExecutionResponse,
  OperatorUpdateResponse
}
import org.apache.texera.web.resource.dashboard.user.workflow.ExecutionResource
import org.apache.texera.web.service.execution.ComputingUnitClient.{
  Handover,
  Refused,
  Taken,
  Unanswered,
  Unreached
}
import org.apache.texera.web.service.execution.RecordingComputingUnits.Handed
import org.apache.texera.web.service.execution.WorkflowCompilingService.CompileRefused
import org.apache.texera.web.{TexeraWebApplication, TexeraWebConfiguration}
import org.jooq.exception.DataAccessException
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.lang.reflect.Proxy
import java.net.URI
import java.sql.Timestamp
import javax.ws.rs.core.{Response, UriInfo}
import javax.ws.rs.{InternalServerErrorException, WebApplicationException}
import scala.collection.mutable
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.{Failure, Success, Try, Using}

/**
  * Changing an operator of a paused execution at the Dashboard service, through
  * [[ExecutionResource]]: `POST /api/executions/{eid}/updates`.
  *
  * The rows are in `MockTexeraDB`; each execution is created by [[ExecutionCreator]], and its
  * changes are sent with the workflow it was created from, as the editor sends them. Changes are
  * compiled with the fixture resolvers of `TestOperators`. Nothing a change makes is kept: a case
  * reads the change the Dashboard hands the execution's computing unit, which here keeps what it
  * is handed and runs nothing ([[RecordingComputingUnits]]).
  *
  * Users: `ownerUid` owns the workflow and the unit; `creatorUid` creates the executions, as a
  * user who may only read the workflow and was given WRITE on the unit; `strangerUid` has no right
  * to either.
  */
class OperatorUpdatesSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val ownerUid = 9701
  private val creatorUid = 9702
  private val strangerUid = 9703

  private val testWid = 9711
  private val unitCuid = 9721

  /** An execution inserted by hand, rather than created, for a case a create never leaves. */
  private val noUnitEid = 971902

  /** The executions this suite creates start after this id. */
  private val firstCreatedEid = 972000

  private val requestUri = new URI("http://texera.example:4200/api/executions")

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    val cfg = getDSLContext.configuration()

    Seq(ownerUid, creatorUid, strangerUid).foreach { uid =>
      val user = new User
      user.setUid(uid)
      user.setName(s"operator-updates-user-$uid")
      user.setEmail(s"user-$uid@example.com")
      user.setRole(UserRoleEnum.REGULAR)
      new UserDao(cfg).insert(user)
    }

    val workflow = new Workflow
    workflow.setWid(testWid)
    workflow.setName("operator-updates-spec-workflow")
    workflow.setContent("{}")
    workflow.setDescription("")
    workflow.setCreationTime(new Timestamp(System.currentTimeMillis()))
    workflow.setLastModifiedTime(new Timestamp(System.currentTimeMillis()))
    new WorkflowDao(cfg).insert(workflow)
    val version = new WorkflowVersion
    version.setWid(testWid)
    version.setContent("{}")
    version.setCreationTime(new Timestamp(System.currentTimeMillis()))
    new WorkflowVersionDao(cfg).insert(version)
    getDSLContext
      .insertInto(WORKFLOW_OF_USER)
      .set(WORKFLOW_OF_USER.UID, Integer.valueOf(ownerUid))
      .set(WORKFLOW_OF_USER.WID, Integer.valueOf(testWid))
      .execute()
    grantWorkflowRead()

    val unit = new WorkflowComputingUnit
    unit.setCuid(unitCuid)
    unit.setUid(ownerUid)
    unit.setName(s"operator-updates-unit-$unitCuid")
    unit.setCreationTime(new Timestamp(System.currentTimeMillis()))
    unit.setType(WorkflowComputingUnitTypeEnum.local)
    unit.setUri("local://test")
    unit.setResource("{}")
    new WorkflowComputingUnitDao(cfg).insert(unit)
    getDSLContext
      .insertInto(COMPUTING_UNIT_USER_ACCESS)
      .set(COMPUTING_UNIT_USER_ACCESS.CUID, Integer.valueOf(unitCuid))
      .set(COMPUTING_UNIT_USER_ACCESS.UID, Integer.valueOf(creatorUid))
      .set(COMPUTING_UNIT_USER_ACCESS.PRIVILEGE, PrivilegeEnum.WRITE)
      .execute()

    // Executions created below take ids after the one inserted by hand. The table is qualified
    // from the generated metadata, as the connection's search_path does not hold texera_db.
    getDSLContext.execute(
      "select setval(pg_get_serial_sequence(?, ?), ?, true)",
      s"${WORKFLOW_EXECUTIONS.getSchema.getName}.${WORKFLOW_EXECUTIONS.getName}",
      WORKFLOW_EXECUTIONS.EID.getName,
      Integer.valueOf(firstCreatedEid)
    )
  }

  override protected def afterAll(): Unit =
    try closeConnectionPool()
    finally super.afterAll()

  // --- fixtures ---

  private def grantWorkflowRead(): Unit =
    getDSLContext
      .insertInto(WORKFLOW_USER_ACCESS)
      .set(WORKFLOW_USER_ACCESS.UID, Integer.valueOf(creatorUid))
      .set(WORKFLOW_USER_ACCESS.WID, Integer.valueOf(testWid))
      .set(WORKFLOW_USER_ACCESS.PRIVILEGE, PrivilegeEnum.READ)
      .execute()

  private def setUnitAccess(privilege: PrivilegeEnum): Unit =
    getDSLContext
      .update(COMPUTING_UNIT_USER_ACCESS)
      .set(COMPUTING_UNIT_USER_ACCESS.PRIVILEGE, privilege)
      .where(
        COMPUTING_UNIT_USER_ACCESS.CUID
          .eq(Integer.valueOf(unitCuid))
          .and(COMPUTING_UNIT_USER_ACCESS.UID.eq(Integer.valueOf(creatorUid)))
      )
      .execute()

  /** Inserts execution `eid` of the workflow by the creator. */
  private def insertExecution(eid: Int, cuid: Option[Int] = Some(unitCuid)): Unit = {
    val vid = getDSLContext
      .select(WORKFLOW_VERSION.VID)
      .from(WORKFLOW_VERSION)
      .where(WORKFLOW_VERSION.WID.eq(Integer.valueOf(testWid)))
      .fetchOneInto(classOf[Integer])
    getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.EID, Integer.valueOf(eid))
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, Integer.valueOf(creatorUid))
      .set(WORKFLOW_EXECUTIONS.CUID, cuid.map(Integer.valueOf).orNull)
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .execute()
  }

  /** What the execution's unit answers a change it is handed: taken, unless a case says. */
  @volatile private var unitAnswer: Handover = Taken

  /** The unit's side of every change the suite asks for. */
  private val handedOver = new RecordingComputingUnits(unitAnswer)

  /** Runs `body` while the execution's unit answers `answer` to a change it is handed. */
  private def whileUnitAnswers[T](answer: Handover)(body: => T): T = {
    unitAnswer = answer
    try body
    finally unitAnswer = Taken
  }

  /** Creates executions with the fixture bindings and no cost hints, on units that take them. */
  private class FixtureCreator
      extends ExecutionCreator(
        compiling = new FixtureCompilingService(),
        units = new RecordingComputingUnits(),
        linker = FixtureInputs.linker,
        replayLogRoot = None,
        warehousesEnabled = false,
        costHints = NoHints,
        background = _.run(),
        // No large binary is deleted for what a create finds replaced.
        expiry = new ExecutionExpiry(warehousesEnabled = false, deleteBinaries = _ => ())
      )

  private object NoHints extends CostHintsLoader(1) {
    override def load(wid: Long, uid: Int): Option[CostHints] = None
  }

  /** What an operator answers when it is asked to build the operator a change makes of it. */
  private type Reconfiguration = Try[(PhysicalOp, Option[StateTransferFunc])]

  /**
    * The updates under test, whose compiling service compiles in this JVM and pins a change's
    * datasets and models with `resolver` (the fixtures', unless a case gives another), and set
    * up as the case needs: `reconfiguration` stands in for the answer of the operator a change
    * is made to. `resolverUsers` records the user each change was bound for: a resolver is
    * asked for on every change the service is asked to make, whether or not it names a dataset
    * or a model.
    */
  private class FixtureUpdates(
      resolver: RepositoryVersionResolver = TestOperators.fixtureRepositoryResolver,
      reconfiguration: Option[() => Reconfiguration] = None,
      val resolverUsers: mutable.ListBuffer[Integer] = mutable.ListBuffer.empty,
      compiling: Option[WorkflowCompilingService] = None
  ) extends OperatorUpdates(
        compiling = compiling.getOrElse(
          new FixtureCompilingService(
            repositoriesFor = uid => {
              resolverUsers += uid
              resolver
            },
            reconfigure = (current, changed, workflowId, executionId) =>
              reconfiguration.fold(
                current.runtimeReconfiguration(workflowId, executionId, current, changed)
              )(_())
          )
        ),
        units = handedOver
      )

  private def sessionUser(uid: Int): SessionUser = {
    val user = new User
    user.setUid(uid)
    user.setName(s"operator-updates-user-$uid")
    user.setEmail(s"user-$uid@example.com")
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

  private def resource(
      fixtureUpdates: OperatorUpdates = new FixtureUpdates()
  ): ExecutionResource = new ExecutionResource(new FixtureCreator(), fixtureUpdates)

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  private val udfCode =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    @overrides
      |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
      |        yield tuple_
      |""".stripMargin

  /** The UDF's code once changed, tagging what it changes. */
  private def changedCode(tag: String): String =
    udfCode.replace("yield tuple_", s"""tuple_["Region"] = "$tag"
      |        yield tuple_""".stripMargin)

  private def udf(
      id: String = "udf",
      code: String = udfCode,
      environment: Option[String] = None,
      parameters: List[UiUDFParameter] = Nil
  ): PythonUDFOpDescV2 = {
    val op = named(TestOperators.pythonOpDesc(), id)
    op.code = code
    environment.foreach { name =>
      op.defaultEnv = false
      op.envName = name
    }
    op.uiParameters = parameters
    op
  }

  private def limit(id: String, rows: Int): LimitOpDesc = {
    val op = named(new LimitOpDesc, id)
    op.limit = rows
    op
  }

  /** A scan of a fixture file, then a Python UDF on what it reads, then a Limit. */
  private def udfPlan(environment: Option[String] = None): LogicalPlanPojo =
    LogicalPlanPojo(
      List(
        named(TestOperators.smallCsvScanOpDesc(), "scan"),
        udf(environment = environment),
        limit("limit", 5)
      ),
      List(link("scan", "udf"), link("udf", "limit")),
      List.empty,
      List.empty
    )

  /** A Python Lambda that adds the column `Derived`, worked out by `expression`. */
  private def lambda(expression: String): PythonLambdaFunctionOpDesc = {
    val op = named(new PythonLambdaFunctionOpDesc, "lambda")
    op.lambdaAttributeUnits = List(
      new LambdaAttributeUnit("Add New Column", expression, "Derived", AttributeType.INTEGER)
    )
    op
  }

  /** A scan of a fixture file, then a Python Lambda on what it reads, then a Limit. */
  private def lambdaPlan(): LogicalPlanPojo =
    LogicalPlanPojo(
      List(
        named(TestOperators.smallCsvScanOpDesc(), "scan"),
        lambda("tuple_['Units Sold'] * 2"),
        limit("limit", 5)
      ),
      List(link("scan", "lambda"), link("lambda", "limit")),
      List.empty,
      List.empty
    )

  private def filter(id: String, value: String): SpecializedFilterOpDesc = {
    val op = named(new SpecializedFilterOpDesc, id)
    op.predicates = List(new FilterPredicate("line", ComparisonType.EQUAL_TO, value))
    op
  }

  /** A Limit parsed as the editor sends one whose limit is the loop variable `name`. */
  private def limitReferring(id: String, name: String): LogicalOp =
    objectMapper.readValue(
      s"""{"operatorID":"$id","limit":"$$$name","operatorType":"Limit"}""",
      classOf[LogicalOp]
    )

  /**
    * lines -> pre -> start -> typed -> limit2 -> filter -> bound -> end: `typed`, `limit2`,
    * `filter` and `bound` are inside the loop block; `typed` refers to the loop variable `n` with a
    * typed reference, and `bound` to `x` with the whole string "$x"; `pre`, outside every block,
    * holds the literal "$x".
    */
  private def loopPlan(): LogicalPlanPojo = {
    val lines = named(new TextInputSourceOpDesc(), "lines")
    lines.textInput = "0\n1"
    val start = named(new LoopStartOpDesc(), "start")
    start.initialization = "i = 0"
    start.output = "table.iloc[i]"
    val end = named(new LoopEndOpDesc(), "end")
    end.update = "i += 1"
    end.condition = "i < len(table)"
    val ops = List(
      lines,
      filter("pre", "$x"),
      start,
      limitReferring("typed", "n"),
      limit("limit2", 3),
      filter("filter", "Asia"),
      filter("bound", "$x"),
      end
    )
    val ids = ops.map(_.operatorIdentifier.id)
    LogicalPlanPojo(
      ops,
      ids.zip(ids.tail).map { case (from, to) => link(from, to) },
      List.empty,
      List.empty
    )
  }

  /** An execution of `plan` the creator created. */
  private def created(plan: LogicalPlanPojo = udfPlan()): CreateExecutionResponse = {
    val response = resource().create(
      CreateExecutionRequest(
        wid = testWid,
        executionName = "operator-updates-spec",
        engineVersion = "1.4.0-spec",
        logicalPlan = TestUtils.sentPlan(plan),
        workflowSettings = None,
        computingUnitId = unitCuid,
        warehouseId = None,
        replayFromExecution = None,
        targetOperatorId = None
      ),
      sessionUser(creatorUid),
      uriInfo,
      FixtureCompilingService.authorizationOf(creatorUid)
    )
    withClue(s"${response.getEntity}: ") { response.getStatus shouldBe 201 }
    response.getEntity.asInstanceOf[CreateExecutionResponse]
  }

  /** Asks for the change `body` holds to execution `eid`, as user `uid`. */
  private def postBody(
      eid: Long,
      body: OperatorUpdateRequestBody,
      uid: Int = creatorUid,
      updates: OperatorUpdates = new FixtureUpdates()
  ): Response =
    resource(updates).postUpdate(
      eid,
      body,
      sessionUser(uid),
      FixtureCompilingService.authorizationOf(uid)
    )

  /**
    * Asks for `operator`, changed, in place of the operator of its id in `workflow`, as the
    * editor sends them: their JSON, which the Dashboard hands on.
    */
  private def post(
      eid: Long,
      operator: LogicalOp,
      workflow: LogicalPlanPojo = udfPlan(),
      uid: Int = creatorUid,
      updates: OperatorUpdates = new FixtureUpdates()
  ): Response =
    postBody(
      eid,
      OperatorUpdateRequestBody(
        Option(operator).map(TestUtils.sentOperator).orNull,
        TestUtils.sentPlan(workflow)
      ),
      uid,
      updates
    )

  /**
    * A change the Dashboard made and the execution's unit took.
    *
    * @param operatorId the operator the 201 names
    * @param handed     what the unit was handed for it
    */
  private case class MadeUpdate(operatorId: String, handed: Handed) {

    /** The change as text, as the unit reads it. */
    def update: String = handed.text
  }

  /** The change `response` asks for, answered 201, with what the unit was handed for it. */
  private def made(response: => Response): MadeUpdate = {
    val before = handedOver.updates.size
    val answered = response
    withClue(s"${answered.getEntity}: ") { answered.getStatus shouldBe 201 }
    val handed = handedOver.updates.drop(before)
    handed should have size 1
    MadeUpdate(answered.getEntity.asInstanceOf[OperatorUpdateResponse].operatorId, handed.head)
  }

  /** The message of the refusal `body` throws, which answers `status`. */
  private def refused(status: Int)(body: => Any): String = {
    val refusal = intercept[WebApplicationException](body)
    withClue(s"${refusal.getMessage}: ") { refusal.getResponse.getStatus shouldBe status }
    refusal.getMessage
  }

  /** The operator to run that `update` holds, as the computing unit reads it. */
  private def decoded(update: MadeUpdate): OperatorUpdate =
    PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(update.update))

  /** The descriptor that the operator `update` holds runs from, as `T`. */
  private def descriptorOf[T](update: MadeUpdate, as: Class[T]): T =
    objectMapper.readValue(
      decoded(update).opExecInitInfo.asInstanceOf[OpExecWithClassName].descString,
      as
    )

  private def datasetParameter(value: String): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = value
    parameter
  }

  private lazy val dashboardMapper: ObjectMapper = {
    val application = new TexeraWebApplication
    val bootstrap = new Bootstrap[TexeraWebConfiguration](application)
    application.initialize(bootstrap)
    bootstrap.getObjectMapper
  }

  private val udfOpId = PhysicalOpIdentity(OperatorIdentity("udf"), "main")

  // --- made ---

  "ExecutionResource.postUpdate" should
    "make the change into the operator to run, for the execution's creator, and hand it to the execution's unit" in {
    val execution = created()
    val updates = new FixtureUpdates()

    val update = made(post(execution.eid, udf(code = changedCode("v2")), updates = updates))

    update.operatorId shouldBe "udf"
    // Handed to the unit the execution was created for, as the caller: with the request's own
    // Authorization header.
    update.handed.cuid shouldBe unitCuid
    update.handed.authorization shouldBe FixtureCompilingService.authorizationOf(creatorUid)
    // What the unit applies: the new code for the running operator, of this execution.
    decoded(update) shouldBe OperatorUpdate(
      ExecutionIdentity(execution.eid),
      udfOpId,
      OpExecWithCode(changedCode("v2"), "python"),
      None,
      None
    )
    // Bound as the creator may read.
    updates.resolverUsers.toSet shouldBe Set(Integer.valueOf(creatorUid))
  }

  it should "make each change of a pause on its own" in {
    val execution = created()

    val first = made(post(execution.eid, udf(code = changedCode("v2"))))
    val second = made(post(execution.eid, limit("limit", 9)))

    decoded(first).opExecInitInfo shouldBe OpExecWithCode(changedCode("v2"), "python")
    decoded(second).opId shouldBe PhysicalOpIdentity(OperatorIdentity("limit"), "main")
    descriptorOf(second, classOf[LimitOpDesc]).limit shouldBe 9
  }

  it should "pin the datasets a changed UDF names, as its plan was pinned" in {
    val execution = created()
    val changed = udf(
      code = changedCode("v2"),
      parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))
    )

    val update = decoded(made(post(execution.eid, changed)))

    update.repositoryMounts shouldBe Some(RepositoryMounts(Set("dataset-1:d4t4")))
    // The code names the repository commit: the unit that runs it knows where it mounts it.
    update.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(
        changedCode("v2"),
        List(datasetParameter("dataset-1:d4t4"))
      ),
      "python"
    )
  }

  it should "hand over the Python environment the change asks for, for the computing unit to check" in {
    // The unit refuses a change of the environment its operator runs in: the Dashboard does not
    // hold the plan to tell.
    val inDefault = created()
    val inMl = created(plan = udfPlan(environment = Some("ml")))

    decoded(made(post(inDefault.eid, udf()))).pythonEnvironment shouldBe None
    decoded(made(post(inDefault.eid, udf(environment = Some("ml"))))).pythonEnvironment shouldBe
      Some("ml")
    // Written as the editor may, it is named as the operator names it.
    decoded(
      made(
        post(
          inMl.eid,
          udf(code = changedCode("v2"), environment = Some("  ml  ")),
          workflow = udfPlan(environment = Some("ml"))
        )
      )
    ).pythonEnvironment shouldBe Some("ml")
  }

  it should "change an operator inside a loop block that refers to no loop variable, and a '$x' literal outside every block" in {
    val execution = created(plan = loopPlan())

    made(post(execution.eid, filter("filter", "Europe"), workflow = loopPlan()))
    // Outside every block "$y" is the literal it is everywhere else.
    val literal = made(post(execution.eid, filter("pre", "$y"), workflow = loopPlan()))

    descriptorOf(literal, classOf[SpecializedFilterOpDesc]).predicates.head.value shouldBe "$y"
  }

  it should "parse a change as the Dashboard's mapper reads the request" in {
    val execution = created()
    val body = dashboardMapper.readValue(
      s"""{
         |  "operator": {"operatorType": "Limit", "operatorID": "limit", "limit": 7},
         |  "workflow": ${TestUtils.sentPlan(udfPlan())}
         |}""".stripMargin,
      classOf[OperatorUpdateRequestBody]
    )

    val update = made(postBody(execution.eid, body))

    update.operatorId shouldBe "limit"
    descriptorOf(update, classOf[LimitOpDesc]).limit shouldBe 7
  }

  it should "answer the operator the unit took a change to, as {operatorId}, and nothing of the change" in {
    val execution = created()
    val answer = post(execution.eid, limit("limit", 7))
    answer.getStatus shouldBe 201

    val written = dashboardMapper.readTree(dashboardMapper.writeValueAsString(answer.getEntity))

    written.fieldNames().asScala.toList shouldBe List("operatorId")
    written.get("operatorId").asText() shouldBe "limit"
  }

  // --- handed to the unit ---

  it should "answer 409 with the unit's reason when the unit does not take the change" in {
    val execution = created()
    val reasons = Seq(
      s"Only the user who started execution ${execution.eid} may change its operators.",
      s"Execution ${execution.eid} is not running here."
    )
    reasons.foreach { reason =>
      whileUnitAnswers(Refused(reason)) {
        refused(409)(post(execution.eid, limit("limit", 7))) shouldBe reason
      }
    }
  }

  it should "answer 503 when the unit cannot be reached, and 504 when it does not say whether it took the change" in {
    val execution = created()
    val before = handedOver.updates.size

    whileUnitAnswers(Unreached(new java.net.ConnectException("refused"))) {
      refused(503)(post(execution.eid, limit("limit", 7))) shouldBe
        s"The change to execution ${execution.eid} could not be applied: computing unit " +
          s"$unitCuid could not be reached."
    }
    whileUnitAnswers(Unanswered(new java.net.http.HttpTimeoutException("late"))) {
      refused(504)(post(execution.eid, limit("limit", 7))) shouldBe
        s"Computing unit $unitCuid did not answer whether it took the change to execution " +
          s"${execution.eid}."
    }
    // Each was handed over once: the Dashboard does not hand a change over again.
    handedOver.updates.drop(before).map(_.cuid) shouldBe Seq(unitCuid, unitCuid)
  }

  it should "hand the unit nothing of a change it refuses itself" in {
    val execution = created()
    val before = handedOver.updates.size

    refused(404)(post(execution.eid, limit("ghost", 7)))
    refused(403)(post(execution.eid, limit("limit", 7), uid = strangerUid))

    handedOver.updates.drop(before) shouldBe empty
  }

  // --- refused: the change ---

  it should "refuse a change that refers to loop variables, or of an operator that does" in {
    val execution = created(plan = loopPlan())
    def loopRefusal(name: String) =
      s"$name refers to loop variables, so it can't be changed while the workflow runs."
    def postLoop(changed: LogicalOp) = post(execution.eid, changed, workflow = loopPlan())

    // The running operator refers to `n`.
    refused(400)(postLoop(limit("typed", 7))) shouldBe loopRefusal("Limit")
    // The change refers to `n`, as the editor sends "$n" in an Int property.
    refused(400)(postLoop(limitReferring("limit2", "n"))) shouldBe loopRefusal("Limit")
    // Inside a loop block a whole-string "$x" refers to a loop variable.
    refused(400)(postLoop(filter("filter", "$x"))) shouldBe loopRefusal("Filter")
    // The running Filter `bound` holds "$x" inside the block. The workflow sent keeps it as the
    // string it is, with no sidecar (a parse records only typed references), so only the
    // operator's place in the block tells that it refers to a loop variable.
    val sent = objectMapper.treeToValue(TestUtils.sentPlan(loopPlan()), classOf[LogicalPlanPojo])
    sent.operators.find(_.operatorIdentifier.id == "bound").get.stateReferences shouldBe empty
    refused(400)(postLoop(filter("bound", "Europe"))) shouldBe loopRefusal("Filter")
  }

  it should "refuse an operator that cannot be changed while it runs" in {
    val execution = created()

    refused(400)(post(execution.eid, named(TestOperators.smallCsvScanOpDesc(), "scan"))) shouldBe
      "operator CSVScanSourceOpDesc does not support reconfiguration"
  }

  it should "refuse an operator that offers a change while it runs and has no way to take one" in {
    // The editor unlocks a Python Lambda for a change (supportReconfiguration), yet the operator
    // is left with LogicalOp's own runtimeReconfiguration, which throws. The change is refused in
    // its words.
    val execution = created(plan = lambdaPlan())

    refused(400) {
      post(execution.eid, lambda("tuple_['Units Sold'] * 3"), workflow = lambdaPlan())
    } shouldBe "operator PythonLambdaFunctionOpDesc does not support reconfiguration"
  }

  it should "refuse a change its operator fails on, in the failure's words or by its type" in {
    // No descriptor of the build answers a Failure, or throws with no message: an override may.
    val execution = created()
    val outcomes: Seq[(String, () => Reconfiguration)] = Seq(
      "this operator takes no change" ->
        (() => Failure(new RuntimeException("this operator takes no change"))),
      "this operator blew up while being reconfigured" ->
        (() => throw new IllegalStateException("this operator blew up while being reconfigured")),
      "java.lang.IllegalStateException" -> (() => throw new IllegalStateException())
    )

    outcomes.foreach {
      case (refusal, outcome) =>
        val updates = new FixtureUpdates(reconfiguration = Some(outcome))
        refused(400)(post(execution.eid, limit("limit", 7), updates = updates)) shouldBe refusal
    }
  }

  it should "refuse a change its operator makes into another operator" in {
    // No descriptor of the build does: an override may build its operator under another id.
    val execution = created()
    val another = limit("other", 7)
      .getPhysicalOp(WorkflowIdentity(testWid), ExecutionIdentity(execution.eid))
    val updates = new FixtureUpdates(reconfiguration = Some(() => Success((another, None))))

    refused(400)(post(execution.eid, limit("limit", 7), updates = updates)) shouldBe
      "The change makes Limit the operator other, not one of operator limit."
  }

  it should "answer 500, not the change's refusal, when the compiling service fails" in {
    // The service's own failure, of which the Dashboard has only the status: the user is not
    // told the change was at fault.
    val execution = created()
    val updates = new FixtureUpdates(
      compiling = Some(new FixtureCompilingService(repositoriesFor = _ => {
        throw new IllegalStateException("the compiling service is broken")
      }))
    )

    val failure = intercept[InternalServerErrorException] {
      post(execution.eid, limit("limit", 7), updates = updates)
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getMessage shouldBe s"The change to execution ${execution.eid} could not be made."
    failure.getCause shouldBe a[CompileRefused]
  }

  it should "refuse a change the operator cannot be built from" in {
    val execution = created(plan = udfPlan(environment = Some("ml")))
    val blank = udf(code = changedCode("v2"), environment = Some("ml"))
    blank.envName = "  "

    refused(400)(post(execution.eid, blank, workflow = udfPlan(environment = Some("ml")))) shouldBe
      "Virtual Environment name is required when not using the default Python environment."
  }

  it should "refuse a change that makes an operator one of another type" in {
    val execution = created()

    refused(400)(post(execution.eid, limit("udf", 3))) shouldBe
      "Operator udf is a Python UDF; a change cannot make it a Limit."
  }

  it should "refuse a dataset version the creator cannot read" in {
    val execution = created()
    val unreadable = "/dataset/owner@x.com/secret/v1"

    refused(400) {
      post(execution.eid, udf(parameters = List(datasetParameter(unreadable))))
    } should include(unreadable)
  }

  it should "refuse a change larger than a computing unit takes, with how large it is and may be" in {
    val execution = created()
    // New code, then a comment as long as a change may be.
    val code = changedCode("v2") + "# " + ("x" * PhysicalPlanCodec.MaxPlanBytes) + "\n"

    refused(400)(post(execution.eid, udf(code = code))) should fullyMatch regex
      "The change is 16\\.[0-9] MiB, and a change may be at most 16 MiB\\."
  }

  it should "answer 500 for a failure to pin a version that is not the change's error" in {
    // A version that does not exist, or that the creator may not read, is the change's error
    // (400). A database that does not answer the compiling service is not: it is the service's
    // failure, which the Dashboard answers 500, so it is not taken for the user's mistake.
    val execution = created()
    val databaseDown = new DataAccessException("the database did not answer")
    val updates = new FixtureUpdates(resolver = _ => throw databaseDown)

    val failure = intercept[InternalServerErrorException] {
      post(
        execution.eid,
        udf(
          code = changedCode("v2"),
          parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))
        ),
        updates = updates
      )
    }

    failure.getMessage shouldBe s"The change to execution ${execution.eid} could not be made."
    failure.getCause shouldBe a[CompileRefused]
    updates.resolverUsers.toList shouldBe List(Integer.valueOf(creatorUid))
  }

  // --- the compiling service, asked over HTTP ---

  /** Updates that ask the compiling service at `endpoint`, as the deployment's do. */
  private def updatesAsking(
      endpoint: URI,
      deadline: FiniteDuration = ExecutionCreator.CompileDeadline
  ): OperatorUpdates =
    new OperatorUpdates(
      compiling = new WorkflowCompilingServiceClient(endpoint, connectTimeout = 2.seconds),
      units = handedOver,
      compileDeadline = deadline
    )

  it should "ask the compiling service to make the change, with the caller's own token, and hand over what it makes" in {
    val execution = created()
    val workflow = udfPlan()
    Using.resource(StubCompilingServer.compiling()) { server =>
      val update = made(
        post(
          execution.eid,
          limit("limit", 9),
          workflow = workflow,
          updates = updatesAsking(server.endpoint)
        )
      )

      // Asked once, as the caller: with the request's own Authorization header.
      val asked = server.requests
      asked.map(ask => (ask.path, ask.authorization)) shouldBe
        List(("/api/compile/update", FixtureCompilingService.authorizationOf(creatorUid)))
      val body = asked.head.body
      body.fieldNames().asScala.toSet shouldBe
        Set("workflowId", "executionId", "logicalPlan", "operator")
      body.get("workflowId").asLong() shouldBe testWid
      body.get("executionId").asLong() shouldBe execution.eid
      // The workflow and the change, as the editor sent them.
      body.get("logicalPlan") shouldBe TestUtils.sentPlan(workflow)
      body.get("operator") shouldBe TestUtils.sentOperator(limit("limit", 9))

      decoded(update).executionId shouldBe ExecutionIdentity(execution.eid)
      decoded(update).opId shouldBe PhysicalOpIdentity(OperatorIdentity("limit"), "main")
      descriptorOf(update, classOf[LimitOpDesc]).limit shouldBe 9
    }
  }

  it should "relay the compiling service's refusals of a change, with their status" in {
    val execution = created()
    Using.resource(StubCompilingServer.compiling()) { server =>
      val updates = updatesAsking(server.endpoint)

      refused(404)(post(execution.eid, limit("ghost", 7), updates = updates)) shouldBe
        "Operator ghost is not in the workflow sent with the change."
      refused(400)(post(execution.eid, limit("udf", 3), updates = updates)) shouldBe
        "Operator udf is a Python UDF; a change cannot make it a Limit."
    }
  }

  it should "answer 504 when the compiling service does not answer by the deadline, and 503 when it cannot be reached" in {
    val execution = created()
    val slow = new StubCompilingServer(_ => {
      Thread.sleep(3000)
      StubCompilingServer.Answer(200, "{}")
    })
    try {
      refused(504) {
        post(execution.eid, limit("limit", 7), updates = updatesAsking(slow.endpoint, 500.millis))
      } shouldBe s"The change to execution ${execution.eid} could not be made: the workflow " +
        "compiling service took longer than 500 milliseconds."
    } finally slow.close()

    // An address nothing listens at any more.
    refused(503) {
      post(execution.eid, limit("limit", 7), updates = updatesAsking(slow.endpoint))
    } shouldBe s"The change to execution ${execution.eid} could not be made: the workflow " +
      "compiling service could not be reached. Try again in a moment."
  }

  it should "answer 500 when the compiling service answers what is no change to the operator asked for" in {
    val execution = created()
    val another = created()
    // Changes as the service makes them: to the operator asked for of another execution, and to
    // another operator of this one.
    def madeFor(eid: Long, changed: LogicalOp): String =
      TestUtils.fixtureCompiling.updateToRun(
        WorkflowCompilingService.UpdateRequest(
          testWid,
          eid,
          TestUtils.sentPlan(udfPlan()),
          TestUtils.sentOperator(changed)
        ),
        FixtureCompilingService.authorizationOf(creatorUid),
        ExecutionCreator.CompileDeadline
      )
    val answers =
      Seq(madeFor(another.eid, limit("limit", 7)), madeFor(execution.eid, udf()))
        .map(update => objectMapper.createObjectNode().put("update", update).toString) ++
        Seq("""{"update": "{}"}""", """{"update": 7}""", "{}", "not JSON")

    answers.foreach { answer =>
      Using.resource(new StubCompilingServer(_ => StubCompilingServer.Answer(200, answer))) {
        server =>
          withClue(s"$answer: ") {
            val failure = intercept[InternalServerErrorException] {
              post(execution.eid, limit("limit", 7), updates = updatesAsking(server.endpoint))
            }
            failure.getMessage shouldBe
              s"The change to execution ${execution.eid} could not be made."
          }
      }
    }
  }

  // --- refused: the execution ---

  it should "refuse anyone but the user who created the execution, the workflow's owner included" in {
    val execution = created()
    val refusal = s"Only the user who created execution ${execution.eid} may change its operators."

    refused(403)(post(execution.eid, limit("limit", 7), uid = ownerUid)) shouldBe refusal
    refused(403)(post(execution.eid, limit("limit", 7), uid = strangerUid)) shouldBe refusal
  }

  it should "refuse the creator once they may no longer read the workflow" in {
    val execution = created()
    getDSLContext
      .deleteFrom(WORKFLOW_USER_ACCESS)
      .where(WORKFLOW_USER_ACCESS.UID.eq(Integer.valueOf(creatorUid)))
      .execute()
    try {
      refused(403)(post(execution.eid, limit("limit", 7))) shouldBe
        s"You do not have access to workflow $testWid."
    } finally grantWorkflowRead()
  }

  it should "refuse the creator once they may no longer run workflows on the unit" in {
    val execution = created()
    setUnitAccess(PrivilegeEnum.READ)
    try {
      refused(403)(post(execution.eid, limit("limit", 7))) shouldBe
        s"You may not run workflows on computing unit $unitCuid."
    } finally setUnitAccess(PrivilegeEnum.WRITE)
  }

  it should "refuse an execution created for no computing unit" in {
    insertExecution(noUnitEid, cuid = None)

    refused(403)(post(noUnitEid, limit("limit", 7))) shouldBe
      s"Execution $noUnitEid was created for no computing unit."
  }

  it should "refuse an execution there is not" in {
    Seq(979999L, 0L, -1L, Int.MaxValue.toLong + 1, Long.MaxValue).foreach { eid =>
      withClue(s"eid $eid: ") {
        refused(404)(post(eid, limit("limit", 7))) shouldBe s"There is no execution $eid."
      }
    }
  }

  it should "refuse an operator the workflow sent does not have" in {
    val execution = created()

    refused(404)(post(execution.eid, limit("ghost", 7))) shouldBe
      "Operator ghost is not in the workflow sent with the change."
  }

  it should "refuse an execution that is closed with 409, however it ended" in {
    Seq[Short](3, 4, 5).foreach { outcome =>
      val execution = created()
      ExecutionRecords.close(
        execution.eid,
        outcome,
        reason = None,
        endedAtMs = System.currentTimeMillis(),
        fromLog = false
      ) shouldBe true

      withClue(s"outcome $outcome: ") {
        refused(409)(post(execution.eid, limit("limit", 7))) shouldBe
          s"Execution ${execution.eid} has ended."
      }
    }
  }

  // --- refused: malformed ---

  it should "refuse a request that names no operator, or holds no workflow, before it reads anything" in {
    val execution = created()
    val noId = limit("limit", 7)
    noId.setOperatorId(" ")
    val nullId = limit("limit", 7)
    nullId.setOperatorId(null)
    def withWorkflow(workflow: JsonNode) =
      OperatorUpdateRequestBody(TestUtils.sentOperator(limit("limit", 7)), workflow)
    val updates = new FixtureUpdates()

    refused(400)(postBody(execution.eid, null, updates = updates)) shouldBe
      "The request has no body."
    refused(400)(post(execution.eid, null, updates = updates)) shouldBe
      "The request names no operator."
    refused(400)(post(execution.eid, noId, updates = updates)) shouldBe
      "The operator to change has no id."
    refused(400)(post(execution.eid, nullId, updates = updates)) shouldBe
      "The operator to change has no id."
    Seq(null, objectMapper.createArrayNode(), objectMapper.getNodeFactory.textNode("{}")).foreach {
      workflow =>
        withClue(s"$workflow: ") {
          refused(400)(postBody(execution.eid, withWorkflow(workflow), updates = updates)) shouldBe
            "The request holds no workflow to make the change in."
        }
    }
    // Even to a user who may not change the execution, or for one there is not.
    refused(400)(post(execution.eid, null, uid = strangerUid, updates = updates)) shouldBe
      "The request names no operator."
    refused(400)(post(979999L, null, updates = updates)) shouldBe "The request names no operator."
    // No refusal reached the binding.
    updates.resolverUsers shouldBe empty
  }

  it should "refuse a workflow sent with a change that the compiler does not read" in {
    val execution = created()
    val cyclic =
      udfPlan().copy(links = List(link("scan", "udf"), link("udf", "limit"), link("limit", "scan")))

    refused(400)(post(execution.eid, limit("limit", 7), workflow = cyclic)) shouldBe
      "The workflow's links form a cycle: scan -> udf -> limit -> scan."
  }

  it should "be served at POST /executions/{eid}/updates, to regular users and admins" in {
    val postUpdate = classOf[ExecutionResource].getMethods.find(_.getName == "postUpdate").get

    postUpdate.getAnnotation(classOf[javax.ws.rs.POST]) should not be null
    postUpdate.getAnnotation(classOf[javax.ws.rs.Path]).value() shouldBe "/{eid}/updates"
    postUpdate
      .getAnnotation(classOf[javax.annotation.security.RolesAllowed])
      .value()
      .toSet shouldBe Set("REGULAR", "ADMIN")
    postUpdate.getParameterAnnotations.head.collect {
      case param: javax.ws.rs.PathParam => param.value()
    } shouldBe Array("eid")
  }
}
