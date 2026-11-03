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

import scala.reflect.{ClassTag, classTag}

class WebsocketInput(errorHandler: Throwable => Unit) {
  private val wsInput = PublishSubject.create[(TexeraWebSocketRequest, Option[String])]()

  def subscribe[T <: TexeraWebSocketRequest: ClassTag](
      callback: (T, Option[String]) => Unit
  ): Disposable = {
    wsInput.subscribe((evt: (TexeraWebSocketRequest, Option[String])) => {
      evt._1 match {
        case req: T if classTag[T].runtimeClass.isInstance(req) =>
          try {
            callback(req, evt._2)
          } catch {
            case throwable: Throwable =>
              errorHandler(throwable)
          }
        case other =>
        // skip this one because it doesn't match the type we want
      }
    })
  }

  /** @param subjectOpt the token subject of the caller who sent the request */
  def onNext(req: TexeraWebSocketRequest, subjectOpt: Option[String]): Unit = {
    wsInput.onNext((req, subjectOpt))
  }

}
