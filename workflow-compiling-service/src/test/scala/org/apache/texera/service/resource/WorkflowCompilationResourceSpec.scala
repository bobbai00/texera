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

import com.fasterxml.jackson.databind.node.ObjectNode
import io.dropwizard.testing.junit5.ResourceExtension
import jakarta.ws.rs.client.Entity
import jakarta.ws.rs.core.{MediaType, Response}
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.workflow.PortIdentity
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.{FileScanOpDesc, FileScanSourceOpDesc}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.UiUDFParameter
import org.apache.texera.amber.operator.udf.python.source.PythonUDFSourceOpDescV2
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.dao.{SqlServer, StatementRecorder}
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.assertj.core.api.Assertions.assertThat
import org.jooq.ConnectionProvider
import org.jooq.impl.DSL
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec

import java.sql.{Connection, SQLException}

/**
  * Resource-layer tests for `/compile`. Owns only what the REST envelope
  * adds on top of compilation itself: HTTP status, the
  * `@JsonTypeInfo` discriminator that lets the frontend route success vs
  * failure, and the JSON shape the resource expects on the wire.
  *
  * All compiler-behavior assertions (schema propagation, lenient-mode
  * error accumulation, multi-op chains) live in
  * `org.apache.texera.common.compiler.WorkflowCompilerSpec` so a regression
  * lands on the right spec.
  */
