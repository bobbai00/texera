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
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.state.StateReferencing.literalReferences
import org.apache.texera.amber.core.storage.ScanFileResolver
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.loop.{LoopEndOpDesc, LoopStartOpDesc}
import org.apache.texera.amber.operator.source.scan.ScanSourceOpDesc
import org.apache.texera.amber.operator.source.scan.csv.CSVScanSourceOpDesc
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.common.compiler.CompileSettings
import org.jgrapht.graph.DirectedAcyclicGraph
import org.jgrapht.util.SupplierUtil

import java.util
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.{Failure, Success, Try}

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
) extends LazyLogging {

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
    * Resolves each scan source operator's user-given file name to a URI and sets it on the
    * operator via `setResolvedFileName`.
    *
    * @param fileResolver resolves scan source file names to URIs
    * @param errorList if given, errors encountered during resolution are appended to it;
    *                  otherwise the first error is thrown
    */
  def resolveScanSourceOpFileName(
      fileResolver: ScanFileResolver,
      errorList: Option[ArrayBuffer[(OperatorIdentity, Throwable)]]
  ): Unit = {
    operators.foreach {
      case operator @ (scanOp: ScanSourceOpDesc) =>
        Try {
          // Resolve file path for ScanSourceOpDesc
          val fileName = scanOp.fileName.getOrElse(
            throw new RuntimeException(
              "No file selected. Please select a file from the 'File' dropdown in the right panel."
            )
          )
          val fileUri = fileResolver.resolve(fileName) // Convert to URI

          // Set the URI in the ScanSourceOpDesc
          scanOp.setResolvedFileName(fileUri)
        } match {
          case Success(_) => // Successfully resolved and set the file URI

          case Failure(err) =>
            logger.error("Error resolving file path for ScanSourceOpDesc", err)
            errorList match {
              case Some(errList) =>
                errList.append((operator.operatorIdentifier, err))
              case None =>
                // Throw the error if no errorList is provided
                throw err
            }
        }

      case _ => // Skip non-ScanSourceOpDesc operators
    }
  }
}
