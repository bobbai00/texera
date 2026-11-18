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

import org.apache.texera.dao.MockTexeraDB
import org.apache.texera.dao.jooq.generated.Tables.USER_WAREHOUSE
import org.apache.texera.dao.jooq.generated.enums.UserWarehouseFlavorEnum
import org.apache.texera.dao.jooq.generated.tables.daos.UserDao
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.util.UUID

/**
  * Specs for [[ExecutionResources]]: the warehouse an execution writes into. The rows are in
  * `MockTexeraDB`.
  */
class ExecutionResourcesSpec
    extends AnyFlatSpec
    with Matchers
    with BeforeAndAfterAll
    with MockTexeraDB {

  private val testUid = 9431

  /** A user who owns no warehouse, and so may write into none. */
  private val intruderUid = 9434

  private val warehouseName = s"user-$testUid-7"

  /** The id of `testUid`'s warehouse, the row named `warehouseName`. */
  private var whid: Integer = _

  override protected def beforeAll(): Unit = {
    initializeDBAndReplaceDSLContext()
    val cfg = getDSLContext.configuration()

    Seq(testUid -> "execution_resources_spec_user", intruderUid -> "execution_resources_intruder")
      .foreach {
        case (uid, name) =>
          val user = new User
          user.setUid(uid)
          user.setName(name)
          user.setEmail(s"execution-resources-${UUID.randomUUID()}@example.com")
          new UserDao(cfg).insert(user)
      }

    val warehouse = getDSLContext.newRecord(USER_WAREHOUSE)
    warehouse.setUid(testUid)
    warehouse.setName("execution-resources-warehouse")
    warehouse.setLakekeeperWarehouseName(warehouseName)
    warehouse.setLakekeeperWarehouseId(UUID.randomUUID())
    warehouse.setFlavor(UserWarehouseFlavorEnum.local)
    warehouse.store()
    whid = warehouse.getWhid
  }

  override protected def afterAll(): Unit = closeConnectionPool()

  "ExecutionResources.resolveLakekeeperWarehouseName" should "require a pick while warehouses are enabled" in {
    // A run must name the warehouse it writes into, the same way it names a computing unit;
    // falling back to the shared default would route a caller that forgot to pick into shared
    // storage (#7751).
    val error = intercept[IllegalArgumentException] {
      ExecutionResources.resolveLakekeeperWarehouseName(None, testUid, enabled = true)
    }
    error.getMessage shouldBe "A warehouse must be selected for this execution."
  }

  it should "keep the shared default warehouse when nothing is picked and the feature is off" in {
    ExecutionResources.resolveLakekeeperWarehouseName(None, testUid, enabled = false) shouldBe None
  }

  it should "resolve an owned warehouse to its Lakekeeper name" in {
    ExecutionResources.resolveLakekeeperWarehouseName(Some(whid), testUid, enabled = true) shouldBe
      Some(warehouseName)
  }

  it should "refuse another user's warehouse" in {
    val error = intercept[IllegalArgumentException] {
      ExecutionResources.resolveLakekeeperWarehouseName(Some(whid), intruderUid, enabled = true)
    }
    error.getMessage shouldBe s"You have no warehouse with id $whid."
  }

  it should "refuse an explicit pick while warehouses are disabled" in {
    // Never route the run into the shared warehouse silently (#6930).
    val error = intercept[IllegalArgumentException] {
      ExecutionResources.resolveLakekeeperWarehouseName(Some(whid), testUid, enabled = false)
    }
    error.getMessage shouldBe "Per-user warehouses are disabled in this deployment."
  }
}
