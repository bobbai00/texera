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

package org.apache.texera.amber.engine.common.executionrecord

import com.google.protobuf.timestamp.Timestamp
import org.apache.iceberg.catalog.TableIdentifier
import org.apache.texera.amber.core.storage.{
  ConsoleMessageStore,
  ConsoleRow,
  ExecutionLogEntry,
  ExecutionLogStore,
  IcebergCatalogInstance,
  RuntimeStatisticsRow,
  RuntimeStatisticsStore
}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.PortIdentity
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  RUNNING
}
import org.apache.texera.amber.engine.architecture.worker.statistics.{
  PortTupleMetricsMapping,
  TupleMetrics
}
import org.apache.texera.amber.engine.common.Utils.maptoStatusCode
import org.apache.texera.amber.engine.common.executionruntimestate.{
  OperatorMetrics,
  OperatorStatistics
}
import org.apache.texera.common.config.StorageConfig

import java.io.{File, FileWriter, PrintWriter}
import java.net.URI
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicLong
import scala.concurrent.duration.DurationInt
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * A benchmark, not a test: does the record of a day-long run read back fast, through the real
  * recorder and the real stores?
  *
  * It drives a [[LakeExecutionRecorder]] tick by tick, on a clock it sets and with no timer, so
  * a simulated day takes minutes. Every tick it tells the recorder new numbers for every
  * operator and the console lines of the tick, and ticks. The run's state changes as a day-long
  * run's does: READY and RUNNING at the start, a pause and a resume now and then (with the
  * defaults, every hour of simulated time), COMPLETED at the end. The recorder writes to the
  * lake the storage configuration names, and tidies its tables as it does in a computing unit.
  *
  * Every `--checkpoint-every` ticks, right before every tidy, and after the end, the bench reads
  * the record back the way its readers do, three times each, and compares what it read with
  * what it told the recorder. It also keeps how long every write of the recorder took.
  *
  * It writes, into `--out`:
  *  - `checkpoints.csv`: a row for every checkpoint, with the reads' times and what the tables
  *    held;
  *  - `ticks.csv`: a row for every write the recorder made;
  *  - `checks.txt`: a `PASS` or `FAIL` line for each of its eight checks, against the thresholds
  *    this file sets.
  *
  * It exits with 0 when every check passed, with 1 when one failed, and with 2 when it could not
  * run to its end. Run it by hand against a lake:
  * {{{
  *   sbt -batch "WorkflowExecutionService/Test/runMain \
  *     org.apache.texera.amber.engine.common.executionrecord.ExecutionRecordBench --out <dir>"
  * }}}
  * Its times mean something only against a REST catalog and an object store, as a deployment
  * has them. Against the build's Postgres catalog it shows that the record is whole.
  *
  * One thing is not as in a computing unit. A tidy keeps the snapshots of its last minute, and
  * it reads the wall clock for that, not the recorder's. The bench makes hundreds of ticks in a
  * minute, so between two tidies its tables carry hundreds of snapshots, where a computing
  * unit's carry the few a tidy keeps and those of the appends since. The data files a read
  * opens are the same; the table's metadata, which every commit rewrites, is larger.
  * `checkpoints.csv` has the count.
  */
object ExecutionRecordBench {

  private val Usage =
    """ExecutionRecordBench [--quick] [--ticks 2880] [--operators 10] [--console-per-tick 1]
      |                     [--state-changes 49] [--checkpoint-every 250] [--warmup-ticks 60]
      |                     [--out target/execution-record-bench]
      |  --quick  120 ticks, a checkpoint every 30 and a warm-up of 20 ticks; an option after
      |           it still applies""".stripMargin

