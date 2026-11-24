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

package org.apache.texera.web.resource

import io.reactivex.rxjava3.disposables.Disposable
import org.apache.texera.amber.core.executor.{InputFile, OpExecWithClassName, OperatorInputs}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  ExecutionPlan,
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PortIdentity,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  FAILED,
  RUNNING
}
import org.apache.texera.amber.engine.common.executionrecord.RecordingExecutionRecorder
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.WorkflowLifecycleManager
import org.apache.texera.web.service.WorkflowExecutionService.RunServices
import org.apache.texera.web.service.{
  ExecutionReconfigurationService,
  WorkflowExecutionService,
  WorkflowService
}
import org.apache.texera.web.storage.ExecutionStateStore
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import javax.ws.rs.core.Response
import scala.collection.mutable.ArrayBuffer

/**
  * The routes the Dashboard service hands a computing unit its work over
  * ([[ExecutionHandoverResource]]): the start of an execution from its plan, and a change to an
  * operator of a paused one.
  *
  * What is pinned here is the routes' own: which workflow's service a start is taken on and for
  * whom, which run a change goes to and as whom, and how each is answered, 204 or 409 with why.
  * The plans and the change are written here, as the Dashboard service writes them, and the
  * services' runs have no engine. What the rest does is owned elsewhere: every check a start
  * makes of a plan by `ExecutionStartSpec`, what taking a start does to the run a service holds
  * by `WorkflowServiceSpec`, what a run makes of a change by
  * `ExecutionReconfigurationServiceSpec`, and a plan and a change the Dashboard service made,
  * through to the sessions on the unit, by `WorkflowWebsocketResourceSpec`.
  */
class ExecutionHandoverResourceSpec extends AnyFlatSpec with Matchers {

  private val wid = 9761L
  private val otherWid = 9762L
  private val unitCuid = 9763
  private val starterUid = 9764
  private val firstEid = 976100L

  private def caller(uid: Int = starterUid): SessionUser = {
    val user = new User
    user.setUid(Integer.valueOf(uid))
    user.setEmail(s"handover-spec-$uid@example.com")
    new SessionUser(user)
  }

  /** A source of one string column, of execution `eid` of workflow `workflow`. */
  private def lines(workflow: Long, eid: Long): PhysicalOp =
    PhysicalOp
      .sourcePhysicalOp(
        PhysicalOpIdentity(OperatorIdentity("lines"), "main"),
        WorkflowIdentity(workflow),
        ExecutionIdentity(eid),
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

  /**
    * The plan of execution `eid` of workflow `workflow`, as the Dashboard service writes it: one
    * source, which reads `reads` through their links, writing into `warehouse`.
    */
  private def planOf(
      eid: Long,
      workflow: Long = wid,
      warehouse: Option[String] = None,
      reads: Seq[InputFile] = Seq.empty
  ): String = {
    val context = new WorkflowContext(WorkflowIdentity(workflow), ExecutionIdentity(eid))
    context.warehouse = warehouse
    PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.encode(
        ExecutionPlan(
          context,
          PhysicalPlan(
            Set(
              lines(workflow, eid)
                .withStorageLocations(warehouse)
                .withInputs(OperatorInputs(files = reads))
            ),
            Set.empty
          )
        )
      )
    )
  }

  /** A change to the source of execution `eid`, as the Dashboard service writes one. */
  private def changeOf(eid: Long): String =
    PhysicalPlanCodec.updateToJson(
      PhysicalPlanCodec.encodeUpdate(ExecutionIdentity(eid), lines(wid, eid))
    )

