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

import org.apache.iceberg.catalog.TableIdentifier
import org.apache.iceberg.exceptions.ServiceUnavailableException
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.OutputPort.OutputMode
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.amber.util.IcebergUtil
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.concurrent.atomic.AtomicLong

/**
  * Specs for [[ExecutionTables]] on Iceberg's JDBC catalog (see [[EmbeddedJdbcCatalog]]): the
  * tables it finds, measures and drops are real ones.
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

  private def statisticsRow(operator: String): RuntimeStatisticsRow =
    RuntimeStatisticsRow(operator, 1794873600000L, 1, 2, 3, 4, 5, 6, 7, 1, 1)

  "ExecutionTables.ownTables" should "name the log, the statistics and the console of an execution" in {
    val eid = ExecutionIdentity(34)

    ExecutionTables.ownTables(workflowId, eid, None).map(_.toString) shouldBe Seq(
      "vfs:///wid/12/eid/34/executionlog",
      "vfs:///wid/12/eid/34/runtimestatistics",
      "vfs:///wid/12/eid/34/consolemessages"
    )
    ExecutionTables.ownTables(workflowId, eid, Some(warehouse)).map(_.toString) shouldBe Seq(
      s"vfs:///wh/$warehouse/wid/12/eid/34/executionlog",
      s"vfs:///wh/$warehouse/wid/12/eid/34/runtimestatistics",
      s"vfs:///wh/$warehouse/wid/12/eid/34/consolemessages"
    )
  }

  /** The result and the state table of each of `ports`, made as a run's writers make them. */
  private def portTablesMade(ports: URI*): Seq[URI] =
    made(
      ports.flatMap(base => Seq(VFSURIFactory.resultURI(base), VFSURIFactory.stateURI(base))): _*
    )

  "ExecutionTables.portTables" should "find the result and the state table of every output port the execution stored, by their names" in {
    val eid = freshExecution()
    val stored = portTablesMade(
      locationOf(eid, port("scan", 0)),
      locationOf(eid, port("join", 0)),
      locationOf(eid, port("join", 1))
    )
    // Another execution's, another workflow's, and this execution's own tables of other kinds.
    portTablesMade(
      locationOf(ExecutionIdentity(eid.id + 1000), port("scan", 0)),
      locationOf(eid, port("scan", 0), wid = WorkflowIdentity(13))
    )
    made(ConsoleMessageStore.consoleUri(workflowId, eid, None))

    val found = ExecutionTables.portTables(workflowId, eid, None)
    found should contain theSameElementsAs stored
    // Each is a table's URI: of the result namespace, or of the state namespace.
    found.map(VFSURIFactory.decodeURI(_).resourceType).distinct should contain theSameElementsAs
      Seq(VFSResourceType.RESULT, VFSResourceType.STATE)
  }

  it should "find the tables of an execution in a warehouse in that warehouse" in {
    val eid = freshExecution()
    val stored = portTablesMade(locationOf(eid, port("scan", 0), Some(warehouse)))

    ExecutionTables.portTables(workflowId, eid, Some(warehouse)) should contain theSameElementsAs
      stored
  }

  it should "keep execution 3 apart from execution 34" in {
    val wid = WorkflowIdentity(99)
    val three = portTablesMade(locationOf(ExecutionIdentity(3), port("scan", 0), wid = wid))
    val thirtyFour = portTablesMade(locationOf(ExecutionIdentity(34), port("scan", 0), wid = wid))

    ExecutionTables.portTables(wid, ExecutionIdentity(3), None) should contain theSameElementsAs
      three
    ExecutionTables.portTables(wid, ExecutionIdentity(34), None) should contain theSameElementsAs
      thirtyFour
  }

  it should "find nothing for an execution that stored no port" in {
    ExecutionTables.portTables(workflowId, freshExecution(), None) shouldBe Nil
  }

  it should "leave out a table whose name starts as the execution's but gives no port's URI back" in {
    val eid = freshExecution()
    val stored = portTablesMade(locationOf(eid, port("scan", 0)))
    IcebergUtil.createTable(
      IcebergCatalogInstance.getInstance(None),
      StorageConfig.icebergTableResultNamespace,
      s"wid_${workflowId.id}_eid_${eid.id}_not_a_port",
      IcebergUtil.toIcebergSchema(Schema().add("line", AttributeType.STRING)),
      overrideIfExists = true
    )

    ExecutionTables.portTables(workflowId, eid, None) should contain theSameElementsAs stored
    IcebergCatalogInstance
      .getInstance(None)
      .tableExists(
        TableIdentifier.of(
          StorageConfig.icebergTableResultNamespace,
          s"wid_${workflowId.id}_eid_${eid.id}_not_a_port"
        )
      ) shouldBe true
  }

  it should "throw, not find nothing, when the catalog cannot answer" in {
    val eid = freshExecution()
    portTablesMade(locationOf(eid, port("scan", 0)))

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy
        ExecutionTables.portTables(workflowId, eid, None)
    }
  }

  /** A port of one of the physical operators `layer` of logical operator `operator`. */
  private def portOf(
      operator: String,
      layer: String,
      number: Int,
      internal: Boolean = false
  ): GlobalPortIdentity =
    GlobalPortIdentity(
      PhysicalOpIdentity(OperatorIdentity(operator), layer),
      PortIdentity(number, internal)
    )

  "ExecutionTables.isOutputOf" should "take an external port of any physical operator of the logical operator, by its number" in {
    val aggregate = OperatorIdentity("aggregate")

    ExecutionTables.isOutputOf(
      portOf("aggregate", "globalAgg", 0),
      aggregate,
      PortIdentity()
    ) shouldBe true
    ExecutionTables.isOutputOf(
      portOf("aggregate", "main", 1),
      aggregate,
      PortIdentity(1)
    ) shouldBe true
    // The port between the operator's own physical operators is not one its users see.
    ExecutionTables.isOutputOf(
      portOf("aggregate", "localAgg", 0, internal = true),
      aggregate,
      PortIdentity()
    ) shouldBe false
    ExecutionTables.isOutputOf(
      portOf("aggregate", "globalAgg", 1),
      aggregate,
      PortIdentity()
    ) shouldBe false
    ExecutionTables.isOutputOf(
      portOf("aggregate-2", "globalAgg", 0),
      aggregate,
      PortIdentity()
    ) shouldBe false
  }

  "ExecutionTables.resultTableAmong" should "find the result, not the state, of a logical operator's external port among a plan's port tables" in {
    val eid = freshExecution()
    val internal = locationOf(eid, portOf("aggregate", "localAgg", 0, internal = true))
    val external = locationOf(eid, portOf("aggregate", "globalAgg", 0))
    val scan = locationOf(eid, port("scan", 0))
    val tables = {
      portTablesMade(scan, internal, external)
      ExecutionTables.portTables(workflowId, eid, None)
    }

    ExecutionTables.resultTableAmong(tables, OperatorIdentity("aggregate"), PortIdentity()) shouldBe
      Some(VFSURIFactory.resultURI(external))
    ExecutionTables.resultTableAmong(tables, OperatorIdentity("scan"), PortIdentity()) shouldBe
      Some(VFSURIFactory.resultURI(scan))
    ExecutionTables.resultTableAmong(
      tables,
      OperatorIdentity("scan"),
      PortIdentity(1)
    ) shouldBe None
    ExecutionTables.resultTableAmong(tables, OperatorIdentity("join"), PortIdentity()) shouldBe None
    ExecutionTables.resultTableAmong(Nil, OperatorIdentity("scan"), PortIdentity()) shouldBe None
    // A state table alone is no result.
    ExecutionTables.resultTableAmong(
      Seq(VFSURIFactory.stateURI(scan)),
      OperatorIdentity("scan"),
      PortIdentity()
    ) shouldBe None
  }

  it should "refuse a URI that is no table of an execution" in {
    an[IllegalArgumentException] should be thrownBy ExecutionTables.resultTableAmong(
      Seq(new URI("mock:///not-a-vfs-uri")),
      OperatorIdentity("scan"),
      PortIdentity()
    )
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

  it should "count a written table in the warehouse its URI names" in {
    val statistics =
      RuntimeStatisticsStore.statisticsUri(workflowId, freshExecution(), Some(warehouse))
    RuntimeStatisticsStore.create(statistics)
    RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan")))

    ExecutionTables.storedBytes(statistics) should be > 0L
  }

  it should "throw, not count nothing, when the catalog cannot answer" in {
    val log = ExecutionLogStore.logUri(workflowId, freshExecution(), None)
    ExecutionLogStore.create(log, 1794873600000L, 30000L)

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.storedBytes(log)
    }
  }

  "ExecutionTables.outputModeOf" should "read the output mode each result table was made with" in {
    val eid = freshExecution()
    OutputMode.values.foreach { mode =>
      val result = VFSURIFactory.resultURI(locationOf(eid, port(s"op${mode.value}", 0)))
      DocumentFactory.createDocument(
        result,
        Schema().add("line", AttributeType.STRING),
        ExecutionTables.resultTableProperties(mode)
      )

      withClue(s"$mode: ") { ExecutionTables.outputModeOf(result) shouldBe Some(mode) }
    }
  }

  it should "read none of a table made without one, one that names no mode, and no table" in {
    val eid = freshExecution()
    val Seq(plain, odd, absent) = Seq("plain", "odd", "absent").map(name =>
      VFSURIFactory.resultURI(locationOf(eid, port(name, 0)))
    )
    made(plain)
    DocumentFactory.createDocument(
      odd,
      Schema().add("line", AttributeType.STRING),
      Map(ExecutionTables.OutputModeProperty -> "NOT_A_MODE")
    )

    Seq(plain, odd, absent).foreach { uri =>
      withClue(s"$uri: ") { ExecutionTables.outputModeOf(uri) shouldBe None }
    }
  }

  /** Makes the table at each of `uris`, as a run's writers do. */
  private def made(uris: URI*): Seq[URI] = {
    uris.foreach(DocumentFactory.createDocument(_, Schema().add("line", AttributeType.STRING)))
    uris
  }

  /** A table of execution `eid`, of workflow `wid`, that no function of today's names. */
  private def odd(eid: ExecutionIdentity, rest: String, wid: WorkflowIdentity = workflowId): URI =
    new URI(s"vfs:///wid/${wid.id}/eid/${eid.id}/$rest")

  "ExecutionTables.exists and drop" should "tell and drop the table at a URI, and answer false where there is none" in {
    val eid = freshExecution()
    val result = VFSURIFactory.resultURI(locationOf(eid, port("scan", 0)))
    val state = VFSURIFactory.stateURI(locationOf(eid, port("scan", 0)))

    ExecutionTables.exists(result) shouldBe false
    ExecutionTables.drop(result) shouldBe false

    made(result, state)
    ExecutionTables.exists(result) shouldBe true
    ExecutionTables.drop(result) shouldBe true
    ExecutionTables.exists(result) shouldBe false
    // The port's other table is another table.
    ExecutionTables.exists(state) shouldBe true
    ExecutionTables.drop(result) shouldBe false
  }

  it should "throw, not answer false, when the catalog cannot answer" in {
    val result = made(VFSURIFactory.resultURI(locationOf(freshExecution(), port("scan", 0)))).head

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.exists(result)
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.drop(result)
    }
    ExecutionTables.exists(result) shouldBe true
  }

  "ExecutionTables.dropNamed" should "drop the execution's tables of the kinds asked for, whatever names them, and no other's" in {
    val eid = ExecutionIdentity(3)
    val base = locationOf(eid, port("scan", 0))
    val (result, state) = (VFSURIFactory.resultURI(base), VFSURIFactory.stateURI(base))
    val console = ConsoleMessageStore.consoleUri(workflowId, eid, None)
    // One console table per operator, as executions once kept them.
    val operatorConsole = odd(eid, "opid/scan/consolemessages")
    val statistics = RuntimeStatisticsStore.statisticsUri(workflowId, eid, None)
    val log = ExecutionLogStore.logUri(workflowId, eid, None)
    made(result, state, console, operatorConsole, statistics, log)
    // Execution 34's, whose names start as execution 3's do up to the id; and execution 3 of
    // workflow 120, whose names end as those of execution 3 of workflow 12 do.
    val others = made(
      VFSURIFactory.resultURI(locationOf(ExecutionIdentity(34), port("scan", 0))),
      ConsoleMessageStore.consoleUri(workflowId, ExecutionIdentity(34), None),
      VFSURIFactory.resultURI(locationOf(eid, port("scan", 0), wid = WorkflowIdentity(120))),
      ConsoleMessageStore.consoleUri(WorkflowIdentity(120), eid, None)
    )

    val dropped = ExecutionTables.dropNamed(workflowId, eid, None, ExecutionTables.ProducedKinds)

    dropped should have size 4
    all(dropped) should startWith("wid_12_eid_3_")
    dropped should contain allOf (
      "wid_12_eid_3_consolemessages",
      "wid_12_eid_3_opid_scan_consolemessages"
    )
    Seq(result, state, console, operatorConsole).foreach { uri =>
      withClue(s"$uri: ") { ExecutionTables.exists(uri) shouldBe false }
    }
    // Not of the kinds asked for.
    Seq(statistics, log).foreach(uri =>
      withClue(s"$uri: ") {
        ExecutionTables.exists(uri) shouldBe true
      }
    )
    others.foreach(uri => withClue(s"$uri: ") { ExecutionTables.exists(uri) shouldBe true })
    // A second time there is nothing left to find.
    ExecutionTables.dropNamed(workflowId, eid, None, ExecutionTables.ProducedKinds) shouldBe Nil

    ExecutionTables.dropNamed(workflowId, eid, None, ExecutionTables.AllKinds) should
      contain theSameElementsAs Seq("wid_12_eid_3_runtimestatistics", "wid_12_eid_3_executionlog")
    Seq(statistics, log).foreach(uri =>
      withClue(s"$uri: ") {
        ExecutionTables.exists(uri) shouldBe false
      }
    )
  }

  it should "drop nothing for an execution that has no table" in {
    ExecutionTables.dropNamed(
      workflowId,
      freshExecution(),
      Some(warehouse),
      ExecutionTables.AllKinds
    ) shouldBe Nil
  }

  it should "throw, not drop nothing, when the catalog cannot answer" in {
    val eid = freshExecution()
    val result = made(VFSURIFactory.resultURI(locationOf(eid, port("scan", 0)))).head

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy
        ExecutionTables.dropNamed(workflowId, eid, None, ExecutionTables.ProducedKinds)
    }
    ExecutionTables.exists(result) shouldBe true
  }
}
