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

package org.apache.texera.amber.core.storage.result.iceberg

import java.util
import java.util.concurrent.{AbstractExecutorService, TimeUnit}

/**
  * Runs each task where it is submitted. The stores of a table that has one writer hand it to
  * Iceberg in place of Iceberg's shared worker pool, which has nothing to speed up there (one
  * manifest, a few files) and which a JVM that is exiting shuts down: that is when a computing
  * unit that is stopped writes how its runs ended, and a write that asked the pool for a thread
  * then was refused.
  */
private[iceberg] object OnCallingThread extends AbstractExecutorService {
  override def execute(task: Runnable): Unit = task.run()

  // Never shut down: it holds no thread.
  override def shutdown(): Unit = ()
  override def shutdownNow(): util.List[Runnable] = util.Collections.emptyList()
  override def isShutdown: Boolean = false
  override def isTerminated: Boolean = false
  override def awaitTermination(timeout: Long, unit: TimeUnit): Boolean = false
}
