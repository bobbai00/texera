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

package org.apache.texera.amber.core.storage.result.iceberg.bench

import org.apache.iceberg.catalog.{Catalog, Namespace, SupportsNamespaces, TableIdentifier}
import org.apache.iceberg.data.Record
import org.apache.iceberg.data.parquet.GenericParquetWriter
import org.apache.iceberg.io.DataWriter
import org.apache.iceberg.parquet.Parquet
import org.apache.iceberg.{
  DataFile,
  FileScanTask,
  HasTableOperations,
  IcebergBuild,
  PartitionSpec,
  Table,
  TableMetadataParser,
  Schema => IcebergSchema
}
import org.apache.parquet.schema.MessageType
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.storage.result.ResultSchema
import org.apache.texera.amber.core.storage.result.iceberg.IcebergDocument
import org.apache.texera.amber.core.storage.{DocumentFactory, IcebergCatalogInstance, VFSURIFactory}
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.util.IcebergUtil
import org.apache.texera.common.config.StorageConfig

import java.io.{File, FileWriter, PrintWriter}
import java.sql.Timestamp
import java.time.{LocalDateTime, ZoneId}
import java.util.UUID
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters._
import scala.util.{Try, Using}

/**
  * Step 0 proof, not a test: does committing runtime statistics on a timer, and tidying the
  * table now and then, keep a day-long run cheap to write and fast to read, with the JVM
  * Iceberg client and Texera's own code paths?
  *
  * Texera code used as-is: the REST catalog from [[IcebergCatalogInstance]] (wrapped only to
  * time `loadTable`), [[DocumentFactory.createDocument]] / [[DocumentFactory.openDocument]] on
  * a runtime-statistics VFS URI, [[IcebergUtil.createTable]], the `IcebergTableWriter` behind
  * `VirtualDocument.writer` (one writer per tick, closed at the end of the tick, so every tick
  * is exactly one flush: loadTable + one Parquet file + one append commit), and the
  * [[IcebergDocument]] reader. Tidying uses core Iceberg APIs only (no Spark): rewrite all live
  * data files into one, rewrite manifests, expire snapshots keeping the last few.
  *
  * Run it by hand against a lake; proofs/step0/iceberg-commits/run.sh brings one up and calls
  * {{{
  *   sbt "WorkflowCore/Test/runMain org.apache.texera.amber.core.storage.result.iceberg.bench.IcebergCommitBench --out <dir>"
  * }}}
  * The lake is chosen by storage.conf's environment overrides (STORAGE_ICEBERG_CATALOG_*).
  */
object IcebergCommitBench {

  private final case class Config(
      out: File,
      commits: Int,
      operators: Int,
      checkpointEvery: Int,
      tidyEvery: Int,
      keepSnapshots: Int,
      finalKeepSnapshots: Int,
      tickSeconds: Int,
      warmupCommits: Int,
      dayStart: String,
      scenarios: Seq[String]
  )

  private def parseArgs(args: Array[String]): Config = {
    val kv = args
      .grouped(2)
      .collect { case Array(k, v) if k.startsWith("--") => k.drop(2) -> v }
      .toMap
    def int(key: String, default: Int): Int = kv.get(key).map(_.toInt).getOrElse(default)
    Config(
      out = new File(kv.getOrElse("out", "iceberg-commit-bench-out")),
      commits = int("commits", 2880),
      operators = int("operators", 10),
      checkpointEvery = int("checkpoint-every", 250),
      tidyEvery = int("tidy-every", 200),
      keepSnapshots = int("keep-snapshots", 5),
      // A finished run needs no history: keeping one snapshot frees every replaced file.
      finalKeepSnapshots = int("final-keep-snapshots", 1),
      tickSeconds = int("tick-seconds", 30),
      warmupCommits = int("warmup-commits", 50),
      // A day with no daylight-saving change (see dstReport for why that matters).
      dayStart = kv.getOrElse("day-start", "2026-11-10T00:00:00"),
      // "tidy" tidies every tidy-every commits, "tidy-N" every N, "no-tidy" only at the end.
      scenarios = kv
        .get("scenarios")
        .map(_.split(',').toSeq)
        .getOrElse(Seq("tidy", "tidy-50", "no-tidy"))
    )
  }

  // ---------------------------------------------------------------------------------------
  // Catalog: Texera's REST catalog, wrapped to time loadTable.
  // ---------------------------------------------------------------------------------------

  /**
    * Delegates everything to Texera's catalog and times `loadTable`, so the catalog round
    * trip inside a tick (IcebergTableWriter resolves the table on every flush) can be told
    * apart from writing the file and committing it.
    */
  private final class TimingCatalog(delegate: Catalog with SupportsNamespaces)
      extends Catalog
      with SupportsNamespaces {
    var loadTableNanos = 0L
    override def name(): String = delegate.name()
    override def loadTable(identifier: TableIdentifier): Table = {
      val start = System.nanoTime()
      try delegate.loadTable(identifier)
      finally loadTableNanos += System.nanoTime() - start
    }
    override def tableExists(identifier: TableIdentifier): Boolean =
      delegate.tableExists(identifier)
    override def listTables(namespace: Namespace): java.util.List[TableIdentifier] =
      delegate.listTables(namespace)
    override def dropTable(identifier: TableIdentifier): Boolean = delegate.dropTable(identifier)
    override def dropTable(identifier: TableIdentifier, purge: Boolean): Boolean =
      delegate.dropTable(identifier, purge)
    override def renameTable(from: TableIdentifier, to: TableIdentifier): Unit =
      delegate.renameTable(from, to)
    override def buildTable(
        identifier: TableIdentifier,
        schema: IcebergSchema
    ): Catalog.TableBuilder = delegate.buildTable(identifier, schema)
    override def createTable(
        identifier: TableIdentifier,
        schema: IcebergSchema,
        spec: PartitionSpec,
        properties: java.util.Map[String, String]
    ): Table = delegate.createTable(identifier, schema, spec, properties)
    override def createNamespace(
        namespace: Namespace,
        metadata: java.util.Map[String, String]
    ): Unit = delegate.createNamespace(namespace, metadata)
    override def listNamespaces(namespace: Namespace): java.util.List[Namespace] =
      delegate.listNamespaces(namespace)
    override def loadNamespaceMetadata(namespace: Namespace): java.util.Map[String, String] =
      delegate.loadNamespaceMetadata(namespace)
    override def dropNamespace(namespace: Namespace): Boolean = delegate.dropNamespace(namespace)
    override def setProperties(
        namespace: Namespace,
        properties: java.util.Map[String, String]
    ): Boolean = delegate.setProperties(namespace, properties)
    override def removeProperties(
        namespace: Namespace,
        properties: java.util.Set[String]
    ): Boolean = delegate.removeProperties(namespace, properties)
    override def namespaceExists(namespace: Namespace): Boolean =
      delegate.namespaceExists(namespace)
  }

