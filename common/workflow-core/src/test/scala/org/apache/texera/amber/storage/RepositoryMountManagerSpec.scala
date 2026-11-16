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

package org.apache.texera.amber.storage

import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.texera.amber.core.storage.RepositoryMountManager
import org.apache.texera.amber.core.workflow.RepositoryMounts
import org.apache.texera.common.config.EnvironmentalVariable
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.nio.file.{Path, Paths}
import scala.collection.mutable

class RepositoryMountManagerSpec extends AnyFlatSpec with Matchers {

  private val locator = "dataset-1:abc123"
  private val inPodPath = Paths.get("/mnt/texera-mounts/dataset-1/abc123")

  private val podEnv = Map(
    EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT -> "/mnt/texera-mounts",
    EnvironmentalVariable.ENV_ACCESS_CONTROL_SERVICE_URL -> "http://access-control-service-svc:9096",
    EnvironmentalVariable.ENV_CU_ID -> "7",
    EnvironmentalVariable.ENV_USER_JWT_TOKEN -> "user-jwt"
  )

  private class Fixture(
      env: Map[String, String] = podEnv,
      mountedAfterRequest: Boolean = true,
      alreadyMounted: Boolean = false,
      timeoutMs: Long = 400
  ) {
    val requests: mutable.Buffer[(String, String, String)] = mutable.Buffer()
    // The mount points a request has made appear in the pod, each under the pod's root.
    private val mounted = mutable.Set[Path]()

    val manager: RepositoryMountManager = new RepositoryMountManager(
      env.get,
      (url, body, jwt) => {
        requests += ((url, body, jwt))
        if (mountedAfterRequest) {
          val request = new ObjectMapper().readTree(body)
          mounted += Paths
            .get(env(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT).trim)
            .resolve(request.get("repositoryName").asText())
            .resolve(request.get("commitHash").asText())
        }
      },
      (mountPoint: Path) => alreadyMounted || mounted.contains(mountPoint),
      timeoutMs
    )
  }

  private val badLocators = Seq("dataset-1", "", ":abc", "dataset-1:", null)

  private def mountsUnder(root: String, locators: String*): RepositoryMounts =
    RepositoryMounts(root, locators.toSet)

  "mountRoot" should "be the pod's mount root, trimmed" in {
    new Fixture().manager.mountRoot shouldBe Some(Paths.get("/mnt/texera-mounts"))
    val padded = podEnv + (EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT -> "  /mnt/texera-mounts ")
    new Fixture(env = padded).manager.mountRoot shouldBe Some(Paths.get("/mnt/texera-mounts"))
  }

  it should "be None in a pod that can mount nothing" in {
    new Fixture(
      env = podEnv - EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT
    ).manager.mountRoot shouldBe None
    new Fixture(
      env = podEnv + (EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT -> "  ")
    ).manager.mountRoot shouldBe None
  }

  "RepositoryMountManager.mountPoint" should "place a locator under whatever root it is given" in {
    // A plan writes this path into an operator's code, against the plan's root, not a pod's.
    RepositoryMountManager.mountPoint(Paths.get("/plan/root"), locator) shouldBe
      Paths.get("/plan/root/dataset-1/abc123")
  }

  it should "reject a locator that is not <repositoryName>:<commitHash>" in {
    badLocators.foreach { bad =>
      an[IllegalArgumentException] should be thrownBy
        RepositoryMountManager.mountPoint(Paths.get("/plan/root"), bad)
    }
  }

  "RepositoryMountManager.requireMountableUnder" should
    "accept code that reads its mounts under the unit's root, however either spells it" in {
    for (
      planRoot <- Seq("/mnt/texera-mounts", "/mnt/texera-mounts/", "/mnt/./texera-mounts");
      unitRoot <- Seq("/mnt/texera-mounts", "/mnt/texera-mounts/")
    ) {
      noException should be thrownBy RepositoryMountManager.requireMountableUnder(
        mountsUnder(planRoot, locator),
        Some(Paths.get(unitRoot))
      )
    }
  }

  it should "refuse code that reads its mounts under another root, naming both" in {
    val failure = the[IllegalStateException] thrownBy RepositoryMountManager
      .requireMountableUnder(
        mountsUnder("/plan/root", locator),
        Some(Paths.get("/mnt/texera-mounts"))
      )
    failure.getMessage should include("/plan/root")
    failure.getMessage should include("/mnt/texera-mounts")
  }

