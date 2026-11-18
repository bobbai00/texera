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

import org.apache.iceberg.Table
import org.apache.iceberg.exceptions.{CommitStateUnknownException, ServiceUnavailableException}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class IcebergTidySpec extends AnyFlatSpec with Matchers with RecordTables {

  private def manifestCount(table: Table): Int = {
    val current = loaded(table)
    current.currentSnapshot().allManifests(current.io()).size()
  }

  /** Appends `commits` times three rows, numbered on from `first`. */
  private def appendThrees(table: Table, first: Long, commits: Int): Unit =
    (0 until commits).foreach { commit =>
      val start = first + commit * 3L
      append(table, Seq(start, start + 1, start + 2))
    }

  "IcebergTidy.tidy" should "merge a table's small files and keep its rows in order, while it is written and at its end" in {
    val table = newTable()
    appendThrees(table, first = 1L, commits = 60)
    val appended = dataFiles(table).map(_.location())
    val beforeTidy = loaded(table)

    IcebergTidy.tidy(loaded(table), atEnd = false)

    val merged = dataFiles(table).map(_.location())
    merged should have size 1
    merged.head should include("/merged_")
    readSeqs(table) shouldBe (1L to 180L)
    // Every snapshot is younger than a minute, so none is expired: the 60 appends, the merge
    // and the manifest rewrite. A read that planned before the tidy still finds its files.
    snapshotCount(table) shouldBe 62
    IcebergReader.read(beforeTidy, Seq("seq"))(_.map(seqOf).toList) shouldBe (1L to 180L)

    appendThrees(table, first = 181L, commits = 5)
    readSeqs(table) shouldBe (1L to 195L)
    val beforeEnd = dataFiles(table).map(_.location())
    beforeEnd should have size 6

    IcebergTidy.tidy(loaded(table), atEnd = true)

    val atEnd = dataFiles(table)
    atEnd.map(_.recordCount()) shouldBe List(195L)
    manifestCount(table) shouldBe 1
    snapshotCount(table) shouldBe 1
    readSeqs(table) shouldBe (1L to 195L)
    // Every file the tidies replaced is gone from the table's location.
    (appended ++ beforeEnd).foreach { location =>
      withClue(s"$location: ")(exists(table, location) shouldBe false)
    }
    exists(table, atEnd.head.location()) shouldBe true
  }

  it should "leave a table as its writer left it while the JVM exits" in {
    val table = newTable()
    (1 to 5).foreach(i => append(table, Seq(i.toLong)))
    val files = dataFileNames(table)
    val snapshots = snapshotCount(table)

    IcebergTidy.tidy(table, atEnd = true, exiting = () => true)

    dataFileNames(table) shouldBe files
    snapshotCount(table) shouldBe snapshots
    readSeqs(table) shouldBe (1L to 5L)
  }

  it should "leave the table's properties as they were" in {
    val table = newTable()
    val label = Map("spec.state" -> "COMPLETED", "spec.reason" -> "")
    append(table, Seq(1L), label)
    append(table, Seq(2L))
    val before = loaded(table).properties()

    IcebergTidy.tidy(loaded(table), atEnd = false)
    loaded(table).properties() shouldBe before

    IcebergTidy.tidy(loaded(table), atEnd = true)
    loaded(table).properties() shouldBe before
    label.foreach { case (key, value) => before.get(key) shouldBe value }
  }

  it should "change nothing in a table that is tidy" in {
    val table = newTable()
    append(table, Seq(1L))
    append(table, Seq(2L))
    IcebergTidy.tidy(loaded(table), atEnd = true)
    val file = dataFiles(table).map(_.location())
    val snapshot = loaded(table).currentSnapshot().snapshotId()

    IcebergTidy.tidy(loaded(table), atEnd = true)
    IcebergTidy.tidy(loaded(table), atEnd = false)

    dataFiles(table).map(_.location()) shouldBe file
    loaded(table).currentSnapshot().snapshotId() shouldBe snapshot
    readSeqs(table) shouldBe List(1L, 2L)
  }

  it should "do nothing to a table nothing was appended to" in {
    val table = newTable()
    val commitsBefore = commitCount(table)

    IcebergTidy.tidy(loaded(table), atEnd = false)
    IcebergTidy.tidy(loaded(table), atEnd = true)

    commitCount(table) shouldBe commitsBefore
    snapshotCount(table) shouldBe 0
  }

  it should "go on merging after the table's older snapshots were expired" in {
    val table = newTable()
    append(table, Seq(1L))
    append(table, Seq(2L))
    IcebergTidy.tidy(loaded(table), atEnd = true)
    append(table, Seq(3L))
    append(table, Seq(4L))

    IcebergTidy.tidy(loaded(table), atEnd = true)

    dataFiles(table).map(_.recordCount()) shouldBe List(4L)
    snapshotCount(table) shouldBe 1
    readSeqs(table) shouldBe List(1L, 2L, 3L, 4L)
  }

  "IcebergTidy.mergeSmallFiles" should "leave a file that reached the target size, and every file before it" in {
    val table = newTable()
    append(table, Seq(1L))
    append(table, 2L to 2001L)
    append(table, Seq(2002L))
    append(table, Seq(2003L))
    val before = dataFiles(table)
    val large = before(1)
    // The target is the large file's own size: a file that reached it is not small.
    val targetBytes = large.fileSizeInBytes()
    before.filterNot(_ == large).foreach(_.fileSizeInBytes() should be < targetBytes)

    IcebergTidy.mergeSmallFiles(loaded(table), targetBytes) shouldBe 2

    val after = dataFiles(table)
    after.map(_.recordCount()) shouldBe List(1L, 2000L, 2L)
    // The small file before the large one is not rewritten, nor is the large one.
    after.take(2).map(_.location()) shouldBe before.take(2).map(_.location())
    readSeqs(table) shouldBe (1L to 2003L)
  }

  it should "merge nothing when fewer than two files are small" in {
    val table = newTable()
    IcebergTidy.mergeSmallFiles(loaded(table), IcebergTidy.TargetFileBytes) shouldBe 0

    append(table, Seq(1L, 2L))
    IcebergTidy.mergeSmallFiles(loaded(table), IcebergTidy.TargetFileBytes) shouldBe 0

    append(table, Seq(3L))
    // No file is smaller than a target of one byte.
    IcebergTidy.mergeSmallFiles(loaded(table), targetBytes = 1L) shouldBe 0
    snapshotCount(table) shouldBe 2
    readSeqs(table) shouldBe List(1L, 2L, 3L)
  }

  it should "keep the rows in order when an append lands while it merges" in {
    val table = newTable()
    (1L to 3L).foreach(seq => append(table, Seq(seq)))

    // Another client's commit lands after the merge planned its files and before it commits.
    IcebergTidy.mergeSmallFiles(
      loaded(table),
      IcebergTidy.TargetFileBytes,
      beforeCommit = () => append(loaded(table), Seq(4L))
    ) shouldBe 3

    dataFiles(table).map(_.recordCount()) shouldBe List(3L, 1L)
    readSeqs(table) shouldBe List(1L, 2L, 3L, 4L)
  }

  it should "leave no merged file behind when the catalog refuses the merge" in {
    val table = newTable()
    (1L to 3L).foreach(seq => append(table, Seq(seq)))
    val before = dataFiles(table).map(_.location())
    val refusing = answeringCommits(table) { _ =>
      throw new ServiceUnavailableException("the catalog is overloaded")
    }

    (1 to 2).foreach { _ =>
      a[ServiceUnavailableException] should be thrownBy
        IcebergTidy.mergeSmallFiles(refusing, IcebergTidy.TargetFileBytes)
    }

    filesWritten(table, "merged") shouldBe empty
    dataFiles(table).map(_.location()) shouldBe before
    readSeqs(table) shouldBe List(1L, 2L, 3L)
  }

  it should "keep the merged file when the merge's outcome is unknown" in {
    val table = newTable()
    (1L to 3L).foreach(seq => append(table, Seq(seq)))
    val answerLost = answeringCommits(table) { commit =>
      commit()
      throw new CommitStateUnknownException(new RuntimeException("502 Bad Gateway"))
    }

    a[CommitStateUnknownException] should be thrownBy
      IcebergTidy.mergeSmallFiles(answerLost, IcebergTidy.TargetFileBytes)

    // The merge landed: the table reads the merged file.
    filesWritten(table, "merged") should have size 1
    filesWritten(table, "merged") shouldBe dataFileNames(table)
    readSeqs(table) shouldBe List(1L, 2L, 3L)
  }

  "IcebergTidy.expire" should "keep the newest snapshots, however old, and every snapshot that is not old enough" in {
    val table = newTable()
    (1L to 8L).foreach(seq => append(table, Seq(seq)))

    // No snapshot is older than the start of time.
    IcebergTidy.expire(loaded(table), retainLast = 1, olderThanMs = 0L)
    snapshotCount(table) shouldBe 8

    IcebergTidy.expire(loaded(table), retainLast = 5, olderThanMs = Long.MaxValue)
    snapshotCount(table) shouldBe 5
    // Expiring snapshots drops history, not rows: the current snapshot holds them all.
    readSeqs(table) shouldBe (1L to 8L)
  }

  "IcebergTidy.rewriteManifests" should "leave one manifest" in {
    val table = newTable()
    (1L to 4L).foreach(seq => append(table, Seq(seq)))
    manifestCount(table) shouldBe 4

    IcebergTidy.rewriteManifests(loaded(table))

    manifestCount(table) shouldBe 1
    readSeqs(table) shouldBe List(1L, 2L, 3L, 4L)
  }
}
