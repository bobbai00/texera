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

import org.apache.texera.amber.core.storage.{VFSResourceType, VFSURIFactory}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, OperatorIdentity}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity}

import java.net.URI
import java.sql.Timestamp
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import scala.collection.concurrent.TrieMap
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Engine-side ids derived from the catalog's UUIDs.
  *
  * The engine keys storage by numbers: a result table is named after the workflow id and the
  * execution id, and creating a result document replaces any table of that name. Units share one
  * warehouse, so these numbers must never repeat: not across units, and not across restarts of
  * one unit. Deriving them from the catalog's UUIDs gives exactly that, and lets anyone holding
  * the catalog id recompute the engine id. Both halves are mixed so the id stays random even for
  * time-ordered UUIDs, whose high half is mostly a timestamp.
  */
object EngineIds {
  def of(uuid: UUID): Long = {
    val bits = (uuid.getMostSignificantBits ^ uuid.getLeastSignificantBits) & Long.MaxValue
    if (bits == 0L) 1L else bits
  }

  /** The id for a catalog id; anything that is not a UUID is hashed instead. */
  def of(id: String): Long =
    Try(UUID.fromString(id)).map(of).getOrElse(Math.max(1L, Math.abs(id.hashCode.toLong)))

  def fresh(): Long = of(UUID.randomUUID())
}

/**
  * One execution as the unit knows it. The unit is a pure engine: this record is the whole
  * execution metadata it keeps, in memory, for the lifetime of the process. The catalog is the
  * system of record and learns everything through the lineage reporter.
  *
  * The bean-style accessors mirror the old database row so the engine services that update
  * an execution keep compiling unchanged. `seq` orders executions by creation; the id itself is
  * random (see [[EngineIds]]).
  */
final class ExecutionRecord(
    val eid: ExecutionIdentity,
    val seq: Long,
    val workflowId: Long,
    val cuid: Int,
    val externalId: Option[String],
    val name: String
) {
  @volatile private var status: Short = 0
  @volatile private var lastUpdateTime: Timestamp = new Timestamp(System.currentTimeMillis())
  @volatile private var logLocation: String = _
  @volatile private var runtimeStatsUri: Option[URI] = None
  @volatile private var runtimeStatsSize: Long = 0
  val startingTime: Timestamp = new Timestamp(System.currentTimeMillis())
  private[execution] val resultUris = new ConcurrentHashMap[String, URI]()
  private[execution] val resultSizes = new ConcurrentHashMap[String, java.lang.Long]()
  private[execution] val consoleUris = new ConcurrentHashMap[String, URI]()

  def getStatus: Short = status
  def setStatus(s: Short): Unit = { status = s; ExecutionRegistry.notifyStatus(this) }
  def getLastUpdateTime: Timestamp = lastUpdateTime
  def setLastUpdateTime(t: Timestamp): Unit = lastUpdateTime = t
  def getLogLocation: String = logLocation
  def setLogLocation(l: String): Unit = logLocation = l
  def getName: String = name
  def getRuntimeStatsUri: Option[URI] = runtimeStatsUri
  def setRuntimeStatsUri(uri: URI): Unit = runtimeStatsUri = Some(uri)
  def getRuntimeStatsSize: Long = runtimeStatsSize
  def setRuntimeStatsSize(n: Long): Unit = runtimeStatsSize = n
  def getStartingTime: Timestamp = startingTime

  /** Result URIs keyed by serialized global port id. */
  def portResults: Map[String, URI] = resultUris.asScala.toMap
  def consoleMessageUris: Map[String, URI] = consoleUris.asScala.toMap
  def resultSize(globalPortId: String): Option[Long] =
    Option(resultSizes.get(globalPortId)).map(_.longValue())
}

/**
  * In-memory registry of executions on this unit. Replaces the Postgres-backed helpers the
  * engine used (workflow_executions, operator_port_executions, operator_executions).
  */
object ExecutionRegistry {
  private val sequence = new AtomicLong(0)
  private val byId = new TrieMap[Long, ExecutionRecord]()
  private val byExternal = new TrieMap[String, ExecutionRecord]()
  private val statusListeners = new TrieMap[Long, ExecutionRecord => Unit]()
  private val portResultListeners = new TrieMap[Long, (GlobalPortIdentity, URI) => Unit]()

  /**
    * Registers a new execution. Its engine id comes from the catalog's execution id when there
    * is one, and from a fresh UUID otherwise (runs started over the live WebSocket).
    */
  def create(
      workflowId: Long,
      cuid: Int,
      name: String,
      externalId: Option[String]
  ): ExecutionRecord = {
    val id = externalId.map(EngineIds.of).getOrElse(EngineIds.fresh())
    val record =
      new ExecutionRecord(
        ExecutionIdentity(id),
        sequence.incrementAndGet(),
        workflowId,
        cuid,
        externalId,
        name
      )
    if (byId.putIfAbsent(id, record).isDefined) {
      throw new IllegalStateException(
        s"execution ${externalId.getOrElse(id)} is already registered"
      )
    }
    externalId.foreach(byExternal.put(_, record))
    record
  }

  /**
    * Registers an execution under an id the caller chose. Only for tests that drive the engine
    * directly with a fixed execution id; runs on a unit always get theirs from [[create]].
    */
  private[texera] def adopt(
      eid: ExecutionIdentity,
      workflowId: Long,
      cuid: Int,
      name: String
  ): ExecutionRecord = {
    val record = new ExecutionRecord(eid, sequence.incrementAndGet(), workflowId, cuid, None, name)
    if (byId.putIfAbsent(eid.id, record).isDefined) {
      throw new IllegalStateException(s"execution ${eid.id} is already registered")
    }
    record
  }

