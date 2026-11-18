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

import org.apache.texera.amber.core.storage.model.LinkDocument

/**
  * What an operator reads from outside the run: what its plan states ([[OperatorInputs]]), handed
  * to its executor beside its descriptor. An executor reads nothing from outside the run but
  * through this, so it reads only what its plan was made with.
  *
  * @param linkEndpoints the object-store endpoints the unit reads links from; a link that points
  *                      anywhere else is refused
  */
final class ExecutorInputs(inputs: OperatorInputs, linkEndpoints: Seq[String]) {

  private lazy val files: Map[String, InputFile] =
    inputs.files.map(file => file.name -> file).toMap

  /** Whether the plan links a file under `name`. */
  def hasFile(name: String): Boolean = files.contains(name)

  /**
    * Opens the file the executor knows as `name`, through the plan's link to it.
    *
    * @throws IllegalStateException    if the plan links no file under that name
    * @throws IllegalArgumentException if the link points at none of the unit's endpoints
    */
  def open(name: String): LinkDocument = {
    val file = files.getOrElse(
      name,
      throw new IllegalStateException(
        s"The operator has no link to $name: its plan was not made to run."
      )
    )
    new LinkDocument(file.link, name, linkEndpoints)
  }

  /** The files the operator lists; None when its plan gives it no listing. */
  def listing: Option[Seq[String]] = inputs.listing.map(_.files)

  /** The most columns a row of a CSV file may have; None when its plan gives no limit. */
  def csvParserMaxColumns: Option[Int] = inputs.csvParserMaxColumns
}

object ExecutorInputs {

  /** The inputs of an operator that reads nothing from outside the run. */
  val none: ExecutorInputs = new ExecutorInputs(OperatorInputs.defaultInstance, Seq.empty)
}