  /**
    * A service of workflow `workflow` whose runs have no engine: a run records the plan it is
    * started from and who started it (`started`), stays as it was built, or fails with
    * `failure` as a run that cannot be set up does.
    */
  private final class EnginelessService(
      workflow: Long = wid,
      failure: Option[RuntimeException] = None,
      val started: ArrayBuffer[(ExecutionPlan, Int)] = ArrayBuffer.empty
  ) extends WorkflowService(
        WorkflowIdentity(workflow),
        unitCuid,
        3600,
        started = ConcurrentHashMap.newKeySet(),
        newRun = (context, _, executionStateStore, errorHandler) =>
          new WorkflowExecutionService(context, null, executionStateStore, errorHandler, None) {
            override def startPlan(
                executionPlan: ExecutionPlan,
                startedBy: Int
            ): Option[Throwable] = {
              started += ((executionPlan, startedBy))
              failure.foreach(errorHandler)
              failure
            }
          },
        startRecord = _ => new RecordingExecutionRecorder
      ) {
    override val lifeCycleManager: WorkflowLifecycleManager =
      new WorkflowLifecycleManager("ExecutionHandoverResourceSpec", 3600, () => ()) {
        override def increaseUserCount(): Unit = ()
        override def decreaseUserCount(state: Option[WorkflowAggregatedState]): Unit = ()
        override def registerCleanUpOnStateChange(stateStore: ExecutionStateStore): Disposable =
          Disposable.empty()
      }
  }

  /**
    * The routes on a unit whose workflows' services are `services`, by workflow. `asked` is each
    * service the routes asked for: the workflow, and the unit it was asked for.
    */
  private final class Routes(
      services: Map[Long, WorkflowService],
      val asked: ArrayBuffer[(Long, Int)] = ArrayBuffer.empty
  ) extends ExecutionHandoverResource(
        (workflowId, cuid) => {
          asked += ((workflowId.id, cuid))
          services(workflowId.id)
        },
        eid =>
          services.values.iterator
            .flatMap(service => Option(service.executionService.getValue).map(service -> _))
            .find { case (_, run) => run.workflowContext.executionId.id == eid }
      )

  /** Fails unless `answer` is a 409 that says `why`, and nothing else. */
  private def assertRefused(answer: Response, why: String): Unit = {
    answer.getStatus shouldBe 409
    answer.getEntity shouldBe HandoverRefusal(why)
  }

  /** Fails unless `answer` is a 204, which has no body. */
  private def assertDone(answer: Response): Unit = {
    withClue(s"${answer.getEntity}: ") { answer.getStatus shouldBe 204 }
    answer.getEntity shouldBe null
  }

  // --- a start ---

  "start" should
    "take the start on the service of the plan's workflow, on the unit asked, for the caller" in {
    val (service, other) = (new EnginelessService(), new EnginelessService(workflow = otherWid))
    val routes = new Routes(Map(wid -> service, otherWid -> other))

    assertDone(routes.start(StartExecutionRequest(planOf(firstEid), unitCuid), caller()))
    // The request names no workflow: the plan does.
    assertDone(
      routes.start(StartExecutionRequest(planOf(firstEid + 1, otherWid), unitCuid + 1), caller())
    )

    // Each service is asked for with the unit the request names.
    routes.asked shouldBe Seq((wid, unitCuid), (otherWid, unitCuid + 1))
    // Each holds the run of its execution, started from the plan handed over, for the caller.
    service.started.map {
      case (plan, uid) => (plan.context.workflowId.id, plan.context.executionId.id, uid)
    } shouldBe Seq((wid, firstEid, starterUid))
    other.started.map {
      case (plan, uid) => (plan.context.workflowId.id, plan.context.executionId.id, uid)
    } shouldBe Seq((otherWid, firstEid + 1, starterUid))
    service.executionService.getValue.workflowContext.executionId shouldBe
      ExecutionIdentity(firstEid)
    service.started.head._1.plan.operators.map(_.id) shouldBe
      Set(PhysicalOpIdentity(OperatorIdentity("lines"), "main"))
  }

