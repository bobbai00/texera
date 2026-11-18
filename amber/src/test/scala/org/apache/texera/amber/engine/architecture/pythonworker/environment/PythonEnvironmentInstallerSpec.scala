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

package org.apache.texera.amber.engine.architecture.pythonworker.environment

import org.apache.texera.amber.core.workflow.PythonEnvironment
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller.{
  InstallFailed,
  Installed,
  Installing,
  Joining,
  Ready,
  Reused,
  Wait
}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Millis, Seconds, Span}

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path}
import java.security.MessageDigest
import java.time.Instant
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
import java.util.{Comparator, HexFormat}
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters.{CollectionHasAsScala, IteratorHasAsScala}
import scala.util.Using

/**
  * The installer, on a [[FakePython]]: no interpreter and no pip runs, and what they would leave
  * on disk is left under a directory of this suite's. What a real interpreter and a real pip do
  * with the installer's commands is the integration suite's to show
  * (`PythonEnvironmentIntegrationSpec`).
  */
class PythonEnvironmentInstallerSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with Eventually {

  // For what another thread is about to do.
  implicit override val patienceConfig: PatienceConfig =
    PatienceConfig(timeout = Span(10, Seconds), interval = Span(20, Millis))

  private val scratch: Path = Files.createTempDirectory("python-environment-installer-spec")
  private val threads: ExecutorService = Executors.newCachedThreadPool()

  override protected def afterAll(): Unit = {
    threads.shutdownNow()
    Using.resource(Files.walk(scratch)) { paths =>
      paths.sorted(Comparator.reverseOrder[Path]()).forEach(path => Files.deleteIfExists(path))
    }
  }

  /** A root of its own for a case, so no case finds what another installed. */
  private def newRoot(): Path = Files.createTempDirectory(scratch, "root")

  private val ml = PythonEnvironment("ml", Seq("numpy>=2.1.0", "requests", "tabulate==0.9.0"))
  private val plots = PythonEnvironment("plots", Seq("tabulate==0.9.0"))

