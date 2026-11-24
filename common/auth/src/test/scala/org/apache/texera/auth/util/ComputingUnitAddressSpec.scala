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

import org.apache.texera.dao.jooq.generated.enums.WorkflowComputingUnitTypeEnum
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI

/**
  * Where a computing unit is reached from inside the deployment, given what its record holds
  * ([[ComputingUnitAddress.resolve]]). The rule read off a unit's row
  * ([[ComputingUnitAddress.of]]) is shown through the access control service, which routes a
  * unit's websocket by it (`AccessControlResourceSpec`).
  */
class ComputingUnitAddressSpec extends AnyFlatSpec with Matchers {

  private val configured = "http://workflow-runtime-coordinator-service:8085"
  private val clusterAddress = "computing-unit-9772.unit-svc.unit-pool.svc.cluster.local:8085"

  private def kubernetes(recorded: String): Option[URI] =
    ComputingUnitAddress.resolve(WorkflowComputingUnitTypeEnum.kubernetes, recorded, configured)

  "ComputingUnitAddress.resolve" should
    "be the address a unit Kubernetes runs records, over HTTP unless it names a scheme" in {
    kubernetes(clusterAddress) shouldBe Some(new URI(s"http://$clusterAddress"))
    kubernetes(s"  $clusterAddress\n") shouldBe Some(new URI(s"http://$clusterAddress"))
    kubernetes("https://units.example:8443") shouldBe Some(new URI("https://units.example:8443"))
    // A unit's routes resolve against it, and the gateway routes by its authority.
    kubernetes(clusterAddress).map(_.resolve("/api/execution/start")) shouldBe
      Some(new URI(s"http://$clusterAddress/api/execution/start"))
    kubernetes(clusterAddress).map(_.getAuthority) shouldBe Some(clusterAddress)
  }

  it should "be none for a unit Kubernetes runs that records no address" in {
    Seq("", "   ", null).foreach { recorded =>
      withClue(s"'$recorded': ") { kubernetes(recorded) shouldBe None }
    }
  }

  it should "be the deployment's one unit for a local unit, whatever it records" in {
    // A local unit records where a browser reaches it, which says nothing to a service.
    Seq("http://localhost:8080/wsapi", "local://test", "", null).foreach { recorded =>
      withClue(s"'$recorded': ") {
        val address =
          ComputingUnitAddress.resolve(WorkflowComputingUnitTypeEnum.local, recorded, configured)
        address shouldBe Some(new URI(configured))
        address.map(_.getAuthority) shouldBe Some("workflow-runtime-coordinator-service:8085")
      }
    }
  }

  it should "take a unit whose record names no type for the deployment's one unit" in {
    ComputingUnitAddress.resolve(null, clusterAddress, configured) shouldBe
      Some(new URI(configured))
  }
}
