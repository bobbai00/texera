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

import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError

/**
  * A workflow that cannot be made into a plan to run, with why, per operator: what a
  * [[CompilationErrorHandling.Strict]] compile throws.
  *
  * The message names the operators with errors, one per line as `"<operator id>: <message>"`, in
  * the order of `operatorErrors`, after a line that counts them. It names the first
  * [[WorkflowCompilationFailed.MaxNamed]] and counts the others; `operatorErrors` holds them all.
  * A compile gives it, as its cause, the error the first operator listed has, so that its stack
  * trace shows where that error was thrown.
  *
  * @param operatorErrors the first error of each operator that has one, as the editing compile
  *                       reports it: a COMPILATION_ERROR that names the operator, whose message is
  *                       the error's class and message. A compile lists them in the order of the
  *                       workflow, an operator before those downstream of it, so the cause of a
  *                       chain of errors comes first. Not empty.
  */
class WorkflowCompilationFailed(val operatorErrors: Map[OperatorIdentity, WorkflowFatalError])
    extends RuntimeException(WorkflowCompilationFailed.describe(operatorErrors))

object WorkflowCompilationFailed {

  /** The most operators the message names. */
  val MaxNamed = 5

  private def describe(operatorErrors: Map[OperatorIdentity, WorkflowFatalError]): String = {
    require(operatorErrors.nonEmpty, "A failed compile holds at least one operator's error.")
    def operators(count: Int): String = if (count == 1) "operator" else "operators"
    val count = operatorErrors.size
    val header = "The workflow does not compile: " +
      (if (count == 1) "1 operator has an error." else s"$count operators have errors.")
    val named = operatorErrors.take(MaxNamed).map {
      case (operator, error) => s"${operator.id}: ${error.message}"
    }
    val others = count - MaxNamed
    val rest = Option.when(others > 0)(s"and $others more ${operators(others)}")
    ((header +: named.toSeq) ++ rest).mkString("\n")
  }
}
