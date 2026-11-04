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
import org.apache.texera.amber.core.workflow.GlobalPortIdentity

import scala.collection.concurrent.TrieMap

/**
  * Where an execution's tables live, as the catalog laid it out: the namespace it created and
  * opened for this unit, and the table it named for each external output port. Registered
  * from the start request, before the first worker can write, and again from a later read.
  * Every table of the execution goes into the namespace; an output port the catalog named
  * gets that name, anything else (internal ports, state, console, statistics) keeps the key
  * derived from its URI. An execution nobody registered keeps the configured per-type
  * namespaces, which is how the engine's own tests and a stand-alone unit run.
  */
case class ExecutionLayout(namespace: String, tables: Map[(String, Int), String]) {

  /** The catalog's table for an external output port, if it named one. */
  def tableOf(port: GlobalPortIdentity): Option[String] =
    if (port.portId.internal) None else tables.get((port.opId.logicalOpId.id, port.portId.id))
}

object ExecutionLayouts {
  private val byExecution = new TrieMap[ExecutionIdentity, ExecutionLayout]()

  def register(eid: ExecutionIdentity, layout: ExecutionLayout): Unit =
    if (layout.namespace.nonEmpty) byExecution.put(eid, layout)

  def lookup(eid: ExecutionIdentity): Option[ExecutionLayout] = byExecution.get(eid)
}
