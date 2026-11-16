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
import io.dropwizard.jackson.Jackson
import io.dropwizard.jersey.errors.{ErrorMessage, LoggingExceptionMapper}
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.VIRTUAL_ENVIRONMENTS
import org.apache.texera.dao.jooq.generated.tables.daos.UserDao
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.web.resource.dashboard.user.environment.EnvironmentResource.{
  EnvironmentRequest,
  EnvironmentRow
}
import org.jooq.JSONB
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.util.UUID
import javax.annotation.security.RolesAllowed
import javax.ws.rs.{BadRequestException, NotFoundException, Path, WebApplicationException}

class EnvironmentResourceSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  private val resource = new EnvironmentResource
  private var owner: SessionUser = _
  private var other: SessionUser = _

  // The Dashboard's mapper: Dropwizard's, with the Scala module TexeraWebApplication adds.
  private val dashboardMapper: ObjectMapper =
    Jackson.newObjectMapper().registerModule(DefaultScalaModule)

  private def addUser(name: String): SessionUser = {
    val user = new User
    user.setName(name)
    user.setEmail(s"user_${UUID.randomUUID()}@example.com")
    new UserDao(getDSLContext.configuration()).insert(user)
    new SessionUser(user)
  }

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    owner = addUser("environment_spec_owner")
    other = addUser("environment_spec_other")
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  override protected def beforeEach(): Unit =
    getDSLContext.deleteFrom(VIRTUAL_ENVIRONMENTS).execute()

  private def create(
      user: SessionUser,
      name: String,
      packages: Map[String, String] = Map.empty
  ): EnvironmentRow =
    resource.create(EnvironmentRequest(name, packages), user).getEntity.asInstanceOf[EnvironmentRow]

  /** A row written straight to the table, as an older release or a hand edit could leave it. */
  private def storeRaw(user: SessionUser, name: String, packagesJson: String): Int =
    getDSLContext
      .insertInto(VIRTUAL_ENVIRONMENTS)
      .set(VIRTUAL_ENVIRONMENTS.UID, user.getUid)
      .set(VIRTUAL_ENVIRONMENTS.NAME, name)
      .set(VIRTUAL_ENVIRONMENTS.PACKAGES, JSONB.valueOf(packagesJson))
      .returning(VIRTUAL_ENVIRONMENTS.VEID)
      .fetchOne()
      .getVeid

  "EnvironmentResource" should "be served at /environments to regular users and admins" in {
    classOf[EnvironmentResource].getAnnotation(classOf[Path]).value() shouldBe "/environments"
    classOf[EnvironmentResource]
      .getAnnotation(classOf[RolesAllowed])
      .value()
      .toSet shouldBe Set("REGULAR", "ADMIN")
  }

  "create" should "store the environment for the caller and answer 201 with its row" in {
    val response = resource.create(
      EnvironmentRequest("ml", Map("tabulate" -> "==0.9.0", "requests" -> "")),
      owner
    )

    response.getStatus shouldBe 201
    val row = response.getEntity.asInstanceOf[EnvironmentRow]
    row.name shouldBe "ml"
    row.packages shouldBe Map("tabulate" -> "==0.9.0", "requests" -> "")
    resource.list(owner) shouldBe List(row)
  }

  it should "answer in the JSON shape the frontend reads" in {
    val row = create(owner, "ml", Map("tabulate" -> "==0.9.0", "requests" -> ""))
    val expected =
      s"""{"veid": ${row.veid}, "name": "ml", "packages": {"tabulate": "==0.9.0", "requests": ""}}"""

    dashboardMapper.readTree(dashboardMapper.writeValueAsString(row)) shouldBe
      dashboardMapper.readTree(expected)
    dashboardMapper.readTree(dashboardMapper.writeValueAsString(resource.list(owner))) shouldBe
      dashboardMapper.readTree(s"[$expected]")
  }

  it should "read the body the frontend sends, with or without packages" in {
    dashboardMapper.readValue(
      """{"name": "ml", "packages": {"numpy": "==1.26.0", "requests": ""}}""",
      classOf[EnvironmentRequest]
    ) shouldBe EnvironmentRequest("ml", Map("numpy" -> "==1.26.0", "requests" -> ""))

    val bare = dashboardMapper.readValue("""{"name": "bare"}""", classOf[EnvironmentRequest])
    resource.create(bare, owner).getEntity.asInstanceOf[EnvironmentRow].packages shouldBe Map.empty
  }

  it should "store the name without surrounding spaces" in {
    create(owner, "  ml  ").name shouldBe "ml"
    resource.list(owner).map(_.name) shouldBe List("ml")
  }

  it should "accept a name with '.', '_' and '-' after its first letter or digit" in {
    create(owner, "ml-env_1.0").name shouldBe "ml-env_1.0"
    create(owner, "0.x").name shouldBe "0.x"
    resource.list(owner).map(_.name) shouldBe List("ml-env_1.0", "0.x")
  }

  it should "store missing packages as none, and a missing version as any version" in {
    create(owner, "empty", packages = null).packages shouldBe Map.empty
    create(owner, "unpinned", Map("requests" -> null)).packages shouldBe Map("requests" -> "")
    resource.list(owner).map(_.packages) shouldBe List(Map.empty, Map("requests" -> ""))
  }

  it should "store the packages as the caller wrote them" in {
    // The grammar normalizes names only for the lines pip reads; the caller's own spelling stays.
    create(owner, "spelled", Map("NumPy" -> ">=1.26", "Foo_Bar" -> "")).packages shouldBe
      Map("NumPy" -> ">=1.26", "Foo_Bar" -> "")
  }

  it should "answer 400 for a name the grammar refuses, and store nothing" in {
    for (
      name <- Seq("bad name", "../escape", "a" * 129, "env-ä", "ml;rm", ".", "..", ".x", "-x", "_x")
    ) {
      val refusal = intercept[BadRequestException] {
        resource.create(EnvironmentRequest(name, Map.empty), owner)
      }
      refusal.getResponse.getStatus shouldBe 400
      refusal.getMessage should startWith(s"""Environment name "${name.take(64)}""")
    }
    for (missing <- Seq("", "   ", null)) {
      intercept[BadRequestException] {
        resource.create(EnvironmentRequest(missing, Map.empty), owner)
      }.getMessage shouldBe "An environment needs a name."
    }
    intercept[BadRequestException](resource.create(null, owner)).getMessage shouldBe
      "An environment needs a name."
    resource.list(owner) shouldBe empty
  }

  it should "answer 400 for a package pip would read as more than a name and a version bound" in {
    val refused = Seq(
      "-r x" -> "",
      "pkg @ http://example.com/pkg.whl" -> "",
      "a,b" -> "",
      "x y" -> "",
      "pkg[extra]" -> "",
      "numpy" -> "==1.0,<2",
      "numpy" -> "@ http://example.com/numpy.whl",
      "numpy" -> "-r requirements.txt",
      "numpy" -> "~=1.0"
    )
    for ((pkg, spec) <- refused) {
      val refusal = intercept[BadRequestException] {
        resource.create(EnvironmentRequest("ml", Map("requests" -> "", pkg -> spec)), owner)
      }
      refusal.getResponse.getStatus shouldBe 400
      withClue(s"$pkg -> $spec: ") {
        refusal.getMessage should include(s""""$pkg"""")
        refusal.getMessage should include("is not valid")
      }
    }
    resource.list(owner) shouldBe empty
  }

  it should "accept up to 200 packages and answer 400 for more" in {
    val packages = (1 to 201).map(i => s"pkg$i" -> "").toMap

    intercept[BadRequestException] {
      resource.create(EnvironmentRequest("big", packages), owner)
    }.getMessage shouldBe "An environment lists at most 200 packages; this one lists 201."
    create(owner, "full", packages - "pkg201").packages.size shouldBe 200
  }

  it should "answer 409 when the caller already has an environment of that name, and keep it" in {
    val first = create(owner, "ml", Map("numpy" -> ""))

    val conflict = intercept[WebApplicationException] {
      resource.create(EnvironmentRequest("ml", Map("pandas" -> "")), owner)
    }

    conflict.getResponse.getStatus shouldBe 409
    conflict.getMessage shouldBe """An environment named "ml" already exists."""
    resource.list(owner) shouldBe List(first)
  }

  it should "accept a name another user already uses" in {
    create(other, "shared")

    resource
      .create(EnvironmentRequest("shared", Map.empty), owner)
      .getStatus shouldBe 201
  }

  "list" should "return only the caller's environments, oldest first" in {
    val first = create(owner, "env-1", Map("numpy" -> "==1.26.0"))
    val second = create(owner, "env-2")
    val theirs = create(other, "env-other")

    resource.list(owner) shouldBe List(first, second)
    resource.list(other) shouldBe List(theirs)
  }

  it should "return an empty list when the caller has no environment" in {
    create(other, "not-yours")

    resource.list(owner) shouldBe empty
  }

  it should "list a row written before the grammar as stored" in {
    val veid = storeRaw(owner, "legacy", """{"NumPy": "1.5", "pkg[extra]": ""}""")

    resource.list(owner) shouldBe List(
      EnvironmentRow(veid, "legacy", Map("NumPy" -> "1.5", "pkg[extra]" -> ""))
    )
  }

  it should "list a row whose packages are not a JSON object of strings with none" in {
    val garbled = storeRaw(owner, "garbled", "[1, 2]")
    val nested = storeRaw(owner, "nested", """{"numpy": {"version": "1.26"}}""")
    val fine = create(owner, "fine", Map("numpy" -> ""))

    resource.list(owner) shouldBe List(
      EnvironmentRow(garbled, "garbled", Map.empty),
      EnvironmentRow(nested, "nested", Map.empty),
      fine
    )
  }

  "update" should "rename the caller's environment, replace its packages and answer its row" in {
    val original = create(owner, "original", Map("numpy" -> ""))

    val updated = resource.update(
      original.veid,
      EnvironmentRequest(" renamed ", Map("pandas" -> "==2.2.0")),
      owner
    )

    updated shouldBe EnvironmentRow(original.veid, "renamed", Map("pandas" -> "==2.2.0"))
    resource.list(owner) shouldBe List(updated)
  }

  it should "keep the environment's own name without a conflict" in {
    val env = create(owner, "same", Map("numpy" -> ""))

    resource
      .update(env.veid, EnvironmentRequest("same", Map("numpy" -> "==1.26.0")), owner)
      .packages shouldBe Map("numpy" -> "==1.26.0")
  }

  it should "answer 404 for another user's environment and leave it as it was" in {
    val theirs = create(other, "theirs", Map("numpy" -> ""))

    intercept[NotFoundException] {
      resource.update(theirs.veid, EnvironmentRequest("hijacked", Map.empty), owner)
    }.getMessage shouldBe "This environment does not exist or is not yours."
    resource.list(other) shouldBe List(theirs)
  }

  it should "answer 404, not 409, for another user's environment given a name the caller uses" in {
    create(owner, "mine")
    val theirs = create(other, "theirs")

    intercept[NotFoundException] {
      resource.update(theirs.veid, EnvironmentRequest("mine", Map.empty), owner)
    }.getResponse.getStatus shouldBe 404
    resource.list(other) shouldBe List(theirs)
  }

  it should "answer 404 for an id that does not exist" in {
    intercept[NotFoundException] {
      resource.update(-1, EnvironmentRequest("env-x", Map.empty), owner)
    }.getResponse.getStatus shouldBe 404
  }

  it should "answer 400 for a name or a package the grammar refuses, and leave the row as it was" in {
    val env = create(owner, "keep", Map("numpy" -> ""))

    intercept[BadRequestException] {
      resource.update(env.veid, EnvironmentRequest("bad name", Map.empty), owner)
    }.getResponse.getStatus shouldBe 400
    intercept[BadRequestException] {
      resource.update(env.veid, EnvironmentRequest("keep", Map("pkg[extra]" -> "")), owner)
    }.getResponse.getStatus shouldBe 400
    resource.list(owner) shouldBe List(env)
  }

  it should "answer 409 when renaming onto another of the caller's environments" in {
    val existing = create(owner, "existing")
    val target = create(owner, "target")

    val conflict = intercept[WebApplicationException] {
      resource.update(target.veid, EnvironmentRequest("existing", Map.empty), owner)
    }

    conflict.getResponse.getStatus shouldBe 409
    conflict.getMessage shouldBe """An environment named "existing" already exists."""
    resource.list(owner) shouldBe List(existing, target)
  }

  it should "save a row written before the grammar only once it passes" in {
    val veid = storeRaw(owner, "legacy", """{"numpy": "1.5"}""")

    intercept[BadRequestException] {
      resource.update(veid, EnvironmentRequest("legacy", Map("numpy" -> "1.5")), owner)
    }.getMessage shouldBe
      """Version "1.5" of package "numpy" is not valid: a version bound starts with ==, >= or <=."""
    resource.update(veid, EnvironmentRequest("legacy", Map("numpy" -> "==1.5")), owner) shouldBe
      EnvironmentRow(veid, "legacy", Map("numpy" -> "==1.5"))
  }

  "delete" should "remove the caller's environment and answer 204" in {
    val env = create(owner, "doomed")
    val kept = create(owner, "kept")

    resource.delete(env.veid, owner).getStatus shouldBe 204
    resource.list(owner) shouldBe List(kept)
  }

  it should "answer 404 for another user's environment and keep it" in {
    val theirs = create(other, "theirs")

    intercept[NotFoundException](resource.delete(theirs.veid, owner)).getMessage shouldBe
      "This environment does not exist or is not yours."
    resource.list(other) shouldBe List(theirs)
  }

  it should "answer 404 the second time" in {
    val env = create(owner, "once")
    resource.delete(env.veid, owner)

    intercept[NotFoundException](
      resource.delete(env.veid, owner)
    ).getResponse.getStatus shouldBe 404
  }

  "a refusal" should "reach the browser as JSON that carries its message" in {
    // What Dropwizard's mapper makes of each refusal is what the Environments page shows.
    val dropwizardMapper = new LoggingExceptionMapper[Throwable] {}
    val existing = create(owner, "existing")
    val refusals = Seq(
      intercept[BadRequestException] {
        resource.create(EnvironmentRequest("ml", Map("pkg[extra]" -> "")), owner)
      },
      intercept[WebApplicationException] {
        resource.create(EnvironmentRequest(existing.name, Map.empty), owner)
      },
      intercept[NotFoundException](resource.delete(-1, owner))
    )

    for (refusal <- refusals) {
      val response = dropwizardMapper.toResponse(refusal)
      val status = refusal.getResponse.getStatus
      response.getStatus shouldBe status
      response.getEntity shouldBe new ErrorMessage(status, refusal.getMessage)
    }
    refusals.map(_.getResponse.getStatus) shouldBe Seq(400, 409, 404)
  }
}
