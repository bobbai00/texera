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

import java.io.{File, FileInputStream, InputStream}
import java.net.URI
import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.nio.file.{Files, StandardCopyOption}

/**
  * A read-only file fetched over HTTP(S), e.g. a dataset file the catalog presigned for this
  * run. The file is downloaded once to a temporary location on first access; operators read it
  * like a local file.
  */
private[storage] class ReadonlyHttpFileDocument(uri: URI) extends ReadonlyVirtualDocument[Nothing] {
  @volatile private var cached: Option[File] = None

  override def getURI: URI = uri

  private def download(): File =
    synchronized {
      cached match {
        case Some(f) if f.exists() => f
        case _ =>
          val name = Option(uri.getPath)
            .map(p => p.substring(p.lastIndexOf('/') + 1))
            .filter(_.nonEmpty)
            .getOrElse("file")
          val suffix = if (name.contains('.')) name.substring(name.lastIndexOf('.')) else ""
          val tmp = Files.createTempFile("texera-input-", suffix)
          val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build()
          val request = HttpRequest.newBuilder(uri).GET().build()
          val response = client.send(request, HttpResponse.BodyHandlers.ofInputStream())
          if (response.statusCode() >= 300) {
            val body = new String(response.body().readNBytes(500))
            throw new java.io.IOException(s"GET $uri failed with ${response.statusCode()}: $body")
          }
          val in = response.body()
          try Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING)
          finally in.close()
          tmp.toFile.deleteOnExit()
          cached = Some(tmp.toFile)
          tmp.toFile
      }
    }

  override def asInputStream(): InputStream = new FileInputStream(download())

  override def asFile(): File = download()

  override def getItem(i: Int): Nothing =
    throw new NotImplementedError("getItem is not supported for ReadonlyHttpFileDocument")
  override def get(): Iterator[Nothing] =
    throw new NotImplementedError("get is not supported for ReadonlyHttpFileDocument")
  override def getRange(
      from: Int,
      until: Int,
      columns: Option[Seq[String]] = None
  ): Iterator[Nothing] =
    throw new NotImplementedError("getRange is not supported for ReadonlyHttpFileDocument")
  override def getAfter(offset: Int): Iterator[Nothing] =
    throw new NotImplementedError("getAfter is not supported for ReadonlyHttpFileDocument")
  override def getCount: Long =
    throw new NotImplementedError("getCount is not supported for ReadonlyHttpFileDocument")
}
