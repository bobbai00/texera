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
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.dao.SiteSettings

/**
  * The site's settings that a compile makes a plan under. They are read once, when the plan is
  * compiled, and what they decide is fixed in the operators they apply to.
  *
  * @param csvParserMaxColumns the most columns a row of a CSV file may have (site setting
  *                            `csv_parser_max_columns`)
  * @param maxListedFiles      the most files a File Lister may list, or a File Scan From Input
  *                            read, in a plan made to run (`constants.max-listed-files`)
  */
final case class CompileSettings(csvParserMaxColumns: Int, maxListedFiles: Int)

object CompileSettings {

  /** The settings of a site whose administrators have changed none. */
  val Default: CompileSettings =
    CompileSettings(
      csvParserMaxColumns = CSVScanSourceOpDesc.DefaultMaxColumns,
      maxListedFiles = ApplicationConfig.maxListedFiles
    )

  /**
    * The site's settings as they stand now, for a service that has Postgres: what the site's
    * administrators set is read from there, and the rest is the deployment's configuration. A
    * read Postgres does not answer is thrown as it is: a plan compiled under the default could
    * run under another limit than the site's.
    */
  def fromSiteSettings(): CompileSettings =
    Default.copy(
      csvParserMaxColumns =
        SiteSettings.getIntStrict("csv_parser_max_columns", Default.csvParserMaxColumns)
    )
}
