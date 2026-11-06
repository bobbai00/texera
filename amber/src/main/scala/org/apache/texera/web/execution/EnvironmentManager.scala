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

package org.apache.texera.web.execution

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.common.config.PythonUtils

import java.nio.file.{Files, Path, Paths}
import scala.collection.concurrent.TrieMap
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Python environments on this unit, one virtual environment per list of packages, named by the
  * key the catalog derives from the list: the same packages are the same environment, built
  * once. Built on first use with the unit's own Python; no database involved.
  *
  * Layout: `<root>/<key>/venv`.
  */
object EnvironmentManager extends LazyLogging {
  sealed trait Status
  case object Building extends Status

  /** Built: each package asked for, pinned as the environment has it (`pandas==2.2.3`). */
  final case class Ready(installed: List[String]) extends Status
  final case class Failed(message: String) extends Status

  private val root: Path =
    Paths.get(sys.env.getOrElse("TEXERA_ENV_ROOT", "/tmp/texera-environments"))
  private val statuses = new TrieMap[String, Status]()
  private val SafeName = "^[A-Za-z0-9_.-]{1,120}$".r
  private val Pin = "^[A-Za-z0-9][A-Za-z0-9._-]*==\\S+$".r

  def status(key: String): Option[Status] = statuses.get(key)

  /** The Python binary of a ready environment, if it exists. */
  def getPythonBin(key: String): Option[Path] = {
    if (SafeName.findFirstIn(key).isEmpty) return None
    val bin = pythonBinOf(key)
    if (Files.isExecutable(bin)) Some(bin.toAbsolutePath) else None
  }

  /** Where an environment's interpreter lives, built or not. */
  private[texera] def pythonBinOf(key: String): Path =
    venvDir(key).resolve("bin").resolve("python")

  private def venvDir(key: String): Path = root.resolve(key).resolve("venv")

  /**
    * Builds the environment synchronously: creates the venv with the unit's Python and installs
    * the packages. A built or building environment is answered as it is; a failed one is tried
    * again.
    */
  def ensure(key: String, packages: Seq[String]): Status = {
    if (SafeName.findFirstIn(key).isEmpty) return Failed(s"invalid environment key $key")
    statuses.putIfAbsent(key, Building) match {
      case None                                                            =>
      case Some(failed: Failed) if statuses.replace(key, failed, Building) =>
      case Some(status)                                                    => return status
    }
    val status = Try(build(key, packages.map(_.trim).filter(_.nonEmpty)))
      .fold(e => Failed(Option(e.getMessage).getOrElse(e.toString)), Ready)
    statuses.put(key, status)
    logger.info(s"environment $key: $status")
    status
  }

  private def build(key: String, packages: Seq[String]): List[String] = {
    val python = pythonBinOf(key)
    if (!Files.isExecutable(python)) {
      val dir = venvDir(key)
      Files.createDirectories(dir.getParent)
      run(Seq(PythonUtils.getPythonExecutable, "-m", "venv", dir.toString))
      layerOnBase(python)
    }
    if (packages.nonEmpty) {
      sys.env.get("TEXERA_UV").orElse(which("uv")) match {
        case Some(uv) =>
          run(Seq(uv, "pip", "install", "--quiet", "--python", python.toString) ++ packages)
        case None =>
          run(
            Seq(python.toString, "-m", "pip", "install", "--quiet", "--disable-pip-version-check")
              ++ packages
          )
      }
    }
    pinnedFrom(capture(Seq(python.toString, "-c", Installed) ++ packages))
  }

  /**
    * Prints each requirement it is given as the interpreter has it, `name==version`: installed
    * in the environment, or already in the unit's base. A requirement that names no package it
    * finds (a URL, say) is left out.
    */
  private val Installed =
    """import importlib.metadata as m, re, sys
      |for requirement in sys.argv[1:]:
      |    name = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", requirement.strip())
      |    try:
      |        found = m.distribution(name.group()) if name else None
      |    except m.PackageNotFoundError:
      |        found = None
      |    if found:
      |        print(found.metadata["Name"] + "==" + found.version)
      |""".stripMargin

  /** The pins in what the interpreter printed, once each, in order; anything else is dropped. */
  private[execution] def pinnedFrom(output: String): List[String] =
    output.split("\n").map(_.trim).filter(Pin.matches).distinct.toList

  /**
    * Makes the unit's base interpreter packages (the engine's Python runtime and the default
    * operator libraries) visible in the environment through a .pth file. The environment's own
    * packages come first on sys.path, so a requested version wins over the base one.
    */
  private def layerOnBase(envPython: Path): Unit = {
    val base = capture(
      Seq(
        PythonUtils.getPythonExecutable,
        "-c",
        "import site; print('\\n'.join(site.getsitepackages()))"
      )
    )
      .split("\n")
      .map(_.trim)
      .filter(_.nonEmpty)
    val envSite = capture(
      Seq(envPython.toString, "-c", "import site; print(site.getsitepackages()[0])")
    ).trim
    Files.write(
      Paths.get(envSite).resolve("texera-base.pth"),
      base.mkString("\n").concat("\n").getBytes
    )
  }

  private def which(bin: String): Option[String] =
    sys.env
      .getOrElse("PATH", "")
      .split(java.io.File.pathSeparator)
      .map(Paths.get(_).resolve(bin))
      .find(Files.isExecutable)
      .map(_.toString)

  private def capture(cmd: Seq[String]): String = {
    val pb = new ProcessBuilder(cmd.asJava)
    pb.redirectErrorStream(true)
    val process = pb.start()
    val output = new String(process.getInputStream.readAllBytes())
    if (process.waitFor() != 0)
      throw new RuntimeException(s"${cmd.head} failed: ${output.takeRight(1000)}")
    output
  }

  private def run(cmd: Seq[String]): Unit = {
    val pb = new ProcessBuilder(cmd.asJava)
    pb.redirectErrorStream(true)
    val process = pb.start()
    val output = new String(process.getInputStream.readAllBytes())
    val code = process.waitFor()
    if (code != 0) {
      throw new RuntimeException(s"${cmd.head} exited with $code: ${output.takeRight(2000)}")
    }
  }
}
