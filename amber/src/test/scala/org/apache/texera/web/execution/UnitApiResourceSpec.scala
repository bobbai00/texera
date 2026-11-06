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
import javax.ws.rs.WebApplicationException

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
    UnitApiResource.statusOf(WorkflowAggregatedState.PAUSED) shouldBe "paused"
    UnitApiResource.statusOf(WorkflowAggregatedState.PAUSING) shouldBe "running"
    UnitApiResource.statusOf(WorkflowAggregatedState.RESUMING) shouldBe "running"
    UnitApiResource.isTerminal(WorkflowAggregatedState.PAUSED) shouldBe false
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

  "tableIdentifier" should "name a port's table as the catalog laid it out, else by its URI" in {
    import org.apache.texera.amber.core.storage.{ExecutionLayout, ExecutionLayouts, VFSURIFactory}
    import org.apache.texera.amber.core.virtualidentity.{
      ExecutionIdentity,
      OperatorIdentity,
      PhysicalOpIdentity,
      WorkflowIdentity
    }
    import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
    def result(execution: Long, op: String, port: Int = 0, internal: Boolean = false) = {
      val gp = GlobalPortIdentity(
        PhysicalOpIdentity(OperatorIdentity(op), "main"),
        PortIdentity(port, internal)
      )
      VFSURIFactory.resultURI(
        VFSURIFactory.createPortBaseURI(WorkflowIdentity(5), ExecutionIdentity(execution), gp)
      )
    }
    val eid = ExecutionIdentity(EngineIds.of(UUID.randomUUID().toString))
    val store = ResultStore(
      "texera",
      "e_abc",
      Some(List(OutputTable("avg", "output-0", "avg_output_0")))
    )
    ExecutionLayouts.register(eid, store.layout)
    UnitApiResource.tableIdentifier(eid, result(eid.id, "avg")) shouldBe "e_abc.avg_output_0"
    // Another port, an internal port and another execution keep their own URIs.
    UnitApiResource.tableIdentifier(eid, result(eid.id, "avg", port = 1)) should startWith("vfs:")
    UnitApiResource.tableIdentifier(eid, result(eid.id, "avg", internal = true)) should startWith(
      "vfs:"
    )
    val other = ExecutionIdentity(EngineIds.fresh())
    UnitApiResource.tableIdentifier(other, result(other.id, "avg")) should startWith("vfs:")
    ExecutionLayout("e_x", Map.empty).tableOf(
      GlobalPortIdentity(
        PhysicalOpIdentity(OperatorIdentity("avg"), "main"),
        PortIdentity(0, false)
      )
    ) shouldBe None
  }

  "a start request" should "name the warehouse the execution stores what it writes in" in {
    val request = objectMapper.readValue(
      """{"eid":"0b6f8a2e-52c1-4a52-9d55-0c6f6b2f9a10","workflow":{"rid":"w","vno":1},
        |"logicalPlan":{"operators":[],"links":[]},
        |"resultStore":{"warehouse":"w_0a1b2c3d","namespace":"e_abc",
        |"tables":[{"opid":"avg","port":"output-0","table":"avg_output_0"}]},
        |"reporting":{"lineageUrl":"http://catalog/lineage"},"actor":"p"}""".stripMargin,
      classOf[ExecutionStartRequest]
    )
    val store = request.resultStore.get
    UnitApiResource.warehouseNamed(store.warehouse) shouldBe Some("w_0a1b2c3d")
    store.layout.namespace shouldBe "e_abc"
  }

  "warehouseNamed" should "take a legal name as given, and none as the unit's default warehouse" in {
    UnitApiResource.warehouseNamed("texera") shouldBe Some("texera")
    UnitApiResource.warehouseNamed("w_0a1b2c3d") shouldBe Some("w_0a1b2c3d")
    UnitApiResource.warehouseNamed("") shouldBe None
    UnitApiResource.warehouseNamed(null) shouldBe None
  }

  it should "refuse a name the storage layer cannot carry, never using the default instead" in {
    Seq("a/b", "a%2Fb", "-lead", "sp ace", "../texera").foreach { bad =>
      withClue(s"'$bad': ") {
        val refused = intercept[WebApplicationException](UnitApiResource.warehouseNamed(bad))
        refused.getResponse.getStatus shouldBe 400
      }
    }
  }

  "result" should "read a recorded table from the warehouse the catalog names" in {
    import org.apache.iceberg.catalog.{Namespace, SupportsNamespaces, TableIdentifier}
    import org.apache.texera.amber.core.storage.model.BufferedItemWriter
    import org.apache.texera.amber.core.storage.{
      DocumentFactory,
      ExecutionLayout,
      ExecutionLayouts,
      IcebergCatalogInstance,
      VFSURIFactory
    }
    import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
    import org.apache.texera.amber.core.virtualidentity.{
      ExecutionIdentity,
      OperatorIdentity,
      PhysicalOpIdentity,
      WorkflowIdentity
    }
    import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
    import org.apache.texera.amber.util.IcebergUtil
    import org.apache.texera.common.config.StorageConfig

    import java.nio.file.{Files, Path}
    import java.util.Comparator
    import scala.util.Try

    // Only the REST catalog is scoped to a warehouse. Under it, each of the two names gets
    // a local catalog of its own, so a table in one is not in the other. The other catalog
    // types share one catalog whatever the name, and only the read itself is checked.
    val separate = StorageConfig.icebergCatalogType == "rest"
    val (home, elsewhere) = ("w_unitapispec_home", "w_unitapispec_elsewhere")
    if (separate) {
      Seq(home, elsewhere).foreach { name =>
        val directory = Files.createTempDirectory(name)
        // Best effort: the temp warehouse goes when the JVM does.
        sys.addShutdownHook {
          try Files
            .walk(directory)
            .sorted(Comparator.reverseOrder[Path]())
            .forEach((p: Path) => Files.deleteIfExists(p))
          catch { case _: Throwable => () }
        }
        IcebergCatalogInstance.replaceInstance(
          IcebergUtil.createHadoopCatalog(name, directory),
          Some(name)
        )
      }
    }

    // A finished execution as the catalog laid it out: a namespace of its own, the output
    // port's table under the name the catalog chose, in the warehouse it named.
    val eid = ExecutionIdentity(EngineIds.fresh())
    val namespace = "e_unitapispec"
    ExecutionLayouts.register(eid, ExecutionLayout(namespace, Map(("avg", 0) -> "avg_output_0")))
    try {
      val schema = new Schema(List(new Attribute("mean", AttributeType.INTEGER)))
      val writer = DocumentFactory
        .createDocument(
          VFSURIFactory.resultURI(
            VFSURIFactory.createPortBaseURI(
              WorkflowIdentity(5),
              eid,
              GlobalPortIdentity(
                PhysicalOpIdentity(OperatorIdentity("avg"), "main"),
                PortIdentity(0)
              ),
              Some(home)
            )
          ),
          schema
        )
        .writer("unit-api-spec")
        .asInstanceOf[BufferedItemWriter[Tuple]]
      writer.open()
      Seq(4, 2).foreach(v =>
        writer.putOne(Tuple.builder(schema).add("mean", AttributeType.INTEGER, v).build())
      )
      writer.close()

      // The unit no longer holds the execution: the catalog says where the table is.
      def read(warehouse: String): RowPage =
        new UnitApiResource().result(
          UUID.randomUUID().toString,
          "avg",
          "output-0",
          0,
          10,
          "avg_output_0",
          namespace,
          warehouse
        )

      val page = read(home)
      page.schema.map(_.attributeName) shouldBe List("mean")
      page.rows.map(_.map(_.asInt())) should contain theSameElementsAs List(List(4), List(2))
      page.total shouldBe Some(2)

      if (separate) {
        intercept[WebApplicationException](read(elsewhere)).getResponse.getStatus shouldBe 404
      }
      intercept[WebApplicationException](read("a/b")).getResponse.getStatus shouldBe 400
    } finally {
      // Leave nothing behind in a catalog that other suites and other runs share.
      val catalog = IcebergCatalogInstance.getInstance(Some(home))
      Try(catalog.dropTable(TableIdentifier.of(namespace, "avg_output_0")))
      catalog match {
        case namespaces: SupportsNamespaces =>
          Try(namespaces.dropNamespace(Namespace.of(namespace)))
        case _ =>
      }
    }
  }

  "rowsOf" should "cut a long string for a table's cell, and serve a visualization's page whole" in {
    import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}

    val long = "x" * 5000
    // An ordinary result: a cell shows the start of a long string.
    val table = new Schema(
      List(new Attribute("note", AttributeType.STRING), new Attribute("n", AttributeType.INTEGER))
    )
    val row = Tuple
      .builder(table)
      .add("note", AttributeType.STRING, long)
      .add("n", AttributeType.INTEGER, 7)
      .build()
    val cells = UnitApiResource.rowsOf(List(row), table.getAttributes).head
    cells.head.asText() should have length 103
    cells.head.asText() should endWith("...")
    cells(1).asInt() shouldBe 7

    // What a visualization operator draws: one column holding the page. Cut, it is no page.
    val drawn = new Schema(List(new Attribute("html-content", AttributeType.STRING)))
    val page = Tuple.builder(drawn).add("html-content", AttributeType.STRING, long).build()
    UnitApiResource.isVisualization(drawn.getAttributes) shouldBe true
    UnitApiResource.rowsOf(List(page), drawn.getAttributes).head.head.asText() shouldBe long

    // A column of that name among others is a column like any other.
    val mixed = new Schema(
      List(
        new Attribute("html-content", AttributeType.STRING),
        new Attribute("n", AttributeType.INTEGER)
      )
    )
    UnitApiResource.isVisualization(mixed.getAttributes) shouldBe false
    UnitApiResource.isVisualization(table.getAttributes) shouldBe false
  }

  "EnvironmentManager.nameOf" should "make a filesystem-safe, version-specific name" in {
    val name = EnvironmentManager.nameOf("e6325d76-7bcf-442c-b926-1c9175ae42d8", 3)
    name shouldBe "env-e6325d767bcf442cb9261c9175ae42d8-v3"
    EnvironmentManager.getPythonBin("../escape") shouldBe None
  }
}
