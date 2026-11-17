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

import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec

class RepositoryMountsSpec extends AnyFlatSpec {

  private val badLocators = Seq("dataset-1", "", ":abc", "dataset-1:", null)

  // What would name a directory outside the one a repository is mounted at, or read as an option.
  private val unsafeLocators = Seq(
    "../..:abc123",
    "/etc:abc123",
    "dataset-1:../../etc",
    "dataset-1:abc/123",
    "data set:abc123",
    "..:abc123",
    "dataset-1:.",
    "-o:abc123",
    "dataset-1:abc:123",
    "dataset-1:abc\n123",
    "datasét-1:abc123"
  )

  "RepositoryMounts" should "hold the repositories an operator's code reads" in {
    val mounts = RepositoryMounts(Set("dataset-1:abc123", "model-1:def456"))
    assert(mounts.locators == Set("dataset-1:abc123", "model-1:def456"))
  }

  it should "refuse to name no repository" in {
    for (nothing <- Seq(Set.empty[String], null)) {
      val failure = intercept[IllegalArgumentException](RepositoryMounts(nothing))
      assert(failure.getMessage == "requirement failed: Mounts name no repository.")
    }
  }

  it should "refuse anything among its repositories that is not a locator" in {
    for (bad <- badLocators ++ unsafeLocators) {
      val failure = intercept[IllegalArgumentException] {
        RepositoryMounts(Set("dataset-1:abc123", bad))
      }
      assert(failure.getMessage.contains(s"'$bad'"), failure.getMessage)
    }
  }

  it should "read back from JSON as written, and refuse JSON that names no repository" in {
    val mounts = RepositoryMounts(Set("dataset-1:abc123", "model-1:def456"))
    val json = objectMapper.writeValueAsString(mounts)
    assert(objectMapper.readValue(json, classOf[RepositoryMounts]) == mounts)

    // A reader builds the value through its constructor, so it cannot make one the type refuses.
    for (invalid <- Seq("""{"locators":[]}""", """{"locators":["../..:abc123"]}""")) {
      val failure = intercept[Exception](objectMapper.readValue(invalid, classOf[RepositoryMounts]))
      val causes = Iterator.iterate[Throwable](failure)(_.getCause).takeWhile(_ != null).toList
      assert(causes.exists(_.isInstanceOf[IllegalArgumentException]), s"$invalid: $failure")
    }
  }

  "RepositoryMounts.locator" should "name a repository at a commit as parseLocator reads it" in {
    val locator = RepositoryMounts.locator("dataset-1", "abc123")
    assert(locator == "dataset-1:abc123")
    assert(RepositoryMounts.parseLocator(locator) == (("dataset-1", "abc123")))
  }

  "RepositoryMounts.parseLocator" should
    "take the names repositories and commits have: letters, digits, '.', '_' and '-'" in {
    assert(
      RepositoryMounts
        .parseLocator("Model_7.v2-a:0f3c9A_b.1-2") == (("Model_7.v2-a", "0f3c9A_b.1-2"))
    )
    assert(RepositoryMounts.parseLocator("d:c") == (("d", "c")))
  }

  it should "reject a locator that is not <repositoryName>:<commitHash>" in {
    for (bad <- badLocators) {
      intercept[IllegalArgumentException](RepositoryMounts.parseLocator(bad))
    }
  }

  it should "reject a repository or a commit that would name another directory, or an option" in {
    for (unsafe <- unsafeLocators) {
      val failure = intercept[IllegalArgumentException](RepositoryMounts.parseLocator(unsafe))
      assert(
        failure.getMessage == s"Invalid mount locator '$unsafe'; expected " +
          "<repositoryName>:<commitHash>, each of letters, digits, '.', '_' and '-', starting " +
          "with a letter or digit."
      )
    }
  }
}