  /**
    * @param ticks           how many ticks the run lasts; 2,880 are a day
    * @param operators       how many operators the run has, each with new numbers on every tick
    * @param consolePerTick  how many console lines come between two ticks
    * @param stateChanges    how many rows the run's log gets: READY, RUNNING and COMPLETED, and
    *                        a pause and a resume for every two more, spread evenly over the run
    * @param checkpointEvery how many ticks come between two checkpoints of the run
    * @param warmupTicks     how many ticks the run before the measured one lasts; 0 for none
    * @param out             where the files go
    */
  private final case class Config(
      ticks: Int = 2880,
      operators: Int = 10,
      consolePerTick: Int = 1,
      stateChanges: Int = 49,
      checkpointEvery: Int = 250,
      warmupTicks: Int = 60,
      out: File = new File("target/execution-record-bench")
  ) {

    /** How often the run is paused and resumed. */
    def pauses: Int = (stateChanges - 3) / 2

    /** The ticks the run is paused and resumed at. */
    def pauseTicks: Set[Int] =
      (1 to pauses).map(pause => (pause.toLong * ticks / (pauses + 1)).toInt).toSet

    /** How many ticks a window of commits lasts, of which the first is compared with the last. */
    def window: Int = math.min(checkpointEvery, ticks / 2)

    /** This configuration, once it is one the bench can run. */
    def checked: Config = {
      require(ticks >= 2, s"a run needs 2 ticks at least, not $ticks")
      require(operators >= 1, s"a run needs an operator, not $operators")
      require(
        consolePerTick >= 0 && consolePerTick < ExecutionRecorder.ConsoleBatchRows,
        s"$consolePerTick console lines a tick: the bench tells 0 or more, and fewer than the " +
          s"${ExecutionRecorder.ConsoleBatchRows} a recorder stores without waiting for a tick"
      )
      require(
        stateChanges >= 3 && stateChanges % 2 == 1 && pauses < ticks,
        s"$stateChanges changes of state: a run has READY, RUNNING and COMPLETED, and a pause " +
          s"with its resume at no more than each tick but the last of its $ticks"
      )
      require(checkpointEvery >= 1, s"a checkpoint comes every tick at most, not $checkpointEvery")
      require(warmupTicks == 0 || warmupTicks >= 2, s"a warm-up lasts 2 ticks at least, or none")
      this
    }
  }

  private def parse(args: List[String], config: Config): Config =
    args match {
      case Nil => config.checked
      case "--quick" :: rest =>
        parse(rest, config.copy(ticks = 120, checkpointEvery = 30, warmupTicks = 20))
      case "--ticks" :: n :: rest            => parse(rest, config.copy(ticks = n.toInt))
      case "--operators" :: n :: rest        => parse(rest, config.copy(operators = n.toInt))
      case "--console-per-tick" :: n :: rest => parse(rest, config.copy(consolePerTick = n.toInt))
      case "--state-changes" :: n :: rest    => parse(rest, config.copy(stateChanges = n.toInt))
      case "--checkpoint-every" :: n :: rest => parse(rest, config.copy(checkpointEvery = n.toInt))
      case "--warmup-ticks" :: n :: rest     => parse(rest, config.copy(warmupTicks = n.toInt))
      case "--out" :: dir :: rest            => parse(rest, config.copy(out = new File(dir)))
      case other :: _ =>
        throw new IllegalArgumentException(s"unknown or incomplete option $other\n$Usage")
    }

  // ---------------------------------------------------------------------------
  // what the checks hold the record to
  // ---------------------------------------------------------------------------

  private val LabelP95Ms = 50.0
  private val StatisticsReadMs = 1000.0
  private val LogReadMs = 100.0
  private val ConsoleReadMs = 200.0
  private val CommitGrowth = 1.5

  /** How many console rows a reader asks for at a time. */
  private val ConsolePage = 1000

  /** The columns a chart of one number over time reads. */
  private val ThreeColumns = Set("operatorId", "timeMs", "outputTupleCnt")

  /** How often a read is made at a checkpoint: its time is the median. */
  private val Repeats = 3

  // ---------------------------------------------------------------------------
  // the simulated run
  // ---------------------------------------------------------------------------

  /** A tick in simulated time: the default of `storage.iceberg.table.commit.interval-ms`. */
  private val TickMs = 30000L

  /** When the simulated run starts. Times are epoch milliseconds, so any day does. */
  private val StartMs = Instant.parse("2026-11-10T00:00:00Z").toEpochMilli

  /** The workflow whose executions the bench records; no spec and no deployment has it. */
  private val Workflow = WorkflowIdentity(9667)

  /** How long the bench waits for the recorder to write what it was told. */
  private val Patience = 10.minutes

  private val Log = "log"
  private val Statistics = "statistics"
  private val Console = "console"

  /** The ids of `n` operators as a workflow has them, in the order the recorder stores them. */
  private def operatorIds(n: Int): Seq[String] = {
    val kinds = Seq("CSVFileScan", "Filter", "Projection", "HashJoin", "Aggregate", "PythonUDFV2")
    (0 until n).map { i =>
      s"${kinds(i % kinds.size)}-operator-${UUID.nameUUIDFromBytes(s"operator-$i".getBytes)}"
    }.sorted
  }