  private lazy val catalog: TimingCatalog = {
    val texeraCatalog = IcebergCatalogInstance.getInstance() match {
      case c: Catalog with SupportsNamespaces => c
      case other =>
        throw new IllegalStateException(s"${other.getClass.getName} does not support namespaces")
    }
    val timing = new TimingCatalog(texeraCatalog)
    // Every Texera path (DocumentFactory, IcebergDocument, IcebergTableWriter) resolves the
    // default warehouse's catalog through IcebergCatalogInstance, so they all go through this.
    IcebergCatalogInstance.replaceInstance(timing)
    timing
  }

  // ---------------------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------------------

  private var console: PrintWriter = _

  private def say(line: String): Unit = {
    println(line)
    console.println(line)
    console.flush()
  }

  private final class Csv(file: File, header: String) {
    private val writer = new PrintWriter(new FileWriter(file))
    writer.println(header)
    writer.flush()
    def row(values: Any*): Unit = {
      writer.println(values.map(cell).mkString(","))
      writer.flush()
    }
    def close(): Unit = writer.close()
  }

  private implicit val csvReleasable: Using.Releasable[Csv] = _.close()

  private def cell(value: Any): String =
    value match {
      case d: Double => if (d.isNaN) "" else f"$d%.2f"
      case s: String => if (s.contains(",")) "\"" + s + "\"" else s
      case other     => other.toString
    }

  private def ms(nanos: Long): Double = nanos / 1e6

  private def timedMs[T](body: => T): (Double, T) = {
    val start = System.nanoTime()
    val result = body
    (ms(System.nanoTime() - start), result)
  }

  private def percentile(values: Seq[Double], p: Double): Double =
    if (values.isEmpty) Double.NaN
    else {
      val sorted = values.sorted
      sorted(math.min(sorted.size - 1, math.max(0, math.ceil(p / 100 * sorted.size).toInt - 1)))
    }

  private def median(values: Seq[Double]): Double = percentile(values, 50)

  private def f1(value: Double): String = f"$value%.1f"

  private def kb(bytes: Long): String = f"${bytes / 1024.0}%.0f"

  // ---------------------------------------------------------------------------------------
  // Tables under test
  // ---------------------------------------------------------------------------------------

  /** One row per state change of the run; the newest row is the run's state. */
  private val LogSchema: Schema = new Schema(
    new Attribute("seq", AttributeType.LONG),
    new Attribute("time", AttributeType.TIMESTAMP),
    new Attribute("kind", AttributeType.STRING),
    new Attribute("state", AttributeType.STRING),
    new Attribute("detail", AttributeType.STRING)
  )
  private val LogNamespace = "execution-log"
  private val StatsLabel = "runtime_statistics"
  private val LogLabel = "log"

  /** A table under test: its identifier and how Texera opens it for reading. */
  private final case class BenchTable(
      label: String,
      id: TableIdentifier,
      open: () => VirtualDocument[Tuple]
  )

  private def createStatsTable(eid: Long): (BenchTable, VirtualDocument[Tuple]) = {
    val uri = VFSURIFactory.createRuntimeStatisticsURI(WorkflowIdentity(1), ExecutionIdentity(eid))
    // Same call ExecutionStatsService makes when an execution starts.
    val doc = DocumentFactory
      .createDocument(uri, ResultSchema.runtimeStatisticsSchema)
      .asInstanceOf[VirtualDocument[Tuple]]
    val id = TableIdentifier.of(
      StorageConfig.icebergTableRuntimeStatisticsNamespace,
      s"wid_1_eid_${eid}_runtimestatistics"
    )
    val open = () => DocumentFactory.openDocument(uri)._1.asInstanceOf[VirtualDocument[Tuple]]
    (BenchTable(StatsLabel, id, open), doc)
  }

  private def createLogTable(eid: Long): (BenchTable, VirtualDocument[Tuple]) = {
    val name = s"wid_1_eid_${eid}_log"
    val icebergSchema = IcebergUtil.toIcebergSchema(LogSchema)
    IcebergUtil.createTable(catalog, LogNamespace, name, icebergSchema, overrideIfExists = true)
    // What DocumentFactory.openDocument builds for a VFS URI; the log has no VFS type yet.
    def document(schema: IcebergSchema): VirtualDocument[Tuple] =
      new IcebergDocument[Tuple](
        LogNamespace,
        name,
        schema,
        IcebergUtil.toGenericRecord,
        (s, r) => IcebergUtil.fromRecord(r, IcebergUtil.fromIcebergSchema(s))
      )
    val open = () =>
      document(IcebergUtil.loadTableMetadata(catalog, LogNamespace, name).get.schema())
    (BenchTable(LogLabel, TableIdentifier.of(LogNamespace, name), open), document(icebergSchema))
  }

  private def operatorIds(n: Int): Seq[String] = {
    val kinds = Seq("CSVFileScan", "Filter", "Projection", "HashJoin", "Aggregate", "PythonUDFV2")
    (0 until n).map { i =>
      val uuid = UUID.nameUUIDFromBytes(s"operator-$i".getBytes("UTF-8"))
      s"${kinds(i % kinds.size)}-operator-$uuid"
    }
  }

  private def tickTime(tick: Int, cfg: Config): Timestamp =
    new Timestamp(
      Timestamp.valueOf(LocalDateTime.parse(cfg.dayStart)).getTime +
        tick.toLong * cfg.tickSeconds * 1000L
    )

  /** A row shaped like the ones ExecutionStatsService.storeRuntimeStatistics writes. */
  private def statsTuple(operatorId: String, index: Int, tick: Int, time: Timestamp): Tuple = {
    val processed = tick.toLong * 1000L * (index + 1)
    new Tuple(
      ResultSchema.runtimeStatisticsSchema,
      Array[Any](
        operatorId,
        time,
        processed,
        processed * 64,
        processed - index,
        (processed - index) * 64,
        tick.toLong * 21000000L * (index + 1),
        tick.toLong * 900000L,
        tick.toLong * 3000000000L,
        1 + index % 4,
        1
      )
    )
  }

  /** One tick: a fresh writer, one row per operator, close = one flush = one commit. */
  private def statsTick(
      doc: VirtualDocument[Tuple],
      tick: Int,
      operators: Seq[String],
      cfg: Config
  ): (Double, Double) = {
    val time = tickTime(tick, cfg)
    val loadBefore = catalog.loadTableNanos
    val start = System.nanoTime()
    val writer = doc.writer(s"runtime_statistics_t$tick")
    writer.open()
    operators.zipWithIndex.foreach { case (op, i) => writer.putOne(statsTuple(op, i, tick, time)) }
    writer.close()
    (ms(System.nanoTime() - start), ms(catalog.loadTableNanos - loadBefore))
  }

