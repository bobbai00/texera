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

package org.apache.texera.common.compiler.model

import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.amber.core.state.StateReferencing.literalReferences
import org.apache.texera.amber.core.storage.{
  DatasetVersionLister,
  InputLinker,
  ListedFile,
  ScanFileResolver
}
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{InputFile, PlanInput}
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.source.dataset.FileListerSourceOpDesc
import org.apache.texera.amber.operator.source.scan.ScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.file.FileScanOpDesc
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.CompileSettings
import org.jgrapht.graph.DirectedAcyclicGraph
import org.jgrapht.util.SupplierUtil

import java.util
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters.{IteratorHasAsScala, SetHasAsScala}

object LogicalPlan {

  private def toJgraphtDAG(
      operatorList: List[LogicalOp],
      links: List[LogicalLink]
  ): DirectedAcyclicGraph[OperatorIdentity, LogicalLink] = {
    val workflowDag =
      new DirectedAcyclicGraph[OperatorIdentity, LogicalLink](
        null, // vertexSupplier
        SupplierUtil.createSupplier(classOf[LogicalLink]), // edgeSupplier
        false, // weighted
        true // allowMultipleEdges
      )
    operatorList.foreach(op => workflowDag.addVertex(op.operatorIdentifier))
    links.foreach(l =>
      workflowDag.addEdge(
        l.fromOpId,
        l.toOpId,
        l
      )
    )
    workflowDag
  }

  def apply(
      pojo: LogicalPlanPojo
  ): LogicalPlan = {
    LogicalPlan(pojo.operators, pojo.links)
  }
}

