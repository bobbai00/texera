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

package org.apache.texera.web.storage

import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}

import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import scala.jdk.CollectionConverters.ConcurrentMapHasAsScala

/**
  * Where the results of one run are: the result URI of each output port whose storage the run's
  * engine has made, as the engine reports it. Kept in memory, so the computing unit that holds
  * the run finds the run's results without asking anyone.
  */
class ResultUris {

  private val byPort = new ConcurrentHashMap[GlobalPortIdentity, URI]()

  /** The engine made the storage of output port `port`: its result is at `uri`. */
  def add(port: GlobalPortIdentity, uri: URI): Unit = byPort.put(port, uri)

  /** The result URI of every output port whose storage was made, by port. */
  def all: Map[GlobalPortIdentity, URI] = byPort.asScala.toMap

  /**
    * The result of output port `portId` of logical operator `operatorId`, an external port of
    * one of its physical operators. None until the engine has made the port's storage, and for
    * a port whose results are not stored.
    */
  def of(operatorId: OperatorIdentity, portId: PortIdentity): Option[URI] =
    byPort.asScala.collectFirst {
      case (port, uri)
          if !port.portId.internal && port.opId.logicalOpId == operatorId &&
            port.portId == portId =>
        uri
    }
}
