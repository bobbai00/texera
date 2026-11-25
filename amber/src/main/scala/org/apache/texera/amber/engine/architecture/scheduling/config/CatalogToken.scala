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

package org.apache.texera.amber.engine.architecture.scheduling.config

/**
  * The token of an execution for the lake's catalog, which every catalog request about the
  * execution carries ([[org.apache.texera.amber.core.storage.CatalogIdentity]]). It opens the
  * execution's tables, so it is never printed: the configuration of a worker holds it, and is
  * logged and sent to other machines.
  *
  * @param value the token itself; empty for none
  */
final case class CatalogToken(value: String) {
  override def toString: String =
    if (value.isEmpty) "CatalogToken()" else "CatalogToken(<hidden>)"
}

object CatalogToken {

  /** No token: the computing unit was handed none, as with a catalog that takes no token. */
  val None: CatalogToken = CatalogToken("")
}
