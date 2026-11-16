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

  private val root = "/mnt/texera-mounts"
  private val badLocators = Seq("dataset-1", "", ":abc", "dataset-1:", null)

  "RepositoryMounts" should "hold the root and the repositories read under it" in {
    val mounts = RepositoryMounts(root, Set("dataset-1:abc123", "model-1:def456"))
    assert(mounts.root == root)
    assert(mounts.locators == Set("dataset-1:abc123", "model-1:def456"))
  }

  it should "refuse repositories with no root to read them under" in {
    for (blank <- Seq("", "   ", null)) {
      val failure = intercept[IllegalArgumentException] {
        RepositoryMounts(blank, Set("dataset-1:abc123"))
      }
      assert(failure.getMessage.contains("dataset-1:abc123"), failure.getMessage)
    }
  }

  it should "refuse a root with no repository under it" in {
    for (nothing <- Seq(Set.empty[String], null)) {
      val failure = intercept[IllegalArgumentException](RepositoryMounts(root, nothing))
      assert(failure.getMessage.contains(root), failure.getMessage)
    }
  }

  it should "refuse anything among its repositories that is not a locator" in {
    for (bad <- badLocators) {
      val failure = intercept[IllegalArgumentException] {
        RepositoryMounts(root, Set("dataset-1:abc123", bad))
      }
      assert(failure.getMessage.contains(s"'$bad'"), failure.getMessage)
    }
  }

  it should "read back from JSON as written, and refuse JSON that names no root" in {
    val mounts = RepositoryMounts(root, Set("dataset-1:abc123", "model-1:def456"))
    val json = objectMapper.writeValueAsString(mounts)
    assert(objectMapper.readValue(json, classOf[RepositoryMounts]) == mounts)

    // A reader builds the value through its constructor, so it cannot make one the type refuses.
    for (
      invalid <- Seq(
        """{"root":"","locators":["dataset-1:abc123"]}""",
        """{"locators":["dataset-1:abc123"]}""",
        s"""{"root":"$root","locators":[]}"""
      )
    ) {
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

  "RepositoryMounts.parseLocator" should "split at the first colon only" in {
    assert(RepositoryMounts.parseLocator("dataset-1:abc:123") == (("dataset-1", "abc:123")))
  }

  it should "reject a locator that is not <repositoryName>:<commitHash>" in {
    for (bad <- badLocators) {
      intercept[IllegalArgumentException](RepositoryMounts.parseLocator(bad))
    }
  }

  "RepositoryMounts.byRoot" should
    "name each root once, with every repository read under it" in {
    val merged = RepositoryMounts.byRoot(
      Seq(
        RepositoryMounts(root, Set("dataset-1:abc123")),
        RepositoryMounts("/plan/root", Set("model-1:def456")),
        RepositoryMounts(root, Set("dataset-1:abc123", "dataset-2:fed321"))
      )
    )
    assert(
      merged.toSet == Set(
        RepositoryMounts(root, Set("dataset-1:abc123", "dataset-2:fed321")),
        RepositoryMounts("/plan/root", Set("model-1:def456"))
      )
    )
    assert(merged.size == 2)
  }

  it should "merge nothing into nothing" in {
    assert(RepositoryMounts.byRoot(Seq.empty).isEmpty)
  }
}
