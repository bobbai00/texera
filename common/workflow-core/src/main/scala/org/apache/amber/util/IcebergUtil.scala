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

import org.apache.amber.config.StorageConfig
import org.apache.amber.core.tuple.{Attribute, AttributeType, BigObject, Schema, Tuple}
import org.apache.hadoop.conf.Configuration
import org.apache.iceberg.catalog.{Catalog, TableIdentifier}
import org.apache.iceberg.data.parquet.GenericParquetReaders
import org.apache.iceberg.data.{GenericRecord, Record}
import org.apache.iceberg.hadoop.{HadoopCatalog, HadoopFileIO}
import org.apache.iceberg.io.{CloseableIterable, InputFile}
import org.apache.iceberg.jdbc.JdbcCatalog
import org.apache.iceberg.parquet.{Parquet, ParquetValueReader}
import org.apache.iceberg.rest.RESTCatalog
import org.apache.iceberg.types.{Type => IcebergType, Types}
import org.apache.iceberg.{
  CatalogProperties,
  DataFile,
  PartitionSpec,
  Table,
  TableProperties,
  Schema => IcebergSchema
}

import java.nio.ByteBuffer
import java.nio.file.Path
import java.sql.Timestamp
import java.time.{LocalDateTime, ZoneId}
import scala.jdk.CollectionConverters._

/**
  * Util functions to interact with Iceberg Tables
  */
object IcebergUtil {

  // Unique suffix for BIG_OBJECT field encoding
  private val BIG_OBJECT_FIELD_SUFFIX = "__texera_big_obj_ptr"
  // Unique suffix for LIST field encoding
  private val LIST_FIELD_SUFFIX = "__texera_list"
  // Unique suffix for STRUCT field encoding
  private val STRUCT_FIELD_SUFFIX = "__texera_struct"
  // Unique suffix for INTEGER field encoding (stored as LongType to avoid overflow)
  private val INTEGER_FIELD_SUFFIX = "__texera_int"

  // JSON object mapper for nested type serialization
  private lazy val jsonMapper = new com.fasterxml.jackson.databind.ObjectMapper()

  /**
    * Creates and initializes a HadoopCatalog with the given parameters.
    * - Uses an empty Hadoop `Configuration`, meaning the local file system (or `file:/`) will be used by default
    * instead of HDFS.
    * - The `warehouse` parameter specifies the root directory for storing table data.
    * - Sets the file I/O implementation to `HadoopFileIO`.
    *
    * @param catalogName the name of the catalog.
    * @param warehouse   the root path for the warehouse where the tables are stored.
    * @return the initialized HadoopCatalog instance.
    */
  def createHadoopCatalog(
      catalogName: String,
      warehouse: Path
  ): HadoopCatalog = {
    val catalog = new HadoopCatalog()
    catalog.setConf(new Configuration) // Empty configuration, defaults to `file:/`
    // Ensure warehouse path is absolute to avoid invalid URIs like file://./path
    val absoluteWarehouse = warehouse.toAbsolutePath.toString
    catalog.initialize(
      catalogName,
      Map(
        "warehouse" -> absoluteWarehouse,
        CatalogProperties.FILE_IO_IMPL -> classOf[HadoopFileIO].getName
      ).asJava
    )

    catalog
  }

  /**
    * Creates and initializes a RESTCatalog with the given parameters.
    * - Configures the catalog to interact with a REST endpoint.
    * - The `warehouse` parameter specifies the root directory for storing table data.
    * - Sets the file I/O implementation to `HadoopFileIO`.
    * - Authentication support is not implemented yet (see TODO).
    *
    * Note: The only tested REST catalog implementation is `tabulario/iceberg-rest`
    * (https://hub.docker.com/r/tabulario/iceberg-rest).
    *
    * TODO: Add authentication support, such as OAuth2, using `OAuth2Properties`.
    *
    * @param catalogName the name of the catalog.
    * @param warehouse   the root path for the warehouse where the tables are stored.
    * @return the initialized RESTCatalog instance.
    */
  def createRestCatalog(
      catalogName: String,
      warehouse: Path
  ): RESTCatalog = {
    val catalog = new RESTCatalog()
    // Ensure warehouse path is absolute to avoid invalid URIs like file://./path
    val absoluteWarehouse = warehouse.toAbsolutePath.toString
    catalog.initialize(
      catalogName,
      Map(
        "warehouse" -> absoluteWarehouse,
        CatalogProperties.URI -> StorageConfig.icebergRESTCatalogUri,
        CatalogProperties.FILE_IO_IMPL -> classOf[HadoopFileIO].getName
      ).asJava
    )
    catalog
  }