  /** What operator `index` has done by `tick`: totals that grow with every tick. */
  private final case class Numbers(tick: Int, index: Int) {
    private val in = tick.toLong * 1000 * (index + 1)
    private val out = in - index
    private val dataNanos = tick.toLong * 21000000L * (index + 1)
    private val controlNanos = tick.toLong * 900000L
    private val idleNanos = tick.toLong * 3000000000L
    private val workers = 1 + index % 4

    /** As the engine reports them. */
    def metrics(state: WorkflowAggregatedState): OperatorMetrics =
      OperatorMetrics(
        state,
        OperatorStatistics(
          Seq(PortTupleMetricsMapping(PortIdentity(0), TupleMetrics(in, in * 64))),
          Seq(PortTupleMetricsMapping(PortIdentity(0), TupleMetrics(out, out * 64))),
          numWorkers = workers,
          dataProcessingTime = dataNanos,
          controlProcessingTime = controlNanos,
          idleTime = idleNanos
        )
      )

    /** As the statistics table should hold them, stored at `timeMs`. */
    def row(
        operatorId: String,
        timeMs: Long,
        state: WorkflowAggregatedState
    ): RuntimeStatisticsRow =
      RuntimeStatisticsRow(
        operatorId,
        timeMs,
        inputTupleCnt = in,
        inputTupleSize = in * 64,
        outputTupleCnt = out,
        outputTupleSize = out * 64,
        dataProcessingTime = dataNanos,
        controlProcessingTime = controlNanos,
        idleTime = idleNanos,
        numWorkers = workers,
        status = maptoStatusCode(state).toInt
      )
  }

  /** What a read of [[ThreeColumns]] alone returns of `row`. */
  private def threeColumnsOf(row: RuntimeStatisticsRow): RuntimeStatisticsRow =
    RuntimeStatisticsRow(row.operatorId, row.timeMs, 0, 0, row.outputTupleCnt, 0, 0, 0, 0, 0, 0)

  // ---------------------------------------------------------------------------
  // what a run leaves for the checks
  // ---------------------------------------------------------------------------

  /** One write the recorder made: to which table, what, how many rows, and how long it took. */
  private final case class Write(
      tick: Int,
      timeMs: Long,
      table: String,
      what: String,
      rows: Int,
      ms: Double
  )

  /** What a read returned: its rows, and for a page whether more rows follow it. */
  private final case class Answer(rows: Seq[Any], more: Boolean = false)

  /**
    * One read, made [[Repeats]] times.
    *
    * @param runsMs how long each took
    * @param rows   how many rows it returned
    * @param wrong  where what it returned differs from what the recorder was told, if it does
    */
  private final case class Read(runsMs: Seq[Double], rows: Int, wrong: Option[String]) {
    def ms: Double = median(runsMs)
  }

  /** What a table holds: the data files of its current snapshot, and its snapshots. */
  private final case class Shape(dataFiles: Int, snapshots: Int)

  /**
    * The record as it read at one moment of the run.
    *
    * @param phase        `periodic`, `before-tidy`, `before-end-tidy` or `end`
    * @param consoleRows  how many rows the console held, read whole
    * @param wholeConsole where the console, read whole, differs from what was told, if it does
    * @param shapes       of the log, the statistics and the console table, by [[Log]],
    *                     [[Statistics]] and [[Console]]
    */
  private final case class Checkpoint(
      tick: Int,
      phase: String,
      label: Read,
      log: Read,
      statistics: Read,
      threeColumns: Read,
      consolePage: Read,
      consoleRows: Int,
      wholeConsole: Option[String],
      shapes: Map[String, Shape]
  ) {

    /** The reads that did not return what the recorder was told, each with where it differs. */
    def wrong: Seq[String] =
      Seq(
        "label" -> label.wrong,
        "log" -> log.wrong,
        "statistics" -> statistics.wrong,
        "statistics, three columns" -> threeColumns.wrong,
        "console page" -> consolePage.wrong,
        "console" -> wholeConsole
      ).collect { case (read, Some(difference)) => s"$read at tick $tick ($phase): $difference" }
  }

  /**
    * A finished run.
    *
    * @param shapes   of the three tables after the end
    * @param appended the tables the recorder appended to
    */
  private final case class Outcome(
      checkpoints: Seq[Checkpoint],
      writes: Seq[Write],
      shapes: Map[String, Shape],
      appended: Set[String]
  )

  // ---------------------------------------------------------------------------
  // output
  // ---------------------------------------------------------------------------

  /** A CSV file that is whole after every row, so a run that is killed keeps what it measured. */
  private final class Csv(file: File, header: String) {
    private val writer = new PrintWriter(new FileWriter(file))
    row(header.split(',').toSeq: _*)

    def row(values: Any*): Unit =
      synchronized {
        writer.println(
          values
            .map {
              case number: Double => f"$number%.2f"
              case other          => other.toString
            }
            .mkString(",")
        )
        writer.flush()
      }

