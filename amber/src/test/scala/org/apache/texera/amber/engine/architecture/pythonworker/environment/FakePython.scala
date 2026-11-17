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

import org.apache.texera.amber.engine.architecture.pythonworker.environment.FakePython.Run
import org.apache.texera.amber.util.JSONUtils.objectMapper

import java.nio.file.{Files, Path, Paths}
import java.util.concurrent.{CopyOnWriteArrayList, CountDownLatch, Executor, Semaphore, TimeUnit}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters.{CollectionHasAsScala, SeqHasAsJava}

/**
  * Stands in for the engine's Python interpreter and for pip, for specs that run neither: it
  * answers what the interpreter says of itself, and leaves on disk what `python -m venv` and pip
  * leave there.
  *
  * A virtual environment it makes has an interpreter file and a directory of packages; `pip
  * freeze` in it lists what its last `pip install` was asked for, an unpinned requirement at
  * version 1.0. What `pip install` does is `pipInstall`'s to say: by default it succeeds.
  *
  * @param executable      the engine's interpreter, as the installer is told to run it
  * @param siteDirectories where the interpreter says it imports its packages from
  * @param packages        the packages it says it has there
  */
final class FakePython(
    val executable: String = "/opt/engine/bin/python",
    val siteDirectories: Seq[String] =
      Seq("/opt/engine/user-site", "/opt/engine/lib/python3.11/site-packages"),
    val packages: Seq[String] = Seq("numpy==2.1.0", "pandas==2.2.3", "pip==24.0")
) extends ProcessRunner {

  private val ran = new CopyOnWriteArrayList[Run]()

  /** Every command run so far, in the order they began. */
  def runs: Seq[Run] = ran.asScala.toList

  /** The `pip install` commands among them. */
  def pipInstalls: Seq[Run] = runs.filter(_.command.containsSlice(Seq("-m", "pip", "install")))

  /** The line the interpreter answers when asked what it holds. */
  val description: String = objectMapper.writeValueAsString(
    Map(
      "executable" -> executable,
      "version" -> "3.11.14 (main, fake)",
      "platform" -> "fake-platform",
      "siteDirectories" -> siteDirectories,
      "packages" -> packages
    )
  )

  /** What the interpreter does when asked what it holds; a spec may make it fail. */
  @volatile var describe: () => ProcessOutcome = () => ProcessOutcome(Some(0), Seq(description))

  /** What `python -m venv` does, after the fake has made the directory; a spec may make it fail. */
  @volatile var makeVenv: Path => ProcessOutcome = _ => ProcessOutcome(Some(0), Nil)

  /** What `pip install` does, given the requirements it is asked for; a spec may make it fail. */
  @volatile var pipInstall: Seq[String] => ProcessOutcome = requirements =>
    ProcessOutcome(
      Some(0),
      requirements.map(line => s"Collecting $line") :+
        s"Successfully installed ${requirements.mkString(" ")}"
    )

  /** The `pip install`s held since [[holdPipInstalls]], for a spec to wait for and let go. */
  final class HeldInstalls private[FakePython] () {
    private val begun = new Semaphore(0)
    private val release = new CountDownLatch(1)

    private[FakePython] def hold(): Unit = {
      begun.release()
      release.await(30, TimeUnit.SECONDS)
    }

    /** Waits for `installs` more to have begun; false if they have not within `limit`. */
    def awaitBegun(installs: Int = 1, limit: FiniteDuration = 30.seconds): Boolean =
      begun.tryAcquire(installs, limit.toMillis, TimeUnit.MILLISECONDS)

    /** Lets every held install go on, and those that begin later. */
    def letGo(): Unit = release.countDown()
  }

  /** Holds every `pip install` from now on where it begins, until the spec lets them go. */
  def holdPipInstalls(): HeldInstalls = {
    val held = new HeldInstalls
    val install = pipInstall
    pipInstall = requirements => {
      held.hold()
      install(requirements)
    }
    held
  }

  override def run(
      command: Seq[String],
      environment: Map[String, String],
      limit: FiniteDuration
  ): ProcessOutcome = {
    ran.add(Run(command, environment, limit, Thread.currentThread()))
    command match {
      case Seq(`executable`, "-c", _) => describe()
      case Seq(`executable`, "-m", "venv", directory) =>
        val venv = Paths.get(directory)
        Files.createDirectories(sitePackagesOf(venv))
        val interpreter =
          Files.createFile(Files.createDirectories(venv.resolve("bin")).resolve("python"))
        interpreter.toFile.setExecutable(true)
        makeVenv(venv)
      case Seq(interpreter, "-c", _) =>
        ProcessOutcome(Some(0), Seq(sitePackagesOf(venvOf(interpreter)).toString))
      case Seq(interpreter, "-m", "pip", "install", rest @ _*) =>
        val requirements =
          Files.readAllLines(Paths.get(rest(rest.indexOf("-r") + 1))).asScala.toList
        val outcome = pipInstall(requirements)
        if (outcome.exitCode.contains(0)) {
          Files.write(venvOf(interpreter).resolve("fake-installed.txt"), requirements.asJava)
        }
        outcome
      case Seq(interpreter, "-m", "pip", "freeze", "--local") =>
        val installed = venvOf(interpreter).resolve("fake-installed.txt")
        ProcessOutcome(
          Some(0),
          Files.readAllLines(installed).asScala.toList.map { line =>
            if (line.exists(c => c == '=' || c == '<' || c == '>')) line.replaceAll("[<>]=", "==")
            else s"$line==1.0"
          }
        )
      case other => throw new IllegalArgumentException(s"The fake Python cannot run $other")
    }
  }

  private def venvOf(interpreter: String): Path = Paths.get(interpreter).getParent.getParent

  /** Where the virtual environment in `venv` keeps its packages. */
  def sitePackagesOf(venv: Path): Path =
    venv.resolve("lib").resolve("python3.11").resolve("site-packages")

  /** An installer on this Python that installs under `root`, on `executor`'s threads. */
  def installer(
      root: Path,
      executor: Executor,
      timeout: FiniteDuration = 30.minutes
  ): PythonEnvironmentInstaller =
    new PythonEnvironmentInstaller(
      root,
      timeout,
      new EngineInterpreter(executable, this),
      this,
      executor
    )
}

object FakePython {

  /** One command a fake was asked to run, and the thread that asked. */
  final case class Run(
      command: Seq[String],
      environment: Map[String, String],
      limit: FiniteDuration,
      thread: Thread
  )

  /** Runs each task where it is handed over, so a spec sees an install done when asked for. */
  val SameThread: Executor = task => task.run()
}
