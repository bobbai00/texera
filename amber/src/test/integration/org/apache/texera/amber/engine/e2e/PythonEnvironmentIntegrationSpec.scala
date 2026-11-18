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

import com.fasterxml.jackson.databind.JsonNode
import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.storage.{
  DocumentFactory,
  ExecutionPlanStore,
  PlanRecord,
  VFSURIFactory
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Tuple}
import org.apache.texera.amber.core.workflow.{
  GlobalPortIdentity,
  PhysicalPlanCodec,
  PortIdentity,
  PythonEnvironment
}
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller.InstallFailed
import org.apache.texera.amber.engine.architecture.pythonworker.environment.{
  EngineInterpreter,
  ProcessRunner,
  PythonEnvironmentInstaller
}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED,
  READY,
  RUNNING,
  TERMINATED
}
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.ExecutionMetadataStore
import org.apache.texera.amber.engine.e2e.TestUtils.{
  cleanupWorkflowExecutionData,
  fixtureBindings,
  fixtureUnitMountRoot,
  initiateTexeraDBForTestCases,
  readMaterializedResults,
  setUpWorkflowExecutionData,
  workflowContext
}
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.python.PythonUDFOpDescV2
import org.apache.texera.amber.tags.IntegrationTest
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlanPojo}
import org.apache.texera.common.compiler.PythonEnvironmentNotResolved
import org.apache.texera.common.config.{PythonUtils, UdfConfig}
import org.apache.texera.web.service.{
  ExecutionConsoleService,
  ExecutionResultService,
  PlanToRun,
  WorkflowExecutionService
}
import org.apache.texera.web.storage.{ExecutionStateStore, WorkflowStateStore}
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Minutes, Span}
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path, Paths}
import java.security.MessageDigest
import java.util.concurrent.{CopyOnWriteArrayList, ExecutionException, TimeUnit}
import java.util.{Comparator, HexFormat}
import scala.collection.mutable
import scala.jdk.CollectionConverters.{CollectionHasAsScala, IteratorHasAsScala}
import scala.util.Using

/**
  * Runs whose Python UDF names an environment, on what a computing unit runs them with: its own
  * installer, the interpreter its workers run, pip, and the package index pip installs from.
  * Each run is set up and started as a unit starts one, from its plan saved and read back; only
  * the engine is of this suite's actor system.
  *
  * The environments are installed under the unit's root (`udf.python.environments.root`). The
  * suite starts with none of its own there, and leaves none; what its runs wrote to the lake is
  * cleared after it.
  *
  * Tagged @IntegrationTest because it spawns Python workers and installs from the package index;
  * routed to the `amber-integration` CI job.
  */