    def close(): Unit = writer.close()
  }

  private final class Outputs(dir: File) {
    val checkpoints = new Csv(
      new File(dir, "checkpoints.csv"),
      "tick,phase,label_ms,label_runs_ms,log_ms,log_runs_ms,log_rows,statistics_ms," +
        "statistics_runs_ms,statistics_rows,statistics_3_columns_ms,statistics_3_columns_runs_ms," +
        "console_1000_ms,console_1000_runs_ms,console_rows,log_data_files,log_snapshots," +
        "statistics_data_files,statistics_snapshots,console_data_files,console_snapshots,rows_ok"
    )
    val ticks = new Csv(new File(dir, "ticks.csv"), "tick,time_ms,table,write,rows,ms")
    val checks = new PrintWriter(new FileWriter(new File(dir, "checks.txt")))

    def close(): Unit = {
      checkpoints.close()
      ticks.close()
      checks.close()
    }
  }

  private def timed[T](body: => T): (Double, T) = {
    val start = System.nanoTime()
    val result = body
    ((System.nanoTime() - start) / 1e6, result)
  }

  /** The `p`th percentile of `values`: the smallest of them that `p` percent do not exceed. */
  private def percentile(values: Seq[Double], p: Double): Double = {
    val sorted = values.sorted
    sorted(math.min(sorted.size - 1, math.max(0, math.ceil(p / 100 * sorted.size).toInt - 1)))
  }

  private def median(values: Seq[Double]): Double = percentile(values, 50)

  private def f1(value: Double): String = f"$value%.1f"

  /** Where `read` differs from `told`, if it does: in its count, or from which row on. */
  private def difference(told: Answer, read: Answer): Option[String] =
    if (read == told) None
    else if (read.rows.size != told.rows.size) {
      Some(s"read ${read.rows.size} rows, told ${told.rows.size}")
    } else {
      read.rows
        .zip(told.rows)
        .zipWithIndex
        .collectFirst {
          case ((got, expected), at) if got != expected =>
            s"row ${at + 1} of ${told.rows.size} read as $got, told as $expected"
        }
        .orElse(Some(s"read that more rows follow: ${read.more}, where it is ${told.more}"))
    }

  // ---------------------------------------------------------------------------
  // one run
  // ---------------------------------------------------------------------------

  /**
    * One run of `config.ticks` ticks, recorded as execution `executionId`.
    *
    * The recorder's stores are the lake's, wrapped to time every write, and to read the record
    * right before a tidy. Everything the bench tells the recorder it also keeps, as the rows
    * the tables should hold, so every read can be compared with them.
    *
    * @param outputs where a checkpoint and a write are written as they happen; None for a
    *                warm-up, which measures nothing
    */
  private final class Run(config: Config, executionId: Long, outputs: Option[Outputs]) {
    private val execution = ExecutionIdentity(executionId)
    private val logUri = ExecutionLogStore.logUri(Workflow, execution, None)
    private val statisticsUri = RuntimeStatisticsStore.statisticsUri(Workflow, execution, None)
    private val consoleUri = ConsoleMessageStore.consoleUri(Workflow, execution, None)
    private val tables = Seq(
      (Log, StorageConfig.icebergTableExecutionLogNamespace, logUri),
      (Statistics, StorageConfig.icebergTableRuntimeStatisticsNamespace, statisticsUri),
      (Console, StorageConfig.icebergTableConsoleMessagesNamespace, consoleUri)
    )
    private val operators = operatorIds(config.operators)

    private val clock = new AtomicLong(StartMs)
    // The tick whose numbers the recorder was last told; 0 before the first.
    @volatile private var tick = 0

    // What the recorder was told, as the rows its tables should hold. The bench's thread adds
    // to them. Statistics and console lines are told while the recorder's thread rests, so
    // whatever is told of them is in the lake whenever the record is read.
    @volatile private var toldLog = Vector.empty[ExecutionLogEntry]
    @volatile private var toldStatistics = Vector.empty[RuntimeStatisticsRow]
    @volatile private var toldThreeColumns = Vector.empty[RuntimeStatisticsRow]
    @volatile private var toldConsole = Vector.empty[ConsoleRow]

    // How many rows the recorder has appended to the log. The read right before a tidy needs
    // it: the commit of a pause may still be tidying when the bench tells the resume.
    @volatile private var logged = 0
    // On the recorder's thread alone: whether the record was read since the recorder's last
    // write that was no tidy. A commit tidies its tables one after another, with no other
    // write between, so one read before the first of them is right before them all.
    private var readBeforeTidy = false

