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

import org.apache.texera.dao.jooq.generated.Tables.{USER, WORKFLOW, WORKFLOW_VERSION}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.sql.Timestamp
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Applies `sql/updates/53.sql`, which gives `workflow_executions` its closing record, to a
  * database as it was before: the suite's own database, made from `sql/texera_ddl.sql`, with the
  * closing record's columns and indexes taken out again, and with the columns of a run's state
  * put back, which the update reads and the next one, `sql/updates/54.sql`, drops. What the
  * update adds must be what the DDL makes, and every execution that exists must come out closed.
  */
class ExecutionClosingRecordUpdateSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val columns = Seq(
    "outcome",
    "outcome_reason",
    "ended_at",
    "outcome_from_log",
    "stored_bytes",
    "results_expired_at",
    "notification"
  )
  private val indexes = Seq(
    "idx_workflow_executions_open",
    "idx_workflow_executions_verdict",
    "idx_workflow_executions_unexpired"
  )

  private val createdAt = Timestamp.valueOf("2026-11-16 09:00:00")
  private val updatedAt = Timestamp.valueOf("2026-11-16 09:05:00")

  /** The update after this one, which says what the columns of a run's state were. */
  private val runStateDrop = new SqlUpdate(54)

  /** The column that held when a row last changed: the one of them that was a time. */
  private val lastChange: String = runStateDrop.droppedColumns.collect {
    case (name, "TIMESTAMP") => name
  } match {
    case Seq(name) => name
    case other     => fail(s"expected one column of a time among those update 54 drops: $other")
  }

  private var uid: Integer = _
  private var vid: Integer = _

  /** The closing record's columns and indexes as the DDL makes them, read before they go. */
  private var columnsOfDdl: Seq[Seq[AnyRef]] = _
  private var indexesOfDdl: Seq[String] = _

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    initializeDBAndReplaceDSLContext()
    uid = getDSLContext
      .insertInto(USER, USER.NAME)
      .values("execution-closing-record-update-spec")
      .returning(USER.UID)
      .fetchOne()
      .getUid
    val wid = getDSLContext
      .insertInto(WORKFLOW, WORKFLOW.NAME, WORKFLOW.CONTENT)
      .values("execution-closing-record-update-spec", "{}")
      .returning(WORKFLOW.WID)
      .fetchOne()
      .getWid
    vid = getDSLContext
      .insertInto(WORKFLOW_VERSION, WORKFLOW_VERSION.WID, WORKFLOW_VERSION.CONTENT)
      .values(wid, "{}")
      .returning(WORKFLOW_VERSION.VID)
      .fetchOne()
      .getVid

    columnsOfDdl = closingColumns()
    indexesOfDdl = closingIndexes()
    // The table as it was before the closing record.
    execute(
      indexes.map(index => s"DROP INDEX texera_db.$index;").mkString("\n") +
        "\nALTER TABLE texera_db.workflow_executions " +
        (columns.map(column => s"DROP COLUMN $column") ++
          runStateDrop.droppedColumns.map { case (column, was) => s"ADD COLUMN $column $was" })
          .mkString(", ") + ";"
    )
  }

  override protected def afterAll(): Unit =
    try closeConnectionPool()
    finally super.afterAll()

  /** Runs `script` on a connection of its own: what it sets for its session ends with it. */
  private def execute(script: String): Unit =
    Using.resource(newRawConnection()) { connection =>
      Using.resource(connection.createStatement())(_.execute(script))
    }

  private val update = new SqlUpdate(53)

  private def applyUpdate(): Unit = execute(update.script)

  private def quoted(names: Seq[String]): String = names.map(name => s"'$name'").mkString(", ")

  private def closingColumns(): Seq[Seq[AnyRef]] =
    getDSLContext
      .fetch(
        s"""select column_name, data_type, is_nullable, column_default
           |from information_schema.columns
           |where table_schema = 'texera_db' and table_name = 'workflow_executions'
           |  and column_name in (${quoted(columns)})
           |order by column_name""".stripMargin
      )
      .asScala
      .map(_.intoList().asScala.toSeq)
      .toSeq

  private def closingIndexes(): Seq[String] =
    getDSLContext
      .fetch(
        s"""select indexdef from pg_indexes
           |where schemaname = 'texera_db' and tablename = 'workflow_executions'
           |  and indexname in (${quoted(indexes)})
           |order by indexname""".stripMargin
      )
      .asScala
      .map(_.get(0, classOf[String]))
      .toSeq

  /** Inserts an execution as it was kept before the closing record, and answers its id. */
  private def insertExecution(status: Int, lastUpdate: Option[Timestamp]): Integer =
    getDSLContext
      .fetchOne(
        s"""insert into texera_db.workflow_executions
           |  (vid, uid, status, starting_time, $lastChange, environment_version)
           |values (?, ?, ?::smallint, ?, ?, 'test') returning eid""".stripMargin,
        vid,
        uid,
        Integer.valueOf(status),
        createdAt,
        lastUpdate.orNull
      )
      .get(0, classOf[Integer])

  /** The closing record of execution `eid`, and whether its results are marked expired. */
  private def closingOf(eid: Integer): Seq[AnyRef] =
    getDSLContext
      .fetchOne(
        """select outcome, outcome_reason, ended_at, outcome_from_log, stored_bytes,
          |       results_expired_at is not null, notification
          |from texera_db.workflow_executions where eid = ?""".stripMargin,
        eid
      )
      .intoList()
      .asScala
      .toSeq

  private val closedAtUpgrade = "closed when Texera was upgraded"

  "sql/updates/53.sql" should "close every execution that exists, with its status when that is an ending" in {
    // Each status a row can hold, with and without a last update.
    val ended = Seq(3, 4, 5).map(status => status -> insertExecution(status, Some(updatedAt)))
    val unended =
      Seq(0, 1, 2, 6, -1).map(status => status -> insertExecution(status, Some(updatedAt)))
    val neverUpdated = Seq(3, 1).map(status => status -> insertExecution(status, None))

    applyUpdate()

    ended.foreach {
      case (status, eid) =>
        withClue(s"status $status: ") {
          closingOf(eid) shouldBe Seq(
            Short.box(status.toShort),
            null,
            updatedAt,
            java.lang.Boolean.TRUE,
            Long.box(0L),
            java.lang.Boolean.TRUE,
            null
          )
        }
    }
    unended.foreach {
      case (status, eid) =>
        withClue(s"status $status: ") {
          closingOf(eid) shouldBe Seq(
            Short.box(4.toShort),
            closedAtUpgrade,
            updatedAt,
            java.lang.Boolean.FALSE,
            Long.box(0L),
            java.lang.Boolean.TRUE,
            null
          )
        }
    }
    // An execution that was never updated ended, for all the row says, when it was created.
    closingOf(neverUpdated.head._2).take(4) shouldBe
      Seq(Short.box(3.toShort), null, createdAt, java.lang.Boolean.TRUE)
    closingOf(neverUpdated.last._2).take(4) shouldBe
      Seq(Short.box(4.toShort), closedAtUpgrade, createdAt, java.lang.Boolean.FALSE)
  }

  it should "add the columns and the indexes that sql/texera_ddl.sql makes" in {
    applyUpdate()

    closingColumns() shouldBe columnsOfDdl
    closingColumns().map(_.head) shouldBe columns.sorted
    closingIndexes() shouldBe indexesOfDdl
    closingIndexes() should have size 3
  }

  it should "close nothing where the closing record is there already, applied again or to a database made from the DDL" in {
    // An execution made since: open, and to be closed when it ends, not by an upgrade.
    val open = insertExecution(1, None)
    val closed = insertExecution(3, Some(updatedAt))
    getDSLContext.execute(
      """update texera_db.workflow_executions
        |set outcome = 5, outcome_reason = 'killed by the user', ended_at = ?,
        |    outcome_from_log = true, stored_bytes = 77
        |where eid = ?""".stripMargin,
      updatedAt,
      closed
    )

    applyUpdate()

    closingOf(open) shouldBe
      Seq(null, null, null, java.lang.Boolean.FALSE, null, java.lang.Boolean.FALSE, null)
    closingOf(closed) shouldBe Seq(
      Short.box(5.toShort),
      "killed by the user",
      updatedAt,
      java.lang.Boolean.TRUE,
      Long.box(77L),
      java.lang.Boolean.FALSE,
      null
    )
    closingColumns() shouldBe columnsOfDdl
    closingIndexes() shouldBe indexesOfDdl

    // On a database made from the DDL, the columns the update reads are not there either: it
    // still changes nothing, and does not fail over them.
    execute(runStateDrop.script)
    applyUpdate()

    closingOf(open) shouldBe
      Seq(null, null, null, java.lang.Boolean.FALSE, null, java.lang.Boolean.FALSE, null)
    closingOf(closed).take(2) shouldBe Seq(Short.box(5.toShort), "killed by the user")
    closingColumns() shouldBe columnsOfDdl
    closingIndexes() shouldBe indexesOfDdl
  }

  it should "be an update of sql/changelog.xml, which lists its updates in order" in {
    val updates = SqlUpdate.listedInChangelog

    updates should contain(53)
    updates shouldBe updates.sorted
  }
}
