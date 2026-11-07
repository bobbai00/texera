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

import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{HashPartition, PortIdentity}
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class FunctionOpSpec extends AnyFlatSpec with Matchers {
  import AttributeType._

  private def schema(cols: (String, AttributeType)*) =
    Schema(cols.map { case (n, t) => new Attribute(n, t) }.toList)
  private val readings =
    schema("patient_id" -> STRING, "taken_at" -> TIMESTAMP, "glucose" -> DOUBLE)
  private val labs = schema("patient_id" -> STRING, "a1c" -> DOUBLE)

  private val code =
    """import pandas as pd
      |
      |@returns(patient_id=str, time_in_range=float)
      |def time_in_range(readings, *, low: int = 70):
      |    g = readings.groupby("patient_id")["glucose"]
      |    return g.apply(lambda s: (s >= low).mean()).rename("time_in_range").reset_index()""".stripMargin

  /** The operator as the catalog compiles a workflow's call to a function. */
  private def function(settings: String): FunctionOp =
    objectMapper
      .readValue(
        s"""{"operatorType": "function", "operatorID": "tir", "code": ${objectMapper
          .writeValueAsString(code)}, "function": "time_in_range", $settings}""",
        classOf[LogicalOp]
      )
      .asInstanceOf[FunctionOp]

  private def error(f: => Any): String =
    intercept[SettingError](f).getMessage

  "A function" should "put out the columns its returns declares, once by names columns of every input" in {
    val tir =
      function(""""returns": ["patient_id string", "time_in_range double"], "by": ["patient_id"]""")
    tir.outputColumns(List(readings)) shouldBe schema(
      "patient_id" -> STRING,
      "time_in_range" -> DOUBLE
    )
    tir.operatorInfo.operatorGroupName shouldBe "Python"

    tir.outputColumns(List(labs)) shouldBe schema("patient_id" -> STRING, "time_in_range" -> DOUBLE)
    error(
      function(""""returns": ["patient_id string"], "by": ["patient"]""").outputColumns(
        List(readings)
      )
    ) shouldBe
      """by: the input has no column "patient"; did you mean "patient_id"?"""
    error(function(""""returns": ["patient_id varchar2"]""").outputColumns(List(readings))) shouldBe
      "returns: 'patient_id varchar2': varchar2 is not a type; use string, integer, long, double, boolean or timestamp"
    error(function(""""returns": ["patient_id"]""").outputColumns(List(readings))) shouldBe
      "returns: 'patient_id': write a column as its name and type, as patient_id string"
    error(function(""""returns": []""").outputColumns(List(readings))) shouldBe
      "returns: name at least one column, as patient_id string"
    error(function(""""returns": ["a long", "a double"]""").outputColumns(List(readings))) shouldBe
      "returns: a is named twice"
  }

  it should "run on Python workers as the code and a class that calls it with its arguments" in {
    val tir = function(
      """"returns": ["patient_id string", "time_in_range double"], "by": ["patient_id"], "args": {"low": 54, "note": "a \"quoted\" word", "on": true, "none": null}"""
    )
    val module = tir.module
    module should startWith(
      "from pytexera import *\nfrom pytexera import FunctionOperator, FunctionSourceOperator, returns\n\nimport pandas as pd\n"
    )
    module should include(code)
    module should include(
      """    columns = __import__('json').loads("[[\"patient_id\",\"string\"],[\"time_in_range\",\"double\"]]")"""
    )
    module should include(
      """    arguments = __import__('json').loads("{\"low\":54,\"note\":\"a \\\"quoted\\\" word\",\"on\":true,\"none\":null}")"""
    )
    module should include("    function = staticmethod(time_in_range)\n")
    module should include("    inputs = 1\n    grouped = True\n")
    function(""""returns": ["n long"]""").module should include("    grouped = False\n")
    error(
      function(""""returns": ["n long"], "function": "time-in-range"""").outputColumns(
        List(readings)
      )
    ) shouldBe
      "function: 'time-in-range' is not a Python function's name"
  }

  it should "spread its rows by key over workers with by, and keep them on one worker without" in {
    val ids = (WorkflowIdentity(1L), ExecutionIdentity(1L))
    val grouped = function(""""returns": ["patient_id string"], "by": ["patient_id"]""")
      .getPhysicalOp(ids._1, ids._2)
    grouped.parallelizable shouldBe true
    grouped.partitionRequirement shouldBe List(Some(HashPartition(List("patient_id"))))
    grouped.opExecInitInfo shouldBe a[OpExecWithCode]
    grouped.opExecInitInfo.asInstanceOf[OpExecWithCode].language shouldBe "python"

    val whole = function(""""returns": ["n long"]""").getPhysicalOp(ids._1, ids._2)
    whole.parallelizable shouldBe false

    val pair =
      function(""""returns": ["n long"], "inputs": ["readings", "labs"], "by": ["patient_id"]""")
    pair.operatorInfo.inputPorts.map(p => (p.id, p.displayName)) shouldBe
      List(PortIdentity(0) -> "readings", PortIdentity(1) -> "labs")
    pair.getPhysicalOp(ids._1, ids._2).partitionRequirement shouldBe
      List(Some(HashPartition(List("patient_id"))), Some(HashPartition(List("patient_id"))))
    pair.outputColumns(List(readings, labs)) shouldBe schema("n" -> LONG)
  }

  it should "be a source when it reads no table, called once on one worker" in {
    val ids = (WorkflowIdentity(1L), ExecutionIdentity(1L))
    val source = function(""""returns": ["n long"], "inputs": [], "args": {"upto": 3}""")
    source.operatorInfo.inputPorts shouldBe Nil
    source.outputColumns(Nil) shouldBe schema("n" -> LONG)
    val op = source.getPhysicalOp(ids._1, ids._2)
    op.isSourceOperator shouldBe true
    op.parallelizable shouldBe false
    op.inputPorts shouldBe empty
    val module = source.module
    module should include("class GenerateOperator(FunctionSourceOperator):\n")
    module should include("    function = staticmethod(time_in_range)\n")
    module should not include "inputs ="
    module should not include "grouped ="
    error(
      function(""""returns": ["n long"], "inputs": [], "by": ["n"]""").outputColumns(Nil)
    ) shouldBe "by: a function that reads no table has no rows to group"
    // Absent, the inputs are the one table it reads.
    function(""""returns": ["n long"]""").operatorInfo.inputPorts.size shouldBe 1
  }

  it should "run in the Python environment the unit names, or the unit's default" in {
    val ids = (WorkflowIdentity(1L), ExecutionIdentity(1L))
    function(""""returns": ["n long"]""").getPhysicalOp(ids._1, ids._2).pveName shouldBe ""
    function(""""returns": ["n long"], "envName": "env-humanize"""")
      .getPhysicalOp(ids._1, ids._2)
      .pveName shouldBe "env-humanize"
    function(""""returns": ["n long"], "inputs": [], "envName": "env-humanize"""")
      .getPhysicalOp(ids._1, ids._2)
      .pveName shouldBe "env-humanize"
  }

  it should "go through JSON and back, as the engine copies a plan" in {
    val tir = function(""""returns": ["n long"], "envName": "env-humanize"""")
    val json = objectMapper.writeValueAsString(tir)
    val again = objectMapper.readValue(json, classOf[LogicalOp]).asInstanceOf[FunctionOp]
    again.pveName shouldBe "env-humanize"
    again.columns shouldBe tir.columns
  }
}
