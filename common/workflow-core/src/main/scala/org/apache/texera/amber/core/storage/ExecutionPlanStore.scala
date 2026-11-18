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

package org.apache.texera.amber.core.storage

import org.apache.iceberg.Table
import org.apache.iceberg.exceptions.{CommitFailedException, NoSuchTableException}
import org.apache.iceberg.expressions.Expressions
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.result.ResultSchema.executionPlanSchema
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.util.IcebergUtil
import org.apache.texera.common.config.StorageConfig

import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Locale
import scala.annotation.tailrec
import scala.jdk.CollectionConverters._
import scala.util.{Try, Using}

/**
  * One row of an execution's plan table, without what its body was compiled from: the plan row,
  * written when the execution is created (entry id "plan"), or the row of one change to a paused
  * operator (entry id "update-<id>").
  *
  * `body` is the engine's input, a stored plan or a stored update. Who created the execution
  * and the computing unit it was created for are columns, not fields of the plan: they are what
  * the unit's web layer checks, and a plan names neither a user nor a unit. Nothing here says
  * where to reach that user: an address is no part of what a unit reads.
  */
final case class PlanRecord(
    entryId: String,
    body: String,
    createdBy: Int,
    computingUnitId: Int
) {
  Seq("entryId" -> entryId, "body" -> body).foreach {
    case (name, value) => require(value != null, s"a plan record needs its $name")
  }

  /** Without the body, which holds the credentials and links the plan's operators are given. */
  override def toString: String =
    s"PlanRecord($entryId, createdBy=$createdBy, computingUnitId=$computingUnitId)"
}

/** The execution's plan table does not exist, or it holds no plan row. */
final class NoStoredPlanException(val uri: URI) extends RuntimeException(s"no stored plan at $uri")

/** The execution's plan table holds no update with this id. */
final class NoSuchUpdateException(val uri: URI, val updateId: String)
    extends RuntimeException(s"no update $updateId in the stored plan at $uri")

/** The execution's plan table already carries the tag that marks it started. */
final class ExecutionAlreadyStartedException(val executionId: ExecutionIdentity)
    extends RuntimeException(s"execution ${executionId.id} was already started")

/**
  * A row's body is larger than the store keeps ([[ExecutionPlanStore.MaxBodyBytes]]). Its message
  * is for the user whose plan or change it is, the size rounded up so that it reads as more
  * than the limit.
  *
  * @param what  what the body is: "plan" or "change"
  * @param bytes the body's size, in bytes of UTF-8
  */
final class PlanTooLargeException(what: String, val bytes: Int)
    extends RuntimeException(
      String.format(
        Locale.ROOT,
        "The %s is %.1f MiB, and a stored %s may be at most %d MiB.",
        what,
        Double.box(math.ceil(bytes * 10.0 / (1024 * 1024)) / 10),
        what,
        Int.box(ExecutionPlanStore.MaxBodyBytes / (1024 * 1024))
      )
    )

/**
  * Keeps each execution's plan in the lake: one Iceberg table per execution, in the warehouse the
  * execution writes into, at the URI [[planUri]] names (namespace
  * `storage.iceberg.table.plan-namespace`, table `wid_<wid>_eid_<eid>_plan`).
  *
  * The table holds the plan row and the rows of the changes to its paused operators (see
  * [[PlanRecord]]), and the execution's start claim: the tag `started` on the snapshot that was
  * current when the execution started. Every catalog refuses a second ref of one name, so an
  * execution starts at most once, whoever asks and from wherever.
  *
  * Beside its record, a row keeps the JSON of what its body was compiled from, as the user sent
  * it (`logical`): on the plan row, the logical plan, or the part of it up to the one operator the
  * execution runs to; on an update row, the operator as changed. It is written so that it parses
  * back with its loop-variable references, and holds nothing a compile found for an operator:
  * the links an executor reads files through are in the body alone. It is the execution's
  * provenance, and, on the plan row, what the Dashboard compiles a change to a paused operator
  * against; a computing unit has no use for it, and does not read it.
  *
  * Every method takes only a URI [[planUri]] could have built, and refuses any other. A table
  * that is not there is a [[NoStoredPlanException]]; any other failure of the catalog is thrown
  * as it is, so a catalog that cannot answer is never taken for a missing plan.
  */
