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
import org.apache.texera.amber.core.storage.{
  DatasetVersionLister,
  FileResolver,
  InputLink,
  InputLinker,
  ListedFile,
  RepositoryVersionResolver,
  ScanFileResolver
}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType}
import org.apache.texera.amber.operator.aggregate.{
  AggregateOpDesc,
  AggregationFunction,
  AggregationOperation
}
import org.apache.texera.amber.operator.hashJoin.HashJoinOpDesc
import org.apache.texera.amber.operator.keywordSearch.KeywordSearchOpDesc
import org.apache.texera.amber.operator.source.scan.ScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.json.JSONLScanSourceOpDesc
import org.apache.texera.amber.operator.source.sql.asterixdb.AsterixDBSourceOpDesc
import org.apache.texera.amber.operator.udf.python.PythonUDFOpDescV2
import org.apache.texera.amber.operator.udf.python.source.PythonUDFSourceOpDescV2
import org.apache.texera.common.config.StorageConfig

import java.net.{HttpURLConnection, InetAddress, InetSocketAddress, URI}
import java.nio.file.{Files, Path, Paths}
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{ConcurrentHashMap, Executors, TimeUnit}

object TestOperators {

  /**
    * The URI of a fixture file on the local disk.
    *
    * @throws FileNotFoundException if there is no such file
    */
  def localFileUri(path: String): URI = {
    val filePath = Paths.get(path)
    if (!Files.exists(filePath)) {
      throw new FileNotFoundException(s"Local file $path does not exist")
    }
    filePath.toUri
  }

  /**
    * Resolves the fixture files the scan operators below read: a path on the local disk, or the
    * `file:` URI one of them was already given. Tests hand this to the compiler in place of a
    * user's resolver, which knows nothing about local files.
    */
  val fixtureFileResolver: ScanFileResolver = fileName =>
    if (FileResolver.isFileResolved(fileName)) new URI(fileName) else localFileUri(fileName)

  /**
    * Links the fixture files, as a plan made to run links the files of a dataset: each to a GET
    * on a server of this JVM's, which stands in for the object store ([[FixtureFileServer]]).
    * Tests hand this to the compiler in place of the deployment's linker, which signs links to
    * the store itself. A file is linked once, so two compiles of one workflow make one plan.
    */
  val fixtureInputLinker: InputLinker = new InputLinker {
    override def link(fileUri: URI): InputLink = fixtureFileServer.link(Paths.get(fileUri))

    override def linkListed(file: ListedFile): InputLink =
      fixtureFileServer.link(Paths.get(new URI(file.physicalAddress)))
  }

  /**
    * `scan` with the file it reads linked by [[fixtureInputLinker]], as a compile that makes a
    * plan to run links it: for a test that builds a scan's executor from a descriptor it did
    * not compile.
    */
  def linked[T <: ScanSourceOpDesc](scan: T): T = {
    val fileName = scan.fileName.get
    scan.inputLinks = Map(fileName -> fixtureInputLinker.link(new URI(fileName)))
    scan
  }

  private lazy val fixtureFileServer = new FixtureFileServer

  /**
    * Serves the files [[fixtureInputLinker]] linked, and nothing else, on the loopback
    * interface. The first link starts it, and from then on every executor of this JVM may read
    * links from it (`StorageConfig.inputLinksAllowedEndpoints`), as a computing unit may from
    * its object store.
    */
  private class FixtureFileServer {
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
    private val endpoint = s"http://127.0.0.1:${server.getAddress.getPort}"
    StorageConfig.inputLinksAllowedEndpoints :+= endpoint

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

  /** The dataset and model versions `fixtureRepositoryResolver` pins, to repository and commit. */
  val fixtureRepositoryVersions: Map[String, (String, String)] = Map(
    "/dataset/owner@x.com/sales/v1" -> ("dataset-1", "d4t4"),
    "/model/owner@x.com/iris/v2" -> ("model-1", "m0d3l")
  )

  /**
    * Pins the versions above, as a user's resolver pins the versions that user may read; tests
    * hand it to the compiler in place of one, which needs a database. Any other version is
    * refused, as one that does not exist or that the user may not read is.
    */
  val fixtureRepositoryResolver: RepositoryVersionResolver = versionPath =>
    fixtureRepositoryVersions.getOrElse(
      versionPath,
      throw new FileNotFoundException(s"Version $versionPath not found.")
    )

