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

import org.apache.amber.core.tuple.{AttributeType, BigObject, Schema, Tuple}
import org.apache.amber.util.IcebergUtil.toIcebergSchema
import org.apache.iceberg.data.GenericRecord
import org.apache.iceberg.types.Types
import org.apache.iceberg.{Schema => IcebergSchema}
import org.scalatest.flatspec.AnyFlatSpec

import java.nio.ByteBuffer
import java.sql.Timestamp
import java.time.{LocalDateTime, ZoneId}
import scala.jdk.CollectionConverters._

class IcebergUtilSpec extends AnyFlatSpec {

  val texeraSchema: Schema = Schema()
    .add("test-1", AttributeType.INTEGER)
    .add("test-2", AttributeType.LONG)
    .add("test-3", AttributeType.BOOLEAN)
    .add("test-4", AttributeType.DOUBLE)
    .add("test-5", AttributeType.TIMESTAMP)
    .add("test-6", AttributeType.STRING)
    .add("test-7", AttributeType.BINARY)

  val icebergSchema: IcebergSchema = new IcebergSchema(
    List(
      // INTEGER uses LongType and field suffix to preserve type information
      Types.NestedField.optional(1, "test-1__texera_int", Types.LongType.get()),
      Types.NestedField.optional(2, "test-2", Types.LongType.get()),
      Types.NestedField.optional(3, "test-3", Types.BooleanType.get()),
      Types.NestedField.optional(4, "test-4", Types.DoubleType.get()),
      Types.NestedField.optional(5, "test-5", Types.TimestampType.withoutZone()),
      Types.NestedField.optional(6, "test-6", Types.StringType.get()),
      Types.NestedField.optional(7, "test-7", Types.BinaryType.get())
    ).asJava
  )

  behavior of "IcebergUtil"

  it should "convert from AttributeType to Iceberg Type correctly" in {
    // INTEGER uses LongType to avoid overflow for large integer values
    assert(IcebergUtil.toIcebergType(AttributeType.INTEGER) == Types.LongType.get())
    assert(IcebergUtil.toIcebergType(AttributeType.LONG) == Types.LongType.get())
    assert(IcebergUtil.toIcebergType(AttributeType.BOOLEAN) == Types.BooleanType.get())
    assert(IcebergUtil.toIcebergType(AttributeType.DOUBLE) == Types.DoubleType.get())
    assert(IcebergUtil.toIcebergType(AttributeType.TIMESTAMP) == Types.TimestampType.withoutZone())
    assert(IcebergUtil.toIcebergType(AttributeType.STRING) == Types.StringType.get())
    assert(IcebergUtil.toIcebergType(AttributeType.BINARY) == Types.BinaryType.get())
    // Nested types are stored as StringType (JSON serialized)
    assert(IcebergUtil.toIcebergType(AttributeType.LIST) == Types.StringType.get())
    assert(IcebergUtil.toIcebergType(AttributeType.STRUCT) == Types.StringType.get())
  }

  it should "convert from Iceberg Type to AttributeType correctly" in {
    assert(IcebergUtil.fromIcebergType(Types.IntegerType.get()) == AttributeType.INTEGER)
    assert(IcebergUtil.fromIcebergType(Types.LongType.get()) == AttributeType.LONG)
    assert(IcebergUtil.fromIcebergType(Types.BooleanType.get()) == AttributeType.BOOLEAN)
    assert(IcebergUtil.fromIcebergType(Types.DoubleType.get()) == AttributeType.DOUBLE)
    assert(
      IcebergUtil.fromIcebergType(Types.TimestampType.withoutZone()) == AttributeType.TIMESTAMP
    )
    assert(IcebergUtil.fromIcebergType(Types.StringType.get()) == AttributeType.STRING)
    assert(IcebergUtil.fromIcebergType(Types.BinaryType.get()) == AttributeType.BINARY)
  }

  it should "convert from Texera Schema to Iceberg Schema correctly" in {
    assert(IcebergUtil.toIcebergSchema(texeraSchema).sameSchema(icebergSchema))
  }

  it should "convert from Iceberg Schema to Texera Schema correctly" in {
    assert(IcebergUtil.fromIcebergSchema(icebergSchema) == texeraSchema)
  }

