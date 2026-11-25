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

import org.apache.texera.common.config.{AuthConfig, StorageConfig}
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.jce.ECNamedCurveTable
import org.jose4j.json.JsonUtil
import org.jose4j.jwk.{EllipticCurveJsonWebKey, JsonWebKey, JsonWebKeySet, Use}
import org.jose4j.jws.AlgorithmIdentifiers.ECDSA_USING_P256_CURVE_AND_SHA256
import org.jose4j.jws.JsonWebSignature
import org.jose4j.jwt.{JwtClaims, NumericDate}
import org.jose4j.jwx.HeaderParameterNames
import org.jose4j.keys.EllipticCurves
import org.jose4j.lang.HashUtil

import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.{ECPoint, ECPrivateKeySpec, ECPublicKeySpec}
import java.time.Clock
import java.util.Collections

/**
  * The tokens Texera's services give the Iceberg REST catalog (Lakekeeper) to say who calls it:
  * the platform, that is the Dashboard service and the Result Service, or one execution, whose
  * computing unit sends the execution's token with every catalog call it makes about it.
  *
  * Each is a JWT signed with ES256. The key is derived from the secret the services share
  * (`auth.jwt.256-bit-secret`), so every replica of every service signs with the same key, and
  * no key is stored or handed out. The Access Control Service publishes its public half
  * ([[jwksJson]], [[discoveryJson]]), which Lakekeeper checks every token against. A computing
  * unit holds no secret and makes no token.
  *
  * A token says no more than whom it is for, when it was made and until when it works: `iss`,
  * `aud`, `sub`, `iat` and `exp`. Lakekeeper knows its holder as the user [[catalogUserOf]] its
  * subject, and the grants of that user say what the holder may do.
  */
object CatalogTokens {

  /** The subject of the platform's token. */
  val PlatformSubject = "texera"

  /** The subject of the token of execution `eid`. */
  def executionSubject(eid: Long): String = s"texera-execution-$eid"

  /** The catalog user Lakekeeper knows the holder of a token for `subject` as. */
  def catalogUserOf(subject: String): String = s"oidc~$subject"

  /** How long a platform token works, and how long before its end the next one is made. */
  private[auth] val PlatformTtlSeconds = 3600L
  private[auth] val PlatformRenewBeforeSeconds = 600L

  // What turns the shared secret into the signing key, by HKDF-SHA256. Changing any of them
  // changes the key, and the catalog then refuses every token made before.
  private val KeySalt = "texera-iceberg-catalog"
  private val KeyInfo = "es256-signing-key-v1"
  // 16 bytes more than the order of the curve takes, so that reducing them by the order leaves
  // a negligible bias, as key generation with extra random bits does.
  private val KeyMaterialBytes = 48

  private val Curve = ECNamedCurveTable.getParameterSpec("secp256r1")

  private lazy val issuer = new TokenIssuer(
    AuthConfig.jwtSecretKey,
    StorageConfig.icebergRESTCatalogTokenIssuer,
    StorageConfig.icebergRESTCatalogTokenAudience,
    StorageConfig.icebergRESTCatalogTokenExecutionTtlSeconds,
    Clock.systemUTC()
  )

  /**
    * The platform's token. One works for an hour, and the same one is given until 10 minutes
    * are left of it.
    */
  def platform(): String = issuer.platform()

  /**
    * A new token for execution `eid`. It works for
    * `storage.iceberg.catalog.rest.token.execution-ttl-seconds`, and nothing renews it.
    */
  def forExecution(eid: Long): String = issuer.forExecution(eid)

  /** The key tokens are signed with, public half only, as a JWK Set: `{"keys": [<key>]}`. */
  def jwksJson(): String = issuer.jwksJson

  /** The OpenID discovery document the catalog reads the issuer and the key's location from. */
  def discoveryJson(jwksUri: String): String = issuer.discoveryJson(jwksUri)

  /**
    * The private scalar of the key derived from `secret`: the HKDF-SHA256 output of the secret,
    * as an unsigned big-endian number, reduced into [1, n - 1], n the order of P-256.
    */
  private[auth] def privateScalarOf(secret: String): BigInteger = {
    val hkdf = new HKDFBytesGenerator(new SHA256Digest())
    hkdf.init(new HKDFParameters(utf8(secret), utf8(KeySalt), utf8(KeyInfo)))
    val material = new Array[Byte](KeyMaterialBytes)
    hkdf.generateBytes(material, 0, material.length)
    new BigInteger(1, material).mod(Curve.getN.subtract(BigInteger.ONE)).add(BigInteger.ONE)
  }

