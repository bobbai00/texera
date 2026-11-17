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

package org.apache.texera.amber.operator.source.scan.file

import org.apache.texera.amber.core.executor.{ExecutorInputs, OperatorExecutor}
import org.apache.texera.amber.core.tuple.{Tuple, TupleLike}
import org.apache.texera.amber.util.JSONUtils.objectMapper

import java.io.FileNotFoundException

class FileScanOpExec private[scan] (
    descString: String,
    inputs: ExecutorInputs
) extends OperatorExecutor {
  private val desc: FileScanOpDesc =
    objectMapper.readValue(descString, classOf[FileScanOpDesc])

  /**
    * The tuples of the file `tuple` names, by its first string field: a file the plan links,
    * which is one a File Lister upstream of this operator listed when the plan was made. The
    * file is read through that link. No other name is looked up, wherever a file of that name
    * may be.
    *
    * @throws FileNotFoundException if the plan carries no link to the file
    */
  override def processTuple(tuple: Tuple, port: Int): Iterator[TupleLike] = {
    val fileName = tuple.getFields.collectFirst { case s: String => s }.get
    if (!inputs.hasFile(fileName)) {
      throw new FileNotFoundException(
        s"${desc.operatorInfo.userFriendlyName} reads only files listed by a File Lister " +
          s"upstream of it; $fileName is not one of them."
      )
    }
    FileScanUtils.createTuplesFromFile(
      document = inputs.open(fileName),
      displayFileName = fileName,
      attributeType = desc.attributeType,
      fileEncoding = desc.fileEncoding,
      extract = desc.extract,
      outputFileName = desc.outputFileName,
      fileScanOffset = desc.fileScanOffset,
      fileScanLimit = desc.fileScanLimit
    )
  }
}
