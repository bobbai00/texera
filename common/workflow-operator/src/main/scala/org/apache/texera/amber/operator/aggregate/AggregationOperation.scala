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

package org.apache.texera.amber.operator.aggregate

import com.fasterxml.jackson.annotation.{JsonIgnore, JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.{JsonSchemaInject, JsonSchemaTitle}
import org.apache.texera.amber.core.tuple.{
  Attribute,
  AttributeType,
  AttributeTypeUtils,
  Schema,
  Tuple
}
import org.apache.texera.amber.operator.metadata.annotations.AutofillAttributeName

import javax.validation.constraints.NotNull

case class AveragePartialObj(sum: Double, count: Double) extends Serializable {}

@JsonSchemaInject(json = """
{
  "attributeTypeRules": {
    "attribute": {
      "allOf": [
        {
          "if": {
            "aggFunction": {
              "valEnum": ["sum", "average", "min", "max"]
            }
          },
          "then": {
            "enum": ["integer", "long", "double", "timestamp"]
          }
        },
        {
          "if": {
            "aggFunction": {
              "valEnum": ["concat"]
            }
          },
          "then": {
            "enum": ["string"]
          }
        }
      ]
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "aggFunction": { "const": "count" }
        }
      },
      "then": {},
      "else": {
        "required": ["attribute"],
        "properties": {
          "attribute": { "pattern": "\\S" }
        }
      }
    }
  ]
}
""")
class AggregationOperation {
  @JsonProperty(required = true)
  @JsonSchemaTitle("Aggregate Func")
  @JsonPropertyDescription("sum, count, average, min, max, or concat")
  var aggFunction: AggregationFunction = _

  @JsonProperty(value = "attribute")
  @JsonPropertyDescription("column to aggregate on")
  @AutofillAttributeName
  var attribute: String = _

  @JsonProperty(value = "result attribute", required = true)
  @JsonPropertyDescription("column name of average result")
  @NotNull(message = "result attribute is required")
  var resultAttribute: String = _

  @JsonIgnore
  def getAggregationAttribute(attrType: AttributeType): Attribute = {
    val resultAttrType = this.aggFunction match {
      case AggregationFunction.SUM     => attrType
      case AggregationFunction.COUNT   => AttributeType.INTEGER
      case AggregationFunction.AVERAGE => AttributeType.DOUBLE
      case AggregationFunction.MIN     => attrType
      case AggregationFunction.MAX     => attrType
      case AggregationFunction.CONCAT  => AttributeType.STRING
      case _                           => throw new RuntimeException("Unknown aggregation function: " + this.aggFunction)
    }
    new Attribute(resultAttribute, resultAttrType)
  }

  @JsonIgnore
  def getAggFunc(attrType: AttributeType): DistributedAggregation[Object] = {
    val aggFunc = aggFunction match {
      case AggregationFunction.AVERAGE => averageAgg()
      case AggregationFunction.COUNT   => countAgg()
      case AggregationFunction.MAX     => maxAgg(attrType)
      case AggregationFunction.MIN     => minAgg(attrType)
      case AggregationFunction.SUM     => sumAgg(attrType)
      case AggregationFunction.CONCAT  => concatAgg()
      case _ =>
        throw new UnsupportedOperationException("Unknown aggregation function: " + aggFunction)
    }
    aggFunc.asInstanceOf[DistributedAggregation[Object]]
  }

  /** The column that carries a first-stage average's row count, beside its running sum. */
  @JsonIgnore
  def averageCountAttribute: String = resultAttribute + "__count"

  /**
    * The columns the first stage emits for this aggregation on every worker. An average
    * cannot be merged from averages, so its first stage emits a running sum and a row
    * count; every other function emits one value of its result type.
    */
  @JsonIgnore
  def getPartialAttributes(attrType: AttributeType): List[Attribute] =
    aggFunction match {
      case AggregationFunction.AVERAGE =>
        List(
          new Attribute(resultAttribute, AttributeType.DOUBLE),
          new Attribute(averageCountAttribute, AttributeType.LONG)
        )
      case _ => List(getAggregationAttribute(attrType))
    }

  /** The first stage's values for one group, in the order of `getPartialAttributes`. */
  @JsonIgnore
  def getPartialValues(agg: DistributedAggregation[Object], partial: Object): List[Object] =
    aggFunction match {
      case AggregationFunction.AVERAGE =>
        val average = partial.asInstanceOf[AveragePartialObj]
        List(java.lang.Double.valueOf(average.sum), java.lang.Long.valueOf(average.count.toLong))
      case _ => List(agg.finalAgg(partial))
    }

  /**
    * The second stage: combines, per group, what the first stage emitted on every worker.
    * Partial counts and sums add up, partial minima and maxima compete, partial
    * concatenations join, and an average divides the summed sums by the summed counts.
    *
    * @param partialType the type of this aggregation's column in the first stage's output
    */
  @JsonIgnore
  def getMergeAgg(partialType: AttributeType): DistributedAggregation[Object] = {
    def overPartials(function: AggregationFunction): AggregationOperation = {
      val operation = new AggregationOperation()
      operation.aggFunction = function
      operation.attribute = resultAttribute
      operation.resultAttribute = resultAttribute
      operation
    }
    aggFunction match {
      case AggregationFunction.AVERAGE =>
        averageMergeAgg().asInstanceOf[DistributedAggregation[Object]]
      case AggregationFunction.COUNT =>
        overPartials(AggregationFunction.SUM).getAggFunc(AttributeType.INTEGER)
      case function => overPartials(function).getAggFunc(partialType)
    }
  }

  /** This aggregation's column in the final output, read off the first stage's output schema. */
  @JsonIgnore
  def getFinalAttribute(partialSchema: Schema): Attribute =
    aggFunction match {
      case AggregationFunction.AVERAGE => new Attribute(resultAttribute, AttributeType.DOUBLE)
      case _                           => partialSchema.getAttribute(resultAttribute)
    }

  private def averageMergeAgg(): DistributedAggregation[AveragePartialObj] =
    new DistributedAggregation[AveragePartialObj](
      () => AveragePartialObj(0, 0),
      (partial, tuple) => {
        val sum = tuple.getField[java.lang.Double](resultAttribute)
        val count = tuple.getField[java.lang.Long](averageCountAttribute)
        AveragePartialObj(partial.sum + sum.doubleValue(), partial.count + count.doubleValue())
      },
      (partial1, partial2) =>
        AveragePartialObj(partial1.sum + partial2.sum, partial1.count + partial2.count),
      partial => {
        val ret: java.lang.Double = if (partial.count == 0d) null else partial.sum / partial.count
        ret
      }
    )

  private def sumAgg(attributeType: AttributeType): DistributedAggregation[Object] = {
    if (
      attributeType != AttributeType.INTEGER &&
      attributeType != AttributeType.DOUBLE &&
      attributeType != AttributeType.LONG &&
      attributeType != AttributeType.TIMESTAMP
    ) {
      throw new UnsupportedOperationException(
        "Unsupported attribute type for sum aggregation: " + attributeType
      )
    }
    new DistributedAggregation[Object](
      () => AttributeTypeUtils.zeroValue(attributeType),
      (partial, tuple) => {
        val value = tuple.getField[Object](attribute)
        AttributeTypeUtils.add(partial, value, attributeType)
      },
      (partial1, partial2) => AttributeTypeUtils.add(partial1, partial2, attributeType),
      partial => partial
    )
  }

  private def countAgg(): DistributedAggregation[Integer] = {
    // An empty attribute means COUNT(*): count every row. Otherwise count only the
    // rows whose attribute value is non-null (COUNT(column)).
    val countAllRows = attribute == null || attribute.trim.isEmpty
    new DistributedAggregation[Integer](
      () => 0,
      (partial, tuple) =>
        partial + (if (countAllRows || tuple.getField(attribute) != null) 1 else 0),
      (partial1, partial2) => partial1 + partial2,
      partial => partial
    )
  }

  private def concatAgg(): DistributedAggregation[String] = {
    new DistributedAggregation[String](
      () => "",
      (partial, tuple) => {
        if (partial == "") {
          if (tuple.getField(attribute) != null) tuple.getField(attribute).toString else ""
        } else {
          partial + "," + (if (tuple.getField(attribute) != null)
                             tuple.getField(attribute).toString
                           else "")
        }
      },
      (partial1, partial2) => {
        if (partial1 != "" && partial2 != "") {
          partial1 + "," + partial2
        } else {
          partial1 + partial2
        }
      },
      partial => partial
    )
  }

  private def minAgg(attributeType: AttributeType): DistributedAggregation[Object] = {
    if (
      attributeType != AttributeType.INTEGER &&
      attributeType != AttributeType.DOUBLE &&
      attributeType != AttributeType.LONG &&
      attributeType != AttributeType.TIMESTAMP
    ) {
      throw new UnsupportedOperationException(
        "Unsupported attribute type for min aggregation: " + attributeType
      )
    }
    new DistributedAggregation[Object](
      () => AttributeTypeUtils.maxValue(attributeType),
      (partial, tuple) => {
        val value = tuple.getField[Object](attribute)
        val comp = AttributeTypeUtils.compare(value, partial, attributeType)
        if (value != null && comp < 0) value else partial
      },
      (partial1, partial2) =>
        if (AttributeTypeUtils.compare(partial1, partial2, attributeType) < 0) partial1
        else partial2,
      partial => if (partial == AttributeTypeUtils.maxValue(attributeType)) null else partial
    )
  }

  private def maxAgg(attributeType: AttributeType): DistributedAggregation[Object] = {
    if (
      attributeType != AttributeType.INTEGER &&
      attributeType != AttributeType.DOUBLE &&
      attributeType != AttributeType.LONG &&
      attributeType != AttributeType.TIMESTAMP
    ) {
      throw new UnsupportedOperationException(
        "Unsupported attribute type for max aggregation: " + attributeType
      )
    }
    new DistributedAggregation[Object](
      () => AttributeTypeUtils.minValue(attributeType),
      (partial, tuple) => {
        val value = tuple.getField[Object](attribute)
        val comp = AttributeTypeUtils.compare(value, partial, attributeType)
        if (value != null && comp > 0) value else partial
      },
      (partial1, partial2) =>
        if (AttributeTypeUtils.compare(partial1, partial2, attributeType) > 0) partial1
        else partial2,
      partial => if (partial == AttributeTypeUtils.minValue(attributeType)) null else partial
    )
  }

  private def getNumericalValue(tuple: Tuple): Option[Double] = {
    val value: Object = tuple.getField(attribute)
    if (value == null)
      return None

    if (tuple.getSchema.getAttribute(attribute).getType == AttributeType.TIMESTAMP)
      Option(AttributeTypeUtils.parseTimestamp(value.toString).getTime.toDouble)
    else Option(value.toString.toDouble)
  }

  private def averageAgg(): DistributedAggregation[AveragePartialObj] = {
    new DistributedAggregation[AveragePartialObj](
      () => AveragePartialObj(0, 0),
      (partial, tuple) => {
        val value = getNumericalValue(tuple)
        AveragePartialObj(
          partial.sum + (if (value.isDefined) value.get else 0),
          partial.count + (if (value.isDefined) 1 else 0)
        )
      },
      (partial1, partial2) =>
        AveragePartialObj(partial1.sum + partial2.sum, partial1.count + partial2.count),
      partial => {
        val ret: java.lang.Double = if (partial.count == 0d) null else partial.sum / partial.count
        ret
      }
    )
  }
}
