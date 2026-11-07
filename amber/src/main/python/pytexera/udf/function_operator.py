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

"""A Python function as an operator.

A team keeps the Python it reuses as functions:

    @returns(patient_id=str, time_in_range=float)
    def time_in_range(readings: pd.DataFrame, *, low: int = 70) -> pd.DataFrame:
        ...

The engine runs one as a table operator. Each worker calls the function once, with the rows it
got from each input as a DataFrame and the operator's settings as keyword arguments; when the
operator groups its rows (`by`), every group reaches one worker whole. What the function returns
is checked against its @returns and put out in that order.
"""

from abc import abstractmethod
from typing import Any, Callable, Dict, Iterator, List, Optional

import pandas

from core.models import Table, TableLike
from .udf_operator import UDFTableOperator


def returns(*, nondeterministic: bool = False, **columns: Any) -> Callable:
    """
    Name a function's output columns and their types: str, int, float, bool or datetime.
    With nondeterministic=True, say the function may give other rows for the same input,
    as one that samples without a seed, reads the clock or calls out does: no run reuses
    its rows. The catalog reads both from the code when the operator is saved; at run time
    the function stays as it is.
    """

    def mark(function: Callable) -> Callable:
        function.__texera_returns__ = columns
        function.__texera_nondeterministic__ = nondeterministic
        return function

    return mark


def _missing(value: Any) -> bool:
    try:
        return bool(pandas.isna(value))
    except (TypeError, ValueError):
        return False


def conform(name: str, out: Any, columns: List[List[str]]) -> pandas.DataFrame:
    """
    What a function returned, as its operator puts it out: its declared columns in their
    order, doubles as floats and text as str, a missing value as None. Anything else it
    returned is an error that names what was declared and what came back.
    """
    if not isinstance(out, pandas.DataFrame):
        raise TypeError(f"{name} returned {type(out).__name__}, not a pandas DataFrame")
    declared = [column for column, _ in columns]
    got = [str(column) for column in out.columns]
    if sorted(got) != sorted(declared):
        in_index = [n for n in out.index.names if n in declared and n not in got]
        hint = (
            f"; {', '.join(in_index)} {'is' if len(in_index) == 1 else 'are'} in its "
            "index: call reset_index() on what it returns"
            if in_index
            else ""
        )
        raise ValueError(
            f"{name} returned the columns {got}, but its @returns declares {declared}{hint}"
        )
    out = out[declared].copy()
    for column, kind in columns:
        if kind == "double":
            try:
                out[column] = out[column].astype("float64")
            except (TypeError, ValueError) as error:
                raise ValueError(
                    f"{name}: column {column} is declared float, but holds {error}"
                ) from error
        elif kind in ("string", "timestamp"):
            # Built as objects: a datetime column would turn None back into NaT.
            out[column] = pandas.Series(
                [
                    None if _missing(v) else (str(v) if kind == "string" else v)
                    for v in out[column]
                ],
                index=out.index,
                dtype=object,
            )
    return out


class FunctionOperator(UDFTableOperator):
    """
    Runs `function` as a table operator. The class the engine makes for an operator sets
    what it runs: the function, its declared columns as [name, type] pairs in order, the
    keyword arguments, how many inputs it reads, and whether its rows are grouped.
    """

    columns: List[List[str]] = []
    arguments: Dict[str, Any] = {}
    inputs: int = 1
    grouped: bool = False

    @staticmethod
    @abstractmethod
    def function(*tables: pandas.DataFrame, **settings: Any) -> pandas.DataFrame:
        """The function the operator is."""

    def _tables(self) -> Dict[int, pandas.DataFrame]:
        if "_function_tables" not in self.__dict__:
            self._function_tables = {}
        return self._function_tables

    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        tables = self._tables()
        tables[port] = pandas.DataFrame(table)
        if len(tables) < self.inputs:
            yield None
            return
        ordered = [tables[i] for i in range(self.inputs)]
        if self.grouped and all(t.empty for t in ordered):
            # A worker no group went to has nothing to call the function on.
            yield None
            return
        name = getattr(self.function, "__name__", "the function")
        yield conform(name, self.function(*ordered, **self.arguments), self.columns)
