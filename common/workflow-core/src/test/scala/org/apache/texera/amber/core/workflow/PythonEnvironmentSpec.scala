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

package org.apache.texera.amber.core.workflow

import org.scalatest.flatspec.AnyFlatSpec

class PythonEnvironmentSpec extends AnyFlatSpec {

  private def refusal(name: String, requirements: Seq[String]): String =
    intercept[IllegalArgumentException](PythonEnvironment(name, requirements)).getMessage

  "PythonEnvironment" should "hold its name and the canonical lines it is given" in {
    val lines = Seq("numpy>=2.1.0", "requests", "tabulate==0.9.0")
    val environment = PythonEnvironment("ml", lines)
    assert(environment.name == "ml")
    assert(environment.requirements == lines)
  }

  it should "hold what PythonRequirements makes of a user's packages" in {
    val lines = PythonRequirements
      .canonicalLines(Map("Tabulate" -> "==0.9.0", "typing_extensions" -> "", "numpy" -> ">=2.1"))
      .getOrElse(fail("the packages are not ones pip may read"))
    assert(
      PythonEnvironment("ml", lines).requirements ==
        Seq("numpy>=2.1", "tabulate==0.9.0", "typing-extensions")
    )
  }

  it should "install nothing when it lists no package" in {
    assert(PythonEnvironment("bare", Seq.empty).requirements.isEmpty)
  }

  it should "name its package list by the digest of its lines, whatever it is called" in {
    val lines = Seq("requests", "tabulate==0.9.0")
    val environment = PythonEnvironment("ml", lines)
    assert(environment.digest == PythonRequirements.digest(lines))
    // The lowercase hex SHA-256 of "requests\ntabulate==0.9.0".
    assert(
      environment.digest == "9c9800b3003381e75ed6c0a3ac983d703b5494bcaf2b8938139c204148683879"
    )
    assert(PythonEnvironment("another-name", lines).digest == environment.digest)
    assert(PythonEnvironment("ml", lines :+ "zstandard").digest != environment.digest)
    assert(PythonEnvironment("ml", Seq.empty).digest == PythonRequirements.digest(Seq.empty))
  }

  it should "equal an environment of the same name and lines only" in {
    val environment = PythonEnvironment("ml", Seq("tabulate==0.9.0"))
    assert(environment == PythonEnvironment("ml", Seq("tabulate==0.9.0")))
    assert(environment != PythonEnvironment("ml", Seq("tabulate==0.8.10")))
    assert(environment != PythonEnvironment("ml2", Seq("tabulate==0.9.0")))
  }

  it should "refuse a line pip would read as more than a package and a version bound" in {
    Seq(
      "-r requirements.txt",
      "--index-url=https://example.com/simple",
      "pkg @ https://example.com/pkg.whl",
      "pkg[extra]",
      "pkg==1.0,<2",
      "pkg; python_version < '3'",
      "pkg ==1.0",
      ""
    ).foreach { line =>
      withClue(s"[$line]: ") {
        val message = refusal("ml", Seq(line))
        assert(message.startsWith("Python environment 'ml' cannot be installed: "), message)
      }
    }
  }

  it should "refuse a line that is not in canonical form, naming the form expected" in {
    val message = refusal("ml", Seq("Typing_Extensions==4.14.1"))
    assert(message.contains("\"Typing_Extensions==4.14.1\""), message)
    assert(message.contains("\"typing-extensions==4.14.1\""), message)
  }

  it should "refuse lines that are not sorted, or that list a requirement twice" in {
    assert(
      refusal("ml", Seq("tabulate==0.9.0", "requests")) ==
        "The requirements of Python environment 'ml' are not sorted, each once: " +
          "tabulate==0.9.0, requests"
    )
    assert(
      refusal("ml", Seq("requests", "requests")) ==
        "The requirements of Python environment 'ml' are not sorted, each once: requests, requests"
    )
  }

  it should "refuse a blank name, and none" in {
    Seq("", "   ", null).foreach { name =>
      withClue(s"[$name]: ") {
        assert(refusal(name, Seq("requests")) == "A Python environment needs a name.")
      }
    }
  }

  "PythonEnvironmentRef" should "tell the engine's own environment, a name and a resolved one apart" in {
    val environment = PythonEnvironment("ml", Seq("tabulate==0.9.0"))
    val refs: Seq[PythonEnvironmentRef] = Seq(
      PythonEnvironmentRef.EngineDefault,
      PythonEnvironmentRef.Named("ml"),
      PythonEnvironmentRef.Resolved(environment)
    )
    assert(refs.distinct.size == 3)
    assert(PythonEnvironmentRef.Named("ml") == PythonEnvironmentRef.Named("ml"))
    assert(PythonEnvironmentRef.Named("ml") != PythonEnvironmentRef.Named("ML"))
    assert(
      PythonEnvironmentRef.Resolved(environment) ==
        PythonEnvironmentRef.Resolved(PythonEnvironment("ml", Seq("tabulate==0.9.0")))
    )
  }

  it should "say the name an operator asks for its environment by, resolved or not" in {
    assert(PythonEnvironmentRef.EngineDefault.environmentName.isEmpty)
    assert(PythonEnvironmentRef.Named("ml").environmentName.contains("ml"))
    assert(
      PythonEnvironmentRef
        .Resolved(PythonEnvironment("ml", Seq("tabulate==0.9.0")))
        .environmentName
        .contains("ml")
    )
  }
}
