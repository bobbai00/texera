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

package org.apache.texera.amber.core.storage.model

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.util.LakeFSStorageClient

import java.io.{File, IOException, InputStream}
import java.net._
import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path, Paths, StandardOpenOption}
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.Using

object LakeFSFileDocument {

  /**
    * Where in LakeFS the file at `uri` is: its repository, the commit of its version, and its
    * path within that version. `uri` is {scheme}:///{repositoryName}/{versionHash}/{file}, as
    * `FileResolver` builds it, with each segment of the file's path URL-encoded.
    */
  def locate(uri: URI): (String, String, Path) = {
    val segments = Paths.get(uri.getPath).iterator().asScala.map(_.toString).toArray
    if (segments.length < 3)
      throw new IllegalArgumentException("URI format is incorrect")

    val repositoryName = segments(0)
    val versionHash = URLDecoder.decode(segments(1), StandardCharsets.UTF_8)
    val decodedRelativeSegments =
      segments.drop(2).map(part => URLDecoder.decode(part, StandardCharsets.UTF_8))
    val fileRelativePath = Paths.get(decodedRelativeSegments.head, decodedRelativeSegments.tail: _*)

    (repositoryName, versionHash, fileRelativePath)
  }
}

/**
  * A read-only document over a single file stored in a LakeFS repository, addressed by the URI
  * {scheme}:///{repositoryName}/{versionHash}/{fileRelativePath}.
  *
  * Every versioned-file resource (datasets, models, …) reads its files the same way — fetch the
  * bytes through a URL LakeFS presigns, falling back to a direct LakeFS fetch. Both ask LakeFS,
  * so a file is read this way only where LakeFS answers, with the credentials at hand: where a
  * plan is made, a scan's file is read like this to infer its schema. The scan's executor reads
  * the file through the link its plan carries instead ([[LinkDocument]]).
  *
  * @param uri the resolved {scheme}:///{repositoryName}/{versionHash}/{file} URI
  */
private[storage] class LakeFSFileDocument(uri: URI)
    extends VirtualDocument[Nothing]
    with OnVersionedFileResource
    with LazyLogging {

  protected val (repositoryName, versionHash, fileRelativePath) = LakeFSFileDocument.locate(uri)

  protected var tempFile: Option[File] = None

  override def getURI: URI = uri

  override def asInputStream(): InputStream = {

    def fallbackToLakeFS(exception: Throwable): InputStream = {
      logger.warn(s"${exception.getMessage}. Falling back to LakeFS direct file fetch.", exception)
      val file = LakeFSStorageClient.getFileFromRepo(
        getRepositoryName(),
        getVersionHash(),
        getFileRelativePath()
      )
      // The SDK saves the object to a temp file; delete it once the caller closes the stream.
      Files.newInputStream(file.toPath, StandardOpenOption.DELETE_ON_CLOSE)
    }

    try {
      val presignUrl = LakeFSStorageClient.getFilePresignedUrl(
        getRepositoryName(),
        getVersionHash(),
        getFileRelativePath()
      )
      openPresigned(presignUrl)
    } catch {
      case e: Exception =>
        fallbackToLakeFS(e)
    }
  }

  private def openPresigned(presignedUrl: String): InputStream = {
    val connection = new URL(presignedUrl).openConnection()
    val stream = connection.getInputStream
    new LengthCheckedInputStream(stream, connection.getContentLengthLong, getFileRelativePath())
  }

  override def asFile(): File = {
    tempFile match {
      case Some(file) => file
      case None =>
        val tempFilePath = Files.createTempFile("versionedFile", ".tmp")
        try Using.resources(asInputStream(), Files.newOutputStream(tempFilePath))(_.transferTo(_))
        catch {
          // A copy that did not finish is not the file; leaving it would also leak it on disk.
          case e: Throwable =>
            Files.deleteIfExists(tempFilePath)
            throw e
        }

        val file = tempFilePath.toFile
        tempFile = Some(file)
        file
    }
  }

  override def clear(): Unit = {
    // remove the temporary file, if one was materialized
    tempFile match {
      case Some(file) => Files.delete(file.toPath)
      case None       => // Do nothing
    }
    tempFile = None
  }

  override def getRepositoryName(): String = repositoryName

  override def getVersionHash(): String = versionHash

  override def getFileRelativePath(): String = fileRelativePath.toString
}

/**
  * Fails a read that ends before the length the server declared. HttpURLConnection reports a
  * connection closed mid-body as an ordinary end of stream, so without this a proxy that times out
  * a large presigned download hands the caller a silently truncated file, which a format reader
  * then rejects as corrupt.
  *
  * Extends InputStream rather than FilterInputStream so that skip reads (and counts) through
  * `read`, and mark/reset stay unsupported instead of rewinding the wrapped stream behind the count.
  */
private class LengthCheckedInputStream(in: InputStream, expectedLength: Long, what: String)
    extends InputStream {
  private var received = 0L

  override def read(): Int = {
    val byte = in.read()
    if (byte == -1) checkComplete() else received += 1
    byte
  }

  override def read(buffer: Array[Byte], offset: Int, length: Int): Int = {
    val count = in.read(buffer, offset, length)
    if (count == -1) checkComplete() else received += count
    count
  }

  override def available(): Int = in.available()

  override def close(): Unit = in.close()

  // An undeclared length is -1, which `received` never falls below, so such streams pass through.
  private def checkComplete(): Unit =
    if (received < expectedLength)
      throw new IOException(
        s"Download of $what ended after $received of $expectedLength bytes: the connection was " +
          "closed before the whole file arrived."
      )
}