object ExecutionPlanStore {

  val PlanEntryId = "plan"
  val UpdateEntryIdPrefix = "update-"
  val StartedTag = "started"

  /**
    * The most bytes of UTF-8 a row's body may be: 16 MiB. A plan holds a link to each file its
    * operators read, so it grows with the files it lists: at the default of
    * `constants.max-listed-files`, with links of 600 characters, it is about 9 MiB. The limit
    * is below the longest string a JSON reader takes (20 million characters) and the largest
    * message between the nodes of a computing unit (30 MiB), so a body that was stored can be
    * read back, and each operator of its plan handed its executor.
    */
  val MaxBodyBytes: Int = 16 * 1024 * 1024

  // An update row's entry id also names the data file the row is written to, so it stays one
  // plain file name: the prefix, then 1 to 64 letters, digits or hyphens (a UUID fits).
  private val UpdateEntryIdPattern = s"$UpdateEntryIdPrefix[A-Za-z0-9-]{1,64}".r

  // The columns of a record, which is every column but `logical`.
  private val RecordColumns = executionPlanSchema.getAttributeNames.filterNot(_ == "logical")

  /** The plan table of execution `eid` of workflow `wid`, in `warehouse` (None: the default). */
  def planUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createPlanURI(wid, eid, warehouse)

  /**
    * What `uri` decodes to, when it is a plan table's URI exactly as [[planUri]] builds one:
    * anything more (another segment, a query, a fragment) would name another table.
    */
  def planTableOf(uri: URI): Option[VFSUriComponents] =
    Option(uri)
      .flatMap(uri => Try(VFSURIFactory.decodeURI(uri)).toOption)
      .filter { location =>
        location.resourceType == VFSResourceType.PLAN &&
        Try(planUri(location.workflowId, location.executionId, location.warehouse)).toOption
          .contains(uri)
      }

  /**
    * Writes the plan row as a new table. A table already at this URI can only be stale, since an
    * execution id is written once, so it is replaced, with its rows and its tag.
    *
    * @param logical the logical plan `record`'s body was compiled from
    * @throws PlanTooLargeException if the body is more than [[MaxBodyBytes]]; nothing is written.
    */
  def writePlan(uri: URI, record: PlanRecord, logical: String): Unit = {
    requirePlanUri(uri)
    require(
      record.entryId == PlanEntryId,
      s"a plan row has entry id '$PlanEntryId', not '${record.entryId}'"
    )
    requireLogical(logical)
    requireBodyFits("plan", record)
    val document = DocumentFactory
      .createDocument(uri, executionPlanSchema)
      .asInstanceOf[VirtualDocument[Tuple]]
    writeRow(document, record, logical)
  }

  /**
    * The plan row.
    *
    * @throws NoStoredPlanException if the table does not exist or holds no plan row.
    */
  def readPlan(uri: URI): PlanRecord = {
    requirePlanUri(uri)
    rowsWithEntryId(loadPlanTable(uri), PlanEntryId, RecordColumns).headOption
      .map(recordOf)
      .getOrElse(throw new NoStoredPlanException(uri))
  }

  /**
    * The plan row, and the logical plan its body was compiled from.
    *
    * @throws NoStoredPlanException if the table does not exist or holds no plan row.
    */
  def readPlanWithLogical(uri: URI): (PlanRecord, String) = {
    requirePlanUri(uri)
    rowsWithEntryId(
      loadPlanTable(uri),
      PlanEntryId,
      executionPlanSchema.getAttributeNames
    ).headOption
      .map(row => (recordOf(row), required[String](row, "logical")))
      .getOrElse(throw new NoStoredPlanException(uri))
  }

