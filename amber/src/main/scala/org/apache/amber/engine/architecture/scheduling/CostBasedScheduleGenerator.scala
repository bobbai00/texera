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

import org.apache.amber.config.ApplicationConfig
import org.apache.amber.core.storage.VFSURIFactory.createResultURI
import org.apache.amber.core.virtualidentity.{ActorVirtualIdentity, PhysicalOpIdentity}
import org.apache.amber.core.workflow._
import org.apache.amber.engine.architecture.scheduling.SchedulingUtils.replaceVertex
import org.apache.amber.engine.architecture.scheduling.config.{
  IntermediateInputPortConfig,
  OutputPortConfig,
  ResourceConfig
}
import org.apache.amber.engine.common.AmberLogging
import org.jgrapht.Graph
import org.jgrapht.alg.connectivity.BiconnectivityInspector
import org.jgrapht.graph.{DirectedAcyclicGraph, DirectedPseudograph}

import java.net.URI
import java.util.concurrent.TimeoutException
import scala.collection.mutable
import scala.concurrent.ExecutionContext.Implicits.global
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, Future}
import scala.jdk.CollectionConverters._
import scala.util.control.Breaks.{break, breakable}
import scala.util.{Failure, Success, Try}

/**
  * Result of cache analysis for a physical plan.
  *
  * @param cachedOutputPorts Map of output ports with cache hits to their cached URIs
  * @param linksToMaterialize Links whose output ports have cache hits (should be treated as materialized)
  * @param cacheKeys Map of all output ports to their cache keys (for storing after execution)
  * @param fullyCachedOperators Operators where all output ports are cached and can be skipped
  * @param cachedViewResultPorts Cached output ports that need to be displayed (view result ports)
  */
case class CacheAnalysisResult(
    cachedOutputPorts: Map[GlobalPortIdentity, URI],
    linksToMaterialize: Set[PhysicalLink],
    cacheKeys: Map[GlobalPortIdentity, String],
    fullyCachedOperators: Set[PhysicalOpIdentity],
    cachedViewResultPorts: Map[GlobalPortIdentity, URI]
)