  /** The directory a plan compiled in tests reads its datasets and models under. */
  val fixtureMountRoot: Path = Paths.get("/mnt/texera-mounts")

  val parentDir = Path
    .of(sys.env.getOrElse("TEXERA_HOME", "."))
    .resolve("common")
    .resolve("workflow-operator")
    .toRealPath()
    .toString
  val CountrySalesSmallCsvPath = s"$parentDir/src/test/resources/country_sales_small.csv"
  val CountrySalesMediumCsvPath = s"$parentDir/src/test/resources/country_sales_medium.csv"
  val CountrySalesHeaderlessSmallCsvPath =
    s"$parentDir/src/test/resources/country_sales_headerless_small.csv"
  val CountrySalesSmallMultiLineCsvPath =
    s"$parentDir/src/test/resources/country_sales_small_multi_line.csv"
  val CountrySalesSmallMultiLineCustomDelimiterCsvPath =
    s"$parentDir/src/test/resources/country_sales_headerless_small_multi_line_custom_delimiter.csv"
  val smallJsonLPath =
    s"$parentDir/src/test/resources/100.jsonl"
  val mediumJsonLPath =
    s"$parentDir/src/test/resources/1000.jsonl"
  val TestTextFilePath: String = s"$parentDir/src/test/resources/line_numbers.txt"
  val TestCRLFTextFilePath: String = s"$parentDir/src/test/resources/line_numbers_crlf.txt"
  val TestNumbersFilePath: String = s"$parentDir/src/test/resources/numbers.txt"

  /** The dataset version `fixtureDatasetVersionLister` lists. */
  val fixtureDatasetVersionPath = "/dataset/owner@x.com/sales/v1"

  /**
    * The files of the fixture dataset version: by its path within the version, the fixture file
    * on the local disk whose bytes are the file's.
    */
  val fixtureDatasetFiles: Seq[(String, String)] =
    Seq("line_numbers.txt" -> TestTextFilePath, "reports/numbers.txt" -> TestNumbersFilePath)

  /**
    * Lists the fixture dataset version, as a user's lister lists the versions that user may
    * read; tests hand it to the compiler in place of one, which needs a database and LakeFS. A
    * file is kept where its fixture file is, on the local disk, so `fixtureInputLinker` links
    * what this lists. Any other version is refused, as one that does not exist or that the user
    * may not read is.
    */
  val fixtureDatasetVersionLister: DatasetVersionLister = (versionPath, atMost) => {
    if (versionPath != fixtureDatasetVersionPath) {
      throw new FileNotFoundException(s"Version $versionPath not found.")
    }
    fixtureDatasetFiles.take(atMost).map {
      case (file, localPath) =>
        ListedFile(s"$versionPath/$file", Paths.get(localPath).toUri.toString)
    }
  }

  def headerlessSmallCsvScanOpDesc(): CSVScanSourceOpDesc = {
    getCsvScanOpDesc(CountrySalesHeaderlessSmallCsvPath, header = false)
  }

  def headerlessSmallMultiLineDataCsvScanOpDesc(): CSVScanSourceOpDesc = {
    getCsvScanOpDesc(
      CountrySalesHeaderlessSmallCsvPath,
      header = false,
      multiLine = true
    )
  }

  def smallCsvScanOpDesc(): CSVScanSourceOpDesc = {
    getCsvScanOpDesc(CountrySalesSmallCsvPath, header = true)
  }

  def smallJSONLScanOpDesc(): JSONLScanSourceOpDesc = {
    getJSONLScanOpDesc(smallJsonLPath)
  }

  def mediumFlattenJSONLScanOpDesc(): JSONLScanSourceOpDesc = {
    getJSONLScanOpDesc(mediumJsonLPath, flatten = true)
  }

  def getCsvScanOpDesc(
      fileName: String,
      header: Boolean,
      multiLine: Boolean = false
  ): CSVScanSourceOpDesc = {
    val csvHeaderlessOp = new CSVScanSourceOpDesc()
    csvHeaderlessOp.fileName = Some(fileName)
    csvHeaderlessOp.customDelimiter = Some(",")
    csvHeaderlessOp.hasHeader = header
    csvHeaderlessOp.setResolvedFileName(localFileUri(fileName))
    csvHeaderlessOp

  }

