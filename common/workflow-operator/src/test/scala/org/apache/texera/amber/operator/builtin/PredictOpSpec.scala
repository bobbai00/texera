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

import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.HashPartition
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class PredictOpSpec extends AnyFlatSpec with Matchers {
  import AttributeType._

  private def schema(cols: (String, AttributeType)*) =
    Schema(cols.map { case (n, t) => new Attribute(n, t) }.toList)
  private val cohort =
    schema("patient_id" -> STRING, "Glucose" -> INTEGER, "BMI" -> DOUBLE, "Outcome" -> INTEGER)

  private val riskContract =
    """{"framework": "sklearn", "entry": "model.joblib",
      | "inputs": [{"attributeName": "Glucose", "attributeType": "double"}, {"attributeName": "BMI", "attributeType": "double"}],
      | "outputs": [{"attributeName": "predicted", "attributeType": "long"}, {"attributeName": "risk", "attributeType": "double"}]}""".stripMargin

  /** The operator as the catalog compiles a workflow's predict: the version's contract and files filled in. */
  private def predict(settings: String): PredictOp =
    objectMapper
      .readValue(
        s"""{"operatorType": "predict", "operatorID": "scored", "model": "texera://models/m@2", $settings}""",
        classOf[LogicalOp]
      )
      .asInstanceOf[PredictOp]

  private def error(f: => Any): String = intercept[SettingError](f).getMessage

  "predict" should "add its model's outputs to every row, once the input has what the model reads" in {
    val scored =
      predict(s""""contract": $riskContract, "files": {"model.joblib": "https://lake/m"}""")
    scored.outputColumns(List(cohort)) shouldBe
      schema(
        "patient_id" -> STRING,
        "Glucose" -> INTEGER,
        "BMI" -> DOUBLE,
        "Outcome" -> INTEGER,
        "predicted" -> LONG,
        "risk" -> DOUBLE
      )
    scored.operatorInfo.operatorGroupName shouldBe "Machine Learning"

    error(scored.outputColumns(List(schema("glucose" -> DOUBLE, "BMI" -> DOUBLE)))) shouldBe
      """model: the model reads Glucose: the input has no column "Glucose"; did you mean "glucose"?"""
    error(scored.outputColumns(List(schema("Glucose" -> STRING, "BMI" -> DOUBLE)))) shouldBe
      "model: the model reads Glucose as double, and the input's is string: convert it in a compute first"
    error(scored.outputColumns(List(cohort.add(new Attribute("risk", DOUBLE))))) shouldBe
      "model: the model adds risk, a column the input already has: rename that column with project first"
    error(predict(""""by": ["patient_id"]""").outputColumns(List(cohort))) shouldBe
      "model: the model's contract is not here: name a model version, as texera://models/<rid>@<version>"
  }

  it should "put out a row per group for a model that reads whole groups, which needs by" in {
    val grouped = riskContract.replace(
      """"framework": "sklearn"""",
      """"framework": "python", "grouped": true"""
    )
    error(predict(s""""contract": $grouped""").outputColumns(List(cohort))) shouldBe
      "by: this model reads whole groups, such as one patient's readings: name the columns that make a group"
    predict(s""""contract": $grouped, "by": ["patient_id"]""").outputColumns(List(cohort)) shouldBe
      schema("patient_id" -> STRING, "predicted" -> LONG, "risk" -> DOUBLE)
  }

  it should "run on Python workers as an operator that loads the version and calls it" in {
    val ids = (WorkflowIdentity(1L), ExecutionIdentity(1L))
    val scored = predict(
      s""""contract": $riskContract, "files": {"model.joblib": "https://lake/m?sig=a\\"b"}"""
    )
    val module = scored.module
    module should include("class ProcessModelOperator(ModelBatchOperator):\n")
    module should include("    model = \"texera://models/m@2\"\n")
    module should include("    entry = \"model.joblib\"\n")
    module should include(
      """    files = __import__('json').loads("{\"model.joblib\":\"https://lake/m?sig=a\\\"b\"}")"""
    )
    module should include(
      """    inputs = __import__('json').loads("[[\"Glucose\",\"double\"],[\"BMI\",\"double\"]]")"""
    )
    module should include("""    keys = __import__('json').loads("[]")""")
    val anywhere = scored.getPhysicalOp(ids._1, ids._2)
    anywhere.parallelizable shouldBe true
    anywhere.partitionRequirement.flatten shouldBe empty
    anywhere.pveName shouldBe ""
    // The unit's environment, when its profile adds packages the model needs.
    predict(s""""contract": $riskContract, "envName": "env-torch"""")
      .getPhysicalOp(ids._1, ids._2)
      .pveName shouldBe "env-torch"

    val grouped = riskContract.replace(
      """"framework": "sklearn"""",
      """"framework": "python", "grouped": true"""
    )
    val byPatient = predict(s""""contract": $grouped, "by": ["patient_id"]""")
    byPatient.module should include("class ProcessModelOperator(ModelTableOperator):\n")
    byPatient.getPhysicalOp(ids._1, ids._2).partitionRequirement shouldBe
      List(Some(HashPartition(List("patient_id"))))
  }

  "A model" should "read numbers as numbers, and anything else as its own type" in {
    PredictOp.fits(INTEGER, DOUBLE) shouldBe true
    PredictOp.fits(DOUBLE, LONG) shouldBe true
    PredictOp.fits(STRING, DOUBLE) shouldBe false
    PredictOp.fits(TIMESTAMP, TIMESTAMP) shouldBe true
    PredictOp.fits(BOOLEAN, INTEGER) shouldBe false
  }
}
