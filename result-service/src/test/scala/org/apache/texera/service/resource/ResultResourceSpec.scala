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

package org.apache.texera.service.resource

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import io.dropwizard.auth.AuthValueFactoryProvider
import io.dropwizard.jackson.Jackson
import io.dropwizard.testing.junit5.ResourceExtension
import jakarta.ws.rs.ServiceUnavailableException
import jakarta.ws.rs.core.{HttpHeaders, MediaType, Response}
import org.apache.iceberg.catalog.TableIdentifier
import org.apache.iceberg.types.Types
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionTables,
  IcebergCatalogInstance,
  LocalHadoopIcebergCatalog,
  VFSURIFactory
}
import org.apache.texera.amber.core.storage.model.{BufferedItemWriter, VirtualDocument}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.OutputPort.OutputMode
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.auth.{JwtAuth, JwtAuthFilter, SessionUser, UnauthorizedExceptionMapper}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.{USER_WAREHOUSE, WORKFLOW_EXECUTIONS}
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
  UserWarehouseFlavorEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  ComputingUnitUserAccessDao,
  UserDao,
  WorkflowComputingUnitDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowOfUserDao,
  WorkflowUserAccessDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  ComputingUnitUserAccess,
  User,
  Workflow,
  WorkflowComputingUnit,
  WorkflowExecutions,
  WorkflowOfUser,
  WorkflowUserAccess,
  WorkflowVersion
}
import org.glassfish.jersey.server.filter.RolesAllowedDynamicFeature
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.net.URI
import java.sql.Timestamp
import java.util.{Locale, UUID}

/**
  * Sends requests through the Jersey pipeline production uses, against an embedded database and
  * real Iceberg tables in a local Hadoop catalog, the way WorkflowCore's storage specs read them.
  * An execution's results are the result tables named after it, as a computing unit makes them:
  * each records its port's output mode.
  */
class ResultResourceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  private val Completed: Short = 3
  private val Failed: Short = 4
  private val Killed: Short = 5

  private val schema = new Schema(
    new Attribute("id", AttributeType.INTEGER),
    new Attribute("first_name", AttributeType.STRING),
    new Attribute("Last_Name", AttributeType.STRING)
  )

  private def tuple(id: Int): Tuple =
    Tuple.builder(schema).addSequentially(Array[Any](id, s"first-$id", s"last-$id")).build()

  private val rows: Seq[Tuple] = (0 until 25).map(tuple)

  // Mirror production's mapper: ResultService registers DefaultScalaModule on Dropwizard's.
  private val mapper: ObjectMapper = Jackson.newObjectMapper().registerModule(DefaultScalaModule)

  private val resources: ResourceExtension = ResourceExtension
    .builder()
    .setMapper(mapper)
    .addProvider(classOf[JwtAuthFilter])
    .addProvider(classOf[UnauthorizedExceptionMapper])
    .addProvider(classOf[RolesAllowedDynamicFeature])
    .addProvider(new AuthValueFactoryProvider.Binder(classOf[SessionUser]))
    .addResource(new ResultResource(warehousesEnabled = true))
    .build()

  private def newUser(uid: Int, name: String): User = {
    val user = new User
    user.setUid(uid)
    user.setName(name)
    user.setEmail(s"$name@example.com")
    user.setRole(UserRoleEnum.REGULAR)
    user
  }

  // Owns the workflow below, the computing unit its runs use, and a warehouse.
  private val owner = newUser(1, "owner")
  // Granted the workflow, but not the computing unit.
  private val grantee = newUser(2, "grantee")
  // Holds no grant: the workflow below is public, which is all this user has.
  private val publicViewer = newUser(3, "public-viewer")
  // Shares the owner's computing unit, but not the workflow.
  private val unitSharer = newUser(4, "unit-sharer")

  private val warehouseName = "results-spec-wh"

  private var wid: Integer = _
  private var vid: Integer = _
  private var unit: Integer = _
  private var whid: Integer = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    LocalHadoopIcebergCatalog.ensure(warehouseName)
    resources.before()

    val configuration = getDSLContext.configuration()
    val userDao = new UserDao(configuration)
    Seq(owner, grantee, publicViewer, unitSharer).foreach(user => userDao.insert(user))

    val computingUnit = new WorkflowComputingUnit
    computingUnit.setUid(owner.getUid)
    computingUnit.setName("owner-unit")
    computingUnit.setCreationTime(new Timestamp(0L))
    computingUnit.setType(WorkflowComputingUnitTypeEnum.local)
    computingUnit.setUri("local://owner-unit")
    computingUnit.setResource("{}")
    new WorkflowComputingUnitDao(configuration).insert(computingUnit)
    unit = computingUnit.getCuid

    val unitAccess = new ComputingUnitUserAccess
    unitAccess.setCuid(unit)
    unitAccess.setUid(unitSharer.getUid)
    unitAccess.setPrivilege(PrivilegeEnum.READ)
    new ComputingUnitUserAccessDao(configuration).insert(unitAccess)

    val workflow = new Workflow
    workflow.setName("public-workflow")
    workflow.setContent("{}")
    workflow.setIsPublic(true)
    new WorkflowDao(configuration).insert(workflow)
    wid = workflow.getWid

    val ownership = new WorkflowOfUser
    ownership.setUid(owner.getUid)
    ownership.setWid(wid)
    new WorkflowOfUserDao(configuration).insert(ownership)

    val grant = new WorkflowUserAccess
    grant.setUid(grantee.getUid)
    grant.setWid(wid)
    grant.setPrivilege(PrivilegeEnum.READ)
    new WorkflowUserAccessDao(configuration).insert(grant)

    val version = new WorkflowVersion
    version.setWid(wid)
    version.setContent("{}")
    new WorkflowVersionDao(configuration).insert(version)
    vid = version.getVid

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(owner.getUid)
    warehouse.setName("owner-warehouse")
    warehouse.setLakekeeperWarehouseName(warehouseName)
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    whid = warehouse.getWhid
  }

  override protected def afterAll(): Unit = {
    resources.after()
    shutdownDB()
  }

  override protected def beforeEach(): Unit =
    getDSLContext.deleteFrom(WORKFLOW_EXECUTIONS).execute()

  /**
    * An execution of the workflow, on the owner's computing unit unless `on` says otherwise:
    * closed with `outcome`, or open while it has none.
    */
  private def insertExecution(
      startedBy: User,
      outcome: Option[Short] = Some(Completed),
      on: Option[Integer] = Some(unit),
      warehouse: Option[Integer] = None
  ): Integer = {
    val execution = new WorkflowExecutions
    execution.setVid(vid)
    execution.setUid(startedBy.getUid)
    execution.setCuid(on.orNull)
    execution.setWhid(warehouse.orNull)
    execution.setEnvironmentVersion("test")
    outcome.foreach { ended =>
      execution.setOutcome(Short.box(ended))
      execution.setEndedAt(new Timestamp(System.currentTimeMillis()))
    }
    new WorkflowExecutionsDao(getDSLContext.configuration()).insert(execution)
    execution.getEid
  }

  private def globalPort(
      operatorId: String,
      port: Int = 0,
      internal: Boolean = false
  ): GlobalPortIdentity =
    GlobalPortIdentity(
      PhysicalOpIdentity(OperatorIdentity(operatorId), "main"),
      PortIdentity(port, internal)
    )

  private def portBase(
      eid: Integer,
      port: GlobalPortIdentity,
      warehouse: Option[String] = None
  ): URI =
    VFSURIFactory.createPortBaseURI(
      WorkflowIdentity(wid.longValue()),
      ExecutionIdentity(eid.longValue()),
      port,
      warehouse
    )

  /**
    * Stores `data` in a real result table of `eid`, made as a computing unit makes one: with
    * `mode` recorded, unless it is None.
    */
  private def storeResult(
      eid: Integer,
      operatorId: String = "op",
      port: Int = 0,
      data: Seq[Tuple] = rows,
      mode: Option[OutputMode] = Some(OutputMode.SET_SNAPSHOT),
      internal: Boolean = false,
      warehouse: Option[String] = None
  ): URI = {
    val uri =
      VFSURIFactory.resultURI(portBase(eid, globalPort(operatorId, port, internal), warehouse))
    val document = DocumentFactory.createDocument(
      uri,
      schema,
      mode.map(ExecutionTables.resultTableProperties).getOrElse(Map.empty)
    )
    write(document, data, "store")
    uri
  }

  private def write(document: VirtualDocument[_], data: Seq[Tuple], writerId: String): Unit = {
    val writer = document.writer(writerId).asInstanceOf[BufferedItemWriter[Tuple]]
    writer.open()
    data.foreach(writer.putOne)
    writer.close()
  }

  private def get(caller: User, path: String, query: (String, Any)*): Response =
    query
      .foldLeft(resources.target(path)) {
        case (target, (name, value)) => target.queryParam(name, value.toString)
      }
      .request(MediaType.APPLICATION_JSON)
      .header(HttpHeaders.AUTHORIZATION, s"Bearer ${JwtAuth.jwtToken(JwtAuth.jwtClaims(caller))}")
      .get()

  private def getJson(caller: User, path: String, query: (String, Any)*): JsonNode = {
    val response = get(caller, path, query: _*)
    response.getStatus shouldBe 200
    response.readEntity(classOf[JsonNode])
  }

  private def latestExecutionPath = s"/results/workflows/$wid/latest-execution"
  private def resultsPath(eid: Integer) = s"/results/executions/$eid"
  private def pagesPath(eid: Integer) = s"/results/executions/$eid/operators/op/pages"
  private def statisticsPath(eid: Integer) = s"/results/executions/$eid/operators/op/statistics"
  private def readPaths(eid: Integer) =
    Seq(resultsPath(eid), pagesPath(eid), statisticsPath(eid))

  private def columnNames(page: JsonNode): List[String] =
    (0 until page.get("schema").size).toList
      .map(page.get("schema").get(_).get("attributeName").asText)

  "GET latest-execution" should "return the caller's latest finished execution" in {
    insertExecution(owner, Some(Completed))
    val latest = insertExecution(owner, Some(Failed))
    insertExecution(owner, outcome = None)
    insertExecution(grantee, Some(Completed))

    getJson(owner, latestExecutionPath).get("eid").asInt shouldBe latest
  }

  it should "count completed, failed and killed executions as finished" in {
    Seq(Completed, Failed, Killed).foreach { outcome =>
      val eid = insertExecution(owner, Some(outcome))
      getJson(owner, latestExecutionPath).get("eid").asInt shouldBe eid
    }
  }

  it should "answer 404 while the caller has no finished execution" in {
    insertExecution(owner, outcome = None)
    insertExecution(grantee, Some(Completed))

    get(owner, latestExecutionPath).getStatus shouldBe 404
  }

  "Reading an execution" should "be allowed for the user who started it" in {
    // The public viewer started this one, so its results are theirs despite holding no grant.
    val eid = insertExecution(publicViewer)
    storeResult(eid)

    readPaths(eid).foreach(path => withClue(path)(get(publicViewer, path).getStatus shouldBe 200))
  }

  it should "be allowed for anyone who can use the computing unit it ran on" in {
    val eid = insertExecution(publicViewer)
    storeResult(eid)

    // The unit's owner, and a user the unit was shared with who holds nothing on the workflow.
    for (caller <- Seq(owner, unitSharer); path <- readPaths(eid)) {
      withClue(s"${caller.getName} on $path")(get(caller, path).getStatus shouldBe 200)
    }
  }

  it should "be refused for a user who only has the workflow, granted or public" in {
    // No table is stored, so a refusal that came after looking for them would be a 404.
    val eid = insertExecution(owner)

    for (caller <- Seq(grantee, publicViewer); path <- readPaths(eid)) {
      withClue(s"${caller.getName} on $path")(get(caller, path).getStatus shouldBe 403)
    }
  }

  it should "be refused to all but its starter when no computing unit was recorded" in {
    val eid = insertExecution(owner, on = None)
    storeResult(eid)

    readPaths(eid).foreach { path =>
      withClue(path) {
        get(owner, path).getStatus shouldBe 200
        get(unitSharer, path).getStatus shouldBe 403
      }
    }
  }

  it should "give an execution that does not exist the same refusal" in {
    readPaths(Integer.MAX_VALUE).foreach { path =>
      withClue(path)(get(owner, path).getStatus shouldBe 403)
    }
  }

  it should "be refused without a token" in {
    val eid = insertExecution(owner)

    (latestExecutionPath +: readPaths(eid)).foreach { path =>
      withClue(path) {
        resources.target(path).request(MediaType.APPLICATION_JSON).get().getStatus shouldBe 401
      }
    }
  }

  "GET an execution's results" should "list each with the output mode its table records and its rows" in {
    val eid = insertExecution(owner)
    storeResult(eid, "b", data = rows.take(7))
    storeResult(eid, "a", port = 1, data = Seq.empty, mode = Some(OutputMode.SET_DELTA))
    storeResult(eid, "a", mode = Some(OutputMode.SINGLE_SNAPSHOT))
    storeResult(eid, "made-before-the-modes", data = rows.take(3), mode = None)

    getJson(owner, resultsPath(eid)) shouldBe mapper.readTree(
      """[
        |{"operatorId":"a","portIndex":0,"outputMode":"SINGLE_SNAPSHOT","rowCount":25},
        |{"operatorId":"a","portIndex":1,"outputMode":"SET_DELTA","rowCount":0},
        |{"operatorId":"b","portIndex":0,"outputMode":"SET_SNAPSHOT","rowCount":7},
        |{"operatorId":"made-before-the-modes","portIndex":0,"outputMode":null,"rowCount":3}
        |]""".stripMargin
    )
  }

  it should "order an operator's ports by number" in {
    val eid = insertExecution(owner)
    // As text, which is how the tables' names order them, port 10 comes before port 2.
    storeResult(eid, port = 10)
    storeResult(eid, port = 2)

    val results = getJson(owner, resultsPath(eid))
    (0 until results.size).map(results.get(_).get("portIndex").asInt) shouldBe Seq(2, 10)
  }

  it should "leave out internal ports, states, and the tables of another execution" in {
    val eid = insertExecution(owner)
    val other = insertExecution(owner)
    storeResult(eid, "internal", internal = true)
    DocumentFactory.createDocument(VFSURIFactory.stateURI(portBase(eid, globalPort("op"))), schema)
    storeResult(other)

    getJson(owner, resultsPath(eid)).size shouldBe 0
  }

  it should "read the results of an execution in its warehouse" in {
    val eid = insertExecution(owner, warehouse = Some(whid))
    storeResult(eid, warehouse = Some(warehouseName))

    getJson(owner, resultsPath(eid)).get(0).get("rowCount").asLong shouldBe 25
    getJson(owner, pagesPath(eid)).get("table").size shouldBe 10
  }

  "GET a page" should "return the requested rows with the schema and the full row count" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    val page = getJson(owner, pagesPath(eid), "pageIndex" -> 2, "pageSize" -> 10)

    page.get("table").size shouldBe 10
    page.get("table").get(0) shouldBe mapper.readTree(
      """{"id":10,"first_name":"first-10","Last_Name":"last-10"}"""
    )
    page.get("schema") shouldBe mapper.readTree(
      """[
        |{"attributeName":"id","attributeType":"integer"},
        |{"attributeName":"first_name","attributeType":"string"},
        |{"attributeName":"Last_Name","attributeType":"string"}
        |]""".stripMargin
    )
    page.get("rowCount").asLong shouldBe 25
  }

  it should "default to the first ten rows of port 0" in {
    val eid = insertExecution(owner)
    storeResult(eid)
    storeResult(eid, port = 1, data = (100 until 125).map(tuple))

    val page = getJson(owner, pagesPath(eid))

    page.get("table").size shouldBe 10
    page.get("table").get(0).get("id").asInt shouldBe 0
  }

  it should "read the port it is asked for" in {
    val eid = insertExecution(owner)
    storeResult(eid)
    storeResult(eid, port = 1, data = (100 until 125).map(tuple))

    getJson(owner, pagesPath(eid), "port" -> 1).get("table").get(0).get("id").asInt shouldBe 100
  }

  it should "stop at the end of the result" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    getJson(owner, pagesPath(eid), "pageIndex" -> 3, "pageSize" -> 10).get("table").size shouldBe 5
  }

  it should "keep the schema on a page past the end" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    val page = getJson(owner, pagesPath(eid), "pageIndex" -> 9, "pageSize" -> 10)

    page.get("table").size shouldBe 0
    columnNames(page) shouldBe List("id", "first_name", "Last_Name")
    page.get("rowCount").asLong shouldBe 25
  }

  it should "apply the column offset and limit" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    // With the limit left at its default too: offset plus limit does not fit in an Int.
    columnNames(getJson(owner, pagesPath(eid), "columnOffset" -> 1)) shouldBe
      List("first_name", "Last_Name")
    val narrowed = getJson(owner, pagesPath(eid), "columnOffset" -> 1, "columnLimit" -> 1)
    columnNames(narrowed) shouldBe List("first_name")
    narrowed.get("table").get(0) shouldBe mapper.readTree("""{"first_name":"first-0"}""")
  }

  it should "search the columns ignoring case, before the offset and limit" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    columnNames(getJson(owner, pagesPath(eid), "columnSearch" -> "NAME")) shouldBe
      List("first_name", "Last_Name")
    columnNames(
      getJson(owner, pagesPath(eid), "columnSearch" -> "name", "columnOffset" -> 1)
    ) shouldBe
      List("Last_Name")
    columnNames(getJson(owner, pagesPath(eid), "columnSearch" -> "")) shouldBe
      List("id", "first_name", "Last_Name")
  }

  it should "search the columns the same way in any locale" in {
    val eid = insertExecution(owner)
    storeResult(eid)
    val default = Locale.getDefault
    // By Turkish rules "ID" lowercases to "ıd", with a dotless i, which misses "id".
    Locale.setDefault(Locale.forLanguageTag("tr"))
    try columnNames(getJson(owner, pagesPath(eid), "columnSearch" -> "ID")) shouldBe List("id")
    finally Locale.setDefault(default)
  }

  it should "send a visualization's content whole, and cut long strings elsewhere" in {
    val long = "x" * 150
    val row = Seq(Tuple.builder(schema).addSequentially(Array[Any](0, long, "last-0")).build())
    val visualization = insertExecution(owner)
    storeResult(visualization, data = row, mode = Some(OutputMode.SINGLE_SNAPSHOT))
    val table = insertExecution(owner)
    storeResult(table, data = row)
    // A table that records no output mode is not taken for a visualization.
    val unrecorded = insertExecution(owner)
    storeResult(unrecorded, data = row, mode = None)

    def firstName(eid: Integer): String =
      getJson(owner, pagesPath(eid)).get("table").get(0).get("first_name").asText
    firstName(visualization) shouldBe long
    firstName(table) shouldBe long.take(100) + "..."
    firstName(unrecorded) shouldBe long.take(100) + "..."
  }

  it should "refuse a page or column range out of bounds before reading the table" in {
    // No table is stored, so a check that came after looking for it would be a 404.
    val eid = insertExecution(owner)

    Seq[(String, Any)](
      "pageIndex" -> 0,
      "pageSize" -> 0,
      "pageSize" -> 1001,
      "columnOffset" -> -1,
      "columnLimit" -> -1
    ).foreach { param =>
      withClue(param)(get(owner, pagesPath(eid), param).getStatus shouldBe 400)
    }
    // The end of this page does not fit in an Int.
    get(owner, pagesPath(eid), "pageIndex" -> Int.MaxValue, "pageSize" -> 2).getStatus shouldBe 400
  }

  it should "accept the largest page size" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    getJson(owner, pagesPath(eid), "pageSize" -> 1000).get("table").size shouldBe 25
  }

  it should "show rows committed after the table was first read" in {
    val eid = insertExecution(owner)
    val uri = storeResult(eid)
    getJson(owner, pagesPath(eid), "pageIndex" -> 3, "pageSize" -> 10).get("table").size shouldBe 5

    write(DocumentFactory.openDocument(uri)._1, (25 until 40).map(tuple), "append")

    val page = getJson(owner, pagesPath(eid), "pageIndex" -> 3, "pageSize" -> 10)
    page.get("table").size shouldBe 10
    page.get("rowCount").asLong shouldBe 40
  }

  it should "answer 404 for an operator with no result" in {
    val eid = insertExecution(owner)
    // Another operator's result is stored, so a lookup that ignored the operator would find it.
    storeResult(eid, "other-op")

    get(owner, pagesPath(eid)).getStatus shouldBe 404
  }

  it should "answer 404 for a result whose table was dropped" in {
    val eid = insertExecution(owner)
    ExecutionTables.drop(storeResult(eid)) shouldBe true

    get(owner, pagesPath(eid)).getStatus shouldBe 404
  }

  it should "not pass off a table it cannot read as a missing result" in {
    val eid = insertExecution(owner)
    val uri = storeResult(eid)
    // Texera has no attribute type for a float column, so opening the table now fails. The
    // table is named after its URI's path, as DocumentFactory names result tables.
    IcebergCatalogInstance
      .getInstance()
      .loadTable(
        TableIdentifier.of(
          StorageConfig.icebergTableResultNamespace,
          uri.getPath.stripPrefix("/").replace('/', '_')
        )
      )
      .updateSchema()
      .addColumn("weight", Types.FloatType.get())
      .commit()

    get(owner, pagesPath(eid)).getStatus shouldBe 500
  }

  it should "answer 503 for a result in a per-user warehouse while those are disabled" in {
    val eid = insertExecution(owner, warehouse = Some(whid))
    storeResult(eid, warehouse = Some(warehouseName))
    val disabled = new ResultResource(warehousesEnabled = false)
    val caller = new SessionUser(owner)

    Seq[() => Any](
      () => disabled.getResults(eid, caller),
      () => disabled.getPage(eid, "op", 0, 1, 10, 0, Int.MaxValue, "", caller),
      () => disabled.getStatistics(eid, "op", 0, caller)
    ).foreach { read =>
      the[ServiceUnavailableException] thrownBy read() should have message
        s"this result is stored in warehouse '$warehouseName'; per-user warehouses are " +
          "disabled in this deployment"
    }
  }

  "GET statistics" should "return the table's per-column statistics" in {
    val eid = insertExecution(owner)
    storeResult(eid)

    getJson(owner, statisticsPath(eid)) shouldBe mapper.readTree(
      """{
        |"id":{"not_null_count":25,"min":0.0,"max":24.0},
        |"first_name":{"not_null_count":25},
        |"Last_Name":{"not_null_count":25}
        |}""".stripMargin
    )
  }

  it should "answer 404 for an operator with no result" in {
    val eid = insertExecution(owner)

    get(owner, statisticsPath(eid)).getStatus shouldBe 404
  }
}
