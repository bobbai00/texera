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

package org.apache.texera.amber.operator.source.scan

import com.fasterxml.jackson.annotation.JsonProperty
import org.apache.texera.amber.core.storage.InputLink
import org.apache.texera.amber.core.storage.model.LinkDocument
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.metadata.annotations.SetByCompiler

/**
  * A descriptor whose executor reads files from outside the run. The executor reads each file
  * through the link the plan carries for it ([[inputLinks]]), and through nothing else: it asks
  * no service where a file is or whether its user may read it, so it reads only the files the
  * compiler linked when it made the plan to run.
  */
trait ReadsInputFiles { this: LogicalOp =>

  /**
    * The link to each file the executor reads, by the name the executor knows the file by. A
    * compile that makes a plan to run sets it, to the files it resolved for the plan's user. Any
    * other compile leaves it empty, and no compile keeps a link the operator arrived with.
    */
  @JsonProperty("inputLinks")
  @SetByCompiler
  var inputLinks: Map[String, InputLink] = Map.empty

  /**
    * Opens the file the executor knows as `name`, for the executor to read.
    *
    * @throws IllegalStateException    if the plan carries no link to the file
    * @throws IllegalArgumentException if the link does not point at the object store
    */
  def openInputFile(name: String): LinkDocument =
    new LinkDocument(
      inputLinks.getOrElse(
        name,
        throw new IllegalStateException(
          s"${operatorInfo.userFriendlyName} has no link to $name: its plan was not made to run."
        )
      ),
      name
    )
}
