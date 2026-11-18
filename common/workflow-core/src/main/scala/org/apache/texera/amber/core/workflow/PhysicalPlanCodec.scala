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
import org.apache.texera.amber.core.executor.OperatorInputs
import org.apache.texera.amber.core.storedplan.StoredAttribute.{AttributeType => StoredType}
import org.apache.texera.amber.core.storedplan.StoredPartitionInfo.Kind
import org.apache.texera.amber.core.storedplan.StoredPartitionRequirement.Requirement
import org.apache.texera.amber.core.storedplan.StoredPartitionRule.Rule
import org.apache.texera.amber.core.storedplan.StoredPhysicalOp.{
  LocationPreference => StoredLocation
}
import org.apache.texera.amber.core.storedplan.StoredWorkflowSettings.{ExecutionMode => StoredMode}
import org.apache.texera.amber.core.storedplan._
import org.apache.texera.amber.core.storage.VFSURIFactory
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.jgrapht.graph.DirectedAcyclicGraph
import org.jgrapht.util.SupplierUtil
import org.json4s.jackson.JsonMethods
import org.json4s.{JInt, JNull, JObject, JValue}
import scalapb.json4s.{Parser, Printer}
import scalapb.{GeneratedEnum, GeneratedMessage, GeneratedMessageCompanion}

import java.net.{URI, URISyntaxException}
import scala.collection.mutable
import scala.util.control.NonFatal

/**
  * Saves an execution's plan ([[ExecutionPlan]]) and reads it back, and likewise a change to one
  * operator of a paused run ([[OperatorUpdate]]). A plan is saved as a [[StoredPhysicalPlan]]
  * message (storedplan.proto), a change as a [[StoredOperatorUpdate]] in the same format
  * version, and the message as JSON text.
  *
  * A plan is saved as the same text every time: its operators and its cost hints in the order
  * of their operators' ids, the files an operator reads in the order of their names, and its
  * links once, in an order every port finds its own links in. Each operator read back iterates
  * its ports, and each port its links, in the order the stored plan did.
  *
  * Only a plan made to run can be saved: no operator still holds a resource binding or names a
  * Python environment that was never resolved, every port has its schema, every output port its
  * storage location, and the links form no cycle. A plan read back can be run but not compiled
  * again ([[ReadBackSchemaPropagation]]).
  *
  * A plan is saved in the same format before its files are linked ([[encodeUnlinked]],
  * [[decodeUnlinked]]): as the compile that made it hands it to the service that signs its
  * links, each file with the address of the object that holds it where its link will be.
  * [[encode]] and [[decode]] take only a plan whose files all have their links, which is the
  * plan a computing unit runs.
  */
object PhysicalPlanCodec {

  /** The version of the format this codec writes, and the only one it reads. */
  val FormatVersion: Int = 1

