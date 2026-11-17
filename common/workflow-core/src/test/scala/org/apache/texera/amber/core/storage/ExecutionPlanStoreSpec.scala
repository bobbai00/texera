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

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres
import org.apache.iceberg.catalog.{Catalog, Namespace, TableIdentifier}
import org.apache.iceberg.exceptions.{CommitFailedException, ServiceUnavailableException}
import org.apache.iceberg.inmemory.InMemoryFileIO
import org.apache.iceberg.jdbc.JdbcCatalog
import org.apache.iceberg.{CatalogProperties, Table}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.result.ResultSchema
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.{Callable, CyclicBarrier, Executors, TimeUnit}
import scala.jdk.CollectionConverters._
import scala.util.{Success, Try}

/**
  * Specs for [[ExecutionPlanStore]] on Iceberg's JDBC catalog, the catalog Texera uses when it
  * does not run Lakekeeper, over an embedded Postgres of the spec's own: it needs no database
  * server and leaves nothing behind. Data and metadata files are kept in memory, since what the
  * store relies on (a commit that refuses a second `started` tag) is the catalog's doing, not the
  * file system's.
  *
  * Tagged [[NonParallelTest]] so `common/workflow-core/build.sbt` gives this suite its own forked
  * JVM. That is load-bearing: `beforeAll` installs this catalog into the JVM-wide
  * `IcebergCatalogInstance`, where the module's other suites install a local Hadoop catalog.
  */
@NonParallelTest
class ExecutionPlanStoreSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll {

  private val warehouse = "user-1-7"
  private val workflowId = WorkflowIdentity(12)

  private var postgres: EmbeddedPostgres = _
  private var catalog: JdbcCatalog = _

  override def beforeAll(): Unit = {
    super.beforeAll()
    // Loaded explicitly, as IcebergUtil.createPostgresCatalog does, for the same flaky lookup.
    Class.forName("org.postgresql.Driver")
    postgres = EmbeddedPostgres.builder().start()
    catalog = new JdbcCatalog()
    catalog.initialize(
      "execution_plan_store_spec",
      Map(
        CatalogProperties.WAREHOUSE_LOCATION -> "memory://execution-plan-store-spec",
        CatalogProperties.FILE_IO_IMPL -> classOf[InMemoryFileIO].getName,
        CatalogProperties.URI -> postgres.getJdbcUrl("postgres", "postgres"),
        JdbcCatalog.PROPERTY_PREFIX + "user" -> "postgres",
        JdbcCatalog.PROPERTY_PREFIX + "password" -> ""
      ).asJava
    )
    // The default warehouse and the one the warehouse-scoped URIs name: two cache entries under
    // the REST catalog type, the one shared entry under the others.
    IcebergCatalogInstance.replaceInstance(catalog)
    IcebergCatalogInstance.replaceInstance(catalog, Some(warehouse))
  }

  override def afterAll(): Unit =
    try {
      Option(catalog).foreach(_.close())
      Option(postgres).foreach(_.close())
    } finally super.afterAll()

  /** A catalog that fails every call, the way a REST catalog that cannot answer does. */
  private object UnavailableCatalog extends Catalog {
    private def unavailable(): Nothing =
      throw new ServiceUnavailableException("the catalog is unavailable")
    override def listTables(namespace: Namespace): java.util.List[TableIdentifier] = unavailable()
    override def dropTable(identifier: TableIdentifier, purge: Boolean): Boolean = unavailable()
    override def renameTable(from: TableIdentifier, to: TableIdentifier): Unit = unavailable()
    override def loadTable(identifier: TableIdentifier): Table = unavailable()
  }

  /** Runs `body` with [[UnavailableCatalog]] in place of the spec's catalog, then restores it. */
  private def whileCatalogUnavailable(body: => Unit): Unit = {
    val warehouses = Seq(None, Some(warehouse))
    warehouses.foreach(IcebergCatalogInstance.replaceInstance(UnavailableCatalog, _))
    try body
    finally warehouses.foreach(IcebergCatalogInstance.replaceInstance(catalog, _))
  }

  // Executions below 100 are left to the specs that name one.
  private val nextExecutionId = new AtomicLong(100)

