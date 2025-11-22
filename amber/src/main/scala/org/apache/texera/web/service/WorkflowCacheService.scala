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

package org.apache.texera.web.service

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import com.typesafe.scalalogging.LazyLogging
import org.apache.amber.core.storage.{DocumentFactory, FileResolver}
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{PhysicalOpIdentity, PortIdentity}
import org.apache.amber.core.workflow.PhysicalPlan
import org.apache.texera.dao.SqlServer
import org.jooq.impl.DSL

import java.net.URI
import java.sql.Timestamp
import scala.jdk.CollectionConverters._
import scala.util.Try

/**
  * Cached result information for an operator port
  */
case class CachedResult(
    cacheKey: String,
    operatorId: String,
    portId: String,
    resultUri: URI,
    resultSize: Int,
    tupleCount: Long,
    schema: Option[Schema],
    createdTime: Timestamp,
    lastAccessed: Timestamp,
    accessCount: Int
)

/**
  * Service for managing workflow execution caching at the physical operator port level.
  * This service allows reusing results from previous executions when the operator and
  * its upstream dependencies haven't changed.
  */
class WorkflowCacheService extends LazyLogging {

  private val context = SqlServer.getInstance().createDSLContext()
  private val objectMapper = new ObjectMapper().registerModule(DefaultScalaModule)

  // Table name for workflow cache
  private val WORKFLOW_CACHE = DSL.table("workflow_cache")
  private val CACHE_KEY = DSL.field("cache_key", classOf[String])
  private val OPERATOR_ID = DSL.field("operator_id", classOf[String])
  private val PORT_ID = DSL.field("port_id", classOf[String])
  private val RESULT_URI = DSL.field("result_uri", classOf[String])
  private val RESULT_SIZE = DSL.field("result_size", classOf[Integer])
  private val TUPLE_COUNT = DSL.field("tuple_count", classOf[java.lang.Long])
  private val SCHEMA_JSON = DSL.field("schema_json", classOf[String])
  private val CREATED_TIME = DSL.field("created_time", classOf[Timestamp])
  private val LAST_ACCESSED = DSL.field("last_accessed", classOf[Timestamp])
  private val ACCESS_COUNT = DSL.field("access_count", classOf[Integer])

  /**
    * Looks up a cached result for a specific cache key.
    * Updates the last_accessed timestamp and access_count if found.
    *
    * @param cacheKey The cache key to look up
    * @return Some(CachedResult) if found and valid, None otherwise
    */
  def lookupCache(cacheKey: String): Option[CachedResult] = {
    Try {
      val record = context
        .select(
          CACHE_KEY,
          OPERATOR_ID,
          PORT_ID,
          RESULT_URI,
          RESULT_SIZE,
          TUPLE_COUNT,
          SCHEMA_JSON,
          CREATED_TIME,
          LAST_ACCESSED,
          ACCESS_COUNT
        )
        .from(WORKFLOW_CACHE)
        .where(CACHE_KEY.eq(cacheKey))
        .fetchOne()

      if (record != null) {
        // Update access statistics
        context
          .update(WORKFLOW_CACHE)
          .set(LAST_ACCESSED, new Timestamp(System.currentTimeMillis()))
          .set(ACCESS_COUNT, ACCESS_COUNT.plus(1))
          .where(CACHE_KEY.eq(cacheKey))
          .execute()

        val schemaOpt = Option(record.get(SCHEMA_JSON))
          .filter(_.nonEmpty)
          .flatMap(json => Try(objectMapper.readValue(json, classOf[Schema])).toOption)

        val cachedResult = CachedResult(
          cacheKey = record.get(CACHE_KEY),
          operatorId = record.get(OPERATOR_ID),
          portId = record.get(PORT_ID),
          resultUri = new URI(record.get(RESULT_URI)),
          resultSize = record.get(RESULT_SIZE),
          tupleCount = record.get(TUPLE_COUNT),
          schema = schemaOpt,
          createdTime = record.get(CREATED_TIME),
          lastAccessed = record.get(LAST_ACCESSED),
          accessCount = record.get(ACCESS_COUNT)
        )

        // Verify that the cached result file still exists
        if (verifyCachedResultExists(cachedResult.resultUri)) {
          logger.info(s"Cache hit for key: $cacheKey, operator: ${cachedResult.operatorId}, port: ${cachedResult.portId}")
          Some(cachedResult)
        } else {
          logger.warn(s"Cache entry found but result file missing: ${cachedResult.resultUri}")
          // Remove invalid cache entry
          deleteCacheEntry(cacheKey)
          None
        }
      } else {
        logger.debug(s"Cache miss for key: $cacheKey")
        None
      }
    }.getOrElse {
      logger.error(s"Error looking up cache for key: $cacheKey")
      None
    }
  }

