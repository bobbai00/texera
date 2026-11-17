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

import org.apache.iceberg.data.Record
import org.apache.iceberg.data.parquet.GenericParquetWriter
import org.apache.iceberg.parquet.Parquet
import org.apache.iceberg.{DataFile, Schema, Table, UpdateProperties}
import org.apache.parquet.schema.MessageType

import java.util.UUID

/**
  * Appends Iceberg records to a table that has one writer, which commits on its own schedule:
  * every call is one data file and one commit. [[IcebergTableWriter]] serves the other case,
  * many writers that each buffer a batch of tuples.
  */
private[storage] object IcebergAppender {

  /**
    * Appends `records` as one data file and sets `properties` in the same commit, so a reader
    * sees the rows and the properties together or neither. Without records it only sets the
    * properties, and without either it commits nothing.
    *
    * The file is `<filePrefix>_<32 hex digits>` under the table's location. The digits are
    * random, so an append that is tried again never writes over the file of its first try,
    * which the table reads if that try's commit landed after all.
    *
    * The append is a fast append, which adds a manifest instead of merging into the last one:
    * the table's writer tidies it ([[IcebergTidy]]), and a tidy rewrites the manifests anyway.
    */
  def append(
      table: Table,
      records: Iterable[Record],
      filePrefix: String,
      properties: Map[String, String] = Map.empty
  ): Unit = {
    val transaction = table.newTransaction()
    if (records.nonEmpty) {
      transaction.newFastAppend().appendFile(writeDataFile(table, records, filePrefix)).commit()
    }
    if (properties.nonEmpty) set(transaction.updateProperties(), properties).commit()
    // One commit to the catalog for both, and none when there was neither.
    transaction.commitTransaction()
  }

  /** Sets table properties in a commit of their own, which adds no snapshot. */
  def setProperties(table: Table, properties: Map[String, String]): Unit =
    if (properties.nonEmpty) set(table.updateProperties(), properties).commit()

  /**
    * Writes `records` to a new Parquet file `<filePrefix>_<32 hex digits>` under the table's
    * location, the way `IcebergTableWriter` writes one. The file is not part of the table yet.
    */
  private[iceberg] def writeDataFile(
      table: Table,
      records: IterableOnce[Record],
      filePrefix: String
  ): DataFile = {
    val location = table.location().stripSuffix("/")
    val fileName = s"${filePrefix}_${UUID.randomUUID().toString.replace("-", "")}"
    val writer = Parquet
      .writeData(table.io().newOutputFile(s"$location/$fileName"))
      .forTable(table)
      .createWriterFunc((schema: Schema, messageType: MessageType) =>
        GenericParquetWriter.create(schema, messageType)
      )
      .overwrite()
      .build[Record]()
    try records.iterator.foreach(writer.write)
    finally writer.close()
    writer.toDataFile
  }

  private def set(update: UpdateProperties, properties: Map[String, String]): UpdateProperties =
    properties.foldLeft(update) { case (pending, (key, value)) => pending.set(key, value) }
}
