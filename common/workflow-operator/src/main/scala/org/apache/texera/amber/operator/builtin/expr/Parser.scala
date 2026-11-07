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

import org.apache.texera.amber.operator.builtin.expr.Expr._

import scala.collection.mutable.ArrayBuffer

/** Reads an expression's text into its syntax tree (`Expr`), or says where it stops making sense. */
object Parser {

  private sealed trait Token { def at: Int }
  private final case class Word(text: String, at: Int) extends Token
  private final case class Quoted(text: String, at: Int) extends Token
  private final case class Text(text: String, at: Int) extends Token
  private final case class Number(text: String, at: Int) extends Token
  private final case class Symbol(text: String, at: Int) extends Token
  private final case class End(at: Int) extends Token

  private val symbols = List("||", "<=", ">=", "<>", "!=", "==", "(", ")", ",", "+", "-", "*", "/", "%", "=", "<", ">")

  private def tokenize(text: String): Vector[Token] = {
    val out = ArrayBuffer[Token]()
    var i = 0
    while (i < text.length) {
      val c = text.charAt(i)
      if (c.isWhitespace) i += 1
      else if (c.isLetter || c == '_') {
        val start = i
        while (i < text.length && (text.charAt(i).isLetterOrDigit || text.charAt(i) == '_')) i += 1
        out += Word(text.substring(start, i), start)
      } else if (c.isDigit || (c == '.' && i + 1 < text.length && text.charAt(i + 1).isDigit)) {
        val start = i
        while (i < text.length && (text.charAt(i).isDigit || text.charAt(i) == '.')) i += 1
        if (i < text.length && (text.charAt(i) == 'e' || text.charAt(i) == 'E')) {
          i += 1
          if (i < text.length && (text.charAt(i) == '+' || text.charAt(i) == '-')) i += 1
          while (i < text.length && text.charAt(i).isDigit) i += 1
        }
        out += Number(text.substring(start, i), start)
      } else if (c == '\'' || c == '"') {
        val start = i
        val sb = new StringBuilder
        i += 1
        var closed = false
        while (i < text.length && !closed) {
          if (text.charAt(i) == c) {
            if (i + 1 < text.length && text.charAt(i + 1) == c) { sb += c; i += 2 }
            else { closed = true; i += 1 }
          } else { sb += text.charAt(i); i += 1 }
        }
        if (!closed)
          throw ExprError(
            if (c == '\'') "this text is not closed: add a ' at its end" else "this name is not closed: add a \" at its end",
            start
          )
        out += (if (c == '\'') Text(sb.toString, start) else Quoted(sb.toString, start))
      } else {
        symbols.find(s => text.startsWith(s, i)) match {
          case Some(s) => out += Symbol(s, i); i += s.length
          case None    => throw ExprError(s"'$c' has no meaning here", i)
        }
      }
    }
    out += End(text.length)
    out.toVector
  }

  /** Reads an expression; an empty one, or one with text left over, is an error. */
  def parse(text: String): Expr = {
    if (text == null || text.trim.isEmpty) throw ExprError("an expression is needed here", 0)
    val p = new Reader(tokenize(text))
    val e = p.expr()
    p.peek match {
      case End(_) => e
      case t      => throw ExprError(s"${describe(t)} does not belong here", t.at)
    }
  }

  private def describe(t: Token): String =
    t match {
      case Word(w, _)   => s"'$w'"
      case Quoted(q, _) => s"\"$q\""
      case Text(s, _)   => s"'$s'"
      case Number(n, _) => n
      case Symbol(s, _) => s"'$s'"
      case End(_)       => "the end"
    }

  private final class Reader(tokens: Vector[Token]) {
    private var pos = 0
    def peek: Token = tokens(pos)
    private def next(): Token = { val t = tokens(pos); pos += 1; t }
    private def isWord(t: Token, w: String) = t match { case Word(x, _) => x.equalsIgnoreCase(w); case _ => false }
    private def isSymbol(t: Token, s: String) = t match { case Symbol(x, _) => x == s; case _ => false }
    private def acceptWord(w: String): Boolean = if (isWord(peek, w)) { pos += 1; true } else false
    private def acceptSymbol(s: String): Boolean = if (isSymbol(peek, s)) { pos += 1; true } else false
    private def expectSymbol(s: String, what: String): Unit =
      if (!acceptSymbol(s)) throw ExprError(s"expected '$s' $what, found ${describe(peek)}", peek.at)
    private def expectWord(w: String, what: String): Unit =
      if (!acceptWord(w)) throw ExprError(s"expected ${w.toUpperCase} $what, found ${describe(peek)}", peek.at)

    def expr(): Expr = or()

    private def or(): Expr = {
      var left = and()
      while (isWord(peek, "or")) { val at = next().at; left = Binary("or", left, and(), at) }
      left
    }

    private def and(): Expr = {
      var left = not()
      while (isWord(peek, "and")) { val at = next().at; left = Binary("and", left, not(), at) }
      left
    }

