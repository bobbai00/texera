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
import pandas
import pickle
import pytest
from pandas import RangeIndex

from core.models import Table, Tuple
from core.models.table import deduplicate_columns


class TestTable:
    @pytest.fixture
    def a_timestamp(self):
        return datetime.datetime.now()

    @pytest.fixture
    def target_raw_tuples(self, a_timestamp):
        return [
            {
                "field1": 1,
                "field2": "hello",
                "field3": 2.3,
                "field4": True,
                "field5": a_timestamp,
                "field6": b"some binary",
                "7_special-name": None,
                "none": None,
            },
            {
                "field1": 2,
                "field2": "world",
                "field3": 0.0,
                "field4": False,
                "field5": datetime.datetime.fromtimestamp(1000000000),
                "field6": pickle.dumps([1, 2, 3]),
                "7_special-name": "a strange value",
                "none": None,
            },
        ]

    @pytest.fixture
    def target_tuples(self, target_raw_tuples):
        return [Tuple(raw_tuple) for raw_tuple in target_raw_tuples]

    @pytest.fixture
    def target_table(self, target_raw_tuples):
        return Table(target_raw_tuples)

    @pytest.fixture
    def target_data_frame(self, a_timestamp):
        return pandas.DataFrame(
            {
                "field1": [1, 2],
                "field2": ["hello", "world"],
                "field3": [2.3, 0.0],
                "field4": [True, False],
                "field5": [
                    a_timestamp,
                    datetime.datetime.fromtimestamp(1000000000),
                ],
                "field6": [b"some binary", pickle.dumps([1, 2, 3])],
                "7_special-name": [None, "a strange value"],
                "none": [None, None],
            },
            columns=[
                "field1",
                "field2",
                "field3",
                "field4",
                "field5",
                "field6",
                "7_special-name",
                "none",
            ],
        )

    def test_table_creation(self, target_table, a_timestamp):
        assert target_table["field1"][0] == 1
        assert target_table["field1"][1] == 2
        assert target_table["field2"][0] == "hello"
        assert target_table["field2"][1] == "world"
        assert target_table["field3"][0] == 2.3
        assert target_table["field3"][1] == 0.0
        assert target_table["field4"][0]
        assert not target_table["field4"][1]
        assert target_table["field5"][0] == a_timestamp
        assert target_table["field5"][1] == datetime.datetime.fromtimestamp(1000000000)
        assert target_table["field6"][0] == b"some binary"
        assert target_table["field6"][1] == pickle.dumps([1, 2, 3])
        assert target_table["7_special-name"][0] is None
        assert target_table["7_special-name"][1] == "a strange value"
        assert target_table["none"][0] is None
        assert target_table["none"][1] is None

    def test_as_tuples_preserve_types(self, target_table, target_tuples):
        assert list(target_table.as_tuples()) == target_tuples

    def test_table_from_data_frame(self, target_table, target_data_frame):
        assert Table(target_data_frame) == target_table

    def test_table_from_list_of_tuples(self, target_table, target_tuples):
        table = Table(target_tuples)
        assert table == target_table
        assert list(table.as_tuples()) == target_tuples

    def test_table_from_list_of_series(
        self, target_table, a_timestamp, target_raw_tuples, target_tuples
    ):
        table = Table([pandas.Series(raw_tuple) for raw_tuple in target_raw_tuples])

        assert table == target_table
        assert list(table.as_tuples()) == target_tuples

    def test_table_from_table(self, target_table, target_tuples):
        table = Table(target_table)
        assert table == target_table
        assert list(table.as_tuples()) == target_tuples

    def test_use_table_as_data_frame(self, target_table, target_data_frame):
        df = target_table
        assert (df.index == RangeIndex(start=0, stop=2, step=1)).all()
        concat_df = pandas.concat([df, df])
        assert len(concat_df) == 4
        assert target_table.equals(target_data_frame)

    def test_validation_of_schema(self):
        with pytest.raises(AssertionError):
            Table([{"text": "hello"}, {"book": "harry"}])


class TestDeduplicateColumns:
    def test_no_duplicates(self):
        cols = ["a", "b", "c"]
        new_cols, rename_map = deduplicate_columns(cols)
        assert new_cols == ["a", "b", "c"]
        assert rename_map is None

    def test_simple_duplicate(self):
        cols = ["a", "b", "a"]
        new_cols, rename_map = deduplicate_columns(cols)
        assert new_cols == ["a", "b", "a.1"]
        assert rename_map is not None

    def test_multiple_same_name(self):
        cols = ["x", "x", "x", "x"]
        new_cols, rename_map = deduplicate_columns(cols)
        assert new_cols == ["x", "x.1", "x.2", "x.3"]

    def test_multiple_different_duplicates(self):
        cols = ["a", "b", "a", "b", "c"]
        new_cols, rename_map = deduplicate_columns(cols)
        assert new_cols == ["a", "b", "a.1", "b.1", "c"]

    def test_suffix_collision(self):
        # "a.1" already exists as an original column name, so the first
        # duplicate of "a" must skip ".1" and use ".2"
        cols = ["a", "a.1", "a"]
        new_cols, rename_map = deduplicate_columns(cols)
        assert new_cols[0] == "a"
        assert new_cols[1] == "a.1"
        assert new_cols[2] == "a.2"


class TestTableDuplicateColumns:
    def test_as_tuples_with_duplicate_columns(self):
        """DataFrame with duplicate columns should preserve all values."""
        df = pandas.DataFrame([[1, 2, 3]], columns=["a", "b", "a"])
        table = Table(df)
        tuples = list(table.as_tuples())
        assert len(tuples) == 1
        fields = tuples[0].as_dict()
        assert len(fields) == 3
        assert fields["a"] == 1
        assert fields["b"] == 2
        assert fields["a.1"] == 3

    def test_as_tuples_multiple_rows_with_duplicates(self):
        """Multiple rows with triple duplicate columns."""
        df = pandas.DataFrame(
            [[1, 2, 3], [4, 5, 6]],
            columns=["col", "col", "col"],
        )
        table = Table(df)
        tuples = list(table.as_tuples())
        assert len(tuples) == 2

        row0 = tuples[0].as_dict()
        assert row0["col"] == 1
        assert row0["col.1"] == 2
        assert row0["col.2"] == 3

        row1 = tuples[1].as_dict()
        assert row1["col"] == 4
        assert row1["col.1"] == 5
        assert row1["col.2"] == 6
