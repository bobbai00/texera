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

import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import org.apache.texera.auth.JwtAuth
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.jooq.generated.enums.PrivilegeEnum
import org.apache.texera.dao.jooq.generated.tables.pojos.User
import org.jose4j.jwt.JwtClaims
import org.scalamock.scalatest.MockFactory
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import javax.websocket.server.{HandshakeRequest, ServerEndpointConfig}
import scala.jdk.CollectionConverters._

/**
  * The websocket handshake configurator, the one place a websocket to a computing unit gets its
  * identity: the access and the user the gateway names in the `x-user-*` headers, once the
  * access control service has checked the user's token. A unit verifies no token, so a
  * handshake that carries no such identity gets none, whatever else it carries.
  *
  * What the configurator writes goes into `ServerEndpointConfig.getUserProperties`, the map
  * `WorkflowWebsocketResource.myOnOpen` and `myOnMsg` read: the access under
  * [[HeaderField.UserComputingUnitAccess]], and the user under `User`'s class name. Every
  * assertion reads values back out of that map. A session whose map holds no access is closed
  * by `myOnOpen` (`WorkflowWebsocketResourceSpec`).
  *
  * The tokens here are minted with the production `JwtAuth.jwtToken`, so they are ones every
  * service that checks tokens accepts: that a unit makes nothing of them is its own doing. No
  * socket, container, database or filesystem is involved.
  */
class ServletAwareConfiguratorSpec extends AnyFlatSpec with Matchers with MockFactory {

  private val userId = "77"
  private val userName = "gateway-subject"
  private val userEmail = "gateway-mail@example.com"

  /** The four headers the gateway sets, each value distinct from the others. */
  private val gatewayHeaders: Map[String, Seq[String]] = Map(
    HeaderField.UserComputingUnitAccess -> Seq(PrivilegeEnum.READ.name()),
    HeaderField.UserId -> Seq(userId),
    HeaderField.UserName -> Seq(userName),
    HeaderField.UserEmail -> Seq(userEmail)
  )

  private def handshake(
      headers: Map[String, Seq[String]] = Map.empty,
      queryString: String = ""
  ): (ServerEndpointConfig, HandshakeRequest, java.util.Map[String, AnyRef]) = {
    val javaHeaders = headers.map { case (name, values) => name -> values.asJava }.asJava
    val request = mock[HandshakeRequest]
    (() => request.getHeaders).expects().returning(javaHeaders).anyNumberOfTimes()
    (() => request.getQueryString).expects().returning(queryString).anyNumberOfTimes()

    val properties = new java.util.HashMap[String, AnyRef]()
    val config = mock[ServerEndpointConfig]
    (() => config.getUserProperties).expects().returning(properties).anyNumberOfTimes()

    (config, request, properties)
  }

  private def userIn(properties: java.util.Map[String, AnyRef]): User =
    properties.get(classOf[User].getName).asInstanceOf[User]

  /** A token every service that checks tokens accepts, for user `uid`. */
  private def tokenFor(subject: String, uid: Int, email: String): String = {
    val claims = new JwtClaims
    claims.setSubject(subject)
    claims.setClaim("userId", uid)
    claims.setClaim("email", email)
    claims.setExpirationTimeMinutesInTheFuture(10f)
    JwtAuth.jwtToken(claims)
  }

  /**
    * amber ships no logback-test.xml, so `amber/src/main/resources/logback.xml` governs this JVM
    * and pins `org.apache` at WARN, which leaves the configurator's info line unexecuted. Raising
    * this one logger for the duration of a single call executes it. The previous level is
    * restored in `finally` because every amber suite shares one JVM.
    */
  private def withDebugLogging[T](body: => T): T = {
    val logger = org.slf4j.LoggerFactory
      .getLogger(classOf[ServletAwareConfigurator])
      .asInstanceOf[LogbackLogger]
    val previousLevel = logger.getLevel
    logger.setLevel(Level.DEBUG)
    try body
    finally logger.setLevel(previousLevel)
  }

  "modifyHandshake" should "take the access and the user from the headers the gateway sets" in {
    val (config, request, properties) = handshake(headers = gatewayHeaders)

    withDebugLogging {
      new ServletAwareConfigurator().modifyHandshake(config, request, null)
    }

    // Read back by key: the access and the user live under two different keys, and `myOnOpen`
    // (the access) and `myOnMsg` (the user) look them up by exactly these names.
    properties.get(HeaderField.UserComputingUnitAccess) shouldBe PrivilegeEnum.READ.name()
    val user = userIn(properties)
    // Three mutually distinct values, so a setName/setEmail transposition cannot pass.
    user.getUid.intValue() shouldBe userId.toInt
    user.getName shouldBe userName
    user.getEmail shouldBe userEmail
    properties.keySet.asScala shouldBe
      Set(HeaderField.UserComputingUnitAccess, classOf[User].getName)
  }

