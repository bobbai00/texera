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

package org.apache.texera.amber.core.storage

import org.apache.texera.auth.CatalogTokens

import scala.collection.concurrent.TrieMap

/**
  * Who this JVM is to the Iceberg REST catalog, which decides the token each of its catalog
  * requests carries (see [[org.apache.texera.amber.util.CatalogTokenAuthManager]]):
  *
  *  - [[Anonymous]]: none. Where the catalog asks for no token: tests, and the hadoop and
  *    postgres catalogs.
  *  - [[Platform]]: the platform's token ([[CatalogTokens.platform]]), for Texera's services
  *    that read and drop the tables of every execution: the Dashboard service and the Result
  *    Service.
  *  - [[Executions]]: a request about an execution carries the token the execution was
  *    [[register]]ed with in this JVM, and any other request carries none. For the computing
  *    unit's JVMs, its master and its workers, which hold no secret to make a token with.
  *
  * A JVM starts [[Anonymous]], and its main says which it is before its first catalog request.
  */
object CatalogIdentity {

  sealed trait Mode

  case object Anonymous extends Mode

  case object Platform extends Mode

  case object Executions extends Mode

  @volatile private var current: Mode = Anonymous

  private val tokens = TrieMap.empty[Long, String]

  def use(mode: Mode): Unit = current = mode

  def mode: Mode = current

  /**
    * Executions mode: remember the token of execution `eid` in this JVM. Idempotent; a later
    * token of the same execution takes the place of the earlier one. A null or blank token is
    * no token, and registers nothing.
    */
  def register(eid: Long, token: String): Unit =
    Option(token).filter(_.trim.nonEmpty).foreach(tokens.put(eid, _))

  /** The token execution `eid` was registered with in this JVM. */
  def registered(eid: Long): Option[String] = tokens.get(eid)

  /** What a catalog request about execution `eid` (None: about no execution) carries. */
  def tokenFor(eid: Option[Long]): Option[String] =
    current match {
      case Anonymous  => None
      case Platform   => Some(CatalogTokens.platform())
      case Executions => eid.flatMap(registered)
    }

  /**
    * The catalog-cache identity of a request about execution `eid`: "anonymous", "platform" or
    * "execution-<eid>". Requests of one identity carry the same token, so they can share a
    * catalog client, and requests of two identities never do.
    */
  def cacheIdentity(eid: Option[Long]): String =
    current match {
      case Anonymous  => "anonymous"
      case Platform   => "platform"
      case Executions => eid.fold("anonymous")(id => s"execution-$id")
    }
}
