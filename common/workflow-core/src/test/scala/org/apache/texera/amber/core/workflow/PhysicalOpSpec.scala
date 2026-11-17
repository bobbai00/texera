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

import org.apache.texera.amber.core.executor.{OpExecInitInfo, OpExecWithCode}
import org.apache.texera.amber.core.storage.RepositoryVersionResolver
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.util.JSONUtils.objectMapper
import org.scalatest.flatspec.AnyFlatSpec

import java.nio.file.Path
import scala.jdk.CollectionConverters.IteratorHasAsScala

class PhysicalOpSpec extends AnyFlatSpec {

  private val workflowId = WorkflowIdentity(0L)
  private val executionId = ExecutionIdentity(0L)
  private def opId(name: String): PhysicalOpIdentity =
    PhysicalOpIdentity(OperatorIdentity(name), "main")
  private val intSchema: Schema = Schema().add(new Attribute("v", AttributeType.INTEGER))
  private def newOp(name: String): PhysicalOp =
    PhysicalOp.oneToOnePhysicalOp(opId(name), workflowId, executionId, OpExecInitInfo.Empty)

  // ----- SchemaPropagationFunc -----

  "SchemaPropagationFunc" should "wrap a serializable Java function" in {
    val javaFunc =
      new java.util.function.Function[Map[PortIdentity, Schema], Map[PortIdentity, Schema]]
        with java.io.Serializable {
        override def apply(m: Map[PortIdentity, Schema]): Map[PortIdentity, Schema] = m
      }
    val wrapped = SchemaPropagationFunc(javaFunc)
    val schemas = Map(PortIdentity(0) -> intSchema)
    assert(wrapped.func(schemas) == schemas)
    val scalaFunc = SchemaPropagationFunc(identity[Map[PortIdentity, Schema]] _)
    assert(scalaFunc == scalaFunc.copy())
  }

  // ----- factory methods -----

  "PhysicalOp factories" should "build source ops preferring the coordinator" in {
    val op = PhysicalOp.sourcePhysicalOp(
      workflowId,
      executionId,
      OperatorIdentity("src"),
      OpExecInitInfo.Empty
    )
    assert(op.id == opId("src"))
    assert(!op.parallelizable)
    assert(op.locationPreference.contains(PreferCoordinator))
    assert(op.isSourceOperator)
    val op2 = PhysicalOp.sourcePhysicalOp(opId("s2"), workflowId, executionId, OpExecInitInfo.Empty)
    assert(op2.id == opId("s2"))
    assert(op2.locationPreference.contains(PreferCoordinator))
  }

  it should "build one-to-one ops as parallelizable with no location preference" in {
    val op = PhysicalOp.oneToOnePhysicalOp(
      workflowId,
      executionId,
      OperatorIdentity("o"),
      OpExecInitInfo.Empty
    )
    assert(op.id == opId("o"))
    assert(op.parallelizable)
    assert(op.locationPreference.isEmpty)
  }

  it should "build many-to-one ops requiring a single partition" in {
    val op = PhysicalOp.manyToOnePhysicalOp(
      workflowId,
      executionId,
      OperatorIdentity("m"),
      OpExecInitInfo.Empty
    )
    assert(!op.parallelizable)
    assert(op.partitionRequirement == List(Some(SinglePartition())))
    assert(op.outputPartitionRule == PartitionRule.Fixed(SinglePartition()))
    assert(
      op.outputPartitionRule.outputPartition(List(HashPartition(List("k")))) == SinglePartition()
    )
    val op2 =
      PhysicalOp.manyToOnePhysicalOp(opId("m2"), workflowId, executionId, OpExecInitInfo.Empty)
    assert(op2.partitionRequirement == List(Some(SinglePartition())))
    assert(op2.outputPartitionRule == PartitionRule.Fixed(SinglePartition()))
  }

  it should "build local ops on the coordinator requiring a single partition" in {
    val op = PhysicalOp.localPhysicalOp(
      workflowId,
      executionId,
      OperatorIdentity("l"),
      OpExecInitInfo.Empty
    )
    assert(!op.parallelizable)
    assert(op.partitionRequirement == List(Some(SinglePartition())))
    assert(op.locationPreference.contains(PreferCoordinator))
    val op2 = PhysicalOp.localPhysicalOp(opId("l2"), workflowId, executionId, OpExecInitInfo.Empty)
    assert(op2.locationPreference.contains(PreferCoordinator))
  }

  // ----- dependee inputs -----

  "PhysicalOp.dependeeInputs" should "list distinct dependee ports" in {
    val op = newOp("j").withInputPorts(
      List(
        InputPort(PortIdentity(0)),
        InputPort(PortIdentity(1), dependencies = Seq(PortIdentity(0))),
        InputPort(PortIdentity(2), dependencies = Seq(PortIdentity(0)))
      )
    )
    assert(op.dependeeInputs == List(PortIdentity(0)))
    val dependeeLink = PhysicalLink(opId("u"), PortIdentity(0), opId("j"), PortIdentity(0))
    val dependerLink = PhysicalLink(opId("u"), PortIdentity(0), opId("j"), PortIdentity(1))
    assert(op.isInputLinkDependee(dependeeLink))
    assert(!op.isInputLinkDependee(dependerLink))
  }

