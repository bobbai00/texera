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

import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.dao.jooq.generated.Tables.SITE_SETTINGS
import org.apache.texera.dao.{MockTexeraDB, SqlServer, StatementRecorder}
import org.jooq.ConnectionProvider
import org.jooq.impl.DSL
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path}
import java.sql.{Connection, SQLException}

/**
  * A CSV scan's executor reaches no database. Its column limit is a setting of the site's, which
  * Postgres keeps, but the plan carries the limit to the executor: a computing unit runs a plan
  * without reading Postgres. Each case scans a file beside a database that would give it another
  * answer, or none.
  */
class CSVScanSourceOpExecNoDatabaseSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private var recorder: StatementRecorder = _
  private var threeColumns: Path = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    threeColumns = Files.createTempFile("csv-scan-exec-no-database-spec", ".csv")
    Files.write(threeColumns, "a,b,c\n1,2,3\n".getBytes(StandardCharsets.UTF_8))
  }

  override protected def afterAll(): Unit = {
    Files.deleteIfExists(threeColumns)
    closeConnectionPool()
  }

  /** The rows a scan of the three-column file emits, from a plan compiled under `maxColumns`. */
  private def scanned(maxColumns: Int): List[List[Any]] = {
    val desc = new CSVScanSourceOpDesc()
    desc.customDelimiter = Some(",")
    desc.setResolvedFileName(threeColumns.toUri)
    val exec = new CSVScanSourceOpExec(
      objectMapper.writeValueAsString(desc),
      TestOperators.inputsOf(desc, Some(maxColumns))
    )
    exec.open()
    try exec.produceTuple().map(_.getFields.toList).toList
    finally exec.close()
  }

  /**
    * Runs `body` with the production code pointed at a database it cannot reach, and returns the
    * statements it tried to send meanwhile: one whose failure the code swallows counts too.
    */
  private def whileDatabaseUnreachable(body: => Unit): Seq[StatementRecorder.Statement] = {
    val unreachable = getDSLContext
      .configuration()
      .derive(new ConnectionProvider {
        override def acquire(): Connection = throw new SQLException("database unavailable")
        override def release(connection: Connection): Unit = ()
      })
    SqlServer.getInstance().replaceDSLContext(DSL.using(unreachable))
    try recorder.record(body)
    finally SqlServer.getInstance().replaceDSLContext(getDSLContext)
  }

  "CSVScanSourceOpExec" should
    "scan under its plan's column limit, whatever the site's setting has become" in {
    // The site allows two columns now; the plan was compiled when it allowed four.
    getDSLContext
      .insertInto(SITE_SETTINGS)
      .set(SITE_SETTINGS.KEY, "csv_parser_max_columns")
      .set(SITE_SETTINGS.VALUE, "2")
      .execute()

    scanned(maxColumns = 4) shouldBe List(List(1, 2, 3))
  }

  it should "scan while the database cannot be reached, without trying to reach it" in {
    val statements = whileDatabaseUnreachable {
      scanned(maxColumns = 4) shouldBe List(List(1, 2, 3))
    }

    statements shouldBe empty
  }
}