  /**
    * Adds the row of one change to a paused operator.
    *
    * The row's data file is named after its entry id, so an entry id the table already holds is
    * refused: writing it again would replace the earlier row's file. The check reads the table
    * before the write, so it cannot stop two appends of one entry id that run at once; entry ids
    * are unique because the caller makes each from a UUID.
    *
    * @param logical the operator as changed, which `record`'s body was compiled from
    * @throws NoStoredPlanException if the table does not exist.
    * @throws PlanTooLargeException if the body is more than [[MaxBodyBytes]]; nothing is written.
    */
  def appendUpdate(uri: URI, record: PlanRecord, logical: String): Unit = {
    requirePlanUri(uri)
    require(
      UpdateEntryIdPattern.matches(record.entryId),
      s"an update row has an entry id of '$UpdateEntryIdPrefix' followed by 1 to 64 letters, " +
        s"digits or hyphens, not '${record.entryId}'"
    )
    requireLogical(logical)
    requireBodyFits("change", record)
    val table = loadPlanTable(uri)
    require(
      rowsWithEntryId(table, record.entryId, Seq("entryId")).isEmpty,
      s"the stored plan at $uri already holds ${record.entryId}"
    )
    val document = DocumentFactory.openDocument(uri)._1.asInstanceOf[VirtualDocument[Tuple]]
    writeRow(document, record, logical)
  }

  /**
    * The update row `updateId`.
    *
    * @throws NoSuchUpdateException if the table holds no update row with that entry id.
    * @throws NoStoredPlanException if the table does not exist.
    */
  def readUpdate(uri: URI, updateId: String): PlanRecord = {
    requirePlanUri(uri)
    val table = loadPlanTable(uri)
    // The plan row is no update, whatever is asked for by its entry id.
    Option
      .when(UpdateEntryIdPattern.matches(updateId))(updateId)
      .flatMap(rowsWithEntryId(table, _, RecordColumns).headOption)
      .map(recordOf)
      .getOrElse(throw new NoSuchUpdateException(uri, updateId))
  }

  /**
    * Claims the execution for its one start by tagging the table's current snapshot `started`.
    *
    * A claim that loses its commit to another claim is refused. One that loses it to a commit
    * that is not a claim, such as an update row, is tried again on the table as it then is, up to
    * the configured commit retries (`storage.iceberg.table.commit.retry.num-retries`); after the
    * last, that commit's `CommitFailedException` is thrown.
    *
    * @throws ExecutionAlreadyStartedException if the table already carries the tag, including
    *                                          when another claim added it while this one ran.
    * @throws NoStoredPlanException if the table does not exist or has no snapshot.
    */
  def claimStart(uri: URI): Unit = claimStart(uri, beforeCommit = () => ())

  /**
    * [[claimStart]], running `beforeCommit` in every try after the tag is made and before it is
    * committed, the window in which another commit can land first. Tests land one there.
    */
  private[storage] def claimStart(uri: URI, beforeCommit: () => Unit): Unit = {
    val executionId = requirePlanUri(uri).executionId

    @tailrec
    def claim(retriesLeft: Int): Unit = {
      val table = loadPlanTable(uri)
      val snapshot =
        Option(table.currentSnapshot()).getOrElse(throw new NoStoredPlanException(uri))
      val lostToAnotherCommit =
        try {
          val tagging = table.manageSnapshots().createTag(StartedTag, snapshot.snapshotId())
          beforeCommit()
          tagging.commit()
          false
        } catch {
          // createTag refuses a ref the table already has. A claim that lands after that check
          // fails this commit instead (the REST catalog's assert-ref-snapshot-id requirement, the
          // JDBC catalog's metadata-pointer swap), and the reloaded table carries the tag. A
          // commit that failed with no tag there lost to another kind of commit, such as an update
          // row. Iceberg's own retry re-applies the tag on the table state it was made on and
          // fails again, so the claim starts over from a fresh load.
          case e @ (_: IllegalArgumentException | _: CommitFailedException |
              _: NoSuchTableException) =>
            if (hasStartedTag(loadPlanTable(uri))) {
              throw new ExecutionAlreadyStartedException(executionId)
            }
            e match {
              case _: CommitFailedException if retriesLeft > 0 => true
              case _                                           => throw e
            }
        }
      if (lostToAnotherCommit) claim(retriesLeft - 1)
    }

    claim(retriesLeft = StorageConfig.icebergTableCommitNumRetries)
  }

