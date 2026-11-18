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

package org.apache.texera.amber.core.executor

import org.apache.texera.amber.core.storage.InputLink

/**
  * What an [[InputFile]] has besides its fields: its link as a value, and a text that leaves the
  * link's query out. The query is the link's signature, so a file that is printed, by itself or
  * within whatever holds it, gives nothing away.
  */
trait LinkedFile { this: InputFile =>

  /** Whether the file has its link; until it has, it has the address its link is signed for. */
  def isLinked: Boolean = url.nonEmpty

  /** The link the file is read through. */
  def link: InputLink = InputLink(url, expiresAtMs)

  /** This file read through `link`, which takes its address's place. */
  def linkedThrough(link: InputLink): InputFile =
    InputFile(name, link.url, link.expiresAtMs)

  override def toString: String =
    if (isLinked) s"InputFile($name, ${InputLink.withoutQuery(url)}, expiresAtMs=$expiresAtMs)"
    else s"InputFile($name, at $physicalAddress)"
}
