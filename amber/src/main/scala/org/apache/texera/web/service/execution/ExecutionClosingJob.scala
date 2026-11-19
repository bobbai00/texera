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

package org.apache.texera.web.service.execution

import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.lifecycle.Managed
import org.apache.texera.amber.core.storage.ExecutionLabel
import org.apache.texera.web.service.execution.ExecutionClosing.{
  CheckRowsThenLose,
  CloseEnded,
  CloseNeverStarted,
  CloseUnavailable,
  Decision,
  Read,
  Wait,
  Watch
}

import java.util.concurrent.atomic.{AtomicBoolean, AtomicInteger}
import java.util.concurrent.{
  Callable,
  CancellationException,
  ConcurrentHashMap,
  ExecutionException,
  Executor,
  ExecutorService,
  Executors,
  LinkedBlockingQueue,
  ScheduledExecutorService,
  ThreadPoolExecutor,
  TimeUnit
}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

object ExecutionClosingJob {

  /** How many executions a tick looks at at once, and how long it gives each. */
  val Concurrency = 8
  val LookLimit: FiniteDuration = 5.seconds

  /** Daemon threads for the looks of a tick, let go of after a minute without one. */
  private def lookThreads(): ExecutorService = {
    val count = new AtomicInteger()
    val pool = new ThreadPoolExecutor(
      Concurrency,
      Concurrency,
      1,
      TimeUnit.MINUTES,
      new LinkedBlockingQueue[Runnable](),
      (task: Runnable) => {
        val thread = new Thread(task, s"execution-closing-look-${count.incrementAndGet()}")
        thread.setDaemon(true)
        thread
      }
    )
    pool.allowCoreThreadTimeOut(true)
    pool
  }

  /**
    * The one thread a job expires results on, so that dropping tables holds up no close. A
    * daemon, let go of after a minute with nothing to expire.
    */
  private def expiryThread(): Executor = {
    val pool = new ThreadPoolExecutor(
      1,
      1,
      1,
      TimeUnit.MINUTES,
      new LinkedBlockingQueue[Runnable](),
      (task: Runnable) => {
        val thread = new Thread(task, "execution-expiry")
        thread.setDaemon(true)
        thread
      }
    )
    pool.allowCoreThreadTimeOut(true)
    pool
  }
}

/**
  * Writes each execution's closing record, at the Dashboard service: every
  * `execution-closing.interval-seconds` it looks at the executions that are still open, decides
  * about each with [[ExecutionClosing]] and acts through [[ExecutionCloser]].
  *
  * The same tick looks at the executions a verdict closed in the last
  * `execution-closing.revise-verdict-for-seconds`, and gives one the ending its log shows by
  * then: a unit that was cut off from the lake for a while is not lost.
  *
  * The job also expires results ([[ExecutionExpiry]]), on a thread of its own: those a run has
  * replaced, once a tick finds that a unit has started a later execution of the workflow on
  * the unit, or closes an execution that one has replaced; and, at most every
  * `result-cleanup.collection-check-interval-in-seconds` and first on its first tick, those of
  * the executions that ended longer ago than `result-cleanup.ttl-in-seconds`.
  *
  * Any number of Dashboard replicas run the job, with no leader: every write is a conditional
  * UPDATE or an Iceberg tag, which one of them wins. What a replica remembers between its ticks
  * (how long each beat has stood still) is its own, so a replica that just started only decides
  * later, never wrongly.
  *
  * Whatever fails while one execution is looked at is logged, and the execution is looked at
  * again on the next tick.
  *
  * @param lookLimit    how long a tick gives the look at one execution
  * @param now          the Dashboard service's clock, in epoch milliseconds
  * @param expiryThread runs what is expired, off the thread that ticks
  */
