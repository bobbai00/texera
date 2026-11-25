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

import com.sun.net.httpserver.{HttpExchange, HttpServer}
import org.apache.texera.web.service.StubLakekeeper.Request

import java.net.{InetAddress, InetSocketAddress}
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentLinkedQueue
import scala.jdk.CollectionConverters._

object StubLakekeeper {

  /**
    * A request Lakekeeper was sent, its path and its query as they were sent, undecoded.
    *
    * @param query         None when it has none
    * @param authorization its `Authorization` header; None when it has none
    */
  final case class Request(
      method: String,
      path: String,
      query: Option[String],
      authorization: Option[String],
      body: String
  ) {

    /** The request as `METHOD path?query`. */
    def line: String = s"$method $path${query.fold("")("?" + _)}"
  }
}

/**
  * Lakekeeper on the loopback interface, for a spec of what the Dashboard service asks of it. It
  * keeps every request in the order they came, and answers each as `answer` says, with a status
  * and a body: one `answer` has no answer for gets 500.
  */
final class StubLakekeeper(answer: PartialFunction[Request, (Int, String)]) extends AutoCloseable {

  private val received = new ConcurrentLinkedQueue[Request]()
  private val server =
    HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress, 0), 0)
  server.createContext("/", (exchange: HttpExchange) => serve(exchange))
  server.start()

  /** The catalog's URI, from which a client finds the management API too. */
  val catalogUri: String = s"http://127.0.0.1:${server.getAddress.getPort}/catalog"

  /** The requests received, in the order they came. */
  def requests: List[Request] = received.asScala.toList

  /** Forgets the requests received so far. */
  def clear(): Unit = received.clear()

  override def close(): Unit = server.stop(0)

  private def serve(exchange: HttpExchange): Unit =
    try {
      val request = Request(
        exchange.getRequestMethod,
        exchange.getRequestURI.getRawPath,
        Option(exchange.getRequestURI.getRawQuery),
        Option(exchange.getRequestHeaders.getFirst("Authorization")),
        new String(exchange.getRequestBody.readAllBytes(), StandardCharsets.UTF_8)
      )
      received.add(request)
      val (status, body) = answer.applyOrElse(
        request,
        (unexpected: Request) => (500, s"""{"error": "unexpected ${unexpected.line}"}""")
      )
      val bytes = body.getBytes(StandardCharsets.UTF_8)
      exchange.getResponseHeaders.add("Content-Type", "application/json")
      // A length of 0 would mean a body of no declared length, so an empty body has none.
      exchange.sendResponseHeaders(status, if (bytes.isEmpty) -1 else bytes.length.toLong)
      if (bytes.nonEmpty) exchange.getResponseBody.write(bytes)
    } finally exchange.close()
}
