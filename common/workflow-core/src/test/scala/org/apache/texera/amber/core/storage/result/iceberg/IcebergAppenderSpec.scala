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

import org.apache.iceberg.TableProperties
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class IcebergAppenderSpec extends AnyFlatSpec with Matchers with RecordTables {

  "IcebergAppender.append" should "add the rows as one data file, in one snapshot and one commit" in {
    val table = newTable()
    val commitsBefore = commitCount(table)

    append(table, Seq(1L, 2L, 3L))

    commitCount(table) shouldBe commitsBefore + 1
    snapshotCount(table) shouldBe 1
    val files = dataFiles(table)
    files.map(_.recordCount()) shouldBe List(3L)
    files.head.location() should fullyMatch regex
      s"${java.util.regex.Pattern.quote(table.location().stripSuffix("/"))}/rows_[0-9a-f]{32}"
    readSeqs(table) shouldBe List(1L, 2L, 3L)
  }

  it should "keep every value of a record, a missing one as null" in {
    val table = newTable()
    val records = Seq(
      record(table, 1L, "Grüße 日本語 😀"),
      record(table, 2L, null),
      record(table, 3L, "x" * 100000)
    )

    IcebergAppender.append(table, records, "rows")

    IcebergReader.read(loaded(table), Seq("seq", "text"))(
      _.map(row => seqOf(row) -> row.getField("text")).toList
    ) shouldBe List(1L -> "Grüße 日本語 😀", 2L -> null, 3L -> "x" * 100000)
  }

  it should "give every data file a name of its own, also under one prefix" in {
    val table = newTable()
    append(table, Seq(1L))
    append(table, Seq(1L))

    val locations = dataFiles(table).map(_.location())
    locations.distinct should have size 2
    readSeqs(table) shouldBe List(1L, 1L)
  }

  it should "set properties in the commit that appends the rows" in {
    val table = newTable()
    append(table, Seq(1L))
    val commitsBefore = commitCount(table)

    append(table, Seq(2L, 3L), Map("spec.state" -> "RUNNING", "spec.seq" -> "3"))

    // One commit holds both: no reader can load the rows without the properties, or the
    // properties without the rows.
    commitCount(table) shouldBe commitsBefore + 1
    snapshotCount(table) shouldBe 2
    val after = loaded(table)
    after.properties().get("spec.state") shouldBe "RUNNING"
    after.properties().get("spec.seq") shouldBe "3"
    readSeqs(table) shouldBe List(1L, 2L, 3L)
  }

  it should "replace the value of a property it sets and leave the others" in {
    val table = newTable()
    append(table, Seq(1L), Map("spec.state" -> "RUNNING", "spec.reason" -> ""))

    append(table, Seq(2L), Map("spec.state" -> "PAUSED"))

    val properties = loaded(table).properties()
    properties.get("spec.state") shouldBe "PAUSED"
    properties.get("spec.reason") shouldBe ""
    // What the table was created with is still there.
    properties.containsKey(TableProperties.COMMIT_NUM_RETRIES) shouldBe true
  }

  it should "set only the properties when there are no records" in {
    val table = newTable()
    val commitsBefore = commitCount(table)

    IcebergAppender.append(table, Nil, "rows", Map("spec.beat" -> "17"))

    commitCount(table) shouldBe commitsBefore + 1
    snapshotCount(table) shouldBe 0
    dataFiles(table) shouldBe empty
    loaded(table).properties().get("spec.beat") shouldBe "17"
  }

  it should "commit nothing when there is nothing to append and nothing to set" in {
    val table = newTable()
    val commitsBefore = commitCount(table)

    IcebergAppender.append(table, Nil, "rows")

    commitCount(table) shouldBe commitsBefore
    snapshotCount(table) shouldBe 0
  }

  "IcebergAppender.setProperties" should "set the properties in a commit that adds no snapshot" in {
    val table = newTable()
    append(table, Seq(1L, 2L))
    val snapshotBefore = loaded(table).currentSnapshot().snapshotId()
    val commitsBefore = commitCount(table)

    IcebergAppender.setProperties(table, Map("spec.beat" -> "17", "spec.every" -> "30000"))

    commitCount(table) shouldBe commitsBefore + 1
    snapshotCount(table) shouldBe 1
    val after = loaded(table)
    after.currentSnapshot().snapshotId() shouldBe snapshotBefore
    after.properties().get("spec.beat") shouldBe "17"
    after.properties().get("spec.every") shouldBe "30000"
    readSeqs(table) shouldBe List(1L, 2L)
  }

  it should "commit nothing when there is nothing to set" in {
    val table = newTable()
    val commitsBefore = commitCount(table)

    IcebergAppender.setProperties(table, Map.empty)

    commitCount(table) shouldBe commitsBefore
  }
}