  /** Drops an execution's record; its stored results are [[ExecutionStorage]]'s concern. */
  private[texera] def forget(eid: ExecutionIdentity): Unit =
    byId.remove(eid.id).foreach { record =>
      record.externalId.foreach(byExternal.remove)
      statusListeners.remove(eid.id)
      portResultListeners.remove(eid.id)
    }

  def get(eid: ExecutionIdentity): Option[ExecutionRecord] = byId.get(eid.id)
  def getByExternalId(externalId: String): Option[ExecutionRecord] = byExternal.get(externalId)
  def all: Iterable[ExecutionRecord] = byId.values

  def onStatus(eid: ExecutionIdentity)(f: ExecutionRecord => Unit): Unit =
    statusListeners.put(eid.id, f)
  def onPortResult(eid: ExecutionIdentity)(f: (GlobalPortIdentity, URI) => Unit): Unit =
    portResultListeners.put(eid.id, f)
  private[execution] def notifyStatus(record: ExecutionRecord): Unit =
    statusListeners.get(record.eid.id).foreach(f => f(record))

  /** The runtime statistics of a workflow's newest completed execution on this unit, if any. */
  def latestCompletedStatistics(workflowId: Long): Option[URI] = {
    val completed = org.apache.texera.amber.engine.common.Utils
      .maptoStatusCode(
        org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.COMPLETED
      )
    byId.values
      .filter(r =>
        r.workflowId == workflowId && r.getStatus == completed && r.getRuntimeStatsUri.isDefined
      )
      .maxByOption(_.seq)
      .flatMap(_.getRuntimeStatsUri)
  }

  /** The newest execution of a workflow on a unit, if any. */
  def latestExecution(workflowId: Long, cuid: Int): Option[ExecutionIdentity] =
    byId.values
      .filter(r => r.workflowId == workflowId && r.cuid == cuid)
      .maxByOption(_.seq)
      .map(_.eid)

  def recordPortResultUri(
      eid: ExecutionIdentity,
      globalPortId: GlobalPortIdentity,
      uri: URI
  ): Unit = {
    import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
    byId.get(eid.id).foreach { r =>
      r.resultUris.put(globalPortId.serializeAsString, uri)
      portResultListeners.get(eid.id).foreach(f => f(globalPortId, uri))
    }
  }

  def insertOperatorExecutions(eid: Long, opId: String, uri: URI): Unit =
    byId.get(eid).foreach(_.consoleUris.put(opId, uri))

  def updateRuntimeStatsUri(wid: Long, eid: Long, uri: URI): Unit =
    byId.get(eid).foreach(_.setRuntimeStatsUri(uri))

  def getResultUrisByExecutionId(eid: ExecutionIdentity): List[URI] =
    byId.get(eid.id).map(_.resultUris.values().asScala.toList).getOrElse(Nil)

  def getConsoleMessagesUriByExecutionId(eid: ExecutionIdentity): List[URI] =
    byId.get(eid.id).map(_.consoleUris.values().asScala.toList).getOrElse(Nil)

  def getConsoleMessageUri(eid: ExecutionIdentity, opId: OperatorIdentity): Option[URI] =
    byId.get(eid.id).flatMap(r => Option(r.consoleUris.get(opId.id))).filter(_.toString.nonEmpty)

  def getRuntimeStatsUriByExecutionId(eid: ExecutionIdentity): Option[URI] =
    byId.get(eid.id).flatMap(_.getRuntimeStatsUri)

  def deleteConsoleMessageAndExecutionResultUris(eid: ExecutionIdentity): Unit =
    byId.get(eid.id).foreach { r =>
      r.resultUris.clear()
      r.consoleUris.clear()
    }

  def updateResultSize(
      eid: ExecutionIdentity,
      globalPortId: GlobalPortIdentity,
      size: Long
  ): Unit = {
    import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
    byId
      .get(eid.id)
      .foreach(_.resultSizes.put(globalPortId.serializeAsString, java.lang.Long.valueOf(size)))
  }

  def updateRuntimeStatsSize(eid: ExecutionIdentity): Unit = ()
  def updateRuntimeStatsSize(eid: ExecutionIdentity, size: Long): Unit =
    byId.get(eid.id).foreach(_.setRuntimeStatsSize(size))
  def updateConsoleMessageSize(eid: ExecutionIdentity, opId: OperatorIdentity): Unit = ()

  /** The result URI of a logical operator's external output port in an execution. */
  def getResultUriByLogicalPortId(
      eid: ExecutionIdentity,
      opId: OperatorIdentity,
      portId: PortIdentity
  ): Option[URI] = {
    def matches(uri: URI): Boolean = {
      val components = VFSURIFactory.decodeURI(uri)
      components.globalPortId.exists { globalPortId =>
        !globalPortId.portId.internal &&
        globalPortId.opId.logicalOpId == opId &&
        globalPortId.portId == portId &&
        components.resourceType == VFSResourceType.RESULT
      }
    }
    getResultUrisByExecutionId(eid).find(matches)
  }

  /** Executions whose last update is older than timeToLive seconds and that still hold results. */
  def getExpiredExecutionsWithResultOrLog(timeToLive: Int): List[ExecutionRecord] = {
    val cutoff = System.currentTimeMillis() - timeToLive.toLong * 1000
    byId.values
      .filter(r => timeToLive < 0 || r.getLastUpdateTime.getTime < cutoff)
      .filter(r => !r.resultUris.isEmpty || r.getLogLocation != null)
      .toList
  }
}
