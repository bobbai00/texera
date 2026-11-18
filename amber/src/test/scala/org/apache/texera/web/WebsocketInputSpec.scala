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

import org.apache.texera.web.model.websocket.request.{
  HeartBeatRequest,
  TexeraWebSocketRequest,
  WorkflowKillRequest
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.util.concurrent.atomic.AtomicReference
import scala.collection.mutable

class WebsocketInputSpec extends AnyFlatSpec with Matchers {

  "subscribe" should "deliver requests whose runtime class matches T" in {
    val input = new WebsocketInput()
    val received = mutable.ListBuffer.empty[(HeartBeatRequest, Option[Integer])]
    val sub = input.subscribe[HeartBeatRequest]((req, uid) => received += ((req, uid)))
    try {
      val req = HeartBeatRequest()
      input.onNext(req, Some(7))
      received.toList shouldBe List((req, Some(7)))
    } finally sub.dispose()
  }

  it should "silently drop requests that do not match T" in {
    val input = new WebsocketInput()
    val received = mutable.ListBuffer.empty[TexeraWebSocketRequest]
    val sub = input.subscribe[HeartBeatRequest]((req, _) => received += req)
    try {
      input.onNext(WorkflowKillRequest(1L), None)
      input.onNext(WorkflowKillRequest(1L), Some(1))
      received shouldBe empty
    } finally sub.dispose()
  }

  it should "pass through uidOpt verbatim, including None" in {
    val input = new WebsocketInput()
    val seenUids = mutable.ListBuffer.empty[Option[Integer]]
    val sub = input.subscribe[HeartBeatRequest]((_, uid) => seenUids += uid)
    try {
      input.onNext(HeartBeatRequest(), None)
      input.onNext(HeartBeatRequest(), Some(42))
      // Integer is a Java boxed type; compare via .map(_.intValue) to
      // avoid hinging on Integer identity.
      seenUids.map(_.map(_.intValue)).toList shouldBe List(None, Some(42))
    } finally sub.dispose()
  }

  "onNext" should "throw what a handler throws to whoever handed the request in" in {
    val input = new WebsocketInput()
    val boom = new RuntimeException("boom")
    val sub = input.subscribe[HeartBeatRequest]((_, _) => throw boom)
    try {
      (the[RuntimeException] thrownBy input.onNext(
        HeartBeatRequest(),
        None
      )) should be theSameInstanceAs boom
      // A request no handler fails on throws nothing.
      noException should be thrownBy input.onNext(WorkflowKillRequest(1L), None)
    } finally sub.dispose()
  }

  it should "hand the request to every handler before it throws, and keep the one that threw subscribed" in {
    val input = new WebsocketInput()
    val survivorCount = new AtomicReference[Int](0)
    val thrown = new AtomicReference[Int](0)
    val throwingSub = input.subscribe[HeartBeatRequest]((_, _) => {
      thrown.updateAndGet(_ + 1)
      throw new IllegalStateException("nope")
    })
    val survivorSub = input.subscribe[HeartBeatRequest]((_, _) => survivorCount.updateAndGet(_ + 1))
    try {
      an[IllegalStateException] should be thrownBy input.onNext(HeartBeatRequest(), None)
      an[IllegalStateException] should be thrownBy input.onNext(HeartBeatRequest(), None)
      survivorCount.get() shouldBe 2
      thrown.get() shouldBe 2
    } finally {
      throwingSub.dispose()
      survivorSub.dispose()
    }
  }

  it should "throw the first failure when more than one handler fails" in {
    val input = new WebsocketInput()
    val first =
      input.subscribe[HeartBeatRequest]((_, _) => throw new IllegalStateException("first"))
    val second =
      input.subscribe[HeartBeatRequest]((_, _) => throw new IllegalArgumentException("second"))
    try {
      the[IllegalStateException] thrownBy input.onNext(HeartBeatRequest(), None) should have message
        "first"
    } finally {
      first.dispose()
      second.dispose()
    }
  }

  "subscribe" should "stop delivering events after the returned Disposable is disposed" in {
    val input = new WebsocketInput()
    val count = new AtomicReference[Int](0)
    val sub = input.subscribe[HeartBeatRequest]((_, _) => count.updateAndGet(_ + 1))
    input.onNext(HeartBeatRequest(), None)
    sub.dispose()
    input.onNext(HeartBeatRequest(), None)
    input.onNext(HeartBeatRequest(), None)
    count.get() shouldBe 1
  }
}