class WorkflowCompilationResourceSpec
    extends AnyFlatSpec
    with BeforeAndAfterAll
    with LoggedInResourceFixture {

  private val resources: ResourceExtension = resourcesFor(new WorkflowCompilationResource())
  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    insertUsersAndPrivateDataset()
    resources.before()
  }

  override protected def afterAll(): Unit = {
    resources.after()
    shutdownDB()
  }

  private def csvOp(fileName: String): CSVScanSourceOpDesc = {
    val op = new CSVScanSourceOpDesc()
    op.fileName = Some(fileName)
    op.customDelimiter = Some(",")
    op.hasHeader = true
    op
  }

  // A source that needs no file, for the tests that are about the envelope only.
  private def textOp(text: String): TextInputSourceOpDesc = {
    val op = new TextInputSourceOpDesc()
    op.textInput = text
    op
  }

  private def limitOp(rows: Int): LimitOpDesc = {
    val op = new LimitOpDesc()
    op.limit = rows
    op
  }

  // Scans a whole file as one value, so compiling it resolves the name without reading the file.
  private def wholeFileScanOp(fileName: String): FileScanSourceOpDesc = {
    val op = new FileScanSourceOpDesc()
    op.fileName = Some(fileName)
    op
  }

  private def planOf(operator: LogicalOp): LogicalPlanPojo =
    LogicalPlanPojo(
      operators = List(operator),
      links = List.empty,
      opsToViewResult = List.empty,
      opsToReuseResult = List.empty
    )

  // The frontend serializes LogicalLink with `fromOpId` / `toOpId` as flat
  // strings, but the Scala case class stores them as nested `OperatorIdentity`
  // records. This helper mirrors the wire shape so the test exercises the
  // resource's actual JSON contract instead of a Scala-only round trip.
  private def encodePojoAsFrontendJson(pojo: LogicalPlanPojo): String = {
    val jsonNode = objectMapper.valueToTree[ObjectNode](pojo)
    val linksArray = jsonNode.withArray("links")
    linksArray.forEach { linkNode =>
      val fromOpIdNode = linkNode.get("fromOpId")
      linkNode.asInstanceOf[ObjectNode].put("fromOpId", fromOpIdNode.get("id").asText())
      val toOpIdNode = linkNode.get("toOpId")
      linkNode.asInstanceOf[ObjectNode].put("toOpId", toOpIdNode.get("id").asText())
    }
    objectMapper.writeValueAsString(jsonNode)
  }

  private def postCompile(pojo: LogicalPlanPojo, as: User = owner): Response =
    resources
      .target("/compile")
      .request(MediaType.APPLICATION_JSON)
      .header("Authorization", bearerTokenOf(as))
      .post(Entity.json(encodePojoAsFrontendJson(pojo)))

  "POST /compile" should "return HTTP 200 for a well-formed plan" in {
    val text = textOp("north\nsouth")
    val limit = limitOp(1)
    val response = postCompile(
      LogicalPlanPojo(
        operators = List(text, limit),
        links = List(
          LogicalLink(
            text.operatorIdentifier,
            PortIdentity(0),
            limit.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )
    assertThat(response.getStatus).isEqualTo(200)
  }

  it should "tag the response body with type=success so the frontend can route on the discriminator" in {
    // The @JsonTypeInfo on WorkflowCompilationResponse writes a `type` field.
    // Both polymorphic deserialization (round-tripping through the trait) and
    // a raw-JSON `type == "success"` check need to hold so the Angular client
    // can branch without depending on Scala class names.
    val text = textOp("north\nsouth")
    val limit = limitOp(1)
    val response = postCompile(
      LogicalPlanPojo(
        operators = List(text, limit),
        links = List(
          LogicalLink(
            text.operatorIdentifier,
            PortIdentity(0),
            limit.operatorIdentifier,
            PortIdentity(0)
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    val body = response.readEntity(classOf[String])
    val node = objectMapper.readTree(body)
    assert(
      node.has("type") && node.get("type").asText() == "success",
      s"expected type:success discriminator, got $body"
    )
    val parsed = objectMapper.readValue(body, classOf[WorkflowCompilationResponse])
    assert(parsed.isInstanceOf[WorkflowCompilationSuccess])
    val success = parsed.asInstanceOf[WorkflowCompilationSuccess]
    assert(success.physicalPlan != null)
    assert(success.operatorOutputSchemas.nonEmpty)
  }

  it should "return WorkflowCompilationFailure (not HTTP 500) when a scan source file cannot be resolved" in {
    val response = postCompile(
      LogicalPlanPojo(
        operators = List(csvOp("/does/not/exist/missing.csv")),
        links = List.empty,
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    // Must not surface as HTTP 500 — the error must come back as a structured failure.
    assertThat(response.getStatus).isEqualTo(200)

    // Inspect the raw JSON rather than deserializing the full response: WorkflowFatalError
    // is not round-trippable through the test ObjectMapper, but that is unrelated to the
    // bug under test (which is purely about the resource not NPE'ing).
    val responseBody = response.readEntity(classOf[String])
    val rootNode = objectMapper.readTree(responseBody)
    assertThat(rootNode.get("type").asText()).isEqualTo("failure")
    assertThat(rootNode.has("operatorErrors")).isTrue
  }

  it should "answer 401 to a request that carries no logged-in user" in {
    val response = resources
      .target("/compile")
      .request(MediaType.APPLICATION_JSON)
      .post(Entity.json(encodePojoAsFrontendJson(planOf(wholeFileScanOp(privateDatasetFilePath)))))
    assertThat(response.getStatus).isEqualTo(401)
  }

  it should "compile a scan source whose file the logged-in user can read" in {
    val scan = wholeFileScanOp(privateDatasetFilePath)
    val response = postCompile(planOf(scan), as = owner)

    assertThat(response.getStatus).isEqualTo(200)
    val rootNode = objectMapper.readTree(response.readEntity(classOf[String]))
    assert(rootNode.get("type").asText() == "success", s"expected success, got $rootNode")
    assert(rootNode.get("operatorOutputSchemas").has(scan.operatorIdentifier.id))
  }

  it should "return WorkflowCompilationFailure when the scan source file is not readable by the user" in {
    val scan = csvOp("/dataset/owner@test.com/private_dataset/v1/table.csv")
    val response = postCompile(planOf(scan), as = otherUser)

    assertThat(response.getStatus).isEqualTo(200)
    val body = response.readEntity(classOf[String])
    val rootNode = objectMapper.readTree(body)
    assert(rootNode.get("type").asText() == "failure", s"expected failure, got $body")
    assert(rootNode.get("operatorErrors").has(scan.operatorIdentifier.id))
    val schemas = rootNode.get("operatorOutputSchemas").get(scan.operatorIdentifier.id)
    assert(
      schemas == null || !schemas.elements().hasNext ||
        schemas.elements().next().isNull,
      s"expected no schema for the operator, got $schemas"
    )
    assert(!body.contains(privateDatasetRepositoryName))
    assert(!body.contains(privateDatasetVersionHash))
  }

  it should "return the same operator error for an unreadable file as for a missing one" in {
    val unreadable = wholeFileScanOp(privateDatasetFilePath)
    val missingPath = "/dataset/owner@test.com/no_such_dataset/v1/notes.txt"
    val missing = wholeFileScanOp(missingPath)

    def errorMessageOf(scan: FileScanSourceOpDesc): String = {
      val rootNode = objectMapper.readTree(
        postCompile(planOf(scan), as = otherUser).readEntity(classOf[String])
      )
      rootNode.get("operatorErrors").get(scan.operatorIdentifier.id).get("message").asText()
    }

    assert(
      errorMessageOf(unreadable).replace(privateDatasetFilePath, "<path>")
        == errorMessageOf(missing).replace(missingPath, "<path>")
    )
  }

  it should "answer 500, not the scan's error, when its file cannot be looked up" in {
    // A file that does not exist, or that the user may not read, is the scan's error, for the
    // user to fix. A database that does not answer says nothing about the file: reported on the
    // scan, the outage would read as the user's mistake.
    val scan = wholeFileScanOp(privateDatasetFilePath)
    val unreachable = getDSLContext
      .configuration()
      .derive(new ConnectionProvider {
        override def acquire(): Connection = throw new SQLException("database unavailable")
        override def release(connection: Connection): Unit = ()
      })
    SqlServer.getInstance().replaceDSLContext(DSL.using(unreachable))
    val response =
      try postCompile(planOf(scan), as = owner)
      finally SqlServer.getInstance().replaceDSLContext(getDSLContext)

    assertThat(response.getStatus).isEqualTo(500)
    val body = response.readEntity(classOf[String])
    assert(!body.contains("operatorErrors"), body)
    assert(!body.contains(scan.operatorIdentifier.id), body)
    // The same request compiles once the database answers again.
    assertThat(postCompile(planOf(scan), as = owner).getStatus).isEqualTo(200)
  }

  it should "leave a dataset a UDF names to the run, resolving nothing while editing" in {
    // Only a plan made to run pins a version, refusing one its user cannot read. Were the
    // edit to resolve it, the user who cannot read it would see an error here.
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute("DATA", AttributeType.STRING)
    parameter.inputType = "dataset"
    parameter.value = "/dataset/owner@test.com/private_dataset/v1"
    val udf = new PythonUDFSourceOpDescV2
    udf.code = """from pytexera import *
        |
        |class GenerateOperator(UDFSourceOperator):
        |    def produce(self):
        |        yield
        |""".stripMargin
    udf.uiParameters = List(parameter)

    val response = postCompile(planOf(udf), as = otherUser)

    assertThat(response.getStatus).isEqualTo(200)
    val body = response.readEntity(classOf[String])
    val rootNode = objectMapper.readTree(body)
    assert(rootNode.get("type").asText() == "success", s"expected success, got $body")
    val ops = rootNode.get("physicalPlan").get("operators")
    assert(ops.size() == 1, s"expected one operator in $body")
    assert(Option(ops.get(0).get("repositoryMounts")).forall(_.isNull), s"mounts in $body")
    assert(!body.contains(privateDatasetRepositoryName))
    assert(!body.contains(privateDatasetVersionHash))
  }

  it should "leave the dataset version a File Lister names to the run, listing nothing while editing" in {
    // Only a plan made to run lists a version, refusing one its user cannot read. Were the edit
    // to list it, the user who cannot read it would see an error here, and every edit would ask
    // the storage for the version's files.
    val lister = new FileListerSourceOpDesc
    lister.datasetVersionPath = "/dataset/owner@test.com/private_dataset/v1"
    val scan = new FileScanOpDesc
    val plan = LogicalPlanPojo(
      operators = List(lister, scan),
      links = List(
        LogicalLink(
          lister.operatorIdentifier,
          PortIdentity(),
          scan.operatorIdentifier,
          PortIdentity()
        )
      ),
      opsToViewResult = List.empty,
      opsToReuseResult = List.empty
    )

    var response: Response = null
    val statements = recorder.record { response = postCompile(plan, as = otherUser) }

    assertThat(response.getStatus).isEqualTo(200)
    val body = response.readEntity(classOf[String])
    assert(objectMapper.readTree(body).get("type").asText() == "success", s"got $body")
    // Nothing about the dataset was looked up.
    assert(!statements.exists(_.sql.contains("dataset")), s"statements: ${statements.map(_.sql)}")
    assert(!body.contains(privateDatasetRepositoryName))
    assert(!body.contains(privateDatasetVersionHash))
  }

  it should "return WorkflowCompilationFailure for a File Scan From Input that no File Lister is upstream of" in {
    val names = textOp("/dataset/owner@test.com/private_dataset/v1/notes.txt")
    val scan = new FileScanOpDesc
    val response = postCompile(
      LogicalPlanPojo(
        operators = List(names, scan),
        links = List(
          LogicalLink(
            names.operatorIdentifier,
            PortIdentity(),
            scan.operatorIdentifier,
            PortIdentity()
          )
        ),
        opsToViewResult = List.empty,
        opsToReuseResult = List.empty
      )
    )

    assertThat(response.getStatus).isEqualTo(200)
    val rootNode = objectMapper.readTree(response.readEntity(classOf[String]))
    assert(rootNode.get("type").asText() == "failure", s"expected failure, got $rootNode")
    val errors = rootNode.get("operatorErrors")
    assert(errors.size() == 1 && errors.has(scan.operatorIdentifier.id), s"errors: $errors")
    assert(
      errors.get(scan.operatorIdentifier.id).get("message").asText() ==
        "java.lang.IllegalArgumentException: File Scan From Input reads only the files a File " +
          "Lister upstream of it lists. Link a File Lister to its input, directly or through " +
          "other operators."
    )
  }

  it should "read the site's settings once for a compile, however many operators take one" in {
    // A CSV scan's column limit is the site's: the compile reads it for the plan, not each scan
    // for itself.
    def settingsReads(plan: LogicalPlanPojo): Int =
      recorder
        .record(assertThat(postCompile(plan).getStatus).isEqualTo(200))
        .count(statement => statement.verb == "SELECT" && statement.sql.contains("site_settings"))
    val privateCsv = "/dataset/owner@test.com/private_dataset/v1/table.csv"

    assert(
      settingsReads(
        LogicalPlanPojo(
          operators = List(csvOp(privateCsv), csvOp(privateCsv)),
          links = List.empty,
          opsToViewResult = List.empty,
          opsToReuseResult = List.empty
        )
      ) == 1
    )
    assert(settingsReads(planOf(textOp("north\nsouth"))) == 1)
  }
}
