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

package org.apache.texera.amber.core.storage

import org.apache.iceberg.exceptions.ServiceUnavailableException
import org.apache.texera.amber.core.storedplan.{
  StoredOutputPort,
  StoredPhysicalOp,
  StoredPhysicalPlan
}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PhysicalPlanCodec, PortIdentity}
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.concurrent.atomic.AtomicLong

/**
  * Specs for [[ExecutionTables]] on Iceberg's JDBC catalog (see [[EmbeddedJdbcCatalog]]): the
  * plans it reads and the tables it measures are real ones.
  */
@NonParallelTest
class ExecutionTablesSpec extends AnyFlatSpec with Matchers with EmbeddedJdbcCatalog {

  private val workflowId = WorkflowIdentity(12)
  private val nextExecutionId = new AtomicLong(100)

  private def freshExecution(): ExecutionIdentity =
    ExecutionIdentity(nextExecutionId.getAndIncrement())

  private def port(operator: String, number: Int): GlobalPortIdentity =
    GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity(operator), "main"), PortIdentity(number))

  /** Where `port` of execution `eid` is stored, as a plan made to run names it. */
  private def locationOf(
      eid: ExecutionIdentity,
      port: GlobalPortIdentity,
      warehouse: Option[String] = None,
      wid: WorkflowIdentity = workflowId
  ): URI = VFSURIFactory.createPortBaseURI(wid, eid, port, warehouse)

  /** Writes a plan whose operators store their output ports at `locations`, one list each. */
  private def writtenPlan(
      eid: ExecutionIdentity,
      locations: Seq[Seq[String]],
      warehouse: Option[String] = None
  ): URI = {
    val uri = ExecutionPlanStore.planUri(workflowId, eid, warehouse)
    val body = PhysicalPlanCodec.toJson(
      StoredPhysicalPlan(
        formatVersion = PhysicalPlanCodec.FormatVersion,
        operators = locations.map(ports =>
          StoredPhysicalOp(outputPorts =
            ports.map(location => StoredOutputPort(storageLocation = location))
          )
        )
      )
    )
    ExecutionPlanStore.writePlan(
      uri,
      PlanRecord(ExecutionPlanStore.PlanEntryId, body, 1, 3),
      """{"operators":[],"links":[],"opsToViewResult":[],"opsToReuseResult":[]}"""
    )
    uri
  }

  private def statisticsRow(operator: String): RuntimeStatisticsRow =
    RuntimeStatisticsRow(operator, 1794873600000L, 1, 2, 3, 4, 5, 6, 7, 1, 1)

  "ExecutionTables.ownTables" should "name the plan, the log, the statistics and the console of an execution" in {
    val eid = ExecutionIdentity(34)

    ExecutionTables.ownTables(workflowId, eid, None).map(_.toString) shouldBe Seq(
      "vfs:///wid/12/eid/34/plan",
      "vfs:///wid/12/eid/34/executionlog",
      "vfs:///wid/12/eid/34/runtimestatistics",
      "vfs:///wid/12/eid/34/consolemessages"
    )
    ExecutionTables.ownTables(workflowId, eid, Some(warehouse)).map(_.toString) shouldBe Seq(
      s"vfs:///wh/$warehouse/wid/12/eid/34/plan",
      s"vfs:///wh/$warehouse/wid/12/eid/34/executionlog",
      s"vfs:///wh/$warehouse/wid/12/eid/34/runtimestatistics",
      s"vfs:///wh/$warehouse/wid/12/eid/34/consolemessages"
    )
  }

  "ExecutionTables.portTables" should "list the result and the state of every output port the plan names" in {
    val eid = freshExecution()
    val scan = locationOf(eid, port("scan", 0))
    val join0 = locationOf(eid, port("join", 0))
    val join1 = locationOf(eid, port("join", 1))
    val uri = writtenPlan(eid, Seq(Seq(scan.toString), Seq(join0.toString, join1.toString)))

    ExecutionTables.portTables(uri) shouldBe Seq(scan, join0, join1).flatMap(base =>
      Seq(VFSURIFactory.resultURI(base), VFSURIFactory.stateURI(base))
    )
    // Each is a table's URI: of the result namespace, or of the state namespace.
    ExecutionTables.portTables(uri).map(VFSURIFactory.decodeURI(_).resourceType).distinct shouldBe
      Seq(VFSResourceType.RESULT, VFSResourceType.STATE)
  }

  it should "list the ports of a plan in a warehouse in that warehouse" in {
    val eid = freshExecution()
    val scan = locationOf(eid, port("scan", 0), Some(warehouse))
    val uri = writtenPlan(eid, Seq(Seq(scan.toString)), Some(warehouse))

    ExecutionTables.portTables(uri) shouldBe
      Seq(VFSURIFactory.resultURI(scan), VFSURIFactory.stateURI(scan))
  }

  it should "list nothing for a plan whose operators have no output port, or an execution with no stored plan" in {
    val eid = freshExecution()

    ExecutionTables.portTables(ExecutionPlanStore.planUri(workflowId, eid, None)) shouldBe Nil
    ExecutionTables.portTables(writtenPlan(eid, Seq(Seq.empty))) shouldBe Nil
  }

  it should "refuse a location that is not a port's of the plan's own execution, in its warehouse" in {
    val eid = freshExecution()
    val elsewhere = Seq(
      locationOf(ExecutionIdentity(eid.id + 1000), port("scan", 0)).toString,
      locationOf(eid, port("scan", 0), wid = WorkflowIdentity(13)).toString,
      locationOf(eid, port("scan", 0), Some(warehouse)).toString,
      ExecutionLogStore.logUri(workflowId, eid, None).toString.stripSuffix("/executionlog"),
      "file:///tmp/elsewhere",
      ""
    )

    elsewhere.foreach { location =>
      val uri = writtenPlan(eid, Seq(Seq(locationOf(eid, port("join", 0)).toString, location)))
      withClue(s"'$location': ") {
        an[IllegalArgumentException] should be thrownBy ExecutionTables.portTables(uri)
      }
    }
  }

  it should "refuse a URI that is not a plan's, and a plan in another format version" in {
    val eid = freshExecution()
    an[IllegalArgumentException] should be thrownBy
      ExecutionTables.portTables(ExecutionLogStore.logUri(workflowId, eid, None))

    val uri = ExecutionPlanStore.planUri(workflowId, eid, None)
    ExecutionPlanStore.writePlan(
      uri,
      PlanRecord(ExecutionPlanStore.PlanEntryId, """{"formatVersion":2}""", 1, 3),
      "{}"
    )
    an[IllegalArgumentException] should be thrownBy ExecutionTables.portTables(uri)
  }

  it should "throw, not list nothing, when the catalog cannot answer" in {
    val eid = freshExecution()
    val uri = writtenPlan(eid, Seq(Seq(locationOf(eid, port("scan", 0)).toString)))

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.portTables(uri)
    }
  }

  "ExecutionTables.storedBytes" should "count nothing for a table that is not there, or that nothing was written to" in {
    val eid = freshExecution()
    val log = ExecutionLogStore.logUri(workflowId, eid, None)

    ExecutionTables.storedBytes(log) shouldBe 0L
    // Made, with its beat, and no row: the table has no snapshot.
    ExecutionLogStore.create(log, 1794873600000L, 30000L)
    ExecutionTables.storedBytes(log) shouldBe 0L
    // A port's tables, in namespaces nothing was ever written to.
    ExecutionTables.storedBytes(
      VFSURIFactory.resultURI(locationOf(eid, port("scan", 0)))
    ) shouldBe 0L
  }

  it should "count the bytes of a table's data files, more with each append" in {
    val eid = freshExecution()
    val statistics = RuntimeStatisticsStore.statisticsUri(workflowId, eid, None)
    RuntimeStatisticsStore.create(statistics)

    RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan")))
    val afterOne = ExecutionTables.storedBytes(statistics)
    afterOne should be > 0L

    RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan"), statisticsRow("join")))
    ExecutionTables.storedBytes(statistics) should be > afterOne
  }

  it should "count a written plan, in the warehouse its URI names" in {
    val eid = freshExecution()
    val uri = writtenPlan(eid, Seq(Seq.empty), Some(warehouse))

    ExecutionTables.storedBytes(uri) should be > 0L
  }

  it should "throw, not count nothing, when the catalog cannot answer" in {
    val log = ExecutionLogStore.logUri(workflowId, freshExecution(), None)
    ExecutionLogStore.create(log, 1794873600000L, 30000L)

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.storedBytes(log)
    }
  }
}
