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

package org.apache.texera.amber.core.storage.result

import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}

object ResultSchema {
  val runtimeStatisticsSchema: Schema = new Schema(
    new Attribute("operatorId", AttributeType.STRING),
    new Attribute("time", AttributeType.TIMESTAMP),
    new Attribute("inputTupleCnt", AttributeType.LONG),
    new Attribute("inputTupleSize", AttributeType.LONG),
    new Attribute("outputTupleCnt", AttributeType.LONG),
    new Attribute("outputTupleSize", AttributeType.LONG),
    new Attribute("dataProcessingTime", AttributeType.LONG),
    new Attribute("controlProcessingTime", AttributeType.LONG),
    new Attribute("idleTime", AttributeType.LONG),
    new Attribute("numWorkers", AttributeType.INTEGER),
    new Attribute("status", AttributeType.INTEGER)
  )

  val consoleMessagesSchema: Schema = new Schema(
    new Attribute("message", AttributeType.STRING)
  )

  /**
    * An execution's plan table (see `ExecutionPlanStore`): one plan row written when the
    * execution is created, then one row per change to one of its paused operators.
    */
  val executionPlanSchema: Schema = new Schema(
    new Attribute("entryId", AttributeType.STRING),
    new Attribute("body", AttributeType.STRING),
    new Attribute("logical", AttributeType.STRING),
    new Attribute("createdBy", AttributeType.INTEGER),
    new Attribute("computingUnitId", AttributeType.INTEGER),
    new Attribute("notification", AttributeType.STRING)
  )

  /** An execution's log table (see `ExecutionLogStore`): one row per change of the run's state. */
  val executionLogSchema: Schema = new Schema(
    new Attribute("seq", AttributeType.LONG),
    new Attribute("timeMs", AttributeType.LONG),
    new Attribute("kind", AttributeType.STRING),
    new Attribute("state", AttributeType.STRING),
    new Attribute("detail", AttributeType.STRING)
  )
}
