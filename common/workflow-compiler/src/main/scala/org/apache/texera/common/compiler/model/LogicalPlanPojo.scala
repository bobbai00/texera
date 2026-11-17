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
import org.apache.texera.amber.core.state.StateReferencing
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.util.JSONUtils.objectMapper

import scala.collection.mutable
import scala.jdk.CollectionConverters.{IteratorHasAsScala, SetHasAsJava}

case class LogicalPlanPojo(
    operators: List[LogicalOp],
    links: List[LogicalLink],
    opsToViewResult: List[String],
    opsToReuseResult: List[String]
) {

  /**
    * The part of this plan that a run up to operator `targetId` needs ("Execute To"): the target
    * and every operator upstream of it, in this plan's order, with the links into them. The run
    * views the target's result, and reuses only the results of the operators it keeps. A plan
    * that has no operator `targetId` is returned whole, as it is.
    */
  def upstreamOf(targetId: String): LogicalPlanPojo =
    if (!operators.exists(_.operatorIdentifier.id == targetId)) {
      this
    } else {
      val linksInto = links.groupBy(_.toOpId.id)
      val kept = mutable.Set.empty[String]
      val pending = mutable.Stack(targetId)
      while (pending.nonEmpty) {
        val operatorId = pending.pop()
        if (kept.add(operatorId)) {
          linksInto.getOrElse(operatorId, Nil).foreach(link => pending.push(link.fromOpId.id))
        }
      }
      LogicalPlanPojo(
        operators = operators.filter(op => kept.contains(op.operatorIdentifier.id)),
        links = links.filter(link => kept.contains(link.toOpId.id)),
        opsToViewResult = List(targetId),
        opsToReuseResult = opsToReuseResult.filter(kept.contains)
      )
    }

  /**
    * Why this plan's lists of operators and links cannot be read at all, if they cannot: a list
    * that is missing, or one that holds null. The first check of [[graphProblem]], and all a plan
    * must pass to be cut ([[upstreamOf]]).
    *
    * @return the first problem found, in words the workflow's user can act on; None when both
    *         lists are there and hold no null
    */
  def listProblem(): Option[String] =
    if (operators == null) Some("The workflow lists no operators.")
    else if (links == null) Some("The workflow lists no links.")
    else if (operators.contains(null)) Some("The workflow lists an operator that is null.")
    else if (links.contains(null)) Some("The workflow lists a link that is null.")
    else None

  /**
    * Why this plan is not a workflow the compiler can read, if it is not: what is wrong with its
    * graph, rather than with any operator's settings. The compiler reads every operator once, by
    * an id of its own, and links between operators of the plan that form no cycle; given anything
    * else it fails outside any operator, so such a plan is refused before it is compiled. The
    * lists of results to view and reuse are not checked: the compiler passes over an id there that
    * the plan does not have.
    *
    * @return the first problem found, in words the workflow's user can act on; None when the plan
    *         is a graph the compiler can read
    */
  def graphProblem(): Option[String] =
    listProblem().orElse {
      val ids = operators.map(_.operatorIdentifier.id)
      val known = ids.toSet
      operators
        .find(op => Option(op.operatorIdentifier.id).forall(_.isEmpty))
        .map(op => s"The workflow has a ${op.getClass.getSimpleName} with no operator id.")
        .orElse(
          ids.diff(ids.distinct).headOption.map(id => s"Operator $id is in the workflow twice.")
        )
        .orElse(links.iterator.flatMap(linkProblem(_, known)).nextOption())
        .orElse(cycle.map(path => s"The workflow's links form a cycle: ${path.mkString(" -> ")}."))
    }

  /** What is wrong with `link`, in a plan of the operators `known`, if anything is. */
  private def linkProblem(link: LogicalLink, known: Set[String]): Option[String] = {
    val (from, to) = (link.fromOpId.id, link.toOpId.id)
    if (link.fromPortId == null) Some(s"The link from $from to $to names no output port of $from.")
    else if (link.toPortId == null) Some(s"The link from $from to $to names no input port of $to.")
    else
      Seq(from, to)
        .find(!known.contains(_))
        .map(missing =>
          s"The link from $from to $to names operator $missing, which the workflow does not have."
        )
  }

  /**
    * A cycle the links form, if they form one: the ids along it, the first one repeated last. A
    * depth-first search visits each operator once, and keeps its path in a buffer rather than on
    * the thread's stack, so a long chain of operators cannot overflow it.
    */
  private def cycle: Option[List[String]] = {
    val successors = links.groupMap(_.fromOpId.id)(_.toOpId.id)
    val finished = mutable.Set.empty[String]

    def cycleFrom(start: String): Option[List[String]] = {
      val path = mutable.ArrayBuffer(start)
      val onPath = mutable.Set(start)
      val unvisited = mutable.Stack(successors.getOrElse(start, Nil).iterator)
      var found: Option[List[String]] = None
      while (found.isEmpty && unvisited.nonEmpty) {
        val next = unvisited.top
        if (next.hasNext) {
          val to = next.next()
          if (onPath.contains(to)) {
            found = Some(path.drop(path.indexOf(to)).toList :+ to)
          } else if (!finished.contains(to)) {
            path += to
            onPath += to
            unvisited.push(successors.getOrElse(to, Nil).iterator)
          }
        } else {
          val done = path.remove(path.size - 1)
          onPath -= done
          finished += done
          unvisited.pop()
        }
      }
      found
    }

    operators.iterator
      .map(_.operatorIdentifier.id)
      .filterNot(finished.contains)
      .map(cycleFrom)
      .collectFirst { case Some(found) => found }
  }

  /**
    * This plan as JSON that parses back to it, loop-variable references included: the plan as
    * the editor sends it, as far as a parse can tell. Each operator is written as the editor
    * sends it ([[LogicalPlanPojo.asSent]]).
    */
  def toJson: String = {
    val tree = objectMapper.readTree(objectMapper.writeValueAsString(this))
    Option(tree.get("operators")).foreach(_.elements().asScala.zip(operators).foreach {
      case (written: ObjectNode, operator) => LogicalPlanPojo.asSent(written, operator)
      case _                               => // null: no operator was written
    })
    objectMapper.writeValueAsString(tree)
  }
}

object LogicalPlanPojo {

  /**
    * Makes `written`, the JSON a mapper wrote for `operator`, the JSON an editor sends for it,
    * which parses back to the operator, loop-variable references included.
    *
    * Written with a mapper as it is, the operator would lose its typed references: the parse put
    * a placeholder (`0`, `0.0` or `false`) where each was and recorded it in the operator's
    * sidecar, which the next parse drops. So each reference is put back in place, and the
    * sidecar left out ([[StateReferencing.restoreReferences]]).
    *
    * The properties a compile sets are left out too ([[LogicalOp.propertiesSetByCompiler]]). An
    * editor sends none, every compile replaces whatever a request did send, and what a compile
    * sets is no part of the workflow as its user wrote it: a link to a file is a secret of the
    * plan made to run.
    *
    * @return `written`, changed in place
    */
  def asSent(written: ObjectNode, operator: LogicalOp): ObjectNode = {
    StateReferencing.restoreReferences(written)
    written.remove(LogicalOp.propertiesSetByCompiler(operator.getClass).asJava)
  }
}
