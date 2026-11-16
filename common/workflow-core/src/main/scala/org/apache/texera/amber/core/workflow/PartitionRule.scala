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

/**
  * How an operator's output is partitioned, given how its inputs are partitioned.
  *
  * The scheduler applies the rule while it plans a region, once it knows the partitioning of
  * every input port. The rule is plain data rather than a function, so a stored plan can carry it.
  */
sealed trait PartitionRule extends Product with Serializable {

  /**
    * @param inputs the partitioning of each input port, one entry per port, in the order the
    *               scheduler hands them over. That is not port order: ResourceAllocator groups
    *               the inputs by port id in a hash map, so for ports 0 and 1 the head is port 1.
    * @return the partitioning of the output
    */
  def outputPartition(inputs: List[PartitionInfo]): PartitionInfo
}

object PartitionRule {

  /**
    * The output is partitioned like the head of `inputs`. An operator has this rule by default.
    * With one input port the head is that port; with several it need not be port 0 (see
    * [[PartitionRule.outputPartition]]).
    */
  case object FirstInput extends PartitionRule {
    override def outputPartition(inputs: List[PartitionInfo]): PartitionInfo = inputs.head
  }

  /** The output is partitioned this way, whatever the inputs are. */
  final case class Fixed(partition: PartitionInfo) extends PartitionRule {
    override def outputPartition(inputs: List[PartitionInfo]): PartitionInfo = partition
  }

  /**
    * Looks at the head of `inputs` only. A hash or range partitioning that names at least one
    * column is kept, one that names none becomes unknown, and any other partitioning is passed on
    * as it is. Projection, which has one input port, has this rule.
    */
  case object KeepKeyedInput extends PartitionRule {
    override def outputPartition(inputs: List[PartitionInfo]): PartitionInfo =
      inputs.head match {
        case HashPartition(names) if names.isEmpty        => UnknownPartition()
        case RangePartition(names, _, _) if names.isEmpty => UnknownPartition()
        case input                                        => input
      }
  }
}