  /** One state change, committed at once. */
  private def logChange(
      doc: VirtualDocument[Tuple],
      seq: Long,
      tick: Int,
      state: String,
      cfg: Config
  ): Double = {
    val (elapsed, _) = timedMs {
      val writer = doc.writer(s"log_$seq")
      writer.open()
      writer.putOne(
        new Tuple(LogSchema, Array[Any](seq, tickTime(tick, cfg), "state", state, s"tick $tick"))
      )
      writer.close()
    }
    elapsed
  }

  // ---------------------------------------------------------------------------------------
  // Measurements
  // ---------------------------------------------------------------------------------------

  private final case class TableState(
      loadTableMs: Double,
      metadataFile: String,
      metadataStoredBytes: Long,
      metadataJsonBytes: Long,
      dataFiles: Long,
      records: Long,
      manifests: Int,
      snapshots: Int,
      formatVersion: Int
  )

  private def tableState(id: TableIdentifier): TableState = {
    val loads = (1 to 5).map(_ => timedMs(catalog.loadTable(id))._1)
    val table = catalog.loadTable(id)
    val current = table.asInstanceOf[HasTableOperations].operations().current()
    val snapshot = Option(table.currentSnapshot())
    def summary(key: String): Long =
      snapshot.flatMap(s => Option(s.summary().get(key))).map(_.toLong).getOrElse(0L)
    TableState(
      loadTableMs = median(loads),
      metadataFile = current.metadataFileLocation().split('/').last,
      // As stored by the catalog (Lakekeeper gzips it) ...
      metadataStoredBytes = table.io().newInputFile(current.metadataFileLocation()).getLength,
      // ... and as JSON, which is roughly what every loadTable sends and parses.
      metadataJsonBytes = TableMetadataParser.toJson(current).length.toLong,
      dataFiles = summary("total-data-files"),
      records = summary("total-records"),
      manifests = snapshot.map(_.allManifests(table.io()).size).getOrElse(0),
      snapshots = table.snapshots().asScala.size,
      formatVersion = current.formatVersion()
    )
  }

  /**
    * Splits a commit's cost: a catalog-only commit (a table property change; Lakekeeper still
    * loads the table and writes a whole new metadata file) and writing one 10-row data file
    * the way IcebergTableWriter does (Parquet + a remote-signed PUT), deleted afterwards.
    */
  private def probe(
      id: TableIdentifier,
      label: String,
      operators: Seq[String]
  ): (Double, Double) = {
    val table = catalog.loadTable(id)
    val commits = (1 to 5).map { i =>
      timedMs(table.updateProperties().set("bench.probe", s"$label-$i").commit())._1
    }
    val writes = (1 to 5).map { i =>
      val path = s"${table.location().stripSuffix("/")}/probe_${label}_$i"
      val (elapsed, _) = timedMs {
        val writer = dataWriter(table, path)
        try operators.zipWithIndex.foreach {
          case (op, j) =>
            writer.write(
              IcebergUtil.toGenericRecord(table.schema(), statsTuple(op, j, i, new Timestamp(0L)))
            )
        } finally writer.close()
      }
      // A remote-signed DELETE; a refusal shows up as leftover objects, not as a crash.
      Try(table.io().deleteFile(path)).failed.foreach(e => say(s"WARN probe delete failed: $e"))
      elapsed
    }
    (median(commits), median(writes))
  }

  private def dataWriter(table: Table, path: String): DataWriter[Record] =
    Parquet
      .writeData(table.io().newOutputFile(path))
      .forTable(table)
      .createWriterFunc((schema: IcebergSchema, messageType: MessageType) =>
        GenericParquetWriter.create(schema, messageType)
      )
      .overwrite()
      .build()

  private final case class ReadAll(
      medianMs: Double,
      runsMs: Seq[Double],
      rows: Long,
      ordered: Boolean
  )

  /** Everything, through Texera's reader: open the document, iterate get(). */
  private def readAll(table: BenchTable): ReadAll =
    repeatRead {
      val rows = table.open().get()
      var count = 0L
      var previous = Long.MinValue
      var ordered = true
      while (rows.hasNext) {
        val time = rows.next().getField[Timestamp]("time").getTime
        if (time < previous) ordered = false
        previous = time
        count += 1
      }
      (count, ordered)
    }

  /**
    * Everything, through Texera's reader but only three columns (getRange with a column
    * list), as a chart of one counter over time would read it.
    */
  private def readAllProjected(table: BenchTable): ReadAll =
    repeatRead {
      val rows =
        table.open().getRange(0, Int.MaxValue, Some(Seq("operatorId", "time", "outputTupleCnt")))
      var count = 0L
      while (rows.hasNext) {
        rows.next()
        count += 1
      }
      (count, true)
    }

  /**
    * Everything as raw Iceberg records: the same table load, planning and per-file Parquet
    * reader (IcebergUtil.readDataFileAsIterator) as Texera's reader, without turning each
    * record into a Tuple. The floor for reading row by row with Iceberg's generic reader.
    */
  private def readAllRaw(id: TableIdentifier): ReadAll =
    repeatRead {
      val table = IcebergUtil.loadTableMetadata(catalog, id.namespace().toString, id.name()).get
      val tasks = Using
        .resource(table.newScan().planFiles())(_.asScala.toSeq)
        .sortBy(_.file().fileSequenceNumber().longValue())
      var count = 0L
      tasks.foreach { task =>
        Using.resource(IcebergUtil.readDataFileAsIterator(task.file(), table.schema(), table)) {
          records => records.asScala.foreach(_ => count += 1)
        }
      }
      (count, true)
    }

  /**
    * Times a read: three runs and their median when one run takes under 5 s (other work on
    * the machine causes outliers), a single run otherwise (the untidied day's 10 s reads).
    */
  private def repeatRead(read: => (Long, Boolean)): ReadAll = {
    def once(): (Double, Long, Boolean) = {
      val ((rows, ordered), elapsed) = {
        val start = System.nanoTime()
        val result = read
        (result, ms(System.nanoTime() - start))
      }
      (elapsed, rows, ordered)
    }
    val first = once()
    val runs = if (first._1 < 5000) Seq(first, once(), once()) else Seq(first)
    ReadAll(median(runs.map(_._1)), runs.map(_._1), first._2, runs.forall(_._3))
  }

  /** The newest row through Texera's reader: getCount, then getRange(count - 1, count). */
  private def newestViaTexera(table: BenchTable): (Double, Option[Long]) =
    timedMs {
      val doc = table.open()
      val count = doc.getCount
      if (count == 0) None
      else
        doc
          .getRange((count - 1).toInt, count.toInt)
          .toSeq
          .lastOption
          .map(_.getField[Timestamp]("time").getTime)
    }

