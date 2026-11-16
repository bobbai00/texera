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

package org.apache.texera.web.service.execution

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.{ExecutionPlanStore, WarehouseReadGuard}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{
  USER_WAREHOUSE,
  WORKFLOW_EXECUTIONS,
  WORKFLOW_VERSION
}

import java.net.URI
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

/** What an execution keeps outside its row, found from the row. */
object ExecutionResources extends LazyLogging {

  /**
    * Where execution `eid`'s plan table is: in the warehouse the execution writes into, or the
    * default one when it names none. None when there is no such execution.
    */
  def planUriOf(eid: ExecutionIdentity): Option[URI] = planUrisOf(Seq(eid)).get(eid)

  /**
    * [[planUriOf]] for each of `eids`, in one SELECT. An execution with no row is left out.
    *
    * A row whose warehouse was deleted names none (its `whid` is set to null), so its URI names
    * the default warehouse, where the plan table is not: dropping it there finds no table.
    */
  def planUrisOf(eids: Iterable[ExecutionIdentity]): Map[ExecutionIdentity, URI] =
    if (eids.isEmpty) Map.empty
    else
      SqlServer
        .getInstance()
        .createDSLContext()
        .select(
          WORKFLOW_EXECUTIONS.EID,
          WORKFLOW_VERSION.WID,
          USER_WAREHOUSE.LAKEKEEPER_WAREHOUSE_NAME
        )
        .from(WORKFLOW_EXECUTIONS)
        .join(WORKFLOW_VERSION)
        .on(WORKFLOW_VERSION.VID.eq(WORKFLOW_EXECUTIONS.VID))
        .leftJoin(USER_WAREHOUSE)
        .on(USER_WAREHOUSE.WHID.eq(WORKFLOW_EXECUTIONS.WHID))
        .where(
          WORKFLOW_EXECUTIONS.EID.in(
            eids.map(eid => Integer.valueOf(Math.toIntExact(eid.id))).toSeq.distinct.asJava
          )
        )
        .fetch()
        .asScala
        .map { row =>
          val eid = ExecutionIdentity(row.value1().longValue())
          eid -> ExecutionPlanStore.planUri(
            WorkflowIdentity(row.value2().longValue()),
            eid,
            Option(row.value3())
          )
        }
        .toMap

  /**
    * Drops the plan tables at `planUris`, with their rows and their start claims, once the
    * executions they belong to are deleted. A table in a per-user warehouse is left alone while
    * those are disabled, as every clean-up leaves those warehouses alone (#6930). A drop that
    * fails is logged, not thrown: the executions are gone by then, so a failure can only leave a
    * table behind.
    */
  def dropPlanTables(planUris: Iterable[URI]): Unit =
    planUris.foreach { uri =>
      if (WarehouseReadGuard.skipWhileDisabled(uri)) {
        logger.info(s"Leaving the plan table at $uri: per-user warehouses are disabled.")
      } else {
        try ExecutionPlanStore.drop(uri)
        catch {
          case NonFatal(failure) =>
            logger.warn(s"The plan table at $uri could not be dropped.", failure)
        }
      }
    }
}
