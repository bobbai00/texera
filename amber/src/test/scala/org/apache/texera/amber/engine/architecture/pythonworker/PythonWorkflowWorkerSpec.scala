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

package org.apache.texera.amber.engine.architecture.pythonworker

import com.twitter.util.Promise
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.testkit.{ImplicitSender, TestActorRef, TestKit}
import org.apache.texera.amber.core.storage.CatalogIdentity
import org.apache.texera.amber.core.virtualidentity.{
  ActorVirtualIdentity,
  ChannelIdentity,
  ExecutionIdentity
}
import org.apache.texera.amber.core.workflow.PythonEnvironment
import org.apache.texera.amber.engine.architecture.common.WorkflowActor
import org.apache.texera.amber.engine.architecture.common.WorkflowActor.{NetworkAck, NetworkMessage}
import org.apache.texera.amber.engine.architecture.pythonworker.environment.{
  FakePython,
  PythonEnvironmentInstaller
}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  AsyncRPCContext,
  ControlInvocation,
  EmptyRequest
}
import org.apache.texera.amber.engine.common.ambermessage.WorkflowFIFOMessage
import org.apache.texera.amber.engine.common.ambermessage.WorkflowMessage.getInMemSize
import org.apache.texera.amber.engine.architecture.scheduling.config.{CatalogToken, WorkerConfig}
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.common.config.UdfConfig
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers

import java.lang.reflect.InvocationTargetException
import java.nio.file.{Files, Path}
import java.util.concurrent.{ExecutorService, TimeUnit}
import java.util.concurrent.atomic.AtomicBoolean
import scala.concurrent.duration._
import scala.util.Using
import scala.sys.process.Process

/**
  * Unit tests for the Python worker actor.
  *
  * The worker's `initState` starts a proxy server, spawns a real Python interpreter and starts a
  * Flight client, none of which belongs in a unit test and none of which is guaranteed to exist on
  * a CI runner. The class offers no seam for that, but `initState` is an ordinary override, so the
  * suite subclasses the worker and makes it a no-op. Everything below then runs against a real
  * actor instance with nothing spawned.
  *
  * Two members are read by reflection because they are `private`: `choosePythonBin`, which has no
  * caller other than the process-spawning path, and the executors/port promise, which the teardown
  * assertions need. Reflection into `private` members is an established pattern in this module's
  * specs. `portNumberPromise` in particular has to be fulfilled before anything touches
  * `pythonProxyClient`: that client blocks in its own constructor on `Await.result(promise)`, so a
  * worker whose proxy server never started would otherwise hang the moment `postStop` ran.
  *
  * The worker's unit keeps its Python environments where a [[FakePython]]'s installer does, under
  * a directory of this suite's: no interpreter and no pip runs.
  *
  * Out of scope, deliberately: a `startPythonProcess` that gets as far as running a real
  * interpreter, and `startProxyServer`, which retries a socket bind until it succeeds.
  */
