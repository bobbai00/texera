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

import org.apache.texera.amber.core.workflow.PartitionRule.{Fixed, FirstInput, KeepKeyedInput}
import org.scalatest.flatspec.AnyFlatSpec

class PartitionRuleSpec extends AnyFlatSpec {

  private val hashOnK = HashPartition(List("k"))
  private val rangeOnK = new RangePartition(List("k"), 0L, 100L)
  private val emptyHash = HashPartition(List.empty)
  // RangePartition.apply turns an empty key list into UnknownPartition, so `new` is the only
  // way to build the empty range a rule can still be handed.
  private val emptyRange = new RangePartition(List.empty, 0L, 100L)
  private val unkeyed: List[PartitionInfo] =
    List(SinglePartition(), OneToOnePartition(), BroadcastPartition(), UnknownPartition())
  private val everyKind: List[PartitionInfo] = hashOnK :: rangeOnK :: emptyHash :: unkeyed

  // ----- FirstInput -----

  // The head is whatever the scheduler puts first, which need not be port 0 when an operator has
  // several input ports; ResourcePoliciesSpec pins the order the scheduler uses.
  "PartitionRule.FirstInput" should "partition the output like the head of its inputs" in {
    everyKind.foreach { input =>
      assert(FirstInput.outputPartition(List(input)) == input)
      assert(FirstInput.outputPartition(List(input, hashOnK)) == input)
    }
    // An empty key list is passed on as it is; only KeepKeyedInput turns it into unknown.
    assert(FirstInput.outputPartition(List(emptyRange)) == emptyRange)
  }

  it should "refuse to derive anything from no inputs" in {
    assertThrows[NoSuchElementException](FirstInput.outputPartition(List.empty))
  }

  // ----- Fixed -----

  "PartitionRule.Fixed" should "give its own partitioning whatever the inputs are" in {
    val rule = Fixed(HashPartition(List("x")))
    (everyKind :+ emptyRange).foreach(input =>
      assert(rule.outputPartition(List(input)) == HashPartition(List("x")))
    )
    assert(
      rule.outputPartition(List(SinglePartition(), UnknownPartition())) == HashPartition(List("x"))
    )
    assert(rule.outputPartition(List.empty) == HashPartition(List("x")))
  }

  it should "give any kind of partitioning it holds" in {
    (everyKind :+ emptyRange).foreach(fixed =>
      assert(Fixed(fixed).outputPartition(List(hashOnK)) == fixed)
    )
  }

  // ----- KeepKeyedInput -----

  "PartitionRule.KeepKeyedInput" should "keep a hash partitioning that names columns" in {
    assert(KeepKeyedInput.outputPartition(List(hashOnK)) == hashOnK)
    assert(
      KeepKeyedInput.outputPartition(List(HashPartition(List("a", "b")))) ==
        HashPartition(List("a", "b"))
    )
  }

  it should "keep a range partitioning that names columns, bounds included" in {
    assert(KeepKeyedInput.outputPartition(List(rangeOnK)) == rangeOnK)
    assert(KeepKeyedInput.outputPartition(List(rangeOnK)) != new RangePartition(List("k"), 0L, 99L))
  }

  it should "make a hash partitioning that names no columns unknown" in {
    assert(KeepKeyedInput.outputPartition(List(emptyHash)) == UnknownPartition())
    assert(KeepKeyedInput.outputPartition(List(HashPartition())) == UnknownPartition())
  }

  it should "make a range partitioning that names no columns unknown" in {
    assert(KeepKeyedInput.outputPartition(List(emptyRange)) == UnknownPartition())
    // What RangePartition.apply gives for no columns is already unknown, and stays so.
    assert(
      KeepKeyedInput.outputPartition(List(RangePartition(List.empty, 0L, 100L))) ==
        UnknownPartition()
    )
  }

  it should "pass on any partitioning that is neither hash nor range" in {
    unkeyed.foreach(input => assert(KeepKeyedInput.outputPartition(List(input)) == input))
  }

  it should "look at the head of its inputs only" in {
    assert(KeepKeyedInput.outputPartition(List(SinglePartition(), emptyHash)) == SinglePartition())
    assert(KeepKeyedInput.outputPartition(List(emptyHash, hashOnK)) == UnknownPartition())
    assert(KeepKeyedInput.outputPartition(List(hashOnK, emptyHash)) == hashOnK)
  }

  it should "refuse to derive anything from no inputs" in {
    assertThrows[NoSuchElementException](KeepKeyedInput.outputPartition(List.empty))
  }

  // ----- as data -----

  "PartitionRule" should "compare by value, so two compiles of an operator give equal rules" in {
    assert(Fixed(HashPartition(List("k"))) == Fixed(HashPartition(List("k"))))
    assert(Fixed(HashPartition(List("k"))).hashCode == Fixed(HashPartition(List("k"))).hashCode)
    assert(Fixed(HashPartition(List("k"))) != Fixed(HashPartition(List("j"))))
    assert(Fixed(SinglePartition()) != Fixed(UnknownPartition()))
    val rules: List[PartitionRule] = List(FirstInput, KeepKeyedInput, Fixed(UnknownPartition()))
    assert(rules.distinct == rules)
  }

  it should
    "have only cases that hold nothing but partitionings, so a stored plan can carry it" in {
    import scala.reflect.runtime.universe.typeOf
    val cases = typeOf[PartitionRule].typeSymbol.asClass.knownDirectSubclasses
    // A new case must be plain data too; add it here once it is.
    assert(cases.map(_.name.toString) == Set("FirstInput", "Fixed", "KeepKeyedInput"))
    val fields = cases.toList.filterNot(_.isModuleClass).flatMap { rule =>
      rule.asClass.primaryConstructor.asMethod.paramLists.flatten.map(field => (rule, field))
    }
    assert(fields.nonEmpty)
    fields.foreach {
      case (rule, field) =>
        assert(
          field.typeSignature <:< typeOf[PartitionInfo],
          s"${rule.name}.${field.name} is a ${field.typeSignature}, not a PartitionInfo"
        )
    }
  }

  it should "not take a function in place of a rule" in {
    assertCompiles("val rule: PartitionRule = Fixed(UnknownPartition())")
    // The shapes the operators used while the rule was a function.
    assertTypeError("val rule: PartitionRule = _ => UnknownPartition()")
    assertTypeError("val rule: PartitionRule = (inputs: List[PartitionInfo]) => inputs.head")
  }
}
