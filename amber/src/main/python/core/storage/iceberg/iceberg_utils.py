# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

import json
import os
import pyarrow as pa
import pyiceberg.table
from pyiceberg.catalog import Catalog
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.expressions import AlwaysTrue
from pyiceberg.io.pyarrow import ArrowScan
from pyiceberg.partitioning import UNPARTITIONED_PARTITION_SPEC
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from typing import Optional, Iterable

import core
from core.models import ArrowTableTupleProvider, Tuple
from core.models.schema.attribute_type import AttributeType


def create_postgres_catalog(
    catalog_name: str,
    warehouse_path: str,
    uri_without_scheme: str,
    username: str,
    password: str,
) -> SqlCatalog:
    """
    Creates a Postgres SQL catalog instance by connecting to the database named
    "texera_iceberg_catalog".
    - The only requirement of the database is that it already exists. Once pyiceberg
    can connect to the database, it will handle the initializations.
    :param catalog_name: the name of the catalog.
    :param warehouse_path: the root path for the warehouse where the tables are stored.
    :param uri_without_scheme: the uri of the postgres database but without
            the scheme prefix since java and python use different schemes.
    :param username: the username of the postgres database.
    :param password: the password of the postgres database.
    :return: a SQLCatalog instance.
    """
    # Ensure warehouse_path is absolute to avoid invalid URIs like file://./path
    absolute_warehouse_path = os.path.abspath(warehouse_path)
    return SqlCatalog(
        catalog_name,
        **{
            "uri": f"postgresql+pg8000://{username}:{password}@{uri_without_scheme}",
            "warehouse": f"file://{absolute_warehouse_path}",
        },
    )


def create_table(
    catalog: Catalog,
    table_namespace: str,
    table_name: str,
    table_schema: Schema,
    override_if_exists: bool = False,
) -> Table:
    """
    Creates a new Iceberg table with the specified schema and properties.
    - Drops the existing table if `override_if_exists` is true and the table already
    exists.
    - Creates an unpartitioned table with custom commit retry properties.

    :param catalog: The Iceberg catalog to manage the table.
    :param table_namespace: The namespace of the table.
    :param table_name: The name of the table.
    :param table_schema: The schema of the table.
    :param override_if_exists: Whether to drop and recreate the table if it exists.
    :return: The created Iceberg table.
    """

    identifier = f"{table_namespace}.{table_name}"

    catalog.create_namespace_if_not_exists(table_namespace)

    if catalog.table_exists(identifier) and override_if_exists:
        catalog.drop_table(identifier)

    table = catalog.create_table(
        identifier=identifier,
        schema=table_schema,
        partition_spec=UNPARTITIONED_PARTITION_SPEC,
    )

    return table


def load_table_metadata(
    catalog: Catalog, table_namespace: str, table_name: str
) -> Optional[Table]:
    """
    Loads metadata for an existing Iceberg table.
    - Returns the table if it exists and is successfully loaded.
    - Returns None if the table does not exist or cannot be loaded.

    :param catalog: The Iceberg catalog to load the table from.
    :param table_namespace: The namespace of the table.
    :param table_name: The name of the table.
    :return: The table if found, or None if not found.
    """
    identifier = f"{table_namespace}.{table_name}"
    try:
        return catalog.load_table(identifier)
    except Exception:
        return None


def read_data_file_as_arrow_table(
    planfile: pyiceberg.table.FileScanTask, iceberg_table: pyiceberg.table.Table
) -> pa.Table:
    """Reads a data file as a pyarrow table and returns an iterator over its records."""
    arrow_table: pa.Table = ArrowScan(
        iceberg_table.metadata,
        iceberg_table.io,
        iceberg_table.schema(),
        AlwaysTrue(),
        True,
    ).to_table([planfile])
    return arrow_table


