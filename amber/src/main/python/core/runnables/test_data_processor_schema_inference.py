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

"""
Tests for DataFrame-based schema inference in DataProcessor.

These tests verify that schema inference from pandas DataFrame dtypes
works correctly and produces consistent schemas across all rows.
"""

import datetime
import numpy as np
import pandas as pd
import pytest
from unittest.mock import MagicMock

from core.models.schema.attribute_type import AttributeType
from core.models.schema.schema import Schema
from core.runnables.data_processor import (
    DataProcessor,
    PANDAS_DTYPE_TO_ATTRIBUTE_TYPE,
)


class TestPandasDtypeMapping:
    """Tests for the PANDAS_DTYPE_TO_ATTRIBUTE_TYPE mapping."""

    def test_integer_types_map_to_long(self):
        """All integer types should map to LONG for safety."""
        integer_dtypes = [
            np.dtype("int8"),
            np.dtype("int16"),
            np.dtype("int32"),
            np.dtype("int64"),
            np.dtype("uint8"),
            np.dtype("uint16"),
            np.dtype("uint32"),
            np.dtype("uint64"),
        ]
        for dtype in integer_dtypes:
            assert PANDAS_DTYPE_TO_ATTRIBUTE_TYPE[dtype] == AttributeType.LONG, (
                f"Expected {dtype} to map to LONG"
            )

    def test_float_types_map_to_double(self):
        """All float types should map to DOUBLE."""
        float_dtypes = [
            np.dtype("float16"),
            np.dtype("float32"),
            np.dtype("float64"),
        ]
        for dtype in float_dtypes:
            assert PANDAS_DTYPE_TO_ATTRIBUTE_TYPE[dtype] == AttributeType.DOUBLE, (
                f"Expected {dtype} to map to DOUBLE"
            )

    def test_bool_type_maps_to_bool(self):
        """Boolean type should map to BOOL."""
        assert PANDAS_DTYPE_TO_ATTRIBUTE_TYPE[np.dtype("bool")] == AttributeType.BOOL

    def test_datetime_types_map_to_timestamp(self):
        """Datetime types should map to TIMESTAMP."""
        datetime_dtypes = [
            np.dtype("datetime64[ns]"),
            np.dtype("datetime64[us]"),
            np.dtype("datetime64[ms]"),
        ]
        for dtype in datetime_dtypes:
            assert PANDAS_DTYPE_TO_ATTRIBUTE_TYPE[dtype] == AttributeType.TIMESTAMP, (
                f"Expected {dtype} to map to TIMESTAMP"
            )


class TestMapPandasDtypeToAttributeType:
    """Tests for the _map_pandas_dtype_to_attribute_type method."""

    @pytest.fixture
    def data_processor(self):
        """Create a DataProcessor with a minimal mock context."""
        mock_context = MagicMock()
        return DataProcessor(mock_context)

    def test_standard_int64(self, data_processor):
        """Standard int64 should map to LONG."""
        dtype = np.dtype("int64")
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.LONG

    def test_standard_float64(self, data_processor):
        """Standard float64 should map to DOUBLE."""
        dtype = np.dtype("float64")
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.DOUBLE

    def test_standard_bool(self, data_processor):
        """Standard bool should map to BOOL."""
        dtype = np.dtype("bool")
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.BOOL

    def test_object_dtype_maps_to_string(self, data_processor):
        """Object dtype (typically strings) should map to STRING."""
        dtype = np.dtype("object")
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.STRING

    def test_nullable_int64(self, data_processor):
        """Nullable Int64 (pandas extension type) should map to LONG."""
        dtype = pd.Int64Dtype()
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.LONG

    def test_nullable_int32(self, data_processor):
        """Nullable Int32 (pandas extension type) should map to LONG."""
        dtype = pd.Int32Dtype()
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.LONG

    def test_nullable_uint64(self, data_processor):
        """Nullable UInt64 (pandas extension type) should map to LONG."""
        dtype = pd.UInt64Dtype()
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.LONG

    def test_nullable_boolean(self, data_processor):
        """Nullable boolean (pandas extension type) should map to BOOL."""
        dtype = pd.BooleanDtype()
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.BOOL

    def test_nullable_float64(self, data_processor):
        """Nullable Float64 (pandas extension type) should map to DOUBLE."""
        dtype = pd.Float64Dtype()
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.DOUBLE

    def test_string_dtype(self, data_processor):
        """Pandas StringDtype should map to STRING."""
        dtype = pd.StringDtype()
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.STRING

    def test_datetime64_ns(self, data_processor):
        """Datetime64[ns] should map to TIMESTAMP."""
        dtype = np.dtype("datetime64[ns]")
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.TIMESTAMP

    def test_categorical_maps_to_string(self, data_processor):
        """Categorical dtype should map to STRING."""
        dtype = pd.CategoricalDtype(categories=["a", "b", "c"])
        result = data_processor._map_pandas_dtype_to_attribute_type(dtype)
        assert result == AttributeType.STRING


