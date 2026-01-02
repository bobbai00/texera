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

package org.apache.amber.util

import com.typesafe.scalalogging.LazyLogging
import org.apache.amber.core.tuple.AttributeTypeUtils.AttributeTypeException
import org.apache.amber.core.tuple._
import org.apache.arrow.memory.{BufferAllocator, RootAllocator}
import org.apache.arrow.vector.types.FloatingPointPrecision
import org.apache.arrow.vector.types.TimeUnit.MILLISECOND
import org.apache.arrow.vector.types.pojo.ArrowType.PrimitiveType
import org.apache.arrow.vector.types.pojo.{ArrowType, Field}
import org.apache.arrow.vector.{
  BigIntVector,
  BitVector,
  FieldVector,
  Float8Vector,
  IntVector,
  TimeStampVector,
  VarBinaryVector,
  VarCharVector,
  VectorSchemaRoot
}
import org.apache.arrow.vector.complex.{ListVector, StructVector}
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule

import java.nio.charset.StandardCharsets
import java.util
import scala.jdk.CollectionConverters.CollectionHasAsScala
import scala.language.implicitConversions

object ArrowUtils extends LazyLogging {

  // Create a single allocator for the entire utility
  private val allocator: BufferAllocator = new RootAllocator()

  implicit def bool2int(b: Boolean): Int = if (b) 1 else 0

  /**
    * Reads a row of the given Arrow Vectors into a Texera.Tuple
    * e.g.,
    * rowIndex  IntVector BigIntVector  BooleanVector
    * 0         1         100L          true
    *
    * the row at rowIndex 0 can be converted into `Tuple[1, 100L, true]`
    *
    * @param rowIndex         The row index of the target row to be converted in the Vectors.
    * @param vectorSchemaRoot The root of the Vectors that stores the Arrow Fields. It contains multiple Vectors.
    * @return
    */
  def getTexeraTuple(
      rowIndex: Int,
      vectorSchemaRoot: VectorSchemaRoot
  ): Tuple = {
    val arrowSchema = vectorSchemaRoot.getSchema
    val schema = toTexeraSchema(arrowSchema)

    Tuple
      .builder(schema)
      .addSequentially(
        vectorSchemaRoot.getFieldVectors.asScala
          .map((fieldVector: FieldVector) => {
            val value: AnyRef = fieldVector.getObject(rowIndex)
            try {
              val arrowType = fieldVector.getField.getFieldType.getType
              val attributeType = toAttributeType(arrowType)
              AttributeTypeUtils.parseField(value, attributeType)

            } catch {
              case e: Exception =>
                logger.warn("Caught error during parsing Arrow value back to Texera value", e)
                null
            }

          })
          .toArray
      )
      .build()
  }

  /**
    * Converts an Arrow Schema into Texera Schema.
    *
    * @param arrowSchema The Arrow Schema to be converted.
    * @return A Texera Schema.
    */
  def toTexeraSchema(arrowSchema: org.apache.arrow.vector.types.pojo.Schema): Schema =
    Schema(
      arrowSchema.getFields.asScala.map { field =>
        new Attribute(field.getName, toAttributeType(field.getType))
      }.toList
    )

  /**
    * Converts an ArrowType into an AttributeType.
    *
    * @param srcType the ArrowType to be converted.
    * @throws AttributeTypeException if the type cannot be converted.
    * @return An AttributeType.
    */
  @throws[AttributeTypeException]
  def toAttributeType(srcType: ArrowType): AttributeType = {
    srcType match {
      // Use LONG for all integer types to avoid overflow for large values
      case _: ArrowType.Int =>
        AttributeType.LONG
      case _: ArrowType.Bool =>
        AttributeType.BOOLEAN

      case _: ArrowType.FloatingPoint =>
        AttributeType.DOUBLE

      case _: ArrowType.Timestamp =>
        AttributeType.TIMESTAMP

      case _: ArrowType.Utf8 =>
        AttributeType.STRING

      case _: ArrowType.Binary =>
        AttributeType.BINARY

      case _: ArrowType.List | _: ArrowType.LargeList =>
        AttributeType.LIST

      case _: ArrowType.Struct =>
        AttributeType.STRUCT

      case _ =>
        throw new AttributeTypeUtils.AttributeTypeException(
          "Unexpected value: " + srcType.getTypeID
        )
    }
  }

