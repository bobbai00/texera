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

package org.apache.texera.common.compiler

import com.fasterxml.jackson.databind.node.ObjectNode
import com.google.protobuf.timestamp.Timestamp
import com.typesafe.scalalogging.{LazyLogging, Logger}
import org.apache.commons.vfs2.FileNotFoundException
import org.apache.texera.common.compiler.WorkflowCompiler.{
  bindResources,
  collectOutputSchemaFromPhysicalPlan,
  convertErrorListToWorkflowFatalErrorMap,
  normalizeStateReferences,
  unbindableStateReferences
}
import org.apache.texera.common.compiler.model.{LogicalPlan, LogicalPlanPojo}
import org.apache.texera.amber.core.executor.{OpExecWithCode, OperatorInputs}
import org.apache.texera.amber.core.state.StateReferencing.{
  literalReferences,
  noLoopVariableReferences
}
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.tuple.Schema
import org.apache.texera.amber.core.virtualidentity.OperatorIdentity
import org.apache.texera.amber.core.workflow.{
  GlobalPortIdentity,
  PhysicalLink,
  PhysicalOp,
  PhysicalPlan,
  PortIdentity,
  PreferCoordinator,
  PythonEnvironment,
  PythonEnvironmentRef,
  RepositoryMounts,
  WorkflowContext
}
import org.apache.texera.amber.core.workflowruntimestate.FatalErrorType.COMPILATION_ERROR
import org.apache.texera.amber.core.workflowruntimestate.WorkflowFatalError
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.apache.texera.amber.util.StackTraceUtils.getStackTraceWithAllCauses

import java.net.URISyntaxException
import java.time.Instant
import scala.collection.immutable.VectorMap
import scala.collection.mutable
import scala.collection.mutable.ArrayBuffer
import scala.jdk.CollectionConverters.IteratorHasAsScala
import scala.util.{Failure, Success, Try}

object WorkflowCompiler {
  // util function to convert the error list to an error map, and report the errors in the log
  private def convertErrorListToWorkflowFatalErrorMap(
      logger: Logger,
      errorList: List[(OperatorIdentity, Throwable)]
  ): Map[OperatorIdentity, WorkflowFatalError] = {
    val opIdToError = mutable.Map[OperatorIdentity, WorkflowFatalError]()
    errorList.foreach {
      case (opId, err) =>
        // map each error to WorkflowFatalError, and report them in the log
        logger.error(s"Error occurred in logical plan compilation for opId: $opId", err)
        // keep only the first error per operator: it is the root cause (e.g. a file
        // resolution failure), while later stages re-fail on the same operator with
        // less specific messages (e.g. schema propagation seeing an unresolved file)
        if (!opIdToError.contains(opId)) {
          opIdToError += (opId -> WorkflowFatalError(
            COMPILATION_ERROR,
            Timestamp(Instant.now),
            err.toString,
            getStackTraceWithAllCauses(err),
            opId.id
          ))
        }
    }
    opIdToError.toMap
  }

  /**
    * Makes `logicalOp`'s `stateReferences` sidecar final, before its physical plan serializes it
    * into the executor's descString. Inside a loop block it adds every whole-string `$name` value
    * of the operator's JSON (`StateReferencing.literalReferences`), and an entry in a property that
    * cannot hold a loop variable is an error (`referencesInNoLoopVariableProperties`). Outside
    * every block a string such as "$AAPL" stays a literal, and a typed placeholder (the user wrote
    * "$n" for an Int), which nothing would bind, is an error; it stays in the sidecar, so a
    * recompile reports it too.
    */
  def normalizeStateReferences(logicalOp: LogicalOp, plan: LogicalPlan): Option[Throwable] =
    if (plan.operatorsInsideLoopBlocks.contains(logicalOp.operatorIdentifier)) {
      logicalOp.stateReferences =
        literalReferences(objectMapper.valueToTree[ObjectNode](logicalOp)) ++
          logicalOp.stateReferences
      referencesInNoLoopVariableProperties(logicalOp)
        .orElse(inputsAheadOfLoopState(logicalOp, plan))
    } else {
      Option.when(logicalOp.stateReferences.nonEmpty) {
        new IllegalArgumentException(
          s"${logicalOp.operatorInfo.userFriendlyName} refers to loop variables " +
            s"(${formatReferences(logicalOp.stateReferences)}), but is not inside a loop block"
        )
      }
    }

