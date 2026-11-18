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

package org.apache.texera.common.compiler

import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.executor.{FileListing, InputFile, OperatorInputs}
import org.apache.texera.amber.core.storage.{
  DatasetVersionLister,
  InputLink,
  InputLinker,
  ListedFile,
  ScanFileResolver
}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.PortIdentity
import org.apache.texera.amber.operator.keywordSearch.KeywordSearchOpDesc
import org.apache.texera.amber.operator.limit.LimitOpDesc
import org.apache.texera.amber.operator.metadata.OperatorMetadataGenerator
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.FileScanOpDesc
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.amber.operator.udf.python.PythonUDFOpDescV2
import org.apache.texera.amber.operator.union.UnionOpDesc
import org.apache.texera.amber.operator.{LogicalOp, TestOperators}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.model.{LogicalLink, LogicalPlan}
import org.scalatest.flatspec.AnyFlatSpec

import java.net.URI
import scala.collection.mutable.ArrayBuffer

/**
  * What a compile finds each operator reads from outside the run. How a name becomes a URI is the
  * resolver's business, how a file gets a link the linker's, and which files a dataset version
  * holds the lister's; all three are passed in. Here the resolver is the fixture resolver, which
  * knows local files, unless a case gives another, and the linkers and listers record what they
  * are asked.
  *
  * An operator's own error is appended to the error list by its id, and the others are bound all
  * the same: the editing compile returns every bad operator's error so the UI can surface them at
  * once, and the compile before a run throws them together.
  */
class InputBinderSpec extends AnyFlatSpec {

  private def csv(): CSVScanSourceOpDesc = TestOperators.headerlessSmallCsvScanOpDesc()
  private def keyword(): KeywordSearchOpDesc = TestOperators.keywordSearchOpDesc("column-1", "Asia")

  private def named[T <: LogicalOp](op: T, id: String): T = {
    op.setOperatorId(id)
    op
  }

  private def link(from: LogicalOp, to: LogicalOp): LogicalLink =
    LogicalLink(from.operatorIdentifier, PortIdentity(), to.operatorIdentifier, PortIdentity())

