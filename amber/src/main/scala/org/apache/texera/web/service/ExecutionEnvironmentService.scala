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

package org.apache.texera.web.service

import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{PhysicalPlan, PythonEnvironment, PythonEnvironmentRef}
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller
import org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstaller.{
  InstallFailed,
  Installed,
  Installing,
  Joining,
  Reused
}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessageType.PRINT
import org.apache.texera.web.service.ExecutionEnvironmentService.{
  EnvironmentNotInstalled,
  environmentsOf,
  holding
}

import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.{CompletableFuture, Executors, ScheduledExecutorService, TimeUnit}
import scala.concurrent.duration.{DurationInt, FiniteDuration}
import scala.util.control.NonFatal

object ExecutionEnvironmentService {

  /** How often a run that waits for an install says that it still does. */
  val ReminderInterval: FiniteDuration = 30.seconds

  // Reminds waiting runs. One thread for every run: a reminder is a line added to a console.
  private lazy val reminders: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { task =>
      val thread = new Thread(task, "python-environment-reminders")
      thread.setDaemon(true)
      thread
    }

  /**
    * The Python environments the operators of `plan` run in, each once, with the operators that
    * run in it, both in the order the plan reaches them. An operator in the engine's own
    * environment needs none.
    */
  def environmentsOf(plan: PhysicalPlan): Seq[(PythonEnvironment, Seq[OperatorIdentity])] = {
    val uses = plan
      .topologicalIterator()
      .map(plan.getOperator)
      .flatMap { op =>
        op.pythonEnvironment match {
          case PythonEnvironmentRef.Resolved(environment) => Some(environment -> op.id.logicalOpId)
          case _                                          => None
        }
      }
      .toSeq
    uses.map(_._1).distinct.map { environment =>
      environment -> uses.collect { case (`environment`, operator) => operator }.distinct
    }
  }

  /**
    * An environment of a run's plan that this unit could not install: why the run does not start.
    *
    * @param operators the operators that run in it, the first the plan reaches first
    */
  final class EnvironmentNotInstalled(
      val environment: PythonEnvironment,
      val operators: Seq[OperatorIdentity],
      failure: InstallFailed
  ) extends RuntimeException(
        s"Python environment '${environment.name}' could not be installed: ${failure.reason}",
        failure
      ) {

    /** The last lines the install wrote, pip's among them; why it failed, if it wrote none. */
    val details: String = if (failure.log.isEmpty) failure.reason else failure.log.mkString("\n")
  }

  /** What a ready environment holds, as a console says it. */
  private def holding(packages: Seq[String]): String =
    if (packages.isEmpty) "It holds no package beside the engine's own."
    else s"It holds, beside the engine's packages:\n${packages.mkString("\n")}"
}

/**
  * Makes the Python environments of a run's plan ready on this computing unit, before the run's
  * engine starts, and tells the console of every operator that runs in one what becomes of it:
  * that it is being installed, here or for another run, that it still is, every
  * `reminderInterval`, and that it is ready or was installed before.
  *
  * An install is the unit's, shared by every run that needs the environment: a run only waits
  * for it. A run that is no longer awaited is told nothing more, and its installs go on.
  *
  * @param awaited whether the run still waits to start: false once it is killed, superseded or
  *                failed
  */
class ExecutionEnvironmentService(
    plan: PhysicalPlan,
    console: ExecutionConsoleService,
    installer: PythonEnvironmentInstaller,
    awaited: () => Boolean,
    reminderInterval: FiniteDuration = ExecutionEnvironmentService.ReminderInterval
) {

  /**
    * Returns at once: the installer's threads do the work.
    *
    * @return done once every environment is ready, at once for a plan that names none; failed
    *         with an [[EnvironmentNotInstalled]] as soon as one cannot be installed, while the
    *         others' installs go on
    */
  def prepare(): CompletableFuture[Unit] = {
    val prepared = new CompletableFuture[Unit]()
    val environments = environmentsOf(plan)
    val pending = new AtomicInteger(environments.size)
    if (environments.isEmpty) prepared.complete(())
    environments.foreach {
      case (environment, operators) =>
        val name = s"Python environment '${environment.name}'"
        val asked = System.nanoTime()
        def waited: Double = (System.nanoTime() - asked) / 1e9
        def tell(title: String, message: String = ""): Unit =
          if (awaited()) {
            operators.foreach(operator =>
              console.addUnitMessage(operator.id, PRINT, title, message)
            )
          }

        val ready = installer.ensure(
          environment,
          {
            case Installing =>
              val count = environment.requirements.size
              tell(
                s"Installing $name ($count ${if (count == 1) "package" else "packages"})",
                environment.requirements.mkString("\n")
              )
            case Joining => tell(s"Waiting for $name, which is already being installed")
          }
        )
        val reminder = ExecutionEnvironmentService.reminders.scheduleAtFixedRate(
          () => if (!ready.isDone) tell(s"Still installing $name (${waited.round} s)"),
          reminderInterval.toMillis,
          reminderInterval.toMillis,
          TimeUnit.MILLISECONDS
        )
        ready.whenComplete { (environmentReady, failure) =>
          reminder.cancel(false)
          try {
            failure match {
              case null =>
              case failed: InstallFailed =>
                throw new EnvironmentNotInstalled(environment, operators, failed)
              case other => throw other
            }
            environmentReady match {
              case Reused(_, packages) => tell(s"$name reused", holding(packages))
              case Installed(_, packages, log) =>
                tell(
                  s"$name is ready (${String.format(Locale.ROOT, "%.1f", Double.box(waited))} s)",
                  s"${holding(packages)}\n\nIts install wrote:\n${log.mkString("\n")}"
                )
            }
            if (pending.decrementAndGet() == 0) prepared.complete(())
          } catch {
            case NonFatal(notPrepared) => prepared.completeExceptionally(notPrepared)
          }
        }
    }
    prepared
  }
}