  /**
    * Whether the execution was claimed for its start.
    *
    * @throws NoStoredPlanException if the table does not exist.
    */
  def isStarted(uri: URI): Boolean = {
    requirePlanUri(uri)
    hasStartedTag(loadPlanTable(uri))
  }

  /** Drops the table with its rows and its tag; nothing happens when there is no table. */
  def drop(uri: URI): Unit = {
    requirePlanUri(uri)
    DocumentFactory.dropTable(uri)
  }

  private def requireLogical(logical: String): Unit =
    require(logical != null, "a plan table row needs what its body was compiled from")

  private def requireBodyFits(what: String, record: PlanRecord): Unit = {
    val bytes = record.body.getBytes(StandardCharsets.UTF_8).length
    if (bytes > MaxBodyBytes) throw new PlanTooLargeException(what, bytes)
  }

  private def requirePlanUri(uri: URI): VFSUriComponents =
    planTableOf(uri).getOrElse(
      throw new IllegalArgumentException(s"not an execution plan URI: $uri")
    )

  private def loadPlanTable(uri: URI): Table =
    DocumentFactory.icebergTableOf(uri).getOrElse(throw new NoStoredPlanException(uri))

  private def hasStartedTag(table: Table): Boolean =
    Option(table.refs().get(StartedTag)).exists(_.isTag)

  /** Reads a row of the plan table, none of whose values may be empty. */
  private def recordOf(row: Tuple): PlanRecord =
    PlanRecord(
      entryId = required[String](row, "entryId"),
      body = required[String](row, "body"),
      createdBy = required[Integer](row, "createdBy").intValue(),
      computingUnitId = required[Integer](row, "computingUnitId").intValue()
    )

  private def required[T <: AnyRef](row: Tuple, column: String): T =
    Option(row.getField[T](column)).getOrElse(
      throw new IllegalStateException(s"a plan table row has no $column")
    )

  /**
    * The rows with this entry id, as of the snapshot `table` was loaded at, with only `columns`
    * (`entryId` among them). Read from the loaded table, not through a document, whose reads
    * come back empty when the catalog fails after the load. A data file whose column bounds rule
    * the entry id out is not read, so finding an update skips the plan's body.
    */
  private def rowsWithEntryId(table: Table, entryId: String, columns: Seq[String]): List[Tuple] = {
    val projection = table.schema().select(columns.asJava)
    val schema = IcebergUtil.fromIcebergSchema(projection)
    val rows =
      Using.resource(table.newScan().filter(Expressions.equal("entryId", entryId)).planFiles()) {
        tasks =>
          tasks.asScala.toList.flatMap { task =>
            Using.resource(IcebergUtil.readDataFileAsIterator(task.file(), projection, table)) {
              records => records.asScala.map(IcebergUtil.fromRecord(_, schema)).toList
            }
          }
      }
    rows.filter(_.getField[String]("entryId") == entryId)
  }

  /** Writes `record` and `logical` as one row, to a data file named after the entry id. */
  private def writeRow(
      document: VirtualDocument[Tuple],
      record: PlanRecord,
      logical: String
  ): Unit = {
    val writer = document.writer(record.entryId)
    writer.open()
    writer.putOne(
      Tuple(
        executionPlanSchema,
        Array(
          record.entryId,
          record.body,
          logical,
          record.createdBy,
          record.computingUnitId
        )
      )
    )
    writer.close()
  }
}
