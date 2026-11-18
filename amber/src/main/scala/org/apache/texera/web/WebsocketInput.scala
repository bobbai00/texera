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

package org.apache.texera.web

import io.reactivex.rxjava3.disposables.Disposable
import io.reactivex.rxjava3.subjects.PublishSubject
import org.apache.texera.web.model.websocket.request.TexeraWebSocketRequest

import scala.collection.mutable
import scala.reflect.{ClassTag, classTag}

/**
  * The requests sessions make of one run, handed to whichever of the run's services subscribed
  * to their type. A request one of them fails on is its sender's to hear of, not the run's
  * failure: what a handler throws is thrown to whoever handed the request in, once every handler
  * has seen it.
  */
class WebsocketInput {
  private case class Asked(
      request: TexeraWebSocketRequest,
      uid: Option[Integer],
      failures: mutable.Buffer[Throwable]
  )

  private val wsInput = PublishSubject.create[Asked]()

  def subscribe[T <: TexeraWebSocketRequest: ClassTag](
      callback: (T, Option[Integer]) => Unit
  ): Disposable = {
    wsInput.subscribe((asked: Asked) => {
      asked.request match {
        case req: T if classTag[T].runtimeClass.isInstance(req) =>
          // Kept out of the subject, which would end the subscription of a handler that throws.
          try {
            callback(req, asked.uid)
          } catch {
            case throwable: Throwable => asked.failures += throwable
          }
        case other =>
        // skip this one because it doesn't match the type we want
      }
    })
  }

  /**
    * Hands `req` to its handlers, on the calling thread.
    *
    * @throws Throwable what the first handler to fail threw
    */
  def onNext(req: TexeraWebSocketRequest, uidOpt: Option[Integer]): Unit = {
    val failures = mutable.ListBuffer.empty[Throwable]
    wsInput.onNext(Asked(req, uidOpt, failures))
    failures.headOption.foreach(throw _)
  }

}
