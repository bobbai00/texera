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

package org.apache.texera.common.compiler

import org.apache.texera.amber.core.workflow.PythonEnvironment
import org.apache.texera.dao.jooq.generated.Tables.VIRTUAL_ENVIRONMENTS
import org.apache.texera.dao.jooq.generated.tables.daos.UserDao
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.apache.texera.dao.{MockTexeraDB, StatementRecorder}
import org.jooq.JSONB
import org.jooq.exception.DataAccessException
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}

import java.util.UUID

class UserEnvironmentResolverSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  private var owner: Integer = _
  private var other: Integer = _
  private var recorder: StatementRecorder = _

  private def addUser(name: String): Integer = {
    val user = new User
    user.setName(name)
    user.setEmail(s"user_${UUID.randomUUID()}@example.com")
    new UserDao(getDSLContext.configuration()).insert(user)
    user.getUid
  }

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    owner = addUser("environment_resolver_owner")
    other = addUser("environment_resolver_other")
    recorder = StatementRecorder.installOn(getDSLContext)
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  override protected def beforeEach(): Unit =
    getDSLContext.deleteFrom(VIRTUAL_ENVIRONMENTS).execute()

  /** Saves `packages`, a JSON value, as user `uid`'s environment `name`. */
  private def save(uid: Integer, name: String, packages: String): Unit =
    getDSLContext
      .insertInto(VIRTUAL_ENVIRONMENTS)
      .set(VIRTUAL_ENVIRONMENTS.UID, uid)
      .set(VIRTUAL_ENVIRONMENTS.NAME, name)
      .set(VIRTUAL_ENVIRONMENTS.PACKAGES, JSONB.valueOf(packages))
      .execute()

  private def refusal(uid: Integer, name: String): String =
    intercept[PythonEnvironmentNotResolved](
      new UserEnvironmentResolver(uid).resolve(name)
    ).getMessage

  "UserEnvironmentResolver" should "resolve a name to the user's environment, as canonical lines" in {
    save(
      owner,
      "ml",
      """{"Typing_Extensions": "", "tabulate": "==0.9.0", "numpy": ">=2.1.0", "Requests": "<=2.34.2"}"""
    )

    new UserEnvironmentResolver(owner).resolve("ml") shouldBe PythonEnvironment(
      "ml",
      Seq("numpy>=2.1.0", "requests<=2.34.2", "tabulate==0.9.0", "typing-extensions")
    )
  }

  it should "resolve an environment that lists no package" in {
    save(owner, "bare", "{}")

    new UserEnvironmentResolver(owner).resolve("bare") shouldBe PythonEnvironment("bare", Seq.empty)
  }

  it should "resolve a name to the environment of the user it resolves for, whoever else keeps one under it" in {
    save(owner, "ml", """{"tabulate": "==0.9.0"}""")
    save(other, "ml", """{"requests": ""}""")

    new UserEnvironmentResolver(owner).resolve("ml").requirements shouldBe Seq("tabulate==0.9.0")
    new UserEnvironmentResolver(other).resolve("ml").requirements shouldBe Seq("requests")
  }

  it should "find no environment under a name its user does not keep, another user's included" in {
    save(other, "theirs", """{"tabulate": "==0.9.0"}""")
    save(owner, "ml", """{"tabulate": "==0.9.0"}""")

    // The message says why a name another user keeps finds nothing: a collaborator who runs a
    // shared workflow needs an environment of their own under the name it uses.
    def none(name: String): String =
      s"You have no Python environment named '$name'. Each user keeps their own environments, " +
        "so to run this workflow, create one with this name."
    refusal(owner, "theirs") shouldBe none("theirs")
    refusal(owner, "kept-by-nobody") shouldBe none("kept-by-nobody")
    // A name is the one saved, to the letter.
    refusal(owner, "ML") shouldBe none("ML")
    refusal(owner, "ml ") shouldBe none("ml ")
    refusal(owner, "") shouldBe none("")
  }

  it should "refuse an environment whose packages pip may not read, naming the package" in {
    // Rows saved before packages were checked.
    save(owner, "extra", """{"tabulate": "==0.9.0", "pkg[extra]": ""}""")
    save(owner, "url", """{"pkg": "@ https://example.com/pkg.whl"}""")
    save(owner, "bounds", """{"numpy": ">=1.0,<2.0"}""")

    refusal(owner, "extra") shouldBe
      "Python environment 'extra' cannot be installed: Package \"pkg[extra]\" is not valid: it " +
        "contains '['."
    refusal(owner, "url") shouldBe
      "Python environment 'url' cannot be installed: Version \"@ https://example.com/pkg.whl\" " +
        "of package \"pkg\" is not valid: it contains '@'."
    refusal(owner, "bounds") shouldBe
      "Python environment 'bounds' cannot be installed: Version \">=1.0,<2.0\" of package " +
        "\"numpy\" is not valid: it contains ','."
  }

  it should "refuse an environment whose packages are not stored as an object of names and bounds" in {
    Seq(
      """["tabulate==0.9.0"]""",
      "\"tabulate\"",
      """{"tabulate": {"version": "0.9.0"}}"""
    ).zipWithIndex
      .foreach {
        case (stored, index) =>
          save(owner, s"odd-$index", stored)
          refusal(owner, s"odd-$index") shouldBe
            s"Python environment 'odd-$index' cannot be installed: its packages are not stored " +
              "as names with version bounds."
      }
  }

  it should "ask the database once for a name, for the rows of its user alone" in {
    save(owner, "ml", """{"tabulate": "==0.9.0"}""")

    val statements = recorder.record(new UserEnvironmentResolver(owner).resolve("ml"))

    statements.map(_.verb) shouldBe Seq("SELECT")
    statements.head.sql should include("virtual_environments")
    statements.head.sql should (include("\"uid\" = ?") and include("\"name\" = ?"))
  }

  it should "throw a failure of the database as it is, and not as an environment it does not find" in {
    // What the user's mistake is not is not answered as one.
    closeConnectionPool()
    try a[DataAccessException] should be thrownBy new UserEnvironmentResolver(owner).resolve("ml")
    finally {
      initializeDBAndReplaceDSLContext()
      owner = addUser("environment_resolver_owner_again")
      other = addUser("environment_resolver_other_again")
      recorder = StatementRecorder.installOn(getDSLContext)
    }
  }
}
