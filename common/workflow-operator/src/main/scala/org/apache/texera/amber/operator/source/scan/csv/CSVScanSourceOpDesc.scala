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

package org.apache.texera.amber.operator.source.scan.csv

import com.fasterxml.jackson.annotation.{JsonInclude, JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.{JsonSchemaInject, JsonSchemaTitle}
import com.univocity.parsers.csv.{CsvFormat, CsvParser, CsvParserSettings}
import org.apache.texera.amber.core.executor.OperatorInputs
import org.apache.texera.amber.core.storage.model.ReadonlyVirtualDocument
import org.apache.texera.amber.core.tuple.AttributeTypeUtils.inferSchemaFromRows
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{PhysicalOp, PhysicalPlan}
import org.apache.texera.amber.operator.metadata.annotations.UIWidget
import org.apache.texera.amber.operator.source.scan.ScanSourceOpDesc
import org.apache.texera.amber.operator.{StandaloneCodeGenerator, StandaloneHelpers}

import java.io.{IOException, InputStreamReader}

class CSVScanSourceOpDesc extends ScanSourceOpDesc with StandaloneCodeGenerator {

  @JsonProperty(defaultValue = ",")
  @JsonSchemaTitle("Delimiter")
  @JsonPropertyDescription("single character separating the fields on each line")
  @JsonInclude(JsonInclude.Include.NON_ABSENT)
  @JsonSchemaInject(json = UIWidget.UIWidgetCharDelimiter)
  var customDelimiter: Option[String] = None

  @JsonProperty(defaultValue = "true")
  @JsonSchemaTitle("Header")
  @JsonPropertyDescription("whether the CSV file contains a header line")
  var hasHeader: Boolean = true

  fileTypeName = Option("CSV")

  @throws[IOException]
  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = getPhysicalOp(workflowId, executionId, CSVScanSourceOpDesc.DefaultMaxColumns)

  /**
    * The schema is inferred under the column limit of the site the workflow is compiled for,
    * the one the plan's executor is handed to read the file under.
    */
  override def getPhysicalPlan(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      inputs: OperatorInputs
  ): PhysicalPlan =
    PhysicalPlan(
      operators = Set(
        getPhysicalOp(
          workflowId,
          executionId,
          inputs.csvParserMaxColumns.getOrElse(CSVScanSourceOpDesc.DefaultMaxColumns)
        )
      ),
      links = Set.empty
    )

  private def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      maxColumns: Int
  ): PhysicalOp = {
    if (customDelimiter.forall(_.isEmpty)) {
      customDelimiter = Option(",")
    }
    sourcePhysicalOp(
      workflowId,
      executionId,
      "org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpExec",
      outputSchema = () => inferSchemaFrom(openFileToInferFrom(".csv"), maxColumns)
    )
  }

  /**
    * The schema of the file, inferred under [[CSVScanSourceOpDesc.DefaultMaxColumns]]: for a
    * caller outside a compile. A compile infers it under the site's limit ([[getPhysicalPlan]]).
    */
  override def sourceSchema(): Schema =
    inferSchemaFrom(openFileToInferFrom(".csv"), CSVScanSourceOpDesc.DefaultMaxColumns)

  /**
    * The schema of the file `document` holds, inferred from its first rows, of at most
    * `maxColumns` columns each.
    */
  def inferSchemaFrom(document: ReadonlyVirtualDocument[_], maxColumns: Int): Schema = {
    val delimiterChar = CsvScanSupport.resolveDelimiterChar(customDelimiter).charAt(0)
    val stream = document.asInputStream()
    val inputReader = new InputStreamReader(stream, fileEncoding.getCharset)

    val csvFormat = new CsvFormat()
    csvFormat.setDelimiter(delimiterChar)
    csvFormat.setLineSeparator("\n")
    val csvSetting = new CsvParserSettings()
    csvSetting.setMaxCharsPerColumn(-1)
    csvSetting.setMaxColumns(maxColumns)
    csvSetting.setFormat(csvFormat)
    csvSetting.setHeaderExtractionEnabled(hasHeader)
    val parser = new CsvParser(csvSetting)
    parser.beginParsing(inputReader)

    var data: Array[Array[String]] = Array()
    val readLimit = inferSampleSize
    for (_ <- 0 until readLimit) {
      val row = CSVScanSourceOpExec.parseNextRow(parser, maxColumns)
      if (row != null) {
        data = data :+ row
      }
    }
    parser.stopParsing()
    inputReader.close()

    val attributeTypeList: Array[AttributeType] = inferSchemaFromRows(
      data.iterator.asInstanceOf[Iterator[Array[Any]]]
    )

    val header: Array[String] =
      if (hasHeader)
        Option(parser.getContext.headers())
          .getOrElse((1 to attributeTypeList.length).map(i => "column-" + i).toArray)
      else (1 to attributeTypeList.length).map(i => "column-" + i).toArray

    header.indices.foldLeft(Schema()) { (schema, i) =>
      val name = Option(header(i)).filter(_.nonEmpty).getOrElse(s"column-${i + 1}")
      schema.add(name, attributeTypeList(i))
    }
  }

  override def standaloneSourcePath(): Option[String] = fileName

  override def standaloneHelpers(): Seq[String] = Seq(StandaloneHelpers.AttributeCasts)

  override def generateStandaloneCode(): String =
    CsvScanSupport.generateStandaloneCode(
      this,
      customDelimiter,
      hasHeader,
      dtypeByType = Map(
        AttributeType.INTEGER -> "Int32",
        AttributeType.LONG -> "Int64",
        AttributeType.BOOLEAN -> "boolean",
        AttributeType.TIMESTAMP -> "object"
      ),
      includeNaValuesBlank = true,
      includeWindow = true,
      declaredSchemaBody = (readCall, declared) =>
        s"$readCall\n${StandaloneCodeGenerator.readAsDeclared("out1df", declared)}"
    )
}

object CSVScanSourceOpDesc {

  /** The most columns a row may have on a site whose administrators have set no other limit. */
  val DefaultMaxColumns: Int = 512
}
