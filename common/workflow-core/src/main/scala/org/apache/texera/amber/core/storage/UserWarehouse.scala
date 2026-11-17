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

/**
  * How a user's own warehouse is named in the catalog, and so in the URI of everything an
  * execution writes into it: `user-<uid>-<whid>`. The Dashboard mints the name when the user
  * registers the warehouse, and a computing unit tells a user's own warehouses by it.
  */
object UserWarehouse {

  private val Name = "user-([0-9]+)-[0-9]+".r

  /** The name of warehouse `whid` of user `uid`: stable, short, and mapping back to its row. */
  def nameOf(uid: Int, whid: Int): String = s"user-$uid-$whid"

  /** Whether `name` is the name of one of user `uid`'s warehouses. */
  def isOwnedBy(name: String, uid: Int): Boolean =
    name match {
      case Name(owner) => owner == uid.toString
      case _           => false
    }
}
