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
  * Python environments on this unit, one virtual environment per environment version from the
  * catalog. Built on first use with the unit's own Python; no database involved.
  *
  * Layout: `<root>/<name>/venv` where `name` is `env-<rid>-v<vno>`.
  */
object EnvironmentManager extends LazyLogging {
  sealed trait Status
  case object Building extends Status
  case object Ready extends Status
  final case class Failed(message: String) extends Failed.Base
  object Failed { trait Base extends Status }

  private val root: Path =
    Paths.get(sys.env.getOrElse("TEXERA_ENV_ROOT", "/tmp/texera-environments"))
  private val statuses = new TrieMap[String, Status]()
  private val SafeName = "^[A-Za-z0-9_.-]{1,120}$".r

  def nameOf(rid: String, vno: Int): String = s"env-${rid.replaceAll("[^A-Za-z0-9]", "")}-v$vno"

  def status(name: String): Option[Status] = statuses.get(name)

  /** The Python binary of a ready environment, if it exists. */
  def getPythonBin(name: String): Option[Path] = {
    if (SafeName.findFirstIn(name).isEmpty) return None
    val bin = pythonBinOf(name)
    if (Files.isExecutable(bin)) Some(bin.toAbsolutePath) else None
  }

  /** Where an environment's interpreter lives, built or not. */
  private[texera] def pythonBinOf(name: String): Path =
    venvDir(name).resolve("bin").resolve("python")

  private def venvDir(name: String): Path = root.resolve(name).resolve("venv")

  /**
    * Builds the environment synchronously: creates the venv with the unit's Python and installs
    * the packages with pip. Idempotent; a second call returns the existing status.
    */
  def ensure(name: String, packages: Seq[String]): Status = {
    if (SafeName.findFirstIn(name).isEmpty) return Failed(s"invalid environment name $name")
    statuses.get(name) match {
      case Some(Ready)          => return Ready
      case Some(Building)       => return Building
      case Some(f: Failed.Base) => return f
      case None                 =>
    }
    statuses.put(name, Building)
    val result = Try {
      val dir = venvDir(name)
      Files.createDirectories(dir.getParent)
      val python = dir.resolve("bin").resolve("python")
      if (!Files.isExecutable(python)) {
        run(Seq(PythonUtils.getPythonExecutable, "-m", "venv", dir.toString))
        layerOnBase(python)
      }
      val cleaned = packages.map(_.trim).filter(_.nonEmpty)
      if (cleaned.nonEmpty) {
        val uv = sys.env.get("TEXERA_UV").orElse(which("uv"))
        uv match {
          case Some(bin) =>
            run(Seq(bin, "pip", "install", "--quiet", "--python", python.toString) ++ cleaned)
          case None =>
            run(
              Seq(
                python.toString,
                "-m",
                "pip",
                "install",
                "--quiet",
                "--disable-pip-version-check"
              ) ++ cleaned
            )
        }
      }
    }
    val status = result.fold(e => Failed(Option(e.getMessage).getOrElse(e.toString)), _ => Ready)
    statuses.put(name, status)
    logger.info(s"environment $name: $status")
    status
  }

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