  private def freshPlanUri(warehouse: Option[String] = None): URI =
    ExecutionPlanStore.planUri(
      workflowId,
      ExecutionIdentity(nextExecutionId.getAndIncrement()),
      warehouse
    )

  private val logicalPlan =
    """{"operators":[],"links":[],"opsToViewResult":[],"opsToReuseResult":[]}"""

  private def planRow(
      body: String = """{"formatVersion":1,"operators":[]}""",
      notification: Option[String] = None
  ): PlanRecord =
    PlanRecord(
      entryId = ExecutionPlanStore.PlanEntryId,
      body = body,
      createdBy = 1,
      computingUnitId = 3,
      notification = notification
    )

  private def updateRow(updateId: String, code: String = "print(1)"): PlanRecord =
    PlanRecord(
      entryId = updateId,
      body = s"""{"updateId":"$updateId","code":"$code"}""",
      createdBy = 1,
      computingUnitId = 3,
      notification = None
    )

  /** A body of `bytes` bytes of UTF-8, with German, Japanese and an emoji (a surrogate pair). */
  private def bodyOf(bytes: Int): String = {
    val (start, end) = ("{\"note\":\"Grüße 日本語 😀\",\"padding\":\"", "\"}")
    val body = start + ("x" * (bytes - (start + end).getBytes(StandardCharsets.UTF_8).length)) + end
    body.getBytes(StandardCharsets.UTF_8).length shouldBe bytes
    body
  }

  /** The operator an update row's body was compiled from, as its row keeps it. */
  private def changedOperator(code: String = "print(1)"): String =
    s"""{"operatorID":"PythonUDFV2-operator-1","code":"$code"}"""

  private def appendUpdate(uri: URI, record: PlanRecord): Unit =
    ExecutionPlanStore.appendUpdate(uri, record, changedOperator())

  private val notification = Some(
    """{"email":"texera@example.com","workflowName":"Iris","workflowUrl":"http://localhost:4200/user/workspace/12"}"""
  )

  private def writtenPlan(warehouse: Option[String] = None): URI = {
    val uri = freshPlanUri(warehouse)
    ExecutionPlanStore.writePlan(uri, planRow(), logicalPlan)
    uri
  }

  /** Writes one row straight to a new plan table at `uri`, `column` left empty. */
  private def writeRowWithout(uri: URI, column: String): Unit = {
    val schema = ResultSchema.executionPlanSchema
    val fields: Array[Any] = Array("plan", "{}", logicalPlan, 1, 3, null)
    fields(schema.getIndex(column)) = null
    val writer = DocumentFactory
      .createDocument(uri, schema)
      .asInstanceOf[VirtualDocument[Tuple]]
      .writer("plan")
    writer.open()
    writer.putOne(Tuple(schema, fields))
    writer.close()
  }

  private def currentSnapshotId(uri: URI): Long =
    DocumentFactory.icebergTableOf(uri).get.currentSnapshot().snapshotId()

  private def startedTagSnapshotId(uri: URI): Long =
    DocumentFactory.icebergTableOf(uri).get.refs().get(ExecutionPlanStore.StartedTag).snapshotId()

  // ---------------------------------------------------------------------------
  // PlanRecord
  // ---------------------------------------------------------------------------

  "PlanRecord" should "need every value but the notification" in {
    an[IllegalArgumentException] should be thrownBy planRow().copy(entryId = null)
    an[IllegalArgumentException] should be thrownBy planRow(body = null)
    an[IllegalArgumentException] should be thrownBy planRow().copy(notification = null)
  }

  it should "leave its body out of its text" in {
    val record = planRow(body = """{"password":"5ecr3t"}""", notification = notification)
    record.toString shouldBe "PlanRecord(plan, createdBy=1, computingUnitId=3)"
  }

  // ---------------------------------------------------------------------------
  // planUri
  // ---------------------------------------------------------------------------

  "planUri" should "name the execution's plan table, in its warehouse when it has one" in {
    ExecutionPlanStore.planUri(workflowId, ExecutionIdentity(345), None) shouldBe
      new URI("vfs:///wid/12/eid/345/plan")
    ExecutionPlanStore.planUri(workflowId, ExecutionIdentity(345), Some(warehouse)) shouldBe
      new URI(s"vfs:///wh/$warehouse/wid/12/eid/345/plan")
  }

