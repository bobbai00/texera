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

import com.fasterxml.jackson.databind.node.{ArrayNode, ObjectNode}
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.util.JSONUtils.objectMapper

import java.net.URI
import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.time.Instant
import java.util.concurrent.Executors

/**
  * Posts OpenLineage run events for one execution to the catalog. The event contract is
  * documented in the catalog (internal/server/lineage.go):
  *
  *  - run.runId is the catalog's execution id; job.namespace is "texera".
  *  - Run-level events: job.name == eid, run.facets.texera_execution = {status, error?}.
  *  - Operator-level events: job.name == "eid/opid", run.facets.texera_operator = {opid, state,
  *    tuples?, error?}, outputs[] named "eid/opid/port" with facets.texera_port, inputs[] named
  *    "fromEid/fromOpid/fromPort".
  */
final class LineageReporter(lineageUrl: String, token: String, eid: String) extends LazyLogging {
  private val client = HttpClient.newBuilder().build()
  private val executor = Executors.newSingleThreadExecutor(r => {
    val t = new Thread(r, s"lineage-reporter-$eid")
    t.setDaemon(true)
    t
  })
  private val producer = "https://texera.apache.org/engine"
  private val schemaURL = "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent"

  final case class PortRef(opid: String, port: String)
  final case class OutputPort(
      port: String,
      table: Option[String],
      tupleCount: Option[Long],
      bytes: Option[Long]
  )

  def runStatus(status: String, error: Option[String]): Unit = {
    val facet = objectMapper.createObjectNode()
    facet.put("status", status)
    error.foreach(e =>
      facet.set[ObjectNode]("error", objectMapper.createObjectNode().put("message", e))
    )
    val runFacets = objectMapper.createObjectNode()
    runFacets.set[ObjectNode]("texera_execution", facet)
    val eventType = status match {
      case "running"   => "START"
      case "completed" => "COMPLETE"
      case "failed"    => "FAIL"
      case "cancelled" => "ABORT"
      case _           => "RUNNING"
    }
    post(event(eventType, eid, runFacets, Seq.empty, Seq.empty))
  }

  def operator(
      opid: String,
      state: String,
      tuples: Option[Long],
      error: Option[String],
      outputs: Seq[OutputPort],
      inputs: Seq[PortRef],
      terminal: Boolean
  ): Unit = {
    val facet = objectMapper.createObjectNode()
    facet.put("opid", opid)
    facet.put("state", state)
    tuples.foreach(facet.put("tuples", _))
    error.foreach(e =>
      facet.set[ObjectNode]("error", objectMapper.createObjectNode().put("message", e))
    )
    val runFacets = objectMapper.createObjectNode()
    runFacets.set[ObjectNode]("texera_operator", facet)
    val outs = outputs.map { o =>
      val port = objectMapper.createObjectNode()
      o.table.foreach(port.put("table", _))
      o.tupleCount.foreach(port.put("tupleCount", _))
      o.bytes.foreach(port.put("bytes", _))
      val facets = objectMapper.createObjectNode()
      facets.set[ObjectNode]("texera_port", port)
      dataset(s"$eid/$opid/${o.port}", Some(facets))
    }
    val ins = inputs.map(i => dataset(s"$eid/${i.opid}/${i.port}", None))
    val eventType =
      if (!terminal) "RUNNING"
      else if (state == "Completed") "COMPLETE"
      else if (state == "Failed") "FAIL"
      else "ABORT"
    post(event(eventType, s"$eid/$opid", runFacets, ins, outs))
  }

  private def dataset(name: String, facets: Option[ObjectNode]): ObjectNode = {
    val node = objectMapper.createObjectNode()
    node.put("namespace", "texera")
    node.put("name", name)
    facets.foreach(node.set[ObjectNode]("facets", _))
    node
  }

  private def event(
      eventType: String,
      jobName: String,
      runFacets: ObjectNode,
      inputs: Seq[ObjectNode],
      outputs: Seq[ObjectNode]
  ): ObjectNode = {
    val ev = objectMapper.createObjectNode()
    ev.put("eventType", eventType)
    ev.put("eventTime", Instant.now().toString)
    val run = objectMapper.createObjectNode()
    run.put("runId", eid)
    run.set[ObjectNode]("facets", runFacets)
    ev.set[ObjectNode]("run", run)
    val job = objectMapper.createObjectNode()
    job.put("namespace", "texera")
    job.put("name", jobName)
    ev.set[ObjectNode]("job", job)
    val ins = objectMapper.createArrayNode()
    inputs.foreach(ins.add)
    ev.set[ArrayNode]("inputs", ins)
    val outs = objectMapper.createArrayNode()
    outputs.foreach(outs.add)
    ev.set[ArrayNode]("outputs", outs)
    ev.put("producer", producer)
    ev.put("schemaURL", schemaURL)
    ev
  }

  private def post(body: ObjectNode): Unit = {
    val payload = objectMapper.writeValueAsString(body)
    executor.submit(new Runnable {
      override def run(): Unit =
        try {
          val request = HttpRequest
            .newBuilder(URI.create(lineageUrl))
            .header("Content-Type", "application/json")
            .header("Authorization", s"Bearer $token")
            .POST(HttpRequest.BodyPublishers.ofString(payload))
            .build()
          val response = client.send(request, HttpResponse.BodyHandlers.ofString())
          if (response.statusCode() >= 300) {
            logger.warn(
              s"lineage event rejected (${response.statusCode()}): ${response.body().take(300)}"
            )
          }
        } catch {
          case e: Exception => logger.warn(s"lineage event failed: ${e.getMessage}")
        }
    })
  }

  def close(): Unit = executor.shutdown()
}