  /**
    * The newest row without planning the whole table: walk back from the current snapshot to
    * the newest one that added a data file, read that file, keep its last row. When that
    * snapshot has been expired (a tidy that keeps one snapshot ends on a manifest rewrite,
    * which adds no file), take the current snapshot's file with the highest sequence number.
    */
  private def newestDirect(id: TableIdentifier): (Double, Option[Long]) =
    timedMs {
      val table = catalog.loadTable(id)
      var snapshot = table.currentSnapshot()
      var files = Seq.empty[DataFile]
      while (snapshot != null && files.isEmpty) {
        files = snapshot.addedDataFiles(table.io()).asScala.toSeq
        if (files.isEmpty)
          snapshot = Option(snapshot.parentId()).map(p => table.snapshot(p.longValue())).orNull
      }
      if (files.isEmpty && table.currentSnapshot() != null)
        files = Using
          .resource(table.newScan().planFiles())(_.asScala.map(_.file()).toSeq)
          .sortBy(_.fileSequenceNumber().longValue())
      files.lastOption
        .flatMap { file =>
          Using.resource(IcebergUtil.readDataFileAsIterator(file, table.schema(), table)) { it =>
            it.asScala.foldLeft(Option.empty[Record])((_, record) => Some(record))
          }
        }
        .map(record => Timestamp.valueOf(record.getField("time").asInstanceOf[LocalDateTime]))
        .map(_.getTime)
    }

  private def medianOf3(body: => (Double, Option[Long])): (Double, Option[Long]) = {
    val runs = Seq(body, body, body)
    (median(runs.map(_._1)), runs.head._2)
  }

  // ---------------------------------------------------------------------------------------
  // Tidying, with core Iceberg APIs only
  // ---------------------------------------------------------------------------------------

  private final case class TidyCost(
      compactMs: Double,
      filesCompacted: Int,
      rowsCompacted: Long,
      rewriteManifestsMs: Double,
      expireMs: Double,
      snapshotsExpired: Int
  ) {
    def totalMs: Double = compactMs + rewriteManifestsMs + expireMs
  }

  /**
    * 1. Compact: read every live data file of the current snapshot in Texera's read order
    *    (file sequence number) and write the rows, in that order, into one Parquet file the
    *    way IcebergTableWriter writes one; swap them in with a replace (RewriteFiles) commit.
    *    The new file's sequence number is above every file it replaces and below every later
    *    append, so Texera's reader keeps returning rows in commit order.
    * 2. Rewrite manifests into as few as fit.
    * 3. Expire snapshots, keeping the last `keep`; Iceberg deletes the files only they used.
    */
  private def tidy(id: TableIdentifier, keep: Int, label: String): TidyCost = {
    val start = System.nanoTime()
    val table = catalog.loadTable(id)
    val snapshot = table.currentSnapshot()
    val tasks: Seq[FileScanTask] =
      Using
        .resource(table.newScan().useSnapshot(snapshot.snapshotId()).planFiles())(
          _.asScala.toSeq
        )
        .sortBy(_.file().fileSequenceNumber().longValue())
    var rows = 0L
    if (tasks.size > 1) {
      val writer =
        dataWriter(
          table,
          s"${table.location().stripSuffix("/")}/compacted_${label}_${UUID.randomUUID()}"
        )
      try {
        tasks.foreach { task =>
          Using.resource(IcebergUtil.readDataFileAsIterator(task.file(), table.schema(), table)) {
            records =>
              records.asScala.foreach { record =>
                writer.write(record)
                rows += 1
              }
          }
        }
      } finally writer.close()
      val rewrite = table.newRewrite().validateFromSnapshot(snapshot.snapshotId())
      tasks.foreach(task => rewrite.deleteFile(task.file()))
      rewrite.addFile(writer.toDataFile).commit()
    }
    val compacted = System.nanoTime()
    table.rewriteManifests().clusterBy((_: DataFile) => "all").commit()
    val rewritten = System.nanoTime()
    val snapshotsBefore = table.snapshots().asScala.size
    table.expireSnapshots().expireOlderThan(System.currentTimeMillis()).retainLast(keep).commit()
    val expired = System.nanoTime()
    TidyCost(
      compactMs = ms(compacted - start),
      filesCompacted = if (tasks.size > 1) tasks.size else 0,
      rowsCompacted = rows,
      rewriteManifestsMs = ms(rewritten - compacted),
      expireMs = ms(expired - rewritten),
      snapshotsExpired = snapshotsBefore - table.snapshots().asScala.size
    )
  }

  // ---------------------------------------------------------------------------------------
  // Scenarios
  // ---------------------------------------------------------------------------------------

  private final case class CheckpointRow(
      scenario: String,
      table: String,
      phase: String,
      commits: Int,
      expectedRows: Long,
      window: Seq[Double],
      windowLoad: Seq[Double],
      state: TableState,
      read: ReadAll,
      readRaw: Option[ReadAll],
      readProjected: Option[ReadAll],
      newestTexeraMs: Double,
      newestDirectMs: Double,
      newestOk: Boolean
  )

  private final case class TidyRow(
      scenario: String,
      table: String,
      commits: Int,
      before: TableState,
      readBefore: ReadAll,
      cost: TidyCost,
      after: TableState,
      readAfter: ReadAll
  )

  private final class Outputs(dir: File) {
    val ticks = new Csv(
      new File(dir, "ticks.csv"),
      "scenario,table,commit,commit_ms,loadtable_in_commit_ms"
    )
    val checkpoints = new Csv(
      new File(dir, "checkpoints.csv"),
      "scenario,table,phase,commits,rows_expected,rows_read,rows_in_order,window_commits," +
        "commit_p50_ms,commit_p95_ms,commit_max_ms,loadtable_in_commit_p50_ms," +
        "rest_of_commit_p50_ms,rest_of_commit_p95_ms,catalog_only_commit_ms," +
        "data_file_write_ms,loadtable_ms,metadata_file,metadata_stored_bytes," +
        "metadata_json_bytes,data_files,records,manifests,snapshots,read_all_ms," +
        "read_all_runs_ms,read_all_raw_records_ms,read_all_3_columns_ms,newest_texera_ms," +
        "newest_direct_ms,newest_ok"
    )
    val tidies = new Csv(
      new File(dir, "tidy.csv"),
      "scenario,table,commits,data_files_before,manifests_before,snapshots_before," +
        "metadata_json_bytes_before,read_all_before_ms,compact_ms,files_compacted," +
        "rows_compacted,rewrite_manifests_ms,expire_ms,snapshots_expired,tidy_total_ms," +
        "data_files_after,manifests_after,snapshots_after,metadata_json_bytes_after," +
        "read_all_after_ms"
    )
    val tables = new Csv(
      new File(dir, "tables.csv"),
      "scenario,table,identifier,location,format_version"
    )
    def close(): Unit = Seq(ticks, checkpoints, tidies, tables).foreach(_.close())
  }

  private final case class ScenarioResult(
      name: String,
      checkpoints: Seq[CheckpointRow],
      tidies: Seq[TidyRow],
      logCommitMs: Seq[Double]
  )