  "planTableOf" should "give the workflow, execution and warehouse of a plan table's URI" in {
    Seq(None, Some(warehouse)).foreach { inWarehouse =>
      val uri = ExecutionPlanStore.planUri(workflowId, ExecutionIdentity(345), inWarehouse)
      val location = ExecutionPlanStore.planTableOf(uri).get
      (location.workflowId, location.executionId, location.warehouse) shouldBe
        ((workflowId, ExecutionIdentity(345), inWarehouse))
    }
  }

  it should "give nothing for any other URI" in {
    (notPlanUris :+ null).foreach { uri =>
      withClue(s"$uri: ") { ExecutionPlanStore.planTableOf(uri) shouldBe None }
    }
  }

  // ---------------------------------------------------------------------------
  // writePlan / readPlan
  // ---------------------------------------------------------------------------

  "writePlan and readPlan" should "keep the plan row, with and without a notification" in {
    Seq(planRow(), planRow(notification = notification)).foreach { record =>
      val uri = freshPlanUri()
      ExecutionPlanStore.writePlan(uri, record, logicalPlan)
      ExecutionPlanStore.readPlan(uri) shouldBe record
      ExecutionPlanStore.readPlanWithLogical(uri) shouldBe ((record, logicalPlan))
      ExecutionPlanStore.isStarted(uri) shouldBe false
    }
  }

  it should "keep a body of the most bytes a row may hold intact, text outside ASCII included" in {
    // A plan carrying a link to each of thousands of files runs to megabytes.
    val body = bodyOf(ExecutionPlanStore.MaxBodyBytes)
    val uri = freshPlanUri()
    ExecutionPlanStore.writePlan(uri, planRow(body = body), logicalPlan)
    ExecutionPlanStore.readPlan(uri).body shouldBe body
  }

  it should "read and write a plan whose URI names a warehouse, also when the URI comes as text" in {
    val uri = writtenPlan(Some(warehouse))
    uri.toString should startWith(s"vfs:///wh/$warehouse/wid/12/eid/")
    ExecutionPlanStore.readPlan(URI.create(uri.toString)) shouldBe planRow()
  }

  it should "replace a stale table at the same execution, with its rows and its tag" in {
    val uri = writtenPlan()
    appendUpdate(uri, updateRow("update-stale"))
    ExecutionPlanStore.claimStart(uri)

    val replacement = planRow(body = """{"formatVersion":1,"replacement":true}""")
    val replacementLogical = """{"operators":[],"links":[]}"""
    ExecutionPlanStore.writePlan(uri, replacement, replacementLogical)

    ExecutionPlanStore.readPlanWithLogical(uri) shouldBe ((replacement, replacementLogical))
    a[NoSuchUpdateException] should be thrownBy ExecutionPlanStore.readUpdate(uri, "update-stale")
    ExecutionPlanStore.isStarted(uri) shouldBe false
  }

  "writePlan" should "refuse a row that is not the plan row, or has no logical plan, and write nothing" in {
    val uri = freshPlanUri()
    Seq(updateRow("update-1"), planRow().copy(entryId = "plan-2")).foreach { record =>
      withClue(s"${record.entryId}: ") {
        an[IllegalArgumentException] should be thrownBy
          ExecutionPlanStore.writePlan(uri, record, logicalPlan)
      }
    }
    an[IllegalArgumentException] should be thrownBy
      ExecutionPlanStore.writePlan(uri, planRow(), null)
    DocumentFactory.documentExists(uri) shouldBe false
  }

  it should "refuse a body of one byte more than a row may hold, saying its size, and write nothing" in {
    val uri = freshPlanUri()
    val tooLarge = intercept[PlanTooLargeException] {
      ExecutionPlanStore.writePlan(
        uri,
        planRow(body = bodyOf(ExecutionPlanStore.MaxBodyBytes + 1)),
        logicalPlan
      )
    }
    tooLarge.bytes shouldBe ExecutionPlanStore.MaxBodyBytes + 1
    // Rounded up, so that a size refused never reads as the limit.
    tooLarge.getMessage shouldBe "The plan is 16.1 MiB, and a stored plan may be at most 16 MiB."
    DocumentFactory.documentExists(uri) shouldBe false
  }

