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

import org.apache.iceberg.catalog.{Namespace, TableIdentifier}
import org.apache.iceberg.exceptions.{
  NoSuchNamespaceException,
  NotFoundException,
  ServiceUnavailableException
}
import org.apache.iceberg.io.FileIO
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.apache.texera.amber.util.IcebergUtil
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.concurrent.atomic.AtomicLong
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Specs for [[ExecutionTables]] on Iceberg's JDBC catalog (see [[EmbeddedJdbcCatalog]]): the
  * tables it finds, measures and drops are real ones.
  */
@NonParallelTest
class ExecutionTablesSpec extends AnyFlatSpec with Matchers with EmbeddedJdbcCatalog {

  /** Every kind of table an execution has. */
  private val EveryKind: Seq[VFSResourceType.Value] =
    ExecutionTables.ProducedKinds ++
      Seq(VFSResourceType.RUNTIME_STATISTICS, VFSResourceType.EXECUTION_LOG)

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

  private def namespaceOf(eid: ExecutionIdentity): Namespace =
    Namespace.of(ExecutionNamespace.of(eid.id))

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
    // Each is a table's URI: of a result, or of a state.
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
    val eid = freshExecution()
    ExecutionTables.portTables(workflowId, eid, None) shouldBe Nil
    withNamespace(ConsoleMessageStore.consoleUri(workflowId, eid, None))
    ExecutionTables.portTables(workflowId, eid, None) shouldBe Nil
  }

  it should "leave out a table whose name starts as the execution's but gives no port's URI back" in {
    val eid = freshExecution()
    val stored = portTablesMade(locationOf(eid, port("scan", 0)))
    val notAPort =
      TableIdentifier.of(namespaceOf(eid), s"wid_${workflowId.id}_eid_${eid.id}_not_a_port")
    IcebergUtil.createTable(
      IcebergCatalogInstance.getInstance(None),
      ExecutionNamespace.of(eid.id),
      notAPort.name(),
      IcebergUtil.toIcebergSchema(Schema().add("line", AttributeType.STRING)),
      overrideIfExists = true
    )

    ExecutionTables.portTables(workflowId, eid, None) should contain theSameElementsAs stored
    IcebergCatalogInstance.getInstance(None).tableExists(notAPort) shouldBe true
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

  "ExecutionTables.storedBytes" should "count nothing for a table that is not there, or that nothing was written to" in {
    val eid = freshExecution()
    val log = ExecutionLogStore.logUri(workflowId, eid, None)

    ExecutionTables.storedBytes(log) shouldBe 0L
    // Made, with its beat, and no row: the table has no snapshot.
    ExecutionLogStore.create(withNamespace(log), 1794873600000L, 30000L)
    ExecutionTables.storedBytes(log) shouldBe 0L
    // A port's tables, which nothing ever made.
    ExecutionTables.storedBytes(
      VFSURIFactory.resultURI(locationOf(eid, port("scan", 0)))
    ) shouldBe 0L
  }

  it should "count the bytes of a table's data files, more with each append" in {
    val eid = freshExecution()
    val statistics = withNamespace(RuntimeStatisticsStore.statisticsUri(workflowId, eid, None))
    RuntimeStatisticsStore.create(statistics)

    RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan")))
    val afterOne = ExecutionTables.storedBytes(statistics)
    afterOne should be > 0L

    RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan"), statisticsRow("join")))
    ExecutionTables.storedBytes(statistics) should be > afterOne
  }

  it should "count a written table in the warehouse its URI names" in {
    val statistics = withNamespace(
      RuntimeStatisticsStore.statisticsUri(workflowId, freshExecution(), Some(warehouse))
    )
    RuntimeStatisticsStore.create(statistics)
    RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan")))

    ExecutionTables.storedBytes(statistics) should be > 0L
  }

  it should "throw, not count nothing, when the catalog cannot answer" in {
    val log = withNamespace(ExecutionLogStore.logUri(workflowId, freshExecution(), None))
    ExecutionLogStore.create(log, 1794873600000L, 30000L)

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.storedBytes(log)
    }
  }

  /** Makes the table at each of `uris` in its execution's namespace, as a run's writers do. */
  private def made(uris: URI*): Seq[URI] = {
    uris.foreach(uri =>
      DocumentFactory.createDocument(withNamespace(uri), Schema().add("line", AttributeType.STRING))
    )
    uris
  }

  /** A table of execution `eid`, of workflow `wid`, that no function of today's names. */
  private def odd(eid: ExecutionIdentity, rest: String, wid: WorkflowIdentity = workflowId): URI =
    new URI(s"vfs:///wid/${wid.id}/eid/${eid.id}/$rest")

  "A table of an execution" should "be in the execution's namespace, and in no other" in {
    val eid = freshExecution()
    val base = locationOf(eid, port("scan", 0))
    val tables = made(
      VFSURIFactory.resultURI(base),
      VFSURIFactory.stateURI(base),
      ConsoleMessageStore.consoleUri(workflowId, eid, None),
      RuntimeStatisticsStore.statisticsUri(workflowId, eid, None),
      ExecutionLogStore.logUri(workflowId, eid, None)
    )

    jdbcCatalog.listTables(namespaceOf(eid)).asScala.map(_.name()) should contain theSameElementsAs
      tables.map(_.getPath.stripPrefix("/").replace('/', '_'))
    DocumentFactory.icebergTableOf(tables.head).get.name() should endWith(
      s"execution-${eid.id}.wid_12_eid_${eid.id}_globalportid_" +
        "(logicalOpId=scan,layerName=main,portId=0,isInternal=false,isInput=false)_result"
    )
  }

  it should "not be made where its execution has no namespace, which none of them makes" in {
    // The catalog refuses a table in a namespace that is not there, as Lakekeeper does, and a
    // computing unit's token can make no namespace.
    val eid = freshExecution()
    val base = locationOf(eid, port("scan", 0))
    Seq(
      VFSURIFactory.resultURI(base),
      VFSURIFactory.stateURI(base),
      ConsoleMessageStore.consoleUri(workflowId, eid, None),
      RuntimeStatisticsStore.statisticsUri(workflowId, eid, None),
      ExecutionLogStore.logUri(workflowId, eid, None)
    ).foreach { uri =>
      withClue(s"$uri: ") {
        a[NoSuchNamespaceException] should be thrownBy
          DocumentFactory.createDocument(uri, Schema().add("line", AttributeType.STRING))
      }
    }
    jdbcCatalog.namespaceExists(namespaceOf(eid)) shouldBe false
  }

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

    ExecutionTables.dropNamed(workflowId, eid, None, EveryKind) should
      contain theSameElementsAs Seq("wid_12_eid_3_runtimestatistics", "wid_12_eid_3_executionlog")
    Seq(statistics, log).foreach(uri =>
      withClue(s"$uri: ") {
        ExecutionTables.exists(uri) shouldBe false
      }
    )
    // The namespace stays, with the tables of workflow 120's execution 3.
    jdbcCatalog.namespaceExists(namespaceOf(eid)) shouldBe true
  }

  it should "drop nothing for an execution that has no table" in {
    val eid = freshExecution()
    ExecutionTables.dropNamed(workflowId, eid, Some(warehouse), EveryKind) shouldBe
      Nil
    withNamespace(ConsoleMessageStore.consoleUri(workflowId, eid, Some(warehouse)))
    ExecutionTables.dropNamed(workflowId, eid, Some(warehouse), EveryKind) shouldBe
      Nil
  }

  it should "leave a table of the execution that is of none of the kinds" in {
    val eid = freshExecution()
    val result = made(VFSURIFactory.resultURI(locationOf(eid, port("scan", 0)))).head
    val notAPort = s"wid_${workflowId.id}_eid_${eid.id}_not_a_port"
    IcebergUtil.createTable(
      IcebergCatalogInstance.getInstance(None),
      ExecutionNamespace.of(eid.id),
      notAPort,
      IcebergUtil.toIcebergSchema(Schema().add("line", AttributeType.STRING)),
      overrideIfExists = true
    )

    ExecutionTables.dropNamed(workflowId, eid, None, EveryKind) shouldBe
      Seq(result.getPath.stripPrefix("/").replace('/', '_'))
    jdbcCatalog.tableExists(TableIdentifier.of(namespaceOf(eid), notAPort)) shouldBe true
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

  /** The data files of the table at `uri`. */
  private def dataFilesOf(uri: URI): Seq[String] =
    Using.resource(DocumentFactory.icebergTableOf(uri).get.newScan().planFiles()) {
      _.asScala.map(_.file().location()).toSeq
    }

  /** Whether `io` holds a file at `location`; a FileIO may say it does not by refusing it. */
  private def holds(io: FileIO, location: String): Boolean =
    try io.newInputFile(location).exists()
    catch { case _: NotFoundException => false }

  "ExecutionTables.dropNamespace" should
    "drop the namespace with every table in it, data files and all, and no other's" in {
    Seq(None, Some(warehouse)).foreach { warehouse =>
      val eid = freshExecution()
      val base = locationOf(eid, port("scan", 0), warehouse)
      val statistics = RuntimeStatisticsStore.statisticsUri(workflowId, eid, warehouse)
      RuntimeStatisticsStore.create(withNamespace(statistics))
      RuntimeStatisticsStore.append(statistics, Seq(statisticsRow("scan")))
      val io = DocumentFactory.icebergTableOf(statistics).get.io()
      val dataFiles = dataFilesOf(statistics)
      dataFiles should not be empty
      all(dataFiles.map(holds(io, _))) shouldBe true
      val tables = statistics +: made(
        VFSURIFactory.resultURI(base),
        VFSURIFactory.stateURI(base),
        ConsoleMessageStore.consoleUri(workflowId, eid, warehouse),
        ExecutionLogStore.logUri(workflowId, eid, warehouse),
        // A table no function of today's names.
        VFSURIFactory.uriOfPath(s"wid/12/eid/${eid.id}/opid/scan/consolemessages", warehouse)
      )
      // Another execution's.
      val other = made(
        ConsoleMessageStore.consoleUri(workflowId, ExecutionIdentity(eid.id + 1000), warehouse)
      ).head

      withClue(s"in warehouse $warehouse: ") {
        ExecutionTables.dropNamespace(eid.id, warehouse) should contain theSameElementsAs
          tables.map(_.getPath.stripPrefix("/").replaceFirst("^wh/[^/]+/", "").replace('/', '_'))

        jdbcCatalog.namespaceExists(namespaceOf(eid)) shouldBe false
        tables.foreach(uri => withClue(s"$uri: ") { ExecutionTables.exists(uri) shouldBe false })
        dataFiles.foreach(file => withClue(s"$file: ") { holds(io, file) shouldBe false })
        ExecutionTables.exists(other) shouldBe true
      }
    }
  }

  it should "drop the namespace of an execution that has no table" in {
    val eid = freshExecution()
    withNamespace(ConsoleMessageStore.consoleUri(workflowId, eid, None))

    ExecutionTables.dropNamespace(eid.id, None) shouldBe Nil
    jdbcCatalog.namespaceExists(namespaceOf(eid)) shouldBe false
  }

  it should "do nothing for an execution that has no namespace" in {
    val eid = freshExecution()
    ExecutionTables.dropNamespace(eid.id, None) shouldBe Nil
    ExecutionTables.dropNamespace(eid.id, Some(warehouse)) shouldBe Nil
  }

  it should "throw, not drop nothing, when the catalog cannot answer" in {
    val eid = freshExecution()
    val result = made(VFSURIFactory.resultURI(locationOf(eid, port("scan", 0)))).head

    whileCatalogUnavailable {
      a[ServiceUnavailableException] should be thrownBy ExecutionTables.dropNamespace(eid.id, None)
    }
    ExecutionTables.exists(result) shouldBe true
  }
}
