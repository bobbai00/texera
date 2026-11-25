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

package org.apache.texera.auth

import org.apache.texera.common.config.StorageConfig
import org.jose4j.json.JsonUtil
import org.jose4j.jwa.AlgorithmConstraints
import org.jose4j.jwa.AlgorithmConstraints.ConstraintType
import org.jose4j.jwk.JsonWebKeySet
import org.jose4j.jws.AlgorithmIdentifiers.ECDSA_USING_P256_CURVE_AND_SHA256
import org.jose4j.jws.JsonWebSignature
import org.jose4j.jwt.consumer.{InvalidJwtException, JwtConsumerBuilder}
import org.jose4j.jwt.{JwtClaims, NumericDate}
import org.jose4j.keys.resolvers.JwksVerificationKeyResolver
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.time.{Clock, Instant, ZoneId, ZoneOffset}
import java.util.concurrent.{CountDownLatch, Executors, TimeUnit}
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, ExecutionContext, Future}
import scala.jdk.CollectionConverters._

class CatalogTokensSpec extends AnyFlatSpec with Matchers {

  // The secret auth.conf ships with, and the key it gives: the private scalar and the public
  // point, computed with openssl apart from this code.
  private val DefaultSecret = "8a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"
  private val DefaultScalar = "9d5c7aed3ec5f2fcc1833b530d3f0536bcc0f918594e6bc133e55e3c14dc3ce4"
  private val DefaultX = "SYNyJtRhd3hiDIV-QHwibW1tskKXHtC2SVx2n3aolyo"
  private val DefaultY = "7EROga7LoJwSmXoqgasqbQ3XQLITgg--aB60ZEfDzXk"
  // The key's JWK thumbprint (RFC 7638), computed apart from jose4j.
  private val DefaultKeyId = "-fFQQfBURgsoYAXFgS_Hw5nkq3Ko_w3gJP6Ipy6W3Uo"

  private val Issuer = "texera"
  private val Audience = "texera-catalog"
  private val ExecutionTtlSeconds = 604800L

  /** A clock the specs move by hand. */
  private class ManualClock(private var now: Instant) extends Clock {
    override def getZone: ZoneId = ZoneOffset.UTC
    override def withZone(zone: ZoneId): Clock = this
    override def instant(): Instant = now
    def advanceSeconds(seconds: Long): Unit = now = now.plusSeconds(seconds)
  }

  private def tokensOf(
      clock: Clock = Clock.systemUTC(),
      secret: String = DefaultSecret
  ): CatalogTokens.TokenIssuer =
    new CatalogTokens.TokenIssuer(secret, Issuer, Audience, ExecutionTtlSeconds, clock)

  /** The one key of the key set `tokens` publishes, as its JSON fields. */
  private def publishedKey(tokens: CatalogTokens.TokenIssuer): Map[String, AnyRef] = {
    val keys = JsonUtil.parseJson(tokens.jwksJson).get("keys").asInstanceOf[java.util.List[_]]
    keys.size() shouldBe 1
    keys.get(0).asInstanceOf[java.util.Map[String, AnyRef]].asScala.toMap
  }

  /**
    * The claims of `token`, verified as the catalog verifies them: against the key set
    * `published` holds, for the issuer and the audience, ES256 alone, at the time of `clock`.
    */
  private def verified(token: String, published: String, clock: Clock): JwtClaims =
    new JwtConsumerBuilder()
      .setVerificationKeyResolver(
        new JwksVerificationKeyResolver(new JsonWebKeySet(published).getJsonWebKeys)
      )
      .setJwsAlgorithmConstraints(
        new AlgorithmConstraints(ConstraintType.PERMIT, ECDSA_USING_P256_CURVE_AND_SHA256)
      )
      .setExpectedIssuer(Issuer)
      .setExpectedAudience(Audience)
      .setRequireSubject()
      .setRequireIssuedAt()
      .setRequireExpirationTime()
      .setEvaluationTime(NumericDate.fromSeconds(clock.instant().getEpochSecond))
      .build()
      .processToClaims(token)

  /** The header of `token`, unverified. */
  private def headerOf(token: String): Map[String, AnyRef] = {
    val jws = new JsonWebSignature()
    jws.setCompactSerialization(token)
    JsonUtil.parseJson(jws.getHeaders.getFullHeaderAsJsonString).asScala.toMap
  }

  "CatalogTokens" should "derive the key the test vector names from auth.conf's secret" in {
    CatalogTokens.privateScalarOf(DefaultSecret).toString(16) shouldBe DefaultScalar
    val key = publishedKey(tokensOf())
    key("x") shouldBe DefaultX
    key("y") shouldBe DefaultY
  }

  it should "publish the public half of the key alone, with its thumbprint for its id" in {
    publishedKey(tokensOf()) shouldBe Map(
      "kty" -> "EC",
      "crv" -> "P-256",
      "x" -> DefaultX,
      "y" -> DefaultY,
      "kid" -> DefaultKeyId,
      "use" -> "sig",
      "alg" -> "ES256"
    )
  }

  it should "derive one key from one secret, and another from another" in {
    publishedKey(tokensOf()) shouldBe publishedKey(tokensOf())
    publishedKey(tokensOf(secret = "another-secret")) should not be publishedKey(tokensOf())
  }

  it should "sign the platform's token with the published key, saying whom for and until when" in {
    val clock = new ManualClock(Instant.parse("2026-11-24T12:00:00Z"))
    val tokens = tokensOf(clock)
    val token = tokens.platform()

    headerOf(token) shouldBe Map("alg" -> "ES256", "kid" -> DefaultKeyId, "typ" -> "JWT")
    val claims = verified(token, tokens.jwksJson, clock)
    claims.getClaimNames.asScala.toSet shouldBe Set("iss", "aud", "sub", "iat", "exp")
    claims.getSubject shouldBe CatalogTokens.PlatformSubject
    claims.getIssuedAt.getValue shouldBe clock.instant().getEpochSecond
    claims.getExpirationTime.getValue - claims.getIssuedAt.getValue shouldBe 3600L
  }

