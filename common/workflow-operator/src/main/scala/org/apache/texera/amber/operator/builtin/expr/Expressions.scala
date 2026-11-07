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

import org.apache.texera.amber.core.tuple.{AttributeType, Schema, Tuple}

/** A condition over a row, as `filter` keeps rows: only where it is true (not false, not NULL). */
final class Condition private[expr] (node: Node) {
  private val env = new Env
  def holds(row: Tuple): Boolean = { env.row = row; node.eval(env) == java.lang.Boolean.TRUE }
}

/** A value computed from a row, with the type of the column it makes. */
final class Computed private[expr] (node: Node) {
  private val env = new Env
  val tpe: AttributeType = node.tpe.getOrElse(AttributeType.STRING)
  def apply(row: Tuple): Any = { env.row = row; node.eval(env) }
}

/**
  * An output of `aggregate`: an expression whose aggregate calls are computed per group, such
  * as `avg(glucose)` or `count_if(glucose < 70) / count(*)`.
  */
final class Aggregated private[expr] (node: Node, specs: List[AggregateSpec]) {
  val tpe: AttributeType = node.tpe.getOrElse(AttributeType.STRING)
  /** A group's states, one per aggregate call. */
  def newStates(): Array[AggregateState] = specs.map(_.newState()).toArray
  def add(states: Array[AggregateState], row: Tuple, env: Env): Unit = {
    env.row = row
    var i = 0
    while (i < states.length) { states(i).add(env); i += 1 }
  }
  def result(states: Array[AggregateState]): Any = {
    val env = new Env
    env.aggregates = states.map(_.result)
    node.eval(env)
  }
}

/**
  * The expression language's entry points. Each reads an expression over a table's columns,
  * checks it, and gives what runs on each row; anything wrong is an `ExprError` that says what
  * and where.
  */
object Expressions {

  def condition(text: String, input: Schema): Condition = {
    val node = new Compiler(input, aggregatesAllowed = false).compile(Parser.parse(text))
    if (node.tpe.exists(_ != AttributeType.BOOLEAN))
      throw ExprError("this is a value, not a condition: compare it with something, as in glucose < 70", 0)
    new Condition(node)
  }

  def value(text: String, input: Schema): Computed =
    new Computed(new Compiler(input, aggregatesAllowed = false).compile(Parser.parse(text)))

  def aggregate(text: String, input: Schema): Aggregated = {
    val compiler = new Compiler(input, aggregatesAllowed = true)
    val node = compiler.compile(Parser.parse(text))
    if (compiler.aggregates.isEmpty)
      throw ExprError("an output of aggregate needs an aggregate, such as count(*), avg(x) or max(x)", 0)
    new Aggregated(node, compiler.aggregates.toList)
  }
}
