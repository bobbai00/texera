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

package org.apache.texera.dao

import org.apache.texera.dao.StatementRecorder.{ExecuteStarted, Statement, siteOf}
import org.jooq.ExecuteContext.BatchMode
import org.jooq.impl.DefaultExecuteListenerProvider
import org.jooq.{DSLContext, ExecuteContext, ExecuteListener}

import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import scala.jdk.CollectionConverters._

/**
  * Records the statements a jOOQ configuration sends to the database while a block runs.
  *
  * It listens on the configuration rather than looking at results, so a statement counts even
  * when the code that sent it swallows its failure, and even when it fails before it reaches the
  * database, for want of a connection, say. It hears every thread that uses the configuration: a
  * run reaches Postgres from actor, RxJava and executor threads, not only from the caller's. It
  * sees only what jOOQ sends through this configuration; raw JDBC and other pools, such as the
  * Iceberg catalog's, are invisible to it.
  */
final class StatementRecorder private () extends ExecuteListener {

  private val recorded = new ConcurrentLinkedQueue[Statement]()
  private val recording = new AtomicBoolean(false)

  /**
    * Runs `body` and returns the statements sent meanwhile, in the order they were sent. Work
    * that `body` sets off on other threads is recorded only until `body` returns, so `body` has
    * to wait for it.
    */
  def record(body: => Unit): Seq[Statement] = {
    if (!recording.compareAndSet(false, true)) {
      throw new IllegalStateException("This StatementRecorder is already recording.")
    }
    try {
      recorded.clear()
      body
      recorded.asScala.toList
    } finally recording.set(false)
  }

  // jOOQ calls this right before the driver sends the statement, when its text is final. The
  // mark, set whether or not a block runs, tells exception() that the statement got this far.
  override def executeStart(ctx: ExecuteContext): Unit = {
    ctx.data(ExecuteStarted, java.lang.Boolean.TRUE)
    if (recording.get()) add(ctx)
  }

  // jOOQ gets the connection and prepares the statement before executeStart, so a statement that
  // fails there is reported only here. One that fails later was recorded at executeStart.
  override def exception(ctx: ExecuteContext): Unit =
    if (recording.get() && ctx.data(ExecuteStarted) == null) add(ctx)

  // A batch of separate statements holds one text, and one query, per statement; a statement
  // jOOQ has not rendered yet, because it failed first, is recorded with no text and no value.
  // A batch of several rows sends one text with each row's values, which the context does not
  // hold, so it is recorded with none.
  private def add(ctx: ExecuteContext): Unit = {
    val thread = Thread.currentThread()
    val site = siteOf(thread.getStackTrace.toSeq)
    val queries = ctx.batchQueries()
    ctx.batchSQL().zipWithIndex.foreach {
      case (sql, i) =>
        val values = queries
          .lift(i)
          .filter(query => query != null && sql != null && ctx.batchMode() != BatchMode.SINGLE)
          .fold(Seq.empty[Any])(_.getBindValues.asScala.toSeq)
        recorded.add(Statement(Option(sql).getOrElse(""), values, thread.getName, site))
    }
  }
}

object StatementRecorder {

  /**
    * One statement sent to the database, or that failed before it got there.
    *
    * @param sql    its text as sent, with `?` for each bind value; empty if it failed before jOOQ
    *               rendered it
    * @param values the values bound to its `?`s, in their order; none for a statement that failed
    *               before jOOQ rendered it, and for a batch of several rows, each of which binds
    *               its own
    * @param thread the name of the thread that sent it
    * @param site   the innermost frame of Texera code that sent it; see [[siteOf]]
    */
  final case class Statement(
      sql: String,
      values: Seq[Any],
      thread: String,
      site: Option[StackTraceElement]
  ) {

    /** The statement's first keyword, upper-cased: SELECT, WITH, INSERT, UPDATE, DELETE, ... */
    def verb: String =
      sql.dropWhile(c => c.isWhitespace || c == '(').takeWhile(_.isLetter).toUpperCase(Locale.ROOT)

    /**
      * The tables the statement names, in lower case, without schema or quotes: what follows
      * each FROM, JOIN, INTO and UPDATE of its text, a subquery's included. A name the text
      * gives a common table expression counts as a table where it is read.
      */
    def tables: Set[String] =
      TableReference
        .findAllMatchIn(sql)
        .flatMap(reference => Option(reference.group(1)))
        .map(Name.findAllIn(_).toSeq.last.stripPrefix("\"").stripSuffix("\""))
        .map(_.toLowerCase(Locale.ROOT))
        .toSet
  }

  /** A name in a statement's text, quoted or not. */
  private val Name = """"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*""".r

  /**
    * A table where a statement names one: the name after FROM, JOIN, INTO or UPDATE, with the
    * schema before it if it has one. The UPDATE of an upsert (ON CONFLICT ... DO UPDATE SET)
    * and of a locking read (FOR UPDATE) names none, and is matched without a name.
    */
  private val TableReference = {
    val name = s"(?:${Name.regex})"
    ("""(?i)\b(?:do|for)\s+update\b|\b(?:from|join|into|update)\s+(""" + name +
      """(?:\s*\.\s*""" + name + ")*)").r
  }

  /** The key of the mark that `executeStart` leaves on a statement's context. */
  private object ExecuteStarted

  private val TexeraPrefix = "org.apache.texera."
  private val GeneratedPrefix = "org.apache.texera.dao.jooq."
  private val RecorderClasses =
    Set(classOf[StatementRecorder].getName, classOf[StatementRecorder].getName + "$")

  /**
    * Starts listening on `context`'s configuration, in place, so that the contexts derived from it
    * afterwards (a transaction's, for one) are covered too. Listeners already there stay.
    */
  def installOn(context: DSLContext): StatementRecorder = {
    val recorder = new StatementRecorder
    val configuration = context.configuration()
    configuration.set(
      configuration.executeListenerProviders() :+ new DefaultExecuteListenerProvider(recorder): _*
    )
    recorder
  }

  /**
    * Names the code that sent a statement, given the stack with its innermost frame first: the
    * innermost frame of Texera code, skipping the recorder itself and the generated jOOQ classes,
    * which say what was queried but not who asked. None when no such frame is on the stack.
    */
  def siteOf(stack: Seq[StackTraceElement]): Option[StackTraceElement] =
    stack.find { frame =>
      val className = frame.getClassName
      className.startsWith(TexeraPrefix) &&
      !className.startsWith(GeneratedPrefix) &&
      !RecorderClasses.contains(className)
    }
}