  it should "sign a new token for an execution, which works for the configured time" in {
    val clock = new ManualClock(Instant.parse("2026-11-24T12:00:00Z"))
    val tokens = tokensOf(clock)
    val token = tokens.forExecution(42)

    headerOf(token)("kid") shouldBe DefaultKeyId
    val claims = verified(token, tokens.jwksJson, clock)
    claims.getClaimNames.asScala.toSet shouldBe Set("iss", "aud", "sub", "iat", "exp")
    claims.getSubject shouldBe "texera-execution-42"
    claims.getExpirationTime.getValue - claims.getIssuedAt.getValue shouldBe ExecutionTtlSeconds
    tokens.forExecution(42) should not be token
  }

  it should "give one platform token until 10 minutes are left of it, and a new one then" in {
    val clock = new ManualClock(Instant.parse("2026-11-24T12:00:00Z"))
    val tokens = tokensOf(clock)
    val first = tokens.platform()

    clock.advanceSeconds(3000)
    tokens.platform() shouldBe first

    clock.advanceSeconds(1)
    val second = tokens.platform()
    second should not be first
    val claims = verified(second, tokens.jwksJson, clock)
    claims.getIssuedAt.getValue shouldBe clock.instant().getEpochSecond
    tokens.platform() shouldBe second
  }

  it should "give every caller the same platform token, from many threads at once" in {
    val tokens = tokensOf()
    val threads = Executors.newFixedThreadPool(16)
    implicit val context: ExecutionContext = ExecutionContext.fromExecutorService(threads)
    val start = new CountDownLatch(1)
    try {
      val handedOut = (1 to 64).map { _ =>
        Future {
          start.await(1, TimeUnit.MINUTES)
          tokens.platform()
        }
      }
      start.countDown()
      Await.result(Future.sequence(handedOut), 1.minute).distinct should have size 1
    } finally threads.shutdownNow()
  }

  it should "make tokens the key of another secret does not verify" in {
    val clock = Clock.systemUTC()
    val forged = tokensOf(clock, secret = "another-secret").forExecution(42)

    an[InvalidJwtException] should be thrownBy verified(forged, tokensOf(clock).jwksJson, clock)
  }

  it should "make tokens that stop working when their time is up" in {
    val clock = new ManualClock(Instant.parse("2026-11-24T12:00:00Z"))
    val tokens = tokensOf(clock)
    val token = tokens.forExecution(42)

    clock.advanceSeconds(ExecutionTtlSeconds + 60)
    an[InvalidJwtException] should be thrownBy verified(token, tokens.jwksJson, clock)
  }

  it should "refuse an execution token lifetime below a second, naming the variable" in {
    val error = intercept[IllegalArgumentException] {
      new CatalogTokens.TokenIssuer(DefaultSecret, Issuer, Audience, 0, Clock.systemUTC())
    }
    error.getMessage should include("STORAGE_ICEBERG_CATALOG_REST_TOKEN_EXECUTION_TTL_SECONDS")
  }

  it should "describe the issuer and where its key set is, as OpenID discovery does" in {
    val jwks = "http://access-control-service:9096/api/catalog-issuer/jwks"
    val document = tokensOf().discoveryJson(jwks)

    document should include(s""""jwks_uri":"$jwks"""")
    val fields = JsonUtil.parseJson(document).asScala.toMap.map {
      case (name, values: java.util.List[_]) => name -> values.asScala.toList
      case field                             => field
    }
    fields shouldBe Map(
      "issuer" -> Issuer,
      "jwks_uri" -> jwks,
      "id_token_signing_alg_values_supported" -> List("ES256"),
      "subject_types_supported" -> List("public"),
      "response_types_supported" -> List("id_token")
    )
  }

  it should "name the catalog users of the platform and of each execution" in {
    CatalogTokens.catalogUserOf(CatalogTokens.PlatformSubject) shouldBe "oidc~texera"
    CatalogTokens.catalogUserOf(CatalogTokens.executionSubject(7)) shouldBe
      "oidc~texera-execution-7"
  }

  it should "sign with the key of auth.jwt.256-bit-secret, for the configured audience" in {
    // Only when neither is overridden: the expected key and claims are the defaults'.
    if (
      Seq(
        "AUTH_JWT_SECRET",
        "STORAGE_ICEBERG_CATALOG_REST_TOKEN_ISSUER",
        "STORAGE_ICEBERG_CATALOG_REST_TOKEN_AUDIENCE"
      ).forall(sys.env.get(_).isEmpty)
    ) {
      StorageConfig.icebergRESTCatalogTokenIssuer shouldBe Issuer
      StorageConfig.icebergRESTCatalogTokenAudience shouldBe Audience
      val published = CatalogTokens.jwksJson()
      JsonUtil
        .parseJson(published)
        .get("keys")
        .asInstanceOf[java.util.List[java.util.Map[String, AnyRef]]]
        .get(0)
        .get("kid") shouldBe DefaultKeyId

      val clock = Clock.systemUTC()
      verified(CatalogTokens.platform(), published, clock).getSubject shouldBe "texera"
      verified(CatalogTokens.forExecution(7), published, clock).getSubject shouldBe
        "texera-execution-7"
      CatalogTokens.platform() shouldBe CatalogTokens.platform()
      CatalogTokens.discoveryJson("http://localhost:9096/api/catalog-issuer/jwks") should include(
        s""""issuer":"$Issuer""""
      )
    }
  }
}
