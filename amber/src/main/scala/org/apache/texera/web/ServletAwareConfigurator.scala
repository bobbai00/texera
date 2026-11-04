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

package org.apache.texera.web

import com.typesafe.scalalogging.LazyLogging
import org.apache.http.client.utils.URLEncodedUtils
import org.apache.texera.web.auth.{UnitJwtAuth, UnitPrincipal}

import java.net.URI
import java.nio.charset.StandardCharsets
import javax.websocket.HandshakeResponse
import javax.websocket.server.{HandshakeRequest, ServerEndpointConfig}
import scala.jdk.CollectionConverters._

/**
  * Reads who is opening a WebSocket from the handshake and verifies it like any request: the
  * token arrives as the `access-token` query parameter (browsers cannot set headers on a
  * WebSocket) or as a bearer Authorization header. No identity is taken from plain headers.
  * Whether this person may use the unit at all the gateway asked the catalog before the
  * handshake reached here.
  */
class ServletAwareConfigurator extends ServerEndpointConfig.Configurator with LazyLogging {

  override def modifyHandshake(
      config: ServerEndpointConfig,
      request: HandshakeRequest,
      response: HandshakeResponse
  ): Unit = {
    val principal =
      try ServletAwareConfigurator
        .tokenOf(request)
        .flatMap(UnitJwtAuth.verify)
        .filter(_.isRoleOf(UnitPrincipal.Service))
      catch {
        case e: Exception =>
          logger.warn(s"could not read the caller of a websocket handshake: ${e.getMessage}")
          None
      }
    principal match {
      case Some(p) => config.getUserProperties.put(ServletAwareConfigurator.PrincipalKey, p)
      case None    => config.getUserProperties.remove(ServletAwareConfigurator.PrincipalKey)
    }
  }
}

object ServletAwareConfigurator {

  /** Where the verified caller is kept among the session's user properties. */
  val PrincipalKey: String = classOf[UnitPrincipal].getName

  def tokenOf(request: HandshakeRequest): Option[String] = {
    val fromQuery = Option(request.getQueryString)
      .map(q => URLEncodedUtils.parse(new URI("?" + q), StandardCharsets.UTF_8).asScala)
      .flatMap(_.find(_.getName == "access-token"))
      .map(_.getValue)
    def fromHeader =
      Option(request.getHeaders)
        .flatMap(h => Option(h.get("Authorization")).orElse(Option(h.get("authorization"))))
        .flatMap(_.asScala.headOption)
        .filter(_.startsWith("Bearer "))
        .map(_.stripPrefix("Bearer ").trim)
    fromQuery.filter(_.nonEmpty).orElse(fromHeader)
  }
}
