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
import java.sql.Timestamp
import scala.annotation.tailrec
import scala.jdk.CollectionConverters._
import scala.util.Using

/**
  * One row of an execution's plan table: the plan row, written when the execution is created
  * (entry id and kind "plan"), or the row of one change to a paused operator (kind "update",
  * entry id "update-<id>").
  *
  * `body` is the engine's input, a stored plan or a stored update. `logical` is the JSON of what
  * `body` was compiled from, as the user sent it (on the plan row, the logical plan, or the part
  * of it up to the one operator the execution runs to), written so that it parses back with its
  * loop-variable references: the execution's provenance, and, on the plan row, what the
  * Dashboard compiles a change to a paused operator against. Who created the execution, the
  * computing unit it was created for and its email notification are columns, not fields of the
  * plan: they are what the unit's web layer checks and uses, and a plan names neither a user nor
  * a unit.
  *
  * @param createdAt    wall-clock time, like every Texera Iceberg timestamp.
  * @param notification JSON `{"email", "workflowName", "workflowUrl"}`; None sends no email.
  */
final case class PlanRecord(
    entryId: String,
    kind: String,
    formatVersion: Int,
    body: String,
    logical: String,
    createdAt: Timestamp,
    createdBy: Int,
    computingUnitId: Int,
    notification: Option[String]
) {
  Seq(
    "entryId" -> entryId,
    "kind" -> kind,
    "body" -> body,
    "logical" -> logical,
    "createdAt" -> createdAt,
    "notification" -> notification
  ).foreach { case (name, value) => require(value != null, s"a plan record needs its $name") }

  def toTuple: Tuple =
    Tuple(
      executionPlanSchema,
      Array(
        entryId,
        kind,
        formatVersion,
        body,
        logical,
        createdAt,
        createdBy,
        computingUnitId,
        notification.orNull
      )
    )
}

object PlanRecord {

  /** Reads a row of the plan table; only `notification` may be empty. */
  def fromTuple(tuple: Tuple): PlanRecord = {
    def required[T <: AnyRef](column: String): T =
      Option(tuple.getField[T](column)).getOrElse(
        throw new IllegalStateException(s"a plan table row has no $column")
      )
    PlanRecord(
      entryId = required[String]("entryId"),
      kind = required[String]("kind"),
      formatVersion = required[Integer]("formatVersion").intValue(),
      body = required[String]("body"),
      logical = required[String]("logical"),
      createdAt = required[Timestamp]("createdAt"),
      createdBy = required[Integer]("createdBy").intValue(),
      computingUnitId = required[Integer]("computingUnitId").intValue(),
      notification = Option(tuple.getField[String]("notification"))
    )
  }
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
  * Keeps each execution's plan in the lake: one Iceberg table per execution, in the warehouse the
  * execution writes into, at the URI [[planUri]] names (namespace
  * `storage.iceberg.table.plan-namespace`, table `wid_<wid>_eid_<eid>_plan`).
  *
  * The table holds the plan row and the rows of the changes to its paused operators (see
  * [[PlanRecord]]), and the execution's start claim: the tag `started` on the snapshot that was
  * current when the execution started. Every catalog refuses a second ref of one name, so an
  * execution starts at most once, whoever asks and from wherever.
  *
  * Every method takes only a URI [[planUri]] could have built, and refuses any other. A table
  * that is not there is a [[NoStoredPlanException]]; any other failure of the catalog is thrown
  * as it is, so a catalog that cannot answer is never taken for a missing plan.
  */
object ExecutionPlanStore {

  val PlanEntryId = "plan"
  val PlanKind = "plan"
  val UpdateKind = "update"
  val UpdateEntryIdPrefix = "update-"
  val StartedTag = "started"

  // An update row's entry id also names the data file the row is written to, so it stays one
  // plain file name: the prefix, then 1 to 64 letters, digits or hyphens (a UUID fits).
  private val UpdateEntryIdPattern = s"$UpdateEntryIdPrefix[A-Za-z0-9-]{1,64}".r

