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

package org.apache.texera.common.config

import com.typesafe.config.ConfigFactory
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

/**
  * Spec for the staged-file-cleanup settings added to [[StorageConfig]] (PR #5643).
  *
  * Reading each value forces [[StorageConfig]] to resolve it from storage.conf, so a renamed
  * or mistyped key surfaces here as a ConfigException instead of at service start-up.
  */
class StorageConfigSpec extends AnyFlatSpec with Matchers {

  "StorageConfig cleanup settings" should "load positive retention and interval windows" in {
    StorageConfig.cleanupRetentionHours should be > 0
    StorageConfig.cleanupIntervalMinutes should be > 0
  }

  it should "default the cleanup job to disabled so merging never auto-enables deletion" in {
    // The job deletes uncommitted dataset data, so it must be opt-in per deployment via
    // STORAGE_CLEANUP_ENABLED; this guards the safe default from silently flipping to true.
    // Only assert when the env override is unset (e.g. in CI), since it would win otherwise.
    if (sys.env.get(StorageConfig.ENV_CLEANUP_ENABLED).isEmpty) {
      StorageConfig.cleanupEnabled shouldBe false
    }
  }

  it should "expose the expected environment-variable override names" in {
    StorageConfig.ENV_CLEANUP_ENABLED shouldBe "STORAGE_CLEANUP_ENABLED"
    StorageConfig.ENV_CLEANUP_RETENTION_HOURS shouldBe "STORAGE_CLEANUP_RETENTION_HOURS"
    StorageConfig.ENV_CLEANUP_INTERVAL_MINUTES shouldBe "STORAGE_CLEANUP_INTERVAL_MINUTES"
  }

  "StorageConfig warehouse settings" should "be on by default, and only with the REST catalog" in {
    // Only assert when the env override is unset, since it would win otherwise.
    if (sys.env.get(StorageConfig.ENV_WAREHOUSE_ENABLED).isEmpty) {
      // The resource is read directly as well because CI's amber job pins the
      // catalog to postgres, which makes warehouseEnabled false there either
      // way and would let a revert of the default pass unnoticed.
      ConfigFactory
        .parseResources("storage.conf")
        .resolve()
        .getBoolean("storage.warehouse.enabled") shouldBe true

      StorageConfig.warehouseEnabled shouldBe (StorageConfig.icebergCatalogType == "rest")
    }
  }

  it should "expose the warehouse environment-variable override name" in {
    StorageConfig.ENV_WAREHOUSE_ENABLED shouldBe "STORAGE_WAREHOUSE_ENABLED"
  }

  "StorageConfig iceberg table settings" should "keep execution plans in the execution-plan namespace by default" in {
    // Only assert when the env override is unset, since it would win otherwise.
    if (sys.env.get("STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE").isEmpty) {
      StorageConfig.icebergTablePlanNamespace shouldBe "execution-plan"
    }
  }

  it should "keep execution logs in the execution-log namespace by default" in {
    if (sys.env.get("STORAGE_ICEBERG_TABLE_EXECUTION_LOG_NAMESPACE").isEmpty) {
      StorageConfig.icebergTableExecutionLogNamespace shouldBe "execution-log"
    }
  }

  it should "commit an execution's statistics and console output every 30 seconds by default" in {
    if (sys.env.get("STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS").isEmpty) {
      StorageConfig.icebergTableCommitIntervalMs shouldBe 30000L
    }
  }

  "StorageConfig REST catalog settings" should
    "give a call ten seconds to connect and a minute to be answered by default" in {
    // Only assert when the env override is unset, since it would win otherwise.
    if (sys.env.get("STORAGE_ICEBERG_CATALOG_REST_CONNECTION_TIMEOUT_MS").isEmpty) {
      StorageConfig.icebergRESTCatalogConnectionTimeoutMs shouldBe 10000L
    }
    if (sys.env.get("STORAGE_ICEBERG_CATALOG_REST_SOCKET_TIMEOUT_MS").isEmpty) {
      StorageConfig.icebergRESTCatalogSocketTimeoutMs shouldBe 60000
    }
  }

  "StorageConfig input-link settings" should
    "sign links for the S3 endpoint, and read links from it alone, by default" in {
    // A deployment whose services and computing units reach the object store at one address
    // sets neither. Only assert when neither env override is set, since it would win otherwise.
    if (
      Seq("STORAGE_INPUT_LINKS_S3_ENDPOINT", "STORAGE_INPUT_LINKS_ALLOWED_ENDPOINTS")
        .forall(sys.env.get(_).isEmpty)
    ) {
      // Read from the resource: a test may have repointed StorageConfig.s3Endpoint since.
      val s3Endpoint =
        ConfigFactory.parseResources("storage.conf").resolve().getString("storage.s3.endpoint")
      StorageConfig.inputLinksS3Endpoint shouldBe s3Endpoint
      StorageConfig.inputLinksAllowedEndpoints shouldBe Seq(s3Endpoint)
    }
  }

  it should "make links that last seven days, the longest a link can, by default" in {
    if (sys.env.get("STORAGE_INPUT_LINKS_TTL_SECONDS").isEmpty) {
      StorageConfig.inputLinksTtlSeconds shouldBe 7L * 24 * 60 * 60
    }
  }

  "StorageConfig jupyter settings" should "default the public URL to the internal one" in {
    // Keeps the split a no-op outside containerized deployments.
    // Only assert when neither env override is set, since either would win otherwise.
    if (
      sys.env.get("STORAGE_JUPYTER_INTERNAL_URL").isEmpty &&
      sys.env.get("STORAGE_JUPYTER_PUBLIC_URL").isEmpty
    ) {
      StorageConfig.jupyterPublicURL shouldBe StorageConfig.jupyterInternalURL
    }
  }

  it should "default the token secret to empty so a deployment must set it deliberately" in {
    // Per-user tokens are derived from this key, so it has no safe default: an empty
    // value must be caught at start-up rather than silently deriving from nothing.
    if (sys.env.get("JUPYTER_TOKEN_SECRET").isEmpty) {
      StorageConfig.jupyterTokenSecret shouldBe ""
    }
  }
}
