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

import pyarrow as pa
import rpy2.robjects as robjects
import typing
from rpy2.robjects import default_converter
from rpy2.robjects.conversion import localconverter as local_converter
from rpy2_arrow.arrow import rarrow_to_py_table, converter as arrow_converter
from typing import Iterator, Optional, Union

from core.models import (
    ArrowTableTupleProvider,
    Tuple,
    TupleLike,
    Table,
    TableLike,
    r_utils,
)
from core.models.operator import SourceOperator, TableOperator


class RTableExecutor(TableOperator):
    """
    An executor that can execute R code on Arrow tables.
    """

    is_source = False

    _arrow_to_r_dataframe = robjects.r(
        "function(table) { return (as.data.frame(table)) }"
    )

    _r_dataframe_to_arrow = robjects.r(
        """
        library(arrow)
        function(df) { return (arrow::as_arrow_table(df)) }
        """
    )

    # BigObject column conversion helpers
    _wrap_big_object_cols = robjects.r(
        """
        function(df, cols) {
            for (col in cols) {
                df[[col]] <- new_BigObjectPointerColumn(lapply(df[[col]], function(uri) {
                    if (is.na(uri) || is.null(uri) || nchar(uri) == 0) NA else BigObjectPointer$new(uri)
                }))
            }
            df
        }
    """
    )

    _unwrap_big_object_cols = robjects.r(
        """
        function(df, cols) {
            for (col in cols) {
                vals <- if (inherits(df[[col]], "BigObjectPointerColumn")) unclass(df[[col]]) else df[[col]]
                df[[col]] <- sapply(vals, function(obj) {
                    if (is.na(obj) || is.null(obj)) NA_character_
                    else if (inherits(obj, "BigObjectPointer")) obj$uri
                    else as.character(obj)
                })
            }
            df
        }
    """
    )

    def __init__(self, r_code: str):
        """
        Initialize the RTableExecutor with R code.

        Args:
            r_code (str): R code to be executed.
        """
        super().__init__()
        with local_converter(default_converter):
            self._func: typing.Callable[[pa.Table], pa.Table] = robjects.r(r_code)

    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        """
        Process an input Table using the provided R function.
        The Table is represented as a pandas.DataFrame.

        :param table: Table, a table to be processed.
        :param port: int, input port index of the current Tuple.
            Currently unused in R-UDF
        :return: Iterator[Optional[TableLike]], producing one TableLike object at a
        time, or None.
        """
        from core.models.schema.big_object_pointer import BigObjectPointer
        from core.models.schema import Schema, AttributeType
        from core.models.schema.attribute_type import FROM_ARROW_MAPPING

        # Step 1: Identify and serialize BigObjectPointer → URI strings for input
        input_big_object_cols = [
            col
            for col in table.columns
            if len(table[col]) > 0 and isinstance(table[col].iloc[0], BigObjectPointer)
        ]

        if input_big_object_cols:
            table = table.copy()
            for col in input_big_object_cols:
                table[col] = table[col].apply(
                    lambda x: x.uri if isinstance(x, BigObjectPointer) else x
                )

        # Step 2: Python → R conversion and execution
        with local_converter(arrow_converter):
            # Convert pandas → Arrow → R dataframe
            arrow_table = pa.Table.from_pandas(table)
            r_df = RTableExecutor._arrow_to_r_dataframe(arrow_table)

            # Wrap input BIG_OBJECT columns as BigObjectPointer for R UDF
            if input_big_object_cols:
                r_df = RTableExecutor._wrap_big_object_cols(r_df, input_big_object_cols)

            # Execute user's R function
            r_df = self._func(r_df, port)

            # Detect which OUTPUT columns are BIG_OBJECT
            output_big_object_cols = list(
                robjects.r(
                    'function(df) names(df)[sapply(df, inherits, "BigObjectPointerColumn")]'
                )(r_df)
            )

            # Unwrap output BIG_OBJECT columns to URI strings for Python
            if output_big_object_cols:
                r_df = RTableExecutor._unwrap_big_object_cols(
                    r_df, output_big_object_cols
                )

            # Convert R dataframe → Arrow → pandas
            arrow_table = rarrow_to_py_table(RTableExecutor._r_dataframe_to_arrow(r_df))

        # Step 3: Build output schema with correct BIG_OBJECT type information
        output_schema = Schema()
        for col in arrow_table.column_names:
            attr_type = (
                AttributeType.BIG_OBJECT
                if col in output_big_object_cols
                else FROM_ARROW_MAPPING[arrow_table.schema.field(col).type.id]
            )
            output_schema.add(col, attr_type)

        # Step 4: Create Arrow table with metadata and yield Tuples
        arrow_with_metadata = pa.Table.from_pandas(
            arrow_table.to_pandas(), schema=output_schema.as_arrow_schema()
        )

        for field_accessor in ArrowTableTupleProvider(arrow_with_metadata):
            yield Tuple(
                {name: field_accessor for name in arrow_with_metadata.column_names}
            )


class RTableSourceExecutor(SourceOperator):
    """
    A source operator that produces an R Table or Table-like object using R code.
    """

    is_source = True
    _source_output_to_arrow = robjects.r(
        """
    library(arrow)
    function(source_output) {
        return (arrow::as_arrow_table(as.data.frame(source_output)))
    }
    """
    )

    def __init__(self, r_code: str):
        """
        Initialize the RTableSourceExecutor with R code.

        Args:
            r_code (str): R code to be executed.
        """
        super().__init__()
        # Use the local converter from rpy2 to load in the R function given by the user
        with local_converter(default_converter):
            self._func = robjects.r(r_code)

    def produce(self) -> Iterator[Union[TupleLike, TableLike, None]]:
        """
        Produce Table using the provided R function.
        Used by the source operator only.

        :return: Iterator[Union[TupleLike, TableLike, None]], producing
            one TupleLike object, one TableLike object, or None, at a time.
        """
        with local_converter(arrow_converter):
            output_table = self._func()
            output_rarrow_table = RTableSourceExecutor._source_output_to_arrow(
                output_table
            )
            output_pyarrow_table = rarrow_to_py_table(output_rarrow_table)

        for field_accessor in ArrowTableTupleProvider(output_pyarrow_table):
            yield Tuple(
                {name: field_accessor for name in output_pyarrow_table.column_names}
            )