class TestInferSchemaFromDataFrame:
    """Tests for the _infer_schema_from_dataframe method."""

    @pytest.fixture
    def data_processor(self):
        """Create a DataProcessor with a minimal mock context."""
        mock_context = MagicMock()
        return DataProcessor(mock_context)

    def test_simple_dataframe(self, data_processor):
        """Test schema inference from a simple DataFrame."""
        df = pd.DataFrame({
            "id": [1, 2, 3],
            "name": ["Alice", "Bob", "Charlie"],
            "score": [95.5, 87.0, 92.3],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_names() == ["id", "name", "score"]
        assert schema.get_attr_type("id") == AttributeType.LONG
        assert schema.get_attr_type("name") == AttributeType.STRING
        assert schema.get_attr_type("score") == AttributeType.DOUBLE

    def test_dataframe_with_boolean(self, data_processor):
        """Test schema inference with boolean column."""
        df = pd.DataFrame({
            "active": [True, False, True],
            "count": [1, 2, 3],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("active") == AttributeType.BOOL
        assert schema.get_attr_type("count") == AttributeType.LONG

    def test_dataframe_with_datetime(self, data_processor):
        """Test schema inference with datetime column."""
        df = pd.DataFrame({
            "timestamp": pd.to_datetime(["2023-01-01", "2023-01-02", "2023-01-03"]),
            "value": [10, 20, 30],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("timestamp") == AttributeType.TIMESTAMP
        assert schema.get_attr_type("value") == AttributeType.LONG

    def test_dataframe_with_nullable_integers(self, data_processor):
        """Test schema inference with nullable integer column (contains None)."""
        # Using nullable Int64 dtype
        df = pd.DataFrame({
            "id": pd.array([1, None, 3], dtype=pd.Int64Dtype()),
            "name": ["Alice", "Bob", "Charlie"],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("id") == AttributeType.LONG
        assert schema.get_attr_type("name") == AttributeType.STRING

    def test_dataframe_with_mixed_none_values(self, data_processor):
        """Test that DataFrame dtype handles None values correctly.

        This is the key test case that motivated the DataFrame-based inference:
        When a column has [1, None, 3], pandas knows it's a nullable integer,
        not just inferring from the first value.
        """
        # Standard approach: int column with None becomes float64 in pandas
        df = pd.DataFrame({
            "value": [1, None, 3],  # pandas converts to float64 due to None
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        # pandas represents int+None as float64, which maps to DOUBLE
        assert schema.get_attr_type("value") == AttributeType.DOUBLE

    def test_dataframe_with_explicit_nullable_int(self, data_processor):
        """Test with explicitly nullable integer type."""
        df = pd.DataFrame({
            "value": pd.array([1, None, 3], dtype="Int64"),
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        # Nullable Int64 should map to LONG
        assert schema.get_attr_type("value") == AttributeType.LONG

    def test_dataframe_preserves_column_order(self, data_processor):
        """Test that schema preserves DataFrame column order."""
        df = pd.DataFrame({
            "z_last": [1],
            "a_first": [2],
            "m_middle": [3],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        # Should preserve original order, not alphabetical
        assert schema.get_attr_names() == ["z_last", "a_first", "m_middle"]

    def test_empty_dataframe(self, data_processor):
        """Test schema inference from empty DataFrame with defined columns."""
        df = pd.DataFrame({
            "id": pd.Series([], dtype="int64"),
            "name": pd.Series([], dtype="object"),
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_names() == ["id", "name"]
        assert schema.get_attr_type("id") == AttributeType.LONG
        assert schema.get_attr_type("name") == AttributeType.STRING

    def test_dataframe_with_all_types(self, data_processor):
        """Test schema inference with all supported types."""
        df = pd.DataFrame({
            "int_col": pd.array([1, 2, 3], dtype="int64"),
            "float_col": pd.array([1.1, 2.2, 3.3], dtype="float64"),
            "str_col": ["a", "b", "c"],
            "bool_col": [True, False, True],
            "datetime_col": pd.to_datetime(["2023-01-01", "2023-01-02", "2023-01-03"]),
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("int_col") == AttributeType.LONG
        assert schema.get_attr_type("float_col") == AttributeType.DOUBLE
        assert schema.get_attr_type("str_col") == AttributeType.STRING
        assert schema.get_attr_type("bool_col") == AttributeType.BOOL
        assert schema.get_attr_type("datetime_col") == AttributeType.TIMESTAMP

    def test_dataframe_with_list_column(self, data_processor):
        """Test schema inference with list column (object dtype containing lists)."""
        df = pd.DataFrame({
            "id": [1, 2, 3],
            "tags": [["a", "b"], ["c"], ["d", "e", "f"]],  # List column
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("id") == AttributeType.LONG
        assert schema.get_attr_type("tags") == AttributeType.LIST

    def test_dataframe_with_struct_column(self, data_processor):
        """Test schema inference with dict/struct column (object dtype containing dicts)."""
        df = pd.DataFrame({
            "id": [1, 2, 3],
            "metadata": [{"key": "a"}, {"key": "b"}, {"key": "c"}],  # Dict column
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("id") == AttributeType.LONG
        assert schema.get_attr_type("metadata") == AttributeType.STRUCT

    def test_dataframe_with_mixed_nested_types(self, data_processor):
        """Test schema inference with multiple nested type columns."""
        df = pd.DataFrame({
            "name": ["Alice", "Bob", "Charlie"],
            "scores": [[90, 85], [88, 92], [95, 91]],  # List of ints
            "profile": [{"age": 25}, {"age": 30}, {"age": 28}],  # Dict
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        assert schema.get_attr_type("name") == AttributeType.STRING
        assert schema.get_attr_type("scores") == AttributeType.LIST
        assert schema.get_attr_type("profile") == AttributeType.STRUCT

    def test_dataframe_with_list_containing_none(self, data_processor):
        """Test list column with some None values."""
        df = pd.DataFrame({
            "tags": [["a", "b"], None, ["c", "d"]],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        # Should still detect as LIST from first non-null value
        assert schema.get_attr_type("tags") == AttributeType.LIST

    def test_dataframe_with_all_none_object_column(self, data_processor):
        """Test object column with all None values defaults to STRING."""
        df = pd.DataFrame({
            "unknown": [None, None, None],
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        # All nulls should default to STRING
        assert schema.get_attr_type("unknown") == AttributeType.STRING


class TestDataFrameVsTupleInference:
    """Tests comparing DataFrame-based inference vs tuple-based inference.

    These tests demonstrate why DataFrame-based inference is more reliable.
    """

    @pytest.fixture
    def data_processor(self):
        """Create a DataProcessor with a minimal mock context."""
        mock_context = MagicMock()
        return DataProcessor(mock_context)

    def test_dataframe_handles_none_in_int_column(self, data_processor):
        """DataFrame inference handles None in integer columns better.

        When using tuple-based inference, if the first tuple has an int
        and the second has None, there could be a type mismatch.
        DataFrame-based inference sees the whole column type.
        """
        # DataFrame with None in integer-intended column
        df = pd.DataFrame({
            "id": pd.array([1, None, 3], dtype="Int64"),  # Nullable integer
        })

        # DataFrame inference gives consistent type
        df_schema = data_processor._infer_schema_from_dataframe(df)
        assert df_schema.get_attr_type("id") == AttributeType.LONG

        # Tuple inference from first row would give LONG
        first_row = {"id": 1}
        tuple_schema = data_processor._infer_schema_from_tuple(first_row)
        assert tuple_schema.get_attr_type("id") == AttributeType.LONG

        # But second row has None - tuple inference would give STRING
        second_row = {"id": None}
        tuple_schema_none = data_processor._infer_schema_from_tuple(second_row)
        assert tuple_schema_none.get_attr_type("id") == AttributeType.STRING

        # This demonstrates why DataFrame inference is more reliable

    def test_dataframe_handles_int_float_mixed(self, data_processor):
        """DataFrame inference handles int/float mixing correctly.

        If first value is int (1) but column contains floats (1.5),
        DataFrame already knows the column is float64.
        """
        df = pd.DataFrame({
            "value": [1, 1.5, 2],  # pandas infers float64
        })

        # DataFrame inference correctly identifies as DOUBLE
        df_schema = data_processor._infer_schema_from_dataframe(df)
        assert df_schema.get_attr_type("value") == AttributeType.DOUBLE

        # Tuple inference from first row might think it's int
        # (depends on how pandas represents 1 vs 1.0)

    def test_schema_consistency_across_all_rows(self, data_processor):
        """Verify DataFrame inference produces schema consistent with all rows."""
        df = pd.DataFrame({
            "mixed": [1, 2.5, 3, None, 5.0],  # float64 in pandas
        })

        schema = data_processor._infer_schema_from_dataframe(df)

        # Should be DOUBLE because pandas sees the whole column
        assert schema.get_attr_type("mixed") == AttributeType.DOUBLE


class TestInferTypeFromObjectColumn:
    """Tests for the _infer_type_from_object_column method.

    This method uses pandas.api.types.infer_dtype to detect the actual type
    of values in object dtype columns, properly handling nulls and detecting
    truly mixed types.
    """

    @pytest.fixture
    def data_processor(self):
        """Create a DataProcessor with a minimal mock context."""
        mock_context = MagicMock()
        return DataProcessor(mock_context)

    # ==================== Basic types in object dtype columns ====================
    #
    # Note: This method is only called for columns with dtype='object'.
    # When pandas has [1, None, 2], it converts to float64, NOT object.
    # But when loaded from JSON or other sources, basic types can end up
    # in object dtype columns. We test those scenarios here.

    def test_integer_in_object_column(self, data_processor):
        """Integer values in object dtype column should be detected as LONG.

        Note: To create an object dtype column with integers, we need to
        explicitly set dtype=object or load from JSON-like sources.
        """
        # Force object dtype to simulate JSON loading
        column = pd.Series([1, 2, 3], dtype=object)
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LONG

    def test_float_in_object_column(self, data_processor):
        """Float values in object dtype column should be detected as DOUBLE."""
        column = pd.Series([1.5, 2.5, 3.5], dtype=object)
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.DOUBLE

    def test_boolean_with_nulls(self, data_processor):
        """Boolean column with None values should be detected as BOOL.

        Unlike int/float, booleans with None stay as object dtype in pandas.
        """
        column = pd.Series([True, None, False, None, True])
        # Verify it's actually object dtype
        assert column.dtype == object
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.BOOL

    def test_string_with_nulls(self, data_processor):
        """String column with None values should be detected as STRING."""
        column = pd.Series(["hello", None, "world", None, "test"])
        assert column.dtype == object
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_bytes_with_nulls(self, data_processor):
        """Bytes column with None values should be detected as BINARY."""
        column = pd.Series([b"hello", None, b"world", None])
        assert column.dtype == object
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.BINARY

    def test_datetime_in_object_column(self, data_processor):
        """Datetime values in object dtype column should be detected as TIMESTAMP."""
        # When datetimes are mixed with None in certain ways, they can be object dtype
        column = pd.Series([
            datetime.datetime(2023, 1, 1),
            None,
            datetime.datetime(2023, 1, 2),
            None
        ], dtype=object)
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.TIMESTAMP

    # ==================== List and Struct types ====================

    def test_list_column(self, data_processor):
        """Column of lists should be detected as LIST."""
        column = pd.Series([[1, 2], [3, 4], [5, 6]])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST

    def test_list_with_nulls(self, data_processor):
        """List column with None values should be detected as LIST."""
        column = pd.Series([[1, 2], None, [3, 4], None, [5, 6]])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST

    def test_dict_column(self, data_processor):
        """Column of dicts should be detected as STRUCT."""
        column = pd.Series([{"a": 1}, {"b": 2}, {"c": 3}])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRUCT

    def test_dict_with_nulls(self, data_processor):
        """Dict column with None values should be detected as STRUCT."""
        column = pd.Series([{"a": 1}, None, {"b": 2}, None])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRUCT

    def test_empty_list_column(self, data_processor):
        """Column of empty lists should be detected as LIST."""
        column = pd.Series([[], [], []])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST

    def test_empty_dict_column(self, data_processor):
        """Column of empty dicts should be detected as STRUCT."""
        column = pd.Series([{}, {}, {}])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRUCT

    # ==================== Mixed types (should return STRING) ====================

    def test_mixed_int_and_string(self, data_processor):
        """Mixed int and string should fall back to STRING."""
        column = pd.Series([1, "hello", 2, "world"])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_mixed_int_float_string(self, data_processor):
        """Mixed int, float, and string should fall back to STRING."""
        column = pd.Series([1, 2.5, "hello"])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_mixed_list_and_dict(self, data_processor):
        """Mixed list and dict should fall back to STRING."""
        column = pd.Series([[1, 2], {"a": 1}, [3, 4]])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_mixed_list_and_string(self, data_processor):
        """Mixed list and string should fall back to STRING."""
        column = pd.Series([[1, 2], "hello", [3, 4]])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_mixed_bool_and_string(self, data_processor):
        """Mixed bool and string should fall back to STRING."""
        column = pd.Series([True, "hello", False])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    # ==================== Special cases ====================

    def test_mixed_integer_float(self, data_processor):
        """Mixed int and float in object column should be detected as DOUBLE."""
        # Force object dtype to test the method directly
        column = pd.Series([1, 2.5, 3, 4.5], dtype=object)
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.DOUBLE

    def test_all_nulls(self, data_processor):
        """Column with all nulls should default to STRING."""
        column = pd.Series([None, None, None])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_empty_column(self, data_processor):
        """Empty column should default to STRING."""
        column = pd.Series([], dtype=object)
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRING

    def test_single_value_integer(self, data_processor):
        """Single integer value should be detected as LONG."""
        column = pd.Series([42])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LONG

    def test_single_value_list(self, data_processor):
        """Single list value should be detected as LIST."""
        column = pd.Series([[1, 2, 3]])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST

    # ==================== Real-world JSON data scenarios ====================

    def test_json_boolean_field_with_nulls(self, data_processor):
        """Simulates is_credit field from JSON: boolean with null values."""
        # This is the original problem case
        column = pd.Series([True, False, None, True, None, False])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.BOOL

    def test_json_list_field_with_nulls(self, data_processor):
        """Simulates merchant_category_code field from JSON: list with nulls."""
        column = pd.Series([
            [8000, 8011, 8021],
            None,
            [7299, 9399],
            [],
            None
        ])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST

    def test_json_nested_dict_field(self, data_processor):
        """Simulates a nested object field from JSON."""
        column = pd.Series([
            {"name": "Alice", "age": 30},
            {"name": "Bob", "age": 25},
            None,
            {"name": "Charlie", "age": 35}
        ])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.STRUCT

    def test_large_sample_list_consistency(self, data_processor):
        """Test that sampling works correctly for large columns of lists."""
        # Create a column with 200 lists (more than sample size of 100)
        column = pd.Series([[i, i+1] for i in range(200)])
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST

    def test_large_sample_with_trailing_mixed(self, data_processor):
        """Test that sampling only checks first 100, so trailing mixed types may not be detected.

        Note: This is a known limitation - we sample first 100 values for performance.
        If the first 100 are all lists but value 101+ are different types, we still return LIST.
        """
        # First 100 are lists, then strings
        data = [[i] for i in range(100)] + ["string" + str(i) for i in range(50)]
        column = pd.Series(data)
        # Since we sample first 100, all are lists, so result is LIST
        result = data_processor._infer_type_from_object_column(column)
        assert result == AttributeType.LIST  # Known limitation