  /** The plan table of execution `eid` of workflow `wid`, in `warehouse` (None: the default). */
  def planUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI =
    VFSURIFactory.createPlanURI(wid, eid, warehouse)

  /**
    * Writes the plan row as a new table. A table already at this URI can only be stale, since an
    * execution id is written once, so it is replaced, with its rows and its tag.
    */
  def writePlan(uri: URI, record: PlanRecord): Unit = {
    requirePlanUri(uri)
    require(
      record.entryId == PlanEntryId && record.kind == PlanKind,
      s"a plan row has entry id and kind '$PlanEntryId', " +
        s"not '${record.entryId}' and '${record.kind}'"
    )
    val document = DocumentFactory
      .createDocument(uri, executionPlanSchema)
      .asInstanceOf[VirtualDocument[Tuple]]
    writeRow(document, PlanEntryId, record)
  }

  /**
    * The plan row.
    *
    * @throws NoStoredPlanException if the table does not exist or holds no plan row.
    */
  def readPlan(uri: URI): PlanRecord = {
    requirePlanUri(uri)
    recordsWithEntryId(loadPlanTable(uri), PlanEntryId).headOption
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
    * @throws NoStoredPlanException if the table does not exist.
    */
  def appendUpdate(uri: URI, record: PlanRecord): Unit = {
    requirePlanUri(uri)
    require(
      record.kind == UpdateKind && UpdateEntryIdPattern.matches(record.entryId),
      s"an update row has kind '$UpdateKind' and an entry id of '$UpdateEntryIdPrefix' followed " +
        s"by 1 to 64 letters, digits or hyphens, not '${record.kind}' and '${record.entryId}'"
    )
    val table = loadPlanTable(uri)
    require(
      rowsWithEntryId(table, record.entryId, Seq("entryId")).isEmpty,
      s"the stored plan at $uri already holds ${record.entryId}"
    )
    val document = DocumentFactory.openDocument(uri)._1.asInstanceOf[VirtualDocument[Tuple]]
    writeRow(document, record.entryId, record)
  }

  /**
    * The update row `updateId`.
    *
    * @throws NoSuchUpdateException if the table holds no update row with that entry id.
    * @throws NoStoredPlanException if the table does not exist.
    */
  def readUpdate(uri: URI, updateId: String): PlanRecord = {
    requirePlanUri(uri)
    recordsWithEntryId(loadPlanTable(uri), updateId)
      .find(_.kind == UpdateKind)
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

  private def requirePlanUri(uri: URI): VFSUriComponents = {
    val components = VFSURIFactory.decodeURI(uri)
    // Rebuilding the URI from what it decodes to refuses extra segments, which would address a
    // different table name in the plan namespace.
    require(
      components.resourceType == VFSResourceType.PLAN &&
        uri == VFSURIFactory.createPlanURI(
          components.workflowId,
          components.executionId,
          components.warehouse
        ),
      s"not an execution plan URI: $uri"
    )
    components
  }

  private def loadPlanTable(uri: URI): Table =
    DocumentFactory.icebergTableOf(uri).getOrElse(throw new NoStoredPlanException(uri))

  private def hasStartedTag(table: Table): Boolean =
    Option(table.refs().get(StartedTag)).exists(_.isTag)

  private def recordsWithEntryId(table: Table, entryId: String): List[PlanRecord] =
    rowsWithEntryId(table, entryId, executionPlanSchema.getAttributeNames).map(PlanRecord.fromTuple)

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

  private def writeRow(
      document: VirtualDocument[Tuple],
      writerIdentifier: String,
      record: PlanRecord
  ): Unit = {
    val writer = document.writer(writerIdentifier)
    writer.open()
    writer.putOne(record.toTuple)
    writer.close()
  }
}