  /**
    * The signing key derived from `secret`, with its private half, its use, its algorithm, and
    * its JWK thumbprint (RFC 7638) for its id.
    */
  private[auth] def keyOf(secret: String): EllipticCurveJsonWebKey = {
    val scalar = privateScalarOf(secret)
    val point = Curve.getG.multiply(scalar).normalize()
    val factory = KeyFactory.getInstance("EC")
    val publicKey = factory.generatePublic(
      new ECPublicKeySpec(
        new ECPoint(point.getAffineXCoord.toBigInteger, point.getAffineYCoord.toBigInteger),
        EllipticCurves.P256
      )
    )
    val key = new EllipticCurveJsonWebKey(publicKey.asInstanceOf[ECPublicKey])
    key.setPrivateKey(factory.generatePrivate(new ECPrivateKeySpec(scalar, EllipticCurves.P256)))
    key.setKeyId(key.calculateBase64urlEncodedThumbprint(HashUtil.SHA_256))
    key.setUse(Use.SIGNATURE)
    key.setAlgorithm(ECDSA_USING_P256_CURVE_AND_SHA256)
    key
  }

  private def utf8(text: String): Array[Byte] = text.getBytes(StandardCharsets.UTF_8)

  /**
    * Makes the tokens of the key derived from `secret`, stamped with the times of `clock`.
    *
    * @param issuer the `iss` of its tokens, which its discovery document names too.
    * @param audience the `aud` of its tokens: the catalog's `LAKEKEEPER__OPENID_AUDIENCE`.
    * @param executionTtlSeconds how long an execution's token works, in seconds.
    */
  private[auth] final class TokenIssuer(
      secret: String,
      issuer: String,
      audience: String,
      executionTtlSeconds: Long,
      clock: Clock
  ) {
    require(
      executionTtlSeconds >= 1,
      "STORAGE_ICEBERG_CATALOG_REST_TOKEN_EXECUTION_TTL_SECONDS must be at least 1, got " +
        executionTtlSeconds
    )

    private val key = keyOf(secret)

    // The platform's token, and when it ends, in epoch seconds.
    @volatile private var platformToken: Option[(String, Long)] = None

    val jwksJson: String =
      new JsonWebKeySet(Collections.singletonList[JsonWebKey](key))
        .toJson(JsonWebKey.OutputControlLevel.PUBLIC_ONLY)

    def platform(): String =
      lasting(platformToken).getOrElse(synchronized {
        lasting(platformToken).getOrElse {
          val made = mint(PlatformSubject, PlatformTtlSeconds)
          platformToken = Some(made)
          made._1
        }
      })

    def forExecution(eid: Long): String = mint(executionSubject(eid), executionTtlSeconds)._1

    def discoveryJson(jwksUri: String): String = {
      val document = new java.util.LinkedHashMap[String, AnyRef]()
      document.put("issuer", issuer)
      document.put("jwks_uri", jwksUri)
      document.put(
        "id_token_signing_alg_values_supported",
        Collections.singletonList(ECDSA_USING_P256_CURVE_AND_SHA256)
      )
      document.put("subject_types_supported", Collections.singletonList("public"))
      document.put("response_types_supported", Collections.singletonList("id_token"))
      JsonUtil.toJson(document)
    }

    /** The token of `made`, while at least the renewal margin is left of it. */
    private def lasting(made: Option[(String, Long)]): Option[String] =
      made.collect {
        case (token, endsAt) if endsAt - nowSeconds() >= PlatformRenewBeforeSeconds => token
      }

    private def nowSeconds(): Long = clock.instant().getEpochSecond

    /** A token for `subject` that works for `ttlSeconds` from now, and when it ends. */
    private def mint(subject: String, ttlSeconds: Long): (String, Long) = {
      val issuedAt = nowSeconds()
      val endsAt = issuedAt + ttlSeconds
      val claims = new JwtClaims()
      claims.setIssuer(issuer)
      claims.setAudience(audience)
      claims.setSubject(subject)
      claims.setIssuedAt(NumericDate.fromSeconds(issuedAt))
      claims.setExpirationTime(NumericDate.fromSeconds(endsAt))
      val jws = new JsonWebSignature()
      jws.setPayload(claims.toJson)
      jws.setAlgorithmHeaderValue(ECDSA_USING_P256_CURVE_AND_SHA256)
      jws.setKeyIdHeaderValue(key.getKeyId)
      jws.setHeader(HeaderParameterNames.TYPE, "JWT")
      jws.setKey(key.getPrivateKey)
      (jws.getCompactSerialization, endsAt)
    }
  }
}
