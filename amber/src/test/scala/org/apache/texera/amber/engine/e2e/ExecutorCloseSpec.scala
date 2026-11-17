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

package org.apache.texera.amber.engine.e2e

import com.twitter.util.{Await, Duration, Promise, Return}
import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.TestKit
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.executor.{OpExecWithClassName, SourceOperatorExecutor}
import org.apache.texera.amber.core.tuple.{AttributeType, Schema, TupleLike}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  OutputPort,
  PhysicalOp,
  PhysicalPlan,
  PortIdentity,
  WorkflowContext
}
import org.apache.texera.amber.engine.architecture.coordinator.{CoordinatorConfig, FatalError}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.EmptyRequest
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.amber.engine.common.client.AmberClient
import org.scalatest.BeforeAndAfterAll
import org.scalatest.concurrent.Eventually
import org.scalatest.flatspec.AnyFlatSpecLike
import org.scalatest.matchers.should.Matchers
import org.scalatest.time.{Seconds, Span}

import java.nio.file.{Files, Path}
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.LockSupport
import java.util.concurrent.{ConcurrentHashMap, CountDownLatch, TimeUnit}

object CopyKeepingSource {

  /** The source a worker built for each name a plan gave one. */
  val built = new ConcurrentHashMap[String, CopyKeepingSource]()
}

/**
  * A source that keeps a temporary copy of what it reads from when it is built until it is
  * closed, as a scan that needs its file on disk does, and counts how often it is closed.
  */
abstract class CopyKeepingSource(name: String) extends SourceOperatorExecutor {
  val copy: Path = Files.createTempFile("executor-close-spec", ".tmp")
  val closes = new AtomicInteger()
  CopyKeepingSource.built.put(name, this)

  override def close(): Unit = {
    closes.incrementAndGet()
    Files.deleteIfExists(copy)
  }
}

/** Produces rows for as long as its worker runs. */
class EndlessSource(name: String) extends CopyKeepingSource(name) {
  val producing = new CountDownLatch(1)

  override def produceTuple(): Iterator[TupleLike] =
    Iterator.continually {
      producing.countDown()
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1))
      TupleLike(1)
    }
}

/** Produces a row that does not fit its port's schema, which fails its worker. */
class MisfitSource(name: String) extends CopyKeepingSource(name) {
  override def produceTuple(): Iterator[TupleLike] = Iterator(TupleLike(1, "one field too many"))
}

/**
  * A worker closes its executor when its run ends before the executor finished: when the run is
  * killed, and when it fails. Each case runs a plan of one source on a real engine. What an
  * executor's close frees is its own to pin (a scan's copy: `ScanExecutorInputLinkSpec`); that
  * an executor is closed no more than once is pinned on the worker (`WorkflowWorkerSpec`,
  * `DataProcessorSpec`).
  */
class ExecutorCloseSpec
    extends TestKit(ActorSystem("ExecutorCloseSpec", AmberRuntime.pekkoConfig))
    with AnyFlatSpecLike
    with Matchers
    with Eventually
    with BeforeAndAfterAll {

  implicit override val patienceConfig: PatienceConfig = PatienceConfig(Span(30, Seconds))

  override def beforeAll(): Unit = system.actorOf(Props[SingleNodeListener](), "cluster-info")

  override def afterAll(): Unit = TestKit.shutdownActorSystem(system)

  /** The engine of a run of one source of class `source`, built under `name`. */
  private def engineOf(source: Class[_ <: CopyKeepingSource], name: String): AmberClient = {
    // Ids of this suite's own (9601): the run stores nothing, and shares no state.
    val context = new WorkflowContext(WorkflowIdentity(9601L), ExecutionIdentity(9601L))
    val operator = PhysicalOp
      .sourcePhysicalOp(
        context.workflowId,
        context.executionId,
        OperatorIdentity(name),
        OpExecWithClassName(source.getName, name)
      )
      .copy(outputPorts =
        Map(
          PortIdentity() -> (
            OutputPort(),
            List.empty,
            Right(Schema().add("number", AttributeType.INTEGER))
          )
        )
      )
    new AmberClient(
      system,
      context,
      PhysicalPlan(Set(operator), Set.empty),
      CoordinatorConfig.default,
      _ => ()
    )
  }

  private def sourceBuiltAs(name: String): CopyKeepingSource =
    eventually(Option(CopyKeepingSource.built.get(name)).getOrElse(fail(s"$name was not built")))

  "A worker" should "close its executor when its run is killed" in {
    val engine = engineOf(classOf[EndlessSource], "killed")
    try {
      Await.result(engine.coordinatorInterface.startWorkflow(EmptyRequest(), ()))
      val source = sourceBuiltAs("killed").asInstanceOf[EndlessSource]
      source.producing.await(30, TimeUnit.SECONDS) shouldBe true
      Files.exists(source.copy) shouldBe true

      // What a kill does to a run's engine.
      engine.shutdown()

      eventually(Files.exists(source.copy) shouldBe false)
      source.closes.get() shouldBe 1
    } finally engine.shutdown()
  }

  it should "close its executor when its run fails" in {
    val engine = engineOf(classOf[MisfitSource], "failed")
    try {
      val failure = Promise[FatalError]()
      engine.registerCallback[FatalError](error => failure.updateIfEmpty(Return(error)))
      Await.result(engine.coordinatorInterface.startWorkflow(EmptyRequest(), ()))

      // The run fails of its own: nothing shuts its engine down.
      Await.result(failure, Duration.fromSeconds(30))
      val source = sourceBuiltAs("failed")
      eventually(Files.exists(source.copy) shouldBe false)
      source.closes.get() shouldBe 1
    } finally engine.shutdown()
  }
}
