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

/**
  * Controls what the compiler does with the errors of a workflow's operators. Either way it goes
  * on past an operator's error — in file resolution, logical-to-physical expansion and schema
  * propagation — so that it finds every operator's errors. And either way a failure that is no
  * operator's error, such as the database or the storage not answering, is thrown as it is.
  *
  *   - [[CompilationErrorHandling.Lenient]] returns them in the result, with
  *     `physicalPlan = None` when any error occurred. Used for editing-time validation.
  *   - [[CompilationErrorHandling.Strict]] throws them together, as a [[WorkflowCompilationFailed]]
  *     that holds each operator's first error. It also links the file each scan source reads,
  *     and a file that cannot be linked is its scan's error. Only a plan with no error goes on to
  *     pin the datasets and models its operators name; every operator is bound, and the binding
  *     errors are thrown the same way. Used before execution, so a plan made to run has no
  *     error.
  */
sealed trait CompilationErrorHandling

object CompilationErrorHandling {
  case object Lenient extends CompilationErrorHandling
  case object Strict extends CompilationErrorHandling
}