  it should "refuse, with why, a start whose checks fail, asking for no workflow's service" in {
    val eid = firstEid + 10
    val nextFormat = PhysicalPlanCodec.FormatVersion + 1
    val expiry = 1000L
    val expired = planOf(
      eid,
      reads = Seq(
        InputFile("lines.txt", "http://texera-rustfs:9000/texera-dataset/lines.txt", expiry)
      )
    )
    val refusals: Seq[(String, StartExecutionRequest, String)] = Seq(
      ("no body", null, "The request has no body."),
      ("no plan", StartExecutionRequest(null, unitCuid), "The request carries no plan."),
      ("an empty plan", StartExecutionRequest("", unitCuid), "The request carries no plan."),
      (
        "not a plan",
        StartExecutionRequest("{}", unitCuid),
        "The plan names no format version; this reader reads version " +
          s"${PhysicalPlanCodec.FormatVersion}."
      ),
      (
        "another format",
        StartExecutionRequest(
          planOf(eid).replaceFirst(
            s""""formatVersion": ${PhysicalPlanCodec.FormatVersion},""",
            s""""formatVersion": $nextFormat,"""
          ),
          unitCuid
        ),
        s"The plan is in format version $nextFormat, but this reader reads version " +
          s"${PhysicalPlanCodec.FormatVersion}."
      ),
      (
        "another user's warehouse",
        StartExecutionRequest(planOf(eid, warehouse = Some(s"user-${starterUid + 1}-3")), unitCuid),
        "The plan writes into another user's warehouse."
      ),
      (
        "an expired input link",
        StartExecutionRequest(expired, unitCuid),
        s"The plan's input links expired at ${Instant.ofEpochMilli(expiry)}. Run the workflow " +
          "again."
      )
    )
    val service = new EnginelessService()
    val routes = new Routes(Map(wid -> service))
    // A run in flight on the workflow's service.
    assertDone(routes.start(StartExecutionRequest(planOf(eid - 1), unitCuid), caller()))
    val inFlight = service.executionService.getValue
    inFlight.executionStateStore.metadataStore.updateState(_.withState(RUNNING))
    val inFlightState = inFlight.executionStateStore.metadataStore.getState
    routes.asked.clear()

    refusals.foreach {
      case (name, request, why) =>
        withClue(s"$name: ") {
          assertRefused(routes.start(request, caller()), why)
        }
    }

    // Refused by the checks made before a service is asked for: none is left behind for the
    // unit a refused start names, nothing is started, and the run in flight is as it was.
    routes.asked shouldBe empty
    service.started should have size 1
    service.executionService.getValue should be theSameInstanceAs inFlight
    inFlight.executionStateStore.metadataStore.getState shouldBe inFlightState
  }

  it should "refuse a plan handed over a second time, leaving the run it started as it is" in {
    val eid = firstEid + 20
    val service = new EnginelessService()
    val routes = new Routes(Map(wid -> service))
    assertDone(routes.start(StartExecutionRequest(planOf(eid), unitCuid), caller()))
    val run = service.executionService.getValue

    // The same plan again, as a hand-over that is retried would send it, from whoever sends it.
    Seq(caller(), caller(starterUid + 1)).foreach { again =>
      assertRefused(
        routes.start(StartExecutionRequest(planOf(eid), unitCuid), again),
        s"Execution $eid was already started."
      )
    }

    service.started should have size 1
    service.executionService.getValue should be theSameInstanceAs run
  }

  it should "answer a start it took as done when the run then fails: the failure is the run's" in {
    val eid = firstEid + 30
    val service =
      new EnginelessService(failure = Some(new IllegalStateException("the engine is gone")))
    val routes = new Routes(Map(wid -> service))

    assertDone(routes.start(StartExecutionRequest(planOf(eid), unitCuid), caller()))

    // The run is the one the service holds, failed, with why: its sessions see it, and it is
    // recorded.
    val failed = service.executionService.getValue.executionStateStore.metadataStore.getState
    failed.state shouldBe FAILED
    failed.fatalErrors.map(_.message) shouldBe
      Seq("java.lang.IllegalStateException: the engine is gone")
  }

  it should "refuse a start that fails on this unit before a run is built, naming its execution" in {
    val eid = firstEid + 40
    val routes = new ExecutionHandoverResource(
      (_, _) => throw new IllegalStateException("no service can be made"),
      _ => None
    )

    assertRefused(
      routes.start(StartExecutionRequest(planOf(eid), unitCuid), caller()),
      s"Execution $eid could not be started, because of an error on this computing unit."
    )
  }

