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

package org.apache.texera.web.execution

import org.apache.texera.amber.core.storage.VFSURIFactory
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.virtualidentity.{
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import java.util.UUID
import scala.collection.mutable.ArrayBuffer

class ExecutionStorageSpec extends AnyFlatSpec with Matchers {

  /** A document that only records that it was cleared. */
  private final class ClearRecorder(uri: URI, cleared: ArrayBuffer[URI])
      extends VirtualDocument[Nothing] {
    override def getURI: URI = uri
    override def clear(): Unit = cleared += uri
  }

  private def run(workflow: Long, ports: Int): ExecutionRecord = {
    val record = ExecutionRegistry.create(workflow, 0, "run", Some(UUID.randomUUID().toString))
    (0 until ports).foreach { i =>
      val port =
        GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity(s"op-$i"), "main"), PortIdentity(0))
      val base = VFSURIFactory.createPortBaseURI(WorkflowIdentity(workflow), record.eid, port)
      ExecutionRegistry.recordPortResultUri(record.eid, port, VFSURIFactory.resultURI(base))
    }
    record
  }

  "drop" should "clear an execution's documents and large binaries, and nothing of another's" in {
    val expired = run(31, ports = 2)
    val other = run(31, ports = 1)
    val cleared = ArrayBuffer.empty[URI]
    val binaries = ArrayBuffer.empty[Long]
    val expiredResults = expired.portResults.values.toSet

    ExecutionStorage.drop(expired.eid, uri => new ClearRecorder(uri, cleared), binaries += _)

    cleared.toSet shouldBe expiredResults
    binaries shouldBe Seq(expired.eid.id)
    expired.portResults shouldBe empty
    other.portResults should have size 1
  }

  it should "clear an execution's documents in the warehouse it named" in {
    // The warehouse is part of each URI, so the drop reaches the documents wherever the
    // execution wrote them, whatever the unit's own default warehouse is.
    val expired = ExecutionRegistry.create(33, 0, "run", Some(UUID.randomUUID().toString))
    val port =
      GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("op"), "main"), PortIdentity(0))
    val result = VFSURIFactory.resultURI(
      VFSURIFactory.createPortBaseURI(WorkflowIdentity(33), expired.eid, port, Some("w_0a1b2c"))
    )
    val console = VFSURIFactory.createConsoleMessagesURI(
      WorkflowIdentity(33),
      expired.eid,
      OperatorIdentity("op"),
      Some("w_0a1b2c")
    )
    ExecutionRegistry.recordPortResultUri(expired.eid, port, result)
    ExecutionRegistry.insertOperatorExecutions(expired.eid.id, "op", console)
    val cleared = ArrayBuffer.empty[URI]

    ExecutionStorage.drop(expired.eid, uri => new ClearRecorder(uri, cleared), _ => ())

    cleared.toSet shouldBe Set(result, console)
    cleared.foreach(uri => VFSURIFactory.decodeURI(uri).warehouse shouldBe Some("w_0a1b2c"))
  }

  it should "keep going past a document it cannot open or a URI it cannot decode" in {
    val expired = run(32, ports = 2)
    ExecutionRegistry.insertOperatorExecutions(
      expired.eid.id,
      "console-op",
      new URI("bogus:///not-vfs")
    )
    val results = expired.portResults.values.toSet
    val failing = results.head
    val cleared = ArrayBuffer.empty[URI]
    val binaries = ArrayBuffer.empty[Long]

    // Like DocumentFactory: a vfs URI whose table is gone fails to open, a non-vfs URI is refused.
    val open: URI => VirtualDocument[_] = uri =>
      if (uri == failing) throw new RuntimeException("table is gone")
      else if (uri.getScheme != "vfs")
        throw new IllegalArgumentException(s"Invalid URI scheme: ${uri.getScheme}")
      else new ClearRecorder(uri, cleared)
    ExecutionStorage.drop(expired.eid, open, binaries += _)

    cleared.toSet shouldBe results - failing
    binaries shouldBe Seq(expired.eid.id)
    expired.portResults shouldBe empty
    expired.consoleMessageUris shouldBe empty
  }
}