  /**
    * The loop state writes a loop variable into the operator's setting only once the workflow runs,
    * but a property marked `NoLoopVariable` -- the name or type of an output column, or what an
    * input is partitioned on -- has been built into the plan by then: from the placeholder. A
    * Projection alias "$a" would output a column named "$a", null in every row; a SortPartitions
    * domain would stay 0 to 0. A reference there is an error instead.
    */
  private def referencesInNoLoopVariableProperties(logicalOp: LogicalOp): Option[Throwable] = {
    val references = noLoopVariableReferences(logicalOp)
    Option.when(references.nonEmpty) {
      val those = if (references.size == 1) "that property" else "those properties"
      new IllegalArgumentException(
        s"${logicalOp.operatorInfo.userFriendlyName} cannot refer to loop variables " +
          s"(${formatReferences(references)}): its output schema or partitioning is built from " +
          s"$those when the workflow is compiled, before the loop runs"
      )
    }
  }

  /**
    * The first tuple fails on a loop variable its state has not written yet, and the states of
    * the blocks around the operator come ahead of the tuples only on links from inside all of
    * them, or from the LoopStart of the innermost. An input with any other link is an error,
    * unless the operator reads it only after an input whose links all carry the state (a join's
    * probe input).
    */
  private def inputsAheadOfLoopState(logicalOp: LogicalOp, plan: LogicalPlan): Option[Throwable] = {
    val around = plan.enclosingLoopStarts
    val mine = around(logicalOp.operatorIdentifier)
    val linksByPort = plan.getUpstreamLinks(logicalOp.operatorIdentifier).groupBy(_.toPortId)
    // A LoopStart's link carries its own block's state too.
    def carriesOnlyState(port: PortIdentity): Boolean =
      linksByPort
        .get(port)
        .exists(_.forall { link =>
          mine.subsetOf(around.getOrElse(link.fromOpId, Set.empty) + link.fromOpId)
        })
    val exposed = logicalOp.operatorInfo.inputPorts.filter { input =>
      linksByPort.contains(input.id) && !carriesOnlyState(input.id) &&
      !input.dependencies.exists(carriesOnlyState)
    }
    Option.when(logicalOp.stateReferences.nonEmpty && exposed.nonEmpty) {
      val inputs = exposed.map { input =>
        if (input.displayName.nonEmpty) s"input '${input.displayName}'"
        else s"input port ${input.id.id}"
      }
      new IllegalArgumentException(
        s"${logicalOp.operatorInfo.userFriendlyName} refers to loop variables " +
          s"(${formatReferences(logicalOp.stateReferences)}), but its ${inputs.mkString(" and ")} " +
          s"${if (exposed.size == 1) "is" else "are"} fed from outside the loop block, so " +
          "tuples from there can arrive before the loop state"
      )
    }
  }

  /**
    * A reference is bound in the executor that `ExecFactory` builds from the descriptor's JSON: the
    * state message writes the loop variable into the descriptor that executor parsed. An operator
    * whose executor runs code instead -- a UDF, or a descriptor that generates Python from its
    * properties, such as the sklearn operators -- never takes that path: its code is built from the
    * placeholders before the loop runs, and nothing binds them.
    */
  def unbindableStateReferences(logicalOp: LogicalOp, subPlan: PhysicalPlan): Option[Throwable] =
    Option.when(
      logicalOp.stateReferences.nonEmpty &&
        subPlan.operators.exists(_.opExecInitInfo.isInstanceOf[OpExecWithCode])
    ) {
      new UnsupportedOperationException(
        s"${logicalOp.operatorInfo.userFriendlyName} cannot refer to loop variables yet " +
          s"(${formatReferences(logicalOp.stateReferences)}): its code is generated before " +
          "the loop runs"
      )
    }

