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

package org.apache.texera.web.service

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.setup.Environment
import org.apache.texera.amber.config.ApplicationConfig
import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.core.virtualidentity.ExecutionIdentity
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED
}
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.amber.engine.common.storage.SequentialRecordStorage
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.dao.jooq.generated.tables.pojos.WorkflowExecutions
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource

import java.net.URI
import java.util.concurrent.TimeUnit

object ExecutionCleanupService extends LazyLogging {

  /**
    * On startup, mark any execution rows that were running before a crash/restart as FAILED
    * and free their replay logs. Only invoked when ApplicationConfig.cleanupAllExecutionResults
    * is enabled.
    */
  def runStartupCleanup(): Unit = {
    if (!ApplicationConfig.cleanupAllExecutionResults) return
    val allExecutionsBeforeRestart: List[WorkflowExecutions] =
      WorkflowExecutionsResource.getExpiredExecutionsWithResultOrLog(-1)
    cleanExecutions(
      allExecutionsBeforeRestart,
      statusByte =>
        if (statusByte != maptoStatusCode(COMPLETED)) maptoStatusCode(FAILED) else statusByte
    )
  }

  /**
    * Schedule periodic cleanup of executions whose results have aged past timeToLive seconds.
    */
  def scheduleRecurringCleanup(environment: Environment): Unit = {
    val timeToLive = ApplicationConfig.sinkStorageTTLInSecs
    val intervalSeconds = ApplicationConfig.sinkStorageCleanUpCheckIntervalInSecs
    val scheduler = environment.lifecycle
      .scheduledExecutorService("execution-cleanup")
      .threads(1)
      .build()
    scheduler.scheduleWithFixedDelay(
      () => recurringCheckExpiredResults(timeToLive),
      2L,
      intervalSeconds.toLong,
      TimeUnit.SECONDS
    )
  }

  private def cleanExecutions(
      executions: List[WorkflowExecutions],
      statusChangeFunc: Short => Short
  ): Unit = {
    executions.foreach(execEntry => {
      dropCollections(execEntry.getResult)
      deleteReplayLog(execEntry.getLogLocation)
      val executionIdentity = ExecutionIdentity(execEntry.getEid.longValue())
      ExecutionsMetadataPersistService.tryUpdateExistingExecution(executionIdentity) { execution =>
        execution.setResult("")
        execution.setLogLocation(null)
        execution.setStatus(statusChangeFunc(execution.getStatus))
      }
    })
  }

  private def dropCollections(result: String): Unit = {
    if (result == null || result.isEmpty) return
    try {
      val node = objectMapper.readTree(result)
      val collectionEntries = node.get("results")
      collectionEntries.forEach(collection => {
        val storageType = collection.get("storageType").asText()
        storageType match {
          case DocumentFactory.ICEBERG =>
          // Iceberg collections are reaped by server-side result cleanup; nothing to do here.
        }
      })
    } catch {
      case e: Throwable =>
        logger.warn("result collection cleanup failed.", e)
    }
  }

  private def deleteReplayLog(logLocation: String): Unit = {
    if (logLocation == null || logLocation.isEmpty) return
    val uri = new URI(logLocation)
    try {
      SequentialRecordStorage.getStorage(Some(uri)).deleteStorage()
    } catch {
      case throwable: Throwable =>
        logger.warn(s"failed to delete log at $logLocation", throwable)
    }
  }

  private def recurringCheckExpiredResults(timeToLive: Int): Unit = {
    val expiredResults: List[WorkflowExecutions] =
      WorkflowExecutionsResource.getExpiredExecutionsWithResultOrLog(timeToLive)
    cleanExecutions(expiredResults, statusByte => statusByte)
  }
}
