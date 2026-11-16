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

import org.apache.texera.amber.core.executor.{OpExecInitInfo, OpExecWithClassName, OpExecWithCode}
import org.apache.texera.amber.core.storedplan.StoredAttribute.{AttributeType => StoredType}
import org.apache.texera.amber.core.storedplan.StoredPartitionInfo.Kind
import org.apache.texera.amber.core.storedplan.StoredPartitionRequirement.Requirement
import org.apache.texera.amber.core.storedplan.StoredPartitionRule.Rule
import org.apache.texera.amber.core.storedplan.StoredPhysicalOp.{
  LocationPreference => StoredLocation
}
import org.apache.texera.amber.core.storedplan.StoredWorkflowSettings.{ExecutionMode => StoredMode}
import org.apache.texera.amber.core.storedplan._
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.OutputPort.OutputMode
import org.apache.texera.amber.core.workflow.PhysicalPlanRoundTrip.{
  assertRoundTrips,
  assertSameContext,
  assertSamePlan
}
import org.json4s.jackson.JsonMethods.{compact, parse}
import org.json4s.{JArray, JDouble, JInt, JObject, JString, JValue}
import org.scalatest.flatspec.AnyFlatSpec
import scalapb.descriptors.{Descriptor, ScalaType}

import java.lang.reflect.Modifier
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import scala.collection.mutable

class PhysicalPlanCodecSpec extends AnyFlatSpec {

  private val workflowId = WorkflowIdentity(7)
  private val executionId = ExecutionIdentity(42)

  private def opId(name: String, layer: String = "main"): PhysicalOpIdentity =
    PhysicalOpIdentity(OperatorIdentity(name), layer)

  private def schemaOf(attributes: (String, AttributeType)*): Schema =
    Schema(attributes.map { case (name, kind) => new Attribute(name, kind) }.toList)

  private val keyed = schemaOf("k" -> AttributeType.STRING, "Value" -> AttributeType.LONG)

  // A column of each type, one of them named in more than ASCII and in mixed case.
  private val everyType = Schema(AttributeType.values.toList.map { kind =>
    new Attribute(if (kind == AttributeType.STRING) "Ünïcode Name" else s"${kind.name}_col", kind)
  })

  /** An operator of this spec's workflow and execution, with no port. */
  private def operator(
      name: String,
      layer: String = "main",
      executor: OpExecInitInfo = OpExecWithClassName("org.example.ExampleOpExec", "{}")
  ): PhysicalOp =
    PhysicalOp(opId(name, layer), workflowId, executionId, executor)

  /** `op` with these ports, in this order, each with a schema and no link yet. */
  private def withPorts(
      op: PhysicalOp,
      inputs: Seq[(InputPort, Schema)] = Seq.empty,
      outputs: Seq[(OutputPort, Schema)] = Seq.empty
  ): PhysicalOp =
    op.copy(
      inputPorts = inputs.map {
        case (port, schema) => port.id -> (port, List.empty[PhysicalLink], Right(schema))
      }.toMap,
      outputPorts = outputs.map {
        case (port, schema) => port.id -> (port, List.empty[PhysicalLink], Right(schema))
      }.toMap
    )

  /**
    * A plan of `operators` and `links`, in this order, each link listed on the two ports it joins
    * in the order of `links` — as the compiler's addLink lists them, though no schema propagates.
    */
  private def planOf(operators: Seq[PhysicalOp], links: Seq[PhysicalLink]): PhysicalPlan = {
    def into(op: PhysicalOp, port: PortIdentity) =
      links.filter(l => l.toOpId == op.id && l.toPortId == port).toList
    def outOf(op: PhysicalOp, port: PortIdentity) =
      links.filter(l => l.fromOpId == op.id && l.fromPortId == port).toList
    PhysicalPlan(
      operators.map { op =>
        op.copy(
          inputPorts = op.inputPorts.map {
            case (id, (port, _, schema)) => id -> (port, into(op, id), schema)
          },
          outputPorts = op.outputPorts.map {
            case (id, (port, _, schema)) => id -> (port, outOf(op, id), schema)
          }
        )
      }.toSet,
      links.toSet
    )
  }

  private def link(from: PhysicalOp, to: PhysicalOp, fromPort: Int = 0, toPort: Int = 0) =
    PhysicalLink(from.id, PortIdentity(fromPort), to.id, PortIdentity(toPort))

  private def contextOf(
      settings: WorkflowSettings = WorkflowSettings(400, ExecutionMode.PIPELINED),
      warehouse: Option[String] = None
  ): WorkflowContext =
    // The computing unit is not saved: a plan does not choose the unit it runs on.
    new WorkflowContext(workflowId, executionId, settings, cuid = Some(3), warehouse = warehouse)

  // ----- a plan that sets every field -----

  private val scan = withPorts(
    operator(
      "scan",
      executor = OpExecWithClassName("org.example.ScanOpExec", """{"fileName":"résumé.csv"}""")
    ).copy(parallelizable = false, locationPreference = Some(PreferCoordinator)),
    outputs = Seq(OutputPort(PortIdentity(0), "rows") -> everyType)
  )

  private val udf = withPorts(
    operator("udf", executor = OpExecWithCode("print('héllo')\nyield {'k': 1}\n", "python")).copy(
      locationPreference = Some(RoundRobinPreference),
      partitionRequirement = List(Some(HashPartition(List("k"))), None),
      outputPartitionRule =
        PartitionRule.Fixed(new RangePartition(List("k", "Value"), Long.MinValue, Long.MaxValue)),
      isOneToManyOp = true,
      suggestedWorkerNum = Some(3),
      pveName = "py311",
      repositoryMounts =
        Some(RepositoryMounts("/mnt/texera-mounts", Set("dataset-1:d4t4", "model-1:m0d3l")))
    ),
    inputs = Seq(
      InputPort(PortIdentity(0), "left", disallowMultiLinks = true) -> everyType,
      InputPort(PortIdentity(1), "right", dependencies = List(PortIdentity(0))) -> everyType
    ),
    outputs =
      Seq(OutputPort(PortIdentity(0), blocking = true, mode = OutputMode.SET_DELTA) -> keyed)
  )

  private val localAgg = withPorts(
    operator("agg", "localAgg").copy(
      outputPartitionRule = PartitionRule.KeepKeyedInput,
      requiresMaterializedExecution = true
    ),
    inputs = Seq(InputPort(PortIdentity(0)) -> keyed),
    outputs = Seq(OutputPort(PortIdentity(0, internal = true), blocking = true) -> keyed)
  )

  private val globalAgg = withPorts(
    operator("agg", "globalAgg").copy(
      partitionRequirement = List(Some(SinglePartition())),
      isLoopStart = true
    ),
    inputs = Seq(InputPort(PortIdentity(0, internal = true)) -> keyed),
    outputs = Seq(
      OutputPort(PortIdentity(0), mode = OutputMode.SINGLE_SNAPSHOT, reuseStorage = true) -> keyed
    )
  )

