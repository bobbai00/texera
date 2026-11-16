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

package org.apache.texera.amber.engine.architecture.scheduling.resourcePolicies

import org.apache.texera.amber.core.executor.OpExecInitInfo
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  HashPartition,
  InputPort,
  OutputPort,
  PartitionRule,
  PhysicalLink,
  PhysicalOp,
  PhysicalPlan,
  PortIdentity,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.scheduling.{Region, RegionIdentity}
import org.apache.texera.amber.engine.architecture.sendsemantics.partitionings.{
  BroadcastPartitioning,
  HashBasedShufflePartitioning,
  OneToOnePartitioning,
  Partitioning,
  RangeBasedShufflePartitioning,
  RoundRobinPartitioning
}
import org.apache.texera.amber.engine.e2e.TestUtils.buildWorkflow
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.common.compiler.model.LogicalLink
import org.scalatest.flatspec.AnyFlatSpec

class ResourcePoliciesSpec extends AnyFlatSpec {

  // ---------------------------------------------------------------------------
  // ExecutionClusterInfo
  // ---------------------------------------------------------------------------

  "ExecutionClusterInfo" should "construct without arguments" in {
    // No-arg constructor must not throw; the type currently has no observable
    // state to assert beyond that.
    new ExecutionClusterInfo()
  }

  // ---------------------------------------------------------------------------
  // DefaultResourceAllocator (helpers + tests)
  // ---------------------------------------------------------------------------

  /** Build a small linear `csv -> keyword` workflow to feed the allocator. */
  private def buildLinearWorkflow() = {
    val csv = TestOperators.headerlessSmallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    buildWorkflow(
      List(csv, keyword),
      List(
        LogicalLink(
          csv.operatorIdentifier,
          PortIdentity(0),
          keyword.operatorIdentifier,
          PortIdentity(0)
        )
      ),
      new WorkflowContext()
    )
  }

  private def newAllocator(): (DefaultResourceAllocator, Region) = {
    val workflow = buildLinearWorkflow()
    val allocator = new DefaultResourceAllocator(
      workflow.physicalPlan,
      new ExecutionClusterInfo(),
      workflow.context.workflowSettings
    )
    val region = Region(
      id = RegionIdentity(0),
      physicalOps = workflow.physicalPlan.operators,
      physicalLinks = workflow.physicalPlan.links
    )
    (allocator, region)
  }

  "DefaultResourceAllocator.allocate" should "return zero cost (placeholder)" in {
    val (allocator, region) = newAllocator()
    val (_, cost) = allocator.allocate(region)
    assert(cost == 0d)
  }

  it should "produce an OperatorConfig entry for every operator in the region" in {
    val (allocator, region) = newAllocator()
    val (resourceConfig, _) = allocator.allocate(region)
    val opIds = region.getOperators.map(_.id)
    assert(resourceConfig.operatorConfigs.keySet == opIds)
  }

  it should "respect parallelizable / suggested-worker settings on each PhysicalOp" in {
    val (allocator, region) = newAllocator()
    val (resourceConfig, _) = allocator.allocate(region)
    region.getOperators.foreach { op =>
      val workers = resourceConfig.operatorConfigs(op.id).workerConfigs.size
      val expected =
        if (!op.parallelizable) 1
        else
          op.suggestedWorkerNum.getOrElse(
            org.apache.texera.common.config.ApplicationConfig.numWorkerPerOperatorByDefault
          )
      assert(workers == expected, s"unexpected worker count for ${op.id}")
    }
  }

