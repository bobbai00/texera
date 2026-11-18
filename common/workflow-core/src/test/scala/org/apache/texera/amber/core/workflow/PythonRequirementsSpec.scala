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

import org.apache.texera.amber.core.workflow.PythonRequirements._
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import scala.util.Success

class PythonRequirementsSpec extends AnyFlatSpec with Matchers {

  /** The problem `canonicalLines` reports for `packages`, failing the test if it reports none. */
  private def refusalOf(packages: Map[String, String]): String =
    canonicalLines(packages) match {
      case Left(problem) => problem
      case Right(lines)  => fail(s"$packages was accepted as $lines")
    }

  /** The problem `validateLine` reports for `line`, failing the test if it reports none. */
  private def lineRefusalOf(line: String): String =
    validateLine(line) match {
      case Left(problem) => problem
      case Right(_)      => fail(s"line '$line' was accepted")
    }

  "PythonRequirements.validateName" should "accept a letter or digit, then up to 127 letters, digits, '.', '_' and '-'" in {
    for (
      name <-
        Seq("ml", "ML_env-2.0", "a", "1", "0.x", "ml-", "ml.", "a..b", "a" * 128, "a" + "-" * 127)
    )
      validateName(name) shouldBe Right(name)
  }

  it should "refuse a missing or empty name" in {
    validateName(null) shouldBe Left("An environment needs a name.")
    validateName("") shouldBe Left("An environment needs a name.")
  }

  it should "refuse any other character, more than 128 characters, and surrounding spaces" in {
    for (name <- Seq("bad name", "a/b", "env-ä", "a" * 129, " ml", "ml\n", "a:b", "ml;rm")) {
      val problem = validateName(name).left.getOrElse(fail(s"'$name' was accepted"))
      problem should startWith("Environment name \"")
      problem should endWith(
        "use 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit."
      )
    }
  }

  it should "refuse a name that is only dots or starts with '.', '_' or '-'" in {
    // Written into a path, "." and ".." name another directory; written into a command line, a
    // leading '-' reads as an option.
    for (name <- Seq(".", "..", ".x", "../escape", "-x", "--index-url", "_x", ".env-1.0"))
      validateName(name) shouldBe Left(
        s"""Environment name "$name" is not valid: use 1 to 128 letters, digits, '.', '_' or '-', """ +
          "starting with a letter or digit."
      )
  }

  "PythonRequirements.canonicalLines" should "write a package name in its PEP 503 form: lowercase, each run of '-', '_' and '.' one '-'" in {
    canonicalLines(Map("NumPy" -> "")) shouldBe Right(Seq("numpy"))
    canonicalLines(Map("Foo.Bar_baz--Qux" -> "==1.0")) shouldBe Right(Seq("foo-bar-baz-qux==1.0"))
    canonicalLines(Map("a._-b" -> "")) shouldBe Right(Seq("a-b"))
    canonicalLines(Map("already-normal" -> "")) shouldBe Right(Seq("already-normal"))
  }

  it should "write one normalized line per package, sorted" in {
    canonicalLines(
      Map("tabulate" -> "==0.9.0", "Requests" -> "", "NumPy" -> ">=1.26")
    ) shouldBe Right(Seq("numpy>=1.26", "requests", "tabulate==0.9.0"))
  }

  it should "write each package once however its name is spelled" in {
    canonicalLines(
      Map("NumPy" -> "==1.26.0", "numpy" -> "==1.26.0", "num_py" -> "")
    ) shouldBe Right(Seq("num-py", "numpy==1.26.0"))
  }

  it should "keep every distinct bound of one package, sorted" in {
    canonicalLines(Map("numpy" -> "<=2.0", "NumPy" -> ">=1.26")) shouldBe Right(
      Seq("numpy<=2.0", "numpy>=1.26")
    )
  }

  it should "read no packages as no lines, and a missing version as any version" in {
    canonicalLines(Map.empty) shouldBe Right(Seq.empty)
    canonicalLines(null) shouldBe Right(Seq.empty)
    canonicalLines(Map("requests" -> null)) shouldBe Right(Seq("requests"))
  }

  it should "accept each version bound the grammar allows" in {
    for (
      spec <- Seq(
        "",
        "==1.26.0",
        ">=1.0",
        "<=2",
        "==1.26.*",
        "==1!2.0",
        "==1.0+local.7",
        "==2.0rc1",
        "==1.0_post-1",
        ">=" + "1" * 64
      )
    ) canonicalLines(Map("pkg" -> spec)) shouldBe Right(Seq(s"pkg$spec"))
  }

