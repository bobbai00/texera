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

package org.apache.texera.amber.engine.architecture.scheduling

import org.apache.texera.amber.core.virtualidentity.ExecutionIdentity
import org.apache.texera.amber.core.workflow.{
  CostHints,
  ExecutionMode,
  GlobalPortIdentity,
  PhysicalPlan,
  PortIdentity,
  WorkflowContext,
  WorkflowSettings
}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.amber.engine.architecture.scheduling.DefaultCostEstimator.DEFAULT_OPERATOR_COST
import org.apache.texera.amber.engine.architecture.scheduling.config.OutputPortConfig
import org.apache.texera.amber.engine.common.virtualidentity.util.COORDINATOR
import org.apache.texera.amber.engine.e2e.TestUtils.buildWorkflow
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.aggregate.AggregationFunction
import org.apache.texera.amber.operator.hashJoin.HashJoinOpDesc
import org.apache.texera.amber.operator.keywordSearch.KeywordSearchOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.common.compiler.model.LogicalLink
import org.scalamock.scalatest.MockFactory
import org.scalatest.flatspec.AnyFlatSpec

import java.net.URI
import scala.jdk.CollectionConverters._

class CostBasedScheduleGeneratorSpec extends AnyFlatSpec with MockFactory {

  /** A run's context with `hints`, as a run's web layer would set it up. */
  private def contextWith(
      hints: Option[CostHints],
      settings: WorkflowSettings = WorkflowSettings()
  ): WorkflowContext = {
    val context = new WorkflowContext(workflowSettings = settings)
    context.costHints = hints
    context
  }

  /** The csv->->filter->join->filter2 workflow of these operators, made to run under `context`. */
  private def csvFilterJoinFilter(
      csv: CSVScanSourceOpDesc,
      keyword: KeywordSearchOpDesc,
      join: HashJoinOpDesc[String],
      keyword2: KeywordSearchOpDesc,
      context: WorkflowContext
  ): Workflow =
    buildWorkflow(
      List(csv, keyword, join, keyword2),
      List(
        LogicalLink(
          csv.operatorIdentifier,
          PortIdentity(),
          join.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          csv.operatorIdentifier,
          PortIdentity(),
          keyword.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keyword.operatorIdentifier,
          PortIdentity(),
          join.operatorIdentifier,
          PortIdentity(1)
        ),
        LogicalLink(
          join.operatorIdentifier,
          PortIdentity(),
          keyword2.operatorIdentifier,
          PortIdentity()
        )
      ),
      context
    )

  private def generatorFor(workflow: Workflow): CostBasedScheduleGenerator =
    new CostBasedScheduleGenerator(workflow.context, workflow.physicalPlan, COORDINATOR)

  "CostBasedRegionPlanGenerator" should "finish bottom-up search using different pruning techniques with correct number of states explored in csv->->filter->join->filter2 workflow" in {
    val headerlessCsvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val joinOpDesc = TestOperators.joinOpDesc("column-1", "column-1")
    val keywordOpDesc2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow = buildWorkflow(
      List(
        headerlessCsvOpDesc1,
        keywordOpDesc,
        joinOpDesc,
        keywordOpDesc2
      ),
      List(
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keywordOpDesc.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity(1)
        ),
        LogicalLink(
          joinOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc2.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    val globalSearchNoPruningResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).bottomUpSearch(globalSearch = true, oChains = false, oCleanEdges = false, oEarlyStop = false)

    // Should have explored all possible states (2^4 states)
    assert(globalSearchNoPruningResult.numStatesExplored == 16)

    val globalSearchOChainsResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).bottomUpSearch(globalSearch = true, oCleanEdges = false, oEarlyStop = false)

    // By applying pruning based on Chains alone, it should skip 10 (8 + 2) states. 8 states where CSV->Build is
    // materialized should be skipped because this edge is in the same chain as another blocking edge.
    // Of the remaining states, 2 more states where both CSV->KeywordFilter and KeywordFilter->Probe are materialized
    // should be skipped because these two edges are in the same chain.
    assert(globalSearchOChainsResult.numStatesExplored == 6)

    val globalSearchOCleanEdgesResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).bottomUpSearch(globalSearch = true, oChains = false, oEarlyStop = false)

