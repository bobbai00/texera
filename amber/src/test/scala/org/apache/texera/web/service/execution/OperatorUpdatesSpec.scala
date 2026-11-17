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

import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import io.dropwizard.setup.Bootstrap
import org.apache.texera.amber.core.executor.{OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.state.StateReferencing
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  NoStoredPlanException,
  PlanRecord,
  RepositoryVersionResolver
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Tuple}
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
  PythonEnvironmentRef,
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
import org.apache.texera.amber.operator.{LogicalOp, StateTransferFunc, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.auth.SessionUser
import org.apache.texera.common.compiler.{PythonEnvironmentResolver, RunBindings}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.{
  COMPUTING_UNIT_USER_ACCESS,
  USER_WAREHOUSE,
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
import org.apache.texera.web.{TexeraWebApplication, TexeraWebConfiguration}
import org.jooq.exception.DataAccessException
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.lang.reflect.Proxy
import java.net.URI
import java.nio.file.Path
import java.sql.Timestamp
import javax.ws.rs.core.{Response, UriInfo}
import javax.ws.rs.{InternalServerErrorException, WebApplicationException}
import scala.collection.mutable
import scala.jdk.CollectionConverters._
import scala.util.{Failure, Try}

/**
  * Changing an operator of a paused execution at the Dashboard service, through
  * [[ExecutionResource]]: `POST /api/executions/{eid}/updates`.
  *
  * The rows are in `MockTexeraDB`; each execution is created by [[ExecutionCreator]], so its plan
  * table is the one a change is compiled against, in the catalog the build's tests use (the
  * Postgres JDBC catalog in CI). The executions take ids after 972000, set in `beforeAll`, so
  * their plan tables are this suite's own. Plans and changes are compiled with the fixture
  * resolvers of `TestOperators`.
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

  /** Executions inserted by hand, rather than created, for the cases a create never leaves. */
  private val noPlanEid = 971901
  private val noUnitEid = 971902
  private val badBodyEid = 971903
  private val badLogicalEid = 971904
  private val otherLayerEid = 971905
  private val otherCreatorEid = 971906
  private val otherUnitEid = 971907

  /** The executions this suite creates start after this id. */
  private val firstCreatedEid = 972000

  private val creatorWarehouse = s"user-$creatorUid-spec"
  private var creatorWhid: Integer = _

  private val requestUri = new URI("http://texera.example:4200/api/executions")

  /** Every plan table this suite makes, dropped after it. */
  private val madePlans = mutable.ListBuffer.empty[URI]

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

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(creatorUid)
    warehouse.setName(creatorWarehouse)
    warehouse.setLakekeeperWarehouseName(creatorWarehouse)
    warehouse.setLakekeeperWarehouseId(java.util.UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    creatorWhid = warehouse.getWhid

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
    try madePlans.foreach(uri => Try(ExecutionPlanStore.drop(uri)))
    finally {
      closeConnectionPool()
      super.afterAll()
    }

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

  /** Inserts execution `eid` of the workflow by the creator, at `status`, with no plan. */
  private def insertExecution(eid: Int, status: Short, cuid: Option[Int] = Some(unitCuid)): Unit = {
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
      .set(WORKFLOW_EXECUTIONS.STATUS, java.lang.Short.valueOf(status))
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .execute()
  }

  private def setStatus(eid: Long, status: Short): Unit =
    getDSLContext
      .update(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.STATUS, java.lang.Short.valueOf(status))
      .where(WORKFLOW_EXECUTIONS.EID.eq(Integer.valueOf(eid.toInt)))
      .execute()

  /** Creates executions with the fixture bindings and no cost hints. */
  private class FixtureCreator(warehouses: Boolean = false) extends ExecutionCreator {
    override protected def bindingsFor(uid: Integer): RunBindings = TestUtils.fixtureBindings
    override protected def replayLogRoot: Option[URI] = None
    override protected def warehousesEnabled: Boolean = warehouses
    override protected def costHintsLoader: CostHintsLoader = NoHints
  }

  private object NoHints extends CostHintsLoader(1) {
    override def load(wid: Long, uid: Int): Option[CostHints] = None
  }

  /** What an operator answers when it is asked to build the operator a change makes of it. */
  private type Reconfiguration = Try[(PhysicalOp, Option[StateTransferFunc])]

  /**
    * The updates under test, bound to the fixtures but for `resolver`, `root` and `environments`
    * (the fixtures', unless a case gives others), and with seams set as the case needs:
    * `reconfiguration` stands in for the answer of the operator a change is made to.
    * `resolverUsers` records the user each change was bound for: bindings are made for every
    * change that reaches the binding, whether or not it names a dataset or a model.
    */
  private class FixtureUpdates(
      root: Option[Path] = Some(TestOperators.fixtureMountRoot),
      warehouses: Boolean = false,
      failAppend: Option[RuntimeException] = None,
      resolver: RepositoryVersionResolver = TestOperators.fixtureRepositoryResolver,
      environments: PythonEnvironmentResolver = TestUtils.fixtureBindings.environments,
      reconfiguration: Option[() => Reconfiguration] = None
  ) extends OperatorUpdates {
    val resolverUsers: mutable.ListBuffer[Integer] = mutable.ListBuffer.empty
    override protected def bindingsFor(uid: Integer): RunBindings = {
      resolverUsers += uid
      TestUtils.fixtureBindings.copy(
        repositories = resolver,
        mountRoot = root,
        environments = environments
      )
    }
    override protected def warehousesEnabled: Boolean = warehouses
    override protected def appendUpdate(planUri: URI, record: PlanRecord): Unit =
      failAppend match {
        case Some(failure) => throw failure
        case None          => super.appendUpdate(planUri, record)
      }
    override protected def reconfigure(
        current: LogicalOp,
        changed: LogicalOp,
        workflowId: WorkflowIdentity,
        executionId: ExecutionIdentity
    ): Reconfiguration =
      reconfiguration.fold(super.reconfigure(current, changed, workflowId, executionId))(_())
  }

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
      fixtureCreator: ExecutionCreator = new FixtureCreator(),
      fixtureUpdates: OperatorUpdates = new FixtureUpdates()
  ): ExecutionResource =
    new ExecutionResource {
      override protected def creator: ExecutionCreator = fixtureCreator
      override protected def updates: OperatorUpdates = fixtureUpdates
    }

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

  private def createRequest(
      plan: LogicalPlanPojo,
      warehouseId: Option[Int] = None,
      targets: List[String] = Nil
  ): CreateExecutionRequest =
    CreateExecutionRequest(
      wid = testWid,
      executionName = "operator-updates-spec",
      engineVersion = "1.4.0-spec",
      logicalPlan = plan,
      workflowSettings = None,
      computingUnitId = unitCuid,
      warehouseId = warehouseId,
      replayFromExecution = None,
      targetOperatorIds = targets
    )

  /** An execution the creator created; its plan table is dropped after the suite. */
  private def created(
      plan: LogicalPlanPojo = udfPlan(),
      creator: FixtureCreator = new FixtureCreator(),
      warehouseId: Option[Int] = None,
      targets: List[String] = Nil
  ): CreateExecutionResponse = {
    val response = resource(fixtureCreator = creator)
      .create(createRequest(plan, warehouseId, targets), sessionUser(creatorUid), uriInfo)
    withClue(s"${response.getEntity}: ") { response.getStatus shouldBe 201 }
    val execution = response.getEntity.asInstanceOf[CreateExecutionResponse]
    madePlans += new URI(execution.planUri)
    execution
  }

  private def post(
      eid: Long,
      operator: LogicalOp,
      uid: Int = creatorUid,
      updates: OperatorUpdates = new FixtureUpdates()
  ): Response =
    resource(fixtureUpdates = updates)
      .postUpdate(eid, OperatorUpdateRequestBody(operator), sessionUser(uid))

  /** The update a 200 stored. */
  private def stored(response: Response): OperatorUpdateResponse = {
    withClue(s"${response.getEntity}: ") { response.getStatus shouldBe 200 }
    response.getEntity.asInstanceOf[OperatorUpdateResponse]
  }

  /** The message of the refusal `body` throws, which answers `status`. */
  private def refused(status: Int)(body: => Any): String = {
    val refusal = intercept[WebApplicationException](body)
    withClue(s"${refusal.getMessage}: ") { refusal.getResponse.getStatus shouldBe status }
    refusal.getMessage
  }

  /** Every update row of the plan table at `planUri`. */
  private def updateRows(planUri: String): List[PlanRecord] =
    DocumentFactory
      .openDocument(new URI(planUri))
      ._1
      .asInstanceOf[VirtualDocument[Tuple]]
      .get()
      .map(PlanRecord.fromTuple)
      .filter(_.kind == ExecutionPlanStore.UpdateKind)
      .toList

  /**
    * The JSON text of a stored plan, `json`, with every id of operator `operatorId`'s layer "main"
    * (the operator's own, its links' and its stored ports') naming the layer `layer` instead.
    */
  private def renamedLayer(json: String, operatorId: String, layer: String): String = {
    val tree = objectMapper.readTree(json)
    def rename(node: JsonNode): Unit =
      node match {
        case identity: ObjectNode
            if identity.path("logicalOpId").path("id").asText() == operatorId &&
              identity.path("layerName").asText() == "main" =>
          identity.put("layerName", layer)
        case container if container.isContainerNode =>
          container.elements().asScala.toList.foreach(rename)
        case _ => // a value: no id
      }
    rename(tree)
    objectMapper.writeValueAsString(tree)
  }

  private def readUpdate(execution: CreateExecutionResponse, updateId: String): PlanRecord =
    ExecutionPlanStore.readUpdate(new URI(execution.planUri), updateId)

  private def decoded(record: PlanRecord): OperatorUpdate =
    PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(record.body))

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

  // --- stored ---

  "ExecutionResource.postUpdate" should
    "store the change as an update row of the execution's plan, made to run for its creator" in {
    val execution = created()
    val planBefore = ExecutionPlanStore.readPlan(new URI(execution.planUri))
    val updates = new FixtureUpdates()
    val before = System.currentTimeMillis()

    val update = stored(post(execution.eid, udf(code = changedCode("v2")), updates = updates))

    update.operatorId shouldBe "udf"
    update.updateId should fullyMatch regex "update-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    val record = readUpdate(execution, update.updateId)
    record.entryId shouldBe update.updateId
    record.kind shouldBe ExecutionPlanStore.UpdateKind
    record.formatVersion shouldBe PhysicalPlanCodec.FormatVersion
    record.createdBy shouldBe creatorUid
    record.computingUnitId shouldBe unitCuid
    record.notification shouldBe None
    record.createdAt.getTime should be >= (before - 1000)
    // What the unit applies: the new code for the running operator, of this execution.
    decoded(record) shouldBe OperatorUpdate(
      ExecutionIdentity(execution.eid),
      update.updateId,
      udfOpId,
      OpExecWithCode(changedCode("v2"), "python"),
      None
    )
    // The change as the editor sent it.
    val logical = objectMapper.readValue(record.logical, classOf[LogicalOp])
    logical shouldBe a[PythonUDFOpDescV2]
    logical.operatorIdentifier shouldBe OperatorIdentity("udf")
    logical.asInstanceOf[PythonUDFOpDescV2].code shouldBe changedCode("v2")
    objectMapper.readTree(record.logical).has(StateReferencing.SIDECAR_PROPERTY) shouldBe false
    // Bound as the creator may read, and the plan row left as it was.
    updates.resolverUsers.toSet shouldBe Set(Integer.valueOf(creatorUid))
    ExecutionPlanStore.readPlan(new URI(execution.planUri)) shouldBe planBefore
    updateRows(execution.planUri).map(_.entryId) shouldBe List(update.updateId)
  }

  it should "keep each change of a pause as a row of its own" in {
    val execution = created()

    val first = stored(post(execution.eid, udf(code = changedCode("v2"))))
    val second = stored(post(execution.eid, limit("limit", 9)))

    first.updateId should not be second.updateId
    updateRows(execution.planUri).map(_.entryId).toSet shouldBe
      Set(first.updateId, second.updateId)
    decoded(readUpdate(execution, first.updateId)).opExecInitInfo shouldBe
      OpExecWithCode(changedCode("v2"), "python")
    val limitUpdate = decoded(readUpdate(execution, second.updateId))
    limitUpdate.opId shouldBe PhysicalOpIdentity(OperatorIdentity("limit"), "main")
    objectMapper
      .readValue(
        limitUpdate.opExecInitInfo.asInstanceOf[OpExecWithClassName].descString,
        classOf[LimitOpDesc]
      )
      .limit shouldBe 9
  }

  it should "pin the datasets a changed UDF names, as its plan was pinned" in {
    val execution = created()
    val changed = udf(
      code = changedCode("v2"),
      parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))
    )

    val update = decoded(readUpdate(execution, stored(post(execution.eid, changed)).updateId))

    update.repositoryMounts shouldBe Some(
      RepositoryMounts(TestOperators.fixtureMountRoot.toString, Set("dataset-1:d4t4"))
    )
    update.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(
        changedCode("v2"),
        List(
          datasetParameter(
            TestOperators.fixtureMountRoot.resolve("dataset-1").resolve("d4t4").toString
          )
        )
      ),
      "python"
    )
  }

  it should "store changes at any status before the execution ends" in {
    val execution = created()

    Seq[Short](0, 1, 2).foreach { status =>
      setStatus(execution.eid, status)
      withClue(s"status $status: ") {
        stored(post(execution.eid, udf(code = changedCode(s"s$status"))))
      }
    }
  }

  it should "read the plan from the creator's warehouse while per-user warehouses are enabled" in {
    val execution =
      created(creator = new FixtureCreator(warehouses = true), warehouseId = Some(creatorWhid))
    execution.planUri should startWith(s"vfs:///wh/$creatorWarehouse/")

    val update =
      stored(
        post(
          execution.eid,
          udf(code = changedCode("v2")),
          updates = new FixtureUpdates(warehouses = true)
        )
      )

    readUpdate(execution, update.updateId).createdBy shouldBe creatorUid
  }

  it should "change an operator inside a loop block that refers to no loop variable, and a '$x' literal outside every block" in {
    val execution = created(plan = loopPlan())

    stored(post(execution.eid, filter("filter", "Europe")))
    // Outside every block "$y" is the literal it is everywhere else.
    val literal = stored(post(execution.eid, filter("pre", "$y")))

    objectMapper
      .readTree(readUpdate(execution, literal.updateId).logical)
      .get("predicates")
      .get(0)
      .get("value")
      .asText() shouldBe "$y"
  }

  it should "parse a change as the Dashboard's mapper reads the request" in {
    val execution = created()
    val body = dashboardMapper.readValue(
      """{"operator": {"operatorType": "Limit", "operatorID": "limit", "limit": 7}}""",
      classOf[OperatorUpdateRequestBody]
    )

    val update = stored(
      resource().postUpdate(execution.eid, body, sessionUser(creatorUid))
    )

    update.operatorId shouldBe "limit"
    objectMapper
      .readTree(readUpdate(execution, update.updateId).logical)
      .get("limit")
      .asInt() shouldBe 7
  }

  it should "write the update it stored as {updateId, operatorId}" in {
    val execution = created()
    val update = stored(post(execution.eid, limit("limit", 7)))

    val written = dashboardMapper.readTree(dashboardMapper.writeValueAsString(update))

    written.fieldNames().asScala.toSet shouldBe Set("updateId", "operatorId")
    written.get("updateId").asText() shouldBe update.updateId
    written.get("operatorId").asText() shouldBe "limit"
  }

  // --- refused: the change ---

  it should "refuse a change that refers to loop variables, or of an operator that does" in {
    val execution = created(plan = loopPlan())
    def loopRefusal(name: String) =
      s"$name refers to loop variables, so it can't be changed while the workflow runs."

    // The running operator refers to `n`.
    refused(400)(post(execution.eid, limit("typed", 7))) shouldBe loopRefusal("Limit")
    // The change refers to `n`, as the editor sends "$n" in an Int property.
    refused(400)(post(execution.eid, limitReferring("limit2", "n"))) shouldBe loopRefusal("Limit")
    // Inside a loop block a whole-string "$x" refers to a loop variable.
    refused(400)(post(execution.eid, filter("filter", "$x"))) shouldBe loopRefusal("Filter")
    // The running Filter `bound` holds "$x" inside the block. The plan row's logical plan keeps
    // it as the string it is, with no sidecar (a parse records only typed references), so only
    // the operator's place in the block tells that it refers to a loop variable.
    val workflow = objectMapper.readValue(
      ExecutionPlanStore.readPlan(new URI(execution.planUri)).logical,
      classOf[LogicalPlanPojo]
    )
    workflow.operators.find(_.operatorIdentifier.id == "bound").get.stateReferences shouldBe empty
    refused(400)(post(execution.eid, filter("bound", "Europe"))) shouldBe loopRefusal("Filter")
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse an operator that cannot be changed while it runs" in {
    val execution = created()

    refused(400)(post(execution.eid, named(TestOperators.smallCsvScanOpDesc(), "scan"))) shouldBe
      "operator CSVScanSourceOpDesc does not support reconfiguration"
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse an operator that offers a change while it runs and has no way to take one" in {
    // The editor unlocks a Python Lambda for a change (supportReconfiguration), yet the operator
    // is left with LogicalOp's own runtimeReconfiguration, which throws. The change is refused in
    // its words, and what was stored earlier in the pause stays.
    val execution = created(plan = lambdaPlan())
    val earlier = stored(post(execution.eid, limit("limit", 9)))

    refused(400)(post(execution.eid, lambda("tuple_['Units Sold'] * 3"))) shouldBe
      "operator PythonLambdaFunctionOpDesc does not support reconfiguration"
    updateRows(execution.planUri).map(_.entryId) shouldBe List(earlier.updateId)
  }

  it should "refuse a change its operator fails on, in the failure's words or by its type" in {
    // No descriptor of the build answers a Failure, or throws with no message: an override may.
    val execution = created()
    val earlier = stored(post(execution.eid, limit("limit", 9)))
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
    updateRows(execution.planUri).map(_.entryId) shouldBe List(earlier.updateId)
  }

  it should "throw, as it is, a fatal error of the operator a change is made to" in {
    // Not the change's refusal: it is thrown on, so the user is not told the change was at fault.
    val execution = created()
    val updates =
      new FixtureUpdates(reconfiguration = Some(() => throw new InterruptedException("stop")))

    an[InterruptedException] should be thrownBy
      post(execution.eid, limit("limit", 7), updates = updates)
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse a change the operator cannot be built from" in {
    val execution = created(plan = udfPlan(environment = Some("ml")))
    val blank = udf(code = changedCode("v2"), environment = Some("ml"))
    blank.envName = "  "

    refused(400)(post(execution.eid, blank)) shouldBe
      "Virtual Environment name is required when not using the default Python environment."
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse a change that makes an operator one of another type" in {
    val execution = created()

    refused(400)(post(execution.eid, limit("udf", 3))) shouldBe
      "Operator udf is a Python UDF; a change cannot make it a Limit."
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse a change that makes an operator the running plan does not have" in {
    // A plan whose Limit runs as the layer "other": a change builds it as "main", which the unit
    // would refuse to apply.
    val execution = created()
    val plan = ExecutionPlanStore.readPlan(new URI(execution.planUri))
    insertExecution(otherLayerEid, status = 2)
    val uri =
      ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(otherLayerEid), None)
    // The plan of this execution, as its own.
    val ownId = "\"id\": \"" + execution.eid + "\""
    plan.body should include(ownId)
    val body = PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.fromJson(
        renamedLayer(
          plan.body.replace(ownId, "\"id\": \"" + otherLayerEid + "\""),
          "limit",
          "other"
        )
      )
    )
    PhysicalPlanCodec
      .decode(PhysicalPlanCodec.fromJson(body))
      .plan
      .operators
      .map(_.id) should contain(PhysicalOpIdentity(OperatorIdentity("limit"), "other"))
    ExecutionPlanStore.writePlan(uri, plan.copy(body = body))
    madePlans += uri

    refused(400)(post(otherLayerEid, limit("limit", 7))) shouldBe
      "The change makes Limit the operator limit-main, which the running workflow does not have."
    updateRows(uri.toString) shouldBe empty
  }

  it should "refuse a change of the Python environment the operator runs in" in {
    val inDefault = created()
    val inMl = created(plan = udfPlan(environment = Some("ml")))
    val refusal = "the operator's Python environment cannot change while the run is paused"

    refused(400)(post(inDefault.eid, udf(environment = Some("ml")))) shouldBe refusal
    refused(400)(post(inMl.eid, udf())) shouldBe refusal
    refused(400)(post(inMl.eid, udf(environment = Some("other")))) shouldBe refusal
    updateRows(inDefault.planUri) shouldBe empty
    updateRows(inMl.planUri) shouldBe empty
    // The same environment, written as the editor may, is no change of it.
    stored(post(inMl.eid, udf(code = changedCode("v2"), environment = Some("  ml  "))))
  }

  it should "take the environment a running operator has from its plan, asking for it no more" in {
    // The operator's workers keep the interpreter the plan gave them: what the creator keeps
    // under the environment's name by now, or no longer keeps, changes nothing for the run.
    val execution = created(plan = udfPlan(environment = Some("ml")))
    val running = PhysicalPlanCodec
      .decode(
        PhysicalPlanCodec.fromJson(ExecutionPlanStore.readPlan(new URI(execution.planUri)).body)
      )
      .plan
      .getOperator(PhysicalOpIdentity(OperatorIdentity("udf"), "main"))
    running.pythonEnvironment shouldBe PythonEnvironmentRef.Resolved(TestUtils.fixtureEnvironment)
    val asked = mutable.ListBuffer.empty[String]
    val updates = new FixtureUpdates(environments = name => {
      asked += name
      fail(s"asked to resolve the environment '$name'")
    })

    val update = stored(
      post(
        execution.eid,
        udf(code = changedCode("v2"), environment = Some("ml")),
        updates = updates
      )
    )

    asked shouldBe empty
    updateRows(execution.planUri).map(_.entryId) shouldBe List(update.updateId)
  }

  it should "refuse a dataset version the creator cannot read, or with no root to mount it under" in {
    val execution = created()
    val unreadable = "/dataset/owner@x.com/secret/v1"

    refused(400) {
      post(execution.eid, udf(parameters = List(datasetParameter(unreadable))))
    } should include(unreadable)
    refused(400) {
      post(
        execution.eid,
        udf(parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))),
        updates = new FixtureUpdates(root = None)
      )
    } should include("no directory to mount it under")
    updateRows(execution.planUri) shouldBe empty
  }

  it should "throw, as it is, a failure to pin a version that is not the change's error" in {
    // A version that does not exist, or that the creator may not read, is the change's error
    // (400). A database that does not answer is not: it is thrown as it is, which the Dashboard
    // answers 500, so it is not taken for the user's mistake.
    val execution = created()
    val databaseDown = new DataAccessException("the database did not answer")
    val updates = new FixtureUpdates(resolver = _ => throw databaseDown)

    val thrown = intercept[DataAccessException] {
      post(
        execution.eid,
        udf(
          code = changedCode("v2"),
          parameters = List(datasetParameter("/dataset/owner@x.com/sales/v1"))
        ),
        updates = updates
      )
    }

    thrown should be theSameInstanceAs databaseDown
    updates.resolverUsers.toList shouldBe List(Integer.valueOf(creatorUid))
    updateRows(execution.planUri) shouldBe empty
  }

  // --- refused: the execution ---

  it should "refuse anyone but the user who created the execution, the workflow's owner included" in {
    val execution = created()
    val refusal = s"Only the user who created execution ${execution.eid} may change its operators."

    refused(403)(post(execution.eid, limit("limit", 7), uid = ownerUid)) shouldBe refusal
    refused(403)(post(execution.eid, limit("limit", 7), uid = strangerUid)) shouldBe refusal
    updateRows(execution.planUri) shouldBe empty
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
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse the creator once they may no longer run workflows on the unit" in {
    val execution = created()
    setUnitAccess(PrivilegeEnum.READ)
    try {
      refused(403)(post(execution.eid, limit("limit", 7))) shouldBe
        s"You may not run workflows on computing unit $unitCuid."
    } finally setUnitAccess(PrivilegeEnum.WRITE)
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse an execution created for no computing unit" in {
    insertExecution(noUnitEid, status = 2, cuid = None)

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

  it should "refuse an operator the workflow the execution runs does not have" in {
    val execution = created()
    // Created up to the UDF: the Limit after it is not in the workflow the execution runs.
    val upToUdf = created(targets = List("udf"))

    refused(404)(post(execution.eid, limit("ghost", 7))) shouldBe
      s"Operator ghost is not in the workflow execution ${execution.eid} runs."
    refused(404)(post(upToUdf.eid, limit("limit", 7))) shouldBe
      s"Operator limit is not in the workflow execution ${upToUdf.eid} runs."
    updateRows(execution.planUri) shouldBe empty
    updateRows(upToUdf.planUri) shouldBe empty
  }

  it should "refuse an execution that has ended with 409" in {
    val execution = created()

    Seq[Short](3, 4, 5).foreach { status =>
      setStatus(execution.eid, status)
      withClue(s"status $status: ") {
        refused(409)(post(execution.eid, limit("limit", 7))) shouldBe
          s"execution ${execution.eid} has ended"
      }
    }
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse an execution whose plan is in a per-user warehouse while those are disabled" in {
    val execution =
      created(creator = new FixtureCreator(warehouses = true), warehouseId = Some(creatorWhid))

    refused(409)(post(execution.eid, limit("limit", 7))) shouldBe
      s"Execution ${execution.eid} keeps its plan in warehouse '$creatorWarehouse', and " +
        "per-user warehouses are disabled in this deployment."
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse an execution that has no stored plan" in {
    insertExecution(noPlanEid, status = 2)

    refused(404)(post(noPlanEid, limit("limit", 7))) shouldBe
      s"execution $noPlanEid has no stored plan"
  }

  // --- refused: malformed ---

  it should "refuse a request that names no operator, before it reads anything" in {
    val execution = created()
    val noId = limit("limit", 7)
    noId.setOperatorId(" ")
    val nullId = limit("limit", 7)
    nullId.setOperatorId(null)
    val updates = new FixtureUpdates()

    refused(400) {
      resource(fixtureUpdates = updates).postUpdate(execution.eid, null, sessionUser(creatorUid))
    } shouldBe "The request has no body."
    refused(400)(post(execution.eid, null, updates = updates)) shouldBe
      "The request names no operator."
    refused(400)(post(execution.eid, noId, updates = updates)) shouldBe
      "The operator to change has no id."
    refused(400)(post(execution.eid, nullId, updates = updates)) shouldBe
      "The operator to change has no id."
    // Even to a user who may not change the execution, or for one there is not.
    refused(400)(post(execution.eid, null, uid = strangerUid, updates = updates)) shouldBe
      "The request names no operator."
    refused(400)(post(979999L, null, updates = updates)) shouldBe "The request names no operator."
    // No refusal reached the binding.
    updates.resolverUsers shouldBe empty
    updateRows(execution.planUri) shouldBe empty
  }

  // --- the plan cannot be read, or the change stored ---

  it should "answer 500 when the stored plan cannot be read" in {
    val execution = created()
    val plan = ExecutionPlanStore.readPlan(new URI(execution.planUri))
    insertExecution(badBodyEid, status = 2)
    insertExecution(badLogicalEid, status = 2)
    Seq(
      badBodyEid -> plan.copy(body = "{}"),
      badLogicalEid -> plan.copy(logical = "[]")
    ).foreach {
      case (eid, record) =>
        val uri =
          ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(eid), None)
        ExecutionPlanStore.writePlan(uri, record)
        madePlans += uri
    }

    Seq(badBodyEid, badLogicalEid).foreach { eid =>
      withClue(s"execution $eid: ") {
        val failure =
          intercept[InternalServerErrorException](post(eid, limit("limit", 7)))
        failure.getResponse.getStatus shouldBe 500
        failure.getMessage shouldBe s"The stored plan of execution $eid cannot be read."
        failure.getCause should not be null
      }
    }
  }

  it should "answer 500 when the change cannot be stored" in {
    val execution = created()
    val lakeDown = new RuntimeException("the catalog does not answer")

    val failure = intercept[InternalServerErrorException] {
      post(
        execution.eid,
        limit("limit", 7),
        updates = new FixtureUpdates(failAppend = Some(lakeDown))
      )
    }

    failure.getResponse.getStatus shouldBe 500
    failure.getMessage shouldBe
      s"The change to operator limit of execution ${execution.eid} could not be stored."
    failure.getCause shouldBe lakeDown
    updateRows(execution.planUri) shouldBe empty
  }

  it should "refuse a change whose plan table is gone by the time the change is stored" in {
    // The execution was deleted while the change was compiled: the append finds no table.
    val execution = created()
    val dropped = new NoStoredPlanException(new URI(execution.planUri))

    refused(404) {
      post(
        execution.eid,
        limit("limit", 7),
        updates = new FixtureUpdates(failAppend = Some(dropped))
      )
    } shouldBe s"execution ${execution.eid} has no stored plan"
  }

  it should "answer 500 when the stored plan was made for another user or computing unit" in {
    // The unit runs the plan for the user and on the unit its plan row names, and would refuse
    // a change stored for the ones the execution's row names.
    val execution = created()
    val plan = ExecutionPlanStore.readPlan(new URI(execution.planUri))
    insertExecution(otherCreatorEid, status = 2)
    insertExecution(otherUnitEid, status = 2)
    val plans = Seq(
      otherCreatorEid -> plan.copy(createdBy = ownerUid),
      otherUnitEid -> plan.copy(computingUnitId = unitCuid + 1)
    ).map {
      case (eid, record) =>
        val uri =
          ExecutionPlanStore.planUri(WorkflowIdentity(testWid), ExecutionIdentity(eid), None)
        ExecutionPlanStore.writePlan(uri, record)
        madePlans += uri
        eid -> uri
    }

    plans.foreach {
      case (eid, uri) =>
        withClue(s"execution $eid: ") {
          val failure = intercept[InternalServerErrorException](post(eid, limit("limit", 7)))
          failure.getResponse.getStatus shouldBe 500
          failure.getMessage shouldBe
            s"The stored plan of execution $eid was made for another user or computing unit."
          failure.getCause.getMessage should include(s"The plan row of execution $eid names user")
          updateRows(uri.toString) shouldBe empty
        }
    }
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