    private val writes = new ConcurrentLinkedQueue[Write]()
    private val checkpoints = new ConcurrentLinkedQueue[Checkpoint]()
    // What went wrong on the recorder's thread, which the recorder does not let out.
    private val failures = new ConcurrentLinkedQueue[String]()

    private val recorder = new LakeExecutionRecorder(
      logUri = logUri,
      statisticsUri = statisticsUri,
      consoleUri = consoleUri,
      beatEveryMs = TickMs,
      // The bench ticks: a simulated day does not wait for a timer.
      timed = false,
      clock = () => clock.get(),
      create = (uri, nowMs, every) =>
        writing(Log, "create", 0)(ExecutionLogStore.create(uri, nowMs, every)),
      append = (uri, rows, nowMs) =>
        writing(Log, "append", rows.size) {
          ExecutionLogStore.append(uri, rows, nowMs)
          logged = rows.last.seq.toInt
        },
      beat = (uri, nowMs) => writing(Log, "beat", 0)(ExecutionLogStore.beat(uri, nowMs)),
      tidy = tidying(Log, ExecutionLogStore.tidy),
      createStatistics = uri =>
        writing(Statistics, "create", 0)(RuntimeStatisticsStore.create(uri)),
      appendStatistics = (uri, rows) =>
        writing(Statistics, "append", rows.size)(RuntimeStatisticsStore.append(uri, rows)),
      tidyStatistics = tidying(Statistics, RuntimeStatisticsStore.tidy),
      createConsole = uri => writing(Console, "create", 0)(ConsoleMessageStore.create(uri)),
      appendConsole = (uri, rows) =>
        writing(Console, "append", rows.size)(ConsoleMessageStore.append(uri, rows)),
      tidyConsole = tidying(Console, ConsoleMessageStore.tidy)
    )

    /**
      * Makes a write of the recorder's and keeps how long it took. One that fails is kept as a
      * failure and thrown on to the recorder, which would make it again later: the rows would
      * then no longer be the ones the bench expects, so the run is given up.
      */
    private def timing(table: String, what: String, rows: Int)(write: => Unit): Unit = {
      val (took, written) = timed(Try(write))
      written.failed.foreach { failure =>
        failures.add(s"$table.$what at tick $tick failed: $failure")
        throw failure
      }
      val made = Write(tick, clock.get(), table, what, rows, took)
      writes.add(made)
      outputs.foreach(
        _.ticks.row(made.tick, made.timeMs, made.table, made.what, made.rows, made.ms)
      )
    }

    /** A write of the recorder's that is no tidy. */
    private def writing(table: String, what: String, rows: Int)(write: => Unit): Unit = {
      readBeforeTidy = false
      timing(table, what, rows)(write)
    }

    /**
      * A tidy of the recorder's, with a read of the record right before the first tidy of a
      * commit: that is when the tables have the most files they ever have.
      */
    private def tidying(table: String, tidy: (URI, Boolean) => Unit): (URI, Boolean) => Unit =
      (uri, atEnd) => {
        if (!readBeforeTidy) {
          readBeforeTidy = true
          Try(checkpoint(if (atEnd) "before-end-tidy" else "before-tidy")).failed.foreach {
            failure => failures.add(s"the read before a tidy at tick $tick failed: $failure")
          }
        }
        timing(table, if (atEnd) "tidy-for-end" else "tidy", 0)(tidy(uri, atEnd))
      }

    private def giveUpIfFailed(): Unit =
      if (!failures.isEmpty) {
        throw new IllegalStateException(
          s"execution $executionId could not be recorded as told: " +
            failures.asScala.mkString("; ")
        )
      }

    /**
      * Tells the recorder of a change of state, and waits until its row is written, with
      * everything else the recorder was told before it. The commit that writes them may not be
      * over by then: it tidies after it has written.
      */
    private def change(state: String): Unit = {
      toldLog :+= ExecutionLogEntry.state(toldLog.size + 1L, clock.get(), state)
      recorder.state(state)
      if (!recorder.awaitIdle(Patience)) {
        failures.add(s"the change to $state was not written within $Patience")
      }
      giveUpIfFailed()
    }

    /** One tick. It returns when the recorder's thread has done everything asked of it. */
    private def tickRecorder(): Unit = {
      recorder.tick()
      giveUpIfFailed()
    }

