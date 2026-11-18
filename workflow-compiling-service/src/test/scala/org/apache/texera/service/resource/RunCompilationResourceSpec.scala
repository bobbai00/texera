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

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import io.dropwizard.testing.junit5.ResourceExtension
import jakarta.ws.rs.client.Entity
import jakarta.ws.rs.core.{MediaType, Response}
import org.apache.texera.amber.core.executor.{InputFile, OpExecWithClassName, OperatorInputs}
import org.apache.texera.amber.core.storage.{FileResolver, InputFileLocator}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionMode,
  ExecutionPlan,
  OperatorUpdate,
  PhysicalPlanCodec,
  PortIdentity,
  PreferCoordinator,
  PythonEnvironment,
  PythonEnvironmentRef,
  RepositoryMounts
}
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.FileScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.PythonUDFOpDescV2
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.compiler.{CompileFor, PlanToRun}
import org.apache.texera.dao.jooq.generated.Tables.{SITE_SETTINGS, VIRTUAL_ENVIRONMENTS}
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.dao.SiteSettings
import org.jooq.JSONB
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.concurrent.{CountDownLatch, ExecutorService, Executors, TimeUnit}
import scala.collection.mutable
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._

/**
  * `POST /compile/run` and `POST /compile/update`: what the Dashboard service is answered when
  * it asks for the plan of a run, or for a change to a paused operator, with a user's token.
  *
  * What a compile makes of a workflow is `PlanToRunSpec`'s, `UpdateToRunSpec`'s and
  * `WorkflowCompilerSpec`'s. Here: that the plan is made for the caller, as the caller may read
  * what the workflow names; the JSON on the wire; the status of each refusal; and that a compile
  * runs on the pool, under the deadline.
  *
  * The users and the private dataset are `LoggedInResourceFixture`'s. Files are resolved for the
  * caller from the database, as the deployment resolves them; where LakeFS keeps a file is
  * answered by a locator of this suite's, since no LakeFS runs here.
  */
class RunCompilationResourceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with LoggedInResourceFixture {

  private val privateFileUri =
    new URI(s"dataset:///$privateDatasetRepositoryName/$privateDatasetVersionHash/notes.txt")
  private val privateFileAddress = s"s3://texera-dataset/$privateDatasetRepositoryName/data/n0t3s"

  /** The files the locator was asked for, by the user they were located for. */
  private val located = mutable.ListBuffer.empty[(Integer, URI)]

  /**
    * What the deployment binds a plan to for a user, but for where LakeFS keeps a file, which
    * this suite answers for the private dataset's.
    */
  private def bindingsFor(uid: Integer): CompileFor.Run =
    PlanToRun
      .bindingsFor(uid)
      .copy(locator = (file => {
        located += ((uid, file))
        if (file == privateFileUri) privateFileAddress
        else throw new org.apache.commons.vfs2.FileNotFoundException(file)
      }): InputFileLocator)

  private val pool: ExecutorService = Executors.newCachedThreadPool()

  private def resourceWith(
      bindings: Integer => CompileFor.Run = bindingsFor,
      compiles: ExecutorService = pool,
      deadline: FiniteDuration = RunCompilationResource.CompileDeadline
  ): RunCompilationResource =
    new RunCompilationResource(
      bindings,
      FileResolver.repositoryVersionResolverForUser,
      compiles,
      deadline
    )

