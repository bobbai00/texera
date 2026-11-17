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

package org.apache.texera.web.service

import org.apache.texera.amber.core.storage.{FileResolver, InputLink, InputLinker, ListedFile}
import org.apache.texera.amber.engine.e2e.TestUtils
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.filter.{
  ComparisonType,
  FilterPredicate,
  SpecializedFilterOpDesc
}
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.{FileScanOpDesc, FileScanSourceOpDesc}
import org.apache.texera.common.compiler.RunBindings
import org.apache.texera.dao.jooq.generated.tables.daos.{DatasetDao, DatasetVersionDao}
import org.apache.texera.dao.jooq.generated.tables.pojos.{Dataset, DatasetVersion}

import java.net.URI
import java.nio.file.{Files, Paths}
import scala.io.Source
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * A computing unit starts a run without reading Postgres, and touches only the tables of the
  * run's state until the run ends: for a scan of a CSV file, for a scan of a dataset's file, and
  * for a File Lister with a File Scan From Input. See [[UnitStartReadsNoPostgresFixture]] for how
  * an execution is created, started and watched.
  *
  * Each of these needs something only Postgres or LakeFS could tell a unit, were it not in the
  * plan: the CSV scan the site's column limit, the scan where the dataset keeps its file, the
  * File Lister the files of its version, and the File Scan From Input the file each name it is
  * sent names.
  */
class UnitStartReadsNoPostgresSpec
    extends UnitStartReadsNoPostgresFixture("UnitStartReadsNoPostgresSpec") {

  override protected def firstCreatedEid: Int = 978000
  override protected def wid: Int = 9781

  // A private dataset of the creator's, with one version, and a file of it as a scan names it
  // and as the creator's resolver resolves it. No LakeFS holds the dataset: the file's bytes are
  // a fixture file's, in the fixture server, which only the plan's link leads to.
  private val notesDid = 9787
  private val notesVersionHash = "5f0c7a1be2d94c3fa6b87d10e4c9a2b35d6e7f80"
  private val notesPath = s"/dataset/$creatorEmail/unit-start-notes/v1/2026/notes.txt"
  private val notesUri = new URI(s"dataset:///dataset-$notesDid/$notesVersionHash/2026/notes.txt")

  override protected def beforeAll(): Unit = {
    super.beforeAll()
    val cfg = getDSLContext.configuration()
    val notes = new Dataset
    notes.setDid(notesDid)
    notes.setOwnerUid(creatorUid)
    notes.setName("unit-start-notes")
    notes.setRepositoryName(s"dataset-$notesDid")
    notes.setIsPublic(false)
    notes.setDescription("")
    new DatasetDao(cfg).insert(notes)
    val version = new DatasetVersion
    version.setDid(notesDid)
    version.setCreatorUid(creatorUid)
    version.setName("v1")
    version.setVersionHash(notesVersionHash)
    new DatasetVersionDao(cfg).insert(version)
  }

  /**
    * The fixtures' bindings, and the dataset's file: resolved for the creator from the dataset's
    * rows, as the deployment resolves it, and linked to the fixture file that holds its bytes.
    */
  override protected def bindings: RunBindings = {
    val fixtures = TestUtils.fixtureBindings
    fixtures.copy(
      files = fileName =>
        if (fileName == notesPath) FileResolver.forUser(creatorUid).resolve(fileName)
        else fixtures.files.resolve(fileName),
      inputLinker = new InputLinker {
        override def link(fileUri: URI): InputLink =
          fixtures.inputLinker.link(
            if (fileUri == notesUri) TestOperators.localFileUri(TestOperators.TestTextFilePath)
            else fileUri
          )
        override def linkListed(file: ListedFile): InputLink = fixtures.inputLinker.linkListed(file)
      }
    )
  }

  /** The lines of the fixture file at `path`, read without the engine. */
  private def linesOf(path: String): List[String] =
    Files.readAllLines(Paths.get(path)).asScala.toList

  /** The rows of the small sales CSV, each by its columns' names, read without the engine. */
  private lazy val salesRows: List[Map[String, String]] =
    Using.resource(Source.fromFile(TestOperators.CountrySalesSmallCsvPath)) { source =>
      val lines = source.getLines().filter(_.nonEmpty).toList
      val header = lines.head.split(",", -1).map(_.trim).toList
      lines.tail.map(line => header.zip(line.split(",", -1).map(_.trim)).toMap)
    }

  "A computing unit" should "start a scan of a CSV file and a filter without reading Postgres" in {
    val filter = named(new SpecializedFilterOpDesc(), "filter")
    filter.predicates = List(new FilterPredicate("Region", ComparisonType.EQUAL_TO, "Asia"))

    val ran = run(
      List(named(TestOperators.smallCsvScanOpDesc(), "scan"), filter),
      List(link("scan", "filter"))
    )

    assertStartedWithoutReading(ran)
    ran.resultOf("filter").map(_.getField[Any]("Order ID").toString) should
      contain theSameElementsAs salesRows.filter(_("Region") == "Asia").map(_("Order ID"))
  }

  it should "start a scan of a dataset's file without reading Postgres or reaching LakeFS" in {
    val scan = named(new FileScanSourceOpDesc(), "notes")
    scan.fileName = Some(notesPath)

    val ran = run(List(scan), List.empty)

    assertStartedWithoutReading(ran)
    // The file as LakeFS names it is all the unit knows of it, and no LakeFS holds it: the
    // bytes came through the plan's link.
    ran.resultOf("notes").map(_.getFields.toList) should contain theSameElementsAs
      linesOf(TestOperators.TestTextFilePath).map(List(_))
  }

  it should "start a File Lister and a File Scan From Input without reading Postgres" in {
    val lister = named(new FileListerSourceOpDesc(), "lister")
    lister.datasetVersionPath = TestOperators.fixtureDatasetVersionPath
    val scan = named(new FileScanOpDesc(), "scan")
    scan.outputFileName = true

    val ran = run(List(lister, scan), List(link("lister", "scan")))

    assertStartedWithoutReading(ran)
    // Each line of each file the version lists, beside the file's name: a name of a dataset's
    // file, which the unit neither resolved nor asked anything about.
    ran.resultOf("scan").map(_.getFields.toList) should contain theSameElementsAs
      TestOperators.fixtureDatasetFiles.flatMap {
        case (file, localPath) =>
          linesOf(localPath).map(List(s"${TestOperators.fixtureDatasetVersionPath}/$file", _))
      }
  }
}
