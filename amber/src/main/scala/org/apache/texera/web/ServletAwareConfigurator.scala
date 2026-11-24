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
import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.jooq.generated.tables.pojos.User

import javax.websocket.HandshakeResponse
import javax.websocket.server.{HandshakeRequest, ServerEndpointConfig}
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Takes who a websocket is for from its handshake: the identity the gateway sets on it once
  * the access control service has checked the user's token and their access to this computing
  * unit ([[HeaderField]]). A unit verifies no token itself. A handshake that carries no such
  * identity leaves the session without a user and without an access, and the endpoint closes it
  * ([[org.apache.texera.web.resource.WorkflowWebsocketResource.myOnOpen]]).
  */
class ServletAwareConfigurator extends ServerEndpointConfig.Configurator with LazyLogging {

  override def modifyHandshake(
      config: ServerEndpointConfig,
      request: HandshakeRequest,
      response: HandshakeResponse
  ): Unit = {
    val headers = request.getHeaders.asScala.view.mapValues(_.asScala.headOption).toMap
    def header(name: String): Option[String] = headers.get(name).flatten
    val identity = for {
      access <- header(HeaderField.UserComputingUnitAccess)
      uid <- header(HeaderField.UserId).flatMap(id => Try(id.trim.toInt).toOption)
    } yield (access, uid)
    identity match {
      case Some((access, uid)) =>
        config.getUserProperties.put(HeaderField.UserComputingUnitAccess, access)
        val user = new User()
        user.setUid(uid)
        header(HeaderField.UserName).foreach(user.setName)
        header(HeaderField.UserEmail).foreach(user.setEmail)
        config.getUserProperties.put(classOf[User].getName, user)
        logger.info(s"A websocket for user $uid, with $access access to this computing unit.")
      case None =>
        logger.warn("A websocket handshake came with no identity from the gateway.")
    }
  }
}
