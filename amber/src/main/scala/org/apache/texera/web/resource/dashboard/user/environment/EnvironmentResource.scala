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

package org.apache.texera.web.resource.dashboard.user.environment

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import org.apache.texera.amber.core.workflow.PythonRequirements
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.jooq.generated.Tables.VIRTUAL_ENVIRONMENTS
import org.apache.texera.dao.jooq.generated.tables.records.VirtualEnvironmentsRecord
import org.apache.texera.dao.{SqlServer, SqlStates}
import org.jooq.exception.DataAccessException
import org.jooq.{Condition, DSLContext, JSONB}

import javax.annotation.security.RolesAllowed
import javax.ws.rs._
import javax.ws.rs.core.{MediaType, Response}
import scala.jdk.CollectionConverters._
import scala.util.Try

object EnvironmentResource {

  /** A name for an environment and the packages it holds, each mapped to its version spec. */
  case class EnvironmentRequest(name: String, packages: Map[String, String])

  /** One of the caller's environments, as stored. */
  case class EnvironmentRow(veid: Int, name: String, packages: Map[String, String])

  private val mapper: ObjectMapper = new ObjectMapper().registerModule(DefaultScalaModule)

  /**
    * The packages a row holds in `stored`, each name mapped to its version spec: none for a row
    * with no value. A failure for a value that is not a JSON object of strings, as a row written
    * by hand, or by an older release, may hold.
    */
  def packagesOf(stored: JSONB): Try[Map[String, String]] =
    PythonRequirements.storedPackages(Option(stored).map(_.data()).orNull)
}

/**
  * The Python environments a user keeps: rows of `virtual_environments`, each a name and the
  * packages to install, listed and changed only by the user who owns them.
  *
  * The rows belong to a user, not to any computing unit, so the Dashboard serves them. Every
  * write passes [[PythonRequirements]], the grammar shared with the engine, so a saved environment
  * holds only package names and plain version bounds. A row written before that check existed is
  * listed as stored, and has to pass it to be saved again.
  */
@Path("/environments")
@RolesAllowed(Array("REGULAR", "ADMIN"))
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class EnvironmentResource extends LazyLogging {
  import EnvironmentResource._

  private def context: DSLContext = SqlServer.getInstance().createDSLContext()

  /** The caller's environments, oldest first. */
  @GET
  def list(@Auth user: SessionUser): List[EnvironmentRow] =
    context
      .selectFrom(VIRTUAL_ENVIRONMENTS)
      .where(VIRTUAL_ENVIRONMENTS.UID.eq(user.getUid))
      .orderBy(VIRTUAL_ENVIRONMENTS.VEID)
      .fetch()
      .asScala
      .map(toRow)
      .toList

  /**
    * Saves a new environment for the caller: 201 with its row, 400 when the name or a package
    * breaks the grammar, 409 when the caller already has an environment of that name.
    */
  @POST
  def create(request: EnvironmentRequest, @Auth user: SessionUser): Response = {
    val (name, packages) = validated(request)
    val row = refusingTakenName(name) {
      context
        .insertInto(VIRTUAL_ENVIRONMENTS)
        .set(VIRTUAL_ENVIRONMENTS.UID, user.getUid)
        .set(VIRTUAL_ENVIRONMENTS.NAME, name)
        .set(VIRTUAL_ENVIRONMENTS.PACKAGES, packagesJson(packages))
        .returning()
        .fetchOne()
    }
    Response.status(Response.Status.CREATED).entity(toRow(row)).build()
  }

  /**
    * Renames one of the caller's environments and replaces its packages: 200 with its row, 400
    * when the name or a package breaks the grammar, 404 when the caller has no environment
    * `veid`, 409 when another of the caller's environments has the name.
    */
  @PUT
  @Path("/{veid}")
  def update(
      @PathParam("veid") veid: Int,
      request: EnvironmentRequest,
      @Auth user: SessionUser
  ): EnvironmentRow = {
    val (name, packages) = validated(request)
    val row = refusingTakenName(name) {
      context
        .update(VIRTUAL_ENVIRONMENTS)
        .set(VIRTUAL_ENVIRONMENTS.NAME, name)
        .set(VIRTUAL_ENVIRONMENTS.PACKAGES, packagesJson(packages))
        .where(ownedBy(veid, user))
        .returning()
        .fetchOne()
    }
    toRow(Option(row).getOrElse(throw notTheCallers))
  }

  /** Deletes one of the caller's environments: 204, or 404 when the caller has no `veid`. */
  @DELETE
  @Path("/{veid}")
  def delete(@PathParam("veid") veid: Int, @Auth user: SessionUser): Response = {
    if (context.deleteFrom(VIRTUAL_ENVIRONMENTS).where(ownedBy(veid, user)).execute() == 0)
      throw notTheCallers
    Response.noContent().build()
  }

  /**
    * The trimmed name and the packages of `request`, or 400 with the first problem the grammar
    * finds. Missing packages are none, and a missing version is any version.
    */
  private def validated(request: EnvironmentRequest): (String, Map[String, String]) = {
    val name = Option(request).flatMap(r => Option(r.name)).map(_.trim).getOrElse("")
    val packages =
      Option(request).flatMap(r => Option(r.packages)).getOrElse(Map.empty[String, String])
    PythonRequirements
      .validateName(name)
      .flatMap(_ => PythonRequirements.canonicalLines(packages))
      .fold(
        problem => throw new BadRequestException(problem),
        _ => (name, packages.map { case (pkg, spec) => pkg -> Option(spec).getOrElse("") })
      )
  }

  /** `write`, or 409 when it would give the caller two environments named `name`. */
  private def refusingTakenName[T](name: String)(write: => T): T =
    try write
    catch {
      case e: DataAccessException if e.sqlState() == SqlStates.UNIQUE_VIOLATION =>
        throw new WebApplicationException(
          s"""An environment named "$name" already exists.""",
          Response.Status.CONFLICT
        )
    }

  private def ownedBy(veid: Int, user: SessionUser): Condition =
    VIRTUAL_ENVIRONMENTS.VEID
      .eq(Integer.valueOf(veid))
      .and(VIRTUAL_ENVIRONMENTS.UID.eq(user.getUid))

  // The same answer whether the environment belongs to another user or does not exist, so a
  // caller learns nothing about other users' rows. The page shows it, so it names no id.
  private def notTheCallers: NotFoundException =
    new NotFoundException("This environment does not exist or is not yours.")

  private def toRow(record: VirtualEnvironmentsRecord): EnvironmentRow =
    EnvironmentRow(record.getVeid, record.getName, packagesOf(record))

  // A row is listed as stored. One whose packages are not a JSON object of strings (written by
  // hand, or by an older release) is listed with none rather than failing the caller's list.
  private def packagesOf(record: VirtualEnvironmentsRecord): Map[String, String] =
    EnvironmentResource.packagesOf(record.getPackages).getOrElse {
      logger.warn(
        s"Environment ${record.getVeid} holds packages that are not a JSON object of strings; " +
          "listing it with none."
      )
      Map.empty
    }

  private def packagesJson(packages: Map[String, String]): JSONB =
    JSONB.valueOf(mapper.writeValueAsString(packages))
}
