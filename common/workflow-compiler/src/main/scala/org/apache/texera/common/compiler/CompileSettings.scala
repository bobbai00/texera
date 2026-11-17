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

package org.apache.texera.common.compiler

import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.dao.SiteSettings

/**
  * The site's settings that a compile fixes in the plan it makes. They are read once, when the
  * plan is compiled, and travel in the operators they apply to, so what runs the plan asks the
  * site for nothing.
  *
  * @param csvParserMaxColumns the most columns a row of a CSV file may have (site setting
  *                            `csv_parser_max_columns`): the limit of every CSV scan
  */
final case class CompileSettings(csvParserMaxColumns: Int)

object CompileSettings {

  /** The settings of a site whose administrators have changed none. */
  val Default: CompileSettings =
    CompileSettings(csvParserMaxColumns = CSVScanSourceOpDesc.DefaultMaxColumns)

  /**
    * The site's settings as they stand now, read from Postgres: for a service that has it, the
    * Dashboard and the compiling service. A setting that cannot be read, because the site holds
    * none, holds one that is no number, or Postgres does not answer, is the default's.
    */
  def fromSiteSettings(): CompileSettings =
    CompileSettings(
      csvParserMaxColumns =
        SiteSettings.getInt("csv_parser_max_columns", Default.csvParserMaxColumns)
    )
}