  def getJSONLScanOpDesc(fileName: String, flatten: Boolean = false): JSONLScanSourceOpDesc = {
    val jsonlOp = new JSONLScanSourceOpDesc
    jsonlOp.fileName = Some(fileName)
    jsonlOp.flatten = flatten
    jsonlOp.setResolvedFileName(localFileUri(fileName))
    jsonlOp
  }

  def joinOpDesc(buildAttrName: String, probeAttrName: String): HashJoinOpDesc[String] = {
    val joinOp = new HashJoinOpDesc[String]()
    joinOp.buildAttributeName = buildAttrName
    joinOp.probeAttributeName = probeAttrName
    joinOp
  }

  def mediumCsvScanOpDesc(): CSVScanSourceOpDesc = {
    getCsvScanOpDesc(CountrySalesMediumCsvPath, header = true)
  }

  def keywordSearchOpDesc(attribute: String, keywordToSearch: String): KeywordSearchOpDesc = {
    val keywordSearchOp = new KeywordSearchOpDesc()
    keywordSearchOp.attribute = attribute
    keywordSearchOp.keyword = keywordToSearch
    keywordSearchOp
  }

  def aggregateAndGroupByDesc(
      attributeToAggregate: String,
      aggFunction: AggregationFunction,
      groupByAttributes: List[String]
  ): AggregateOpDesc = {
    val aggOp = new AggregateOpDesc()
    val aggFunc = new AggregationOperation()
    aggFunc.aggFunction = aggFunction
    aggFunc.attribute = attributeToAggregate
    aggFunc.resultAttribute = "aggregate-result"
    aggOp.aggregations = List(aggFunc)
    aggOp.groupByKeys = groupByAttributes
    aggOp
  }

  // TODO: use mock data to perform the test, remove dependency on the real AsterixDB
  def asterixDBSourceOpDesc(): AsterixDBSourceOpDesc = {
    val asterixDBOp = new AsterixDBSourceOpDesc()
    asterixDBOp.host = "ipubmed4.ics.uci.edu" // AsterixDB at version 0.9.5
    asterixDBOp.port = "default"
    asterixDBOp.database = "twitter"
    asterixDBOp.table = "ds_tweet"
    asterixDBOp.limit = Some(1000)
    asterixDBOp
  }

  def pythonOpDesc(): PythonUDFOpDescV2 = {
    val udf = new PythonUDFOpDescV2()
    udf.workers = 1
    udf.retainInputColumns = true
    udf.code = """
        |from pytexera import *
        |
        |class ProcessTupleOperator(UDFOperatorV2):
        |    @overrides
        |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        |        yield tuple_
        |""".stripMargin
    udf
  }

  def pythonSourceOpDesc(numTuple: Int): PythonUDFSourceOpDescV2 = {
    val udf = new PythonUDFSourceOpDescV2()
    udf.workers = 1
    udf.columns = List(new Attribute("field_1", AttributeType.STRING))
    udf.code = s"""
                 |from pytexera import *
                 |
                 |class UDFSourceOperator(UDFSourceOperator):
                 |    @overrides
                 |    def produce(self) -> Iterator[Union[TupleLike, TableLike, None]]:
                 |        for i in range($numTuple):
                 |          yield {'field_1': str(i) }
                 |""".stripMargin
    udf
  }

  // Emits `numTuple` rows with a "Region" column, sleeping `delaySeconds`
  // between rows.
  def slowRegionSourceOpDesc(numTuple: Int, delaySeconds: Double): PythonUDFSourceOpDescV2 = {
    val udf = new PythonUDFSourceOpDescV2()
    udf.workers = 1
    udf.columns = List(new Attribute("Region", AttributeType.STRING))
    udf.code = s"""
                 |from pytexera import *
                 |import time
                 |
                 |class UDFSourceOperator(UDFSourceOperator):
                 |    @overrides
                 |    def produce(self) -> Iterator[Union[TupleLike, TableLike, None]]:
                 |        for i in range($numTuple):
                 |            time.sleep($delaySeconds)
                 |            yield {'Region': 'Asia'}
                 |""".stripMargin
    udf
  }

}
