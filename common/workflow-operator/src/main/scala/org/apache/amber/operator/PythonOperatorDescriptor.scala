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

package org.apache.amber.operator

import org.apache.amber.config.UdfConfig
import org.apache.amber.core.executor.OpExecWithCode
import org.apache.amber.core.tuple.Schema
import org.apache.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.amber.core.workflow.{PhysicalOp, PortIdentity, SchemaPropagationFunc}

/**
  * Utility object for validating Python UDF code.
  */
object PythonCodeValidator {

  /**
    * Validates Python code for file I/O operations when file I/O is not allowed.
    * Throws an exception if file I/O patterns are detected.
    *
    * @param code The Python code to validate
    * @throws RuntimeException if file I/O operations are detected and not allowed
    */
  def validateNoFileIO(code: String): Unit = {
    if (UdfConfig.pythonAllowFileIO) {
      return // File I/O is allowed, skip validation
    }

    // Patterns that indicate file I/O operations
    // Using word boundaries and context-aware patterns to reduce false positives
    val fileIOPatterns = Seq(
      // Direct file operations
      ("""(?<![.\w])open\s*\(""".r, "open() function"),
      // File object methods
      ("""\.read\s*\(""".r, ".read() method"),
      ("""\.write\s*\(""".r, ".write() method"),
      ("""\.readline\s*\(""".r, ".readline() method"),
      ("""\.readlines\s*\(""".r, ".readlines() method"),
      ("""\.writelines\s*\(""".r, ".writelines() method"),
      // OS and filesystem module imports
      ("""(?m)^(?:from\s+os\s+import|import\s+os)""".r, "os module import"),
      ("""(?m)^(?:from\s+shutil\s+import|import\s+shutil)""".r, "shutil module import"),
      ("""(?m)^(?:from\s+pathlib\s+import|import\s+pathlib)""".r, "pathlib module import"),
      ("""(?m)^(?:from\s+io\s+import|import\s+io)""".r, "io module import"),
      ("""(?m)^(?:from\s+subprocess\s+import|import\s+subprocess)""".r, "subprocess module import"),
      ("""(?m)^(?:from\s+glob\s+import|import\s+glob)""".r, "glob module import"),
      // Path operations
      ("""Path\s*\(""".r, "Path() constructor")
    )

    // Remove comments and strings to avoid false positives
    val codeWithoutComments = code
      .replaceAll("""#.*$""", "") // Remove single-line comments
      .replaceAll("""'''[\s\S]*?'''""", "\"\"") // Remove triple single-quoted strings
      .replaceAll("\"\"\"[\\s\\S]*?\"\"\"", "\"\"") // Remove triple double-quoted strings

    val detectedPatterns = fileIOPatterns.flatMap {
      case (pattern, description) =>
        if (pattern.findFirstIn(codeWithoutComments).isDefined) {
          Some(description)
        } else {
          None
        }
    }

    if (detectedPatterns.nonEmpty) {
      throw new RuntimeException(
        s"File I/O operations are not allowed in Python UDF. " +
          s"Detected: ${detectedPatterns.mkString(", ")}. " +
          s"Please remove file I/O code"
      )
    }
  }

  /**
    * Generates Python code that will raise an exception with the given error message.
    * This is used to embed compilation errors in the code so they can be detected later.
    *
    * @param ex The exception to embed
    * @return Python code comment containing the error message
    */
  def generatePythonCodeForRaisingException(ex: Throwable): String = {
    s"#EXCEPTION DURING CODE GENERATION: ${ex.getMessage}"
  }
}

trait PythonOperatorDescriptor extends LogicalOp {
  private def generatePythonCodeForRaisingException(ex: Throwable): String = {
    PythonCodeValidator.generatePythonCodeForRaisingException(ex)
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    val pythonCode =
      try {
        val code = generatePythonCode()
        PythonCodeValidator.validateNoFileIO(code)
        code
      } catch {
        case ex: Throwable =>
          // instead of throwing error directly, we embed the error in the code
          // this can let upper-level compiler catch the error without interrupting the schema propagation
          generatePythonCodeForRaisingException(ex)
      }
    val physicalOp = if (asSource()) {
      PhysicalOp.sourcePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(pythonCode, "python")
      )
    } else {
      PhysicalOp.oneToOnePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(pythonCode, "python")
      )
    }

    physicalOp
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withParallelizable(parallelizable())
      .withPropagateSchema(SchemaPropagationFunc(inputSchemas => getOutputSchemas(inputSchemas)))
  }

  def parallelizable(): Boolean = false

  def asSource(): Boolean = false

  /**
    * This method is to be implemented to generate the actual Python source code
    * based on operators predicates.
    *
    * @return a String representation of the executable Python source code.
    */
  def generatePythonCode(): String

  def getOutputSchemas(inputSchemas: Map[PortIdentity, Schema]): Map[PortIdentity, Schema]

}
