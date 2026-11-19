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

import org.apache.texera.amber.core.executor.{
  FileListing,
  InputFile,
  OpExecInitInfo,
  OpExecWithClassName,
  OpExecWithCode,
  OperatorInputs
}
import org.apache.texera.amber.core.storage.{InputLink, InputLinker}
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
  assertSameExecutionPlan
}
import org.json4s.jackson.JsonMethods.{compact, parse}
import org.json4s.{JArray, JDouble, JInt, JObject, JString, JValue}
import org.scalatest.flatspec.AnyFlatSpec
import scalapb.descriptors.{Descriptor, ScalaType}

import java.lang.reflect.Modifier
import java.net.URI
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

  /**
    * `op` with these ports, in this order, each with a schema and no link yet, and each output
    * port stored where a run in no warehouse of its own stores it.
    */
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
    ).withStorageLocations(None)

  /**
    * A plan of `operators` and `links`, in this order, each link listed on the two ports it joins
    * in the order of `links` — as the compiler's addLink lists them, though no schema propagates.
    * Its output ports are stored in `warehouse`.
    */
  private def planOf(
      operators: Seq[PhysicalOp],
      links: Seq[PhysicalLink],
      warehouse: Option[String] = None
  ): PhysicalPlan = {
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
        ).withStorageLocations(warehouse)
      }.toSet,
      links.toSet
    )
  }

  private def link(from: PhysicalOp, to: PhysicalOp, fromPort: Int = 0, toPort: Int = 0) =
    PhysicalLink(from.id, PortIdentity(fromPort), to.id, PortIdentity(toPort))

  private def contextOf(
      settings: WorkflowSettings = WorkflowSettings(400, ExecutionMode.PIPELINED),
      warehouse: Option[String] = None,
      costHints: Option[CostHints] = None
  ): WorkflowContext =
    new WorkflowContext(
      workflowId,
      executionId,
      settings,
      warehouse = warehouse,
      costHints = costHints
    )

  /** Saves `plan`, made to run under `context`, with nothing else for the run. */
  private def save(context: WorkflowContext, plan: PhysicalPlan): StoredPhysicalPlan =
    PhysicalPlanCodec.encode(ExecutionPlan(context, plan))

  // ----- a plan that sets every field -----

  /** A link to `file`, signed as an object store signs one. */
  private def linkTo(file: String): String =
    s"http://texera-rustfs:9000/texera-dataset/$file?X-Amz-Signature=5ecr3t"

  // Every kind of thing an operator reads from outside the run: files in the order of their
  // names, a listing in the order it was listed, and a limit of the site's.
  private val scanInputs = OperatorInputs(
    files = Seq(
      InputFile("dataset:///ds-1/d4t4/a.csv", linkTo("a"), Long.MaxValue),
      InputFile("dataset:///ds-1/d4t4/résumé.csv", linkTo("r%C3%A9sum%C3%A9"), 1763856000000L)
    ),
    listing = Some(FileListing(Seq("/dataset/a@x.io/ds/v1/b.txt", "/dataset/a@x.io/ds/v1/a.txt"))),
    csvParserMaxColumns = Some(731)
  )

  private val scan = withPorts(
    operator(
      "scan",
      executor = OpExecWithClassName("org.example.ScanOpExec", """{"fileName":"résumé.csv"}""")
    ).copy(
      parallelizable = false,
      locationPreference = Some(PreferCoordinator),
      inputs = scanInputs
    ),
    outputs = Seq(OutputPort(PortIdentity(0), "rows") -> everyType)
  )

  // What the plan's user keeps under a name of more than ASCII: only its lines are pip's to read.
  private val fullEnvironment =
    PythonEnvironment("ml ünï", Seq("numpy>=2.1.0", "tabulate==0.9.0", "typing-extensions"))

  private val udf = withPorts(
    operator("udf", executor = OpExecWithCode("print('héllo')\nyield {'k': 1}\n", "python")).copy(
      locationPreference = Some(RoundRobinPreference),
      partitionRequirement = List(Some(HashPartition(List("k"))), None),
      outputPartitionRule =
        PartitionRule.Fixed(new RangePartition(List("k", "Value"), Long.MinValue, Long.MaxValue)),
      isOneToManyOp = true,
      suggestedWorkerNum = Some(3),
      pythonEnvironment = PythonEnvironmentRef.Resolved(fullEnvironment),
      repositoryMounts = Some(RepositoryMounts(Set("dataset-1:d4t4", "model-1:m0d3l")))
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
      requiresMaterializedExecution = true,
      inputs = OperatorInputs(files = Seq(InputFile("a", linkTo("a"), 1L)))
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

  private val fullWarehouse = Some("lake-wh")

  private val fullPlan = planOf(Seq(scan, udf, localAgg, globalAgg), fullLinks, fullWarehouse)

  private val fullContext = contextOf(
    WorkflowSettings(
      100,
      ExecutionMode.MATERIALIZED,
      Set(
        GlobalPortIdentity(globalAgg.id, PortIdentity(0)),
        GlobalPortIdentity(udf.id, PortIdentity(0))
      )
    ),
    warehouse = fullWarehouse,
    // An operator the plan no longer has among them, as the workflow may have changed since.
    costHints = Some(
      CostHints(
        ExecutionIdentity(41),
        Map("udf" -> 12.5, "scan" -> 0.0, "agg" -> 1e-3, "removed-since" -> 7200.25)
      )
    )
  )

  private val fullReplay =
    ReplaySource(ExecutionIdentity(40), new URI("file:///var/texera/logs/7/40/"), "interaction-3")

  private val fullExecutionPlan = ExecutionPlan(
    fullContext,
    fullPlan,
    replay = Some(fullReplay),
    replayLog = Some(new URI("hdfs://namenode:8020/texera/logs/7/42/"))
  )

  "PhysicalPlanCodec" should "save a plan that sets every field and read the same plan back" in {
    assertRoundTrips(fullExecutionPlan)
  }

  // ----- a plan whose files are not linked yet -----

  /** Where `file` is kept: the object a link to it is signed for. */
  private def addressOf(file: InputFile): String =
    s"s3://texera-dataset/data/${file.name.hashCode.toHexString}"

  /** `plan` as a compile makes it: each file where it is kept, with no link. */
  private def unlinked(plan: PhysicalPlan): PhysicalPlan =
    PhysicalPlan(
      plan.operators.map { op =>
        op.withInputs(op.inputs.copy(files = op.inputs.files.map { file =>
          InputFile(file.name, physicalAddress = addressOf(file))
        }))
      },
      plan.links
    )

  private val fullUnlinkedPlan = fullExecutionPlan.copy(plan = unlinked(fullPlan))

  it should "save a plan whose files are not linked yet, each where it is kept, and read the same plan back" in {
    val json = PhysicalPlanRoundTrip.assertRoundTripsUnlinked(fullUnlinkedPlan)

    // Nothing of a link is written for a file that has none.
    assert(!json.contains("\"url\"") && !json.contains("\"expiresAtMs\""))
    assert(json.contains("\"physicalAddress\": \"s3://texera-dataset/data/"))
    // But for its files, the plan is the linked plan's.
    val linker: InputLinker = address =>
      fullPlan.operators
        .flatMap(_.inputs.files)
        .find(addressOf(_) == address)
        .map(_.link)
        .getOrElse(fail(s"asked to link $address, which no file of the plan is kept at"))
    assertSameExecutionPlan(
      fullExecutionPlan,
      fullUnlinkedPlan.copy(plan = fullUnlinkedPlan.plan.linkedBy(linker))
    )
  }

  it should "link each address of a plan once, however many operators read the file kept there, and leave a linked plan as it is" in {
    val asked = mutable.ListBuffer.empty[String]
    val linker: InputLinker = address => {
      asked += address
      InputLink(s"http://texera-rustfs:9000/${address.stripPrefix("s3://")}?X-Amz-Signature=s", 9L)
    }
    // The scan's first file is also the only file the local aggregate reads.
    val shared = InputFile("dataset:///ds-1/d4t4/a.csv", physicalAddress = "s3://bucket/a")
    val other = InputFile("dataset:///ds-1/d4t4/b.csv", physicalAddress = "s3://bucket/b")
    val plan = fullPlan
      .setOperator(fullPlan.getOperator(scan.id).withInputs(OperatorInputs(Seq(shared, other))))
      .setOperator(fullPlan.getOperator(localAgg.id).withInputs(OperatorInputs(Seq(shared))))

    val linked = plan.linkedBy(linker)

    assert(asked.toList.sorted == List("s3://bucket/a", "s3://bucket/b"))
    assert(
      linked.getOperator(scan.id).inputs.files == Seq(
        InputFile(shared.name, "http://texera-rustfs:9000/bucket/a?X-Amz-Signature=s", 9L),
        InputFile(other.name, "http://texera-rustfs:9000/bucket/b?X-Amz-Signature=s", 9L)
      )
    )
    assert(
      linked.getOperator(localAgg.id).inputs.files ==
        Seq(InputFile(shared.name, "http://texera-rustfs:9000/bucket/a?X-Amz-Signature=s", 9L))
    )
    // What an operator reads besides its files, and the operators that read none, are as they
    // were; and a plan whose files have their links is asked nothing about.
    assert(linked.getOperator(udf.id) == fullPlan.getOperator(udf.id))
    assert(linked.links == plan.links)
    assert(linked.linkedBy(_ => fail("asked to link a linked plan")) == linked)
    assert(fullPlan.linkedBy(_ => fail("asked to link a linked plan")) == fullPlan)
  }

  it should "refuse, as a plan to run, one whose files are not linked; and as one not linked yet, one whose files are" in {
    // The UDF alone reads a file, so that it is its file each refusal names.
    val readsNone = Seq(scan.id, localAgg.id).foldLeft(fullPlan) { (plan, id) =>
      plan.setOperator(plan.getOperator(id).withInputs(OperatorInputs()))
    }
    def reading(file: InputFile): ExecutionPlan =
      fullExecutionPlan.copy(plan =
        readsNone
          .setOperator(readsNone.getOperator(udf.id).withInputs(OperatorInputs(Seq(file))))
      )
    val linked = InputFile("dataset:///ds-1/d4t4/a.csv", linkTo("a"), 5L)
    val file = InputFile(linked.name, physicalAddress = "s3://texera-dataset/data/a")
    // A computing unit reads a plan with `decode`: one the compile made is not yet one to run.
    assertRefused(PhysicalPlanCodec.encode(reading(file)))(
      s"Operator udf-main has no link to its file ${file.name}"
    )
    assertRefused(PhysicalPlanCodec.decode(PhysicalPlanCodec.encodeUnlinked(reading(file))))(
      s"Operator udf-main has no link to its file ${file.name}"
    )
    assertRefused(PhysicalPlanCodec.encodeUnlinked(reading(linked)))(
      s"The file ${file.name} of operator udf-main does not say where it is kept"
    )
    assertRefused(PhysicalPlanCodec.decodeUnlinked(PhysicalPlanCodec.encode(reading(linked))))(
      s"The file ${file.name} of operator udf-main does not say where it is kept"
    )
    // A file has its address or its link, never both.
    val both = reading(linked.copy(physicalAddress = file.physicalAddress))
    assertRefused(PhysicalPlanCodec.encode(both))(
      s"The file ${file.name} of operator udf-main has its link and still names where it is kept"
    )
    assertRefused(PhysicalPlanCodec.encodeUnlinked(both))(
      s"The file ${file.name} of operator udf-main has a link already"
    )
    assertRefused(PhysicalPlanCodec.encodeUnlinked(reading(file.copy(expiresAtMs = 5L))))(
      s"The file ${file.name} of operator udf-main has a link already"
    )
    // What every plan's files are held to, linked or not.
    assertRefused(PhysicalPlanCodec.encodeUnlinked(reading(file.copy(name = ""))))(
      "A file operator udf-main reads has no name"
    )
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

  it should "save and read back a worker count, a Python environment and mounts, or none of them" in {
    Seq(
      operator("op"),
      // proto3 would leave a 0 out; an optional field keeps it apart from "no worker count"
      operator("op").withSuggestedWorkerNum(0),
      operator("op")
        .withSuggestedWorkerNum(16)
        .withPythonEnvironment(PythonEnvironmentRef.Resolved(fullEnvironment)),
      // an environment that installs nothing is still one, apart from the engine's own
      operator("op").withPythonEnvironment(
        PythonEnvironmentRef.Resolved(PythonEnvironment("bare", Seq.empty))
      ),
      operator("op").copy(repositoryMounts = Some(RepositoryMounts(Set("r:c"))))
    ).foreach { op =>
      withClue(s"$op: ") {
        assertRoundTrips(contextOf(), planOf(Seq(op), Nil))
      }
    }
  }

  it should "save and read back what an operator reads from outside the run, each kind alone, all of them or none" in {
    val file = InputFile("dataset:///ds-1/d4t4/a.csv", linkTo("a"), 1763856000000L)
    Seq(
      OperatorInputs(),
      OperatorInputs(files = Seq(file)),
      OperatorInputs(listing = Some(FileListing(Seq("/dataset/a@x.io/ds/v1/a.txt")))),
      // a version that holds no file is listed all the same, apart from no listing
      OperatorInputs(listing = Some(FileListing())),
      OperatorInputs(csvParserMaxColumns = Some(1)),
      scanInputs
    ).foreach { inputs =>
      withClue(s"$inputs: ") {
        val json =
          assertRoundTrips(contextOf(), planOf(Seq(operator("op").withInputs(inputs)), Nil))
        val read = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(json)).plan
        assert(read.getOperator(opId("op")).inputs == inputs)
      }
    }
  }

  it should "read an operator's Python environment back as it was saved, or the engine's own" in {
    val read = PhysicalPlanCodec.decode(save(fullContext, fullPlan)).plan
    assert(
      read.getOperator(udf.id).pythonEnvironment == PythonEnvironmentRef.Resolved(fullEnvironment)
    )
    assert(read.getOperator(scan.id).pythonEnvironment == PythonEnvironmentRef.EngineDefault)
    // Saved as its name and its lines: a unit derives the digest it installs them under.
    val stored = save(fullContext, fullPlan).operators.find(_.id.contains(udf.id)).get
    assert(
      stored.pythonEnvironment.contains(
        StoredPythonEnvironment(
          "ml ünï",
          Seq("numpy>=2.1.0", "tabulate==0.9.0", "typing-extensions")
        )
      )
    )
  }

  it should "save and read back each port's schema, a column of every attribute type included" in {
    AttributeType.values.foreach { kind =>
      withClue(s"$kind: ") {
        val op = withPorts(operator("op"), outputs = Seq(OutputPort() -> schemaOf("c" -> kind)))
        val read = PhysicalPlanCodec
          .decode(
            PhysicalPlanCodec.fromJson(
              assertRoundTrips(contextOf(), planOf(Seq(op), Nil))
            )
          )
          .plan
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
    val valid = save(contextOf(), planOf(Seq(op), Nil))
    val read = named.map { kind =>
      val plan = PhysicalPlanCodec
        .decode(
          valid.update(_.operators(0).outputPorts(0).schema.attributes(0).attributeType := kind)
        )
        .plan
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
      contextOf(WorkflowSettings(400, ExecutionMode.PIPELINED, stored.take(2).toSet), Some("w")),
      // more stored ports than a small set holds, so they iterate in hash order
      contextOf(WorkflowSettings(400, ExecutionMode.MATERIALIZED, stored.toSet))
    ).foreach { context =>
      withClue(s"${context.workflowSettings}, ${context.warehouse}: ") {
        assertRoundTrips(context, planOf(Seq(op), Nil, context.warehouse))
      }
    }
    // a warehouse named by an empty string is still one, though no port can be stored in it
    assertRoundTrips(contextOf(warehouse = Some("")), planOf(Seq(operator("op")), Nil))
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
    val read = PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(json))
    assert(read.plan.getOperator(op.id).inputPorts.keys.toList == inputOrder)
    assert(read.plan.getOperator(op.id).outputPorts.keys.toList == outputOrder)
    assert(read.context.workflowSettings.outputPortsNeedingStorage.toList == stored)
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
    // Saved once, in the order the union's port lists them.
    assert(save(contextOf(), plan).links == Seq(fromC, fromA, fromB))
    val read = PhysicalPlanCodec.decode(save(contextOf(), plan)).plan
    assert(read.getOperator(union.id).inputPorts(PortIdentity())._2 == List(fromC, fromA, fromB))
  }

  it should "save links in the order of their ends where the ports leave their order open" in {
    // Two sources, each read by two sinks: a port lists two links, and no port all four.
    val Seq(s1, s2) =
      Seq("s1", "s2").map(name => withPorts(operator(name), outputs = Seq(OutputPort() -> keyed)))
    val Seq(t1, t2) =
      Seq("t1", "t2").map(name => withPorts(operator(name), inputs = Seq(InputPort() -> keyed)))
    // Each port lists its links as this does: every link of s2 before s1's, and into t2 first.
    val links = Seq(link(s2, t2), link(s1, t2), link(s2, t1), link(s1, t1))
    val plan = planOf(Seq(t2, s2, t1, s1), links)
    // The ports leave open only which of s1 -> t2 and s2 -> t1 comes first: the lesser does.
    assert(save(contextOf(), plan).links == links)
    assertRoundTrips(contextOf(), plan)
    // With every port listing its links in the order of their ends, that is the order saved.
    val sorted = Seq(link(s1, t1), link(s1, t2), link(s2, t1), link(s2, t2))
    assert(save(contextOf(), planOf(Seq(t2, s2, t1, s1), sorted)).links == sorted)

    // Links no port lists together are in the order of their ends alone: by the operator they
    // leave, then by its port, where 2 comes before 10 and an internal port after the port of
    // its number.
    val ports = Seq(PortIdentity(10), PortIdentity(2, internal = true), PortIdentity(2))
    val fan = withPorts(operator("fan"), outputs = ports.map(port => OutputPort(port) -> keyed))
    val sink = withPorts(
      operator("sink"),
      inputs = ports.indices.map(index => InputPort(PortIdentity(index)) -> keyed)
    )
    val Seq(from10, fromInternal2, from2) = ports.zipWithIndex.map {
      case (port, index) => PhysicalLink(fan.id, port, sink.id, PortIdentity(index))
    }
    val fanned = planOf(Seq(fan, sink, s1, t1), Seq(link(s1, t1), from10, fromInternal2, from2))
    assert(save(contextOf(), fanned).links == Seq(from2, fromInternal2, from10, link(s1, t1)))
    assertRoundTrips(contextOf(), fanned)
  }

  it should "refuse to save a plan whose ports list their links in orders that no one order gives" in {
    val Seq(s1, s2) =
      Seq("s1", "s2").map(name => withPorts(operator(name), outputs = Seq(OutputPort() -> keyed)))
    val Seq(t1, t2) =
      Seq("t1", "t2").map(name => withPorts(operator(name), inputs = Seq(InputPort() -> keyed)))
    def listing(op: PhysicalOp, links: PhysicalLink*): PhysicalOp =
      if (op.inputPorts.isEmpty) {
        op.copy(outputPorts = Map(PortIdentity() -> (OutputPort(), links.toList, Right(keyed))))
      } else op.copy(inputPorts = Map(PortIdentity() -> (InputPort(), links.toList, Right(keyed))))
    // Each port lists the link the next one lists first, last: round in a circle.
    val plan = PhysicalPlan(
      Set(
        listing(s1, link(s1, t1), link(s1, t2)),
        listing(t2, link(s1, t2), link(s2, t2)),
        listing(s2, link(s2, t2), link(s2, t1)),
        listing(t1, link(s2, t1), link(s1, t1))
      ),
      Set(link(s1, t1), link(s1, t2), link(s2, t1), link(s2, t2))
    )
    assertRefused(save(contextOf(), plan))(
      "The plan's ports list their links in orders that no one order of the links gives",
      "s1-main[0] -> t1-main[0]"
    )
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

  it should "save operators in the order of their ids, however many, the same text every time" in {
    // Each copy of an operator gets a function of its own, as each compile gives it, so two sets
    // of more than four hash their operators apart and need not iterate them in one order.
    def propagation(): SchemaPropagationFunc = {
      val token = new Object
      SchemaPropagationFunc(schemas => { token.hashCode; schemas })
    }
    def chain(names: Seq[String]): PhysicalPlan = {
      val ops = names.map(name =>
        withPorts(
          operator(name).withPropagateSchema(propagation()),
          inputs = Seq(InputPort() -> keyed),
          outputs = Seq(OutputPort() -> keyed)
        )
      )
      planOf(ops, ops.sliding(2).map { case Seq(from, to) => link(from, to) }.toSeq)
    }
    Seq(Seq("c", "a", "b"), Seq("e", "b", "f", "a", "d", "c")).foreach { names =>
      withClue(s"${names.size} operators: ") {
        val stored = save(contextOf(), chain(names))
        assert(stored.operators.flatMap(_.id).map(_.logicalOpId.id) == names.sorted)
        val texts = (1 to 5).map(_ => PhysicalPlanCodec.toJson(save(contextOf(), chain(names))))
        assert(texts.distinct.size == 1, "two saves of one plan give different text")
        assert(texts.head == PhysicalPlanCodec.toJson(stored))
      }
    }
    // Operators of one logical operator, by their layers.
    assert(
      save(fullContext, fullPlan).operators.flatMap(_.id) ==
        Seq(globalAgg.id, localAgg.id, scan.id, udf.id)
    )
  }

  it should "read back a plan whose operators cannot derive their schemas again" in {
    val read = PhysicalPlanCodec.decode(save(fullContext, fullPlan)).plan
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

  // ----- what a run needs besides its plan -----

  it should "save and read back a replay, a replay log and cost hints, each one alone or absent" in {
    val bare = ExecutionPlan(contextOf(warehouse = fullWarehouse), fullPlan)
    val withHints = ExecutionPlan(
      contextOf(warehouse = fullWarehouse, costHints = fullContext.costHints),
      fullPlan
    )
    Seq(
      "none of them" -> bare,
      "a replay" -> bare.copy(replay = Some(fullReplay)),
      "a replay log" -> bare.copy(replayLog = fullExecutionPlan.replayLog),
      "cost hints" -> withHints,
      "all of them" -> fullExecutionPlan
    ).foreach {
      case (what, plan) =>
        withClue(s"$what: ") {
          assertRoundTrips(plan)
        }
    }
  }

  it should "save and read back ten thousand files of one operator" in {
    // An operator's block holds every file the operator reads through a link, however many.
    val files = (1 to 10000).map { part =>
      val name = f"dataset:///ds-1/d4t4/part-$part%05d.csv"
      InputFile(name, linkTo(name), 1763856000000L + part)
    }
    val reading = operator("op").withInputs(OperatorInputs(files = files))

    assertRoundTrips(contextOf(), planOf(Seq(reading), Nil))
  }

  it should "save and read back cost hints that name no operator, and costs of 0 and of the largest finite number" in {
    Seq(Map.empty[String, Double], Map("udf" -> 0.0), Map("udf" -> Double.MaxValue)).foreach {
      seconds =>
        withClue(s"$seconds: ") {
          val hints = CostHints(ExecutionIdentity(Long.MaxValue), seconds)
          assertRoundTrips(
            ExecutionPlan(contextOf(warehouse = fullWarehouse, costHints = Some(hints)), fullPlan)
          )
        }
    }
  }

  it should "save and read back a replay and a replay log at URIs of any scheme, unicode included" in {
    Seq(
      "file:///tmp/logs/7/40/",
      "hdfs://namenode:8020/logs/7/40",
      "s3://bucket/r%C3%A9sum%C3%A9/7/40/",
      "file:///tmp/résumé/"
    ).foreach { location =>
      withClue(s"$location: ") {
        val uri = new URI(location)
        assertRoundTrips(
          ExecutionPlan(
            contextOf(warehouse = fullWarehouse),
            fullPlan,
            replay = Some(ReplaySource(ExecutionIdentity(1), uri, "ünï")),
            replayLog = Some(uri)
          )
        )
      }
    }
  }

  it should "save cost hints in the order of their operators' ids, the same text whatever order they come in" in {
    val stored = PhysicalPlanCodec.encode(fullExecutionPlan)
    assert(
      stored.getCostHints.operators.map(_.logicalOperatorId) ==
        Seq("agg", "removed-since", "scan", "udf")
    )
    val hints = fullContext.costHints.map(hints =>
      hints.copy(secondsByLogicalOperator = hints.secondsByLogicalOperator.toSeq.reverse.toMap)
    )
    val context = contextOf(fullContext.workflowSettings, fullContext.warehouse, hints)
    assert(
      PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(fullExecutionPlan.copy(context = context)))
        == PhysicalPlanCodec.toJson(stored)
    )
  }

  // ----- what a plan's text holds -----

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
        "plan's text leaves out, and why."
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
        "pythonEnvironment",
        "repositoryMounts",
        "inputs",
        "storageLocations"
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
      saved = Set("workflowId", "executionId", "workflowSettings", "warehouse", "costHints"),
      leftOut = Map.empty
    )
  }

  it should "save every field of what a run needs besides its plan, and of a change to an operator" in {
    val update = OperatorUpdate(executionId, udf.id, udf.opExecInitInfo, None, Some("ml"))
    Seq[(String, Product, Set[String])](
      ("ExecutionPlan", fullExecutionPlan, Set("context", "plan", "replay", "replayLog")),
      ("ReplaySource", fullReplay, Set("sourceExecutionId", "logLocation", "interaction")),
      (
        "CostHints",
        fullContext.costHints.get,
        Set("sourceExecutionId", "secondsByLogicalOperator")
      ),
      (
        "OperatorUpdate",
        update,
        Set("executionId", "opId", "opExecInitInfo", "repositoryMounts", "pythonEnvironment")
      )
    ).foreach {
      case (what, value, saved) =>
        assertAccountedFor(what, value.productElementNames.toSeq, saved, Map.empty)
    }
    // A change holds only what the engine changes in the running operator; the rest of it stays.
    val keptRunning = "the running operator's stays"
    assertAccountedFor(
      "PhysicalOp, in a change to it",
      operator("op").productElementNames.toSeq,
      saved = Set("id", "opExecInitInfo", "repositoryMounts", "pythonEnvironment"),
      leftOut = Map(
        "workflowId" -> keptRunning,
        "executionId" -> "the change's, saved once",
        "parallelizable" -> keptRunning,
        "locationPreference" -> keptRunning,
        "partitionRequirement" -> keptRunning,
        "outputPartitionRule" -> keptRunning,
        "inputPorts" -> keptRunning,
        "outputPorts" -> keptRunning,
        "propagateSchema" -> keptRunning,
        "isOneToManyOp" -> keptRunning,
        "requiresMaterializedExecution" -> keptRunning,
        "isLoopStart" -> keptRunning,
        "suggestedWorkerNum" -> keptRunning,
        "inputs" -> keptRunning,
        "storageLocations" -> keptRunning,
        "resourceBinding" -> "an operator made to run holds none, and saving one is refused"
      )
    )
  }

  // ----- the format, pinned -----

  // Two small plans, one for each execution mode, that use every name the format has between
  // them (a case below checks it): the first sets every field, the second none it may leave out.
  // And a change to an operator that sets every field. Their JSON is checked in: a change to
  // what the codec writes for them fails here, and a change to the format comes with a new
  // format version and golden files for it.

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
      .withLocationPreference(Some(PreferCoordinator))
      .withInputs(
        OperatorInputs(
          files = Seq(InputFile("dataset:///ds-1/d4t4/a.csv", linkTo("a"), 1763856000000L)),
          listing = Some(FileListing(Seq("/dataset/a@x.io/ds/v1/a.csv"))),
          csvParserMaxColumns = Some(512)
        )
      ),
    outputs = Seq(OutputPort(PortIdentity(0), "out") -> goldenRow)
  )
  private val goldenUdf = withPorts(
    operator("udf", executor = OpExecWithCode("yield tuple_", "python")).copy(
      locationPreference = Some(RoundRobinPreference),
      partitionRequirement = List(Some(HashPartition(List("id"))), None),
      outputPartitionRule = PartitionRule.Fixed(UnknownPartition()),
      suggestedWorkerNum = Some(2),
      pythonEnvironment = PythonEnvironmentRef.Resolved(
        PythonEnvironment("ml", Seq("numpy>=2.1.0", "tabulate==0.9.0"))
      ),
      repositoryMounts = Some(RepositoryMounts(Set("dataset-1:d4t4", "model-2:m0d3l")))
    ),
    inputs = Seq(
      InputPort(PortIdentity(0), "in") -> goldenRow,
      InputPort(PortIdentity(1, internal = true), dependencies = List(PortIdentity(0))) ->
        goldenRow
    ),
    outputs = Seq(OutputPort(PortIdentity(1), mode = OutputMode.SET_DELTA) -> goldenIds)
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
      link(goldenUdf, goldenJoin, fromPort = 1),
      link(goldenScan, goldenJoin, toPort = 1)
    ),
    warehouse = Some("wh-1")
  )
  private val goldenContext = contextOf(
    WorkflowSettings(
      400,
      ExecutionMode.PIPELINED,
      Set(
        GlobalPortIdentity(goldenJoin.id, PortIdentity(0)),
        GlobalPortIdentity(goldenUdf.id, PortIdentity(1))
      )
    ),
    warehouse = Some("wh-1"),
    costHints = Some(CostHints(ExecutionIdentity(41), Map("udf" -> 3.0, "join" -> 12.5)))
  )
  private val goldenExecutionPlan = ExecutionPlan(
    goldenContext,
    goldenPlan,
    replay = Some(
      ReplaySource(ExecutionIdentity(40), new URI("file:///var/texera/logs/7/40/"), "replay-to")
    ),
    replayLog = Some(new URI("file:///var/texera/logs/7/42/"))
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

  private val goldenPlans: Seq[(String, ExecutionPlan)] = Seq(
    "physical-plan-v1.json" -> goldenExecutionPlan,
    "physical-plan-v1-materialized.json" ->
      ExecutionPlan(goldenMaterializedContext, planOf(Seq(goldenSource), Nil))
  )

  // The first plan as the compile that made it hands it on, before its files are linked: its
  // scan's file where it is kept, and none of what the service that creates the execution adds.
  private val goldenUnlinkedFile = "physical-plan-v1-unlinked.json"
  private val goldenUnlinkedPlan = ExecutionPlan(
    contextOf(goldenContext.workflowSettings, goldenContext.warehouse),
    PhysicalPlan(
      goldenPlan.operators.map { op =>
        op.withInputs(op.inputs.copy(files = op.inputs.files.map { file =>
          InputFile(file.name, physicalAddress = "s3://texera-dataset/dataset-1/data/gdm5/a")
        }))
      },
      goldenPlan.links
    )
  )

  // The UDF's code changed while the run is paused; it reads the same datasets and models.
  private val goldenUpdateFile = "operator-update-v1.json"
  private val goldenChangedUdf =
    goldenUdf.copy(opExecInitInfo = OpExecWithCode("yield tuple_  # changed", "python"))
  private val goldenUpdate = OperatorUpdate(
    executionId,
    goldenUdf.id,
    goldenChangedUdf.opExecInitInfo,
    goldenUdf.repositoryMounts,
    Some("ml")
  )

  /** The golden file's text, with no newline at its end; empty if there is no such file. */
  private def golden(file: String): String =
    Option(getClass.getResourceAsStream(s"/storedplan/$file")).fold("") { stream =>
      try new String(stream.readAllBytes(), StandardCharsets.UTF_8).stripSuffix("\n")
      finally stream.close()
    }

  it should "write each golden plan and change exactly as its golden file has it" in {
    val written = goldenPlans.map {
      case (file, plan) => file -> PhysicalPlanCodec.toJson(PhysicalPlanCodec.encode(plan))
    } :+ goldenUnlinkedFile -> PhysicalPlanCodec.toJson(
      PhysicalPlanCodec.encodeUnlinked(goldenUnlinkedPlan)
    ) :+ goldenUpdateFile -> PhysicalPlanCodec.updateToJson(
      PhysicalPlanCodec.encodeUpdate(executionId, goldenChangedUdf)
    )
    val differing = written.flatMap {
      case (file, text) =>
        Option.when(text != golden(file)) {
          val actual = Files.createTempFile(file.stripSuffix(".json") + "-", ".json")
          Files.write(actual, (text + "\n").getBytes(StandardCharsets.UTF_8))
          s"$file (the codec writes $actual)"
        }
    }
    assert(
      differing.isEmpty,
      s"The codec no longer writes ${differing.mkString(", ")} as checked in. A change to the " +
        "format needs a new format version and golden files."
    )
  }

  it should "read each golden file back to its plan or change" in {
    goldenPlans.foreach {
      case (file, plan) =>
        withClue(s"$file: ") {
          assert(golden(file).nonEmpty, "the golden file is missing from the test resources")
          assertSameExecutionPlan(
            plan,
            PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(golden(file)))
          )
        }
    }
    withClue(s"$goldenUnlinkedFile: ") {
      assert(golden(goldenUnlinkedFile).nonEmpty, "the golden file is missing")
      assertSameExecutionPlan(
        goldenUnlinkedPlan,
        PhysicalPlanCodec.decodeUnlinked(PhysicalPlanCodec.fromJson(golden(goldenUnlinkedFile)))
      )
    }
    withClue(s"$goldenUpdateFile: ") {
      assert(golden(goldenUpdateFile).nonEmpty, "the golden file is missing")
      assert(
        PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(golden(goldenUpdateFile)))
          == goldenUpdate
      )
    }
  }

  it should "use every field, oneof case and enum value of the format in its golden files" in {
    val text = (goldenPlans.map(_._1) :+ goldenUnlinkedFile :+ goldenUpdateFile)
      .map(golden)
      .mkString("\n")
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
    walk(StoredOperatorUpdate.scalaDescriptor)
    assert(fields.contains("opExecWithCode") && values.contains("SINGLE_SNAPSHOT"))
    assert(fields.contains("expiresAtMs") && fields.contains("pythonEnvironment"))
    // What no plan writes, as a value at its default is left out: a port whose results are
    // stored is an output port, never an input, and SET_SNAPSHOT is the first value of an enum
    // the format reuses.
    val neverWritten = Set("input", "SET_SNAPSHOT")
    assert(neverWritten.subsetOf(fields ++ values))

    val unused = (fields.toSeq.filterNot(name => text.contains(s""""$name": """)) ++
      values.toSeq.filterNot(name => text.contains(s""""$name""""))).filterNot(neverWritten)
    assert(
      unused.isEmpty,
      s"No golden file uses ${unused.mkString(", ")}, so nothing checks what the format writes " +
        "for it. Use each in a golden plan."
    )
    // A field of a change that a plan has too, such as opId, is used by the change's own file.
    val updateFields = parse(golden(goldenUpdateFile)) match {
      case JObject(fields) => fields.map(_._1).toSet
      case other           => fail(s"$goldenUpdateFile is not a JSON object: $other")
    }
    assert(updateFields == StoredOperatorUpdate.scalaDescriptor.fields.map(_.name).toSet)
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
    val binding: ResourceBinding = _ => fail("saving a plan must not bind anything")
    assertRefused(
      save(fullContext, fullPlanWithUdf(_.withResourceBinding(Some(binding))))
    )("udf-main", "never resolved")
  }

  it should "refuse to save an operator that names a Python environment no plan resolved" in {
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf(_.withPythonEnvironment(PythonEnvironmentRef.Named("ml")))
      )
    )(
      "Operator udf-main names the Python environment 'ml', which was never resolved: only a " +
        "plan made to run can be saved."
    )
  }

  it should "refuse to save an operator of another workflow or execution" in {
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf(_.copy(workflowId = WorkflowIdentity(8)))
      )
    )("udf-main", "workflow 8", "workflow 7")
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf(_.copy(executionId = ExecutionIdentity(1)))
      )
    )("udf-main", "execution 1", "execution 42")
  }

  it should "refuse to save a port with no schema" in {
    val missing = Left(new SchemaNotAvailableException("schema is not available"))
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf { op =>
          val (port, links, _) = op.inputPorts(PortIdentity(1))
          op.copy(inputPorts = op.inputPorts + (PortIdentity(1) -> (port, links, missing)))
        }
      )
    )("input port 1", "udf-main", "no schema", "schema is not available")
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf { op =>
          val (port, links, _) = op.outputPorts(PortIdentity(0))
          op.copy(outputPorts = op.outputPorts + (PortIdentity(0) -> (port, links, missing)))
        }
      )
    )("output port 0", "udf-main", "no schema")
  }

  it should "refuse to save an output port with no storage location, or one that is not its own in the plan's execution and warehouse" in {
    def storedAt(location: String)(op: PhysicalOp): PhysicalOp =
      op.copy(storageLocations = Map(PortIdentity(0) -> new URI(location)))
    assertRefused(
      save(fullContext, fullPlanWithUdf(_.copy(storageLocations = Map.empty)))
    )("output port 0 of operator udf-main has no storage location", "made to run")
    // the plan's own location for the port, in each case below with one part of it changed
    val own = fullPlan.getOperator(udf.id).storageLocation(PortIdentity(0)).toString
    assert(
      own == "vfs:///wh/lake-wh/wid/7/eid/42/globalportid/" +
        "(logicalOpId=udf,layerName=main,portId=0,isInternal=false,isInput=false)"
    )
    Seq(
      "another workflow's" -> own.replace("/wid/7/", "/wid/8/"),
      "another execution's" -> own.replace("/eid/42/", "/eid/41/"),
      "another warehouse's" -> own.replace("/wh/lake-wh/", "/wh/other-wh/"),
      "the default warehouse's" -> own.replace("/wh/lake-wh", ""),
      "another operator's" -> own.replace("logicalOpId=udf", "logicalOpId=scan"),
      "another port's" -> own.replace("portId=0", "portId=1"),
      "an input port's" -> own.replace("isInput=false", "isInput=true")
    ).foreach {
      case (whose, location) =>
        withClue(s"$whose: ") {
          assertRefused(save(fullContext, fullPlanWithUdf(storedAt(location))))(
            s"output port 0 of operator udf-main is stored at '$location'",
            "not that port's location in execution 42 of workflow 7, in warehouse 'lake-wh'"
          )
        }
    }
    Seq(
      "file:///tmp/udf/0",
      "vfs:udf",
      "vfs:///wid/seven/eid/42/globalportid/x",
      own.replace("/eid/42", "")
    ).foreach { location =>
      withClue(s"$location: ") {
        assertRefused(save(fullContext, fullPlanWithUdf(storedAt(location))))(
          s"is stored at '$location', which is not the location of a port"
        )
      }
    }
    // A location that names the port, with more to its path, is still the port's.
    assertRoundTrips(
      fullContext,
      fullPlanWithUdf(storedAt(own.replace("/wid/7/", "/results/wid/7/")))
    )
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf(op =>
          op.copy(storageLocations = op.storageLocations + (PortIdentity(3) -> new URI(own)))
        )
      )
    )("udf-main has a storage location for its output port 3, which it does not have")
  }

  it should "refuse to save an operator with no executor, or a port under another id" in {
    assertRefused(
      save(
        fullContext,
        fullPlanWithUdf(_.copy(opExecInitInfo = OpExecInitInfo.Empty))
      )
    )("udf-main", "no executor")
    assertRefused(
      save(
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
      save(fullContext, fullPlan.copy(links = fullPlan.links + ghost))
    )("udf-main[0] -> ghost-main[0]", "names operator ghost-main")
    val unlisted = fullPlanWithUdf { op =>
      val (port, _, schema) = op.inputPorts(PortIdentity(1))
      op.copy(inputPorts = op.inputPorts + (PortIdentity(1) -> (port, Nil, schema)))
    }
    assertRefused(save(fullContext, unlisted))(
      "The input port 1 of operator udf-main lists its links as [], but the plan's links that " +
        "join it are [scan-main[0] -> udf-main[1]]."
    )
    // listed twice, on a port it does not join, and though it is none of the plan's
    val scanToUdf1 = link(scan, udf, toPort = 1)
    def listingOnUdf(port: Int, links: PhysicalLink*) =
      fullPlanWithUdf { op =>
        val (inputPort, _, schema) = op.inputPorts(PortIdentity(port))
        op.copy(inputPorts =
          op.inputPorts + (PortIdentity(port) -> (inputPort, links.toList, schema))
        )
      }
    assertRefused(save(fullContext, listingOnUdf(1, scanToUdf1, scanToUdf1)))(
      "input port 1 of operator udf-main lists its links as [scan-main[0] -> udf-main[1], " +
        "scan-main[0] -> udf-main[1]]"
    )
    assertRefused(save(fullContext, listingOnUdf(0, link(scan, udf), scanToUdf1)))(
      "input port 0 of operator udf-main lists its links as [scan-main[0] -> udf-main[0], " +
        "scan-main[0] -> udf-main[1]], but the plan's links that join it are " +
        "[scan-main[0] -> udf-main[0]]."
    )
    assertRefused(save(fullContext, fullPlan.copy(links = fullPlan.links - scanToUdf1)))(
      "output port 0 of operator scan-main lists its links as [scan-main[0] -> udf-main[0], " +
        "scan-main[0] -> udf-main[1]], but the plan's links that join it are " +
        "[scan-main[0] -> udf-main[0]]."
    )
    val twin = fullPlan.operators.find(_.id == udf.id).get.withSuggestedWorkerNum(9)
    assertRefused(
      save(fullContext, fullPlan.copy(operators = fullPlan.operators + twin))
    )("2 operators udf-main")
  }

  it should "refuse to save a plan whose links form a cycle" in {
    val back = PhysicalLink(globalAgg.id, PortIdentity(0), udf.id, PortIdentity(1))
    assertRefused(
      save(
        fullContext,
        planOf(Seq(scan, udf, localAgg, globalAgg), fullLinks :+ back, fullWarehouse)
      )
    )("closes a cycle")
  }

  it should "refuse to save an input port that depends on a port its operator does not have" in {
    assertRefused(
      save(fullContext, fullPlanWithUdf(dependingOn(PortIdentity(7))))
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
      ),
      fullWarehouse
    )
    assertRefused(save(context, fullPlan))("output port 4 of operator udf-main")
  }

  it should "refuse to save settings that send batches of no tuple" in {
    Seq(0, -5).foreach { size =>
      assertRefused(
        save(
          contextOf(WorkflowSettings(size, ExecutionMode.PIPELINED)),
          planOf(Seq(operator("op")), Nil)
        )
      )(s"batch size is $size")
    }
  }

  /** `fullExecutionPlan` with its context's cost hints replaced. */
  private def hinting(hints: CostHints): ExecutionPlan =
    fullExecutionPlan.copy(context =
      contextOf(fullContext.workflowSettings, fullContext.warehouse, Some(hints))
    )

  it should "refuse to save a replay of no execution, from a log at no absolute URI, or up to no interaction" in {
    def replaying(replay: ReplaySource) =
      PhysicalPlanCodec.encode(fullExecutionPlan.copy(replay = Some(replay)))
    Seq(0L, -1L, Long.MinValue).foreach { id =>
      assertRefused(replaying(fullReplay.copy(sourceExecutionId = ExecutionIdentity(id))))(
        s"replays the log of execution $id, but an execution's id is at least 1"
      )
    }
    Seq("logs/7/40", "/var/texera/logs/7/40/", "").foreach { location =>
      assertRefused(replaying(fullReplay.copy(logLocation = new URI(location))))(
        s"replays the log of execution 40 at '$location', which is not an absolute URI"
      )
    }
    Seq("", " \t\n").foreach { interaction =>
      assertRefused(replaying(fullReplay.copy(interaction = interaction)))(
        "replays the log of execution 40 up to an interaction it does not name"
      )
    }
  }

  it should "refuse to save a replay log at no absolute URI" in {
    Seq("logs/7/42", "/var/texera/logs/7/42/").foreach { location =>
      assertRefused(
        PhysicalPlanCodec.encode(fullExecutionPlan.copy(replayLog = Some(new URI(location))))
      )(s"writes its replay log to '$location', which is not an absolute URI")
    }
  }

  it should "refuse to save cost hints of no execution, of an operator with no id, or that give a cost that is not a finite number of seconds, at least 0" in {
    val hints = fullContext.costHints.get
    Seq(0L, -7L).foreach { id =>
      assertRefused(
        PhysicalPlanCodec.encode(hinting(hints.copy(sourceExecutionId = ExecutionIdentity(id))))
      )(s"cost hints come from execution $id, but an execution's id is at least 1")
    }
    Seq(Double.NaN, Double.PositiveInfinity, Double.NegativeInfinity, -1e-9, -5.0).foreach {
      seconds =>
        assertRefused(
          PhysicalPlanCodec.encode(
            hinting(
              hints.copy(secondsByLogicalOperator =
                hints.secondsByLogicalOperator + ("udf" -> seconds)
              )
            )
          )
        )(
          s"give operator udf $seconds seconds",
          "a cost is a finite number of seconds, at least 0"
        )
    }
    assertRefused(
      PhysicalPlanCodec.encode(
        hinting(hints.copy(secondsByLogicalOperator = Map("" -> 1.0)))
      )
    )("cost hints name an operator with no id")
  }

  it should "refuse to save a file with no name or no link, given twice or out of the order of the names, or whose link expires at the epoch or before; and a column limit below 1" in {
    val file = scanInputs.files.head
    def reading(files: InputFile*) =
      save(fullContext, fullPlanWithUdf(_.withInputs(OperatorInputs(files = files))))
    assertRefused(reading(file.copy(name = "")))("A file operator udf-main reads has no name")
    assertRefused(reading(file.copy(url = "")))(
      s"Operator udf-main has no link to its file ${file.name}"
    )
    // the same name, wherever its link leads and whenever it expires
    assertRefused(reading(file, file.copy(url = linkTo("b"), expiresAtMs = 5L)))(
      s"The file ${file.name} of operator udf-main appears twice"
    )
    assertRefused(reading(file.copy(name = "b"), file.copy(name = "a")))(
      "The files operator udf-main reads are not in the order of their names: file b comes " +
        "before file a."
    )
    Seq(0L, -1L).foreach { expiresAtMs =>
      assertRefused(reading(file.copy(expiresAtMs = expiresAtMs)))(
        s"The link to the file ${file.name} of operator udf-main expires at $expiresAtMs ms " +
          "since the epoch, which is not after it"
      )
    }
    Seq(0, -3).foreach { limit =>
      assertRefused(
        save(
          fullContext,
          fullPlanWithUdf(_.withInputs(OperatorInputs(csvParserMaxColumns = Some(limit))))
        )
      )(s"Operator udf-main reads CSV files of at most $limit columns, but a row has at least 1")
    }
  }

  // ----- what it refuses to read -----

  private val valid: StoredPhysicalPlan = PhysicalPlanCodec.encode(fullExecutionPlan)

  private def indexOf(id: PhysicalOpIdentity): Int = valid.operators.indexWhere(_.id.contains(id))

  /** `valid` with the saved operator `id` replaced by `f` of it. */
  private def withStoredOp(id: PhysicalOpIdentity)(f: StoredPhysicalOp => StoredPhysicalOp) =
    valid.copy(operators = valid.operators.updated(indexOf(id), f(valid.operators(indexOf(id)))))

  private def assertUnreadable(stored: StoredPhysicalPlan)(expected: String*): Unit =
    assertRefused(PhysicalPlanCodec.decode(stored))(expected: _*)

  it should "read the plan it refuses nothing in" in {
    assertSameExecutionPlan(fullExecutionPlan, PhysicalPlanCodec.decode(valid))
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

  it should "refuse an output port with no storage location, or one that is not its own in the plan's execution and warehouse" in {
    def storedAt(location: String) =
      withStoredOp(udf.id)(_.update(_.outputPorts(0).storageLocation := location))
    val own = valid.operators(indexOf(udf.id)).outputPorts(0).storageLocation
    assertUnreadable(storedAt(""))("output port 0 of operator udf-main has no storage location")
    assertUnreadable(storedAt("vfs:///wid/7/eid/42/a b"))(
      "output port 0 of operator udf-main is stored at 'vfs:///wid/7/eid/42/a b'",
      "which is not a URI"
    )
    assertUnreadable(storedAt("s3://bucket/udf/0"))(
      "is stored at 's3://bucket/udf/0', which is not the location of a port"
    )
    Seq(
      own.replace("/eid/42/", "/eid/43/"),
      own.replace("/wh/lake-wh/", "/wh/user-9-1/"),
      own.replace("layerName=main", "layerName=other")
    ).foreach { location =>
      withClue(s"$location: ") {
        assertUnreadable(storedAt(location))(
          s"is stored at '$location'",
          "not that port's location in execution 42 of workflow 7, in warehouse 'lake-wh'"
        )
      }
    }
    // Every port of the plan is stored in the plan's warehouse: named by none, it is the
    // shared one, where none of this plan's ports is.
    assertUnreadable(valid.copy(warehouse = None))(
      "not that port's location in execution 42 of workflow 7."
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

  it should "list on each port read back the plan's links that join it, in the order saved" in {
    val Seq(toPort0, toPort1) = Seq(link(scan, udf), link(scan, udf, toPort = 1))
    def scanLinksOf(stored: StoredPhysicalPlan): List[PhysicalLink] =
      PhysicalPlanCodec.decode(stored).plan.getOperator(scan.id).outputPorts(PortIdentity())._2
    assert(valid.links.filter(_.fromOpId == scan.id) == Seq(toPort0, toPort1))
    assert(scanLinksOf(valid) == List(toPort0, toPort1))
    assert(
      scanLinksOf(valid.copy(links = toPort1 +: valid.links.filterNot(_ == toPort1))) ==
        List(toPort1, toPort0)
    )
    // A link left out is on neither port it joined.
    val without = PhysicalPlanCodec.decode(valid.copy(links = valid.links.filterNot(_ == toPort1)))
    assert(without.plan.getOperator(scan.id).outputPorts(PortIdentity())._2 == List(toPort0))
    assert(without.plan.getOperator(udf.id).inputPorts(PortIdentity(1))._2.isEmpty)
  }

  it should "refuse links that form a cycle, a link from an operator to itself included" in {
    assertUnreadable(
      valid.addLinks(PhysicalLink(udf.id, PortIdentity(0), udf.id, PortIdentity(0)))
    )(
      "Link udf-main[0] -> udf-main[0] closes a cycle"
    )
    // udf -> localAgg -> globalAgg -> udf
    assertUnreadable(
      valid.addLinks(PhysicalLink(globalAgg.id, PortIdentity(0), udf.id, PortIdentity(1)))
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
      withStoredOp(udf.id)(_.update(_.repositoryMounts :+= "dataset-1:d4t4"))
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

  it should "refuse mounts that RepositoryMounts refuses, and read an operator that names none as mounting none" in {
    Seq("no-commit", "../..:d4t4", "dataset-1:../etc").foreach { locator =>
      assertUnreadable(withStoredOp(udf.id)(_.update(_.repositoryMounts := Seq(locator))))(
        "udf-main cannot mount",
        s"Invalid mount locator '$locator'"
      )
    }
    val none = PhysicalPlanCodec.decode(withStoredOp(udf.id)(_.update(_.repositoryMounts := Nil)))
    assert(none.plan.getOperator(udf.id).repositoryMounts.isEmpty)
  }

  it should "refuse a Python environment pip may not read" in {
    def environment(f: StoredPythonEnvironment => StoredPythonEnvironment): StoredPhysicalPlan =
      withStoredOp(udf.id)(op => op.withPythonEnvironment(f(op.getPythonEnvironment)))
    // What a line may not be, each an option, a URL or more than one bound to pip.
    Seq(
      "--index-url=https://example.com/simple",
      "-r /etc/passwd",
      "pkg @ https://example.com/pkg.whl",
      "pkg[extra]",
      "pkg>=1,<2",
      ""
    ).foreach { line =>
      withClue(s"[$line]: ") {
        assertUnreadable(environment(_.withRequirements(Seq(line))))(
          "Operator udf-main cannot run in the environment it names: Python environment " +
            "'ml ünï' cannot be installed: "
        )
      }
    }
    assertUnreadable(environment(_.withRequirements(Seq("Tabulate==0.9.0"))))(
      "udf-main cannot run in the environment it names",
      "is not in canonical form; expected \"tabulate==0.9.0\""
    )
    assertUnreadable(environment(_.withRequirements(Seq("tabulate==0.9.0", "numpy>=2.1.0"))))(
      "udf-main cannot run in the environment it names",
      "are not sorted, each once: tabulate==0.9.0, numpy>=2.1.0"
    )
    assertUnreadable(environment(_.withRequirements(Seq("numpy>=2.1.0", "numpy>=2.1.0"))))(
      "are not sorted, each once: numpy>=2.1.0, numpy>=2.1.0"
    )
    assertUnreadable(environment(_.withName(" ")))(
      "udf-main cannot run in the environment it names: A Python environment needs a name."
    )
    // The digest a unit installs an environment under is the one its lines have.
    val read = PhysicalPlanCodec
      .decode(environment(_.withRequirements(Seq("tabulate==0.9.0"))))
      .plan
      .getOperator(udf.id)
      .pythonEnvironment
    assert(
      read == PythonEnvironmentRef.Resolved(PythonEnvironment("ml ünï", Seq("tabulate==0.9.0")))
    )
  }

  it should "refuse a replay of no execution, from a log at no absolute URI, or up to no interaction" in {
    assertUnreadable(valid.update(_.replay.sourceExecutionId := 0L))(
      "replays the log of execution 0, but an execution's id is at least 1"
    )
    Seq("logs/7/40", "/var/texera/logs/7/40/", "").foreach { location =>
      assertUnreadable(valid.update(_.replay.logLocation := location))(
        s"replays the log of execution 40 at '$location', which is not an absolute URI"
      )
    }
    assertUnreadable(valid.update(_.replay.logLocation := "file:///var/texera logs/"))(
      "replays the log of execution 40 at 'file:///var/texera logs/', which is not a URI"
    )
    Seq("", "  ").foreach { interaction =>
      assertUnreadable(valid.update(_.replay.interaction := interaction))(
        "up to an interaction it does not name"
      )
    }
  }

  it should "refuse a replay log at no absolute URI" in {
    assertUnreadable(valid.update(_.replayLogLocation := "logs/7/42"))(
      "writes its replay log to 'logs/7/42', which is not an absolute URI"
    )
    assertUnreadable(valid.update(_.replayLogLocation := ""))(
      "writes its replay log to '', which is not an absolute URI"
    )
    assertUnreadable(valid.update(_.replayLogLocation := "hdfs://name node/logs"))(
      "writes its replay log to 'hdfs://name node/logs', which is not a URI"
    )
  }

  it should "refuse cost hints of no execution, out of order, naming an operator twice or with no id, or that give a cost that is not a finite number of seconds, at least 0" in {
    val costs = valid.getCostHints.operators
    assert(costs.map(_.logicalOperatorId) == Seq("agg", "removed-since", "scan", "udf"))
    assertUnreadable(valid.update(_.costHints.sourceExecutionId := -1L))(
      "cost hints come from execution -1, but an execution's id is at least 1"
    )
    assertUnreadable(valid.update(_.costHints.operators := costs.reverse))(
      "The plan's cost hints are not in the order of their operators' ids: operator udf comes " +
        "before operator scan."
    )
    assertUnreadable(valid.update(_.costHints.operators :+= costs.head.withSeconds(2.0)))(
      "The cost of operator agg appears twice"
    )
    assertUnreadable(valid.update(_.costHints.operators(0).logicalOperatorId := ""))(
      "cost hints name an operator with no id"
    )
    Seq(Double.NaN, Double.PositiveInfinity, Double.NegativeInfinity, -0.25).foreach { seconds =>
      assertUnreadable(valid.update(_.costHints.operators(2).seconds := seconds))(
        s"give operator scan $seconds seconds, but a cost is a finite number of seconds, at least 0"
      )
    }
  }

  it should "refuse a file with no name or no link, given twice or out of the order of the names, or whose link expires at the epoch or before; and a column limit below 1" in {
    def reading(edit: OperatorInputs => OperatorInputs) =
      withStoredOp(scan.id)(_.update(_.inputs.modify(edit)))
    val files = valid.operators(indexOf(scan.id)).getInputs.files
    assert(
      files.map(_.name) == Seq("dataset:///ds-1/d4t4/a.csv", "dataset:///ds-1/d4t4/résumé.csv")
    )
    assertUnreadable(reading(_.update(_.files(0).name := "")))(
      "A file operator scan-main reads has no name"
    )
    assertUnreadable(reading(_.update(_.files(1).url := "")))(
      "Operator scan-main has no link to its file dataset:///ds-1/d4t4/résumé.csv"
    )
    assertUnreadable(reading(_.withFiles(files :+ files.last)))(
      "The file dataset:///ds-1/d4t4/résumé.csv of operator scan-main appears twice"
    )
    assertUnreadable(reading(_.withFiles(files.reverse)))(
      "The files operator scan-main reads are not in the order of their names: file " +
        "dataset:///ds-1/d4t4/résumé.csv comes before file dataset:///ds-1/d4t4/a.csv."
    )
    Seq(0L, Long.MinValue).foreach { expiresAtMs =>
      assertUnreadable(reading(_.update(_.files(0).expiresAtMs := expiresAtMs)))(
        s"The link to the file dataset:///ds-1/d4t4/a.csv of operator scan-main expires at " +
          s"$expiresAtMs ms since the epoch, which is not after it"
      )
    }
    assertUnreadable(reading(_.withCsvParserMaxColumns(0)))(
      "Operator scan-main reads CSV files of at most 0 columns, but a row has at least 1"
    )
    // An operator that reads nothing has no inputs: saved with empty ones, it reads none.
    val empty = PhysicalPlanCodec.decode(withStoredOp(udf.id)(_.withInputs(OperatorInputs())))
    assert(empty.plan.getOperator(udf.id).inputs == OperatorInputs.defaultInstance)
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

  it should "write each field but one at its default" in {
    val written = compact(parse(validJson))
    Seq(
      "\"formatVersion\":1",
      // port 0 of an operator is the default of a port's id, and is left out
      "{\"fromOpId\":{\"logicalOpId\":{\"id\":\"scan\"},\"layerName\":\"main\"}," +
        "\"toOpId\":{\"logicalOpId\":{\"id\":\"udf\"},\"layerName\":\"main\"}}",
      "\"toPortId\":{\"id\":1}",
      "\"port\":{\"id\":{\"id\":1},\"displayName\":\"right\",\"dependencies\":[{}]}",
      "\"port\":{\"blocking\":true,\"mode\":\"SET_DELTA\"}",
      // "no requirement" is written out, not left as an empty entry
      "{\"noRequirement\":{}}",
      "\"isLoopStart\":true",
      "\"warehouse\":\"lake-wh\"",
      "\"suggestedWorkerNum\":3",
      "\"repositoryMounts\":[\"dataset-1:d4t4\",\"model-1:m0d3l\"]",
      "\"pythonEnvironment\":{\"name\":\"ml ünï\",\"requirements\":[\"numpy>=2.1.0\"," +
        "\"tabulate==0.9.0\",\"typing-extensions\"]}",
      "\"replay\":{\"sourceExecutionId\":\"40\",\"logLocation\":\"file:///var/texera/logs/7/40/\"," +
        "\"interaction\":\"interaction-3\"}",
      "\"replayLogLocation\":\"hdfs://namenode:8020/texera/logs/7/42/\"",
      "\"costHints\":{\"sourceExecutionId\":\"41\",\"operators\":[{\"logicalOperatorId\":\"agg\"," +
        "\"seconds\":0.001},",
      // a cost of 0 is a cost at its default
      "{\"logicalOperatorId\":\"scan\"}",
      "\"inputs\":{\"files\":[{\"name\":\"a\",\"url\":\"http://texera-rustfs:9000/" +
        "texera-dataset/a?X-Amz-Signature=5ecr3t\",\"expiresAtMs\":\"1\"}]}",
      "\"listing\":{\"files\":[\"/dataset/a@x.io/ds/v1/b.txt\",\"/dataset/a@x.io/ds/v1/a.txt\"]}," +
        "\"csvParserMaxColumns\":731}"
    ).foreach(field => assert(written.contains(field), s"[$field] is not in $written"))
    // A plan with nothing but one operator names only what is not a default.
    val noneOfThem = PhysicalPlanCodec.toJson(
      save(contextOf(), planOf(Seq(operator("op")), Nil))
    )
    assert(
      compact(parse(noneOfThem)) == "{\"formatVersion\":1,\"workflowId\":{\"id\":\"7\"}," +
        "\"executionId\":{\"id\":\"42\"},\"settings\":{\"dataTransferBatchSize\":400," +
        "\"executionMode\":\"PIPELINED\"},\"operators\":[{\"id\":{\"logicalOpId\":{\"id\":\"op\"}," +
        "\"layerName\":\"main\"},\"opExecInitInfo\":{\"opExecWithClassName\":{\"className\":" +
        "\"org.example.ExampleOpExec\",\"descString\":\"{}\"}},\"parallelizable\":true," +
        "\"locationPreference\":\"NO_PREFERENCE\",\"outputPartitionRule\":{\"firstInput\":{}}}]}"
    )
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

  it should "read a plan of the most bytes a plan may be, nearly all of them one string" in {
    // A scan's descriptor holds a link to each file the scan reads, and is one JSON string.
    def scanning(descriptor: String): StoredPhysicalPlan =
      withStoredOp(scan.id)(_.withOpExecInitInfo(OpExecWithClassName("Scan", descriptor)))
    def bytesOf(stored: StoredPhysicalPlan): Int =
      PhysicalPlanCodec.toJson(stored).getBytes(StandardCharsets.UTF_8).length
    val largest =
      scanning("x" * (PhysicalPlanCodec.MaxPlanBytes - bytesOf(scanning("x")) + 1))
    assert(bytesOf(largest) == PhysicalPlanCodec.MaxPlanBytes)

    assert(PhysicalPlanCodec.fromJson(PhysicalPlanCodec.toJson(largest)) == largest)
  }

  it should "refuse JSON with a field the format does not have, at any depth" in {
    assertRefused(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("isLoopStart", flag) => Some("isLoopStarts" -> flag)
    }))("isLoopStarts")
    assertRefused(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("requirements", lines) => Some("packages" -> lines)
    }))("packages")
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
    val repeated = validJson.replaceFirst(
      "\"isLoopStart\": true",
      "\"isLoopStart\": true, \"isLoopStart\": false"
    )
    assert(repeated != validJson)
    assertRefused(PhysicalPlanCodec.fromJson(repeated))("not JSON", "Duplicate field 'isLoopStart'")
    // the version too, which is read before anything else
    assertRefused(PhysicalPlanCodec.fromJson("{\"formatVersion\": 1, " + validJson.drop(1)))(
      "Duplicate field 'formatVersion'"
    )
  }

  it should "refuse JSON in another format version before looking at its fields" in {
    val laterVersion = editedJson(validJson) {
      case ("formatVersion", _)  => Some("formatVersion" -> JInt(2))
      case ("isLoopStart", flag) => Some("aFieldOfVersion2" -> flag)
    }
    assert(
      refusal(PhysicalPlanCodec.fromJson(laterVersion)) ==
        "The plan is in format version 2, but this reader reads version 1."
    )
    Seq(JInt(0) -> "0", JString("1") -> "\"1\"", JDouble(1.0) -> "1.0").foreach {
      case (version, written) =>
        val json = editedJson(validJson) {
          case ("formatVersion", _) => Some("formatVersion" -> version)
        }
        assertRefused(PhysicalPlanCodec.fromJson(json))(
          s"The plan is in format version $written, but this reader reads version 1."
        )
    }
    val noVersion = editedJson(validJson) { case ("formatVersion", _) => None }
    assert(
      refusal(PhysicalPlanCodec.fromJson(noVersion)) ==
        "The plan names no format version; this reader reads version 1."
    )
  }

  it should "read a field left out as its default, and refuse the plan where it needs the field" in {
    def without(field: String): StoredPhysicalPlan =
      PhysicalPlanCodec.fromJson(editedJson(validJson) { case (`field`, _) => None })
    assertUnreadable(without("settings"))("has no settings")
    assertUnreadable(without("dataTransferBatchSize"))("batch size is 0")
    assertUnreadable(without("executionMode"))("EXECUTION_MODE_UNSPECIFIED")
    assertUnreadable(without("outputPartitionRule"))("has no output partition rule")
    assertUnreadable(without("locationPreference"))("LOCATION_PREFERENCE_UNSPECIFIED")
    assertUnreadable(without("attributeType"))("ATTRIBUTE_TYPE_UNSPECIFIED")
    assertUnreadable(without("opExecInitInfo"))("no executor")
    assertUnreadable(without("interaction"))("up to an interaction it does not name")
    assertUnreadable(without("expiresAtMs"))("expires at 0 ms since the epoch")
    assertUnreadable(without("sourceExecutionId"))(
      "execution 0, but an execution's id is at least 1"
    )
    assertUnreadable(without("storageLocation"))("has no storage location")
    // A field a plan may leave out reads as the plan without it.
    assert(PhysicalPlanCodec.decode(without("replay")).replay.isEmpty)
  }

  it should "read a cost that is no number, or a replay log left empty, and refuse each" in {
    Seq("NaN", "Infinity", "-Infinity").foreach { seconds =>
      val json = editedJson(validJson) {
        case ("seconds", JDouble(12.5)) => Some("seconds" -> JString(seconds))
      }
      assertRefused(PhysicalPlanCodec.decode(PhysicalPlanCodec.fromJson(json)))(
        s"give operator udf $seconds seconds"
      )
    }
    assertUnreadable(PhysicalPlanCodec.fromJson(editedJson(validJson) {
      case ("replayLogLocation", _) => Some("replayLogLocation" -> JString(""))
    }))("writes its replay log to '', which is not an absolute URI")
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

  // ----- a change to an operator of a paused run -----

  // The UDF of `fullPlan`, its code changed while the run is paused; its ports and the rest of it
  // are as the running plan has them.
  private val changedUdf =
    udf.copy(opExecInitInfo = OpExecWithCode("yield {'k': 2}  # ünï\n", "python"))

  /**
    * Saves the change of `op` and reads it back from the message and from its JSON text; fails
    * unless both give `op`'s id, executor, mounts and the name of the environment it asks for.
    *
    * @return the JSON text
    */
  private def assertUpdateRoundTrips(op: PhysicalOp): String = {
    val stored = PhysicalPlanCodec.encodeUpdate(executionId, op)
    val json = PhysicalPlanCodec.updateToJson(stored)
    assert(
      PhysicalPlanCodec.updateFromJson(json) == stored,
      s"the JSON reads back otherwise:\n$json"
    )
    val expected = OperatorUpdate(
      executionId,
      op.id,
      op.opExecInitInfo,
      op.repositoryMounts,
      op.pythonEnvironment.environmentName
    )
    assert(PhysicalPlanCodec.decodeUpdate(stored) == expected)
    assert(PhysicalPlanCodec.decodeUpdate(PhysicalPlanCodec.updateFromJson(json)) == expected)
    json
  }

  it should "save a change to an operator and read it back, from the message and from its JSON" in {
    Seq(
      "new code that reads datasets" -> changedUdf,
      "new code that reads none" -> changedUdf.copy(repositoryMounts = None),
      "new settings" -> udf.copy(
        opExecInitInfo = OpExecWithClassName("org.example.FilterOpExec", """{"value":"é"}"""),
        repositoryMounts = None
      ),
      // A change saves the environment the operator as changed asks for, by name.
      "an operator that asks for its environment by name" ->
        changedUdf.withPythonEnvironment(PythonEnvironmentRef.Named("ml ünï")),
      "an executor with empty strings" -> udf.copy(opExecInitInfo = OpExecWithCode("", "")),
      "an operator of an internal layer" -> localAgg
    ).foreach {
      case (what, op) =>
        withClue(s"$what: ") {
          assertUpdateRoundTrips(op)
        }
    }
  }

  it should "save of a change only the operator's id, its executor, what its code reads and the environment it asks for" in {
    val json = assertUpdateRoundTrips(changedUdf)
    val fields = parse(json) match {
      case JObject(fields) => fields.toMap
      case other           => fail(s"not a JSON object: $other")
    }
    assert(
      fields.keySet ==
        Set(
          "formatVersion",
          "executionId",
          "opId",
          "opExecInitInfo",
          "repositoryMounts"
        ) ++ changedUdf.pythonEnvironment.environmentName.map(_ => "pythonEnvironment")
    )
    assert(fields("formatVersion") == JInt(1))
    assert(compact(fields("opId")) == """{"logicalOpId":{"id":"udf"},"layerName":"main"}""")
    // no port, link, schema or partitioning of the running operator
    Seq("inputPorts", "outputPorts", "links", "schema", "partitionRequirement").foreach { field =>
      assert(!json.contains(s""""$field""""), s"$field is in a change")
    }
    // mounts that are none are left out
    val noMounts = assertUpdateRoundTrips(changedUdf.copy(repositoryMounts = None))
    assert(!noMounts.contains("\"repositoryMounts\""))
    // the environment it asks for, by name only, and nothing when it asks for the engine's own
    val named = assertUpdateRoundTrips(
      changedUdf.withPythonEnvironment(PythonEnvironmentRef.Named("ml"))
    )
    assert(named.contains("\"pythonEnvironment\": \"ml\""))
  }

  it should "refuse to save a change to an operator that holds a resource binding, has no executor or belongs to another execution" in {
    val binding: ResourceBinding = _ => fail("saving a change must not bind anything")
    assertRefused(
      PhysicalPlanCodec.encodeUpdate(executionId, changedUdf.withResourceBinding(Some(binding)))
    )("Operator udf-main names datasets or models that were never resolved")
    assertRefused(
      PhysicalPlanCodec.encodeUpdate(
        executionId,
        changedUdf.copy(opExecInitInfo = OpExecInitInfo.Empty)
      )
    )("The update of operator udf-main gives it no executor")
    assertRefused(
      PhysicalPlanCodec.encodeUpdate(ExecutionIdentity(43), changedUdf)
    )("Operator udf-main belongs to execution 42, but the update is saved for execution 43")
  }

  private val validUpdate: StoredOperatorUpdate =
    PhysicalPlanCodec.encodeUpdate(executionId, changedUdf)

  private def assertUpdateUnreadable(stored: StoredOperatorUpdate)(expected: String*): Unit =
    assertRefused(PhysicalPlanCodec.decodeUpdate(stored))(expected: _*)

  it should "refuse a change of no execution or operator, with no executor, or with mounts RepositoryMounts refuses" in {
    assertUpdateUnreadable(validUpdate.clearExecutionId)("The operator update names no execution.")
    assertUpdateUnreadable(validUpdate.clearOpId)("The operator update names no operator.")
    assertUpdateUnreadable(validUpdate.withOpExecInitInfo(OpExecInitInfo.Empty))(
      "The update of operator udf-main gives it no executor."
    )
    assertUpdateUnreadable(validUpdate.update(_.repositoryMounts := Seq("../..:d4t4")))(
      "udf-main cannot mount",
      "Invalid mount locator '../..:d4t4'"
    )
    assertUpdateUnreadable(validUpdate.update(_.repositoryMounts :+= "dataset-1:d4t4"))(
      "Repository dataset-1:d4t4 of operator udf-main appears twice"
    )
    assert(
      PhysicalPlanCodec
        .decodeUpdate(validUpdate.update(_.repositoryMounts := Nil))
        .repositoryMounts
        .isEmpty
    )
  }

  it should "read a change's JSON as it reads a plan's" in {
    val json = PhysicalPlanCodec.updateToJson(validUpdate)
    def refused(text: String)(expected: String*): Unit =
      assertRefused(PhysicalPlanCodec.updateFromJson(text))(expected: _*)
    // whatever the order of its fields and its spacing
    assert(PhysicalPlanCodec.updateFromJson(s"\n$json\n") == validUpdate)
    assert(
      PhysicalPlanCodec.updateFromJson(compact(parse(json) match {
        case JObject(fields) => JObject(fields.reverse)
        case other           => other
      })) == validUpdate
    )
    // a field the format does not have, at the top or deeper
    refused(editedJson(json) { case ("opId", id) => Some("opIds" -> id) })("opIds")
    refused(editedJson(json) { case ("layerName", name) => Some("layer" -> name) })("layer")
    // a field left out reads as its default, which reading the change refuses where it needs one
    assertUpdateUnreadable(
      PhysicalPlanCodec.updateFromJson(editedJson(json) { case ("opId", _) => None })
    )("The operator update names no operator.")
    // another version, or none, before anything else
    refused(editedJson(json) {
      case ("formatVersion", _) => Some("formatVersion" -> JInt(2))
      case ("opId", id)         => Some("aFieldOfVersion2" -> id)
    })("The operator update is in format version 2, but this reader reads version 1.")
    refused(editedJson(json) {
      case ("formatVersion", _) => Some("formatVersion" -> JString("1"))
    })(
      "The operator update is in format version \"1\", but this reader reads version 1."
    )
    refused(editedJson(json) { case ("formatVersion", _) => None })(
      "The operator update names no format version; this reader reads version 1."
    )
    // not one JSON object
    refused(json.take(json.length / 2))("The operator update is not JSON")
    refused("")("The operator update is not JSON")
    refused("[]")("The operator update is not a JSON object")
    refused(json + json)("The operator update is not JSON", "Trailing token")
    refused(json.replaceFirst("\"formatVersion\": ", "\"formatVersion\": 1, \"formatVersion\": "))(
      "Duplicate field 'formatVersion'"
    )
    // a plan is not a change
    refused(validJson)("The operator update is not a saved operator update")
  }
}