case class LogicalPlan(
    operators: List[LogicalOp],
    links: List[LogicalLink]
) {

  private lazy val operatorMap: Map[OperatorIdentity, LogicalOp] =
    operators.map(op => (op.operatorIdentifier, op)).toMap

  private lazy val jgraphtDag: DirectedAcyclicGraph[OperatorIdentity, LogicalLink] =
    LogicalPlan.toJgraphtDAG(operators, links)

  def getTopologicalOpIds: util.Iterator[OperatorIdentity] = jgraphtDag.iterator()

  def getOperator(opId: OperatorIdentity): LogicalOp = operatorMap(opId)

  def getTerminalOperatorIds: List[OperatorIdentity] =
    operatorMap.keys
      .filter(op => jgraphtDag.outDegreeOf(op) == 0)
      .toList

  def getUpstreamLinks(opId: OperatorIdentity): List[LogicalLink] = {
    links.filter(l => l.toOpId == opId)
  }

  /**
    * The operators inside some loop block, on a path LoopStart -> ... -> operator -> ... -> LoopEnd
    * whose two ends match, each with the LoopStarts of the blocks it is inside: those with a path
    * to it on which no LoopEnd closes their block (a LoopEnd closes the innermost block the path
    * opened). A control operator is not inside its own block, but an inner block's are inside the
    * outer one. The property panel decides where it offers `$K` with a port of this
    * (`enclosingLoopStarts`, loop-block.util.ts); `LogicalPlanSpec` and the port's spec run the same
    * cases (loop-blocks.json), so the two agree.
    */
  lazy val enclosingLoopStarts: Map[OperatorIdentity, Set[OperatorIdentity]] = {
    val order = getTopologicalOpIds.asScala.toList
    // 1 for a LoopStart, which opens a block, -1 for a LoopEnd, which closes one, 0 otherwise.
    val change = operatorMap.map {
      case (id, _: LoopStartOpDesc) => id -> 1
      case (id, _: LoopEndOpDesc)   => id -> -1
      case (id, _)                  => id -> 0
    }
    val upstream = links.groupMap(_.toOpId)(_.fromOpId).withDefaultValue(Nil)
    val downstream = links.groupMap(_.fromOpId)(_.toOpId).withDefaultValue(Nil)
    // The most blocks a path from each operator closes that it did not open, the operator
    // included; a block closed below is one besides a LoopEnd's own.
    val closing = order.reverse.foldLeft(Map.empty[OperatorIdentity, Int]) { (closing, id) =>
      closing.updated(id, (0 :: downstream(id).map(closing)).max - change(id))
    }
    val closedBelow = order.filter(id => closing(id) > (if (change(id) < 0) 1 else 0)).toSet
    order
      .filter(change(_) > 0)
      .flatMap { start =>
        // The most blocks a path from `start` leaves open at each operator, its own still open.
        val open = order.dropWhile(_ != start).tail.foldLeft(Map(start -> 1)) { (open, id) =>
          upstream(id).flatMap(open.get).maxOption.map(_ + change(id)) match {
            case Some(blocks) if blocks > 0 => open.updated(id, blocks)
            case _                          => open
          }
        }
        (open.keySet - start).intersect(closedBelow).map(_ -> start)
      }
      .groupMap(_._1)(_._2)
      .map { case (id, starts) => id -> starts.toSet }
  }

  def operatorsInsideLoopBlocks: Set[OperatorIdentity] = enclosingLoopStarts.keySet

  /**
    * Whether `op`, in the place of this plan's operator of its id, refers to loop variables: its
    * sidecar names one (on an operator a compile made final, every reference; on one just parsed,
    * the typed ones), or it sits inside a loop block and holds a whole-string `$name`.
    *
    * Such an operator cannot be changed while the workflow runs: the executor rebuilt from it would
    * parse its placeholders after the loop state that writes them into its setting has arrived
    * (`OperatorExecutor.registerState`), so nothing would ever set them.
    */
  def refersToLoopVariables(op: LogicalOp): Boolean =
    op.stateReferences.nonEmpty || (
      operatorsInsideLoopBlocks.contains(op.operatorIdentifier) &&
        literalReferences(objectMapper.valueToTree[ObjectNode](op)).nonEmpty
    )

  /**
    * Sets, on each operator that reads one, the site's setting its plan is compiled under: the
    * column limit of each CSV scan. A value the operator arrived with is replaced, so a request
    * cannot choose one.
    */
  def applyCompileSettings(settings: CompileSettings): Unit =
    operators.foreach {
      case csvScan: CSVScanSourceOpDesc =>
        csvScan.maxColumns = Some(settings.csvParserMaxColumns)
      case _ => // reads no setting of the site's
    }

  /**
    * Binds each scan source to the file it reads. Its file name is resolved to the URI of a file
    * the plan's user may read, which is set on the operator (`setResolvedFileName`). For a plan
    * made to run, the file is then linked, and the link, through which the scan's executor
    * reads the file, is set on the operator too.
    *
    * An operator keeps no link it arrived with, so a request cannot hand an executor one: the
    * only links an operator holds are to files this compile resolved for the plan's user.
    *
    * An operator's own error -- it names no file, or one that does not exist or that the user
    * may not read -- is appended to `errors`, and the operator is left without a link. Any other
    * failure, such as the database or the storage not answering, is no error of the operator's,
    * and is thrown as it is.
    *
    * @param linker makes the links of a plan made to run; None for a compile that makes no plan
    *               to run, which links nothing
    * @return what the plan reads from outside the run: each file linked
    */
  def bindScanFiles(
      resolver: ScanFileResolver,
      linker: Option[InputLinker],
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): Seq[PlanInput] =
    operators.collect { case scan: ScanSourceOpDesc => scan }.flatMap { scan =>
      scan.inputLinks = Map.empty
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
            val file = resolver.resolve(name)
            scan.setResolvedFileName(file)
            linker.map(_.link(file)).map { link =>
              val resolvedName = scan.fileName.get
              scan.inputLinks = Map(resolvedName -> link)
              PlanInput(
                scan.operatorIdentifier,
                resolvedName,
                InputFile(link.expiresAtMs, link.sizeBytes)
              )
            }
          } catch {
            case notFound: FileNotFoundException =>
              errors.append((scan.operatorIdentifier, notFound))
              None
          }
      }
    }

  /**
    * Binds the operators that read the files of dataset versions: each File Lister to the
    * listing of its version, and each File Scan From Input to the files listed upstream of it.
    *
    * A File Scan From Input reads the files its input tuples name, and the names arrive only
    * while the plan runs, when nothing resolves a name any more. So it reads only what the File
    * Listers upstream of it list, through any path of operators, and one with no File Lister
    * upstream is an error, in every compile.
    *
    * For a plan made to run, each File Lister's dataset version is listed, as the plan's user
    * may read it, and the listing is set on the operator, which outputs it when the plan runs
    * and lists nothing then. Each File Scan From Input is linked to the files listed upstream
    * of it, from where the listings say they are kept, and the links, through which its
    * executor reads the files, are set on the operator.
    *
    * An operator keeps no listing and no link it arrived with, so a request cannot hand an
    * executor either.
    *
    * An operator's own error is appended to `errors`: a File Lister that names no dataset
    * version, or one that does not exist or that the plan's user may not read, or one that
    * holds more than `maxFiles` files; a File Scan From Input with no File Lister upstream, or
    * with more than `maxFiles` files listed upstream of it. Any other failure, such as the
    * database or the storage not answering, is no error of the operator's, and is thrown as it
    * is.
    *
    * @param lister   lists the dataset versions of a plan made to run; None for a compile that
    *                 makes no plan to run, which lists and links nothing
    * @param linker   links the files listed
    * @param maxFiles the most files a File Lister may list, and a File Scan From Input may read
    * @return what the plan reads from outside the run: each file linked
    */
  def bindListedFiles(
      lister: Option[DatasetVersionLister],
      linker: InputLinker,
      maxFiles: Int,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): Seq[PlanInput] = {
    val fileListers = operators.collect { case fileLister: FileListerSourceOpDesc => fileLister }
    // What each File Lister lists; one with an error, or of a plan not made to run, lists none.
    val listings: Map[OperatorIdentity, Seq[ListedFile]] = fileListers.flatMap { fileLister =>
      fileLister.listing = None
      listingOf(fileLister, lister, maxFiles, errors).map { files =>
        fileLister.listing = Some(files.map(_.logicalPath).toList)
        fileLister.operatorIdentifier -> files
      }
    }.toMap

    operators.collect { case fileScan: FileScanOpDesc => fileScan }.flatMap { fileScan =>
      def refuse(why: String): Seq[PlanInput] = {
        errors.append((fileScan.operatorIdentifier, new IllegalArgumentException(why)))
        Nil
      }
      fileScan.inputLinks = Map.empty
      val name = fileScan.operatorInfo.userFriendlyName
      val upstream = jgraphtDag.getAncestors(fileScan.operatorIdentifier).asScala
      val upstreamListers = fileListers.map(_.operatorIdentifier).filter(upstream.contains)
      // A file two File Listers list is one file.
      val files = upstreamListers.flatMap(listings.getOrElse(_, Nil)).distinctBy(_.logicalPath)
      if (upstreamListers.isEmpty) {
        refuse(
          s"$name reads only the files a File Lister upstream of it lists. Link a File Lister " +
            "to its input, directly or through other operators."
        )
      } else if (files.size > maxFiles) {
        refuse(
          s"The File Listers upstream of $name list ${files.size} files, and it can read at " +
            s"most $maxFiles."
        )
      } else {
        val links = files.map(file => file.logicalPath -> linker.linkListed(file))
        fileScan.inputLinks = links.toMap
        links.map {
          case (file, link) =>
            PlanInput(
              fileScan.operatorIdentifier,
              file,
              InputFile(link.expiresAtMs, link.sizeBytes)
            )
        }
      }
    }
  }

  /**
    * The files of the dataset version `fileLister` names, as `lister` lists them: None when
    * there is no `lister`, or the operator has an error of its own, which is appended to
    * `errors`.
    */
  private def listingOf(
      fileLister: FileListerSourceOpDesc,
      lister: Option[DatasetVersionLister],
      maxFiles: Int,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): Option[Seq[ListedFile]] = {
    def refuse(why: String, cause: Throwable = null): Option[Seq[ListedFile]] = {
      errors.append((fileLister.operatorIdentifier, new IllegalArgumentException(why, cause)))
      None
    }
    Option(fileLister.datasetVersionPath).map(_.trim).filter(_.nonEmpty) match {
      case None =>
        refuse(
          "No dataset version selected. Please select one in the 'Dataset' field in the right " +
            "panel."
        )
      case Some(versionPath) =>
        lister.flatMap { lister =>
          try {
            // One file more than may be listed is asked for, to tell a version that holds more.
            val files =
              lister.list(versionPath, if (maxFiles < Int.MaxValue) maxFiles + 1 else maxFiles)
            if (files.size <= maxFiles) Some(files)
            else
              refuse(
                s"Dataset version $versionPath holds more files than the $maxFiles a " +
                  s"${fileLister.operatorInfo.userFriendlyName} can list."
              )
          } catch {
            case notFound: FileNotFoundException =>
              refuse(
                s"Dataset version $versionPath was not found: it does not exist, or you do not " +
                  "have access to it.",
                notFound
              )
          }
        }
    }
  }
}
