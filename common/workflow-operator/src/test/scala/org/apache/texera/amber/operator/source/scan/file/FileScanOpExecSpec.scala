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

package org.apache.texera.amber.operator.source.scan.file

import org.apache.texera.amber.core.executor.{
  ExecFactory,
  InputFile,
  OpExecWithClassName,
  OperatorExecutor,
  OperatorInputs
}
import org.apache.texera.amber.core.storage.InputLink
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.source.scan.FileAttributeType
import org.apache.texera.dao.{MockTexeraDB, SqlServer, StatementRecorder}
import org.jooq.ConnectionProvider
import org.jooq.impl.DSL
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.{FileNotFoundException, IOException}
import java.nio.file.Paths
import java.sql.{Connection, SQLException}
import java.time.Instant

/**
  * A File Scan From Input's executor reads the files its input tuples name through the links its
  * plan gives it, and through nothing else: a name the plan has no link to is refused, whatever
  * it names and wherever a file of that name may be. So a computing unit reads only the files a
  * File Lister listed when the plan was made, and asks no service for a file.
  *
  * The files here are named as a File Lister names the files of a dataset version, which only
  * Postgres and LakeFS could find. Their bytes are those of local fixture files, which their
  * links lead to; the executor is the one a worker builds, from what the plan's operator
  * carries.
  */
class FileScanOpExecSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val versionPath = "/dataset/ada@texera.io/letters/v1"
  private val lines = s"$versionPath/line_numbers.txt"
  private val numbers = s"$versionPath/reports/numbers.txt"

  private var recorder: StatementRecorder = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  /** A link to the bytes of the local file at `path`, as a plan made to run carries one. */
  private def linkTo(path: String): InputLink =
    TestOperators.fixtureInputLinker.link(TestOperators.localFileUri(path))

  /** The links of a plan whose File Listers listed the two files above. */
  private def listed: Map[String, InputLink] =
    Map(
      lines -> linkTo(TestOperators.TestTextFilePath),
      numbers -> linkTo(TestOperators.TestNumbersFilePath)
    )

  /**
    * The executor a worker builds for a File Scan From Input set up by `configure`, from what
    * its plan's operator carries, with `links` as the links the plan gives the operator.
    */
  private def executorOf(
      links: Map[String, InputLink] = listed,
      configure: FileScanOpDesc => Unit = _ => ()
  ): OperatorExecutor = {
    val descriptor = new FileScanOpDesc
    configure(descriptor)
    val inputs = TestOperators.executorInputs(
      OperatorInputs(files = links.toSeq.sortBy(_._1).map {
        case (name, link) => InputFile(name, link.url, link.expiresAtMs)
      })
    )
    descriptor.getPhysicalOp(WorkflowIdentity(1), ExecutionIdentity(1)).opExecInitInfo match {
      case OpExecWithClassName(className, descString) =>
        ExecFactory
          .newExecFromJavaClassName(className, descString, inputs = inputs)
          .asInstanceOf[OperatorExecutor]
      case other => fail(s"a File Scan From Input runs no executor of a class: $other")
    }
  }

  private val fileNames = new Schema(new Attribute("filename", AttributeType.STRING))

  /** What `executor` outputs for an input tuple that names `fileName`: each tuple's fields. */
  private def rowsOf(executor: OperatorExecutor, fileName: String): List[List[Any]] =
    executor.processTuple(Tuple(fileNames, Array[Any](fileName)), 0).map(_.getFields.toList).toList

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

  private def notListed(fileName: String): String =
    "File Scan From Input reads only files listed by a File Lister upstream of it; " +
      s"$fileName is not one of them."

  "FileScanOpExec" should
    "read each file its input tuples name through its plan's link, with the database out of reach" in {
    val executor = executorOf()

    val statements = whileDatabaseUnreachable {
      rowsOf(executor, lines) shouldBe (1 to 10).map(n => List(s"line$n")).toList
      rowsOf(executor, numbers) shouldBe (1 to 10).map(n => List(n.toString)).toList
    }

    statements shouldBe empty
  }

  it should "read the lines of the window its descriptor asks for" in {
    def scanned(configure: FileScanOpDesc => Unit): List[List[Any]] =
      rowsOf(executorOf(configure = configure), lines)

    scanned(_.fileScanLimit = Some(5)) shouldBe (1 to 5).map(n => List(s"line$n")).toList
    scanned(_.fileScanOffset = Some(5)) shouldBe (6 to 10).map(n => List(s"line$n")).toList
  }

  it should "read a file as the type its descriptor asks for" in {
    val asIntegers = executorOf(configure = _.attributeType = FileAttributeType.INTEGER)

    rowsOf(asIntegers, numbers) shouldBe (1 to 10).map(n => List(n)).toList
  }

  it should "name each file as its input tuple names it, when it outputs the file's name" in {
    val executor = executorOf(configure = { descriptor =>
      descriptor.attributeType = FileAttributeType.SINGLE_STRING
      descriptor.outputFileName = true
    })

    rowsOf(executor, numbers) shouldBe List(List(numbers, (1 to 10).mkString("\n")))
  }

  it should "take the first string of an input tuple as the file's name, whichever column it is" in {
    val idThenName = new Schema(
      new Attribute("id", AttributeType.INTEGER),
      new Attribute("filename", AttributeType.STRING)
    )
    val executor = executorOf(configure = _.fileScanLimit = Some(1))

    val rows = executor.processTuple(Tuple(idThenName, Array[Any](7, lines)), 0).toList

    rows.map(_.getFields.toList) shouldBe List(List("line1"))
  }

  it should "refuse a file its plan gives it no link to, whatever names it and wherever it is" in {
    val executor = executorOf()
    val refused = Seq(
      // A file of the version that no File Lister upstream listed.
      s"$versionPath/unlisted.txt",
      // A listed file, by another spelling of its name.
      "/ada@texera.io/letters/v1/line_numbers.txt",
      // A file as a resolver resolves one, which LakeFS would be asked for.
      "dataset:///dataset-12/97fd4c2a755b69b7c66d322eab40b7e5c2ad5d10/line_numbers.txt",
      // A file on the disk of whatever runs the executor, by its path and as a URI.
      TestOperators.TestTextFilePath,
      Paths.get(TestOperators.TestTextFilePath).toUri.toString
    )

    val statements = recorder.record {
      refused.foreach { fileName =>
        val thrown = intercept[FileNotFoundException](rowsOf(executor, fileName))

        thrown.getMessage shouldBe notListed(fileName)
      }
    }

    // No name was looked up.
    statements shouldBe empty
    // A refusal is of its tuple alone: the files listed are read as before.
    rowsOf(executor, numbers) should have size 10
  }

  it should "refuse every file when its plan gives it no link, as a plan not made to run" in {
    val executor = executorOf(links = Map.empty)

    intercept[FileNotFoundException](rowsOf(executor, lines)).getMessage shouldBe notListed(lines)
  }

  it should "fail on a file whose link has expired, saying when, and go on reading the others" in {
    val expiredAt = Instant.parse("2024-02-29T12:00:00Z")
    val expired = linkTo(TestOperators.TestTextFilePath).copy(expiresAtMs = expiredAt.toEpochMilli)
    val executor = executorOf(links = listed + (lines -> expired))

    val thrown = intercept[IOException](rowsOf(executor, lines))

    thrown.getMessage shouldBe
      s"The link to $lines expired at 2024-02-29T12:00:00Z; run the workflow again."
    rowsOf(executor, numbers) should have size 10
  }

  it should "refuse a link that leads anywhere but the object store, before it reads anything" in {
    val elsewhere =
      linkTo(TestOperators.TestTextFilePath).copy(url = "http://169.254.169.254/latest/meta-data/")
    val executor = executorOf(links = listed + (lines -> elsewhere))

    val thrown = intercept[IllegalArgumentException](rowsOf(executor, lines))

    thrown.getMessage should startWith(
      s"Refusing to read $lines: its link points at http://169.254.169.254:80, and input files " +
        "are read only from "
    )
  }
}
