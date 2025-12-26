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

package org.apache.amber.engine.architecture.scheduling

import org.apache.amber.core.virtualidentity.ExecutionIdentity
import org.apache.amber.core.workflow.{GlobalPortIdentity, PortIdentity, WorkflowContext}
import org.apache.amber.engine.e2e.TestUtils.buildWorkflow
import org.apache.amber.operator.TestOperators
import org.apache.texera.workflow.LogicalLink
import org.scalatest.BeforeAndAfterEach
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI

class PortResultCacheSpec extends AnyFlatSpec with Matchers with BeforeAndAfterEach {

  override def beforeEach(): Unit = {
    // Clear the cache before each test
    PortResultCache.clear()
  }

  "PortResultCache" should "store and lookup cache entries correctly" in {
    val cacheKey = "test-key-1"
    val uri = new URI("vfs:///test/path/1")

    // Initially, the key should not exist
    PortResultCache.lookup(cacheKey) shouldBe None

    // Store the entry
    PortResultCache.store(cacheKey, uri)

    // Now it should be found
    PortResultCache.lookup(cacheKey) shouldBe Some(uri)
  }

  it should "correctly report cache size" in {
    PortResultCache.size shouldBe 0

    PortResultCache.store("key1", new URI("vfs:///path/1"))
    PortResultCache.size shouldBe 1

    PortResultCache.store("key2", new URI("vfs:///path/2"))
    PortResultCache.size shouldBe 2

    PortResultCache.store("key3", new URI("vfs:///path/3"))
    PortResultCache.size shouldBe 3
  }

  it should "correctly check if a URI is cached" in {
    val uri1 = new URI("vfs:///test/path/1")
    val uri2 = new URI("vfs:///test/path/2")
    val uri3 = new URI("vfs:///test/path/3")

    PortResultCache.store("key1", uri1)
    PortResultCache.store("key2", uri2)

    PortResultCache.isUriCached(uri1) shouldBe true
    PortResultCache.isUriCached(uri2) shouldBe true
    PortResultCache.isUriCached(uri3) shouldBe false
  }

  it should "clear all entries" in {
    PortResultCache.store("key1", new URI("vfs:///path/1"))
    PortResultCache.store("key2", new URI("vfs:///path/2"))
    PortResultCache.size shouldBe 2

    PortResultCache.clear()

    PortResultCache.size shouldBe 0
    PortResultCache.lookup("key1") shouldBe None
    PortResultCache.lookup("key2") shouldBe None
  }

  it should "store and retrieve execution-specific cache keys" in {
    val executionId = ExecutionIdentity(123L)
    val portId1 = GlobalPortIdentity(
      opId = org.apache.amber.core.virtualidentity.PhysicalOpIdentity(
        org.apache.amber.core.virtualidentity.OperatorIdentity("op1"),
        "main"
      ),
      portId = PortIdentity()
    )
    val portId2 = GlobalPortIdentity(
      opId = org.apache.amber.core.virtualidentity.PhysicalOpIdentity(
        org.apache.amber.core.virtualidentity.OperatorIdentity("op2"),
        "main"
      ),
      portId = PortIdentity()
    )

    val cacheKeys = Map(
      portId1 -> "cachekey1",
      portId2 -> "cachekey2"
    )

    // Store cache keys for execution
    PortResultCache.storeCacheKeysForExecution(executionId, cacheKeys)

    // Retrieve cache keys
    PortResultCache.getCacheKeyForPort(executionId, portId1) shouldBe Some("cachekey1")
    PortResultCache.getCacheKeyForPort(executionId, portId2) shouldBe Some("cachekey2")

    // Non-existent port should return None
    val nonExistentPort = GlobalPortIdentity(
      opId = org.apache.amber.core.virtualidentity.PhysicalOpIdentity(
        org.apache.amber.core.virtualidentity.OperatorIdentity("op3"),
        "main"
      ),
      portId = PortIdentity()
    )
    PortResultCache.getCacheKeyForPort(executionId, nonExistentPort) shouldBe None

    // Non-existent execution should return None
    PortResultCache.getCacheKeyForPort(ExecutionIdentity(999L), portId1) shouldBe None

    // Remove cache keys for execution
    PortResultCache.removeCacheKeysForExecution(executionId)
    PortResultCache.getCacheKeyForPort(executionId, portId1) shouldBe None
  }