  "readPlan" should "fail with NoStoredPlanException where there is no table" in {
    val uri = freshPlanUri()
    val thrown = intercept[NoStoredPlanException](ExecutionPlanStore.readPlan(uri))
    thrown.uri shouldBe uri
  }

  it should "fail with NoStoredPlanException when the table holds no plan row" in {
    val empty = freshPlanUri()
    DocumentFactory.createDocument(empty, ResultSchema.executionPlanSchema)
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(empty)
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlanWithLogical(empty)

    val updatesOnly = freshPlanUri()
    DocumentFactory.createDocument(updatesOnly, ResultSchema.executionPlanSchema)
    appendUpdate(updatesOnly, updateRow("update-1"))
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(updatesOnly)
  }

  it should "refuse a row without a value a record needs" in {
    // A missing number must not read as 0.
    Seq("body", "createdBy", "computingUnitId").foreach { column =>
      val uri = freshPlanUri()
      writeRowWithout(uri, column)
      withClue(s"$column: ") {
        val thrown = intercept[IllegalStateException](ExecutionPlanStore.readPlan(uri))
        thrown.getMessage shouldBe s"a plan table row has no $column"
      }
    }
  }

  it should "read the row without the logical plan, which only readPlanWithLogical needs" in {
    val uri = freshPlanUri()
    writeRowWithout(uri, "logical")

    ExecutionPlanStore.readPlan(uri) shouldBe planRow(body = "{}")
    val thrown = intercept[IllegalStateException](ExecutionPlanStore.readPlanWithLogical(uri))
    thrown.getMessage shouldBe "a plan table row has no logical"
  }

  // ---------------------------------------------------------------------------
  // appendUpdate / readUpdate
  // ---------------------------------------------------------------------------

  "appendUpdate and readUpdate" should "add update rows beside the plan row and read each back" in {
    val uri = writtenPlan()
    val first = updateRow("update-4f6c", code = "print(1)")
    val second = updateRow("update-9a1b", code = "print(2)")
    appendUpdate(uri, first)
    appendUpdate(uri, second)

    ExecutionPlanStore.readUpdate(uri, "update-4f6c") shouldBe first
    ExecutionPlanStore.readUpdate(uri, "update-9a1b") shouldBe second
    ExecutionPlanStore.readPlan(uri) shouldBe planRow()
  }

  "readUpdate" should "fail with NoSuchUpdateException for an update the table does not hold" in {
    val uri = writtenPlan()
    appendUpdate(uri, updateRow("update-1"))

    val thrown = intercept[NoSuchUpdateException](ExecutionPlanStore.readUpdate(uri, "update-2"))
    thrown.uri shouldBe uri
    thrown.updateId shouldBe "update-2"
    // The plan row is not an update.
    Seq(ExecutionPlanStore.PlanEntryId, "", "update-").foreach { updateId =>
      withClue(s"'$updateId': ") {
        a[NoSuchUpdateException] should be thrownBy ExecutionPlanStore.readUpdate(uri, updateId)
      }
    }
  }

  "appendUpdate" should "refuse a row that is not an update row, and append nothing" in {
    val uri = writtenPlan()
    val refused = Seq(
      planRow(),
      updateRow("plan"),
      updateRow("update-"),
      updateRow("4f6c"),
      // The entry id names the row's data file, so it must stay one plain file name.
      updateRow("update-a/b"),
      updateRow("update-.."),
      updateRow("update-/../../operator-port-result/wid_12_eid_1_result"),
      updateRow("update-4f6c 9a1b"),
      updateRow("update-日本"),
      updateRow("update-" + "a" * 65)
    )
    refused.foreach { record =>
      withClue(s"${record.entryId}: ") {
        an[IllegalArgumentException] should be thrownBy appendUpdate(uri, record)
      }
    }
    an[IllegalArgumentException] should be thrownBy
      ExecutionPlanStore.appendUpdate(uri, updateRow("update-1"), null)
    ExecutionPlanStore.readPlan(uri) shouldBe planRow()
    refused.map(_.entryId).distinct.foreach { entryId =>
      withClue(s"$entryId: ") {
        a[NoSuchUpdateException] should be thrownBy ExecutionPlanStore.readUpdate(uri, entryId)
      }
    }
  }