  private val internalLink =
    PhysicalLink(
      localAgg.id,
      PortIdentity(0, internal = true),
      globalAgg.id,
      PortIdentity(0, internal = true)
    )

  private val fullLinks =
    Seq(link(scan, udf), link(scan, udf, toPort = 1), link(udf, localAgg), internalLink)

  private val fullPlan = planOf(Seq(scan, udf, localAgg, globalAgg), fullLinks)

  private val fullContext = contextOf(
    WorkflowSettings(
      100,
      ExecutionMode.MATERIALIZED,
      Set(
        GlobalPortIdentity(globalAgg.id, PortIdentity(0)),
        GlobalPortIdentity(udf.id, PortIdentity(0))
      )
    ),
    warehouse = Some("lake-wh")
  )

  "PhysicalPlanCodec" should "save a plan that sets every field and read the same plan back" in {
    assertRoundTrips(fullContext, fullPlan)
  }

  it should "save and read back every partitioning, as a requirement and as a fixed rule" in {
    val partitionings: Seq[PartitionInfo] = Seq(
      HashPartition(List("k", "Value")),
      HashPartition(), // on every column
      new RangePartition(List("k"), -5L, 5L),
      // Only the constructor makes a range on no column; RangePartition.apply makes it unknown.
      new RangePartition(List.empty, 0L, 0L),
      SinglePartition(),
      OneToOnePartition(),
      BroadcastPartition(),
      UnknownPartition()
    )
    partitionings.foreach { partition =>
      withClue(s"$partition: ") {
        val op = operator("op").copy(
          partitionRequirement = List(None, Some(partition), None),
          outputPartitionRule = PartitionRule.Fixed(partition)
        )
        assertRoundTrips(contextOf(), planOf(Seq(op), Seq.empty))
      }
    }
  }

  it should "save and read back every output partition rule" in {
    Seq(
      PartitionRule.FirstInput,
      PartitionRule.KeepKeyedInput,
      PartitionRule.Fixed(HashPartition(List("k")))
    ).foreach { rule =>
      withClue(s"$rule: ") {
        assertRoundTrips(
          contextOf(),
          planOf(Seq(operator("op").withOutputPartitionRule(rule)), Nil)
        )
      }
    }
  }

  it should "save and read back every location preference, none included" in {
    Seq(None, Some(PreferCoordinator), Some(RoundRobinPreference)).foreach { preference =>
      withClue(s"$preference: ") {
        val op = operator("op").withLocationPreference(preference)
        assertRoundTrips(contextOf(), planOf(Seq(op), Nil))
      }
    }
  }

  it should "save and read back every output mode, blocking or not, reusing storage or not" in {
    val outputs = for {
      mode <- OutputMode.values
      blocking <- Seq(false, true)
      reuseStorage <- Seq(false, true)
    } yield (mode, blocking, reuseStorage)
    val op = withPorts(
      operator("op"),
      outputs = outputs.zipWithIndex.map {
        case ((mode, blocking, reuseStorage), index) =>
          OutputPort(PortIdentity(index), s"out-$index", blocking, mode, reuseStorage) -> keyed
      }
    )
    assert(op.outputPorts.size == 12)
    assertRoundTrips(contextOf(), planOf(Seq(op), Nil))
  }

  it should "save and read back an executor of each kind, empty strings included" in {
    Seq(
      OpExecWithClassName("org.example.ExampleOpExec", """{"x":"ü"}"""),
      OpExecWithCode("def f():\n    return 1\n", "r-tuple"),
      OpExecWithCode("", "")
    ).foreach { executor =>
      withClue(s"$executor: ") {
        assertRoundTrips(contextOf(), planOf(Seq(operator("op", executor = executor)), Nil))
      }
    }
  }

  it should "save and read back a worker count, PVE and mounts, or none of them" in {
    Seq(
      operator("op"),
      // proto3 would leave a 0 out; an optional field keeps it apart from "no worker count"
      operator("op").withSuggestedWorkerNum(0),
      operator("op").withSuggestedWorkerNum(16).withPveName("py-3.12 ünï"),
      operator("op").copy(repositoryMounts = Some(RepositoryMounts("/m", Set("r:c"))))
    ).foreach { op =>
      withClue(s"$op: ") {
        assertRoundTrips(contextOf(), planOf(Seq(op), Nil))
      }
    }
  }

  it should "save and read back each port's schema, a column of every attribute type included" in {
    AttributeType.values.foreach { kind =>
      withClue(s"$kind: ") {
        val op = withPorts(operator("op"), outputs = Seq(OutputPort() -> schemaOf("c" -> kind)))
        val (_, read) = PhysicalPlanCodec.decode(
          PhysicalPlanCodec.fromJson(
            assertRoundTrips(contextOf(), planOf(Seq(op), Nil))
          )
        )
        assert(
          read.getOperator(op.id).outputPorts(PortIdentity())._3 == Right(schemaOf("c" -> kind))
        )
      }
    }
    // and a port with no column
    val empty = withPorts(operator("op"), inputs = Seq(InputPort() -> Schema()))
    assertRoundTrips(contextOf(), planOf(Seq(empty), Nil))
  }

  it should "read every attribute type the format names" in {
    val named = StoredType.values.filterNot(_ == StoredType.ATTRIBUTE_TYPE_UNSPECIFIED)
    assert(named.size == AttributeType.values.length)
    val op = withPorts(operator("op"), outputs = Seq(OutputPort() -> keyed))
    val valid = PhysicalPlanCodec.encode(contextOf(), planOf(Seq(op), Nil))
    val read = named.map { kind =>
      val (_, plan) = PhysicalPlanCodec.decode(
        valid.update(_.operators(0).outputPorts(0).schema.attributes(0).attributeType := kind)
      )
      plan.operators.head.outputPorts(PortIdentity())._3.toOption.get.attributes.head.getType
    }
    assert(read.toSet == AttributeType.values.toSet)
  }

  it should "save and read back the settings and the warehouse" in {
    val stored = (0 until 6).map(i => GlobalPortIdentity(opId("op"), PortIdentity(i)))
    val op =
      withPorts(operator("op"), outputs = stored.map(port => OutputPort(port.portId) -> keyed))
    Seq(
      contextOf(WorkflowSettings(1, ExecutionMode.PIPELINED)),
      contextOf(WorkflowSettings(Int.MaxValue, ExecutionMode.MATERIALIZED), Some("lake-wh")),
      // a warehouse named by an empty string is still one
      contextOf(WorkflowSettings(400, ExecutionMode.PIPELINED, stored.take(2).toSet), Some("")),
      // more stored ports than a small set holds, so they iterate in hash order
      contextOf(WorkflowSettings(400, ExecutionMode.MATERIALIZED, stored.toSet))
    ).foreach { context =>
      withClue(s"${context.workflowSettings}, ${context.warehouse}: ") {
        assertRoundTrips(context, planOf(Seq(op), Nil))
      }
    }
  }

