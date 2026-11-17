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

import org.apache.commons.lang3.SystemUtils
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.io.IOException
import java.nio.file.{Files, Path}
import scala.concurrent.duration.DurationInt

/**
  * The runner of real processes, on the shell every POSIX system has: no Python is needed. The
  * cases are skipped on Windows, where a computing unit does not run.
  */
class ProcessRunnerSpec extends AnyFlatSpec with Matchers {

  private def shell(script: String, environment: Map[String, String] = Map.empty) = {
    assume(!SystemUtils.IS_OS_WINDOWS, "needs a POSIX shell")
    ProcessRunner.OperatingSystem.run(Seq("sh", "-c", script), environment, 30.seconds)
  }

  "ProcessRunner.OperatingSystem" should "answer a process's exit code and the lines it wrote" in {
    shell("echo one; echo two; exit 0") shouldBe ProcessOutcome(Some(0), Seq("one", "two"))
    shell("exit 3") shouldBe ProcessOutcome(Some(3), Nil)
  }

  it should "take the error stream with the output, in the order the lines came" in {
    shell("echo out; echo oops >&2; echo more; exit 1") shouldBe
      ProcessOutcome(Some(1), Seq("out", "oops", "more"))
  }

  it should "set the variables it is given beside the JVM's own" in {
    val outcome = shell(
      "echo \"$TEXERA_SPEC_VARIABLE\"; test -n \"$PATH\" && echo inherited",
      Map("TEXERA_SPEC_VARIABLE" -> "set for the process")
    )
    outcome shouldBe ProcessOutcome(Some(0), Seq("set for the process", "inherited"))
  }

  it should "give a process nothing to read, so one that asks a question ends" in {
    shell("read answer; echo \"read [$answer]\"").lines shouldBe Seq("read []")
  }

  it should "destroy a process still running at its limit, with the processes it started" in {
    assume(!SystemUtils.IS_OS_WINDOWS, "needs a POSIX shell")
    val marker: Path = Files.createTempFile("process-runner-spec", ".txt")
    try {
      val started = System.nanoTime()
      // The shell starts a child that would write the marker after the limit has passed.
      val outcome = ProcessRunner.OperatingSystem.run(
        Seq("sh", "-c", s"echo begun; (sleep 2; echo late > '$marker') & wait"),
        Map.empty,
        300.millis
      )
      val seconds = (System.nanoTime() - started) / 1e9

      outcome shouldBe ProcessOutcome(None, Seq("begun"))
      seconds should be < 2.0
      Thread.sleep(2500)
      Files.size(marker) shouldBe 0L
    } finally Files.deleteIfExists(marker)
  }

  it should "fail to run a command there is not" in {
    an[IOException] should be thrownBy ProcessRunner.OperatingSystem.run(
      Seq("texera-no-such-command-9f3c"),
      Map.empty,
      5.seconds
    )
  }
}
