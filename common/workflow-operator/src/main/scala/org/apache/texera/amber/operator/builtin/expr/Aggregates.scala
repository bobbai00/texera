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

package org.apache.texera.amber.operator.builtin.expr

import org.apache.texera.amber.core.tuple.AttributeType
import org.apache.texera.amber.core.tuple.AttributeType._

import scala.collection.mutable

/** What one aggregate call keeps for a group while the group's rows arrive. */
trait AggregateState {
  def add(env: Env): Unit
  def result: Any
}

/** One aggregate call: the type of its result and how a group's state starts. */
final case class AggregateSpec(name: String, tpe: Option[AttributeType], newState: () => AggregateState)

/**
  * The aggregates: count(*), count(x), count(DISTINCT x), count_if(condition), sum, avg (mean),
  * min, max, stddev and variance (of a sample), median. NULLs are skipped; a group with nothing
  * to aggregate gives NULL, except the counts, which give 0.
  */
object Aggregates {
  val names: Set[String] = Set("count", "count_if", "sum", "avg", "mean", "min", "max", "stddev", "variance", "median")

  def spec(name: String, args: List[Expr], compiled: List[Node], star: Boolean, distinct: Boolean, at: Int): AggregateSpec = {
    def one(): Node =
      compiled match {
        case List(x) if !star => x
        case _                => throw ExprError(s"$name takes one argument", at)
      }
    def numeric(x: Node): Node = {
      if (!x.tpe.forall(t => t == INTEGER || t == LONG || t == DOUBLE))
        throw ExprError(s"$name needs numbers, and ${describe(args)} is ${x.tpe.map(_.getName).getOrElse("null")}; read it as a number with try_cast(... AS double)", at)
      x
    }
    if (distinct && name != "count") throw ExprError(s"DISTINCT goes only with count", at)
    name match {
      case "count" if star =>
        AggregateSpec(name, Some(LONG), () => new Counter(_ => true))
      case "count" if distinct =>
        val x = one()
        AggregateSpec(name, Some(LONG), () => new DistinctCounter(x))
      case "count" =>
        val x = one()
        AggregateSpec(name, Some(LONG), () => new Counter(env => x.eval(env) != null))
      case "count_if" =>
        val x = one()
        if (x.tpe.exists(_ != BOOLEAN)) throw ExprError("count_if counts the rows where a condition is true; give it a condition", at)
        AggregateSpec(name, Some(LONG), () => new Counter(env => x.eval(env) == java.lang.Boolean.TRUE))
      case "sum" =>
        val x = numeric(one())
        val integral = x.tpe.forall(t => t == INTEGER || t == LONG)
        AggregateSpec(name, Some(if (integral) LONG else DOUBLE), () => new Sum(x, integral))
      case "avg" | "mean" =>
        val x = numeric(one())
        AggregateSpec(name, Some(DOUBLE), () => new Moments(x, Moments.Mean))
      case "stddev" =>
        val x = numeric(one())
        AggregateSpec(name, Some(DOUBLE), () => new Moments(x, Moments.StdDev))
      case "variance" =>
        val x = numeric(one())
        AggregateSpec(name, Some(DOUBLE), () => new Moments(x, Moments.Variance))
      case "min" | "max" =>
        val x = one()
        if (x.tpe.exists(t => t == BOOLEAN || t == BINARY || t == LARGE_BINARY))
          throw ExprError(s"$name needs numbers, text or times", at)
        AggregateSpec(name, x.tpe, () => new Extreme(x, name == "max"))
      case "median" =>
        val x = numeric(one())
        AggregateSpec(name, Some(DOUBLE), () => new Median(x))
    }
  }

  private def describe(args: List[Expr]): String =
    args.headOption match {
      case Some(Expr.Column(n, _, _)) => n
      case _                          => "its argument"
    }

  private final class Counter(counts: Env => Boolean) extends AggregateState {
    private var n = 0L
    def add(env: Env): Unit = if (counts(env)) n += 1
    def result: Any = java.lang.Long.valueOf(n)
  }

  private final class DistinctCounter(x: Node) extends AggregateState {
    private val seen = mutable.HashSet[Any]()
    def add(env: Env): Unit = { val v = x.eval(env); if (v != null) seen += v }
    def result: Any = java.lang.Long.valueOf(seen.size.toLong)
  }

  private final class Sum(x: Node, integral: Boolean) extends AggregateState {
    private var any = false
    private var longs = 0L
    private var doubles = 0.0
    def add(env: Env): Unit =
      x.eval(env) match {
        case null      =>
        case v: Number => any = true; if (integral) longs += v.longValue else doubles += v.doubleValue
      }
    def result: Any = if (!any) null else if (integral) java.lang.Long.valueOf(longs) else java.lang.Double.valueOf(doubles)
  }

  object Moments extends Enumeration { val Mean, StdDev, Variance = Value }

  /** Count, mean and spread in one pass (Welford's method), so they stay exact over many rows. */
  private final class Moments(x: Node, of: Moments.Value) extends AggregateState {
    private var n = 0L
    private var mean = 0.0
    private var m2 = 0.0
    def add(env: Env): Unit =
      x.eval(env) match {
        case null =>
        case v: Number =>
          n += 1
          val delta = v.doubleValue - mean
          mean += delta / n
          m2 += delta * (v.doubleValue - mean)
      }
    def result: Any =
      of match {
        case Moments.Mean     => if (n == 0) null else java.lang.Double.valueOf(mean)
        case Moments.Variance => if (n < 2) null else java.lang.Double.valueOf(m2 / (n - 1))
        case _                => if (n < 2) null else java.lang.Double.valueOf(math.sqrt(m2 / (n - 1)))
      }
  }

  private final class Extreme(x: Node, max: Boolean) extends AggregateState {
    private var best: Any = null
    def add(env: Env): Unit = {
      val v = x.eval(env)
      if (v != null && (best == null || (if (max) Values.compare(v, best) > 0 else Values.compare(v, best) < 0))) best = v
    }
    def result: Any = best
  }

  private final class Median(x: Node) extends AggregateState {
    private val values = mutable.ArrayBuffer[Double]()
    def add(env: Env): Unit = x.eval(env) match { case null => ; case v: Number => values += v.doubleValue }
    def result: Any =
      if (values.isEmpty) null
      else {
        val sorted = values.sorted
        val mid = sorted.length / 2
        java.lang.Double.valueOf(if (sorted.length % 2 == 1) sorted(mid) else (sorted(mid - 1) + sorted(mid)) / 2)
      }
  }
}
