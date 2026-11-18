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

package org.apache.texera.dao

import java.nio.file.{Files, Paths}
import scala.jdk.CollectionConverters._

object SqlUpdate {
  private val DroppedColumn = """\s*DROP COLUMN IF EXISTS (\w+)[,;]\s*-- was (.+)""".r
  private val DroppedTable = """DROP TABLE IF EXISTS texera_db\.(\w+);""".r
  private val DroppedType = """DROP TYPE IF EXISTS texera_db\.(\w+);""".r

  /** The numbers of the updates `sql/changelog.xml` lists, in its order. */
  def listedInChangelog: Seq[Int] = {
    val changelog = new String(Files.readAllBytes(Paths.get("sql/changelog.xml").toRealPath()))
    """<sqlFile path="sql/updates/(\d+)\.sql"/>""".r
      .findAllMatchIn(changelog.replaceAll("(?s)<!--.*?-->", ""))
      .map(_.group(1).toInt)
      .toSeq
  }
}

/**
  * The update `sql/updates/<number>.sql`, read from its file, for a spec that applies it. What
  * it drops is read from it too: a spec puts that back to have a database as it was before
  * the update, by the names, and for a column the definition, the update itself gives.
  */
final class SqlUpdate(number: Int) {
  import SqlUpdate._

  private val lines: Seq[String] =
    Files.readAllLines(Paths.get(f"sql/updates/$number%02d.sql").toRealPath()).asScala.toSeq

  /** The update as its runners apply it: without psql's `\c`, on a connection to the database. */
  val script: String = lines.filterNot(_.trim.startsWith("\\c")).mkString("\n")

  /** Each column it drops, with what its comment says the column was: its type and default. */
  val droppedColumns: Seq[(String, String)] =
    lines.collect { case DroppedColumn(name, was) => name -> was.trim }

  val droppedTables: Seq[String] = lines.collect { case DroppedTable(name) => name }

  val droppedTypes: Seq[String] = lines.collect { case DroppedType(name) => name }
}
