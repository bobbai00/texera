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

package org.apache.texera.web.service.execution

import org.apache.texera.web.model.http.response.execution.CreateExecutionResponse
import org.apache.texera.web.service.execution.ComputingUnitClient.{Handover, Taken}

import java.util.concurrent.CopyOnWriteArrayList
import scala.jdk.CollectionConverters._

/**
  * An execution a suite created, with the plan the Dashboard service handed its computing unit:
  * the create answers the id alone.
  */
final case class CreatedExecution(eid: Long, plan: String)

object RecordingComputingUnits {

  /**
    * What the Dashboard service handed a computing unit.
    *
    * @param text          a plan, or a change to an operator
    * @param authorization the `Authorization` header it was handed over with
    */
  final case class Handed(cuid: Int, text: String, authorization: String)
}

/**
  * Computing units that keep what the Dashboard service hands them and answer `outcome`: the
  * units' side of a create and of a change to an operator, for a suite that runs no unit.
  *
  * @param outcome what a unit answers to what it is handed, asked at each hand-over
  */
class RecordingComputingUnits(outcome: => Handover = Taken) extends ComputingUnitClient {
  import RecordingComputingUnits.Handed

  private val startsHanded = new CopyOnWriteArrayList[Handed]()
  private val updatesHanded = new CopyOnWriteArrayList[Handed]()

  /** The plans handed over, in the order they were. */
  def starts: Seq[Handed] = startsHanded.asScala.toSeq

  /** The changes handed over, in the order they were. */
  def updates: Seq[Handed] = updatesHanded.asScala.toSeq

  /** The plan handed over for execution `eid`: the one that names it. */
  def planOf(eid: Long): Option[String] =
    starts.map(_.text).find(plan => ExecutionStart.executionNamedBy(plan).contains(eid))

  /** `response`, the answer to a create, with the plan handed over for its execution. */
  def created(response: CreateExecutionResponse): CreatedExecution =
    CreatedExecution(
      response.eid,
      planOf(response.eid).getOrElse(
        throw new NoSuchElementException(s"no plan was handed over for execution ${response.eid}")
      )
    )

  override def start(cuid: Int, plan: String, authorization: String): Handover = {
    startsHanded.add(Handed(cuid, plan, authorization))
    outcome
  }

  override def update(cuid: Int, update: String, authorization: String): Handover = {
    updatesHanded.add(Handed(cuid, update, authorization))
    outcome
  }
}
