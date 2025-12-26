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

package org.apache.amber.engine.architecture.scheduling

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.typesafe.scalalogging.LazyLogging
import org.apache.amber.core.executor.{OpExecSource, OpExecWithClassName, OpExecWithCode}
import org.apache.amber.core.virtualidentity.ExecutionIdentity
import org.apache.amber.core.workflow.{GlobalPortIdentity, PhysicalOp, PhysicalPlan, PortIdentity}

import java.net.URI
import java.security.MessageDigest
import java.util
import scala.collection.mutable
import scala.jdk.CollectionConverters._

/**
  * Cache entry storing the URI and eviction status.
  *
  * @param uri              The storage URI for the cached result
  * @param markedForEviction Whether this entry has been marked for eviction by LRU
  */
case class CacheEntry(uri: URI, var markedForEviction: Boolean = false)

/**
  * Singleton object that manages port-level result caching across workflow executions.
  *
  * The cache stores mappings from content-addressable cache keys (based on operator
  * properties and upstream topology) to storage URIs. This enables result reuse
  * when the same computation is requested again.
  *
  * Key features:
  * - LRU eviction when cache exceeds maximum size
  * - Thread-safe operations
  * - Cache keys are topology-aware (include upstream dependencies)
  * - Stores URIs, not actual tuple data
  */
object PortResultCache extends LazyLogging {

  // Maximum number of cached port results
  private val maxSize: Int = 1000

  // LRU cache: cacheKey → CacheEntry
  // Using LinkedHashMap with accessOrder=true for LRU behavior
  private val cache: util.LinkedHashMap[String, CacheEntry] =
    new util.LinkedHashMap[String, CacheEntry](maxSize + 1, 0.75f, true) {
      override def removeEldestEntry(eldest: util.Map.Entry[String, CacheEntry]): Boolean = {
        if (this.size() > maxSize) {
          // Mark URI as evictable before removal
          eldest.getValue.markedForEviction = true
          logger.debug(s"Cache evicting entry: ${eldest.getKey.take(16)}...")
          true
        } else {
          false
        }
      }
    }

  /**
    * Look up a cached URI by its cache key.
    *
    * @param cacheKey The content-addressable cache key
    * @return Some(uri) if found, None otherwise
    */
  def lookup(cacheKey: String): Option[URI] =
    synchronized {
      Option(cache.get(cacheKey)).map(_.uri)
    }

  /**
    * Store a new cache entry.
    *
    * @param cacheKey The content-addressable cache key
    * @param uri      The storage URI for the result
    */
  def store(cacheKey: String, uri: URI): Unit =
    synchronized {
      cache.put(cacheKey, CacheEntry(uri))
      logger.debug(s"Cache stored: ${cacheKey.take(16)}... -> $uri")
    }

  /**
    * Check if a URI is currently cached (not evicted).
    * Used by garbage collection to avoid deleting cached results.
    *
    * @param uri The URI to check
    * @return true if the URI is in the active cache
    */
  def isUriCached(uri: URI): Boolean =
    synchronized {
      cache.values().asScala.exists(entry => entry.uri == uri && !entry.markedForEviction)
    }

  /**
    * Get all URIs that have been marked for eviction.
    * These URIs can be safely deleted by garbage collection.
    *
    * @return Set of evictable URIs
    */
  def getEvictableUris: Set[URI] =
    synchronized {
      cache.values().asScala.filter(_.markedForEviction).map(_.uri).toSet
    }

  /**
    * Get the current cache size.
    *
    * @return Number of entries in the cache
    */
  def size: Int =
    synchronized {
      cache.size()
    }

  /**
    * Clear all cache entries. Useful for testing.
    */
  def clear(): Unit =
    synchronized {
      cache.clear()
      executionCacheKeys.clear()
      logger.info("Cache cleared")
    }

  // Storage for cache keys per execution - used to store results after execution completes
  private val executionCacheKeys: mutable.Map[ExecutionIdentity, Map[GlobalPortIdentity, String]] =
    mutable.Map.empty

  /**
    * Store cache keys for an execution. Called during schedule generation.
    *
    * @param executionId The execution identifier
    * @param cacheKeys   Map of output port identities to their cache keys
    */
  def storeCacheKeysForExecution(
      executionId: ExecutionIdentity,
      cacheKeys: Map[GlobalPortIdentity, String]
  ): Unit =
    synchronized {
      executionCacheKeys(executionId) = cacheKeys
      logger.debug(s"Stored ${cacheKeys.size} cache keys for execution ${executionId.id}")
    }

  /**
    * Get the cache key for a specific output port in an execution.
    *
    * @param executionId The execution identifier
    * @param portId      The output port identity
    * @return The cache key if available
    */
  def getCacheKeyForPort(
      executionId: ExecutionIdentity,
      portId: GlobalPortIdentity
  ): Option[String] =
    synchronized {
      executionCacheKeys.get(executionId).flatMap(_.get(portId))
    }

  /**
    * Remove cache keys for a completed execution.
    *
    * @param executionId The execution identifier
    */
  def removeCacheKeysForExecution(executionId: ExecutionIdentity): Unit =
    synchronized {
      executionCacheKeys.remove(executionId)
      logger.debug(s"Removed cache keys for execution ${executionId.id}")
    }

