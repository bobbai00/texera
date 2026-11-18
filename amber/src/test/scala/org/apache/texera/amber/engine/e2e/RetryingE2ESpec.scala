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

import com.twitter.util.Duration
import com.typesafe.scalalogging.Logger
import org.apache.pekko.actor.{ActorSystem, Props}
import org.apache.pekko.testkit.{ImplicitSender, TestKit}
import org.apache.pekko.util.Timeout
import org.apache.texera.amber.clustering.SingleNodeListener
import org.apache.texera.amber.core.workflow.PortIdentity
import org.apache.texera.amber.engine.common.AmberRuntime
import org.apache.texera.amber.operator.TestOperators
import org.apache.texera.amber.operator.source.scan.text.TextInputSourceOpDesc
import org.apache.texera.common.compiler.model.LogicalLink
import org.scalatest.{BeforeAndAfterAll, Outcome, Retries}
import org.scalatest.flatspec.AnyFlatSpecLike

import scala.concurrent.duration.DurationInt

/**
  * Shared retrying TestKit fixture for Amber E2E suites. They run on the engine alone, as a
  * computing unit does: with no Texera database.
  * Each subclass passes a unique `specId` so concurrent Iceberg state stays isolated.
  */
abstract class RetryingE2ESpec(
    actorSystemName: String,
    protected val specId: Int
) extends TestKit(ActorSystem(actorSystemName, AmberRuntime.pekkoConfig))
    with ImplicitSender
    with AnyFlatSpecLike
    with BeforeAndAfterAll
    with Retries {

  override def withFixture(test: NoArgTest): Outcome =
    withRetry { super.withFixture(test) }

  implicit val timeout: Timeout = Timeout(5.seconds)

  override def beforeAll(): Unit = {
    system.actorOf(Props[SingleNodeListener](), "cluster-info")
    // The Iceberg catalog these test cases write results to is kept in postgres in CI, but
    // occasionally the jdbc driver cannot be found during CI run.
    // Explicitly load the JDBC driver to avoid flaky CI failures.
    Class.forName("org.postgresql.Driver")
  }

  override def afterAll(): Unit = {
    TestKit.shutdownActorSystem(system)
  }

  /**
    * Runs a TextInput -> Python UDF workflow once before timed integration tests so
    * Python worker cold-start is paid up front without failing the suite on warmup lag.
    */
  protected def warmUpPythonWorker(logger: Logger): Unit = {
    val warmupCap = Duration.fromSeconds(60)
    try {
      val src = new TextInputSourceOpDesc()
      src.textInput = "warmup"
      val udf = TestOperators.pythonOpDesc()
      val workflow = TestUtils.buildWorkflow(
        List(src, udf),
        List(
          LogicalLink(
            src.operatorIdentifier,
            PortIdentity(),
            udf.operatorIdentifier,
            PortIdentity()
          )
        ),
        TestUtils.workflowContext(specId)
      )
      TestUtils.runWorkflowAndReadTerminalResults(system, workflow, warmupCap)
    } catch {
      case e: Throwable =>
        logger.warn(
          s"warmup workflow did not finish within ${warmupCap}; tests will run cold and rely on Retries: ${e.getMessage}"
        )
    }
  }
}
