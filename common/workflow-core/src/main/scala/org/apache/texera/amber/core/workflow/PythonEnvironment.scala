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

package org.apache.texera.amber.core.workflow

/**
  * A Python environment as a plan made to run carries it: the packages a computing unit installs,
  * beside the engine's own, for the workers of the operators that run in it.
  *
  * It holds only what pip may read: every requirement is a canonical line of
  * [[PythonRequirements]], and the lines are sorted, each once. So a value of this type is written
  * to a requirements file as it is, wherever it came from.
  *
  * @param name         what the plan's user calls the environment, which its operators ask for
  *                     it by
  * @param requirements the packages, as canonical requirement lines ("tabulate==0.9.0")
  * @throws IllegalArgumentException if the name is blank, a line is not a canonical requirement
  *                                  line, or the lines are not sorted, each once
  */
final case class PythonEnvironment(name: String, requirements: Seq[String]) {
  PythonEnvironment
    .problemOf(name, requirements)
    .foreach(problem => throw new IllegalArgumentException(problem))

  /**
    * Names the package list ([[PythonRequirements.digest]]): two environments that ask for the
    * same packages have one digest, whatever they are called.
    */
  val digest: String = PythonRequirements.digest(requirements)
}

object PythonEnvironment {

  /** Why `requirements` under `name` are no environment, if they are none. */
  private def problemOf(name: String, requirements: Seq[String]): Option[String] =
    if (name == null || name.trim.isEmpty) Some("A Python environment needs a name.")
    else
      requirements.iterator
        .flatMap(line => PythonRequirements.validateLine(line).left.toOption)
        .nextOption()
        .map(problem => s"Python environment '$name' cannot be installed: $problem")
        .orElse(
          Option.when(requirements != requirements.distinct.sorted)(
            s"The requirements of Python environment '$name' are not sorted, each once: " +
              requirements.mkString(", ")
          )
        )
}

/**
  * The Python environment the workers of an operator run in.
  *
  * An operator asks for an environment by its name. The compile that makes a plan to run resolves
  * the name, for the plan's user, to what the environment holds then, and the plan carries that:
  * the computing unit that runs the plan installs what the plan says, and asks nobody what a name
  * stands for.
  */
sealed trait PythonEnvironmentRef extends Product with Serializable {

  /** The name the operator asks for its environment by; None for the engine's own. */
  def environmentName: Option[String]
}

object PythonEnvironmentRef {

  /** The engine's own interpreter, with the packages the engine has: an operator's by default. */
  case object EngineDefault extends PythonEnvironmentRef {
    override val environmentName: Option[String] = None
  }

  /**
    * The environment the plan's user keeps under `name`, as an operator asks for it. Only a
    * compile that makes a plan to run resolves it; nothing saves or runs an operator that still
    * names one.
    */
  final case class Named(name: String) extends PythonEnvironmentRef {
    override def environmentName: Option[String] = Some(name)
  }

  /** What an environment held when a plan made to run resolved it. */
  final case class Resolved(environment: PythonEnvironment) extends PythonEnvironmentRef {
    override def environmentName: Option[String] = Some(environment.name)
  }
}