  def createPostgresCatalog(
      catalogName: String,
      warehouse: Path
  ): JdbcCatalog = {
    // Occasionally the jdbc driver cannot be found during CI run.
    // Explicitly load the JDBC driver to avoid flaky CI failures.
    Class.forName("org.postgresql.Driver")
    val catalog = new JdbcCatalog()
    // Ensure warehouse path is absolute to avoid invalid URIs like file://./path
    // Also handle Windows paths: C:/xxx/xxx -> C/xxx/xxx for PyArrow compatibility
    val absoluteWarehouse = warehouse.toAbsolutePath.toString.replace(":", "")
    catalog.initialize(
      catalogName,
      Map(
        "warehouse" -> absoluteWarehouse,
        CatalogProperties.FILE_IO_IMPL -> classOf[HadoopFileIO].getName,
        CatalogProperties.URI -> s"jdbc:postgresql://${StorageConfig.icebergPostgresCatalogUriWithoutScheme}",
        JdbcCatalog.PROPERTY_PREFIX + "user" -> StorageConfig.icebergPostgresCatalogUsername,
        JdbcCatalog.PROPERTY_PREFIX + "password" -> StorageConfig.icebergPostgresCatalogPassword
      ).asJava
    )
    catalog
  }

  /**
    * Creates a new Iceberg table with the specified schema and properties.
    * - Drops the existing table if `overrideIfExists` is true and the table already exists.
    * - Creates an unpartitioned table with custom commit retry properties.
    *
    * @param catalog the Iceberg catalog to manage the table.
    * @param tableNamespace the namespace of the table.
    * @param tableName the name of the table.
    * @param tableSchema the schema of the table.
    * @param overrideIfExists whether to drop and recreate the table if it exists.
    * @return the created Iceberg table.
    */
  def createTable(
      catalog: Catalog,
      tableNamespace: String,
      tableName: String,
      tableSchema: IcebergSchema,
      overrideIfExists: Boolean
  ): Table = {

    val tableProperties = Map(
      TableProperties.COMMIT_NUM_RETRIES -> StorageConfig.icebergTableCommitNumRetries.toString,
      TableProperties.COMMIT_MAX_RETRY_WAIT_MS -> StorageConfig.icebergTableCommitMaxRetryWaitMs.toString,
      TableProperties.COMMIT_MIN_RETRY_WAIT_MS -> StorageConfig.icebergTableCommitMinRetryWaitMs.toString
    )

    val identifier = TableIdentifier.of(tableNamespace, tableName)
    if (catalog.tableExists(identifier) && overrideIfExists) {
      catalog.dropTable(identifier)
    }
    catalog.createTable(
      identifier,
      tableSchema,
      PartitionSpec.unpartitioned,
      tableProperties.asJava
    )

  }

  /**
    * Loads metadata for an existing Iceberg table.
    * - Returns `Some(Table)` if the table exists and is successfully loaded.
    * - Returns `None` if the table does not exist or cannot be loaded.
    *
    * @param catalog the Iceberg catalog to load the table from.
    * @param tableNamespace the namespace of the table.
    * @param tableName the name of the table.
    * @return an Option containing the table, or None if not found.
    */
  def loadTableMetadata(
      catalog: Catalog,
      tableNamespace: String,
      tableName: String
  ): Option[Table] = {
    val identifier = TableIdentifier.of(tableNamespace, tableName)
    try {
      Some(catalog.loadTable(identifier))
    } catch {
      case _: Exception => None
    }
  }

