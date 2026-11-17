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

import org.apache.iceberg.Table
import org.apache.iceberg.catalog.{Catalog, Namespace, TableIdentifier}
import org.apache.iceberg.exceptions.NoSuchTableException
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.storage.{
  ExecutionPlanStore,
  IcebergCatalogInstance,
  PlanRecord,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionMode,
  ExecutionPlan,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PlanInput,
  PortIdentity,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.service.WorkflowService
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger

/**
  * The checks a computing unit makes before it starts an execution the Dashboard service created:
  * every refusal of [[StoredExecutionStart]], in its words, and that no catalog is opened before
  * the URI passes. The plans are encoded here, as the Dashboard encodes them; nothing is written
  * to a catalog. The last cases start through a [[WorkflowService]] with a catalog that counts
  * what it is asked.
  */
class StoredExecutionStartSpec extends AnyFlatSpec with Matchers {

  private val wid = 9751L
  private val eid = 975001L
  private val uid = 9752
  private val cuid = 9753
  private val ownWarehouse = s"user-$uid-3"
  private def planUri(
      workflow: Long = wid,
      execution: Long = eid,
      warehouse: Option[String] = None
  ): URI =
    ExecutionPlanStore.planUri(WorkflowIdentity(workflow), ExecutionIdentity(execution), warehouse)

  private def checkUri(
      uri: URI,
      execution: Long = eid,
      socketWorkflow: Option[Long] = Some(wid),
      user: Int = uid,
      warehousesEnabled: Boolean = true
  ): Either[String, _] =
    StoredExecutionStart.checkUri(uri, execution, socketWorkflow, user, warehousesEnabled)

  /** A source of one string column, of `workflow`'s execution `execution`. */
  private def source(name: String, workflow: Long = wid, execution: Long = eid): PhysicalOp =
    PhysicalOp
      .sourcePhysicalOp(
        PhysicalOpIdentity(OperatorIdentity(name), "main"),
        WorkflowIdentity(workflow),
        ExecutionIdentity(execution),
        OpExecWithClassName("unused")
      )
      .copy(outputPorts =
        Map(
          PortIdentity() -> (
            OutputPort(),
            List.empty,
            Right(Schema().add("line", AttributeType.STRING))
          )
        )
      )

  /** The plan of a run of `lines` alone, saved as the Dashboard saves it. */
  private def savedPlan(
      workflow: Long = wid,
      execution: Long = eid,
      warehouse: Option[String] = None,
      inputs: Seq[PlanInput] = Seq.empty
  ): String =
    PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.encode(
        ExecutionPlan(
          new WorkflowContext(
            WorkflowIdentity(workflow),
            ExecutionIdentity(execution),
            WorkflowSettings(dataTransferBatchSize = 77, executionMode = ExecutionMode.PIPELINED),
            warehouse = warehouse
          ),
          PhysicalPlan(Set(source("lines", workflow, execution)), Set.empty),
          inputs = inputs
        )
      )
    )

  private def record(
      body: String = savedPlan(),
      createdBy: Int = uid,
      computingUnitId: Int = cuid
  ): PlanRecord =
    PlanRecord(
      entryId = ExecutionPlanStore.PlanEntryId,
      body = body,
      createdBy = createdBy,
      computingUnitId = computingUnitId,
      notification = None
    )

  private val now = Instant.parse("2026-11-16T12:00:00Z").toEpochMilli

  private def checkRecord(
      planRecord: PlanRecord,
      uri: URI = planUri(),
      user: Int = uid,
      unit: Int = cuid,
      nowMs: Long = now
  ): Either[String, ExecutionPlan] =
    StoredExecutionStart.checkRecord(planRecord, VFSURIFactory.decodeURI(uri), user, unit, nowMs)

  private def input(name: String, expiresAtMs: Long): PlanInput =
    PlanInput(OperatorIdentity("lines"), name, expiresAtMs)

  // --- planUriOf ---

  "planUriOf" should "read the plan table a request names" in {
    StoredExecutionStart.planUriOf(planUri().toString) shouldBe Right(planUri())
  }

  it should "refuse a request that names none, or no URI" in {
    StoredExecutionStart.planUriOf(null) shouldBe Left("not an execution plan")
    StoredExecutionStart.planUriOf("vfs:///wid/1/eid/2/plan with spaces") shouldBe
      Left("not an execution plan")
  }

  // --- checkUri ---

  "checkUri" should "pass the plan table of the execution, in the default warehouse or the user's own" in {
    val default = checkUri(planUri()).getOrElse(fail("refused"))
    default shouldBe VFSURIFactory.decodeURI(planUri())
    val own = checkUri(planUri(warehouse = Some(ownWarehouse))).getOrElse(fail("refused"))
    own shouldBe VFSURIFactory.decodeURI(planUri(warehouse = Some(ownWarehouse)))
    // A request that came over no socket starts the workflow the URI names.
    checkUri(planUri(), socketWorkflow = None).isRight shouldBe true
  }

  it should "refuse anything but a plan table's URI as the store builds it" in {
    val notPlans = Seq(
      new URI("file:///wid/9751/eid/975001/plan"),
      new URI("vfs:plan"),
      new URI("vfs:///wid/x/eid/975001/plan"),
      VFSURIFactory.createRuntimeStatisticsURI(WorkflowIdentity(wid), ExecutionIdentity(eid)),
      VFSURIFactory.createConsoleMessagesURI(
        WorkflowIdentity(wid),
        ExecutionIdentity(eid),
        OperatorIdentity("lines")
      ),
      // another segment, a query, a fragment: each would name another table, or none
      new URI(s"vfs:///wid/$wid/eid/$eid/extra/plan"),
      new URI(s"vfs:///wid/$wid/eid/$eid/plan?x=1"),
      new URI(s"vfs:///wid/$wid/eid/$eid/plan#x"),
      new URI(s"vfs://host/wid/$wid/eid/$eid/plan"),
      // a warehouse name the store could not have written: no warehouse, read as the default
      new URI(s"vfs:///wh/user-$uid-3%2Fx/wid/$wid/eid/$eid/plan")
    )
    notPlans.foreach { uri =>
      withClue(s"$uri: ") { checkUri(uri) shouldBe Left("not an execution plan") }
    }
  }

  it should "refuse the plan table of another execution" in {
    checkUri(planUri(execution = eid + 1)) shouldBe
      Left(s"the plan is execution ${eid + 1}'s, not $eid's")
  }

  it should "refuse, over a socket, the plan of another workflow" in {
    checkUri(planUri(workflow = wid + 1)) shouldBe
      Left(s"the plan belongs to workflow ${wid + 1}, not to this one")
  }

  it should "refuse a plan in another user's warehouse, before it asks whether warehouses are on" in {
    Seq(
      s"user-${uid + 1}-3",
      s"user-${uid}7-3", // another user, whose id starts with this one's
      s"user-$uid-",
      s"user-$uid-3x",
      "shared",
      s"user-$uid"
    ).foreach { warehouse =>
      withClue(s"$warehouse: ") {
        Seq(true, false).foreach { enabled =>
          checkUri(planUri(warehouse = Some(warehouse)), warehousesEnabled = enabled) shouldBe
            Left("the plan is in another user's warehouse")
        }
      }
    }
  }

  it should "refuse a plan in the user's own warehouse while per-user warehouses are disabled" in {
    checkUri(planUri(warehouse = Some(ownWarehouse)), warehousesEnabled = false) shouldBe
      Left(
        s"execution $eid keeps its plan in warehouse '$ownWarehouse', and per-user warehouses " +
          "are disabled in this deployment"
      )
    // The default warehouse is read either way.
    checkUri(planUri(), warehousesEnabled = false).isRight shouldBe true
  }

  it should "check the execution first, then the workflow, then the warehouse" in {
    val everythingWrong =
      planUri(workflow = wid + 1, execution = eid + 1, warehouse = Some("shared"))
    checkUri(everythingWrong, execution = eid) shouldBe
      Left(s"the plan is execution ${eid + 1}'s, not $eid's")
    checkUri(everythingWrong, execution = eid + 1) shouldBe
      Left(s"the plan belongs to workflow ${wid + 1}, not to this one")
    checkUri(everythingWrong, execution = eid + 1, socketWorkflow = None) shouldBe
      Left("the plan is in another user's warehouse")
  }

  // --- checkRecord ---

  "checkRecord" should "read the plan of a row made for the user and unit, with its context" in {
    val plan = checkRecord(record()).getOrElse(fail("refused"))
    plan.context.workflowId shouldBe WorkflowIdentity(wid)
    plan.context.executionId shouldBe ExecutionIdentity(eid)
    plan.context.workflowSettings.dataTransferBatchSize shouldBe 77
    plan.context.warehouse shouldBe None
    plan.plan.operators.map(_.id) shouldBe Set(
      PhysicalOpIdentity(OperatorIdentity("lines"), "main")
    )

    val inOwnWarehouse = checkRecord(
      record(body = savedPlan(warehouse = Some(ownWarehouse))),
      uri = planUri(warehouse = Some(ownWarehouse))
    ).getOrElse(fail("refused"))
    inOwnWarehouse.context.warehouse shouldBe Some(ownWarehouse)
  }

  it should "refuse anyone but the user who created the execution, without reading its plan" in {
    checkRecord(record(body = "not a plan"), user = uid + 1) shouldBe
      Left(s"only the user who created execution $eid may start it")
  }

  it should "refuse a row made for another computing unit, without reading its plan" in {
    checkRecord(record(body = "not a plan"), unit = cuid + 1) shouldBe
      Left(s"execution $eid was created for computing unit $cuid, not ${cuid + 1}")
  }

  it should "check the row's creator, then its unit" in {
    val everythingWrong = record(createdBy = uid + 1, computingUnitId = cuid + 1)
    checkRecord(everythingWrong) shouldBe
      Left(s"only the user who created execution $eid may start it")
    checkRecord(everythingWrong.copy(createdBy = uid)) shouldBe
      Left(s"execution $eid was created for computing unit ${cuid + 1}, not $cuid")
  }

  it should "refuse a plan it cannot read, in the codec's words" in {
    checkRecord(record(body = "not a plan")).left.getOrElse(fail("read")) should
      startWith("The plan is not JSON")
    // A plan in a format this unit does not read yet is refused for its format, whatever it
    // holds that this unit does not know.
    val nextFormat = savedPlan().replaceFirst(
      s""""formatVersion": ${PhysicalPlanCodec.FormatVersion},""",
      s""""formatVersion": ${PhysicalPlanCodec.FormatVersion + 1}, "aFieldOfTheNextFormat": 1,"""
    )
    nextFormat should not be savedPlan()
    checkRecord(record(body = nextFormat)) shouldBe Left(
      s"The plan is in format version ${PhysicalPlanCodec.FormatVersion + 1}, but this reader " +
        s"reads version ${PhysicalPlanCodec.FormatVersion}."
    )
  }

  it should "refuse a plan of another workflow, execution or warehouse than the table it is in" in {
    Seq(
      savedPlan(workflow = wid + 1),
      savedPlan(execution = eid + 1),
      savedPlan(warehouse = Some(ownWarehouse))
    ).foreach { body =>
      checkRecord(record(body = body)) shouldBe Left("the plan's ids do not match its location")
    }
    // and the plan of the default warehouse, found in the user's own
    checkRecord(record(), uri = planUri(warehouse = Some(ownWarehouse))) shouldBe
      Left("the plan's ids do not match its location")
  }

  it should "refuse a plan whose earliest input link has expired, naming when" in {
    val earliest = now - 1000
    checkRecord(
      record(body = savedPlan(inputs = Seq(input("b.csv", now + 60000), input("a.csv", earliest))))
    ) shouldBe Left(
      s"input links expired at ${Instant.ofEpochMilli(earliest)}; run the workflow again"
    )
    // A link that expires now has expired.
    checkRecord(record(body = savedPlan(inputs = Seq(input("a.csv", now))))) shouldBe
      Left(s"input links expired at ${Instant.ofEpochMilli(now)}; run the workflow again")
  }

  it should "pass a plan whose input links have not expired, and one that reads no input" in {
    val plan = checkRecord(record(body = savedPlan(inputs = Seq(input("a.csv", now + 1)))))
      .getOrElse(fail("refused"))
    plan.inputs.map(_.name) shouldBe Seq("a.csv")
    checkRecord(record()).map(_.inputs) shouldBe Right(Seq.empty)
  }

  // --- withoutSecrets ---

  "withoutSecrets" should "keep the scheme, host, port and path of a URI, and drop its query" in {
    val token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXhlcmEifQ.c2lnbmF0dXJl"
    StoredExecutionStart.withoutSecrets(
      new URI(
        s"ws://localhost:8085/wsapi/workflow-websocket?wid=12&uid=1&cuid=3&access-token=$token"
      )
    ) shouldBe new URI("ws://localhost:8085/wsapi/workflow-websocket")
    StoredExecutionStart.withoutSecrets(
      new URI(s"wss://texera.example/wsapi/workflow-websocket?access-token=$token#$token")
    ) shouldBe new URI("wss://texera.example/wsapi/workflow-websocket")
    // The agent's runs name their workflow where a host would be.
    StoredExecutionStart.withoutSecrets(new URI("sync-execution://12")) shouldBe
      new URI("sync-execution://12")
    // Escapes in the path stay as they were.
    StoredExecutionStart.withoutSecrets(new URI("ws://[::1]:8080/a%20b?x=1")) shouldBe
      new URI("ws://[::1]:8080/a%20b")
  }

  it should "drop user info, and keep nothing of a URI that is not hierarchical" in {
    StoredExecutionStart.withoutSecrets(new URI("ws://user:secret@host/path")) shouldBe
      new URI("ws://host/path")
    // An authority that names no host keeps what follows its user info.
    StoredExecutionStart.withoutSecrets(new URI("x://user:secret@not_a_host/path")) shouldBe
      new URI("x://not_a_host/path")
    StoredExecutionStart.withoutSecrets(new URI("mailto:secret@example.com")) shouldBe
      new URI("")
    StoredExecutionStart.withoutSecrets(null) shouldBe new URI("")
  }

  // --- nothing is read before the URI passes ---

  /** A catalog that counts every call and holds no table. */
  private final class CountingCatalog extends Catalog {
    val calls = new AtomicInteger()
    override def listTables(namespace: Namespace): java.util.List[TableIdentifier] = {
      calls.incrementAndGet()
      java.util.Collections.emptyList()
    }
    override def dropTable(identifier: TableIdentifier, purge: Boolean): Boolean = {
      calls.incrementAndGet()
      false
    }
    override def renameTable(from: TableIdentifier, to: TableIdentifier): Unit = {
      calls.incrementAndGet()
      throw new UnsupportedOperationException("rename")
    }
    override def loadTable(identifier: TableIdentifier): Table = {
      calls.incrementAndGet()
      throw new NoSuchTableException("no table %s", identifier)
    }
  }

  /** `body`, run with `catalog` in place of the build's: every warehouse's, in this build. */
  private def withCatalog[T](catalog: Catalog)(body: => T): T = {
    val previous = IcebergCatalogInstance.getInstance()
    IcebergCatalogInstance.replaceInstance(catalog)
    try body
    finally IcebergCatalogInstance.replaceInstance(previous)
  }

  private def user(id: Integer): User = {
    val user = new User
    user.setUid(id)
    user
  }

  "WorkflowService.startStoredExecution" should "open no catalog for a start the URI refuses" in {
    val service = new WorkflowService(WorkflowIdentity(wid), cuid, 3600)
    val catalog = new CountingCatalog
    val refusals = Seq(
      new URI("vfs:///not/a/plan") -> "not an execution plan",
      planUri(execution = eid + 1) -> s"the plan is execution ${eid + 1}'s, not $eid's",
      planUri(workflow = wid + 1) -> s"the plan belongs to workflow ${wid + 1}, not to this one",
      planUri(warehouse = Some(s"user-${uid + 1}-3")) -> "the plan is in another user's warehouse"
    )
    withCatalog(catalog) {
      refusals.foreach {
        case (uri, why) =>
          withClue(s"$uri: ") {
            service.startStoredExecution(eid, uri, user(uid), cuid, new URI("ws://unit")) shouldBe
              Left(why)
          }
      }
      // and a start with no user, however good its URI
      service.startStoredExecution(eid, planUri(), user(null), cuid, new URI("ws://unit")) shouldBe
        Left("a signed-in user is required to start an execution")
      service.startStoredExecution(eid, planUri(), null, cuid, new URI("ws://unit")) shouldBe
        Left("a signed-in user is required to start an execution")
      catalog.calls.get() shouldBe 0

      // The control: a URI that passes is looked up, and has no table here.
      service.startStoredExecution(eid, planUri(), user(uid), cuid, new URI("ws://unit")) shouldBe
        Left(s"execution $eid has no stored plan")
      catalog.calls.get() should be > 0
    }
    // Nothing was published: the service holds no run.
    service.executionService.getValue shouldBe null
  }
}
