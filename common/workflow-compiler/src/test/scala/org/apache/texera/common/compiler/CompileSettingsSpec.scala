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

import org.apache.texera.common.config.DefaultsConfig
import org.apache.texera.dao.jooq.generated.Tables.SITE_SETTINGS
import org.apache.texera.dao.{MockTexeraDB, SiteSettings}
import org.scalatest.{BeforeAndAfterAll, BeforeAndAfterEach}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class CompileSettingsSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with BeforeAndAfterEach
    with MockTexeraDB {

  private val csvMaxColumnsKey = "csv_parser_max_columns"

  override protected def beforeAll(): Unit = initializeDBAndReplaceDSLContext()

  override protected def afterAll(): Unit = closeConnectionPool()

  // Each case starts on a site that holds no limit.
  override protected def beforeEach(): Unit =
    getDSLContext.deleteFrom(SITE_SETTINGS).where(SITE_SETTINGS.KEY.eq(csvMaxColumnsKey)).execute()

  private def siteHolds(csvMaxColumns: String): Unit =
    SiteSettings.upsert(getDSLContext, csvMaxColumnsKey, csvMaxColumns, "spec")

  "CompileSettings.fromSiteSettings" should
    "take the CSV column limit the site holds, as it stands at each read" in {
    siteHolds("731")
    CompileSettings.fromSiteSettings() shouldBe CompileSettings(csvParserMaxColumns = 731)

    siteHolds("9")
    CompileSettings.fromSiteSettings() shouldBe CompileSettings(csvParserMaxColumns = 9)
  }

  it should "take the default for a limit the site does not hold, or holds as no number" in {
    CompileSettings.fromSiteSettings() shouldBe CompileSettings.Default

    siteHolds("many")
    CompileSettings.fromSiteSettings() shouldBe CompileSettings.Default
  }

  "CompileSettings.Default" should "be what a site is seeded with" in {
    // The seed is default.conf's, unless the environment of this run overrides it.
    assume(!sys.env.contains("OPERATOR_CSV_PARSER_MAX_COLUMNS"))

    CompileSettings.Default.csvParserMaxColumns.toString shouldBe
      DefaultsConfig.allDefaults(csvMaxColumnsKey)
  }
}
