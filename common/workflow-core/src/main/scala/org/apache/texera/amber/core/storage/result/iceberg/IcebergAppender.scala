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
import org.apache.iceberg.exceptions.CleanableFailure
import org.apache.iceberg.parquet.Parquet
import org.apache.iceberg.{
  DataFile,
  HasTableOperations,
  ManifestFile,
  ManifestFiles,
  Schema,
  SnapshotSummary,
  Table,
  UpdateProperties
}
import org.apache.parquet.schema.MessageType

import java.net.{ConnectException, NoRouteToHostException, UnknownHostException}
import java.util.UUID
import scala.annotation.tailrec
import scala.collection.mutable
import scala.util.control.NonFatal

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
    *
    * An append that fails leaves no file behind when its commit cannot have landed (see
    * [[committing]]), so a writer that tries again and again does not fill the table's location
    * with files no table reads.
    *
    * Nothing of an append runs on Iceberg's shared worker pool, which takes no work once the
    * JVM is exiting: a computing unit that is stopped records how its runs ended exactly then.
    * So the append writes the manifest of its data file itself ([[writeManifest]]), where
    * Iceberg would write it on that pool whatever executor the append names.
    */
  def append(
      table: Table,
      records: Iterable[Record],
      filePrefix: String,
      properties: Map[String, String] = Map.empty
  ): Unit = {
    val transaction = table.newTransaction()
    val file = Option.when(records.nonEmpty)(writeDataFile(table, records, filePrefix))
    // What the append wrote that no table reads before the commit lands.
    val written = mutable.ListBuffer.from(file.map(_.location()))
    committing(table, written) { () =>
      file.foreach { added =>
        val manifest = writeManifest(table, added)
        written += manifest.path()
        transaction
          .newFastAppend()
          .scanManifestsWith(OnCallingThread)
          .appendManifest(manifest)
          // A manifest that is handed over is counted by its files and rows alone.
          .set(SnapshotSummary.ADDED_FILE_SIZE_PROP, added.fileSizeInBytes().toString)
          .commit()
      }
      if (properties.nonEmpty) set(transaction.updateProperties(), properties).commit()
    } { () =>
      // One commit to the catalog for both, and none when there was neither.
      transaction.commitTransaction()
    }
  }

  /**
    * Makes the files at `written`, which `table` does not read yet, part of it: `prepare` gets
    * the commit ready without asking the catalog, and `commit` asks it. When either fails, the
    * failure is thrown as it is, and the files are deleted if the commit cannot have landed:
    * nothing would ever read them. `written` is read when that happens, so `prepare` can add
    * to it.
    *
    * It cannot have landed when the catalog was not asked yet, when the failure is one Iceberg
    * marks as safe to clean up after ([[CleanableFailure]]: the catalog refused the commit, or
    * has no such table), and when the catalog could not be connected to. After any other
    * failure the commit may have landed, as when the catalog's answer was lost
    * (`CommitStateUnknownException`) or never came: the table then reads the files, so they
    * stay.
    */
  private[iceberg] def committing(table: Table, written: Iterable[String])(
      prepare: () => Unit
  )(commit: () => Unit): Unit = {
    var asked = false
    try {
      prepare()
      asked = true
      commit()
    } catch {
      case NonFatal(failure) =>
        if (!asked || cannotHaveLanded(failure)) {
          written.foreach { orphan =>
            try table.io().deleteFile(orphan)
            catch { case NonFatal(notDeleted) => failure.addSuppressed(notDeleted) }
          }
        }
        throw failure
    }
  }

  @tailrec
  private def cannotHaveLanded(failure: Throwable): Boolean =
    if (failure == null) false
    else if (failure.isInstanceOf[CleanableFailure] || neverSent(failure)) true
    else cannotHaveLanded(failure.getCause)

  /**
    * Whether `failure` says that a request was not sent: the catalog's address did not resolve,
    * or nothing answered there. Apache's client, which Iceberg's REST catalog uses, reports a
    * connection that timed out as a socket timeout of the name below.
    */
  private def neverSent(failure: Throwable): Boolean =
    failure match {
      case _: ConnectException | _: UnknownHostException | _: NoRouteToHostException => true
      case other                                                                     => other.getClass.getSimpleName == "ConnectTimeoutException"
    }

  /** Sets table properties in a commit of their own, which adds no snapshot. */
  def setProperties(table: Table, properties: Map[String, String]): Unit =
    if (properties.nonEmpty) set(table.updateProperties(), properties).commit()

  /**
    * Writes `records` to a new Parquet file `<filePrefix>_<32 hex digits>` under the table's
    * location, the way `IcebergTableWriter` writes one. The file is not part of the table yet:
    * [[committing]] makes it part of it.
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

  /**
    * Writes the manifest that adds `file` to `table`, on the calling thread, beside the table's
    * other metadata. The manifest is not part of the table yet. Its entry takes the snapshot
    * and the sequence number of the commit that adds it, as a table of format version 2 has
    * them inherited: Iceberg makes no other by default.
    */
  private def writeManifest(table: Table, file: DataFile): ManifestFile = {
    val operations = table.asInstanceOf[HasTableOperations].operations()
    val location = operations.metadataFileLocation(s"${UUID.randomUUID()}-m0.avro")
    val writer = ManifestFiles.write(
      operations.current().formatVersion(),
      table.spec(),
      table.io().newOutputFile(location),
      null
    )
    try writer.add(file)
    finally writer.close()
    writer.toManifestFile
  }

  private def set(update: UpdateProperties, properties: Map[String, String]): UpdateProperties =
    properties.foldLeft(update) { case (pending, (key, value)) => pending.set(key, value) }
}