class PythonWorkflowWorkerSpec
    extends TestKit(ActorSystem("PythonWorkflowWorkerSpec", AmberRuntime.pekkoConfig))
    with ImplicitSender
    with AnyFlatSpecLike
    with Matchers
    with BeforeAndAfterAll {

  /** Where the unit of the workers below installs its environments. */
  private val environmentsRoot: Path = Files.createTempDirectory("python-workflow-worker-spec")
  private val python = new FakePython()
  private val unitEnvironments: PythonEnvironmentInstaller =
    python.installer(environmentsRoot, FakePython.SameThread)

  /** An environment installed on the unit, and one that is not. */
  private val installed = PythonEnvironment("installed", Seq("tabulate==0.9.0"))
  private val absent = PythonEnvironment("absent", Seq("requests"))

  override def beforeAll(): Unit =
    unitEnvironments.ensure(installed, _ => ()).get(30, TimeUnit.SECONDS)

  override def afterAll(): Unit = {
    deleteRecursively(environmentsRoot)
    TestKit.shutdownActorSystem(system)
  }

  /** The worker with its process/socket startup removed; see the class comment. */
  private class InertPythonWorkflowWorker(config: WorkerConfig)
      extends PythonWorkflowWorker(config, unitEnvironments) {
    override def initState(): Unit = ()
  }

  /** Stands in for the OS process the worker would have spawned. */
  private class RecordingProcess(failOnDestroy: Boolean = false) extends Process {
    val destroyed = new AtomicBoolean(false)
    override def isAlive(): Boolean = !destroyed.get()
    override def exitValue(): Int = 0
    override def destroy(): Unit = {
      destroyed.set(true)
      if (failOnDestroy) throw new IllegalStateException("destroy failed")
    }
  }

  private def newWorker(config: WorkerConfig): TestActorRef[InertPythonWorkflowWorker] =
    TestActorRef[InertPythonWorkflowWorker](new InertPythonWorkflowWorker(config))

  private def config(environment: Option[PythonEnvironment] = None): WorkerConfig =
    WorkerConfig(ActorVirtualIdentity("python-worker-spec"), pythonEnvironment = environment)

  private def readPrivate[T](actor: PythonWorkflowWorker, name: String): T = {
    val method = classOf[PythonWorkflowWorker].getDeclaredMethod(name)
    method.setAccessible(true)
    method.invoke(actor).asInstanceOf[T]
  }

  private def chosenPythonBin(actor: PythonWorkflowWorker): String =
    readPrivate[String](actor, "choosePythonBin")

  /** What a private member of the worker, called by reflection, failed with. */
  private def failureOf(call: => Any): Throwable =
    intercept[InvocationTargetException](call).getCause

  /** Releases the port the proxy client's constructor blocks on. */
  private def openPort(actor: PythonWorkflowWorker, port: Int = 65535): Unit =
    readPrivate[Promise[Int]](actor, "portNumberPromise").setValue(port)

  private def setServerProcess(actor: PythonWorkflowWorker, process: Process): Unit = {
    val setter =
      classOf[PythonWorkflowWorker].getDeclaredMethod("pythonServerProcess_$eq", classOf[Process])
    setter.setAccessible(true)
    setter.invoke(actor, process)
  }

  private def deleteRecursively(path: Path): Unit = {
    if (Files.exists(path)) {
      // Files.walk holds an open directory handle, so it has to be closed; on Windows an
      // open handle also blocks the deletion it is feeding.
      Using.resource(Files.walk(path)) { paths =>
        paths
          .sorted(java.util.Comparator.reverseOrder[Path]())
          .forEach(p => Files.deleteIfExists(p))
      }
    }
  }

  /**
    * The proxy client the worker builds for itself. Its accessor is name-mangled because the
    * field is captured by a closure, so it is found by suffix rather than spelled out.
    */
  private def proxyClient(actor: PythonWorkflowWorker): PythonProxyClient = {
    val accessors = classOf[PythonWorkflowWorker].getDeclaredMethods
      .filter(m => m.getName.endsWith("pythonProxyClient") && m.getParameterCount == 0)
    accessors should have size 1
    accessors.head.setAccessible(true)
    accessors.head.invoke(actor).asInstanceOf[PythonProxyClient]
  }

  /** The client's main-loop flag, which `close()` clears. */
  private def isClientRunning(client: PythonProxyClient): Boolean = {
    val field = classOf[PythonProxyClient].getDeclaredField("running")
    field.setAccessible(true)
    field.getBoolean(client)
  }

  behavior of "PythonWorkflowWorker"

  it should "resolve the Python sources under the amber home" in {
    val worker = newWorker(config())
    val path = worker.underlyingActor.pythonSrcDirectory

    // Asserted by tail rather than as an absolute string: the amber home moves with the checkout.
    path.getFileName.toString shouldBe "python"
    path.getParent.getFileName.toString shouldBe "main"
    path.getParent.getParent.getFileName.toString shouldBe "src"
  }

  it should "expose the configured R path with its surrounding whitespace removed" in {
    val worker = newWorker(config())

    worker.underlyingActor.RENVPath shouldBe UdfConfig.rPath.trim
    worker.underlyingActor.RENVPath shouldBe worker.underlyingActor.RENVPath.trim
  }

  it should "run the engine's interpreter when its operator asks for no environment" in {
    val worker = newWorker(config())

    chosenPythonBin(worker.underlyingActor) shouldBe python.executable
  }

  it should "run the interpreter of its operator's environment, as the unit installed it" in {
    val worker = newWorker(config(Some(installed)))

    val interpreter = chosenPythonBin(worker.underlyingActor)

    interpreter shouldBe unitEnvironments.interpreterFor(Some(installed))
    interpreter should not be python.executable
    Files.isExecutable(Path.of(interpreter)) shouldBe true
    Path.of(interpreter).startsWith(environmentsRoot) shouldBe true
  }

  it should "fail, rather than run another interpreter, when its operator's environment is not installed on the unit" in {
    val worker = newWorker(config(Some(absent)))

    val failure = failureOf(chosenPythonBin(worker.underlyingActor))

    failure shouldBe an[IllegalStateException]
    failure.getMessage shouldBe
      "Python environment 'absent' is not installed on this computing unit."
  }

  it should "start no process when it has no interpreter to run" in {
    val worker = newWorker(config(Some(absent)))
    val actor = worker.underlyingActor

    val failure = failureOf(readPrivate[Unit](actor, "startPythonProcess"))

    failure.getMessage shouldBe
      "Python environment 'absent' is not installed on this computing unit."
    readPrivate[Process](actor, "pythonServerProcess") shouldBe null
  }

  it should "close the proxy client, stop both executors and destroy the process on shutdown" in {
    val worker = newWorker(config())
    val actor = worker.underlyingActor
    openPort(actor)
    val process = new RecordingProcess()
    setServerProcess(actor, process)
    val client = proxyClient(actor)
    val clientExecutor = readPrivate[ExecutorService](actor, "clientThreadExecutor")
    val serverExecutor = readPrivate[ExecutorService](actor, "serverThreadExecutor")
    isClientRunning(client) shouldBe true

    watch(worker)
    system.stop(worker)
    expectTerminated(worker, 10.seconds)

    // close() clears the client's main-loop flag, so this fails if the call is dropped.
    isClientRunning(client) shouldBe false
    clientExecutor.isShutdown shouldBe true
    serverExecutor.isShutdown shouldBe true
    process.destroyed.get() shouldBe true
  }

  it should "not let a failing teardown step escape postStop" in {
    val worker = newWorker(config())
    val actor = worker.underlyingActor
    openPort(actor)
    val process = new RecordingProcess(failOnDestroy = true)
    setServerProcess(actor, process)
    val client = proxyClient(actor)
    val clientExecutor = readPrivate[ExecutorService](actor, "clientThreadExecutor")
    val serverExecutor = readPrivate[ExecutorService](actor, "serverThreadExecutor")

    watch(worker)
    system.stop(worker)

    // The actor still terminates, and the steps that ran before the failure still took effect.
    expectTerminated(worker, 10.seconds)
    isClientRunning(client) shouldBe false
    clientExecutor.isShutdown shouldBe true
    serverExecutor.isShutdown shouldBe true
    process.destroyed.get() shouldBe true
  }

  it should "answer a credit request with the credit currently queued for that channel" in {
    val worker = newWorker(config())
    openPort(worker.underlyingActor)
    val channel =
      ChannelIdentity(
        ActorVirtualIdentity("upstream"),
        ActorVirtualIdentity("downstream"),
        isControl = true
      )

    val client = proxyClient(worker.underlyingActor)

    worker ! WorkflowActor.CreditRequest(channel)

    // The request also pushes a CreditUpdate down to the Python side.
    client.getControlQueueLength shouldBe 1
    val response = expectMsgType[WorkflowActor.CreditResponse](10.seconds)
    response.channelId shouldBe channel
    // Nothing has been handed to the Python side, so it is holding nothing.
    response.credit shouldBe 0L
  }

  it should "stay responsive after backpressure is pushed to the Python side" in {
    val worker = newWorker(config())
    openPort(worker.underlyingActor)
    val channel =
      ChannelIdentity(
        ActorVirtualIdentity("upstream"),
        ActorVirtualIdentity("downstream"),
        isControl = true
      )

    val client = proxyClient(worker.underlyingActor)

    worker.underlyingActor.handleBackpressure(true)
    worker.underlyingActor.handleBackpressure(false)

    // Both commands are queued for the Python process rather than answered here.
    client.getControlQueueLength shouldBe 2
    // The actor also keeps serving its own protocol afterwards.
    worker ! WorkflowActor.CreditRequest(channel)
    expectMsgType[WorkflowActor.CreditResponse](10.seconds).channelId shouldBe channel
  }

  it should "hand a control payload to the Python side and acknowledge the message" in {
    val worker = newWorker(config())
    openPort(worker.underlyingActor)
    val channel =
      ChannelIdentity(
        ActorVirtualIdentity("upstream"),
        ActorVirtualIdentity("python-worker-spec"),
        isControl = true
      )
    val payload =
      ControlInvocation(
        "method",
        EmptyRequest(),
        AsyncRPCContext(channel.fromWorkerId, channel.toWorkerId),
        0
      )
    val message = WorkflowFIFOMessage(channel, 0, payload)
    val client = proxyClient(worker.underlyingActor)
    client.getControlQueueLength shouldBe 0

    worker ! NetworkMessage(7L, message)

    // The payload is handed to the Python side, not just acknowledged.
    client.getControlQueueLength shouldBe 1
    val ack = expectMsgType[NetworkAck](10.seconds)
    ack.messageId shouldBe 7L
    ack.ackedCredit shouldBe getInMemSize(message)
    // The payload is queued for the Python process, which holds no data of its own here.
    ack.queuedCredit shouldBe 0L
  }

  it should "refuse to load from a checkpoint" in {
    val worker = newWorker(config())

    a[NotImplementedError] should be thrownBy worker.underlyingActor.loadFromCheckpoint(null)
  }

  it should "hold its execution's token in its JVM as it starts" in {
    val eid = ExecutionIdentity(9643001L)
    CatalogIdentity.registered(eid.id) shouldBe None

    // Made, with no process started: the process gets the token in its environment
    // (PythonWorkflowWorkerStartupConfigSpec).
    newWorker(
      WorkerConfig(
        ActorVirtualIdentity("python-worker-spec"),
        executionId = eid,
        catalogToken = CatalogToken("t-9643001")
      )
    )

    CatalogIdentity.registered(eid.id) shouldBe Some("t-9643001")
  }
}
