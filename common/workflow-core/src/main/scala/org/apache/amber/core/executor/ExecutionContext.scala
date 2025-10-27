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

package org.apache.amber.core.executor

/**
  * ExecutionContext provides thread-local access to execution metadata.
  * This allows operator executors to access execution ID and operator ID.
  */
object ExecutionContext {
  private val executionIdThreadLocal: ThreadLocal[Option[Int]] = ThreadLocal.withInitial(() => None)
  private val operatorIdThreadLocal: ThreadLocal[Option[String]] =
    ThreadLocal.withInitial(() => None)
  private val eventCallbackThreadLocal: ThreadLocal[Option[(String, String, String) => Unit]] =
    ThreadLocal.withInitial(() => None)

  /**
    * Sets the execution ID for the current thread.
    * Should be called when initializing an executor.
    */
  def setExecutionId(executionId: Long): Unit = {
    executionIdThreadLocal.set(Some(executionId.toInt))
  }

  /**
    * Gets the execution ID for the current thread.
    * @return Some(executionId) if set, None otherwise
    */
  def getExecutionId: Option[Int] = {
    executionIdThreadLocal.get()
  }

  /**
    * Sets the operator ID for the current thread.
    * Should be called when initializing an executor.
    */
  def setOperatorId(operatorId: String): Unit = {
    operatorIdThreadLocal.set(Some(operatorId))
  }

  /**
    * Gets the operator ID for the current thread.
    * @return Some(operatorId) if set, None otherwise
    */
  def getOperatorId: Option[String] = {
    operatorIdThreadLocal.get()
  }

  /**
    * Sets a callback for sending big object events.
    * The callback takes (operatorId, uri, eventType) as parameters.
    */
  def setBigObjectEventCallback(callback: (String, String, String) => Unit): Unit = {
    eventCallbackThreadLocal.set(Some(callback))
  }

  /**
    * Gets the big object event callback for the current thread.
    */
  def getBigObjectEventCallback: Option[(String, String, String) => Unit] = {
    eventCallbackThreadLocal.get()
  }

  /**
    * Clears the execution context for the current thread.
    * Should be called when cleaning up.
    */
  def clear(): Unit = {
    executionIdThreadLocal.remove()
    operatorIdThreadLocal.remove()
    eventCallbackThreadLocal.remove()
  }
}
