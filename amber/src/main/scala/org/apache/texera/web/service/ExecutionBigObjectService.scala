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

package org.apache.texera.web.service

import org.apache.amber.engine.architecture.rpc.controlcommands.BigObjectEvent
import org.apache.amber.engine.common.client.AmberClient
import org.apache.texera.web.SubscriptionManager
import org.apache.texera.web.model.websocket.event.BigObjectUpdateEvent
import org.apache.texera.web.storage.ExecutionStateStore

/**
  * Forwards BigObjectEvent messages from workers to frontend via websocket.
  */
class ExecutionBigObjectService(
    client: AmberClient,
    stateStore: ExecutionStateStore
) extends SubscriptionManager {

  addSubscription(
    client.registerCallback[BigObjectEvent](evt => stateStore.bigObjectStore.updateState(_ :+ evt))
  )

  addSubscription(
    stateStore.bigObjectStore.registerDiffHandler((oldEvents, newEvents) =>
      newEvents.diff(oldEvents) match {
        case diff if diff.nonEmpty => Seq(BigObjectUpdateEvent(diff))
        case _                     => Seq.empty
      }
    )
  )
}
