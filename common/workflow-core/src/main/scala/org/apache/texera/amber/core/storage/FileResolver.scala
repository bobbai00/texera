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

package org.apache.texera.amber.core.storage

import java.io.FileNotFoundException
import java.net.URI
import java.nio.file.{Files, Paths}
import scala.util.Try

/**
  * Turns the file name an operator was configured with into a URI the engine can read.
  *
  * The engine keeps no catalog of its own. Dataset files reach it already resolved: the catalog
  * rewrites `dataset://<rid>@<version>/<path>` references into presigned URLs before it hands a
  * plan to a unit. What is left to resolve here is a URI with a scheme, kept as is, or a path
  * on the unit's own file system, used by local development and tests.
  */
object FileResolver {

  /**
    * @throws FileNotFoundException when the name is neither a URI nor an existing local file;
    *                               the message says how datasets are meant to arrive
    */
  def resolve(fileName: String): URI = {
    if (isFileResolved(fileName)) return new URI(fileName)
    Option(fileName)
      .map(_.trim)
      .filter(_.nonEmpty)
      .flatMap(name => Try(Paths.get(name)).toOption)
      .filter(Files.exists(_))
      .map(_.toUri)
      .getOrElse(
        throw new FileNotFoundException(
          s"$fileName is not a file on this unit. Dataset files are read through the catalog: " +
            "use dataset://<rid>@<version>/<path>, which the catalog resolves before the run."
        )
      )
  }

  /** Whether the name is already a URI (it has a scheme of more than one letter, unlike `C:`). */
  def isFileResolved(filePath: String): Boolean =
    Try(new URI(filePath)).toOption.exists(uri => uri.getScheme != null && uri.getScheme.length > 1)
}
