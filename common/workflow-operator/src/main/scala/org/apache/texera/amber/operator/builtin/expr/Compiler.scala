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

import org.apache.texera.amber.core.tuple.{AttributeType, AttributeTypeUtils, Schema, Tuple}
import org.apache.texera.amber.operator.builtin.expr.Expr._

import java.sql.Timestamp
import java.time.temporal.ChronoUnit
import java.time.{Instant, ZoneId, ZonedDateTime}
import scala.collection.mutable.ArrayBuffer
import scala.util.Try

/** Where an expression is evaluated: one input row, or one group's aggregate results. */
final class Env {
  var row: Tuple = _
  var aggregates: Array[Any] = _
}

/** A typed, compiled expression: its type (absent for a bare NULL) and how to compute it. */
final case class Node(tpe: Option[AttributeType], eval: Env => Any)

/**
  * Types and compiles expressions over a table's columns. Types follow SQL: integers and longs
  * add up to a long, anything with a double is a double, `/` is always a double, and division by
  * zero is null. NULL follows SQL's three-valued logic. Times are read in the zone the engine reads
  * them in. Every error names what the expression says, in its words.
  */
final class Compiler(input: Schema, aggregatesAllowed: Boolean) {
  import AttributeType._

  /** The aggregate calls met, in order: their results are `Env.aggregates`. */
  val aggregates: ArrayBuffer[AggregateSpec] = ArrayBuffer()

  private val zone: ZoneId = ZoneId.systemDefault()

  private val numeric = Set(INTEGER, LONG, DOUBLE)
  private def isNumeric(t: Option[AttributeType]) = t.forall(numeric.contains)
  private def integral(t: Option[AttributeType]) = t.forall(x => x == INTEGER || x == LONG)

  private def typeName(t: Option[AttributeType]): String =
    t match {
      case None                       => "null"
      case Some(STRING)               => "text"
      case Some(INTEGER) | Some(LONG) => "an integer"
      case Some(DOUBLE)               => "a number"
      case Some(BOOLEAN)              => "true or false"
      case Some(TIMESTAMP)            => "a time"
      case Some(other)                => other.getName
    }

  private def said(e: Expr): String =
    e match {
      case Column(name, _, _)     => name
      case Literal(s: String, _)  => s"'$s'"
      case Literal(null, _)       => "NULL"
      case Literal(v, _)          => String.valueOf(v)
      case Call(name, _, _, _, _) => s"$name(...)"
      case _                      => "this value"
    }

  def compile(e: Expr): Node =
    e match {
      case Literal(v, _)       => Node(literalType(v), _ => v)
      case c: Column           => column(c)
      case Unary("not", x, at) => not(x, at)
      case Unary("-", x, at)   => negate(x, at)
      case Unary(op, _, at)    => throw ExprError(s"'$op' has no meaning here", at)
      case Binary(op, l, r, at) =>
        op match {
          case "and" | "or"                         => logic(op, l, r, at)
          case "=" | "<>" | "<" | "<=" | ">" | ">=" => compare(op, l, r, at)
          case "+" | "-" | "*" | "/" | "%"          => arithmetic(op, l, r, at)
          case "||"                                 => concat(List(compile(l), compile(r)))
        }
      case IsNull(x, negated, _) =>
        val n = compile(x)
        Node(Some(BOOLEAN), env => java.lang.Boolean.valueOf((n.eval(env) == null) != negated))
      case In(x, options, negated, at)            => in(x, options, negated, at)
      case Between(x, low, high, negated, at)     => between(x, low, high, negated, at)
      case Like(x, pattern, negated, at)          => like(x, pattern, negated, at)
      case Case(whens, otherwise, at)             => caseWhen(whens, otherwise, at)
      case Cast(x, to, safe, at)                  => cast(compile(x), to, safe, at)
      case Call(name, args, star, distinct, at)   => call(name, args, star, distinct, at)
    }

  private def literalType(v: Any): Option[AttributeType] =
    v match {
      case null                  => None
      case _: java.lang.Long     => Some(LONG)
      case _: java.lang.Double   => Some(DOUBLE)
      case _: String             => Some(STRING)
      case _: java.lang.Boolean  => Some(BOOLEAN)
      case _                     => Some(STRING)
    }

  // ---- columns -------------------------------------------------------------------------

