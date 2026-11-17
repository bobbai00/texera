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

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.{HexFormat, Locale}
import scala.util.matching.Regex

/**
  * What a Python environment may hold: its name, and the packages pip installs into it.
  *
  * A user names an environment and lists its packages, each a package name with an optional
  * version bound. `validateName` and `canonicalLines` check what a user writes; `validateLine`
  * checks a line that arrives from elsewhere, before pip reads it. Only a package name and a plain
  * version bound get through, so nothing a user writes reaches pip as an option (`-r`,
  * `--index-url`), a URL or a path (`pkg @ https://…`), an environment marker (`;`), a list of
  * bounds (`,`) or an extra (`pkg[extra]`).
  *
  * The canonical form of a package list is one `<normalized name><spec>` line per distinct
  * requirement, sorted; a package listed under two spellings with different bounds gives one line
  * per bound. Its digest names the list: two lists that ask for the same packages, in any order or
  * spelling of their names, have one digest.
  */
object PythonRequirements {

  /** The most packages one environment may list. */
  private val MaxPackages = 200

  private val MaxPackageNameLength = 128
  private val EnvironmentName: Regex = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}".r
  private val PackageName: Regex = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?".r
  private val Version: Regex = "[A-Za-z0-9][A-Za-z0-9.+!*_-]{0,63}".r
  private val Operators = Seq("==", ">=", "<=")
  private val NameSeparators: Regex = "[-_.]+".r

  /** What is wrong with one part of a requirement: the part, as a message names it, and why. */
  private final case class Problem(part: String, reason: String)

  /**
    * `name` if it can name an environment: a letter or digit, then up to 127 letters, digits,
    * '.', '_' or '-'.
    *
    * So a name is never '.' or '..', and never starts like an option: it is safe to write into a
    * path or a command line. The name is checked as given; a caller that accepts surrounding
    * spaces trims them first.
    */
  def validateName(name: String): Either[String, String] =
    if (name == null || name.isEmpty) Left("An environment needs a name.")
    else if (EnvironmentName.matches(name)) Right(name)
    else
      Left(
        s"Environment name ${shown(name)} is not valid: use 1 to 128 letters, digits, '.', '_' " +
          "or '-', starting with a letter or digit."
      )

  /** The PEP 503 form of a package name: lowercase, each run of '-', '_' and '.' one '-'. */
  private def normalizePackageName(name: String): String =
    NameSeparators.replaceAllIn(name, "-").toLowerCase(Locale.ROOT)

  /**
    * The canonical lines of an environment's packages, or why pip may not read them.
    *
    * @param packages each package name mapped to its version spec: empty for any version, or
    *                 `==V`, `>=V` or `<=V`. A null map lists no packages; a null spec is empty.
    * @return one `<normalized name><spec>` line per distinct requirement, sorted (a package
    *         listed under two spellings with different bounds gives one line per bound); or what
    *         is wrong with the first package, by name, that breaks the grammar
    */
  def canonicalLines(packages: Map[String, String]): Either[String, Seq[String]] = {
    val entries = Option(packages).getOrElse(Map.empty[String, String]).toSeq
    if (entries.size > MaxPackages)
      Left(s"An environment lists at most $MaxPackages packages; this one lists ${entries.size}.")
    else
      entries
        .sortBy { case (name, _) => Option(name).getOrElse("") }
        .foldLeft[Either[Problem, Vector[String]]](Right(Vector.empty)) {
          case (Right(lines), (name, spec)) =>
            requirementLine(name, Option(spec).getOrElse("")).map(lines :+ _)
          case (problem, _) => problem
        }
        .map(_.distinct.sorted)
        .left
        .map(problem => s"${problem.part} is not valid: ${problem.reason}.")
  }

  /** The lowercase hex SHA-256 of `lines` joined by '\n': the name of a canonical package list. */
  def digest(lines: Seq[String]): String =
    HexFormat
      .of()
      .formatHex(
        MessageDigest
          .getInstance("SHA-256")
          .digest(lines.mkString("\n").getBytes(StandardCharsets.UTF_8))
      )

  /**
    * `line` if it is a canonical requirement line, as `canonicalLines` writes them: a normalized
    * package name, then nothing or `==V`, `>=V` or `<=V`. For checking lines that arrive from
    * elsewhere before pip reads them.
    */
  def validateLine(line: String): Either[String, String] =
    if (line == null || line.isEmpty) Left("A requirement line is empty.")
    else {
      val specStart = line.indexWhere(c => c == '=' || c == '>' || c == '<')
      val (name, spec) = if (specStart < 0) (line, "") else line.splitAt(specStart)
      requirementLine(name, spec) match {
        case Left(problem) =>
          Left(s"Requirement line ${shown(line)} is not valid: ${problem.reason}.")
        case Right(canonical) if canonical != line =>
          Left(
            s"Requirement line ${shown(line)} is not in canonical form; expected ${shown(canonical)}."
          )
        case Right(_) => Right(line)
      }
    }

  private def requirementLine(name: String, spec: String): Either[Problem, String] =
    for {
      _ <- validatePackageName(name)
      _ <- validateSpec(name, spec)
    } yield normalizePackageName(name) + spec

  private def validatePackageName(name: String): Either[Problem, Unit] = {
    def invalid(reason: String) = Left(Problem(s"Package ${shown(name)}", reason))
    if (name == null || name.isEmpty) invalid("the name is empty")
    else
      refusal(name) match {
        case Some(reason) => invalid(reason)
        case None if name.length > MaxPackageNameLength =>
          invalid(s"a package name has at most $MaxPackageNameLength characters")
        case None if !PackageName.matches(name) =>
          invalid(
            "a package name has letters, digits, '.', '_' or '-', and starts and ends with a " +
              "letter or digit"
          )
        case None => Right(())
      }
  }

  private def validateSpec(packageName: String, spec: String): Either[Problem, Unit] = {
    def invalid(reason: String) =
      Left(Problem(s"Version ${shown(spec)} of package ${shown(packageName)}", reason))
    if (spec.isEmpty) Right(())
    else
      refusal(spec) match {
        case Some(reason) => invalid(reason)
        case None =>
          Operators.find(op => spec.startsWith(op)) match {
            case None => invalid("a version bound starts with ==, >= or <=")
            case Some(op) if !Version.matches(spec.substring(op.length)) =>
              invalid(
                s"the version after $op has up to 64 letters, digits, '.', '+', '!', '*', '_' " +
                  "or '-', and starts with a letter or digit"
              )
            case Some(_) => Right(())
          }
      }
  }

  /**
    * Why pip would read `text` as more than a package name or a version bound, if it would: a
    * leading '-' is an option, whitespace ends the requirement, ',' joins bounds, ';' starts a
    * marker, '@', '/' and ':' make a URL or a path, and '[' starts an extra.
    */
  private def refusal(text: String): Option[String] =
    if (text.startsWith("-")) Some("it starts with '-'")
    else
      text.collectFirst {
        case c if Character.isWhitespace(c)          => "it contains whitespace"
        case c @ (',' | ';' | '@' | '/' | ':' | '[') => s"it contains '$c'"
      }

  /** `text` quoted for a message: control characters escaped, and cut after 64 characters. */
  private def shown(text: String): String = {
    val visible = Option(text).getOrElse("").flatMap {
      case c if Character.isISOControl(c) => "\\" + "u%04x".format(c.toInt)
      case c                              => c.toString
    }
    "\"" + (if (visible.length > 64) visible.take(64) + "…" else visible) + "\""
  }
}
