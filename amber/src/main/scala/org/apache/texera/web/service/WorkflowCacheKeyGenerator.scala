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
import org.apache.amber.core.virtualidentity.{PhysicalOpIdentity, PortIdentity}
import org.apache.amber.core.workflow.{PhysicalPlan, PortIdentity => CorePortIdentity}

import java.security.MessageDigest
import scala.collection.mutable

/**
  * Generates cache keys for physical operators based on their properties and upstream dependencies.
  * The cache key uniquely identifies the computation performed by an operator, including all its
  * upstream dependencies. If any operator or its dependencies change, the cache key will be different.
  */
class WorkflowCacheKeyGenerator(physicalPlan: PhysicalPlan) {

  private val objectMapper = new ObjectMapper().registerModule(DefaultScalaModule)

  // Cache to store computed cache keys to avoid recomputation
  private val cacheKeyMap = mutable.Map[(PhysicalOpIdentity, CorePortIdentity), String]()

  // Cache to store operator content hashes (without dependencies)
  private val operatorContentHashMap = mutable.Map[PhysicalOpIdentity, String]()

  /**
    * Computes a cache key for a specific output port of a physical operator.
    * The cache key includes:
    * 1. The operator's own properties (type, configuration, code, etc.)
    * 2. Recursively, the cache keys of all upstream operators
    * 3. The port identifier
    *
    * @param opId The physical operator identity
    * @param portId The output port identity
    * @return A hex-encoded SHA-256 hash that serves as the cache key
    */
  def getCacheKey(opId: PhysicalOpIdentity, portId: CorePortIdentity): String = {
    cacheKeyMap.getOrElseUpdate(
      (opId, portId), {
        val operator = physicalPlan.getOperator(opId)

        // Get the content hash of this operator (without dependencies)
        val operatorHash = getOperatorContentHash(opId)

        // Get cache keys of all upstream operators and their ports
        val upstreamCacheKeys = physicalPlan
          .getUpstreamPhysicalLinks(opId)
          .toList
          .sortBy(link => (link.fromOpId.toString, link.fromPortId.toString))
          .map { link =>
            // Recursively get the cache key of the upstream port
            getCacheKey(link.fromOpId, link.fromPortId)
          }

        // Combine operator hash, upstream cache keys, and port id
        val combinedContent = Map(
          "operatorHash" -> operatorHash,
          "upstreamKeys" -> upstreamCacheKeys,
          "portId" -> portId.id
        )

        // Compute the final cache key
        computeHash(objectMapper.writeValueAsString(combinedContent))
      }
    )
  }

  /**
    * Computes a content hash for an operator based on its properties.
    * This hash represents the operator itself, excluding its dependencies.
    *
    * @param opId The physical operator identity
    * @return A hex-encoded SHA-256 hash of the operator's content
    */
  private def getOperatorContentHash(opId: PhysicalOpIdentity): String = {
    operatorContentHashMap.getOrElseUpdate(
      opId, {
        val operator = physicalPlan.getOperator(opId)

        // Extract relevant operator properties for hashing
        val operatorContent = Map(
          "logicalOpId" -> operator.id.logicalOpId.id,
          "opExecInitInfo" -> operator.opExecInitInfo.getClass.getName,
          "parallelizable" -> operator.parallelizable,
          "partitionRequirement" -> operator.partitionRequirement.map(_.toString),
          "isOneToManyOp" -> operator.isOneToManyOp
        )

        // For operators with code (UDF, Python, etc.), include the code in the hash
        val contentWithCode = if (operator.isPythonBased || operator.opExecInitInfo.getClass.getSimpleName.contains("Code")) {
          try {
            operatorContent + ("code" -> operator.getCode)
          } catch {
            case _: Exception => operatorContent
          }
        } else {
          operatorContent
        }

        // Serialize and hash
        computeHash(objectMapper.writeValueAsString(contentWithCode))
      }
    )
  }

  /**
    * Computes SHA-256 hash of a string and returns it as a hex string.
    */
  private def computeHash(content: String): String = {
    val digest = MessageDigest.getInstance("SHA-256")
    val hashBytes = digest.digest(content.getBytes("UTF-8"))
    hashBytes.map("%02x".format(_)).mkString
  }

  /**
    * Clears the internal caches. Useful for testing.
    */
  def clearCache(): Unit = {
    cacheKeyMap.clear()
    operatorContentHashMap.clear()
  }
}
