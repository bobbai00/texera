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
    }
    statements.map(_.verb) shouldBe Seq("SELECT")
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
    def verbOf(sql: String): String = Statement(sql, "thread", None).verb
    verbOf("update \"user\" set name = ?") shouldBe "UPDATE"
    verbOf("  \n select 1") shouldBe "SELECT"
    verbOf("(select 1) union (select 2)") shouldBe "SELECT"
    verbOf("WITH t AS (select 1) select * from t") shouldBe "WITH"
    verbOf("") shouldBe ""
  }
}
