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
import org.apache.texera.amber.core.storage.ExecutionLayouts
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.amber.core.virtualidentity.ActorVirtualIdentity
import org.apache.texera.amber.core.workflow.PhysicalOp
import org.apache.texera.amber.util.VirtualIdentityUtils
import org.apache.texera.service.util.LargeBinaryManager

import scala.jdk.CollectionConverters._

case object WorkerConfig {
  def generateWorkerConfigs(
      physicalOp: PhysicalOp,
      cuid: Option[Int] = None
  ): List[WorkerConfig] = {
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

    val layout = ExecutionLayouts.lookup(physicalOp.executionId)
    (0 until workerCount).toList.map(idx =>
      WorkerConfig(
        VirtualIdentityUtils.createWorkerIdentity(physicalOp.workflowId, physicalOp.id, idx),
        pveName = physicalOp.pveName,
        cuid = cuid,
        largeBinaryBaseUri = LargeBinaryManager.baseUriForExecution(physicalOp.executionId.id),
        tableNamespace = layout.map(_.namespace).getOrElse(""),
        resultTables = layout
          .map(l =>
            objectMapper.writeValueAsString(l.tables.map {
              case ((op, port), t) => s"$op:$port" -> t
            }.asJava)
          )
          .getOrElse("")
      )
    )
  }
}

case class WorkerConfig(
    workerId: ActorVirtualIdentity,
    pveName: String = "",
    cuid: Option[Int] = None,
    // Coordinator-named, execution-scoped base URI under which this worker's large binaries
    // live; create() appends a unique suffix. Empty when large binaries are unconfigured.
    largeBinaryBaseUri: String = "",
    // The namespace the catalog made for this execution's tables; empty keeps the configured
    // per-type namespaces (see ExecutionLayouts).
    tableNamespace: String = "",
    // The tables the catalog named for the external output ports, as JSON {"op:port": table}.
    resultTables: String = ""
)
