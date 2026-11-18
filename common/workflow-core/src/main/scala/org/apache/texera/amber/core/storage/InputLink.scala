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
  * each file its operators read (see [[org.apache.texera.amber.core.workflow.ExecutionPlan]]).
  *
  * The URL is a secret: its query holds the signature that lets its holder read the file.
  * [[toString]] leaves the query out, so a link that ends up in a log line gives nothing away.
  *
  * @param url         a presigned GET on the object store
  * @param expiresAtMs when the link stops working, in milliseconds since the epoch
  */
final case class InputLink(url: String, expiresAtMs: Long) {

  override def toString: String =
    s"InputLink(${InputLink.withoutQuery(url)}, expiresAtMs=$expiresAtMs)"
}

object InputLink {

  /** `url` up to its query: the part of a link that may be logged. */
  def withoutQuery(url: String): String = url.takeWhile(c => c != '?' && c != '#')
}

/**
  * Says where the files a plan's operators read are kept, when the plan is made to run. A plan
  * carries each file's address, so an [[InputLinker]] signs its links without a lookup.
  *
  * A locator checks no access: it locates whatever file it is handed. It is to be handed only
  * files a [[ScanFileResolver]] resolved for the plan's user, which is where access is checked.
  * A file a [[DatasetVersionLister]] listed needs no locator: its listing says where it is kept.
  */
trait InputFileLocator {

  /**
    * The object that holds the bytes of the file at `fileUri`, a URI a [[ScanFileResolver]]
    * resolved a name to: its address in the store that keeps it (s3://bucket/key).
    *
    * @throws org.apache.commons.vfs2.FileNotFoundException if there is no such file
    */
  def locate(fileUri: URI): String
}

/**
  * Makes the links a plan's operators read their files through, once the plan is made: only a
  * service that holds the object store's keys can.
  *
  * A linker checks no access: it links whatever address it is handed. It is to be handed only
  * the addresses of a plan made for its user, which is where access was checked.
  */
trait InputLinker {

  /**
    * Links the object at `physicalAddress`, as an [[InputFileLocator]] or the listing of a
    * dataset version gives a file's. Nothing is asked about it: thousands of files are linked
    * without a lookup for each.
    *
    * @throws IllegalStateException if the address is of no store a link can be signed for
    */
  def link(physicalAddress: String): InputLink
}
