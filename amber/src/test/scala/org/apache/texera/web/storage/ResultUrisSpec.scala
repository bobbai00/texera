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

package org.apache.texera.web.storage

import org.apache.texera.amber.core.virtualidentity.{OperatorIdentity, PhysicalOpIdentity}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI

class ResultUrisSpec extends AnyFlatSpec with Matchers {

  private def port(
      operator: String,
      portId: PortIdentity = PortIdentity(),
      layer: String = "main"
  ): GlobalPortIdentity =
    GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity(operator), layer), portId)

  private def uri(name: String): URI = new URI(s"vfs:///wid/1/eid/2/globalportid/$name/result")

  "ResultUris" should "know no result until the engine reports one" in {
    val resultUris = new ResultUris

    resultUris.all shouldBe empty
    resultUris.of(OperatorIdentity("filter"), PortIdentity()) shouldBe None
  }

  it should "find the result of an operator's output port once the engine has reported it" in {
    val resultUris = new ResultUris
    resultUris.add(port("filter"), uri("filter-0"))
    resultUris.add(port("filter", PortIdentity(1)), uri("filter-1"))
    resultUris.add(port("sort"), uri("sort-0"))

    resultUris.of(OperatorIdentity("filter"), PortIdentity()) shouldBe Some(uri("filter-0"))
    resultUris.of(OperatorIdentity("filter"), PortIdentity(1)) shouldBe Some(uri("filter-1"))
    resultUris.of(OperatorIdentity("sort"), PortIdentity()) shouldBe Some(uri("sort-0"))
    // A port that is not stored, and an operator that stores none.
    resultUris.of(OperatorIdentity("sort"), PortIdentity(1)) shouldBe None
    resultUris.of(OperatorIdentity("limit"), PortIdentity()) shouldBe None
    resultUris.all shouldBe Map(
      port("filter") -> uri("filter-0"),
      port("filter", PortIdentity(1)) -> uri("filter-1"),
      port("sort") -> uri("sort-0")
    )
  }

  it should "find an operator's result on whichever of its physical operators stores it" in {
    val resultUris = new ResultUris
    resultUris.add(port("join", layer = "probe"), uri("join-probe-0"))

    resultUris.of(OperatorIdentity("join"), PortIdentity()) shouldBe Some(uri("join-probe-0"))
  }

  it should "take no internal port for an operator's result" in {
    val resultUris = new ResultUris
    // What a build layer hands its probe layer is stored too, on a port the operator does not show.
    val internal = PortIdentity(0, internal = true)
    resultUris.add(port("join", internal, layer = "build"), uri("join-build-internal"))

    resultUris.of(OperatorIdentity("join"), PortIdentity()) shouldBe None
    resultUris.of(OperatorIdentity("join"), internal) shouldBe None
    resultUris.all.keySet shouldBe Set(port("join", internal, layer = "build"))
  }

  it should "keep one result per port, the one reported last" in {
    val resultUris = new ResultUris
    resultUris.add(port("filter"), uri("first"))
    resultUris.add(port("filter"), uri("second"))

    resultUris.of(OperatorIdentity("filter"), PortIdentity()) shouldBe Some(uri("second"))
    resultUris.all should have size 1
  }
}