    private def not(): Expr =
      if (isWord(peek, "not")) { val at = next().at; Unary("not", not(), at) }
      else predicate()

    private def predicate(): Expr = {
      val left = sum()
      val t = peek
      t match {
        case Symbol(op @ ("=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">="), at) =>
          next()
          val normal = op match { case "==" => "="; case "!=" => "<>"; case o => o }
          Binary(normal, left, sum(), at)
        case _ if isWord(t, "is") =>
          next()
          val negated = acceptWord("not")
          expectWord("null", "after IS")
          IsNull(left, negated, t.at)
        case _ =>
          val negated = isWord(t, "not") && {
            val after = tokens(pos + 1)
            isWord(after, "in") || isWord(after, "between") || isWord(after, "like")
          }
          if (negated) next()
          if (acceptWord("in")) {
            expectSymbol("(", "after IN")
            val options = ArrayBuffer(expr())
            while (acceptSymbol(",")) options += expr()
            expectSymbol(")", "to close the IN list")
            In(left, options.toList, negated, t.at)
          } else if (acceptWord("between")) {
            val low = sum()
            expectWord("and", "between the bounds of BETWEEN")
            Between(left, low, sum(), negated, t.at)
          } else if (acceptWord("like")) Like(left, sum(), negated, t.at)
          else left
      }
    }

    private def sum(): Expr = {
      var left = product()
      var going = true
      while (going) peek match {
        case Symbol(op @ ("+" | "-" | "||"), at) => next(); left = Binary(op, left, product(), at)
        case _                                   => going = false
      }
      left
    }

    private def product(): Expr = {
      var left = unary()
      var going = true
      while (going) peek match {
        case Symbol(op @ ("*" | "/" | "%"), at) => next(); left = Binary(op, left, unary(), at)
        case _                                  => going = false
      }
      left
    }

    private def unary(): Expr =
      peek match {
        case Symbol("-", at) => next(); Unary("-", unary(), at)
        case Symbol("+", _)  => next(); unary()
        case _               => primary()
      }

    private def primary(): Expr =
      next() match {
        case Number(n, at) =>
          if (n.exists(c => c == '.' || c == 'e' || c == 'E')) Literal(java.lang.Double.valueOf(n.toDouble), at)
          else
            try Literal(java.lang.Long.valueOf(n.toLong), at)
            catch { case _: NumberFormatException => Literal(java.lang.Double.valueOf(n.toDouble), at) }
        case Text(s, at)   => Literal(s, at)
        case Quoted(q, at) => Column(q, quoted = true, at)
        case Symbol("(", _) =>
          val e = expr()
          expectSymbol(")", "to close the parenthesis")
          e
        case w @ Word(word, at) =>
          word.toLowerCase match {
            case "true"  => Literal(java.lang.Boolean.TRUE, at)
            case "false" => Literal(java.lang.Boolean.FALSE, at)
            case "null"  => Literal(null, at)
            case "case"  => caseOf(at)
            case "cast" | "try_cast" if isSymbol(peek, "(") =>
              next()
              val operand = expr()
              expectWord("as", s"in ${word.toUpperCase}(value AS type)")
              val to = next() match {
                case Word(tpe, _) => tpe.toLowerCase
                case t            => throw ExprError(s"expected a type after AS, found ${describe(t)}", t.at)
              }
              expectSymbol(")", s"to close ${word.toUpperCase}")
              Cast(operand, to, safe = word.equalsIgnoreCase("try_cast"), at)
            case _ if isSymbol(peek, "(") => call(w)
            case _                        => Column(word, quoted = false, at)
          }
        case t => throw ExprError(s"expected a value, found ${describe(t)}", t.at)
      }

    private def call(name: Word): Expr = {
      next() // (
      if (acceptSymbol(")")) return Call(name.text.toLowerCase, Nil, star = false, distinct = false, name.at)
      if (acceptSymbol("*")) {
        expectSymbol(")", s"after ${name.text}(*")
        return Call(name.text.toLowerCase, Nil, star = true, distinct = false, name.at)
      }
      val distinct = acceptWord("distinct")
      val args = ArrayBuffer(expr())
      while (acceptSymbol(",")) args += expr()
      expectSymbol(")", s"to close ${name.text}(")
      Call(name.text.toLowerCase, args.toList, star = false, distinct, name.at)
    }

    private def caseOf(at: Int): Expr = {
      val whens = ArrayBuffer[(Expr, Expr)]()
      while (acceptWord("when")) {
        val cond = expr()
        expectWord("then", "after a WHEN condition")
        whens += cond -> expr()
      }
      if (whens.isEmpty) throw ExprError("CASE needs at least one WHEN ... THEN ...", peek.at)
      val otherwise = if (acceptWord("else")) Some(expr()) else None
      expectWord("end", "to close CASE")
      Case(whens.toList, otherwise, at)
    }
  }
}
