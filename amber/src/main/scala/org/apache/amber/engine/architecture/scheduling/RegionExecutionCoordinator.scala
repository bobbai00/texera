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

import org.apache.pekko.pattern.gracefulStop
import com.twitter.util.{Future, Return, Throw}
import org.apache.amber.core.storage.{DocumentFactory, VFSURIFactory}
import org.apache.amber.core.storage.VFSURIFactory.decodeURI
import org.apache.amber.core.virtualidentity.{ActorVirtualIdentity, OperatorIdentity}
import org.apache.amber.core.workflow.{GlobalPortIdentity, PhysicalLink, PhysicalOp, PortIdentity}
import org.apache.amber.engine.architecture.common.{
  AkkaActorRefMappingService,
  AkkaActorService,
  ExecutorDeployment
}
import org.apache.amber.engine.architecture.controller.execution.{
  OperatorExecution,
  RegionExecution,
  WorkflowExecution
}
import org.apache.amber.engine.architecture.controller.{
  ControllerConfig,
  ExecutionStatsUpdate,
  WorkerAssignmentUpdate
}
import org.apache.amber.engine.architecture.rpc.controlcommands._
import org.apache.amber.engine.architecture.rpc.controlreturns.EmptyReturn
import org.apache.amber.engine.architecture.scheduling.config.{
  InputPortConfig,
  OperatorConfig,
  OutputPortConfig,
  ResourceConfig
}
import org.apache.amber.engine.architecture.sendsemantics.partitionings.Partitioning
import org.apache.amber.engine.architecture.worker.statistics.WorkerState
import org.apache.amber.engine.common.AmberLogging
import org.apache.amber.engine.common.FutureBijection._
import org.apache.amber.engine.common.rpc.AsyncRPCClient
import org.apache.amber.engine.common.virtualidentity.util.CONTROLLER
import org.apache.texera.web.SessionState
import org.apache.texera.web.model.websocket.event.RegionStateEvent
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import scala.concurrent.duration.Duration

/**
  * The executor of a region.
  *
  * We currently use a two-phase execution scheme to handle input-port dependency relationships. This is based on these
  * assumptions:
  *
  *  - We only allow input port dependencies where the input ports of a region can be grouped as two layers, with one
  *    layer of “dependee” ports and another layer of “depender” ports. We do not allow the case where an input port
  *    can both be a dependee and a depender.
  *  - We only allow depender ports to send data to output ports. Depenee input ports cannot send data to output ports.
  *  - All the physical operators must have output ports so that we can use the existence of output ports to decide
  *    whether to `FinalizeExecutor()` for a worker. (See `OutputManager.finalizeOutput()`)
  *
  * Under these assumptions, we can `syncStatusAndTransitionRegionExecutionPhase` for a region in this sequence:
  *
  * 0. `Unexecuted`
  *
  * 1. `ExecutingDependeePortsPhase`: All the dependee input ports are executed first until they complete.
  *    The corresponding workers of those input ports are also started in this phase. No output ports are allowed. If no
  *    dependee ports exist in a region, this first phase will be skipped.
  *
  * 2. `ExecutingNonDependeePortsPhase`: All other ports (non-dependee input ports, output ports) and
  *    their workers are executed. Region completion is indicated by the completion of all the ports when in this phase.
  *
  * 3. `Completed`
  */
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}

