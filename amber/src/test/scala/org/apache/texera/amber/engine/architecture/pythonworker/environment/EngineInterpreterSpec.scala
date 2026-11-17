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

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat
import scala.concurrent.duration.DurationInt

/**
  * What the engine's interpreter is taken to say of itself, on a [[FakePython]]. The script a
  * real interpreter is asked with is run by the integration suite
  * (`PythonEnvironmentIntegrationSpec`).
  */
class EngineInterpreterSpec extends AnyFlatSpec with Matchers {

  private def sha256Hex(text: String): String =
    HexFormat
      .of()
      .formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)))

  private def failureOf(python: FakePython): String =
    (the[IllegalStateException] thrownBy
      new EngineInterpreter(python.executable, python).description).getMessage

  private val couldNotBeAsked =
    "The engine's Python interpreter '/opt/engine/bin/python' could not be asked what it holds: "

  "EngineInterpreter" should "take what the interpreter answers for where it imports from and what it holds" in {
    val python = new FakePython()

    val description = new EngineInterpreter(python.executable, python).description

    description.siteDirectories shouldBe python.siteDirectories
    description.packages shouldBe python.packages
    // The interpreter is run once, with a script, and given two minutes to answer.
    python.runs should have size 1
    python.runs.head.command.take(2) shouldBe Seq(python.executable, "-c")
    python.runs.head.command(2) should include("importlib.metadata")
    python.runs.head.environment shouldBe empty
    python.runs.head.limit shouldBe 2.minutes
  }

  it should "tell one interpreter from another by all it says of itself" in {
    val python = new FakePython()
    val identity = new EngineInterpreter(python.executable, python).description.identity

    identity shouldBe sha256Hex(python.description)
    // The same answer is the same interpreter, whoever asks.
    new EngineInterpreter(
      python.executable,
      new FakePython()
    ).description.identity shouldBe identity
    // Another path, other directories or another package are another.
    Seq(
      new FakePython(executable = "/opt/another/bin/python"),
      new FakePython(siteDirectories = Seq("/opt/engine/lib/python3.12/site-packages")),
      new FakePython(packages = Seq("numpy==2.1.1", "pandas==2.2.3", "pip==24.0"))
    ).foreach { other =>
      new EngineInterpreter(other.executable, other).description.identity should not be identity
    }
  }

  it should "ask the interpreter once, and keep its answer" in {
    val python = new FakePython()
    val engine = new EngineInterpreter(python.executable, python)

    val first = engine.description
    engine.description should be theSameInstanceAs first
    python.runs should have size 1
  }

  it should "read the answer on the last line, after whatever the interpreter wrote before it" in {
    val python = new FakePython()
    python.describe = () =>
      ProcessOutcome(
        Some(0),
        Seq("DeprecationWarning: something is deprecated", python.description)
      )

    new EngineInterpreter(python.executable, python).description.packages shouldBe python.packages
  }

  it should "fail when the interpreter exits with an error, saying its last word" in {
    val python = new FakePython()
    python.describe = () =>
      ProcessOutcome(Some(1), Seq("Traceback (most recent call last):", "ImportError: no site"))
    failureOf(python) shouldBe couldNotBeAsked + "it exited with 1: ImportError: no site"

    python.describe = () => ProcessOutcome(Some(9), Nil)
    failureOf(python) shouldBe couldNotBeAsked + "it exited with 9"
  }

  it should "fail when the interpreter answers anything but what it was asked for" in {
    val python = new FakePython()
    Seq(
      Seq("Python 3.11.14"),
      Seq("""{"siteDirectories": ["/opt/engine/site"]}"""),
      Seq("""{"siteDirectories": "/opt/engine/site", "packages": []}"""),
      Seq("[]"),
      Nil
    ).foreach { answer =>
      withClue(s"$answer: ") {
        python.describe = () => ProcessOutcome(Some(0), answer)
        failureOf(python) shouldBe
          couldNotBeAsked + s"it answered '${answer.lastOption.getOrElse("")}'"
      }
    }
  }

  it should "fail when the interpreter does not answer in time, or cannot be run" in {
    val python = new FakePython()
    python.describe = () => ProcessOutcome(None, Nil)
    failureOf(python) shouldBe couldNotBeAsked + "it did not answer within 2 minutes"

    val notFound = new IOException("Cannot run program \"/opt/engine/bin/python\": error=2")
    python.describe = () => throw notFound
    val failure = the[IllegalStateException] thrownBy
      new EngineInterpreter(python.executable, python).description
    failure.getMessage shouldBe couldNotBeAsked + notFound.getMessage
    failure.getCause should be theSameInstanceAs notFound
  }

  it should "ask again after a failure, and keep the first answer it gets" in {
    val python = new FakePython()
    val engine = new EngineInterpreter(python.executable, python)
    val answer = python.describe
    python.describe = () => ProcessOutcome(Some(1), Nil)
    an[IllegalStateException] should be thrownBy engine.description

    python.describe = answer
    engine.description.packages shouldBe python.packages
    engine.description
    python.runs should have size 2
  }
}