  /** A descriptor's references as the compile errors name them: `/pointer -> $name, ...`. */
  private def formatReferences(references: Map[String, String]): String =
    references.toSeq.sorted.map { case (pointer, name) => s"$pointer -> $$$name" }.mkString(", ")

  /**
    * Pins the datasets and models `op` names, as a compile for a run does for every operator:
    * its executor names each version by the repository commit behind it, which it lists as what
    * to mount, and it no longer holds a binding. An operator that names none is returned as it
    * is.
    *
    * This is the only place a binding is forced. A paused execution's edited operator goes
    * through it too, so it is bound the way the rest of its plan was.
    *
    * @param repositories pins the versions, for the plan's user
    * @throws org.apache.commons.vfs2.FileNotFoundException if a version does not exist, or the
    *                                                       plan's user cannot read it
    */
  def bindResources(op: PhysicalOp, repositories: RepositoryVersionResolver): PhysicalOp =
    op.resourceBinding.fold(op) { binding =>
      val bound = binding.bind(repositories)
      op.copy(
        opExecInitInfo = bound.opExecInitInfo,
        repositoryMounts =
          Option.when(bound.mountLocators.nonEmpty)(RepositoryMounts(bound.mountLocators)),
        resourceBinding = None
      )
    }

  private def collectOutputSchemaFromPhysicalPlan(
      physicalPlan: PhysicalPlan,
      errorList: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): Map[OperatorIdentity, Map[PortIdentity, Option[Schema]]] = {

    // Collect output schemas per physical operator
    val physicalOutputSchemas =
      physicalPlan.operators.map { physicalOp =>
        val portSchemas = physicalOp.outputPorts.values
          .filterNot(_._1.id.internal)
          .map {
            case (port, _, schema) =>
              schema match {
                case Left(err) =>
                  errorList.append((physicalOp.id.logicalOpId, err))
                  port.id -> None
                case Right(validSchema) =>
                  port.id -> Some(validSchema)
              }
          }
          .toMap
        physicalOp.id -> portSchemas
      }

    // Group by logical operator ID and merge port schemas
    physicalOutputSchemas
      .groupBy(_._1.logicalOpId)
      .view
      .mapValues { list =>
        list.flatMap(_._2).toMap
      }
      .toMap
  }

}

case class WorkflowCompilationResult(
    physicalPlan: Option[PhysicalPlan], // if physicalPlan is None, compilation failed
    operatorIdToOutputSchemas: Map[OperatorIdentity, Map[PortIdentity, Option[Schema]]],
    operatorIdToError: Map[OperatorIdentity, WorkflowFatalError],
    outputPortsNeedingStorage: Set[GlobalPortIdentity]
)

/**
  * The single workflow compiler shared in-process by both compilation call sites: the
  * workflow-compiling-service, which compiles a workflow while it is edited, and amber, which
  * compiles it to make the plan of a run. What a compile is for ([[CompileFor]]) decides what
  * becomes of the errors of the workflow's operators and what is looked up for the plan.
  *
  * This module depends only on WorkflowOperator, so neither service leaks its HTTP stack into
  * the other; the engine `Workflow` wrapper stays in amber as a thin adapter over
  * [[WorkflowCompilationResult]]. `outputPortsNeedingStorage` is always computed — the
  * editing-path caller simply ignores it — keeping both paths on one code path.
  *
  * @param context the workflow and execution the compiler makes plans for: their ids stamp
  *                every operator
  * @param purpose what the plans are compiled for
  */
class WorkflowCompiler(context: WorkflowContext, purpose: CompileFor) extends LazyLogging {

  /**
    * Pins what the operators of `plan` name, as [[bindResources]] does, each operator by itself,
    * so that every operator's binding error is found. An operator's own error -- a version that
    * does not exist or that the plan's user may not read -- leaves it as it was, and is appended
    * to `errors`. Any other failure, such as the database not answering, is no error of the
    * operator's, and is thrown as it is.
    */
  private def bindPlanResources(
      plan: PhysicalPlan,
      repositories: RepositoryVersionResolver,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): PhysicalPlan =
    plan.operators
      .filter(_.resourceBinding.isDefined)
      .foldLeft(plan) { (boundPlan, op) =>
        Try(bindResources(op, repositories)) match {
          case Success(bound) => boundPlan.setOperator(bound)
          case Failure(notFound: FileNotFoundException) =>
            errors.append((op.id.logicalOpId, notFound))
            boundPlan
          case Failure(other) => throw other
        }
      }

