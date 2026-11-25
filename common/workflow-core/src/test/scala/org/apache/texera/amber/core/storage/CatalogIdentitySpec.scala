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

import org.apache.texera.amber.core.storage.CatalogIdentity.{Anonymous, Executions, Platform}
import org.apache.texera.auth.CatalogTokens
import org.apache.texera.common.tags.NonParallelTest
import org.scalatest.BeforeAndAfterEach
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.util.concurrent.{CountDownLatch, Executors, TimeUnit}
import scala.concurrent.duration.DurationInt
import scala.concurrent.{Await, ExecutionContext, Future}

/**
  * Specs for [[CatalogIdentity]]. Tagged [[NonParallelTest]] so the suite gets a forked JVM of
  * its own: it switches the JVM-wide mode, which every other suite's catalog requests go by.
  * Every spec registers executions no other spec names, as registrations stay for the JVM.
  */
@NonParallelTest
class CatalogIdentitySpec extends AnyFlatSpec with Matchers with BeforeAndAfterEach {

  override def afterEach(): Unit =
    try CatalogIdentity.use(Anonymous)
    finally super.afterEach()

  "CatalogIdentity" should "be anonymous until a main says otherwise, and then carry no token" in {
    CatalogIdentity.mode shouldBe Anonymous
    CatalogIdentity.register(1, "token-1")

    CatalogIdentity.tokenFor(Some(1)) shouldBe None
    CatalogIdentity.tokenFor(None) shouldBe None
    CatalogIdentity.cacheIdentity(Some(1)) shouldBe "anonymous"
    CatalogIdentity.cacheIdentity(None) shouldBe "anonymous"
  }

  it should "carry the platform's token about every execution and about none, in Platform mode" in {
    CatalogIdentity.use(Platform)
    CatalogIdentity.register(2, "token-2")

    CatalogIdentity.mode shouldBe Platform
    CatalogIdentity.tokenFor(Some(2)) shouldBe Some(CatalogTokens.platform())
    CatalogIdentity.tokenFor(None) shouldBe Some(CatalogTokens.platform())
    CatalogIdentity.cacheIdentity(Some(2)) shouldBe "platform"
    CatalogIdentity.cacheIdentity(None) shouldBe "platform"
  }

  it should "carry the token an execution was registered with about it, in Executions mode" in {
    CatalogIdentity.use(Executions)
    CatalogIdentity.register(3, "token-3")
    CatalogIdentity.register(4, "token-4")

    CatalogIdentity.tokenFor(Some(3)) shouldBe Some("token-3")
    CatalogIdentity.tokenFor(Some(4)) shouldBe Some("token-4")
    CatalogIdentity.cacheIdentity(Some(3)) shouldBe "execution-3"
    CatalogIdentity.cacheIdentity(Some(4)) shouldBe "execution-4"
  }

  it should "carry nothing about an execution with no token, or about none, in Executions mode" in {
    CatalogIdentity.use(Executions)

    CatalogIdentity.tokenFor(Some(5)) shouldBe None
    CatalogIdentity.tokenFor(None) shouldBe None
    CatalogIdentity.cacheIdentity(Some(5)) shouldBe "execution-5"
    CatalogIdentity.cacheIdentity(None) shouldBe "anonymous"
  }

  it should "register idempotently, a later token in the place of an earlier one" in {
    CatalogIdentity.register(6, "token-6")
    CatalogIdentity.register(6, "token-6")
    CatalogIdentity.registered(6) shouldBe Some("token-6")

    CatalogIdentity.register(6, "token-6-again")
    CatalogIdentity.registered(6) shouldBe Some("token-6-again")
    CatalogIdentity.registered(7) shouldBe None
  }

  it should "take a null or blank token for no token, and register nothing for it" in {
    Seq(null, "", "   ").foreach(CatalogIdentity.register(8, _))
    CatalogIdentity.registered(8) shouldBe None

    CatalogIdentity.register(9, "token-9")
    CatalogIdentity.register(9, "")
    CatalogIdentity.registered(9) shouldBe Some("token-9")
  }

  it should "keep the tokens many threads register at once, while others read and switch modes" in {
    val threads = Executors.newFixedThreadPool(16)
    implicit val context: ExecutionContext = ExecutionContext.fromExecutorService(threads)
    val start = new CountDownLatch(1)
    val eids = 1000L until 3000L
    try {
      val writers = eids.grouped(100).toSeq.map { group =>
        Future {
          start.await(1, TimeUnit.MINUTES)
          group.foreach { eid =>
            CatalogIdentity.register(eid, s"token-$eid")
            CatalogIdentity.registered(eid) shouldBe Some(s"token-$eid")
          }
        }
      }
      val switcher = Future {
        start.await(1, TimeUnit.MINUTES)
        (1 to 1000).foreach { i =>
          CatalogIdentity.use(if (i % 2 == 0) Executions else Anonymous)
          val token = CatalogIdentity.tokenFor(Some(1000L + i))
          token should (be(None) or be(Some(s"token-${1000 + i}")))
        }
      }
      start.countDown()
      Await.result(Future.sequence(switcher +: writers), 1.minute)

      eids.foreach(eid => CatalogIdentity.registered(eid) shouldBe Some(s"token-$eid"))
      CatalogIdentity.use(Executions)
      eids.foreach(eid => CatalogIdentity.tokenFor(Some(eid)) shouldBe Some(s"token-$eid"))
    } finally threads.shutdownNow()
  }
}
