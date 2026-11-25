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

import com.sun.net.httpserver.{HttpExchange, HttpServer}

import java.net.{InetAddress, InetSocketAddress}
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

/** A REST catalog on this machine for the specs: an HTTP server that answers as it is told. */
object RestCatalogStub {

  /** The configuration a catalog gives the one request a client makes to initialize. */
  val Configuration = """{"defaults": {}, "overrides": {}}"""

  /**
    * Runs `body` against a REST catalog on this machine that answers every request as `answer`
    * does, and is given the catalog's URI.
    */
  def withRestCatalogAt[T](answer: HttpExchange => Unit)(body: String => T): T = {
    val server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress, 0), 0)
    val threads = Executors.newCachedThreadPool()
    server.setExecutor(threads)
    server.createContext("/", (exchange: HttpExchange) => answer(exchange))
    server.start()
    try body(s"http://127.0.0.1:${server.getAddress.getPort}/catalog")
    finally {
      server.stop(0)
      threads.shutdownNow()
    }
  }

  /** Answers `exchange` with `json`, as a catalog answers a request it takes. */
  def answer(exchange: HttpExchange, json: String): Unit = {
    val body = json.getBytes(StandardCharsets.UTF_8)
    exchange.getResponseHeaders.add("Content-Type", "application/json")
    exchange.sendResponseHeaders(200, body.length.toLong)
    exchange.getResponseBody.write(body)
    exchange.close()
  }
}
