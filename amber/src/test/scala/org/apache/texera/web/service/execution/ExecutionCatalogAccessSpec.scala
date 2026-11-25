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
import org.apache.iceberg.catalog.{Namespace, SupportsNamespaces}
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionLogStore,
  ExecutionNamespace,
  ExecutionTables,
  IcebergCatalogInstance,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.web.service.execution.RecordingLakekeeper.{
  Granted,
  LookedUp,
  NamespaceDropped,
  UserDeleted,
  UserMade
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

/**
  * What an execution may do in the lake ([[ExecutionCatalogAccess]]): its namespace is made and
  * dropped in the catalog the build's tests use (the Postgres JDBC catalog in CI), and its
  * catalog user and grants go to a Lakekeeper that keeps what it is asked
  * ([[RecordingLakekeeper]]). The executions are this suite's own, by their ids.
  */
class ExecutionCatalogAccessSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll {

  private val mapper = new ObjectMapper()
  private val nextEid = new AtomicInteger(977100)
  private val sharedWarehouse = StorageConfig.icebergRESTCatalogWarehouseName

  /** A fresh execution: whatever an earlier run of the suite left of it is dropped. */
  private def freshEid(): Long = {
    val eid = nextEid.getAndIncrement().toLong
    ExecutionTables.dropNamespace(eid, None)
    eid
  }

  override protected def afterAll(): Unit =
    try (977100 until nextEid.get()).foreach(eid => ExecutionTables.dropNamespace(eid, None))
    finally super.afterAll()

  private def hasNamespace(eid: Long): Boolean =
    IcebergCatalogInstance
      .getInstance()
      .asInstanceOf[SupportsNamespaces]
      .namespaceExists(Namespace.of(ExecutionNamespace.of(eid)))

  /** The claims of `token`, a JWS in its compact form. */
  private def claimsOf(token: String): JsonNode =
    mapper.readTree(
      new String(Base64.getUrlDecoder.decode(token.split('.')(1)), StandardCharsets.UTF_8)
    )

  private def headerOf(token: String): JsonNode =
    mapper.readTree(
      new String(Base64.getUrlDecoder.decode(token.split('.')(0)), StandardCharsets.UTF_8)
    )

  private def userOf(eid: Long): String = s"oidc~texera-execution-$eid"

  // --- open ---

  "ExecutionCatalogAccess.open" should "make the execution's namespace, its catalog user granted on it, and answer its token" in {
    val lakekeeper = new RecordingLakekeeper()
    val eid = freshEid()

    val token = new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ())
      .open(eid, None)

    hasNamespace(eid) shouldBe true
    lakekeeper.calls shouldBe Seq(
      // Whatever user of the same id the catalog holds goes first, with all it was granted.
      UserDeleted(userOf(eid)),
      LookedUp(sharedWarehouse, s"execution-$eid"),
      UserMade(userOf(eid), s"execution $eid"),
      Granted(
        RecordingLakekeeper.idOf(sharedWarehouse, s"execution-$eid"),
        userOf(eid),
        Seq("create", "modify", "select")
      )
    )
    // The token names the execution's user, for the catalog's audience.
    token shouldBe defined
    headerOf(token.get).get("alg").asText() shouldBe "ES256"
    val claims = claimsOf(token.get)
    claims.get("sub").asText() shouldBe s"texera-execution-$eid"
    claims.get("iss").asText() shouldBe StorageConfig.icebergRESTCatalogTokenIssuer
    claims.get("aud").asText() shouldBe StorageConfig.icebergRESTCatalogTokenAudience
    claims.get("exp").asLong() - claims.get("iat").asLong() shouldBe
      StorageConfig.icebergRESTCatalogTokenExecutionTtlSeconds
  }

  it should "make the namespace in the warehouse the execution writes into, and look its id up there" in {
    val lakekeeper = new RecordingLakekeeper()
    val eid = freshEid()

    new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ())
      .open(eid, Some("user-7-3"))

    lakekeeper.calls.collect { case looked: LookedUp => looked } shouldBe
      Seq(LookedUp("user-7-3", s"execution-$eid"))
    lakekeeper.calls.collect { case granted: Granted => granted.namespaceId } shouldBe
      Seq(RecordingLakekeeper.idOf("user-7-3", s"execution-$eid"))
  }

  it should "make the catalog ready first, and make nothing in a catalog that is not" in {
    val lakekeeper = new RecordingLakekeeper()
    val eid = freshEid()
    val notReady = new IllegalStateException("the catalog is not set up")

    the[IllegalStateException] thrownBy new ExecutionCatalogAccess(
      lakekeeper,
      rest = true,
      setup = () => throw notReady
    ).open(eid, None) shouldBe notReady

    hasNamespace(eid) shouldBe false
    lakekeeper.calls shouldBe empty
  }

  it should "replace a namespace already there, a stale one, with its tables and its user" in {
    val lakekeeper = new RecordingLakekeeper()
    val access = new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ())
    val eid = freshEid()
    access.open(eid, None)
    // What an execution of the same id left: a database made afresh beside a kept catalog.
    val staleLog = ExecutionLogStore.logUri(WorkflowIdentity(9772), ExecutionIdentity(eid), None)
    ExecutionLogStore.create(staleLog, System.currentTimeMillis(), 30000L)

    val again = access.open(eid, None)

    hasNamespace(eid) shouldBe true
    ExecutionTables.exists(staleLog) shouldBe false
    claimsOf(again.get).get("sub").asText() shouldBe s"texera-execution-$eid"
    lakekeeper.calls.collect {
      case made: UserMade            => s"made ${made.id}"
      case deleted: UserDeleted      => s"deleted ${deleted.id}"
      case dropped: NamespaceDropped => s"dropped ${dropped.namespace}"
    } shouldBe Seq(
      s"deleted ${userOf(eid)}",
      s"made ${userOf(eid)}",
      s"deleted ${userOf(eid)}",
      s"dropped execution-$eid",
      s"made ${userOf(eid)}"
    )
  }

  it should "fail, and grant nothing, when the catalog has no id for the namespace it made" in {
    val lakekeeper = new RecordingLakekeeper {
      override def namespaceIdOf(warehouseName: String, namespace: String): Option[String] = {
        super.namespaceIdOf(warehouseName, namespace)
        None
      }
    }
    val eid = freshEid()

    val failure = intercept[IllegalStateException] {
      new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ()).open(eid, None)
    }

    failure.getMessage shouldBe s"Namespace execution-$eid of warehouse $sharedWarehouse was " +
      "made, and the catalog has no id for it."
    lakekeeper.calls shouldBe Seq(
      UserDeleted(userOf(eid)),
      LookedUp(sharedWarehouse, s"execution-$eid")
    )
  }

  it should "make only the namespace, and answer no token, on a catalog that is not a REST one" in {
    val lakekeeper = new RecordingLakekeeper()
    val eid = freshEid()
    var setUp = 0

    new ExecutionCatalogAccess(lakekeeper, rest = false, setup = () => setUp += 1)
      .open(eid, None) shouldBe None

    hasNamespace(eid) shouldBe true
    setUp shouldBe 1
    lakekeeper.calls shouldBe empty
  }

  // --- revoke ---

  "ExecutionCatalogAccess.revoke" should "delete the execution's catalog user, and leave its namespace" in {
    val lakekeeper = new RecordingLakekeeper()
    val access = new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ())
    val eid = freshEid()
    access.open(eid, None)

    access.revoke(eid)

    lakekeeper.calls.last shouldBe UserDeleted(userOf(eid))
    hasNamespace(eid) shouldBe true
  }

  it should "ask nothing on a catalog that is not a REST one" in {
    val lakekeeper = new RecordingLakekeeper()

    new ExecutionCatalogAccess(lakekeeper, rest = false, setup = () => ()).revoke(freshEid())

    lakekeeper.calls shouldBe empty
  }

  // --- drop ---

  "ExecutionCatalogAccess.drop" should "delete the execution's catalog user first, then have the catalog drop the namespace with all it holds" in {
    var namespaceAtRevoke: Option[Boolean] = None
    val eid = freshEid()
    val lakekeeper = new RecordingLakekeeper {
      override def deleteUser(id: String): Unit = {
        namespaceAtRevoke = Some(hasNamespace(eid))
        super.deleteUser(id)
      }
    }
    val access = new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ())
    access.open(eid, None)
    val wid = WorkflowIdentity(9771)
    val log = ExecutionLogStore.logUri(wid, ExecutionIdentity(eid), None)
    ExecutionLogStore.create(log, System.currentTimeMillis(), 30000L)
    val result = VFSURIFactory.resultURI(
      VFSURIFactory.createPortBaseURI(
        wid,
        ExecutionIdentity(eid),
        GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("scan"), "main"), PortIdentity())
      )
    )
    DocumentFactory.createDocument(result, Schema().add("line", AttributeType.STRING))

    access.drop(eid, None)

    hasNamespace(eid) shouldBe false
    Seq(log, result).foreach(uri =>
      withClue(s"$uri: ") { ExecutionTables.exists(uri) shouldBe false }
    )
    // The catalog drops the namespace itself, with what the execution's token may have made
    // there besides tables (views, namespaces), protected or not.
    lakekeeper.calls.takeRight(2) shouldBe Seq(
      UserDeleted(userOf(eid)),
      NamespaceDropped(sharedWarehouse, s"execution-$eid")
    )
    // Revoked while the namespace was still there: a unit can make no table while it empties.
    namespaceAtRevoke shouldBe Some(true)
  }

  it should "change nothing of an execution with no namespace, as often as asked" in {
    val lakekeeper = new RecordingLakekeeper()
    val access = new ExecutionCatalogAccess(lakekeeper, rest = true, setup = () => ())
    val eid = freshEid()

    access.drop(eid, None)
    access.drop(eid, None)

    hasNamespace(eid) shouldBe false
    lakekeeper.calls shouldBe Seq
      .fill(2)(
        Seq(UserDeleted(userOf(eid)), NamespaceDropped(sharedWarehouse, s"execution-$eid"))
      )
      .flatten
  }

  it should "drop the namespace with its tables itself on a catalog that is not a REST one" in {
    val lakekeeper = new RecordingLakekeeper()
    val access = new ExecutionCatalogAccess(lakekeeper, rest = false, setup = () => ())
    val eid = freshEid()
    access.open(eid, None)
    val log = ExecutionLogStore.logUri(WorkflowIdentity(9773), ExecutionIdentity(eid), None)
    ExecutionLogStore.create(log, System.currentTimeMillis(), 30000L)

    access.drop(eid, None)

    hasNamespace(eid) shouldBe false
    ExecutionTables.exists(log) shouldBe false
    lakekeeper.calls shouldBe empty
  }

  "ExecutionCatalogAccess.userOf" should "name the user the execution's token is for" in {
    ExecutionCatalogAccess.userOf(42L) shouldBe "oidc~texera-execution-42"
  }
}