  it should "accept a package name of up to 128 characters, and refuse a longer one" in {
    canonicalLines(Map("a" * 128 -> "")) shouldBe Right(Seq("a" * 128))
    refusalOf(Map("a" * 129 -> "")) should endWith(
      "is not valid: a package name has at most 128 characters."
    )
  }

  it should "accept up to 200 packages, and refuse more" in {
    def packages(count: Int) = (1 to count).map(i => s"pkg$i" -> "").toMap
    canonicalLines(packages(200)).map(_.size) shouldBe Right(200)
    refusalOf(packages(201)) shouldBe
      "An environment lists at most 200 packages; this one lists 201."
  }

  it should "refuse a package name pip would read as an option, a URL, a marker, a list or an extra" in {
    val refused = Seq(
      "-r x" -> "it starts with '-'",
      "--index-url" -> "it starts with '-'",
      "pkg @ https://example.com/pkg.whl" -> "it contains whitespace",
      "pkg@https://example.com/pkg.whl" -> "it contains '@'",
      "a,b" -> "it contains ','",
      "x y" -> "it contains whitespace",
      "x\ty" -> "it contains whitespace",
      "numpy\n--index-url" -> "it contains whitespace",
      "pkg[extra]" -> "it contains '['",
      "numpy;python_version<'3.8'" -> "it contains ';'",
      "./local/pkg" -> "it contains '/'",
      "git+https:x" -> "it contains ':'"
    )
    for ((name, reason) <- refused)
      refusalOf(Map(name -> "")) should (startWith("Package \"") and endWith(
        s"is not valid: $reason."
      ))
  }

  it should "refuse a package name outside the name grammar" in {
    for (name <- Seq("pkg_", "_pkg", ".pkg", "pkg.", "nümpy", "pkg~", "pkg!", "pkg+1", "pkg*")) {
      refusalOf(Map(name -> "")) shouldBe
        s"""Package "$name" is not valid: a package name has letters, digits, '.', '_' or '-', """ +
          "and starts and ends with a letter or digit."
    }
    refusalOf(Map("" -> "==1.0")) shouldBe "Package \"\" is not valid: the name is empty."
  }

  it should "refuse a version bound that is not ==, >= or <= followed by a version" in {
    for (spec <- Seq("~=1.0", "!=1.0", ">1.0", "<1.0", "1.0", "=1.0", "latest"))
      refusalOf(Map("numpy" -> spec)) shouldBe
        s"""Version "$spec" of package "numpy" is not valid: a version bound starts with ==, >= or <=."""
  }

  it should "refuse a version that is missing, too long or outside the version grammar" in {
    for (
      (spec, op) <- Seq(
        "==" -> "==",
        ">=" -> ">=",
        "===1.0" -> "==",
        "==.1" -> "==",
        "<=1$" -> "<=",
        ">=" + "1" * 65 -> ">="
      )
    )
      refusalOf(Map("numpy" -> spec)) should endWith(
        s"is not valid: the version after $op has up to 64 letters, digits, '.', '+', '!', '*', " +
          "'_' or '-', and starts with a letter or digit."
      )
  }

  it should "refuse a version bound pip would read as more than a bound" in {
    val refused = Seq(
      "==1.0,<2" -> "it contains ','",
      "== 1.0" -> "it contains whitespace",
      "==1.0; python_version<'3.8'" -> "it contains ';'",
      "@ https://example.com/pkg.whl" -> "it contains '@'",
      "-r requirements.txt" -> "it starts with '-'",
      "==1.0\n--index-url" -> "it contains whitespace"
    )
    for ((spec, reason) <- refused)
      refusalOf(Map("numpy" -> spec)) should (startWith("Version \"") and endWith(
        s"""of package "numpy" is not valid: $reason."""
      ))
  }

  it should "report the first package by name that breaks the grammar" in {
    refusalOf(Map("zeta" -> "~=1", "alpha" -> "~=2", "mid" -> "")) should include("\"alpha\"")
  }

  it should "show a refused value with its control characters escaped and its length cut" in {
    // A message may reach a log, so a line break in a refused value must not start a new line.
    val escapedLineBreak = "\\" + "u000a"
    refusalOf(Map("numpy\n--index-url" -> "")) should include(
      "\"numpy" + escapedLineBreak + "--index-url\""
    )
    val long = "x" * 100 + " y"
    refusalOf(Map(long -> "")) should include("\"" + "x" * 64 + "…\"")
  }