  it should "save and read back the largest ids" in {
    val wid = WorkflowIdentity(Long.MaxValue)
    val eid = ExecutionIdentity(Long.MaxValue)
    val op = PhysicalOp(opId("op"), wid, eid, OpExecWithClassName("x", "{}"))
    val context = new WorkflowContext(wid, eid, WorkflowSettings(400, ExecutionMode.PIPELINED))
    val json = assertRoundTrips(context, PhysicalPlan(Set(op), Set.empty))
    // proto3 JSON writes 64-bit numbers as strings, so a reader in JavaScript loses no digit
    assert(json.contains("\"9223372036854775807\""))
  }

  it should "keep the order an operator iterates its ports in, and the stored ports', out of number order" in {
    // Inputs 1 then 0, outputs 2, 0, 1: a map of up to four ports iterates in the order they
    // were added in, and the engine sees them in it.
    val op = withPorts(
      operator("op"),
      inputs = Seq(InputPort(PortIdentity(1)) -> keyed, InputPort(PortIdentity(0)) -> keyed),
      outputs = Seq(2, 0, 1).map(port => OutputPort(PortIdentity(port)) -> keyed)
    )
    val inputOrder = List(PortIdentity(1), PortIdentity(0))
    val outputOrder = List(PortIdentity(2), PortIdentity(0), PortIdentity(1))
    assert(op.inputPorts.keys.toList == inputOrder && op.outputPorts.keys.toList == outputOrder)
    val stored = List(2, 0, 1).map(port => GlobalPortIdentity(op.id, PortIdentity(port)))
    val context = contextOf(WorkflowSettings(400, ExecutionMode.PIPELINED, stored.toSet))
    assert(context.workflowSettings.outputPortsNeedingStorage.toList == stored)
    val plan = planOf(Seq(op), Nil)

    val json = assertRoundTrips(context, plan)
    val (readContext, read) = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(json))
    assert(read.getOperator(op.id).inputPorts.keys.toList == inputOrder)
    assert(read.getOperator(op.id).outputPorts.keys.toList == outputOrder)
    assert(readContext.workflowSettings.outputPortsNeedingStorage.toList == stored)
  }

  it should "keep the order each port lists its links in, apart from the plan's order" in {
    val sources = Seq("a", "b", "c").map(name =>
      withPorts(operator(name), outputs = Seq(OutputPort() -> keyed))
    )
    val Seq(a, b, c) = sources
    val union = operator("union")
    val links @ Seq(fromA, fromB, fromC) = sources.map(source => link(source, union))
    // the plan iterates its links a, b, c; the union's port lists them c, a, b
    val plan = PhysicalPlan(
      Set(a, b, c).map(op =>
        op.copy(outputPorts = op.outputPorts.map {
          case (id, (port, _, schema)) =>
            id -> (port, links.filter(_.fromOpId == op.id).toList, schema)
        })
      ) + union.copy(inputPorts =
        Map(PortIdentity() -> (InputPort(), List(fromC, fromA, fromB), Right(keyed)))
      ),
      links.toSet
    )
    assert(plan.links.toList == links)

    assertRoundTrips(contextOf(), plan)
    val (_, read) = PhysicalPlanCodec.decode(PhysicalPlanCodec.encode(contextOf(), plan))
    assert(read.getOperator(union.id).inputPorts(PortIdentity())._2 == List(fromC, fromA, fromB))
  }

  it should "read back a plan of more operators, links and ports than a small set holds" in {
    // Six operators in a chain, the last with six input ports: every set and map is a hashed one.
    val chain = (0 until 6).map(i =>
      withPorts(
        operator(s"op$i"),
        inputs = (0 until (if (i == 5) 6 else 1)).map(p => InputPort(PortIdentity(p)) -> keyed),
        outputs = Seq(OutputPort() -> keyed)
      )
    )
    val links = chain.sliding(2).map { case Seq(from, to) => link(from, to) }.toSeq ++
      (1 until 6).map(p => link(chain(p - 1), chain(5), toPort = p))
    val plan = planOf(chain, links)
    assert(plan.operators.size == 6 && plan.links.size == 10)

    assertRoundTrips(contextOf(), plan)
  }

  it should "save more operators than a small set holds in the order of their ids, the same text every time" in {
    // Each copy of an operator gets a function of its own, as each compile gives it, so the two
    // sets hash their operators apart and need not iterate them in one order.
    def propagation(): SchemaPropagationFunc = {
      val token = new Object
      SchemaPropagationFunc(schemas => { token.hashCode; schemas })
    }
    def chain(): PhysicalPlan = {
      val ops = Seq("e", "b", "f", "a", "d", "c").map(name =>
        withPorts(
          operator(name).withPropagateSchema(propagation()),
          inputs = Seq(InputPort() -> keyed),
          outputs = Seq(OutputPort() -> keyed)
        )
      )
      planOf(ops, ops.sliding(2).map { case Seq(from, to) => link(from, to) }.toSeq)
    }
    val stored = PhysicalPlanCodec.encode(contextOf(), chain())
    assert(
      stored.operators.flatMap(_.id).map(_.logicalOpId.id) == Seq("a", "b", "c", "d", "e", "f")
    )
    val texts =
      (1 to 5).map(_ => PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(contextOf(), chain())))
    assert(texts.distinct.size == 1, "two saves of one plan give different text")
    assert(texts.head == PhysicalPlanCodec.toJson(stored))
  }

  it should "read back a plan whose operators cannot derive their schemas again" in {
    val (_, read) = PhysicalPlanCodec.decode(PhysicalPlanCodec.encode(fullContext, fullPlan))
    assert(read.operators.nonEmpty)
    read.operators.foreach { op =>
      withClue(s"operator ${op.id.logicalOpId.id}-${op.id.layerName}: ") {
        // Neither the function the compile used nor PhysicalOp's default, the identity.
        assert(op.propagateSchema == PhysicalPlanCodec.ReadBackSchemaPropagation)
        val refused = intercept[UnsupportedOperationException] {
          op.propagateSchema.func(Map(PortIdentity(0) -> keyed))
        }
        assert(refused.getMessage.contains("read back from a saved plan"))
        // Deriving the schemas leaves that error on every output port, rather than a schema
        // copied from an input port.
        op.propagateSchema().outputPorts.values.foreach {
          case (port, _, schema) =>
            withClue(s"output port ${port.id.id}: ") {
              assert(schema.left.exists(_.getMessage == refused.getMessage))
            }
        }
      }
    }
  }

  // ----- what a saved plan holds -----

  /** Fails unless each of `fields` is listed as saved or as left out, and nothing else is. */
  private def assertAccountedFor(
      what: String,
      fields: Seq[String],
      saved: Set[String],
      leftOut: Map[String, String]
  ): Unit = {
    val listed = saved ++ leftOut.keySet
    val unlisted = fields.filterNot(listed.contains)
    assert(
      unlisted.isEmpty,
      s"$what has fields this spec does not list: ${unlisted.mkString(", ")}. Save each in " +
        "PhysicalPlanCodec, with a new format version and golden files, or list it as one a " +
        "saved plan leaves out, and why."
    )
    val gone = listed.filterNot(fields.contains)
    assert(gone.isEmpty, s"$what no longer has ${gone.mkString(", ")}")
  }

  it should "save every field of a plan and its context but those it leaves out on purpose" in {
    assertAccountedFor(
      "PhysicalOp",
      operator("op").productElementNames.toSeq,
      saved = Set(
        "id",
        "opExecInitInfo",
        "parallelizable",
        "locationPreference",
        "partitionRequirement",
        "outputPartitionRule",
        "inputPorts",
        "outputPorts",
        "isOneToManyOp",
        "requiresMaterializedExecution",
        "isLoopStart",
        "suggestedWorkerNum",
        "pveName",
        "repositoryMounts"
      ),
      leftOut = Map(
        "workflowId" -> "every operator's is the plan's, saved once",
        "executionId" -> "every operator's is the plan's, saved once",
        "propagateSchema" -> "a function, for compiling; each port keeps the schema it gave",
        "resourceBinding" -> "a plan made to run holds none, and saving one is refused"
      )
    )
    assertAccountedFor(
      "WorkflowSettings",
      WorkflowSettings(1, ExecutionMode.PIPELINED).productElementNames.toSeq,
      saved = Set("dataTransferBatchSize", "executionMode", "outputPortsNeedingStorage"),
      leftOut = Map.empty
    )
    assertAccountedFor(
      "WorkflowContext",
      classOf[WorkflowContext].getDeclaredFields.toSeq
        .filterNot(field => field.isSynthetic || Modifier.isStatic(field.getModifiers))
        .map(_.getName),
      saved = Set("workflowId", "executionId", "workflowSettings", "warehouse"),
      leftOut = Map("cuid" -> "the computing unit the plan runs on, which it does not choose")
    )
  }

  // ----- the format, pinned -----

  // Two small plans in format version 1, one for each execution mode, that use every name the
  // format has between them (a case below checks it). Their JSON is checked in: a change to what
  // the codec writes for them fails here, and a change to the format comes with a new format
  // version and golden files for it.

  // A column of each attribute type.
  private val goldenRow = schemaOf(
    "id" -> AttributeType.INTEGER,
    "name" -> AttributeType.STRING,
    "count" -> AttributeType.LONG,
    "score" -> AttributeType.DOUBLE,
    "valid" -> AttributeType.BOOLEAN,
    "seen" -> AttributeType.TIMESTAMP,
    "bytes" -> AttributeType.BINARY,
    "blob" -> AttributeType.LARGE_BINARY,
    "extra" -> AttributeType.ANY
  )
  private val goldenIds = schemaOf("id" -> AttributeType.INTEGER)

  private val goldenScan = withPorts(
    operator(
      "scan",
      executor = OpExecWithClassName("org.example.ScanOpExec", """{"file":"a.csv"}""")
    )
      .withParallelizable(false)
      .withLocationPreference(Some(PreferCoordinator)),
    outputs = Seq(OutputPort(PortIdentity(0), "out") -> goldenRow)
  )
  private val goldenUdf = withPorts(
    operator("udf", executor = OpExecWithCode("yield tuple_", "python")).copy(
      locationPreference = Some(RoundRobinPreference),
      partitionRequirement = List(Some(HashPartition(List("id"))), None),
      outputPartitionRule = PartitionRule.Fixed(UnknownPartition()),
      suggestedWorkerNum = Some(2),
      pveName = "py311",
      repositoryMounts =
        Some(RepositoryMounts("/mnt/texera-mounts", Set("dataset-1:d4t4", "model-2:m0d3l")))
    ),
    inputs = Seq(
      InputPort(PortIdentity(0), "in") -> goldenRow,
      InputPort(PortIdentity(1, internal = true), dependencies = List(PortIdentity(0))) ->
        goldenRow
    ),
    outputs = Seq(OutputPort(PortIdentity(0), mode = OutputMode.SET_DELTA) -> goldenIds)
  )
  private val goldenJoin = withPorts(
    operator("join", executor = OpExecWithClassName("org.example.JoinOpExec", "{}")).copy(
      partitionRequirement = List(
        Some(new RangePartition(List("id"), -10L, 99L)),
        Some(SinglePartition()),
        Some(OneToOnePartition()),
        Some(BroadcastPartition())
      ),
      outputPartitionRule = PartitionRule.KeepKeyedInput,
      isOneToManyOp = true,
      requiresMaterializedExecution = true,
      isLoopStart = true
    ),
    inputs = Seq(
      InputPort(PortIdentity(0), "build", disallowMultiLinks = true) -> goldenIds,
      InputPort(PortIdentity(1), "probe") -> goldenRow
    ),
    outputs = Seq(
      OutputPort(
        PortIdentity(0),
        "result",
        blocking = true,
        mode = OutputMode.SINGLE_SNAPSHOT,
        reuseStorage = true
      ) -> goldenIds
    )
  )
  // The scan's port lists two links.
  private val goldenPlan = planOf(
    Seq(goldenScan, goldenUdf, goldenJoin),
    Seq(
      link(goldenScan, goldenUdf),
      link(goldenUdf, goldenJoin),
      link(goldenScan, goldenJoin, toPort = 1)
    )
  )
  private val goldenContext = contextOf(
    WorkflowSettings(
      400,
      ExecutionMode.PIPELINED,
      Set(
        GlobalPortIdentity(goldenJoin.id, PortIdentity(0)),
        GlobalPortIdentity(goldenUdf.id, PortIdentity(0))
      )
    ),
    warehouse = Some("wh-1")
  )

  private val goldenSource = withPorts(
    operator("source", executor = OpExecWithCode("yield {'id': 1}", "python")),
    outputs = Seq(OutputPort(PortIdentity(0)) -> goldenIds)
  )
  private val goldenMaterializedContext = contextOf(
    WorkflowSettings(
      1,
      ExecutionMode.MATERIALIZED,
      Set(GlobalPortIdentity(goldenSource.id, PortIdentity(0)))
    )
  )

  private val goldenPlans: Seq[(String, WorkflowContext, PhysicalPlan)] = Seq(
    ("physical-plan-v1.json", goldenContext, goldenPlan),
    (
      "physical-plan-v1-materialized.json",
      goldenMaterializedContext,
      planOf(Seq(goldenSource), Nil)
    )
  )

  /** The golden file's text, with no newline at its end; empty if there is no such file. */
  private def golden(file: String): String =
    Option(getClass.getResourceAsStream(s"/storedplan/$file")).fold("") { stream =>
      try new String(stream.readAllBytes(), StandardCharsets.UTF_8).stripSuffix("\n")
      finally stream.close()
    }

  it should "write each golden plan in format version 1 exactly as its golden file has it" in {
    val differing = goldenPlans.flatMap {
      case (file, context, plan) =>
        val written = PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(context, plan))
        Option.when(written != golden(file)) {
          val actual = Files.createTempFile(file.stripSuffix(".json") + "-", ".json")
          Files.write(actual, (written + "\n").getBytes(StandardCharsets.UTF_8))
          s"$file (the codec writes $actual)"
        }
    }
    assert(
      differing.isEmpty,
      s"The codec no longer writes ${differing.mkString(", ")} as checked in. A change to the " +
        "format needs a new format version and golden files."
    )
  }

  it should "read each golden file in format version 1 back to its plan" in {
    goldenPlans.foreach {
      case (file, context, plan) =>
        withClue(s"$file: ") {
          assert(golden(file).nonEmpty, "the golden file is missing from the test resources")
          val (readContext, read) =
            PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(golden(file)))
          assertSameContext(context, readContext)
          assertSamePlan(plan, read)
        }
    }
  }

  it should "use every field, oneof case and enum value of the format in its golden files" in {
    val text = goldenPlans.map { case (file, _, _) => golden(file) }.mkString("\n")
    // Every field (a oneof's cases are fields too) and enum value, at any depth, reused messages
    // included; an UNSPECIFIED value is in no plan.
    val fields = mutable.SortedSet[String]()
    val values = mutable.SortedSet[String]()
    val seen = mutable.Set[String]()
    def walk(message: Descriptor): Unit =
      if (seen.add(message.fullName)) {
        message.fields.foreach { field =>
          fields += field.name
          field.scalaType match {
            case ScalaType.Message(nested) => walk(nested)
            case ScalaType.Enum(enumeration) =>
              values ++= enumeration.values.map(_.name).filterNot(_.endsWith("_UNSPECIFIED"))
            case _ =>
          }
        }
      }
    walk(StoredPhysicalPlan.scalaDescriptor)
    assert(fields.contains("opExecWithCode") && values.contains("SINGLE_SNAPSHOT"))

    val unused = fields.toSeq.filterNot(name => text.contains(s""""$name": """)) ++
      values.toSeq.filterNot(name => text.contains(s""""$name""""))
    assert(
      unused.isEmpty,
      s"No golden file uses ${unused.mkString(", ")}, so nothing checks what the format writes " +
        "for it. Use each in a golden plan."
    )
  }

  // ----- what it refuses to save -----

  private def refusal(action: => Any): String =
    intercept[IllegalArgumentException](action).getMessage

  private def assertRefused(action: => Any)(expected: String*): Unit = {
    val message = refusal(action)
    expected.foreach(part => assert(message.contains(part), s"[$message] does not say [$part]"))
  }

  /** `fullPlan` with `udf` replaced by `f(udf)`. */
  private def fullPlanWithUdf(f: PhysicalOp => PhysicalOp): PhysicalPlan =
    fullPlan.setOperator(f(fullPlan.getOperator(udf.id)))

  /** `op` with the dependencies of its input port 1 replaced. */
  private def dependingOn(dependencies: PortIdentity*)(op: PhysicalOp): PhysicalOp = {
    val (port, links, schema) = op.inputPorts(PortIdentity(1))
    op.copy(inputPorts =
      op.inputPorts + (PortIdentity(1) -> (port.withDependencies(dependencies), links, schema))
    )
  }

  it should "refuse to save an operator that still holds a resource binding" in {
    val binding: ResourceBinding = (_, _) => fail("saving a plan must not bind anything")
    assertRefused(
      PhysicalPlanCodec.encode(fullContext, fullPlanWithUdf(_.withResourceBinding(Some(binding))))
    )("udf-main", "never resolved")
  }

  it should "refuse to save an operator of another workflow or execution" in {
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        fullPlanWithUdf(_.copy(workflowId = WorkflowIdentity(8)))
      )
    )("udf-main", "workflow 8", "workflow 7")
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        fullPlanWithUdf(_.copy(executionId = ExecutionIdentity(1)))
      )
    )("udf-main", "execution 1", "execution 42")
  }

  it should "refuse to save a port with no schema" in {
    val missing = Left(new SchemaNotAvailableException("schema is not available"))
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        fullPlanWithUdf { op =>
          val (port, links, _) = op.inputPorts(PortIdentity(1))
          op.copy(inputPorts = op.inputPorts + (PortIdentity(1) -> (port, links, missing)))
        }
      )
    )("input port 1", "udf-main", "no schema", "schema is not available")
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        fullPlanWithUdf { op =>
          val (port, links, _) = op.outputPorts(PortIdentity(0))
          op.copy(outputPorts = op.outputPorts + (PortIdentity(0) -> (port, links, missing)))
        }
      )
    )("output port 0", "udf-main", "no schema")
  }

  it should "refuse to save an operator with no executor, or a port under another id" in {
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        fullPlanWithUdf(_.copy(opExecInitInfo = OpExecInitInfo.Empty))
      )
    )("udf-main", "no executor")
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        fullPlanWithUdf { op =>
          op.copy(inputPorts = op.inputPorts.map {
            case (id, (port, links, schema)) =>
              id -> (port.copy(id = PortIdentity(id.id + 5)), links, schema)
          })
        }
      )
    )("udf-main", "input port 5", "under port 0")
  }

  it should "refuse to save a plan whose links and ports disagree" in {
    val ghost = PhysicalLink(udf.id, PortIdentity(0), opId("ghost"), PortIdentity(0))
    assertRefused(
      PhysicalPlanCodec.encode(fullContext, fullPlan.copy(links = fullPlan.links + ghost))
    )("udf-main[0] -> ghost-main[0]", "names operator ghost-main")
    val unlisted = fullPlanWithUdf { op =>
      val (port, _, schema) = op.inputPorts(PortIdentity(1))
      op.copy(inputPorts = op.inputPorts + (PortIdentity(1) -> (port, Nil, schema)))
    }
    assertRefused(PhysicalPlanCodec.encode(fullContext, unlisted))(
      "scan-main[0] -> udf-main[1]",
      "listed 0 times on the input port 1 of operator udf-main"
    )
    val twin = fullPlan.operators.find(_.id == udf.id).get.withPveName("another")
    assertRefused(
      PhysicalPlanCodec.encode(fullContext, fullPlan.copy(operators = fullPlan.operators + twin))
    )("2 operators udf-main")
  }

  it should "refuse to save a plan whose links form a cycle" in {
    val back = PhysicalLink(globalAgg.id, PortIdentity(0), udf.id, PortIdentity(1))
    assertRefused(
      PhysicalPlanCodec.encode(
        fullContext,
        planOf(Seq(scan, udf, localAgg, globalAgg), fullLinks :+ back)
      )
    )("closes a cycle")
  }

  it should "refuse to save an input port that depends on a port its operator does not have" in {
    assertRefused(
      PhysicalPlanCodec.encode(fullContext, fullPlanWithUdf(dependingOn(PortIdentity(7))))
    )(
      "input port 1 of operator udf-main depends on its input port 7, which the operator does " +
        "not have"
    )
    // an input port, of its own operator, is what it can depend on
    assertRoundTrips(fullContext, fullPlanWithUdf(dependingOn(PortIdentity(0), PortIdentity(1))))
  }

  it should "refuse to save settings that store the results of a port the plan does not have" in {
    val context = contextOf(
      WorkflowSettings(
        400,
        ExecutionMode.PIPELINED,
        Set(GlobalPortIdentity(udf.id, PortIdentity(4)))
      )
    )
    assertRefused(PhysicalPlanCodec.encode(context, fullPlan))("output port 4 of operator udf-main")
  }

  it should "refuse to save settings that send batches of no tuple" in {
    Seq(0, -5).foreach { size =>
      assertRefused(
        PhysicalPlanCodec.encode(
          contextOf(WorkflowSettings(size, ExecutionMode.PIPELINED)),
          planOf(Seq(operator("op")), Nil)
        )
      )(s"batch size is $size")
    }
  }

  // ----- what it refuses to read -----

  private val valid: StoredPhysicalPlan = PhysicalPlanCodec.encode(fullContext, fullPlan)

  private def indexOf(id: PhysicalOpIdentity): Int = valid.operators.indexWhere(_.id.contains(id))

  /** `valid` with the saved operator `id` replaced by `f` of it. */
  private def withStoredOp(id: PhysicalOpIdentity)(f: StoredPhysicalOp => StoredPhysicalOp) =
    valid.copy(operators = valid.operators.updated(indexOf(id), f(valid.operators(indexOf(id)))))

  /** `valid` with `link` added to the plan's links, and last to those of the ports it joins. */
  private def withStoredLink(link: PhysicalLink): StoredPhysicalPlan =
    valid.copy(
      operators = valid.operators.map { op =>
        op.update(
          _.outputPorts.modify(_.map { port =>
            if (op.id.contains(link.fromOpId) && port.getPort.id == link.fromPortId) {
              port.addLinks(link)
            } else port
          }),
          _.inputPorts.modify(_.map { port =>
            if (op.id.contains(link.toOpId) && port.getPort.id == link.toPortId) {
              port.addLinks(link)
            } else port
          })
        )
      },
      links = valid.links :+ link
    )

  private def assertUnreadable(stored: StoredPhysicalPlan)(expected: String*): Unit =
    assertRefused(PhysicalPlanCodec.decode(stored))(expected: _*)

  it should "read the plan it refuses nothing in" in {
    val (context, plan) = PhysicalPlanCodec.decode(valid)
    assertSameContext(fullContext, context)
    assertSamePlan(fullPlan, plan)
  }

  it should "refuse a plan in another format version, naming both versions" in {
    assertUnreadable(valid.copy(formatVersion = 2))("format version 2", "reads version 1")
    assertUnreadable(valid.copy(formatVersion = 0))("names no format version", "reads version 1")
  }

  it should "refuse a plan that names no workflow or execution, or has no settings" in {
    assertUnreadable(valid.copy(workflowId = None))("names no workflow")
    assertUnreadable(valid.copy(executionId = None))("names no execution")
    assertUnreadable(valid.copy(settings = None))("has no settings")
  }

  it should "refuse an operator with no id or no executor" in {
    assertUnreadable(withStoredOp(udf.id)(_.copy(id = None)))("has no id")
    assertUnreadable(withStoredOp(udf.id)(_.copy(opExecInitInfo = OpExecInitInfo.Empty)))(
      "udf-main",
      "no executor"
    )
  }

  it should "refuse a value left unspecified in every enum the format defines" in {
    assertUnreadable(
      valid.update(_.settings.executionMode := StoredMode.EXECUTION_MODE_UNSPECIFIED)
    )(
      "execution mode",
      "EXECUTION_MODE_UNSPECIFIED"
    )
    assertUnreadable(
      withStoredOp(udf.id)(_.withLocationPreference(StoredLocation.LOCATION_PREFERENCE_UNSPECIFIED))
    )(
      "location preference of operator udf-main",
      "LOCATION_PREFERENCE_UNSPECIFIED"
    )
    assertUnreadable(
      withStoredOp(udf.id)(
        _.update(
          _.outputPorts(0).schema
            .attributes(0)
            .attributeType := StoredType.ATTRIBUTE_TYPE_UNSPECIFIED
        )
      )
    )("attribute k", "output port 0 of operator udf-main", "ATTRIBUTE_TYPE_UNSPECIFIED")
  }

  it should "refuse an enum value it does not know" in {
    assertUnreadable(valid.update(_.settings.executionMode := StoredMode.Unrecognized(7)))(
      "execution mode is 7"
    )
    assertUnreadable(
      withStoredOp(udf.id)(_.withLocationPreference(StoredLocation.Unrecognized(9)))
    )(
      "location preference of operator udf-main is 9"
    )
    assertUnreadable(
      withStoredOp(udf.id)(
        _.update(_.outputPorts(0).schema.attributes(0).attributeType := StoredType.Unrecognized(42))
      )
    )("attribute k", "is 42")
    assertUnreadable(
      withStoredOp(udf.id)(_.update(_.outputPorts(0).port.mode := OutputMode.Unrecognized(5)))
    )("mode of output port 0 of operator udf-main is 5")
  }

  it should "refuse a partitioning, a requirement or a rule that names no kind" in {
    val noKind = StoredPartitionInfo(Kind.Empty)
    assertUnreadable(withStoredOp(udf.id)(_.clearOutputPartitionRule))(
      "udf-main has no output partition rule"
    )
    assertUnreadable(
      withStoredOp(udf.id)(_.withOutputPartitionRule(StoredPartitionRule(Rule.Empty)))
    )(
      "rule of operator udf-main names no rule"
    )
    assertUnreadable(
      withStoredOp(udf.id)(_.withOutputPartitionRule(StoredPartitionRule(Rule.Fixed(noKind))))
    )("rule of operator udf-main names no kind")
    assertUnreadable(
      withStoredOp(udf.id)(_.update(_.partitionRequirement(1).partition := noKind))
    )("partition requirement on input port 1 of operator udf-main names no kind")
    assertUnreadable(
      withStoredOp(udf.id)(_.update(_.partitionRequirement(0).requirement := Requirement.Empty))
    )("partition requirement on input port 0 of operator udf-main names neither")
  }

  it should "refuse a port that is empty or has no schema" in {
    assertUnreadable(withStoredOp(udf.id)(_.update(_.inputPorts(1).optionalPort := None)))(
      "input port of operator udf-main is empty"
    )
    assertUnreadable(withStoredOp(udf.id)(_.update(_.outputPorts(0).optionalSchema := None)))(
      "output port 0 of operator udf-main has no schema"
    )
  }

  it should "refuse a link that names an operator or a port the plan does not have" in {
    val toGhost = PhysicalLink(udf.id, PortIdentity(0), opId("ghost"), PortIdentity(0))
    assertUnreadable(valid.copy(links = valid.links :+ toGhost))("names operator ghost-main")
    val toMissingPort = PhysicalLink(scan.id, PortIdentity(0), udf.id, PortIdentity(9))
    assertUnreadable(valid.copy(links = valid.links :+ toMissingPort))(
      "joins the input port 9 of operator udf-main, which the operator does not have"
    )
    val fromMissingPort = PhysicalLink(scan.id, PortIdentity(3), udf.id, PortIdentity(0))
    assertUnreadable(valid.copy(links = valid.links :+ fromMissingPort))(
      "joins the output port 3 of operator scan-main"
    )
  }

  it should "refuse ports whose links disagree with the plan's" in {
    val scanToUdf1 = link(scan, udf, toPort = 1)
    // not listed on the port it ends at
    assertUnreadable(withStoredOp(udf.id)(_.update(_.inputPorts(1).links := Nil)))(
      "scan-main[0] -> udf-main[1] is listed 0 times on the input port 1 of operator udf-main"
    )
    // listed twice
    assertUnreadable(withStoredOp(udf.id)(_.update(_.inputPorts(1).links :+= scanToUdf1)))(
      "is listed 2 times on the input port 1"
    )
    // listed on a port it does not join, as well as on its own
    assertUnreadable(withStoredOp(udf.id)(_.update(_.inputPorts(0).links :+= scanToUdf1)))(
      "input port 0 of operator udf-main lists link scan-main[0] -> udf-main[1], " +
        "which does not join it"
    )
    // listed, but not one of the plan's links
    assertUnreadable(valid.copy(links = valid.links.filterNot(_ == scanToUdf1)))(
      "lists link scan-main[0] -> udf-main[1], which is not one of the plan's"
    )
  }

  it should "refuse links that form a cycle, a link from an operator to itself included" in {
    assertUnreadable(
      withStoredLink(PhysicalLink(udf.id, PortIdentity(0), udf.id, PortIdentity(0)))
    )(
      "Link udf-main[0] -> udf-main[0] closes a cycle"
    )
    // udf -> localAgg -> globalAgg -> udf
    assertUnreadable(
      withStoredLink(PhysicalLink(globalAgg.id, PortIdentity(0), udf.id, PortIdentity(1)))
    )("closes a cycle")
  }

  it should "refuse an input port that depends on a port its operator does not have" in {
    assertUnreadable(
      withStoredOp(udf.id)(_.update(_.inputPorts(1).port.dependencies := Seq(PortIdentity(7))))
    )(
      "input port 1 of operator udf-main depends on its input port 7, which the operator does " +
        "not have"
    )
    // an internal port 0 is another port than port 0, and an output port is not an input port
    assertUnreadable(
      withStoredOp(udf.id)(
        _.update(_.inputPorts(1).port.dependencies := Seq(PortIdentity(0, internal = true)))
      )
    )("depends on its input port 0 (internal)")
    assertUnreadable(
      withStoredOp(localAgg.id)(
        _.update(_.inputPorts(0).port.dependencies := Seq(PortIdentity(0, internal = true)))
      )
    )("input port 0 of operator agg-localAgg depends on its input port 0 (internal)")
  }

  it should "refuse an operator, port, link, stored port or repository that appears twice" in {
    assertUnreadable(valid.copy(operators = valid.operators :+ valid.operators(indexOf(udf.id))))(
      "Operator udf-main appears twice"
    )
    assertUnreadable(
      withStoredOp(udf.id)(op => op.withInputPorts(op.inputPorts :+ op.inputPorts.head))
    )(
      "input port 0 of operator udf-main appears twice"
    )
    assertUnreadable(valid.copy(links = valid.links :+ valid.links.head))("appears twice")
    assertUnreadable(
      valid.update(
        _.settings.outputPortsNeedingStorage :+= GlobalPortIdentity(udf.id, PortIdentity(0))
      )
    )(
      "output port 0 of operator udf-main appears twice"
    )
    assertUnreadable(
      withStoredOp(udf.id)(_.update(_.repositoryMounts.locators :+= "dataset-1:d4t4"))
    )(
      "Repository dataset-1:d4t4 of operator udf-main appears twice"
    )
  }

  it should "refuse settings that store the results of a port the plan does not have" in {
    assertUnreadable(
      valid.update(
        _.settings.outputPortsNeedingStorage :+= GlobalPortIdentity(opId("ghost"), PortIdentity(0))
      )
    )(
      "output port 0 of operator ghost-main, which is not an output port of the plan"
    )
    assertUnreadable(
      valid.update(
        _.settings.outputPortsNeedingStorage :+= GlobalPortIdentity(
          udf.id,
          PortIdentity(0),
          input = true
        )
      )
    )(
      "input port 0 of operator udf-main, which is not an output port of the plan"
    )
  }

  it should "refuse settings that send batches of no tuple" in {
    Seq(0, -5).foreach { size =>
      assertUnreadable(valid.update(_.settings.dataTransferBatchSize := size))(
        s"batch size is $size"
      )
    }
  }

  it should "refuse mounts that RepositoryMounts refuses" in {
    assertUnreadable(withStoredOp(udf.id)(_.update(_.repositoryMounts.root := " ")))(
      "udf-main cannot mount",
      "no directory"
    )
    assertUnreadable(withStoredOp(udf.id)(_.update(_.repositoryMounts.locators := Nil)))(
      "udf-main cannot mount",
      "name no repository"
    )
    assertUnreadable(
      withStoredOp(udf.id)(_.update(_.repositoryMounts.locators := Seq("no-commit")))
    )(
      "udf-main cannot mount",
      "Invalid mount locator 'no-commit'"
    )
  }

  // ----- its JSON -----

  private val validJson = PhysicalPlanCodec.toJson(valid)

  /** `json` with each field `edit` matches, at any depth, replaced by what it gives, if any. */
  private def editedJson(
      json: String
  )(edit: PartialFunction[(String, JValue), Option[(String, JValue)]]): String = {
    def walk(value: JValue): JValue =
      value match {
        case JObject(fields) =>
          JObject(fields.flatMap(field => edit.applyOrElse(field, Some(_: (String, JValue)))).map {
            case (name, nested) => name -> walk(nested)
          })
        case JArray(items) => JArray(items.map(walk))
        case other         => other
      }
    compact(walk(parse(json)))
  }

  it should "write every field out, a port 0 and every default value included" in {
    val written = compact(parse(validJson))
    Seq(
      "\"formatVersion\":1",
      // proto3 JSON would leave out a PortIdentity at its default, so port 0 would not show
      "\"fromPortId\":{\"id\":0,\"internal\":false}",
      "\"port\":{\"id\":{\"id\":0,\"internal\":false},\"displayName\":\"\"," +
        "\"disallowMultiLinks\":false",
      "\"dependencies\":[]",
      "\"blocking\":false,\"mode\":\"SET_SNAPSHOT\",\"reuseStorage\":false",
      "\"partitionRequirement\":[]",
      // "no requirement" is written out, not left as an empty entry
      "{\"noRequirement\":{}}",
      "\"inputPorts\":[]",
      "\"isLoopStart\":false",
      "\"pveName\":\"\"",
      "\"warehouse\":\"lake-wh\"",
      "\"suggestedWorkerNum\":3"
    ).foreach(field => assert(written.contains(field), s"[$field] is not in $written"))
    // An optional field that is none is left out: absent means none.
    val noneOfThem = PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.encode(contextOf(), planOf(Seq(operator("op")), Nil))
    )
    Seq("warehouse", "suggestedWorkerNum", "repositoryMounts").foreach { field =>
      assert(!noneOfThem.contains("\"" + field + "\""), s"$field is written though it is none")
    }
  }

  it should "read a plan whatever the order of its fields and its spacing" in {
    def reversed(value: JValue): JValue =
      value match {
        case JObject(fields) =>
          JObject(fields.reverse.map { case (name, v) => name -> reversed(v) })
        case JArray(items) => JArray(items.map(reversed))
        case other         => other
      }
    assert(PhysicalPlanCodec.fromJson(compact(reversed(parse(validJson)))) == valid)
    assert(PhysicalPlanCodec.fromJson(s"\n  $validJson\n\n") == valid)
  }

  it should "refuse JSON with a field the format does not have, at any depth" in {
    assertRefused(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("pveName", name) => Some("pveNames" -> name)
    }))("pveNames")
    assertRefused(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("toPortId", port) => Some("toPort" -> port)
    }))("toPort")
  }

  it should "refuse text that is not one JSON object" in {
    assertRefused(PhysicalPlanCodec.fromJson(validJson.take(validJson.length / 2)))("not JSON")
    assertRefused(PhysicalPlanCodec.fromJson(""))("not JSON")
    assertRefused(PhysicalPlanCodec.fromJson("[]"))("not a JSON object")
    assertRefused(PhysicalPlanCodec.fromJson("null"))("not a JSON object")
  }

  it should "refuse text after the plan" in {
    // as a lake cell that two writes appended to would hold
    assertRefused(PhysicalPlanCodec.fromJson(validJson + "\n" + validJson))(
      "not JSON",
      "Trailing token"
    )
    assertRefused(PhysicalPlanCodec.fromJson(validJson + " garbage"))("not JSON")
  }

  it should "refuse a field given twice in one object" in {
    val repeated =
      validJson.replaceFirst("\"pveName\": \"\"", "\"pveName\": \"\", \"pveName\": \"x\"")
    assert(repeated != validJson)
    assertRefused(PhysicalPlanCodec.fromJson(repeated))("not JSON", "Duplicate field 'pveName'")
    // the version too, which is read before anything else
    assertRefused(PhysicalPlanCodec.fromJson("{\"formatVersion\": 2, " + validJson.drop(1)))(
      "Duplicate field 'formatVersion'"
    )
  }

  it should "refuse JSON in another format version before looking at its fields" in {
    val laterVersion = editedJson(validJson) {
      case ("formatVersion", _) => Some("formatVersion" -> JInt(2))
      case ("pveName", name)    => Some("aFieldOfVersion2" -> name)
    }
    assertRefused(PhysicalPlanCodec.fromJson(laterVersion))("format version 2", "reads version 1")
    Seq(JString("3") -> "\"3\"", JString("1") -> "\"1\"", JDouble(2.0) -> "2.0").foreach {
      case (version, written) =>
        val json = editedJson(validJson) {
          case ("formatVersion", _) => Some("formatVersion" -> version)
        }
        assertRefused(PhysicalPlanCodec.fromJson(json))(
          s"format version is $written, not a whole number",
          "reads version 1"
        )
    }
    val noVersion = editedJson(validJson) { case ("formatVersion", _) => None }
    assertRefused(PhysicalPlanCodec.fromJson(noVersion))("names no format version")
  }

  it should "refuse JSON that leaves out a field, or writes a value otherwise than a saved plan" in {
    def assertMisread(json: String)(where: String): Unit =
      assertRefused(PhysicalPlanCodec.fromJson(json))("not written as a saved plan is", where)
    // a field left out, which the parser would read as its default
    assertMisread(editedJson(validJson) { case ("parallelizable", _) => None })(
      "/operators/0/parallelizable is missing"
    )
    assertMisread(editedJson(validJson) { case ("dataTransferBatchSize", _) => None })(
      "/settings/dataTransferBatchSize is missing"
    )
    assertMisread(editedJson(validJson) { case ("mode", _) => None })(
      "/operators/0/outputPorts/0/port/mode is missing"
    )
    // A message left out reads as none, as a saved plan writes none; reading the plan refuses
    // none where it needs one.
    assertUnreadable(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("outputPartitionRule", _) => None
    }))("has no output partition rule")
    assertUnreadable(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("settings", _) => None
    }))("has no settings")
    // a value the parser reads, written as no saved plan writes it
    assertMisread(validJson.replace("\"MATERIALIZED\"", "2"))(
      "/settings/executionMode is 2, which a saved plan writes as \"MATERIALIZED\""
    )
    assertMisread(editedJson(validJson) {
      case ("workflowId", _) => Some("workflowId" -> JObject("id" -> JInt(7)))
    })("/workflowId/id is 7, which a saved plan writes as \"7\"")
    assertMisread(validJson.replace("\"warehouse\": \"lake-wh\"", "\"warehouse\": null"))(
      "/warehouse is null, but a saved plan leaves it out"
    )
  }

  it should "refuse an enum value the format does not name, and read one it names but refuses" in {
    assertRefused(
      PhysicalPlanCodec.fromJson(validJson.replace("\"MATERIALIZED\"", "\"STREAMING\""))
    )(
      "STREAMING"
    )
    val unspecified = PhysicalPlanCodec.fromJson(
      validJson.replace("\"MATERIALIZED\"", "\"EXECUTION_MODE_UNSPECIFIED\"")
    )
    assertUnreadable(unspecified)("EXECUTION_MODE_UNSPECIFIED")
  }

  it should "read a partition requirement left empty, and refuse it as naming nothing" in {
    // {} is how a requirement that names neither a partitioning nor none is written
    val unsaid = PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("noRequirement", _) => None
    })
    assertUnreadable(unsaid)("partition requirement on input port 1 of operator udf-main")
  }
}
