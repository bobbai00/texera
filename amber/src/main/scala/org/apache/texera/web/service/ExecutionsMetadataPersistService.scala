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
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.web.execution.{ExecutionRecord, ExecutionRegistry}

/**
  * Execution metadata on the unit lives in the in-memory [[ExecutionRegistry]]; the catalog is
  * told through the lineage reporter. This object keeps the API the engine services call.
  */
object ExecutionsMetadataPersistService extends LazyLogging {

  /**
    * Registers a new execution and returns its identity on this unit. `externalId` is the
    * catalog's execution id when the run was started through the unit API.
    */
  def insertNewExecution(
      workflowId: WorkflowIdentity,
      executionName: String,
      environmentVersion: String,
      computingUnitId: Integer,
      warehouseId: Option[Int] = None,
      externalId: Option[String] = None
  ): ExecutionIdentity = {
    val record = ExecutionRegistry.create(workflowId.id, computingUnitId, executionName, externalId)
    logger.info(
      s"registered execution ${record.eid} for workflow $workflowId (external ${externalId.getOrElse("-")})"
    )
    record.eid
  }

  def tryGetExistingExecution(executionId: ExecutionIdentity): Option[ExecutionRecord] =
    ExecutionRegistry.get(executionId)

  def tryUpdateExistingExecution(
      executionId: ExecutionIdentity
  )(updateFunc: ExecutionRecord => Unit): Unit = {
    ExecutionRegistry.get(executionId) match {
      case Some(record) => updateFunc(record)
      case None         => logger.info(s"Unable to update execution $executionId: unknown")
    }
  }
}