  private def column(c: Column): Node = {
    val names = input.getAttributeNames
    val name =
      if (names.contains(c.name)) c.name
      else
        names.filter(_.equalsIgnoreCase(c.name)) match {
          case List(only) if !c.quoted => only
          case _                       => throw ExprError(Names.missing(c.name, names), c.at)
        }
    val index = input.getIndex(name)
    val tpe = input.getAttribute(name).getType
    Node(Some(tpe), env => {
      if (env.row == null)
        throw ExprError(s"$name is not aggregated: put it in by, or use it inside an aggregate such as avg($name)", c.at)
      env.row.getField[Any](index)
    })
  }

  // ---- logic and comparison ------------------------------------------------------------

  private def bool(e: Expr): Node = {
    val n = compile(e)
    if (n.tpe.exists(_ != BOOLEAN))
      throw ExprError(s"${said(e)} is ${typeName(n.tpe)}, not true or false: compare it with something", e.at)
    n
  }

  private def not(x: Expr, at: Int): Node = {
    val n = bool(x)
    Node(Some(BOOLEAN), env => n.eval(env) match {
      case null       => null
      case b: Boolean => java.lang.Boolean.valueOf(!b)
    })
  }

  private def logic(op: String, l: Expr, r: Expr, at: Int): Node = {
    val (a, b) = (bool(l), bool(r))
    if (op == "and")
      Node(Some(BOOLEAN), env => {
        val x = a.eval(env)
        if (x == java.lang.Boolean.FALSE) java.lang.Boolean.FALSE
        else {
          val y = b.eval(env)
          if (y == java.lang.Boolean.FALSE) java.lang.Boolean.FALSE
          else if (x == null || y == null) null
          else java.lang.Boolean.TRUE
        }
      })
    else
      Node(Some(BOOLEAN), env => {
        val x = a.eval(env)
        if (x == java.lang.Boolean.TRUE) java.lang.Boolean.TRUE
        else {
          val y = b.eval(env)
          if (y == java.lang.Boolean.TRUE) java.lang.Boolean.TRUE
          else if (x == null || y == null) null
          else java.lang.Boolean.FALSE
        }
      })
  }

  /** Two values that can be compared, a time read from text where the other side is a time. */
  private def comparable(l: Expr, r: Expr, at: Int): (Node, Node) = {
    var (a, b) = (compile(l), compile(r))
    if (a.tpe.contains(TIMESTAMP) && b.tpe.contains(STRING)) b = timeLiteral(r, b)
    if (b.tpe.contains(TIMESTAMP) && a.tpe.contains(STRING)) a = timeLiteral(l, a)
    val ok = (a.tpe, b.tpe) match {
      case (None, _) | (_, None)                             => true
      case (Some(x), Some(y)) if numeric(x) && numeric(y)     => true
      case (Some(x), Some(y))                                 => x == y
    }
    if (!ok)
      throw ExprError(
        s"${said(l)} is ${typeName(a.tpe)} and ${said(r)} is ${typeName(b.tpe)}: they cannot be compared; cast one with try_cast(... AS ...)",
        at
      )
    (a, b)
  }

  private def timeLiteral(e: Expr, n: Node): Node =
    e match {
      case Literal(s: String, at) =>
        val t = Try(AttributeTypeUtils.parseTimestamp(s)).getOrElse(
          throw ExprError(s"'$s' is not a time this can read; write it as 'YYYY-MM-DD hh:mm:ss'", at)
        )
        Node(Some(TIMESTAMP), _ => t)
      case _ => n
    }

  private def compare(op: String, l: Expr, r: Expr, at: Int): Node = {
    val (a, b) = comparable(l, r, at)
    val test: Int => Boolean = op match {
      case "="  => _ == 0
      case "<>" => _ != 0
      case "<"  => _ < 0
      case "<=" => _ <= 0
      case ">"  => _ > 0
      case ">=" => _ >= 0
    }
    Node(Some(BOOLEAN), env => {
      val x = a.eval(env)
      if (x == null) null
      else {
        val y = b.eval(env)
        if (y == null) null else java.lang.Boolean.valueOf(test(Values.compare(x, y)))
      }
    })
  }

  private def in(x: Expr, options: List[Expr], negated: Boolean, at: Int): Node = {
    val pairs = options.map(o => comparable(x, o, o.at))
    val value = pairs.head._1
    val choices = pairs.map(_._2)
    Node(Some(BOOLEAN), env => {
      val v = value.eval(env)
      if (v == null) null
      else {
        var sawNull = false
        var found = false
        val it = choices.iterator
        while (!found && it.hasNext) {
          val c = it.next().eval(env)
          if (c == null) sawNull = true else if (Values.compare(v, c) == 0) found = true
        }
        if (found) java.lang.Boolean.valueOf(!negated)
        else if (sawNull) null
        else java.lang.Boolean.valueOf(negated)
      }
    })
  }

