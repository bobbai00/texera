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

package org.apache.texera.amber.operator.builtin

import org.apache.texera.amber.core.executor.OpExecWithClassName
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class StoredOpSpec extends AnyFlatSpec with Matchers {

  private def stored(settings: String): StoredOp =
    objectMapper
      .readValue(
        s"""{"operatorType": "stored", "operatorID": "metrics", $settings}""",
        classOf[LogicalOp]
      )
      .asInstanceOf[StoredOp]

  "A stored result" should "put out the columns the catalog read from the lake, as a source on one worker" in {
    val metrics = stored(
      """"warehouse": "texera", "namespace": "e_1", "table": "metrics_output_0",
        | "columns": [{"attributeName": "participant", "attributeType": "string"}, {"attributeName": "tir", "attributeType": "double"}],
        | "from": "texera://workflows/w/executions/e/operators/metrics/ports/output-0"""".stripMargin
    )
    metrics.schema shouldBe Schema(
      List(
        new Attribute("participant", AttributeType.STRING),
        new Attribute("tir", AttributeType.DOUBLE)
      )
    )
    metrics.operatorInfo.inputPorts shouldBe empty
    val physical = metrics.getPhysicalOp(WorkflowIdentity(1L), ExecutionIdentity(1L))
    physical.parallelizable shouldBe false
    physical.opExecInitInfo
      .asInstanceOf[OpExecWithClassName]
      .className shouldBe classOf[StoredExec].getName
    intercept[SettingError](
      stored(""""namespace": "e_1", "table": "t", "columns": []""").schema
    ).getMessage shouldBe
      "columns: the stored table's columns are not here"
  }
}
