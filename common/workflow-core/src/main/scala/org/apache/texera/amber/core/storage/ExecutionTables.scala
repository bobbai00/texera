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

import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}

import java.net.URI

/**
  * The tables an execution keeps in the lake. Each is one Iceberg table in the warehouse the
  * execution writes into, found without a registry: its log, statistics and console at URIs its
  * ids name ([[ownTables]]), and the result and the state of each output port it stored, found
  * by their names ([[portTables]]), since every table of an execution is named after its
  * workflow and the execution.
  *
  * The stores of the three own tables ([[ExecutionLogStore]], [[RuntimeStatisticsStore]],
  * [[ConsoleMessageStore]]) share these rules:
  *
  *  - A method takes only a URI the store's own builder could have made, and refuses any other:
  *    anything more, such as another segment, would name another table.
  *  - An execution id is used once, so a table already at the URI of a new execution is stale,
  *    and making the table replaces it.
  *  - A table that is not there is an answer. A read of the log, statistics or console finds
  *    nothing, a write to them fails with [[NoSuchExecutionTableException]], and a drop does
  *    nothing. Any other failure of the catalog or the object store is thrown as it is, so a
  *    lake that cannot answer is never taken for a missing table.
  *  - The engine that runs the execution is the one writer of its log, statistics and console.
  */
object ExecutionTables {

  /** The kinds of table that hold what a run produced: its results, their states, its console. */
  val ProducedKinds: Seq[VFSResourceType.Value] =
    Seq(VFSResourceType.RESULT, VFSResourceType.STATE, VFSResourceType.CONSOLE_MESSAGES)

  val AllKinds: Seq[VFSResourceType.Value] =
    ProducedKinds ++
      Seq(VFSResourceType.RUNTIME_STATISTICS, VFSResourceType.EXECUTION_LOG)

  /** The execution's three own tables. A `warehouse` of None is the default warehouse. */
  def ownTables(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String]
  ): Seq[URI] =
    Seq(
      ExecutionLogStore.logUri(wid, eid, warehouse),
      RuntimeStatisticsStore.statisticsUri(wid, eid, warehouse),
      ConsoleMessageStore.consoleUri(wid, eid, warehouse)
    )

  /**
    * The result table and the state table of every output port execution `eid` of workflow `wid`
    * stored, found by their names: a run stores only some of its ports, and the tables say which.
    * It lists the whole namespace of each of the two kinds to find them.
    */
  def portTables(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String]
  ): Seq[URI] =
    Seq(VFSResourceType.RESULT, VFSResourceType.STATE).flatMap(
      DocumentFactory.tablesOf(wid, eid, warehouse, _)
    )

  def exists(uri: URI): Boolean = DocumentFactory.icebergTableOf(uri).isDefined

  /** @return false when there was no table at `uri` */
  def drop(uri: URI): Boolean = DocumentFactory.dropTable(uri)

  /**
    * Drops the execution's tables of `kinds`, going by their names: every table of an execution
    * is named after its workflow and the execution. It lists the whole namespace of each kind to
    * find them.
    *
    * @return the names of the tables dropped
    */
  def dropNamed(
      wid: WorkflowIdentity,
      eid: ExecutionIdentity,
      warehouse: Option[String],
      kinds: Seq[VFSResourceType.Value]
  ): Seq[String] = kinds.flatMap(DocumentFactory.dropTablesOf(wid, eid, warehouse, _))

  /**
    * Whether `port` is output port `portId` of logical operator `operatorId` as the workflow's
    * users see it: an external port of one of the operator's physical operators. Every lookup
    * of a logical operator's result goes by this rule.
    */
  def isOutputOf(
      port: GlobalPortIdentity,
      operatorId: OperatorIdentity,
      portId: PortIdentity
  ): Boolean =
    !port.portId.internal && port.opId.logicalOpId == operatorId && port.portId == portId

  /**
    * Of `tables`, the result table of output port `portId` of logical operator `operatorId`
    * (see [[isOutputOf]]).
    *
    * @throws IllegalArgumentException if one of `tables` looked at is no table of an execution
    */
  def resultTableAmong(
      tables: Iterable[URI],
      operatorId: OperatorIdentity,
      portId: PortIdentity
  ): Option[URI] =
    tables.find { uri =>
      val named = VFSURIFactory.decodeURI(uri)
      named.resourceType == VFSResourceType.RESULT &&
      named.globalPortId.exists(isOutputOf(_, operatorId, portId))
    }

  /**
    * The bytes of the data files of the table at `uri`, as its newest snapshot counts them
    * (`total-files-size`); 0 when there is no such table, or nothing was written to it.
    */
  def storedBytes(uri: URI): Long =
    DocumentFactory
      .icebergTableOf(uri)
      .flatMap(table => Option(table.currentSnapshot()))
      .flatMap(snapshot => Option(snapshot.summary().get("total-files-size")))
      .flatMap(_.toLongOption)
      .getOrElse(0L)
}
