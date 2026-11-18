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

package org.apache.texera.amber.core.workflow

import org.apache.texera.amber.core.executor.OpExecInitInfo
import org.apache.texera.amber.core.storage.RepositoryVersionResolver

/**
  * The datasets and models an operator's code names, left for the plan made to run to pin.
  *
  * A compile-time callback, like the schema propagation function. Pinning a version is a
  * database lookup with an access check, and the editing-time compile runs on every edit, so
  * that compile leaves the binding alone. The compile that makes a plan to run forces it once
  * and keeps only what it gives, as data on the operator ([[BoundResources]]). The engine is
  * never handed a binding.
  */
trait ResourceBinding {

  def bind(resolver: RepositoryVersionResolver): BoundResources
}

/**
  * What a [[ResourceBinding]] gives.
  *
  * @param opExecInitInfo the executor, with each version's locator in its path's place
  * @param mountLocators  the repositories to mount, each a [[RepositoryMounts.locator]]
  */
final case class BoundResources(opExecInitInfo: OpExecInitInfo, mountLocators: Set[String])
