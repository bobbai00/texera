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

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import org.apache.texera.auth.CatalogTokens
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.web.service.LakekeeperClient.{PurgeWaitPolicy, ServerInfo}
import org.apache.texera.web.service.StubLakekeeper.Request
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach, LoneElement}

import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Exercises [[LakekeeperClient]] end-to-end against an in-process HTTP stub standing in
  * for Lakekeeper ([[StubLakekeeper]]). No network dependency; the stub binds port 0 to pick a
  * free ephemeral port, and answers 500 to any request a case does not expect.
  */
class LakekeeperClientSpec
    extends AnyFlatSpec
    with Matchers
    with LoneElement
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  private val mapper = new ObjectMapper()

  /** What every request of the client carries: the platform's token. */
  private def platformBearer: Option[String] = Some(s"Bearer ${CatalogTokens.platform()}")

  private def json(body: String): JsonNode = mapper.readTree(body)

  // --- the warehouses' stub, shared by the cases that create and delete warehouses ---

  private val lakekeeperWarehouseId = UUID.randomUUID()
  private val erroringWarehouseId = UUID.randomUUID()
  private val goneWarehouseId = UUID.randomUUID()

  // Lakekeeper purges dropped tables asynchronously (queue `tabular_purge`), and
  // answers a warehouse delete with 409 WarehouseHasUnfinishedTasks while any
  // purge task is pending (#7742). These stub warehouses model that queue:
  // `racing` drains after two attempts, `alwaysBusy` never drains, and
  // `otherConflict` 409s for an unrelated reason (which must NOT be retried).
  private val racingWarehouseId = UUID.randomUUID()
  private val alwaysBusyWarehouseId = UUID.randomUUID()
  private val otherConflictWarehouseId = UUID.randomUUID()
  private val malformedConflictWarehouseId = UUID.randomUUID()
  private val unfinishedTasksBody =
    """{"error":{"message":"Warehouse has unfinished tasks. Cannot delete warehouse until all tasks are finished.","type":"WarehouseHasUnfinishedTasks","code":409}}"""

  private val namespacesOf = s"/catalog/v1/$lakekeeperWarehouseId/namespaces"

  private val warehouses: StubLakekeeper = new StubLakekeeper({
    case Request("POST", "/management/v1/warehouse", _, _, _) =>
      (201, s"""{"warehouse-id": "$lakekeeperWarehouseId"}""")
    case Request("DELETE", path, _, _, _) if path.endsWith(racingWarehouseId.toString) =>
      if (deleteAttempts(racingWarehouseId) <= 2) (409, unfinishedTasksBody) else (204, "")
    case Request("DELETE", path, _, _, _) if path.endsWith(alwaysBusyWarehouseId.toString) =>
      (409, unfinishedTasksBody)
    case Request("DELETE", path, _, _, _) if path.endsWith(malformedConflictWarehouseId.toString) =>
      // A 409 whose body isn't the JSON envelope the type check reads.
      (409, "<html>gateway conflict</html>")
    case Request("DELETE", path, _, _, _) if path.endsWith(otherConflictWarehouseId.toString) =>
      (409, """{"error":{"message":"warehouse is in use","type":"Conflict","code":409}}""")
    case Request("DELETE", path, _, _, _)
        if path == s"/management/v1/warehouse/$lakekeeperWarehouseId" =>
      (204, "")
    case Request("GET", path, _, _, _) if path == namespacesOf =>
      (200, """{"namespaces": [["execution-2"]]}""")
    // The tables listing is served in TWO pages so the client's next-page-token
    // loop is pinned: missing the second page would leave the warehouse non-empty.
    case Request("GET", path, None, _, _) if path == s"$namespacesOf/execution-2/tables" =>
      (
        200,
        """{"identifiers": [{"namespace": ["execution-2"], "name": "wid_1_eid_2_result"}],
           |"next-page-token": "page-2"}""".stripMargin
      )
    case Request("GET", path, Some("pageToken=page-2"), _, _)
        if path == s"$namespacesOf/execution-2/tables" =>
      (
        200,
        """{"identifiers": [{"namespace": ["execution-2"], "name": "wid_1_eid_2_state"}]}"""
      )
    case Request("DELETE", path, _, _, _) if path.startsWith(namespacesOf) =>
      (204, "")
    case Request(_, path, _, _, _) if path.contains(goneWarehouseId.toString) =>
      (404, """{"error":{"message":"not found","type":"WarehouseNotFound","code":404}}""")
    case Request(_, path, _, _, _) if path.contains(erroringWarehouseId.toString) =>
      (500, """{"error": "internal"}""")
    // The other warehouses hold no namespace.
    case Request("GET", path, _, _, _) if path.startsWith("/catalog/v1/") =>
      (404, """{"error":{"message":"not found","type":"NoSuchNamespaceException","code":404}}""")
  })

  // How many warehouse deletes have reached the stub for this id, including the one
  // being served: the stub keeps every request before it answers it.
  private def deleteAttempts(id: UUID): Int =
    warehouses.requests.count(_.line == s"DELETE /management/v1/warehouse/$id")

  private val client = new LakekeeperClient(warehouses.catalogUri)

  // Zero retry delay keeps the spec free of real sleeps (deterministic); 4
  // attempts keeps the exhaustion case cheap to assert.
  private val retryClient = new LakekeeperClient(
    warehouses.catalogUri,
    PurgeWaitPolicy(maxAttempts = 4, initialDelayMillis = 0)
  )

  override protected def beforeEach(): Unit = warehouses.clear()

  override protected def afterAll(): Unit = warehouses.close()

  /** Runs `body` with a client of a Lakekeeper that answers as `answer` says. */
  private def withLakekeeper[T](answer: PartialFunction[Request, (Int, String)])(
      body: (StubLakekeeper, LakekeeperClient) => T
  ): T =
    Using.resource(new StubLakekeeper(answer))(stub =>
      body(stub, new LakekeeperClient(stub.catalogUri))
    )

  /** Fails unless every request `stub` received carried the platform's token. */
  private def allCarriedThePlatformsToken(stub: StubLakekeeper): Unit = {
    stub.requests should not be empty
    stub.requests.foreach { request =>
      withClue(s"${request.line}: ") { request.authorization shouldBe platformBearer }
    }
  }

  // --- warehouses ---

  "createWarehouse" should "post the Local storage profile and return the assigned id" in {
    client.createWarehouse("user-7-mybucket") shouldBe lakekeeperWarehouseId

    val payload = json(warehouses.requests.loneElement.body)
    payload.get("warehouse-name").asText() shouldBe "user-7-mybucket"
    payload.get("project-id").asText() shouldBe "00000000-0000-0000-0000-000000000000"
    val profile = payload.get("storage-profile")
    profile.get("type").asText() shouldBe "s3"
    profile.get("bucket").asText() shouldBe StorageConfig.icebergRESTCatalogS3Bucket
    profile.get("sts-enabled").asBoolean() shouldBe false
    profile.get("path-style-access").asBoolean() shouldBe true
    profile.get("flavor").asText() shouldBe "s3-compat"
    // Each warehouse owns its own key prefix inside the shared bucket.
    profile.get("key-prefix").asText() shouldBe "user-7-mybucket"
    payload.get("storage-credential").get("credential-type").asText() shouldBe "access-key"
    allCarriedThePlatformsToken(warehouses)
  }

  "deleteWarehouseEmptyFirst" should "purge every page of tables, then namespaces, then the warehouse" in {
    client.deleteWarehouseEmptyFirst(lakekeeperWarehouseId)

    warehouses.requests.filter(_.method == "DELETE").map(_.line) shouldBe List(
      s"DELETE $namespacesOf/execution-2/tables/wid_1_eid_2_result?purgeRequested=true",
      s"DELETE $namespacesOf/execution-2/tables/wid_1_eid_2_state?purgeRequested=true",
      s"DELETE $namespacesOf/execution-2",
      s"DELETE /management/v1/warehouse/$lakekeeperWarehouseId"
    )
    allCarriedThePlatformsToken(warehouses)
  }

  it should "treat an already-gone warehouse as deleted (404s tolerated, idempotent)" in {
    // Every request about this warehouse 404s. A retry after a partial failure must heal
    // rather than wedge on \"not found\".
    noException should be thrownBy client.deleteWarehouseEmptyFirst(goneWarehouseId)
  }

  it should "surface a Lakekeeper failure with its status and body" in {
    val error = intercept[RuntimeException] {
      client.deleteWarehouseEmptyFirst(erroringWarehouseId)
    }
    error.getMessage should include("Lakekeeper")
    error.getMessage should include("500")
  }

  it should "wait out 409 WarehouseHasUnfinishedTasks from the asynchronous purge (#7742)" in {
    // Lakekeeper purges dropped tables asynchronously; the stub answers the
    // warehouse delete with 409 WarehouseHasUnfinishedTasks twice before the
    // queue "drains" and it returns 204. The delete must ride that out.
    noException should be thrownBy retryClient.deleteWarehouseEmptyFirst(racingWarehouseId)
    deleteAttempts(racingWarehouseId) shouldBe 3
  }

  it should "give up once the purge-wait retries are exhausted" in {
    val error = intercept[RuntimeException] {
      retryClient.deleteWarehouseEmptyFirst(alwaysBusyWarehouseId)
    }
    error.getMessage should include("409")
    error.getMessage should include("WarehouseHasUnfinishedTasks")
    deleteAttempts(alwaysBusyWarehouseId) shouldBe 4
  }

  // Shared by the non-retryable-409 cases: the delete must fail on the first
  // attempt, with the status surfaced, rather than be waited out as transient.
  private def assertFailsWithoutRetry(id: UUID): Unit = {
    val error = intercept[RuntimeException] {
      retryClient.deleteWarehouseEmptyFirst(id)
    }
    error.getMessage should include("409")
    deleteAttempts(id) shouldBe 1
  }

  it should "fail immediately on a 409 whose body is not the expected JSON envelope" in {
    // The type check parses the body; a malformed one must read as "not the
    // purge conflict" and fail rather than be retried as if it were transient.
    assertFailsWithoutRetry(malformedConflictWarehouseId)
  }

  it should "fail immediately on a 409 that is not WarehouseHasUnfinishedTasks" in {
    assertFailsWithoutRetry(otherConflictWarehouseId)
  }

  // --- the shared warehouse ---

  private val sharedWarehouseId = UUID.randomUUID()

  /** A warehouse as Lakekeeper lists it, its storage at `endpoint`. */
  private def listed(name: String, endpoint: String): String =
    s"""{"warehouses": [{
       |  "id": "$sharedWarehouseId", "warehouse-id": "$sharedWarehouseId", "name": "$name",
       |  "project-id": "00000000-0000-0000-0000-000000000000", "status": "active",
       |  "protected": false, "delete-profile": {"type": "hard"},
       |  "storage-profile": {"type": "s3", "bucket": "texera-iceberg", "key-prefix": "shared",
       |    "region": "us-west-2", "endpoint": "$endpoint", "flavor": "s3-compat",
       |    "path-style-access": true, "sts-enabled": false, "remote-signing-enabled": true}
       |}]}""".stripMargin

  "ensureSharedWarehouse" should "create the warehouse under its key prefix when Lakekeeper has none of its name" in {
    withLakekeeper({
      case Request("GET", "/management/v1/warehouse", _, _, _) =>
        (200, listed("another-warehouse", "http://old:9000"))
      case Request("POST", "/management/v1/warehouse", _, _, _) =>
        (201, s"""{"warehouse-id": "$sharedWarehouseId"}""")
    }) { (stub, lakekeeper) =>
      lakekeeper.ensureSharedWarehouse("texera", "shared")

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/warehouse",
        "POST /management/v1/warehouse"
      )
      val payload = json(stub.requests.last.body)
      payload.get("warehouse-name").asText() shouldBe "texera"
      payload.get("project-id").asText() shouldBe "00000000-0000-0000-0000-000000000000"
      val profile = payload.get("storage-profile")
      profile.get("type").asText() shouldBe "s3"
      profile.get("bucket").asText() shouldBe StorageConfig.icebergRESTCatalogS3Bucket
      profile.get("key-prefix").asText() shouldBe "shared"
      profile.get("region").asText() shouldBe StorageConfig.s3Region
      profile.get("endpoint").asText() shouldBe StorageConfig.s3Endpoint
      profile.get("flavor").asText() shouldBe "s3-compat"
      profile.get("path-style-access").asBoolean() shouldBe true
      profile.get("sts-enabled").asBoolean() shouldBe false
      val credential = payload.get("storage-credential")
      credential.get("credential-type").asText() shouldBe "access-key"
      credential.get("aws-access-key-id").asText() shouldBe StorageConfig.s3Username
      credential.get("aws-secret-access-key").asText() shouldBe StorageConfig.s3Password
      allCarriedThePlatformsToken(stub)
    }
  }

  it should "set the endpoint of a warehouse that is there to this deployment's, and keep the rest of its profile (#6195)" in {
    withLakekeeper({
      case Request("GET", "/management/v1/warehouse", _, _, _) =>
        (200, listed("texera", "http://192.0.2.7:9000"))
      case Request("POST", path, _, _, _)
          if path == s"/management/v1/warehouse/$sharedWarehouseId/storage" =>
        (200, "{}")
    }) { (stub, lakekeeper) =>
      lakekeeper.ensureSharedWarehouse("texera", "a-prefix-it-was-not-made-with")

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/warehouse",
        s"POST /management/v1/warehouse/$sharedWarehouseId/storage"
      )
      val payload = json(stub.requests.last.body)
      val profile = payload.get("storage-profile")
      profile.get("endpoint").asText() shouldBe StorageConfig.s3Endpoint
      // Lakekeeper refuses a profile whose key prefix or region would change.
      profile.get("key-prefix").asText() shouldBe "shared"
      profile.get("region").asText() shouldBe "us-west-2"
      profile.get("remote-signing-enabled").asBoolean() shouldBe true
      payload.get("storage-credential").get("aws-access-key-id").asText() shouldBe
        StorageConfig.s3Username
      allCarriedThePlatformsToken(stub)
    }
  }

  it should "refresh the warehouse another replica made meanwhile" in {
    val lists = new AtomicInteger()
    withLakekeeper({
      case Request("GET", "/management/v1/warehouse", _, _, _) =>
        if (lists.incrementAndGet() == 1) (200, """{"warehouses": []}""")
        else (200, listed("texera", "http://192.0.2.7:9000"))
      case Request("POST", "/management/v1/warehouse", _, _, _) =>
        (409, """{"error":{"message":"exists","type":"WarehouseNameAlreadyExists","code":409}}""")
      case Request("POST", path, _, _, _)
          if path == s"/management/v1/warehouse/$sharedWarehouseId/storage" =>
        (200, "{}")
    }) { (stub, lakekeeper) =>
      lakekeeper.ensureSharedWarehouse("texera", "shared")

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/warehouse",
        "POST /management/v1/warehouse",
        "GET /management/v1/warehouse",
        s"POST /management/v1/warehouse/$sharedWarehouseId/storage"
      )
    }
  }

  it should "surface a Lakekeeper that cannot list its warehouses" in {
    withLakekeeper(PartialFunction.empty) { (_, lakekeeper) =>
      val error = intercept[RuntimeException](lakekeeper.ensureSharedWarehouse("texera", "shared"))
      error.getMessage should include("list warehouses")
      error.getMessage should include("500")
    }
  }

  // --- the server ---

  "info" should "tell whether the server is bootstrapped" in {
    Seq(true, false).foreach { bootstrapped =>
      withLakekeeper({
        case Request("GET", "/management/v1/info", _, _, _) =>
          (
            200,
            s"""{"version": "0.11.0", "bootstrapped": $bootstrapped, "authz-backend": "openfga"}"""
          )
      }) { (stub, lakekeeper) =>
        lakekeeper.info() shouldBe ServerInfo(bootstrapped)
        allCarriedThePlatformsToken(stub)
      }
    }
  }

  it should "fail on an answer that tells no bootstrap" in {
    withLakekeeper({
      case Request("GET", "/management/v1/info", _, _, _) => (200, """{"version": "0.11.0"}""")
    }) { (_, lakekeeper) =>
      intercept[RuntimeException](lakekeeper.info()).getMessage should include("no bootstrap")
    }
  }

  "bootstrap" should "make the platform the server's operator, an application named Texera" in {
    withLakekeeper({
      case Request("POST", "/management/v1/bootstrap", _, _, _) => (204, "")
    }) { (stub, lakekeeper) =>
      lakekeeper.bootstrap()

      val payload = json(stub.requests.loneElement.body)
      payload.fieldNames().asScala.toSet shouldBe
        Set("accept-terms-of-use", "is-operator", "user-type", "user-name")
      payload.get("accept-terms-of-use").asBoolean() shouldBe true
      payload.get("is-operator").asBoolean() shouldBe true
      payload.get("user-type").asText() shouldBe "application"
      payload.get("user-name").asText() shouldBe "Texera"
      allCarriedThePlatformsToken(stub)
    }
  }

  it should "take a server another caller bootstrapped for bootstrapped, and fail on any other refusal" in {
    def bootstrapAnswering(status: Int, body: String): Unit =
      withLakekeeper({
        case Request("POST", "/management/v1/bootstrap", _, _, _) => (status, body)
      })((_, lakekeeper) => lakekeeper.bootstrap())

    noException should be thrownBy bootstrapAnswering(
      400,
      """{"error":{"message":"Catalog already bootstrapped","type":"CatalogAlreadyBootstrapped","code":400}}"""
    )
    intercept[RuntimeException](
      bootstrapAnswering(
        400,
        """{"error":{"message":"terms","type":"TermsOfUseNotAccepted","code":400}}"""
      )
    ).getMessage should include("400")
    intercept[RuntimeException](bootstrapAnswering(401, "")).getMessage should include("401")
  }

  "ensureDefaultProject" should "make the default project, and take one that is there for made" in {
    Seq(201, 409).foreach { status =>
      withLakekeeper({
        case Request("POST", "/management/v1/project", _, _, _) =>
          (status, """{"project-id": "00000000-0000-0000-0000-000000000000"}""")
      }) { (stub, lakekeeper) =>
        withClue(s"$status: ") {
          lakekeeper.ensureDefaultProject()

          val payload = json(stub.requests.loneElement.body)
          payload.get("project-id").asText() shouldBe "00000000-0000-0000-0000-000000000000"
          payload.get("project-name").asText() shouldBe "default"
          allCarriedThePlatformsToken(stub)
        }
      }
    }
  }

  it should "fail when the project cannot be made" in {
    withLakekeeper({
      case Request("POST", "/management/v1/project", _, _, _) => (403, """{"error": "no"}""")
    }) { (_, lakekeeper) =>
      intercept[RuntimeException](lakekeeper.ensureDefaultProject()).getMessage should
        include("403")
    }
  }

  // --- an execution's namespace, user and grants ---

  private val warehousePrefix = UUID.randomUUID().toString

  /** A catalog with namespace execution-5 in warehouse texera, and no execution-6. */
  private val catalog: PartialFunction[Request, (Int, String)] = {
    case Request("GET", "/catalog/v1/config", Some("warehouse=texera"), _, _) =>
      (200, s"""{"defaults": {}, "overrides": {"prefix": "$warehousePrefix"}, "endpoints": []}""")
    case Request("GET", "/catalog/v1/config", Some("warehouse=user-1-2"), _, _) =>
      (200, """{"defaults": {"prefix": "the-prefix-of-user-1-2"}, "overrides": {}}""")
    case Request("GET", path, _, _, _)
        if path == s"/catalog/v1/$warehousePrefix/namespaces/execution-5" =>
      (200, """{"namespace": ["execution-5"], "properties": {"namespace_id": "ns-of-5"}}""")
    case Request("GET", path, _, _, _)
        if path == "/catalog/v1/the-prefix-of-user-1-2/namespaces/execution-5" =>
      (200, """{"namespace": ["execution-5"], "properties": {"namespace_id": "ns-of-5-there"}}""")
    case Request("GET", path, _, _, _)
        if path == s"/catalog/v1/$warehousePrefix/namespaces/execution-6" =>
      (404, """{"error":{"message":"not found","type":"NoSuchNamespaceException","code":404}}""")
  }

  "namespaceIdOf" should "find a namespace's id by its warehouse's prefix, which it looks up once per warehouse" in {
    withLakekeeper(catalog) { (stub, lakekeeper) =>
      lakekeeper.namespaceIdOf("texera", "execution-5") shouldBe Some("ns-of-5")
      lakekeeper.namespaceIdOf("texera", "execution-6") shouldBe None
      lakekeeper.namespaceIdOf("texera", "execution-5") shouldBe Some("ns-of-5")
      lakekeeper.namespaceIdOf("user-1-2", "execution-5") shouldBe Some("ns-of-5-there")

      stub.requests.map(_.line) shouldBe List(
        "GET /catalog/v1/config?warehouse=texera",
        s"GET /catalog/v1/$warehousePrefix/namespaces/execution-5",
        s"GET /catalog/v1/$warehousePrefix/namespaces/execution-6",
        s"GET /catalog/v1/$warehousePrefix/namespaces/execution-5",
        "GET /catalog/v1/config?warehouse=user-1-2",
        "GET /catalog/v1/the-prefix-of-user-1-2/namespaces/execution-5"
      )
      allCarriedThePlatformsToken(stub)
    }
  }

  it should "fail on a warehouse the catalog has no config of, and on a namespace it gives no id" in {
    val withNoId: PartialFunction[Request, (Int, String)] = {
      case Request("GET", path, _, _, _)
          if path == s"/catalog/v1/$warehousePrefix/namespaces/execution-7" =>
        (200, """{"namespace": ["execution-7"], "properties": {}}""")
    }
    withLakekeeper(catalog.orElse(withNoId)) { (_, lakekeeper) =>
      intercept[RuntimeException](
        lakekeeper.namespaceIdOf("user-9-9", "execution-5")
      ).getMessage should include("500")
      intercept[RuntimeException](
        lakekeeper.namespaceIdOf("texera", "execution-7")
      ).getMessage should include("no id")
    }
  }

  "createUser" should "make an application user of the id given, or update the one there" in {
    Seq(201, 200).foreach { status =>
      withLakekeeper({
        case Request("POST", "/management/v1/user", _, _, _) => (status, "{}")
      }) { (stub, lakekeeper) =>
        lakekeeper.createUser("oidc~texera-execution-5", "execution 5")

        val payload = json(stub.requests.loneElement.body)
        payload.fieldNames().asScala.toSet shouldBe
          Set("id", "name", "user-type", "update-if-exists")
        payload.get("id").asText() shouldBe "oidc~texera-execution-5"
        payload.get("name").asText() shouldBe "execution 5"
        payload.get("user-type").asText() shouldBe "application"
        payload.get("update-if-exists").asBoolean() shouldBe true
        allCarriedThePlatformsToken(stub)
      }
    }
  }

  it should "fail when the user cannot be made" in {
    withLakekeeper(PartialFunction.empty) { (_, lakekeeper) =>
      intercept[RuntimeException](
        lakekeeper.createUser("oidc~texera-execution-5", "execution 5")
      ).getMessage should include("500")
    }
  }

  private val assignmentsOf5 = "/management/v1/permissions/namespace/ns-of-5/assignments"

  "grantNamespace" should "write one assignment per kind for the user, on the namespace's id" in {
    withLakekeeper({
      case Request("POST", `assignmentsOf5`, _, _, _) => (204, "")
    }) { (stub, lakekeeper) =>
      lakekeeper.grantNamespace("ns-of-5", "oidc~texera-execution-5", Seq("create", "select"))

      stub.requests.map(_.line) shouldBe List(s"POST $assignmentsOf5")
      val payload = json(stub.requests.head.body)
      payload.fieldNames().asScala.toSet shouldBe Set("writes")
      payload.get("writes").iterator().asScala.toList.map { write =>
        (write.get("type").asText(), write.get("user").asText())
      } shouldBe List(
        ("create", "oidc~texera-execution-5"),
        ("select", "oidc~texera-execution-5")
      )
      allCarriedThePlatformsToken(stub)
    }
  }

  it should "take a refused write for granted when the user holds every grant already" in {
    withLakekeeper({
      case Request("POST", `assignmentsOf5`, _, _, _) =>
        (409, """{"error":{"message":"exists","type":"TupleAlreadyExists","code":409}}""")
      case Request("GET", `assignmentsOf5`, _, _, _) =>
        (
          200,
          """{"assignments": [
            |  {"type": "create", "user": "oidc~texera-execution-5"},
            |  {"type": "select", "user": "oidc~texera-execution-5"},
            |  {"type": "modify", "user": "oidc~texera-execution-6"}
            |]}""".stripMargin
        )
    }) { (stub, lakekeeper) =>
      lakekeeper.grantNamespace("ns-of-5", "oidc~texera-execution-5", Seq("create", "select"))
      intercept[RuntimeException](
        lakekeeper.grantNamespace("ns-of-5", "oidc~texera-execution-5", Seq("modify"))
      ).getMessage should include("409")
      allCarriedThePlatformsToken(stub)
    }
  }

  "deleteUser" should "delete the user at its id, unencoded where the id is unreserved, and take a missing one for deleted" in {
    Seq(204, 404).foreach { status =>
      withLakekeeper({
        case Request("DELETE", "/management/v1/user/oidc~texera-execution-5", _, _, _) =>
          (status, "")
      }) { (stub, lakekeeper) =>
        withClue(s"$status: ") {
          lakekeeper.deleteUser("oidc~texera-execution-5")
          stub.requests.map(_.line) shouldBe List(
            "DELETE /management/v1/user/oidc~texera-execution-5"
          )
          allCarriedThePlatformsToken(stub)
        }
      }
    }
  }

  it should "fail when the user cannot be deleted" in {
    withLakekeeper(PartialFunction.empty) { (_, lakekeeper) =>
      intercept[RuntimeException](
        lakekeeper.deleteUser("oidc~texera-execution-5")
      ).getMessage should include("500")
    }
  }
}
