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

package org.apache.texera.amber.engine.architecture.scheduling.config

import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.amber.core.storage.CatalogIdentity
import org.apache.texera.amber.core.virtualidentity.{ActorVirtualIdentity, ExecutionIdentity}
import org.apache.texera.amber.core.workflow.{
  PhysicalOp,
  PythonEnvironment,
  PythonEnvironmentRef,
  WorkflowContext
}
import org.apache.texera.amber.util.VirtualIdentityUtils
import org.apache.texera.service.util.LargeBinaryManager

case object WorkerConfig {
  def generateWorkerConfigs(physicalOp: PhysicalOp): List[WorkerConfig] = {
    val workerCount = if (physicalOp.parallelizable) {
      physicalOp.suggestedWorkerNum match {
        // Keep suggested number of workers
        case Some(num) => num
        // If no suggested number, use default value
        case None => ApplicationConfig.numWorkerPerOperatorByDefault
      }
    } else {
      // Non parallelizable operator has only 1 worker
      1
    }

    lazy val largeBinaryBaseUri = LargeBinaryManager.baseUriForExecution(physicalOp.executionId.id)
    // The token this unit was handed with the execution's start: each worker holds it again in
    // its own JVM, which may be on another machine.
    val catalogToken = CatalogIdentity
      .registered(physicalOp.executionId.id)
      .fold(CatalogToken.None)(CatalogToken(_))
    List.tabulate(workerCount)(idx =>
      WorkerConfig(
        VirtualIdentityUtils.createWorkerIdentity(physicalOp.workflowId, physicalOp.id, idx),
        pythonEnvironment = physicalOp.pythonEnvironment match {
          case PythonEnvironmentRef.Resolved(environment) => Some(environment)
          case _                                          => None
        },
        largeBinaryBaseUri = largeBinaryBaseUri,
        executionId = physicalOp.executionId,
        catalogToken = catalogToken
      )
    )
  }
}

case class WorkerConfig(
    workerId: ActorVirtualIdentity,
    // The Python environment a Python worker runs in: its operator's. None: the engine's own.
    pythonEnvironment: Option[PythonEnvironment] = None,
    // Coordinator-named, execution-scoped base URI under which this worker's large binaries
    // live; create() appends a unique suffix. Empty when large binaries are unconfigured.
    largeBinaryBaseUri: String = "",
    // The execution the worker runs for, and that execution's token for the lake's catalog,
    // which the worker holds as it starts (holdCatalogToken) and a Python worker hands to its
    // process. No token where the unit was handed none.
    executionId: ExecutionIdentity = WorkflowContext.DEFAULT_EXECUTION_ID,
    catalogToken: CatalogToken = CatalogToken.None
) {

  /**
    * Holds the worker's token in this JVM, for its execution: from then on, every catalog
    * request made here about the execution carries it. A worker given no token holds none.
    */
  def holdCatalogToken(): Unit =
    if (catalogToken != CatalogToken.None) {
      CatalogIdentity.register(executionId.id, catalogToken.value)
    }
}
