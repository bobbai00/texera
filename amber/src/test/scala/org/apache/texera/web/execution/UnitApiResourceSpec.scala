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

import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.util.UUID

class UnitApiResourceSpec extends AnyFlatSpec with Matchers {

  "the operator registry" should "be served in the contract's OperatorTypeList shape" in {
    val registry = UnitApiResource.operatorRegistry
    registry.operators should not be empty
    val scan = registry.operators.find(_.operatorType == "CSVFileScan").get
    scan.userFriendlyName should not be empty
    scan.operatorGroupName should not be empty
    scan.jsonSchema.get("properties").has("fileName") shouldBe true
    scan.outputPorts should not be empty
    registry.groups should not be empty
    // It serializes with the field names api/common.tsp declares.
    val json = objectMapper.valueToTree[com.fasterxml.jackson.databind.JsonNode](scan)
    json.has("operatorType") shouldBe true
    json.has("userFriendlyName") shouldBe true
    json.has("jsonSchema") shouldBe true
  }

  "compile" should "report output schemas per port for a valid plan" in {
    val csv = java.nio.file.Files.createTempFile("iris", ".csv")
    java.nio.file.Files.writeString(csv, "species,petal\nsetosa,1.4\nvirginica,5.5\n")
    val plan = objectMapper.readTree(
      s"""{"operators":[{"operatorID":"scan","operatorType":"CSVFileScan","fileName":"${csv.toString}",
         |"fileEncoding":"UTF_8","hasHeader":true,"inputPorts":[],"outputPorts":[{"portID":"output-0"}]}],
         |"links":[],"opsToViewResult":[],"opsToReuseResult":[]}""".stripMargin
    )
    val result = new UnitApiResource().compile(EngineCompileRequest(plan))
    result.ok shouldBe true
    result.operatorErrors shouldBe empty
    result.operatorOutputSchemas("scan")("output-0").get.map(_.attributeName) shouldBe List(
      "species",
      "petal"
    )
  }

  it should "report an error per operator instead of throwing for a broken plan" in {
    val plan = objectMapper.readTree(
      """{"operators":[{"operatorID":"scan","operatorType":"CSVFileScan","fileName":"/no/such/file.csv",
        |"fileEncoding":"UTF_8","hasHeader":true}],"links":[],"opsToViewResult":[],"opsToReuseResult":[]}""".stripMargin
    )
    val result = new UnitApiResource().compile(EngineCompileRequest(plan))
    result.ok shouldBe false
    result.operatorErrors.keySet should contain("scan")
  }

  "statusOf" should "map engine states to catalog execution statuses" in {
    UnitApiResource.statusOf(WorkflowAggregatedState.COMPLETED) shouldBe "completed"
    UnitApiResource.statusOf(WorkflowAggregatedState.FAILED) shouldBe "failed"
    UnitApiResource.statusOf(WorkflowAggregatedState.KILLED) shouldBe "cancelled"
    UnitApiResource.statusOf(WorkflowAggregatedState.RUNNING) shouldBe "running"
    UnitApiResource.statusOf(WorkflowAggregatedState.READY) shouldBe "pending"
    UnitApiResource.isTerminal(WorkflowAggregatedState.COMPLETED) shouldBe true
    UnitApiResource.isTerminal(WorkflowAggregatedState.RUNNING) shouldBe false
  }

  "workflowIdOf" should "derive a stable engine id from a catalog rid" in {
    val rid = UUID.randomUUID().toString
    UnitApiResource.workflowIdOf(rid) shouldBe UnitApiResource.workflowIdOf(rid)
    UnitApiResource.workflowIdOf(rid) should be >= 0L
  }

  "claim" should "let exactly one start through per execution id, even when starts race" in {
    // A second start of the same id would shut down the run already going and report it failed.
    val eid = UUID.randomUUID().toString
    val pool = java.util.concurrent.Executors.newFixedThreadPool(16)
    try {
      val gate = new java.util.concurrent.CountDownLatch(1)
      val attempts = (1 to 64).map { _ =>
        pool.submit(new java.util.concurrent.Callable[Boolean] {
          override def call(): Boolean = { gate.await(); UnitApiResource.claim(eid) }
        })
      }
      gate.countDown()
      attempts.map(_.get()).count(identity) shouldBe 1
    } finally pool.shutdown()
    UnitApiResource.claim(UUID.randomUUID().toString) shouldBe true
  }

  "recordedResult" should "accept only this execution's result table for the named port" in {
    import org.apache.texera.amber.core.storage.VFSURIFactory
    import org.apache.texera.amber.core.virtualidentity.{
      ExecutionIdentity,
      OperatorIdentity,
      PhysicalOpIdentity,
      WorkflowIdentity
    }
    import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
    val eid = UUID.randomUUID().toString
    def table(
        execution: Long,
        op: String,
        port: Int = 0,
        internal: Boolean = false,
        state: Boolean = false
    ) = {
      val gp = GlobalPortIdentity(
        PhysicalOpIdentity(OperatorIdentity(op), "main"),
        PortIdentity(port, internal)
      )
      val base =
        VFSURIFactory.createPortBaseURI(WorkflowIdentity(5), ExecutionIdentity(execution), gp)
      (if (state) VFSURIFactory.stateURI(base) else VFSURIFactory.resultURI(base)).toString
    }
    val own = table(EngineIds.of(eid), "avg")
    UnitApiResource.recordedResult(eid, "avg", 0, own).toString shouldBe own

    val refused = Seq(
      table(EngineIds.of(UUID.randomUUID().toString), "avg"), // another execution's table
      table(EngineIds.of(eid), "scan"), // another operator
      table(EngineIds.of(eid), "avg", port = 1), // another port
      table(EngineIds.of(eid), "avg", internal = true), // an internal port
      table(EngineIds.of(eid), "avg", state = true), // not a result
      "https://example.org/x",
      "not a uri %%"
    )
    refused.foreach { location =>
      withClue(location) {
        val error = the[javax.ws.rs.WebApplicationException] thrownBy UnitApiResource
          .recordedResult(eid, "avg", 0, location)
        error.getResponse.getStatus shouldBe 403
      }
    }
  }

  "EnvironmentManager.nameOf" should "make a filesystem-safe, version-specific name" in {
    val name = EnvironmentManager.nameOf("e6325d76-7bcf-442c-b926-1c9175ae42d8", 3)
    name shouldBe "env-e6325d767bcf442cb9261c9175ae42d8-v3"
    EnvironmentManager.getPythonBin("../escape") shouldBe None
  }
}