  it should "convert Texera Tuple to Iceberg GenericRecord correctly" in {
    val tuple = Tuple
      .builder(texeraSchema)
      .addSequentially(
        Array(
          Int.box(42),
          Long.box(123456789L),
          Boolean.box(true),
          Double.box(3.14),
          new Timestamp(10000L),
          "hello world",
          Array[Byte](1, 2, 3, 4)
        )
      )
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(tuple.schema), tuple)

    // INTEGER fields have __texera_int suffix and are stored as Long
    assert(record.getField("test-1__texera_int") == 42L)
    assert(record.getField("test-2") == 123456789L)
    assert(record.getField("test-3") == true)
    assert(record.getField("test-4") == 3.14)
    assert(record.getField("test-5") == new Timestamp(10000L).toLocalDateTime)
    assert(record.getField("test-6") == "hello world")
    assert(record.getField("test-7") == ByteBuffer.wrap(Array[Byte](1, 2, 3, 4)))

    val tupleFromRecord = IcebergUtil.fromRecord(record, texeraSchema)
    assert(tupleFromRecord == tuple)
  }

  it should "convert Texera Tuple with null values to Iceberg GenericRecord correctly" in {
    val tuple = Tuple
      .builder(texeraSchema)
      .addSequentially(
        Array(
          Int.box(42), // Non-null
          null, // Null Long
          Boolean.box(true), // Non-null
          null, // Null Double
          null, // Null Timestamp
          "hello world", // Non-null String
          null // Null Binary
        )
      )
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(tuple.schema), tuple)

    // INTEGER fields have __texera_int suffix and are stored as Long
    assert(record.getField("test-1__texera_int") == 42L)
    assert(record.getField("test-2") == null)
    assert(record.getField("test-3") == true)
    assert(record.getField("test-4") == null)
    assert(record.getField("test-5") == null)
    assert(record.getField("test-6") == "hello world")
    assert(record.getField("test-7") == null)

    val tupleFromRecord = IcebergUtil.fromRecord(record, texeraSchema)
    assert(tupleFromRecord == tuple)
  }

  it should "convert a fully null Texera Tuple to Iceberg GenericRecord correctly" in {
    val tuple = Tuple
      .builder(texeraSchema)
      .addSequentially(
        Array(
          null, // Null Integer
          null, // Null Long
          null, // Null Boolean
          null, // Null Double
          null, // Null Timestamp
          null, // Null String
          null // Null Binary
        )
      )
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(tuple.schema), tuple)

    // INTEGER fields have __texera_int suffix
    assert(record.getField("test-1__texera_int") == null)
    assert(record.getField("test-2") == null)
    assert(record.getField("test-3") == null)
    assert(record.getField("test-4") == null)
    assert(record.getField("test-5") == null)
    assert(record.getField("test-6") == null)
    assert(record.getField("test-7") == null)

    val tupleFromRecord = IcebergUtil.fromRecord(record, texeraSchema)
    assert(tupleFromRecord == tuple)
  }

  it should "convert Iceberg GenericRecord to Texera Tuple correctly" in {
    val record = GenericRecord.create(icebergSchema)
    // INTEGER fields use __texera_int suffix and are stored as Long
    record.setField("test-1__texera_int", 42L)
    record.setField("test-2", 123456789L)
    record.setField("test-3", true)
    record.setField("test-4", 3.14)
    record.setField(
      "test-5",
      LocalDateTime.ofInstant(new Timestamp(10000L).toInstant, ZoneId.systemDefault())
    )
    record.setField("test-6", "hello world")
    record.setField("test-7", ByteBuffer.wrap(Array[Byte](1, 2, 3, 4)))

    val tuple = IcebergUtil.fromRecord(record, texeraSchema)

    assert(tuple.getField[Integer]("test-1") == 42)
    assert(tuple.getField[Long]("test-2") == 123456789L)
    assert(tuple.getField[Boolean]("test-3") == true)
    assert(tuple.getField[Double]("test-4") == 3.14)
    assert(tuple.getField[Timestamp]("test-5") == new Timestamp(10000L))
    assert(tuple.getField[String]("test-6") == "hello world")
    assert(tuple.getField[Array[Byte]]("test-7") sameElements Array[Byte](1, 2, 3, 4))
  }

  // BIG_OBJECT type tests

  it should "convert BIG_OBJECT type correctly between Texera and Iceberg" in {
    // BIG_OBJECT stored as StringType with field name suffix
    assert(IcebergUtil.toIcebergType(AttributeType.BIG_OBJECT) == Types.StringType.get())
    assert(IcebergUtil.fromIcebergType(Types.StringType.get(), "field") == AttributeType.STRING)
    assert(
      IcebergUtil.fromIcebergType(
        Types.StringType.get(),
        "field__texera_big_obj_ptr"
      ) == AttributeType.BIG_OBJECT
    )
  }

  it should "convert schemas with BIG_OBJECT fields correctly" in {
    val texeraSchema = Schema()
      .add("id", AttributeType.INTEGER)
      .add("large_data", AttributeType.BIG_OBJECT)

    val icebergSchema = IcebergUtil.toIcebergSchema(texeraSchema)

    // INTEGER field gets encoded name with suffix
    assert(icebergSchema.findField("id__texera_int") != null)
    assert(icebergSchema.findField("id__texera_int").`type`() == Types.LongType.get())
    // BIG_OBJECT field gets encoded name with suffix
    assert(icebergSchema.findField("large_data__texera_big_obj_ptr") != null)
    assert(
      icebergSchema.findField("large_data__texera_big_obj_ptr").`type`() == Types.StringType.get()
    )

    // Round-trip preserves schema
    val roundTripSchema = IcebergUtil.fromIcebergSchema(icebergSchema)
    assert(roundTripSchema.getAttribute("id").getType == AttributeType.INTEGER)
    assert(roundTripSchema.getAttribute("large_data").getType == AttributeType.BIG_OBJECT)
  }

  it should "convert tuples with BIG_OBJECT to records and back correctly" in {
    val schema = Schema()
      .add("id", AttributeType.INTEGER)
      .add("large_data", AttributeType.BIG_OBJECT)

    val tuple = Tuple
      .builder(schema)
      .addSequentially(Array(Int.box(42), new BigObject("s3://bucket/object/key.data")))
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tuple)

    // INTEGER stored as Long with encoded field name
    assert(record.getField("id__texera_int") == 42L)
    // BIG_OBJECT stored as URI string with encoded field name
    assert(record.getField("large_data__texera_big_obj_ptr") == "s3://bucket/object/key.data")

    // Round-trip preserves data
    val roundTripTuple = IcebergUtil.fromRecord(record, schema)
    assert(roundTripTuple == tuple)

    // BigObject properties are accessible
    val bigObj = roundTripTuple.getField[BigObject]("large_data")
    assert(bigObj.getUri == "s3://bucket/object/key.data")
    assert(bigObj.getBucketName == "bucket")
    assert(bigObj.getObjectKey == "object/key.data")
  }

  it should "handle null BIG_OBJECT values correctly" in {
    val schema = Schema().add("data", AttributeType.BIG_OBJECT)

    val tupleWithNull = Tuple.builder(schema).addSequentially(Array(null)).build()
    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tupleWithNull)

    assert(record.getField("data__texera_big_obj_ptr") == null)
    assert(IcebergUtil.fromRecord(record, schema) == tupleWithNull)
  }

  it should "handle multiple BIG_OBJECT fields and mixed types correctly" in {
    val schema = Schema()
      .add("int_field", AttributeType.INTEGER)
      .add("big_obj_1", AttributeType.BIG_OBJECT)
      .add("string_field", AttributeType.STRING)
      .add("big_obj_2", AttributeType.BIG_OBJECT)

    val tuple = Tuple
      .builder(schema)
      .addSequentially(
        Array(
          Int.box(123),
          new BigObject("s3://bucket1/file1.dat"),
          "normal string",
          null // null BIG_OBJECT
        )
      )
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tuple)

    // INTEGER stored as Long with encoded field name
    assert(record.getField("int_field__texera_int") == 123L)
    assert(record.getField("big_obj_1__texera_big_obj_ptr") == "s3://bucket1/file1.dat")
    assert(record.getField("string_field") == "normal string")
    assert(record.getField("big_obj_2__texera_big_obj_ptr") == null)

    assert(IcebergUtil.fromRecord(record, schema) == tuple)
  }

  // LIST type tests

  it should "convert LIST type correctly between Texera and Iceberg" in {
    // LIST stored as StringType with field name suffix (JSON serialized)
    assert(IcebergUtil.toIcebergType(AttributeType.LIST) == Types.StringType.get())
    assert(IcebergUtil.fromIcebergType(Types.StringType.get(), "field") == AttributeType.STRING)
    assert(
      IcebergUtil.fromIcebergType(
        Types.StringType.get(),
        "field__texera_list"
      ) == AttributeType.LIST
    )
  }

  it should "convert schemas with LIST fields correctly" in {
    val texeraSchema = Schema()
      .add("id", AttributeType.INTEGER)
      .add("tags", AttributeType.LIST)

    val icebergSchema = IcebergUtil.toIcebergSchema(texeraSchema)

    // INTEGER field gets encoded name with suffix
    assert(icebergSchema.findField("id__texera_int") != null)
    assert(icebergSchema.findField("id__texera_int").`type`() == Types.LongType.get())
    // LIST field gets encoded name with suffix
    assert(icebergSchema.findField("tags__texera_list") != null)
    assert(
      icebergSchema.findField("tags__texera_list").`type`() == Types.StringType.get()
    )

    // Round-trip preserves schema
    val roundTripSchema = IcebergUtil.fromIcebergSchema(icebergSchema)
    assert(roundTripSchema.getAttribute("id").getType == AttributeType.INTEGER)
    assert(roundTripSchema.getAttribute("tags").getType == AttributeType.LIST)
  }

  it should "convert tuples with LIST to records and back correctly" in {
    val schema = Schema()
      .add("id", AttributeType.INTEGER)
      .add("items", AttributeType.LIST)

    val javaList = new java.util.ArrayList[Any]()
    javaList.add("item1")
    javaList.add("item2")
    javaList.add("item3")

    val tuple = Tuple
      .builder(schema)
      .addSequentially(Array(Int.box(42), javaList))
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tuple)

    // INTEGER stored as Long with encoded field name
    assert(record.getField("id__texera_int") == 42L)
    // LIST stored as JSON string with encoded field name
    assert(record.getField("items__texera_list") == """["item1","item2","item3"]""")

    // Round-trip preserves data
    val roundTripTuple = IcebergUtil.fromRecord(record, schema)
    val roundTripList = roundTripTuple.getField[java.util.List[_]]("items")
    assert(roundTripList.size() == 3)
    assert(roundTripList.get(0) == "item1")
    assert(roundTripList.get(1) == "item2")
    assert(roundTripList.get(2) == "item3")
  }

  it should "handle null LIST values correctly" in {
    val schema = Schema().add("items", AttributeType.LIST)

    val tupleWithNull = Tuple.builder(schema).addSequentially(Array(null)).build()
    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tupleWithNull)

    assert(record.getField("items__texera_list") == null)
    assert(IcebergUtil.fromRecord(record, schema) == tupleWithNull)
  }

  // STRUCT type tests

  it should "convert STRUCT type correctly between Texera and Iceberg" in {
    // STRUCT stored as StringType with field name suffix (JSON serialized)
    assert(IcebergUtil.toIcebergType(AttributeType.STRUCT) == Types.StringType.get())
    assert(IcebergUtil.fromIcebergType(Types.StringType.get(), "field") == AttributeType.STRING)
    assert(
      IcebergUtil.fromIcebergType(
        Types.StringType.get(),
        "field__texera_struct"
      ) == AttributeType.STRUCT
    )
  }

  it should "convert schemas with STRUCT fields correctly" in {
    val texeraSchema = Schema()
      .add("id", AttributeType.INTEGER)
      .add("metadata", AttributeType.STRUCT)

    val icebergSchema = IcebergUtil.toIcebergSchema(texeraSchema)

    // INTEGER field gets encoded name with suffix
    assert(icebergSchema.findField("id__texera_int") != null)
    assert(icebergSchema.findField("id__texera_int").`type`() == Types.LongType.get())
    // STRUCT field gets encoded name with suffix
    assert(icebergSchema.findField("metadata__texera_struct") != null)
    assert(
      icebergSchema.findField("metadata__texera_struct").`type`() == Types.StringType.get()
    )

    // Round-trip preserves schema
    val roundTripSchema = IcebergUtil.fromIcebergSchema(icebergSchema)
    assert(roundTripSchema.getAttribute("id").getType == AttributeType.INTEGER)
    assert(roundTripSchema.getAttribute("metadata").getType == AttributeType.STRUCT)
  }

  it should "convert tuples with STRUCT to records and back correctly" in {
    val schema = Schema()
      .add("id", AttributeType.INTEGER)
      .add("data", AttributeType.STRUCT)

    val javaMap = new java.util.LinkedHashMap[String, Any]()
    javaMap.put("key1", "value1")
    javaMap.put("key2", "value2")

    val tuple = Tuple
      .builder(schema)
      .addSequentially(Array(Int.box(42), javaMap))
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tuple)

    // INTEGER stored as Long with encoded field name
    assert(record.getField("id__texera_int") == 42L)
    // STRUCT stored as JSON string with encoded field name
    assert(record.getField("data__texera_struct") == """{"key1":"value1","key2":"value2"}""")

    // Round-trip preserves data
    val roundTripTuple = IcebergUtil.fromRecord(record, schema)
    val roundTripMap = roundTripTuple.getField[java.util.Map[String, _]]("data")
    assert(roundTripMap.size() == 2)
    assert(roundTripMap.get("key1") == "value1")
    assert(roundTripMap.get("key2") == "value2")
  }

  it should "handle null STRUCT values correctly" in {
    val schema = Schema().add("data", AttributeType.STRUCT)

    val tupleWithNull = Tuple.builder(schema).addSequentially(Array(null)).build()
    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tupleWithNull)

    assert(record.getField("data__texera_struct") == null)
    assert(IcebergUtil.fromRecord(record, schema) == tupleWithNull)
  }

  it should "handle mixed LIST, STRUCT, and other types correctly" in {
    val schema = Schema()
      .add("int_field", AttributeType.INTEGER)
      .add("list_field", AttributeType.LIST)
      .add("string_field", AttributeType.STRING)
      .add("struct_field", AttributeType.STRUCT)
      .add("big_obj_field", AttributeType.BIG_OBJECT)

    val javaList = new java.util.ArrayList[Any]()
    javaList.add(1)
    javaList.add(2)

    val javaMap = new java.util.LinkedHashMap[String, Any]()
    javaMap.put("nested", "value")

    val tuple = Tuple
      .builder(schema)
      .addSequentially(
        Array(
          Int.box(123),
          javaList,
          "normal string",
          javaMap,
          new BigObject("s3://bucket/file.dat")
        )
      )
      .build()

    val record = IcebergUtil.toGenericRecord(toIcebergSchema(schema), tuple)

    // INTEGER stored as Long with encoded field name
    assert(record.getField("int_field__texera_int") == 123L)
    assert(record.getField("list_field__texera_list") == "[1,2]")
    assert(record.getField("string_field") == "normal string")
    assert(record.getField("struct_field__texera_struct") == """{"nested":"value"}""")
    assert(record.getField("big_obj_field__texera_big_obj_ptr") == "s3://bucket/file.dat")

    // Verify round-trip
    val roundTripTuple = IcebergUtil.fromRecord(record, schema)
    assert(roundTripTuple.getField[Integer]("int_field") == 123)
    assert(roundTripTuple.getField[String]("string_field") == "normal string")

    val rtList = roundTripTuple.getField[java.util.List[_]]("list_field")
    assert(rtList.size() == 2)

    val rtMap = roundTripTuple.getField[java.util.Map[String, _]]("struct_field")
    assert(rtMap.get("nested") == "value")

    val rtBigObj = roundTripTuple.getField[BigObject]("big_obj_field")
    assert(rtBigObj.getUri == "s3://bucket/file.dat")
  }

  // Tests for native Iceberg nested types (e.g., from PyIceberg or external sources)

  it should "convert native Iceberg ListType to AttributeType.LIST" in {
    val listType = Types.ListType.ofOptional(1, Types.StringType.get())
    assert(IcebergUtil.fromIcebergType(listType) == AttributeType.LIST)
  }

  it should "convert native Iceberg MapType to AttributeType.STRUCT" in {
    val mapType = Types.MapType.ofOptional(1, 2, Types.StringType.get(), Types.StringType.get())
    assert(IcebergUtil.fromIcebergType(mapType) == AttributeType.STRUCT)
  }

  it should "convert native Iceberg StructType to AttributeType.STRUCT" in {
    val structType = Types.StructType.of(
      Types.NestedField.optional(1, "field1", Types.StringType.get())
    )
    assert(IcebergUtil.fromIcebergType(structType) == AttributeType.STRUCT)
  }

  it should "convert schemas with native Iceberg nested types correctly" in {
    // Create an Iceberg schema with native list and map types (as if from PyIceberg)
    val nativeIcebergSchema = new IcebergSchema(
      List(
        Types.NestedField.optional(1, "name", Types.StringType.get()),
        Types.NestedField.optional(2, "tags", Types.ListType.ofOptional(3, Types.StringType.get())),
        Types.NestedField.optional(
          4,
          "metadata",
          Types.MapType.ofOptional(5, 6, Types.StringType.get(), Types.StringType.get())
        )
      ).asJava
    )

    val texeraSchema = IcebergUtil.fromIcebergSchema(nativeIcebergSchema)

    assert(texeraSchema.getAttribute("name").getType == AttributeType.STRING)
    assert(texeraSchema.getAttribute("tags").getType == AttributeType.LIST)
    assert(texeraSchema.getAttribute("metadata").getType == AttributeType.STRUCT)
  }

  it should "handle records with native Iceberg list values" in {
    // Create a schema with native list type
    val nativeIcebergSchema = new IcebergSchema(
      List(
        Types.NestedField.optional(1, "id", Types.LongType.get()),
        Types.NestedField.optional(2, "items", Types.ListType.ofOptional(3, Types.StringType.get()))
      ).asJava
    )

    val texeraSchema = Schema()
      .add("id", AttributeType.LONG)
      .add("items", AttributeType.LIST)

    // Create a record with native list value
    val record = GenericRecord.create(nativeIcebergSchema)
    record.setField("id", 42L)
    val javaList = new java.util.ArrayList[String]()
    javaList.add("a")
    javaList.add("b")
    javaList.add("c")
    record.setField("items", javaList)

    val tuple = IcebergUtil.fromRecord(record, texeraSchema)

    assert(tuple.getField[Long]("id") == 42L)
    val items = tuple.getField[java.util.List[_]]("items")
    assert(items.size() == 3)
    assert(items.get(0) == "a")
    assert(items.get(1) == "b")
    assert(items.get(2) == "c")
  }

  it should "handle records with native Iceberg map values" in {
    // Create a schema with native map type
    val nativeIcebergSchema = new IcebergSchema(
      List(
        Types.NestedField.optional(1, "id", Types.LongType.get()),
        Types.NestedField.optional(
          2,
          "data",
          Types.MapType.ofOptional(3, 4, Types.StringType.get(), Types.StringType.get())
        )
      ).asJava
    )

    val texeraSchema = Schema()
      .add("id", AttributeType.LONG)
      .add("data", AttributeType.STRUCT)

    // Create a record with native map value
    val record = GenericRecord.create(nativeIcebergSchema)
    record.setField("id", 99L)
    val javaMap = new java.util.HashMap[String, String]()
    javaMap.put("key1", "value1")
    javaMap.put("key2", "value2")
    record.setField("data", javaMap)

    val tuple = IcebergUtil.fromRecord(record, texeraSchema)

    assert(tuple.getField[Long]("id") == 99L)
    val data = tuple.getField[java.util.Map[_, _]]("data")
    assert(data.size() == 2)
    assert(data.get("key1") == "value1")
    assert(data.get("key2") == "value2")
  }
}
