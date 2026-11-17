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

package org.apache.texera.amber.engine.e2e

import com.twitter.util.{Await, Duration, Promise, Return, Throw, Try}
import org.apache.pekko.actor.ActorSystem
import org.apache.texera.amber.core.executor.OpExecInitInfo
import org.apache.texera.amber.core.storage.{DocumentFactory, VFSURIFactory}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  GlobalPortIdentity,
  PhysicalOp,
  PhysicalPlan,
  PhysicalPlanCodec,
  PortIdentity,
  PythonEnvironment,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.engine.architecture.coordinator.{
  CoordinatorConfig,
  ExecutionStateUpdate,
  FatalError,
  OperatorPortResultUriAvailable,
  Workflow
}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  EmptyRequest,
  UpdateExecutorRequest,
  WorkflowReconfigureRequest
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  PAUSED
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.enums.UserRoleEnum
import org.apache.texera.dao.jooq.generated.tables.daos.{
  UserDao,
  WorkflowDao,
  WorkflowExecutionsDao,
  WorkflowVersionDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.{
  User,
  WorkflowExecutions,
  WorkflowVersion,
  Workflow => WorkflowPojo
}
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.web.service.{PlanToRun, WorkflowExecutionService}
import org.apache.texera.web.storage.ResultUris
import org.apache.texera.common.compiler.model.LogicalLink
import org.apache.texera.common.compiler.{
  CompilationErrorHandling,
  CompileSettings,
  PythonEnvironmentNotResolved,
  RunBindings,
  WorkflowCompiler
}
import org.scalatest.Assertions

import java.nio.file.{Path, Paths}

object TestUtils {

  /**
    * A WorkflowContext whose workflow- and execution-id are both `id`. Each e2e
    * suite passes a distinct id so its results land in a disjoint storage
    * keyspace (`vfs:///wid/{id}/eid/{id}/...`) and disjoint DB rows, letting the
    * suites run concurrently without colliding on the shared Iceberg catalog.
    */
  def workflowContext(
      id: Int,
      workflowSettings: WorkflowSettings = WorkflowSettings()
  ): WorkflowContext =
    new WorkflowContext(
      workflowId = WorkflowIdentity(id.toLong),
      executionId = ExecutionIdentity(id.toLong),
      workflowSettings = workflowSettings
    )

  /** The one Python environment the user of the fixtures keeps, under the name `ml`. */
  val fixtureEnvironment: PythonEnvironment = PythonEnvironment("ml", Seq("tabulate==0.9.0"))

  /**
    * What a plan compiled in a spec is bound to: its scan sources read fixture files on the local
    * disk, through links to the fixture server, as a run reads a dataset's files through links
    * to the object store; its File Listers list the fixture dataset version, whose files are
    * read through such links too; a UDF's datasets and models are the fixture versions; the
    * site's settings are the defaults; and a UDF's Python environment is the fixture's, the only
    * one there is.
    */
  val fixtureBindings: RunBindings = RunBindings(
    files = TestOperators.fixtureFileResolver,
    inputLinker = TestOperators.fixtureInputLinker,
    lister = TestOperators.fixtureDatasetVersionLister,
    repositories = TestOperators.fixtureRepositoryResolver,
    settings = CompileSettings.Default,
    environments = name =>
      if (name == fixtureEnvironment.name) fixtureEnvironment
      else throw PythonEnvironmentNotResolved.noSuchEnvironment(name)
  )

  /** The directory the computing unit of a spec mounts datasets and models under. */
  val fixtureUnitMountRoot: Path = Paths.get("/mnt/texera-mounts")

  /**
    * The workflow of `operators` and `links`, made to run under `context` as a run's is: its plan
    * made and saved as text (`PlanToRun.make`), and the engine's plan read back from that as the
    * fixture unit runs it (`WorkflowExecutionService.mountedUnder`), so a spec runs what a run
    * would. `context` takes the settings and cost hints saved with the plan,
    * the ports whose results are stored among them. The text stays in memory: the Dashboard writes
    * it to the execution's plan table and a computing unit reads it back from there, which these
    * specs need no catalog for.
    *
    * @param fromSavedPlan false to keep the plan as the compile made it, never saved. Only for
    *                      comparing a run of that plan with a run of the plan read back.
    */
  def buildWorkflow(
      operators: List[LogicalOp],
      links: List[LogicalLink],
      context: WorkflowContext,
      fromSavedPlan: Boolean = true
  ): Workflow = {
    val workflowCompiler = new WorkflowCompiler(context, fixtureBindings)
    val logicalPlan = LogicalPlanPojo(operators, links, List(), List())
    if (fromSavedPlan) {
      val savedPlan = PlanToRun.make(workflowCompiler, logicalPlan)
      val readBack = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(savedPlan))
      context.workflowSettings = readBack.context.workflowSettings
      context.costHints = readBack.context.costHints
      Workflow(
        context,
        WorkflowExecutionService.mountedUnder(readBack.plan, Some(fixtureUnitMountRoot))
      )
    } else {
      // The compile PlanToRun.make makes a run's plan with, but not saved: strict, so an error
      // throws rather than leaving no physical plan.
      Workflow.fromCompilationResult(
        context,
        workflowCompiler.compile(logicalPlan, CompilationErrorHandling.Strict)
      )
    }
  }

  /**
    * Fails unless `saved` is `compiled` read back from its saved form: every operator of `saved`
    * was read back, none of `compiled` was, and but for that the plans are the same, down to the
    * order the engine finds each operator's ports and each port's links in.
    */
  def assertReadBackFrom(compiled: PhysicalPlan, saved: PhysicalPlan): Unit = {
    def readBack(op: PhysicalOp): Boolean =
      op.propagateSchema == PhysicalPlanCodec.ReadBackSchemaPropagation
    Assertions.assert(
      !compiled.operators.exists(readBack),
      "the compiled plan was read back from a saved plan: it was meant to run as compiled"
    )
    Assertions.assert(
      saved.operators.forall(readBack),
      "the plan to run was not read back from its saved form"
    )
    // the schema functions, the one part of a plan that is not saved, set aside
    def withoutPropagation(plan: PhysicalPlan): PhysicalPlan =
      PhysicalPlan(
        plan.operators.map(_.copy(propagateSchema = PhysicalPlanCodec.ReadBackSchemaPropagation)),
        plan.links
      )
    Assertions.assert(
      withoutPropagation(saved) == withoutPropagation(compiled),
      "the plan read back is not the compiled plan"
    )
    // An Attribute equals one whose name differs only in case; a saved name must not.
    def ports(op: PhysicalOp): List[Any] =
      (op.inputPorts.toList ++ op.outputPorts.toList).map {
        case (id, (_, links, schema)) =>
          (id, links, schema.toOption.map(_.getAttributes.map(a => (a.getName, a.getType))))
      }
    compiled.operators.foreach { op =>
      Assertions.assert(
        ports(saved.getOperator(op.id)) == ports(op),
        s"the ports of operator ${op.id.logicalOpId.id}-${op.id.layerName} differ in their " +
          "order, the order of their links, or the case of a column's name"
      )
    }
  }

  /**
    * Resolve and read each operator's external RESULT document among `resultUris`,
    * applying `extract` to the opened document. Operators with no external
    * RESULT uri (e.g. one whose output wasn't materialized) are omitted. Shared
    * by the e2e specs so the lookup-open-extract block doesn't drift between
    * copies.
    */
  def readMaterializedResults[T](
      resultUris: ResultUris,
      operatorIds: Iterable[OperatorIdentity],
      extract: VirtualDocument[Tuple] => T
  ): Map[OperatorIdentity, T] =
    operatorIds.flatMap { opId =>
      resultUris.of(opId, PortIdentity()).map { uri =>
        opId -> extract(
          DocumentFactory.openDocument(uri)._1.asInstanceOf[VirtualDocument[Tuple]]
        )
      }
    }.toMap

  /**
    * The operators `plan` ends in: those no other operator reads from, whose results a run stores.
    */
  private def terminalOperatorIds(plan: PhysicalPlan): List[OperatorIdentity] = {
    val readFrom = plan.links.collect {
      case link if link.fromOpId.logicalOpId != link.toOpId.logicalOpId => link.fromOpId.logicalOpId
    }
    (plan.operators.map(_.id.logicalOpId) -- readFrom).toList
  }

  /**
    * Convenience over `readMaterializedResults` for the common case: read each
    * terminal operator's result of `workflow` as a `List[Tuple]`.
    */
  def readMaterializedResults(
      resultUris: ResultUris,
      workflow: Workflow
  ): Map[OperatorIdentity, List[Tuple]] =
    readMaterializedResults(
      resultUris,
      terminalOperatorIds(workflow.physicalPlan),
      _.get().toList
    )

  /**
    * Run `workflow` to COMPLETED, then read the requested operators' materialized
    * results via `readMaterializedResults`. A FatalError aborts the run and is
    * surfaced as the exception from the completion await. Specs that drive the
    * run differently (e.g. a pause/resume flow) read results directly inside
    * their own completion callback instead.
    */
  def runWorkflowAndReadResults[T](
      system: ActorSystem,
      workflow: Workflow,
      operatorIds: Iterable[OperatorIdentity],
      extract: VirtualDocument[Tuple] => T,
      completionTimeout: Duration = Duration.fromMinutes(1)
  ): Map[OperatorIdentity, T] = {
    // The Promise carries the result so completing the run and handing back the
    // value are atomic. Every terminal path uses `updateIfEmpty`, so a second
    // event (a late FatalError after COMPLETED, or a repeated state update)
    // can't throw inside a callback and get swallowed -- which would otherwise
    // mask the real failure as a timeout. A read failure inside the COMPLETED
    // callback fails the Promise (via `Try`) instead of hanging, and
    // `shutdown()` runs in a `finally` so a timeout or error can't leak the
    // client's actors.
    val completion = Promise[Map[OperatorIdentity, T]]()
    val client = new AmberClient(
      system,
      workflow.context,
      workflow.physicalPlan,
      CoordinatorConfig.default,
      e => completion.updateIfEmpty(Throw(e))
    )
    try {
      client.registerCallback[FatalError](evt => completion.updateIfEmpty(Throw(evt.e)))
      val resultUris = resultUrisOf(client)
      client.registerCallback[ExecutionStateUpdate](evt => {
        if (evt.state == COMPLETED) {
          completion.updateIfEmpty(Try(readMaterializedResults(resultUris, operatorIds, extract)))
        }
      })
      Await.result(client.coordinatorInterface.startWorkflow(EmptyRequest(), ()))
      Await.result(completion, completionTimeout)
    } finally {
      client.shutdown()
    }
  }

  /**
    * Where the results of the run of `client`'s engine are: kept as the engine reports each
    * materialized output port, the way a computing unit keeps those of the run it holds
    * (`ExecutionResultService.attachToExecution`), but driven from a test-owned `AmberClient`.
    * To be called before the run starts: a port reported earlier is not kept.
    */
  def resultUrisOf(client: AmberClient): ResultUris = {
    val resultUris = new ResultUris
    client.registerCallback[OperatorPortResultUriAvailable](evt =>
      resultUris.add(evt.globalPortId, evt.uri)
    )
    resultUris
  }

  /**
    * Convenience over `runWorkflowAndReadResults` for the common case: run
    * `workflow` and read each terminal operator's result as a `List[Tuple]`.
    */
  def runWorkflowAndReadTerminalResults(
      system: ActorSystem,
      workflow: Workflow,
      completionTimeout: Duration = Duration.fromMinutes(1)
  ): Map[OperatorIdentity, List[Tuple]] =
    runWorkflowAndReadResults(
      system,
      workflow,
      terminalOperatorIds(workflow.physicalPlan),
      _.get().toList,
      completionTimeout
    )

  /**
    * The workflow of `operators` and `links` built twice, each under a context `newContext` makes:
    * first with the plan its compile made, never saved, then as every run's is, with that plan
    * saved as text and read back. Fails unless the second plan is the first read back
    * ([[assertReadBackFrom]]), under the same settings.
    */
  def buildFromCompiledAndSavedPlans(
      operators: List[LogicalOp],
      links: List[LogicalLink],
      newContext: () => WorkflowContext
  ): (Workflow, Workflow) = {
    val compiled = buildWorkflow(operators, links, newContext(), fromSavedPlan = false)
    val saved = buildWorkflow(operators, links, newContext())
    assertReadBackFrom(compiled.physicalPlan, saved.physicalPlan)
    val (compiledSettings, savedSettings) =
      (compiled.context.workflowSettings, saved.context.workflowSettings)
    Assertions.assert(
      savedSettings == compiledSettings,
      "the plan read back runs under other settings than the compiled plan"
    )
    Assertions.assert(
      savedSettings.outputPortsNeedingStorage.toList ==
        compiledSettings.outputPortsNeedingStorage.toList,
      "the ports whose results are stored are in another order"
    )
    (compiled, saved)
  }

  /**
    * `runWorkflowAndReadTerminalResults`, as if no run of `workflow`'s execution came before:
    * what an earlier run stored for `workflow`'s output ports is dropped. A port that keeps its
    * storage over a loop's iterations (`reuseStorage`) would otherwise keep it over runs of one
    * execution, too, which production never makes: it gives each run an execution of its own.
    */
  def runAfresh(
      system: ActorSystem,
      workflow: Workflow,
      completionTimeout: Duration = Duration.fromMinutes(1)
  ): Map[OperatorIdentity, List[Tuple]] = {
    for {
      op <- workflow.physicalPlan.operators
      portId <- op.outputPorts.keys
      base = VFSURIFactory.createPortBaseURI(
        workflow.context.workflowId,
        workflow.context.executionId,
        GlobalPortIdentity(op.id, portId),
        workflow.context.warehouse
      )
      uri <- List(VFSURIFactory.resultURI(base), VFSURIFactory.stateURI(base))
      if DocumentFactory.documentExists(uri)
    } DocumentFactory.openDocument(uri)._1.clear()
    runWorkflowAndReadTerminalResults(system, workflow, completionTimeout)
  }

  /**
    * Runs the workflow of `operators` and `links` twice, as `buildFromCompiledAndSavedPlans`
    * builds it: first from the plan its compile made, then as every run runs, from that plan
    * saved and read back. Fails unless the two runs give each terminal operator the same results,
    * as multisets.
    *
    * @return the terminal results of the run from the saved plan
    */
  def runFromCompiledAndSavedPlans(
      system: ActorSystem,
      operators: List[LogicalOp],
      links: List[LogicalLink],
      newContext: () => WorkflowContext,
      completionTimeout: Duration = Duration.fromMinutes(1)
  ): Map[OperatorIdentity, List[Tuple]] = {
    val (compiled, saved) = buildFromCompiledAndSavedPlans(operators, links, newContext)
    val fromCompiled = runAfresh(system, compiled, completionTimeout)
    val fromSaved = runAfresh(system, saved, completionTimeout)

    def counted(tuples: List[Tuple]): Map[Tuple, Int] =
      tuples.groupMapReduce(identity)(_ => 1)(_ + _)
    Assertions.assert(fromSaved.keySet == fromCompiled.keySet, "the runs read other operators")
    fromCompiled.foreach {
      case (opId, tuples) =>
        val (fromCompiledPlan, fromSavedPlan) = (counted(tuples), counted(fromSaved(opId)))
        val differing = (fromCompiledPlan.keySet ++ fromSavedPlan.keySet).toSeq.collect {
          case tuple if fromCompiledPlan.get(tuple) != fromSavedPlan.get(tuple) =>
            s"$tuple, ${fromCompiledPlan.getOrElse(tuple, 0)} times from the compiled plan and " +
              s"${fromSavedPlan.getOrElse(tuple, 0)} from the saved one"
        }
        Assertions.assert(
          differing.isEmpty,
          s"operator ${opId.id} gave other results from the saved plan: ${tuples.size} rows " +
            s"from the compiled plan, ${fromSaved(opId).size} from the saved one; " +
            s"${differing.take(5).mkString("; ")}"
        )
    }
    fromSaved
  }

  /**
    * If a test case accesses the user system through singleton resources that cache the DSLContext (e.g., executes a
    * workflow, which accesses WorkflowExecutionsResource), we use a separate texera_db specifically for such test cases.
    * Note such test cases need to clean up the database at the end of running each test case.
    *
    * This backs the e2e specs with MockTexeraDB's embedded Postgres instead of an external test Postgres
    * (depends on #4179).
    */
  def initiateTexeraDBForTestCases(): Unit = {
    org.apache.texera.dao.MockTexeraDB.ensureInitialized()
    val embedded = org.apache.texera.dao.MockTexeraDB.getDBInstance

    val dbName =
      "texera_db_for_test_cases_" + java.util.UUID.randomUUID().toString.replace("-", "")

    org.apache.texera.dao.MockTexeraDB.createTestDatabase(dbName)

    SqlServer.initConnection(
      embedded.getJdbcUrl("postgres", dbName),
      "postgres",
      ""
    )
  }

  // All fixture rows for one suite share `id` as uid/wid/vid/eid; the email is
  // derived from it so concurrent suites don't collide on the unique email key.
  def testUser(id: Int): User = {
    val user = new User
    user.setUid(Integer.valueOf(id))
    user.setName(s"test_user_$id")
    user.setRole(UserRoleEnum.ADMIN)
    user.setEmail(s"test_user_$id@test.com")
    user
  }

  def testWorkflowEntry(id: Int): WorkflowPojo = {
    val workflow = new WorkflowPojo
    workflow.setName("test workflow")
    workflow.setWid(Integer.valueOf(id))
    workflow.setContent("test workflow content")
    workflow.setDescription("test description")
    workflow
  }

  def testWorkflowVersionEntry(id: Int): WorkflowVersion = {
    val workflowVersion = new WorkflowVersion
    workflowVersion.setWid(Integer.valueOf(id))
    workflowVersion.setVid(Integer.valueOf(id))
    workflowVersion.setContent("test version content")
    workflowVersion
  }

  def testWorkflowExecutionEntry(id: Int): WorkflowExecutions = {
    val workflowExecution = new WorkflowExecutions
    workflowExecution.setEid(Integer.valueOf(id))
    workflowExecution.setVid(Integer.valueOf(id))
    workflowExecution.setUid(Integer.valueOf(id))
    workflowExecution.setStatus(3.toByte)
    workflowExecution.setEnvironmentVersion("test engine")
    workflowExecution
  }

  def setUpWorkflowExecutionData(id: Int): Unit = {
    val dslConfig = SqlServer.getInstance().context.configuration()
    val userDao = new UserDao(dslConfig)
    val workflowDao = new WorkflowDao(dslConfig)
    val workflowExecutionsDao = new WorkflowExecutionsDao(dslConfig)
    val workflowVersionDao = new WorkflowVersionDao(dslConfig)
    userDao.insert(testUser(id))
    workflowDao.insert(testWorkflowEntry(id))
    workflowVersionDao.insert(testWorkflowVersionEntry(id))
    workflowExecutionsDao.insert(testWorkflowExecutionEntry(id))
  }

  /**
    * Returns a Promise that completes the next time the client emits an
    * ExecutionStateUpdate with the given target state. Must be called BEFORE
    * the action that triggers the state change, since AmberClient observables
    * do not replay past events.
    */
  def stateReached(
      client: AmberClient,
      target: WorkflowAggregatedState
  ): Promise[Unit] = {
    val p = Promise[Unit]()
    client.registerCallback[ExecutionStateUpdate](evt => {
      if (evt.state == target) {
        p.updateIfEmpty(Return(()))
      }
    })
    p
  }

  /**
    * Pause a freshly-started workflow, swap the executor for the given target
    * operators via WorkflowReconfigureRequest, resume, and collect the
    * terminal-port outputs once the run completes. Shared by ReconfigurationSpec
    * (pure-Scala) and ReconfigurationIntegrationSpec (Python-tagged), so an
    * earlier in-spec copy doesn't drift between the two as new e2e specs
    * land. The caller passes its own `system` (TestKit) and `ctx`
    * (WorkflowContext) since both are tied to the spec lifecycle.
    */
  def shouldReconfigure(
      system: ActorSystem,
      ctx: WorkflowContext,
      operators: List[LogicalOp],
      links: List[LogicalLink],
      targetOps: Seq[LogicalOp],
      newOpExecInitInfo: OpExecInitInfo
  ): Map[OperatorIdentity, List[Tuple]] = {
    val workflow = buildWorkflow(operators, links, ctx)
    val client = new AmberClient(
      system,
      workflow.context,
      workflow.physicalPlan,
      CoordinatorConfig.default,
      error => {}
    )
    // Timeout for control-command acks (start/pause/reconfigure/resume).
    val commandTimeout = Duration.fromSeconds(30)
    val resultUris = resultUrisOf(client)
    val completion = Promise[Unit]()
    var result: Map[OperatorIdentity, List[Tuple]] = null
    client.registerCallback[ExecutionStateUpdate](evt => {
      if (evt.state == COMPLETED) {
        result = readMaterializedResults(resultUris, workflow)
        completion.setDone()
      }
    })
    Await.result(
      client.coordinatorInterface.startWorkflow(EmptyRequest(), ()),
      commandTimeout
    )
    val pausedReached = stateReached(client, PAUSED)
    Await.result(
      client.coordinatorInterface.pauseWorkflow(EmptyRequest(), ()),
      commandTimeout
    )
    Await.result(pausedReached, commandTimeout)
    val physicalOps = targetOps.flatMap(op =>
      workflow.physicalPlan.getPhysicalOpsOfLogicalOp(op.operatorIdentifier)
    )
    // Production dispatches the reconfiguration without awaiting its ack and it
    // only takes effect on resume (see ExecutionReconfigurationService), so the
    // harness must not await the ack while still paused — that await is what
    // used to deadlock for the full 30s command timeout. The reconfigure ack is
    // awaited only after the resume ack, which ResumeHandler completes once
    // every worker has acknowledged the resume. (There is no RUNNING event to
    // wait for: the engine only pushes ExecutionStateUpdate to the client for
    // PAUSED and terminal states.)
    val reconfigured = client.coordinatorInterface.reconfigureWorkflow(
      WorkflowReconfigureRequest(
        reconfiguration = physicalOps.map(op => UpdateExecutorRequest(op.id, newOpExecInitInfo)),
        reconfigurationId = "test-reconfigure-1"
      ),
      ()
    )
    Await.result(
      client.coordinatorInterface.resumeWorkflow(EmptyRequest(), ()),
      commandTimeout
    )
    Await.result(reconfigured, commandTimeout)
    Await.result(completion, Duration.fromMinutes(1))
    result
  }

  def cleanupWorkflowExecutionData(id: Int): Unit = {
    val dslConfig = SqlServer.getInstance().context.configuration()
    val userDao = new UserDao(dslConfig)
    val workflowDao = new WorkflowDao(dslConfig)
    val workflowExecutionsDao = new WorkflowExecutionsDao(dslConfig)
    val workflowVersionDao = new WorkflowVersionDao(dslConfig)
    workflowExecutionsDao.deleteById(id)
    workflowVersionDao.deleteById(id)
    workflowDao.deleteById(id)
    userDao.deleteById(id)
  }

}