  private def between(x: Expr, low: Expr, high: Expr, negated: Boolean, at: Int): Node = {
    val (v, lo) = comparable(x, low, at)
    val (_, hi) = comparable(x, high, at)
    Node(Some(BOOLEAN), env => {
      val (a, b, c) = (v.eval(env), lo.eval(env), hi.eval(env))
      if (a == null || b == null || c == null) null
      else java.lang.Boolean.valueOf((Values.compare(a, b) >= 0 && Values.compare(a, c) <= 0) != negated)
    })
  }

  private def like(x: Expr, pattern: Expr, negated: Boolean, at: Int): Node = {
    val (v, p) = (text(x), text(pattern))
    Node(Some(BOOLEAN), env => {
      val (s, pat) = (v.eval(env), p.eval(env))
      if (s == null || pat == null) null
      else java.lang.Boolean.valueOf(Values.like(s.toString, pat.toString) != negated)
    })
  }

  private def text(e: Expr): Node = {
    val n = compile(e)
    if (n.tpe.exists(_ != STRING)) throw ExprError(s"${said(e)} is ${typeName(n.tpe)}, not text", e.at)
    n
  }

  // ---- arithmetic -----------------------------------------------------------------------

  private def number(e: Expr): Node = {
    val n = compile(e)
    if (!isNumeric(n.tpe))
      throw ExprError(
        s"${said(e)} is ${typeName(n.tpe)}, not a number" +
          (if (n.tpe.contains(STRING)) s"; read it as one with try_cast(${said(e)} AS double)" else ""),
        e.at
      )
    n
  }

  private def negate(x: Expr, at: Int): Node = {
    val n = number(x)
    val asLong = integral(n.tpe)
    Node(if (asLong) Some(LONG) else Some(DOUBLE), env => n.eval(env) match {
      case null      => null
      case v: Number => if (asLong) java.lang.Long.valueOf(-v.longValue) else java.lang.Double.valueOf(-v.doubleValue)
    })
  }

  private def arithmetic(op: String, l: Expr, r: Expr, at: Int): Node = {
    val (a, b) = (number(l), number(r))
    val asLong = op != "/" && integral(a.tpe) && integral(b.tpe)
    val f: (Number, Number) => Any =
      if (asLong) op match {
        case "+" => (x, y) => java.lang.Long.valueOf(x.longValue + y.longValue)
        case "-" => (x, y) => java.lang.Long.valueOf(x.longValue - y.longValue)
        case "*" => (x, y) => java.lang.Long.valueOf(x.longValue * y.longValue)
        case "%" => (x, y) => if (y.longValue == 0) null else java.lang.Long.valueOf(x.longValue % y.longValue)
      }
      else op match {
        case "+" => (x, y) => java.lang.Double.valueOf(x.doubleValue + y.doubleValue)
        case "-" => (x, y) => java.lang.Double.valueOf(x.doubleValue - y.doubleValue)
        case "*" => (x, y) => java.lang.Double.valueOf(x.doubleValue * y.doubleValue)
        case "/" => (x, y) => if (y.doubleValue == 0) null else java.lang.Double.valueOf(x.doubleValue / y.doubleValue)
        case "%" => (x, y) => if (y.doubleValue == 0) null else java.lang.Double.valueOf(x.doubleValue % y.doubleValue)
      }
    Node(Some(if (asLong) LONG else DOUBLE), env => {
      val x = a.eval(env)
      if (x == null) null
      else {
        val y = b.eval(env)
        if (y == null) null else f(x.asInstanceOf[Number], y.asInstanceOf[Number])
      }
    })
  }

  private def concat(parts: List[Node]): Node =
    Node(Some(STRING), env => {
      val values = parts.map(_.eval(env))
      if (values.contains(null)) null else values.map(Values.show).mkString
    })

  // ---- CASE and CAST --------------------------------------------------------------------

  /** The type several branches share: numbers widen, NULL takes the others' type. */
  private def common(nodes: List[(Expr, Node)], at: Int): Option[AttributeType] = {
    val typed = nodes.filter(_._2.tpe.isDefined)
    if (typed.isEmpty) None
    else if (typed.forall(n => isNumeric(n._2.tpe))) Some(if (typed.forall(n => integral(n._2.tpe))) LONG else DOUBLE)
    else {
      val first = typed.head
      typed.find(_._2.tpe != first._2.tpe) match {
        case Some((other, n)) =>
          throw ExprError(s"${said(first._1)} is ${typeName(first._2.tpe)} but ${said(other)} is ${typeName(n.tpe)}: give every branch one type", at)
        case None => first._2.tpe
      }
    }
  }

