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

import org.apache.texera.amber.core.storage.InputLink
import org.apache.texera.amber.core.storage.model.LinkDocument.{
  ConnectTimeoutMs,
  Endpoint,
  ReadTimeoutMs
}

import java.io.{File, IOException, InputStream}
import java.net.{HttpURLConnection, URI, URL}
import java.nio.file.{Files, Path}
import java.time.Instant
import java.util.Locale
import scala.util.{Try, Using}

object LinkDocument {

  /** How long the object store is given to accept a connection, in milliseconds. */
  private val ConnectTimeoutMs = 30 * 1000

  /** How long the object store is given to send the next part of a file, in milliseconds. */
  private val ReadTimeoutMs = 5 * 60 * 1000

  /**
    * An address of an object store: what two URLs have in common when they reach the same
    * server the same way. The scheme and the host are in lower case and the port is spelled
    * out, so two spellings of one address are equal.
    */
  private final case class Endpoint(scheme: String, host: String, port: Int) {
    override def toString: String = s"$scheme://$host:$port"
  }

  private object Endpoint {

    /** The endpoint `uri` is at; None unless it is an http or https URL of a host. */
    def of(uri: URI): Option[Endpoint] =
      for {
        scheme <- Option(uri.getScheme).map(_.toLowerCase(Locale.ROOT))
        defaultPort <- Map("http" -> 80, "https" -> 443).get(scheme)
        host <- Option(uri.getHost)
      } yield Endpoint(
        scheme,
        host.toLowerCase(Locale.ROOT),
        if (uri.getPort == -1) defaultPort else uri.getPort
      )

    def configured(setting: String): Endpoint =
      Try(new URI(setting)).toOption.flatMap(of).getOrElse {
        throw new IllegalStateException(
          s"'$setting' is set as an object-store endpoint to read input files from, but it is " +
            "not an http or https URL."
        )
      }
  }
}

/**
  * A file read through a link ([[InputLink]]): how a computing unit reads what a plan's operators
  * read from outside the run.
  *
  * A link comes out of a plan, so it is not trusted to name what the unit should fetch. It must
  * point at one of `allowedEndpoints`, by scheme, host and port; any other link is refused here,
  * when the document is made, before anything connects to it. The store's answer is taken as it
  * is: a redirect is not followed.
  *
  * A link stops working at its expiry, and nothing renews it. Reading through an expired link
  * fails, naming when it expired, without asking the store.
  *
  * The file is streamed ([[asInputStream]]), or copied once to a temporary file for a reader
  * that needs one ([[asFile]]), which [[close]] removes. No failure's message holds the link's
  * query, which is its signature.
  *
  * @param name what failures call the file: the name its operator knows it by
  * @throws IllegalArgumentException if the link does not point at one of `allowedEndpoints`
  */
class LinkDocument(link: InputLink, name: String, allowedEndpoints: Seq[String])
    extends ReadonlyVirtualDocument[Nothing]
    with AutoCloseable {

  private val (endpoint: Endpoint, location: URL) = {
    val allowed = allowedEndpoints.map(Endpoint.configured)
    Try(new URI(link.url)).toOption.map(uri => (uri, Endpoint.of(uri))) match {
      case Some((uri, Some(pointsAt))) if allowed.contains(pointsAt) =>
        // Asked of the address that was checked, with the host, path and query spelled as the
        // link spells them: its signature covers all three.
        val file = uri.getRawPath + Option(uri.getRawQuery).fold("")("?" + _)
        (pointsAt, new URL(uri.getScheme, uri.getHost, uri.getPort, file))
      case other =>
        val pointsAt = other.flatMap(_._2).fold("no http or https address")(_.toString)
        throw new IllegalArgumentException(
          s"Refusing to read $name: its link points at $pointsAt, and input files are read " +
            s"only from ${allowed.mkString(", ")}."
        )
    }
  }

  private var copy: Option[Path] = None

  /** Where the link points, without its query: nothing of it that is secret. */
  override def getURI: URI = new URI(InputLink.withoutQuery(link.url))

  /**
    * Opens the file for reading, with one GET of the link.
    *
    * @throws IOException if the link has expired; if the store does not answer, or answers
    *                     anything but the file; or, while the stream is read, if it ends before
    *                     the length the store declared
    */
  override def asInputStream(): InputStream = {
    if (hasExpired) throw expired()
    val connection = location.openConnection().asInstanceOf[HttpURLConnection]
    connection.setRequestMethod("GET")
    connection.setInstanceFollowRedirects(false)
    connection.setConnectTimeout(ConnectTimeoutMs)
    connection.setReadTimeout(ReadTimeoutMs)
    val status =
      try connection.getResponseCode
      catch {
        case failure: IOException =>
          connection.disconnect()
          throw new IOException(
            s"Could not read $name: the object store at $endpoint did not answer.",
            failure
          )
      }
    if (status != HttpURLConnection.HTTP_OK) {
      connection.disconnect()
      // The store refuses a link it finds expired, which its clock may find before this one.
      throw (
        if (status == HttpURLConnection.HTTP_FORBIDDEN && hasExpired) expired()
        else new IOException(s"Could not read $name: the object store answered HTTP $status.")
      )
    }
    new LengthCheckedInputStream(connection.getInputStream, connection.getContentLengthLong, name)
  }

  /**
    * The file, copied to a temporary file the first time this is asked, for a reader that needs
    * to seek or to open it more than once. The copy outlives the link's expiry; [[close]]
    * removes it.
    *
    * @throws IOException if the file cannot be read (see [[asInputStream]])
    */
  override def asFile(): File =
    copy.getOrElse {
      val file = Files.createTempFile("inputFile", ".tmp")
      try Using.resources(asInputStream(), Files.newOutputStream(file))(_.transferTo(_))
      catch {
        // A copy that did not finish is not the file; leaving it would also leak it on disk.
        case e: Throwable =>
          Files.deleteIfExists(file)
          throw e
      }
      copy = Some(file)
      file
    }.toFile

  override def close(): Unit = {
    copy.foreach(Files.deleteIfExists)
    copy = None
  }

  private def hasExpired: Boolean = System.currentTimeMillis() >= link.expiresAtMs

  private def expired(): IOException =
    new IOException(
      s"The link to $name expired at ${Instant.ofEpochMilli(link.expiresAtMs)}; run the " +
        "workflow again."
    )

  override def getItem(i: Int): Nothing =
    throw new NotImplementedError("getItem is not supported for LinkDocument")

  override def get(): Iterator[Nothing] =
    throw new NotImplementedError("get is not supported for LinkDocument")

  override def getRange(
      from: Int,
      until: Int,
      columns: Option[Seq[String]] = None
  ): Iterator[Nothing] =
    throw new NotImplementedError("getRange is not supported for LinkDocument")

  override def getAfter(offset: Int): Iterator[Nothing] =
    throw new NotImplementedError("getAfter is not supported for LinkDocument")

  override def getCount: Long =
    throw new NotImplementedError("getCount is not supported for LinkDocument")
}