  /**
    * Converts a custom Amber `Schema` to an Iceberg `Schema`.
    * Field names are encoded to preserve BIG_OBJECT type information.
    *
    * @param amberSchema The custom Amber Schema.
    * @return An Iceberg Schema.
    */
  def toIcebergSchema(amberSchema: Schema): IcebergSchema = {
    val icebergFields = amberSchema.getAttributes.zipWithIndex.map {
      case (attribute, index) =>
        val encodedName = encodeFieldName(attribute.getName, attribute.getType)
        val icebergType = toIcebergType(attribute.getType)
        Types.NestedField.optional(index + 1, encodedName, icebergType)
    }
    new IcebergSchema(icebergFields.asJava)
  }

  /**
    * Converts a custom Amber `AttributeType` to an Iceberg `Type`.
    * Note: BIG_OBJECT is stored as StringType; field name encoding is used to distinguish it.
    * LIST and STRUCT types are stored as Iceberg ListType and MapType respectively.
    *
    * @param attributeType The custom Amber AttributeType.
    * @return The corresponding Iceberg Type.
    */
  def toIcebergType(attributeType: AttributeType): IcebergType = {
    attributeType match {
      case AttributeType.STRING => Types.StringType.get()
      // Use LongType for INTEGER to avoid overflow for large integer values
      case AttributeType.INTEGER   => Types.LongType.get()
      case AttributeType.LONG      => Types.LongType.get()
      case AttributeType.DOUBLE    => Types.DoubleType.get()
      case AttributeType.BOOLEAN   => Types.BooleanType.get()
      case AttributeType.TIMESTAMP => Types.TimestampType.withoutZone()
      case AttributeType.BINARY    => Types.BinaryType.get()
      case AttributeType.BIG_OBJECT =>
        Types.StringType.get() // Store BigObjectPointer URI as string
      // Nested types: LIST and STRUCT are serialized as JSON strings for storage
      case AttributeType.LIST   => Types.StringType.get()
      case AttributeType.STRUCT => Types.StringType.get()
      case AttributeType.ANY =>
        throw new IllegalArgumentException("ANY type is not supported in Iceberg")
    }
  }

  /**
    * Converts a custom Amber `Tuple` to an Iceberg `GenericRecord`, handling `null` values.
    * LIST and STRUCT types are serialized as JSON strings.
    *
    * @param tuple The custom Amber Tuple.
    * @return An Iceberg GenericRecord.
    */
  def toGenericRecord(icebergSchema: IcebergSchema, tuple: Tuple): Record = {
    val record = GenericRecord.create(icebergSchema)

    tuple.schema.getAttributes.zipWithIndex.foreach {
      case (attribute, index) =>
        val fieldName = encodeFieldName(attribute.getName, attribute.getType)
        val value = tuple.getField[AnyRef](index) match {
          case null                 => null
          case ts: Timestamp        => ts.toInstant.atZone(ZoneId.systemDefault()).toLocalDateTime
          case bytes: Array[Byte]   => ByteBuffer.wrap(bytes)
          case bigObjPtr: BigObject => bigObjPtr.getUri
          // Convert Integer to Long since Iceberg uses LongType for INTEGER to avoid overflow
          case int: java.lang.Integer if attribute.getType == AttributeType.INTEGER =>
            java.lang.Long.valueOf(int.longValue())
          // Serialize LIST and STRUCT types as JSON strings
          case list: java.util.List[_] if attribute.getType == AttributeType.LIST =>
            jsonMapper.writeValueAsString(list)
          case map: java.util.Map[_, _] if attribute.getType == AttributeType.STRUCT =>
            jsonMapper.writeValueAsString(map)
          case other => other
        }
        record.setField(fieldName, value)
    }

    record
  }

