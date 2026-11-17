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

import com.google.common.hash.Hashing
import org.apache.texera.amber.engine.architecture.pythonworker.environment.EngineInterpreter.{
  DescribeLimit,
  DescribeScript,
  Description,
  sha256Hex
}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import java.io.IOException
import java.nio.charset.StandardCharsets
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.Try

/**
  * The engine's own Python interpreter, the one a Python worker runs unless its operator asks for
  * an environment: what every environment on this computing unit is built on.
  *
  * An environment is a virtual environment this interpreter makes, set up to import the
  * interpreter's packages beside its own. So it is only good with this interpreter and these
  * packages, and what it installs must leave them as they are: the interpreter says where it
  * imports its packages from, which they are, and what tells it from any other interpreter.
  *
  * @param executable the interpreter, as a command: a path, or a name on the PATH
  * @param processes  runs the interpreter
  */
final class EngineInterpreter(val executable: String, processes: ProcessRunner) {

  @volatile private var described: Option[Description] = None

  /**
    * What the interpreter says of itself. It is asked once: the answer is kept for as long as
    * this JVM runs. A failure to ask is not kept, so the next call asks again.
    *
    * @throws IllegalStateException if the interpreter cannot be run, or does not answer
    */
  def description: Description =
    described.getOrElse(synchronized {
      described.getOrElse {
        val answer = describe()
        described = Some(answer)
        answer
      }
    })

  private def describe(): Description = {
    def refuse(why: String, cause: Throwable = null): Nothing =
      throw new IllegalStateException(
        s"The engine's Python interpreter '$executable' could not be asked what it holds: $why",
        cause
      )
    val outcome =
      try processes.run(Seq(executable, "-c", DescribeScript), Map.empty, DescribeLimit)
      catch { case failure: IOException => refuse(failure.getMessage, failure) }
    val said = outcome.lines.lastOption.getOrElse("")
    outcome.exitCode match {
      case Some(0) =>
        Try {
          val answer = objectMapper.readTree(said)
          def strings(field: String): Seq[String] = {
            val values = answer.get(field)
            require(values.isArray, s"$field is no list")
            values.elements().asScala.map(_.asText()).toList
          }
          Description(
            identity = sha256Hex(said),
            siteDirectories = strings("siteDirectories"),
            packages = strings("packages")
          )
        }.getOrElse(refuse(s"it answered '$said'"))
      case Some(code) => refuse(s"it exited with $code${if (said.isEmpty) "" else s": $said"}")
      case None       => refuse(s"it did not answer within $DescribeLimit")
    }
  }
}

object EngineInterpreter {

  /**
    * What an interpreter says of itself.
    *
    * @param identity        tells the interpreter, with the packages it has, from any other:
    *                        the SHA-256 of its path, version, platform, site directories and
    *                        packages. An environment built on one is not used with another.
    * @param siteDirectories the directories it imports its packages from, in the order it
    *                        searches them
    * @param packages        the packages in those directories, each as `<name>==<version>`, the
    *                        one it imports when two directories hold one name. Only those whose
    *                        name and version pip can read in a requirement are listed.
    */
  final case class Description(
      identity: String,
      siteDirectories: Seq[String],
      packages: Seq[String]
  )

  private val DescribeLimit: FiniteDuration = 2.minutes

  /** The lowercase hex SHA-256 of `text`. */
  private[environment] def sha256Hex(text: String): String =
    Hashing.sha256().hashString(text, StandardCharsets.UTF_8).toString

  // Prints one line of JSON. It reads the distributions' own metadata, so it needs no pip: an
  // interpreter need not have one. A version outside PEP 440, as some system packages have, is
  // left out, since pip refuses a file of constraints that holds one.
  private val DescribeScript: String =
    """import importlib.metadata, json, os, platform, re, site, sys
      |
      |directories = [d for d in site.getsitepackages() if os.path.isdir(d)]
      |if site.ENABLE_USER_SITE and os.path.isdir(site.getusersitepackages()):
      |    directories.insert(0, site.getusersitepackages())
      |name_form = re.compile(r"[a-z0-9]([a-z0-9._-]*[a-z0-9])?", re.IGNORECASE)
      |version_form = re.compile(
      |    r"v?([0-9]+!)?[0-9]+(\.[0-9]+)*"
      |    r"([-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?[0-9]*)?"
      |    r"(-[0-9]+|[-_.]?(post|rev|r)[-_.]?[0-9]*)?"
      |    r"([-_.]?dev[-_.]?[0-9]*)?"
      |    r"(\+[a-z0-9]+([-_.][a-z0-9]+)*)?",
      |    re.IGNORECASE,
      |)
      |imported = {}
      |for distribution in importlib.metadata.distributions(path=directories):
      |    name, version = distribution.metadata["Name"], distribution.version
      |    if name:
      |        imported.setdefault(re.sub(r"[-_.]+", "-", name).lower(), (name, version))
      |packages = sorted(
      |    f"{name}=={version}"
      |    for name, version in imported.values()
      |    if name_form.fullmatch(name) and version and version_form.fullmatch(version)
      |)
      |print(json.dumps({
      |    "executable": os.path.realpath(sys.executable),
      |    "version": sys.version,
      |    "platform": platform.platform(),
      |    "siteDirectories": directories,
      |    "packages": packages,
      |}, sort_keys=True))
      |""".stripMargin
}