  /**
    * Resolves the Python environments the operators of `plan` name: each operator that asks for
    * one by name carries what the plan's user keeps under that name, and prefers the
    * coordinator's node, the one node of a computing unit that installs environments. A name is
    * resolved once, however many operators ask for it, so the plan holds one environment under
    * it.
    *
    * An environment the plan's user does not have, or has with packages pip may not read, is the
    * error of every operator that names it: each is left as it was, and its error appended to
    * `errors`. Any other failure, such as the database not answering, is no error of an
    * operator's, and is thrown as it is.
    */
  private def bindPlanEnvironments(
      plan: PhysicalPlan,
      environments: PythonEnvironmentResolver,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): PhysicalPlan = {
    val resolved = mutable.Map.empty[String, Try[PythonEnvironment]]
    plan.operators.foldLeft(plan) { (boundPlan, op) =>
      op.pythonEnvironment match {
        case PythonEnvironmentRef.Named(name) =>
          resolved.getOrElseUpdate(name, Try(environments.resolve(name))) match {
            case Success(environment) =>
              boundPlan.setOperator(
                op.copy(
                  pythonEnvironment = PythonEnvironmentRef.Resolved(environment),
                  locationPreference = Some(PreferCoordinator)
                )
              )
            case Failure(error: PythonEnvironmentNotResolved) =>
              errors.append((op.id.logicalOpId, error))
              boundPlan
            case Failure(other) => throw other
          }
        case _ => boundPlan
      }
    }
  }

  /**
    * Names where each output port of `plan` is stored when the run stores it, in the run's
    * warehouse. Every port of every operator is named: which of them a run stores, for its user
    * to view or for a later region to read, is decided when the run is scheduled, and whatever
    * runs the plan stores a port where the plan says.
    *
    * An operator whose id cannot be part of a location is left as it was, and its error
    * appended to `errors`.
    */
  private def locateOutputPorts(
      plan: PhysicalPlan,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): PhysicalPlan =
    plan.operators.foldLeft(plan) { (locatedPlan, op) =>
      Try(op.withStorageLocations(context.warehouse)) match {
        case Success(located) => locatedPlan.setOperator(located)
        case Failure(error @ (_: IllegalArgumentException | _: URISyntaxException)) =>
          errors.append(
            (
              op.id.logicalOpId,
              new IllegalArgumentException(
                "The operator's id cannot name where its results are stored: " + error.getMessage,
                error
              )
            )
          )
          locatedPlan
        case Failure(other) => throw other
      }
    }

  /**
    * Fails a compile for a run with `errors`: each operator's first, listed in the order of
    * `logicalPlan`, an operator before those downstream of it, so that the cause of a chain of
    * errors comes first. The error of the operator listed first is the failure's cause, so that
    * a log of the failure shows where that error was thrown.
    */
  private def failWith(
      logicalPlan: LogicalPlan,
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): Nothing = {
    val position = logicalPlan.getTopologicalOpIds.asScala.zipWithIndex.toMap
    val operatorErrors = convertErrorListToWorkflowFatalErrorMap(logger, errors.toList).toSeq
      .sortBy { case (operator, _) => (position.getOrElse(operator, Int.MaxValue), operator.id) }
    val failure = new WorkflowCompilationFailed(VectorMap.from(operatorErrors))
    val (firstListed, _) = operatorErrors.head
    errors
      .collectFirst { case (operator, error) if operator == firstListed => error }
      .foreach(cause => failure.initCause(cause))
    throw failure
  }

