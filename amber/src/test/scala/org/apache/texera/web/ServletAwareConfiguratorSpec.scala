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

package org.apache.texera.web

import org.apache.texera.web.auth.{UnitJwtAuth, UnitPrincipal}
import org.scalamock.scalatest.MockFactory
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import javax.websocket.server.{HandshakeRequest, ServerEndpointConfig}
import scala.jdk.CollectionConverters._

/**
  * The handshake is where a WebSocket connection gets its caller, and the unit trusts only a
  * token it verified itself: from the `access-token` query parameter or a bearer Authorization
  * header. Identity headers are ignored, whoever set them. Verification (RS256 against the
  * identity provider's JWKS) is stubbed so only the tokens named here are valid.
  */
class ServletAwareConfiguratorSpec extends AnyFlatSpec with Matchers with MockFactory {

  private val alice = UnitPrincipal(
    "3f1c2a64-0000-4000-8000-00000000a11c",
    "alice",
    Some("alice@example.org"),
    UnitPrincipal.Regular
  )

  private def withTokens[T](valid: Map[String, UnitPrincipal])(body: => T): T = {
    val previous = UnitJwtAuth.verifier
    UnitJwtAuth.verifier = valid.get
    try body
    finally UnitJwtAuth.verifier = previous
  }

  private def handshake(
      headers: Map[String, Seq[String]] = Map.empty,
      queryString: String = null,
      properties: java.util.Map[String, AnyRef] = new java.util.HashMap[String, AnyRef]()
  ): java.util.Map[String, AnyRef] = {
    val request = mock[HandshakeRequest]
    (() => request.getHeaders)
      .expects()
      .returning(headers.map { case (k, v) => k -> v.asJava }.asJava)
      .anyNumberOfTimes()
    (() => request.getQueryString).expects().returning(queryString).anyNumberOfTimes()
    val config = mock[ServerEndpointConfig]
    (() => config.getUserProperties).expects().returning(properties).anyNumberOfTimes()
    new ServletAwareConfigurator().modifyHandshake(config, request, null)
    properties
  }

  private def callerIn(properties: java.util.Map[String, AnyRef]): Option[UnitPrincipal] =
    Option(properties.get(ServletAwareConfigurator.PrincipalKey)).map(_.asInstanceOf[UnitPrincipal])

  "modifyHandshake" should "take the caller from a verified access-token query parameter" in {
    // Other parameters around the token, so "the query string is the token" would not pass.
    withTokens(Map("the-token" -> alice)) {
      callerIn(handshake(queryString = "wid=1&access-token=the-token&cuid=2")) shouldBe Some(alice)
    }
  }

  it should "take the caller from a bearer Authorization header" in {
    withTokens(Map("the-token" -> alice)) {
      callerIn(handshake(headers = Map("Authorization" -> Seq("Bearer the-token")))) shouldBe Some(
        alice
      )
    }
  }

  it should "record no caller for a token that does not verify" in {
    withTokens(Map("the-token" -> alice)) {
      callerIn(handshake(queryString = "access-token=forged")) shouldBe None
      callerIn(handshake()) shouldBe None
    }
  }

  it should "ignore identity headers, which anyone who reaches the unit could set" in {
    withTokens(Map.empty) {
      val forged = Map(
        "x-user-id" -> Seq("1"),
        "x-user-name" -> Seq("admin"),
        "x-user-email" -> Seq("admin@example.org"),
        "x-user-computing-unit-access" -> Seq("WRITE")
      )
      callerIn(handshake(headers = forged)) shouldBe None
    }
  }

  it should "drop a caller left in shared properties by an earlier handshake when this one fails" in {
    withTokens(Map("the-token" -> alice)) {
      val shared = handshake(queryString = "access-token=the-token")
      callerIn(handshake(queryString = "access-token=forged", properties = shared)) shouldBe None
    }
  }
}