  it should "take the entry ids the Dashboard makes, and any of letters, digits and hyphens up to 64" in {
    val uri = writtenPlan()
    Seq(s"update-${UUID.randomUUID()}", "update-" + "a" * 64, "update-Z-9").foreach { entryId =>
      withClue(s"$entryId: ") {
        appendUpdate(uri, updateRow(entryId))
        ExecutionPlanStore.readUpdate(uri, entryId) shouldBe updateRow(entryId)
      }
    }
  }

  it should "refuse an entry id the table already holds, keeping the first row" in {
    val uri = writtenPlan()
    val first = updateRow("update-1", code = "print(1)")
    appendUpdate(uri, first)

    val thrown = intercept[IllegalArgumentException] {
      appendUpdate(uri, updateRow("update-1", code = "print(2)"))
    }
    thrown.getMessage should include("already holds update-1")
    ExecutionPlanStore.readUpdate(uri, "update-1") shouldBe first
  }

  it should "keep a body of the most bytes a row may hold, and refuse one byte more, appending nothing" in {
    val uri = writtenPlan()
    val largest = updateRow("update-1").copy(body = bodyOf(ExecutionPlanStore.MaxBodyBytes))
    appendUpdate(uri, largest)
    ExecutionPlanStore.readUpdate(uri, "update-1") shouldBe largest

    val tooLarge = intercept[PlanTooLargeException] {
      appendUpdate(
        uri,
        updateRow("update-2").copy(body = bodyOf(ExecutionPlanStore.MaxBodyBytes + 1))
      )
    }
    tooLarge.getMessage shouldBe
      "The change is 16.1 MiB, and a stored change may be at most 16 MiB."
    a[NoSuchUpdateException] should be thrownBy ExecutionPlanStore.readUpdate(uri, "update-2")
  }

  it should "fail with NoStoredPlanException where there is no table, and create none" in {
    val uri = freshPlanUri()
    a[NoStoredPlanException] should be thrownBy appendUpdate(uri, updateRow("update-1"))
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readUpdate(uri, "update-1")
    DocumentFactory.documentExists(uri) shouldBe false
  }

  // ---------------------------------------------------------------------------
  // claimStart / isStarted
  // ---------------------------------------------------------------------------

  "claimStart" should "tag the snapshot current at the claim, after which the execution reads as started" in {
    val uri = writtenPlan()
    val claimed = currentSnapshotId(uri)
    ExecutionPlanStore.isStarted(uri) shouldBe false

    ExecutionPlanStore.claimStart(uri)

    ExecutionPlanStore.isStarted(uri) shouldBe true
    startedTagSnapshotId(uri) shouldBe claimed

    // Updates still land after the claim, and the tag stays on the snapshot it marked.
    appendUpdate(uri, updateRow("update-1"))
    ExecutionPlanStore.readUpdate(uri, "update-1") shouldBe updateRow("update-1")
    currentSnapshotId(uri) should not be claimed
    startedTagSnapshotId(uri) shouldBe claimed
    ExecutionPlanStore.isStarted(uri) shouldBe true
  }

  it should "refuse a second claim" in {
    val uri = writtenPlan()
    val executionId = VFSURIFactory.decodeURI(uri).executionId
    ExecutionPlanStore.claimStart(uri)

    val thrown = intercept[ExecutionAlreadyStartedException](ExecutionPlanStore.claimStart(uri))
    thrown.executionId shouldBe executionId
    thrown.getMessage shouldBe s"execution ${executionId.id} was already started"
  }

  it should "refuse a claim that another claim beat to the commit" in {
    val uri = writtenPlan()
    // The other claim lands after this one made its tag, before this one commits it.
    var competing: Option[Try[Unit]] = None
    intercept[ExecutionAlreadyStartedException] {
      ExecutionPlanStore.claimStart(
        uri,
        beforeCommit =
          () => if (competing.isEmpty) competing = Some(Try(ExecutionPlanStore.claimStart(uri)))
      )
    }
    competing shouldBe Some(Success(()))
    ExecutionPlanStore.isStarted(uri) shouldBe true
  }

