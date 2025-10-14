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
import org.apache.amber.core.tuple.BigObjectPointer
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.BIG_OBJECT

import java.io.{Closeable, InputStream}
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import scala.jdk.CollectionConverters._

/**
  * BigObjectStream wraps an InputStream and tracks its lifecycle for proper cleanup.
  */
class BigObjectStream(private val inputStream: InputStream, private val pointer: BigObjectPointer)
    extends InputStream
    with Closeable {

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
      BigObjectManager.closeStream(pointer)
    }
  }

  def isClosed: Boolean = closed
  def getPointer: BigObjectPointer = pointer
}

/**
  * BigObjectManager manages the lifecycle of large objects (>2GB) stored in S3.
  */
object BigObjectManager extends LazyLogging {
  private val DEFAULT_BUCKET = "texera-big-objects"
  private val openStreams = new ConcurrentHashMap[BigObjectPointer, BigObjectStream]()
  private lazy val context = SqlServer.getInstance().createDSLContext()

  /**
    * Creates a big object from an InputStream using multipart upload.
    * Handles streams of any size without loading into memory.
    * Registers the big object in the database for cleanup tracking.
    *
    * @param executionId The execution ID this big object belongs to.
    * @param stream The input stream containing the big object data.
    * @return A BigObjectPointer that can be used in tuples.
    */
  def create(executionId: Int, stream: InputStream): BigObjectPointer = {
    S3StorageClient.createBucketIfNotExist(DEFAULT_BUCKET)

    val objectKey = s"${System.currentTimeMillis()}/${UUID.randomUUID()}"
    val uri = s"s3://$DEFAULT_BUCKET/$objectKey"

    // Upload to S3
    S3StorageClient.uploadObject(DEFAULT_BUCKET, objectKey, stream)

    // Register in database
    try {
      context
        .insertInto(BIG_OBJECT)
        .columns(BIG_OBJECT.EXECUTION_ID, BIG_OBJECT.URI)
        .values(Int.box(executionId), uri)
        .execute()
      logger.debug(s"Registered big object: eid=$executionId, uri=$uri")
    } catch {
      case e: Exception =>
        // Database failed - clean up S3 object
        logger.error(s"Failed to register big object, cleaning up: $uri", e)
        try {
          S3StorageClient.deleteObject(DEFAULT_BUCKET, objectKey)
        } catch {
          case cleanupError: Exception =>
            logger.error(s"Failed to cleanup orphaned S3 object: $uri", cleanupError)
        }
        throw new RuntimeException(s"Failed to create big object: ${e.getMessage}", e)
    }

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
    val stream = new BigObjectStream(inputStream, ptr)
    openStreams.put(ptr, stream)
    stream
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
        Option(openStreams.get(ptr)).foreach(_.close())
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

  /**
    * Closes a big object stream. Typically called automatically when the stream is closed.
    */
  def close(ptr: BigObjectPointer): Unit = {
    Option(openStreams.get(ptr)).foreach { stream =>
      if (!stream.isClosed) stream.close()
    }
  }

  /**
    * Internal method to remove a stream from tracking when it's closed.
    */
  private[util] def closeStream(ptr: BigObjectPointer): Unit = {
    openStreams.remove(ptr)
  }
}