class CostBasedScheduleGenerator(
    workflowContext: WorkflowContext,
    initialPhysicalPlan: PhysicalPlan,
    val actorId: ActorVirtualIdentity
) extends ScheduleGenerator(
      workflowContext,
      initialPhysicalPlan
    )
    with AmberLogging {

  case class SearchResult(
      state: Set[PhysicalLink],
      regionDAG: DirectedAcyclicGraph[Region, RegionLink],
      cost: Double,
      searchTimeNanoSeconds: Long = 0,
      numStatesExplored: Int = 0
  )

  private val costEstimator =
    new DefaultCostEstimator(
      workflowContext = workflowContext,
      resourceAllocator = resourceAllocator,
      actorId = actorId
    )

  private case class CostEstimatorMemoKey(
      physicalOpIds: Set[PhysicalOpIdentity],
      physicalLinkIds: Set[PhysicalLink],
      portIds: Set[GlobalPortIdentity],
      resourceConfig: Option[ResourceConfig]
  )

  private val costEstimatorMemoization
      : mutable.Map[CostEstimatorMemoKey, (ResourceConfig, Double)] =
    new mutable.HashMap()

  // Cache analysis result, computed once and stored for use during region creation
  private var cacheAnalysisResult: Option[CacheAnalysisResult] = None

  /**
    * Analyze the physical plan for cache hits.
    * This computes cache keys for all output ports and looks up cached URIs.
    *
    * @return CacheAnalysisResult containing cached ports, links to materialize, and fully cached operators
    */
  private def analyzeCacheHits(): CacheAnalysisResult = {
    val cacheKeys = PortResultCache.computeAllCacheKeys(physicalPlan)
    val cachedOutputPorts = cacheKeys.flatMap {
      case (portId, cacheKey) =>
        PortResultCache.lookup(cacheKey).map(uri => portId -> uri)
    }

    // Find links whose output ports have cache hits
    // These links should be treated as materialized
    val linksToMaterialize = physicalPlan.links.filter { link =>
      val outputPortId = GlobalPortIdentity(link.fromOpId, link.fromPortId)
      cachedOutputPorts.contains(outputPortId)
    }

    // Find operators that are fully cached (all output ports are cached)
    // These operators can be completely skipped during execution
    val fullyCachedOperators: Set[PhysicalOpIdentity] = physicalPlan.operators
      .filter { op =>
        val outputPortIds = op.outputPorts.keys.map(portId => GlobalPortIdentity(op.id, portId))
        // An operator is fully cached if:
        // 1. It has at least one output port, AND
        // 2. All of its output ports are cached
        outputPortIds.nonEmpty && outputPortIds.forall(cachedOutputPorts.contains)
      }
      .map(_.id)
      .toSet

    // Find cached output ports that need to be displayed (view result ports)
    // These cached URIs need to be registered with WorkflowExecutionsResource
    val outputPortsNeedingStorage = workflowContext.workflowSettings.outputPortsNeedingStorage
    val cachedViewResultPorts: Map[GlobalPortIdentity, URI] = cachedOutputPorts.filter {
      case (portId, _) => outputPortsNeedingStorage.contains(portId)
    }

    if (cachedOutputPorts.nonEmpty) {
      logger.info(
        s"WID: ${workflowContext.workflowId.id}, EID: ${workflowContext.executionId.id}, " +
          s"cache hits: ${cachedOutputPorts.size} output ports, ${linksToMaterialize.size} links to skip, " +
          s"${fullyCachedOperators.size} operators fully cached, ${cachedViewResultPorts.size} cached view-result ports"
      )
    }

    CacheAnalysisResult(
      cachedOutputPorts,
      linksToMaterialize,
      cacheKeys,
      fullyCachedOperators,
      cachedViewResultPorts
    )
  }

  /**
    * Get the cache keys computed during this schedule generation.
    * This is used by RegionExecutionCoordinator to store results after execution.
    *
    * @return Map of output port identities to their cache keys
    */
  def getCacheKeys: Map[GlobalPortIdentity, String] = {
    cacheAnalysisResult.map(_.cacheKeys).getOrElse(Map.empty)
  }

  /**
    * Get cached view-result ports that need to be registered with WorkflowExecutionsResource.
    *
    * @return Map of output port identities to their cached URIs
    */
  def getCachedViewResultPorts: Map[GlobalPortIdentity, URI] = {
    cacheAnalysisResult.map(_.cachedViewResultPorts).getOrElse(Map.empty)
  }

  /**
    * Get fully cached operators with their cached data (metrics and console messages URIs).
    * This is used by WorkflowScheduler to store cached operators for stats display.
    *
    * @return Map of operator ID to its cached data
    */
  def getFullyCachedOperatorsWithData: Map[PhysicalOpIdentity, CachedOperatorData] = {
    cacheAnalysisResult.map { analysis =>
      analysis.fullyCachedOperators.flatMap { opId =>
        val op = physicalPlan.getOperator(opId)

        // Compute operator cache key from output port cache keys
        val outputPortCacheKeys = op.outputPorts.keys.flatMap { portId =>
          val globalPortId = GlobalPortIdentity(opId, portId)
          analysis.cacheKeys.get(globalPortId)
        }.toSeq

        if (outputPortCacheKeys.nonEmpty) {
          val operatorCacheKey = PortResultCache.computeOperatorCacheKey(outputPortCacheKeys)

          // Look up cached operator data
          PortResultCache.lookupOperatorData(operatorCacheKey).map { cachedData =>
            opId -> cachedData
          }
        } else {
          None
        }
      }.toMap
    }.getOrElse(Map.empty)
  }

  def generate(): (Schedule, PhysicalPlan) = {
    // Analyze cache hits before schedule generation
    val analysisResult = analyzeCacheHits()
    cacheAnalysisResult = Some(analysisResult)

    // Store cache keys for this execution so RegionExecutionCoordinator can access them
    PortResultCache.storeCacheKeysForExecution(
      workflowContext.executionId,
      analysisResult.cacheKeys
    )

    val startTime = System.nanoTime()
    val regionDAG = createRegionDAG()
    val totalRPGTime = System.nanoTime() - startTime
    val regionPlan = RegionPlan(
      regions = regionDAG.iterator().asScala.toSet,
      regionLinks = regionDAG.edgeSet().asScala.toSet
    )
    val schedule = generateScheduleFromRegionPlan(regionPlan)
    logger.info(
      s"WID: ${workflowContext.workflowId.id}, EID: ${workflowContext.executionId.id}, total RPG time: " +
        s"${totalRPGTime / 1e6} ms."
    )
    (
      schedule,
      physicalPlan
    )
  }

  /**
    * Partitions a physical plan into Regions and assigns storage URIs in two passes.
    *
    * <p><strong>Overview</strong></p>
    * <ol>
    *   <li><strong>Region construction:</strong>
    *     Remove all materialized edges from the DAG and compute undirected connected
    *     components. The resulting “Region Graph” may contain directed cycles.</li>
    *   <li><strong>Pass 1 – Output URIs:</strong>
    *     For each Region, allocate storage URIs on every output port of materialized edges.</li>
    *   <li><strong>Pass 2 – Input URIs:</strong>
    *     Re-traverse the same Regions and attach reader URIs on input ports using
    *     the URIs created in Pass 1.</li>
    * </ol>
    *
    * <p><strong>Why two passes?</strong></p>
    * <ul>
    *   <li>Potential directed cycles in the Region Graph makes a topological
    *       traversal of regions inpossible.</li>
    *   <li>To ensure every output URI exists before its corresponding reader is assigned,
    *       and avoiding “reader before writer” holes, two passes are required.</li>
    * </ul>
    *
    * @param physicalPlan the original physical plan (without materializations)
    * @param matEdges     edges to be materialized (including blocking edges)
    * @return a set of `Region`s whose `ResourceConfig` contains only `URI`s for `PortConfig`s
    *         (`Partitioning` to be assigned later in `ResourceAllocator`; see `IntermediateInputPortConfig`.)
    */
  private def createRegions(
      physicalPlan: PhysicalPlan,
      matEdges: Set[PhysicalLink]
  ): Set[Region] = {

    // Get cached output ports from cache analysis
    val cachedOutputPorts: Map[GlobalPortIdentity, URI] =
      cacheAnalysisResult.map(_.cachedOutputPorts).getOrElse(Map.empty)

    // Include cached links in the materialization edges
    val cachedLinks: Set[PhysicalLink] =
      cacheAnalysisResult.map(_.linksToMaterialize).getOrElse(Set.empty)
    val allMatEdges = matEdges ++ cachedLinks

    // Get fully cached operators that should be skipped
    val fullyCachedOperators: Set[PhysicalOpIdentity] =
      cacheAnalysisResult.map(_.fullyCachedOperators).getOrElse(Set.empty)

    // Pass 0 – remove materialized edges and create connected components

    val matEdgesRemovedDAG: PhysicalPlan = allMatEdges.foldLeft(physicalPlan)(_.removeLink(_))

    val connectedComponents: Set[Graph[PhysicalOpIdentity, PhysicalLink]] =
      new BiconnectivityInspector[PhysicalOpIdentity, PhysicalLink](
        matEdgesRemovedDAG.dag
      ).getConnectedComponents.asScala.toSet

    // Pass 1 – build Regions only output-port storage URIs
    // Filter out fully cached operators from each region

    val regionsWithOnlyOutputPortURIs: Set[Region] = connectedComponents.zipWithIndex.flatMap {
      case (connectedSubDAG, idx) =>
        // Operators and intra‑region pipelined links
        // Exclude fully cached operators from the region

        val allOperatorsInComponent: Set[PhysicalOpIdentity] =
          connectedSubDAG.vertexSet().asScala.toSet
        val operators: Set[PhysicalOpIdentity] = allOperatorsInComponent.diff(fullyCachedOperators)

        // Skip this region if all operators are cached
        if (operators.isEmpty) {
          None
        } else {
          Some(
            createRegionFromOperators(
              operators,
              allOperatorsInComponent,
              physicalPlan,
              allMatEdges,
              cachedOutputPorts,
              idx
            )
          )
        }
    }

    // Collect writer‑side configs so we can look them up in Pass 2
    val allOutputPortConfigs: Map[GlobalPortIdentity, OutputPortConfig] =
      regionsWithOnlyOutputPortURIs
        .flatMap(_.resourceConfig) // Seq[ResourceConfig]
        .flatMap(_.portConfigs.collect { // PortConfig → OutputPortConfig
          case (id, cfg: OutputPortConfig) => id -> cfg
        })
        .toMap

    // Pass 2 – add input‑port storage configs (reader URIs)

    regionsWithOnlyOutputPortURIs.map { existingRegion =>
      addInputPortConfigs(existingRegion, allMatEdges, cachedOutputPorts, allOutputPortConfigs)
    }
  }

  /**
    * Creates a Region from a set of operators.
    * Helper method extracted from createRegions to handle region creation logic.
    */
  private def createRegionFromOperators(
      operators: Set[PhysicalOpIdentity],
      allOperatorsInComponent: Set[PhysicalOpIdentity],
      physicalPlan: PhysicalPlan,
      allMatEdges: Set[PhysicalLink],
      cachedOutputPorts: Map[GlobalPortIdentity, URI],
      regionIdx: Int
  ): Region = {
    val links: Set[PhysicalLink] = operators
      .flatMap { opId =>
        physicalPlan.getUpstreamPhysicalLinks(opId) ++
          physicalPlan.getDownstreamPhysicalLinks(opId)
      }
      .filter(link => operators.contains(link.fromOpId) && operators.contains(link.toOpId))
      .diff(allMatEdges) // keep only pipelined edges

    val physicalOps: Set[PhysicalOp] = operators.map(physicalPlan.getOperator)

    // Frontend-specified ports that need to be materialized (output ports of "eye-icon" physicalOps)
    val outputPortIdsToViewResult: Set[GlobalPortIdentity] =
      workflowContext.workflowSettings.outputPortsNeedingStorage
        .filter(pid => operators.contains(pid.opId))

    // Contains both frontend-specified and scheduler-decided ports that require materializations.
    // Exclude cached output ports - they already have data, no need to write
    val outputPortIdsNeedingStorage: Set[GlobalPortIdentity] =
      (allMatEdges
        .filter(e => operators.contains(e.fromOpId))
        .map(e => GlobalPortIdentity(e.fromOpId, e.fromPortId)) ++
        outputPortIdsToViewResult)
        .filterNot(cachedOutputPorts.contains) // Skip cached ports

    // Allocate an URI for each of these output ports (only non-cached ones)
    val outputPortConfigs: Map[GlobalPortIdentity, OutputPortConfig] =
      outputPortIdsNeedingStorage.map { gpid =>
        val outputWriterURI = createResultURI(
          workflowId = workflowContext.workflowId,
          executionId = workflowContext.executionId,
          globalPortId = gpid
        )
        gpid -> OutputPortConfig(outputWriterURI)
      }.toMap

    val resourceConfig = ResourceConfig(portConfigs = outputPortConfigs)

    // Enumerate all ports belonging to the Region
    val ports: Set[GlobalPortIdentity] = physicalOps.flatMap { op =>
      op.inputPorts.keys
        .map(inputPortId => GlobalPortIdentity(op.id, inputPortId, input = true))
        .toSet ++ op.outputPorts.keys
        .map(outputPortId => GlobalPortIdentity(op.id, outputPortId))
        .toSet
    }

    // Build the Region skeleton (no input‑port URIs yet)
    Region(
      id = RegionIdentity(regionIdx),
      physicalOps = physicalOps,
      physicalLinks = links,
      ports = ports,
      resourceConfig = Some(resourceConfig)
    )
  }

  /**
    * Adds input port configs to an existing region.
    * Helper method extracted from createRegions for Pass 2.
    */
  private def addInputPortConfigs(
      existingRegion: Region,
      allMatEdges: Set[PhysicalLink],
      cachedOutputPorts: Map[GlobalPortIdentity, URI],
      allOutputPortConfigs: Map[GlobalPortIdentity, OutputPortConfig]
  ): Region = {
    // MatEdges that originally connected to the input ports of this region.
    val relevantMatEdges: Set[PhysicalLink] = allMatEdges.filter { matEdge =>
      existingRegion.getOperators.exists(_.id == matEdge.toOpId)
    }

    // Assign storage URIs to input ports of each materialized edge
    val inputPortConfigs: Map[GlobalPortIdentity, IntermediateInputPortConfig] =
      relevantMatEdges
        .foldLeft(Map.empty[GlobalPortIdentity, List[URI]]) { (acc, link) =>
          val globalOutputPortId = GlobalPortIdentity(link.fromOpId, link.fromPortId)
          val globalInputPortId = GlobalPortIdentity(link.toOpId, link.toPortId, input = true)

          // First check if this output port is cached
          val inputReaderURI = cachedOutputPorts.get(globalOutputPortId) match {
            case Some(cachedUri) =>
              // Use cached URI
              cachedUri
            case None =>
              // Fall back to writer-side URI from Pass 1
              allOutputPortConfigs
                .getOrElse(
                  globalOutputPortId,
                  throw new IllegalStateException(
                    s"Materialization edge $link: attempting to assign a materialization " +
                      s"reader URI for input port $globalInputPortId when " +
                      s"the output port $globalOutputPortId has not been assigned a URI yet."
                  )
                )
                .storageURI
          }

          // Group all available URIs of this input port together
          acc.updated(
            globalInputPortId,
            acc.getOrElse(globalInputPortId, List.empty[URI]) :+ inputReaderURI
          )
        }
        .map {
          case (inputPortId, uris) =>
            inputPortId -> IntermediateInputPortConfig(uris)
        }

    val newResourceConfig: Option[ResourceConfig] = existingRegion.resourceConfig match {
      case Some(existingConfig) =>
        Some(ResourceConfig(portConfigs = existingConfig.portConfigs ++ inputPortConfigs))
      case None =>
        if (inputPortConfigs.nonEmpty) Some(ResourceConfig(portConfigs = inputPortConfigs))
        else None
    }

    existingRegion.copy(resourceConfig = newResourceConfig)
  }

  /**
    * Checks a plan for schedulability, and returns a region DAG if the plan is schedulable.
    *
    * @param matEdges Set of edges to materialize (including the original blocking edges).
    * @return If the plan is schedulable, a region DAG will be returned. Otherwise a DirectedPseudograph (with directed
    *         cycles) will be returned to indicate that the plan is unschedulable.
    */
  private def tryConnectRegionDAG(
      matEdges: Set[PhysicalLink]
  ): Either[DirectedAcyclicGraph[Region, RegionLink], DirectedPseudograph[Region, RegionLink]] = {
    val regionDAG = new DirectedAcyclicGraph[Region, RegionLink](classOf[RegionLink])
    val regionGraph = new DirectedPseudograph[Region, RegionLink](classOf[RegionLink])
    val opToRegionMap = new mutable.HashMap[PhysicalOpIdentity, Region]
    createRegions(physicalPlan, matEdges).foreach(region => {
      region.getOperators.foreach(op => opToRegionMap(op.id) = region)
      regionGraph.addVertex(region)
      regionDAG.addVertex(region)
    })
    var isAcyclic = true
    matEdges.foreach(matEdge => {
      // Skip matEdges where either endpoint is a fully cached operator (not in any region)
      val fromRegionOpt = opToRegionMap.get(matEdge.fromOpId)
      val toRegionOpt = opToRegionMap.get(matEdge.toOpId)

      (fromRegionOpt, toRegionOpt) match {
        case (Some(fromRegion), Some(toRegion)) =>
          regionGraph.addEdge(fromRegion, toRegion, RegionLink(fromRegion.id, toRegion.id))
          try {
            regionDAG.addEdge(fromRegion, toRegion, RegionLink(fromRegion.id, toRegion.id))
          } catch {
            case _: IllegalArgumentException =>
              isAcyclic = false
          }
        case _ =>
          // One or both operators are fully cached and excluded from regions
          // No region link needed - the downstream region will read from cache
          ()
      }
    })
    if (isAcyclic) Left(regionDAG)
    else Right(regionGraph)
  }

  /**
    * Performs a search to generate a region DAG.
    * Materializations are added only after the plan is determined to be schedulable.
    *
    * @return A region DAG.
    */
  private def createRegionDAG(): DirectedAcyclicGraph[Region, RegionLink] = {
    val searchResultFuture: Future[SearchResult] = Future {
      if (ApplicationConfig.useTopDownSearch)
        topDownSearch(globalSearch = ApplicationConfig.useGlobalSearch)
      else
        bottomUpSearch(globalSearch = ApplicationConfig.useGlobalSearch)
    }
    val searchResult = Try(
      Await.result(searchResultFuture, ApplicationConfig.searchTimeoutMilliseconds.milliseconds)
    ) match {
      case Failure(exception) =>
        exception match {
          case _: TimeoutException =>
            logger.warn(
              s"WID: ${workflowContext.workflowId.id}, EID: ${workflowContext.executionId.id}, search for region plan " +
                s"timed out, falling back to bottom-up greedy search.",
              exception
            )
            bottomUpSearch()
          case _ => throw new RuntimeException(exception)
        }

      case Success(result) =>
        result
    }
    logger.info(
      s"WID: ${workflowContext.workflowId.id}, EID: ${workflowContext.executionId.id}, search time: " +
        s"${searchResult.searchTimeNanoSeconds / 1e6} ms."
    )

    val regionDAG = searchResult.regionDAG
    regionDAG
  }

  /**
    * The core of the search algorithm. If the input physical plan is already schedulable, no search will be executed.
    * Otherwise, depending on the configuration, either a global search or a greedy search will be performed to find
    * an optimal plan. The search starts from a plan where all non-blocking edges are pipelined, and leads to a low-cost
    * schedulable plan by changing pipelined non-blocking edges to materialized. By default all pruning techniques
    * are enabled (chains, clean edges, and early stopping on schedulable states).
    *
    * @return A SearchResult containing the plan, the region DAG (without materializations added yet), the cost, the
    *         time to finish search, and the number of states explored.
    */
  def bottomUpSearch(
      globalSearch: Boolean = false,
      oChains: Boolean = true,
      oCleanEdges: Boolean = true,
      oEarlyStop: Boolean = true
  ): SearchResult = {
    val startTime = System.nanoTime()
    val originalNonBlockingEdges =
      if (oCleanEdges) {
        physicalPlan.getNonBridgeNonBlockingLinks
      } else {
        physicalPlan.links.diff(
          physicalPlan.getBlockingAndDependeeLinks
        )
      }
    // Queue to hold states to be explored, starting with the empty set
    val queue: mutable.Queue[Set[PhysicalLink]] = mutable.Queue(Set.empty[PhysicalLink])
    // Keep track of visited states to avoid revisiting
    val visited: mutable.Set[Set[PhysicalLink]] = mutable.Set.empty[Set[PhysicalLink]]
    // Used for the Early Stop optimization technique
    val schedulableStates: mutable.Set[Set[PhysicalLink]] = mutable.Set.empty[Set[PhysicalLink]]
    // Initialize the bestResult with an impossible high cost for comparison
    var bestResult: SearchResult = SearchResult(
      state = Set.empty,
      regionDAG = new DirectedAcyclicGraph[Region, RegionLink](classOf[RegionLink]),
      cost = Double.PositiveInfinity
    )

    while (queue.nonEmpty) {
      // A state is represented as a set of materialized non-blocking edges.
      val currentState = queue.dequeue()
      breakable {
        if (
          oEarlyStop && schedulableStates
            .exists(ancestorState => ancestorState.subsetOf(currentState))
        ) {
          // Early stop: stopping exploring states beyond a schedulable state since the cost will only increase.
          // A state X is a descendant of an ancestor state Y in the bottom-up search process if Y's set of materialized
          // edges is a subset of that of X's (since X is reachable from Y by adding more materialized edges.)
          break()
        }
        visited.add(currentState)
        tryConnectRegionDAG(
          physicalPlan.getBlockingAndDependeeLinks ++ currentState
        ) match {
          case Left(regionDAG) =>
            updateOptimumIfApplicable(regionDAG)
            addNeighborStatesToFrontier()
          case Right(_) =>
            addNeighborStatesToFrontier()
        }
      }

      /**
        * An internal method of bottom-up search that updates the current optimum if the examined state is schedulable
        * and has a lower cost.
        */
      def updateOptimumIfApplicable(regionDAG: DirectedAcyclicGraph[Region, RegionLink]): Unit = {
        if (oEarlyStop) schedulableStates.add(currentState)
        // Calculate the current state's cost and update the bestResult if it's lower
        val cost = allocateResourcesAndEvaluateCost(regionDAG)
        if (cost < bestResult.cost) {
          bestResult = SearchResult(currentState, regionDAG, cost)
        }
      }

      /**
        * An internal method of bottom-up search that performs state transitions (changing an pipelined edge to
        * materialized) to include the unvisited neighbor(s) of the current state in the frontier (i.e., the queue).
        * If using global search, all unvisited neighbors will be included. Otherwise in a greedy search, only the
        * neighbor with the lowest cost will be included.
        */
      def addNeighborStatesToFrontier(): Unit = {
        val allCurrentMaterializedEdges =
          currentState ++ physicalPlan.getBlockingAndDependeeLinks
        // Generate and enqueue all neighbour states that haven't been visited
        var candidateEdges = originalNonBlockingEdges
          .diff(currentState)
        if (oChains) {
          val edgesInChainWithMaterializedEdges = physicalPlan.maxChains
            .filter(chain => chain.intersect(allCurrentMaterializedEdges).nonEmpty)
            .flatten
          candidateEdges = candidateEdges.diff(
            edgesInChainWithMaterializedEdges
          ) // Edges in chain with blocking edges should not be materialized
        }

        val unvisitedNeighborStates = candidateEdges
          .map(edge => currentState + edge)
          .filter(neighborState =>
            !visited.contains(neighborState) && !queue.contains(neighborState)
          )

        val filteredNeighborStates = if (oEarlyStop) {
          // Any descendant state of a schedulable state is not worth exploring.
          unvisitedNeighborStates.filter(neighborState =>
            !schedulableStates.exists(ancestorState => ancestorState.subsetOf(neighborState))
          )
        } else {
          unvisitedNeighborStates
        }

        if (globalSearch) {
          // include all unvisited neighbors
          filteredNeighborStates.foreach(neighborState => queue.enqueue(neighborState))
        } else {
          // greedy search, only include an unvisited neighbor with the lowest cost
          if (filteredNeighborStates.nonEmpty) {
            val minCostNeighborState = filteredNeighborStates.minBy(neighborState =>
              tryConnectRegionDAG(
                physicalPlan.getBlockingAndDependeeLinks ++ neighborState
              ) match {
                case Left(regionDAG) =>
                  allocateResourcesAndEvaluateCost(regionDAG)
                case Right(_) =>
                  Double.MaxValue
              }
            )
            queue.enqueue(minCostNeighborState)
          }
        }
      }
    }

    val searchTime = System.nanoTime() - startTime
    bestResult.copy(
      searchTimeNanoSeconds = searchTime,
      numStatesExplored = visited.size
    )
  }

  /**
    * Another direction to perform the search. Depending on the configuration, either a global search or a greedy search
    * will be performed to find an optimal plan. The search starts from a plan where all edges are materialized, and
    * leads to a low-cost schedulable plan by changing materialized non-blocking edges to pipelined.
    * By default, all pruning techniques are enabled (chains, clean edges).
    *
    * @return A SearchResult containing the plan, the region DAG (without materializations added yet), the cost, the
    *         time to finish search, and the number of states explored.
    */
  def topDownSearch(
      globalSearch: Boolean = false,
      oChains: Boolean = true,
      oCleanEdges: Boolean = true
  ): SearchResult = {
    val startTime = System.nanoTime()
    // Starting from a state where all non-blocking edges are materialized
    val originalSeedState = physicalPlan.links.diff(
      physicalPlan.getBlockingAndDependeeLinks
    )

    // Chain optimization: an edge in the same chain as a blocking edge should not be materialized
    val seedStateOptimizedByChainsIfApplicable = if (oChains) {
      val edgesInChainWithBlockingEdge = physicalPlan.maxChains
        .filter(chain => chain.intersect(physicalPlan.getBlockingAndDependeeLinks).nonEmpty)
        .flatten
      originalSeedState.diff(edgesInChainWithBlockingEdge)
    } else {
      originalSeedState
    }

    // Clean edge optimization: a clean edge should not be materialized
    val finalSeedState = if (oCleanEdges) {
      seedStateOptimizedByChainsIfApplicable.intersect(physicalPlan.getNonBridgeNonBlockingLinks)
    } else {
      seedStateOptimizedByChainsIfApplicable
    }

    // Queue to hold states to be explored, starting with the seed state
    val queue: mutable.Queue[Set[PhysicalLink]] = mutable.Queue(finalSeedState)
    // Keep track of visited states to avoid revisiting
    val visited: mutable.Set[Set[PhysicalLink]] = mutable.Set.empty[Set[PhysicalLink]]
    // Initialize the bestResult with an impossible high cost for comparison
    var bestResult: SearchResult = SearchResult(
      state = Set.empty,
      regionDAG = new DirectedAcyclicGraph[Region, RegionLink](classOf[RegionLink]),
      cost = Double.PositiveInfinity
    )

    while (queue.nonEmpty) {
      val currentState = queue.dequeue()
      visited.add(currentState)
      tryConnectRegionDAG(
        physicalPlan.getBlockingAndDependeeLinks ++ currentState
      ) match {
        case Left(regionDAG) =>
          updateOptimumIfApplicable(regionDAG)
          addNeighborStatesToFrontier()
        // No need to explore further
        case Right(_) =>
          addNeighborStatesToFrontier()
      }

      /**
        * An internal method of top-down search that updates the current optimum if the examined state is schedulable
        * and has a lower cost.
        */
      def updateOptimumIfApplicable(regionDAG: DirectedAcyclicGraph[Region, RegionLink]): Unit = {
        // Calculate the current state's cost and update the bestResult if it's lower
        val cost = allocateResourcesAndEvaluateCost(regionDAG)
        if (cost < bestResult.cost) {
          bestResult = SearchResult(currentState, regionDAG, cost)
        }
      }

      /**
        * An internal method of top-down search that performs state transitions (changing an materialized edge to
        * pipelined) to include the unvisited neighbor(s) of the current state in the frontier (i.e., the queue).
        * If using global search, all unvisited neighbors will be included. Otherwise in a greedy search, only the
        * neighbor with the lowest cost will be included.
        */
      def addNeighborStatesToFrontier(): Unit = {
        val unvisitedNeighborStates = currentState
          .map(edge => currentState - edge)
          .filter(neighborState =>
            !visited.contains(neighborState) && !queue.contains(neighborState)
          )

        if (globalSearch) {
          // include all unvisited neighbors
          unvisitedNeighborStates.foreach(neighborState => queue.enqueue(neighborState))
        } else {
          // greedy search, only include an unvisited neighbor with the lowest cost
          if (unvisitedNeighborStates.nonEmpty) {
            val minCostNeighborState = unvisitedNeighborStates.minBy(neighborState =>
              tryConnectRegionDAG(
                physicalPlan.getBlockingAndDependeeLinks ++ neighborState
              ) match {
                case Left(regionDAG) =>
                  allocateResourcesAndEvaluateCost(regionDAG)
                case Right(_) =>
                  Double.MaxValue
              }
            )
            queue.enqueue(minCostNeighborState)
          }
        }
      }
    }

    val searchTime = System.nanoTime() - startTime
    bestResult.copy(
      searchTimeNanoSeconds = searchTime,
      numStatesExplored = visited.size
    )
  }

  /**
    * Takes a region DAG, generates one or more (to be done in the future) schedules based on the region DAG, allocates
    * resources to each region in the region DAG, and calculates the cost of the schedule(s) using Cost Estimator. Uses
    * the cost of the best schedule (currently only considers one schedule) as the cost of the region DAG.
    *
    * @return A cost determined by the cost estimator.
    */
  private def allocateResourcesAndEvaluateCost(
      regionDAG: DirectedAcyclicGraph[Region, RegionLink]
  ): Double = {
    val regionPlan =
      RegionPlan(regionDAG.vertexSet().asScala.toSet, regionDAG.edgeSet().asScala.toSet)
    val schedule = generateScheduleFromRegionPlan(regionPlan)
    // In the future we may allow multiple regions in a level and split the resources.
    schedule
      .map(level =>
        level
          .map(region => {
            val costEstimatorMemoKey = CostEstimatorMemoKey(
              physicalOpIds = region.physicalOps.map(_.id),
              physicalLinkIds = region.physicalLinks,
              portIds = region.ports,
              resourceConfig = region.resourceConfig
            )
            val (resourceConfig, regionCost) = costEstimatorMemoization
              .getOrElseUpdate(
                costEstimatorMemoKey,
                costEstimator.allocateResourcesAndEstimateCost(region, 1)
              )
            // Update the region in the regionDAG to be the new region with resources allocated.
            val regionWithResourceConfig = region.copy(resourceConfig = Some(resourceConfig))
            replaceVertex(regionDAG, region, regionWithResourceConfig)
            regionCost
          })
          .sum
      )
      .sum
  }

}
