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

import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.executor.{FileListing, InputFile, OperatorInputs}
import org.apache.texera.amber.core.storage.ListedFile
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.ScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.FileScanOpDesc
import org.apache.texera.common.compiler.model.LogicalPlan

import scala.collection.mutable.ArrayBuffer

/**
  * Finds what each operator of a workflow reads from outside the run ([[OperatorInputs]]),
  * before the workflow is expanded; the compile binds it to the operator's physical operators.
  *
  *  - A scan source reads the file it names. The name is resolved to the URI of a file the
  *    plan's user may read, which is set on the operator (`setResolvedFileName`), where its
  *    schema is read from. For a run, the file is then located.
  *  - A CSV scan reads its file under the site's column limit.
  *  - A File Lister outputs the files of the dataset version it names. For a run, the version
  *    is listed, as the plan's user may read it.
  *  - A File Scan From Input reads the files its input tuples name, and the names arrive only
  *    while the plan runs, when nothing resolves a name any more. So it reads only what the
  *    File Listers upstream of it list, through any path of operators, and one with no File
  *    Lister upstream is an error, whatever the compile is for. For a run, it reads the files
  *    listed upstream of it, at the addresses the listings give.
  *
  * A file of a run is given the address of the object that holds it, and no link: links are
  * signed later, from the addresses, by a service that holds the object store's keys. What an
  * operator reads comes from here alone: the only addresses in a plan are of files this found
  * for the plan's user.
  *
  * An operator's own error is appended to `errors`, and the operator is given no file and no
  * listing: a file or dataset version that is not named, does not exist or may not be read by
  * the plan's user, or more files listed than the settings allow.
  */
private[compiler] class InputBinder(
    purpose: CompileFor,
    errors: ArrayBuffer[(OperatorIdentity, Throwable)]
) {

  private val settings = purpose.settings

  // What locates files and lists dataset versions; None unless the plan is made to run.
  private val forRun: Option[CompileFor.Run] = purpose match {
    case run: CompileFor.Run   => Some(run)
    case _: CompileFor.Editing => None
  }

  /** What each operator of `plan` reads; an operator that reads nothing is left out. */
  def inputsOf(plan: LogicalPlan): Map[OperatorIdentity, OperatorInputs] = {
    val scanned = plan.operators.collect {
      case scan: ScanSourceOpDesc => scan.operatorIdentifier -> readBy(scan)
    }
    val fileListers = plan.operators.collect { case lister: FileListerSourceOpDesc => lister }
    // What each File Lister lists; one with an error, or of a plan not made to run, lists none.
    val listings = fileListers.flatMap { fileLister =>
      listingOf(fileLister).map(fileLister.operatorIdentifier -> _)
    }.toMap
    val listed = listings.map {
      case (fileLister, listing) =>
        fileLister -> OperatorInputs(listing = Some(FileListing(listing.map(_.logicalPath))))
    }
    val read = plan.operators.collect {
      case fileScan: FileScanOpDesc =>
        val upstream = plan.getAncestorOpIds(fileScan.operatorIdentifier)
        val upstreamListers = fileListers.map(_.operatorIdentifier).filter(upstream.contains)
        fileScan.operatorIdentifier -> readBy(fileScan, upstreamListers, listings)
    }
    (scanned ++ listed ++ read).filter(_._2 != OperatorInputs.defaultInstance).toMap
  }

  private def readBy(scan: ScanSourceOpDesc): OperatorInputs =
    OperatorInputs(
      files = fileOf(scan).toSeq,
      csvParserMaxColumns = scan match {
        case _: CSVScanSourceOpDesc => Some(settings.csvParserMaxColumns)
        case _                      => None
      }
    )

  /**
    * Resolves the file `scan` names and sets it on the scan; for a run, the file located, under
    * its resolved name, which is the name the scan's executor knows it by.
    */
  private def fileOf(scan: ScanSourceOpDesc): Option[InputFile] =
    scan.fileName match {
      case None =>
        errors.append(
          (
            scan.operatorIdentifier,
            new RuntimeException(
              "No file selected. Please select a file from the 'File' dropdown in the right panel."
            )
          )
        )
        None
      case Some(name) =>
        try {
          val file = purpose.files.resolve(name)
          scan.setResolvedFileName(file)
          forRun.map { run =>
            InputFile(scan.fileName.get, physicalAddress = run.locator.locate(file))
          }
        } catch {
          case notFound: FileNotFoundException =>
            errors.append((scan.operatorIdentifier, notFound))
            None
        }
    }

  /**
    * The files `fileScan` reads, for a run: those the File Listers upstream of it list, each
    * where its listing says it is kept. A file two of them list is one file.
    */
  private def readBy(
      fileScan: FileScanOpDesc,
      upstreamListers: Seq[OperatorIdentity],
      listings: Map[OperatorIdentity, Seq[ListedFile]]
  ): OperatorInputs = {
    def refuse(why: String): OperatorInputs = {
      errors.append((fileScan.operatorIdentifier, new IllegalArgumentException(why)))
      OperatorInputs.defaultInstance
    }
    val name = fileScan.operatorInfo.userFriendlyName
    val listed = upstreamListers.flatMap(listings.getOrElse(_, Nil)).distinctBy(_.logicalPath)
    if (upstreamListers.isEmpty) {
      refuse(
        s"$name reads only the files a File Lister upstream of it lists. Link a File Lister " +
          "to its input, directly or through other operators."
      )
    } else if (listed.size > settings.maxListedFiles) {
      refuse(
        s"The File Listers upstream of $name list ${listed.size} files, and it can read at " +
          s"most ${settings.maxListedFiles}."
      )
    } else {
      // Listed only for a run, so only then is there a file to read.
      OperatorInputs(files =
        listed
          .map(file => InputFile(file.logicalPath, physicalAddress = file.physicalAddress))
          .sortBy(_.name)
      )
    }
  }

  /**
    * The files of the dataset version `fileLister` names, as a run lists them: None for a
    * compile that makes no plan to run, or when the operator has an error of its own.
    */
  private def listingOf(fileLister: FileListerSourceOpDesc): Option[Seq[ListedFile]] = {
    def refuse(why: String, cause: Throwable = null): Option[Seq[ListedFile]] = {
      errors.append((fileLister.operatorIdentifier, new IllegalArgumentException(why, cause)))
      None
    }
    val maxFiles = settings.maxListedFiles
    Option(fileLister.datasetVersionPath).map(_.trim).filter(_.nonEmpty) match {
      case None =>
        refuse(
          "No dataset version selected. Please select one in the 'Dataset' field in the right " +
            "panel."
        )
      case Some(versionPath) =>
        forRun.flatMap { run =>
          try {
            // One file more than may be listed is asked for, to tell a version that holds more.
            val listing =
              run.lister.list(versionPath, if (maxFiles < Int.MaxValue) maxFiles + 1 else maxFiles)
            if (listing.size <= maxFiles) Some(listing)
            else
              refuse(
                s"Dataset version $versionPath holds more files than the $maxFiles a " +
                  s"${fileLister.operatorInfo.userFriendlyName} can list."
              )
          } catch {
            case notFound: FileNotFoundException =>
              refuse(
                s"Dataset version $versionPath was not found: it does not exist, or you do " +
                  "not have access to it.",
                notFound
              )
          }
        }
    }
  }
}
