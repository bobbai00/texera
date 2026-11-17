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

package org.apache.texera.web.service.execution

import org.apache.texera.amber.core.workflow.{PythonEnvironment, PythonRequirements}
import org.apache.texera.common.compiler.{PythonEnvironmentNotResolved, PythonEnvironmentResolver}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.VIRTUAL_ENVIRONMENTS
import org.apache.texera.web.resource.dashboard.user.environment.EnvironmentResource

import scala.util.{Failure, Success}

/**
  * Resolves a Python environment's name to the environment user `uid` keeps under it: a row of
  * `virtual_environments`, as the user saved it at the Dashboard. Only the user's own rows are
  * looked at: an environment of that name that another user keeps is not this user's to run in.
  *
  * The packages of the row are made into the canonical lines a plan carries
  * ([[PythonRequirements.canonicalLines]]). A row saved before packages were checked may hold
  * some that pip may not read; such an environment is not resolved until its user saves it
  * again.
  */
final class UserEnvironmentResolver(uid: Integer) extends PythonEnvironmentResolver {

  override def resolve(name: String): PythonEnvironment = {
    val stored = Option(
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(VIRTUAL_ENVIRONMENTS.PACKAGES)
        .from(VIRTUAL_ENVIRONMENTS)
        .where(VIRTUAL_ENVIRONMENTS.UID.eq(uid).and(VIRTUAL_ENVIRONMENTS.NAME.eq(name)))
        .fetchOne()
    ).getOrElse(throw PythonEnvironmentNotResolved.noSuchEnvironment(name))
    val packages = EnvironmentResource.packagesOf(stored.value1()) match {
      case Success(packages) => packages
      case Failure(_) =>
        throw PythonEnvironmentNotResolved.notInstallable(
          name,
          "its packages are not stored as names with version bounds."
        )
    }
    PythonRequirements.canonicalLines(packages) match {
      case Right(lines)  => PythonEnvironment(name, lines)
      case Left(problem) => throw PythonEnvironmentNotResolved.notInstallable(name, problem)
    }
  }
}
