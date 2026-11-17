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

package org.apache.texera.amber.operator.udf

import org.apache.texera.amber.core.executor.{OpExecInitInfo, OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{PhysicalOp, RepositoryMounts}
import org.apache.texera.amber.operator.udf.java.JavaUdfUiParameterInjector
import org.apache.texera.amber.operator.udf.python.PythonUdfUiParameterInjector
import org.apache.texera.amber.operator.udf.r.RUdfUiParameterInjector
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import _root_.java.nio.file.Paths

class UdfRepositoryDirectoriesSpec extends AnyFlatSpec with Matchers {

  private val unitRoot = Paths.get("/unit/root")
  private val dataset = "dataset-1:d4t4"
  private val model = "model-1:m0d3l"

  private val pythonCode =
    """from pytexera import *
      |
      |class ProcessTupleOperator(UDFOperatorV2):
      |    def process_tuple(self, tuple_, port):
      |        yield tuple_
      |""".stripMargin

  private val rCode = "function() { data.frame() }"

  private val javaCode =
    """import org.apache.texera.amber.operator.udf.java.UiParameter;
      |public class JavaUDFOpExec {
      |  @UiParameter(value="DATA", resource="dataset") public String data;
      |  @UiParameter(value="MODEL", resource="model") public String model;
      |  @UiParameter(value="AGAIN", resource="dataset") public String again;
      |  @UiParameter("label") public String label;
      |}
      |""".stripMargin

  // Each UDF language, with code that takes `parameters` and the injector that writes them in.
  private val languages: Seq[(String, String, (String, List[UiUDFParameter]) => String)] = Seq(
    ("python", pythonCode, PythonUdfUiParameterInjector.inject),
    ("r-tuple", rCode, RUdfUiParameterInjector.inject),
    ("r-table", rCode, RUdfUiParameterInjector.inject),
    ("java", javaCode, JavaUdfUiParameterInjector.inject)
  )

  private def parameter(name: String, inputType: String, value: String): UiUDFParameter = {
    val parameter = new UiUDFParameter
    parameter.attribute = new Attribute(name, AttributeType.STRING)
    parameter.inputType = inputType
    parameter.value = value
    parameter
  }

  // A dataset read through two parameters and a model, beside a value that is the UDF's own.
  private def parameters(dataset: String, model: String): List[UiUDFParameter] =
    List(
      parameter("DATA", "dataset", dataset),
      parameter("MODEL", "model", model),
      parameter("AGAIN", "dataset", dataset),
      parameter("label", "", "dataset-1")
    )

  private def operator(info: OpExecInitInfo, locators: String*): PhysicalOp =
    PhysicalOp
      .oneToOnePhysicalOp(WorkflowIdentity(1), ExecutionIdentity(1), OperatorIdentity("udf"), info)
      .copy(repositoryMounts = Option.when(locators.nonEmpty)(RepositoryMounts(locators.toSet)))

  "UdfRepositoryDirectories.mountedUnder" should
    "give the code of every UDF language the directory the unit mounts each repository at" in {
    for ((language, code, inject) <- languages) withClue(s"$language: ") {
      val planned =
        operator(OpExecWithCode(inject(code, parameters(dataset, model)), language), dataset, model)

      val running = UdfRepositoryDirectories.mountedUnder(Some(unitRoot))(planned)

      // The code is what the injector writes for the directories, and nothing else changes.
      running shouldBe planned.copy(opExecInitInfo =
        OpExecWithCode(
          inject(code, parameters("/unit/root/dataset-1/d4t4", "/unit/root/model-1/m0d3l")),
          language
        )
      )
    }
  }

  it should "return an operator that reads no dataset or model as it is, on any unit" in {
    val udf = operator(OpExecWithCode(pythonCode, "python"))
    val builtIn = operator(OpExecWithClassName("org.apache.texera.Filter", "{}"))
    for (op <- Seq(udf, builtIn); root <- Seq(Some(unitRoot), None)) {
      UdfRepositoryDirectories.mountedUnder(root)(op) should be theSameInstanceAs op
    }
  }

  it should "refuse, on a unit that mounts none, an operator that reads a dataset or model" in {
    val planned = operator(
      OpExecWithCode(
        PythonUdfUiParameterInjector.inject(pythonCode, parameters(dataset, model)),
        "python"
      ),
      model,
      dataset
    )

    val failure = the[IllegalStateException] thrownBy
      UdfRepositoryDirectories.mountedUnder(None)(planned)

    failure.getMessage shouldBe "Operator udf reads datasets or models (dataset-1:d4t4, " +
      "model-1:m0d3l), which this computing unit cannot mount."
  }

  it should "refuse code that does not name a repository its plan says it reads" in {
    for ((language, code, inject) <- languages) withClue(s"$language: ") {
      // The code names the dataset alone; the plan says it reads another commit of the model too.
      val planned = operator(
        OpExecWithCode(
          inject(code, parameters(dataset, "/model/owner@test.com/iris/v2")),
          language
        ),
        dataset,
        model
      )

      val failure = the[IllegalArgumentException] thrownBy
        UdfRepositoryDirectories.mountedUnder(Some(unitRoot))(planned)

      failure.getMessage shouldBe
        "The code of operator udf does not name model-1:m0d3l, which its plan says it reads."
    }
  }

  it should "refuse an operator that reads a dataset or model in no code that names it" in {
    for (
      info <- Seq(
        OpExecWithClassName("org.apache.texera.Filter", "{}"),
        OpExecWithCode(s"""val data = "$dataset"""", "scala")
      )
    ) {
      val failure = the[IllegalArgumentException] thrownBy
        UdfRepositoryDirectories.mountedUnder(Some(unitRoot))(operator(info, dataset))

      failure.getMessage shouldBe "Operator udf reads datasets or models (dataset-1:d4t4), but " +
        "it is no UDF whose code names them."
    }
  }
}
