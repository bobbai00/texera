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

import org.apache.iceberg.rest.auth.{AuthManager, AuthSession, DefaultAuthSession}
import org.apache.iceberg.rest.{HTTPHeaders, RESTClient}
import org.apache.texera.amber.core.storage.CatalogIdentity

import java.util

/**
  * How a Java Iceberg REST client says who it is: every request it sends carries the token
  * [[CatalogIdentity.tokenFor]] gives for the client's execution at that moment, as
  * `Authorization: Bearer <token>`, or no such header when there is none. The token is looked
  * up per request, so a client that lives for days sends each new platform token, and a client
  * made before its execution's token was registered sends the token once it is.
  *
  * The client's execution is the one its property [[CatalogTokenAuthManager.ExecutionProperty]]
  * names, and none when it is absent. Iceberg makes the manager from the property
  * `rest.auth.type` (see `IcebergUtil.createRestCatalog`), for the catalog, and with the
  * catalog's properties for the S3 remote signer of each table the catalog opens, so the
  * signing requests of S3 reads and writes carry the same token.
  *
  * Every session it gives is such a session: Iceberg's defaults make the one of the initial
  * configuration request and the signer's as they make the catalog's, and give a context or a
  * table the session of its parent.
  *
  * @param name the name of the catalog, or of the component such as the S3 signer, that uses
  *             the manager: Iceberg makes every manager with one.
  */
class CatalogTokenAuthManager(name: String) extends AuthManager {

  override def catalogSession(
      sharedClient: RESTClient,
      properties: util.Map[String, String]
  ): AuthSession = {
    val execution =
      Option(properties.get(CatalogTokenAuthManager.ExecutionProperty)).map(_.toLong)
    new DefaultAuthSession {
      override def headers(): HTTPHeaders =
        CatalogIdentity
          .tokenFor(execution)
          .fold(HTTPHeaders.EMPTY)(token =>
            HTTPHeaders.of(HTTPHeaders.HTTPHeader.of("Authorization", s"Bearer $token"))
          )
    }
  }

  override def close(): Unit = ()
}

object CatalogTokenAuthManager {

  /** The catalog property that names the execution a client speaks for. */
  val ExecutionProperty = "texera.catalog.execution"
}
