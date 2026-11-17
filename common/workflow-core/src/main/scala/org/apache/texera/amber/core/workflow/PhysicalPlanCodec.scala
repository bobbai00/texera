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

package org.apache.texera.amber.core.workflow

import com.fasterxml.jackson.core.StreamReadFeature
import com.fasterxml.jackson.core.util.{DefaultIndenter, DefaultPrettyPrinter, Separators}
import com.fasterxml.jackson.databind.DeserializationFeature
import com.google.protobuf.empty.Empty
import org.apache.texera.amber.core.storedplan.StoredAttribute.{AttributeType => StoredType}
import org.apache.texera.amber.core.storedplan.StoredPartitionInfo.Kind
import org.apache.texera.amber.core.storedplan.StoredPartitionRequirement.Requirement
import org.apache.texera.amber.core.storedplan.StoredPartitionRule.Rule
import org.apache.texera.amber.core.storedplan.StoredPhysicalOp.{
  LocationPreference => StoredLocation
}
import org.apache.texera.amber.core.storedplan.StoredPlanInput.Source
import org.apache.texera.amber.core.storedplan.StoredWorkflowSettings.{ExecutionMode => StoredMode}
import org.apache.texera.amber.core.storedplan._
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.jgrapht.graph.DirectedAcyclicGraph
import org.jgrapht.util.SupplierUtil
import org.json4s.jackson.JsonMethods
import org.json4s.{JArray, JInt, JNull, JObject, JValue}
import scalapb.descriptors.{PEmpty, PMessage, PRepeated, ScalaType}
import scalapb.json4s.{Parser, Printer}
import scalapb.{GeneratedEnum, GeneratedMessage, GeneratedMessageCompanion}

import java.net.{URI, URISyntaxException}
import scala.util.control.NonFatal

/**
  * Saves an execution's plan, a physical plan made to run with the context it runs under and
  * what else the run needs ([[ExecutionPlan]]), and reads it back; and likewise a change to one
  * operator of a paused run ([[OperatorUpdate]]).
  *
  * A plan is saved as a [[StoredPhysicalPlan]] message (storedplan.proto), and the message as
  * JSON text. Reading it back gives the plan the engine runs: the same operators, executors,
  * ports, schemas, links and settings, with the run's cost hints, where it replays from, where
  * it writes its replay log, and what its operators read from outside it. The plan read back is
  * built by inserting in the order the message lists things, so it iterates its links, each
  * operator's ports, each port's links and the ports whose results are stored in the order the
  * saved plan did, since the engine's scheduling can depend on it; and its operators too, when
  * there are at most four. A set of more than four operators iterates in the order of their hash
  * codes, which take in identity hashes (of a schema propagation function, say): that order
  * differs between two compiles of a workflow, and no order saved could bring it back. Such
  * operators are saved in the order of their ids instead, and the cost hints and inputs, which
  * the plan holds in no order, by their operators' ids and the inputs' names, so a plan is saved
  * as the same text every time.
  *
  * Only a plan made to run can be saved: no operator still holds a resource binding or names a
  * Python environment that was never resolved, every port has its schema, and the links form no
  * cycle. A plan read back can be run but not compiled again: each port keeps its schema, but no
  * operator keeps the function that derived it ([[ReadBackSchemaPropagation]] takes its place).
  *
  * A change to an operator is saved as a [[StoredOperatorUpdate]], in the same format version:
  * only what the engine applies to the running operator, its executor and what its code reads.
  *
  * Text is read only in the form [[toJson]] and [[updateToJson]] write, but for the order of an
  * object's fields and the spacing: a plan cut short, edited by hand, or written by another
  * writer that differs is refused, rather than read with defaults in place of what it leaves out.
  */
object PhysicalPlanCodec {

  /** The version of the format this codec writes, and the only one it reads. */
  val FormatVersion: Int = 3

  /**
    * The schema propagation function of every operator read back. A saved plan holds each port's
    * schema but not the function the compile derived it with, so an operator read back cannot
    * derive schemas again: this function fails, and `PhysicalOp.propagateSchema` records the
    * failure on each output port. PhysicalOp's default, the identity, would instead copy each
    * input schema onto the output port of the same number, a wrong schema that nothing reports.
    * Nothing derives schemas in a plan that runs; this keeps a later change that does from
    * running on wrong schemas unnoticed.
    */
  val ReadBackSchemaPropagation: SchemaPropagationFunc = SchemaPropagationFunc(_ =>
    throw new UnsupportedOperationException(
      "This operator was read back from a saved plan, which holds its schemas but not the " +
        "function that derived them, so it cannot derive them again."
    )
  )

  private val attributeTypes: Seq[(AttributeType, StoredType)] = Seq(
    AttributeType.STRING -> StoredType.STRING,
    AttributeType.INTEGER -> StoredType.INTEGER,
    AttributeType.LONG -> StoredType.LONG,
    AttributeType.DOUBLE -> StoredType.DOUBLE,
    AttributeType.BOOLEAN -> StoredType.BOOLEAN,
    AttributeType.TIMESTAMP -> StoredType.TIMESTAMP,
    AttributeType.BINARY -> StoredType.BINARY,
    AttributeType.LARGE_BINARY -> StoredType.LARGE_BINARY,
    AttributeType.ANY -> StoredType.ANY
  )
  private val storedTypeOf: Map[AttributeType, StoredType] = attributeTypes.toMap
  private val attributeTypeOf: Map[StoredType, AttributeType] = attributeTypes.map(_.swap).toMap

  // A Scala set of up to this many elements iterates in the order they were added in.
  private val smallSetSize = 4

