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

package org.apache.texera.web.auth

import java.security.Principal

/**
  * Who is calling the unit, as a verified token says. The unit keeps no user records: people,
  * agents and their grants live in the catalog, and the gateway asks the catalog before a
  * request reaches the unit.
  *
  * @param subject the token's `sub`, the catalog's principal id for people and agents
  * @param role    what `@RolesAllowed` checks: [[UnitPrincipal.Admin]] for administrators and
  *                platform services, [[UnitPrincipal.Regular]] otherwise
  */
final case class UnitPrincipal(subject: String, name: String, email: Option[String], role: String)
    extends Principal {
  override def getName: String = name
  def isRoleOf(r: String): Boolean = role == r
}

object UnitPrincipal {
  val Regular = "REGULAR"
  val Admin = "ADMIN"
}
