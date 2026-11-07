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

import inspect
import json

import pandas
import pytest

from core.architecture.managers.executor_manager import ExecutorManager
from core.models import Table
from pytexera import FunctionOperator, returns
from pytexera.udf.function_operator import conform

USER_CODE = '''import pandas as pd

@returns(patient_id=str, time_in_range=float, readings=int)
def time_in_range(readings: pd.DataFrame, *, low: int = 70, high: int = 180) -> pd.DataFrame:
    """The share of each patient's readings in range."""
    g = readings.groupby("patient_id")["glucose"]
    return pd.DataFrame({
        "readings": g.size(),
        "time_in_range": g.apply(lambda s: s.between(low, high).mean()),
    }).reset_index()
'''


def generated(code: str, function: str, columns, arguments, inputs=1, grouped=False):
    """The module the engine runs for a function operator, as the engine writes it."""
    return (
        "from pytexera import *\n"
        "from pytexera import FunctionOperator, returns\n\n"
        f"{code}\n\n"
        "class ProcessTableOperator(FunctionOperator):\n"
        f"    function = staticmethod({function})\n"
        f"    columns = __import__('json').loads({json.dumps(json.dumps(columns))})\n"
        f"    arguments = __import__('json').loads({json.dumps(json.dumps(arguments))})\n"
        f"    inputs = {inputs}\n"
        f"    grouped = {grouped}\n"
    )


READINGS = pandas.DataFrame(
    {
        "patient_id": ["P-1", "P-1", "P-1", "P-2", "P-2"],
        "glucose": [64, 120, 200, 99, 101],
    }
)
COLUMNS = [["patient_id", "string"], ["time_in_range", "double"], ["readings", "long"]]


def run(operator, *tables):
    out = []
    for port, table in enumerate(tables):
        out.extend(
            x for x in operator.process_table(Table(table), port) if x is not None
        )
    return out


class TestFunctionOperator:
    def test_the_engines_module_loads_as_one_operator_that_calls_the_function(self):
        manager = ExecutorManager()
        try:
            cls = manager.load_executor_definition(
                generated(
                    USER_CODE,
                    "time_in_range",
                    COLUMNS,
                    {"low": 100, "high": 180},
                    grouped=True,
                )
            )
        finally:
            manager.close()
        assert cls.__name__ == "ProcessTableOperator"
        assert inspect.isabstract(FunctionOperator) and not inspect.isabstract(cls)
        [out] = run(cls(), READINGS)
        # In the declared order, whatever order the function put its columns in.
        assert list(out.columns) == ["patient_id", "time_in_range", "readings"]
        # In [100, 180]: 120 of P-1's three readings, 101 of P-2's two.
        assert out.to_dict("records") == [
            {"patient_id": "P-1", "time_in_range": 1 / 3, "readings": 3},
            {"patient_id": "P-2", "time_in_range": 0.5, "readings": 2},
        ]
        assert str(out["time_in_range"].dtype) == "float64"

    def test_two_inputs_are_called_together_once_both_have_arrived(self):
        def pair(left, right, *, on="patient_id"):
            return left.merge(right, on=on)

        class Pair(FunctionOperator):
            function = staticmethod(pair)
            columns = [
                ["patient_id", "string"],
                ["glucose", "double"],
                ["a1c", "double"],
            ]
            arguments = {"on": "patient_id"}
            inputs = 2

        labs = pandas.DataFrame({"patient_id": ["P-1"], "a1c": [7.4]})
        operator = Pair()
        assert [x for x in operator.process_table(Table(READINGS), 0)] == [None]
        [out] = [x for x in operator.process_table(Table(labs), 1) if x is not None]
        assert out["glucose"].tolist() == [64.0, 120.0, 200.0]

    def test_a_worker_without_a_group_calls_nothing_and_one_without_by_calls_on_empty(
        self,
    ):
        calls = []

        def count(rows):
            calls.append(len(rows))
            return pandas.DataFrame({"n": [len(rows)]})

        class Grouped(FunctionOperator):
            function = staticmethod(count)
            columns = [["n", "long"]]
            grouped = True

        class Whole(Grouped):
            grouped = False

        empty = READINGS.iloc[0:0]
        assert run(Grouped(), empty) == []
        [out] = run(Whole(), empty)
        assert out["n"].tolist() == [0] and calls == [0]

    def test_what_disagrees_with_returns_fails_naming_both(self):
        with pytest.raises(ValueError) as wrong:
            conform(
                "f",
                pandas.DataFrame({"patient_id": ["P-1"], "tir": [0.5]}),
                COLUMNS[:2],
            )
        assert str(wrong.value) == (
            "f returned the columns ['patient_id', 'tir'], but its @returns declares "
            "['patient_id', 'time_in_range']"
        )
        indexed = pandas.DataFrame(
            {"time_in_range": [0.5]}, index=pandas.Index(["P-1"], name="patient_id")
        )
        with pytest.raises(
            ValueError, match="patient_id is in its index: call reset_index"
        ):
            conform("f", indexed, COLUMNS[:2])
        with pytest.raises(
            TypeError, match="f returned Series, not a pandas DataFrame"
        ):
            conform("f", READINGS["glucose"], COLUMNS[:2])
        with pytest.raises(ValueError, match="column time_in_range is declared float"):
            conform(
                "f",
                pandas.DataFrame({"patient_id": ["P-1"], "time_in_range": ["high"]}),
                COLUMNS[:2],
            )

    def test_text_and_times_are_values_or_none(self):
        frame = pandas.DataFrame(
            {"id": [7, None], "at": [pandas.Timestamp("2026-11-01 23:30"), pandas.NaT]}
        )
        out = conform("f", frame, [["id", "string"], ["at", "timestamp"]])
        assert out.to_dict("records") == [
            {"id": "7.0", "at": pandas.Timestamp("2026-11-01 23:30")},
            {"id": None, "at": None},
        ]

    def test_returns_leaves_the_function_as_it_is(self):
        @returns(n=int)
        def f(rows):
            return rows

        assert f(1) == 1 and f.__texera_returns__ == {"n": int}