  /**
    * Expands the logical plan to a physical plan, each physical operator with what its logical
    * operator reads from outside the run (`inputs`). An operator's error is appended to
    * `errors`, and the expansion goes on with the operators after it.
    * @return the expanded physical plan and a set of output ports that need storage
    */
  private def expandLogicalPlan(
      logicalPlan: LogicalPlan,
      inputs: Map[OperatorIdentity, OperatorInputs],
      logicalOpsToViewResult: List[String],
      errors: ArrayBuffer[(OperatorIdentity, Throwable)]
  ): (PhysicalPlan, Set[GlobalPortIdentity]) = {
    val terminalLogicalOps = logicalPlan.getTerminalOperatorIds
    val logicalOpsNeedingStorage =
      (terminalLogicalOps ++ logicalOpsToViewResult.map(OperatorIdentity(_))).toSet
    var physicalPlan = PhysicalPlan(operators = Set.empty, links = Set.empty)
    val outputPortsNeedingStorage: mutable.HashSet[GlobalPortIdentity] = mutable.HashSet()

    logicalPlan.getTopologicalOpIds.asScala.foreach { logicalOpId =>
      def report(error: Throwable): Unit = errors.append((logicalOpId, error))
      Try {
        val logicalOp = logicalPlan.getOperator(logicalOpId)
        val givenLinks = logicalPlan.getUpstreamLinks(logicalOp.operatorIdentifier)
        val upstreamLinks = givenLinks.distinct

        // A link given twice is still one link; expanded twice, each port it joins would list it
        // twice, and a plan to run lists each link once.
        givenLinks.diff(upstreamLinks).headOption.foreach { link =>
          report(
            new IllegalArgumentException(
              s"The link from output port ${link.fromPortId.id} of operator ${link.fromOpId.id} " +
                s"to input port ${link.toPortId.id} of operator ${link.toOpId.id} is given more " +
                "than once"
            )
          )
        }
        // Before the physical plan: the descriptor serializes its sidecar into its descString.
        normalizeStateReferences(logicalOp, logicalPlan).foreach(report)
        val read = inputs.getOrElse(logicalOpId, OperatorInputs.defaultInstance)
        val subPlan =
          logicalOp.getPhysicalPlan(context.workflowId, context.executionId, read)
        // Before the code-generation check below: the first error per operator is reported, and
        // code generated from a placeholder may fail on it with a less specific message.
        unbindableStateReferences(logicalOp, subPlan).foreach(report)
        subPlan
          .topologicalIterator()
          .map(subPlan.getOperator)
          .foreach({ physicalOp =>
            {
              // An input port can wait only for input ports of its own operator: the engine would
              // wait forever for one the operator does not have. A UDF's ports are the user's to
              // set.
              for {
                (port, _, _) <- physicalOp.inputPorts.values
                dependee <- port.dependencies.find(!physicalOp.inputPorts.contains(_))
              } {
                report(
                  new IllegalArgumentException(
                    s"Input port ${port.id.id} of ${logicalOp.operatorInfo.userFriendlyName} " +
                      s"depends on input port ${dependee.id}, which the operator does not have"
                  )
                )
              }

              val externalLinks = upstreamLinks
                .filter(link => physicalOp.inputPorts.contains(link.toPortId))
                .flatMap { link =>
                  physicalPlan
                    .getPhysicalOpsOfLogicalOp(link.fromOpId)
                    .find(_.outputPorts.contains(link.fromPortId))
                    .map(fromOp =>
                      PhysicalLink(fromOp.id, link.fromPortId, physicalOp.id, link.toPortId)
                    )
                }

              val internalLinks = subPlan.getUpstreamPhysicalLinks(physicalOp.id)

              // Add the operator to the physical plan
              physicalPlan = physicalPlan.addOperator(physicalOp.withInputs(read).propagateSchema())

              // Add all the links to the physical plan
              physicalPlan = (externalLinks ++ internalLinks)
                .foldLeft(physicalPlan) { (plan, link) => plan.addLink(link) }

              // **Check for Python-based operator errors during code generation**
              if (physicalOp.isPythonBased) {
                val code = physicalOp.getCode
                val exceptionPattern = """#EXCEPTION DURING CODE GENERATION:\s*(.*)""".r

                exceptionPattern.findFirstMatchIn(code).foreach { matchResult =>
                  val errorMessage = matchResult.group(1).trim
                  // Store the error and continue
                  report(
                    new RuntimeException(s"Operator is not configured properly: $errorMessage")
                  )
                }
              }
            }
          })

        // convert logical operators needing storage to output ports needing storage
        subPlan
          .topologicalIterator()
          .filter(opId => logicalOpsNeedingStorage.contains(opId.logicalOpId))
          .map(physicalPlan.getOperator)
          .foreach { physicalOp =>
            physicalOp.outputPorts
              .filterNot(_._1.internal)
              .foreach {
                case (outputPortId, _) =>
                  outputPortsNeedingStorage += GlobalPortIdentity(
                    opId = physicalOp.id,
                    portId = outputPortId
                  )
              }
          }
      }.failed.foreach(report)
    }
    (physicalPlan, outputPortsNeedingStorage.toSet)
  }