  // ----- exec-code accessors -----

  "PhysicalOp.isPythonBased" should "hold for python and R code executors only" in {
    def withLanguage(language: String): PhysicalOp =
      newOp("p").copy(opExecInitInfo = OpExecWithCode("code", language))
    assert(withLanguage("python").isPythonBased)
    assert(withLanguage("r-tuple").isPythonBased)
    assert(withLanguage("r-table").isPythonBased)
    assert(!withLanguage("java").isPythonBased)
    assert(!newOp("p").isPythonBased)
  }

  "PhysicalOp.getCode" should "return the code or reject executors without code" in {
    val op = newOp("c").copy(opExecInitInfo = OpExecWithCode("print(1)", "python"))
    assert(op.getCode == "print(1)")
    val ex = intercept[IllegalAccessError](newOp("c").getCode)
    assert(ex.getMessage == "No code information in this physical operator")
  }

  // ----- with-builders -----

  "PhysicalOp with-builders" should
    "copy the partition requirement, output partition rule and one-to-many flag" in {
    val required = List(Some(HashPartition(List("k"))), None)
    assert(newOp("a").withPartitionRequirement(required).partitionRequirement == required)
    val rule = PartitionRule.Fixed(HashPartition(List("x")))
    val op = newOp("a").withOutputPartitionRule(rule)
    assert(op.outputPartitionRule == rule)
    assert(
      op.outputPartitionRule.outputPartition(List(SinglePartition())) == HashPartition(List("x"))
    )
    assert(newOp("a").withIsOneToManyOp(true).isOneToManyOp)
    assert(!newOp("a").isOneToManyOp)
  }

  // ----- the Python environment -----

  private val environment = PythonEnvironment("ml", Seq("tabulate==0.9.0"))

  "PhysicalOp" should "run in the engine's own Python environment by default" in {
    assert(newOp("a").pythonEnvironment == PythonEnvironmentRef.EngineDefault)
    newOp("a").requireEnvironmentResolved()
  }

  "PhysicalOp.withPythonEnvironment" should "copy the environment the operator runs in" in {
    val op = newOp("a")
    val named = op.withPythonEnvironment(PythonEnvironmentRef.Named("ml"))
    assert(named.pythonEnvironment == PythonEnvironmentRef.Named("ml"))
    val resolved = named.withPythonEnvironment(PythonEnvironmentRef.Resolved(environment))
    assert(resolved.pythonEnvironment == PythonEnvironmentRef.Resolved(environment))
    // Nothing else of the operator changes.
    assert(resolved.withPythonEnvironment(PythonEnvironmentRef.EngineDefault) == op)
  }

  "PhysicalOp.requireEnvironmentResolved" should
    "refuse an operator that names an environment no plan resolved" in {
    val op = newOp("named-udf").withPythonEnvironment(PythonEnvironmentRef.Named("ml"))
    val failure = intercept[IllegalStateException](op.requireEnvironmentResolved())
    assert(
      failure.getMessage ==
        "Operator named-udf names the Python environment 'ml', which was never resolved: only a " +
          "plan made to run can run it."
    )
  }

  it should "accept an operator whose environment a plan resolved" in {
    newOp("a")
      .withPythonEnvironment(PythonEnvironmentRef.Resolved(environment))
      .requireEnvironmentResolved()
  }

  // ----- datasets and models -----

  /** A binding that counts how often it is forced. */
  private class CountingBinding extends ResourceBinding {
    var forced = 0
    override def bind(resolver: RepositoryVersionResolver, mountRoot: Path): BoundResources = {
      forced += 1
      BoundResources(OpExecWithCode("bound", "python"), Set("dataset-1:abc123"))
    }
  }

  private val mounts = RepositoryMounts("/mnt/texera-mounts", Set("dataset-1:abc123"))

  "PhysicalOp" should "name nothing to mount and hold no binding by default" in {
    val op = newOp("a")
    assert(op.repositoryMounts.isEmpty)
    assert(op.resourceBinding.isEmpty)
    op.requireResourcesBound()
  }

  "PhysicalOp.withResourceBinding" should "hold the binding without forcing it" in {
    val binding = new CountingBinding
    val op = newOp("a").withResourceBinding(Some(binding))
    assert(op.resourceBinding.contains(binding))
    assert(binding.forced == 0)
    // The compile-time view stays as the operator built it until a plan to run binds it.
    assert(op.opExecInitInfo == OpExecInitInfo.Empty)
    assert(op.repositoryMounts.isEmpty)
    assert(op.withResourceBinding(None).resourceBinding.isEmpty)
  }

  "PhysicalOp.requireResourcesBound" should
    "refuse an operator that still holds a binding, without forcing it" in {
    val binding = new CountingBinding
    val op = newOp("unbound-udf").withResourceBinding(Some(binding))
    val failure = intercept[IllegalStateException](op.requireResourcesBound())
    assert(failure.getMessage.contains("unbound-udf"), failure.getMessage)
    assert(binding.forced == 0)
  }

