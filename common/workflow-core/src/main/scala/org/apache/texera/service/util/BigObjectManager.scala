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

package org.apache.texera.service.util

import com.typesafe.scalalogging.LazyLogging
import org.apache.amber.core.executor.ExecutionContext
import org.apache.amber.core.tuple.BigObjectPointer
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.BIG_OBJECT

import java.io.{Closeable, InputStream}
import java.util.UUID
import scala.jdk.CollectionConverters._

/**
  * BigObjectStream wraps an InputStream for reading big objects.
  */
class BigObjectStream(private val inputStream: InputStream) extends InputStream with Closeable {

  @volatile private var closed = false

  private def checkClosed(): Unit = {
    if (closed) throw new IllegalStateException("Stream is closed")
  }

  override def read(): Int = {
    checkClosed()
    inputStream.read()
  }

  override def read(b: Array[Byte]): Int = {
    checkClosed()
    inputStream.read(b)
  }

  override def read(b: Array[Byte], off: Int, len: Int): Int = {
    checkClosed()
    inputStream.read(b, off, len)
  }

  override def available(): Int = if (closed) 0 else inputStream.available()

  override def close(): Unit = {
    if (!closed) {
      closed = true
      inputStream.close()
    }
  }

  def isClosed: Boolean = closed
}

/**
  * BigObjectManager manages the lifecycle of large objects (>2GB) stored in S3.
  */
object BigObjectManager extends LazyLogging {
  private val DEFAULT_BUCKET = "texera-big-objects"
  private lazy val context = SqlServer.getInstance().createDSLContext()

  /**
    * Creates a big object from InputStream, uploads to S3, and registers in database.
    * Automatically retrieves execution ID and operator ID from ExecutionContext.
    *
    * @param stream Input stream containing the data.
    * @return BigObjectPointer for use in tuples.
    */
  def create(stream: InputStream): BigObjectPointer = {
    val executionId = ExecutionContext.getExecutionId.getOrElse(
      throw new IllegalStateException("Execution ID not set in ExecutionContext")
    )
    val operatorId = ExecutionContext.getOperatorId.getOrElse(
      throw new IllegalStateException("Operator ID not set in ExecutionContext")
    )

    S3StorageClient.createBucketIfNotExist(DEFAULT_BUCKET)

    val objectKey = s"${System.currentTimeMillis()}/${UUID.randomUUID()}"
    val uri = s"s3://$DEFAULT_BUCKET/$objectKey"

    // Upload to S3
    S3StorageClient.uploadObject(DEFAULT_BUCKET, objectKey, stream)

    // Register in database
    try {
      context
        .insertInto(BIG_OBJECT)
        .columns(BIG_OBJECT.EXECUTION_ID, BIG_OBJECT.OPERATOR_ID, BIG_OBJECT.URI)
        .values(Int.box(executionId), operatorId, uri)
        .execute()
      logger.debug(s"Registered big object: eid=$executionId, opid=$operatorId, uri=$uri")
    } catch {
      case e: Exception =>
        logger.error(s"Failed to register big object, cleaning up: $uri", e)
        try {
          S3StorageClient.deleteObject(DEFAULT_BUCKET, objectKey)
        } catch {
          case _: Exception => // Best effort cleanup
        }
        throw new RuntimeException(s"Failed to create big object: ${e.getMessage}", e)
    }

    // Send event to frontend
    sendBigObjectEvent(operatorId, uri, "CREATE")

    new BigObjectPointer(uri)
  }

  /**
    * Opens a big object for reading.
    *
    * @param ptr The BigObjectPointer from a tuple field.
    * @return A BigObjectStream for reading the big object data.
    */
  def open(ptr: BigObjectPointer): BigObjectStream = {
    require(
      S3StorageClient.objectExists(ptr.getBucketName, ptr.getObjectKey),
      s"Big object does not exist: ${ptr.getUri}"
    )

    val inputStream = S3StorageClient.downloadObject(ptr.getBucketName, ptr.getObjectKey)

    // Send event to frontend
    ExecutionContext.getOperatorId.foreach { operatorId =>
      sendBigObjectEvent(operatorId, ptr.getUri, "READ")
    }

    new BigObjectStream(inputStream)
  }

  /**
    * Sends a BigObjectEvent using the registered callback.
    *
    * @param operatorId The operator ID
    * @param uri The big object URI
    * @param eventType The event type ("CREATE" or "READ")
    */
  private def sendBigObjectEvent(
      operatorId: String,
      uri: String,
      eventType: String
  ): Unit = {
    ExecutionContext.getBigObjectEventCallback.foreach { callback =>
      try {
        callback(operatorId, uri, eventType)
      } catch {
        case e: Exception =>
          logger.warn(s"Failed to send BigObjectEvent: ${e.getMessage}")
      }
    }
  }

  /**
    * Deletes all big objects associated with a specific execution ID.
    * This is called during workflow execution cleanup.
    *
    * @param executionId The execution ID whose big objects should be deleted.
    * @return The number of big objects successfully deleted from S3.
    */
  def delete(executionId: Int): Unit = {
    val uris = context
      .select(BIG_OBJECT.URI)
      .from(BIG_OBJECT)
      .where(BIG_OBJECT.EXECUTION_ID.eq(executionId))
      .fetchInto(classOf[String])
      .asScala
      .toList

    if (uris.isEmpty) {
      logger.debug(s"No big objects for execution $executionId")
      return
    }

    logger.info(s"Deleting ${uris.size} big object(s) for execution $executionId")

    // Delete each object from S3
    uris.foreach { uri =>
      try {
        val ptr = new BigObjectPointer(uri)
        S3StorageClient.deleteObject(ptr.getBucketName, ptr.getObjectKey)
      } catch {
        case e: Exception =>
          logger.error(s"Failed to delete big object: $uri", e)
      }
    }

    // Delete database records
    context
      .deleteFrom(BIG_OBJECT)
      .where(BIG_OBJECT.EXECUTION_ID.eq(executionId))
      .execute()
  }
}