  "PythonRequirements.digest" should "be the lowercase hex SHA-256 of the lines joined by newlines" in {
    digest(Seq("numpy>=1.26", "requests", "tabulate==0.9.0")) shouldBe
      "f6cbc121cb6d99633ad29852dc7ca1b82432718de14ef67d21295d11ed45f042"
    digest(Seq("requests")) shouldBe
      "ec72420df5dfbdce4111f715c96338df3b7cb75f58e478d2449c9720e560de8c"
    digest(Seq.empty) shouldBe "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }

  it should "name two package lists alike exactly when they ask for the same packages" in {
    val digestOf = (packages: Map[String, String]) => canonicalLines(packages).map(digest)
    digestOf(Map("NumPy" -> "==1.26.0", "requests" -> "")) shouldBe
      digestOf(Map("requests" -> "", "numpy" -> "==1.26.0"))
    digestOf(Map("numpy" -> "==1.26.0")) should not be digestOf(Map("numpy" -> "==1.26.1"))
    digestOf(Map("numpy" -> "")) should not be digestOf(Map.empty)
  }

  "PythonRequirements.validateLine" should "accept every line canonicalLines writes" in {
    val lines = canonicalLines(
      Map("NumPy" -> ">=1.26", "requests" -> "", "Foo_Bar" -> "<=2", "tabulate" -> "==0.9.*")
    ).getOrElse(fail("the packages were refused"))
    lines.foreach(line => validateLine(line) shouldBe Right(line))
  }

  it should "refuse a valid line that is not in canonical form" in {
    lineRefusalOf("NumPy==1.0") shouldBe
      "Requirement line \"NumPy==1.0\" is not in canonical form; expected \"numpy==1.0\"."
    lineRefusalOf("foo_bar") shouldBe
      "Requirement line \"foo_bar\" is not in canonical form; expected \"foo-bar\"."
  }

  it should "refuse a line pip would read as an option, a URL, a marker, a list or an extra" in {
    val refused = Seq(
      "-r requirements.txt" -> "it starts with '-'",
      "--index-url=https://example.com/simple" -> "it starts with '-'",
      "pkg @ https://example.com/pkg.whl" -> "it contains whitespace",
      "a,b" -> "it contains ','",
      "x y" -> "it contains whitespace",
      "pkg[extra]" -> "it contains '['",
      "numpy;python_version<'3.8'" -> "it contains ';'",
      "numpy==1.0,<2" -> "it contains ','",
      "numpy==1.0\n-r evil.txt" -> "it contains whitespace",
      "numpy~=1.0" -> ("a package name has letters, digits, '.', '_' or '-', and starts and " +
        "ends with a letter or digit"),
      "numpy>1.0" -> "a version bound starts with ==, >= or <=",
      "numpy==" -> ("the version after == has up to 64 letters, digits, '.', '+', '!', '*', " +
        "'_' or '-', and starts with a letter or digit")
    )
    for ((line, reason) <- refused)
      lineRefusalOf(line) should (startWith("Requirement line \"") and endWith(
        s"is not valid: $reason."
      ))
  }

  it should "refuse an empty or missing line" in {
    lineRefusalOf("") shouldBe "A requirement line is empty."
    lineRefusalOf(null) shouldBe "A requirement line is empty."
  }

  "PythonRequirements.storedPackages" should "read the packages a row keeps, each name with its version spec" in {
    storedPackages("""{"Tabulate": "==0.9.0", "numpy": ""}""") shouldBe
      Success(Map("Tabulate" -> "==0.9.0", "numpy" -> ""))
    storedPackages("{}") shouldBe Success(Map.empty)
  }

  it should "read a row with no value as one that lists no package" in {
    storedPackages(null) shouldBe Success(Map.empty)
  }

  it should "fail on a value that is not a JSON object of strings" in {
    Seq(
      """["tabulate==0.9.0"]""",
      "\"tabulate\"",
      """{"tabulate": {"version": "0.9.0"}}""",
      "null",
      "not JSON",
      ""
    ).foreach { stored =>
      withClue(s"[$stored]: ") {
        storedPackages(stored).isFailure shouldBe true
      }
    }
  }
}
