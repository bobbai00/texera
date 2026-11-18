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

package org.apache.texera.dao

import org.apache.texera.dao.jooq.generated.Tables.{
  USER,
  WORKFLOW,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.sql.Timestamp
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Applies `sql/updates/54.sql`, which drops what a computing unit used to write to Postgres,
  * to a database that has it: the suite's own database, made from `sql/texera_ddl.sql`, with
  * what the update drops put back. The update names each thing it drops, and says what each
  * column was, so the columns are put back as they were; a table and a type are put back as
  * stand-ins, a table with a column of each type that goes and a reference to its execution,
  * as the tables that go had. What the update leaves must be what the DDL makes.
  */
class RunStateDropUpdateSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val update = new SqlUpdate(54)

  private val endedAt = Timestamp.valueOf("2026-11-17 09:05:00")

  /** The schema as the DDL makes it, read before anything is put back. */
  private var schemaOfDdl: Schema = _

  /** An execution that exists when the update is applied, closed. */
  private var eid: Integer = _

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    schemaOfDdl = schema()

    val uid = getDSLContext
      .insertInto(USER, USER.NAME)
      .values("run-state-drop-update-spec")
      .returning(USER.UID)
      .fetchOne()
      .getUid
    val wid = getDSLContext
      .insertInto(WORKFLOW, WORKFLOW.NAME, WORKFLOW.CONTENT)
      .values("run-state-drop-update-spec", "{}")
      .returning(WORKFLOW.WID)
      .fetchOne()
      .getWid
    val vid = getDSLContext
      .insertInto(WORKFLOW_VERSION, WORKFLOW_VERSION.WID, WORKFLOW_VERSION.CONTENT)
      .values(wid, "{}")
      .returning(WORKFLOW_VERSION.VID)
      .fetchOne()
      .getVid
    eid = getDSLContext
      .insertInto(WORKFLOW_EXECUTIONS)
      .set(WORKFLOW_EXECUTIONS.VID, vid)
      .set(WORKFLOW_EXECUTIONS.UID, uid)
      .set(WORKFLOW_EXECUTIONS.ENVIRONMENT_VERSION, "test")
      .set(WORKFLOW_EXECUTIONS.OUTCOME, Short.box(3.toShort))
      .set(WORKFLOW_EXECUTIONS.ENDED_AT, endedAt)
      .set(WORKFLOW_EXECUTIONS.OUTCOME_FROM_LOG, java.lang.Boolean.TRUE)
      .returning(WORKFLOW_EXECUTIONS.EID)
      .fetchOne()
      .getEid

    // The database as it was before the update: what it drops is there, and in use.
    execute(
      update.droppedTypes.map(name => s"CREATE TYPE texera_db.$name AS ENUM ('A', 'B');") ++
        update.droppedTables.map { table =>
          val ofEachType = update.droppedTypes.map(name => s", of_$name texera_db.$name")
          s"""CREATE TABLE texera_db.$table (
             |  workflow_execution_id INT NOT NULL
             |    REFERENCES texera_db.workflow_executions(eid) ON DELETE CASCADE
             |  ${ofEachType.mkString}
             |);
             |INSERT INTO texera_db.$table (workflow_execution_id) VALUES ($eid);""".stripMargin
        } :+
        ("ALTER TABLE texera_db.workflow_executions " +
          update.droppedColumns
            .map { case (column, was) => s"ADD COLUMN $column $was" }
            .mkString(", ") + ";")
    )
  }

  override protected def afterAll(): Unit =
    try closeConnectionPool()
    finally super.afterAll()

  /** Runs `statements` on a connection of its own: what it sets for its session ends with it. */
  private def execute(statements: Seq[String]): Unit =
    Using.resource(newRawConnection()) { connection =>
      Using.resource(connection.createStatement())(_.execute(statements.mkString("\n")))
    }

  private def applyUpdate(): Unit = execute(Seq(update.script))

  /**
    * What a schema is made of here: each column of `workflow_executions` with its type, whether
    * it may be null and its default; the tables; and the types.
    */
  private case class Schema(
      executionColumns: Seq[Seq[AnyRef]],
      tables: Seq[String],
      types: Seq[String]
  )

  private def names(query: String): Seq[String] =
    getDSLContext.fetch(query).asScala.map(_.get(0, classOf[String])).toSeq

  private def schema(): Schema =
    Schema(
      getDSLContext
        .fetch(
          """select column_name, data_type, is_nullable, column_default
            |from information_schema.columns
            |where table_schema = 'texera_db' and table_name = 'workflow_executions'
            |order by column_name""".stripMargin
        )
        .asScala
        .map(_.intoList().asScala.toSeq)
        .toSeq,
      names(
        """select table_name from information_schema.tables
          |where table_schema = 'texera_db' order by table_name""".stripMargin
      ),
      names(
        """select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
          |where n.nspname = 'texera_db' and t.typtype = 'e' order by t.typname""".stripMargin
      )
    )

  /** The closing record of the execution, and when it was created: what its row keeps. */
  private def execution(): Seq[AnyRef] =
    getDSLContext
      .fetchOne(
        """select outcome, ended_at, outcome_from_log, environment_version
          |from texera_db.workflow_executions where eid = ?""".stripMargin,
        eid
      )
      .intoList()
      .asScala
      .toSeq

  "sql/updates/54.sql" should "drop five columns of a run's state, the two tables of a run's console and results, and the type of a result's mode" in {
    update.droppedColumns should have size 5
    update.droppedTables should have size 2
    update.droppedTypes should have size 1
    // What goes is none of what the DDL makes, and was all put back, to be dropped.
    val before = schema()
    before.executionColumns.map(_.head) should contain allElementsOf update.droppedColumns.map(_._1)
    schemaOfDdl.executionColumns.map(_.head) should contain noElementsOf
      update.droppedColumns.map(_._1)
    before.tables should contain allElementsOf update.droppedTables
    schemaOfDdl.tables should contain noElementsOf update.droppedTables
    before.types should contain allElementsOf update.droppedTypes
    schemaOfDdl.types should contain noElementsOf update.droppedTypes
  }

  it should "leave the schema as sql/texera_ddl.sql makes it, and every execution with its closing record" in {
    val before = execution()

    applyUpdate()

    schema() shouldBe schemaOfDdl
    execution() shouldBe before
    execution() shouldBe Seq(Short.box(3.toShort), endedAt, java.lang.Boolean.TRUE, "test")
  }

  it should "change nothing applied again, or to a database made from the DDL" in {
    applyUpdate()
    applyUpdate()

    schema() shouldBe schemaOfDdl
    execution() shouldBe Seq(Short.box(3.toShort), endedAt, java.lang.Boolean.TRUE, "test")
  }

  it should "be an update of sql/changelog.xml, after the one whose closing record replaces what it drops" in {
    val updates = SqlUpdate.listedInChangelog

    updates should contain inOrder (53, 54)
    updates shouldBe updates.sorted
  }
}