  it should "refuse every mount on a unit that mounts nothing, naming what was asked for" in {
    val failure = the[IllegalStateException] thrownBy RepositoryMountManager
      .requireMountableUnder(mountsUnder("/mnt/texera-mounts", locator), None)
    failure.getMessage should include(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT)
    failure.getMessage should include(locator)
  }

  "ensureAllMounted" should "mount what the plan names when its root is this pod's" in {
    val fixture = new Fixture()
    // The same directory, however the plan spelled it.
    for (root <- Seq("/mnt/texera-mounts", "/mnt/texera-mounts/", "/mnt/./texera-mounts")) {
      fixture.manager.ensureAllMounted(mountsUnder(root, locator))
    }
    fixture.requests should have size 1
  }

  it should "ask for every repository the plan names under its root" in {
    val fixture = new Fixture()
    fixture.manager.ensureAllMounted(mountsUnder("/mnt/texera-mounts", locator, "model-1:def456"))
    fixture.requests.map(_._2) should contain theSameElementsAs Seq(
      """{"repositoryName":"dataset-1","commitHash":"abc123"}""",
      """{"repositoryName":"model-1","commitHash":"def456"}"""
    )
  }

  it should "refuse, before asking for any mount, a plan whose code reads another root" in {
    val fixture = new Fixture()
    val failure = the[IllegalStateException] thrownBy
      fixture.manager.ensureAllMounted(mountsUnder("/plan/root", locator))
    failure.getMessage should include("/plan/root")
    failure.getMessage should include("/mnt/texera-mounts")
    fixture.requests shouldBe empty
  }

  it should "say the pod has no mount root when the plan needs mounts" in {
    val fixture = new Fixture(env = podEnv - EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT)
    val failure = the[IllegalStateException] thrownBy
      fixture.manager.ensureAllMounted(mountsUnder("/mnt/texera-mounts", locator))
    failure.getMessage should include(EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT)
    fixture.requests shouldBe empty
  }

  "ensureMounted" should "ask the authority and return the in-pod path" in {
    val fixture = new Fixture()
    fixture.manager.ensureMounted(locator) shouldBe inPodPath

    val (url, body, jwt) = fixture.requests.head
    // The authority is addressed per computing unit; the pod's own cuid is a claim it checks.
    url shouldBe "http://access-control-service-svc:9096/api/mounts/7"
    body should include(""""repositoryName":"dataset-1"""")
    body should include(""""commitHash":"abc123"""")
    // The pod's user token: the authority re-checks that user, and GeeseFS presents it on
    // every read afterwards.
    jwt shouldBe "user-jwt"
  }

  it should "not ask again for something already mounted" in {
    val fixture = new Fixture(alreadyMounted = true)
    fixture.manager.ensureMounted(locator) shouldBe inPodPath
    fixture.requests shouldBe empty
  }

  it should "reject a locator that is not <repositoryName>:<commitHash>, asking nothing" in {
    val fixture = new Fixture()
    badLocators.foreach { bad =>
      an[IllegalArgumentException] should be thrownBy fixture.manager.ensureMounted(bad)
    }
    fixture.requests shouldBe empty
  }

  it should "give up if the mount never propagates into the pod" in {
    val fixture = new Fixture(mountedAfterRequest = false)
    val failure = the[RuntimeException] thrownBy fixture.manager.ensureMounted(locator)
    failure.getMessage should include("did not appear as a mount")
  }

  it should "say which variable is missing rather than fail obscurely" in {
    Seq(
      EnvironmentalVariable.ENV_MOUNT_IN_POD_ROOT,
      EnvironmentalVariable.ENV_ACCESS_CONTROL_SERVICE_URL,
      EnvironmentalVariable.ENV_CU_ID,
      EnvironmentalVariable.ENV_USER_JWT_TOKEN
    ).foreach { missing =>
      val fixture = new Fixture(env = podEnv - missing)
      val failure = the[IllegalStateException] thrownBy fixture.manager.ensureMounted(locator)
      failure.getMessage should include(missing)
      fixture.requests shouldBe empty
    }
  }
}