  /**
    * Converts an Iceberg `Record` to an Amber `Tuple`
    * LIST and STRUCT types are deserialized from JSON strings or passed through if native.
    *
    * @param record      The Iceberg Record.
    * @param amberSchema The corresponding Amber Schema.
    * @return An Amber Tuple.
    */
  def fromRecord(record: Record, amberSchema: Schema): Tuple = {
    val fieldValues = amberSchema.getAttributes.map { attribute =>
      // Try encoded field name first, then fall back to original name
      // (for schemas created by external systems like PyIceberg)
      val encodedName = encodeFieldName(attribute.getName, attribute.getType)
      val rawValue = Option(record.getField(encodedName))
        .orElse(Option(record.getField(attribute.getName)))
        .orNull

      rawValue match {
        case null               => null
        case ldt: LocalDateTime => Timestamp.valueOf(ldt)
        case buffer: ByteBuffer =>
          val bytes = new Array[Byte](buffer.remaining())
          buffer.get(bytes)
          bytes
        case uri: String if attribute.getType == AttributeType.BIG_OBJECT =>
          new BigObject(uri)
        // Deserialize LIST from JSON string (when stored as StringType)
        case jsonStr: String if attribute.getType == AttributeType.LIST =>
          jsonMapper.readValue(jsonStr, classOf[java.util.List[_]])
        // Deserialize STRUCT from JSON string (when stored as StringType)
        case jsonStr: String if attribute.getType == AttributeType.STRUCT =>
          jsonMapper.readValue(jsonStr, classOf[java.util.Map[String, _]])
        // Native Iceberg List type - pass through as-is
        case list: java.util.List[_] if attribute.getType == AttributeType.LIST =>
          list
        // Native Iceberg Map/Struct type - pass through as-is
        case map: java.util.Map[_, _] if attribute.getType == AttributeType.STRUCT =>
          map
        // Convert Long back to Integer for INTEGER type
        case long: java.lang.Long if attribute.getType == AttributeType.INTEGER =>
          java.lang.Integer.valueOf(long.intValue())
        case other => other
      }
    }

    Tuple(amberSchema, fieldValues.toArray)
  }

  /**
    * Encodes a field name for special types (BIG_OBJECT, LIST, STRUCT) by adding a unique system suffix.
    * This ensures these fields can be identified when reading from Iceberg.
    *
    * @param fieldName The original field name
    * @param attributeType The attribute type
    * @return The encoded field name with a unique suffix for special types
    */
  private def encodeFieldName(fieldName: String, attributeType: AttributeType): String = {
    attributeType match {
      case AttributeType.BIG_OBJECT => s"$fieldName$BIG_OBJECT_FIELD_SUFFIX"
      case AttributeType.LIST       => s"$fieldName$LIST_FIELD_SUFFIX"
      case AttributeType.STRUCT     => s"$fieldName$STRUCT_FIELD_SUFFIX"
      case AttributeType.INTEGER    => s"$fieldName$INTEGER_FIELD_SUFFIX"
      case _                        => fieldName
    }
  }

  /**
    * Decodes a field name by removing the unique system suffix if present.
    * This restores the original user-defined field name.
    *
    * @param fieldName The encoded field name
    * @return The original field name with system suffix removed
    */
  private def decodeFieldName(fieldName: String): String = {
    if (fieldName.endsWith(BIG_OBJECT_FIELD_SUFFIX)) {
      fieldName.substring(0, fieldName.length - BIG_OBJECT_FIELD_SUFFIX.length)
    } else if (fieldName.endsWith(LIST_FIELD_SUFFIX)) {
      fieldName.substring(0, fieldName.length - LIST_FIELD_SUFFIX.length)
    } else if (fieldName.endsWith(STRUCT_FIELD_SUFFIX)) {
      fieldName.substring(0, fieldName.length - STRUCT_FIELD_SUFFIX.length)
    } else if (fieldName.endsWith(INTEGER_FIELD_SUFFIX)) {
      fieldName.substring(0, fieldName.length - INTEGER_FIELD_SUFFIX.length)
    } else {
      fieldName
    }
  }

