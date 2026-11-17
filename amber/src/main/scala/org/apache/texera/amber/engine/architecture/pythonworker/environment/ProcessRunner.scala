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

package org.apache.texera.amber.engine.architecture.pythonworker.environment

import java.io.{BufferedReader, IOException, InputStreamReader}
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import scala.collection.mutable.ArrayBuffer
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.jdk.CollectionConverters.{MapHasAsJava, SeqHasAsJava}

/**
  * What a child process did.
  *
  * @param exitCode its exit code; None when it was still running at its limit, and was destroyed
  * @param lines    the lines it wrote, to its output and its error stream, in the order they came
  */
final case class ProcessOutcome(exitCode: Option[Int], lines: Seq[String])

/**
  * Runs the child processes Python environments are made with: the engine's interpreter, and pip.
  * A seam, so a spec runs neither.
  */
trait ProcessRunner {

  /**
    * Runs `command` to its end, or to `limit`: a process still running then is destroyed, with
    * every process it started.
    *
    * @param environment variables set for the process, beside this JVM's own
    * @throws java.io.IOException if the command cannot be started
    */
  def run(
      command: Seq[String],
      environment: Map[String, String],
      limit: FiniteDuration
  ): ProcessOutcome
}

object ProcessRunner {

  // How long the lines a process wrote are waited for once it has ended: a process it started
  // and left behind can hold the stream open.
  private val DrainLimit = 10.seconds

  /** Runs each command as a process of the operating system. */
  object OperatingSystem extends ProcessRunner {

    override def run(
        command: Seq[String],
        environment: Map[String, String],
        limit: FiniteDuration
    ): ProcessOutcome = {
      val builder = new ProcessBuilder(command.asJava).redirectErrorStream(true)
      builder.environment().putAll(environment.asJava)
      val process = builder.start()
      val lines = ArrayBuffer.empty[String]
      val reader = new Thread(
        () => {
          val output =
            new BufferedReader(
              new InputStreamReader(process.getInputStream, StandardCharsets.UTF_8)
            )
          // The stream fails under a process that is destroyed: what it wrote until then stands.
          try Iterator
            .continually(output.readLine())
            .takeWhile(_ != null)
            .foreach(line => lines.synchronized(lines += line))
          catch { case _: IOException => }
        },
        s"output-of-${command.head}"
      )
      reader.setDaemon(true)
      try {
        // The process reads nothing: it is never asked a question.
        process.getOutputStream.close()
        reader.start()
        val ended = process.waitFor(limit.toMillis, TimeUnit.MILLISECONDS)
        if (!ended) destroy(process)
        reader.join(DrainLimit.toMillis)
        ProcessOutcome(Option.when(ended)(process.exitValue()), lines.synchronized(lines.toList))
      } finally if (process.isAlive) destroy(process)
    }

    private def destroy(process: Process): Unit = {
      process.descendants().forEach(descendant => descendant.destroyForcibly())
      process.destroyForcibly()
    }
  }
}
