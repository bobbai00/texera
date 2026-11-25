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

package org.apache.texera.amber.util

import org.apache.iceberg.CatalogProperties
import org.apache.iceberg.aws.s3.signer.S3V4RestSignerClient
import org.apache.iceberg.catalog.{SessionCatalog, TableIdentifier}
import org.apache.iceberg.rest.auth.{AuthManagers, AuthProperties, AuthSession}
import org.apache.iceberg.rest.{HTTPClient, HTTPRequest, ImmutableHTTPRequest, RESTClient}
import org.apache.texera.amber.core.storage.CatalogIdentity
import org.apache.texera.amber.core.storage.CatalogIdentity.{Executions, Platform}
import org.apache.texera.auth.CatalogTokens
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.BeforeAndAfterEach
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.signer.AwsSignerExecutionAttribute
import software.amazon.awssdk.core.interceptor.ExecutionAttributes
import software.amazon.awssdk.http.{SdkHttpFullRequest, SdkHttpMethod}
import software.amazon.awssdk.regions.Region

import java.net.URI
import java.util.concurrent.ConcurrentLinkedQueue
import scala.annotation.nowarn
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Specs for [[CatalogTokenAuthManager]]: what the requests of Iceberg's REST clients carry,
  * those of a catalog and those of the S3 signer of its tables, in each [[CatalogIdentity]] mode.
  *
  * Tagged [[NonParallelTest]] so the suite gets a forked JVM of its own: it switches the
  * JVM-wide mode, and Iceberg's S3 signers share one HTTP client per JVM, made for the address
  * the first of them signs at.
  */
@NonParallelTest
class CatalogTokenAuthManagerSpec extends AnyFlatSpec with Matchers with BeforeAndAfterEach {

  override def afterEach(): Unit =
    try CatalogIdentity.use(CatalogIdentity.Anonymous)
    finally super.afterEach()

  /**
    * The properties of a REST client for `execution`, as `IcebergUtil.createRestCatalog` sets
    * them: what the S3 signer of each table of the client is made with.
    */
  private def propertiesFor(execution: Option[Long]): java.util.Map[String, String] =
    (Map(
      CatalogProperties.URI -> "http://127.0.0.1:1/catalog",
      AuthProperties.AUTH_TYPE -> classOf[CatalogTokenAuthManager].getName
    ) ++ execution.map(CatalogTokenAuthManager.ExecutionProperty -> _.toString)).asJava

  private def withClient[T](properties: java.util.Map[String, String])(body: RESTClient => T): T = {
    val client = HTTPClient.builder(properties).uri(properties.get(CatalogProperties.URI)).build()
    Using.resource(client)(body)
  }

  /** The Authorization header a request that has none carries through `session`. */
  private def authorizationThrough(session: AuthSession): Option[String] = {
    val request = ImmutableHTTPRequest
      .builder()
      .baseUri(URI.create("http://127.0.0.1:1/catalog"))
      .method(HTTPRequest.HTTPMethod.GET)
      .path("v1/config")
      .build()
    session.authenticate(request).headers().entries("Authorization").asScala.toSeq match {
      case Seq()       => None
      case Seq(header) => Some(header.value())
      case headers     => fail(s"a request carries ${headers.size} Authorization headers")
    }
  }

  /**
    * The Authorization header of a request the S3 signer of a client for `execution` sends: its
    * manager is loaded by name from the client's properties, as the signer loads it.
    */
  private def signerAuthorization(execution: Option[Long]): Option[String] = {
    val properties = propertiesFor(execution)
    withClient(properties) { client =>
      authorizationThrough(
        AuthManagers.loadAuthManager("s3-signer", properties).tableSession(client, properties)
      )
    }
  }

  "CatalogTokenAuthManager" should "be what Iceberg's S3 signer loads from its properties" in {
    AuthManagers.loadAuthManager("s3-signer", propertiesFor(Some(7))) shouldBe
      a[CatalogTokenAuthManager]
  }

  it should "add the token the client's execution was registered with, in Executions mode" in {
    CatalogIdentity.use(Executions)
    CatalogIdentity.register(7, "token-7")

    signerAuthorization(Some(7)) shouldBe Some("Bearer token-7")
  }

  it should "add nothing for executions with no token, or for none, in Executions mode" in {
    CatalogIdentity.use(Executions)
    CatalogIdentity.register(7, "token-7")

    signerAuthorization(Some(8)) shouldBe None
    signerAuthorization(None) shouldBe None
  }

  it should "add the platform's token for a client of any execution or none, in Platform mode" in {
    CatalogIdentity.use(Platform)
    CatalogIdentity.register(9, "token-9")

    signerAuthorization(Some(9)) shouldBe Some(s"Bearer ${CatalogTokens.platform()}")
    signerAuthorization(None) shouldBe Some(s"Bearer ${CatalogTokens.platform()}")
  }

  it should "add nothing in Anonymous mode" in {
    CatalogIdentity.register(10, "token-10")

    signerAuthorization(Some(10)) shouldBe None
    signerAuthorization(None) shouldBe None
  }

  it should "look the token up for each request" in {
    val properties = propertiesFor(Some(11))
    withClient(properties) { client =>
      val session = new CatalogTokenAuthManager("texera_iceberg").catalogSession(client, properties)
      CatalogIdentity.use(Executions)
      authorizationThrough(session) shouldBe None

      CatalogIdentity.register(11, "token-11")
      authorizationThrough(session) shouldBe Some("Bearer token-11")

      CatalogIdentity.use(Platform)
      authorizationThrough(session) shouldBe Some(s"Bearer ${CatalogTokens.platform()}")
    }
  }