  it should "honor an explicit suggestedWorkerNum on a parallelizable op" in {
    val workflow = buildLinearWorkflow()
    val keywordPhysicalOpId =
      workflow.physicalPlan.operators.find(_.parallelizable).map(_.id).get
    val rebuiltOps = workflow.physicalPlan.operators.map { op =>
      if (op.id == keywordPhysicalOpId) op.withSuggestedWorkerNum(7) else op
    }
    val rebuiltPlan = workflow.physicalPlan.copy(operators = rebuiltOps)
    val allocator = new DefaultResourceAllocator(
      rebuiltPlan,
      new ExecutionClusterInfo(),
      workflow.context.workflowSettings
    )
    val region = Region(
      id = RegionIdentity(0),
      physicalOps = rebuiltOps,
      physicalLinks = rebuiltPlan.links
    )
    val (resourceConfig, _) = allocator.allocate(region)
    assert(resourceConfig.operatorConfigs(keywordPhysicalOpId).workerConfigs.size == 7)
  }

  it should "emit distinct worker ids per operator" in {
    val (allocator, region) = newAllocator()
    val (resourceConfig, _) = allocator.allocate(region)
    val ids = resourceConfig.operatorConfigs.values.flatMap(_.workerConfigs.map(_.workerId)).toList
    assert(ids.distinct.size == ids.size, s"duplicate worker ids in $ids")
  }

  it should "produce a LinkConfig entry for every physical link in the region" in {
    val (allocator, region) = newAllocator()
    val (resourceConfig, _) = allocator.allocate(region)
    assert(resourceConfig.linkConfigs.keySet == region.getLinks)
  }

  it should "wire each LinkConfig so its Partitioning channels match its channelConfigs" in {
    val (allocator, region) = newAllocator()
    val (resourceConfig, _) = allocator.allocate(region)
    resourceConfig.linkConfigs.values.foreach { link =>
      assert(link.channelConfigs.nonEmpty)
      val partitioningChannels = partitioningOf(link.partitioning)
      assert(partitioningChannels == link.channelConfigs.map(_.channelId))
    }
  }

  private def partitioningOf(p: Partitioning) =
    p match {
      case x: OneToOnePartitioning          => x.channels
      case x: RoundRobinPartitioning        => x.channels
      case x: HashBasedShufflePartitioning  => x.channels
      case x: RangeBasedShufflePartitioning => x.channels
      case x: BroadcastPartitioning         => x.channels
      case other                            => fail(s"allocator emitted unexpected Partitioning: $other")
    }

  it should "leave portConfigs empty when the region has no prior resourceConfig" in {
    val (allocator, region) = newAllocator()
    val (resourceConfig, _) = allocator.allocate(region)
    assert(resourceConfig.portConfigs.isEmpty)
  }

  // ---------------------------------------------------------------------------
  // DefaultResourceAllocator: output partition rules
  // ---------------------------------------------------------------------------

  // Hand-built plans, so each test controls what partitioning every link starts from. A source
  // has one worker and no partitioning. Every other op has two workers, so a link between two
  // of them keeps the upstream op's output partitioning unless the downstream op requires
  // another.

  private val workflowId = WorkflowIdentity(1L)
  private val executionId = ExecutionIdentity(1L)

  private def sourceOp(name: String): PhysicalOp =
    PhysicalOp
      .sourcePhysicalOp(workflowId, executionId, OperatorIdentity(name), OpExecInitInfo.Empty)
      .withOutputPorts(List(OutputPort(PortIdentity(0))))

  private def twoWorkerOp(name: String, inputPorts: Int = 1): PhysicalOp =
    PhysicalOp
      .oneToOnePhysicalOp(workflowId, executionId, OperatorIdentity(name), OpExecInitInfo.Empty)
      .withInputPorts((0 until inputPorts).map(id => InputPort(PortIdentity(id))).toList)
      .withOutputPorts(List(OutputPort(PortIdentity(0))))
      .withSuggestedWorkerNum(2)

  private def linkOf(from: PhysicalOp, to: PhysicalOp, toPort: Int = 0): PhysicalLink =
    PhysicalLink(from.id, PortIdentity(0), to.id, PortIdentity(toPort))

