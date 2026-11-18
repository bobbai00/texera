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

package org.apache.texera.web.service

import io.reactivex.rxjava3.disposables.Disposable
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  PhysicalLink,
  PhysicalOp,
  PhysicalPlan,
  PortIdentity,
  PythonEnvironment,
  PythonEnvironmentRef,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.coordinator.CoordinatorConfig
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller.Reused
import org.apache.texera.amber.engine.architecture.pythonworker.environment.{
  FakePython,
  ProcessOutcome,
  PythonEnvironmentInstaller
}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessageType
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.web.WebsocketInput
import org.apache.texera.web.service.ExecutionEnvironmentService.EnvironmentNotInstalled
import org.apache.texera.web.storage.ExecutionStateStore
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}

import java.nio.file.{Files, Path}
import java.util.Comparator
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.{
  CompletableFuture,
  CopyOnWriteArrayList,
  CountDownLatch,
  ExecutionException,
  ExecutorService,
  Executors,
  TimeUnit,
  TimeoutException
}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters.CollectionHasAsScala
import scala.reflect.ClassTag
import scala.util.Using

/**
  * What a run tells its operators' consoles while its plan's Python environments are made ready,
  * on a [[FakePython]]: no interpreter and no pip runs. What the consoles are told is recorded
  * here, on an [[ExecutionConsoleService]] that no engine is behind; what a console does with a
  * message of the unit's is `ExecutionConsoleServiceSpec`'s, and what a run does once its
  * environments are ready, or one is not, is `WorkflowExecutionServiceSpec`'s.
  */