  def appendTexeraTuple(tuple: Tuple, vectorSchemaRoot: VectorSchemaRoot): Unit = {
    val currentRowCount = vectorSchemaRoot.getRowCount
    val nextRowIndex = currentRowCount
    setTexeraTuple(tuple, nextRowIndex, vectorSchemaRoot)
  }

  /**
    * Writes a Texera.Tuple into a row of the Arrow Vectors. It will overwrite the data on the
    * target row of the Vectors.
    *
    * @param tuple            A Texera.Tuple.
    * @param index            The row index in the Vectors to be replaced.
    * @param vectorSchemaRoot The root of the Vectors that stores the Arrow Fields. It contains
    *                         multiple Vectors.
    */
  def setTexeraTuple(tuple: Tuple, index: Int, vectorSchemaRoot: VectorSchemaRoot): Unit = {
    val arrowSchema = vectorSchemaRoot.getSchema
    val arrowFields = arrowSchema.getFields.asScala.toList

    for (i <- arrowFields.indices) {
      val vector: FieldVector = vectorSchemaRoot.getVector(i)
      val value = tuple.getField[AnyRef](i)
      val isNull = value == null
      arrowFields.apply(i).getFieldType.getType match {
        case _: ArrowType.Int =>
          vector.getField.getFieldType.getType.asInstanceOf[ArrowType.Int].getBitWidth match {
            case 16 | 32 =>
              vector
                .asInstanceOf[IntVector]
                .setSafe(index, !isNull, if (isNull) 0 else value.asInstanceOf[Int])

            case 64 | _ =>
              vector
                .asInstanceOf[BigIntVector]
                .setSafe(index, !isNull, if (isNull) 0 else value.asInstanceOf[Long])
          }

        case _: ArrowType.Bool =>
          vector
            .asInstanceOf[BitVector]
            .setSafe(index, !isNull, if (isNull) 0 else value.asInstanceOf[Boolean])

        case _: ArrowType.FloatingPoint =>
          vector
            .asInstanceOf[Float8Vector]
            .setSafe(index, !isNull, if (isNull) 0 else value.asInstanceOf[Double])

        case _: ArrowType.Timestamp =>
          vector
            .asInstanceOf[TimeStampVector]
            .setSafe(
              index,
              !isNull,
              if (isNull) 0L
              else
                AttributeTypeUtils
                  .parseField(value, AttributeType.LONG)
                  .asInstanceOf[Long]
            )

        case _: ArrowType.Utf8 =>
          if (isNull) vector.asInstanceOf[VarCharVector].setNull(index)
          else
            vector
              .asInstanceOf[VarCharVector]
              .setSafe(index, value.asInstanceOf[String].getBytes(StandardCharsets.UTF_8))
        case _: ArrowType.Binary | _: ArrowType.LargeBinary =>
          if (isNull) vector.asInstanceOf[VarBinaryVector].setNull(index)
          else
            vector
              .asInstanceOf[VarBinaryVector]
              .setSafe(index, value.asInstanceOf[Array[Byte]])

        case _: ArrowType.List | _: ArrowType.LargeList =>
          // Handle ListVector for nested list data
          vector match {
            case listVector: ListVector =>
              // For now, log warning - full ListVector write support is complex
              // and would require dynamic element type inference
              logger.warn(
                s"Writing to ListVector not fully supported. Field: ${arrowFields(i).getName}"
              )
              // Mark as null for safety
              listVector.setNull(index)
            case charVector: VarCharVector =>
              // Fallback: serialize as JSON string if vector is VarChar
              if (isNull) charVector.setNull(index)
              else {
                val jsonBytes = objectMapper.writeValueAsString(value).getBytes(StandardCharsets.UTF_8)
                charVector.setSafe(index, jsonBytes)
              }
            case _ =>
              logger.warn(s"Unexpected vector type for LIST: ${vector.getClass.getName}")
          }

        case _: ArrowType.Struct =>
          // Handle StructVector for nested struct/dict data
          vector match {
            case structVector: StructVector =>
              // For now, log warning - full StructVector write support is complex
              logger.warn(
                s"Writing to StructVector not fully supported. Field: ${arrowFields(i).getName}"
              )
              // Mark as null for safety
              structVector.setNull(index)
            case charVector: VarCharVector =>
              // Fallback: serialize as JSON string if vector is VarChar
              if (isNull) charVector.setNull(index)
              else {
                val jsonBytes = objectMapper.writeValueAsString(value).getBytes(StandardCharsets.UTF_8)
                charVector.setSafe(index, jsonBytes)
              }
            case _ =>
              logger.warn(s"Unexpected vector type for STRUCT: ${vector.getClass.getName}")
          }

      }
    }

    vectorSchemaRoot.setRowCount(vectorSchemaRoot.getRowCount + 1)
  }

