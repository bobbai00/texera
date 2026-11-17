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
import org.apache.texera.amber.core.storage.{InPodMount, RepositoryMountManager}
import org.apache.texera.common.config.EnvironmentalVariable
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.nio.file.{Files, Path, Paths}
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

  private val badLocators =
    Seq("dataset-1", "", ":abc", "dataset-1:", null, "../..:abc123", "dataset-1:../etc")

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
    RepositoryMountManager.mountPoint(Paths.get("/unit/root"), locator) shouldBe
      Paths.get("/unit/root/dataset-1/abc123")
  }

  it should "reject a locator that is not <repositoryName>:<commitHash>" in {
    badLocators.foreach { bad =>
      an[IllegalArgumentException] should be thrownBy
        RepositoryMountManager.mountPoint(Paths.get("/unit/root"), bad)
    }
  }

  "ensureAllMounted" should "ask for every repository it is given, each once" in {
    val fixture = new Fixture()
    fixture.manager.ensureAllMounted(Set(locator, "model-1:def456"))
    fixture.requests.map(_._2) should contain theSameElementsAs Seq(
      """{"repositoryName":"dataset-1","commitHash":"abc123"}""",
      """{"repositoryName":"model-1","commitHash":"def456"}"""
    )
    // What is mounted is not asked for again.
    fixture.manager.ensureAllMounted(Set(locator))
    fixture.requests should have size 2
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

  // A mount whose GeeseFS process died stays in /proc/mounts and can even stat, but cannot be
  // listed. Telling it apart is what lets ensureMounted ask again instead of handing the
  // operator an unreadable directory. A real dead FUSE mount cannot be made in a unit test, so
  // these pin the rule itself: whatever cannot be listed is not live.
  "InPodMount.responds" should "accept a directory that can be listed" in {
    val dir = Files.createTempDirectory("mount-live")
    try InPodMount.responds(dir) shouldBe true
    finally Files.delete(dir)
  }

  it should "reject a path that cannot be listed" in {
    val dir = Files.createTempDirectory("mount-dead")
    val file = Files.createFile(dir.resolve("not-a-directory"))
    try {
      InPodMount.responds(dir.resolve("missing")) shouldBe false
      InPodMount.responds(file) shouldBe false
    } finally {
      Files.delete(file)
      Files.delete(dir)
    }
  }

  "InPodMount.isFuseMounted" should "not count a plain directory as a mount" in {
    val dir = Files.createTempDirectory("mount-none")
    try InPodMount.isFuseMounted(dir) shouldBe false
    finally Files.delete(dir)
  }
}