    /** Tells the recorder what tick `n` is to store: every operator's numbers, and the console. */
    private def tell(n: Int): Unit = {
      tick = n
      val now = StartMs + n * TickMs
      clock.set(now)
      val state = if (n == config.ticks) COMPLETED else RUNNING
      val numbers = operators.zipWithIndex.map { case (id, index) => id -> Numbers(n, index) }
      recorder.statistics(numbers.map {
        case (id, operator) => id -> operator.metrics(state)
      }.toMap)
      val rows = numbers.map { case (id, operator) => operator.row(id, now, state) }
      toldStatistics ++= rows
      toldThreeColumns ++= rows.map(threeColumnsOf)
      (1 to config.consolePerTick).foreach { _ =>
        val seq = toldConsole.size + 1L
        val operatorId = operators((seq % operators.size).toInt)
        val row = ConsoleRow(
          seq,
          now,
          operatorId,
          workerId = s"Worker:WF${Workflow.id}-$operatorId-main-0",
          msgType = ConsoleMessageType.PRINT.name,
          source = "udf.py:7",
          title = s"batch $seq done",
          message = s"tick $n: batch $seq took ${seq * 37 % 977} ms; the loss went down again"
        )
        recorder.console(
          operatorId,
          ConsoleMessage(
            row.workerId,
            Timestamp(now / 1000, 0),
            ConsoleMessageType.PRINT,
            row.source,
            row.title,
            row.message
          )
        )
        toldConsole :+= row
      }
    }

    /** Reads `read` [[Repeats]] times, and compares what each returned with `told`. */
    private def thrice[T](told: Answer)(read: => T)(answer: T => Answer): Read = {
      val runs = Seq.fill(Repeats)(timed(read))
      val answers = runs.map { case (_, result) => answer(result) }
      Read(runs.map(_._1), answers.last.rows.size, answers.flatMap(difference(told, _)).headOption)
    }

    private def shapes(): Map[String, Shape] =
      tables.map {
        case (name, namespace, uri) =>
          val table = IcebergCatalogInstance
            .getInstance()
            .loadTable(
              TableIdentifier.of(namespace, uri.getPath.stripPrefix("/").replace("/", "_"))
            )
          name -> Shape(
            Option(table.currentSnapshot()).fold(0)(_.summary().get("total-data-files").toInt),
            table.snapshots().asScala.size
          )
      }.toMap

    /**
      * Reads the record as its readers do: the label, the whole log, the whole statistics with
      * all columns and with three, and a page of the console. Then the whole console once more,
      * untimed, to see that no line is lost.
      */
    private def checkpoint(phase: String): Checkpoint = {
      val toldLogged = toldLog.take(logged)
      val newest = toldLogged.last
      val label = thrice(Answer(Seq((newest.state, newest.seq, newest.timeMs))))(
        ExecutionLogStore.label(logUri)
      )(read => Answer(read.map(l => (l.state, l.stateSeq, l.stateTimeMs)).toSeq))
      val log = thrice(Answer(toldLogged))(ExecutionLogStore.read(logUri))(Answer(_))
      val statistics =
        thrice(Answer(toldStatistics))(RuntimeStatisticsStore.read(statisticsUri))(Answer(_))
      val threeColumns = thrice(Answer(toldThreeColumns))(
        RuntimeStatisticsStore.read(statisticsUri, ThreeColumns)
      )(Answer(_))
      val consolePage =
        thrice(Answer(toldConsole.take(ConsolePage), toldConsole.size > ConsolePage))(
          ConsoleMessageStore.read(consoleUri, None, 0, ConsolePage)
        ) { case (rows, more) => Answer(rows, more) }
      val (console, moreConsole) = ConsoleMessageStore.read(consoleUri, None, 0, Int.MaxValue)
      val read = Checkpoint(
        tick,
        phase,
        label,
        log,
        statistics,
        threeColumns,
        consolePage,
        consoleRows = console.size,
        wholeConsole = difference(Answer(toldConsole), Answer(console, moreConsole)),
        shapes = shapes()
      )
      checkpoints.add(read)
      outputs.foreach { files =>
        def runs(of: Read): String = of.runsMs.map(f1).mkString(";")
        files.checkpoints.row(
          Seq[Any](tick, phase, read.label.ms, runs(read.label), read.log.ms, runs(read.log)) ++
            Seq(read.log.rows, read.statistics.ms, runs(read.statistics), read.statistics.rows) ++
            Seq(read.threeColumns.ms, runs(read.threeColumns), read.consolePage.ms) ++
            Seq(runs(read.consolePage), read.consoleRows) ++
            Seq(Log, Statistics, Console).map(read.shapes).flatMap { shape =>
              Seq(shape.dataFiles, shape.snapshots)
            } :+ read.wrong.isEmpty: _*
        )
        println(
          f"tick $tick%5d $phase%-15s label ${read.label.ms}%6.1f ms, log ${read.log.ms}%6.1f ms, " +
            f"statistics ${read.statistics.ms}%7.1f ms (${read.statistics.rows} rows in " +
            f"${read.shapes(Statistics).dataFiles} files), console page " +
            f"${read.consolePage.ms}%6.1f ms" + (if (read.wrong.isEmpty) "" else "  ROWS DIFFER")
        )
      }
      read
    }

