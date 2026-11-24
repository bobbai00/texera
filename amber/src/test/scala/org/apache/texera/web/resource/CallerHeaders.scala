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

import java.lang.reflect.{InvocationHandler, Method, Proxy}
import javax.ws.rs.core.HttpHeaders

/**
  * The headers of a request to one of a computing unit's routes, as a suite hands them to the
  * route: all a unit reads of them is the user its caller names ([[UnitCaller]]).
  */
object CallerHeaders {

  /**
    * The headers of a request for user `uid`, as the Dashboard service and the agent service
    * send them.
    */
  def of(uid: Int): HttpHeaders = holding(Map(HeaderField.UserId -> uid.toString))

  /** The headers of a request that names no user. */
  val none: HttpHeaders = holding(Map.empty)

  /**
    * Headers that hold `values`, read by name without regard to case as a request's are, and
    * answer nothing else: a route that asked them for more would fail its suite.
    */
  def holding(values: Map[String, String]): HttpHeaders =
    Proxy
      .newProxyInstance(
        classOf[HttpHeaders].getClassLoader,
        Array[Class[_]](classOf[HttpHeaders]),
        new InvocationHandler {
          override def invoke(proxy: AnyRef, method: Method, args: Array[AnyRef]): AnyRef =
            method.getName match {
              case "getHeaderString" =>
                val name = args(0).asInstanceOf[String]
                values.collectFirst {
                  case (held, value) if held.equalsIgnoreCase(name) => value
                }.orNull
              case "toString" => s"CallerHeaders($values)"
              case "hashCode" => Int.box(System.identityHashCode(proxy))
              case "equals"   => Boolean.box(proxy eq args(0))
              case other =>
                throw new UnsupportedOperationException(s"a suite's headers answer no $other")
            }
        }
      )
      .asInstanceOf[HttpHeaders]
}
