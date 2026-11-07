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

package org.apache.texera.amber.operator.builtin.expr

import org.apache.texera.amber.core.tuple.AttributeType

/** Names: of columns, which may be mistyped, and of types, which have a few spellings. */
object Names {

  /** What a name that is not a column is told: the closest column, else the columns there are. */
  def missing(name: String, columns: List[String]): String = {
    val wanted = name.toLowerCase
    val close = columns
      .map(c => c -> distance(wanted, c.toLowerCase))
      .filter {
        case (c, d) =>
          val column = c.toLowerCase
          d <= math.max(2, column.length / 3) || (wanted.length >= 3 && (column.startsWith(
            wanted
          ) || column.contains(wanted) || wanted.startsWith(column)))
      }
      .sortBy(_._2)
    close.headOption match {
      case Some((best, _)) => s"""the input has no column "$name"; did you mean "$best"?"""
      case None if columns.size <= 12 =>
        s"""the input has no column "$name"; its columns are ${columns
          .map(c => s""""$c"""")
          .mkString(", ")}"""
      case None => s"""the input has no column "$name\""""
    }
  }

  /** The type a name in CAST means. */
  def typeNamed(name: String): Option[AttributeType] =
    name.toLowerCase match {
      case "integer" | "int"                          => Some(AttributeType.INTEGER)
      case "long" | "bigint"                          => Some(AttributeType.LONG)
      case "double" | "float" | "real" | "number"     => Some(AttributeType.DOUBLE)
      case "text" | "string" | "varchar"              => Some(AttributeType.STRING)
      case "boolean" | "bool"                         => Some(AttributeType.BOOLEAN)
      case "timestamp" | "datetime" | "date" | "time" => Some(AttributeType.TIMESTAMP)
      case _                                          => None
    }

  /** Edit distance: how many letters to change, add or remove to get from one name to the other. */
  def distance(a: String, b: String): Int = {
    val row = Array.tabulate(b.length + 1)(identity)
    for (i <- 1 to a.length) {
      var diagonal = row(0)
      row(0) = i
      for (j <- 1 to b.length) {
        val above = row(j)
        row(j) = math.min(
          math.min(row(j) + 1, row(j - 1) + 1),
          diagonal + (if (a(i - 1) == b(j - 1)) 0 else 1)
        )
        diagonal = above
      }
    }
    row(b.length)
  }
}
