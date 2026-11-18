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

/**
  * The repositories an operator's code reads, named when its plan is made to run and mounted by
  * the computing unit that runs it. An operator that reads none holds no value at all.
  *
  * @param locators the repositories to mount, each "<repositoryName>:<commitHash>"
  * @throws IllegalArgumentException if `locators` is empty or holds something that is no locator
  */
final case class RepositoryMounts(locators: Set[String]) {
  require(locators != null && locators.nonEmpty, "Mounts name no repository.")
  locators.foreach(RepositoryMounts.parseLocator)
}

object RepositoryMounts {

  // A repository's name and a commit's hash each name a directory where the repository is
  // mounted, so each is letters, digits, '.', '_' and '-' after a first letter or digit, as the
  // mount authority takes them: no path separator, ".." or option is one.
  private val Segment = "[A-Za-z0-9][A-Za-z0-9._-]*".r

  /** The locator of a repository pinned to one commit. */
  def locator(repositoryName: String, commitHash: String): String =
    s"$repositoryName:$commitHash"

  /**
    * The repository name and commit hash `locator` names.
    *
    * @throws IllegalArgumentException if it is not "<repositoryName>:<commitHash>"
    */
  def parseLocator(locator: String): (String, String) =
    Option(locator).getOrElse("").split(":", 2) match {
      case Array(repository, commit) if Segment.matches(repository) && Segment.matches(commit) =>
        (repository, commit)
      case _ =>
        throw new IllegalArgumentException(
          s"Invalid mount locator '$locator'; expected <repositoryName>:<commitHash>, each of " +
            "letters, digits, '.', '_' and '-', starting with a letter or digit."
        )
    }
}
