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

import org.apache.texera.amber.core.storage.{
  ExecutionNamespace,
  ExecutionTables,
  IcebergCatalogInstance
}
import org.apache.texera.amber.util.IcebergUtil
import org.apache.texera.auth.CatalogTokens
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.web.service.{CatalogSetup, LakekeeperClient}

object ExecutionCatalogAccess {

  /** What an execution's catalog user may do in its namespace: make, change and read tables. */
  val Grants: Seq[String] = Seq("create", "modify", "select")

  /** The Dashboard service's own, shared by its routes and its jobs. */
  lazy val forDeployment: ExecutionCatalogAccess = new ExecutionCatalogAccess()

  /** The catalog user of execution `eid`, which the execution's token names. */
  def userOf(eid: Long): String =
    CatalogTokens.catalogUserOf(CatalogTokens.executionSubject(eid))
}

/**
  * What an execution may do in the lake, at the Dashboard service. Every table of execution
  * `eid` is in a namespace of its own, `execution-<eid>` ([[ExecutionNamespace]]), in the
  * warehouse it writes into, which this service makes when it creates the execution ([[open]]):
  * no computing unit makes one. On a REST catalog the execution also has a catalog user of its
  * own, which may make, change and read the tables of its namespace and nothing else, and its
  * unit sends the execution's token, which names that user, with every request to the catalog.
  *
  * The token works until it expires ([[CatalogTokens.forExecution]]) or the user is deleted:
  * when the execution's results expire ([[revoke]]), and with its namespace ([[drop]]) when the
  * execution is deleted or its create fails. A close leaves it: the unit still shows the results
  * of the run it ran last, and writes what the run recorded last after its ending.
  *
  * Each call does what is not done yet, so any number of replicas may make the same call.
  *
  * @param lakekeeper the catalog's management API, which only a REST catalog has
  * @param rest       whether the catalog is a REST one, the one kind with users and tokens
  * @param setup      makes the catalog ready, before a namespace is made in it ([[CatalogSetup]])
  */
class ExecutionCatalogAccess(
    lakekeeper: => LakekeeperClient = LakekeeperClient.forDeployment,
    rest: Boolean = StorageConfig.icebergCatalogType == "rest",
    setup: () => Unit = () => CatalogSetup.ensure()
) {
  import ExecutionCatalogAccess.{Grants, userOf}

  /**
    * Makes the namespace of execution `eid` in `warehouse` (None: the one executions write into
    * when they name none); on a REST catalog also the execution's catalog user, granted
    * [[ExecutionCatalogAccess.Grants]] on that namespace.
    *
    * @return the token the execution's catalog requests carry; None on a catalog that is not a
    *         REST one, which takes no token
    */
  def open(eid: Long, warehouse: Option[String]): Option[String] = {
    setup()
    val namespace = ExecutionNamespace.of(eid)
    val catalog = IcebergCatalogInstance.getInstance(warehouse)
    // An execution id is used once, so what the lake already holds under one is stale, such as
    // what a database made afresh beside a catalog that was kept left behind: the catalog user
    // goes, with every grant and ownership it holds in any warehouse, and the namespace here
    // with all it holds, as a table at the URI of a new execution is replaced.
    revoke(eid)
    if (IcebergUtil.namespaceExists(catalog, namespace)) dropNamespace(eid, warehouse)
    IcebergUtil.createNamespace(catalog, namespace)
    Option.when(rest) {
      val client = lakekeeper
      val warehouseName = warehouseNameOf(warehouse)
      val namespaceId = client.namespaceIdOf(warehouseName, namespace).getOrElse {
        throw new IllegalStateException(
          s"Namespace $namespace of warehouse $warehouseName was made, and the catalog has no " +
            "id for it."
        )
      }
      client.createUser(userOf(eid), s"execution $eid")
      client.grantNamespace(namespaceId, userOf(eid), Grants)
      CatalogTokens.forExecution(eid)
    }
  }

  /**
    * Ends what the token of execution `eid` can do: deletes the execution's catalog user, with
    * every grant and every ownership it holds. Nothing happens on a catalog that is not a REST
    * one.
    */
  def revoke(eid: Long): Unit =
    if (rest) lakekeeper.deleteUser(userOf(eid))

  /**
    * Ends what the token of execution `eid` can do ([[revoke]]), then drops its namespace in
    * `warehouse` with all it holds. Revoking first keeps a unit that still runs the execution
    * from making a table while the namespace is emptied. A namespace that is not there is
    * dropped.
    */
  def drop(eid: Long, warehouse: Option[String]): Unit = {
    revoke(eid)
    dropNamespace(eid, warehouse)
  }

  /**
    * Drops the namespace of execution `eid` in `warehouse` with all it holds. A REST catalog
    * drops it itself, with whatever the execution's token made there, tables, views and
    * namespaces, protected or not, each table's files purged. Any other catalog holds the
    * execution's tables alone there, each dropped and purged ([[ExecutionTables.dropNamespace]]).
    */
  private def dropNamespace(eid: Long, warehouse: Option[String]): Unit =
    if (rest) lakekeeper.dropNamespace(warehouseNameOf(warehouse), ExecutionNamespace.of(eid))
    else ExecutionTables.dropNamespace(eid, warehouse)

  private def warehouseNameOf(warehouse: Option[String]): String =
    warehouse.getOrElse(StorageConfig.icebergRESTCatalogWarehouseName)
}