def _serialize_value_for_iceberg(value, attr_type: AttributeType):
    """
    Serialize a value for Iceberg storage.
    LIST and STRUCT types are serialized as JSON strings.
    """
    if value is None:
        return None
    if attr_type == AttributeType.LIST or attr_type == AttributeType.STRUCT:
        return json.dumps(value)
    return value


def amber_tuples_to_arrow_table(
    iceberg_schema: Schema, tuple_list: Iterable[Tuple], amber_schema=None
) -> pa.Table:
    """
    Converts a list of amber tuples to a pyarrow table for serialization.
    LIST and STRUCT values are serialized as JSON strings for Iceberg compatibility.

    :param iceberg_schema: The Iceberg schema for the table.
    :param tuple_list: The list of Amber tuples to convert.
    :param amber_schema: Optional Amber schema to determine attribute types.
                         If not provided, types are inferred from values.
    """
    tuple_list = list(tuple_list)  # Materialize to allow multiple iterations
    if not tuple_list:
        return pa.Table.from_pydict(
            {name: [] for name in iceberg_schema.as_arrow().names},
            schema=iceberg_schema.as_arrow(),
        )

    arrow_names = iceberg_schema.as_arrow().names
    result_dict = {}

    for name in arrow_names:
        values = [t[name] for t in tuple_list]
        # Determine attribute type from amber_schema or infer from first non-None value
        attr_type = None
        if amber_schema is not None and name in amber_schema:
            attr_type = amber_schema[name]
        else:
            # Infer type from first non-None value
            for v in values:
                if v is not None:
                    if isinstance(v, list):
                        attr_type = AttributeType.LIST
                    elif isinstance(v, dict):
                        attr_type = AttributeType.STRUCT
                    break

        # Serialize LIST/STRUCT values to JSON strings
        if attr_type in (AttributeType.LIST, AttributeType.STRUCT):
            values = [_serialize_value_for_iceberg(v, attr_type) for v in values]

        result_dict[name] = values

    return pa.Table.from_pydict(result_dict, schema=iceberg_schema.as_arrow())


def _deserialize_value_from_iceberg(value, is_nested_type: bool):
    """
    Deserialize a value from Iceberg storage.
    JSON strings for LIST/STRUCT types are deserialized to list/dict.
    """
    if value is None:
        return None
    if is_nested_type and isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def arrow_table_to_amber_tuples(
    iceberg_schema: Schema, arrow_table: pa.Table, amber_schema=None
) -> Iterable[Tuple]:
    """
    Converts an arrow table to a list of amber tuples for deserialization.
    JSON strings for LIST/STRUCT types are deserialized back to list/dict.

    :param iceberg_schema: The Iceberg schema for the table.
    :param arrow_table: The Arrow table to convert.
    :param amber_schema: Optional Amber schema to determine which fields are LIST/STRUCT.
                         If not provided, JSON deserialization is attempted for string fields.
    """
    tuple_provider = ArrowTableTupleProvider(arrow_table)
    arrow_schema = iceberg_schema.as_arrow()
    column_names = arrow_table.column_names

    # Determine which columns need JSON deserialization
    nested_columns = set()
    if amber_schema is not None:
        for name in column_names:
            if name in amber_schema and amber_schema[name] in (
                AttributeType.LIST,
                AttributeType.STRUCT,
            ):
                nested_columns.add(name)
    else:
        # Check arrow schema for string fields that might be serialized LIST/STRUCT
        for i, name in enumerate(column_names):
            field = arrow_schema.field(name)
            if pa.types.is_string(field.type) or pa.types.is_large_string(field.type):
                # Mark as potential nested type for JSON deserialization attempt
                nested_columns.add(name)

    for field_accessor in tuple_provider:
        tuple_dict = {}
        for name in column_names:
            value = field_accessor[name] if isinstance(field_accessor, dict) else getattr(field_accessor, name, None)
            if name in nested_columns:
                value = _deserialize_value_from_iceberg(value, True)
            tuple_dict[name] = value

        yield Tuple(tuple_dict, schema=core.models.Schema(arrow_schema))
