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

import org.apache.hc.client5.http.ConnectTimeoutException
import org.apache.iceberg.TableProperties
import org.apache.iceberg.exceptions.{
  CommitFailedException,
  CommitStateUnknownException,
  RESTException,
  ServiceUnavailableException
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.{ConnectException, SocketTimeoutException}

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

  // ---------------------------------------------------------------------------
  // an append that fails
  // ---------------------------------------------------------------------------

  it should "leave no data file behind when the catalog refuses the commit, however often it is tried" in {
    val table = newTable()
    append(table, Seq(1L))
    // 503, as a catalog that is overloaded answers: the commit was not made.
    val refusing = answeringCommits(table) { _ =>
      throw new ServiceUnavailableException("the catalog is overloaded")
    }

    (1 to 3).foreach { _ =>
      the[ServiceUnavailableException] thrownBy append(refusing, Seq(2L, 3L)) should have message
        "the catalog is overloaded"
    }

    // Only the file of the append that was made: a try that failed left none.
    filesWritten(table, "rows") shouldBe dataFileNames(table)
    readSeqs(table) shouldBe List(1L)
    snapshotCount(table) shouldBe 1

    // The append that gets through at last writes the one file the table reads.
    append(table, Seq(2L, 3L))
    filesWritten(table, "rows") shouldBe dataFileNames(table)
    dataFileNames(table) should have size 2
    readSeqs(table) shouldBe List(1L, 2L, 3L)
  }

  it should "leave no data file behind when another commit got there first" in {
    val table = newTable()
    // A conflict is tried again as often as the table says: not at all here.
    table.updateProperties().set(TableProperties.COMMIT_NUM_RETRIES, "0").commit()
    val conflicting = answeringCommits(table) { _ =>
      throw new CommitFailedException("the table has changed")
    }

    a[CommitFailedException] should be thrownBy append(conflicting, Seq(1L))

    filesWritten(table, "rows") shouldBe empty
    readSeqs(table) shouldBe empty
  }

  it should "leave no data file behind when the catalog could not be connected to" in {
    // The request was never sent, whether the connection was refused or timed out.
    Seq(
      new ConnectException("Connection refused"),
      new ConnectTimeoutException("Connect to http://localhost:8181 timed out")
    ).foreach { notConnected =>
      val table = newTable()
      val unreachable = answeringCommits(table) { _ =>
        throw new RESTException(notConnected, "Error occurred while processing POST request")
      }

      a[RESTException] should be thrownBy append(unreachable, Seq(1L))

      withClue(s"after $notConnected: ")(filesWritten(table, "rows") shouldBe empty)
    }
  }

  it should "keep the data file when the commit's outcome is unknown, since the commit may have landed" in {
    val table = newTable()
    // The commit is made, and its answer is lost on the way back.
    val answerLost = answeringCommits(table) { commit =>
      commit()
      throw new CommitStateUnknownException(new RuntimeException("502 Bad Gateway"))
    }

    a[CommitStateUnknownException] should be thrownBy append(answerLost, Seq(1L, 2L))

    // The table reads the file: deleting it would have broken every read of the table.
    dataFileNames(table) should have size 1
    filesWritten(table, "rows") shouldBe dataFileNames(table)
    readSeqs(table) shouldBe List(1L, 2L)
  }

  it should "keep the data file when the catalog's answer never came" in {
    val table = newTable()
    // The request was sent, and the client stopped waiting for its answer: the REST client
    // reports that as any other failure of the connection.
    val timingOut = answeringCommits(table) { commit =>
      commit()
      throw new RESTException(
        new SocketTimeoutException("Read timed out"),
        "Error occurred while processing POST request"
      )
    }

    a[RESTException] should be thrownBy append(timingOut, Seq(1L, 2L))

    filesWritten(table, "rows") shouldBe dataFileNames(table)
    readSeqs(table) shouldBe List(1L, 2L)
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
