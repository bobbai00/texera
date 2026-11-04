/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.texera.amber.core.storage

import org.apache.texera.amber.core.virtualidentity.ExecutionIdentity

import scala.collection.concurrent.TrieMap

/**
  * The Iceberg namespace each execution's tables live in, when the catalog named one: the
  * catalog creates the namespace, grants this unit write access to it, and asks for it in the
  * start request (ResultStore.namespace) and in every later read. Every table of the execution,
  * results and state alike, goes there; an execution nobody registered keeps the configured
  * per-type namespaces, which is how the engine's own tests and a stand-alone unit run.
  */
object ExecutionNamespaces {
  private val byExecution = new TrieMap[ExecutionIdentity, String]()

  def register(eid: ExecutionIdentity, namespace: String): Unit =
    if (namespace.nonEmpty) byExecution.put(eid, namespace)

  def lookup(eid: ExecutionIdentity): Option[String] = byExecution.get(eid)
}
