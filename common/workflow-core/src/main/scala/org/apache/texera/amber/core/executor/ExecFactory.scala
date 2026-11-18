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

package org.apache.texera.amber.core.executor

import org.apache.texera.amber.core.state.StateReferencing

import java.lang.reflect.{InvocationTargetException, Modifier}

object ExecFactory {

  def newExecFromJavaCode(code: String): OperatorExecutor = {
    JavaRuntimeCompilation
      .compileCode(code)
      .getDeclaredConstructor()
      .newInstance()
      .asInstanceOf[OperatorExecutor]
  }

  /**
    * Builds the executor of class `className`, handing its constructor what it declares it
    * takes, in this order: the operator's descriptor (when one is given), what the operator
    * reads from outside the run, and its worker's index among how many workers.
    *
    * A sidecar's loop variables are bound to the executor's one setting (`OperatorExecutor`).
    */
  def newExecFromJavaClassName[K](
      className: String,
      descString: String = "",
      idx: Int = 0,
      workerCount: Int = 1,
      inputs: ExecutorInputs = ExecutorInputs.none
  ): OperatorExecutor = {
    val executor = instantiate[K](className, descString, idx, workerCount, inputs)
    val references = StateReferenceBinding.sidecarOf(descString)
    if (references.nonEmpty) {
      def refuse(reason: String): Nothing = {
        val named = references.toSeq.sorted.map { case (pointer, name) => s"$pointer -> $$$name" }
        throw new IllegalStateException(
          s"$className refers to loop variables (${named.mkString(", ")}), but it holds $reason"
        )
      }
      settingsHeldBy(executor) match {
        case List(setting) =>
          OperatorExecutor.bindings.put(
            executor,
            new StateReferenceBinding(className, setting, references)
          )
        case Nil => refuse("no descriptor to write them into")
        case settings =>
          refuse(s"${settings.size} descriptors, so which one is its setting is unclear")
      }
    }
    executor
  }

  /** The descriptors `executor` holds in a field of its class or a superclass, each object once. */
  private def settingsHeldBy(executor: OperatorExecutor): List[StateReferencing] =
    Iterator
      .iterate[Class[_]](executor.getClass)(_.getSuperclass)
      .takeWhile(_ != null)
      .flatMap(_.getDeclaredFields)
      .filter(field =>
        !Modifier.isStatic(field.getModifiers) &&
          classOf[StateReferencing].isAssignableFrom(field.getType)
      )
      .flatMap { field => field.setAccessible(true); Option(field.get(executor)) }
      // By identity: a descriptor's equals compares its properties.
      .foldLeft(List.empty[StateReferencing]) {
        case (held, setting: StateReferencing) if !held.exists(_ eq setting) => held :+ setting
        case (held, _)                                                       => held
      }

  /**
    * Calls the first constructor the class declares of those an executor may have: with no
    * descriptor `()` or `(Int, Int)`, and with one `(String)`, `(String, Int, Int)`,
    * `(String, ExecutorInputs)` or `(String, ExecutorInputs, Int, Int)`.
    *
    * What the constructor throws is thrown as it is. Reflection wraps it in an exception of its
    * own, which has no message: reported as the reason an operator failed, it would hide the
    * constructor's.
    *
    * @throws NoSuchMethodException if the class declares none of them
    */
  private def instantiate[K](
      className: String,
      descString: String,
      idx: Int,
      workerCount: Int,
      inputs: ExecutorInputs
  ): OperatorExecutor = {
    val clazz = Class.forName(className).asInstanceOf[Class[K]]
    val worker =
      Seq[(Class[_], AnyRef)](classOf[Int] -> Int.box(idx), classOf[Int] -> Int.box(workerCount))
    val described = Seq[(Class[_], AnyRef)](classOf[String] -> descString)
    val reading = described :+ (classOf[ExecutorInputs] -> inputs)
    val taken =
      if (descString.isEmpty) Seq(Seq.empty, worker)
      else Seq(described, described ++ worker, reading, reading ++ worker)
    val (constructor, arguments) = taken.iterator
      .flatMap { parameters =>
        try Some(clazz.getDeclaredConstructor(parameters.map(_._1): _*) -> parameters.map(_._2))
        catch { case _: NoSuchMethodException => None }
      }
      .nextOption()
      .getOrElse {
        val tried = taken.map(_.map(_._1.getSimpleName).mkString("(", ", ", ")")).mkString(", ")
        throw new NoSuchMethodException(
          s"$className has none of the constructors an executor is built with: $tried"
        )
      }
    try constructor.newInstance(arguments: _*).asInstanceOf[OperatorExecutor]
    catch {
      case thrownByConstructor: InvocationTargetException => throw thrownByConstructor.getCause
    }
  }
}
