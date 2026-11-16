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
  * The repositories an operator's code reads, and the directory it reads them under: fixed when
  * a plan to run is made, so the engine only has to mount them.
  *
  * The two go together. The code was written against `root`, so naming a repository without it
  * would leave the engine unable to check that it mounts where the code looks; an operator that
  * reads no repository holds no value at all. Neither part may be empty.
  *
  * @param root     the directory a computing unit mounts repositories under, as the code names
  *                 it: each repository is read from `<root>/<repositoryName>/<commitHash>`
  * @param locators the repositories to mount, each "<repositoryName>:<commitHash>"
  * @throws IllegalArgumentException if `root` is blank, or `locators` is empty or holds
  *                                  something that is not a locator
  */
final case class RepositoryMounts(root: String, locators: Set[String]) {
  require(
    root != null && root.trim.nonEmpty,
    s"Repositories ${Option(locators)
      .getOrElse(Set.empty)
      .map(String.valueOf)
      .toSeq
      .sorted
      .mkString(", ")} name no directory their code reads them under."
  )
  require(locators != null && locators.nonEmpty, s"Mounts under $root name no repository.")
  locators.foreach(RepositoryMounts.parseLocator)
}

object RepositoryMounts {

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
      case Array(repository, commit) if repository.nonEmpty && commit.nonEmpty =>
        (repository, commit)
      case _ =>
        throw new IllegalArgumentException(
          s"Invalid mount locator '$locator'; expected <repositoryName>:<commitHash>."
        )
    }

  /**
    * `mounts` with each root once, naming every repository read under it: what operators that
    * run together need mounted, one request per root.
    */
  def byRoot(mounts: Iterable[RepositoryMounts]): Iterable[RepositoryMounts] =
    mounts
      .groupMapReduce(_.root)(_.locators)(_ ++ _)
      .map { case (root, locators) => RepositoryMounts(root, locators) }
}