  /**
    * The schema propagation function of every operator read back. A stored plan holds each port's
    * schema but not the function the compile derived it with, so an operator read back cannot
    * derive schemas again: this function fails, and `PhysicalOp.propagateSchema` records the
    * failure on each output port. PhysicalOp's default, the identity, would instead copy each
    * input schema onto the output port of the same number, a wrong schema that nothing reports.
    * Nothing derives schemas in a plan that runs; this keeps a later change that does from
    * running on wrong schemas unnoticed.
    */
  val ReadBackSchemaPropagation: SchemaPropagationFunc = SchemaPropagationFunc(_ =>
    throw new UnsupportedOperationException(
      "This operator was read back from a stored plan, which holds its schemas but not the " +
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

  // Field names as the proto writes them.
  private val printer = new Printer().preservingProtoFieldNames
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
    * A kind of message the codec saves as text, for what is shared between them: reading and
    * writing JSON.
    *
    * @param noun  what messages call one: "plan", say
    * @param title what it is, for a message that says text is not one
    */
  private final case class Saved[M <: GeneratedMessage](
      noun: String,
      title: String,
      companion: GeneratedMessageCompanion[M]
  )

  private val StoredPlan = Saved("plan", "stored physical plan", StoredPhysicalPlan)
  private val SavedUpdate = Saved("operator update", "saved operator update", StoredOperatorUpdate)

  /**
    * Saves `plan`. The ids, settings, warehouse and cost hints come from its context.
    *
    * @throws IllegalArgumentException if the plan is not one made to run under its context, with
    *                                  a link to each file its operators read
    */
  def encode(plan: ExecutionPlan): StoredPhysicalPlan = encode(plan, linked = true)

  /**
    * Saves `plan` as [[encode]] does, before its files are linked: each file its operators read
    * has the address of the object that holds it, and no link.
    *
    * @throws IllegalArgumentException as [[encode]] does, and if a file has a link or no address
    */
  def encodeUnlinked(plan: ExecutionPlan): StoredPhysicalPlan = encode(plan, linked = false)

  private def encode(plan: ExecutionPlan, linked: Boolean): StoredPhysicalPlan = {
    val context = plan.context
    val physicalPlan = plan.plan
    physicalPlan.operators.foreach(requireRunnableUnder(context, _, linked))
    requireConsistent(physicalPlan, context.workflowSettings.outputPortsNeedingStorage)
    requirePortsListTheirLinks(physicalPlan)
    StoredPhysicalPlan(
      formatVersion = FormatVersion,
      workflowId = Some(context.workflowId),
      executionId = Some(context.executionId),
      settings = Some(encodeSettings(context.workflowSettings)),
      warehouse = context.warehouse,
      operators = physicalPlan.operators.toSeq.sortBy(op => orderOf(op.id)).map(encodeOperator),
      links = linksInPortOrder(physicalPlan),
      replay = plan.replay.map(encodeReplay),
      replayLogLocation = plan.replayLog.map(requireAbsolute(writesReplayLogTo, _)).map(_.toString),
      costHints = context.costHints.map(encodeCostHints)
    )
  }

  /**
    * Reads a stored plan back, with the context it runs under.
    *
    * The plan is for running, not for compiling again: each operator's `propagateSchema` is
    * [[ReadBackSchemaPropagation]]. Operators and links are built as saved, with no schema
    * propagated.
    *
    * @throws IllegalArgumentException if the plan is not one [[encode]] saves in this version
    */
  def decode(stored: StoredPhysicalPlan): ExecutionPlan = decode(stored, linked = true)

  /**
    * Reads back a plan saved before its files were linked, as [[decode]] reads one whose files
    * are: a plan [[encodeUnlinked]] saves.
    *
    * @throws IllegalArgumentException as [[decode]] does, and if a file has a link or no address
    */
  def decodeUnlinked(stored: StoredPhysicalPlan): ExecutionPlan = decode(stored, linked = false)

  private def decode(stored: StoredPhysicalPlan, linked: Boolean): ExecutionPlan = {
    val workflowId = stored.workflowId.getOrElse(refuse("The plan names no workflow."))
    val executionId = stored.executionId.getOrElse(refuse("The plan names no execution."))
    val settings = decodeSettings(stored.settings.getOrElse(refuse("The plan has no settings.")))
    requireDistinct(stored.links)(link => s"Link ${show(link)}")
    val linksInto = stored.links.groupBy(link => (link.toOpId, link.toPortId))
    val linksOutOf = stored.links.groupBy(link => (link.fromOpId, link.fromPortId))
    val operators = stored.operators.map(
      decodeOperator(workflowId, executionId, stored.warehouse, linksInto, linksOutOf, linked)
    )
    requireDistinct(operators.map(_.id))(id => s"Operator ${show(id)}")
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
      replayLog = stored.replayLogLocation.map(absoluteUriOf(writesReplayLogTo, _))
    )
  }

  def toJson(stored: StoredPhysicalPlan): String = write(StoredPlan, stored)

  /**
    * Parses the JSON text of a stored plan; [[decode]] checks what it holds.
    *
    * @throws IllegalArgumentException if the text is not one JSON object in this format version,
    *                                  or has a field twice or a field the format does not have
    */
  def fromJson(json: String): StoredPhysicalPlan = read(StoredPlan, json)

  /**
    * Saves a change to operator `op` of the paused execution `executionId`, under `updateId`:
    * only what an [[OperatorUpdate]] carries.
    *
    * @throws IllegalArgumentException if `updateId` is blank, or `op` is not one made to run in
    *                                  that execution
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
      repositoryMounts = encodeMounts(op.repositoryMounts)
    )
  }

  /**
    * Reads a saved change to an operator back.
    *
    * @throws IllegalArgumentException if the change is not one [[encodeUpdate]] saves
    */
  def decodeUpdate(stored: StoredOperatorUpdate): OperatorUpdate = {
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
      repositoryMounts = decodeMounts(name, stored.repositoryMounts)
    )
  }