  /**
    * Determines the AttributeType from an encoded field name by examining the unique suffix.
    *
    * @param fieldName The field name to check
    * @return Some(AttributeType) if a special type suffix is found, None otherwise
    */
  private def getTypeFromFieldSuffix(fieldName: String): Option[AttributeType] = {
    if (fieldName.endsWith(BIG_OBJECT_FIELD_SUFFIX)) Some(AttributeType.BIG_OBJECT)
    else if (fieldName.endsWith(LIST_FIELD_SUFFIX)) Some(AttributeType.LIST)
    else if (fieldName.endsWith(STRUCT_FIELD_SUFFIX)) Some(AttributeType.STRUCT)
    else if (fieldName.endsWith(INTEGER_FIELD_SUFFIX)) Some(AttributeType.INTEGER)
    else None
  }

  /**
    * Converts an Iceberg `Schema` to an Amber `Schema`.
    * Field names are decoded to restore original names and detect special types (BIG_OBJECT, LIST, STRUCT).
    *
    * @param icebergSchema The Iceberg Schema.
    * @return The corresponding Amber Schema.
    */
  def fromIcebergSchema(icebergSchema: IcebergSchema): Schema = {
    val attributes = icebergSchema
      .columns()
      .asScala
      .map { field =>
        val fieldName = field.name()
        val icebergType = field.`type`()
        val attributeType = fromIcebergType(icebergType, fieldName)
        val originalName = decodeFieldName(fieldName)
        new Attribute(originalName, attributeType)
      }
      .toList

    Schema(attributes)
  }

  /**
    * Converts an Iceberg `Type` to an Amber `AttributeType`.
    *
    * @param icebergType The Iceberg Type.
    * @param fieldName The field name (used to detect special types by suffix).
    * @return The corresponding Amber AttributeType.
    */
  def fromIcebergType(
      icebergType: IcebergType,
      fieldName: String = ""
  ): AttributeType = {
    // First check if field name has a special suffix indicating LIST, STRUCT, INTEGER, or BIG_OBJECT
    getTypeFromFieldSuffix(fieldName) match {
      case Some(attrType) => attrType
      case None =>
        // No special suffix, determine type from Iceberg type
        icebergType match {
          case _: Types.StringType    => AttributeType.STRING
          case _: Types.IntegerType   => AttributeType.INTEGER
          case _: Types.LongType      => AttributeType.LONG
          case _: Types.DoubleType    => AttributeType.DOUBLE
          case _: Types.BooleanType   => AttributeType.BOOLEAN
          case _: Types.TimestampType => AttributeType.TIMESTAMP
          case _: Types.BinaryType    => AttributeType.BINARY
          // Native Iceberg nested types (e.g., from PyIceberg or external sources)
          case _: Types.ListType   => AttributeType.LIST
          case _: Types.MapType    => AttributeType.STRUCT
          case _: Types.StructType => AttributeType.STRUCT
          case _ => throw new IllegalArgumentException(s"Unsupported Iceberg type: $icebergType")
        }
    }
  }

  /**
    * Util function to create a Record iterator over the given DataFile in Iceberg
    * @param dataFile the data file
    * @param schema the schema of the table
    * @param table the iceberg table
    * @return an iterator over the records in the data file
    */
  def readDataFileAsIterator(
      dataFile: DataFile,
      schema: IcebergSchema,
      table: Table
  ): Iterator[Record] = {
    val inputFile: InputFile = table.io().newInputFile(dataFile)
    val readerFunc
        : java.util.function.Function[org.apache.parquet.schema.MessageType, ParquetValueReader[
          _
        ]] =
      (messageType: org.apache.parquet.schema.MessageType) =>
        GenericParquetReaders.buildReader(schema, messageType)
    val closeableIterable: CloseableIterable[Record] =
      Parquet
        .read(inputFile)
        .project(schema)
        .createReaderFunc(readerFunc)
        .build()
    closeableIterable.iterator().asScala
  }

}