  "Cache key computation" should "produce the same key for identical operators" in {
    // Build two identical workflows
    val csvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val workflow1 = buildWorkflow(
      List(csvOpDesc1),
      List(),
      new WorkflowContext()
    )

    val csvOpDesc2 = TestOperators.headerlessSmallCsvScanOpDesc()
    val workflow2 = buildWorkflow(
      List(csvOpDesc2),
      List(),
      new WorkflowContext()
    )

    // Compute cache keys
    val keys1 = PortResultCache.computeAllCacheKeys(workflow1.physicalPlan)
    val keys2 = PortResultCache.computeAllCacheKeys(workflow2.physicalPlan)

    // Both should have 1 output port
    keys1.size shouldBe 1
    keys2.size shouldBe 1

    // The cache keys should be identical since the operators are identical
    keys1.values.head shouldBe keys2.values.head
  }

  it should "produce different keys for different operators" in {
    val csvOpDesc = TestOperators.headerlessSmallCsvScanOpDesc()
    val workflow1 = buildWorkflow(
      List(csvOpDesc),
      List(),
      new WorkflowContext()
    )

    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val csvOpDesc2 = TestOperators.headerlessSmallCsvScanOpDesc()
    val workflow2 = buildWorkflow(
      List(csvOpDesc2, keywordOpDesc),
      List(
        LogicalLink(
          csvOpDesc2.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    // Compute cache keys
    val keys1 = PortResultCache.computeAllCacheKeys(workflow1.physicalPlan)
    val keys2 = PortResultCache.computeAllCacheKeys(workflow2.physicalPlan)

    // workflow1 has 1 output port (CSV source)
    keys1.size shouldBe 1

    // workflow2 has 2 output ports (CSV source + keyword filter)
    keys2.size shouldBe 2

    // Find the CSV operator key in workflow2 (it should match the key from workflow1)
    val csvKey1 = keys1.values.head
    // Find the output port that belongs to a CSV operator (the one with no upstream)
    val csvPortId2 = keys2.keys.find { portId =>
      workflow2.physicalPlan.getUpstreamPhysicalLinks(portId.opId).isEmpty
    }.get
    val csvKey2 = keys2(csvPortId2)

    csvKey1 shouldBe csvKey2
  }

  it should "produce different keys when upstream changes" in {
    // Create workflow with CSV -> Keyword filter
    val csvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc1 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow1 = buildWorkflow(
      List(csvOpDesc1, keywordOpDesc1),
      List(
        LogicalLink(
          csvOpDesc1.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc1.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    // Create workflow with different CSV file -> same Keyword filter
    val csvOpDesc2 = TestOperators.smallCsvScanOpDesc() // Different CSV file (has header)
    val keywordOpDesc2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow2 = buildWorkflow(
      List(csvOpDesc2, keywordOpDesc2),
      List(
        LogicalLink(
          csvOpDesc2.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc2.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    // Compute cache keys
    val keys1 = PortResultCache.computeAllCacheKeys(workflow1.physicalPlan)
    val keys2 = PortResultCache.computeAllCacheKeys(workflow2.physicalPlan)

    // Get keyword filter keys (they have upstream links, so they're not the source operators)
    val keywordPortId1 = keys1.keys.find { portId =>
      workflow1.physicalPlan.getUpstreamPhysicalLinks(portId.opId).nonEmpty
    }.get
    val keywordPortId2 = keys2.keys.find { portId =>
      workflow2.physicalPlan.getUpstreamPhysicalLinks(portId.opId).nonEmpty
    }.get

    val keywordKey1 = keys1(keywordPortId1)
    val keywordKey2 = keys2(keywordPortId2)

    // Keys should be different because upstream operators are different
    keywordKey1 should not be keywordKey2
  }

  it should "produce consistent keys across multiple computations" in {
    val csvOpDesc = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow = buildWorkflow(
      List(csvOpDesc, keywordOpDesc),
      List(
        LogicalLink(
          csvOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    // Compute cache keys multiple times
    val keys1 = PortResultCache.computeAllCacheKeys(workflow.physicalPlan)
    val keys2 = PortResultCache.computeAllCacheKeys(workflow.physicalPlan)
    val keys3 = PortResultCache.computeAllCacheKeys(workflow.physicalPlan)

    // All computations should produce the same results
    keys1 shouldBe keys2
    keys2 shouldBe keys3
  }
}
