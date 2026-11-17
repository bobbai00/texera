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
import org.apache.iceberg.exceptions.NotFoundException
import org.apache.iceberg.expressions.{Expression, Expressions}
import org.apache.iceberg.io.CloseableIterator
import org.apache.iceberg.{DataFile, Schema, Table}
import org.apache.texera.amber.util.IcebergUtil
import software.amazon.awssdk.services.s3.model.NoSuchKeyException

import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * Reads a table that [[IcebergAppender]] writes and [[IcebergTidy]] tidies, as Iceberg records
  * and never through `Tuple`.
  */
private[storage] object IcebergReader {

  /**
    * Hands `collect` the rows of the table's current snapshot, in the order they were appended,
    * with only `columns`. Of the data files, only those whose column bounds allow a row that
    * matches `filter` are read, each with all its rows.
    *
    * A tidy can delete a file this read still needs: a manifest of the snapshot the table was
    * loaded at, or a data file between the read's plan and its read of the file. The read then
    * starts over, once, from the snapshot current by then: `collect` is called again with new
    * rows, and what it returned first is dropped. A file that is gone in the second try as well
    * is thrown. `afterPlan` runs in every try between the plan and the read; tests tidy there.
    */
  def read[T](
      table: Table,
      columns: Seq[String],
      filter: Expression = Expressions.alwaysTrue(),
      afterPlan: () => Unit = () => ()
  )(collect: Iterator[Record] => T): T = {
    val projection = table.schema().select(columns.asJava)

    def readOnce(): T = {
      val files = dataFiles(table, filter)
      afterPlan()
      Using.resource(new Records(table, files, projection))(collect)
    }

    try readOnce()
    catch {
      // S3FileIO turns a missing object into a NotFoundException where it opens a stream, and
      // lets the object store's own exception through where it asks for the object's length,
      // as it does for the manifest list of an expired snapshot.
      case _: NotFoundException | _: NoSuchKeyException =>
        table.refresh()
        readOnce()
    }
  }

  /**
    * The data files of the table's current snapshot that can hold a row matching `filter`, in
    * the order their rows were appended: by data sequence number, which a file merged by
    * [[IcebergTidy]] takes over from the files it replaces.
    */
  private[iceberg] def dataFiles(
      table: Table,
      filter: Expression = Expressions.alwaysTrue()
  ): List[DataFile] =
    Using
      .resource(table.newScan().filter(filter).planFiles())(_.asScala.map(_.file()).toList)
      .sortBy(_.dataSequenceNumber().longValue())

  /** The rows of `files`, file after file, with one file open at a time. */
  private[iceberg] final class Records(table: Table, files: Seq[DataFile], projection: Schema)
      extends Iterator[Record]
      with AutoCloseable {

    private val remaining = files.iterator
    private var open: Option[CloseableIterator[Record]] = None

    override def hasNext: Boolean = {
      while (!open.exists(_.hasNext) && remaining.hasNext) {
        close()
        open = Some(IcebergUtil.readDataFileAsIterator(remaining.next(), projection, table))
      }
      open.exists(_.hasNext)
    }

    override def next(): Record =
      if (hasNext) open.get.next() else throw new NoSuchElementException("no more rows")

    override def close(): Unit = {
      open.foreach(_.close())
      open = None
    }
  }
}