  /**
    * Stores a new cache entry.
    *
    * @param cacheKey The cache key
    * @param operatorId The logical operator ID
    * @param portId The port ID
    * @param resultUri The URI where results are stored
    * @param resultSize Size of the result in bytes
    * @param tupleCount Number of tuples in the result
    * @param schema Optional schema of the result
    */
  def storeCache(
      cacheKey: String,
      operatorId: String,
      portId: String,
      resultUri: URI,
      resultSize: Int,
      tupleCount: Long,
      schema: Option[Schema]
  ): Unit = {
    Try {
      val schemaJson = schema.map(s => objectMapper.writeValueAsString(s)).orNull
      val now = new Timestamp(System.currentTimeMillis())

      context
        .insertInto(WORKFLOW_CACHE)
        .columns(
          CACHE_KEY,
          OPERATOR_ID,
          PORT_ID,
          RESULT_URI,
          RESULT_SIZE,
          TUPLE_COUNT,
          SCHEMA_JSON,
          CREATED_TIME,
          LAST_ACCESSED,
          ACCESS_COUNT
        )
        .values(
          cacheKey,
          operatorId,
          portId,
          resultUri.toString,
          resultSize.asInstanceOf[Integer],
          tupleCount.asInstanceOf[java.lang.Long],
          schemaJson,
          now,
          now,
          1.asInstanceOf[Integer]
        )
        .onConflict(CACHE_KEY)
        .doUpdate()
        .set(LAST_ACCESSED, now)
        .set(ACCESS_COUNT, ACCESS_COUNT.plus(1))
        .execute()

      logger.info(s"Stored cache entry: key=$cacheKey, operator=$operatorId, port=$portId, tuples=$tupleCount")
    }.recover {
      case e: Exception =>
        logger.error(s"Error storing cache entry for key: $cacheKey", e)
    }
  }

  /**
    * Looks up all cached results for a given physical plan.
    * Returns a map of (operatorId, portId) -> CachedResult
    *
    * @param physicalPlan The physical plan
    * @param cacheKeyGenerator The cache key generator for this plan
    * @return Map of operator/port combinations to cached results
    */
  def lookupCachedResultsForPlan(
      physicalPlan: PhysicalPlan,
      cacheKeyGenerator: WorkflowCacheKeyGenerator
  ): Map[(PhysicalOpIdentity, PortIdentity), CachedResult] = {
    val cachedResults = scala.collection.mutable.Map[(PhysicalOpIdentity, PortIdentity), CachedResult]()

    // Check each operator's output ports for cached results
    physicalPlan.operators.foreach { operator =>
      operator.outputPorts.keys.foreach { portId =>
        val cacheKey = cacheKeyGenerator.getCacheKey(operator.id, portId)
        lookupCache(cacheKey).foreach { cachedResult =>
          cachedResults.put((operator.id, portId), cachedResult)
        }
      }
    }

    cachedResults.toMap
  }

  /**
    * Deletes a cache entry by cache key.
    *
    * @param cacheKey The cache key to delete
    */
  def deleteCacheEntry(cacheKey: String): Unit = {
    Try {
      context
        .deleteFrom(WORKFLOW_CACHE)
        .where(CACHE_KEY.eq(cacheKey))
        .execute()
      logger.info(s"Deleted cache entry: $cacheKey")
    }.recover {
      case e: Exception =>
        logger.error(s"Error deleting cache entry: $cacheKey", e)
    }
  }

  /**
    * Deletes cache entries that haven't been accessed since the specified timestamp.
    * Useful for cache eviction based on LRU policy.
    *
    * @param olderThan Delete entries last accessed before this timestamp
    * @return Number of entries deleted
    */
  def evictOldCacheEntries(olderThan: Timestamp): Int = {
    Try {
      val count = context
        .deleteFrom(WORKFLOW_CACHE)
        .where(LAST_ACCESSED.lt(olderThan))
        .execute()
      logger.info(s"Evicted $count cache entries older than $olderThan")
      count
    }.getOrElse {
      logger.error("Error evicting old cache entries")
      0
    }
  }

  /**
    * Gets cache statistics (total entries, total size, etc.)
    *
    * @return Map of statistics
    */
  def getCacheStatistics(): Map[String, Any] = {
    Try {
      val stats = context
        .select(
          DSL.count().as("total_entries"),
          DSL.sum(RESULT_SIZE).as("total_size_bytes"),
          DSL.sum(TUPLE_COUNT).as("total_tuples"),
          DSL.avg(ACCESS_COUNT).as("avg_access_count")
        )
        .from(WORKFLOW_CACHE)
        .fetchOne()

      Map(
        "totalEntries" -> stats.get(0),
        "totalSizeBytes" -> Option(stats.get(1)).getOrElse(0L),
        "totalTuples" -> Option(stats.get(2)).getOrElse(0L),
        "avgAccessCount" -> Option(stats.get(3)).getOrElse(0.0)
      )
    }.getOrElse(Map.empty)
  }

  /**
    * Verifies that a cached result file still exists in storage.
    *
    * @param uri The URI of the cached result
    * @return true if the file exists, false otherwise
    */
  private def verifyCachedResultExists(uri: URI): Boolean = {
    Try {
      val fileResolver = new FileResolver()
      fileResolver.resolve(uri.toString).exists()
    }.getOrElse(false)
  }

  /**
    * Clears all cache entries. Use with caution!
    */
  def clearAllCache(): Unit = {
    Try {
      val count = context
        .deleteFrom(WORKFLOW_CACHE)
        .execute()
      logger.warn(s"Cleared all cache entries: $count entries deleted")
    }.recover {
      case e: Exception =>
        logger.error("Error clearing all cache", e)
    }
  }
}
