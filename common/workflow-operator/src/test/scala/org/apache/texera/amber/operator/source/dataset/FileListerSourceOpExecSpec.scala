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

package org.apache.texera.amber.operator.source.dataset

import org.apache.texera.amber.core.executor.{
  ExecFactory,
  OpExecWithClassName,
  SourceOperatorExecutor
}
import org.apache.texera.amber.core.tuple.SchemaEnforceable
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.PortIdentity
import org.apache.texera.dao.{MockTexeraDB, SqlServer, StatementRecorder}
import org.jooq.ConnectionProvider
import org.jooq.impl.DSL
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.sql.{Connection, SQLException}

/**
  * A File Lister's executor outputs the listing its plan carries, and lists no dataset version
  * itself: a computing unit runs a plan without asking Postgres which version a path names, or
  * LakeFS which files the version holds. The executor is the one a worker builds, from what the
  * plan's operator carries.
  */
class FileListerSourceOpExecSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val versionPath = "/dataset/ada@texera.io/letters/v1"
  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  /** A File Lister of the version at `versionPath`, as a compile leaves it with `listing`. */
  private def planned(listing: Option[List[String]]): FileListerSourceOpDesc = {
    val descriptor = new FileListerSourceOpDesc
    descriptor.datasetVersionPath = versionPath
    descriptor.listing = listing
    descriptor
  }

  /** The executor a worker builds for `descriptor`, from what its plan's operator carries. */
  private def executorOf(descriptor: FileListerSourceOpDesc): SourceOperatorExecutor =
    descriptor.getPhysicalOp(WorkflowIdentity(1), ExecutionIdentity(1)).opExecInitInfo match {
      case OpExecWithClassName(className, descString) =>
        ExecFactory
          .newExecFromJavaClassName(className, descString)
          .asInstanceOf[SourceOperatorExecutor]
      case other => fail(s"a File Lister runs no executor of a class: $other")
    }

  /** The file names the executor of `descriptor` outputs, from its tuples' `filename` column. */
  private def outputOf(descriptor: FileListerSourceOpDesc): List[String] = {
    val schema = descriptor.getExternalOutputSchemas(Map.empty)(PortIdentity())
    val executor = executorOf(descriptor)
    executor.open()
    try {
      executor
        .produceTuple()
        .map(_.asInstanceOf[SchemaEnforceable].enforceSchema(schema).getField[String]("filename"))
        .toList
    } finally executor.close()
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

  "FileListerSourceOpExec" should "output its plan's listing, a tuple for each file, in its order" in {
    // Not in the order of the names: the order is the listing's to keep.
    val listing = List(
      s"$versionPath/b.txt",
      s"$versionPath/2024/q1/sales report.csv",
      s"$versionPath/a.txt",
      s"$versionPath/données/été.csv"
    )

    outputOf(planned(Some(listing))) shouldBe listing
  }

  it should "output nothing for a version that was listed and holds no file" in {
    outputOf(planned(Some(Nil))) shouldBe empty
  }

  it should "list while the database cannot be reached, without trying to reach it" in {
    val listing = List(s"$versionPath/a.txt", s"$versionPath/b.txt")

    val statements = whileDatabaseUnreachable {
      outputOf(planned(Some(listing))) shouldBe listing
    }

    statements shouldBe empty
  }

  it should "refuse a descriptor that carries no listing, rather than list the version itself" in {
    val statements = recorder.record {
      val thrown = intercept[IllegalStateException](executorOf(planned(None)))

      thrown.getMessage shouldBe "File Lister has no listing: its plan was not made to run."
    }

    statements shouldBe empty
  }
}
