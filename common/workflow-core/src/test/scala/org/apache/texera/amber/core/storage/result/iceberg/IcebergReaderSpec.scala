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

import org.apache.iceberg.exceptions.NotFoundException
import org.apache.iceberg.expressions.Expressions
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import software.amazon.awssdk.services.s3.model.NoSuchKeyException

class IcebergReaderSpec extends AnyFlatSpec with Matchers with RecordTables {

  "IcebergReader.read" should "hand over the rows in the order they were appended" in {
    val table = newTable()
    append(table, Seq(1L, 2L, 3L))
    append(table, Seq(4L))
    append(table, Seq(5L, 6L))

    IcebergReader.read(loaded(table), Seq("seq", "text"))(
      _.map(row => seqOf(row) -> row.getField("text")).toList
    ) shouldBe (1L to 6L).map(seq => seq -> textOf(seq))
  }

  it should "read only the columns it is asked for" in {
    val table = newTable()
    append(table, Seq(1L, 2L))

    val rows = IcebergReader.read(loaded(table), Seq("text"))(_.toList)

    rows.map(_.getField("text")) shouldBe List(textOf(1L), textOf(2L))
    rows.foreach(_.getField("seq") shouldBe null)
  }

  it should "skip the data files that cannot hold a matching row, and read the others whole" in {
    val table = newTable()
    append(table, Seq(1L, 2L))
    append(table, Seq(3L, 4L))
    append(table, Seq(5L, 6L))

    // The first file's rows end at 2, so it is not read. The second holds 4 and comes with 3
    // as well: filtering rows is left to the caller.
    IcebergReader.read(
      loaded(table),
      Seq("seq"),
      Expressions.greaterThan[java.lang.Long]("seq", 3L)
    )(
      _.map(seqOf).toList
    ) shouldBe List(3L, 4L, 5L, 6L)
  }

  it should "hand over nothing for a table nothing was appended to" in {
    IcebergReader.read(newTable(), Seq("seq"))(_.toList) shouldBe empty
  }

  it should "start over when a tidy deleted the files it planned" in {
    val table = newTable()
    (1L to 6L).foreach(seq => append(table, Seq(seq)))
    val planned = dataFiles(table).map(_.location())
    var plans = 0

    val seqs = IcebergReader.read(
      loaded(table),
      Seq("seq"),
      afterPlan = () => {
        plans += 1
        // The tidy at the writer's end keeps one snapshot, so the six planned files go.
        if (plans == 1) IcebergTidy.tidy(loaded(table), atEnd = true)
      }
    )(_.map(seqOf).toList)

    seqs shouldBe (1L to 6L)
    plans shouldBe 2
    planned.foreach(location => withClue(s"$location: ")(exists(table, location) shouldBe false))
  }

  it should "start over when a tidy expired the snapshot its table was loaded at" in {
    val table = newTable()
    (1L to 6L).foreach(seq => append(table, Seq(seq)))
    val loadedBefore = loaded(table)

    // With the snapshot go its manifests, which the read needs before it can plan a file.
    IcebergTidy.tidy(loaded(table), atEnd = true)

    IcebergReader.read(loadedBefore, Seq("seq"))(_.map(seqOf).toList) shouldBe (1L to 6L)
  }

  it should "start over when the object store itself says that a file is gone" in {
    val table = newTable()
    append(table, Seq(1L, 2L))
    var plans = 0

    // S3FileIO lets the store's NoSuchKeyException through where it asks for a file's length,
    // as it does for the manifest list of an expired snapshot. No local file system throws it.
    IcebergReader.read(
      loaded(table),
      Seq("seq"),
      afterPlan = () => {
        plans += 1
        if (plans == 1) throw NoSuchKeyException.builder().message("no such key").build()
      }
    )(_.map(seqOf).toList) shouldBe List(1L, 2L)
    plans shouldBe 2
  }

  it should "drop what it collected before it started over" in {
    val table = newTable()
    (1L to 6L).foreach(seq => append(table, Seq(seq)))
    var collects = 0

    val seqs = IcebergReader.read(loaded(table), Seq("seq")) { rows =>
      collects += 1
      val first = seqOf(rows.next())
      // The files go while the first try is in the middle of them.
      if (collects == 1) IcebergTidy.tidy(loaded(table), atEnd = true)
      first +: rows.map(seqOf).toList
    }

    seqs shouldBe (1L to 6L)
    collects shouldBe 2
  }

  it should "fail when a planned file is gone in the second try as well" in {
    val table = newTable()
    append(table, Seq(1L))
    append(table, Seq(2L))
    var plans = 0

    a[NotFoundException] should be thrownBy IcebergReader.read(
      loaded(table),
      Seq("seq"),
      afterPlan = () => {
        plans += 1
        // A file the current snapshot still lists is deleted from under the table.
        if (plans == 1) table.io().deleteFile(dataFiles(table).head.location())
      }
    )(_.map(seqOf).toList)
    plans shouldBe 2
  }
}