  def updateToJson(stored: StoredOperatorUpdate): String = write(SavedUpdate, stored)

  /**
    * Parses the JSON text of a saved change to an operator, as [[fromJson]] parses a plan's;
    * [[decodeUpdate]] checks what it holds.
    */
  def updateFromJson(json: String): StoredOperatorUpdate = read(SavedUpdate, json)

  // ----- encoding -----

  private def requireRunnableUnder(
      context: WorkflowContext,
      op: PhysicalOp,
      linked: Boolean
  ): Unit = {
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
    requireInputs(name, op.inputs, linked)
    op.storageLocations.keys.find(!op.outputPorts.contains(_)).foreach { id =>
      refuse(
        s"Operator $name has a storage location for its output port ${show(id)}, which it does " +
          "not have."
      )
    }
    op.outputPorts.keys.foreach { id =>
      val port = GlobalPortIdentity(op.id, id)
      val location = op.storageLocations.getOrElse(
        id,
        refuse(s"The ${show(port)} has no storage location: only a plan made to run can be saved.")
      )
      requireStorageLocation(context.workflowId, context.executionId, context.warehouse)(
        port,
        location
      )
    }
  }

  /**
    * Fails unless each port lists exactly the plan's links that join it, each once. A plan is
    * saved with its links alone, and a port read back lists those that join it.
    */
  private def requirePortsListTheirLinks(plan: PhysicalPlan): Unit =
    for (op <- plan.operators; input <- Seq(true, false)) {
      val listed =
        if (input) op.inputPorts.map { case (id, (_, links, _)) => id -> links }
        else op.outputPorts.map { case (id, (_, links, _)) => id -> links }
      listed.foreach {
        case (portId, links) =>
          val joining = plan.links.filter(link =>
            if (input) link.toOpId == op.id && link.toPortId == portId
            else link.fromOpId == op.id && link.fromPortId == portId
          )
          if (links.size != joining.size || links.toSet != joining) {
            def shown(links: Iterable[PhysicalLink]) = links.map(show).toSeq.sorted.mkString(", ")
            refuse(
              s"The ${portName(op.id, portId, input)} lists its links as [${shown(links)}], but " +
                s"the plan's links that join it are [${shown(joining)}]."
            )
          }
      }
    }

  /** What operators are saved in the order of. */
  private def orderOf(id: PhysicalOpIdentity): (String, String) = (id.logicalOpId.id, id.layerName)

  /** The order links are saved in where the ports that list them leave it open: by their ends. */
  private val linkOrder: Ordering[PhysicalLink] = Ordering.by(link =>
    (
      orderOf(link.fromOpId),
      (link.fromPortId.id, link.fromPortId.internal),
      orderOf(link.toOpId),
      (link.toPortId.id, link.toPortId.internal)
    )
  )