  private def sha256Hex(text: String): String =
    HexFormat
      .of()
      .formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)))

  /** The directory `environment` is installed in under `root`, on `python`. */
  private def directoryOf(root: Path, environment: PythonEnvironment, python: FakePython): Path =
    root.resolve(sha256Hex(s"${environment.digest}\n${sha256Hex(python.description)}").take(32))

  /** What an install is told while it waits, as it was told. */
  private final class Waits extends (Wait => Unit) {
    private val told = new CopyOnWriteArrayList[Wait]()
    override def apply(wait: Wait): Unit = told.add(wait)
    def all: Seq[Wait] = told.asScala.toList
  }

  private def await(ready: CompletableFuture[Ready]): Ready = ready.get(30, TimeUnit.SECONDS)

  private def failureOf(ready: CompletableFuture[Ready]): InstallFailed =
    intercept[ExecutionException](await(ready)).getCause match {
      case failed: InstallFailed => failed
      case other                 => fail(s"failed with $other, not with an InstallFailed")
    }

  private def entriesOf(root: Path): Set[String] =
    Using.resource(Files.list(root))(_.iterator().asScala.map(_.getFileName.toString).toSet)

  private def linesOf(file: Path): Seq[String] = Files.readAllLines(file).asScala.toList

  // ----- a first install -----

  "PythonEnvironmentInstaller" should
    "install an environment the first time it is asked for, in a directory named by its key" in {
    val python = new FakePython()
    val root = newRoot()
    val waits = new Waits
    val before = Instant.now()

    val ready = await(python.installer(root, FakePython.SameThread).ensure(ml, waits))

    val directory = directoryOf(root, ml, python)
    directory.getFileName.toString should fullyMatch regex "[0-9a-f]{32}"
    val interpreter = directory.resolve("bin").resolve("python")
    ready shouldBe Installed(
      interpreter,
      packages = Seq("numpy==2.1.0", "requests==1.0", "tabulate==0.9.0"),
      log = Seq(
        "Collecting numpy>=2.1.0",
        "Collecting requests",
        "Collecting tabulate==0.9.0",
        "Successfully installed numpy>=2.1.0 requests tabulate==0.9.0"
      )
    )
    waits.all shouldBe Seq(Installing)
    // Built by the engine's interpreter, in place, and filled by the environment's own pip.
    val requirements = directory.resolve("texera-requirements.txt")
    val constraints = directory.resolve("texera-constraints.txt")
    python.runs.map(_.command).drop(1) shouldBe Seq(
      Seq(python.executable, "-m", "venv", directory.toString),
      Seq(interpreter.toString, "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"),
      Seq(
        interpreter.toString,
        "-m",
        "pip",
        "install",
        "--no-input",
        "--progress-bar",
        "off",
        "--disable-pip-version-check",
        "-r",
        requirements.toString,
        "-c",
        constraints.toString
      ),
      Seq(interpreter.toString, "-m", "pip", "freeze", "--local")
    )
    python.pipInstalls.map(_.environment) shouldBe
      Seq(Map("PYTHONUNBUFFERED" -> "1", "PIP_NO_INPUT" -> "1"))
    // pip is given the environment's lines, as they are.
    linesOf(requirements) shouldBe ml.requirements
    // Its marker, written last, says what was installed, on which interpreter, and when.
    val marker = objectMapper.readTree(directory.resolve("texera-environment.json").toFile)
    marker.fieldNames().asScala.toSet shouldBe
      Set("digest", "engineIdentity", "requirements", "installed", "seconds", "finishedAt")
    marker.get("digest").asText() shouldBe ml.digest
    marker.get("engineIdentity").asText() shouldBe sha256Hex(python.description)
    marker.get("requirements").elements().asScala.map(_.asText()).toList shouldBe ml.requirements
    marker.get("installed").elements().asScala.map(_.asText()).toList shouldBe ready.packages
    marker.get("seconds").asDouble() should be >= 0.0
    Instant.parse(marker.get("finishedAt").asText()) should (be >= before and be <= Instant.now())
    Files.exists(directory.resolve("texera-environment.json.tmp")) shouldBe false
    // Nothing else is left under the root but the lock that kept other installers out.
    entriesOf(root) shouldBe Set(directory.getFileName.toString, s"${directory.getFileName}.lock")
  }

  it should "make the environment import the engine's packages, and hold them to the engine's versions" in {
    val python = new FakePython(
      siteDirectories = Seq("/home/te'xera/.local/site", "C:\\engine\\Lib\\site-packages"),
      packages = Seq("Pip==24.0", "numpy==2.1.0", "pandas==2.2.3", "pip-tools==7.4.1", "pip==24.0")
    )
    val root = newRoot()

    await(python.installer(root, FakePython.SameThread).ensure(plots, _ => ()))

    val directory = directoryOf(root, plots, python)
    // One line per directory the engine's interpreter imports from, in its order, each a line
    // the environment's interpreter runs when it starts.
    linesOf(python.sitePackagesOf(directory).resolve("texera-engine-site.pth")) shouldBe Seq(
      """import site; site.addsitedir('/home/te\'xera/.local/site')""",
      """import site; site.addsitedir('C:\\engine\\Lib\\site-packages')"""
    )
    // Every package of the engine's but its pip: the environment has a pip of its own.
    linesOf(directory.resolve("texera-constraints.txt")) shouldBe
      Seq("numpy==2.1.0", "pandas==2.2.3", "pip-tools==7.4.1")
  }

  it should "install an environment that lists no package" in {
    val python = new FakePython()
    val root = newRoot()
    val bare = PythonEnvironment("bare", Seq.empty)

    val ready = await(python.installer(root, FakePython.SameThread).ensure(bare, _ => ()))

    ready.packages shouldBe empty
    linesOf(directoryOf(root, bare, python).resolve("texera-requirements.txt")) shouldBe empty
    python.pipInstalls should have size 1
  }

  // ----- the key -----

  it should "key an install by the packages it holds and the interpreter it is built on" in {
    val python = new FakePython()
    val root = newRoot()
    val installer = python.installer(root, FakePython.SameThread)
    val first = await(installer.ensure(ml, _ => ()))

    // The same packages under another name are the same install.
    val renamed = PythonEnvironment("ml-again", ml.requirements)
    await(installer.ensure(renamed, _ => ())) shouldBe Reused(first.interpreter, first.packages)
    // Other packages are another.
    val other = await(installer.ensure(plots, _ => ()))
    other.interpreter should not be first.interpreter
    other.interpreter.startsWith(directoryOf(root, plots, python)) shouldBe true
    // And so are the same packages on an interpreter that holds other packages of its own, or
    // that is another one.
    Seq(
      new FakePython(packages = python.packages :+ "scipy==1.17.1"),
      new FakePython(executable = "/opt/another/bin/python")
    ).foreach { another =>
      val onAnother = await(another.installer(root, FakePython.SameThread).ensure(ml, _ => ()))
      onAnother shouldBe an[Installed]
      onAnother.interpreter should not be first.interpreter
      onAnother.interpreter.startsWith(directoryOf(root, ml, another)) shouldBe true
    }
    python.pipInstalls should have size 2
  }

  // ----- reuse -----

  it should "reuse an environment it installed, running nothing" in {
    val python = new FakePython()
    val root = newRoot()
    val installer = python.installer(root, FakePython.SameThread)
    val first = await(installer.ensure(ml, _ => ()))
    val ranForTheInstall = python.runs.size
    val waits = new Waits

    val again = await(installer.ensure(ml, waits))

    again shouldBe Reused(first.interpreter, first.packages)
    waits.all shouldBe empty
    python.runs should have size ranForTheInstall
  }

  it should "reuse an environment an earlier installer left under its root, as after a restart" in {
    val python = new FakePython()
    val root = newRoot()
    val first = await(python.installer(root, FakePython.SameThread).ensure(ml, _ => ()))

    val afterRestart = await(python.installer(root, FakePython.SameThread).ensure(ml, _ => ()))

    afterRestart shouldBe Reused(first.interpreter, first.packages)
    python.pipInstalls should have size 1
  }

  // ----- the marker -----

  it should "take a directory without its marker for no environment, and build it again" in {
    val python = new FakePython()
    val root = newRoot()
    val installer = python.installer(root, FakePython.SameThread)
    val directory = directoryOf(root, ml, python)
    val interpreter = directory.resolve("bin").resolve("python")
    val marker = directory.resolve("texera-environment.json")

    /** Leaves in the directory what `left` leaves there, and asks for the environment. */
    def askedAfter(left: => Unit): Ready = {
      left
      a[IllegalStateException] should be thrownBy
        installer.interpreterFor(Some(ml))
      val ready = await(installer.ensure(ml, _ => ()))
      Files.exists(directory.resolve("left-behind.txt")) shouldBe false
      installer.interpreterFor(Some(ml)) shouldBe interpreter.toString
      ready
    }

    // An install that stopped halfway: an interpreter, some files, no marker.
    askedAfter {
      Files.createDirectories(interpreter.getParent)
      Files.createFile(interpreter).toFile.setExecutable(true)
      Files.writeString(directory.resolve("left-behind.txt"), "half an install")
    } shouldBe an[Installed]
    // A marker that was cut short.
    askedAfter {
      Files.writeString(marker, "{\"digest\": \"")
      Files.writeString(directory.resolve("left-behind.txt"), "a marker cut short")
    } shouldBe an[Installed]
    // A marker whose interpreter is gone.
    askedAfter {
      Files.delete(interpreter)
      Files.writeString(directory.resolve("left-behind.txt"), "no interpreter")
    } shouldBe an[Installed]
    python.pipInstalls should have size 3
    // Whole again, it is reused.
    await(installer.ensure(ml, _ => ())) shouldBe a[Reused]
  }

  // ----- one install at a time -----

  it should "install an environment once for the callers that ask for it at the same time" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val installer = python.installer(newRoot(), threads)
    val (firstWaits, secondWaits) = (new Waits, new Waits)

    val first = installer.ensure(ml, firstWaits)
    held.awaitBegun() shouldBe true
    val second = installer.ensure(ml, secondWaits)
    // The second is told that it waits for the first's install, which is still under way.
    eventually(secondWaits.all shouldBe Seq(Joining))
    first.isDone shouldBe false
    second.isDone shouldBe false
    held.letGo()

    val installed = await(first)
    installed shouldBe an[Installed]
    // Both are handed the one install, with what it wrote.
    await(second) shouldBe installed
    firstWaits.all shouldBe Seq(Installing)
    python.pipInstalls should have size 1
    // And a caller that comes once it is over finds it installed.
    await(installer.ensure(ml, _ => ())) shouldBe Reused(installed.interpreter, installed.packages)
  }

  it should "go on with an install whose callers no longer wait for it" in {
    // A run that is killed while its environment installs stops waiting; the install is the
    // unit's, and the next run finds it.
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val root = newRoot()
    val installer = python.installer(root, threads)
    val starter = installer.ensure(ml, _ => ())
    held.awaitBegun() shouldBe true
    val joiner = installer.ensure(ml, _ => ())

    starter.cancel(true) shouldBe true
    joiner.cancel(true) shouldBe true
    val later = installer.ensure(ml, _ => ())
    held.letGo()

    await(later) shouldBe an[Installed]
    python.pipInstalls should have size 1
    Files.exists(directoryOf(root, ml, python).resolve("texera-environment.json")) shouldBe true
  }

  it should "go on with an install whose caller fails when told of it" in {
    val python = new FakePython()
    val root = newRoot()

    val ready = await(
      python
        .installer(root, FakePython.SameThread)
        .ensure(ml, _ => throw new IllegalStateException("the caller is gone"))
    )

    ready shouldBe an[Installed]
  }

  it should "run two installs of different environments at once, and no more" in {
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val installer = python.installer(newRoot(), threads)
    val environments =
      Seq("requests", "tabulate==0.9.0", "zstandard").map(line =>
        PythonEnvironment(line, Seq(line))
      )

    val installs = environments.map(environment => installer.ensure(environment, _ => ()))
    held.awaitBegun(installs = 2) shouldBe true
    // The third waits for its turn: its pip has not begun.
    held.awaitBegun(limit = 300.millis) shouldBe false
    python.pipInstalls should have size 2
    held.letGo()

    installs.map(await).foreach(_ shouldBe an[Installed])
    python.pipInstalls should have size 3
  }

  it should "wait for an install another installer makes under the same root, and then find it" in {
    // Two JVMs that share a root, each with an installer of its own: a lock file beside the
    // environment's directory keeps the second out until the first is done.
    val python = new FakePython()
    val held = python.holdPipInstalls()
    val root = newRoot()
    val first = python.installer(root, threads).ensure(ml, _ => ())
    held.awaitBegun() shouldBe true

    val second = python.installer(root, threads).ensure(ml, _ => ())
    a[TimeoutException] should be thrownBy second.get(500, TimeUnit.MILLISECONDS)
    held.letGo()

    val installed = await(first)
    await(second) shouldBe Reused(installed.interpreter, installed.packages)
    python.pipInstalls should have size 1
  }

  // ----- failures -----

  it should "fail with what pip gives as its errors, and remove the directory" in {
    val python = new FakePython()
    val root = newRoot()
    val installer = python.installer(root, FakePython.SameThread)
    val pipSaid = Seq(
      "Collecting tabulate==0.9.0",
      "ERROR: Could not find a version that satisfies the requirement no-such-package==1.0.0 " +
        "(from versions: none)",
      "ERROR: No matching distribution found for no-such-package==1.0.0"
    )
    val succeed = python.pipInstall
    python.pipInstall = _ => ProcessOutcome(Some(1), pipSaid)

    val failed = failureOf(installer.ensure(ml, _ => ()))

    failed.reason shouldBe
      "Could not find a version that satisfies the requirement no-such-package==1.0.0 (from " +
        "versions: none) No matching distribution found for no-such-package==1.0.0"
    failed.log shouldBe pipSaid
    // Nothing of the failed install is left, so nothing takes it for an environment.
    val directory = directoryOf(root, ml, python)
    Files.exists(directory) shouldBe false
    entriesOf(root) shouldBe Set(s"${directory.getFileName}.lock")
    a[IllegalStateException] should be thrownBy
      installer.interpreterFor(Some(ml))
    // A later caller installs again, and can succeed.
    python.pipInstall = succeed
    await(installer.ensure(ml, _ => ())) shouldBe an[Installed]
    python.pipInstalls should have size 2
  }

  it should "fail every caller that waits for an install that fails" in {
    val python = new FakePython()
    val begun = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    python.pipInstall = _ => {
      begun.countDown()
      release.await(30, TimeUnit.SECONDS)
      ProcessOutcome(Some(2), Seq("ERROR: ResolutionImpossible"))
    }
    val installer = python.installer(newRoot(), threads)
    val first = installer.ensure(ml, _ => ())
    begun.await(30, TimeUnit.SECONDS) shouldBe true
    val joinerWaits = new Waits
    val second = installer.ensure(ml, joinerWaits)
    eventually(joinerWaits.all shouldBe Seq(Joining))
    release.countDown()

    failureOf(first).reason shouldBe "ResolutionImpossible"
    failureOf(second) should be theSameInstanceAs failureOf(first)
  }

  it should "say which step failed, and its last word, when pip gave no error" in {
    val python = new FakePython()
    val root = newRoot()
    python.makeVenv = _ =>
      ProcessOutcome(
        Some(1),
        Seq("The virtual environment was not created successfully.", "", "Failing command: x", " ")
      )

    val failed = failureOf(python.installer(root, FakePython.SameThread).ensure(ml, _ => ()))

    failed.reason shouldBe "python -m venv exited with 1: Failing command: x"
    failed.log should contain("The virtual environment was not created successfully.")
    Files.exists(directoryOf(root, ml, python)) shouldBe false
    python.pipInstalls shouldBe empty
  }

  it should "stop an install that takes longer than its timeout, and remove the directory" in {
    val python = new FakePython()
    val root = newRoot()
    // A step that is still running at its limit is destroyed, and has no exit code.
    python.pipInstall = _ => ProcessOutcome(None, Seq("Collecting tabulate==0.9.0"))

    val failed = failureOf(
      python.installer(root, FakePython.SameThread, timeout = 90.seconds).ensure(ml, _ => ())
    )

    failed.reason shouldBe "the install did not finish within 90 seconds"
    failed.log shouldBe Seq("Collecting tabulate==0.9.0")
    Files.exists(directoryOf(root, ml, python)) shouldBe false
    // Every step is given what is left of the timeout, and no more.
    python.runs.drop(1).foreach(run => run.limit should (be > 60.seconds and be <= 90.seconds))
  }

  it should "fail when the engine's interpreter cannot be asked what it holds, and ask again next time" in {
    val python = new FakePython()
    val root = newRoot()
    val installer = python.installer(root, FakePython.SameThread)
    val answer = python.describe
    python.describe = () => ProcessOutcome(Some(127), Seq("python: command not found"))

    failureOf(installer.ensure(ml, _ => ())).reason shouldBe
      s"The engine's Python interpreter '${python.executable}' could not be asked what it " +
        "holds: it exited with 127: python: command not found"
    entriesOf(root) shouldBe empty

    python.describe = answer
    await(installer.ensure(ml, _ => ())) shouldBe an[Installed]
  }

  // ----- a worker's interpreter -----

  "PythonEnvironmentInstaller.interpreterFor" should
    "give the engine's interpreter to an operator that asks for no environment" in {
    val python = new FakePython()

    python
      .installer(newRoot(), FakePython.SameThread)
      .interpreterFor(None) shouldBe python.executable
    // Asked of nothing: the engine's own interpreter is not even described.
    python.runs shouldBe empty
  }

  it should "give an installed environment's interpreter, and no other environment's" in {
    val python = new FakePython()
    val root = newRoot()
    val installer = python.installer(root, FakePython.SameThread)
    val installed = await(installer.ensure(ml, _ => ()))

    installer.interpreterFor(Some(ml)) shouldBe
      installed.interpreter.toString
    // The same packages under another name are the same install.
    installer.interpreterFor(Some(PythonEnvironment("renamed", ml.requirements))) shouldBe
      installed.interpreter.toString
  }

  it should "refuse an environment that is not installed here, rather than give another interpreter" in {
    val python = new FakePython()
    val installer = python.installer(newRoot(), FakePython.SameThread)
    await(installer.ensure(ml, _ => ()))

    val missing = the[IllegalStateException] thrownBy
      installer.interpreterFor(Some(plots))
    missing.getMessage shouldBe "Python environment 'plots' is not installed on this computing unit."
  }

  "PythonEnvironmentInstaller.under" should
    "be the installer itself for its own root, and find under another what is installed there" in {
    val python = new FakePython()
    val (root, other) = (newRoot(), newRoot())
    val installer = python.installer(root, FakePython.SameThread)
    val installed = await(python.installer(other, FakePython.SameThread).ensure(ml, _ => ()))

    installer.under(root) should be theSameInstanceAs installer
    installer.under(other).root shouldBe other
    installer.under(other).interpreterFor(Some(ml)) shouldBe installed.interpreter.toString
    // Its own root holds no such environment.
    an[IllegalStateException] should be thrownBy installer.interpreterFor(Some(ml))
  }

}
