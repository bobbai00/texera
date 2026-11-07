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

/**
  * The expression language of the built-in operators: a small part of SQL, enough for
  * conditions (`filter`), computed columns (`compute`) and aggregates (`aggregate`).
  *
  *   expr      := or
  *   or        := and (OR and)*
  *   and       := not (AND not)*
  *   not       := NOT not | predicate
  *   predicate := sum [compare sum | IS [NOT] NULL | [NOT] IN (expr, ...)
  *                     | [NOT] BETWEEN sum AND sum | [NOT] LIKE sum]
  *   sum       := product (('+' | '-' | '||') product)*
  *   product   := unary (('*' | '/' | '%') unary)*
  *   unary     := ('-' | '+') unary | primary
  *   primary   := number | 'text' | TRUE | FALSE | NULL | column | "quoted column"
  *              | name '(' [DISTINCT] (* | expr, ...) ')' | CASE ... END
  *              | CAST '(' expr AS type ')' | TRY_CAST '(' expr AS type ')' | '(' expr ')'
  *
  * Every node keeps where it starts in the text, so an error can point at it.
  */
sealed trait Expr { def at: Int }

object Expr {
  final case class Literal(value: Any, at: Int) extends Expr
  final case class Column(name: String, quoted: Boolean, at: Int) extends Expr
  final case class Unary(op: String, operand: Expr, at: Int) extends Expr
  final case class Binary(op: String, left: Expr, right: Expr, at: Int) extends Expr
  final case class IsNull(operand: Expr, negated: Boolean, at: Int) extends Expr
  final case class In(operand: Expr, options: List[Expr], negated: Boolean, at: Int) extends Expr
  final case class Between(operand: Expr, low: Expr, high: Expr, negated: Boolean, at: Int)
      extends Expr
  final case class Like(operand: Expr, pattern: Expr, negated: Boolean, at: Int) extends Expr
  final case class Case(whens: List[(Expr, Expr)], otherwise: Option[Expr], at: Int)
      extends Expr
  final case class Cast(operand: Expr, to: String, safe: Boolean, at: Int) extends Expr
  final case class Call(name: String, args: List[Expr], star: Boolean, distinct: Boolean, at: Int)
      extends Expr
}

/**
  * What is wrong with an expression, and where: `at` is the offset in its text. The message is
  * written for the person or agent who wrote the expression, in their terms.
  */
final case class ExprError(message: String, at: Int) extends RuntimeException(message)
