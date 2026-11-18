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

package org.apache.texera.amber.engine

import org.apache.texera.amber.engine.architecture.coordinator.Coordinator
import org.scalatest.flatspec.AnyFlatSpec

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path, Paths}
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.Using

/**
  * What the engine runs a plan without, and what the module the engine is built in holds none
  * of. Checked on the module's compiled classes, those of `org.apache.texera.amber.engine`
  * among them: a class file names every class and method its code uses, however the source
  * spells it.
  */
class EngineBoundarySpec extends AnyFlatSpec {

  // Where the module's own classes are, apart from those of its specs.
  private val moduleRoot: Path =
    Paths.get(classOf[Coordinator].getProtectionDomain.getCodeSource.getLocation.toURI)

  /** Each class under `directory`, by its file's path in it, with its bytes as text. */
  private def classesUnder(directory: Path): Map[String, String] = {
    assert(Files.isDirectory(directory), s"the classes are not in a directory: $directory")
    Using.resource(Files.walk(directory)) { files =>
      files
        .iterator()
        .asScala
        .filter(_.toString.endsWith(".class"))
        .map { file: Path =>
          directory.relativize(file).toString ->
            new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1)
        }
        .toMap
    }
  }

  /** Each class of the engine, by its file's path in the package. */
  private val engineClasses: Map[String, String] =
    classesUnder(moduleRoot.resolve("org/apache/texera/amber/engine"))

  /**
    * Each class of the module: the engine's, the computing unit's and the Dashboard service's,
    * by its file's path from the module's root.
    */
  private val moduleClasses: Map[String, String] = classesUnder(moduleRoot)

  private def classesNaming(
      name: String,
      classes: Map[String, String] = engineClasses
  ): Seq[String] =
    classes.collect { case (file, bytes) if bytes.contains(name) => file }.toSeq.sorted

  "The engine" should "make up no location for a port, which its plan names" in {
    assert(engineClasses.size > 500, "too few classes for the engine's: were they found?")
    // What names a port's location when a plan is made.
    Seq("createPortBaseURI", "withStorageLocations").foreach { naming =>
      assert(classesNaming(naming).isEmpty, s"$naming is used in the engine")
    }
  }

  it should "use nothing of the compiler: it runs a plan that was made before it starts" in {
    assert(engineClasses.size > 500, "too few classes for the engine's: were they found?")
    // The compiler's package, as a class file names a class and as a string names one.
    Seq("org/apache/texera/common/compiler", "org.apache.texera.common.compiler").foreach {
      compiler =>
        val naming = classesNaming(compiler)
        assert(naming.isEmpty, s"the engine uses the compiler in ${naming.mkString(", ")}")
    }
  }

  "The engine's module" should
    "use nothing of the compiler: the compiling service compiles for the Dashboard" in {
    // The engine's classes, and as many again of the unit's and the Dashboard's.
    assert(moduleClasses.size > 1000, "too few classes for the module's: were they found?")
    assert(
      moduleClasses.keys.exists(_.endsWith("ExecutionCreator.class")) &&
        moduleClasses.keys.exists(_.endsWith("OperatorUpdates.class")),
      "the Dashboard's classes are not among the module's: were they found?"
    )
    Seq("org/apache/texera/common/compiler", "org.apache.texera.common.compiler").foreach {
      compiler =>
        val naming = classesNaming(compiler, moduleClasses)
        assert(naming.isEmpty, s"the module uses the compiler in ${naming.mkString(", ")}")
    }
  }

  it should "be built without the compiler, which only its specs depend on" in {
    // The build's own word for it: the module's line of dependencies names no compiler, and
    // the one line that does gives it to the specs alone.
    val build = new String(
      Files.readAllBytes(Paths.get(sys.env.getOrElse("TEXERA_HOME", ".")).resolve("build.sbt")),
      StandardCharsets.UTF_8
    )
    val module = build
      .split("\n")
      .dropWhile(!_.startsWith("lazy val WorkflowExecutionService"))
      .drop(1)
      .takeWhile(!_.startsWith("lazy val"))
    assert(module.nonEmpty, "the module's definition was not found in build.sbt")
    val naming = module.filter(_.contains("WorkflowCompiler")).map(_.trim).toSeq
    assert(naming.size == 1 && naming.head.startsWith(".dependsOn(WorkflowCompiler % \"test->"))
  }
}
