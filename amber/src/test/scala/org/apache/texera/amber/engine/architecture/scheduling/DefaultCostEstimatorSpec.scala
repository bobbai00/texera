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
  GlobalPortIdentity,
  PhysicalOp,
  PortIdentity,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.coordinator.Workflow
import org.apache.texera.amber.engine.architecture.scheduling.DefaultCostEstimator.DEFAULT_OPERATOR_COST
import org.apache.texera.amber.engine.architecture.scheduling.config.{
  OutputPortConfig,
  ResourceConfig
}
import org.apache.texera.amber.engine.architecture.scheduling.resourcePolicies.{
  DefaultResourceAllocator,
  ExecutionClusterInfo
}
import org.apache.texera.amber.engine.common.virtualidentity.util.COORDINATOR
import org.apache.texera.amber.engine.e2e.TestUtils.buildWorkflow
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.aggregate.{AggregateOpDesc, AggregationFunction}
import org.apache.texera.amber.operator.keywordSearch.KeywordSearchOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.common.compiler.model.LogicalLink
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import scala.jdk.CollectionConverters.CollectionHasAsScala

/**
  * The scheduler's cost model. A region costs the seconds its longest-running operator took in an
  * earlier execution, as the run's cost hints give them, or, when the run has none, the number of
  * its ports whose results are stored. The hints come from the run's context alone: this spec has
  * no database, and each workflow is made to run as a run's is, its hints saved with its plan and
  * read back with it.
  */
class DefaultCostEstimatorSpec extends AnyFlatSpec with Matchers {

  private val csvOpDesc: CSVScanSourceOpDesc = TestOperators.headerlessSmallCsvScanOpDesc()
  private val keywordOpDesc: KeywordSearchOpDesc =
    TestOperators.keywordSearchOpDesc("column-1", "Asia")
  private val groupByOpDesc: AggregateOpDesc =
    TestOperators.aggregateAndGroupByDesc("column-1", AggregationFunction.COUNT, List[String]())

  private val csvId = csvOpDesc.operatorIdentifier.id
  private val keywordId = keywordOpDesc.operatorIdentifier.id
  private val groupById = groupByOpDesc.operatorIdentifier.id

  /** A run's context with `hints`, as a run's web layer would set it up. */
  private def contextWith(hints: Option[CostHints]): WorkflowContext = {
    val context = new WorkflowContext()
    context.costHints = hints
    context
  }

  /** Cost hints from execution 7 giving each named operator its seconds. */
  private def hints(seconds: (String, Double)*): Option[CostHints] =
    Some(CostHints(ExecutionIdentity(7), seconds.toMap))

  /** csv -> keyword, made to run under `context`. */
  private def csvToKeyword(context: WorkflowContext): Workflow =
    buildWorkflow(
      List(csvOpDesc, keywordOpDesc),
      List(
        LogicalLink(
          csvOpDesc.operatorIdentifier,
          PortIdentity(0),
          keywordOpDesc.operatorIdentifier,
          PortIdentity(0)
        )
      ),
      context
    )

  private def outputPortsOf(ops: Set[PhysicalOp]): Set[GlobalPortIdentity] =
    ops.flatMap(op => op.outputPorts.keys.map(GlobalPortIdentity(op.id, _)))

  /**
    * A region of `ops` of `workflow`, with every port they have and the links between them, that
    * stores the results of `storedPorts`.
    */
  private def regionOf(
      workflow: Workflow,
      ops: Set[PhysicalOp],
      storedPorts: Set[GlobalPortIdentity] = Set.empty
  ): Region = {
    val opIds = ops.map(_.id)
    Region(
      id = RegionIdentity(0),
      physicalOps = ops,
      physicalLinks = workflow.physicalPlan.links.filter(link =>
        opIds.contains(link.fromOpId) && opIds.contains(link.toOpId)
      ),
      ports = ops.flatMap(op =>
        op.inputPorts.keys.map(GlobalPortIdentity(op.id, _, input = true))
      ) ++ outputPortsOf(ops),
      resourceConfig = Option.when(storedPorts.nonEmpty)(
        ResourceConfig(portConfigs = storedPorts.toSeq.zipWithIndex.map {
          case (port, index) => port -> OutputPortConfig(new URI(s"vfs:///stored/$index"))
        }.toMap)
      )
    )
  }