@IntegrationTest
class PythonEnvironmentIntegrationSpec
    extends TestKit(ActorSystem("PythonEnvironmentIntegrationSpec", AmberRuntime.pekkoConfig))
    with AnyFlatSpecLike
    with Matchers
    with Eventually
    with BeforeAndAfterAll
    with BeforeAndAfterEach {

  // 1 to 8 are the other e2e and integration specs'.
  private val specId = 9

  // An install and a Python worker's start take seconds; a slow index, minutes.
  private val patience = timeout(Span(5, Minutes))

  private val installer = PythonEnvironmentInstaller.forThisUnit
  private val engine =
    new EngineInterpreter(PythonUtils.getPythonExecutable, ProcessRunner.OperatingSystem)

  private val tables = PythonEnvironment("tables", Seq("tabulate==0.9.0"))
  // A version of tabulate that was never released.
  private val unreleased = PythonEnvironment("unreleased", Seq("tabulate==0.0.0.dev999"))
  // Another version of six than the engine's interpreter holds, which holds one for pandas.
  private lazy val anotherSix: Option[PythonEnvironment] =
    engine.description.packages.collectFirst {
      case line if line.startsWith("six==") =>
        val other = if (line == "six==1.16.0") "1.15.0" else "1.16.0"
        PythonEnvironment("another-six", Seq(s"six==$other"))
    }
  private def environments: Seq[PythonEnvironment] = Seq(tables, unreleased) ++ anotherSix

  /** What the runs below write to the lake: their results, statistics and console. */
  private val written = mutable.Set.empty[URI]

  override def beforeAll(): Unit = {
    system.actorOf(Props[SingleNodeListener](), "cluster-info")
    // as in the other e2e specs: load the JDBC driver explicitly, which CI occasionally misses
    Class.forName("org.postgresql.Driver")
    initiateTexeraDBForTestCases()
    environments.foreach(uninstall)
  }

  override def afterAll(): Unit =
    try {
      environments.foreach(uninstall)
      written
        .filter(DocumentFactory.documentExists)
        .foreach(uri => DocumentFactory.openDocument(uri)._1.clear())
    } finally TestKit.shutdownActorSystem(system)

  override protected def beforeEach(): Unit = setUpWorkflowExecutionData(specId)

  override protected def afterEach(): Unit = cleanupWorkflowExecutionData(specId)

  /**
    * Where the unit installs `environment`: under its root, in a directory named by the
    * environment's digest and the identity of the engine's interpreter.
    */
  private def directoryOf(environment: PythonEnvironment): Path = {
    val key = MessageDigest
      .getInstance("SHA-256")
      .digest(
        s"${environment.digest}\n${engine.description.identity}".getBytes(StandardCharsets.UTF_8)
      )
    Paths.get(UdfConfig.pythonEnvironmentsRoot).resolve(HexFormat.of().formatHex(key).take(32))
  }

  private def lockOf(environment: PythonEnvironment): Path = {
    val directory = directoryOf(environment)
    directory.resolveSibling(s"${directory.getFileName}.lock")
  }

  /** Removes what the unit keeps of `environment`, if anything. */
  private def uninstall(environment: PythonEnvironment): Unit = {
    val directory = directoryOf(environment)
    if (Files.exists(directory)) {
      Using.resource(Files.walk(directory)) { paths =>
        paths.sorted(Comparator.reverseOrder[Path]()).forEach(path => Files.delete(path))
      }
    }
    Files.deleteIfExists(lockOf(environment))
  }

  /** What the marker of `environment`, installed, says of it. */
  private def markerOf(environment: PythonEnvironment): JsonNode =
    objectMapper.readTree(
      Files.readString(directoryOf(environment).resolve("texera-environment.json"))
    )

  private def strings(values: JsonNode): Seq[String] =
    values.elements().asScala.map(_.asText()).toList

  /**
    * A run of one line of text through a Python UDF that names `environment`, which the run's
    * user keeps. The UDF adds, to the line, the version of tabulate it imports and where the
    * interpreter it runs in is installed.
    */
  private final class Run(environment: PythonEnvironment) {
    private val text = new TextInputSourceOpDesc()
    text.setOperatorId("lines")
    text.textInput = "one line"
    private val udf = new PythonUDFOpDescV2()
    udf.setOperatorId("udf")
    udf.defaultEnv = false
    udf.envName = environment.name
    udf.retainInputColumns = true
    udf.outputColumns = List(
      new Attribute("tabulate", AttributeType.STRING),
      new Attribute("prefix", AttributeType.STRING)
    )
    udf.code = """from pytexera import *
        |import sys
        |import tabulate
        |
        |class ProcessTupleOperator(UDFOperatorV2):
        |    @overrides
        |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        |        tuple_["tabulate"] = tabulate.__version__
        |        tuple_["prefix"] = sys.prefix
        |        yield tuple_
        |""".stripMargin

    /** The UDF, as the run's errors and consoles name it. */
    val udfId: String = udf.operatorIdentifier.id

    private val savedPlan = PlanToRun
      .make(
        workflowContext(specId),
        fixtureBindings.copy(environments =
          name =>
            if (name == environment.name) environment
            else throw PythonEnvironmentNotResolved.noSuchEnvironment(name)
        ),
        LogicalPlanPojo(
          List(text, udf),
          List(
            LogicalLink(
              text.operatorIdentifier,
              PortIdentity(),
              udf.operatorIdentifier,
              PortIdentity()
            )
          ),
          List(),
          List()
        )
      )
    private val executionPlan = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(savedPlan))
    private val context = executionPlan.context
    written ++= executionPlan.plan.operators.flatMap(op =>
      op.outputPorts.keys.flatMap { port =>
        val base = VFSURIFactory.createPortBaseURI(
          context.workflowId,
          context.executionId,
          GlobalPortIdentity(op.id, port),
          context.warehouse
        )
        Seq(VFSURIFactory.resultURI(base), VFSURIFactory.stateURI(base))
      }
    )
    written += VFSURIFactory.createRuntimeStatisticsURI(context.workflowId, context.executionId)
    written += VFSURIFactory.createConsoleMessagesURI(
      context.workflowId,
      context.executionId,
      udf.operatorIdentifier
    )

    /** What the engine failed with, if it did. */
    val errors = new CopyOnWriteArrayList[Throwable]()

    /** Every state the run was in, in order. */
    val states = new CopyOnWriteArrayList[WorkflowAggregatedState]()

    private val store = new ExecutionStateStore()
    store.metadataStore.updateState(_.withExecutionId(context.executionId))
    private val watchingStates =
      store.metadataStore.getStateObservable.subscribe { metadata: ExecutionMetadataStore =>
        if (states.isEmpty || states.get(states.size - 1) != metadata.state) {
          states.add(metadata.state)
        }
      }
    private val resultService =
      new ExecutionResultService(context.workflowId, specId, new WorkflowStateStore())

    // What fails in the engine ends the run FAILED, as a unit records it.
    private def failed(error: Throwable): Unit = {
      errors.add(error)
      store.transitionTo(FAILED)
    }

    private val service = new WorkflowExecutionService(
      context,
      resultService,
      store,
      failed,
      Some(fixtureUnitMountRoot),
      createAmberRuntime = new AmberClient(system, _, _, _, _)
    )

    /** Starts the run, and answers what it ended as. */
    def end(): ExecutionMetadataStore = {
      val planRow = PlanRecord(
        entryId = ExecutionPlanStore.PlanEntryId,
        body = savedPlan,
        createdBy = specId,
        computingUnitId = specId,
        notification = None
      )
      val planUri = ExecutionPlanStore.planUri(context.workflowId, context.executionId, None)
      service.startStored(executionPlan, planRow, planUri) shouldBe None
      eventually(patience, interval(Span(200, Millis))) {
        Set(COMPLETED, FAILED, KILLED, TERMINATED) should contain(
          store.metadataStore.getState.state
        )
      }
      store.metadataStore.getState
    }

    /** What the unit told the UDF's console, but for its reminders that an install goes on. */
    def told: Seq[ConsoleMessage] =
      store.consoleStore.getState.operatorConsole
        .get(udfId)
        .toSeq
        .flatMap(_.consoleMessages)
        .filter(_.source == ExecutionConsoleService.ComputingUnitSource)
        .filterNot(_.title.startsWith("Still installing"))

    /** The tuples the UDF gave. */
    def results: List[Tuple] =
      readMaterializedResults(store.resultUris, Seq(udf.operatorIdentifier), _.get().toList)(
        udf.operatorIdentifier
      )

    def close(): Unit = {
      watchingStates.dispose()
      service.unsubscribeAll()
      resultService.unsubscribeAll()
    }
  }

  private def withRun(environment: PythonEnvironment)(body: Run => Unit): Unit = {
    val run = new Run(environment)
    try body(run)
    finally run.close()
  }

  /** Fails unless the UDF of `run` imported tabulate 0.9.0 in the interpreter of `tables`. */
  private def assertRanInTables(run: Run): Unit = {
    val results = run.results
    results.map(_.getField[String]("line")) shouldBe List("one line")
    results.map(_.getField[String]("tabulate")) shouldBe List("0.9.0")
    results.map(tuple => Paths.get(tuple.getField[String]("prefix")).toRealPath()) shouldBe
      List(directoryOf(tables).toRealPath())
  }

  "The engine's interpreter" should "say where it imports from and what it holds, the same each time" in {
    val description = engine.description

    description.siteDirectories should not be empty
    description.siteDirectories.foreach(directory =>
      withClue(s"$directory: ")(Files.isDirectory(Paths.get(directory)) shouldBe true)
    )
    // Each package once, pinned to its version: lines pip takes as constraints.
    description.packages.foreach(_ should fullyMatch regex "[A-Za-z0-9][A-Za-z0-9._-]*==[^\\s=]+")
    val names =
      description.packages.map(_.takeWhile(_ != '=').toLowerCase.replaceAll("[-_.]+", "-"))
    names.distinct shouldBe names
    // What a Python worker cannot start without.
    names should contain("pyarrow")
    // The identity names every install: one that changed between two askings would have every
    // environment installed again.
    description.identity should fullyMatch regex "[0-9a-f]{64}"
    new EngineInterpreter(
      PythonUtils.getPythonExecutable,
      ProcessRunner.OperatingSystem
    ).description shouldBe
      description
  }

  "A run whose UDF names a Python environment" should
    "install the environment before its engine starts, and run the UDF in it" in {
    assume(
      !engine.description.packages.exists(_.toLowerCase.startsWith("tabulate==")),
      "the engine's interpreter holds tabulate itself"
    )
    withRun(tables) { run =>
      val ended = run.end()

      withClue(s"${ended.fatalErrors} ${run.errors}: ")(ended.state shouldBe COMPLETED)
      run.errors shouldBe empty
      // The worker ran in the environment, with its package and with the engine's.
      assertRanInTables(run)
      // Installed first, and only then started.
      run.states.asScala.dropWhile(_ != READY) shouldBe Seq(READY, RUNNING, COMPLETED)
      val told = run.told
      told.map(_.msgType).distinct shouldBe Seq(ConsoleMessageType.PRINT)
      told.map(_.title) should have size 2
      told.head.title shouldBe "Installing Python environment 'tables' (1 package)"
      told.head.message shouldBe "tabulate==0.9.0"
      told(
        1
      ).title should fullyMatch regex "Python environment 'tables' is ready \\(\\d+\\.\\d s\\)"
      told(1).message should startWith(
        "It holds, beside the engine's packages:\ntabulate==0.9.0\n\nIts install wrote:\n"
      )
      told(1).message should include("Successfully installed tabulate-0.9.0")
    }
    // What the unit keeps of it: the marker, written last, and its lock beside the directory.
    val marker = markerOf(tables)
    marker.get("digest").asText() shouldBe tables.digest
    marker.get("engineIdentity").asText() shouldBe engine.description.identity
    strings(marker.get("requirements")) shouldBe Seq("tabulate==0.9.0")
    strings(marker.get("installed")) shouldBe Seq("tabulate==0.9.0")
    Files.isRegularFile(lockOf(tables)) shouldBe true
  }

  it should "run in the environment an earlier run installed, and say that it is reused" in {
    installer.ensure(tables, _ => ()).get(5, TimeUnit.MINUTES)
    val installedAt = markerOf(tables).get("finishedAt").asText()

    withRun(tables) { run =>
      val ended = run.end()

      withClue(s"${ended.fatalErrors} ${run.errors}: ")(ended.state shouldBe COMPLETED)
      assertRanInTables(run)
      run.told.map(message => (message.msgType, message.title, message.message)) shouldBe Seq(
        (
          ConsoleMessageType.PRINT,
          "Python environment 'tables' reused",
          "It holds, beside the engine's packages:\ntabulate==0.9.0"
        )
      )
    }
    // Nothing was installed again.
    markerOf(tables).get("finishedAt").asText() shouldBe installedAt
  }

  it should "fail before its engine starts when pip cannot install the environment, in pip's words" in {
    withRun(unreleased) { run =>
      val ended = run.end()

      ended.state shouldBe FAILED
      // No worker started, and nothing failed in the engine.
      run.states.asScala.dropWhile(_ != READY) shouldBe Seq(READY, FAILED)
      run.errors shouldBe empty
      ended.fatalErrors should have size 1
      val error = ended.fatalErrors.head
      error.operatorId shouldBe run.udfId
      error.message should startWith(
        "Python environment 'unreleased' could not be installed: Could not find a version that " +
          "satisfies the requirement tabulate==0.0.0.dev999"
      )
      error.message should endWith("No matching distribution found for tabulate==0.0.0.dev999")
      error.details should include(
        "ERROR: No matching distribution found for tabulate==0.0.0.dev999"
      )
      // The console says that the install began. That it failed is the run's error, said once.
      run.told.map(message => (message.msgType, message.title)) shouldBe Seq(
        (ConsoleMessageType.PRINT, "Installing Python environment 'unreleased' (1 package)")
      )
    }
    // A failed install leaves no directory to take for an environment.
    Files.exists(directoryOf(unreleased)) shouldBe false
  }

  "The unit's installer" should "refuse an environment that asks for another version of a package the engine holds" in {
    // The engine's packages are pinned for every environment: pip adds to them, and replaces
    // none.
    assume(anotherSix.isDefined, "the engine's interpreter holds no six")
    val environment = anotherSix.get

    val failure = the[ExecutionException] thrownBy
      installer.ensure(environment, _ => ()).get(5, TimeUnit.MINUTES)

    failure.getCause shouldBe an[InstallFailed]
    val reason = failure.getCause.asInstanceOf[InstallFailed].reason
    reason should include(environment.requirements.head)
    reason should include("conflicting dependencies")
    Files.exists(directoryOf(environment)) shouldBe false
  }
}
