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

import org.apache.texera.dao.StatementRecorder.{Statement, siteOf}
import org.apache.texera.dao.jooq.generated.Tables.USER
import org.jooq.ConnectionProvider
import org.jooq.impl.DSL
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.sql.{Connection, SQLException}
import java.util.UUID
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Specs assert that code sends no statement, or only certain ones, through this recorder, so a
  * recorder that misses statements would make them pass for the wrong reason.
  */
class StatementRecorderSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  private def updateNobody(): Unit =
    getDSLContext.update(USER).set(USER.NAME, "nobody").where(USER.UID.eq(-1)).execute()

  "record" should "return each statement sent while the block runs, in order, with its thread" in {
    val statements = recorder.record {
      getDSLContext.selectOne().fetch()
      updateNobody()
    }
    statements.map(_.verb) shouldBe Seq("SELECT", "UPDATE")
    statements(1).sql should include("\"user\"")
    statements.map(_.thread).distinct shouldBe Seq(Thread.currentThread().getName)
  }

  it should "record the values a statement binds, in the order of its placeholders" in {
    val statements = recorder.record {
      getDSLContext
        .update(USER)
        .set(USER.NAME, "nobody")
        .set(USER.EMAIL, null.asInstanceOf[String])
        .where(USER.UID.eq(-1))
        .execute()
      getDSLContext.selectOne().fetch()
    }

    statements.head.sql.count(_ == '?') shouldBe 3
    statements.head.values shouldBe Seq("nobody", null, -1)
    // A statement that binds nothing has no value.
    statements(1).values shouldBe empty
  }

  it should "leave out what is sent outside the block, before it, after it or in an earlier one" in {
    getDSLContext.selectOne().fetch()
    val first = recorder.record(getDSLContext.selectOne().fetch())
    getDSLContext.selectOne().fetch()
    val second = recorder.record(updateNobody())
    getDSLContext.selectOne().fetch()

    first.map(_.verb) shouldBe Seq("SELECT")
    second.map(_.verb) shouldBe Seq("UPDATE")
  }

  it should "record a statement whose failure the code that sent it swallows" in {
    val statements = recorder.record {
      Try(getDSLContext.execute("select * from no_such_table"))
    }
    statements.map(_.sql) shouldBe Seq("select * from no_such_table")
  }

  it should "record a statement that fails before it is sent, for want of a connection" in {
    // jOOQ gets the connection after it renders the statement and before executeStart, so a
    // recorder that only listened there would miss a read that never got a connection.
    val noConnection = getDSLContext
      .configuration()
      .derive(new ConnectionProvider {
        override def acquire(): Connection = throw new SQLException("no connection")
        override def release(connection: Connection): Unit = ()
      })
    val statements = recorder.record {
      Try(DSL.using(noConnection).selectOne().fetch())
      Try(DSL.using(noConnection).update(USER).set(USER.NAME, "nobody").execute())
    }
    statements.map(_.verb) shouldBe Seq("SELECT", "UPDATE")
    statements(1).values shouldBe Seq("nobody")
  }

  it should "record each statement of a batch of separate statements" in {
    val statements = recorder.record {
      getDSLContext
        .batch(
          getDSLContext.update(USER).set(USER.NAME, "nobody").where(USER.UID.eq(-1)),
          getDSLContext.deleteFrom(USER).where(USER.UID.eq(-1))
        )
        .execute()
    }
    statements.map(_.verb) shouldBe Seq("UPDATE", "DELETE")
    statements.map(_.values) shouldBe Seq(Seq("nobody", -1), Seq(-1))
  }

  it should "record a batch insert of several rows once, as the one statement it sends" in {
    // jOOQ builds the batch by stopping each row's INSERT before it is sent, with a signal it
    // does not report as a failure, so none of those stopped statements may be counted.
    val names = Seq("statement-recorder-spec-a", "statement-recorder-spec-b")
    val users = names.map { name =>
      val user = getDSLContext.newRecord(USER)
      user.setName(name)
      user.setEmail(s"$name-${UUID.randomUUID()}@example.com")
      user
    }
    try {
      val statements = recorder.record(getDSLContext.batchInsert(users.asJava).execute())
      statements.map(_.verb) shouldBe Seq("INSERT")
      // Each row binds its own values to the one text, so the statement is recorded with none.
      statements.head.values shouldBe empty
    } finally getDSLContext.deleteFrom(USER).where(USER.NAME.in(names: _*)).execute()
  }

  it should "record what a transaction sends through the context derived for it" in {
    val statements = recorder.record {
      SqlServer.withTransaction(getDSLContext)(_.selectOne().fetch())
    }
    statements.map(_.verb) shouldBe Seq("SELECT")
  }

  it should "record what other threads send while the block runs" in {
    val statements = recorder.record {
      val worker = new Thread(() => updateNobody(), "statement-recorder-spec-worker")
      worker.start()
      worker.join()
    }
    statements.map(s => (s.verb, s.thread)) shouldBe Seq(
      ("UPDATE", "statement-recorder-spec-worker")
    )
  }

  it should "refuse to record inside a recording, and record again afterwards" in {
    an[IllegalStateException] should be thrownBy recorder.record(recorder.record(()))
    recorder.record(getDSLContext.selectOne().fetch()).map(_.verb) shouldBe Seq("SELECT")
  }

  it should "name the code that sent each statement" in {
    val statements = recorder.record(getDSLContext.selectOne().fetch())
    statements.flatMap(_.site).map(_.getClassName) shouldBe Seq(getClass.getName)
  }

  private def frame(className: String): StackTraceElement =
    new StackTraceElement(className, "run", "Source.scala", 1)

  "siteOf" should "skip the recorder and the generated jOOQ classes to the code that asked" in {
    val caller = frame("org.apache.texera.web.service.ExecutionsMetadataPersistService$")
    siteOf(
      Seq(
        frame("java.lang.Thread"),
        frame("org.apache.texera.dao.StatementRecorder"),
        frame("org.jooq.impl.AbstractQuery"),
        frame("org.apache.texera.dao.jooq.generated.tables.daos.WorkflowExecutionsDao"),
        caller,
        frame("org.apache.texera.web.storage.ExecutionStateStore$")
      )
    ) shouldBe Some(caller)
  }

  it should "find nothing on a stack without Texera code" in {
    siteOf(Seq.empty) shouldBe None
    siteOf(Seq(frame("org.jooq.impl.AbstractQuery"), frame("java.lang.Thread"))) shouldBe None
    siteOf(Seq(frame("org.apache.texerafoo.Service"))) shouldBe None
    siteOf(Seq(frame("org.apache.texera.dao.StatementRecorder$"))) shouldBe None
  }

  "verb" should "be the first keyword, upper-cased, past leading space and parentheses" in {
    def verbOf(sql: String): String = Statement(sql, Seq.empty, "thread", None).verb
    verbOf("update \"user\" set name = ?") shouldBe "UPDATE"
    verbOf("  \n select 1") shouldBe "SELECT"
    verbOf("(select 1) union (select 2)") shouldBe "SELECT"
    verbOf("WITH t AS (select 1) select * from t") shouldBe "WITH"
    verbOf("") shouldBe ""
  }

  "tables" should "be the tables a statement names, without schema or quotes" in {
    def tablesOf(sql: String): Set[String] = Statement(sql, Seq.empty, "thread", None).tables
    tablesOf(
      """update "texera_db"."workflow_executions" set "outcome" = ? where "eid" = ?"""
    ) shouldBe
      Set("workflow_executions")
    tablesOf(
      """insert into "texera_db"."workflow_user_access" ("uid") values (?)"""
    ) shouldBe
      Set("workflow_user_access")
    tablesOf("""delete from "texera_db"."operator_port_cache" where "x" = ?""") shouldBe
      Set("operator_port_cache")
    // Every table of a join, whatever the join, and unquoted names in any case.
    tablesOf(
      """select "d"."name" from "texera_db"."dataset" as "d" left outer join "texera_db"."user"
        |on "user"."uid" = "d"."owner_uid" JOIN Dataset_Version on 1 = 1""".stripMargin
    ) shouldBe Set("dataset", "user", "dataset_version")
    // A table read only in a subquery, of a condition or of the table list.
    tablesOf(
      """update "workflow_executions" set "log_location" = ? where "vid" in
        |(select "vid" from "workflow_version" where "wid" = ?)""".stripMargin
    ) shouldBe Set("workflow_executions", "workflow_version")
    tablesOf("""select count(*) from (select 1 from "site_settings") as "t"""") shouldBe
      Set("site_settings")
    tablesOf("with t as (select 1 from site_settings) select * from t") shouldBe
      Set("site_settings", "t")
  }

  it should "name no table for a statement that reads none, or for an UPDATE that is not of a table" in {
    def tablesOf(sql: String): Set[String] = Statement(sql, Seq.empty, "thread", None).tables
    tablesOf("select 1") shouldBe empty
    tablesOf("select setval(pg_get_serial_sequence(?, ?), ?, true)") shouldBe empty
    tablesOf("") shouldBe empty
    // An upsert updates the table it inserts into, and a locking read updates none.
    tablesOf(
      """insert into "site_settings" ("key", "value") values (?, ?)
        |on conflict ("key") do update set "value" = ?""".stripMargin
    ) shouldBe Set("site_settings")
    tablesOf("""select "eid" from "workflow_executions" where "eid" = ? for update""") shouldBe
      Set("workflow_executions")
    tablesOf(
      """select "eid" from "workflow_executions" for update of "workflow_executions""""
    ) shouldBe
      Set("workflow_executions")
  }

  it should "be those of the statements jOOQ sends" in {
    val statements = recorder.record {
      updateNobody()
      getDSLContext.selectCount().from(USER).fetch()
    }
    statements.map(_.tables) shouldBe Seq(Set("user"), Set("user"))
  }
}