  it should "accept a bound operator, whatever it mounts" in {
    newOp("a").copy(repositoryMounts = Some(mounts)).requireResourcesBound()
  }

  // ----- propagateSchema -----

  "PhysicalOp.propagateSchema" should "wait for all input schemas before running propagation" in {
    val op = newOp("a")
      .withInputPorts(List(InputPort(PortIdentity(0)), InputPort(PortIdentity(1))))
      .withOutputPorts(List(OutputPort(PortIdentity(0))))
    val updated = op.propagateSchema(Some((PortIdentity(0), intSchema)))
    assert(updated.inputPorts(PortIdentity(0))._3 == Right(intSchema))
    assert(updated.inputPorts(PortIdentity(1))._3.isLeft)
    assert(updated.outputPorts(PortIdentity(0))._3.isLeft)
  }

  it should "run propagation with no new schema when all inputs are already known" in {
    val src = newOp("s")
      .withOutputPorts(List(OutputPort(PortIdentity(0))))
      .withPropagateSchema(SchemaPropagationFunc(_ => Map(PortIdentity(0) -> intSchema)))
    val out = src.propagateSchema()
    assert(out.outputPorts(PortIdentity(0))._3 == Right(intSchema))
  }

  // ----- input-port dependency ordering -----

  "PhysicalOp.getInputPortDependencyPairs" should "order ports along the dependency chain" in {
    val op = newOp("j").withInputPorts(
      List(
        InputPort(PortIdentity(0)),
        InputPort(PortIdentity(1), dependencies = Seq(PortIdentity(0))),
        InputPort(PortIdentity(2), dependencies = Seq(PortIdentity(1)))
      )
    )
    assert(
      op.getInputPortDependencyPairs == List(PortIdentity(0), PortIdentity(1), PortIdentity(2))
    )
  }

  it should "be empty when no port declares dependencies" in {
    val op = newOp("a").withInputPorts(List(InputPort(PortIdentity(0))))
    assert(op.getInputPortDependencyPairs == Nil)
  }

  // ----- addOutputLink guards -----

  "PhysicalOp.addOutputLink" should "reject links from other operators or undeclared ports" in {
    val op = newOp("a").withOutputPorts(List(OutputPort(PortIdentity(0))))
    assertThrows[AssertionError] {
      op.addOutputLink(PhysicalLink(opId("other"), PortIdentity(0), opId("dn"), PortIdentity(0)))
    }
    assertThrows[AssertionError] {
      op.addOutputLink(PhysicalLink(opId("a"), PortIdentity(99), opId("dn"), PortIdentity(0)))
    }
  }

  // ----- primary-constructor defaults -----

  "PhysicalOp" should "provide sensible defaults from the primary constructor" in {
    val op = PhysicalOp(opId("raw"), workflowId, executionId, OpExecInitInfo.Empty)
    assert(op == op.copy())
    assert(op.outputPartitionRule == PartitionRule.FirstInput)
    val inputs = List(HashPartition(List("x")), SinglePartition())
    assert(op.outputPartitionRule.outputPartition(inputs) == HashPartition(List("x")))
    val schemas = Map(PortIdentity(0) -> intSchema)
    assert(op.propagateSchema.func(schemas) == schemas)
  }

  // ----- JSON -----

  "PhysicalOp JSON" should "leave the output partition rule out, as it left the function out" in {
    val rules = List(
      PartitionRule.FirstInput,
      PartitionRule.KeepKeyedInput,
      PartitionRule.Fixed(HashPartition(List("k")))
    )
    rules.foreach { rule =>
      val op = newOp("a").withOutputPartitionRule(rule)
      val json = objectMapper.readTree(objectMapper.writeValueAsString(op))
      assert(json.has("parallelizable"))
      assert(!json.has("outputPartitionRule"), s"$rule is in $json")
    }
  }

  it should "carry what the operator mounts, and leave a binding out without forcing it" in {
    val binding = new CountingBinding
    val op = newOp("a")
      .copy(repositoryMounts = Some(mounts))
      .withResourceBinding(Some(binding))
    val json = objectMapper.readTree(objectMapper.writeValueAsString(op))
    val written = json.get("repositoryMounts")
    assert(written.get("root").asText() == "/mnt/texera-mounts", s"no root in $json")
    assert(
      written.get("locators").elements().asScala.map(_.asText()).toList == List(
        "dataset-1:abc123"
      )
    )
    assert(!json.has("resourceBinding"), s"the binding is in $json")
    assert(binding.forced == 0)
  }

  it should "leave the Python environment out, whichever it is" in {
    Seq(
      PythonEnvironmentRef.EngineDefault,
      PythonEnvironmentRef.Named("ml"),
      PythonEnvironmentRef.Resolved(environment)
    ).foreach { ref =>
      val json =
        objectMapper.readTree(
          objectMapper.writeValueAsString(newOp("a").withPythonEnvironment(ref))
        )
      assert(json.has("parallelizable"))
      assert(!json.has("pythonEnvironment"), s"$ref is in $json")
    }
  }
}
