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

import org.apache.texera.common.config.StorageConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.USER_WAREHOUSE

/**
  * The warehouse an execution writes into, which is checked when it is created
  * ([[resolveLakekeeperWarehouseName]]). What an execution keeps there is dropped by
  * [[ExecutionExpiry]].
  */
object ExecutionResources {

  /**
    * Maps an execution's chosen warehouse (its user_warehouse row id) to its Lakekeeper
    * warehouse name, checking that the requesting user owns it.
    *
    * With warehouses enabled a pick is **required**, the same way a computing unit is:
    * falling back to the shared default would make "a run writes into the user's own
    * warehouse" a UI convention rather than a system property, and would silently route
    * any caller that forgot to pick into shared storage (#7751).
    *
    * With warehouses disabled, an explicit pick is refused loudly rather than silently
    * routed into the shared warehouse, and no pick keeps the shared default (#6930).
    *
    * @throws IllegalArgumentException if the pick breaks one of these rules, in words the user
    *                                  can act on
    */
  def resolveLakekeeperWarehouseName(
      warehouseId: Option[Int],
      uid: Integer,
      enabled: Boolean = StorageConfig.warehouseEnabled
  ): Option[String] = {
    if (!enabled) {
      warehouseId.foreach(_ =>
        throw new IllegalArgumentException(
          "Per-user warehouses are disabled in this deployment."
        )
      )
      return None
    }
    if (warehouseId.isEmpty) {
      throw new IllegalArgumentException(
        "A warehouse must be selected for this execution."
      )
    }
    warehouseId.map(id => {
      val lakekeeperWarehouseName = SqlServer
        .getInstance()
        .createDSLContext()
        .select(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)
        .from(USER_WAREHOUSE)
        .where(USER_WAREHOUSE.WHID.eq(id).and(USER_WAREHOUSE.UID.eq(uid)))
        .fetchOne(USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME)
      if (lakekeeperWarehouseName == null) {
        throw new IllegalArgumentException(s"You have no warehouse with id $id.")
      }
      lakekeeperWarehouseName
    })
  }
}
