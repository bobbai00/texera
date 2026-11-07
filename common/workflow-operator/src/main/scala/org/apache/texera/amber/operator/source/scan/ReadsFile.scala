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

package org.apache.texera.amber.operator.source.scan

import java.net.URI

/**
  * An operator that reads one file a workflow names. Before the plan is built the compiler
  * resolves the name, the catalog's URI or a URL it presigned, to one the engine can open.
  */
trait ReadsFile {

  /** The file the operator names, as the workflow gave it. */
  def fileToRead: Option[String]

  /** Sets the file to the URI it was resolved to. */
  def setResolvedFileName(uri: URI): Unit
}
