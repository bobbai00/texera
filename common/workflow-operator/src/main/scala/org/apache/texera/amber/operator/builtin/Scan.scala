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

import com.fasterxml.jackson.annotation.{JsonIgnore, JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.core.tuple.Schema
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{OutputPort, PhysicalOp}
import org.apache.texera.amber.operator.metadata.OperatorInfo
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.json.JSONLScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.{ReadsFile, ScanSourceOpDesc}

import java.net.URI

/**
  * `scan(file="texera://datasets/<rid>@4/files/cgm.csv")`: reads one file of a dataset version.
  * The format follows the file's extension unless one is given: csv, tsv, or json (one object
  * per line). Column types are read off the first rows.
  */
class ScanOp extends BuiltinOp with ReadsFile {
  @JsonProperty(required = true)
  @JsonSchemaTitle("File")
  @JsonPropertyDescription("The file: texera://datasets/<rid>@<version>/files/<path>")
  var file: String = ""

  @JsonProperty(defaultValue = "auto")
  @JsonSchemaTitle("Format")
  @JsonPropertyDescription("auto (by the file's extension), csv, tsv or json (one object per line)")
  var format: String = "auto"

  @JsonProperty(defaultValue = "true")
  @JsonSchemaTitle("Header")
  @JsonPropertyDescription("Whether a csv or tsv file's first line names its columns")
  var header: Boolean = true

  @JsonProperty
  @JsonSchemaTitle("Delimiter")
  @JsonPropertyDescription("The one character between fields; absent: a comma, or a tab for tsv")
  var delimiter: String = _

  @JsonIgnore override def name = "scan"
  @JsonIgnore override def summary = "Read a file of a dataset version."
  @JsonIgnore override def inputNames: List[String] = Nil
  @JsonIgnore override def executor: String = ""

  @JsonIgnore override def fileToRead: Option[String] = Option(file).filter(_.nonEmpty)
  override def setResolvedFileName(uri: URI): Unit = file = uri.toASCIIString

  /** The format, from the setting or the file's extension. */
  @JsonIgnore def formatOf: String = {
    val stated = Option(format).map(_.trim.toLowerCase).filter(f => f.nonEmpty && f != "auto")
    stated.getOrElse {
      val path = Option(file).map(f => f.takeWhile(_ != '?').toLowerCase).getOrElse("")
      if (path.endsWith(".tsv") || path.endsWith(".tab")) "tsv"
      else if (path.endsWith(".json") || path.endsWith(".jsonl") || path.endsWith(".ndjson")) "json"
      else "csv"
    }
  }

  /** The engine's reader for the file, under this operator's identity. */
  private def reader: ScanSourceOpDesc = {
    val r: ScanSourceOpDesc = formatOf match {
      case "csv" | "tsv" =>
        val csv = new CSVScanSourceOpDesc
        csv.hasHeader = header
        val sep = Option(delimiter).filter(_.nonEmpty).getOrElse(if (formatOf == "tsv") "\t" else ",")
        if (sep.length != 1) throw new SettingError("delimiter", "one character")
        csv.customDelimiter = Some(sep)
        csv
      case "json" => new JSONLScanSourceOpDesc
      case other  => throw new SettingError("format", s"'$other' is not one this reads: csv, tsv or json")
    }
    if (fileToRead.isEmpty) throw new SettingError("file", "name the file to read")
    r.fileName = fileToRead
    r.setOperatorId(operatorIdentifier.id)
    r
  }

  override def outputColumns(inputs: List[Schema]): Schema = reader.sourceSchema()

  override def getPhysicalOp(workflowId: WorkflowIdentity, executionId: ExecutionIdentity): PhysicalOp =
    reader.getPhysicalOp(workflowId, executionId)

  override def operatorInfo: OperatorInfo =
    OperatorInfo(name, summary, BuiltinOp.Group, inputPorts = List.empty, outputPorts = List(OutputPort()))
}