  /**
    * The plan's links in the order they are saved in: one in which every port finds its links in
    * the order it lists them, since a port read back lists its links in the saved order. A link
    * comes next once it is the first left on both ports it joins; of such links, the least.
    *
    * `plan`'s ports list exactly its links that join them ([[requirePortsListTheirLinks]]).
    */
  private def linksInPortOrder(plan: PhysicalPlan): Seq[PhysicalLink] = {
    // what each port still lists: an output port by false, an input port by true
    val left = mutable.Map.empty[(PhysicalOpIdentity, PortIdentity, Boolean), List[PhysicalLink]]
    plan.operators.foreach { op =>
      op.outputPorts.foreach { case (id, (_, links, _)) => left((op.id, id, false)) = links }
      op.inputPorts.foreach { case (id, (_, links, _)) => left((op.id, id, true)) = links }
    }
    def portsOf(link: PhysicalLink) =
      Seq((link.fromOpId, link.fromPortId, false), (link.toOpId, link.toPortId, true))
    def isNext(link: PhysicalLink) = portsOf(link).forall(left(_).headOption.contains(link))
    val next = mutable.TreeSet.from(plan.links.filter(isNext))(linkOrder)
    val ordered = Seq.newBuilder[PhysicalLink]
    while (next.nonEmpty) {
      val link = next.head
      next -= link
      ordered += link
      portsOf(link).foreach { port =>
        left(port) = left(port).tail
        next ++= left(port).headOption.filter(isNext)
      }
    }
    val links = ordered.result()
    if (links.size < plan.links.size) {
      refuse(
        "The plan's ports list their links in orders that no one order of the links gives: " +
          left.values.flatten.toSeq.distinct.map(show).sorted.mkString(", ") + "."
      )
    }
    links
  }

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
        case (port, _, schema) => StoredInputPort(Some(port), schema.toOption.map(encodeSchema))
      },
      // and every output port has its location
      outputPorts = op.outputPorts.values.toSeq.map {
        case (port, _, schema) =>
          StoredOutputPort(
            Some(port),
            schema.toOption.map(encodeSchema),
            op.storageLocations(port.id).toString
          )
      },
      isOneToManyOp = op.isOneToManyOp,
      requiresMaterializedExecution = op.requiresMaterializedExecution,
      isLoopStart = op.isLoopStart,
      suggestedWorkerNum = op.suggestedWorkerNum,
      repositoryMounts = encodeMounts(op.repositoryMounts),
      // a name never resolved is not saved: requireRunnableUnder refused the plan
      pythonEnvironment = op.pythonEnvironment match {
        case PythonEnvironmentRef.Resolved(environment) =>
          Some(StoredPythonEnvironment(environment.name, environment.requirements))
        case _ => None
      },
      inputs = Option.when(op.inputs != OperatorInputs.defaultInstance)(op.inputs)
    )

  private def encodeMounts(mounts: Option[RepositoryMounts]): Seq[String] =
    mounts.fold(Seq.empty[String])(_.locators.toSeq.sorted)

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

  /**
    * @param linksInto  the plan's links into each input port, in the order they are saved in
    * @param linksOutOf the plan's links out of each output port, likewise
    */
  private def decodeOperator(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      warehouse: Option[String],
      linksInto: Map[(PhysicalOpIdentity, PortIdentity), Seq[PhysicalLink]],
      linksOutOf: Map[(PhysicalOpIdentity, PortIdentity), Seq[PhysicalLink]],
      linked: Boolean
  )(stored: StoredPhysicalOp): PhysicalOp = {
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
    val outputPorts =
      decodePorts(name, "output", stored.outputPorts.map(p => (p.port, p.schema)))(
        _.id,
        portId => linksOutOf.getOrElse((id, portId), Nil)
      )
    // every stored port has a port: decodePorts refused the operator otherwise
    val storageLocations = stored.outputPorts.map { storedPort =>
      val port = GlobalPortIdentity(id, storedPort.port.get.id)
      if (storedPort.storageLocation.isEmpty) refuse(s"The ${show(port)} has no storage location.")
      val location = uriOf(s"The ${show(port)} is stored at", storedPort.storageLocation)
      requireStorageLocation(workflowId, executionId, warehouse)(port, location)
      port.portId -> location
    }.toMap
    val inputs = stored.inputs.getOrElse(OperatorInputs.defaultInstance)
    requireInputs(name, inputs, linked)
    PhysicalOp(
      id = id,
      workflowId = workflowId,
      executionId = executionId,
      opExecInitInfo = stored.opExecInitInfo,
      parallelizable = stored.parallelizable,
      locationPreference = locationPreference,
      partitionRequirement = partitionRequirement,
      outputPartitionRule = outputPartitionRule,
      inputPorts = decodePorts(name, "input", stored.inputPorts.map(p => (p.port, p.schema)))(
        _.id,
        portId => linksInto.getOrElse((id, portId), Nil)
      ),
      outputPorts = outputPorts,
      propagateSchema = ReadBackSchemaPropagation,
      isOneToManyOp = stored.isOneToManyOp,
      requiresMaterializedExecution = stored.requiresMaterializedExecution,
      isLoopStart = stored.isLoopStart,
      suggestedWorkerNum = stored.suggestedWorkerNum,
      pythonEnvironment = stored.pythonEnvironment
        .map(decodeEnvironment(name))
        .getOrElse(PythonEnvironmentRef.EngineDefault),
      repositoryMounts = decodeMounts(name, stored.repositoryMounts),
      inputs = inputs,
      storageLocations = storageLocations
    )
  }

  /** The environment operator `operator` runs in, as [[PythonEnvironment]] takes it. */
  private def decodeEnvironment(
      operator: String
  )(stored: StoredPythonEnvironment): PythonEnvironmentRef =
    try PythonEnvironmentRef.Resolved(PythonEnvironment(stored.name, stored.requirements))
    catch {
      case e: IllegalArgumentException =>
        refuse(s"Operator $operator cannot run in the environment it names: ${e.getMessage}", e)
    }

  /** The mounts of operator `operator`, as [[RepositoryMounts]] takes them; none for no locator. */
  private def decodeMounts(operator: String, locators: Seq[String]): Option[RepositoryMounts] = {
    requireDistinct(locators)(locator => s"Repository $locator of operator $operator")
    try Option.when(locators.nonEmpty)(RepositoryMounts(locators.toSet))
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

  /**
    * An operator's ports on one side, keyed by port id, built in the order they are stored, each
    * with the plan's links that join it.
    */
  private def decodePorts[P](
      operator: String,
      side: String,
      stored: Seq[(Option[P], Option[StoredSchema])]
  )(
      idOf: P => PortIdentity,
      linksOf: PortIdentity => Seq[PhysicalLink]
  ): Map[PortIdentity, (P, List[PhysicalLink], Either[Throwable, Schema])] = {
    val ports = stored.map {
      case (port, schema) =>
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
        id -> (definedPort, linksOf(id).toList, Right(decoded): Either[Throwable, Schema])
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
    * Fails unless every link joins an output port and an input port the plan has, the links form
    * no cycle, every input port depends only on input ports of its own operator, and every port
    * whose results are stored is an output port the plan has. No operator id appears twice.
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

    plan.links.foreach { link =>
      val name = s"Link ${show(link)}"
      Seq((link.fromOpId, link.fromPortId, false), (link.toOpId, link.toPortId, true)).foreach {
        case (opId, portId, input) =>
          val op = operators.getOrElse(
            opId,
            refuse(s"$name names operator ${show(opId)}, which the plan does not have.")
          )
          if (!(if (input) op.inputPorts else op.outputPorts).contains(portId)) {
            refuse(
              s"$name joins the ${portName(opId, portId, input)}, which the operator does not have."
            )
          }
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

  /** The URI `text` is, unless it is none. */
  private def uriOf(what: String, text: String): URI =
    try new URI(text)
    catch {
      case e: URISyntaxException =>
        refuse(s"$what '$text', which is not a URI: ${e.getMessage}", e)
    }

  /** The URI `text` is, unless it is none or not an absolute one. */
  private def absoluteUriOf(what: String, text: String): URI =
    requireAbsolute(what, uriOf(what, text))

  /**
    * Fails unless `location` is where the output port `port` of the plan's execution is stored:
    * a location of that workflow and execution, in the plan's warehouse, that names the port. A
    * unit stores a port where its plan says, so a plan cannot have it write into another
    * execution's tables, or another warehouse's.
    */
  private def requireStorageLocation(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      warehouse: Option[String]
  )(port: GlobalPortIdentity, location: URI): Unit = {
    val what = s"The ${show(port)} is stored at '$location'"
    if (location.isOpaque) refuse(s"$what, which is not the location of a port.")
    val named =
      try VFSURIFactory.decodeURI(VFSURIFactory.resultURI(location))
      catch {
        case e: IllegalArgumentException =>
          refuse(s"$what, which is not the location of a port: ${e.getMessage}", e)
      }
    if (
      named.workflowId != workflowId || named.executionId != executionId ||
      named.warehouse != warehouse || !named.globalPortId.contains(port)
    ) {
      refuse(
        s"$what, which is not that port's location in execution ${executionId.id} of workflow " +
          s"${workflowId.id}" + warehouse.fold(".")(name => s", in warehouse '$name'.")
      )
    }
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
    * Fails unless each file operator `operator` reads has a name, and is given once and in the
    * order of the names; and the operator reads a CSV file, if it reads one, under a limit of at
    * least one column. In a plan whose files are `linked`, each file is read through a link that
    * expires after the epoch, and names no address; in one whose files are not, each names the
    * address its link is to be signed for, and has no link.
    */
  private def requireInputs(operator: String, inputs: OperatorInputs, linked: Boolean): Unit = {
    inputs.files.foreach { file =>
      if (file.name.isEmpty) refuse(s"A file operator $operator reads has no name.")
      if (linked) {
        if (file.url.isEmpty) refuse(s"Operator $operator has no link to its file ${file.name}.")
        if (file.expiresAtMs < 1) {
          refuse(
            s"The link to the file ${file.name} of operator $operator expires at " +
              s"${file.expiresAtMs} ms since the epoch, which is not after it."
          )
        }
        if (file.physicalAddress.nonEmpty) {
          refuse(
            s"The file ${file.name} of operator $operator has its link and still names where " +
              "it is kept: a link takes the address's place."
          )
        }
      } else {
        if (file.physicalAddress.isEmpty) {
          refuse(s"The file ${file.name} of operator $operator does not say where it is kept.")
        }
        if (file.url.nonEmpty || file.expiresAtMs != 0) {
          refuse(
            s"The file ${file.name} of operator $operator has a link already: only a plan " +
              "whose files are not linked yet names where they are kept."
          )
        }
      }
    }
    val names = inputs.files.map(_.name)
    requireDistinct(names)(name => s"The file $name of operator $operator")
    requireOrdered(
      names,
      s"The files operator $operator reads are not in the order of their names"
    )(name => s"file $name")
    inputs.csvParserMaxColumns.filter(_ < 1).foreach { limit =>
      refuse(
        s"Operator $operator reads CSV files of at most $limit columns, but a row has at least 1."
      )
    }
  }

  private def requireUpdateId(updateId: String): Unit =
    if (isBlank(updateId)) refuse("The operator update has no update id.")

  // ----- JSON -----

  private def write[M <: GeneratedMessage](saved: Saved[M], message: M): String =
    jsonWriter.writeValueAsString(printer.toJson(message))

  /** Parses JSON text into a message of `saved`'s kind, refusing another format version. */
  private def read[M <: GeneratedMessage](saved: Saved[M], json: String): M = {
    val noun = saved.noun
    val value =
      try Option(jsonReader.readValue[JValue](json)).getOrElse(JNull)
      catch { case NonFatal(e) => refuse(s"The $noun is not JSON: ${e.getMessage}", e) }
    val fields = value match {
      case JObject(fields) => fields
      case other           => refuse(s"The $noun is not a JSON object: ${excerpt(other)}")
    }
    // Checked before the fields are read, so text in another version is refused for its version
    // rather than for a field this version does not have.
    fields.collectFirst { case ("formatVersion", version) => version } match {
      case Some(JInt(version)) if version == FormatVersion =>
      case Some(version) =>
        refuse(
          s"The $noun is in format version ${excerpt(version)}, but this reader reads version " +
            s"$FormatVersion."
        )
      case None =>
        refuse(s"The $noun names no format version; this reader reads version $FormatVersion.")
    }
    try parser.fromJson[M](value)(saved.companion)
    catch {
      case NonFatal(e) => refuse(s"The $noun is not a ${saved.title}: ${e.getMessage}", e)
    }
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

  private def show(port: GlobalPortIdentity): String = portName(port.opId, port.portId, port.input)

  private def portName(opId: PhysicalOpIdentity, portId: PortIdentity, input: Boolean): String =
    s"${if (input) "input" else "output"} port ${show(portId)} of operator ${show(opId)}"

  private def refuse(message: String, cause: Throwable = null): Nothing =
    throw new IllegalArgumentException(message, cause)

  private def refuseEnum(what: String, value: GeneratedEnum): Nothing =
    if (value.isUnrecognized) refuse(s"$what is ${value.value}, which this version does not know.")
    else refuse(s"$what is not given (${value.name}).")
}
