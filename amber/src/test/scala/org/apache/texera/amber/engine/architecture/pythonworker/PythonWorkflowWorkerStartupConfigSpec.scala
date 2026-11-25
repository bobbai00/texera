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

package org.apache.texera.amber.engine.architecture.pythonworker

import org.apache.texera.amber.engine.architecture.scheduling.config.CatalogToken
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.Base64

class PythonWorkflowWorkerStartupConfigSpec extends AnyFlatSpec {

  private def decode(encoded: String): String =
    new String(Base64.getDecoder.decode(encoded), StandardCharsets.UTF_8)

  "encodeStartupConfig" should "serialize entries to a Base64-encoded JSON object keyed by name" in {
    val encoded = PythonWorkflowWorker.encodeStartupConfig(
      Seq("workerId" -> "w-1", "outputPort" -> "5005", "s3Region" -> "us-west-2")
    )
    val parsed = objectMapper.readValue(decode(encoded), classOf[java.util.Map[String, String]])
    assert(parsed.get("workerId") == "w-1")
    assert(parsed.get("outputPort") == "5005")
    assert(parsed.get("s3Region") == "us-west-2")
    assert(parsed.size() == 3)
  }

  it should "produce output free of quotes and whitespace so it survives argv quoting on Windows" in {
    val encoded = PythonWorkflowWorker.encodeStartupConfig(
      Seq("workerId" -> "w-1", "s3Region" -> "us-west-2")
    )
    assert(!encoded.exists(c => c == '"' || c.isWhitespace))
  }

  it should "fail loudly when the same key appears more than once" in {
    val exception = intercept[IllegalArgumentException] {
      PythonWorkflowWorker.encodeStartupConfig(
        Seq("s3Region" -> "us-west-2", "s3Region" -> "us-east-1")
      )
    }
    assert(exception.getMessage.contains("duplicate"))
  }

  private val expectedKeys = Set(
    "workerId",
    "outputPort",
    "loggerLevel",
    "rPath",
    "icebergCatalogType",
    "icebergPostgresCatalogUriWithoutScheme",
    "icebergPostgresCatalogUsername",
    "icebergPostgresCatalogPassword",
    "icebergRestCatalogUri",
    "icebergRestCatalogWarehouseName",
    "icebergFileStorageDirectoryPath",
    "icebergTableCommitBatchSize",
    "s3Endpoint",
    "s3Region",
    "s3AuthUsername",
    "s3AuthPassword",
    "s3LargeBinariesBaseUri"
  )

  "buildStartupConfig" should "produce exactly the expected named keys with the worker values" in {
    val config =
      PythonWorkflowWorker.buildStartupConfig("worker-7", "6000", "/opt/R", "s3://bucket/uri")
    val map = config.toMap

    assert(config.size == expectedKeys.size, "no duplicate or missing keys")
    assert(map.keySet == expectedKeys)
    assert(map("workerId") == "worker-7")
    assert(map("outputPort") == "6000")
    assert(map("rPath") == "/opt/R")
    assert(map("s3LargeBinariesBaseUri") == "s3://bucket/uri")
  }

  it should "produce a config that round-trips through encodeStartupConfig" in {
    val encoded = PythonWorkflowWorker.encodeStartupConfig(
      PythonWorkflowWorker.buildStartupConfig("w", "1", "", "uri")
    )
    val parsed = objectMapper.readValue(decode(encoded), classOf[java.util.Map[String, String]])
    assert(parsed.get("workerId") == "w")
    assert(parsed.get("s3LargeBinariesBaseUri") == "uri")
    assert(parsed.size() == expectedKeys.size)
  }

  /**
    * What the process of a Python worker finds, run as the worker runs it
    * (`pythonProcess`), with a shell for its interpreter and a script for its entry point, which
    * print the token in the worker's environment and the one argument the process is given. A
    * shell takes the same `-u` a Python interpreter is given, under which a variable that is not
    * set fails the script.
    *
    * @return the token, and the argument
    */
  private def whatTheProcessFinds(
      startupConfig: Seq[(String, String)],
      catalogToken: CatalogToken
  ): (String, String) = {
    val script = Files.createTempFile("python-workflow-worker-process", ".sh")
    try {
      Files.writeString(script, "printf '%s\\n%s' \"$TEXERA_ICEBERG_CATALOG_TOKEN\" \"$1\"\n")
      PythonWorkflowWorker
        .pythonProcess("sh", script.toString, startupConfig, catalogToken)
        .lazyLines
        .toList match {
        case List(token, argument) => (token, argument)
        case printed               => fail(s"the process printed ${printed.size} lines, not 2")
      }
    } finally Files.deleteIfExists(script)
  }

  "pythonProcess" should "hand the process its execution's token in TEXERA_ICEBERG_CATALOG_TOKEN, and keep it out of its arguments" in {
    val token = "eyJhbGciOiJFUzI1NiJ9.e30.c2lnbmVk"
    val config = PythonWorkflowWorker.buildStartupConfig("worker-7", "6000", "", "s3://bucket/uri")

    val (found, argument) = whatTheProcessFinds(config, CatalogToken(token))

    assert(PythonWorkflowWorker.CatalogTokenVariable == "TEXERA_ICEBERG_CATALOG_TOKEN")
    assert(found == token)
    // Its one argument is the startup config, which holds no token.
    assert(argument == PythonWorkflowWorker.encodeStartupConfig(config))
    assert(!decode(argument).contains(token))
  }

  it should "hand the process of a worker given no token an empty TEXERA_ICEBERG_CATALOG_TOKEN" in {
    val config = PythonWorkflowWorker.buildStartupConfig("worker-8", "6001", "", "")

    // Set, to nothing: the script, under `-u`, would fail on a variable that is not set.
    assert(whatTheProcessFinds(config, CatalogToken.None)._1 == "")
  }
}
