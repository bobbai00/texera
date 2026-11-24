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

package org.apache.texera.web.resource

import org.apache.texera.auth.util.HeaderField
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import javax.ws.rs.WebApplicationException
import javax.ws.rs.core.MediaType

/**
  * Who a request to one of a computing unit's routes is for ([[UnitCaller]]): the user its
  * caller names by id in a header, and nobody when it names none. A unit reads no token.
  */
class UnitCallerSpec extends AnyFlatSpec with Matchers {

  "UnitCaller.of" should "be the user the request names by id" in {
    val user = UnitCaller.of(CallerHeaders.of(4711)).getOrElse(fail("the request names a user"))

    user.getUid.intValue() shouldBe 4711
    // The id is all a route reads of its caller, and all a caller sends.
    (user.getName, user.getEmail) shouldBe ((null, null))
  }

  it should "read the header whatever case its name comes in, and a padded id as the number it holds" in {
    Seq("x-user-id" -> "4711", "X-User-Id" -> " 4711 ", "X-USER-ID" -> "4711\t").foreach {
      case (name, value) =>
        withClue(s"$name: '$value': ") {
          UnitCaller.of(CallerHeaders.holding(Map(name -> value))).map(_.getUid.intValue()) shouldBe
            Some(4711)
        }
    }
    HeaderField.UserId shouldBe "x-user-id"
  }

  it should "be nobody for a request that names no user, or names one by what is no number" in {
    Seq(
      Map.empty[String, String],
      Map(HeaderField.UserId -> ""),
      Map(HeaderField.UserId -> "   "),
      Map(HeaderField.UserId -> "texera"),
      Map(HeaderField.UserId -> "47.11"),
      // Larger than a user's id can be.
      Map(HeaderField.UserId -> "99999999999"),
      // A name, an address and a token name nobody: a route goes by the id alone.
      Map(
        HeaderField.UserName -> "texera",
        HeaderField.UserEmail -> "texera@example.com",
        "Authorization" -> "Bearer a-users-own-token"
      )
    ).foreach { headers =>
      withClue(s"$headers: ") { UnitCaller.of(CallerHeaders.holding(headers)) shouldBe None }
    }
  }

  "UnitCaller.required" should "be the user the request names" in {
    UnitCaller.required(CallerHeaders.of(7)).getUid.intValue() shouldBe 7
  }

  it should "answer 401, saying that the request names no user, when it names none" in {
    val refused = the[WebApplicationException] thrownBy UnitCaller.required(CallerHeaders.none)

    refused.getResponse.getStatus shouldBe 401
    refused.getResponse.getMediaType shouldBe MediaType.APPLICATION_JSON_TYPE
    refused.getResponse.getEntity shouldBe HandoverRefusal("The request names no user.")
    UnitCaller.NoUser shouldBe "The request names no user."
  }
}