  private def widen(n: Node, to: Option[AttributeType]): Env => Any =
    to match {
      case Some(DOUBLE) if n.tpe.exists(t => t != DOUBLE) =>
        env => n.eval(env) match { case null => null; case v: Number => java.lang.Double.valueOf(v.doubleValue) }
      case Some(LONG) if n.tpe.contains(INTEGER) =>
        env => n.eval(env) match { case null => null; case v: Number => java.lang.Long.valueOf(v.longValue) }
      case _ => n.eval
    }

  private def caseWhen(whens: List[(Expr, Expr)], otherwise: Option[Expr], at: Int): Node = {
    val conditions = whens.map { case (c, _) => bool(c) }
    val results = whens.map { case (_, v) => v -> compile(v) } ++ otherwise.map(o => o -> compile(o))
    val tpe = common(results, at)
    val evals = results.map(r => widen(r._2, tpe)).toArray
    val tests = conditions.toArray
    val hasElse = otherwise.isDefined
    Node(tpe, env => {
      var i = 0
      var out: Any = null
      var done = false
      while (!done && i < tests.length) {
        if (tests(i).eval(env) == java.lang.Boolean.TRUE) { out = evals(i)(env); done = true }
        i += 1
      }
      if (!done && hasElse) evals(tests.length)(env) else out
    })
  }

  private def cast(n: Node, to: String, safe: Boolean, at: Int): Node = {
    val target = Names.typeNamed(to).getOrElse(
      throw ExprError(s"'$to' is not a type; use one of integer, long, double, text, boolean, timestamp", at)
    )
    Node(Some(target), env => {
      val v = n.eval(env)
      if (v == null) null
      else
        Try(Values.cast(v, target)).getOrElse {
          if (safe) null
          else throw ExprError(s"'${Values.show(v)}' cannot be read as ${typeName(Some(target))}; try_cast gives null instead", at)
        }
    })
  }

  // ---- functions ------------------------------------------------------------------------

  private def call(name: String, args: List[Expr], star: Boolean, distinct: Boolean, at: Int): Node =
    if (Aggregates.names.contains(name)) aggregate(name, args, star, distinct, at)
    else if (star || distinct) throw ExprError(s"$name takes no * or DISTINCT", at)
    else Functions.compile(this, name, args, at)

  private def aggregate(name: String, args: List[Expr], star: Boolean, distinct: Boolean, at: Int): Node = {
    if (!aggregatesAllowed)
      throw ExprError(s"$name is an aggregate: use it in aggregate's outputs, with by naming the groups", at)
    val inner = new Compiler(input, aggregatesAllowed = false)
    val compiledArgs = args.map(inner.compile)
    val spec = Aggregates.spec(name, args, compiledArgs, star, distinct, at)
    val index = aggregates.length
    aggregates += spec
    Node(spec.tpe, env => env.aggregates(index))
  }

  /** For the function library: an argument compiled, with its expression. */
  def arg(e: Expr): Node = compile(e)
  def numberArg(e: Expr): Node = number(e)
  def textArg(e: Expr): Node = text(e)
  def timeArg(e: Expr): Node = {
    val n = compile(e)
    n.tpe match {
      case Some(TIMESTAMP) | None => n
      case Some(STRING)           => timeLiteral(e, n) match { case t if t.tpe.contains(TIMESTAMP) => t; case _ => throw ExprError(s"${said(e)} is text, not a time; read it with try_cast(${said(e)} AS timestamp)", e.at) }
      case other                  => throw ExprError(s"${said(e)} is ${typeName(other)}, not a time", e.at)
    }
  }
  def commonOf(args: List[Expr], at: Int): (List[Node], Option[AttributeType]) = {
    val nodes = args.map(compile)
    val tpe = common(args.zip(nodes), at)
    (nodes, tpe)
  }
  def widened(n: Node, to: Option[AttributeType]): Env => Any = widen(n, to)
  def zoneOfTimes: ZoneId = zone
}

