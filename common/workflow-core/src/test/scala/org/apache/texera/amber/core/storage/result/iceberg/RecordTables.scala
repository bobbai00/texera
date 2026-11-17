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

package org.apache.texera.amber.core.storage.result.iceberg

import org.apache.iceberg.catalog.{Catalog, TableIdentifier}
import org.apache.iceberg.data.{GenericRecord, Record}
import org.apache.iceberg.{DataFile, HasTableOperations, Table}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.util.IcebergUtil
import org.scalatest.{BeforeAndAfterAll, Suite}

import java.nio.file.{Files, Path}
import java.util.{Comparator, UUID}
import scala.jdk.CollectionConverters._

/**
  * Tables of `(seq LONG, text STRING)` rows for the specs of [[IcebergAppender]],
  * [[IcebergReader]] and [[IcebergTidy]], in a local Hadoop catalog of the suite's own: the
  * JVM-wide `IcebergCatalogInstance` is other suites' to replace. Every table has a name of
  * its own, and everything a spec looks at is asked of the table and its `FileIO`, never of
  * the local file system, so the specs hold on any catalog.
  */
trait RecordTables extends BeforeAndAfterAll { this: Suite =>

  private val namespace = "record_tables_spec"
  private var warehouseDir: Path = _
  private var catalog: Catalog = _

  override def beforeAll(): Unit = {
    super.beforeAll()
    warehouseDir = Files.createTempDirectory("record-tables-spec")
    catalog = IcebergUtil.createHadoopCatalog("record-tables-spec", warehouseDir)
  }

  override def afterAll(): Unit =
    try {
      catalog match {
        case closeable: AutoCloseable => closeable.close()
        case _                        =>
      }
      Files
        .walk(warehouseDir)
        .sorted(Comparator.reverseOrder[Path]())
        .forEach((path: Path) => Files.deleteIfExists(path))
    } finally super.afterAll()

  protected def newTable(): Table =
    IcebergUtil.createTable(
      catalog,
      namespace,
      s"tbl_${UUID.randomUUID().toString.replace("-", "")}",
      IcebergUtil.toIcebergSchema(
        Schema().add("seq", AttributeType.LONG).add("text", AttributeType.STRING)
      ),
      overrideIfExists = true
    )

  /** The table as a client that loads it now sees it. */
  protected def loaded(table: Table): Table = {
    val name = table.name()
    catalog.loadTable(TableIdentifier.of(namespace, name.substring(name.lastIndexOf('.') + 1)))
  }

  protected def record(table: Table, seq: Long, text: String): Record = {
    val record = GenericRecord.create(table.schema())
    record.setField("seq", Long.box(seq))
    record.setField("text", text)
    record
  }

  protected def textOf(seq: Long): String = s"row-$seq"

  /** Appends one row per `seq`, in one commit. */
  protected def append(
      table: Table,
      seqs: Seq[Long],
      properties: Map[String, String] = Map.empty
  ): Unit =
    IcebergAppender.append(
      table,
      seqs.map(seq => record(table, seq, textOf(seq))),
      "rows",
      properties
    )

  /** The `seq` of every row, as [[IcebergReader]] reads a newly loaded table. */
  protected def readSeqs(table: Table): List[Long] =
    IcebergReader.read(loaded(table), Seq("seq"))(_.map(seqOf).toList)

  protected def seqOf(record: Record): Long = record.getField("seq").asInstanceOf[Long]

  /** The current snapshot's data files, oldest rows first. */
  protected def dataFiles(table: Table): List[DataFile] = IcebergReader.dataFiles(loaded(table))

  protected def exists(table: Table, location: String): Boolean =
    table.io().newInputFile(location).exists()

  protected def snapshotCount(table: Table): Int = loaded(table).snapshots().asScala.size

  /** How many commits the table has had since it was created. */
  protected def commitCount(table: Table): Int =
    loaded(table).asInstanceOf[HasTableOperations].operations().current().previousFiles().size()
}