class ExecutionClosingJob(
    settings: ExecutionClosing.Settings = ExecutionClosing.Settings.configured,
    closer: ExecutionCloser = new ExecutionCloser(),
    openExecutions: () => Seq[ExecutionRecord] = () => ExecutionRecords.open(),
    closedByVerdictSince: Long => Seq[ExecutionRecord] = ExecutionRecords.closedByVerdictSince,
    lookLimit: FiniteDuration = ExecutionClosingJob.LookLimit,
    now: () => Long = () => System.currentTimeMillis(),
    expiry: ExecutionExpiry = ExecutionExpiry.forDeployment,
    expiryThread: Executor = ExecutionClosingJob.expiryThread()
) extends Managed
    with LazyLogging {

  private var scheduler: ScheduledExecutorService = _
  private val lookThreads = ExecutionClosingJob.lookThreads()

  // What this job saw of each open execution's beat on its earlier ticks.
  private val watches = new ConcurrentHashMap[Long, Watch]()

  // The open executions a tick found started, for which it had expired what they replaced.
  private val replacing = ConcurrentHashMap.newKeySet[Long]()

  // When this job last had the results past their age expired, on its own clock, and whether
  // that pass is still to end. Only the ticking thread reads and writes the time.
  private var lastExpiryPassMs: Option[Long] = None
  private val expiryPassUnderWay = new AtomicBoolean(false)

  override def start(): Unit = {
    scheduler = Executors.newSingleThreadScheduledExecutor((runnable: Runnable) => {
      val thread = new Thread(runnable, "execution-closing")
      thread.setDaemon(true)
      thread
    })
    scheduler.scheduleWithFixedDelay(
      () => runScheduledTick(),
      settings.intervalSeconds.toLong,
      settings.intervalSeconds.toLong,
      TimeUnit.SECONDS
    )
  }

  override def stop(): Unit = {
    if (scheduler != null) scheduler.shutdownNow()
    lookThreads.shutdownNow()
  }

  /**
    * Runs one tick for the scheduler. Catches every Throwable, since one that escaped would
    * cancel the schedule: no execution would be closed again until the service restarts.
    */
  private[execution] def runScheduledTick(): Unit =
    try tick()
    catch {
      case _: InterruptedException => Thread.currentThread().interrupt()
      case t: Throwable            => logger.error("A tick of the execution closing job failed.", t)
    }

  /**
    * One tick: looks at every open execution, then at every execution closed by a verdict that
    * its log may still replace, at most [[ExecutionClosingJob.Concurrency]] at a time; then
    * has the results past their age expired, when that is due.
    */
  private[execution] def tick(): Unit = {
    val open = openExecutions()
    val verdicts = closedByVerdictSince(ExecutionClosing.reviseSinceMs(settings, now()))
    // An execution that is no longer open is no longer watched.
    val stillOpen = open.map(_.eid).toSet.asJava
    watches.keySet().retainAll(stillOpen)
    replacing.retainAll(stillOpen)
    lookAtEach(open)(lookAtOpen)
    lookAtEach(verdicts)(lookAtVerdict)
    expireByAgeWhenDue()
  }

  private def lookAtOpen(execution: ExecutionRecord): Unit =
    ExecutionClosing.withoutReading(execution, settings) match {
      case Some(decision) => act(execution, decision, label = None)
      case None =>
        val read =
          try closer.read(execution)
          catch {
            case NonFatal(failure) =>
              // Each tick, without the trace: a lake that is down says so for every execution.
              logger.warn(
                s"The log of execution ${execution.eid} could not be read, so nothing is " +
                  s"decided about it on this tick: $failure"
              )
              Read.Failed
          }
        val (decision, watch) =
          ExecutionClosing.decide(
            execution,
            read,
            Option(watches.get(execution.eid)),
            settings,
            now()
          )
        watch match {
          case Some(watched) => watches.put(execution.eid, watched)
          case None          => watches.remove(execution.eid)
        }
        val label = read match {
          case Read.Log(label) => Some(label)
          case _               => None
        }
        val closed = act(execution, decision, label)
        decision match {
          // One no unit started holds nothing, and replaced nothing.
          case _: CloseEnded | _: CheckRowsThenLose if closed =>
            expireReplaced(execution, closed = true)
          case _ if label.exists(_.state.nonEmpty) => expireReplaced(execution, closed = false)
          case _                                   => ()
        }
    }

  /**
    * Has the results expired that a run replaced on the unit of `execution`, of the workflow's
    * executions there, when the look at `execution` found one of the two things that can make
    * them so:
    *  - a unit has started `execution`, which replaces the earlier ones; handed over once for
    *    an execution, unless it fails, which the next tick tries again;
    *  - this job closed `execution`, which a unit may have run: a later one may have replaced
    *    it while it was open, and it replaced the earlier ones.
    */
  private def expireReplaced(execution: ExecutionRecord, closed: Boolean): Unit =
    execution.cuid.foreach { cuid =>
      if (closed || replacing.add(execution.eid)) {
        val upTo = if (closed) ExecutionExpiry.UpToNewest else execution.eid
        val replace: Runnable = () =>
          if (!expiry.expireReplaced(execution.wid, cuid, upTo)) {
            replacing.remove(execution.eid)
          }
        try expiryThread.execute(replace)
        catch {
          case NonFatal(refused) =>
            replacing.remove(execution.eid)
            logger.warn(
              s"What was replaced on computing unit $cuid when execution ${execution.eid} " +
                s"${if (closed) "was closed" else "started"} was not handed over to be expired: " +
                s"$refused"
            )
        }
      }
    }

  /**
    * Has the results of the executions that ended longer ago than results are kept expired,
    * when a pass is due and the one before it has ended.
    */
  private def expireByAgeWhenDue(): Unit = {
    val nowMs = now()
    if (
      ExecutionClosing.expiryDue(settings, lastExpiryPassMs, nowMs) &&
      expiryPassUnderWay.compareAndSet(false, true)
    ) {
      val pass: Runnable = () =>
        try {
          val expired = expiry.expirePast(ExecutionClosing.pastAge(settings, nowMs))
          if (expired > 0) {
            logger.info(s"Expired the results of $expired executions that were past their age.")
          }
        } catch {
          case NonFatal(failure) =>
            logger.warn("The results past their age could not be expired on this pass.", failure)
        } finally expiryPassUnderWay.set(false)
      try {
        expiryThread.execute(pass)
        lastExpiryPassMs = Some(nowMs)
      } catch {
        case NonFatal(refused) =>
          expiryPassUnderWay.set(false)
          logger.warn(s"The pass over the results past their age was not handed over: $refused")
      }
    }
  }

  /** Acts on `decision` about `execution`, and answers whether that closed the execution. */
  private def act(
      execution: ExecutionRecord,
      decision: Decision,
      label: Option[ExecutionLabel]
  ): Boolean =
    decision match {
      case Wait                      => false
      case CloseEnded(ending)        => closer.close(execution, ending, fromLog = true)
      case CloseNeverStarted         => closer.closeNeverStarted(execution)
      case CheckRowsThenLose(reason) => closer.loseUnlessEnded(execution, reason, label)
      case CloseUnavailable          => closer.closeUnavailable(execution)
    }

  private def lookAtVerdict(execution: ExecutionRecord): Unit =
    if (ExecutionClosing.revisable(execution, settings, now())) closer.reviseIfEnded(execution)

  /**
    * Runs `look` on each of `executions`, a batch at a time, giving a batch `lookLimit`: a look
    * that takes longer is interrupted. A look that fails or is cut short is logged.
    */
  private def lookAtEach(executions: Seq[ExecutionRecord])(look: ExecutionRecord => Unit): Unit =
    executions.grouped(ExecutionClosingJob.Concurrency).foreach { batch =>
      val looks = batch.map(execution => (() => look(execution)): Callable[Unit])
      val looked = lookThreads.invokeAll(looks.asJava, lookLimit.toMillis, TimeUnit.MILLISECONDS)
      batch.zip(looked.asScala).foreach {
        case (execution, result) =>
          try result.get()
          catch {
            case _: CancellationException =>
              logger.warn(
                s"Looking at execution ${execution.eid} took longer than $lookLimit; it is " +
                  "looked at again on the next tick."
              )
            case failed: ExecutionException =>
              logger.warn(
                s"Execution ${execution.eid} could not be looked at; it is looked at again on " +
                  "the next tick.",
                failed.getCause
              )
          }
      }
    }
}
