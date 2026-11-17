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

package org.apache.texera.amber.operator.source.scan

import org.apache.arrow.memory.RootAllocator
import org.apache.arrow.vector.VectorSchemaRoot
import org.apache.arrow.vector.ipc.ArrowFileWriter
import org.apache.texera.amber.core.executor.{
  ExecFactory,
  ExecutorInputs,
  InputFile,
  OpExecWithClassName,
  OperatorInputs,
  SourceOperatorExecutor
}
import org.apache.texera.amber.core.storage.InputLink
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.source.scan.arrow.ArrowSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.{
  CSVScanSourceOpDesc,
  ParallelCSVScanSourceOpDesc
}
import org.apache.texera.amber.operator.source.scan.csvOld.CSVOldScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.FileScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.json.JSONLScanSourceOpDesc
import org.apache.texera.amber.util.ArrowUtils
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.{MockTexeraDB, SqlServer, StatementRecorder}
import org.jooq.ConnectionProvider
import org.jooq.impl.DSL
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.{FileOutputStream, IOException}
import java.net.ServerSocket
import java.nio.channels.Channels
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path}
import java.sql.{Connection, SQLException}
import java.time.Instant

/**
  * Every scan source's executor reads its file through the link its plan gives it, and through
  * nothing else: what lets a computing unit run a plan with no service to ask for a file.
  *
  * Each scan here is of a dataset's file, named as a user's resolver names one
  * (`dataset:///<repository>/<commit>/<file>`), which only LakeFS could find. Its bytes are
  * those of a local file, which its link leads to; the executor is the one a worker builds, from
  * the executor a plan's operator carries and what the plan says the operator reads.
  */
class ScanExecutorInputLinkSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  /**
    * A scan of one kind.
    *
    * @param newDescriptor its descriptor, set up but for its file
    * @param file          the local file whose bytes are the dataset file's
    * @param rows          what it reads from the file
    */
  private case class Scan(
      newDescriptor: () => ScanSourceOpDesc,
      file: Path,
      rows: List[List[Any]]
  ) {
    val fileName =
      s"dataset:///dataset-12/97fd4c2a755b69b7c66d322eab40b7e5c2ad5d10/${file.getFileName}"

    /** A link to the file's bytes, as a plan made to run carries one. */
    def link: InputLink = TestOperators.fixtureInputLinker.link(file.toUri)

    /** The scan's descriptor, of the dataset's file. */
    def descriptor: ScanSourceOpDesc = {
      val descriptor = newDescriptor()
      descriptor.fileName = Some(fileName)
      descriptor
    }

    /**
      * What a plan made to run gives the scan's executor, with `links` as the links to the files
      * it names: for a CSV scan, the column limit too.
      */
    def inputs(links: (String, InputLink)*): ExecutorInputs =
      TestOperators.executorInputs(
        OperatorInputs(
          files = links.map { case (name, link) => InputFile(name, link.url, link.expiresAtMs) },
          csvParserMaxColumns = Option.when(newDescriptor().isInstanceOf[CSVScanSourceOpDesc])(
            CSVScanSourceOpDesc.DefaultMaxColumns
          )
        )
      )
  }

  private var recorder: StatementRecorder = _
  private var directory: Path = _
  private var lakefsEndpoint: String = _
  private var scans: Seq[Scan] = _

  private def written(fileName: String, content: String): Path =
    Files.write(directory.resolve(fileName), content.getBytes(StandardCharsets.UTF_8))

  private def arrowFile(fileName: String, values: String*): Path = {
    val schema = Schema(List(new Attribute("name", AttributeType.STRING)))
    val file = directory.resolve(fileName)
    val allocator = new RootAllocator()
    val root = VectorSchemaRoot.create(ArrowUtils.fromTexeraSchema(schema), allocator)
    val out = new FileOutputStream(file.toFile)
    val writer = new ArrowFileWriter(root, null, Channels.newChannel(out))
    try {
      writer.start()
      root.allocateNew()
      values.zipWithIndex.foreach {
        case (value, row) =>
          ArrowUtils.setTexeraTuple(
            Tuple.builder(schema).addSequentially(Array[Any](value)).build(),
            row,
            root
          )
      }
      root.setRowCount(values.size)
      writer.writeBatch()
      writer.end()
    } finally {
      writer.close()
      root.close()
      allocator.close()
      out.close()
    }
    file
  }

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    recorder = StatementRecorder.installOn(getDSLContext)
    // Nothing answers at LakeFS's address either: a read that asked LakeFS would fail.
    lakefsEndpoint = StorageConfig.lakefsEndpoint
    StorageConfig.lakefsEndpoint = {
      val socket = new ServerSocket(0)
      try s"http://127.0.0.1:${socket.getLocalPort}/api/v1"
      finally socket.close()
    }
    directory = Files.createTempDirectory("scan-executor-input-link-spec")

    val people = List(List(1, "Ada"), List(2, "Grace"))
    scans = Seq(
      Scan(
        () => {
          val descriptor = new CSVScanSourceOpDesc
          descriptor.customDelimiter = Some(",")
          descriptor
        },
        written("people.csv", "id,name\n1,Ada\n2,Grace\n"),
        people
      ),
      Scan(
        () => {
          val descriptor = new ParallelCSVScanSourceOpDesc
          descriptor.customDelimiter = Some(",")
          descriptor
        },
        written("people-parallel.csv", "id,name\n1,Ada\n2,Grace\n"),
        people
      ),
      Scan(
        () => new CSVOldScanSourceOpDesc,
        written("people-old.csv", "id,name\n1,Ada\n2,Grace\n"),
        people
      ),
      Scan(
        () => new JSONLScanSourceOpDesc,
        written("people.jsonl", """{"id":1,"name":"Ada"}""" + "\n" + """{"id":2,"name":"Grace"}"""),
        people
      ),
      Scan(
        () => new ArrowSourceOpDesc,
        arrowFile("people.arrow", "Ada", "Grace"),
        List(List("Ada"), List("Grace"))
      ),
      Scan(
        () => new FileScanSourceOpDesc,
        written("people.txt", "Ada\nGrace"),
        List(List("Ada"), List("Grace"))
      )
    )
  }

  override protected def afterAll(): Unit = {
    StorageConfig.lakefsEndpoint = lakefsEndpoint
    Files.list(directory).forEach(file => Files.deleteIfExists(file))
    Files.deleteIfExists(directory)
    closeConnectionPool()
  }

  /**
    * The executor a worker builds for `descriptor`, from what its plan's operator carries and
    * the `inputs` the plan gives the operator.
    */
  private def executorOf(
      descriptor: ScanSourceOpDesc,
      inputs: ExecutorInputs
  ): SourceOperatorExecutor =
    descriptor.getPhysicalOp(WorkflowIdentity(1), ExecutionIdentity(1)).opExecInitInfo match {
      case OpExecWithClassName(className, descString) =>
        ExecFactory
          .newExecFromJavaClassName(className, descString, inputs = inputs)
          .asInstanceOf[SourceOperatorExecutor]
      case other =>
        fail(s"${descriptor.getClass.getSimpleName} runs no executor of a class: $other")
    }

  /**
    * The rows the executor of `descriptor` reads when given `inputs`, from when it is built to
    * when it is closed.
    */
  private def rowsOf(descriptor: ScanSourceOpDesc, inputs: ExecutorInputs): List[List[Any]] = {
    val executor = executorOf(descriptor, inputs)
    executor.open()
    try executor.produceTuple().map(_.getFields.toList).toList
    finally executor.close()
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

  /** The copies of linked files that executors have left in the temporary directory. */
  private def copies: Set[String] =
    Option(new java.io.File(System.getProperty("java.io.tmpdir")).list())
      .map(_.toSet)
      .getOrElse(Set.empty[String])
      .filter(_.startsWith("inputFile"))

  "A scan source's executor" should
    "read its file through its plan's link, with the database and LakeFS out of reach" in {
    scans.foreach { scan =>
      withClue(s"${scan.newDescriptor().getClass.getSimpleName}: ") {
        val copiesBefore = copies
        val statements = whileDatabaseUnreachable {
          rowsOf(scan.descriptor, scan.inputs(scan.fileName -> scan.link)) shouldBe scan.rows
        }

        statements shouldBe empty
        // A scan that needs its file on disk copies it there, and removes the copy when it closes.
        (copies -- copiesBefore) shouldBe empty
      }
    }
  }

  it should "refuse a file its plan gives it no link to, wherever the file is" in {
    scans.foreach { scan =>
      withClue(s"${scan.newDescriptor().getClass.getSimpleName}: ") {
        def refused(descriptor: ScanSourceOpDesc, inputs: ExecutorInputs): String =
          intercept[IllegalStateException](rowsOf(descriptor, inputs)).getMessage

        refused(scan.descriptor, scan.inputs()) shouldBe
          s"The operator has no link to ${scan.fileName}: its plan was not made to run."
        // A link to another file is none to this one.
        refused(
          scan.descriptor,
          scan.inputs("dataset:///dataset-12/c0ffee/other" -> scan.link)
        ) shouldBe s"The operator has no link to ${scan.fileName}: its plan was not made to run."
        // Nor is a file on the executor's own disk read without one.
        val local = scan.newDescriptor()
        local.setResolvedFileName(scan.file.toUri)
        refused(local, scan.inputs()) shouldBe
          s"The operator has no link to ${scan.file.toUri.toASCIIString}: its plan was not " +
            "made to run."
      }
    }
  }

  it should "fail, saying when its link expired, once the link has" in {
    val expiredAt = Instant.parse("2024-02-29T12:00:00Z")
    scans.foreach { scan =>
      withClue(s"${scan.newDescriptor().getClass.getSimpleName}: ") {
        val expired = scan.link.copy(expiresAtMs = expiredAt.toEpochMilli)

        val thrown = intercept[IOException] {
          rowsOf(scan.descriptor, scan.inputs(scan.fileName -> expired))
        }

        thrown.getMessage shouldBe
          s"The link to ${scan.fileName} expired at 2024-02-29T12:00:00Z; run the workflow again."
      }
    }
  }

  it should "fail on its next read of the file when its link expires while it runs" in {
    // Built while its link is good, when it reads the file for its schema; opened once the link
    // has expired, when it reads the file again for its rows.
    val scan = scans.head
    val expiresAtMs = System.currentTimeMillis() + 1500
    val executor = executorOf(
      scan.descriptor,
      scan.inputs(scan.fileName -> scan.link.copy(expiresAtMs = expiresAtMs))
    )
    Thread.sleep(math.max(0L, expiresAtMs + 50 - System.currentTimeMillis()))

    val thrown = intercept[IOException](executor.open())

    thrown.getMessage shouldBe s"The link to ${scan.fileName} expired at " +
      s"${Instant.ofEpochMilli(expiresAtMs)}; run the workflow again."
    executor.close()
  }

  it should "refuse a link that leads anywhere but the object store, before it reads anything" in {
    scans.foreach { scan =>
      withClue(s"${scan.newDescriptor().getClass.getSimpleName}: ") {
        val elsewhere = scan.link.copy(url = "http://169.254.169.254/latest/meta-data/")

        val thrown = intercept[IllegalArgumentException] {
          executorOf(scan.descriptor, scan.inputs(scan.fileName -> elsewhere))
        }

        thrown.getMessage should startWith(
          s"Refusing to read ${scan.fileName}: its link points at http://169.254.169.254:80, " +
            "and input files are read only from "
        )
      }
    }
  }
}