  it should "let exactly one of several claims racing on one execution win" in {
    val contenders = 8
    val pool = Executors.newFixedThreadPool(contenders)
    try {
      (1 to 5).foreach { round =>
        val uri = writtenPlan()
        val barrier = new CyclicBarrier(contenders)
        val outcomes = (1 to contenders)
          .map(_ =>
            pool.submit(new Callable[Try[Unit]] {
              override def call(): Try[Unit] = {
                barrier.await(30, TimeUnit.SECONDS)
                Try(ExecutionPlanStore.claimStart(uri))
              }
            })
          )
          .map(_.get(2, TimeUnit.MINUTES))
        withClue(s"round $round: ") {
          outcomes.count(_.isSuccess) shouldBe 1
          outcomes
            .flatMap(_.failed.toOption)
            .foreach(_ shouldBe an[ExecutionAlreadyStartedException])
          ExecutionPlanStore.isStarted(uri) shouldBe true
        }
      }
    } finally pool.shutdownNow()
  }

  it should "report a plan dropped while it was being claimed as missing" in {
    val uri = writtenPlan()
    a[NoStoredPlanException] should be thrownBy
      ExecutionPlanStore.claimStart(uri, beforeCommit = () => ExecutionPlanStore.drop(uri))
  }

  it should "claim on a fresh try when a commit that is not a claim landed first" in {
    val uri = writtenPlan()
    var attempts = 0
    // An update lands between the first try's tag and its commit, which fails though no claim
    // won. Iceberg re-applies a failed tag only on the state it was made on, so the store tries
    // again from the table as it now is.
    ExecutionPlanStore.claimStart(
      uri,
      beforeCommit = () => {
        attempts += 1
        if (attempts == 1) appendUpdate(uri, updateRow("update-1"))
      }
    )
    attempts shouldBe 2
    ExecutionPlanStore.isStarted(uri) shouldBe true
    // The tag is on the snapshot current when the claim committed, the one with the update.
    startedTagSnapshotId(uri) shouldBe currentSnapshotId(uri)
    ExecutionPlanStore.readUpdate(uri, "update-1") shouldBe updateRow("update-1")
  }

  it should "pass on the commit failure once the configured retries are spent" in {
    val uri = writtenPlan()
    var attempts = 0
    a[CommitFailedException] should be thrownBy ExecutionPlanStore.claimStart(
      uri,
      beforeCommit = () => {
        attempts += 1
        appendUpdate(uri, updateRow(s"update-$attempts"))
      }
    )
    attempts shouldBe 1 + StorageConfig.icebergTableCommitNumRetries
    ExecutionPlanStore.isStarted(uri) shouldBe false

    noException should be thrownBy ExecutionPlanStore.claimStart(uri)
    ExecutionPlanStore.isStarted(uri) shouldBe true
  }

  it should "fail with NoStoredPlanException where there is no table, or no snapshot to tag" in {
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.claimStart(freshPlanUri())

    val empty = freshPlanUri()
    DocumentFactory.createDocument(empty, ResultSchema.executionPlanSchema)
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.claimStart(empty)
    ExecutionPlanStore.isStarted(empty) shouldBe false
  }

  "isStarted" should "fail with NoStoredPlanException where there is no table" in {
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.isStarted(freshPlanUri())
  }

  // ---------------------------------------------------------------------------
  // drop
  // ---------------------------------------------------------------------------

  "drop" should "remove the table with its rows and its tag" in {
    val uri = writtenPlan()
    appendUpdate(uri, updateRow("update-1"))
    ExecutionPlanStore.claimStart(uri)

    ExecutionPlanStore.drop(uri)

    DocumentFactory.documentExists(uri) shouldBe false
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.readPlan(uri)
    a[NoStoredPlanException] should be thrownBy ExecutionPlanStore.isStarted(uri)
    // A plan written at the URI again starts out unclaimed.
    ExecutionPlanStore.writePlan(uri, planRow(), logicalPlan)
    ExecutionPlanStore.isStarted(uri) shouldBe false
    noException should be thrownBy ExecutionPlanStore.claimStart(uri)
  }

  it should "do nothing where there is no table" in {
    val uri = freshPlanUri()
    noException should be thrownBy ExecutionPlanStore.drop(uri)
    noException should be thrownBy ExecutionPlanStore.drop(uri)
    DocumentFactory.documentExists(uri) shouldBe false
  }