  // Shared ObjectMapper for JSON serialization of nested types
  private lazy val objectMapper: ObjectMapper = {
    val mapper = new ObjectMapper()
    mapper.registerModule(DefaultScalaModule)
    mapper
  }

  /**
    * Converts an Amber schema into Arrow schema.
    *
    * @param schema The Texera Schema.
    * @return An Arrow Schema.
    */
  def fromTexeraSchema(schema: Schema): org.apache.arrow.vector.types.pojo.Schema = {
    import org.apache.arrow.vector.types.pojo.FieldType
    val arrowFields = new util.ArrayList[Field]

    for (amberAttribute <- schema.getAttributes) {
      val name = amberAttribute.getName
      val attrType = amberAttribute.getType
      val arrowType = fromAttributeType(attrType)

      val field = attrType match {
        case AttributeType.LIST =>
          // Create a LIST field with a generic element type (string by default)
          // The actual element type will be inferred from the data at runtime
          val elementField = Field.nullable("item", ArrowType.Utf8.INSTANCE)
          new Field(name, FieldType.nullable(arrowType), java.util.Collections.singletonList(elementField))

        case AttributeType.STRUCT =>
          // Create a STRUCT field with no predefined children
          // Actual struct fields will be determined at runtime from the data
          new Field(name, FieldType.nullable(arrowType), java.util.Collections.emptyList())

        case _ =>
          // For primitive types, use the standard nullablePrimitive method
          arrowType match {
            case pt: PrimitiveType => Field.nullablePrimitive(name, pt)
            case _ => new Field(name, FieldType.nullable(arrowType), java.util.Collections.emptyList())
          }
      }
      arrowFields.add(field)
    }
    new org.apache.arrow.vector.types.pojo.Schema(arrowFields)
  }

  /**
    * Converts an AttributeType into an ArrowType.
    *
    * @param srcType The AttributeType to be converted.
    * @throws AttributeTypeException if the type cannot be converted.
    * @return An ArrowType corresponding to the given AttributeType.
    */
  @throws[AttributeTypeException]
  def fromAttributeType(srcType: AttributeType): ArrowType = {
    srcType match {
      // Use 64-bit for INTEGER to avoid overflow for large integer values
      case AttributeType.INTEGER =>
        new ArrowType.Int(64, true)

      case AttributeType.LONG =>
        new ArrowType.Int(64, true)

      case AttributeType.DOUBLE =>
        new ArrowType.FloatingPoint(FloatingPointPrecision.DOUBLE)

      case AttributeType.BOOLEAN =>
        ArrowType.Bool.INSTANCE

      case AttributeType.TIMESTAMP =>
        new ArrowType.Timestamp(MILLISECOND, "UTC")

      case AttributeType.BINARY =>
        new ArrowType.Binary

      case AttributeType.STRING | AttributeType.ANY =>
        ArrowType.Utf8.INSTANCE

      // For LIST and STRUCT, we use Arrow's native nested types
      // The actual element/field types are determined at runtime from the data
      case AttributeType.LIST =>
        ArrowType.List.INSTANCE

      case AttributeType.STRUCT =>
        ArrowType.Struct.INSTANCE

      case _ =>
        throw new AttributeTypeUtils.AttributeTypeException("Unexpected value: " + srcType)
    }
  }
}
