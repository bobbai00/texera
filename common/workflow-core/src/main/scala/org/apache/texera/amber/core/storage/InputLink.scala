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

package org.apache.texera.amber.core.storage

import java.net.URI

/**
  * A link to a file that an operator reads from outside the run: a URL the file can be read from
  * with a GET, by whoever holds the link and until it expires. A plan made to run carries one for
  * each file its operators read, so the computing unit that runs the plan reads the files without
  * asking any service where they are, or whether its user may read them.
  *
  * The URL is a secret: its query holds the signature that lets its holder read the file.
  * [[toString]] leaves the query out, so a link that ends up in a log line gives nothing away.
  *
  * @param url         where the file is read from: a presigned GET on the object store
  * @param expiresAtMs when the link stops working, in milliseconds since the epoch
  * @param sizeBytes   the file's size in bytes
  */
final case class InputLink(url: String, expiresAtMs: Long, sizeBytes: Long) {

  override def toString: String =
    s"InputLink(${InputLink.withoutQuery(url)}, expiresAtMs=$expiresAtMs, sizeBytes=$sizeBytes)"
}

object InputLink {

  /**
    * `url` up to its query, which is where a presigned link keeps its signature: the part of a
    * link that may be logged.
    */
  def withoutQuery(url: String): String = url.takeWhile(c => c != '?' && c != '#')
}

/**
  * Makes the links a plan's operators read their files through, when the plan is made to run.
  *
  * A linker checks no access: it links whatever file it is handed. It is to be handed only files
  * a [[ScanFileResolver]] resolved for the plan's user, which is where access is checked.
  */
trait InputLinker {

  /**
    * Links the file at `fileUri`, a URI a [[ScanFileResolver]] resolved a name to.
    *
    * @throws org.apache.commons.vfs2.FileNotFoundException if there is no such file. Any other
    *                                                       failure, such as the storage not
    *                                                       answering, is thrown as it is.
    */
  def link(fileUri: URI): InputLink
}

object InputLinker {

  /**
    * Links nothing. For a compile that makes no plan to run, which never asks; a plan made to run
    * with it fails on the first file it reads rather than running without a link to it.
    */
  val Unavailable: InputLinker = fileUri =>
    throw new IllegalStateException(
      s"No linker for input files was given, so $fileUri cannot be linked."
    )
}