  /**
    * What the operators of `plan` read, as an [[InputBinder]] finds it: for a run when `run`
    * gives what links its files and lists its dataset versions, and for editing otherwise.
    */
  private def inputsOf(
      plan: LogicalPlan,
      files: ScanFileResolver = TestOperators.fixtureFileResolver,
      settings: CompileSettings = CompileSettings.Default,
      run: Option[(InputLinker, DatasetVersionLister)] = None,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)] = ArrayBuffer.empty
  ): Map[OperatorIdentity, OperatorInputs] = {
    val purpose = run match {
      case Some((linker, lister)) =>
        CompileFor.Run(
          files,
          settings,
          linker,
          lister,
          repositories = versionPath => fail(s"asked to pin $versionPath"),
          environments = name => fail(s"asked to resolve the environment $name")
        )
      case None => CompileFor.Editing(files, settings)
    }
    new InputBinder(purpose, errors).inputsOf(plan)
  }

  private def allowing(maxListedFiles: Int): CompileSettings =
    CompileSettings.Default.copy(maxListedFiles = maxListedFiles)

  private val defaultColumnLimit = Some(CompileSettings.Default.csvParserMaxColumns)

  /** A lister that is asked for nothing. */
  private val listsNothing: DatasetVersionLister =
    (versionPath, _) => fail(s"asked to list $versionPath")

  /** A linker that is asked for nothing. */
  private val linksNothing: InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = fail(s"asked to link $fileUri")
      override def linkListed(file: ListedFile): InputLink =
        fail(s"asked to link the listed file ${file.logicalPath}")
    }

  // ---------------------------------------------------------------------------
  // Scan sources
  // ---------------------------------------------------------------------------

  private def csvWithMissingFile(): CSVScanSourceOpDesc = {
    val op = TestOperators.headerlessSmallCsvScanOpDesc()
    // No such file on the local disk, so the fixture resolver refuses the name.
    op.fileName = Some("nonexistent-test-file.csv")
    op
  }

  /** The link `recordingLinker` makes for `file`. */
  private def linkOf(file: URI): InputLink =
    InputLink(s"http://texera-rustfs:9000/bucket${file.getPath}?X-Amz-Signature=5ecr3t", 86400000L)

  /** `file` as an operator reads it through the link `recordingLinker` makes for it. */
  private def linked(file: URI): InputFile =
    InputFile(file.toASCIIString, linkOf(file).url, linkOf(file).expiresAtMs)

  /**
    * A linker of the files resolvers resolve, each as `linkFile` links it. It is asked for no
    * file of a listing: a scan source's file is named, not listed.
    */
  private def linkerOf(linkFile: URI => InputLink): InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = linkFile(fileUri)
      override def linkListed(file: ListedFile): InputLink =
        fail(s"asked to link the listed file ${file.logicalPath}")
    }

  /** A linker that links any file, and lists the files it was asked to link in `asked`. */
  private def recordingLinker(asked: ArrayBuffer[URI]): InputLinker =
    linkerOf { file =>
      asked += file
      linkOf(file)
    }

  "InputBinder" should
    "append a per-operator error for every failing scan source instead of throwing" in {
    // Two independent broken scans: BOTH are collected (binding does not stop at
    // the first failure), keyed by their distinct operator ids.
    val brokenA = csvWithMissingFile()
    val brokenB = csvWithMissingFile()
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    inputsOf(LogicalPlan(List(brokenA, brokenB), List.empty), errors = errors)

    assert(errors.size == 2, s"expected both failures captured, got: $errors")
    assert(
      errors.map(_._1).toSet ==
        Set(brokenA.operatorIdentifier, brokenB.operatorIdentifier)
    )
    // The resolver raises `org.apache.commons.vfs2.FileNotFoundException` for a
    // name it cannot resolve: that, and no other failure, is the operator's error.
    assert(errors.forall(_._2.isInstanceOf[FileNotFoundException]))
  }

  it should "report a scan source that names no file, without asking the resolver" in {
    val unnamed = new CSVScanSourceOpDesc()
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    inputsOf(
      LogicalPlan(List(unnamed), List.empty),
      files = fileName => fail(s"asked to resolve $fileName"),
      errors = errors
    )

    assert(errors.map(_._1).toList == List(unnamed.operatorIdentifier))
    assert(
      errors.head._2.toString == "java.lang.RuntimeException: No file selected. " +
        "Please select a file from the 'File' dropdown in the right panel."
    )
  }

  it should "set on each scan source the URI the given resolver returns for its file name" in {
    val resolved = new URI("dataset:///repository/commit/data.csv")
    val asked = ArrayBuffer.empty[String]
    val op = TestOperators.smallJSONLScanOpDesc()
    op.fileName = Some("/dataset/owner@texera.io/sales/v1/data.jsonl")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      LogicalPlan(List(op), List.empty),
      files = fileName => { asked += fileName; resolved },
      errors = errors
    )

    assert(asked.toList == List("/dataset/owner@texera.io/sales/v1/data.jsonl"))
    assert(op.fileName.contains(resolved.toASCIIString))
    assert(errors.isEmpty)
    // A compile that makes no plan to run links nothing: the scan reads no file through a link.
    assert(inputs.isEmpty)
  }

  it should "link each file it resolved, for a plan made to run, under its resolved name" in {
    val csvFile = new URI("dataset:///repository/commit/data.csv")
    val jsonlFile = new URI("model:///models/commit/a%20b/rows.jsonl")
    val scanCsv = named(TestOperators.headerlessSmallCsvScanOpDesc(), "scan-csv")
    scanCsv.fileName = Some("/dataset/owner@texera.io/sales/v1/data.csv")
    val scanJsonl = named(TestOperators.smallJSONLScanOpDesc(), "scan-jsonl")
    scanJsonl.fileName = Some("/model/owner@texera.io/models/v2/a b/rows.jsonl")
    val asked = ArrayBuffer.empty[URI]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      LogicalPlan(List(scanCsv, keyword(), scanJsonl), List.empty),
      files = fileName => if (fileName.startsWith("/dataset/")) csvFile else jsonlFile,
      run = Some((recordingLinker(asked), listsNothing)),
      errors = errors
    )

    assert(errors.isEmpty)
    // The linker is handed what the resolver resolved, and nothing else.
    assert(asked.toList == List(csvFile, jsonlFile))
    // The executor asks for its file by the name its descriptor knows it by.
    assert(scanCsv.fileName.contains(csvFile.toASCIIString))
    assert(scanJsonl.fileName.contains(jsonlFile.toASCIIString))
    assert(
      inputs == Map(
        OperatorIdentity("scan-csv") ->
          OperatorInputs(files = Seq(linked(csvFile)), csvParserMaxColumns = defaultColumnLimit),
        OperatorIdentity("scan-jsonl") -> OperatorInputs(files = Seq(linked(jsonlFile)))
      )
    )
  }

  it should "link no file whose name did not resolve, whatever the name is" in {
    // A request names a file by a URI of its own making, of a dataset its user may
    // not read. A user's resolver resolves no such name.
    val refusesResolvedNames: ScanFileResolver =
      fileName => throw new FileNotFoundException(fileName)
    val scan = named(TestOperators.smallJSONLScanOpDesc(), "scan")
    scan.fileName = Some("dataset:///another-users-repository/commit/secret.jsonl")
    val asked = ArrayBuffer.empty[URI]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      LogicalPlan(List(scan), List.empty),
      files = refusesResolvedNames,
      run = Some((recordingLinker(asked), listsNothing)),
      errors = errors
    )

    assert(errors.map(_._1).toList == List(scan.operatorIdentifier))
    assert(asked.isEmpty, "the linker was handed a file the resolver did not resolve")
    assert(inputs.isEmpty)
  }

  it should "report a file the linker does not find as its scan source's error" in {
    val missing = named(TestOperators.smallJSONLScanOpDesc(), "missing")
    val found = named(TestOperators.smallJSONLScanOpDesc(), "found")
    val notFound = new FileNotFoundException("no such file in the version")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    val missingFile = TestOperators.fixtureFileResolver.resolve(missing.fileName.get)
    var asked = 0

    val inputs = inputsOf(
      LogicalPlan(List(missing, found), List.empty),
      run = Some(
        (
          linkerOf { file =>
            asked += 1
            if (asked == 1) throw notFound else linkOf(file)
          },
          listsNothing
        )
      ),
      errors = errors
    )

    assert(errors.toList == List((missing.operatorIdentifier, notFound)))
    assert(missing.fileName.contains(missingFile.toASCIIString), "the name was resolved")
    // The scan after it is linked all the same.
    assert(inputs.keySet == Set(found.operatorIdentifier))
    assert(inputs(found.operatorIdentifier).files.map(_.name) == Seq(found.fileName.get))
  }

  it should "throw, as it is, a failure of the resolver or the linker that is no scan's error" in {
    // The database or the storage not answering says nothing about the file: reported on
    // the scan, it would read as the user's mistake.
    val outage = new java.io.IOException("the storage did not answer")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val fromResolver = intercept[java.io.IOException] {
      inputsOf(LogicalPlan(List(csv()), List.empty), files = _ => throw outage, errors = errors)
    }
    val fromLinker = intercept[java.io.IOException] {
      inputsOf(
        LogicalPlan(List(csv()), List.empty),
        run = Some((linkerOf(_ => throw outage), listsNothing)),
        errors = errors
      )
    }

    assert(fromResolver eq outage)
    assert(fromLinker eq outage)
    assert(errors.isEmpty)
  }

  // ---------------------------------------------------------------------------
  // File Listers, and the File Scans From Input that read what they list
  // ---------------------------------------------------------------------------

  private val lettersPath = "/dataset/ada@texera.io/letters/v1"
  private val almanacPath = "/dataset/ada@texera.io/almanac/v2"

  /** The file at `path` within the version at `versionPath`, as a listing holds it. */
  private def listedFile(versionPath: String, path: String): ListedFile =
    ListedFile(s"$versionPath/$path", s"s3://texera-dataset/${path.hashCode.toHexString}")

  private val letters = Seq(listedFile(lettersPath, "b.txt"), listedFile(lettersPath, "a.txt"))
  private val almanac = Seq(listedFile(almanacPath, "2024/moon.csv"))

  /**
    * A lister of `versions`: it lists the first files of each, as many as it is asked for, and
    * refuses any other version as one that is not there. `asked` lists what it was asked.
    */
  private def listerOf(
      versions: Map[String, Seq[ListedFile]],
      asked: ArrayBuffer[(String, Int)] = ArrayBuffer.empty
  ): DatasetVersionLister =
    (versionPath, atMost) => {
      asked += ((versionPath, atMost))
      versions
        .getOrElse(versionPath, throw new FileNotFoundException(versionPath))
        .take(atMost)
    }

  private val bothVersions = Map(lettersPath -> letters, almanacPath -> almanac)

  /** The link `listedFileLinker` makes for `file`. */
  private def linkOf(file: ListedFile): InputLink =
    InputLink(
      s"http://texera-rustfs:9000/${file.physicalAddress.stripPrefix("s3://")}?X-Amz-Signature=5ecr3t",
      86400000L
    )

  /**
    * `listed` as an operator reads them through the links `listedFileLinker` makes: each under
    * the name an input tuple carries, its logical path, in the order of the names.
    */
  private def linked(listed: Seq[ListedFile]): Seq[InputFile] =
    listed
      .map(file => InputFile(file.logicalPath, linkOf(file).url, linkOf(file).expiresAtMs))
      .sortBy(_.name)

  /**
    * A linker of listed files, which lists those it was asked to link in `asked`. It is asked
    * for no file by its URI: only what was listed is linked for a File Scan From Input.
    */
  private def listedFileLinker(asked: ArrayBuffer[ListedFile] = ArrayBuffer.empty): InputLinker =
    new InputLinker {
      override def link(fileUri: URI): InputLink = fail(s"asked to link $fileUri")
      override def linkListed(file: ListedFile): InputLink = {
        asked += file
        linkOf(file)
      }
    }

  private def fileLister(id: String, versionPath: String): FileListerSourceOpDesc = {
    val op = named(new FileListerSourceOpDesc, id)
    op.datasetVersionPath = versionPath
    op
  }

  private def fileScan(id: String): FileScanOpDesc = named(new FileScanOpDesc, id)

  /** What a File Lister reads when its version holds `listed`: the listing, in its order. */
  private def listingOf(listed: Seq[ListedFile]): OperatorInputs =
    OperatorInputs(listing = Some(FileListing(listed.map(_.logicalPath))))

  private val noFileListerUpstream =
    "java.lang.IllegalArgumentException: File Scan From Input reads only the files a File " +
      "Lister upstream of it lists. Link a File Lister to its input, directly or through other " +
      "operators."

  it should "give each File Lister the listing of its version, for a plan made to run" in {
    val lettersLister = fileLister("letters", lettersPath)
    val almanacLister = fileLister("almanac", almanacPath)
    val asked = ArrayBuffer.empty[(String, Int)]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      LogicalPlan(List(lettersLister, keyword(), almanacLister), List.empty),
      settings = allowing(100),
      run = Some((linksNothing, listerOf(bothVersions, asked))),
      errors = errors
    )

    assert(errors.isEmpty)
    // Each version is listed once, asked for one file more than may be listed.
    assert(asked.toList == List((lettersPath, 101), (almanacPath, 101)))
    // The files by their logical paths, in the order they were listed: not sorted again. A File
    // Lister reads no file: with nothing downstream to read them, nothing is linked.
    assert(
      inputs == Map(
        OperatorIdentity("letters") -> listingOf(letters),
        OperatorIdentity("almanac") -> listingOf(almanac)
      )
    )
  }

  it should "link, for each File Scan From Input, the files listed upstream of it, by any path" in {
    // letters ─▶ direct          almanac ─▶ search ─▶ through
    // letters ─▶ union ◀─ almanac            union ─▶ both
    val lettersLister = fileLister("letters", lettersPath)
    val almanacLister = fileLister("almanac", almanacPath)
    val search = named(keyword(), "search")
    val union = named(new UnionOpDesc(), "union")
    val (direct, through, both) = (fileScan("direct"), fileScan("through"), fileScan("both"))
    val plan = LogicalPlan(
      List(both, lettersLister, direct, search, almanacLister, through, union),
      List(
        link(lettersLister, direct),
        link(almanacLister, search),
        link(search, through),
        link(lettersLister, union),
        link(almanacLister, union),
        link(union, both)
      )
    )
    val asked = ArrayBuffer.empty[ListedFile]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      plan,
      settings = allowing(100),
      run = Some((listedFileLinker(asked), listerOf(bothVersions))),
      errors = errors
    )

    assert(errors.isEmpty)
    // The executor asks for a file by the name an input tuple carries: the logical path.
    assert(
      inputs == Map(
        OperatorIdentity("letters") -> listingOf(letters),
        OperatorIdentity("almanac") -> listingOf(almanac),
        OperatorIdentity("direct") -> OperatorInputs(files = linked(letters)),
        OperatorIdentity("through") -> OperatorInputs(files = linked(almanac)),
        OperatorIdentity("both") -> OperatorInputs(files = linked(letters ++ almanac))
      )
    )
    // The linker is handed what was listed, a file for each operator that reads it.
    assert(asked.toList == (letters ++ almanac) ++ letters ++ almanac)
  }

  it should "link a file that two File Listers upstream list once" in {
    val first = fileLister("first", lettersPath)
    val second = fileLister("second", lettersPath)
    val scan = fileScan("scan")
    val plan = LogicalPlan(List(first, second, scan), List(link(first, scan), link(second, scan)))
    val asked = ArrayBuffer.empty[ListedFile]

    // Two files between them: no more than it can read.
    val inputs = inputsOf(
      plan,
      settings = allowing(2),
      run = Some((listedFileLinker(asked), listerOf(bothVersions)))
    )

    assert(asked.toList == letters)
    assert(inputs(OperatorIdentity("scan")) == OperatorInputs(files = linked(letters)))
  }

  it should "list and link nothing for a compile that makes no plan to run" in {
    val lister = fileLister("letters", lettersPath)
    val scan = fileScan("scan")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs =
      inputsOf(LogicalPlan(List(lister, scan), List(link(lister, scan))), errors = errors)

    assert(errors.isEmpty)
    assert(inputs.isEmpty)
  }

  it should "report a File Scan From Input with no File Lister upstream, in every compile" in {
    Seq(None, Some((listedFileLinker(), listerOf(bothVersions)))).foreach { run =>
      // Names from a Text Input, no input at all, and a File Lister that is in the plan but
      // not upstream; then one that a File Lister does feed.
      val names = named(new TextInputSourceOpDesc, "names")
      val elsewhere = fileLister("elsewhere", lettersPath)
      val (fed, alone, beside) = (fileScan("fed"), fileScan("alone"), fileScan("beside"))
      val search = named(keyword(), "search")
      val listed = fileScan("listed")
      val plan = LogicalPlan(
        List(names, elsewhere, fed, alone, beside, search, listed),
        List(link(names, fed), link(beside, search), link(elsewhere, listed))
      )
      val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

      val inputs = inputsOf(plan, settings = allowing(100), run = run, errors = errors)

      withClue(s"for a plan ${run.fold("not made")(_ => "made")} to run: ") {
        assert(errors.map(_._1.id).toList == List("fed", "alone", "beside"))
        assert(errors.forall(_._2.toString == noFileListerUpstream))
        // None of the three reads a file; the one a File Lister feeds reads what it lists.
        assert(
          inputs.collect { case (id, read) if read.files.nonEmpty => id.id }.toSet ==
            run.map(_ => "listed").toSet
        )
      }
    }
  }

  it should "report a File Lister that names no dataset version, without asking for one" in {
    Seq(false, true).foreach { makesPlanToRun =>
      val unset = fileLister("unset", null)
      val blank = fileLister("blank", "  ")
      val scan = fileScan("scan")
      val asked = ArrayBuffer.empty[(String, Int)]
      val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

      val inputs = inputsOf(
        LogicalPlan(List(unset, blank, scan), List(link(unset, scan))),
        settings = allowing(100),
        run = Option.when(makesPlanToRun)((linksNothing, listerOf(bothVersions, asked))),
        errors = errors
      )

      withClue(s"for a plan ${if (makesPlanToRun) "made" else "not made"} to run: ") {
        // The File Scan From Input has no error of its own: a File Lister is upstream of it.
        assert(errors.map(_._1.id).toList == List("unset", "blank"))
        assert(
          errors.forall(
            _._2.toString == "java.lang.IllegalArgumentException: No dataset version " +
              "selected. Please select one in the 'Dataset' field in the right panel."
          )
        )
        assert(asked.isEmpty)
        assert(inputs.isEmpty)
      }
    }
  }

  it should "report a version the lister does not find on its File Lister, and go on" in {
    val missingPath = "/dataset/ada@texera.io/no-such-dataset/v1"
    val missing = fileLister("missing", missingPath)
    val found = fileLister("found", lettersPath)
    val scan = fileScan("scan")
    val plan =
      LogicalPlan(List(missing, found, scan), List(link(missing, scan), link(found, scan)))
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      plan,
      settings = allowing(100),
      run = Some((listedFileLinker(), listerOf(bothVersions))),
      errors = errors
    )

    // The error is the File Lister's alone, in words that name the version.
    assert(errors.map(_._1.id).toList == List("missing"))
    assert(
      errors.head._2.toString == "java.lang.IllegalArgumentException: Dataset version " +
        s"$missingPath was not found: it does not exist, or you do not have access to it."
    )
    assert(errors.head._2.getCause.isInstanceOf[FileNotFoundException])
    // The File Lister after it is listed all the same, and its files linked.
    assert(
      inputs == Map(
        OperatorIdentity("found") -> listingOf(letters),
        OperatorIdentity("scan") -> OperatorInputs(files = linked(letters))
      )
    )
  }

  it should "report a File Lister whose version holds more files than may be listed" in {
    val within = fileLister("within", lettersPath)
    val beyond = fileLister("beyond", almanacPath)
    val asked = ArrayBuffer.empty[(String, Int)]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    // Two files may be listed: the letters are two, and the almanac here is three.
    val versions = Map(
      lettersPath -> letters,
      almanacPath -> Seq("a", "b", "c").map(listedFile(almanacPath, _))
    )

    val inputs = inputsOf(
      LogicalPlan(List(within, beyond), List.empty),
      settings = allowing(2),
      run = Some((linksNothing, listerOf(versions, asked))),
      errors = errors
    )

    // One file beyond what may be listed is asked for, which is how a larger version is told.
    assert(asked.toList == List((lettersPath, 3), (almanacPath, 3)))
    assert(errors.map(_._1.id).toList == List("beyond"))
    assert(
      errors.head._2.toString == "java.lang.IllegalArgumentException: Dataset version " +
        s"$almanacPath holds more files than the 2 a File Lister can list."
    )
    assert(inputs == Map(OperatorIdentity("within") -> listingOf(letters)))
  }

  it should "report a File Scan From Input with more files listed upstream than it can read" in {
    def plan(): LogicalPlan = {
      val lettersLister = fileLister("letters", lettersPath)
      val almanacLister = fileLister("almanac", almanacPath)
      val scan = fileScan("scan")
      LogicalPlan(
        List(lettersLister, almanacLister, scan),
        List(link(lettersLister, scan), link(almanacLister, scan))
      )
    }

    // Each version is within what a File Lister may list; the three files between them are
    // one more than a File Scan From Input may read.
    val asked = ArrayBuffer.empty[ListedFile]
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    val tooMany = inputsOf(
      plan(),
      settings = allowing(2),
      run = Some((listedFileLinker(asked), listerOf(bothVersions))),
      errors = errors
    )

    assert(errors.map(_._1.id).toList == List("scan"))
    assert(
      errors.head._2.toString == "java.lang.IllegalArgumentException: The File Listers " +
        "upstream of File Scan From Input list 3 files, and it can read at most 2."
    )
    assert(asked.isEmpty && !tooMany.contains(OperatorIdentity("scan")))

    // At exactly as many as it can read, they are linked.
    val none = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    val withinLimit = inputsOf(
      plan(),
      settings = allowing(3),
      run = Some((listedFileLinker(), listerOf(bothVersions))),
      errors = none
    )
    assert(none.isEmpty)
    assert(withinLimit(OperatorIdentity("scan")).files == linked(letters ++ almanac))
  }

  it should "ask for as many files as there can be when no fewer may be listed" in {
    val asked = ArrayBuffer.empty[(String, Int)]

    inputsOf(
      LogicalPlan(List(fileLister("letters", lettersPath)), List.empty),
      settings = allowing(Int.MaxValue),
      run = Some((linksNothing, listerOf(bothVersions, asked)))
    )

    assert(asked.toList == List((lettersPath, Int.MaxValue)))
  }

  it should "throw, as it is, a failure of the lister or the linker that is no operator's error" in {
    // The database or the storage not answering says nothing about the version: reported on
    // the File Lister, it would read as the user's mistake.
    val outage = new java.io.IOException("the storage did not answer")
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]
    def plan(): LogicalPlan = {
      val lister = fileLister("letters", lettersPath)
      val scan = fileScan("scan")
      LogicalPlan(List(lister, scan), List(link(lister, scan)))
    }

    val fromLister = intercept[java.io.IOException] {
      inputsOf(plan(), run = Some((linksNothing, (_, _) => throw outage)), errors = errors)
    }
    val fromLinker = intercept[java.io.IOException] {
      inputsOf(
        plan(),
        run = Some(
          (
            new InputLinker {
              override def link(fileUri: URI): InputLink = fail(s"asked to link $fileUri")
              override def linkListed(file: ListedFile): InputLink = throw outage
            },
            listerOf(bothVersions)
          )
        ),
        errors = errors
      )
    }

    assert(fromLister eq outage)
    assert(fromLinker eq outage)
    assert(errors.isEmpty)
  }

  // ---------------------------------------------------------------------------
  // The site's settings
  // ---------------------------------------------------------------------------

  it should "give every CSV scan the site's column limit, in every compile" in {
    Seq(None, Some((recordingLinker(ArrayBuffer.empty), listsNothing))).foreach { run =>
      val first = named(csv(), "first")
      val second = named(csv(), "second")
      val jsonl = named(TestOperators.smallJSONLScanOpDesc(), "jsonl")

      val inputs = inputsOf(
        LogicalPlan(List(first, second, jsonl, keyword()), List.empty),
        settings = CompileSettings.Default.copy(csvParserMaxColumns = 77),
        run = run
      )

      withClue(s"for a plan ${run.fold("not made")(_ => "made")} to run: ") {
        assert(inputs(OperatorIdentity("first")).csvParserMaxColumns.contains(77))
        assert(inputs(OperatorIdentity("second")).csvParserMaxColumns.contains(77))
        // No other operator reads a CSV file.
        assert(inputs.values.count(_.csvParserMaxColumns.isDefined) == 2)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // What it leaves alone
  // ---------------------------------------------------------------------------

  it should "ask nothing for, and say nothing of, an operator that reads nothing from outside" in {
    val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

    val inputs = inputsOf(
      LogicalPlan(List(keyword(), new LimitOpDesc(), new TextInputSourceOpDesc), List.empty),
      files = fileName => fail(s"asked to resolve $fileName"),
      run = Some((linksNothing, listsNothing)),
      errors = errors
    )

    assert(errors.isEmpty)
    assert(inputs.isEmpty)
  }

  it should "find nothing for an operator that takes a change while its run is paused" in {
    // A change to a paused operator is made to run without this pass: only the datasets and
    // models it names are pinned again. So what the pass finds for an operator would not follow
    // a change to it, and an operator that is given something here must not take one.
    val takingChanges = OperatorMetadataGenerator.operatorTypeMap.keys.toSeq
      .filter { operator =>
        operator
          .getMethod(
            "runtimeReconfiguration",
            classOf[WorkflowIdentity],
            classOf[ExecutionIdentity],
            classOf[LogicalOp],
            classOf[LogicalOp]
          )
          .getDeclaringClass != classOf[LogicalOp]
      }
      .sortBy(_.getName)
    // Operators that override it, and those of a base that does.
    assert(takingChanges.contains(classOf[LimitOpDesc]))
    assert(takingChanges.contains(classOf[PythonUDFOpDescV2]))
    assert(takingChanges.contains(classOf[KeywordSearchOpDesc]))

    takingChanges.foreach { operator =>
      withClue(s"${operator.getSimpleName}: ") {
        val errors = ArrayBuffer.empty[(OperatorIdentity, Throwable)]

        val inputs = inputsOf(
          LogicalPlan(List(operator.getConstructor().newInstance()), List.empty),
          files = fileName => fail(s"asked to resolve $fileName"),
          run = Some((linksNothing, listsNothing)),
          errors = errors
        )

        assert(errors.isEmpty)
        assert(inputs.isEmpty)
      }
    }
  }

  it should "leave every descriptor as it was written, but for the file a scan source names" in {
    val scan = named(csv(), "scan")
    val lister = fileLister("letters", lettersPath)
    val listedScan = fileScan("listed-scan")
    val operators = List(scan, lister, listedScan, keyword())
    val written = operators.map(objectMapper.valueToTree[ObjectNode])
    val resolvedName = TestOperators.fixtureFileResolver.resolve(scan.fileName.get).toASCIIString

    val inputs = inputsOf(
      LogicalPlan(operators, List(link(lister, listedScan))),
      run = Some(
        (
          new InputLinker {
            override def link(fileUri: URI): InputLink = linkOf(fileUri)
            override def linkListed(file: ListedFile): InputLink = linkOf(file)
          },
          listerOf(bothVersions)
        )
      )
    )

    // The compile found something for each of the three to read ...
    assert(inputs.keySet.map(_.id) == Set("scan", "letters", "listed-scan"))
    // ... and none of it is in a descriptor: a link, a listing and a limit are the plan's.
    written.head.put("fileName", resolvedName)
    assert(operators.map(objectMapper.valueToTree[ObjectNode]) == written)
  }
}
