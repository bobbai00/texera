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

import org.apache.texera.amber.core.tuple.AttributeType._

import java.sql.Timestamp
import java.time.temporal.ChronoUnit

/**
  * The scalar functions. Each checks its arguments when the expression is compiled, so a wrong
  * argument is reported before anything runs, and gives NULL for a NULL argument unless it is
  * there to handle NULLs (coalesce, nullif).
  */
object Functions {

  val names: List[String] = List(
    "abs", "round", "floor", "ceil", "sqrt", "ln", "log10", "exp", "power", "greatest", "least",
    "coalesce", "nullif",
    "lower", "upper", "trim", "length", "substr", "replace", "concat", "starts_with", "ends_with", "contains",
    "regexp_matches", "regexp_replace", "split_part",
    "year", "month", "day", "hour", "minute", "second", "dayofweek", "date", "date_trunc", "date_diff"
  )

  private def nullSafe(nodes: List[Node])(f: List[Any] => Any): Env => Any =
    env => {
      val values = nodes.map(_.eval(env))
      if (values.contains(null)) null else f(values)
    }

  private def d(v: Any): Double = v.asInstanceOf[Number].doubleValue
  private def dbl(x: Double): Any = if (x.isNaN || x.isInfinite) null else java.lang.Double.valueOf(x)

