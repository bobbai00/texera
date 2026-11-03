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

package org.apache.texera.web.execution

import org.apache.texera.amber.core.storage.VFSURIFactory
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.apache.texera.web.service.ExecutionsMetadataPersistService
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.UUID

class ExecutionRegistrySpec extends AnyFlatSpec with Matchers {

  private def resultUri(
      eid: ExecutionIdentity,
      op: String,
      port: Int
  ): (GlobalPortIdentity, URI) = {
    val gp =
      GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity(op), "main"), PortIdentity(port))
    gp -> VFSURIFactory.resultURI(VFSURIFactory.createPortBaseURI(WorkflowIdentity(1), eid, gp))
  }

  "insertNewExecution" should "register an in-memory record with the catalog's id" in {
    val eid = ExecutionsMetadataPersistService.insertNewExecution(
      WorkflowIdentity(7),
      executionName = "run",
      environmentVersion = "2.0",
      computingUnitId = 0,
      externalId = Some("catalog-eid-1")
    )
    val record = ExecutionRegistry.get(eid).get
    record.externalId shouldBe Some("catalog-eid-1")
    record.workflowId shouldBe 7L
    ExecutionRegistry.getByExternalId("catalog-eid-1").map(_.eid) shouldBe Some(eid)
    ExecutionRegistry.latestExecution(7, 0) shouldBe Some(eid)
  }

  "create" should "derive the engine id from the catalog's execution id" in {
    // Result tables are named after this id and units share one warehouse, so it has to be the
    // same function of the catalog id on every unit and after every restart.
    val catalogEid = "3f1c2a64-8d0b-4d5e-9a7f-0c2b9e4d1a55"
    val record = ExecutionRegistry.create(11, 0, "run", Some(catalogEid))
    record.eid.id shouldBe EngineIds.of(UUID.fromString(catalogEid))
    record.eid.id should be > 0L
    an[IllegalStateException] should be thrownBy ExecutionRegistry.create(
      11,
      0,
      "again",
      Some(catalogEid)
    )
  }

  it should "never hand out the same engine id twice, with or without a catalog id" in {
    val ids = (1 to 200).map(i =>
      ExecutionRegistry
        .create(12, 0, s"run-$i", if (i % 2 == 0) Some(UUID.randomUUID().toString) else None)
        .eid
        .id
    )
    ids.distinct should have size ids.size
    ids.foreach(_ should be > 1L) // 1 is the large-binary store's shared default prefix
  }

  "EngineIds" should "mix both halves of a time-ordered UUID" in {
    // Two UUIDv7 values minted in the same millisecond share their high half almost entirely.
    val sameMillisecond = UUID.fromString("018f6b8e-1a2b-7000-8000-000000000001")
    val sibling = UUID.fromString("018f6b8e-1a2b-7000-8000-000000000002")
    EngineIds.of(sameMillisecond) should not be EngineIds.of(sibling)
    EngineIds.of("not-a-uuid") shouldBe EngineIds.of("not-a-uuid")
  }

  "tryUpdateExistingExecution" should "update a known record and ignore an unknown one" in {
    val eid = ExecutionsMetadataPersistService.insertNewExecution(WorkflowIdentity(8), "", "2.0", 0)
    var notified = 0
    ExecutionRegistry.onStatus(eid)(_ => notified += 1)
    ExecutionsMetadataPersistService.tryUpdateExistingExecution(eid)(_.setStatus(3.toShort))
    ExecutionRegistry.get(eid).get.getStatus shouldBe 3
    notified shouldBe 1
    noException should be thrownBy
      ExecutionsMetadataPersistService.tryUpdateExistingExecution(ExecutionIdentity(Long.MaxValue))(
        _.setStatus(1.toShort)
      )
  }

  "recordPortResultUri" should "index results by port and resolve logical ports" in {
    val eid = ExecutionsMetadataPersistService.insertNewExecution(WorkflowIdentity(9), "", "2.0", 0)
    val (gp, uri) = resultUri(eid, "avg", 0)
    var seen: Option[URI] = None
    ExecutionRegistry.onPortResult(eid)((_, u) => seen = Some(u))
    ExecutionRegistry.recordPortResultUri(eid, gp, uri)
    seen shouldBe Some(uri)
    ExecutionRegistry.getResultUrisByExecutionId(eid) shouldBe List(uri)
    ExecutionRegistry.getResultUriByLogicalPortId(
      eid,
      OperatorIdentity("avg"),
      PortIdentity(0)
    ) shouldBe Some(uri)
    ExecutionRegistry.getResultUriByLogicalPortId(
      eid,
      OperatorIdentity("other"),
      PortIdentity(0)
    ) shouldBe None
    ExecutionRegistry.updateResultSize(eid, gp, 42L)
    ExecutionRegistry.get(eid).get.resultSize(gp.serializeAsString) shouldBe Some(42L)
  }

  "getExpiredExecutionsWithResultOrLog" should "return executions that still hold results" in {
    val eid =
      ExecutionsMetadataPersistService.insertNewExecution(WorkflowIdentity(10), "", "2.0", 0)
    val (gp, uri) = resultUri(eid, "scan", 0)
    ExecutionRegistry.recordPortResultUri(eid, gp, uri)
    ExecutionRegistry.getExpiredExecutionsWithResultOrLog(-1).map(_.eid) should contain(eid)
    ExecutionRegistry.deleteConsoleMessageAndExecutionResultUris(eid)
    ExecutionRegistry.getExpiredExecutionsWithResultOrLog(-1).map(_.eid) should not contain eid
  }
}