  private def checkpoint(
      scenario: String,
      table: BenchTable,
      phase: String,
      commits: Int,
      expectedRows: Long,
      expectedNewest: Long,
      window: Seq[Double],
      windowLoad: Seq[Double],
      probeWith: Option[Seq[String]],
      out: Outputs
  ): CheckpointRow = {
    val (catalogOnlyMs, dataFileMs) = probeWith
      .map(ops => probe(table.id, s"$phase$commits", ops))
      .getOrElse((Double.NaN, Double.NaN))
    val state = tableState(table.id)
    val read = readAll(table)
    // Only for the statistics table: where a full read's time goes.
    val readRaw = probeWith.map(_ => readAllRaw(table.id))
    val readProjected = probeWith.map(_ => readAllProjected(table))
    val (texeraMs, texeraNewest) = medianOf3(newestViaTexera(table))
    val (directMs, directNewest) = medianOf3(newestDirect(table.id))
    val newestOk = texeraNewest.contains(expectedNewest) && directNewest.contains(expectedNewest)
    val rest = window.zip(windowLoad).map { case (total, load) => total - load }
    out.checkpoints.row(
      scenario,
      table.label,
      phase,
      commits,
      expectedRows,
      read.rows,
      read.ordered,
      window.size,
      percentile(window, 50),
      percentile(window, 95),
      if (window.isEmpty) Double.NaN else window.max,
      percentile(windowLoad, 50),
      percentile(rest, 50),
      percentile(rest, 95),
      catalogOnlyMs,
      dataFileMs,
      state.loadTableMs,
      state.metadataFile,
      state.metadataStoredBytes,
      state.metadataJsonBytes,
      state.dataFiles,
      state.records,
      state.manifests,
      state.snapshots,
      read.medianMs,
      read.runsMs.map(f1).mkString(";"),
      readRaw.map(_.medianMs).getOrElse(Double.NaN),
      readProjected.map(_.medianMs).getOrElse(Double.NaN),
      texeraMs,
      directMs,
      newestOk
    )
    val rowsOk = read.rows == expectedRows && read.ordered &&
      (readRaw ++ readProjected).forall(_.rows == expectedRows)
    val flags = (if (rowsOk) "" else " ROWS-MISMATCH") + (if (newestOk) "" else " NEWEST-MISMATCH")
    say(
      f"  [$scenario%-7s] ${table.label}%-18s $phase%-16s commits=$commits%4d " +
        f"commit p50/p95=${f1(percentile(window, 50))}%6s/${f1(percentile(window, 95))}%6s ms " +
        f"loadTable=${f1(state.loadTableMs)}%5s ms metadata=${kb(state.metadataJsonBytes)}%5s KB " +
        f"files=${state.dataFiles}%4d manifests=${state.manifests}%3d snapshots=${state.snapshots}%4d " +
        f"readAll=${f1(read.medianMs)}%7s ms" +
        readRaw.fold("")(r => s" (raw records ${f1(r.medianMs)} ms") +
        readProjected.fold("")(r => s", 3 columns ${f1(r.medianMs)} ms)") +
        f" newest texera/direct=${f1(texeraMs)}/${f1(directMs)} ms" + flags
    )
    CheckpointRow(
      scenario,
      table.label,
      phase,
      commits,
      expectedRows,
      window,
      windowLoad,
      state,
      read,
      readRaw,
      readProjected,
      texeraMs,
      directMs,
      newestOk && rowsOk
    )
  }

  private def runScenario(
      name: String,
      eid: Long,
      tidyEvery: Option[Int],
      cfg: Config,
      out: Outputs
  ): ScenarioResult = {
    say(
      s"== scenario $name: ${cfg.commits} commits of ${cfg.operators} rows" + tidyEvery.fold(
        ", never tidied (both tables tidied once after the last commit, to price it)"
      )(n =>
        s", statistics tidied every $n commits; both tables tidied at the end " +
          s"(keep ${cfg.keepSnapshots} snapshots, ${cfg.finalKeepSnapshots} at the end)"
      )
    )
    val (stats, statsDoc) = createStatsTable(eid)
    val (log, logDoc) = createLogTable(eid)
    Seq(stats, log).foreach { t =>
      val table = catalog.loadTable(t.id)
      val version = table.asInstanceOf[HasTableOperations].operations().current().formatVersion()
      out.tables.row(name, t.label, t.id.toString, table.location(), version)
      say(s"  TABLE $name ${t.label} ${t.id} ${table.location()} format-version=$version")
    }
    val operators = operatorIds(cfg.operators)

    // State changes: ready and running at the start, a pause and a resume every hour, done
    // at the end -- a few dozen rows in a day.
    val ticksPerHour = math.max(1, 3600 / cfg.tickSeconds)
    val changes: Map[Int, Seq[String]] = {
      val hourly = (1 to cfg.commits / ticksPerHour)
        .map(_ * ticksPerHour)
        .filter(_ < cfg.commits)
        .flatMap(t => Seq(t -> "PAUSED", t -> "RUNNING"))
      (Seq(1 -> "READY", 1 -> "RUNNING") ++ hourly ++ Seq(cfg.commits -> "COMPLETED"))
        .groupBy(_._1)
        .map { case (tick, entries) => tick -> entries.map(_._2) }
    }

    val window = ArrayBuffer.empty[Double]
    val windowLoad = ArrayBuffer.empty[Double]
    val logWindow = ArrayBuffer.empty[Double]
    val logAll = ArrayBuffer.empty[Double]
    val checkpoints = ArrayBuffer.empty[CheckpointRow]
    val tidies = ArrayBuffer.empty[TidyRow]
    var logSeq = 0L
    var lastLogTick = 0

    def takeCheckpoint(tick: Int, phase: String): Unit = {
      checkpoints += checkpoint(
        name,
        stats,
        phase,
        tick,
        tick.toLong * cfg.operators,
        tickTime(tick, cfg).getTime,
        window.toSeq,
        windowLoad.toSeq,
        Some(operators),
        out
      )
      checkpoints += checkpoint(
        name,
        log,
        phase,
        logSeq.toInt,
        logSeq,
        tickTime(lastLogTick, cfg).getTime,
        logWindow.toSeq,
        Seq.empty,
        None,
        out
      )
      window.clear()
      windowLoad.clear()
      logWindow.clear()
    }

    def tidyNow(table: BenchTable, tick: Int): Unit = {
      val before = tableState(table.id)
      val readBefore = readAll(table)
      val keep = if (tick == cfg.commits) cfg.finalKeepSnapshots else cfg.keepSnapshots
      val cost = tidy(table.id, keep, s"t$tick")
      val after = tableState(table.id)
      val readAfter = readAll(table)
      tidies += TidyRow(name, table.label, tick, before, readBefore, cost, after, readAfter)
      out.tidies.row(
        name,
        table.label,
        tick,
        before.dataFiles,
        before.manifests,
        before.snapshots,
        before.metadataJsonBytes,
        readBefore.medianMs,
        cost.compactMs,
        cost.filesCompacted,
        cost.rowsCompacted,
        cost.rewriteManifestsMs,
        cost.expireMs,
        cost.snapshotsExpired,
        cost.totalMs,
        after.dataFiles,
        after.manifests,
        after.snapshots,
        after.metadataJsonBytes,
        readAfter.medianMs
      )
      say(
        f"  [$name%-7s] tidy ${table.label} at commit $tick: ${before.dataFiles} files/" +
          f"${before.manifests} manifests/${before.snapshots} snapshots -> ${after.dataFiles}/" +
          f"${after.manifests}/${after.snapshots}; compact ${f1(cost.compactMs)} ms " +
          f"(${cost.rowsCompacted} rows), manifests ${f1(cost.rewriteManifestsMs)} ms, expire " +
          f"${f1(cost.expireMs)} ms, total ${f1(cost.totalMs)} ms; readAll " +
          f"${f1(readBefore.medianMs)} -> ${f1(readAfter.medianMs)} ms"
      )
    }

    for (tick <- 1 to cfg.commits) {
      changes.getOrElse(tick, Seq.empty).foreach { state =>
        logSeq += 1
        lastLogTick = tick
        val elapsed = logChange(logDoc, logSeq, tick, state, cfg)
        logWindow += elapsed
        logAll += elapsed
        out.ticks.row(name, LogLabel, logSeq, elapsed, "")
      }
      val (elapsed, load) = statsTick(statsDoc, tick, operators, cfg)
      window += elapsed
      windowLoad += load
      out.ticks.row(name, StatsLabel, tick, elapsed, load)

      if (tick % cfg.checkpointEvery == 0 || tick == cfg.commits) takeCheckpoint(tick, "run")
      if (tidyEvery.exists(n => tick % n == 0) && tick < cfg.commits) tidyNow(stats, tick)
    }
    // The end of the run: tidy both tables (for no-tidy, this prices a single late tidy).
    tidyNow(stats, cfg.commits)
    tidyNow(log, cfg.commits)
    takeCheckpoint(cfg.commits, "after-final-tidy")
    ScenarioResult(name, checkpoints.toSeq, tidies.toSeq, logAll.toSeq)
  }