  // Field names as the proto writes them, and every field written out, defaults included.
  private val printer = new Printer().includingDefaultValueFields.preservingProtoFieldNames
  // Refuses a field the format does not have.
  private val parser = new Parser()
  // Two-space indents, `"name": value`, a line per array item, and "\n" on every platform.
  private val jsonWriter = {
    val lines = new DefaultIndenter("  ", "\n")
    JsonMethods.mapper.writer(
      new DefaultPrettyPrinter()
        .withSeparators(
          Separators
            .createDefaultInstance()
            .withObjectFieldValueSpacing(Separators.Spacing.AFTER)
            .withObjectEmptySeparator("")
            .withArrayEmptySeparator("")
        )
        .withObjectIndenter(lines)
        .withArrayIndenter(lines)
    )
  }
  // Reads JSON text as json4s's parse does, but refuses a field given twice in an object, or
  // anything after the first value.
  private val jsonReader = JsonMethods.mapper
    .readerFor(classOf[JValue])
    .without(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
    .`with`(DeserializationFeature.USE_BIG_INTEGER_FOR_INTS)
    .`with`(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
    .`with`(StreamReadFeature.STRICT_DUPLICATE_DETECTION)

  /**
    * A kind of message the codec saves as text, for what is shared between them: the version
    * check, and reading and writing JSON.
    *
    * @param noun      what messages call one: "plan", say
    * @param title     what it is, for a message that says text is not one
    * @param companion the message's companion
    */
  private final case class Saved[M <: GeneratedMessage](
      noun: String,
      title: String,
      companion: GeneratedMessageCompanion[M]
  )

  private val SavedPlan = Saved("plan", "saved physical plan", StoredPhysicalPlan)
  private val SavedUpdate = Saved("operator update", "saved operator update", StoredOperatorUpdate)

  /**
    * Saves `plan`. The ids, settings, warehouse and cost hints come from its context. Its cost
    * hints are saved in the order of their operators' ids, and its inputs in the order of their
    * operators' ids, then their names.
    *
    * @throws IllegalArgumentException if the physical plan is not one made to run under the
    *                                  context: an operator still holds a resource binding, names
    *                                  a Python environment that was never resolved, has no
    *                                  executor, belongs to another workflow or execution, or has
    *                                  a port with no schema; its links and ports disagree, its
    *                                  links form a cycle, or a port depends on one its operator
    *                                  does not have; or the settings store the results of a port
    *                                  it does not have, or send batches of fewer than one tuple.
    *                                  Or if what else the run needs is not one [[decode]] reads
    *                                  back: see [[decode]].
    */
  def encode(plan: ExecutionPlan): StoredPhysicalPlan = {
    val context = plan.context
    val physicalPlan = plan.plan
    physicalPlan.operators.foreach(requireRunnableUnder(context, _))
    requireConsistent(physicalPlan, context.workflowSettings.outputPortsNeedingStorage)
    StoredPhysicalPlan(
      formatVersion = FormatVersion,
      workflowId = Some(context.workflowId),
      executionId = Some(context.executionId),
      settings = Some(encodeSettings(context.workflowSettings)),
      warehouse = context.warehouse,
      operators = storedOrder(physicalPlan.operators).map(encodeOperator),
      links = physicalPlan.links.toSeq,
      replay = plan.replay.map(encodeReplay),
      replayLogLocation = plan.replayLog.map(requireAbsolute(writesReplayLogTo, _)).map(_.toString),
      costHints = context.costHints.map(encodeCostHints),
      inputs = encodeInputs(plan.inputs, physicalPlan)
    )
  }

  /**
    * Reads a saved plan back, with the context it runs under: the plan's ids, settings,
    * warehouse and cost hints.
    *
    * The plan is for running, not for compiling again. Each port has the schema the compile gave
    * it, but each operator's `propagateSchema` is [[ReadBackSchemaPropagation]], since the
    * function the compile used is not saved: propagating schemas through the plan, or adding a
    * link to it, leaves each output port it reaches with that function's error instead of a
    * schema. Operators and links are built as saved, with no schema propagated.
    *
    * @throws IllegalArgumentException if the plan is in another format version, leaves out
    *                                  something it must have, holds a value this version does
    *                                  not know, or is not a plan [[encode]] saves. Of an
    *                                  operator's Python environment, that is: a blank name,
    *                                  requirements that are not canonical lines, sorted, each
    *                                  once, or a digest that is not theirs. Of what the run
    *                                  needs besides the physical plan: a replay or cost hints
    *                                  from an execution whose id is below 1; a replay up to a
    *                                  blank interaction; a log not at an absolute URI; cost hints
    *                                  for an operator with no id, or with a cost that is not a
    *                                  finite number of seconds, at least 0; cost hints or inputs
    *                                  out of order, or given twice; or an input of an operator
    *                                  the plan does not have, with no name or source, or of a
    *                                  file whose link expires at the epoch or before, or whose
    *                                  size is below 0
    */
  def decode(stored: StoredPhysicalPlan): ExecutionPlan = {
    requireVersion(SavedPlan, stored.formatVersion)
    val workflowId = stored.workflowId.getOrElse(refuse("The plan names no workflow."))
    val executionId = stored.executionId.getOrElse(refuse("The plan names no execution."))
    val settings = decodeSettings(stored.settings.getOrElse(refuse("The plan has no settings.")))
    val operators = stored.operators.map(decodeOperator(workflowId, executionId))
    requireDistinct(operators.map(_.id))(id => s"Operator ${show(id)}")
    requireDistinct(stored.links)(link => s"Link ${show(link)}")
    val plan = PhysicalPlan(operators.toSet, stored.links.toSet)
    requireConsistent(plan, settings.outputPortsNeedingStorage)
    ExecutionPlan(
      context = new WorkflowContext(
        workflowId,
        executionId,
        settings,
        warehouse = stored.warehouse,
        costHints = stored.costHints.map(decodeCostHints)
      ),
      plan = plan,
      replay = stored.replay.map(decodeReplay),
      replayLog = stored.replayLogLocation.map(absoluteUriOf(writesReplayLogTo, _)),
      inputs = decodeInputs(stored.inputs, plan)
    )
  }

  /** The JSON text of a saved plan. */
  def toJson(stored: StoredPhysicalPlan): String = write(SavedPlan, stored)

  /**
    * Parses the JSON text of a saved plan, refusing one in another format version, or one not in
    * the form [[toJson]] writes; [[decode]] checks the rest.
    *
    * @throws IllegalArgumentException if the text is not one JSON object, or has a field twice;
    *                                  is in another format version; has a field the format does
    *                                  not have; or leaves out a field, or writes one, otherwise
    *                                  than [[toJson]] does
    */
  def fromJson(json: String): StoredPhysicalPlan = read(SavedPlan, json)

  /**
    * Saves a change to operator `op` of the paused execution `executionId`, under `updateId`:
    * the operator's id, its executor, and the datasets and models its code reads. Nothing else of
    * the operator is saved; the engine keeps the rest as the running plan has it.
    *
    * @throws IllegalArgumentException if `updateId` is blank, or `op` is not one made to run in
    *                                  that execution: it still holds a resource binding, has no
    *                                  executor, or belongs to another execution
    */
  def encodeUpdate(
      executionId: ExecutionIdentity,
      updateId: String,
      op: PhysicalOp
  ): StoredOperatorUpdate = {
    val name = show(op.id)
    requireUpdateId(updateId)
    if (op.resourceBinding.isDefined) {
      refuse(
        s"Operator $name names datasets or models that were never resolved: only an operator " +
          "made to run can be saved as an update."
      )
    }
    if (op.executionId != executionId) {
      refuse(
        s"Operator $name belongs to execution ${op.executionId.id}, but the update is saved for " +
          s"execution ${executionId.id}."
      )
    }
    if (op.opExecInitInfo.isEmpty) refuse(s"The update of operator $name gives it no executor.")
    StoredOperatorUpdate(
      formatVersion = FormatVersion,
      executionId = Some(executionId),
      updateId = updateId,
      opId = Some(op.id),
      opExecInitInfo = op.opExecInitInfo,
      repositoryMounts = op.repositoryMounts.map(encodeMounts)
    )
  }

  /**
    * Reads a saved change to an operator back.
    *
    * @throws IllegalArgumentException if the change is in another format version, names no
    *                                  execution or operator, has a blank id, gives the operator
    *                                  no executor, or names mounts [[RepositoryMounts]] refuses
    */
  def decodeUpdate(stored: StoredOperatorUpdate): OperatorUpdate = {
    requireVersion(SavedUpdate, stored.formatVersion)
    val executionId =
      stored.executionId.getOrElse(refuse("The operator update names no execution."))
    requireUpdateId(stored.updateId)
    val opId = stored.opId.getOrElse(refuse("The operator update names no operator."))
    val name = show(opId)
    if (stored.opExecInitInfo.isEmpty) refuse(s"The update of operator $name gives it no executor.")
    OperatorUpdate(
      executionId = executionId,
      updateId = stored.updateId,
      opId = opId,
      opExecInitInfo = stored.opExecInitInfo,
      repositoryMounts = stored.repositoryMounts.map(decodeMounts(name))
    )
  }

  /** The JSON text of a saved change to an operator. */
  def updateToJson(stored: StoredOperatorUpdate): String = write(SavedUpdate, stored)

  /**
    * Parses the JSON text of a saved change to an operator, as strictly as [[fromJson]] parses
    * a plan's; [[decodeUpdate]] checks the rest.
    *
    * @throws IllegalArgumentException as [[fromJson]] does, for a change to an operator
    */
  def updateFromJson(json: String): StoredOperatorUpdate = read(SavedUpdate, json)

  // ----- encoding -----

  private def requireRunnableUnder(context: WorkflowContext, op: PhysicalOp): Unit = {
    val name = show(op.id)
    if (op.resourceBinding.isDefined) {
      refuse(
        s"Operator $name names datasets or models that were never resolved: only a plan made " +
          "to run can be saved."
      )
    }
    op.pythonEnvironment match {
      case PythonEnvironmentRef.Named(environment) =>
        refuse(
          s"Operator $name names the Python environment '$environment', which was never " +
            "resolved: only a plan made to run can be saved."
        )
      case _ =>
    }
    if (op.workflowId != context.workflowId) {
      refuse(
        s"Operator $name belongs to workflow ${op.workflowId.id}, but the plan is saved for " +
          s"workflow ${context.workflowId.id}."
      )
    }
    if (op.executionId != context.executionId) {
      refuse(
        s"Operator $name belongs to execution ${op.executionId.id}, but the plan is saved for " +
          s"execution ${context.executionId.id}."
      )
    }
    if (op.opExecInitInfo.isEmpty) refuse(s"Operator $name has no executor.")
    val ports =
      op.inputPorts.map { case (key, (port, _, schema)) => ("input", key, port.id, schema) } ++
        op.outputPorts.map { case (key, (port, _, schema)) => ("output", key, port.id, schema) }
    ports.foreach {
      case (side, key, id, schema) =>
        if (key != id) {
          refuse(s"Operator $name keeps its $side port ${show(id)} under port ${show(key)}.")
        }
        schema.left.foreach { error =>
          refuse(s"The $side port ${show(id)} of operator $name has no schema: ${error.getMessage}")
        }
    }
  }

  /**
    * The operators in the order they are saved in: the order the set iterates them in, which the
    * plan read back keeps, or, for a set too large to keep it, the order of their ids.
    */
  private def storedOrder(operators: Set[PhysicalOp]): Seq[PhysicalOp] =
    if (operators.size <= smallSetSize) operators.toSeq
    else operators.toSeq.sortBy(op => (op.id.logicalOpId.id, op.id.layerName))

  private def encodeSettings(settings: WorkflowSettings): StoredWorkflowSettings = {
    requireBatchSize(settings.dataTransferBatchSize)
    StoredWorkflowSettings(
      dataTransferBatchSize = settings.dataTransferBatchSize,
      executionMode = settings.executionMode match {
        case ExecutionMode.PIPELINED    => StoredMode.PIPELINED
        case ExecutionMode.MATERIALIZED => StoredMode.MATERIALIZED
        case other                      => refuse(s"The execution mode $other cannot be saved.")
      },
      outputPortsNeedingStorage = settings.outputPortsNeedingStorage.toSeq
    )
  }

  private def encodeOperator(op: PhysicalOp): StoredPhysicalOp =
    StoredPhysicalOp(
      id = Some(op.id),
      opExecInitInfo = op.opExecInitInfo,
      parallelizable = op.parallelizable,
      locationPreference = op.locationPreference match {
        case None                       => StoredLocation.NO_PREFERENCE
        case Some(PreferCoordinator)    => StoredLocation.PREFER_COORDINATOR
        case Some(RoundRobinPreference) => StoredLocation.ROUND_ROBIN
      },
      partitionRequirement = op.partitionRequirement.map(required =>
        StoredPartitionRequirement(required match {
          case Some(partition) => Requirement.Partition(encodePartition(partition))
          case None            => Requirement.NoRequirement(Empty())
        })
      ),
      outputPartitionRule = Some(encodeRule(op.outputPartitionRule)),
      // every schema is a Right: requireRunnableUnder refused the plan otherwise
      inputPorts = op.inputPorts.values.toSeq.map {
        case (port, links, schema) =>
          StoredInputPort(Some(port), links, schema.toOption.map(encodeSchema))
      },
      outputPorts = op.outputPorts.values.toSeq.map {
        case (port, links, schema) =>
          StoredOutputPort(Some(port), links, schema.toOption.map(encodeSchema))
      },
      isOneToManyOp = op.isOneToManyOp,
      requiresMaterializedExecution = op.requiresMaterializedExecution,
      isLoopStart = op.isLoopStart,
      suggestedWorkerNum = op.suggestedWorkerNum,
      repositoryMounts = op.repositoryMounts.map(encodeMounts),
      // a name never resolved is not saved: requireRunnableUnder refused the plan
      pythonEnvironment = op.pythonEnvironment match {
        case PythonEnvironmentRef.Resolved(environment) =>
          Some(
            StoredPythonEnvironment(environment.name, environment.requirements, environment.digest)
          )
        case _ => None
      }
    )

  private def encodeMounts(mounts: RepositoryMounts): StoredRepositoryMounts =
    StoredRepositoryMounts(mounts.root, mounts.locators.toSeq)

  private def encodeReplay(replay: ReplaySource): StoredReplaySource = {
    val sourceExecutionId = replay.sourceExecutionId.id
    requireReplay(sourceExecutionId, replay.interaction)
    StoredReplaySource(
      sourceExecutionId = sourceExecutionId,
      logLocation = requireAbsolute(replaysLogOf(sourceExecutionId), replay.logLocation).toString,
      interaction = replay.interaction
    )
  }

  private def encodeCostHints(hints: CostHints): StoredCostHints = {
    val stored = StoredCostHints(
      sourceExecutionId = hints.sourceExecutionId.id,
      operators = hints.secondsByLogicalOperator.toSeq.sortBy(_._1).map {
        case (logicalOperatorId, seconds) => StoredOperatorCost(logicalOperatorId, seconds)
      }
    )
    requireCostHints(stored)
    stored
  }

  private def encodeInputs(inputs: Seq[PlanInput], plan: PhysicalPlan): Seq[StoredPlanInput] = {
    val stored = inputs
      .map { input =>
        StoredPlanInput(
          logicalOperatorId = input.logicalOperatorId.id,
          name = input.name,
          source = Source.File(StoredInputFile(input.file.expiresAtMs, input.file.sizeBytes))
        )
      }
      .sortBy(input => (input.logicalOperatorId, input.name))
    requireInputs(stored, plan)
    stored
  }

  private def encodePartition(partition: PartitionInfo): StoredPartitionInfo =
    StoredPartitionInfo(partition match {
      case HashPartition(names)            => Kind.Hash(StoredHashPartition(names))
      case RangePartition(names, min, max) => Kind.Range(StoredRangePartition(names, min, max))
      case SinglePartition()               => Kind.Single(Empty())
      case OneToOnePartition()             => Kind.OneToOne(Empty())
      case BroadcastPartition()            => Kind.Broadcast(Empty())
      case UnknownPartition()              => Kind.Unknown(Empty())
    })

  private def encodeRule(rule: PartitionRule): StoredPartitionRule =
    StoredPartitionRule(rule match {
      case PartitionRule.FirstInput       => Rule.FirstInput(Empty())
      case PartitionRule.KeepKeyedInput   => Rule.KeepKeyedInput(Empty())
      case PartitionRule.Fixed(partition) => Rule.Fixed(encodePartition(partition))
    })

  private def encodeSchema(schema: Schema): StoredSchema =
    StoredSchema(schema.attributes.map { attribute =>
      StoredAttribute(
        attribute.getName,
        storedTypeOf.getOrElse(
          attribute.getType,
          refuse(s"The attribute type ${attribute.getType.name} cannot be saved.")
        )
      )
    })

  // ----- decoding -----

  private def decodeSettings(stored: StoredWorkflowSettings): WorkflowSettings = {
    requireBatchSize(stored.dataTransferBatchSize)
    requireDistinct(stored.outputPortsNeedingStorage)(port => s"The stored ${show(port)}")
    WorkflowSettings(
      dataTransferBatchSize = stored.dataTransferBatchSize,
      executionMode = stored.executionMode match {
        case StoredMode.PIPELINED    => ExecutionMode.PIPELINED
        case StoredMode.MATERIALIZED => ExecutionMode.MATERIALIZED
        case other                   => refuseEnum("The plan's execution mode", other)
      },
      outputPortsNeedingStorage = stored.outputPortsNeedingStorage.toSet
    )
  }

  private def decodeOperator(workflowId: WorkflowIdentity, executionId: ExecutionIdentity)(
      stored: StoredPhysicalOp
  ): PhysicalOp = {
    val id = stored.id.getOrElse(refuse("An operator of the plan has no id."))
    val name = show(id)
    if (stored.opExecInitInfo.isEmpty) refuse(s"Operator $name has no executor.")
    val locationPreference = stored.locationPreference match {
      case StoredLocation.NO_PREFERENCE      => None
      case StoredLocation.PREFER_COORDINATOR => Some(PreferCoordinator)
      case StoredLocation.ROUND_ROBIN        => Some(RoundRobinPreference)
      case other =>
        refuseEnum(s"The location preference of operator $name", other)
    }
    val partitionRequirement = stored.partitionRequirement.toList.zipWithIndex.map {
      case (required, port) =>
        val what = s"The partition requirement on input port $port of operator $name"
        required.requirement match {
          case Requirement.Partition(partition) => Some(decodePartition(what)(partition))
          case Requirement.NoRequirement(_)     => None
          case Requirement.Empty                => refuse(s"$what names neither a partitioning nor none.")
        }
    }
    val outputPartitionRule = stored.outputPartitionRule
      .getOrElse(refuse(s"Operator $name has no output partition rule."))
      .rule match {
      case Rule.FirstInput(_)     => PartitionRule.FirstInput
      case Rule.KeepKeyedInput(_) => PartitionRule.KeepKeyedInput
      case Rule.Fixed(partition) =>
        PartitionRule.Fixed(
          decodePartition(s"The output partition rule of operator $name")(partition)
        )
      case Rule.Empty => refuse(s"The output partition rule of operator $name names no rule.")
    }
    stored.outputPorts.flatMap(_.port).foreach { port =>
      if (port.mode.isUnrecognized) {
        refuseEnum(s"The mode of output port ${show(port.id)} of operator $name", port.mode)
      }
    }
    PhysicalOp(
      id = id,
      workflowId = workflowId,
      executionId = executionId,
      opExecInitInfo = stored.opExecInitInfo,
      parallelizable = stored.parallelizable,
      locationPreference = locationPreference,
      partitionRequirement = partitionRequirement,
      outputPartitionRule = outputPartitionRule,
      inputPorts = decodePorts(
        name,
        "input",
        stored.inputPorts.map { port =>
          (port.port, port.links, port.schema)
        }
      )(_.id),
      outputPorts = decodePorts(
        name,
        "output",
        stored.outputPorts.map { port =>
          (port.port, port.links, port.schema)
        }
      )(_.id),
      propagateSchema = ReadBackSchemaPropagation,
      isOneToManyOp = stored.isOneToManyOp,
      requiresMaterializedExecution = stored.requiresMaterializedExecution,
      isLoopStart = stored.isLoopStart,
      suggestedWorkerNum = stored.suggestedWorkerNum,
      pythonEnvironment = stored.pythonEnvironment
        .map(decodeEnvironment(name))
        .getOrElse(PythonEnvironmentRef.EngineDefault),
      repositoryMounts = stored.repositoryMounts.map(decodeMounts(name))
    )
  }

  /**
    * The environment operator `operator` runs in, as [[PythonEnvironment]] takes it: only what
    * pip may read, under the digest of its requirements.
    */
  private def decodeEnvironment(
      operator: String
  )(stored: StoredPythonEnvironment): PythonEnvironmentRef = {
    val environment =
      try PythonEnvironment(stored.name, stored.requirements)
      catch {
        case e: IllegalArgumentException =>
          refuse(s"Operator $operator cannot run in the environment it names: ${e.getMessage}", e)
      }
    if (stored.digest != environment.digest) {
      refuse(
        s"The Python environment '${environment.name}' of operator $operator is saved under the " +
          s"digest '${stored.digest}', but its requirements have the digest ${environment.digest}."
      )
    }
    PythonEnvironmentRef.Resolved(environment)
  }

  /** The mounts of operator `operator`, as [[RepositoryMounts]] takes them. */
  private def decodeMounts(operator: String)(mounts: StoredRepositoryMounts): RepositoryMounts = {
    requireDistinct(mounts.locators)(locator => s"Repository $locator of operator $operator")
    try RepositoryMounts(mounts.root, mounts.locators.toSet)
    catch {
      case e: IllegalArgumentException =>
        refuse(s"Operator $operator cannot mount what it names: ${e.getMessage}", e)
    }
  }

  private def decodeReplay(stored: StoredReplaySource): ReplaySource = {
    requireReplay(stored.sourceExecutionId, stored.interaction)
    ReplaySource(
      sourceExecutionId = ExecutionIdentity(stored.sourceExecutionId),
      logLocation = absoluteUriOf(replaysLogOf(stored.sourceExecutionId), stored.logLocation),
      interaction = stored.interaction
    )
  }

  private def decodeCostHints(stored: StoredCostHints): CostHints = {
    requireCostHints(stored)
    CostHints(
      ExecutionIdentity(stored.sourceExecutionId),
      stored.operators.map(cost => cost.logicalOperatorId -> cost.seconds).toMap
    )
  }

  private def decodeInputs(stored: Seq[StoredPlanInput], plan: PhysicalPlan): Seq[PlanInput] = {
    requireInputs(stored, plan)
    stored.map { input =>
      // a file: requireInputs refused an input that names nothing it reads
      val file = input.getFile
      PlanInput(
        OperatorIdentity(input.logicalOperatorId),
        input.name,
        InputFile(file.expiresAtMs, file.sizeBytes)
      )
    }
  }

  /** An operator's ports on one side, keyed by port id, built in the order they are stored. */
  private def decodePorts[P](
      operator: String,
      side: String,
      stored: Seq[(Option[P], Seq[PhysicalLink], Option[StoredSchema])]
  )(
      idOf: P => PortIdentity
  ): Map[PortIdentity, (P, List[PhysicalLink], Either[Throwable, Schema])] = {
    val ports = stored.map {
      case (port, links, schema) =>
        val definedPort = port.getOrElse(refuse(s"An $side port of operator $operator is empty."))
        val id = idOf(definedPort)
        val where = s"$side port ${show(id)} of operator $operator"
        val attributes = schema.getOrElse(refuse(s"The $where has no schema.")).attributes
        val decoded = Schema(attributes.toList.map { attribute =>
          val attributeType = attributeTypeOf.getOrElse(
            attribute.attributeType,
            refuseEnum(
              s"The type of attribute ${attribute.attributeName} on the $where",
              attribute.attributeType
            )
          )
          new Attribute(attribute.attributeName, attributeType)
        })
        id -> (definedPort, links.toList, Right(decoded): Either[Throwable, Schema])
    }
    requireDistinct(ports.map(_._1))(id => s"The $side port ${show(id)} of operator $operator")
    ports.toMap
  }

  private def decodePartition(what: => String)(stored: StoredPartitionInfo): PartitionInfo =
    stored.kind match {
      case Kind.Hash(hash) => HashPartition(hash.attributeNames.toList)
      // the constructor, not RangePartition.apply, which turns a range on no column to unknown
      case Kind.Range(range) =>
        new RangePartition(range.attributeNames.toList, range.rangeMin, range.rangeMax)
      case Kind.Single(_)    => SinglePartition()
      case Kind.OneToOne(_)  => OneToOnePartition()
      case Kind.Broadcast(_) => BroadcastPartition()
      case Kind.Unknown(_)   => UnknownPartition()
      case Kind.Empty        => refuse(s"$what names no kind of partitioning.")
    }

  // ----- checks both ways -----

  private def requireBatchSize(size: Int): Unit =
    if (size < 1) {
      refuse(s"The plan's data transfer batch size is $size, but a batch holds at least 1 tuple.")
    }

  /**
    * Fails unless every link joins an output port and an input port the plan has, each port
    * lists exactly the plan's links that join it, each once, the links form no cycle, every
    * input port depends only on input ports of its own operator, and every port whose results
    * are stored is an output port the plan has. No operator id appears twice.
    */
  private def requireConsistent(
      plan: PhysicalPlan,
      storedPorts: Iterable[GlobalPortIdentity]
  ): Unit = {
    val operators = plan.operators.groupBy(_.id).map {
      case (id, ops) =>
        if (ops.size > 1) refuse(s"The plan has ${ops.size} operators ${show(id)}.")
        id -> ops.head
    }
    // the links each port of an operator lists, by side
    def listed(op: PhysicalOp, input: Boolean): Map[PortIdentity, List[PhysicalLink]] =
      if (input) op.inputPorts.map { case (id, (_, links, _)) => id -> links }
      else op.outputPorts.map { case (id, (_, links, _)) => id -> links }
    def portName(opId: PhysicalOpIdentity, portId: PortIdentity, input: Boolean): String =
      s"${if (input) "input" else "output"} port ${show(portId)} of operator ${show(opId)}"

    plan.links.foreach { link =>
      val name = s"Link ${show(link)}"
      val ends = Seq(
        (link.fromOpId, link.fromPortId, false),
        (link.toOpId, link.toPortId, true)
      ).map {
        case (opId, portId, input) =>
          val op = operators.getOrElse(
            opId,
            refuse(s"$name names operator ${show(opId)}, which the plan does not have.")
          )
          val port = portName(opId, portId, input)
          val links = listed(op, input).getOrElse(
            portId,
            refuse(s"$name joins the $port, which the operator does not have.")
          )
          (port, links)
      }
      ends.foreach {
        case (port, links) =>
          val times = links.count(_ == link)
          if (times != 1) refuse(s"$name is listed $times times on the $port, not once.")
      }
    }

    for (op <- plan.operators; input <- Seq(true, false); (portId, links) <- listed(op, input)) {
      val port = portName(op.id, portId, input)
      links.foreach { link =>
        if (!plan.links.contains(link)) {
          refuse(s"The $port lists link ${show(link)}, which is not one of the plan's.")
        }
        val joins =
          if (input) link.toOpId == op.id && link.toPortId == portId
          else link.fromOpId == op.id && link.fromPortId == portId
        if (!joins) refuse(s"The $port lists link ${show(link)}, which does not join it.")
      }
    }

    requireAcyclic(plan)

    // An input port the engine waits for that the operator does not have never completes.
    for {
      op <- plan.operators
      (portId, (port, _, _)) <- op.inputPorts
      dependee <- port.dependencies
      if !op.inputPorts.contains(dependee)
    } {
      refuse(
        s"The ${portName(op.id, portId, input = true)} depends on its input port " +
          s"${show(dependee)}, which the operator does not have."
      )
    }

    storedPorts.foreach { stored =>
      val isOutputPort = !stored.input &&
        operators.get(stored.opId).exists(_.outputPorts.contains(stored.portId))
      if (!isOutputPort) {
        refuse(
          s"The settings store the results of ${show(stored)}, which is not an output port of " +
            "the plan."
        )
      }
    }
  }

  /** Fails if the plan's links form a cycle, naming a link that closes one. */
  private def requireAcyclic(plan: PhysicalPlan): Unit = {
    // as PhysicalPlan.dag is built, but a link at a time, to say which link closes the cycle
    val dag = new DirectedAcyclicGraph[PhysicalOpIdentity, PhysicalLink](
      null, // vertexSupplier
      SupplierUtil.createSupplier(classOf[PhysicalLink]), // edgeSupplier
      false, // weighted
      true // allowMultipleEdges
    )
    plan.operators.foreach(op => dag.addVertex(op.id))
    plan.links.foreach { link =>
      try dag.addEdge(link.fromOpId, link.toOpId, link)
      catch {
        case e: IllegalArgumentException =>
          refuse(s"Link ${show(link)} closes a cycle, and a plan to run has none.", e)
      }
    }
  }

  private def requireDistinct[A](items: Seq[A])(what: A => String): Unit =
    items.diff(items.distinct).headOption.foreach(item => refuse(s"${what(item)} appears twice."))

  /**
    * Fails unless each of `items` comes before the next in `ordering`, naming the first two that
    * do not.
    *
    * @param what the sentence that says the items are out of order
    * @param name an item, as the sentence names it
    */
  private def requireOrdered[A](items: Seq[A], what: String)(name: A => String)(implicit
      ordering: Ordering[A]
  ): Unit =
    items.iterator.zip(items.iterator.drop(1)).find { case (a, b) => !ordering.lt(a, b) }.foreach {
      case (a, b) => refuse(s"$what: ${name(a)} comes before ${name(b)}.")
    }

  private def isBlank(text: String): Boolean = text.trim.isEmpty

  // The words a message opens with when it names a location the plan holds, before the location.
  private val writesReplayLogTo = "The plan writes its replay log to"
  private def replaysLogOf(sourceExecutionId: Long): String =
    s"The plan replays the log of execution $sourceExecutionId at"

  /** `location`, unless it is not an absolute URI. */
  private def requireAbsolute(what: String, location: URI): URI = {
    if (!location.isAbsolute) refuse(s"$what '$location', which is not an absolute URI.")
    location
  }

  /** The URI `text` is, unless it is none or not an absolute one. */
  private def absoluteUriOf(what: String, text: String): URI = {
    val location =
      try new URI(text)
      catch {
        case e: URISyntaxException =>
          refuse(s"$what '$text', which is not a URI: ${e.getMessage}", e)
      }
    requireAbsolute(what, location)
  }

  /** Fails unless a replay is from an execution and up to an interaction it names. */
  private def requireReplay(sourceExecutionId: Long, interaction: String): Unit = {
    if (sourceExecutionId < 1) {
      refuse(
        s"The plan replays the log of execution $sourceExecutionId, but an execution's id is at " +
          "least 1."
      )
    }
    if (isBlank(interaction)) {
      refuse(
        s"The plan replays the log of execution $sourceExecutionId up to an interaction it does " +
          "not name."
      )
    }
  }

  /**
    * Fails unless the hints come from an execution, and give each operator they name, once and
    * in the order of the ids, a finite number of seconds, at least 0.
    */
  private def requireCostHints(hints: StoredCostHints): Unit = {
    if (hints.sourceExecutionId < 1) {
      refuse(
        s"The plan's cost hints come from execution ${hints.sourceExecutionId}, but an " +
          "execution's id is at least 1."
      )
    }
    hints.operators.foreach { cost =>
      if (cost.logicalOperatorId.isEmpty) {
        refuse("The plan's cost hints name an operator with no id.")
      }
      val seconds = cost.seconds
      if (seconds.isNaN || seconds.isInfinite || seconds < 0) {
        refuse(
          s"The plan's cost hints give operator ${cost.logicalOperatorId} $seconds seconds, but a " +
            "cost is a finite number of seconds, at least 0."
        )
      }
    }
    val ids = hints.operators.map(_.logicalOperatorId)
    requireDistinct(ids)(id => s"The cost of operator $id")
    requireOrdered(ids, "The plan's cost hints are not in the order of their operators' ids")(id =>
      s"operator $id"
    )
  }

  /**
    * Fails unless each input is of an operator of `plan`, has a name, is given once and in the
    * order of the operators' ids, then the names, and is of a file whose link expires after the
    * epoch and whose size is at least 0.
    */
  private def requireInputs(inputs: Seq[StoredPlanInput], plan: PhysicalPlan): Unit = {
    val operators = plan.operators.map(_.id.logicalOpId.id)
    inputs.foreach { input =>
      if (input.name.isEmpty) {
        refuse(s"An input of operator ${input.logicalOperatorId} has no name.")
      }
      if (!operators.contains(input.logicalOperatorId)) {
        refuse(
          s"Input ${input.name} names operator '${input.logicalOperatorId}', which the plan does " +
            "not have."
        )
      }
      input.source match {
        case Source.File(file) =>
          if (file.expiresAtMs < 1) {
            refuse(
              s"The link to the ${show(input)} expires at ${file.expiresAtMs} ms since the epoch, " +
                "which is not after it."
            )
          }
          if (file.sizeBytes < 0) {
            refuse(
              s"The ${show(input)} is a file of ${file.sizeBytes} bytes, but a file's size is at " +
                "least 0."
            )
          }
        case Source.Empty => refuse(s"The ${show(input)} names nothing it reads.")
      }
    }
    val keys = inputs.map(input => (input.logicalOperatorId, input.name))
    requireDistinct(keys) { case (operator, name) => s"Input $name of operator $operator" }
    requireOrdered(
      keys,
      "The plan's inputs are not in the order of their operators' ids, then their names"
    ) { case (operator, name) => s"input $name of operator $operator" }
  }

  private def requireUpdateId(updateId: String): Unit =
    if (isBlank(updateId)) refuse("The operator update has no update id.")

  // ----- JSON -----

  /** The JSON text of `message`, every field written out (see [[withDefaultMessages]]). */
  private def write[M <: GeneratedMessage](saved: Saved[M], message: M): String =
    jsonWriter.writeValueAsString(
      withDefaultMessages(saved.companion, message.toPMessage, printer.toJson(message))
    )

  /**
    * Parses JSON text into a message of `saved`'s kind, refusing text in another format version,
    * or not in the form [[write]] writes.
    */
  private def read[M <: GeneratedMessage](saved: Saved[M], json: String): M = {
    val noun = saved.noun
    val value =
      try Option(jsonReader.readValue[JValue](json)).getOrElse(JNull)
      catch { case NonFatal(e) => refuse(s"The $noun is not JSON: ${e.getMessage}", e) }
    val fields = value match {
      case JObject(fields) => fields
      case other           => refuse(s"The $noun is not a JSON object: ${excerpt(other)}")
    }
    // Checked first, so text in another version is refused for its version rather than for a
    // field this version does not have.
    fields.collectFirst { case ("formatVersion", version) => version } match {
      case None                                            => refuseNoVersion(saved)
      case Some(JInt(version)) if version == FormatVersion =>
      case Some(JInt(version))                             => refuseVersion(saved, version.toString)
      case Some(version) =>
        refuse(
          s"The $noun's format version is ${excerpt(version)}, not a whole number; this reader " +
            s"reads version $FormatVersion."
        )
    }
    val message =
      try parser.fromJson[M](value)(saved.companion)
      catch {
        case NonFatal(e) => refuse(s"The $noun is not a ${saved.title}: ${e.getMessage}", e)
      }
    // The parser takes a field left out as its default, and reads some values written another
    // way (an enum as a number); text is read only as it is written.
    difference(value, jsonReader.readValue[JValue](write(saved, message)), "", noun).foreach {
      where => refuse(s"The $noun is not written as a saved $noun is: $where.")
    }
    message
  }

  /**
    * scalapb-json4s leaves a message field out when it holds the default instance of a message
    * declared no_box (InputPort's PortIdentity, say), as it cannot tell that from an unset field.
    * This writes each such field out, so a saved plan shows every port number, 0 included.
    *
    * @param companion the companion of the message `value` and `json` are
    * @param value     the message, as its field values; a no_box field always has one
    * @param json      the message as scalapb-json4s prints it
    */
  private def withDefaultMessages(
      companion: GeneratedMessageCompanion[_],
      value: PMessage,
      json: JValue
  ): JValue =
    json match {
      case JObject(printed) =>
        val printedFields = printed.toMap
        JObject(companion.scalaDescriptor.fields.toList.flatMap { field =>
          val printedValue = printedFields.get(field.name)
          def nested = companion.messageCompanionForFieldNumber(field.number)
          val filled = (field.scalaType, value.value.getOrElse(field, PEmpty), printedValue) match {
            case (ScalaType.Message(_), PRepeated(items), Some(JArray(printedItems)))
                if !field.isMapField =>
              Some(JArray(items.toList.zip(printedItems).map {
                case (item: PMessage, printedItem) => withDefaultMessages(nested, item, printedItem)
                case (_, printedItem)              => printedItem
              }))
            case (ScalaType.Message(_), item: PMessage, Some(printedItem)) =>
              Some(withDefaultMessages(nested, item, printedItem))
            case (ScalaType.Message(_), item: PMessage, None) =>
              val default = nested.defaultInstance.asInstanceOf[GeneratedMessage]
              Some(withDefaultMessages(nested, item, printer.toJson(default)))
            case _ => printedValue
          }
          filled.map(field.name -> _)
        })
      case other => other
    }

  /**
    * Where `read` differs from `written`, the form [[write]] gives the message read from it, if
    * anywhere: the path to the first difference, and what it is. An object's fields are compared
    * by name, in any order, and an array's items in order.
    *
    * @param noun what the messages name the text, "plan" say
    */
  private def difference(
      read: JValue,
      written: JValue,
      path: String,
      noun: String
  ): Option[String] =
    (read, written) match {
      case (JObject(readFields), JObject(writtenFields)) =>
        val readValues = readFields.toMap
        val writtenNames = writtenFields.map(_._1).toSet
        writtenFields.iterator
          .map {
            case (name, writtenValue) =>
              readValues.get(name) match {
                case Some(readValue) => difference(readValue, writtenValue, s"$path/$name", noun)
                case None            => Some(s"$path/$name is missing")
              }
          }
          .collectFirst { case Some(found) => found }
          .orElse(readFields.collectFirst {
            case (name, readValue) if !writtenNames.contains(name) =>
              s"$path/$name is ${excerpt(readValue)}, but a saved $noun leaves it out"
          })
      case (JArray(readItems), JArray(writtenItems)) if readItems.size == writtenItems.size =>
        readItems.iterator
          .zip(writtenItems)
          .zipWithIndex
          .map {
            case ((readItem, writtenItem), index) =>
              difference(readItem, writtenItem, s"$path/$index", noun)
          }
          .collectFirst { case Some(found) => found }
      case _ if read == written => None
      case _ =>
        Some(
          s"${if (path.isEmpty) "/" else path} is ${excerpt(read)}, which a saved $noun writes " +
            s"as ${excerpt(written)}"
        )
    }

  // ----- messages -----

  /** `value` as compact JSON, cut short if long. */
  private def excerpt(value: JValue): String = {
    val text = JsonMethods.compact(value)
    if (text.length <= 80) text else text.take(77) + "..."
  }

  private def show(id: PhysicalOpIdentity): String = s"${id.logicalOpId.id}-${id.layerName}"

  private def show(port: PortIdentity): String =
    if (port.internal) s"${port.id} (internal)" else port.id.toString

  private def show(link: PhysicalLink): String =
    s"${show(link.fromOpId)}[${show(link.fromPortId)}] -> " +
      s"${show(link.toOpId)}[${show(link.toPortId)}]"

  private def show(port: GlobalPortIdentity): String =
    s"${if (port.input) "input" else "output"} port ${show(port.portId)} of operator " +
      show(port.opId)

  private def show(input: StoredPlanInput): String =
    s"input ${input.name} of operator ${input.logicalOperatorId}"

  private def refuse(message: String, cause: Throwable = null): Nothing =
    throw new IllegalArgumentException(message, cause)

  /** Fails unless `version` is the one this codec reads. */
  private def requireVersion(saved: Saved[_], version: Int): Unit =
    version match {
      case FormatVersion =>
      case 0             => refuseNoVersion(saved)
      case other         => refuseVersion(saved, other.toString)
    }

  private def refuseNoVersion(saved: Saved[_]): Nothing =
    refuse(s"The ${saved.noun} names no format version; this reader reads version $FormatVersion.")

  private def refuseVersion(saved: Saved[_], version: String): Nothing =
    refuse(
      s"The ${saved.noun} is in format version $version, but this reader reads version " +
        s"$FormatVersion."
    )

  private def refuseEnum(what: String, value: GeneratedEnum): Nothing =
    if (value.isUnrecognized) refuse(s"$what is ${value.value}, which this version does not know.")
    else refuse(s"$what is not given (${value.name}).")
}
