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

package org.apache.texera.web.service

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.{Level, Logger => LogbackLogger}
import ch.qos.logback.core.read.ListAppender
import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.texera.auth.CatalogTokens
import org.apache.texera.common.config.StorageConfig
import org.apache.texera.web.service.StubLakekeeper.Request
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import org.slf4j.LoggerFactory

import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Setting the catalog up at the Dashboard service ([[CatalogSetup]]), against Lakekeeper as a
  * stub on the loopback interface ([[StubLakekeeper]]) that answers as a catalog in the state a
  * case gives it would, and changes that state as the catalog would.
  */
class CatalogSetupSpec extends AnyFlatSpec with Matchers {

  private val mapper = new ObjectMapper()
  private val warehouseId = UUID.randomUUID()
  private val warehouseName = StorageConfig.icebergRESTCatalogWarehouseName

  private val alreadyBootstrapped =
    """{"error":{"message":"Catalog already bootstrapped","type":"CatalogAlreadyBootstrapped","code":400}}"""

  /**
    * A catalog: bootstrapped or not, with its default project or not, and with the shared
    * warehouse at `endpoint` or with none. Its info answers `failingInfos` times with 503 first.
    */
  private class Catalog(
      @volatile var bootstrapped: Boolean = false,
      @volatile var project: Boolean = false,
      @volatile var endpoint: Option[String] = None,
      failingInfos: Int = 0
  ) {
    private val infos = new AtomicInteger()

    private def listing: String =
      endpoint.fold("""{"warehouses": []}""") { at =>
        s"""{"warehouses": [{"warehouse-id": "$warehouseId", "name": "$warehouseName",
           |  "storage-profile": {"type": "s3", "bucket": "texera-iceberg", "key-prefix": "shared",
           |    "region": "us-west-2", "endpoint": "$at", "flavor": "s3-compat",
           |    "path-style-access": true, "sts-enabled": false}}]}""".stripMargin
      }

    val answer: PartialFunction[Request, (Int, String)] = {
      case Request("GET", "/management/v1/info", _, _, _) =>
        if (infos.incrementAndGet() <= failingInfos) (503, """{"error": "starting"}""")
        else (200, s"""{"version": "0.11.0", "bootstrapped": $bootstrapped}""")
      case Request("POST", "/management/v1/bootstrap", _, _, _) =>
        if (bootstrapped) (400, alreadyBootstrapped)
        else {
          bootstrapped = true
          (204, "")
        }
      case Request("POST", "/management/v1/project", _, _, _) =>
        if (project) (409, """{"error":{"message":"exists","type":"Conflict","code":409}}""")
        else {
          project = true
          (201, """{"project-id": "00000000-0000-0000-0000-000000000000"}""")
        }
      case Request("GET", "/management/v1/warehouse", _, _, _) => (200, listing)
      case Request("POST", "/management/v1/warehouse", _, _, body) =>
        endpoint = Some(mapper.readTree(body).path("storage-profile").path("endpoint").asText())
        (201, s"""{"warehouse-id": "$warehouseId"}""")
      case Request("POST", path, _, _, body)
          if path == s"/management/v1/warehouse/$warehouseId/storage" =>
        endpoint = Some(mapper.readTree(body).path("storage-profile").path("endpoint").asText())
        (200, "{}")
    }
  }

  /** Runs `body` with Lakekeeper as `catalog`, and a setup of it that retries every 10 ms. */
  private def withSetupOf[T](catalog: Catalog, rest: Boolean = true)(
      body: (StubLakekeeper, CatalogSetup) => T
  ): T =
    Using.resource(new StubLakekeeper(catalog.answer)) { stub =>
      body(
        stub,
        new CatalogSetup(new LakekeeperClient(stub.catalogUri), rest, retryEvery = 10.millis)
      )
    }

  /** What every request of the setup carries: the platform's token. */
  private def platformBearer: Option[String] = Some(s"Bearer ${CatalogTokens.platform()}")

