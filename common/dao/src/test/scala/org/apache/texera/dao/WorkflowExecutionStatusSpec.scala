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

package org.apache.texera.dao

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class WorkflowExecutionStatusSpec extends AnyFlatSpec with Matchers {

  // The codes are stored in every execution's row and named again by the frontend, so a change
  // here is a change of the stored format.
  "WorkflowExecutionStatus" should "keep the codes that executions' rows already hold" in {
    WorkflowExecutionStatus.Initializing shouldBe 0
    WorkflowExecutionStatus.Running shouldBe 1
    WorkflowExecutionStatus.Paused shouldBe 2
    WorkflowExecutionStatus.Completed shouldBe 3
    WorkflowExecutionStatus.Failed shouldBe 4
    WorkflowExecutionStatus.Killed shouldBe 5
    WorkflowExecutionStatus.Unknown shouldBe -1
  }

  it should "give a created execution a code of its own" in {
    WorkflowExecutionStatus.Created shouldBe 6
  }

  it should "count completed, failed and killed executions as ended, and no other" in {
    WorkflowExecutionStatus.Ended shouldBe Set[Short](3, 4, 5)
  }

  it should "count an execution as not running once it has ended, or while no unit has started it" in {
    WorkflowExecutionStatus.NotRunning shouldBe Set[Short](3, 4, 5, 6)
  }
}