  /**
    * Compute a content-addressable cache key for a physical operator's output port.
    *
    * The cache key is a SHA-256 hash of:
    * - Operator type (class name or code)
    * - Operator properties (serialized)
    * - Output port ID
    * - Upstream cache keys (creating a Merkle-tree structure)
    *
    * This ensures that any change in the operator or its upstream dependencies
    * produces a different cache key.
    *
    * @param physicalOp   The physical operator
    * @param outputPortId The output port to compute the key for
    * @param physicalPlan The physical plan containing topology information
    * @param memo         Memoization map to avoid recomputation
    * @return The SHA-256 hash as a hex string
    */
  def computeCacheKey(
      physicalOp: PhysicalOp,
      outputPortId: PortIdentity,
      physicalPlan: PhysicalPlan,
      memo: mutable.Map[GlobalPortIdentity, String] = mutable.Map.empty
  ): String = {
    val globalPortId = GlobalPortIdentity(physicalOp.id, outputPortId)

    // Return memoized result if available
    memo.get(globalPortId) match {
      case Some(cachedKey) => return cachedKey
      case None            =>
    }

    // Collect upstream cache keys in deterministic order
    val upstreamLinks = physicalPlan
      .getUpstreamPhysicalLinks(physicalOp.id)
      .toSeq
      .sortBy(link => s"${link.fromOpId.logicalOpId.id}:${link.fromPortId.id}")

    val upstreamKeys = upstreamLinks.map { link =>
      val upstreamOp = physicalPlan.getOperator(link.fromOpId)
      computeCacheKey(upstreamOp, link.fromPortId, physicalPlan, memo)
    }

    // Build the key from operator properties + upstream keys
    val opTypeAndProps = getOperatorSignature(physicalOp)
    val portIdStr = outputPortId.id.toString

    val keyComponents = Seq(
      opTypeAndProps,
      portIdStr,
      upstreamKeys.mkString(",")
    )
    val keyString = keyComponents.mkString("|")

    val cacheKey = sha256Hash(keyString)
    memo(globalPortId) = cacheKey
    cacheKey
  }

  // Reusable ObjectMapper for JSON parsing
  private val objectMapper = new ObjectMapper()

  /**
    * Get a string signature for an operator that captures its type and configuration.
    * This is used as part of the cache key computation.
    *
    * The signature excludes the operator ID to ensure identical configurations
    * produce the same cache key regardless of the operator's unique identifier.
    *
    * @param physicalOp The physical operator
    * @return A string representing the operator's type and configuration
    */
  private def getOperatorSignature(physicalOp: PhysicalOp): String = {
    val opExecInfo = physicalOp.opExecInitInfo
    val signature = opExecInfo match {
      case info: OpExecWithClassName =>
        // Parse the descString as JSON and remove the operatorID field
        // to ensure identical configurations produce the same cache key
        val normalizedDesc = normalizeDescString(info.descString)
        s"class:${info.className}:$normalizedDesc"
      case info: OpExecWithCode =>
        // For code-based operators, include the code hash
        s"code:${info.language}:${sha256Hash(info.code)}"
      case info: OpExecSource =>
        s"source:${info.storageKey}"
      case _ =>
        s"unknown:${opExecInfo.hashCode()}"
    }
    signature
  }

  /**
    * Normalize the operator description string by removing fields that
    * should not affect cache key computation (like operator ID).
    *
    * @param descString The operator's serialized description JSON
    * @return A normalized string without the operator ID
    */
  private def normalizeDescString(descString: String): String = {
    try {
      val node = objectMapper.readTree(descString)
      if (node.isObject) {
        val objNode = node.asInstanceOf[ObjectNode]
        // Remove fields that should not affect the cache key
        objNode.remove("operatorID")
        objNode.remove("operatorType") // This is often just a type hint, not config
        objectMapper.writeValueAsString(objNode)
      } else {
        descString
      }
    } catch {
      case _: Throwable =>
        // If JSON parsing fails, use the original string
        descString
    }
  }

  /**
    * Compute SHA-256 hash of a string.
    *
    * @param input The input string
    * @return The hash as a hex string
    */
  private def sha256Hash(input: String): String = {
    MessageDigest
      .getInstance("SHA-256")
      .digest(input.getBytes("UTF-8"))
      .map("%02x".format(_))
      .mkString
  }

  /**
    * Compute cache keys for all output ports in a physical plan.
    * Returns a map from GlobalPortIdentity to cache key.
    *
    * @param physicalPlan The physical plan
    * @return Map of port identities to their cache keys
    */
  def computeAllCacheKeys(physicalPlan: PhysicalPlan): Map[GlobalPortIdentity, String] = {
    val memo = mutable.Map[GlobalPortIdentity, String]()

    // Process in topological order to ensure dependencies are computed first
    physicalPlan.topologicalIterator().foreach { physicalOpId =>
      val op = physicalPlan.getOperator(physicalOpId)
      op.outputPorts.keys.foreach { outputPortId =>
        computeCacheKey(op, outputPortId, physicalPlan, memo)
      }
    }

    memo.toMap
  }

  /**
    * Look up cached URIs for all output ports in a physical plan.
    * Returns a map from GlobalPortIdentity to cached URI for ports that have cache hits.
    *
    * @param physicalPlan The physical plan
    * @return Map of port identities to their cached URIs (only for cache hits)
    */
  def lookupCachedPorts(physicalPlan: PhysicalPlan): Map[GlobalPortIdentity, URI] = {
    val allKeys = computeAllCacheKeys(physicalPlan)
    allKeys.flatMap {
      case (portId, cacheKey) =>
        lookup(cacheKey).map(uri => portId -> uri)
    }
  }
}