class RegionExecutionCoordinator(
    region: Region,
    workflowExecution: WorkflowExecution,
    asyncRPCClient: AsyncRPCClient,
    controllerConfig: ControllerConfig,
    actorService: AkkaActorService,
    actorRefService: AkkaActorRefMappingService,
    workflowId: WorkflowIdentity,
    executionId: ExecutionIdentity
) extends AmberLogging {

  initRegionExecution()

  private sealed trait RegionExecutionPhase
  private case object Unexecuted extends RegionExecutionPhase
  private case object ExecutingDependeePortsPhase extends RegionExecutionPhase
  private case object ExecutingNonDependeePortsPhase extends RegionExecutionPhase
  private case object Completed extends RegionExecutionPhase

  private val currentPhaseRef: AtomicReference[RegionExecutionPhase] = new AtomicReference(
    Unexecuted
  )

  // Track whether output port storage objects have been created to avoid duplicate creation
  private var outputStorageCreated: Boolean = false

  /**
    * Sync the status of `RegionExecution` and transition this coordinator's phase to `Completed` only when the
    * coordinator is currently in `ExecutingNonDependeePortsPhase` and all the ports of this region are completed.
    *
    * Additionally, this method will also terminate all the workers of this region:
    *
    * 1.  An `EndWorker` control message is first sent to all the workers. This will be the last message each worker
    * receives. We wait for all workers have replied to indicate they have finished processing all control messages.
    *
    * 2. Only after all workers have processed all control messages do we send a `gracefulStop` (pekko message) to each
    * worker. JVM workers will be terminated by `gracefulStop`. Python proxy workes will also be terminated by
    * `gracefulStop`, whose termination logic will also kill the PVMs.
    */
  private def tryCompleteRegionExecution(): Future[Unit] = {
    // Only `ExecutingNonDependeePortsPhase` can transition to `Completed`
    if (currentPhaseRef.get != ExecutingNonDependeePortsPhase) {
      return Future.Unit
    }

    // Sync the status with RegionExecution
    val regionExecution = workflowExecution.getRegionExecution(region.id)
    if (!regionExecution.isCompleted) {
      return Future.Unit
    }

    // Set this coordinator's status to be completed so that subsequent regions can be started by
    // WorkflowExecutionCoordinator.
    setPhase(Completed)

    // Store output port results in the cache for future reuse
    cacheOutputResults()

    // Terminate all the workers in this region.
    terminateWorkers(regionExecution)
  }

  /**
    * Store the output port results from this region in the cache.
    * This enables result reuse in future executions.
    * Also caches operator metrics (tuple counts) and console messages URIs.
    */
  private def cacheOutputResults(): Unit = {
    region.resourceConfig.foreach { resourceConfig =>
      // First, store output port URIs in the cache
      resourceConfig.portConfigs.foreach {
        case (globalPortId, outputConfig: OutputPortConfig) if !globalPortId.input =>
          // Look up the cache key for this output port
          PortResultCache.getCacheKeyForPort(executionId, globalPortId).foreach { cacheKey =>
            // Store the URI in the cache
            PortResultCache.store(cacheKey, outputConfig.storageURI)
          }
        case _ => // Skip input port configs
      }

      // Now, cache operator metrics and console messages URIs
      cacheOperatorData(resourceConfig)
    }
  }

  /**
    * Cache operator data including metrics and console messages URIs for each operator.
    * This is used to display stats for cached operators in future executions.
    */
  private def cacheOperatorData(resourceConfig: ResourceConfig): Unit = {
    val regionExecution = workflowExecution.getRegionExecution(region.id)

    region.getOperators.foreach { physicalOp =>
      val opId = physicalOp.id
      val operatorExecution = regionExecution.getOperatorExecution(opId)

      // Collect output port cache keys for this operator
      val outputPortCacheKeys = physicalOp.outputPorts.keys.flatMap { portId =>
        val globalPortId = GlobalPortIdentity(opId, portId)
        PortResultCache.getCacheKeyForPort(executionId, globalPortId)
      }.toSeq

      if (outputPortCacheKeys.nonEmpty) {
        // Compute operator cache key from output port keys
        val operatorCacheKey = PortResultCache.computeOperatorCacheKey(outputPortCacheKeys)

        // Collect output port metrics from storage
        val outputPortMetrics: Map[PortIdentity, CachedPortMetrics] =
          physicalOp.outputPorts.keys.flatMap { portId =>
            val globalPortId = GlobalPortIdentity(opId, portId)
            resourceConfig.portConfigs.get(globalPortId) match {
              case Some(outputConfig: OutputPortConfig) =>
                val tupleCount = getTupleCountFromStorage(outputConfig.storageURI)
                val columnCount = getColumnCountFromStorage(outputConfig.storageURI)
                Some(portId -> CachedPortMetrics(tupleCount, columnCount))
              case _ => None
            }
          }.toMap

        // Collect input port metrics by aggregating worker statistics
        val inputPortMetrics: Map[PortIdentity, CachedPortMetrics] =
          physicalOp.inputPorts.keys.map { portId =>
            val totalCount = operatorExecution.getWorkerIds.map { workerId =>
              val workerExec = operatorExecution.getWorkerExecution(workerId)
              workerExec.getStats.inputTupleMetrics
                .find(_.portId == portId)
                .map(_.tupleMetrics.count)
                .getOrElse(0L)
            }.sum
            // Read column count from the input port's storage URI (upstream output data)
            val globalInputPortId = GlobalPortIdentity(opId, portId, input = true)
            val columnCount = resourceConfig.portConfigs.get(globalInputPortId) match {
              case Some(cfg: InputPortConfig) =>
                cfg.storagePairs.headOption
                  .map(pair => getColumnCountFromStorage(pair._1))
                  .getOrElse(0)
              case _ =>
                // Fallback to worker stats
                operatorExecution.getWorkerIds.flatMap { workerId =>
                  val workerExec = operatorExecution.getWorkerExecution(workerId)
                  workerExec.getStats.inputTupleMetrics
                    .find(_.portId == portId)
                    .map(_.tupleMetrics.columnCount)
                }.maxOption.getOrElse(0)
            }
            portId -> CachedPortMetrics(totalCount, columnCount)
          }.toMap

        // Get console messages URI for this operator
        val consoleMessagesUri = Some(
          VFSURIFactory.createConsoleMessagesURI(
            workflowId,
            executionId,
            OperatorIdentity(opId.logicalOpId.id)
          )
        )

        // Store the cached operator data
        val cachedData = CachedOperatorData(
          inputPortMetrics = inputPortMetrics,
          outputPortMetrics = outputPortMetrics,
          consoleMessagesUri = consoleMessagesUri
        )
        PortResultCache.storeOperatorData(operatorCacheKey, cachedData)
      }
    }
  }

  /**
    * Get the tuple count from a storage URI by opening the document and counting.
    */
  private def getTupleCountFromStorage(uri: java.net.URI): Long = {
    try {
      val (document, _) = DocumentFactory.openDocument(uri)
      document.getCount
    } catch {
      case e: Exception =>
        logger.warn(s"Failed to get tuple count from $uri: ${e.getMessage}")
        0L
    }
  }

  /**
    * Get the column count from a storage URI by opening the document and reading its schema.
    */
  private def getColumnCountFromStorage(uri: java.net.URI): Int = {
    try {
      val (_, schemaOpt) = DocumentFactory.openDocument(uri)
      schemaOpt.map(_.getAttributes.size).getOrElse(0)
    } catch {
      case e: Exception =>
        logger.warn(s"Failed to get column count from $uri: ${e.getMessage}")
        0
    }
  }

  private def terminateWorkers(regionExecution: RegionExecution) = {
    // 1. Send EndWorkers to every worker
    val endWorkerRequests =
      regionExecution.getAllOperatorExecutions.flatMap {
        case (_, opExec) =>
          opExec.getWorkerIds.map { workerId =>
            asyncRPCClient.workerInterface
              .endWorker(EmptyRequest(), asyncRPCClient.mkContext(workerId))
          }
      }.toSeq

    val endWorkerFuture: Future[Unit] =
      Future.collect(endWorkerRequests).unit

    // 2. Send GracefulStops only after 1 has finished
    val gracefulStopRequests: Future[Unit] =
      endWorkerFuture.flatMap { _ =>
        val gracefulStops =
          regionExecution.getAllOperatorExecutions.flatMap {
            case (_, opExec) =>
              opExec.getWorkerIds.map { workerId =>
                val actorRef = actorRefService.getActorRef(workerId)
                // Remove the actorRef so that no other actors can find the worker and send messages.
                actorRefService.removeActorRef(workerId)
                gracefulStop(actorRef, Duration(5, TimeUnit.SECONDS)).asTwitter()
              }
          }.toSeq

        Future.collect(gracefulStops).unit
      }

    // 3. Log whether the kills were successful
    gracefulStopRequests.transform {
      case Return(_) =>
        logger.info(s"Region ${region.id.id} successfully terminated.")
        regionExecution.getAllOperatorExecutions.foreach {
          case (_, opExec) =>
            opExec.getWorkerIds.foreach { workerId =>
              opExec.getWorkerExecution(workerId).update(System.nanoTime(), WorkerState.TERMINATED)
            }
        }
        Future.Unit // propagate success
      case Throw(err) =>
        logger.warn(s"Error when terminating region ${region.id}.")
        Future.exception(err) // propagate failure
    }
  }

  def isCompleted: Boolean = currentPhaseRef.get == Completed

  /**
    * This will sync and transition the region execution phase from one to another depending on its current phase:
    *
    * `Unexecuted` -> `ExecutingDependeePortsPhase` -> `ExecutingNonDependeePortsPhase` -> `Completed`
    */
  def syncStatusAndTransitionRegionExecutionPhase(): Future[Unit] =
    currentPhaseRef.get match {
      case Unexecuted =>
        executeDependeePortPhase()
      case ExecutingDependeePortsPhase =>
        val regionExecution = workflowExecution.getRegionExecution(region.id)
        if (
          region.getOperators.forall { op =>
            val operatorExecution = regionExecution.getOperatorExecution(op.id)
            op.dependeeInputs.forall { dependeePortId =>
              operatorExecution.isInputPortCompleted(dependeePortId)
            }
          }
        ) {
          // All dependee ports are completed. Can proceed with the next phase.
          executeNonDependeePortPhase()
        } else {
          // Some dependee ports are still executing. Continue with this phase.
          Future.Unit
        }
      case ExecutingNonDependeePortsPhase =>
        tryCompleteRegionExecution()
      case Completed =>
        // Already completed, no further action needed.
        Future.Unit
    }

  private def executeDependeePortPhase(): Future[Unit] = {
    setPhase(ExecutingDependeePortsPhase)
    if (!region.getOperators.exists(_.dependeeInputs.nonEmpty)) {
      // Skip to the next phase when there are no dependee input ports
      return syncStatusAndTransitionRegionExecutionPhase()
    }
    val ops = region.getOperators.filter(_.dependeeInputs.nonEmpty)

    // Check if all inputs for operators with dependee ports come from materialized storage.
    // If so, assign ALL ports (not just dependee ports) so the worker knows about all ports
    // before it starts. This is necessary because when reading from materialization,
    // the worker needs to know about all input ports upfront to properly trigger on_finish
    // for each port in the correct order.
    val allInputsFromMaterialization = ops.forall { op =>
      op.inputPorts.keys.forall { portId =>
        val globalPortId = GlobalPortIdentity(op.id, portId, input = true)
        region.resourceConfig.exists { config =>
          config.portConfigs.get(globalPortId) match {
            case Some(cfg: InputPortConfig) => cfg.storagePairs.nonEmpty
            case _                          => false
          }
        }
      }
    }

    if (allInputsFromMaterialization) {
      // When all inputs are from materialization, the worker will process all inputs in Phase 1
      // and produce output before Phase 2 starts. So we need to:
      // 1. Create output port storage objects now
      // 2. Assign ALL ports (input and output) so the worker can process and produce output
      val outputPortConfigs = region.resourceConfig.get.portConfigs.collect {
        case (id, cfg: OutputPortConfig) => id -> cfg
      }
      createOutputPortStorageObjects(outputPortConfigs)

      launchPhaseExecutionInternal(
        ops,
        () => assignAllPortsIncludingOutput(region, ops),
        () => connectChannels(region.getLinks),
        () => sendStarts(region, isDependeePhase = true)
      )
    } else {
      launchPhaseExecutionInternal(
        ops,
        () => assignPorts(region, isDependeePhase = true),
        () => Future.value(Seq.empty),
        () => sendStarts(region, isDependeePhase = true)
      )
    }
  }

  private def executeNonDependeePortPhase(): Future[Unit] = {
    setPhase(ExecutingNonDependeePortsPhase)
    // Allocate output port storage objects (if not already created in executeDependeePortPhase)
    val outputPortConfigs = region.resourceConfig.get.portConfigs.collect {
      case (id, cfg: OutputPortConfig) => id -> cfg
    }
    createOutputPortStorageObjects(outputPortConfigs)

    val ops = region.getOperators.filter(_.dependeeInputs.isEmpty)

    launchPhaseExecutionInternal(
      ops,
      () => assignPorts(region, isDependeePhase = false),
      () => connectChannels(region.getLinks),
      () => sendStarts(region, isDependeePhase = false)
    )
  }

  /**
    * Unified logic for launching either of the two phases asynchronously.
    */
  private def launchPhaseExecutionInternal(
      operatorsToRun: Set[PhysicalOp],
      assignPortsLogic: () => Future[Seq[EmptyReturn]],
      connectChannelsLogic: () => Future[Seq[EmptyReturn]],
      startWorkersLogic: () => Future[Seq[Unit]]
  ): Future[Unit] = {

    val resourceConfig = region.resourceConfig.get
    val regionExecution = workflowExecution.getRegionExecution(region.id)

    asyncRPCClient.sendToClient(
      ExecutionStatsUpdate(workflowExecution.getAllRegionExecutionsStats)
    )
    asyncRPCClient.sendToClient(
      WorkerAssignmentUpdate(
        operatorsToRun
          .map(_.id)
          .map { pid =>
            pid.logicalOpId.id -> regionExecution
              .getOperatorExecution(pid)
              .getWorkerIds
              .map(_.name)
              .toList
          }
          .toMap
      )
    )
    Future(())
      .flatMap(_ => initExecutors(operatorsToRun, resourceConfig))
      .flatMap(_ => assignPortsLogic())
      .flatMap(_ => connectChannelsLogic())
      .flatMap(_ => openOperators(operatorsToRun))
      .flatMap(_ => startWorkersLogic())
      .unit
  }

  /**
    * Initialize the execution states of all the operators in the region, and also create workers for each operator.
    */
  private def initRegionExecution(): Unit = {
    val resourceConfig = region.resourceConfig.get
    val regionExecution = workflowExecution.getRegionExecution(region.id)

    region.getOperators.foreach { physicalOp =>
      val existOpExecution =
        workflowExecution.getAllRegionExecutions.exists(_.hasOperatorExecution(physicalOp.id))

      val operatorExecution = regionExecution.initOperatorExecution(
        physicalOp.id,
        if (existOpExecution)
          Some(workflowExecution.getLatestOperatorExecution(physicalOp.id))
        else
          None
      )

      if (!existOpExecution) {
        buildOperator(
          actorService,
          physicalOp,
          resourceConfig.operatorConfigs(physicalOp.id),
          operatorExecution
        )
      }
    }
  }

  private def buildOperator(
      actorService: AkkaActorService,
      physicalOp: PhysicalOp,
      operatorConfig: OperatorConfig,
      operatorExecution: OperatorExecution
  ): Unit = {
    ExecutorDeployment.createWorkers(
      physicalOp,
      actorService,
      operatorExecution,
      operatorConfig,
      controllerConfig.stateRestoreConfOpt,
      controllerConfig.faultToleranceConfOpt
    )
  }

  private def initExecutors(
      operators: Set[PhysicalOp],
      resourceConfig: ResourceConfig
  ): Future[Seq[EmptyReturn]] = {
    Future
      .collect(
        operators
          .flatMap(physicalOp => {
            val workerConfigs = resourceConfig.operatorConfigs(physicalOp.id).workerConfigs
            workerConfigs.map(_.workerId).map { workerId =>
              asyncRPCClient.workerInterface.initializeExecutor(
                InitializeExecutorRequest(
                  workerConfigs.length,
                  physicalOp.opExecInitInfo,
                  physicalOp.isSourceOperator
                ),
                asyncRPCClient.mkContext(workerId)
              )
            }
          })
          .toSeq
      )
  }

  private def assignPorts(
      region: Region,
      isDependeePhase: Boolean
  ): Future[Seq[EmptyReturn]] = {
    val resourceConfig = region.resourceConfig.get
    Future.collect(
      region.getOperators
        .flatMap { physicalOp: PhysicalOp =>
          // assign input ports
          val inputPortMapping = physicalOp.inputPorts
            .filter {
              case (portId, _) =>
                // keep only the ports that belong to the requested phase
                isDependeePhase == physicalOp.dependeeInputs.contains(portId)
            }
            .flatMap {
              case (inputPortId, (_, _, Right(schema))) =>
                val globalInputPortId = GlobalPortIdentity(physicalOp.id, inputPortId, input = true)
                val (storageURIs, partitionings) =
                  resourceConfig.portConfigs.get(globalInputPortId) match {
                    case Some(cfg: InputPortConfig) =>
                      (cfg.storagePairs.map(_._1.toString), cfg.storagePairs.map(_._2))
                    case _ => (List.empty[String], List.empty[Partitioning])
                  }
                Some(globalInputPortId -> (storageURIs, partitionings, schema))
              case _ => None
            }

          // Currently an output port uses the same AssignPortRequest as an Input port.
          // However, an output port does not need a list of URIs or partitionings.
          // TODO: Separate AssignPortRequest for Input and Output Ports

          // assign output ports (only for non-dependee phase)
          val outputPortMapping =
            if (isDependeePhase) {
              Iterable.empty
            } else {
              physicalOp.outputPorts
                .filter {
                  case (outputPortId, _) =>
                    val globalInputPortId = GlobalPortIdentity(physicalOp.id, outputPortId)
                    region.getPorts.contains(globalInputPortId)
                }
                .flatMap {
                  case (outputPortId, (_, _, Right(schema))) =>
                    val storageURI = resourceConfig.portConfigs
                      .collectFirst {
                        case (gid, cfg: OutputPortConfig)
                            if gid == GlobalPortIdentity(
                              opId = physicalOp.id,
                              portId = outputPortId
                            ) =>
                          cfg.storageURI.toString
                      }
                      .getOrElse("")
                    Some(
                      GlobalPortIdentity(physicalOp.id, outputPortId) -> (List(
                        storageURI
                      ), List.empty, schema)
                    )
                  case _ => None
                }
            }

          inputPortMapping ++ outputPortMapping
        }
        // Issue AssignPort control messages to each worker.
        .flatMap {
          case (globalPortId, (storageUris, partitionings, schema)) =>
            resourceConfig.operatorConfigs(globalPortId.opId).workerConfigs.map(_.workerId).map {
              workerId =>
                asyncRPCClient.workerInterface.assignPort(
                  AssignPortRequest(
                    globalPortId.portId,
                    globalPortId.input,
                    schema.toRawSchema,
                    storageUris,
                    partitionings
                  ),
                  asyncRPCClient.mkContext(workerId)
                )
            }
        }
        .toSeq
    )
  }

  /**
    * Assign ALL ports (input AND output) for the specified operators.
    * This is used when all inputs come from materialized storage, allowing the worker to know
    * about all ports before it starts processing and produce output in the same phase.
    */
  private def assignAllPortsIncludingOutput(
      region: Region,
      operators: Set[PhysicalOp]
  ): Future[Seq[EmptyReturn]] = {
    val resourceConfig = region.resourceConfig.get
    Future.collect(
      operators
        .flatMap { physicalOp: PhysicalOp =>
          // assign ALL input ports (not filtered by phase)
          val inputPortMapping = physicalOp.inputPorts
            .flatMap {
              case (inputPortId, (_, _, Right(schema))) =>
                val globalInputPortId = GlobalPortIdentity(physicalOp.id, inputPortId, input = true)
                val (storageURIs, partitionings) =
                  resourceConfig.portConfigs.get(globalInputPortId) match {
                    case Some(cfg: InputPortConfig) =>
                      (cfg.storagePairs.map(_._1.toString), cfg.storagePairs.map(_._2))
                    case _ => (List.empty[String], List.empty[Partitioning])
                  }
                Some(globalInputPortId -> (storageURIs, partitionings, schema))
              case _ => None
            }

          // assign ALL output ports
          val outputPortMapping = physicalOp.outputPorts
            .filter {
              case (outputPortId, _) =>
                val globalOutputPortId = GlobalPortIdentity(physicalOp.id, outputPortId)
                region.getPorts.contains(globalOutputPortId)
            }
            .flatMap {
              case (outputPortId, (_, _, Right(schema))) =>
                val storageURI = resourceConfig.portConfigs
                  .collectFirst {
                    case (gid, cfg: OutputPortConfig)
                        if gid == GlobalPortIdentity(
                          opId = physicalOp.id,
                          portId = outputPortId
                        ) =>
                      cfg.storageURI.toString
                  }
                  .getOrElse("")
                Some(
                  GlobalPortIdentity(physicalOp.id, outputPortId) -> (List(
                    storageURI
                  ), List.empty[Partitioning], schema)
                )
              case _ => None
            }

          inputPortMapping ++ outputPortMapping
        }
        // Issue AssignPort control messages to each worker.
        .flatMap {
          case (globalPortId, (storageUris, partitionings, schema)) =>
            resourceConfig.operatorConfigs(globalPortId.opId).workerConfigs.map(_.workerId).map {
              workerId =>
                asyncRPCClient.workerInterface.assignPort(
                  AssignPortRequest(
                    globalPortId.portId,
                    globalPortId.input,
                    schema.toRawSchema,
                    storageUris,
                    partitionings
                  ),
                  asyncRPCClient.mkContext(workerId)
                )
            }
        }
        .toSeq
    )
  }

  private def connectChannels(links: Set[PhysicalLink]): Future[Seq[EmptyReturn]] = {
    Future.collect(
      links.map { link: PhysicalLink =>
        asyncRPCClient.controllerInterface.linkWorkers(
          LinkWorkersRequest(link),
          asyncRPCClient.mkContext(CONTROLLER)
        )
      }.toSeq
    )
  }

  private def openOperators(operators: Set[PhysicalOp]): Future[Seq[EmptyReturn]] = {
    Future
      .collect(
        operators
          .map(_.id)
          .flatMap(opId =>
            workflowExecution.getRegionExecution(region.id).getOperatorExecution(opId).getWorkerIds
          )
          .map { workerId =>
            asyncRPCClient.workerInterface
              .openExecutor(EmptyRequest(), asyncRPCClient.mkContext(workerId))
          }
          .toSeq
      )
  }

  private def sendStarts(
      region: Region,
      isDependeePhase: Boolean
  ): Future[Seq[Unit]] = {
    asyncRPCClient.sendToClient(
      ExecutionStatsUpdate(
        workflowExecution.getAllRegionExecutionsStats
      )
    )
    val allStarterOperators = region.getStarterOperators
    val starterOpsForThisPhase =
      if (isDependeePhase) allStarterOperators.filter(_.dependeeInputs.nonEmpty)
      else allStarterOperators
    Future.collect(
      starterOpsForThisPhase
        .map(_.id)
        .flatMap { opId =>
          workflowExecution
            .getRegionExecution(region.id)
            .getOperatorExecution(opId)
            .getWorkerIds
            .map { workerId =>
              asyncRPCClient.workerInterface
                .startWorker(EmptyRequest(), asyncRPCClient.mkContext(workerId))
                .map(resp =>
                  // update worker state
                  workflowExecution
                    .getRegionExecution(region.id)
                    .getOperatorExecution(opId)
                    .getWorkerExecution(workerId)
                    .update(System.nanoTime(), resp.state)
                )
            }
        }
        .toSeq
    )
  }

  private def createOutputPortStorageObjects(
      portConfigs: Map[GlobalPortIdentity, OutputPortConfig]
  ): Unit = {
    // Skip if output storage has already been created (e.g., in executeDependeePortPhase)
    if (outputStorageCreated) {
      return
    }
    outputStorageCreated = true

    portConfigs.foreach {
      case (outputPortId, portConfig) =>
        val storageUriToAdd = portConfig.storageURI
        val (_, eid, _, _) = decodeURI(storageUriToAdd)
        val schemaEither =
          region.getOperator(outputPortId.opId).outputPorts(outputPortId.portId)._3
        val schema = schemaEither match {
          case Right(s) =>
            if (s == null) {
              throw new IllegalStateException(
                s"Schema is null for operator ${outputPortId.opId} port ${outputPortId.portId}. " +
                  "This usually means the source operator could not infer schema (e.g., file not resolved or not accessible)."
              )
            }
            s
          case Left(exception) =>
            throw new IllegalStateException(
              s"Schema propagation failed for operator ${outputPortId.opId} port ${outputPortId.portId}: " +
                s"${exception.getClass.getSimpleName}: ${exception.getMessage}",
              exception
            )
        }
        DocumentFactory.createDocument(storageUriToAdd, schema)
        WorkflowExecutionsResource.insertOperatorPortResultUri(
          eid = eid,
          globalPortId = outputPortId,
          uri = storageUriToAdd
        )
    }
  }

  private def setPhase(phase: RegionExecutionPhase): Unit = {
    currentPhaseRef.set(phase)
    SessionState.getAllSessionStates.foreach { state =>
      state.send(RegionStateEvent(region.id.id, phase.toString))
    }
  }

  override def actorId: ActorVirtualIdentity = CONTROLLER
}
