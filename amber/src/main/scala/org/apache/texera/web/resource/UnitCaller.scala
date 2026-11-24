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

package org.apache.texera.web.resource

import org.apache.texera.auth.util.HeaderField
import org.apache.texera.dao.jooq.generated.tables.pojos.User

import javax.ws.rs.WebApplicationException
import javax.ws.rs.core.{HttpHeaders, MediaType, Response}

/**
  * Who a request to one of a computing unit's routes is for: the user its caller names in
  * [[HeaderField.UserId]]. A unit verifies no token and holds no secret to verify one with. It
  * trusts whoever reaches its port to say, and a deployment's network rules let only the
  * gateway, the Dashboard service and the agent service reach it, each of which has checked
  * the user itself.
  */
object UnitCaller {

  val NoUser = "The request names no user."

  /** The user `headers` name, when they name one by an id. */
  def of(headers: HttpHeaders): Option[User] =
    Option(headers.getHeaderString(HeaderField.UserId))
      .map(_.trim)
      .flatMap(_.toIntOption)
      .map { uid =>
        val user = new User()
        user.setUid(uid)
        user
      }

  /** The user `headers` name, or the 401 a request that names none is answered. */
  def required(headers: HttpHeaders): User =
    of(headers).getOrElse {
      throw new WebApplicationException(
        Response
          .status(Response.Status.UNAUTHORIZED)
          .`type`(MediaType.APPLICATION_JSON)
          .entity(HandoverRefusal(NoUser))
          .build()
      )
    }
}
