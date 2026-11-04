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

package org.apache.texera.web.auth

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.{AuthDynamicFeature, Authenticator}
import io.dropwizard.setup.Environment
import com.github.toastshaman.dropwizard.auth.jwt.JwtAuthFilter
import org.jose4j.jwk.HttpsJwks
import org.jose4j.jwt.JwtClaims
import org.jose4j.jwt.consumer.{JwtConsumer, JwtConsumerBuilder, JwtContext}
import org.jose4j.keys.resolvers.HttpsJwksVerificationKeyResolver

import java.util.Optional
import scala.jdk.CollectionConverters._

/**
  * Token verification for the unit: RS256 against the identity provider's JWKS, issuer and
  * audience checked. No shared secret. The unit's API answers the catalog's own client alone:
  * people and agents reach a unit through the catalog, which authorizes and compiles first.
  */
object UnitJwtAuth extends LazyLogging {
  val issuer: String =
    sys.env.getOrElse("TEXERA_OIDC_ISSUER", "http://localhost:8088/auth/realms/texera")
  val jwksUrl: String = sys.env.getOrElse(
    "TEXERA_OIDC_JWKS_URL",
    "http://localhost:18081/auth/realms/texera/protocol/openid-connect/certs"
  )
  val audience: String = sys.env.getOrElse("TEXERA_OIDC_AUDIENCE", "texera")
  val serviceClientId: String = sys.env.getOrElse("TEXERA_SERVICE_CLIENT_ID", "texera-services")

  lazy val jwtConsumer: JwtConsumer = {
    val jwks = new HttpsJwks(jwksUrl)
    new JwtConsumerBuilder()
      .setAllowedClockSkewInSeconds(30)
      .setRequireExpirationTime()
      .setRequireSubject()
      .setExpectedIssuer(issuer)
      .setExpectedAudience(audience)
      .setVerificationKeyResolver(new HttpsJwksVerificationKeyResolver(jwks))
      .build()
  }

  /** The caller verified claims describe. */
  def principalOf(claims: JwtClaims): UnitPrincipal = {
    val subject = claims.getSubject
    val username =
      Option(claims.getClaimValue("preferred_username", classOf[String])).getOrElse(subject)
    val email = Option(claims.getClaimValue("email", classOf[String]))
    val isService = Option(claims.getClaimValue("azp", classOf[String])).contains(serviceClientId)
    UnitPrincipal(
      subject,
      username,
      email,
      if (isService) UnitPrincipal.Service else UnitPrincipal.Regular
    )
  }

  /** Verifies a raw token (used by the WebSocket handshake); replaceable in tests. */
  @volatile var verifier: String => Option[UnitPrincipal] = verifyWithJwks

  def verify(token: String): Option[UnitPrincipal] = verifier(token)

  private def verifyWithJwks(token: String): Option[UnitPrincipal] =
    try Some(principalOf(jwtConsumer.processToClaims(token)))
    catch {
      case e: Exception =>
        logger.debug(s"token rejected: ${e.getMessage}")
        None
    }

  object UnitAuthenticator extends Authenticator[JwtContext, UnitPrincipal] {
    override def authenticate(context: JwtContext): Optional[UnitPrincipal] =
      try Optional.of(principalOf(context.getJwtClaims))
      catch {
        case e: Exception =>
          logger.warn(s"failed to read the caller from the token: ${e.getMessage}")
          Optional.empty()
      }
  }

  def setup(environment: Environment): Unit = {
    environment.jersey.register(
      new AuthDynamicFeature(
        new JwtAuthFilter.Builder[UnitPrincipal]()
          .setJwtConsumer(jwtConsumer)
          .setRealm("texera")
          .setPrefix("Bearer")
          .setAuthenticator(UnitAuthenticator)
          .setAuthorizer(UserRoleAuthorizer)
          .buildAuthFilter()
      )
    )
  }
}
