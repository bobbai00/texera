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

import jakarta.annotation.security.PermitAll
import jakarta.ws.rs.core.{Context, MediaType, UriInfo}
import jakarta.ws.rs.{GET, Path, Produces}
import org.apache.texera.auth.CatalogTokens

/**
  * Publishes the key the catalog checks Texera's catalog tokens with, the way an OpenID provider
  * publishes its own: Lakekeeper reads the discovery document when it starts, then the key set
  * the document names. Neither takes a token, since a key set holds public keys only.
  */
@Path("/catalog-issuer")
@PermitAll
@Produces(Array(MediaType.APPLICATION_JSON))
class CatalogIssuerResource {

  /** The discovery document. It names the key set by an absolute URL on this request's base. */
  @GET
  @Path("/.well-known/openid-configuration")
  def discovery(@Context uriInfo: UriInfo): String =
    CatalogTokens.discoveryJson(
      uriInfo.getBaseUriBuilder
        .path(classOf[CatalogIssuerResource])
        .path(classOf[CatalogIssuerResource], "jwks")
        .build()
        .toString
    )

  /** The key set: the public key the catalog tokens are signed with. */
  @GET
  @Path("/jwks")
  def jwks: String = CatalogTokens.jwksJson()
}
