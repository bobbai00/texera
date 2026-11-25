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

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.common.config.StorageConfig

import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.util.control.NonFatal

object CatalogSetup {

  /** How long a setup that failed waits before it is tried again, in the background. */
  val RetryEvery: FiniteDuration = 5.seconds

  /** How often a setup that keeps failing in the background logs that it does. */
  val LogFailuresEvery: FiniteDuration = 1.minute

  /** This deployment's catalog's. */
  lazy val forDeployment: CatalogSetup = new CatalogSetup()

  /** Makes this deployment's catalog ready for Texera ([[CatalogSetup.ensure]]). */
  def ensure(): Unit = forDeployment.ensure()
}

/**
  * Makes a REST catalog ready for Texera, at the Dashboard service, which is the one service
  * that sets the catalog up:
  *  1. A catalog that no caller has bootstrapped is bootstrapped, which makes the platform its
  *     operator ([[LakekeeperClient.bootstrap]]).
  *  1. Its default project is made, unless it is there.
  *  1. The warehouse executions write into when they name none is made, in this deployment's
  *     bucket under its key prefix; one that is there has its endpoint set to this
  *     deployment's again ([[LakekeeperClient.ensureSharedWarehouse]]).
  *
  * Each step leaves what is there as it is, so any number of replicas may set the catalog up at
  * once, and a setup that failed half way is done again from the start. Once one succeeds, this
  * one is done: [[ensure]] then asks the catalog nothing. A catalog that is not a REST one has
  * nothing to set up.
  *
  * @param lakekeeper       the catalog's management API
  * @param rest             whether the catalog is a REST one
  * @param retryEvery       how long [[ensureInBackground]] waits after a setup that failed
  * @param logFailuresEvery how often [[ensureInBackground]] logs that setups keep failing
  */
class CatalogSetup(
    lakekeeper: => LakekeeperClient = LakekeeperClient.forDeployment,
    rest: Boolean = StorageConfig.icebergCatalogType == "rest",
    retryEvery: FiniteDuration = CatalogSetup.RetryEvery,
    logFailuresEvery: FiniteDuration = CatalogSetup.LogFailuresEvery
) extends LazyLogging {

  @volatile private var done = false

  /**
    * Sets the catalog up, unless this one did already: on the caller's thread, which waits for
    * a setup another thread is making.
    *
    * @throws RuntimeException what failed, when the catalog could not be set up
    */
  def ensure(): Unit =
    if (!done) {
      synchronized {
        if (!done) {
          if (rest) setUp(lakekeeper)
          done = true
        }
      }
    }

  /**
    * Sets the catalog up on a daemon thread of its own, which tries again every `retryEvery`
    * until a setup succeeds, and logs that it keeps failing at most every `logFailuresEvery`.
    *
    * @return the thread
    */
  def ensureInBackground(): Thread = {
    val thread = new Thread(() => keepTrying(), "catalog-setup")
    thread.setDaemon(true)
    thread.start()
    thread
  }

  private def keepTrying(): Unit = {
    var loggedAtMs: Option[Long] = None
    while (!done) {
      try ensure()
      catch {
        case NonFatal(failure) =>
          val nowMs = System.currentTimeMillis()
          if (loggedAtMs.forall(nowMs - _ >= logFailuresEvery.toMillis)) {
            logger.warn(
              s"The catalog could not be set up; it is tried again every $retryEvery.",
              failure
            )
            loggedAtMs = Some(nowMs)
          }
          try Thread.sleep(retryEvery.toMillis)
          catch {
            case _: InterruptedException =>
              Thread.currentThread().interrupt()
              return
          }
      }
    }
  }

  private def setUp(client: LakekeeperClient): Unit = {
    if (!client.info().bootstrapped) client.bootstrap()
    client.ensureDefaultProject()
    client.ensureSharedWarehouse(
      StorageConfig.icebergRESTCatalogWarehouseName,
      StorageConfig.icebergRESTCatalogKeyPrefix
    )
    logger.info(
      s"The catalog is set up: warehouse '${StorageConfig.icebergRESTCatalogWarehouseName}' " +
        "takes the executions that name none."
    )
  }
}
