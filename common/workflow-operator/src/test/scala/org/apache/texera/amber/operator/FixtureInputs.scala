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

package org.apache.texera.amber.operator

import com.sun.net.httpserver.{HttpExchange, HttpServer}
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.executor.{ExecutorInputs, InputFile, OperatorInputs}
import org.apache.texera.amber.core.storage.{
  DatasetVersionLister,
  InputFileLocator,
  InputLink,
  InputLinker,
  ListedFile
}
import org.apache.texera.amber.operator.source.scan.ScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc

import java.net.{HttpURLConnection, InetAddress, InetSocketAddress, URI}
import java.nio.file.{Files, Path, Paths}
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{ConcurrentHashMap, Executors, TimeUnit}

/**
  * What stands in, in tests, for the object store a plan's operators read their files from: a
  * server of this JVM's that serves fixture files of the local disk, the locator that says
  * where they are kept, the linker that links them, and a dataset version of two of them with
  * its lister. An executor reads the links only when it is given the server's address
  * ([[linkEndpoints]]), as a computing unit reads links from the object store it is set up with.
  */
object FixtureInputs {

  private lazy val server = new FileServer

  /**
    * Says where the fixture files are kept, as a compile for a run asks where LakeFS keeps a
    * dataset's: a fixture file is kept where it is, on the local disk. Tests hand this to the
    * compiler in place of the deployment's locator, which asks LakeFS.
    */
  val locator: InputFileLocator = fileUri => {
    if (!Files.isRegularFile(Paths.get(fileUri))) {
      throw new FileNotFoundException(s"Local file ${Paths.get(fileUri)} does not exist")
    }
    fileUri.toString
  }

  /**
    * Links the fixture files from where [[locator]] and [[lister]] say they are kept, as the
    * Dashboard service links the files of a plan: each to a GET on the server. Tests link a
    * compiled plan with this in place of the deployment's linker, which signs links to the
    * object store. A file is linked once, so two compiles of one workflow make one plan.
    */
  val linker: InputLinker = physicalAddress => server.link(Paths.get(new URI(physicalAddress)))

  /** The link to the fixture file at `fileUri`, as a plan made to run and then linked has it. */
  def linkTo(fileUri: URI): InputLink = linker.link(locator.locate(fileUri))

  /** The endpoints an executor is given to read what [[linker]] links: the server's. */
  def linkEndpoints: Seq[String] = Seq(server.endpoint)

  /** The dataset version [[lister]] lists. */
  val datasetVersionPath = "/dataset/owner@x.com/sales/v1"

  /**
    * The files of the fixture dataset version: by its path within the version, the fixture file
    * on the local disk whose bytes are the file's.
    */
  val datasetFiles: Seq[(String, String)] =
    Seq(
      "line_numbers.txt" -> TestOperators.TestTextFilePath,
      "reports/numbers.txt" -> TestOperators.TestNumbersFilePath
    )

  /**
    * Lists the fixture dataset version, as a user's lister lists the versions that user may
    * read; tests hand it to the compiler in place of one, which needs a database and LakeFS. A
    * file is kept where its fixture file is, on the local disk, so [[linker]] links what this
    * lists. Any other version is refused, as one that does not exist or that the user may not
    * read is.
    */
  val lister: DatasetVersionLister = (versionPath, atMost) => {
    if (versionPath != datasetVersionPath) {
      throw new FileNotFoundException(s"Version $versionPath not found.")
    }
    datasetFiles.take(atMost).map {
      case (file, localPath) =>
        ListedFile(s"$versionPath/$file", Paths.get(localPath).toUri.toString)
    }
  }

  /**
    * What a plan made to run hands the executor of `scan`: its file, linked by [[linker]], and
    * for a CSV scan the default column limit. For a test that builds a scan's executor from a
    * descriptor it did not compile.
    */
  def inputsOf(scan: ScanSourceOpDesc): ExecutorInputs =
    inputsOf(
      scan,
      Option.when(scan.isInstanceOf[CSVScanSourceOpDesc])(CSVScanSourceOpDesc.DefaultMaxColumns)
    )

  /** As `inputsOf(scan)`, with the column limit a plan gives, or none. */
  def inputsOf(scan: ScanSourceOpDesc, csvParserMaxColumns: Option[Int]): ExecutorInputs = {
    val fileName = scan.fileName.get
    val link = linkTo(new URI(fileName))
    executorInputs(
      OperatorInputs(
        files = Seq(InputFile(fileName, link.url, link.expiresAtMs)),
        csvParserMaxColumns = csvParserMaxColumns
      )
    )
  }

  /** `inputs` as an executor that may read from the server is handed them. */
  def executorInputs(inputs: OperatorInputs): ExecutorInputs =
    new ExecutorInputs(inputs, linkEndpoints)

  /**
    * Serves the files [[linker]] linked, and nothing else, on the loopback interface. The first
    * link, or the first reader that asks where it is, starts it.
    */
  private class FileServer {
    private val files = new ConcurrentHashMap[String, Path]()
    private val links = new ConcurrentHashMap[Path, InputLink]()
    private val linksMade = new AtomicInteger()
    private val server =
      HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress, 0), 0)
    server.createContext("/", (exchange: HttpExchange) => serve(exchange))
    // Daemon threads, so that no JVM waits for the server to end. Its own thread takes after
    // the one that starts it.
    server.setExecutor(Executors.newCachedThreadPool(daemon("fixture-file-server", _)))
    private val starter = daemon("fixture-file-server-starter", () => server.start())
    starter.start()
    starter.join()

    val endpoint = s"http://127.0.0.1:${server.getAddress.getPort}"

    /** The link to `file`, made the first time it is asked for. It lasts a day: past any test. */
    def link(file: Path): InputLink = {
      if (!Files.isRegularFile(file)) {
        throw new FileNotFoundException(s"Local file $file does not exist")
      }
      links.computeIfAbsent(
        file,
        _ => {
          val path = s"/${linksMade.incrementAndGet()}"
          files.put(path, file)
          InputLink(endpoint + path, System.currentTimeMillis() + TimeUnit.DAYS.toMillis(1))
        }
      )
    }

    private def daemon(name: String, task: Runnable): Thread = {
      val thread = new Thread(task, name)
      thread.setDaemon(true)
      thread
    }

    private def serve(exchange: HttpExchange): Unit =
      try {
        Option(files.get(exchange.getRequestURI.getPath)).filter(_ =>
          exchange.getRequestMethod == "GET"
        ) match {
          case Some(file) =>
            // A length of 0 would mean a body of no declared length, so an empty file has none.
            val size = Files.size(file)
            exchange.sendResponseHeaders(HttpURLConnection.HTTP_OK, if (size == 0) -1 else size)
            if (size > 0) Files.copy(file, exchange.getResponseBody)
          case None =>
            exchange.sendResponseHeaders(HttpURLConnection.HTTP_NOT_FOUND, -1)
        }
      } finally exchange.close()
  }
}