  /** Allocates one region that holds the whole plan, and gives each link's partitioning. */
  private def allocateWhole(
      ops: Set[PhysicalOp],
      links: List[PhysicalLink]
  ): Map[PhysicalLink, Partitioning] = {
    val plan = links.foldLeft(PhysicalPlan(ops, Set.empty))(_.addLink(_))
    val allocator = new DefaultResourceAllocator(
      plan,
      new ExecutionClusterInfo(),
      new WorkflowContext().workflowSettings
    )
    val (resourceConfig, _) =
      allocator.allocate(Region(RegionIdentity(0), plan.operators, plan.links))
    resourceConfig.linkConfigs.map { case (link, config) => link -> config.partitioning }
  }

  /** The columns a link hashes on, or None when it does not hash. */
  private def hashKeys(partitioning: Partitioning): Option[List[String]] =
    partitioning match {
      case hash: HashBasedShufflePartitioning => Some(hash.hashAttributeNames.toList)
      case _                                  => None
    }

  /** Plans src -> a -> b with `a` set up by `setUpA`, and gives the partitioning of a -> b. */
  private def partitioningAfterA(setUpA: PhysicalOp => PhysicalOp): Partitioning = {
    val src = sourceOp("src")
    val a = setUpA(twoWorkerOp("a"))
    val b = twoWorkerOp("b")
    val aToB = linkOf(a, b)
    allocateWhole(Set(src, a, b), List(linkOf(src, a), aToB))(aToB)
  }

  "DefaultResourceAllocator output partitioning" should
    "follow the upstream op's Fixed rule, whatever the op's input is" in {
    val hashOnK = PartitionRule.Fixed(HashPartition(List("k")))
    assert(hashKeys(partitioningAfterA(_.withOutputPartitionRule(hashOnK))).contains(List("k")))
    // Without the rule, a's output is as unpartitioned as the source's.
    assert(partitioningAfterA(identity).isInstanceOf[RoundRobinPartitioning])
  }

  it should "drop a hash partitioning that names no columns under KeepKeyedInput" in {
    def hashedInto(keys: List[String], rule: PartitionRule)(op: PhysicalOp): PhysicalOp =
      op.withPartitionRequirement(List(Some(HashPartition(keys)))).withOutputPartitionRule(rule)
    val keepKeyed = PartitionRule.KeepKeyedInput
    assert(partitioningAfterA(hashedInto(Nil, keepKeyed)).isInstanceOf[RoundRobinPartitioning])
    assert(hashKeys(partitioningAfterA(hashedInto(List("k"), keepKeyed))).contains(List("k")))
    // The default rule passes the keyless one on.
    val firstInput = PartitionRule.FirstInput
    assert(hashKeys(partitioningAfterA(hashedInto(Nil, firstInput))).contains(Nil))
  }

  // This pins today's order, which is not port order: the allocator groups an op's input
  // partitionings by port in a hash map, and for ports 0 and 1 port 1 comes first. Changing the
  // order changes the output partitioning of every op with two input ports on the default rule
  // (IntervalJoin, CartesianProduct, If, ...), so check each of them when you do.
  it should "partition a two-input op's output like port 1 under the default rule" in {
    val src0 = sourceOp("src0")
    val src1 = sourceOp("src1")
    val join = twoWorkerOp("join", inputPorts = 2)
      .withPartitionRequirement(
        List(Some(HashPartition(List("a"))), Some(HashPartition(List("b"))))
      )
    val sink = twoWorkerOp("sink")
    val toPort0 = linkOf(src0, join, toPort = 0)
    val toPort1 = linkOf(src1, join, toPort = 1)
    val out = linkOf(join, sink)
    val partitionings = allocateWhole(Set(src0, src1, join, sink), List(toPort0, toPort1, out))
    assert(join.outputPartitionRule == PartitionRule.FirstInput)
    assert(hashKeys(partitionings(toPort0)).contains(List("a")))
    assert(hashKeys(partitionings(toPort1)).contains(List("b")))
    assert(hashKeys(partitionings(out)).contains(List("b")))
  }
}
