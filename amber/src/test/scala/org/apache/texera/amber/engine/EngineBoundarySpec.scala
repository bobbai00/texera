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
  * What the engine runs a plan without. Checked on the compiled classes of
  * `org.apache.texera.amber.engine`: a class file names every class and method its code uses,
  * however the source spells it.
  */
class EngineBoundarySpec extends AnyFlatSpec {

  /** Each class of the engine, by its file's path in the package, with its bytes as text. */
  private val engineClasses: Map[String, String] = {
    // Where the engine's own classes are, apart from those of its specs.
    val classes =
      Paths.get(classOf[Coordinator].getProtectionDomain.getCodeSource.getLocation.toURI)
    val engine = classes.resolve("org/apache/texera/amber/engine")
    assert(Files.isDirectory(engine), s"the engine's classes are not in a directory: $classes")
    Using.resource(Files.walk(engine)) { files =>
      files
        .iterator()
        .asScala
        .filter(_.toString.endsWith(".class"))
        .map { file: Path =>
          engine.relativize(file).toString ->
            new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1)
        }
        .toMap
    }
  }

  private def classesNaming(name: String): Seq[String] =
    engineClasses.collect { case (file, bytes) if bytes.contains(name) => file }.toSeq.sorted

  "The engine" should "make up no location for a port, which its plan names" in {
    assert(engineClasses.size > 500, "too few classes for the engine's: were they found?")
    // What names a port's location when a plan is made.
    Seq("createPortBaseURI", "withStorageLocations").foreach { naming =>
      assert(classesNaming(naming).isEmpty, s"$naming is used in the engine")
    }
  }
}