  "CatalogSetup.ensure" should "bootstrap a fresh catalog as the platform, and make its default project and the shared warehouse" in {
    val catalog = new Catalog()
    withSetupOf(catalog) { (stub, setup) =>
      setup.ensure()

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/info",
        "POST /management/v1/bootstrap",
        "POST /management/v1/project",
        "GET /management/v1/warehouse",
        "POST /management/v1/warehouse"
      )
      stub.requests.map(_.authorization).distinct shouldBe List(platformBearer)
      mapper.readTree(stub.requests(1).body).get("is-operator").asBoolean() shouldBe true
      // The warehouse executions that name none write into, in this deployment's bucket.
      val warehouse = mapper.readTree(stub.requests.last.body)
      warehouse.get("warehouse-name").asText() shouldBe warehouseName
      val profile = warehouse.get("storage-profile")
      profile.get("bucket").asText() shouldBe StorageConfig.icebergRESTCatalogS3Bucket
      profile.get("key-prefix").asText() shouldBe StorageConfig.icebergRESTCatalogKeyPrefix
      profile.get("endpoint").asText() shouldBe StorageConfig.s3Endpoint
      profile.get("region").asText() shouldBe StorageConfig.s3Region
      profile.get("flavor").asText() shouldBe "s3-compat"
      profile.get("path-style-access").asBoolean() shouldBe true
      profile.get("sts-enabled").asBoolean() shouldBe false
      warehouse.get("storage-credential").get("aws-access-key-id").asText() shouldBe
        StorageConfig.s3Username
      catalog.bootstrapped shouldBe true
      catalog.project shouldBe true
    }
  }

  it should "leave a catalog that is set up as it is, but for the endpoint of the shared warehouse" in {
    val catalog =
      new Catalog(bootstrapped = true, project = true, endpoint = Some("http://192.0.2.7:9000"))
    withSetupOf(catalog) { (stub, setup) =>
      setup.ensure()

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/info",
        "POST /management/v1/project",
        "GET /management/v1/warehouse",
        s"POST /management/v1/warehouse/$warehouseId/storage"
      )
      catalog.endpoint shouldBe Some(StorageConfig.s3Endpoint)
      val profile = mapper.readTree(stub.requests.last.body).get("storage-profile")
      profile.get("key-prefix").asText() shouldBe "shared"
      profile.get("region").asText() shouldBe "us-west-2"
    }
  }

  it should "take a catalog another replica bootstrapped meanwhile for bootstrapped" in {
    val catalog = new Catalog()
    // Another replica bootstraps it once this one has read that it is not.
    val racing: PartialFunction[Request, (Int, String)] = {
      case Request("POST", "/management/v1/bootstrap", _, _, _) => (400, alreadyBootstrapped)
    }
    Using.resource(new StubLakekeeper(racing.orElse(catalog.answer))) { stub =>
      new CatalogSetup(new LakekeeperClient(stub.catalogUri), rest = true).ensure()

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/info",
        "POST /management/v1/bootstrap",
        "POST /management/v1/project",
        "GET /management/v1/warehouse",
        "POST /management/v1/warehouse"
      )
    }
  }

  it should "set the catalog up once, and ask it nothing after" in {
    val catalog = new Catalog()
    withSetupOf(catalog) { (stub, setup) =>
      setup.ensure()
      val asked = stub.requests.size

      setup.ensure()
      setup.ensure()

      stub.requests should have size asked.toLong
    }
  }

  it should "ask nothing of a catalog that is not a REST one" in {
    withSetupOf(new Catalog(), rest = false) { (stub, setup) =>
      setup.ensure()
      stub.requests shouldBe empty
    }
  }

  it should "throw what failed, and set the catalog up from the start when asked again" in {
    val catalog = new Catalog(failingInfos = 1)
    withSetupOf(catalog) { (stub, setup) =>
      val failure = intercept[RuntimeException](setup.ensure())
      failure.getMessage should include("503")

      setup.ensure()

      stub.requests.map(_.line) shouldBe List(
        "GET /management/v1/info",
        "GET /management/v1/info",
        "POST /management/v1/bootstrap",
        "POST /management/v1/project",
        "GET /management/v1/warehouse",
        "POST /management/v1/warehouse"
      )
    }
  }

  "CatalogSetup.ensureInBackground" should "try again until a setup succeeds, and log that it failed at most once a minute" in {
    val catalog = new Catalog(failingInfos = 3)
    withSetupOf(catalog) { (stub, setup) =>
      val warnings = warningsOf {
        val thread = setup.ensureInBackground()
        thread.isDaemon shouldBe true
        thread.join(30000L)
        thread.isAlive shouldBe false
      }

      stub.requests.count(_.line == "GET /management/v1/info") shouldBe 4
      stub.requests.last.line shouldBe "POST /management/v1/warehouse"
      warnings shouldBe Seq(
        s"The catalog could not be set up; it is tried again every ${10.millis}."
      )
      // Done: nothing is asked again.
      val asked = stub.requests.size
      setup.ensure()
      stub.requests should have size asked.toLong
    }
  }

  /** Runs `body`, and answers what [[CatalogSetup]] warned of meanwhile. */
  private def warningsOf(body: => Unit): Seq[String] = {
    val logger = LoggerFactory.getLogger(classOf[CatalogSetup]).asInstanceOf[LogbackLogger]
    val appender = new ListAppender[ILoggingEvent]
    val level = logger.getLevel
    appender.start()
    logger.addAppender(appender)
    logger.setLevel(Level.ALL)
    try {
      body
      appender.list.asScala.toList.collect {
        case event if event.getLevel == Level.WARN => event.getFormattedMessage
      }
    } finally {
      logger.setLevel(level)
      logger.detachAppender(appender)
      appender.stop()
    }
  }
}
