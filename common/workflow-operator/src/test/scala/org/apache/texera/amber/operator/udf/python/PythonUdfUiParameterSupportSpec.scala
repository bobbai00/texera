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

package org.apache.texera.amber.operator.udf.python

import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

/**
  * Dataset and model parameters carry what the catalog resolved for the run (presigned URLs in
  * place of `dataset://<rid>@<version>/<path>`); the operator injects them like any other value.
  */
class PythonUdfUiParameterSupportSpec extends AnyFlatSpec with Matchers {

  private val code =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    def process_tuple(self, tuple_, port):
      |        yield tuple_
      |""".stripMargin

  private def parameter(
      name: String,
      attributeType: AttributeType,
      inputType: String,
      value: String
  ): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute(name, attributeType)
    parameter.inputType = inputType
    parameter.value = value
    parameter
  }

  private def udfWith(parameters: UiUDFParameter*): PythonUDFOpDescV2 = {
    val udf = new PythonUDFOpDescV2
    udf.code = code
    udf.uiParameters = parameters.toList
    udf
  }

  "A Python UDF" should "hand workers resource parameters exactly as the catalog resolved them" in {
    val parameters = List(
      parameter(
        "DATA",
        AttributeType.STRING,
        "dataset",
        "https://s3.example.org/datasets/versions/d/v1/sales.csv?X-Amz-Signature=a"
      ),
      parameter(
        "MODEL",
        AttributeType.STRING,
        "model",
        "https://s3.example.org/models/versions/m/v2/model.pt?X-Amz-Signature=b"
      ),
      parameter("count", AttributeType.INTEGER, "", "7")
    )
    val op = udfWith(parameters: _*).getPhysicalOp(WorkflowIdentity(1L), ExecutionIdentity(1L))
    op.opExecInitInfo shouldBe OpExecWithCode(
      PythonUdfUiParameterInjector.inject(code, parameters),
      "python"
    )
  }

  it should "refuse a resource parameter nobody chose, while editing rather than at run time" in {
    val error = the[RuntimeException] thrownBy
      udfWith(parameter("DATA", AttributeType.STRING, "dataset", "  "))
        .getPhysicalOp(WorkflowIdentity(1L), ExecutionIdentity(1L))
    error.getMessage should include("No dataset selected for the parameter 'DATA'")
  }
}
