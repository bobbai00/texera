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

package org.apache.texera.amber.core.workflow

import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.WorkflowContext.{
  DEFAULT_EXECUTION_ID,
  DEFAULT_WORKFLOW_ID,
  DEFAULT_WORKFLOW_SETTINGS
}

object WorkflowContext {
  val DEFAULT_EXECUTION_ID: ExecutionIdentity = ExecutionIdentity(1L)
  val DEFAULT_WORKFLOW_ID: WorkflowIdentity = WorkflowIdentity(1L)
  val DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = WorkflowSettings()
}
class WorkflowContext(
    var workflowId: WorkflowIdentity = DEFAULT_WORKFLOW_ID,
    var executionId: ExecutionIdentity = DEFAULT_EXECUTION_ID,
    var workflowSettings: WorkflowSettings = DEFAULT_WORKFLOW_SETTINGS,
    var cuid: Option[Int] = None,
    // The warehouse this execution stores what it writes in, by its name in the lake
    // catalog: the one the catalog named when it started the execution. It becomes the
    // `/wh/<name>` segment of every URI of the execution. None is the unit's configured
    // default warehouse.
    var warehouse: Option[String] = None,
    // Runtime statistics of the workflow's last completed run, if the unit has one; the
    // scheduler estimates region costs from it. The engine keeps no history of its own.
    var pastRuntimeStatistics: Option[java.net.URI] = None
)