  /** Warm the JVM, the HTTP clients and the signer on a throwaway table. */
  private def warmUp(cfg: Config, eid: Long): Unit = {
    val (stats, doc) = createStatsTable(eid)
    val operators = operatorIds(cfg.operators)
    (1 to cfg.warmupCommits).foreach(tick => statsTick(doc, tick, operators, cfg))
    probe(stats.id, "warmup", operators)
    tableState(stats.id)
    readAll(stats)
    newestViaTexera(stats)
    newestDirect(stats.id)
    tidy(stats.id, cfg.keepSnapshots, "warmup")
    readAll(stats)
    catalog.dropTable(stats.id, true)
  }

  /**
    * Where a tick's time goes, on a scratch table: Texera's flush (resolve the table, write
    * one file, append) next to the same work on a table held across commits, and its parts.
    */
  private def breakdown(cfg: Config, eid: Long, dir: File): Unit = {
    val n = 40
    val (stats, doc) = createStatsTable(eid)
    val operators = operatorIds(cfg.operators)
    var tick = 0
    def nextTick(): Int = {
      tick += 1
      tick
    }
    def writeFile(table: Table, tag: String): DataFile = {
      val t = nextTick()
      val writer = dataWriter(table, s"${table.location().stripSuffix("/")}/breakdown_${tag}_$t")
      try operators.zipWithIndex.foreach {
        case (op, i) =>
          writer.write(
            IcebergUtil.toGenericRecord(table.schema(), statsTuple(op, i, t, tickTime(t, cfg)))
          )
      } finally writer.close()
      writer.toDataFile
    }
    def metadataLocation(table: Table): String =
      table.asInstanceOf[HasTableOperations].operations().current().metadataFileLocation()

    (1 to 5).foreach(_ => statsTick(doc, nextTick(), operators, cfg))
    val texeraTick = (1 to n).map(_ => statsTick(doc, nextTick(), operators, cfg)._1)
    val loadOnly = (1 to n).map(_ => timedMs(catalog.loadTable(stats.id))._1)
    val loadAndFirstS3 = (1 to n).map { _ =>
      timedMs {
        val table = catalog.loadTable(stats.id)
        table.io().newInputFile(metadataLocation(table)).getLength
      }._1
    }
    val held = catalog.loadTable(stats.id)
    val heldS3 =
      (1 to n).map(_ => timedMs(held.io().newInputFile(metadataLocation(held)).getLength)._1)
    val heldAppend = (1 to n).map { _ =>
      val (write, file) = timedMs(writeFile(held, "append"))
      val (commit, _) = timedMs(held.newAppend().appendFile(file).commit())
      (write, commit)
    }
    val heldFastAppend = (1 to n).map { _ =>
      val file = writeFile(held, "fast")
      timedMs(held.newFastAppend().appendFile(file).commit())._1
    }
    val catalogOnly = (1 to n).map { i =>
      timedMs(held.updateProperties().set("bench.probe", s"breakdown-$i").commit())._1
    }
    held.updateProperties().set("commit.manifest-merge.enabled", "false").commit()
    val heldAppendNoMerge = (1 to n).map { _ =>
      val file = writeFile(held, "nomerge")
      timedMs(held.newAppend().appendFile(file).commit())._1
    }
    val steps = Seq(
      "texera_flush: loadTable + write file + newAppend commit (what each tick does)" -> texeraTick,
      "loadTable" -> loadOnly,
      "loadTable + first S3 request on its new FileIO" -> loadAndFirstS3,
      "S3 HEAD on a held table's FileIO" -> heldS3,
      "held table: write one 10-row data file (Parquet + signed PUT)" -> heldAppend.map(_._1),
      "held table: newAppend commit (manifest + list + REST commit)" -> heldAppend.map(_._2),
      "held table: write file + newAppend commit" -> heldAppend.map(p => p._1 + p._2),
      "held table: newFastAppend commit" -> heldFastAppend,
      "held table: newAppend commit with commit.manifest-merge.enabled=false" -> heldAppendNoMerge,
      "held table: catalog-only commit (property change)" -> catalogOnly
    )
    Using.resource(new Csv(new File(dir, "breakdown.csv"), "step,n,p50_ms,p95_ms")) { csv =>
      steps.foreach {
        case (step, values) =>
          csv.row(step, values.size, percentile(values, 50), percentile(values, 95))
          say(
            f"  breakdown: ${f1(percentile(values, 50))}%6s / ${f1(percentile(values, 95))}%6s ms  $step"
          )
      }
    }
    catalog.dropTable(stats.id, true)
  }

