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

import org.apache.iceberg.{DataFile, Table}

import scala.util.Using

/**
  * Tidies a table that [[IcebergAppender]] writes. Every append leaves a small data file, a
  * manifest and a snapshot, and a table that keeps them all gets slower to commit to and much
  * slower to read. The table's writer therefore tidies it every so often and when it is done.
  *
  * Only for a table read through [[IcebergReader]], which survives a tidy. Result and state
  * tables are read by iterators that resume from a snapshot and fail once that snapshot is
  * expired: nothing may tidy them.
  */
private[storage] object IcebergTidy {

  /** A data file that reached this size is not merged again. */
  val TargetFileBytes: Long = 32L * 1024 * 1024

  /** While the table is written, a tidy keeps this many snapshots at least. */
  val RetainSnapshots: Int = 5

  /** While the table is written, a tidy keeps the snapshots of this many milliseconds. */
  val RetainMillis: Long = 60L * 1000

  /**
    * Merges the small data files, rewrites the manifests into one and expires snapshots, a
    * commit each. None of them touches the table's properties or the order of its rows.
    *
    * @param atEnd whether the table's writer is done. Then one snapshot stays, with one
    *              manifest and the merged data file (beside every file that had reached
    *              [[TargetFileBytes]]). Otherwise the snapshots of the last [[RetainMillis]]
    *              and at least [[RetainSnapshots]] stay, so that the files a read has planned
    *              outlive it.
    */
  def tidy(table: Table, atEnd: Boolean, exiting: () => Boolean = jvmExiting): Unit =
    // A table nothing was appended to has nothing to tidy. Nor is a table tidied while the JVM
    // exits, as a computing unit that is stopped does: Iceberg merges and deletes files on pools
    // of its own, which take no work by then, and the snapshots an expiry drops would leave
    // their files in the table's location for good. The table stays as its writer left it.
    if (table.currentSnapshot() != null && !exiting()) {
      mergeSmallFiles(table, TargetFileBytes)
      rewriteManifests(table)
      if (atEnd) expire(table, retainLast = 1, olderThanMs = Long.MaxValue)
      else expire(table, RetainSnapshots, System.currentTimeMillis() - RetainMillis)
    }

  /**
    * Whether the JVM is shutting down: it then takes no shutdown hook, and refuses one with an
    * `IllegalStateException`.
    */
  private def jvmExiting(): Boolean = {
    val probe = new Thread(() => ())
    try {
      Runtime.getRuntime.addShutdownHook(probe)
      Runtime.getRuntime.removeShutdownHook(probe)
      false
    } catch {
      case _: IllegalStateException => true
    }
  }

  /**
    * Merges the newest data files that are each smaller than `targetBytes` into one, when there
    * are two or more, and returns how many it merged. A file is never rewritten once a file of
    * `targetBytes` or more was appended after it, so a tidy does not copy a large table.
    *
    * The merged file takes the data sequence number of the newest file it replaces, much as
    * Iceberg's own compaction gives its files the sequence number it started at. Rows
    * therefore keep their order whatever is appended while the merge runs: an append that
    * lands before the merge commits still sorts after it.
    * `beforeCommit` runs right before the commit; tests append there.
    */
  def mergeSmallFiles(
      table: Table,
      targetBytes: Long,
      beforeCommit: () => Unit = () => ()
  ): Int = {
    val small =
      IcebergReader.dataFiles(table).reverse.takeWhile(_.fileSizeInBytes() < targetBytes).reverse
    if (small.size < 2) 0
    else {
      val planned = table.currentSnapshot().snapshotId()
      val merged = Using.resource(new IcebergReader.Records(table, small, table.schema())) {
        IcebergAppender.writeDataFile(table, _, "merged")
      }
      // Validated from the planned snapshot on only: the history before it may be expired.
      val rewrite = table
        .newRewrite()
        .scanManifestsWith(OnCallingThread)
        .validateFromSnapshot(planned)
        .dataSequenceNumber(small.last.dataSequenceNumber())
      // A merge that fails leaves no merged file behind, as an append leaves no data file.
      IcebergAppender.committing(table, Seq(merged.location())) { () =>
        small.foreach(rewrite.deleteFile(_: DataFile))
        rewrite.addFile(merged)
        beforeCommit()
      } { () =>
        rewrite.commit()
      }
      small.size
    }
  }

  /** Rewrites the current snapshot's manifests into one, when it has more than one. */
  def rewriteManifests(table: Table): Unit =
    if (Option(table.currentSnapshot()).exists(_.allManifests(table.io()).size() > 1)) {
      table
        .rewriteManifests()
        .scanManifestsWith(OnCallingThread)
        .clusterBy((_: DataFile) => "all")
        .commit()
    }

  /**
    * Expires the snapshots older than `olderThanMs`, except the newest `retainLast`, and
    * deletes the files only they used.
    */
  def expire(table: Table, retainLast: Int, olderThanMs: Long): Unit =
    table
      .expireSnapshots()
      .expireOlderThan(olderThanMs)
      .retainLast(retainLast)
      .cleanExpiredFiles(true)
      .planWith(OnCallingThread)
      .executeDeleteWith(OnCallingThread)
      .commit()
}