  /**
    * Compiles a workflow to a physical plan, along with the schema propagation result and
    * errors (if any).
    *
    * @param logicalPlanPojo the POJO parsed from the workflow string provided by the user
    * @return WorkflowCompilationResult, containing the physical plan, output schemas per op, errors
    *         per op, and the output ports that need storage
    * @throws WorkflowCompilationFailed if the compile is for a run and an operator has an error:
    *                                   with each such operator's first error, upstream operators
    *                                   first. A failure that is no operator's error, such as the
    *                                   database or the storage not answering, is thrown as it is,
    *                                   whatever the compile is for.
    */
  def compile(logicalPlanPojo: LogicalPlanPojo): WorkflowCompilationResult = {
    // Every step below appends an operator's error here and goes on with the other operators, so
    // that a compile finds them all: for editing it returns them, for a run it throws them
    // together.
    val errors = new ArrayBuffer[(OperatorIdentity, Throwable)]()

    // 1. convert the pojo to logical plan
    val logicalPlan: LogicalPlan = LogicalPlan(logicalPlanPojo)

    // 2. find what each operator reads from outside the run: the file of each scan source,
    // resolved, and the site's settings it is read under; and, for a run, the link to that
    // file, the listing of each File Lister's dataset version, and the links to the files
    // listed upstream of each File Scan From Input
    val inputs = new InputBinder(purpose, errors).inputsOf(logicalPlan)

    // 3. expand the logical plan to the physical plan, and get the output ports that need storage
    val (expandedPlan, outputPortsNeedingStorage) =
      expandLogicalPlan(logicalPlan, inputs, logicalPlanPojo.opsToViewResult, errors)

    // 4. collect the output schema for each logical op
    // even if an error is encountered during logical => physical expansion, we still want to
    // collect the output schemas of the remaining no-error operators. Schema-propagation failures
    // are errors of their operators too (e.g. a Projection on a missing column, which would
    // otherwise be launched and only fail at runtime).
    val opIdToOutputSchema = collectOutputSchemaFromPhysicalPlan(expandedPlan, errors)

    val physicalPlan = purpose match {
      case _: CompileFor.Editing =>
        // The editing path leaves the bindings alone.
        expandedPlan
      case run: CompileFor.Run =>
        if (errors.nonEmpty) failWith(logicalPlan, errors)
        // 5. a plan made to run resolves the Python environments its operators name, pins
        // their datasets and models and names where its output ports are stored, last, once the
        // plan is otherwise valid: the engine is handed what to install, the final code, the
        // repositories to mount and the locations to write to, never a name to look up, a
        // binding or a location to make up.
        val boundPlan = locateOutputPorts(
          bindPlanResources(
            bindPlanEnvironments(expandedPlan, run.environments, errors),
            run.repositories,
            errors
          ),
          errors
        )
        if (errors.nonEmpty) failWith(logicalPlan, errors)
        boundPlan
    }

    WorkflowCompilationResult(
      physicalPlan = if (errors.nonEmpty) None else Some(physicalPlan),
      operatorIdToOutputSchemas = opIdToOutputSchema,
      // map each error from OpId to WorkflowFatalError, and report them via logger
      operatorIdToError = convertErrorListToWorkflowFatalErrorMap(logger, errors.toList),
      outputPortsNeedingStorage = outputPortsNeedingStorage
    )
  }
}