  it should "give the catalog, its contexts, its tables and the signer one session" in {
    CatalogIdentity.use(Executions)
    CatalogIdentity.register(12, "token-12")
    val properties = propertiesFor(Some(12))
    val manager = new CatalogTokenAuthManager("texera_iceberg")
    withClient(properties) { client =>
      val catalog = manager.catalogSession(client, properties)
      val context = manager.contextualSession(SessionCatalog.SessionContext.createEmpty(), catalog)
      val table = manager.tableSession(
        TableIdentifier.of("execution-12", "wid_1_eid_12_executionlog"),
        java.util.Map.of[String, String](),
        catalog
      )

      context should be theSameInstanceAs catalog
      table should be theSameInstanceAs catalog
      Seq(
        manager.initSession(client, properties),
        catalog,
        manager.tableSession(client, properties)
      ).map(authorizationThrough) shouldBe Seq.fill(3)(Some("Bearer token-12"))
    }
  }

  /**
    * The path and the Authorization header of each request a REST catalog for `execution`, made
    * by `IcebergUtil.createRestCatalog`, sends to initialize: one, for its configuration.
    */
  private def initializingRequests(execution: Option[Long]): Seq[(String, Option[String])] = {
    val seen = new ConcurrentLinkedQueue[(String, Option[String])]()
    RestCatalogStub.withRestCatalogAt { exchange =>
      val authorization = Option(exchange.getRequestHeaders.getFirst("Authorization"))
      seen.add(exchange.getRequestURI.getPath -> authorization)
      RestCatalogStub.answer(exchange, RestCatalogStub.Configuration)
    } { uri =>
      IcebergUtil.createRestCatalog("test", "a-warehouse", uri, execution = execution).close()
    }
    seen.asScala.toSeq
  }

  "A REST catalog of IcebergUtil.createRestCatalog" should
    "send its execution's token with its first request, in Executions mode" in {
    CatalogIdentity.use(Executions)
    CatalogIdentity.register(21, "token-21")

    initializingRequests(Some(21)) shouldBe Seq("/catalog/v1/config" -> Some("Bearer token-21"))
    initializingRequests(None) shouldBe Seq("/catalog/v1/config" -> None)
  }

  it should "send the platform's token, in Platform mode" in {
    CatalogIdentity.use(Platform)

    initializingRequests(None) shouldBe
      Seq("/catalog/v1/config" -> Some(s"Bearer ${CatalogTokens.platform()}"))
  }

  it should "send no token, in Anonymous mode" in {
    CatalogIdentity.register(23, "token-23")

    initializingRequests(Some(23)) shouldBe Seq("/catalog/v1/config" -> None)
  }

  /** Signs a read of an object through `signer`, as the S3 client of `S3FileIO` has it signed. */
  @nowarn("cat=deprecation") // The attributes the SDK's signers, Iceberg's among them, still read.
  private def signRead(signer: S3V4RestSignerClient): SdkHttpFullRequest = {
    val attributes = new ExecutionAttributes()
    attributes.putAttribute(AwsSignerExecutionAttribute.SERVICE_SIGNING_NAME, "s3")
    attributes.putAttribute(AwsSignerExecutionAttribute.SIGNING_REGION, Region.US_WEST_2)
    attributes.putAttribute(
      AwsSignerExecutionAttribute.AWS_CREDENTIALS,
      AwsBasicCredentials.create("access-key", "secret-key")
    )
    signer.sign(
      SdkHttpFullRequest
        .builder()
        .method(SdkHttpMethod.GET)
        .protocol("http")
        .host("127.0.0.1")
        .port(9000)
        .encodedPath("/texera-iceberg/shared/wid_1_eid_22_result/data.parquet")
        .build(),
      attributes
    )
  }

  "The S3 signer of a table of the catalog" should
    "send the catalog's execution token with each request it signs" in {
    CatalogIdentity.use(Executions)
    CatalogIdentity.register(22, "token-22")
    val signing = new ConcurrentLinkedQueue[(String, Option[String])]()
    val signed = "http://127.0.0.1:9000/texera-iceberg/shared/wid_1_eid_22_result/data.parquet"

    RestCatalogStub.withRestCatalogAt { exchange =>
      val path = exchange.getRequestURI.getPath
      if (path.endsWith("/v1/aws/s3/sign")) {
        signing.add(path -> Option(exchange.getRequestHeaders.getFirst("Authorization")))
        RestCatalogStub.answer(exchange, s"""{"uri": "$signed", "headers": {}}""")
      } else RestCatalogStub.answer(exchange, RestCatalogStub.Configuration)
    } { uri =>
      Using.resource(
        IcebergUtil.createRestCatalog("test", "a-warehouse", uri, execution = Some(22))
      ) { catalog =>
        // The properties S3FileIO is given for a table of the catalog, which make its signer.
        Using.resource(S3V4RestSignerClient.create(catalog.properties())) { signer =>
          signRead(signer).getUri.toString shouldBe signed
        }
      }
    }
    signing.asScala.toSeq shouldBe Seq("/catalog/v1/aws/s3/sign" -> Some("Bearer token-22"))
  }
}
