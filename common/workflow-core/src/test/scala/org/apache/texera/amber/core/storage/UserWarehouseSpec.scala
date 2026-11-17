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

class UserWarehouseSpec extends AnyFlatSpec with Matchers {

  "UserWarehouse.nameOf" should "name a warehouse after its user and its row" in {
    UserWarehouse.nameOf(uid = 12, whid = 7) shouldBe "user-12-7"
  }

  it should "give a name a URI can hold" in {
    VFSURIFactory.isValidWarehouseName(UserWarehouse.nameOf(Int.MaxValue, Int.MaxValue)) shouldBe
      true
  }

  "UserWarehouse.isOwnedBy" should "tell the warehouses of a user by the names it gives them" in {
    UserWarehouse.isOwnedBy(UserWarehouse.nameOf(12, 7), uid = 12) shouldBe true
    UserWarehouse.isOwnedBy(UserWarehouse.nameOf(12, 7000), uid = 12) shouldBe true
  }

  it should "take no other name for a warehouse of the user" in {
    val notTheirs = Seq(
      // another user's, also one whose id starts or ends as theirs does
      UserWarehouse.nameOf(13, 7),
      UserWarehouse.nameOf(1, 27),
      UserWarehouse.nameOf(121, 7),
      "user-012-7",
      // not a name the Dashboard gives a warehouse
      "user-12",
      "user-12-",
      "user-12-seven",
      "user-12-7-8",
      "user-12-7/../user-13-1",
      "USER-12-7",
      " user-12-7",
      "team-12-7",
      "",
      null
    )
    notTheirs.foreach { name =>
      withClue(s"$name: ") { UserWarehouse.isOwnedBy(name, uid = 12) shouldBe false }
    }
  }
}
