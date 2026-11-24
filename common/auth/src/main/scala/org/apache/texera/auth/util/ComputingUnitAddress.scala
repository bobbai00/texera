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

package org.apache.texera.auth.util

import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.WORKFLOW_COMPUTING_UNIT
import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTypeEnum

import java.net.URI

/**
  * Where a computing unit is reached from inside the deployment. One rule for every service
  * that reaches a unit or routes to one: the access control service, which tells the gateway
  * where to send a unit's websocket, and the Dashboard service, which hands a unit its plans.
  */
object ComputingUnitAddress {

  /**
    * Where computing unit `cuid` is reached: None for a unit there is no record of, and for
    * one whose record gives no address.
    */
  def of(cuid: Int): Option[URI] =
    Option(
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(WORKFLOW_COMPUTING_UNIT.TYPE, WORKFLOW_COMPUTING_UNIT.URI)
        .from(WORKFLOW_COMPUTING_UNIT)
        .where(WORKFLOW_COMPUTING_UNIT.CUID.eq(Integer.valueOf(cuid)))
        .fetchOne()
    ).flatMap(unit =>
      resolve(unit.value1(), unit.value2(), ApplicationConfig.computingUnitEndpoint)
    )

  /**
    * Where a computing unit of `unitType` is reached. A unit Kubernetes runs records the address
    * of its pod inside the cluster: one that records none is reached nowhere. A local unit
    * records the address a browser reaches it at, which says nothing to a service: it is the
    * one unit of its deployment, at `configured` (`web-server.computing-unit-endpoint`).
    */
  def resolve(
      unitType: WorkflowComputingUnitTypeEnum,
      recorded: String,
      configured: String
  ): Option[URI] =
    if (unitType == WorkflowComputingUnitTypeEnum.kubernetes) {
      Option(recorded)
        .map(_.trim)
        .filter(_.nonEmpty)
        .map(uri => new URI(if (uri.contains("://")) uri else s"http://$uri"))
    } else Some(new URI(configured))
}