/** Values at run time: comparison, display, casts and LIKE. */
object Values {
  def compare(a: Any, b: Any): Int =
    (a, b) match {
      case (x: java.lang.Long, y: java.lang.Long)       => java.lang.Long.compare(x, y)
      case (x: java.lang.Integer, y: java.lang.Integer) => Integer.compare(x, y)
      case (x: Number, y: Number) =>
        if ((x.isInstanceOf[java.lang.Long] || x.isInstanceOf[Integer]) && (y.isInstanceOf[java.lang.Long] || y.isInstanceOf[Integer]))
          java.lang.Long.compare(x.longValue, y.longValue)
        else java.lang.Double.compare(x.doubleValue, y.doubleValue)
      case (x: String, y: String)                       => x.compareTo(y)
      case (x: Timestamp, y: Timestamp)                 => x.compareTo(y)
      case (x: java.lang.Boolean, y: java.lang.Boolean) => java.lang.Boolean.compare(x, y)
      case (x, y)                                       => String.valueOf(x).compareTo(String.valueOf(y))
    }

  def show(v: Any): String =
    v match {
      case null                => "null"
      case d: java.lang.Double =>
        val x = d.doubleValue
        if (x == math.rint(x) && !x.isInfinite && math.abs(x) < 1e15) x.toLong.toString else x.toString
      case t: Timestamp        => t.toString
      case other               => other.toString
    }

  def cast(v: Any, to: AttributeType): Any =
    to match {
      case AttributeType.STRING => show(v)
      case AttributeType.BOOLEAN =>
        v match {
          case b: java.lang.Boolean => b
          case n: Number            => java.lang.Boolean.valueOf(n.doubleValue != 0)
          case s: String =>
            s.trim.toLowerCase match {
              case "true" | "t" | "yes" | "y" | "1"  => java.lang.Boolean.TRUE
              case "false" | "f" | "no" | "n" | "0" => java.lang.Boolean.FALSE
              case _                                => throw new IllegalArgumentException(s)
            }
          case other => throw new IllegalArgumentException(String.valueOf(other))
        }
      case AttributeType.TIMESTAMP => AttributeTypeUtils.parseTimestamp(v)
      case AttributeType.INTEGER =>
        v match {
          case n: Number => java.lang.Integer.valueOf(Math.toIntExact(Math.round(n.doubleValue)))
          case s: String => java.lang.Integer.valueOf(BigDecimal(s.trim).toIntExact)
          case b: java.lang.Boolean => java.lang.Integer.valueOf(if (b) 1 else 0)
          case other => throw new IllegalArgumentException(String.valueOf(other))
        }
      case AttributeType.LONG =>
        v match {
          case t: Timestamp => java.lang.Long.valueOf(t.getTime)
          case n: Number    => java.lang.Long.valueOf(Math.round(n.doubleValue))
          case s: String    => java.lang.Long.valueOf(BigDecimal(s.trim).toLongExact)
          case b: java.lang.Boolean => java.lang.Long.valueOf(if (b) 1L else 0L)
          case other        => throw new IllegalArgumentException(String.valueOf(other))
        }
      case AttributeType.DOUBLE =>
        v match {
          case n: Number => java.lang.Double.valueOf(n.doubleValue)
          case s: String => java.lang.Double.valueOf(s.trim.toDouble)
          case b: java.lang.Boolean => java.lang.Double.valueOf(if (b) 1.0 else 0.0)
          case other     => throw new IllegalArgumentException(String.valueOf(other))
        }
      case other => throw new IllegalArgumentException(s"cannot cast to $other")
    }

  /** SQL LIKE: % is any run of characters, _ is one character; everything else is itself. */
  def like(s: String, pattern: String): Boolean = {
    val regex = new StringBuilder
    pattern.foreach {
      case '%' => regex ++= ".*"
      case '_' => regex += '.'
      case c   => regex ++= java.util.regex.Pattern.quote(c.toString)
    }
    s.matches(regex.toString)
  }

  def zoned(t: Timestamp, zone: ZoneId): ZonedDateTime = Instant.ofEpochMilli(t.getTime).atZone(zone)

  def truncate(t: Timestamp, unit: String, zone: ZoneId): Timestamp = {
    val z = zoned(t, zone)
    val cut = unit match {
      case "second" => z.truncatedTo(ChronoUnit.SECONDS)
      case "minute" => z.truncatedTo(ChronoUnit.MINUTES)
      case "hour"   => z.truncatedTo(ChronoUnit.HOURS)
      case "day"    => z.truncatedTo(ChronoUnit.DAYS)
      case "week"   => z.truncatedTo(ChronoUnit.DAYS).minusDays((z.getDayOfWeek.getValue - 1).toLong)
      case "month"  => z.truncatedTo(ChronoUnit.DAYS).withDayOfMonth(1)
      case "year"   => z.truncatedTo(ChronoUnit.DAYS).withDayOfYear(1)
    }
    new Timestamp(cut.toInstant.toEpochMilli)
  }
}