    /** Runs the run to its end, and drops its tables. */
    def run(): Outcome =
      try {
        change("READY")
        clock.addAndGet(1000)
        change("RUNNING")
        // The recorder's first tick, with nothing to store yet: when it returns, the commit
        // of the change before it is over, and what is told next is the next tick's to store.
        tickRecorder()
        val pauseTicks = config.pauseTicks
        (1 to config.ticks).foreach { n =>
          tell(n)
          if (pauseTicks.contains(n)) {
            // The commit of the pause stores what the run did up to it, as in a computing unit.
            change("PAUSED")
            clock.addAndGet(1000)
            change("RUNNING")
          }
          tickRecorder()
          if (n % config.checkpointEvery == 0) checkpoint("periodic")
        }
        clock.addAndGet(1000)
        // Written, and the tables tidied for their end, before this returns.
        change("COMPLETED")
        checkpoint("end")
        val made = writes.asScala.toSeq
        Outcome(
          checkpoints.asScala.toSeq,
          made,
          shapes(),
          made.collect { case write if write.what == "append" => write.table }.toSet
        )
      } finally {
        // Also of a run that broke off: its recorder has no timer, and its thread is a daemon.
        Seq(
          logUri -> (() => ExecutionLogStore.drop(logUri)),
          statisticsUri -> (() => RuntimeStatisticsStore.drop(statisticsUri)),
          consoleUri -> (() => ConsoleMessageStore.drop(consoleUri))
        ).foreach {
          case (uri, drop) =>
            Try(drop()).failed.foreach(failure => println(s"WARN $uri was not dropped: $failure"))
        }
      }
  }

  // ---------------------------------------------------------------------------
  // the checks
  // ---------------------------------------------------------------------------

  /** Writes the line of each check, and says whether all passed. */
  private def report(config: Config, outcome: Outcome, outputs: Outputs): Boolean = {
    def check(name: String, pass: Boolean, evidence: String): Boolean = {
      val line = s"${if (pass) "PASS" else "FAIL"} $name: $evidence"
      println(line)
      outputs.checks.println(line)
      outputs.checks.flush()
      pass
    }
    val end = outcome.checkpoints.last
    val beforeTidy = outcome.checkpoints.filter(_.phase.startsWith("before-"))
    val worstBeforeTidy = beforeTidy.maxBy(_.statistics.ms)
    val labelReads = outcome.checkpoints.flatMap(_.label.runsMs)
    val appends =
      outcome.writes.filter(write => write.table == Statistics && write.what == "append")
    val first = appends.filter(_.tick <= config.window).map(_.ms)
    val last = appends.filter(_.tick > config.ticks - config.window).map(_.ms)
    val wrong = outcome.checkpoints.flatMap(_.wrong)
    val whole = end.log.rows == config.stateChanges &&
      end.statistics.rows == config.ticks.toLong * config.operators &&
      end.consoleRows == config.ticks.toLong * config.consolePerTick
    // A table nothing was appended to was never tidied: it has no data file and no snapshot.
    val tidied = Seq(Log, Statistics, Console).map { table =>
      table -> (if (outcome.appended(table)) Shape(1, 1) else Shape(0, 0))
    }.toMap

    Seq(
      check(
        "label_read_p95",
        percentile(labelReads, 95) < LabelP95Ms,
        s"${f1(percentile(labelReads, 95))} ms over ${labelReads.size} reads at " +
          s"${outcome.checkpoints.size} checkpoints, median ${f1(median(labelReads))} ms, " +
          s"slowest ${f1(labelReads.max)} ms (under ${f1(LabelP95Ms)} ms)"
      ),
      check(
        "statistics_read_end",
        end.statistics.ms < StatisticsReadMs,
        s"${f1(end.statistics.ms)} ms for ${end.statistics.rows} rows in " +
          s"${end.shapes(Statistics).dataFiles} file(s) after the end tidy, " +
          s"${f1(end.threeColumns.ms)} ms with three columns (under ${f1(StatisticsReadMs)} ms)"
      ),
      check(
        "statistics_read_before_tidy_median",
        median(beforeTidy.map(_.statistics.ms)) < StatisticsReadMs,
        s"${f1(median(beforeTidy.map(_.statistics.ms)))} ms over the reads right before " +
          s"${beforeTidy.size} tidies, slowest ${f1(worstBeforeTidy.statistics.ms)} ms at tick " +
          s"${worstBeforeTidy.tick} (${worstBeforeTidy.statistics.rows} rows in " +
          s"${worstBeforeTidy.shapes(Statistics).dataFiles} files) " +
          s"(under ${f1(StatisticsReadMs)} ms)"
      ),
      check(
        "log_read_end",
        end.log.ms < LogReadMs,
        s"${f1(end.log.ms)} ms for ${end.log.rows} rows in ${end.shapes(Log).dataFiles} " +
          s"file(s) after the end tidy (under ${f1(LogReadMs)} ms)"
      ),
      check(
        "console_read_1000_rows_end",
        end.consolePage.ms < ConsoleReadMs,
        s"${f1(end.consolePage.ms)} ms for the first ${end.consolePage.rows} of " +
          s"${end.consoleRows} rows in ${end.shapes(Console).dataFiles} file(s) after the end " +
          s"tidy (under ${f1(ConsoleReadMs)} ms)"
      ),
      check(
        "commit_p50_flat",
        median(last) <= CommitGrowth * median(first),
        s"a statistics append took ${f1(median(first))} ms at the median over ticks " +
          s"1-${config.window} and ${f1(median(last))} ms over ticks " +
          s"${config.ticks - config.window + 1}-${config.ticks}, p95 ${f1(percentile(first, 95))} " +
          s"and ${f1(percentile(last, 95))} ms (the last within $CommitGrowth times the first)"
      ),
      check(
        "rows_complete_and_ordered",
        wrong.isEmpty && whole,
        s"${outcome.checkpoints.size} checkpoints, ${beforeTidy.size} of them right before a " +
          s"tidy; at the end ${end.log.rows} log rows (${config.stateChanges} changes of " +
          s"state), ${end.statistics.rows} statistics rows (${config.ticks} ticks of " +
          s"${config.operators} operators) and ${end.consoleRows} console rows; " +
          (if (wrong.isEmpty) "every read returned the rows the recorder was told, in their order"
           else
             s"${wrong.size} reads differ from what the recorder was told: ${wrong.mkString(" | ")}")
      ),
      check(
        "files_at_end",
        outcome.shapes == tidied,
        Seq(Log, Statistics, Console)
          .map { table =>
            val shape = outcome.shapes(table)
            s"$table ${shape.dataFiles} data file(s) and ${shape.snapshots} snapshot(s)"
          }
          .mkString(", ") + " (1 and 1 each; none of a table nothing was appended to)"
      )
    ).forall(identity)
  }