  // ---------------------------------------------------------------------------
  // a catalog that fails
  // ---------------------------------------------------------------------------

  "Reading, adding, claiming and dropping" should "pass on a catalog failure, not take it for a missing plan" in {
    val uri = writtenPlan(Some(warehouse))
    appendUpdate(uri, updateRow("update-1"))
    val operations: Seq[(String, () => Any)] = Seq(
      "readPlan" -> (() => ExecutionPlanStore.readPlan(uri)),
      "readPlanWithLogical" -> (() => ExecutionPlanStore.readPlanWithLogical(uri)),
      "appendUpdate" -> (() => appendUpdate(uri, updateRow("update-2"))),
      "readUpdate" -> (() => ExecutionPlanStore.readUpdate(uri, "update-1")),
      "claimStart" -> (() => ExecutionPlanStore.claimStart(uri)),
      "isStarted" -> (() => ExecutionPlanStore.isStarted(uri)),
      "drop" -> (() => ExecutionPlanStore.drop(uri)),
      // What the store is built on. This suite has a JVM of its own, so it is the place to swap
      // the catalog under DocumentFactory.
      "icebergTableOf" -> (() => DocumentFactory.icebergTableOf(uri)),
      "dropTable" -> (() => DocumentFactory.dropTable(uri))
    )
    whileCatalogUnavailable {
      operations.foreach {
        case (name, operation) =>
          withClue(s"$name: ") {
            a[ServiceUnavailableException] should be thrownBy operation()
          }
      }
    }
    // The plan is as it was: not dropped, not claimed, no update added.
    ExecutionPlanStore.readPlan(uri) shouldBe planRow()
    ExecutionPlanStore.readUpdate(uri, "update-1") shouldBe updateRow("update-1")
    a[NoSuchUpdateException] should be thrownBy ExecutionPlanStore.readUpdate(uri, "update-2")
    ExecutionPlanStore.isStarted(uri) shouldBe false
  }

  // ---------------------------------------------------------------------------
  // URIs that are not an execution's plan URI
  // ---------------------------------------------------------------------------

  /** URIs that are no execution's plan table, though the first five are of this deployment. */
  private val notPlanUris = Seq(
    VFSURIFactory.createRuntimeStatisticsURI(workflowId, ExecutionIdentity(1)),
    VFSURIFactory.createConsoleMessagesURI(
      workflowId,
      ExecutionIdentity(1),
      OperatorIdentity("op")
    ),
    // Segments the store did not write would address another table in the plan namespace.
    new URI("vfs:///wid/12/eid/1/opid/op/plan"),
    new URI("vfs:///wid/12/eid/1/PLAN"),
    // A warehouse name that does not decode, so the URI would fall back to the default.
    new URI("vfs:///wh/user-1%2D7/wid/12/eid/1/plan"),
    new URI("file:///wid/12/eid/1/plan")
  )

  "Every operation" should "refuse a URI that is not an execution's plan URI, touching no table" in {
    val operations: Seq[(String, URI => Any)] = Seq(
      "writePlan" -> (uri => ExecutionPlanStore.writePlan(uri, planRow(), logicalPlan)),
      "readPlan" -> (uri => ExecutionPlanStore.readPlan(uri)),
      "readPlanWithLogical" -> (uri => ExecutionPlanStore.readPlanWithLogical(uri)),
      "appendUpdate" -> (uri => appendUpdate(uri, updateRow("update-1"))),
      "readUpdate" -> (uri => ExecutionPlanStore.readUpdate(uri, "update-1")),
      "claimStart" -> (uri => ExecutionPlanStore.claimStart(uri)),
      "isStarted" -> (uri => ExecutionPlanStore.isStarted(uri)),
      "drop" -> (uri => ExecutionPlanStore.drop(uri))
    )
    for ((name, operation) <- operations; uri <- notPlanUris)
      withClue(s"$name($uri): ") {
        an[IllegalArgumentException] should be thrownBy operation(uri)
      }
    notPlanUris.init.foreach { uri =>
      withClue(s"$uri: ") { DocumentFactory.documentExists(uri) shouldBe false }
    }
  }
}