  it should "take the first value of a repeated header, not the last" in {
    // HTTP headers are legitimately multi-valued, and the first occurrence is the one that
    // decides the identity and the access a websocket is given: a duplicate appended after the
    // gateway's own must not override it.
    val (config, request, properties) = handshake(headers =
      gatewayHeaders ++ Map(
        HeaderField.UserId -> Seq(userId, "99"),
        HeaderField.UserComputingUnitAccess -> Seq(
          PrivilegeEnum.READ.name(),
          PrivilegeEnum.WRITE.name()
        )
      )
    )

    new ServletAwareConfigurator().modifyHandshake(config, request, null)

    properties.get(HeaderField.UserComputingUnitAccess) shouldBe PrivilegeEnum.READ.name()
    userIn(properties).getUid.intValue() shouldBe userId.toInt
  }

  it should "need the access and the user's id alone: a name or an e-mail address left out stays unset" in {
    Seq(HeaderField.UserName, HeaderField.UserEmail).foreach { missing =>
      withClue(s"with $missing missing: ") {
        val (config, request, properties) = handshake(headers = gatewayHeaders - missing)

        new ServletAwareConfigurator().modifyHandshake(config, request, null)

        properties.get(HeaderField.UserComputingUnitAccess) shouldBe PrivilegeEnum.READ.name()
        val user = userIn(properties)
        user.getUid.intValue() shouldBe userId.toInt
        (user.getName, user.getEmail) shouldBe (
          if (missing == HeaderField.UserName) (null, userEmail) else (userName, null)
        )
      }
    }
  }

  it should "give a handshake no access and no user when the access or the user's id is missing, has no value, or the id is no number" in {
    // Whichever of the two is unusable, nothing at all reaches the map: no access without a
    // user, and no user without an access. `myOnOpen` closes a session it finds no access for.
    Seq(
      "no access" -> (gatewayHeaders - HeaderField.UserComputingUnitAccess),
      "no user id" -> (gatewayHeaders - HeaderField.UserId),
      "an access header with no value" ->
        (gatewayHeaders + (HeaderField.UserComputingUnitAccess -> Seq.empty)),
      "a user id header with no value" -> (gatewayHeaders + (HeaderField.UserId -> Seq.empty)),
      "a user id that is no number" -> (gatewayHeaders + (HeaderField.UserId -> Seq("texera"))),
      "no header at all" -> Map.empty[String, Seq[String]]
    ).foreach {
      case (what, headers) =>
        withClue(s"$what: ") {
          val (config, request, properties) = handshake(headers = headers)

          noException should be thrownBy
            new ServletAwareConfigurator().modifyHandshake(config, request, null)

          properties.keySet.asScala shouldBe empty
        }
    }
  }

  it should "read a padded user id as the number it holds" in {
    val (config, request, properties) =
      handshake(headers = gatewayHeaders + (HeaderField.UserId -> Seq(s" $userId ")))

    new ServletAwareConfigurator().modifyHandshake(config, request, null)

    userIn(properties).getUid.intValue() shouldBe userId.toInt
  }

  it should "read no token: a handshake that carries only one gets no access and no user" in {
    // A token every service accepts, where a browser puts it on the socket's address and where
    // an HTTP client puts it. The gateway reads it there, checks it, and sets the headers; a
    // handshake that reaches a unit with the token alone did not come through the gateway.
    val token = tokenFor("token-subject", 4242, "token-mail@example.com")
    Seq(
      "in the query" ->
        handshake(queryString = s"wid=1&access-token=$token&cuid=2"),
      "in the Authorization header" ->
        handshake(
          headers = Map("Authorization" -> Seq(s"Bearer $token")),
          queryString = "wid=1&cuid=2"
        ),
      "in both, with the user's id but no access" ->
        handshake(
          headers = Map(
            "Authorization" -> Seq(s"Bearer $token"),
            HeaderField.UserId -> Seq("4242")
          ),
          queryString = s"wid=1&access-token=$token&cuid=2"
        )
    ).foreach {
      case (where, (config, request, properties)) =>
        withClue(s"$where: ") {
          new ServletAwareConfigurator().modifyHandshake(config, request, null)

          properties.keySet.asScala shouldBe empty
        }
    }
  }
}
