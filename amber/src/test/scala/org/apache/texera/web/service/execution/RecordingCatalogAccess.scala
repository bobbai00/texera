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

package org.apache.texera.web.service.execution

import org.apache.iceberg.catalog.{Namespace, SupportsNamespaces}
import org.apache.texera.amber.core.storage.IcebergCatalogInstance
import org.apache.texera.web.service.LakekeeperClient

import java.util.concurrent.{ConcurrentHashMap, CopyOnWriteArrayList}
import scala.jdk.CollectionConverters._

object RecordingLakekeeper {

  /** What the Dashboard service asked of Lakekeeper's management API. */
  sealed trait Call

  final case class LookedUp(warehouse: String, namespace: String) extends Call

  final case class UserMade(id: String, name: String) extends Call

  final case class Granted(namespaceId: String, user: String, kinds: Seq[String]) extends Call

  final case class UserDeleted(id: String) extends Call

  final case class NamespaceDropped(warehouse: String, namespace: String) extends Call

  /** The id it answers for namespace `namespace` of warehouse `warehouse`. */
  def idOf(warehouse: String, namespace: String): String = s"$warehouse/$namespace"
}

/**
  * Lakekeeper's management API as a suite has it, reaching no server: it keeps what it is asked,
  * in the order it was, and answers the id of a namespace the catalog the build's tests use has
  * ([[RecordingLakekeeper.idOf]]), and no id for one it has not.
  */
class RecordingLakekeeper extends LakekeeperClient("http://lakekeeper.invalid/catalog") {
  import RecordingLakekeeper._

  private val asked = new CopyOnWriteArrayList[Call]()

  /** What it was asked, in the order it was. */
  def calls: Seq[Call] = asked.asScala.toSeq

  /** The catalog users it deleted, in the order it did. */
  def deleted: Seq[String] = calls.collect { case UserDeleted(id) => id }

  /**
    * Whether catalog user `id` was deleted since it was last made, or ever if it never was: its
    * token can do nothing. The delete a make starts with, of any stale user of the id, comes
    * before the make, so it is not one.
    */
  def revokedSinceMade(id: String): Boolean =
    calls
      .collect {
        case UserMade(`id`, _) => false
        case UserDeleted(`id`) => true
      }
      .lastOption
      .contains(true)

  override def namespaceIdOf(warehouseName: String, namespace: String): Option[String] = {
    asked.add(LookedUp(warehouseName, namespace))
    val catalog = IcebergCatalogInstance.getInstance(Some(warehouseName))
    Option.when(catalog.asInstanceOf[SupportsNamespaces].namespaceExists(Namespace.of(namespace)))(
      idOf(warehouseName, namespace)
    )
  }

  override def createUser(id: String, name: String): Unit = asked.add(UserMade(id, name))

  override def grantNamespace(namespaceId: String, user: String, kinds: Seq[String]): Unit =
    asked.add(Granted(namespaceId, user, kinds))

  override def deleteUser(id: String): Unit = asked.add(UserDeleted(id))

  /** Drops the namespace in the catalog the build's tests use, with its tables, as Lakekeeper does. */
  override def dropNamespace(warehouseName: String, namespace: String): Unit = {
    asked.add(NamespaceDropped(warehouseName, namespace))
    val catalog = IcebergCatalogInstance.getInstance(Some(warehouseName))
    val namespaces = catalog.asInstanceOf[SupportsNamespaces]
    if (namespaces.namespaceExists(Namespace.of(namespace))) {
      catalog.listTables(Namespace.of(namespace)).asScala.foreach(catalog.dropTable(_, true))
      namespaces.dropNamespace(Namespace.of(namespace))
    }
  }
}

/**
  * The Dashboard service's catalog access as a suite has it: each execution's namespace is made
  * and dropped in the catalog the build's tests use, as on any catalog, its catalog user and
  * grants go to `management`, as on a REST one, and each execution it opens gets a token of its
  * own, which it keeps. It sets no catalog up.
  */
class RecordingCatalogAccess(val management: RecordingLakekeeper = new RecordingLakekeeper())
    extends ExecutionCatalogAccess(management, rest = true, setup = () => ()) {

  private val tokens = new ConcurrentHashMap[Long, String]()

  /** The executions it opened, each with the token it answered last. */
  def opened: Map[Long, String] = tokens.asScala.toMap

  override def open(eid: Long, warehouse: Option[String]): Option[String] = {
    val token = super.open(eid, warehouse)
    token.foreach(tokens.put(eid, _))
    token
  }
}
