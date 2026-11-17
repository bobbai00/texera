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

import com.typesafe.scalalogging.LazyLogging
import org.apache.commons.lang3.SystemUtils
import org.apache.texera.amber.core.workflow.{PythonEnvironment, PythonEnvironmentRef}
import org.apache.texera.amber.engine.architecture.pythonworker.environment.EngineInterpreter.sha256Hex
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller._
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.config.{PythonUtils, UdfConfig}

import java.nio.channels.{FileChannel, FileLock, OverlappingFileLockException}
import java.nio.file.{Files, Path, Paths, StandardCopyOption, StandardOpenOption}
import java.time.Instant
import java.util.{Comparator, Locale}
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{CompletableFuture, ConcurrentHashMap, Executor, Executors, Semaphore}
import scala.annotation.tailrec
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.{Deadline, DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters.SeqHasAsJava
import scala.util.control.NonFatal
import scala.util.{Try, Using}

/**
  * Installs the Python environments plans name on this computing unit, and keeps them for the
  * runs that come after.
  *
  * An environment is installed in a directory of `root` named by a key: the SHA-256 of the
  * environment's digest and the engine interpreter's identity, cut to 32 hex digits. So runs of
  * any workflow, by any user, that ask for the same packages share one install, and an install
  * made on another interpreter, or beside other packages of the engine's, is not taken for it.
  *
  * The directory is a virtual environment the engine's interpreter makes, built where it stays:
  * its scripts name its path, so it cannot be built elsewhere and moved into place. A `.pth` file
  * in it adds the directories the engine's interpreter imports its packages from, so a worker in
  * the environment imports the engine's packages beside the environment's own; without it, a
  * virtual environment made by an interpreter that is itself one sees none of them. pip then
  * installs the environment's requirements under constraints that hold every package of the
  * engine's to the version the engine has: the engine's packages are not replaced, and a
  * requirement that cannot live with them fails the install. A marker file is written last. Only
  * a directory that has its marker is an environment, so one a failed or interrupted install
  * left behind is never used, and is built again.
  *
  * One install of a key runs at a time. In this JVM, a caller that needs an environment being
  * installed waits for that install; a lock file beside the directory keeps out another JVM
  * that installs under the same root. An install is no caller's: it runs to its end, or to
  * `timeout`, whatever becomes of those that wait for it, and only one that fails removes its
  * directory.
  *
  * @param root      the directory environments are installed under, one directory each
  * @param timeout   how long one install may take; one that takes longer is stopped
  * @param engine    the interpreter environments are built on
  * @param processes runs the interpreters and pip
  * @param executor  runs what [[ensure]] is asked for, off the caller's thread. An install
  *                  holds one of its threads until it ends, one waiting for its turn too.
  */
final class PythonEnvironmentInstaller(
    root: Path,
    timeout: FiniteDuration,
    engine: EngineInterpreter,
    processes: ProcessRunner,
    executor: Executor
) extends LazyLogging {

  // The installs under way, by key.
  private val underWay = new ConcurrentHashMap[String, CompletableFuture[Ready]]()

  // Installs of different keys take turns, so that a unit runs few pips at once.
  private val turns = new Semaphore(ConcurrentInstalls, true)

  /**
    * Makes `environment` ready on this unit: finds it installed, installs it, or waits for the
    * install of it that is under way. It returns at once; the work is the executor's.
    *
    * @param onWait told, on the executor's thread, when `environment` is not installed yet:
    *               that this call installs it, or that it waits for another's install
    * @return the environment once it is ready. It fails with an [[InstallFailed]] when the
    *         environment cannot be installed.
    */
  def ensure(environment: PythonEnvironment, onWait: Wait => Unit): CompletableFuture[Ready] = {
    val ready = new CompletableFuture[Ready]()
    executor.execute(() =>
      try {
        val directory = directoryOf(environment)
        installedIn(directory) match {
          case Some(reused) => ready.complete(reused)
          case None         => installOnce(environment, directory, onWait, ready)
        }
      } catch {
        case NonFatal(failure) => ready.completeExceptionally(InstallFailed.of(failure))
      }
    )
    ready
  }

  /**
    * The interpreter a worker of an operator in `environment` runs: the engine's own, or the
    * environment's, installed here. A worker runs in its operator's environment or not at all.
    *
    * @throws IllegalStateException if the environment is not installed on this unit, or is a name
    *                               that no plan resolved
    */
  def interpreterFor(environment: PythonEnvironmentRef): String =
    environment match {
      case PythonEnvironmentRef.EngineDefault => engine.executable
      case PythonEnvironmentRef.Resolved(resolved) =>
        installedIn(directoryOf(resolved))
          .map(_.interpreter.toString)
          .getOrElse(
            throw new IllegalStateException(
              s"Python environment '${resolved.name}' is not installed on this computing unit."
            )
          )
      case PythonEnvironmentRef.Named(name) =>
        throw new IllegalStateException(
          s"Python environment '$name' was never resolved: only a plan made to run says what " +
            "its operators run in."
        )
    }

  /** Where `environment` is installed on this unit, or is to be. */
  private def directoryOf(environment: PythonEnvironment): Path =
    root.resolve(
      sha256Hex(s"${environment.digest}\n${engine.description.identity}").take(KeyLength)
    )

  /**
    * The environment in `directory`, if one was installed there to its end: its marker is there,
    * and can be read, and so is its interpreter.
    */
  private def installedIn(directory: Path): Option[Reused] = {
    val interpreter = interpreterIn(directory)
    val marker = directory.resolve(MarkerFile)
    if (!Files.isRegularFile(marker) || !Files.isExecutable(interpreter)) None
    else
      Try(objectMapper.readValue(Files.readString(marker), classOf[Marker])).toOption
        .map(marker => Reused(interpreter, marker.installed))
  }

  /**
    * Installs `environment` into `directory` unless an install of it is under way, which this
    * then waits for; either way `ready` ends as that install does.
    */
  private def installOnce(
      environment: PythonEnvironment,
      directory: Path,
      onWait: Wait => Unit,
      ready: CompletableFuture[Ready]
  ): Unit = {
    val key = directory.getFileName.toString
    val mine = new CompletableFuture[Ready]()
    def tell(wait: Wait): Unit =
      try onWait(wait)
      catch {
        case NonFatal(failure) =>
          logger.warn(
            s"A caller waiting for Python environment '${environment.name}' failed.",
            failure
          )
      }
    Option(underWay.putIfAbsent(key, mine)) match {
      case Some(others) =>
        tell(Joining)
        forward(others, ready)
      case None =>
        forward(mine, ready)
        // The install is let go of before it is answered: a caller that comes after finds the
        // marker, or, after a failure, installs again.
        try {
          tell(Installing)
          val installed = install(environment, directory)
          underWay.remove(key, mine)
          mine.complete(installed)
        } catch {
          case failure: Throwable =>
            underWay.remove(key, mine)
            mine.completeExceptionally(InstallFailed.of(failure))
            if (!NonFatal(failure)) throw failure
        }
    }
  }

  /**
    * Installs `environment` into `directory`, once it is this install's turn and no other JVM
    * installs there: one that did meanwhile is found, and nothing is installed.
    */
  private def install(environment: PythonEnvironment, directory: Path): Ready = {
    turns.acquire()
    try {
      Files.createDirectories(root)
      locked(directory, timeout.fromNow) {
        installedIn(directory).getOrElse(build(environment, directory, timeout.fromNow))
      }
    } finally turns.release()
  }

  /** Runs `body` holding the lock file of `directory`, waited for until `deadline`. */
  private def locked[T](directory: Path, deadline: Deadline)(body: => T): T =
    Using.resource(
      FileChannel.open(
        directory.resolveSibling(s"${directory.getFileName}.lock"),
        StandardOpenOption.CREATE,
        StandardOpenOption.WRITE
      )
    ) { channel =>
      // No lock while another process holds it; the exception while this JVM does, through
      // another installer under the same root.
      @tailrec def acquire(): FileLock =
        Option(
          try channel.tryLock()
          catch { case _: OverlappingFileLockException => null }
        ) match {
          case Some(lock) => lock
          case None if deadline.isOverdue() =>
            throw new InstallFailed(s"another install of it was still under way after $timeout")
          case None =>
            Thread.sleep(LockPoll.toMillis)
            acquire()
        }
      val lock = acquire()
      try body
      finally lock.release()
    }

  /**
    * Builds `environment` in `directory`, from nothing, by `deadline`. Whatever fails, the
    * directory is removed.
    */
  private def build(environment: PythonEnvironment, directory: Path, deadline: Deadline): Ready = {
    val started = System.nanoTime()
    val log = ArrayBuffer.empty[String]

    /** Runs one step of the install to a successful end, and answers what it wrote. */
    def run(
        step: String,
        command: Seq[String],
        variables: Map[String, String] = Map.empty,
        logged: Boolean = true
    ): Seq[String] = {
      val outcome = processes.run(command, variables, deadline.timeLeft.max(MinimumStep))
      if (logged) log ++= outcome.lines
      outcome.exitCode match {
        case Some(0)    => outcome.lines
        case Some(code) =>
          // What pip says went wrong, when it says; else the step's last word.
          val errors = outcome.lines.collect {
            case line if line.startsWith(PipError) => line.stripPrefix(PipError).trim
          }
          val lastWord = outcome.lines.reverseIterator.map(_.trim).find(_.nonEmpty)
          throw new InstallFailed(
            if (errors.nonEmpty) errors.mkString(" ")
            else s"$step exited with $code${lastWord.fold("")(word => s": $word")}",
            log.takeRight(LogLines).toList
          )
        case None =>
          throw new InstallFailed(
            s"the install did not finish within $timeout",
            log.takeRight(LogLines).toList
          )
      }
    }

    logger.info(
      s"Installing Python environment '${environment.name}' (${environment.digest}) in $directory."
    )
    try {
      deleteRecursively(directory)
      run("python -m venv", Seq(engine.executable, "-m", "venv", directory.toString))
      val python = interpreterIn(directory).toString
      val sitePackages =
        run(
          "the new environment's interpreter",
          Seq(python, "-c", SitePackagesScript),
          logged = false
        )
          .map(_.trim)
          .findLast(_.nonEmpty)
          .getOrElse(throw new InstallFailed("the new environment names no directory of packages"))
      Files.write(
        Paths.get(sitePackages).resolve(EngineSiteFile),
        engine.description.siteDirectories.map { engineDirectory =>
          s"import site; site.addsitedir(${pythonLiteral(engineDirectory)})"
        }.asJava
      )
      val requirements = directory.resolve(RequirementsFile)
      val constraints = directory.resolve(ConstraintsFile)
      Files.write(requirements, environment.requirements.asJava)
      // Each environment brings a pip of its own, whichever the interpreter comes with.
      Files.write(constraints, engine.description.packages.filterNot(isPip).asJava)
      run(
        "pip install",
        Seq(
          python,
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
        Map("PYTHONUNBUFFERED" -> "1", "PIP_NO_INPUT" -> "1")
      )
      val packages =
        run("pip freeze", Seq(python, "-m", "pip", "freeze", "--local"), logged = false)
          .map(_.trim)
          .filter(line => line.nonEmpty && !line.startsWith("#"))
      val seconds = (System.nanoTime() - started) / 1e9
      writeMarker(
        directory,
        Marker(
          digest = environment.digest,
          engineIdentity = engine.description.identity,
          requirements = environment.requirements,
          installed = packages,
          seconds = seconds,
          finishedAt = Instant.now().toString
        )
      )
      logger.info(f"Installed Python environment '${environment.name}' in $seconds%.1f s.")
      Installed(interpreterIn(directory), packages, log.takeRight(LogLines).toList)
    } catch {
      case failure: Throwable =>
        failure match {
          case notInstalled: InstallFailed =>
            logger.warn(
              s"Python environment '${environment.name}' could not be installed: " +
                notInstalled.reason
            )
          case unexpected =>
            logger.warn(
              s"Python environment '${environment.name}' could not be installed.",
              unexpected
            )
        }
        Try(deleteRecursively(directory)).failed.foreach { leftBehind =>
          logger.warn(s"The half-built $directory could not be removed.", leftBehind)
        }
        throw failure
    }
  }

  /** Writes the marker of the environment in `directory`, whole or not at all. */
  private def writeMarker(directory: Path, marker: Marker): Unit = {
    val unfinished = directory.resolve(s"$MarkerFile.tmp")
    Files.writeString(
      unfinished,
      objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(marker)
    )
    Files.move(unfinished, directory.resolve(MarkerFile), StandardCopyOption.ATOMIC_MOVE)
  }
}

object PythonEnvironmentInstaller {

  /** An environment that is ready on this unit. */
  sealed trait Ready {

    /** Its Python interpreter. */
    def interpreter: Path

    /** What it holds beside the engine's packages, each as pip lists it: `<name>==<version>`. */
    def packages: Seq[String]
  }

  /** An environment that was installed before it was asked for. */
  final case class Reused(interpreter: Path, packages: Seq[String]) extends Ready

  /**
    * An environment whose install ended just now.
    *
    * @param log the last lines the install wrote, pip's among them
    */
  final case class Installed(interpreter: Path, packages: Seq[String], log: Seq[String])
      extends Ready

  /** Why a caller of [[PythonEnvironmentInstaller.ensure]] has to wait. */
  sealed trait Wait

  /** Its call installs the environment. */
  case object Installing extends Wait

  /** An install of the environment that another call began is under way. */
  case object Joining extends Wait

  /**
    * An environment that could not be installed.
    *
    * @param reason why, in words that end a sentence: what pip gave as its errors, when pip
    *               failed and said why
    * @param log    the last lines the install wrote, pip's among them
    */
  final class InstallFailed(val reason: String, val log: Seq[String] = Nil, cause: Throwable = null)
      extends RuntimeException(reason, cause)

  object InstallFailed {

    /** `failure` as the failure of an install, which it is unless it is one already. */
    private[environment] def of(failure: Throwable): InstallFailed =
      failure match {
        case failed: InstallFailed => failed
        case other =>
          new InstallFailed(Option(other.getMessage).getOrElse(other.toString), Nil, other)
      }
  }

  /**
    * This computing unit's installer: environments under `udf.python.environments.root`, built
    * on the interpreter the unit's Python workers run.
    */
  lazy val forThisUnit: PythonEnvironmentInstaller = {
    val threads = new AtomicInteger()
    new PythonEnvironmentInstaller(
      Paths.get(UdfConfig.pythonEnvironmentsRoot),
      UdfConfig.pythonEnvironmentInstallTimeoutMinutes.minutes,
      new EngineInterpreter(PythonUtils.getPythonExecutable, ProcessRunner.OperatingSystem),
      ProcessRunner.OperatingSystem,
      Executors.newCachedThreadPool { task =>
        val thread = new Thread(task, s"python-environment-${threads.incrementAndGet()}")
        thread.setDaemon(true)
        thread
      }
    )
  }

  /** What an environment's marker says of it. */
  private final case class Marker(
      digest: String,
      engineIdentity: String,
      requirements: Seq[String],
      installed: Seq[String],
      seconds: Double,
      finishedAt: String
  )

  // How many installs, of different keys, run at once.
  private val ConcurrentInstalls = 2
  private val KeyLength = 32
  private val MarkerFile = "texera-environment.json"
  private val RequirementsFile = "texera-requirements.txt"
  private val ConstraintsFile = "texera-constraints.txt"
  private val EngineSiteFile = "texera-engine-site.pth"

  // How many lines of an install's output are kept, for whoever waits for it to read.
  private val LogLines = 200
  private val PipError = "ERROR: "
  private val LockPoll = 200.millis
  // A step that starts at the deadline is still started, to end at once.
  private val MinimumStep = 1.second

  // Prints the directory an interpreter installs pure-Python packages into.
  private val SitePackagesScript = "import sysconfig; print(sysconfig.get_path('purelib'))"

  private def isPip(pinned: String): Boolean =
    pinned.toLowerCase(Locale.ROOT).startsWith("pip==")

  /** The interpreter of the virtual environment in `directory`. */
  private def interpreterIn(directory: Path): Path =
    if (SystemUtils.IS_OS_WINDOWS) directory.resolve("Scripts").resolve("python.exe")
    else directory.resolve("bin").resolve("python")

  /** `text` as a string literal of Python's. */
  private def pythonLiteral(text: String): String =
    "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"

  /** Completes `to` as `from` completes. */
  private def forward(from: CompletableFuture[Ready], to: CompletableFuture[Ready]): Unit =
    from.whenComplete { (ready, failure) =>
      if (failure == null) to.complete(ready) else to.completeExceptionally(failure)
    }

  private def deleteRecursively(directory: Path): Unit =
    if (Files.exists(directory)) {
      Using.resource(Files.walk(directory)) { paths =>
        paths.sorted(Comparator.reverseOrder[Path]()).forEach(path => Files.deleteIfExists(path))
      }
    }
}