  private val resources: ResourceExtension = resourcesFor(resourceWith())

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    insertUsersAndPrivateDataset()
    // The owner keeps a Python environment under the name `ml`; the other user keeps none.
    getDSLContext
      .insertInto(VIRTUAL_ENVIRONMENTS)
      .set(VIRTUAL_ENVIRONMENTS.UID, owner.getUid)
      .set(VIRTUAL_ENVIRONMENTS.NAME, "ml")
      .set(VIRTUAL_ENVIRONMENTS.PACKAGES, JSONB.valueOf("""{"Tabulate": "==0.9.0"}"""))
      .execute()
    resources.before()
  }

  override protected def afterAll(): Unit = {
    resources.after()
    pool.shutdownNow()
    shutdownDB()
  }

  /** What `body` answers with a resource set up otherwise than the suite's. */
  private def withResource[T](resource: RunCompilationResource)(body: ResourceExtension => T): T = {
    val extension = resourcesFor(resource)
    extension.before()
    try body(extension)
    finally extension.after()
  }

  // --- workflows ---

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: String, to: String): LogicalLink =
    LogicalLink(OperatorIdentity(from), PortIdentity(), OperatorIdentity(to), PortIdentity())

  private def text(id: String = "text"): TextInputSourceOpDesc = {
    val op = named(new TextInputSourceOpDesc(), id)
    op.textInput = "north\nsouth"
    op
  }

  private def limit(id: String, rows: Int): LimitOpDesc = {
    val op = named(new LimitOpDesc(), id)
    op.limit = rows
    op
  }

  /** Lines of text into a Limit, then into another: nothing of it is read from outside. */
  private def textPlan(): LogicalPlanPojo =
    LogicalPlanPojo(
      List(text(), limit("limit", 1), limit("limit-2", 1)),
      List(link("text", "limit"), link("limit", "limit-2")),
      List.empty,
      List.empty
    )

  /** A scan of a whole file as one value: compiling it resolves the name, and reads no file. */
  private def scanOf(fileName: String, id: String = "scan"): LogicalPlanPojo = {
    val scan = named(new FileScanSourceOpDesc(), id)
    scan.fileName = Some(fileName)
    LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)
  }

  /** Lines of text into a Python UDF, `udf`, that asks to run in the environment `name`. */
  private def udfPlanIn(name: Option[String]): LogicalPlanPojo =
    LogicalPlanPojo(List(text(), udf(name)), List(link("text", "udf")), List.empty, List.empty)

  private def udf(
      environment: Option[String] = None,
      parameters: List[UiUDFParameter] = Nil
  ): PythonUDFOpDescV2 = {
    val op = named(TestOperators.pythonOpDesc(), "udf")
    environment.foreach { name =>
      op.defaultEnv = false
      op.envName = name
    }
    op.uiParameters = parameters
    op
  }

  private def datasetParameter(value: String): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = value
    parameter
  }

  // --- requests, as the Dashboard service sends them ---

  private val workflowId = 7L
  private val executionId = 42L

  private def runBody(
      plan: LogicalPlanPojo,
      warehouse: Option[String] = None,
      target: Option[String] = None
  ): ObjectNode = {
    val body = objectMapper.createObjectNode()
    body.put("workflowId", workflowId)
    body.put("executionId", executionId)
    warehouse.foreach(body.put("warehouse", _))
    body
      .putObject("settings")
      .put("dataTransferBatchSize", 77)
      .put("executionMode", "MATERIALIZED")
    body.set[JsonNode]("logicalPlan", objectMapper.readTree(plan.toJson))
    target.foreach(body.put("targetOperatorId", _))
    body
  }

  private def post(
      path: String,
      body: JsonNode,
      as: User = owner,
      on: ResourceExtension = resources
  ): Response =
    on.target(path)
      .request(MediaType.APPLICATION_JSON)
      .header("Authorization", bearerTokenOf(as))
      .post(Entity.json(objectMapper.writeValueAsString(body)))

  private def jsonOf(response: Response): JsonNode =
    objectMapper.readTree(response.readEntity(classOf[String]))

  /** The plan a 200 answers, read as the service that links its files reads it. */
  private def planOf(response: Response): (ExecutionPlan, JsonNode) = {
    val body = jsonOf(response)
    withClue(s"$body: ") { response.getStatus shouldBe 200 }
    body.fieldNames().asScala.toSet shouldBe Set("plan", "logicalPlan")
    (PhysicalPlanCodec.decodeUnlinked(PhysicalPlanCodec.fromJson(body.get("plan").asText())), body)
  }

  /** The body of a refusal, which answers `status` with `{code, message}` and `fields` beside. */
  private def refusalOf(response: Response, status: Int, fields: String*): JsonNode = {
    val body = jsonOf(response)
    withClue(s"$body: ") { response.getStatus shouldBe status }
    body.fieldNames().asScala.toSet shouldBe (Set("code", "message") ++ fields)
    body.get("code").asInt() shouldBe status
    body
  }

  // --- POST /compile/run ---

  "POST /compile/run" should "answer the plan of the run as its text, with the workflow it was compiled from" in {
    val sent = runBody(textPlan(), warehouse = Some("wh-1"))

    val (plan, body) = planOf(post("/compile/run", sent))

    plan.context.workflowId shouldBe WorkflowIdentity(workflowId)
    plan.context.executionId shouldBe ExecutionIdentity(executionId)
    plan.context.warehouse shouldBe Some("wh-1")
    plan.context.workflowSettings.dataTransferBatchSize shouldBe 77
    plan.context.workflowSettings.executionMode shouldBe ExecutionMode.MATERIALIZED
    // The compile found the ports whose results are stored: those of the last operator.
    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId.id) shouldBe
      Set("limit-2")
    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("text", "limit", "limit-2")
    // Each output port is stored in the execution's own place, in its warehouse.
    plan.plan.operators.flatMap(_.storageLocations.values).foreach { location =>
      location.toString should startWith(s"vfs:///wh/wh-1/wid/$workflowId/eid/$executionId/")
    }
    // What only the service that stores the plan has is not in it.
    plan.context.costHints shouldBe None
    plan.replay shouldBe None
    plan.replayLog shouldBe None
    // The workflow compiled, as JSON text that parses back to it.
    objectMapper.readTree(body.get("logicalPlan").asText()) shouldBe sent.get("logicalPlan")
  }

  it should "take the workflow as the editor writes it, a link's operators by their ids" in {
    val sent = runBody(textPlan())
    sent.get("logicalPlan").get("links").forEach { link =>
      val flat = link.asInstanceOf[ObjectNode]
      flat.put("fromOpId", link.get("fromOpId").get("id").asText())
      flat.put("toOpId", link.get("toOpId").get("id").asText())
    }
    // What a request may leave out: the results to view and reuse, and the warehouse.
    sent.get("logicalPlan").asInstanceOf[ObjectNode].remove("opsToViewResult")
    sent.get("logicalPlan").asInstanceOf[ObjectNode].remove("opsToReuseResult")

    val (plan, _) = planOf(post("/compile/run", sent))

    plan.plan.links should have size 2
    plan.context.warehouse shouldBe None
  }

  it should "say where each file the caller may read is kept, and sign no link to it" in {
    located.clear()

    val (plan, body) = planOf(post("/compile/run", runBody(scanOf(privateDatasetFilePath))))

    // Resolved for the caller, by the name as typed, and that file located.
    located.toList shouldBe List((owner.getUid, privateFileUri))
    plan.plan.operators.map(_.inputs) shouldBe Set(
      OperatorInputs(files =
        Seq(InputFile(privateFileUri.toASCIIString, physicalAddress = privateFileAddress))
      )
    )
    // The address is the plan's alone: the workflow beside it names the file as its user did.
    body.get("plan").asText() should include(privateFileAddress)
    body.get("logicalPlan").asText() should include(privateDatasetFilePath)
    body.get("logicalPlan").asText() should not include privateDatasetRepositoryName
    // A plan a computing unit runs has links, which this service has no keys to sign.
    body.get("plan").asText() should not include "\"url\""
    an[IllegalArgumentException] should be thrownBy
      PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(body.get("plan").asText()))
  }

  it should "refuse a file the caller may not read as the scan's error, and locate nothing of it" in {
    located.clear()

    val response = post("/compile/run", runBody(scanOf(privateDatasetFilePath)), as = otherUser)

    val body = refusalOf(response, 400, "operatorErrors")
    body.get("message").asText() should startWith(
      "The workflow does not compile: 1 operator has an error."
    )
    body.get("operatorErrors").fieldNames().asScala.toList shouldBe List("scan")
    val message = body.get("operatorErrors").get("scan").get("message").asText()
    message should startWith("org.apache.commons.vfs2.FileNotFoundException")
    message should include(privateDatasetFilePath)
    located shouldBe empty
    // Nothing of the dataset is given away.
    body.toString should not include privateDatasetRepositoryName
    body.toString should not include privateDatasetVersionHash
  }

  it should "write each operator's error as the editor's compile writes one, upstream operators first" in {
    // A scan with no file chosen, and a Limit of what it would read.
    val broken = LogicalPlanPojo(
      List(limit("a-limit", 1), named(new CSVScanSourceOpDesc(), "scan")),
      List(link("scan", "a-limit")),
      List.empty,
      List.empty
    )
    val since = System.currentTimeMillis() / 1000

    val body = refusalOf(post("/compile/run", runBody(broken)), 400, "operatorErrors")

    body.get("message").asText() should startWith(
      "The workflow does not compile: 2 operators have errors.\nscan: "
    )
    // In the order of the workflow, not of the ids.
    body.get("operatorErrors").fieldNames().asScala.toList shouldBe List("scan", "a-limit")
    val error = body.get("operatorErrors").get("scan")
    error.fieldNames().asScala.toSet should contain allOf (
      "type", "timestamp", "message", "details", "operatorId", "workerId"
    )
    error.get("type").get("name").asText() shouldBe "COMPILATION_ERROR"
    error.get("timestamp").get("seconds").asLong() should be >= (since - 1)
    error.get("timestamp").get("nanos").isNumber shouldBe true
    error.get("message").asText() should include("No file selected")
    error.get("details").asText() should not be empty
    error.get("operatorId").asText() shouldBe "scan"
  }

  it should "resolve the Python environment a UDF names to the caller's own, and refuse one the caller lacks as the UDF's error" in {
    val (plan, body) = planOf(post("/compile/run", runBody(udfPlanIn(Some("ml")))))

    val udfOp = plan.plan.getOperator(PhysicalOpIdentity(OperatorIdentity("udf"), "main"))
    // The owner's, as canonical lines: what the unit that runs the plan installs.
    udfOp.pythonEnvironment shouldBe
      PythonEnvironmentRef.Resolved(PythonEnvironment("ml", Seq("tabulate==0.9.0")))
    udfOp.locationPreference shouldBe Some(PreferCoordinator)
    body.get("logicalPlan").asText() should not include "tabulate"

    // The other user keeps no environment of that name: each user's are their own.
    val refusal = refusalOf(
      post("/compile/run", runBody(udfPlanIn(Some("ml"))), as = otherUser),
      400,
      "operatorErrors"
    )
    refusal.get("operatorErrors").fieldNames().asScala.toList shouldBe List("udf")
    refusal.get("operatorErrors").get("udf").get("message").asText() shouldBe
      "org.apache.texera.common.compiler.PythonEnvironmentNotResolved: You have no Python " +
        "environment named 'ml'. Each user keeps their own environments, so to run this " +
        "workflow, create one with this name."
  }

  it should "pin the dataset a UDF names for the caller, and refuse one the caller may not read" in {
    val version = "/dataset/owner@test.com/private_dataset/v1"
    def plan() =
      LogicalPlanPojo(
        List(text(), udf(parameters = List(datasetParameter(version)))),
        List(link("text", "udf")),
        List.empty,
        List.empty
      )

    val (made, _) = planOf(post("/compile/run", runBody(plan())))

    made.plan
      .getOperator(PhysicalOpIdentity(OperatorIdentity("udf"), "main"))
      .repositoryMounts shouldBe Some(
      RepositoryMounts(Set(s"$privateDatasetRepositoryName:$privateDatasetVersionHash"))
    )

    val refusal =
      refusalOf(post("/compile/run", runBody(plan()), as = otherUser), 400, "operatorErrors")
    refusal.get("operatorErrors").fieldNames().asScala.toList shouldBe List("udf")
    refusal.toString should not include privateDatasetRepositoryName
  }

  it should "compile under the site's CSV column limit as it stands" in {
    SiteSettings.upsert(getDSLContext, "csv_parser_max_columns", "731", "spec")
    try {
      val scan = named(TestOperators.smallCsvScanOpDesc(), "csv")
      val bindings = (uid: Integer) =>
        bindingsFor(uid).copy(
          files = TestOperators.fixtureFileResolver,
          locator = (file => file.toString): InputFileLocator
        )

      val (plan, _) = withResource(resourceWith(bindings)) { on =>
        planOf(
          post(
            "/compile/run",
            runBody(LogicalPlanPojo(List(scan), List.empty, List.empty, List.empty)),
            on = on
          )
        )
      }

      plan.plan.operators.flatMap(_.inputs.csvParserMaxColumns) shouldBe Set(731)
    } finally {
      getDSLContext
        .deleteFrom(SITE_SETTINGS)
        .where(SITE_SETTINGS.KEY.eq("csv_parser_max_columns"))
        .execute()
    }
  }

  it should "compile only the target and what is upstream of it, given a target" in {
    val (plan, body) = planOf(post("/compile/run", runBody(textPlan(), target = Some("limit"))))

    plan.plan.operators.map(_.id.logicalOpId.id) shouldBe Set("text", "limit")
    // The run views the target's result.
    plan.context.workflowSettings.outputPortsNeedingStorage.map(_.opId.logicalOpId.id) shouldBe
      Set("limit")
    // The workflow answered is the part compiled.
    val compiled = objectMapper.readTree(body.get("logicalPlan").asText())
    compiled.get("operators").elements().asScala.map(_.get("operatorID").asText()).toList shouldBe
      List("text", "limit")
    compiled.get("opsToViewResult").elements().asScala.map(_.asText()).toList shouldBe
      List("limit")
  }

  it should "refuse a workflow the compiler cannot read, or a target it does not have, as no operator's error" in {
    val cyclic = textPlan().copy(links = List(link("limit", "limit-2"), link("limit-2", "limit")))
    Seq(
      runBody(textPlan(), target = Some("ghost")) ->
        "The workflow has no operator ghost to run up to.",
      runBody(cyclic) -> "The workflow's links form a cycle: limit -> limit-2 -> limit.",
      // Up to the source the cycle is not compiled, so it is not checked.
      runBody(cyclic, target = Some("limit-2")) ->
        "The workflow's links form a cycle: limit -> limit-2 -> limit."
    ).foreach {
      case (sent, problem) =>
        withClue(s"$problem: ") {
          refusalOf(post("/compile/run", sent), 400).get("message").asText() shouldBe problem
        }
    }
    planOf(post("/compile/run", runBody(cyclic, target = Some("text"))))._1.plan.operators
      .map(_.id.logicalOpId.id) shouldBe Set("text")
  }

  it should "refuse a request that names no workflow, execution, settings or plan, or settings no plan runs under" in {
    def without(field: String): ObjectNode = {
      val body = runBody(textPlan())
      body.remove(field)
      body
    }
    def withBatches(size: Int): ObjectNode = {
      val body = runBody(textPlan())
      body.get("settings").asInstanceOf[ObjectNode].put("dataTransferBatchSize", size)
      body
    }
    Seq(
      without("workflowId") -> "The request names no workflow.",
      without("executionId") -> "The request names no execution.",
      without("settings") -> "The request has no settings to run the workflow under.",
      without("logicalPlan") -> "The request has no logical plan.",
      withBatches(0) -> "The workflow's Data Transfer Batch Size is 0; set it to 1 or more."
    ).foreach {
      case (sent, problem) =>
        withClue(s"$problem: ") {
          refusalOf(post("/compile/run", sent), 400).get("message").asText() shouldBe problem
        }
    }
  }

  it should "answer 401 to a request that carries no logged-in user" in {
    val response = resources
      .target("/compile/run")
      .request(MediaType.APPLICATION_JSON)
      .post(Entity.json(objectMapper.writeValueAsString(runBody(textPlan()))))

    response.getStatus shouldBe 401
  }

  it should "be served to regular users and admins, by a resource Jersey makes itself" in {
    classOf[RunCompilationResource]
      .getAnnotation(classOf[jakarta.annotation.security.RolesAllowed])
      .value()
      .toSet shouldBe Set("REGULAR", "ADMIN")
    classOf[RunCompilationResource].getAnnotation(classOf[jakarta.ws.rs.Path]).value() shouldBe
      "/compile"
    // The deployment registers the class, with the deployment's bindings, pool and deadline,
    // beside the editor's compile, whose path it shares.
    val byClass = ResourceExtension
      .builder()
      .setMapper(objectMapper)
      .addProvider(classOf[org.apache.texera.auth.JwtAuthFilter])
      .addProvider(classOf[org.apache.texera.auth.UnauthorizedExceptionMapper])
      .addProvider(classOf[org.glassfish.jersey.server.filter.RolesAllowedDynamicFeature])
      .addProvider(
        new io.dropwizard.auth.AuthValueFactoryProvider.Binder(
          classOf[org.apache.texera.auth.SessionUser]
        )
      )
      .addProvider(classOf[WorkflowCompilationResource])
      .addProvider(classOf[RunCompilationResource])
      .build()
    byClass.before()
    try {
      planOf(post("/compile/run", runBody(textPlan()), on = byClass))
      // The editor's compile still answers at /compile, as it does alone.
      val edited = post("/compile", objectMapper.readTree(textPlan().toJson), on = byClass)
      edited.getStatus shouldBe 200
      jsonOf(edited).get("type").asText() shouldBe "success"
    } finally byClass.after()
  }

  // --- the pool and the deadline ---

  it should "compile on the pool of compiles, not on the request's thread" in {
    val single = Executors.newSingleThreadExecutor(task => new Thread(task, "spec-compile"))
    val boundOn = mutable.ListBuffer.empty[String]
    val bindings = (uid: Integer) => {
      boundOn += Thread.currentThread().getName
      bindingsFor(uid)
    }

    try withResource(resourceWith(bindings, compiles = single)) { on =>
      planOf(post("/compile/run", runBody(textPlan()), on = on))
    } finally single.shutdownNow()

    boundOn.toList shouldBe List("spec-compile")
  }

  it should "answer 504 when a compile takes longer than the deadline, and not leave it running" in {
    // A source that never answers: the scan's file is still being located when the deadline
    // passes.
    val locating = new CountDownLatch(1)
    val interrupted = new CountDownLatch(1)
    val bindings = (uid: Integer) =>
      bindingsFor(uid).copy(locator = (_ => {
        locating.countDown()
        try new CountDownLatch(1).await()
        catch { case _: InterruptedException => interrupted.countDown() }
        privateFileAddress
      }): InputFileLocator)

    val body = withResource(resourceWith(bindings, deadline = 1.second)) { on =>
      refusalOf(post("/compile/run", runBody(scanOf(privateDatasetFilePath)), on = on), 504)
    }

    body.get("message").asText() shouldBe "Compiling the workflow took longer than 1 second."
    locating.getCount shouldBe 0
    interrupted.await(10, TimeUnit.SECONDS) shouldBe true
  }

  it should "answer 503 when no more compiles can wait" in {
    val full = Executors.newSingleThreadExecutor()
    full.shutdown()

    val body = withResource(resourceWith(compiles = full)) { on =>
      refusalOf(post("/compile/run", runBody(textPlan()), on = on), 503)
    }

    body.get("message").asText() shouldBe
      "Too many workflows are being compiled. Try again in a moment."
  }

  it should "answer 500, not an operator's error, when a file cannot be looked up for a reason not the workflow's" in {
    val bindings = (uid: Integer) =>
      bindingsFor(uid).copy(locator = (_ => {
        throw new java.io.IOException("the storage does not answer")
      }): InputFileLocator)

    val (status, body) = withResource(resourceWith(bindings)) { on =>
      val response = post("/compile/run", runBody(scanOf(privateDatasetFilePath)), on = on)
      (response.getStatus, response.readEntity(classOf[String]))
    }

    status shouldBe 500
    body should not include "operatorErrors"
    body should not include "the storage does not answer"
  }

  // --- POST /compile/update ---

  private val updateId = "update-5f0c7a1b"

  private def updateBody(
      operator: LogicalOp,
      workflow: LogicalPlanPojo = udfPlanIn(None),
      running: String = """[{"layerName": "main"}]"""
  ): ObjectNode = {
    val body = objectMapper.createObjectNode()
    body.put("workflowId", workflowId)
    body.put("executionId", executionId)
    body.put("updateId", updateId)
    body.set[JsonNode]("logicalPlan", objectMapper.readTree(workflow.toJson))
    // The change as the editor sends it: the operator's JSON, with no loop-variable sidecar.
    val sent = objectMapper.valueToTree[ObjectNode](operator)
    sent.remove("stateReferences")
    body.set[JsonNode]("operator", sent)
    body.set[JsonNode]("running", objectMapper.readTree(running))
    body
  }

  private def changed(code: String): PythonUDFOpDescV2 = {
    val op = udf()
    op.code = code
    op
  }

  private val changedCode = TestOperators.pythonOpDesc().code.replace("yield tuple_", "yield None")

  "POST /compile/update" should "answer the change made to run, saved under the update's id, with the change as it was sent" in {
    val response = post("/compile/update", updateBody(changed(changedCode)))

    val body = jsonOf(response)
    withClue(s"$body: ") { response.getStatus shouldBe 200 }
    body.fieldNames().asScala.toSet shouldBe Set("update", "operator")
    val update =
      PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(body.get("update").asText()))
    update.executionId shouldBe ExecutionIdentity(executionId)
    update.updateId shouldBe updateId
    update.opId shouldBe PhysicalOpIdentity(OperatorIdentity("udf"), "main")
    update shouldBe a[OperatorUpdate]
    update.repositoryMounts shouldBe None
    val sent = objectMapper.readValue(body.get("operator").asText(), classOf[LogicalOp])
    sent.asInstanceOf[PythonUDFOpDescV2].code shouldBe changedCode
  }

  it should "make a change to an operator built from its descriptor" in {
    val workflow = textPlan()

    val body = jsonOf(post("/compile/update", updateBody(limit("limit", 9), workflow)))

    val update =
      PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(body.get("update").asText()))
    objectMapper
      .readValue(
        update.opExecInitInfo.asInstanceOf[OpExecWithClassName].descString,
        classOf[LimitOpDesc]
      )
      .limit shouldBe 9
  }

  it should "pin the dataset a change names for the caller, and refuse one the caller may not read" in {
    val version = "/dataset/owner@test.com/private_dataset/v1"
    def sent() = updateBody(udf(parameters = List(datasetParameter(version))))

    val body = jsonOf(post("/compile/update", sent()))
    PhysicalPlanCodec
      .decodeUpdate(PhysicalPlanCodec.updateFromJson(body.get("update").asText()))
      .repositoryMounts shouldBe Some(
      RepositoryMounts(Set(s"$privateDatasetRepositoryName:$privateDatasetVersionHash"))
    )

    val refusal = refusalOf(post("/compile/update", sent(), as = otherUser), 400)
    refusal.get("message").asText() should include(version)
    refusal.toString should not include privateDatasetRepositoryName
  }

  it should "refuse a change the running operator cannot take with 400, in the change's words" in {
    Seq(
      updateBody(limit("udf", 3)) ->
        "Operator udf is a Python UDF; a change cannot make it a Limit.",
      updateBody(udf(environment = Some("ml"))) ->
        "The operator's Python environment cannot change while the run is paused.",
      updateBody(udf(), running = """[{"layerName": "main", "pythonEnvironment": "ml"}]""") ->
        "The operator's Python environment cannot change while the run is paused.",
      updateBody(udf(), running = """[{"layerName": "other"}]""") ->
        ("The change makes Python UDF the operator udf-main, which the running workflow does " +
          "not have."),
      updateBody(text()) -> "operator TextInputSourceOpDesc does not support reconfiguration"
    ).foreach {
      case (sent, problem) =>
        withClue(s"$problem: ") {
          refusalOf(post("/compile/update", sent), 400).get("message").asText() shouldBe problem
        }
    }
    // The same environment the running operator runs in is no change of it.
    post(
      "/compile/update",
      updateBody(
        udf(environment = Some("ml")),
        workflow = udfPlanIn(Some("ml")),
        running = """[{"layerName": "main", "pythonEnvironment": "ml"}]"""
      )
    ).getStatus shouldBe 200
  }

  it should "answer 404 for a change to an operator the execution's workflow does not have" in {
    refusalOf(post("/compile/update", updateBody(limit("ghost", 7))), 404)
      .get("message")
      .asText() shouldBe s"Operator ghost is not in the workflow execution $executionId runs."
  }

  it should "answer 401 to a request that carries no logged-in user" in {
    val response = resources
      .target("/compile/update")
      .request(MediaType.APPLICATION_JSON)
      .post(Entity.json(objectMapper.writeValueAsString(updateBody(udf()))))

    response.getStatus shouldBe 401
  }
}
