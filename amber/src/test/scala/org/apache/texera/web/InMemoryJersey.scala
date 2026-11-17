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

import com.fasterxml.jackson.databind.ObjectMapper
import io.dropwizard.jersey.jackson.JacksonMessageBodyProvider
import org.glassfish.jersey.internal.MapPropertiesDelegate
import org.glassfish.jersey.server.{ApplicationHandler, ContainerRequest, ResourceConfig}

import java.io.ByteArrayInputStream
import java.net.URI
import java.nio.charset.StandardCharsets.UTF_8
import java.security.Principal
import javax.ws.rs.core.{MediaType, SecurityContext}

/**
  * Hands requests to the Jersey application `config` describes, in memory, as the servlet
  * container hands them to it under `/api`: no port is bound and no resource is called unless a
  * request gets through its filters. Each request carries a JSON body `{}`, and no credentials
  * unless it is given a token.
  *
  * A request to a path and method some resource serves with `@RolesAllowed` is answered 401 by the
  * JWT filter, after Jersey matched it; one that no resource serves is answered 404 or 405 before
  * any filter. So the status tells a route that resolves from one that does not.
  *
  * The application is built from a copy of `config`: building it locks the configuration it is
  * given, and the environment's must stay as it is for whatever else reads it.
  *
  * @param json the mapper the application reads a request's body with, as the server Dropwizard
  *             builds reads it; None for an application that reads no body, which is enough for
  *             requests its filters stop
  */
final class InMemoryJersey(config: ResourceConfig, json: Option[ObjectMapper] = None) {

  private val handler = new ApplicationHandler({
    val application = new ResourceConfig(config)
    json.foreach(mapper => application.register(new JacksonMessageBodyProvider(mapper)))
    application
  })

  private val anonymous: SecurityContext = new SecurityContext {
    override def getUserPrincipal: Principal = null
    override def isUserInRole(role: String): Boolean = false
    override def isSecure: Boolean = false
    override def getAuthenticationScheme: String = null
  }

  /**
    * The status the application answers `method` on `path`, a path below `/api`, with: to a
    * request that carries no credentials, or `token` as its bearer.
    */
  def statusOf(method: String, path: String, token: Option[String] = None): Int = {
    val request = new ContainerRequest(
      URI.create("http://localhost/api/"),
      URI.create(s"http://localhost/api$path"),
      method,
      anonymous,
      new MapPropertiesDelegate()
    )
    request.header("Content-Type", MediaType.APPLICATION_JSON)
    token.foreach(bearer => request.header("Authorization", s"Bearer $bearer"))
    request.setEntityStream(new ByteArrayInputStream("{}".getBytes(UTF_8)))
    handler.apply(request).get().getStatus
  }
}
