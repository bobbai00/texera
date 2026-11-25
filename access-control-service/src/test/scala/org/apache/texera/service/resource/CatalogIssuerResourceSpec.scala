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

package org.apache.texera.service.resource

import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import io.dropwizard.jackson.Jackson
import io.dropwizard.testing.junit5.ResourceExtension
import jakarta.ws.rs.core.{MediaType, Response, UriBuilder, UriInfo}
import org.apache.texera.auth.{CatalogTokens, JwtAuthFilter, UnauthorizedExceptionMapper}
import org.apache.texera.common.config.StorageConfig
import org.glassfish.jersey.server.filter.RolesAllowedDynamicFeature
import org.jose4j.jwa.AlgorithmConstraints
import org.jose4j.jwa.AlgorithmConstraints.ConstraintType
import org.jose4j.jwk.JsonWebKeySet
import org.jose4j.jws.AlgorithmIdentifiers
import org.jose4j.jwt.consumer.JwtConsumerBuilder
import org.jose4j.keys.resolvers.JwksVerificationKeyResolver
import org.mockito.Mockito.{mock, when}
import org.scalatest.BeforeAndAfterAll
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI

/**
  * Sends requests through the auth pipeline production uses, with no token, the way Lakekeeper
  * reads the discovery document and then the key set it names.
  */
class CatalogIssuerResourceSpec extends AnyFlatSpec with Matchers with BeforeAndAfterAll {

  private val mapper: ObjectMapper = Jackson.newObjectMapper().registerModule(DefaultScalaModule)

  private val resources: ResourceExtension = ResourceExtension
    .builder()
    .setMapper(mapper)
    .addProvider(classOf[JwtAuthFilter])
    .addProvider(classOf[UnauthorizedExceptionMapper])
    .addProvider(classOf[RolesAllowedDynamicFeature])
    .addResource(new CatalogIssuerResource)
    .build()

  override protected def beforeAll(): Unit = resources.before()

  override protected def afterAll(): Unit = resources.after()

  private val discoveryPath = "/catalog-issuer/.well-known/openid-configuration"
  private val jwksPath = "/catalog-issuer/jwks"

  // GETs with no token, as Lakekeeper sends them: to a path of the test container, or to a URL.
  private def get(path: String): Response = resources.target(path).request().get()

  private def get(uri: URI): Response = resources.client().target(uri).request().get()

  private def text(response: Response): String = {
    response.getStatus shouldBe 200
    response.readEntity(classOf[String])
  }

  private def json(path: String): JsonNode = mapper.readTree(text(get(path)))

  "The catalog issuer" should "answer both routes with JSON, to a caller with no token" in {
    Seq(discoveryPath, jwksPath).foreach { path =>
      withClue(path) {
        val response = get(path)
        response.getStatus shouldBe 200
        response.getMediaType.isCompatible(MediaType.APPLICATION_JSON_TYPE) shouldBe true
      }
    }
  }

  "Its discovery document" should "name the configured issuer" in {
    json(discoveryPath).get("issuer").asText shouldBe StorageConfig.icebergRESTCatalogTokenIssuer
  }

  it should "name the key set by an absolute URL that serves it" in {
    val jwksUri = URI.create(json(discoveryPath).get("jwks_uri").asText)

    jwksUri.isAbsolute shouldBe true
    // The test container serves at its root, so the URL is the key set's own route here.
    jwksUri.getPath shouldBe jwksPath
    text(get(jwksUri)) shouldBe text(get(jwksPath))
  }

  it should "build that URL on the base the service is served under" in {
    val uriInfo = mock(classOf[UriInfo])
    when(uriInfo.getBaseUriBuilder)
      .thenReturn(UriBuilder.fromUri("http://access-control-service:9096/api/"))

    val discovery = mapper.readTree(new CatalogIssuerResource().discovery(uriInfo))

    discovery.get("jwks_uri").asText shouldBe
      "http://access-control-service:9096/api/catalog-issuer/jwks"
  }

  "Its key set" should "hold no private key" in {
    val keys = json(jwksPath).get("keys")

    keys.size should be > 0
    // "d" is the private part of an elliptic-curve key.
    (0 until keys.size).foreach(index => keys.get(index).has("d") shouldBe false)
  }

  it should "verify a catalog token minted for the platform, as Lakekeeper checks one" in {
    val keys = new JsonWebKeySet(text(get(jwksPath)))
    val consumer = new JwtConsumerBuilder()
      .setVerificationKeyResolver(new JwksVerificationKeyResolver(keys.getJsonWebKeys))
      .setJwsAlgorithmConstraints(
        new AlgorithmConstraints(
          ConstraintType.PERMIT,
          AlgorithmIdentifiers.ECDSA_USING_P256_CURVE_AND_SHA256
        )
      )
      .setExpectedIssuer(json(discoveryPath).get("issuer").asText)
      .setExpectedAudience(StorageConfig.icebergRESTCatalogTokenAudience)
      .setRequireExpirationTime()
      .setRequireSubject()
      .build()

    consumer.processToClaims(CatalogTokens.platform()).getSubject shouldBe
      CatalogTokens.PlatformSubject
  }
}