  def main(args: Array[String]): Unit = {
    if (args.exists(Set("--help", "-h"))) {
      println(Usage)
      sys.exit(0)
    }
    val exitCode =
      try {
        val config = parse(args.toList, Config())
        config.out.mkdirs()
        val outputs = new Outputs(config.out)
        try {
          val catalog = StorageConfig.icebergCatalogType match {
            case "rest" =>
              s"rest at ${StorageConfig.icebergRESTCatalogUri}, warehouse " +
                StorageConfig.icebergRESTCatalogWarehouseName
            case "postgres" =>
              s"postgres at ${StorageConfig.icebergPostgresCatalogUriWithoutScheme}"
            case other => other
          }
          println(
            s"catalog $catalog; ${config.ticks} ticks of ${config.operators} operators, " +
              s"${config.consolePerTick} console line(s) a tick, ${config.stateChanges} changes " +
              s"of state, a checkpoint every ${config.checkpointEvery} ticks"
          )
          // An execution id no earlier run of the bench had, and one beside it for the warm-up.
          val executionId = System.currentTimeMillis() / 1000 * 2
          if (config.warmupTicks > 0) {
            // Loads the classes and opens the connections, which are not what is measured.
            val warmup = config.copy(
              ticks = config.warmupTicks,
              stateChanges = 5,
              checkpointEvery = config.warmupTicks / 2
            )
            val (took, _) = timed(new Run(warmup, executionId + 1, outputs = None).run())
            println(f"warm-up: ${config.warmupTicks} ticks in ${took / 1000}%.1f s")
          }
          val (took, outcome) = timed(new Run(config, executionId, Some(outputs)).run())
          println(f"${config.ticks} ticks in ${took / 1000}%.1f s; files in ${config.out}")
          if (report(config, outcome, outputs)) 0 else 1
        } finally outputs.close()
      } catch {
        case failure: Throwable =>
          println(s"ERROR the bench did not run to its end: $failure")
          failure.printStackTrace()
          2
      }
    // The JVM would otherwise wait on the threads of the catalog's and the store's clients.
    sys.exit(exitCode)
  }
}
