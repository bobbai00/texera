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

import datetime
import pyarrow as pa
from bidict import bidict
from enum import Enum
from pyarrow import lib


class AttributeType(Enum):
    """
    Types supported by PyTexera & PyAmber.

    The definitions are mapped and following the AttributeType.java
    (src/main/scala/org/apache/texera/workflow/common/tuple/schema/AttributeType.java)
    """

    STRING = 1
    INT = 2
    LONG = 3
    BOOL = 4
    DOUBLE = 5
    TIMESTAMP = 6
    BINARY = 7
    # Nested types for complex data structures
    LIST = 8
    STRUCT = 9


RAW_TYPE_MAPPING = bidict(
    {
        "STRING": AttributeType.STRING,
        "INTEGER": AttributeType.INT,
        "LONG": AttributeType.LONG,
        "DOUBLE": AttributeType.DOUBLE,
        "BOOLEAN": AttributeType.BOOL,
        "TIMESTAMP": AttributeType.TIMESTAMP,
        "BINARY": AttributeType.BINARY,
        "LIST": AttributeType.LIST,
        "STRUCT": AttributeType.STRUCT,
    }
)

TO_ARROW_MAPPING = {
    AttributeType.INT: pa.int32(),
    AttributeType.LONG: pa.int64(),
    AttributeType.STRING: pa.string(),
    AttributeType.DOUBLE: pa.float64(),
    AttributeType.BOOL: pa.bool_(),
    AttributeType.BINARY: pa.binary(),
    AttributeType.TIMESTAMP: pa.timestamp("us"),
    # For nested types, store as JSON strings for Iceberg compatibility
    # This matches the Scala implementation where LIST/STRUCT are serialized as JSON
    AttributeType.LIST: pa.string(),
    AttributeType.STRUCT: pa.string(),
}

FROM_ARROW_MAPPING = {
    lib.Type_INT32: AttributeType.INT,
    lib.Type_INT64: AttributeType.LONG,
    lib.Type_STRING: AttributeType.STRING,
    lib.Type_LARGE_STRING: AttributeType.STRING,
    lib.Type_DOUBLE: AttributeType.DOUBLE,
    lib.Type_BOOL: AttributeType.BOOL,
    lib.Type_BINARY: AttributeType.BINARY,
    lib.Type_LARGE_BINARY: AttributeType.BINARY,
    lib.Type_TIMESTAMP: AttributeType.TIMESTAMP,
    # Nested types
    lib.Type_LIST: AttributeType.LIST,
    lib.Type_LARGE_LIST: AttributeType.LIST,
    lib.Type_STRUCT: AttributeType.STRUCT,
    lib.Type_MAP: AttributeType.STRUCT,  # Map is treated as STRUCT (key-value pairs)
}


# Only single-directional mapping.
TO_PYOBJECT_MAPPING = {
    AttributeType.STRING: str,
    AttributeType.INT: int,
    AttributeType.LONG: int,  # Python3 unifies long into int.
    AttributeType.DOUBLE: float,
    AttributeType.BOOL: bool,
    AttributeType.BINARY: bytes,
    AttributeType.TIMESTAMP: datetime.datetime,
    AttributeType.LIST: list,
    AttributeType.STRUCT: dict,
}

FROM_PYOBJECT_MAPPING = {
    str: AttributeType.STRING,
    int: AttributeType.INT,
    float: AttributeType.DOUBLE,
    bool: AttributeType.BOOL,
    bytes: AttributeType.BINARY,
    datetime.datetime: AttributeType.TIMESTAMP,
    list: AttributeType.LIST,
    dict: AttributeType.STRUCT,
}


def coerce_value_to_type(value, target_type: AttributeType):
    """
    Coerce a value to match the target AttributeType.

    This is useful when schema inference doesn't match the actual data types,
    allowing values to be converted rather than causing validation errors.

    :param value: The value to coerce
    :param target_type: The target AttributeType
    :return: The coerced value
    :raises ValueError: If the value cannot be coerced to the target type
    """
    import json

    if value is None:
        return None

    expected_py_type = TO_PYOBJECT_MAPPING.get(target_type)
    if expected_py_type is None:
        return value

    # Already the correct type
    if isinstance(value, expected_py_type):
        return value

    try:
        if target_type == AttributeType.STRING:
            if isinstance(value, (list, dict)):
                return json.dumps(value)
            return str(value)

        elif target_type == AttributeType.BOOL:
            if isinstance(value, str):
                lower = value.lower()
                if lower in ("true", "1", "yes"):
                    return True
                elif lower in ("false", "0", "no", ""):
                    return False
            return bool(value)

        elif target_type in (AttributeType.INT, AttributeType.LONG):
            if isinstance(value, bool):
                # bool is subclass of int, but we want explicit conversion
                return 1 if value else 0
            return int(value)

        elif target_type == AttributeType.DOUBLE:
            return float(value)

        elif target_type == AttributeType.BINARY:
            if isinstance(value, str):
                return value.encode("utf-8")
            return bytes(value)

        elif target_type == AttributeType.TIMESTAMP:
            if isinstance(value, str):
                # Try parsing ISO format
                return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            elif isinstance(value, (int, float)):
                # Assume Unix timestamp
                return datetime.datetime.fromtimestamp(value)
            return value

        elif target_type == AttributeType.LIST:
            if isinstance(value, str):
                # Try parsing as JSON
                return json.loads(value)
            return list(value)

        elif target_type == AttributeType.STRUCT:
            if isinstance(value, str):
                # Try parsing as JSON
                return json.loads(value)
            return dict(value)

        return value

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise ValueError(
            f"Cannot coerce value {value!r} ({type(value).__name__}) "
            f"to {target_type}: {e}"
        )
