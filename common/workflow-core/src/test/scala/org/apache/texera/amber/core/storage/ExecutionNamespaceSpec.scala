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

package org.apache.texera.amber.core.storage

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class ExecutionNamespaceSpec extends AnyFlatSpec with Matchers {

  "ExecutionNamespace.of" should "name the namespace of an execution after its id" in {
    // The Python side names it the same (core/storage/execution_namespace.py), and the Dashboard
    // service grants each execution the namespace of this name.
    ExecutionNamespace.of(1) shouldBe "execution-1"
    ExecutionNamespace.of(345) shouldBe "execution-345"
    ExecutionNamespace.of(Long.MaxValue) shouldBe s"execution-${Long.MaxValue}"
  }

  it should "keep execution 3 apart from execution 34" in {
    ExecutionNamespace.of(3) should not be ExecutionNamespace.of(34)
  }
}
