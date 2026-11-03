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

package org.apache.texera.web.execution

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.result.iceberg.OnIceberg
import org.apache.texera.amber.core.virtualidentity.ExecutionIdentity
import org.apache.texera.service.util.LargeBinaryManager
import org.apache.texera.web.service.WarehouseReadGuard

import java.net.URI

/**
  * The storage an execution leaves behind: result tables, console documents, runtime-statistics
  * snapshots and large binaries.
  *
  * An execution's results outlive the run. The catalog records every port result in its lineage
  * and serves it back to people and agents, so nothing here runs when a later execution starts
  * or when the engine goes idle. Storage is dropped only when the unit's retention sweep finds an
  * execution older than the configured time to live.
  */
object ExecutionStorage extends LazyLogging {

  /**
    * Drops everything one execution stored. Best effort: a document that cannot be opened, or a
    * URI that does not decode, is logged and skipped so the rest still goes.
    */
  def drop(
      eid: ExecutionIdentity,
      open: URI => VirtualDocument[_] = uri => DocumentFactory.openDocument(uri)._1,
      deleteLargeBinaries: Long => Unit = LargeBinaryManager.deleteByExecution
  ): Unit = {
    // Read the references before removing them; afterwards nothing points at the documents.
    val documents = ExecutionRegistry.getResultUrisByExecutionId(eid) ++
      ExecutionRegistry.getConsoleMessagesUriByExecutionId(eid)
    val runtimeStats = ExecutionRegistry.getRuntimeStatsUriByExecutionId(eid)
    ExecutionRegistry.deleteConsoleMessageAndExecutionResultUris(eid)

    documents.foreach(uri => bestEffort(uri)(open(uri).clear()))
    runtimeStats.foreach { uri =>
      bestEffort(uri) {
        open(uri) match {
          case iceberg: OnIceberg => iceberg.expireSnapshots()
          case other              => logger.warn(s"cannot expire snapshots of $uri: ${other.getClass.getName}")
        }
      }
    }
    deleteLargeBinaries(eid.id)
  }

  private def bestEffort(uri: URI)(action: => Unit): Unit =
    try {
      // While per-user warehouses are disabled, clean-up must not reach into them (#6930).
      if (WarehouseReadGuard.skipWhileDisabled(uri))
        logger.info(s"skipping $uri: per-user warehouses are disabled")
      else action
    } catch {
      case error: Throwable => logger.warn(s"could not drop $uri: ${error.getMessage}")
    }
}
