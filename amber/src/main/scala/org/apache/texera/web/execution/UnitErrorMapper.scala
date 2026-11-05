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

package org.apache.texera.web.execution

import com.typesafe.scalalogging.LazyLogging

import javax.ws.rs.WebApplicationException
import javax.ws.rs.core.{MediaType, Response}
import javax.ws.rs.ext.{ExceptionMapper, Provider}

/** The contract's Error (api/common.tsp). */
case class UnitErrorBody(code: String, message: String)

object UnitErrorMapper {
  def codeOf(status: Int): String =
    status match {
      case 400 | 422     => "invalid"
      case 401           => "unauthorized"
      case 403           => "forbidden"
      case 404           => "not_found"
      case 409           => "conflict"
      case s if s >= 500 => "internal"
      case _             => "error"
    }
}

/**
  * Every error of the unit in the contract's shape, with the engine's own words. Dropwizard's
  * default mapper answers a numeric code and, for anything unexpected, a generic message with a log
  * id; the catalog is the unit's only client and passes the words on to the person or agent that
  * asked. More specific than the default mapper for Throwable, so it wins.
  */
@Provider
class UnitErrorMapper extends ExceptionMapper[RuntimeException] with LazyLogging {
  override def toResponse(e: RuntimeException): Response = {
    // A refusal keeps its own status and headers (a 401's challenge); anything else is the
    // engine failing.
    val answer = e match {
      case refused: WebApplicationException =>
        val original = refused.getResponse
        if (original.getStatus < 400) return original
        Response.fromResponse(original)
      case _ => Response.status(Response.Status.INTERNAL_SERVER_ERROR)
    }
    val status = answer.build().getStatus
    if (status >= 500) logger.error(s"unit error: $e", e)
    val message = Option(e.getMessage).filter(_.nonEmpty).getOrElse(e.toString)
    answer
      .`type`(MediaType.APPLICATION_JSON)
      .entity(UnitErrorBody(UnitErrorMapper.codeOf(status), message))
      .build()
  }
}