    // By applying pruning based on Clean edges (bridges) alone, it should skip 8 states. There is one clean edge
    // in the DAG (Probe->Keyword2) and the 8 states where this edge is materialized should be skipped.
    assert(globalSearchOCleanEdgesResult.numStatesExplored == 8)

    val globalSearchOEarlyStopResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).bottomUpSearch(globalSearch = true, oChains = false, oCleanEdges = false)

    // By applying pruning based on Early Stop alone, only 6 states that are not descendants of a schedulable states
    // should be explored.
    assert(globalSearchOEarlyStopResult.numStatesExplored == 6)

    val globalSearchAllPruningEnabledResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).bottomUpSearch(globalSearch = true)

    // By combining all pruning techniques, only 3 states should be visited (1 state where both CSV->KeywordFilter and
    // KeywordFilter->Probe are pipelined, and two states where only one of CSV->KeywordFilter or KeywordFilter->Probe
    // is materialized. The other two edges should always be pipelined.)
    assert(globalSearchAllPruningEnabledResult.numStatesExplored == 3)

  }

  "CostBasedRegionPlanGenerator" should "finish top-down search using different pruning techniques with correct number of states explored in csv->->filter->join->filter2 workflow" in {
    val headerlessCsvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val joinOpDesc = TestOperators.joinOpDesc("column-1", "column-1")
    val keywordOpDesc2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow = buildWorkflow(
      List(
        headerlessCsvOpDesc1,
        keywordOpDesc,
        joinOpDesc,
        keywordOpDesc2
      ),
      List(
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keywordOpDesc.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity(1)
        ),
        LogicalLink(
          joinOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc2.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    val globalSearchNoPruningResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).topDownSearch(globalSearch = true, oChains = false, oCleanEdges = false)

    // Should have explored all possible states (2^4 states)
    assert(globalSearchNoPruningResult.numStatesExplored == 16)

    val globalSearchOChainsResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).topDownSearch(globalSearch = true, oCleanEdges = false)

    // By applying pruning based on Chains alone, it should start with a state where CSV->Build is pipelined because
    // this edge is in the same chain as another blocking edge. That reduces the search space to 8 states.
    assert(globalSearchOChainsResult.numStatesExplored == 8)

    val globalSearchOCleanEdgesResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).topDownSearch(globalSearch = true, oChains = false)

    // By applying pruning based on Clean Edges (bridges) alone, it should start with a state where Probe->Keyword2 is
    // pipelined because this edge is a clean edge. That reduces the search space to 8 states.
    assert(globalSearchOCleanEdgesResult.numStatesExplored == 8)

    val globalSearchAllPruningEnabledResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).topDownSearch(globalSearch = true)

    // By combining both pruning techniques, the search should start with a state where both CSV->Build and
    // Probe->Keyword2 are pipelined, reducing the search space to 4 states.
    assert(globalSearchAllPruningEnabledResult.numStatesExplored == 4)

  }

  // MATERIALIZED ExecutionMode tests - each operator should be a separate region
  "CostBasedRegionPlanGenerator" should "create separate region for each operator in MATERIALIZED mode for simple csv workflow" in {
    val csvOpDesc = TestOperators.smallCsvScanOpDesc()
    val materializedContext = new WorkflowContext(
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 400,
        executionMode = ExecutionMode.MATERIALIZED
      )
    )
    val workflow = buildWorkflow(
      List(csvOpDesc),
      List(),
      materializedContext
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )
    val result = scheduleGenerator.getFullyMaterializedSearchState

    // Should only explore 1 state (fully materialized)
    assert(result.numStatesExplored == 1)

    // Each physical operator should be in its own region
    val regions = result.regionDAG.vertexSet().asScala
    val numPhysicalOps = workflow.physicalPlan.operators.size
    assert(regions.size == numPhysicalOps, s"Expected $numPhysicalOps regions, got ${regions.size}")

    // Each region should contain exactly 1 operator
    regions.foreach { region =>
      assert(
        region.getOperators.size == 1,
        s"Expected region to have 1 operator, got ${region.getOperators.size}"
      )
    }
  }

  "CostBasedRegionPlanGenerator" should "create separate region for each operator in MATERIALIZED mode for csv->keyword workflow" in {
    val csvOpDesc = TestOperators.smallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("Region", "Asia")
    val materializedContext = new WorkflowContext(
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 400,
        executionMode = ExecutionMode.MATERIALIZED
      )
    )
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
      materializedContext
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )
    val result = scheduleGenerator.getFullyMaterializedSearchState

    // Should only explore 1 state (fully materialized)
    assert(result.numStatesExplored == 1)

    // Each physical operator should be in its own region
    val regions = result.regionDAG.vertexSet().asScala
    val numPhysicalOps = workflow.physicalPlan.operators.size
    assert(regions.size == numPhysicalOps, s"Expected $numPhysicalOps regions, got ${regions.size}")

    // Each region should contain exactly 1 operator
    regions.foreach { region =>
      assert(
        region.getOperators.size == 1,
        s"Expected region to have 1 operator, got ${region.getOperators.size}"
      )
    }

    // All links should be materialized (represented as region links)
    val numRegionLinks = result.regionDAG.edgeSet().asScala.size
    val numPhysicalLinks = workflow.physicalPlan.links.size
    assert(
      numRegionLinks == numPhysicalLinks,
      s"Expected $numPhysicalLinks region links, got $numRegionLinks"
    )
  }

  "CostBasedRegionPlanGenerator" should "create separate region for each operator in MATERIALIZED mode for csv->keyword->count workflow" in {
    val csvOpDesc = TestOperators.smallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("Region", "Asia")
    val countOpDesc = TestOperators.aggregateAndGroupByDesc(
      "Region",
      org.apache.texera.amber.operator.aggregate.AggregationFunction.COUNT,
      List[String]()
    )
    val materializedContext = new WorkflowContext(
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 400,
        executionMode = ExecutionMode.MATERIALIZED
      )
    )
    val workflow = buildWorkflow(
      List(csvOpDesc, keywordOpDesc, countOpDesc),
      List(
        LogicalLink(
          csvOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keywordOpDesc.operatorIdentifier,
          PortIdentity(),
          countOpDesc.operatorIdentifier,
          PortIdentity()
        )
      ),
      materializedContext
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )
    val result = scheduleGenerator.getFullyMaterializedSearchState

    // Should only explore 1 state (fully materialized)
    assert(result.numStatesExplored == 1)

    // Each physical operator should be in its own region
    val regions = result.regionDAG.vertexSet().asScala
    val numPhysicalOps = workflow.physicalPlan.operators.size
    assert(regions.size == numPhysicalOps, s"Expected $numPhysicalOps regions, got ${regions.size}")

    // Each region should contain exactly 1 operator
    regions.foreach { region =>
      assert(
        region.getOperators.size == 1,
        s"Expected region to have 1 operator, got ${region.getOperators.size}"
      )
    }

    // All links should be materialized (represented as region links)
    val numRegionLinks = result.regionDAG.edgeSet().asScala.size
    val numPhysicalLinks = workflow.physicalPlan.links.size
    assert(
      numRegionLinks == numPhysicalLinks,
      s"Expected $numPhysicalLinks region links, got $numRegionLinks"
    )
  }

  "CostBasedRegionPlanGenerator" should "create separate region for each operator in MATERIALIZED mode for join workflow" in {
    val headerlessCsvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val headerlessCsvOpDesc2 = TestOperators.headerlessSmallCsvScanOpDesc()
    val joinOpDesc = TestOperators.joinOpDesc("column-1", "column-1")
    val materializedContext = new WorkflowContext(
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 400,
        executionMode = ExecutionMode.MATERIALIZED
      )
    )
    val workflow = buildWorkflow(
      List(
        headerlessCsvOpDesc1,
        headerlessCsvOpDesc2,
        joinOpDesc
      ),
      List(
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          headerlessCsvOpDesc2.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity(1)
        )
      ),
      materializedContext
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )
    val result = scheduleGenerator.getFullyMaterializedSearchState

    // Should only explore 1 state (fully materialized)
    assert(result.numStatesExplored == 1)

    // Each physical operator should be in its own region
    val regions = result.regionDAG.vertexSet().asScala
    val numPhysicalOps = workflow.physicalPlan.operators.size
    assert(regions.size == numPhysicalOps, s"Expected $numPhysicalOps regions, got ${regions.size}")

    // Each region should contain exactly 1 operator
    regions.foreach { region =>
      assert(
        region.getOperators.size == 1,
        s"Expected region to have 1 operator, got ${region.getOperators.size}"
      )
    }

    // All links should be materialized (represented as region links)
    val numRegionLinks = result.regionDAG.edgeSet().asScala.size
    val numPhysicalLinks = workflow.physicalPlan.links.size
    assert(
      numRegionLinks == numPhysicalLinks,
      s"Expected $numPhysicalLinks region links, got $numRegionLinks"
    )
  }

  "CostBasedRegionPlanGenerator" should "create separate region for each operator in MATERIALIZED mode for complex csv->->filter->join->filter2 workflow" in {
    val headerlessCsvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val joinOpDesc = TestOperators.joinOpDesc("column-1", "column-1")
    val keywordOpDesc2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val materializedContext = new WorkflowContext(
      workflowSettings = WorkflowSettings(
        dataTransferBatchSize = 400,
        executionMode = ExecutionMode.MATERIALIZED
      )
    )
    val workflow = buildWorkflow(
      List(
        headerlessCsvOpDesc1,
        keywordOpDesc,
        joinOpDesc,
        keywordOpDesc2
      ),
      List(
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keywordOpDesc.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity(1)
        ),
        LogicalLink(
          joinOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc2.operatorIdentifier,
          PortIdentity()
        )
      ),
      materializedContext
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )
    val result = scheduleGenerator.getFullyMaterializedSearchState

    // Should only explore 1 state (fully materialized)
    assert(result.numStatesExplored == 1)

    // Each physical operator should be in its own region
    val regions = result.regionDAG.vertexSet().asScala
    val numPhysicalOps = workflow.physicalPlan.operators.size
    assert(regions.size == numPhysicalOps, s"Expected $numPhysicalOps regions, got ${regions.size}")

    // Each region should contain exactly 1 operator
    regions.foreach { region =>
      assert(
        region.getOperators.size == 1,
        s"Expected region to have 1 operator, got ${region.getOperators.size}"
      )
    }

    // All links should be materialized (represented as region links)
    val numRegionLinks = result.regionDAG.edgeSet().asScala.size
    val numPhysicalLinks = workflow.physicalPlan.links.size
    assert(
      numRegionLinks == numPhysicalLinks,
      s"Expected $numPhysicalLinks region links, got $numRegionLinks"
    )
  }

  "CostBasedScheduleGenerator.effectiveExecutionMode" should
    "force MATERIALIZED when an operator requires it, even if PIPELINED is requested" in {
    val workflow = buildWorkflow(
      List(TestOperators.headerlessSmallCsvScanOpDesc()),
      List(),
      new WorkflowContext()
    )
    val planRequiringMaterialization = PhysicalPlan(
      workflow.physicalPlan.operators.map(_.withRequiresMaterializedExecution(true)),
      workflow.physicalPlan.links
    )
    assert(
      CostBasedScheduleGenerator.effectiveExecutionMode(
        planRequiringMaterialization,
        ExecutionMode.PIPELINED
      ) == ExecutionMode.MATERIALIZED
    )
  }

  it should "keep the requested mode when no operator requires materialization" in {
    val workflow = buildWorkflow(
      List(TestOperators.headerlessSmallCsvScanOpDesc()),
      List(),
      new WorkflowContext()
    )
    val plan = workflow.physicalPlan
    assert(
      CostBasedScheduleGenerator.effectiveExecutionMode(plan, ExecutionMode.PIPELINED) ==
        ExecutionMode.PIPELINED
    )
    assert(
      CostBasedScheduleGenerator.effectiveExecutionMode(plan, ExecutionMode.MATERIALIZED) ==
        ExecutionMode.MATERIALIZED
    )
  }

  "CostBasedRegionPlanGenerator" should "finish bottom-up greedy search (globalSearch=false) in csv->->filter->join->filter2 workflow" in {
    val headerlessCsvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val joinOpDesc = TestOperators.joinOpDesc("column-1", "column-1")
    val keywordOpDesc2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow = buildWorkflow(
      List(
        headerlessCsvOpDesc1,
        keywordOpDesc,
        joinOpDesc,
        keywordOpDesc2
      ),
      List(
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keywordOpDesc.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity(1)
        ),
        LogicalLink(
          joinOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc2.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )

    // Greedy search (globalSearch = false): at each schedulable/unschedulable state the frontier keeps only
    // the single lowest-cost neighbor, driving the greedy branch (filteredNeighborStates.nonEmpty + minBy).
    val greedyResult = scheduleGenerator.bottomUpSearch(globalSearch = false)

    // A schedulable plan should have been found: the region DAG is non-empty and the cost is finite.
    assert(greedyResult.regionDAG.vertexSet().asScala.nonEmpty)
    assert(greedyResult.cost < Double.PositiveInfinity)

    // The greedy search enqueues at most one neighbor per explored state, and each bottom-up transition materializes
    // one more edge, so the number of states it explores is bounded linearly by the number of physical links. This is
    // a guaranteed property of greedy search, unlike a comparison against global search whose explored count depends on
    // early-stop pruning and queue ordering.
    assert(greedyResult.numStatesExplored <= scheduleGenerator.physicalPlan.links.size + 1)

    // The chosen state is a set of materialized non-blocking edges, all of which must be links of the physical plan.
    assert(greedyResult.state.subsetOf(scheduleGenerator.physicalPlan.links))
  }

  "CostBasedRegionPlanGenerator" should "finish top-down greedy search (globalSearch=false) in csv->->filter->join->filter2 workflow" in {
    val headerlessCsvOpDesc1 = TestOperators.headerlessSmallCsvScanOpDesc()
    val keywordOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val joinOpDesc = TestOperators.joinOpDesc("column-1", "column-1")
    val keywordOpDesc2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val workflow = buildWorkflow(
      List(
        headerlessCsvOpDesc1,
        keywordOpDesc,
        joinOpDesc,
        keywordOpDesc2
      ),
      List(
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          headerlessCsvOpDesc1.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keywordOpDesc.operatorIdentifier,
          PortIdentity(),
          joinOpDesc.operatorIdentifier,
          PortIdentity(1)
        ),
        LogicalLink(
          joinOpDesc.operatorIdentifier,
          PortIdentity(),
          keywordOpDesc2.operatorIdentifier,
          PortIdentity()
        )
      ),
      new WorkflowContext()
    )

    val scheduleGenerator = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    )

    // Greedy search (globalSearch = false): starting from the fully materialized seed state, each transition
    // keeps only the single lowest-cost neighbor, driving the greedy branch (unvisitedNeighborStates.nonEmpty + minBy)
    // over both the schedulable (Left) and unschedulable-intermediate (Right) legs.
    val greedyResult = scheduleGenerator.topDownSearch(globalSearch = false)

    // A schedulable plan should have been found: the region DAG is non-empty and the cost is finite.
    assert(greedyResult.regionDAG.vertexSet().asScala.nonEmpty)
    assert(greedyResult.cost < Double.PositiveInfinity)

    // The chosen state is a set of materialized non-blocking edges, all of which must be links of the physical plan.
    assert(greedyResult.state.subsetOf(scheduleGenerator.physicalPlan.links))
  }

  // The run's cost hints reach the cost model through the run's context, as the plan saved them.

  "CostBasedScheduleGenerator" should "explore the states it explores without cost hints when its run has them" in {
    // A global search visits every state its pruning leaves, whatever a state costs: the hints
    // change what the plans it finds cost, not which states it explores.
    val csv = TestOperators.headerlessSmallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val join = TestOperators.joinOpDesc("column-1", "column-1")
    val keyword2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val hints = CostHints(
      ExecutionIdentity(7),
      Map(
        csv.operatorIdentifier.id -> 100.25,
        keyword.operatorIdentifier.id -> 10.5,
        join.operatorIdentifier.id -> 1000.75,
        keyword2.operatorIdentifier.id -> 0.125
      )
    )
    val withoutHints = csvFilterJoinFilter(csv, keyword, join, keyword2, contextWith(None))
    val withHints = csvFilterJoinFilter(csv, keyword, join, keyword2, contextWith(Some(hints)))
    assert(withHints.context.costHints.contains(hints))

    def statesExplored(workflow: Workflow): Seq[Int] =
      Seq(
        generatorFor(workflow).bottomUpSearch(
          globalSearch = true,
          oChains = false,
          oCleanEdges = false,
          oEarlyStop = false
        ),
        generatorFor(workflow)
          .bottomUpSearch(globalSearch = true, oCleanEdges = false, oEarlyStop = false),
        generatorFor(workflow)
          .bottomUpSearch(globalSearch = true, oChains = false, oEarlyStop = false),
        generatorFor(workflow)
          .bottomUpSearch(globalSearch = true, oChains = false, oCleanEdges = false),
        generatorFor(workflow).bottomUpSearch(globalSearch = true),
        generatorFor(workflow)
          .topDownSearch(globalSearch = true, oChains = false, oCleanEdges = false),
        generatorFor(workflow).topDownSearch(globalSearch = true, oCleanEdges = false),
        generatorFor(workflow).topDownSearch(globalSearch = true, oChains = false),
        generatorFor(workflow).topDownSearch(globalSearch = true)
      ).map(_.numStatesExplored)

    // the counts the bottom-up and top-down cases above pin
    val expected = Seq(16, 6, 8, 6, 3, 16, 8, 8, 4)
    assert(statesExplored(withoutHints) == expected)
    assert(statesExplored(withHints) == expected)
  }

  it should "cost the plan a search finds by the cost hints of its run" in {
    val csv = TestOperators.headerlessSmallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    val join = TestOperators.joinOpDesc("column-1", "column-1")
    val keyword2 = TestOperators.keywordSearchOpDesc("column-1", "Asia")
    // Eighths, so a sum is the same in any order.
    val seconds = Map(
      csv.operatorIdentifier.id -> 100.25,
      keyword.operatorIdentifier.id -> 10.5,
      join.operatorIdentifier.id -> 1000.75,
      keyword2.operatorIdentifier.id -> 0.125
    )
    val withHints = csvFilterJoinFilter(
      csv,
      keyword,
      join,
      keyword2,
      contextWith(Some(CostHints(ExecutionIdentity(7), seconds)))
    )

    val result = generatorFor(withHints).bottomUpSearch(globalSearch = true)

    // Each region costs its longest-running operator, and the plan the sum of its regions.
    val regions = result.regionDAG.vertexSet().asScala.toSeq
    assert(regions.nonEmpty)
    val longest = regions.map(region =>
      region.getOperators.toSeq
        .map(op => seconds.getOrElse(op.id.logicalOpId.id, DEFAULT_OPERATOR_COST))
        .max
    )
    assert(result.cost == longest.sum)
    // ...and not the number of stored ports it costs without hints
    val withoutHints = csvFilterJoinFilter(csv, keyword, join, keyword2, contextWith(None))
    assert(result.cost != generatorFor(withoutHints).bottomUpSearch(globalSearch = true).cost)
  }

  it should "cost a fully materialized plan by the hinted seconds of each of its operators" in {
    val csv = TestOperators.smallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("Region", "Asia")
    val count =
      TestOperators.aggregateAndGroupByDesc("Region", AggregationFunction.COUNT, List[String]())
    val seconds = Map(
      csv.operatorIdentifier.id -> 0.5,
      keyword.operatorIdentifier.id -> 0.25,
      count.operatorIdentifier.id -> 4.0
    )
    val workflow = buildWorkflow(
      List(csv, keyword, count),
      List(
        LogicalLink(
          csv.operatorIdentifier,
          PortIdentity(),
          keyword.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keyword.operatorIdentifier,
          PortIdentity(),
          count.operatorIdentifier,
          PortIdentity()
        )
      ),
      contextWith(
        Some(CostHints(ExecutionIdentity(7), seconds)),
        WorkflowSettings(dataTransferBatchSize = 400, executionMode = ExecutionMode.MATERIALIZED)
      )
    )

    val result = generatorFor(workflow).getFullyMaterializedSearchState

    // One region per physical operator; both of the count's (local and global) cost what it took.
    assert(workflow.physicalPlan.operators.size == 4)
    assert(result.regionDAG.vertexSet().size() == 4)
    assert(result.cost == 0.5 + 0.25 + 4.0 + 4.0)
  }

  /** The csv->keyword->count workflow, made to run with every link read from storage. */
  private def materializedCsvKeywordCount(): Workflow = {
    val csv = TestOperators.smallCsvScanOpDesc()
    val keyword = TestOperators.keywordSearchOpDesc("Region", "Asia")
    val count =
      TestOperators.aggregateAndGroupByDesc("Region", AggregationFunction.COUNT, List[String]())
    buildWorkflow(
      List(csv, keyword, count),
      List(
        LogicalLink(
          csv.operatorIdentifier,
          PortIdentity(),
          keyword.operatorIdentifier,
          PortIdentity()
        ),
        LogicalLink(
          keyword.operatorIdentifier,
          PortIdentity(),
          count.operatorIdentifier,
          PortIdentity()
        )
      ),
      contextWith(
        None,
        WorkflowSettings(dataTransferBatchSize = 400, executionMode = ExecutionMode.MATERIALIZED)
      )
    )
  }

  it should "store each port where the plan says, and read each input from where its upstream port is stored" in {
    val workflow = materializedCsvKeywordCount()
    // The plan's locations, each one other than the location a port of this execution is given
    // when its plan is made: a scheduler that made locations up would not arrive at them.
    val plan = workflow.physicalPlan.copy(operators = workflow.physicalPlan.operators.map { op =>
      op.copy(storageLocations = op.storageLocations.map {
        case (port, location) =>
          port -> new URI(location.toString.replace("/wid/", "/elsewhere/wid/"))
      })
    })
    assert(
      plan.operators.flatMap(_.storageLocations.values) !=
        workflow.physicalPlan.operators.flatMap(_.storageLocations.values)
    )

    val regions = new CostBasedScheduleGenerator(
      workflow.context,
      plan,
      COORDINATOR
    ).getFullyMaterializedSearchState.regionDAG
      .vertexSet()
      .asScala
    val portConfigs = regions.flatMap(_.resourceConfig.get.portConfigs).toMap

    // Stored: the output port of every link, and the port whose result the user views.
    val stored = plan.links.map(link => GlobalPortIdentity(link.fromOpId, link.fromPortId)) ++
      workflow.context.workflowSettings.outputPortsNeedingStorage
    assert(stored.size == 4)
    assert(portConfigs.keySet.filterNot(_.input) == stored)
    stored.foreach { port =>
      assert(
        portConfigs(port) ==
          OutputPortConfig(plan.getOperator(port.opId).storageLocation(port.portId))
      )
    }
    // Read: the input port of every link, from its upstream port's location.
    assert(portConfigs.keySet.count(_.input) == plan.links.size)
    plan.links.foreach { link =>
      assert(
        portConfigs(GlobalPortIdentity(link.toOpId, link.toPortId, input = true)).storageURIs ==
          List(plan.getOperator(link.fromOpId).storageLocation(link.fromPortId))
      )
    }
  }

  it should "schedule no plan that names no location for a port it stores" in {
    val workflow = materializedCsvKeywordCount()
    val plan = workflow.physicalPlan.copy(
      operators = workflow.physicalPlan.operators.map(_.copy(storageLocations = Map.empty))
    )

    val refused = intercept[IllegalStateException] {
      new CostBasedScheduleGenerator(
        workflow.context,
        plan,
        COORDINATOR
      ).getFullyMaterializedSearchState
    }
    assert(refused.getMessage.contains("has no storage location: its plan was not made to run"))
  }

}
