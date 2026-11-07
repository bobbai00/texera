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

package org.apache.texera.amber.operator.aggregate

import org.apache.texera.amber.core.executor.OperatorExecutor
import org.apache.texera.amber.core.tuple.{Tuple, TupleLike}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import scala.collection.mutable

/**
  * The second stage of an aggregation: merges, per group, the partial results that the first
  * stage (`AggregateOpExec`) emitted on every worker, and finishes them. Its input is hashed on
  * the group keys, so all of a group's partials reach the same worker.
  */
class AggregateFinalOpExec(descString: String) extends OperatorExecutor {
  private val desc: AggregateOpDesc = objectMapper.readValue(descString, classOf[AggregateOpDesc])
  private var mergedByKey: mutable.LinkedHashMap[List[Object], List[Object]] = _
  private var merges: List[DistributedAggregation[Object]] = _

  override def open(): Unit = {
    mergedByKey = mutable.LinkedHashMap.empty
    merges = null
  }

  override def close(): Unit = {
    mergedByKey.clear()
    merges = null
  }

  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    if (merges == null) {
      merges = desc.aggregations.map { aggregation =>
        aggregation.getMergeAgg(tuple.getSchema.getAttribute(aggregation.resultAttribute).getType)
      }
    }
    val key = desc.groupByKeys.map(tuple.getField[Object])
    val merged = mergedByKey.getOrElseUpdate(key, merges.map(_.init()))
    mergedByKey(key) = merges.zip(merged).map {
      case (merge, partial) => merge.iterate(partial, tuple)
    }
    Iterator.empty
  }

  override def onFinish(port: Int): Iterator[TupleLike] =
    mergedByKey.iterator.map {
      case (key, merged) =>
        TupleLike(key ++ merges.zip(merged).map { case (merge, partial) => merge.finalAgg(partial) })
    }
}