  // ---------------------------------------------------------------------------------------
  // Side findings
  // ---------------------------------------------------------------------------------------

  /** What the catalog hands the client for S3 (names and non-secret values only). */
  private def ioReport(eid: Long): Unit = {
    val (stats, _) = createStatsTable(eid)
    val table = catalog.loadTable(stats.id)
    val props = table.io().properties().asScala
    val shown = Seq(
      "s3.remote-signing-enabled",
      "s3.endpoint",
      "s3.path-style-access",
      "s3.delete-enabled",
      "client.region",
      "s3.signer.uri"
    )
    val secretish = Seq("key", "secret", "token", "credential", "password")
    val others = props.keys.toSeq.sorted.filterNot(shown.contains)
    say(
      s"table io: ${table.io().getClass.getSimpleName} " +
        shown.map(k => s"$k=${props.getOrElse(k, "<unset>")}").mkString(" ")
    )
    say(
      "table io, other keys: " + others
        .map(k => if (secretish.exists(k.toLowerCase.contains)) s"$k(value hidden)" else k)
        .mkString(" ")
    )
    say(s"table properties: ${table.properties().asScala.toSeq.sorted.mkString(" ")}")
    catalog.dropTable(stats.id, true)
  }

  /**
    * Texera stores an Amber TIMESTAMP as a zone-less wall clock (toGenericRecord hands Iceberg
    * `Timestamp.toLocalDateTime` in the JVM's zone). Where the zone falls back an hour, two
    * different instants share one wall clock, so a day-long run's times stop being in order.
    */
  private def dstReport(): Unit = {
    val zone = ZoneId.systemDefault()
    val transition =
      Option(zone.getRules.nextTransition(java.time.Instant.parse("2026-07-01T00:00:00Z")))
        .filter(_.isOverlap)
    transition match {
      case None => say(s"INFO dst: zone $zone has no fall-back overlap after 2026-07-01")
      case Some(t) =>
        val first = new Timestamp(t.getInstant.minusSeconds(1800).toEpochMilli)
        val second = new Timestamp(t.getInstant.plusSeconds(1800).toEpochMilli)
        val schema = new Schema(new Attribute("time", AttributeType.TIMESTAMP))
        val icebergSchema = IcebergUtil.toIcebergSchema(schema)
        def roundTrip(ts: Timestamp): Long =
          IcebergUtil
            .fromRecord(
              IcebergUtil.toGenericRecord(icebergSchema, new Tuple(schema, Array[Any](ts))),
              schema
            )
            .getField[Timestamp]("time")
            .getTime
        say(
          s"INFO dst: in $zone, ${first.toInstant} and ${second.toInstant} (an hour apart) " +
            s"both store as ${first.toLocalDateTime}; read back as ${new Timestamp(roundTrip(first)).toInstant} " +
            s"and ${new Timestamp(roundTrip(second)).toInstant}"
        )
    }
  }

  // ---------------------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------------------

  private def check(name: String, pass: Boolean, evidence: String): Boolean = {
    say(s"CHECK ${if (pass) "PASS" else "FAIL"} $name: $evidence")
    pass
  }

