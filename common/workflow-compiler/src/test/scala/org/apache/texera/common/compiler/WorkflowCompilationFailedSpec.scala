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

import com.google.protobuf.timestamp.Timestamp
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.COMPILATION_ERROR
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.scalatest.flatspec.AnyFlatSpec

import scala.collection.immutable.VectorMap

/**
  * The message of [[WorkflowCompilationFailed]], which the log of a run that does not compile
  * shows; the run itself reports each operator's error on its own. `WorkflowCompilerSpec` covers
  * which errors a Strict compile puts in it, and in what order.
  */
class WorkflowCompilationFailedSpec extends AnyFlatSpec {

  private def errorOf(operator: String, message: String): (OperatorIdentity, WorkflowFatalError) =
    OperatorIdentity(operator) ->
      WorkflowFatalError(COMPILATION_ERROR, Timestamp(), message, s"stack of $operator", operator)

  /** Operators op-1 to op-`count`, in that order, each with an error of its own. */
  private def errorsOf(count: Int): VectorMap[OperatorIdentity, WorkflowFatalError] =
    VectorMap.from(
      (1 to count).map(i => errorOf(s"op-$i", s"java.lang.RuntimeException: error $i"))
    )

  "WorkflowCompilationFailed" should "name its one operator and that operator's error" in {
    val failure = new WorkflowCompilationFailed(
      VectorMap(errorOf("scan-op", "java.lang.RuntimeException: No file selected."))
    )

    assert(
      failure.getMessage ==
        "The workflow does not compile: 1 operator has an error.\n" +
          "scan-op: java.lang.RuntimeException: No file selected."
    )
  }

  it should "name each operator with its own error, in the order it is given them" in {
    // Not the operators' order by name: the compiler lists them upstream first.
    val failure = new WorkflowCompilationFailed(
      VectorMap(
        errorOf("Projection-b", "java.lang.IllegalArgumentException: no column \"Größe\""),
        errorOf("CSVFileScan-a", "java.lang.RuntimeException: No file selected.")
      )
    )

    assert(
      failure.getMessage ==
        "The workflow does not compile: 2 operators have errors.\n" +
          "Projection-b: java.lang.IllegalArgumentException: no column \"Größe\"\n" +
          "CSVFileScan-a: java.lang.RuntimeException: No file selected."
    )
  }

  it should "name all five operators when five have errors" in {
    val failure = new WorkflowCompilationFailed(errorsOf(5))

    assert(
      failure.getMessage ==
        ("The workflow does not compile: 5 operators have errors." +:
          (1 to 5).map(i => s"op-$i: java.lang.RuntimeException: error $i")).mkString("\n")
    )
  }

  it should "name the first five operators and count the others" in {
    val six = new WorkflowCompilationFailed(errorsOf(6))
    assert(
      six.getMessage ==
        (("The workflow does not compile: 6 operators have errors." +:
          (1 to 5).map(i => s"op-$i: java.lang.RuntimeException: error $i")) :+
          "and 1 more operator").mkString("\n")
    )

    val seven = new WorkflowCompilationFailed(errorsOf(7))
    assert(seven.getMessage.startsWith("The workflow does not compile: 7 operators have errors.\n"))
    assert(seven.getMessage.linesIterator.toList.last == "and 2 more operators")
    assert(!seven.getMessage.contains("op-6") && !seven.getMessage.contains("op-7"))
  }

  it should "hold every operator's error, those its message leaves out too" in {
    val errors = errorsOf(7)

    val failure = new WorkflowCompilationFailed(errors)

    assert(failure.operatorErrors == errors)
    assert(failure.operatorErrors.keys.toList == errors.keys.toList)
  }

  it should "refuse to be made without an operator's error" in {
    val refusal = intercept[IllegalArgumentException] {
      new WorkflowCompilationFailed(Map.empty)
    }
    assert(refusal.getMessage.contains("at least one operator's error"), refusal.getMessage)
  }
}