  /** What the cost model estimates `region` of `workflow` costs, under the workflow's context. */
  private def costOf(workflow: Workflow, region: Region): Double = {
    val allocator = new DefaultResourceAllocator(
      workflow.physicalPlan,
      new ExecutionClusterInfo(),
      workflow.context.workflowSettings
    )
    new DefaultCostEstimator(workflow.context, allocator, COORDINATOR)
      .allocateResourcesAndEstimateCost(region, 1)
      ._2
  }

  "DefaultCostEstimator" should "cost a region by the number of its ports whose results are stored when the run has no cost hints" in {
    val workflow = csvToKeyword(contextWith(None))
    val ops = workflow.physicalPlan.operators
    val outputs = outputPortsOf(ops)
    outputs should have size 2

    costOf(workflow, regionOf(workflow, ops)) shouldBe 0.0
    costOf(workflow, regionOf(workflow, ops, storedPorts = outputs)) shouldBe 2.0
    costOf(workflow, regionOf(workflow, ops, storedPorts = outputs.take(1))) shouldBe 1.0
  }

  it should "cost a region by its longest-running operator when the run has cost hints, whatever it stores" in {
    val workflow = csvToKeyword(contextWith(hints(csvId -> 0.5, keywordId -> 2.25)))
    val ops = workflow.physicalPlan.operators
    val csv = ops.filter(_.id.logicalOpId.id == csvId)
    csv should have size 1

    costOf(workflow, regionOf(workflow, ops)) shouldBe 2.25
    costOf(workflow, regionOf(workflow, ops, storedPorts = outputPortsOf(ops))) shouldBe 2.25
    costOf(workflow, regionOf(workflow, csv)) shouldBe 0.5
    costOf(workflow, regionOf(workflow, csv, storedPorts = outputPortsOf(csv))) shouldBe 0.5
  }

  it should "cost an operator its hints do not name at the default cost" in {
    // The hints may name operators the plan no longer has, and leave out ones it has gained.
    val workflow = csvToKeyword(contextWith(hints(csvId -> 0.25, "gone" -> 9.0)))
    val ops = workflow.physicalPlan.operators
    val csv = ops.filter(_.id.logicalOpId.id == csvId)
    val keyword = ops.filter(_.id.logicalOpId.id == keywordId)

    costOf(workflow, regionOf(workflow, ops)) shouldBe DEFAULT_OPERATOR_COST
    costOf(workflow, regionOf(workflow, keyword)) shouldBe DEFAULT_OPERATOR_COST
    costOf(workflow, regionOf(workflow, csv)) shouldBe 0.25
  }

  it should "take cost hints that name no operator for no past statistics" in {
    val workflow = csvToKeyword(contextWith(hints()))
    workflow.context.costHints shouldBe hints()
    val ops = workflow.physicalPlan.operators

    // the number of stored ports, not the default cost of an operator the hints do not name
    costOf(workflow, regionOf(workflow, ops, storedPorts = outputPortsOf(ops))) shouldBe 2.0
    costOf(workflow, regionOf(workflow, ops)) shouldBe 0.0
  }

  it should "cost each region a search finds by its longest-running operator, and the search by their sum" in {
    val workflow = buildWorkflow(
      List(csvOpDesc, groupByOpDesc, keywordOpDesc),
      List(
        LogicalLink(
          csvOpDesc.operatorIdentifier,
          PortIdentity(0),
          groupByOpDesc.operatorIdentifier,
          PortIdentity(0)
        ),
        LogicalLink(
          groupByOpDesc.operatorIdentifier,
          PortIdentity(0),
          keywordOpDesc.operatorIdentifier,
          PortIdentity(0)
        )
      ),
      contextWith(hints(csvId -> 0.25, groupById -> 2.5, keywordId -> 0.75))
    )

    val searchResult = new CostBasedScheduleGenerator(
      workflow.context,
      workflow.physicalPlan,
      COORDINATOR
    ).bottomUpSearch()

    // Two regions: CSV -> local aggregate -> global aggregate, then the keyword search.
    val regions = searchResult.regionDAG.vertexSet().asScala.toSeq
    regions.map(_.physicalOps.size).sorted shouldBe Seq(1, 3)
    val groupByRegion = regions.find(_.physicalOps.size == 3).get
    val keywordRegion = regions.find(_.physicalOps.size == 1).get

    // Both physical operators of the aggregate cost what its logical operator took, the longest
    // in the first region.
    costOf(workflow, groupByRegion) shouldBe 2.5
    costOf(workflow, keywordRegion) shouldBe 0.75
    searchResult.cost shouldBe 2.5 + 0.75
  }
}