  private def report(results: Seq[ScenarioResult]): Unit = {
    say("== results")
    def statsRows(r: ScenarioResult) = r.checkpoints.filter(_.table == StatsLabel)
    def logRows(r: ScenarioResult) = r.checkpoints.filter(_.table == LogLabel)

    results.foreach { r =>
      val rows = statsRows(r).filter(_.phase == "run")
      val first = rows.head
      val last = rows.last
      val end = statsRows(r).last
      say(
        f"  ${r.name}: commit p50 ${f1(percentile(first.window, 50))} -> " +
          f"${f1(percentile(last.window, 50))} ms, p95 ${f1(percentile(first.window, 95))} -> " +
          f"${f1(percentile(last.window, 95))} ms; metadata ${kb(first.state.metadataJsonBytes)} -> " +
          f"${kb(last.state.metadataJsonBytes)} KB JSON; data files ${first.state.dataFiles} -> " +
          f"${last.state.dataFiles}; snapshots ${first.state.snapshots} -> ${last.state.snapshots}; " +
          f"read all ${f1(first.read.medianMs)} -> ${f1(last.read.medianMs)} ms; after the final " +
          f"tidy read all ${f1(end.read.medianMs)} ms, newest ${f1(end.newestDirectMs)} ms"
      )
      val statsTidies = r.tidies.filter(_.table == StatsLabel)
      say(
        f"  ${r.name}: ${statsTidies.size} statistics tidies, max ${f1(statsTidies.map(_.cost.totalMs).max)} ms; " +
          r.tidies
            .filter(_.commits == statsTidies.last.commits)
            .map(t =>
              f"final ${t.table} tidy ${f1(t.cost.totalMs)} ms (compact ${f1(t.cost.compactMs)}, " +
                f"manifests ${f1(t.cost.rewriteManifestsMs)}, expire ${f1(t.cost.expireMs)})"
            )
            .mkString("; ")
      )
    }

    val checks = ArrayBuffer.empty[Boolean]
    results.foreach { r =>
      val mismatches = r.checkpoints
        .filterNot(c => c.read.rows == c.expectedRows && c.read.ordered && c.newestOk)
        .map(c => s"${c.table}@${c.commits}") ++ r.tidies
        .filterNot(t => t.readAfter.rows == t.readBefore.rows)
        .map(t => s"tidy:${t.table}@${t.commits}")
      checks += check(
        s"${r.name}_rows_complete_ordered",
        mismatches.isEmpty,
        s"${r.checkpoints.size} checkpoint reads and ${r.tidies.size} tidies; every full read " +
          s"returned all rows in commit order and the newest row matched the last commit" +
          (if (mismatches.isEmpty) "" else s"; mismatches at ${mismatches.mkString(" ")}")
      )
    }

    results.filter(_.name.startsWith("tidy")).foreach { r =>
      val rows = statsRows(r).filter(_.phase == "run")
      val end = statsRows(r).last
      checks += check(
        s"${r.name}_read_all_end_under_1s",
        end.read.medianMs < 1000,
        f"whole day (${end.read.rows} rows, ${end.state.dataFiles} file) read through " +
          f"IcebergDocument in ${f1(end.read.medianMs)} ms after the final tidy"
      )
      val worst = rows.maxBy(_.read.medianMs)
      checks += check(
        s"${r.name}_read_all_every_checkpoint_under_1s",
        worst.read.medianMs < 1000,
        f"slowest checkpoint read ${f1(worst.read.medianMs)} ms at commit ${worst.commits} " +
          f"(${worst.state.dataFiles} files)"
      )
      val worstBefore = r.tidies.filter(_.table == StatsLabel).maxBy(_.readBefore.medianMs)
      checks += check(
        s"${r.name}_read_all_worst_case_under_1s",
        worstBefore.readBefore.medianMs < 1000,
        f"slowest read right before a tidy ${f1(worstBefore.readBefore.medianMs)} ms at commit " +
          f"${worstBefore.commits} (${worstBefore.before.dataFiles} files)"
      )
      val firstP50 = percentile(rows.head.window.drop(10), 50)
      val lastP50 = percentile(rows.last.window, 50)
      val firstP95 = percentile(rows.head.window.drop(10), 95)
      val lastP95 = percentile(rows.last.window, 95)
      checks += check(
        s"${r.name}_commit_latency_flat",
        lastP50 <= 1.5 * firstP50 && lastP95 <= 2.0 * firstP95,
        f"commit p50 ${f1(firstP50)} ms (commits 11-${rows.head.commits}) -> ${f1(lastP50)} ms " +
          f"(commits ${rows(rows.size - 2).commits + 1}-${rows.last.commits}), p95 ${f1(firstP95)} " +
          f"-> ${f1(lastP95)} ms (flat = p50 within 1.5x and p95 within 2x)"
      )
    }

    results.find(_.name == "tidy").orElse(results.headOption).foreach { r =>
      val runRows = logRows(r).filter(_.phase == "run")
      val end = runRows.last
      val tidied = logRows(r).last
      checks += check(
        "log_newest_row_tiny",
        runRows.map(_.newestDirectMs).max < 50,
        f"newest state row (newest snapshot's file) at most ${f1(runRows.map(_.newestDirectMs).max)} ms " +
          f"over the day, ${f1(end.newestTexeraMs)} ms through getCount+getRange; loadTable " +
          f"${f1(end.state.loadTableMs)} ms; state commits p50/p95 ${f1(percentile(r.logCommitMs, 50))}/" +
          f"${f1(percentile(r.logCommitMs, 95))} ms (tiny = under 50 ms)"
      )
      checks += check(
        "log_read_all_tiny_untidied",
        end.read.medianMs < 100,
        f"whole log, ${end.read.rows} rows in ${end.state.dataFiles} files (never tidied during the " +
          f"run), read through IcebergDocument in ${f1(end.read.medianMs)} ms (tiny = under 100 ms)"
      )
      checks += check(
        "log_read_all_tiny_after_final_tidy",
        tidied.read.medianMs < 100,
        f"whole log after the end-of-run tidy (${tidied.state.dataFiles} file) read in " +
          f"${f1(tidied.read.medianMs)} ms (tiny = under 100 ms)"
      )
    }

    results.find(_.name == "no-tidy").foreach { r =>
      val rows = statsRows(r).filter(_.phase == "run")
      val first = rows.head
      val last = rows.last
      val t = r.tidies.filter(_.table == StatsLabel).last
      say(
        f"INFO no-tidy over the day: commit p50 x${percentile(last.window, 50) / percentile(first.window.drop(10), 50)}%.1f, " +
          f"read all x${last.read.medianMs / first.read.medianMs}%.1f, metadata JSON " +
          f"x${last.state.metadataJsonBytes.toDouble / first.state.metadataJsonBytes}%.1f; one tidy " +
          f"at the end took ${f1(t.cost.totalMs)} ms and brought the read to ${f1(t.readAfter.medianMs)} ms"
      )
    }
    // A full read costs per file (open, signed GETs) plus per row (decode, Tuple). The read
    // of one compacted file prices a row; the untidied day then prices a file.
    for {
      tidied <- results.find(_.name == "tidy").map(statsRows(_).last)
      raw <- tidied.readRaw
      projected <- tidied.readProjected
    } {
      val perRowUs = tidied.read.medianMs * 1000 / tidied.read.rows
      say(
        f"INFO one file of ${tidied.read.rows} rows: Texera reader ${f1(tidied.read.medianMs)} ms " +
          f"($perRowUs%.1f us/row), raw Iceberg records ${f1(raw.medianMs)} ms, three columns " +
          f"through Texera ${f1(projected.medianMs)} ms"
      )
      results.find(_.name == "no-tidy").map(statsRows(_).filter(_.phase == "run").last).foreach {
        day =>
          val perFileMs =
            (day.read.medianMs - day.read.rows * perRowUs / 1000) / day.state.dataFiles
          say(
            f"INFO untidied day, ${day.state.dataFiles} files: Texera reader " +
              f"${f1(day.read.medianMs)} ms, about $perFileMs%.1f ms per file on top of the " +
              f"per-row cost; raw records ${day.readRaw.fold("-")(r => f1(r.medianMs))} ms"
          )
      }
    }
    say(s"SUMMARY ${checks.count(identity)}/${checks.size} checks passed")
  }

  // ---------------------------------------------------------------------------------------

  def main(args: Array[String]): Unit = {
    val cfg = parseArgs(args)
    cfg.out.mkdirs()
    console = new PrintWriter(new FileWriter(new File(cfg.out, "console.txt")))
    val out = new Outputs(cfg.out)
    val exitCode =
      try {
        say(
          s"Iceberg ${IcebergBuild.version()} | Java ${System.getProperty("java.version")} | " +
            s"Scala ${scala.util.Properties.versionNumberString} | catalog " +
            s"${StorageConfig.icebergCatalogType} ${StorageConfig.icebergRESTCatalogUri} " +
            s"warehouse ${StorageConfig.icebergRESTCatalogWarehouseName} (${catalog.name()})"
        )
        say(s"config: $cfg")
        val runId = (System.currentTimeMillis() / 1000) % 1000000
        val (warmMs, _) = timedMs(warmUp(cfg, runId * 10))
        say(s"warm-up: ${cfg.warmupCommits} commits, reads and one tidy in ${f1(warmMs)} ms")
        ioReport(runId * 10 + 9)
        dstReport()
        say("== where a commit's time goes (p50 / p95, 40 each, scratch table)")
        breakdown(cfg, runId * 10 + 8, cfg.out)
        val results = cfg.scenarios.zipWithIndex.map {
          case (scenario, i) =>
            val tidyEvery = scenario match {
              case "no-tidy"                          => None
              case "tidy"                             => Some(cfg.tidyEvery)
              case every if every.startsWith("tidy-") => Some(every.stripPrefix("tidy-").toInt)
              case other                              => throw new IllegalArgumentException(s"unknown scenario $other")
            }
            val (elapsed, result) =
              timedMs(runScenario(scenario, runId * 10 + i + 1, tidyEvery, cfg, out))
            say(f"== scenario $scenario took ${elapsed / 1000}%.0f s")
            result
        }
        report(results)
        0
      } catch {
        case e: Throwable =>
          say(s"ERROR ${e.getClass.getName}: ${e.getMessage}")
          e.printStackTrace(console)
          e.printStackTrace()
          1
      } finally {
        out.close()
        console.close()
      }
    // The forked JVM would otherwise wait on the HTTP clients' threads.
    sys.exit(exitCode)
  }
}