  // --- a change to an operator ---

  /**
    * What takes the changes of a run: it answers `answer` to each, and keeps what it was asked,
    * the change and who asked.
    */
  private final class AnsweringChanges(
      answer: Either[String, String],
      val asked: ArrayBuffer[(String, Option[Int])] = ArrayBuffer.empty
  ) extends ExecutionReconfigurationService(
        null,
        new ExecutionStateStore(),
        Workflow(new WorkflowContext(), PhysicalPlan(Set.empty, Set.empty)),
        starterUid,
        None
      ) {
    override protected def registerWorkerCompletionCallback(): Unit = ()
    override protected def registerCompletionDiffHandler(): Unit = ()
    override def applyUpdate(update: String, requester: Option[Int]): Either[String, String] = {
      asked += ((update, requester))
      answer
    }
  }

  /**
    * A service that holds the run of execution `eid`, whose changes `changes` takes; with none,
    * a run that was never set up.
    */
  private def holding(eid: Long, changes: Option[AnsweringChanges]): WorkflowService = {
    val service = new EnginelessService()
    val context = new WorkflowContext(WorkflowIdentity(wid), ExecutionIdentity(eid))
    service.executionService.onNext(
      new WorkflowExecutionService(context, null, new ExecutionStateStore(), _ => (), None) {
        override def services: Option[RunServices] =
          changes.map(taking =>
            RunServices(
              Workflow(context, PhysicalPlan(Set.empty, Set.empty)),
              null,
              taking,
              null,
              null,
              null
            )
          )
      }
    )
    service
  }

  "update" should "hand the change to the run of the execution it names, as the caller" in {
    val eid = firstEid + 50
    val changes = new AnsweringChanges(Right("lines"))
    val routes = new Routes(Map(wid -> holding(eid, Some(changes))))

    assertDone(routes.update(ApplyUpdateRequest(changeOf(eid)), caller()))
    assertDone(routes.update(ApplyUpdateRequest(changeOf(eid)), caller(starterUid + 1)))

    // The run is found by the execution the change names; whether its caller may change it is
    // the run's to say.
    changes.asked shouldBe
      Seq((changeOf(eid), Some(starterUid)), (changeOf(eid), Some(starterUid + 1)))
    routes.asked shouldBe empty
  }

  it should "refuse, with the run's reason, a change the run does not take" in {
    val eid = firstEid + 60
    val why = s"Only the user who started execution $eid may change its operators."
    val changes = new AnsweringChanges(Left(why))
    val routes = new Routes(Map(wid -> holding(eid, Some(changes))))

    assertRefused(routes.update(ApplyUpdateRequest(changeOf(eid)), caller(starterUid + 1)), why)

    changes.asked shouldBe Seq((changeOf(eid), Some(starterUid + 1)))
  }

  it should "refuse a change it can hand to no run: one it cannot read, and one of an execution no run here is of" in {
    val eid = firstEid + 70
    val changes = new AnsweringChanges(Right("lines"))
    val routes = new Routes(Map(wid -> holding(eid, Some(changes))))

    Seq[ApplyUpdateRequest](null, ApplyUpdateRequest(null), ApplyUpdateRequest("  ")).foreach {
      request =>
        assertRefused(routes.update(request, caller()), "The request carries no change to apply.")
    }
    Seq("not a change", "{}").foreach { unreadable =>
      withClue(s"$unreadable: ") {
        assertRefused(
          routes.update(ApplyUpdateRequest(unreadable), caller()),
          "The change cannot be read."
        )
      }
    }
    // A change to an execution whose run this unit does not hold.
    assertRefused(
      routes.update(ApplyUpdateRequest(changeOf(eid + 1)), caller()),
      s"Execution ${eid + 1} is not running here."
    )
    changes.asked shouldBe empty

    // And one to a run that was never set up, which has nothing to change.
    val neverSetUp = new Routes(Map(wid -> holding(eid, None)))
    assertRefused(
      neverSetUp.update(ApplyUpdateRequest(changeOf(eid)), caller()),
      s"Execution $eid is not running here."
    )
  }
}
