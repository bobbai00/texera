/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.texera.web.auth

import com.fasterxml.jackson.databind.ObjectMapper
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.common.config.StorageConfig

import java.net.URI
import java.net.URLEncoder
import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.nio.charset.StandardCharsets

/**
  * The unit's own identity toward the catalog: the OAuth2 client it was given for the lake
  * (client credentials), whose token it also presents when it reports on its runs. Cached
  * and renewed a minute before it expires. Without a client the unit reports nothing the
  * catalog accepts.
  */
object UnitIdentity extends LazyLogging {
  private val client = HttpClient.newBuilder().build()
  private val mapper = new ObjectMapper()
  @volatile private var cached: Option[(String, Long)] = None

  def configured: Boolean = StorageConfig.icebergRESTCatalogClientId.nonEmpty

  /** The current access token, "" when the unit has no client or the provider refuses. */
  def token(): String =
    synchronized {
      cached match {
        case Some((token, expiresAt)) if System.currentTimeMillis() < expiresAt => token
        case _ =>
          fetch() match {
            case Some((token, expiresAt)) =>
              cached = Some((token, expiresAt))
              token
            case None => ""
          }
      }
    }

  private def fetch(): Option[(String, Long)] = {
    if (!configured) return None
    val form = Map(
      "grant_type" -> "client_credentials",
      "client_id" -> StorageConfig.icebergRESTCatalogClientId,
      "client_secret" -> StorageConfig.icebergRESTCatalogClientSecret,
      "scope" -> StorageConfig.icebergRESTCatalogScope
    ).map { case (k, v) => s"$k=${URLEncoder.encode(v, StandardCharsets.UTF_8)}" }
      .mkString("&")
    try {
      val request = HttpRequest
        .newBuilder(URI.create(StorageConfig.icebergRESTCatalogTokenUrl))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(form))
        .build()
      val response = client.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() != 200) {
        logger.warn(
          s"the unit's token was refused (${response.statusCode()}): ${response.body().take(200)}"
        )
        None
      } else {
        val body = mapper.readTree(response.body())
        val expiresIn = Option(body.get("expires_in")).map(_.asLong()).getOrElse(300L)
        Some(
          (body.get("access_token").asText(), System.currentTimeMillis() + (expiresIn - 60) * 1000)
        )
      }
    } catch {
      case e: Exception =>
        logger.warn(s"the unit's token could not be fetched: ${e.getMessage}")
        None
    }
  }
}