  def compile(c: Compiler, name: String, args: List[Expr], at: Int): Node = {
    def arity(n: Int*): Unit =
      if (!n.contains(args.length))
        throw ExprError(s"$name takes ${n.mkString(" or ")} argument${if (n.max == 1) "" else "s"}, not ${args.length}", at)
    def unit(e: Expr): String =
      e match {
        case Expr.Literal(s: String, _) if Set("second", "minute", "hour", "day", "week", "month", "year").contains(s.toLowerCase) => s.toLowerCase
        case _ => throw ExprError(s"$name's first argument is a unit: 'second', 'minute', 'hour', 'day', 'week', 'month' or 'year'", e.at)
      }
    val zone = c.zoneOfTimes
    name match {
      case "abs" =>
        arity(1); val x = c.numberArg(args.head)
        Node(x.tpe.map(t => if (t == INTEGER) LONG else t).orElse(Some(DOUBLE)), nullSafe(List(x)) {
          case List(v: java.lang.Double) => java.lang.Double.valueOf(math.abs(v))
          case List(v: Number)           => java.lang.Long.valueOf(math.abs(v.longValue))
          case other                     => other.head
        })
      case "round" =>
        arity(1, 2); val x = c.numberArg(args.head); val digits = args.lift(1).map(c.numberArg)
        Node(Some(DOUBLE), nullSafe(x :: digits.toList) { values =>
          val places = values.lift(1).map(v => v.asInstanceOf[Number].intValue).getOrElse(0)
          dbl(BigDecimal(d(values.head)).setScale(places, BigDecimal.RoundingMode.HALF_UP).toDouble)
        })
      case "floor" | "ceil" =>
        arity(1); val x = c.numberArg(args.head)
        Node(Some(DOUBLE), nullSafe(List(x)) { v => dbl(if (name == "floor") math.floor(d(v.head)) else math.ceil(d(v.head))) })
      case "sqrt" | "ln" | "log10" | "exp" =>
        arity(1); val x = c.numberArg(args.head)
        val f: Double => Double = name match {
          case "sqrt" => math.sqrt; case "ln" => math.log; case "log10" => math.log10; case _ => math.exp
        }
        Node(Some(DOUBLE), nullSafe(List(x)) { v => dbl(f(d(v.head))) })
      case "power" =>
        arity(2); val (x, y) = (c.numberArg(args.head), c.numberArg(args(1)))
        Node(Some(DOUBLE), nullSafe(List(x, y)) { v => dbl(math.pow(d(v.head), d(v(1)))) })
      case "greatest" | "least" =>
        if (args.length < 2) throw ExprError(s"$name takes two or more arguments", at)
        val (nodes, tpe) = c.commonOf(args, at)
        val evals = nodes.map(n => c.widened(n, tpe))
        Node(tpe, env => {
          val values = evals.map(_(env)).filter(_ != null)
          if (values.isEmpty) null
          else if (name == "greatest") values.reduce((a, b) => if (Values.compare(a, b) >= 0) a else b)
          else values.reduce((a, b) => if (Values.compare(a, b) <= 0) a else b)
        })
      case "coalesce" =>
        if (args.isEmpty) throw ExprError("coalesce takes one or more arguments", at)
        val (nodes, tpe) = c.commonOf(args, at)
        val evals = nodes.map(n => c.widened(n, tpe))
        Node(tpe, env => evals.iterator.map(_(env)).find(_ != null).orNull)
      case "nullif" =>
        arity(2); val (a, b) = (c.arg(args.head), c.arg(args(1)))
        Node(a.tpe, env => {
          val x = a.eval(env)
          val y = b.eval(env)
          if (x != null && y != null && Values.compare(x, y) == 0) null else x
        })
      case "lower" | "upper" | "trim" =>
        arity(1); val s = c.textArg(args.head)
        Node(Some(STRING), nullSafe(List(s)) { v =>
          val t = v.head.toString
          name match { case "lower" => t.toLowerCase; case "upper" => t.toUpperCase; case _ => t.trim }
        })
      case "length" =>
        arity(1); val s = c.textArg(args.head)
        Node(Some(LONG), nullSafe(List(s)) { v => java.lang.Long.valueOf(v.head.toString.length.toLong) })
      case "substr" =>
        arity(2, 3); val s = c.textArg(args.head); val rest = args.tail.map(c.numberArg)
        Node(Some(STRING), nullSafe(s :: rest) { v =>
          val t = v.head.toString
          val start = math.max(v(1).asInstanceOf[Number].intValue - 1, 0)
          val end = v.lift(2).map(n => start + math.max(n.asInstanceOf[Number].intValue, 0)).getOrElse(t.length)
          if (start >= t.length) "" else t.substring(start, math.min(end, t.length))
        })
      case "replace" =>
        arity(3); val nodes = args.map(c.textArg)
        Node(Some(STRING), nullSafe(nodes) { v => v.head.toString.replace(v(1).toString, v(2).toString) })
      case "concat" =>
        if (args.isEmpty) throw ExprError("concat takes one or more arguments", at)
        val nodes = args.map(c.arg)
        Node(Some(STRING), env => nodes.map(_.eval(env)).filter(_ != null).map(Values.show).mkString)
      case "starts_with" | "ends_with" | "contains" =>
        arity(2); val (s, p) = (c.textArg(args.head), c.textArg(args(1)))
        Node(Some(BOOLEAN), nullSafe(List(s, p)) { v =>
          val (t, q) = (v.head.toString, v(1).toString)
          java.lang.Boolean.valueOf(name match { case "starts_with" => t.startsWith(q); case "ends_with" => t.endsWith(q); case _ => t.contains(q) })
        })
      case "regexp_matches" =>
        arity(2); val (s, p) = (c.textArg(args.head), c.textArg(args(1)))
        Node(Some(BOOLEAN), nullSafe(List(s, p)) { v => java.lang.Boolean.valueOf(v(1).toString.r.findFirstIn(v.head.toString).isDefined) })
      case "regexp_replace" =>
        arity(3); val nodes = args.map(c.textArg)
        Node(Some(STRING), nullSafe(nodes) { v => v.head.toString.replaceAll(v(1).toString, v(2).toString) })
      case "split_part" =>
        arity(3); val (s, sep, n) = (c.textArg(args.head), c.textArg(args(1)), c.numberArg(args(2)))
        Node(Some(STRING), nullSafe(List(s, sep, n)) { v =>
          val parts = v.head.toString.split(java.util.regex.Pattern.quote(v(1).toString), -1)
          parts.lift(v(2).asInstanceOf[Number].intValue - 1).getOrElse("")
        })
      case "year" | "month" | "day" | "hour" | "minute" | "second" | "dayofweek" =>
        arity(1); val t = c.timeArg(args.head)
        Node(Some(LONG), nullSafe(List(t)) { v =>
          val z = Values.zoned(v.head.asInstanceOf[Timestamp], zone)
          java.lang.Long.valueOf((name match {
            case "year" => z.getYear; case "month" => z.getMonthValue; case "day" => z.getDayOfMonth
            case "hour" => z.getHour; case "minute" => z.getMinute; case "second" => z.getSecond
            case _      => z.getDayOfWeek.getValue // 1 is Monday, 7 is Sunday
          }).toLong)
        })
      case "date" =>
        arity(1); val t = c.timeArg(args.head)
        Node(Some(TIMESTAMP), nullSafe(List(t)) { v => Values.truncate(v.head.asInstanceOf[Timestamp], "day", zone) })
      case "date_trunc" =>
        arity(2); val u = unit(args.head); val t = c.timeArg(args(1))
        Node(Some(TIMESTAMP), nullSafe(List(t)) { v => Values.truncate(v.head.asInstanceOf[Timestamp], u, zone) })
      case "date_diff" =>
        arity(3); val u = unit(args.head); val (a, b) = (c.timeArg(args(1)), c.timeArg(args(2)))
        val chrono = u match {
          case "second" => ChronoUnit.SECONDS; case "minute" => ChronoUnit.MINUTES; case "hour" => ChronoUnit.HOURS
          case "day" => ChronoUnit.DAYS; case "week" => ChronoUnit.WEEKS; case "month" => ChronoUnit.MONTHS; case _ => ChronoUnit.YEARS
        }
        Node(Some(LONG), nullSafe(List(a, b)) { v =>
          java.lang.Long.valueOf(chrono.between(Values.zoned(v.head.asInstanceOf[Timestamp], zone), Values.zoned(v(1).asInstanceOf[Timestamp], zone)))
        })
      case other =>
        val known = names ++ Aggregates.names
        val close = known.filter(k => Names.distance(k, other) <= 2)
        throw ExprError(s"there is no function $other" + close.headOption.map(k => s"; did you mean $k?").getOrElse(""), at)
    }
  }
}