class ExecutionEnvironmentServiceSpec
    extends TestKit(ActorSystem("ExecutionEnvironmentServiceSpec"))
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll
    with Eventually {

  // For what the installer's threads are about to do.
  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(10, Seconds), interval = Span(20, Millis))

  private val scratch: Path = Files.createTempDirectory("execution-environment-service-spec")
  private val threads: ExecutorService = Executors.newCachedThreadPool()

  override def afterAll(): Unit = {
    threads.shutdownNow()
    Using.resource(Files.walk(scratch)) { paths =>
      paths.sorted(Comparator.reverseOrder[Path]()).forEach(path => Files.deleteIfExists(path))
    }
    TestKit.shutdownActorSystem(system)
  }

  private val ml = PythonEnvironment("ml", Seq("numpy>=2.1.0", "tabulate==0.9.0"))
  private val plots = PythonEnvironment("plots", Seq("tabulate==0.9.0"))

  private def opId(name: String, layer: String = "main"): PhysicalOpIdentity =
    PhysicalOpIdentity(OperatorIdentity(name), layer)

  private def operator(
      name: String,
      environment: PythonEnvironmentRef,
      layer: String = "main"
  ): PhysicalOp =
    PhysicalOp(
      opId(name, layer),
      WorkflowIdentity(1),
      ExecutionIdentity(1),
      OpExecWithClassName("unused"),
      pythonEnvironment = environment
    )

  private def in(environment: PythonEnvironment): PythonEnvironmentRef =
    PythonEnvironmentRef.Resolved(environment)

  /** A plan of `operators`, each feeding the next. */
  private def chain(operators: PhysicalOp*): PhysicalPlan =
    PhysicalPlan(
      operators.toSet,
      operators
        .sliding(2)
        .collect {
          case Seq(from, to) => PhysicalLink(from.id, PortIdentity(), to.id, PortIdentity())
        }
        .toSet
    )

  /** A root of its own for a case, so no case finds what another installed. */
  private def newRoot(): Path = Files.createTempDirectory(scratch, "root")

  /** A message of the unit's that an operator's console was told. */
  private case class Told(msgType: ConsoleMessageType, title: String, message: String)

  /**
    * The consoles of a run that no engine is behind, and the service that tells them what
    * becomes of the environments `installer` installs for the run.
    */
  private final class Run(
      plan: PhysicalPlan,
      val installer: PythonEnvironmentInstaller,
      reminderInterval: FiniteDuration = 1.hour
  ) {
    val awaited = new AtomicBoolean(true)
    private val told = new CopyOnWriteArrayList[(String, Told)]()
    private val client = new AmberClient(
      system,
      new WorkflowContext(),
      PhysicalPlan(Set.empty, Set.empty),
      CoordinatorConfig(None, None, None, None),
      _ => ()
    ) {
      override def registerCallback[T](callback: T => Unit)(implicit ct: ClassTag[T]): Disposable =
        Disposable.empty()
    }
    private val console = new ExecutionConsoleService(
      client,
      new ExecutionStateStore(),
      new WebsocketInput(),
      new WorkflowContext()
    ) {
      override def addUnitMessage(
          operatorId: String,
          msgType: ConsoleMessageType,
          title: String,
          message: String
      ): Unit = told.add(operatorId -> Told(msgType, title, message))
    }
    val service = new ExecutionEnvironmentService(
      plan,
      console,
      installer,
      () => awaited.get(),
      reminderInterval
    )

    /** The operators whose consoles were told anything. */
    def operatorsTold: Set[String] = told.asScala.map(_._1).toSet

    /** What `operator`'s console was told, in order. */
    def toldTo(operator: String): Seq[Told] =
      told.asScala.collect { case (`operator`, message) => message }.toList

    def titlesTo(operator: String): Seq[String] = toldTo(operator).map(_.title)

    def close(): Unit = {
      console.unsubscribeAll()
      client.shutdown()
    }
  }

  /** Runs `body` on a run of `plan`, on a unit that installs on `python` under `root`. */
  private def withRun(
      plan: PhysicalPlan,
      python: FakePython = new FakePython(),
      root: Path = newRoot(),
      reminderInterval: FiniteDuration = 1.hour
  )(body: Run => Any): Unit = {
    val run = new Run(plan, python.installer(root, threads), reminderInterval)
    try body(run)
    finally run.close()
  }

  private def await(prepared: CompletableFuture[Unit]): Unit = prepared.get(30, TimeUnit.SECONDS)

  private def failureOf(prepared: CompletableFuture[Unit]): Throwable =
    intercept[ExecutionException](await(prepared)).getCause

  private val readyTitle = """Python environment 'ml' is ready \(\d+\.\d s\)"""

  // ----- which environments a plan needs -----

  "ExecutionEnvironmentService.environmentsOf" should
    "name each environment once, with the operators that run in it, as the plan reaches them" in {
    val plan = chain(
      operator("scan", PythonEnvironmentRef.EngineDefault),
      operator("udf-b", in(plots)),
      operator("udf-a", in(ml)),
      operator("udf-c", in(plots)),
      // Two layers of one operator are one operator to its console.
      operator("udf-d", in(ml), layer = "first"),
      operator("udf-d", in(ml), layer = "second")
    )

    ExecutionEnvironmentService.environmentsOf(plan) shouldBe Seq(
      plots -> Seq(OperatorIdentity("udf-b"), OperatorIdentity("udf-c")),
      ml -> Seq(OperatorIdentity("udf-a"), OperatorIdentity("udf-d"))
    )
  }

  it should "name none for a plan whose operators all run in the engine's own" in {
    val plan = chain(
      operator("scan", PythonEnvironmentRef.EngineDefault),
      operator("udf", PythonEnvironmentRef.EngineDefault)
    )

    ExecutionEnvironmentService.environmentsOf(plan) shouldBe empty
  }

  // ----- what the consoles are told -----

  "ExecutionEnvironmentService" should "have nothing to prepare for a plan that names no environment" in {
    val python = new FakePython()
    withRun(chain(operator("scan", PythonEnvironmentRef.EngineDefault)), python) { run =>
      val prepared = run.service.prepare()

      // Ready where it is asked, with nothing asked of the installer.
      prepared.isDone shouldBe true
      await(prepared)
      python.runs shouldBe empty
      run.operatorsTold shouldBe empty
    }
  }

  it should "tell each operator of an environment that it is installed, and then what it holds" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val plan = chain(
      operator("scan", PythonEnvironmentRef.EngineDefault),
      operator("udf-a", in(ml)),
      operator("udf-b", in(ml))
    )
    withRun(plan, python) { run =>
      val prepared = run.service.prepare()
      held.awaitBegun() shouldBe true

      // While pip runs, each operator of the environment knows, and the run is not ready.
      eventually(
        run.titlesTo("udf-a") shouldBe Seq("Installing Python environment 'ml' (2 packages)")
      )
      run.titlesTo("udf-b") shouldBe run.titlesTo("udf-a")
      run.toldTo("udf-a").head.message shouldBe "numpy>=2.1.0\ntabulate==0.9.0"
      prepared.isDone shouldBe false
      held.letGo()
      await(prepared)

      Seq("udf-a", "udf-b").foreach { udf =>
        val told = run.toldTo(udf)
        told should have size 2
        told(1).title should fullyMatch regex readyTitle
        told(1).message shouldBe
          """It holds, beside the engine's packages:
            |numpy==2.1.0
            |tabulate==0.9.0
            |
            |Its install wrote:
            |Collecting numpy>=2.1.0
            |Collecting tabulate==0.9.0
            |Successfully installed numpy>=2.1.0 tabulate==0.9.0""".stripMargin
        told.map(_.msgType).distinct shouldBe Seq(ConsoleMessageType.PRINT)
      }
      // An operator in the engine's own environment is told nothing.
      run.operatorsTold shouldBe Set("udf-a", "udf-b")
    }
  }

  it should "be ready only once every environment of its plan is" in {
    val python = new FakePython()
    val mlBegun = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    val install = python.pipInstall
    python.pipInstall = requirements => {
      if (requirements == ml.requirements) {
        mlBegun.countDown()
        release.await(30, TimeUnit.SECONDS)
      }
      install(requirements)
    }
    val plan = chain(operator("plot", in(plots)), operator("train", in(ml)))
    withRun(plan, python) { run =>
      val prepared = run.service.prepare()
      mlBegun.await(30, TimeUnit.SECONDS) shouldBe true

      // One environment is ready while the other is still being installed: the run is not.
      eventually(run.titlesTo("plot") should have size 2)
      run.titlesTo("plot").last should startWith("Python environment 'plots' is ready")
      a[TimeoutException] should be thrownBy prepared.get(300, TimeUnit.MILLISECONDS)
      release.countDown()
      await(prepared)

      run.titlesTo("train").last should startWith("Python environment 'ml' is ready")
    }
  }

  it should "count one package as one" in {
    withRun(chain(operator("udf", in(plots)))) { run =>
      await(run.service.prepare())

      run.titlesTo("udf").head shouldBe "Installing Python environment 'plots' (1 package)"
    }
  }

  it should "say that an environment installed before is reused, and what it holds" in {
    val python = new FakePython()
    val root = newRoot()
    python.installer(root, FakePython.SameThread).ensure(ml, _ => ()).get(30, TimeUnit.SECONDS)

    withRun(chain(operator("udf", in(ml))), python, root) { run =>
      await(run.service.prepare())

      run.toldTo("udf").map(told => (told.title, told.message)) shouldBe Seq(
        (
          "Python environment 'ml' reused",
          "It holds, beside the engine's packages:\nnumpy==2.1.0\ntabulate==0.9.0"
        )
      )
      python.pipInstalls should have size 1
    }
  }

  it should "say so when the environment holds nothing beside the engine's packages" in {
    val bare = PythonEnvironment("bare", Seq.empty)
    withRun(chain(operator("udf", in(bare)))) { run =>
      await(run.service.prepare())

      val told = run.toldTo("udf")
      told.map(_.title).head shouldBe "Installing Python environment 'bare' (0 packages)"
      told(1).message should startWith("It holds no package beside the engine's own.\n\n")
    }
  }

  it should "tell a run that waits for an install another run began that it waits" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val plan = chain(operator("udf", in(ml)))
    withRun(plan, python) { first =>
      val firstPrepared = first.service.prepare()
      held.awaitBegun() shouldBe true
      // Another run on the same unit, so with the same installer.
      val second = new Run(plan, first.installer)
      try {
        val secondPrepared = second.service.prepare()
        eventually(
          second.titlesTo("udf") shouldBe
            Seq("Waiting for Python environment 'ml', which is already being installed")
        )
        held.letGo()
        await(firstPrepared)
        await(secondPrepared)

        // It is handed the same install, with what it wrote.
        second.toldTo("udf")(1).title should fullyMatch regex readyTitle
        second.toldTo("udf")(1).message shouldBe first.toldTo("udf")(1).message
        python.pipInstalls should have size 1
      } finally second.close()
    }
  }

  it should "remind the operators of a long install, until it ends" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    withRun(chain(operator("udf", in(ml))), python, reminderInterval = 50.millis) { run =>
      val prepared = run.service.prepare()
      held.awaitBegun() shouldBe true

      eventually(run.titlesTo("udf").count(_.startsWith("Still installing")) should be >= 2)
      run.titlesTo("udf").filter(_.startsWith("Still installing")).foreach { reminder =>
        reminder should fullyMatch regex """Still installing Python environment 'ml' \(\d+ s\)"""
      }
      held.letGo()
      await(prepared)

      // Once it is ready, the reminders end.
      run.titlesTo("udf").count(_.matches(readyTitle)) shouldBe 1
      Thread.sleep(150)
      val told = run.titlesTo("udf").size
      Thread.sleep(250)
      run.titlesTo("udf") should have size told
    }
  }

  it should "tell a run that is no longer awaited nothing more, while its install goes on" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    withRun(chain(operator("udf", in(ml))), python, reminderInterval = 50.millis) { run =>
      val prepared = run.service.prepare()
      held.awaitBegun() shouldBe true
      eventually(run.titlesTo("udf") should not be empty)

      // Killed, say: from here on its consoles are left alone, reminders included.
      run.awaited.set(false)
      Thread.sleep(150)
      val toldUntilThen = run.titlesTo("udf")
      Thread.sleep(250)
      held.letGo()
      await(prepared)

      run.titlesTo("udf") shouldBe toldUntilThen
      // The install was the unit's to finish: the next run finds it.
      run.installer.ensure(ml, _ => ()).get(30, TimeUnit.SECONDS) shouldBe a[Reused]
    }
  }

  // ----- an environment that cannot be installed -----

  it should "fail with the environment that could not be installed, its operators and pip's words" in {
    val python = new FakePython()
    val pipSaid = Seq(
      "Collecting numpy>=2.1.0",
      "ERROR: No matching distribution found for tabulate==0.9.0"
    )
    python.pipInstall = _ => ProcessOutcome(Some(1), pipSaid)
    val plan = chain(operator("udf-first", in(ml)), operator("udf-second", in(ml)))
    withRun(plan, python) { run =>
      val failure = failureOf(run.service.prepare())

      failure shouldBe an[EnvironmentNotInstalled]
      val notInstalled = failure.asInstanceOf[EnvironmentNotInstalled]
      notInstalled.environment shouldBe ml
      notInstalled.operators shouldBe
        Seq(OperatorIdentity("udf-first"), OperatorIdentity("udf-second"))
      notInstalled.getMessage shouldBe
        "Python environment 'ml' could not be installed: No matching distribution found for " +
          "tabulate==0.9.0"
      notInstalled.details shouldBe pipSaid.mkString("\n")
      // The failure is the run's to report: the consoles are told nothing of it.
      run.titlesTo("udf-first") shouldBe Seq("Installing Python environment 'ml' (2 packages)")
    }
  }

  it should "give why an install failed as its details when the install wrote nothing" in {
    val python = new FakePython()
    python.describe = () => ProcessOutcome(Some(127), Seq("python: command not found"))
    withRun(chain(operator("udf", in(ml))), python) { run =>
      val notInstalled = failureOf(run.service.prepare()).asInstanceOf[EnvironmentNotInstalled]

      notInstalled.details should endWith("it exited with 127: python: command not found")
      notInstalled.getMessage shouldBe
        s"Python environment 'ml' could not be installed: ${notInstalled.details}"
    }
  }

  it should "fail as soon as one environment cannot be installed, while another's install goes on" in {
    val python = new FakePython()
    val plotsStarted = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    val succeed = python.pipInstall
    python.pipInstall = requirements =>
      if (requirements == ml.requirements) ProcessOutcome(Some(1), Seq("ERROR: no numpy today"))
      else {
        plotsStarted.countDown()
        release.await(30, TimeUnit.SECONDS)
        succeed(requirements)
      }
    val plan = chain(operator("plot", in(plots)), operator("train", in(ml)))
    withRun(plan, python) { run =>
      val prepared = run.service.prepare()
      plotsStarted.await(30, TimeUnit.SECONDS) shouldBe true

      val notInstalled = failureOf(prepared).asInstanceOf[EnvironmentNotInstalled]
      notInstalled.environment shouldBe ml
      notInstalled.operators shouldBe Seq(OperatorIdentity("train"))
      // The other environment is still being installed, and is installed to its end.
      run.titlesTo("plot") shouldBe Seq("Installing Python environment 'plots' (1 package)")
      release.countDown()
      eventually(run.titlesTo("plot") should have size 2)
      run.titlesTo("plot").last should startWith("Python environment 'plots' is ready")
    }
  }
}
