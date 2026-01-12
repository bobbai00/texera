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

import os
import sys
import traceback
import pandas
import numpy as np
from loguru import logger
from threading import Event
from typing import Iterator, List, Optional

from core.architecture.managers import Context
from core.data_processing_config import DataProcessingConfig
from core.models import ExceptionInfo, State, TupleLike, InternalMarker, Tuple, Schema
from core.models.internal_marker import StartChannel, EndChannel
from core.models.schema.attribute_type import AttributeType, FROM_PYOBJECT_MAPPING
from core.models.table import all_output_to_tuple

# Mapping from pandas/numpy dtypes to AttributeType
# This provides more accurate schema inference from DataFrames
PANDAS_DTYPE_TO_ATTRIBUTE_TYPE = {
    # Integer types - use LONG for safety (64-bit)
    np.dtype("int8"): AttributeType.LONG,
    np.dtype("int16"): AttributeType.LONG,
    np.dtype("int32"): AttributeType.LONG,
    np.dtype("int64"): AttributeType.LONG,
    np.dtype("uint8"): AttributeType.LONG,
    np.dtype("uint16"): AttributeType.LONG,
    np.dtype("uint32"): AttributeType.LONG,
    np.dtype("uint64"): AttributeType.LONG,
    # Float types
    np.dtype("float16"): AttributeType.DOUBLE,
    np.dtype("float32"): AttributeType.DOUBLE,
    np.dtype("float64"): AttributeType.DOUBLE,
    # Boolean
    np.dtype("bool"): AttributeType.BOOL,
    # Datetime
    np.dtype("datetime64[ns]"): AttributeType.TIMESTAMP,
    np.dtype("datetime64[us]"): AttributeType.TIMESTAMP,
    np.dtype("datetime64[ms]"): AttributeType.TIMESTAMP,
    # Bytes
    np.dtype("bytes"): AttributeType.BINARY,
}
from core.util import Stoppable
from core.util.console_message.replace_print import replace_print
from core.util.console_message.timestamp import current_time_in_local_timezone
from core.util.runnable.runnable import Runnable
from proto.org.apache.amber.engine.architecture.rpc import (
    ConsoleMessage,
    ConsoleMessageType,
)


class DataProcessor(Runnable, Stoppable):
    def __init__(self, context: Context):
        self._running = Event()
        self._context = context
        self._schema_inferred = False  # Track if schema inference has been done

    def run(self) -> None:
        """
        Start the data processing loop. Wait for context switch conditions to be met,
        then continuously process markers or tuples until stopped.
        """
        with self._context.tuple_processing_manager.context_switch_condition:
            self._context.tuple_processing_manager.context_switch_condition.wait()
        self._running.set()
        self._switch_context()
        while self._running.is_set():
            marker = self._context.tuple_processing_manager.get_internal_marker()
            state = self._context.state_processing_manager.get_input_state()
            tuple_ = self._context.tuple_processing_manager.current_input_tuple
            if marker is not None:
                self.process_internal_marker(marker)
            elif state is not None:
                self.process_state(state)
            elif tuple_ is not None:
                self.process_tuple()
            else:
                raise RuntimeError("No marker or tuple to process.")
            self._switch_context()

    def process_internal_marker(self, internal_marker: InternalMarker) -> None:
        try:
            executor = self._context.executor_manager.executor
            port_id = self._context.tuple_processing_manager.get_input_port_id()
            with replace_print(
                self._context.worker_id,
                self._context.console_message_manager.print_buf,
            ):
                if isinstance(internal_marker, StartChannel):
                    self._set_output_state(executor.produce_state_on_start(port_id))
                elif isinstance(internal_marker, EndChannel):
                    self._set_output_state(executor.produce_state_on_finish(port_id))
                    self._switch_context()
                    self._set_output_tuple(executor.on_finish(port_id))

        except Exception as err:
            logger.exception(err)
            exc_info = sys.exc_info()
            self._context.exception_manager.set_exception_info(exc_info)
            self._report_exception(exc_info)

        finally:
            self._switch_context()

    def process_state(self, state: State) -> None:
        """
        Process an input marker by invoking appropriate state
        or tuple generation based on the marker type.
        """
        try:
            executor = self._context.executor_manager.executor
            port_id = self._context.tuple_processing_manager.get_input_port_id()
            with replace_print(
                self._context.worker_id,
                self._context.console_message_manager.print_buf,
            ):
                self._set_output_state(executor.process_state(state, port_id))

        except Exception as err:
            logger.exception(err)
            exc_info = sys.exc_info()
            self._context.exception_manager.set_exception_info(exc_info)
            self._report_exception(exc_info)

        finally:
            self._switch_context()

    def process_tuple(self) -> None:
        """
        Process an input tuple by invoking the executor's tuple processing method.
        """
        finished_current = self._context.tuple_processing_manager.finished_current
        while not finished_current.is_set():
            try:
                executor = self._context.executor_manager.executor
                port_id = self._context.tuple_processing_manager.get_input_port_id()
                tuple_ = self._context.tuple_processing_manager.get_input_tuple()
                with replace_print(
                    self._context.worker_id,
                    self._context.console_message_manager.print_buf,
                ):
                    self._set_output_tuple(executor.process_tuple(tuple_, port_id))

            except Exception as err:
                logger.exception(err)
                exc_info = sys.exc_info()
                self._context.exception_manager.set_exception_info(exc_info)
                self._report_exception(exc_info)

            finally:
                self._switch_context()

    def _set_output_tuple(self, output_iterator: Iterator[Optional[TupleLike]]) -> None:
        """
        Set the output tuple after processing by the executor.

        Uses batched context switching to reduce overhead:
        - When batch_size=1: Original behavior (context switch per tuple)
        - When batch_size>1: Accumulate tuples before switching to reduce overhead

        Schema inference strategy:
        - For DataFrame outputs: Use df.dtypes for accurate schema inference
        - For tuple outputs: Fall back to inferring from first tuple's values
        """
        batch_size = DataProcessingConfig.output_batch_size
        output_batch: List[Optional[Tuple]] = []

        for output in output_iterator:
            # output could be a None, a TupleLike, or a TableLike (DataFrame).

            # For DataFrame outputs, infer schema from dtypes BEFORE converting to tuples
            # This is more reliable because DataFrame dtypes are consistent across all rows
            if not self._schema_inferred and isinstance(output, pandas.DataFrame):
                schema = self._infer_and_apply_schema_from_dataframe(output)
            else:
                schema = None  # Will be determined per-tuple if needed

            for output_tuple in all_output_to_tuple(output):
                if output_tuple is not None:
                    # Get schema: use pre-inferred from DataFrame, or infer from tuple
                    if schema is None:
                        if not self._schema_inferred:
                            schema = self._check_and_update_schema(output_tuple)
                        else:
                            schema = self._context.output_manager.get_port().get_schema()
                    output_tuple.finalize(schema)
                output_batch.append(output_tuple)

                # Flush batch when it reaches the configured size
                if len(output_batch) >= batch_size:
                    self._flush_output_batch(output_batch)
                    output_batch = []

        # Flush any remaining tuples in the batch
        if output_batch:
            self._flush_output_batch(output_batch)

        self._context.tuple_processing_manager.finished_current.set()

    def _infer_and_apply_schema_from_dataframe(self, df: pandas.DataFrame) -> Schema:
        """
        Infer schema from DataFrame and apply it to the output port.

        :param df: The DataFrame to infer schema from
        :return: The inferred schema
        """
        self._schema_inferred = True

        declared_schema = self._context.output_manager.get_port().get_schema()
        inferred_schema = self._infer_schema_from_dataframe(df)

        # Check if schemas match
        if not self._schemas_are_equal(declared_schema, inferred_schema):
            # Emit info about schema inference
            self._emit_schema_info(declared_schema, inferred_schema)

            # Update the output port's schema to the inferred one
            self._context.output_manager.get_port().set_schema(inferred_schema)

            # Recreate the port storage writers with the new schema
            for port_id in self._context.output_manager.get_port_ids():
                self._context.output_manager.recreate_port_storage_writer(
                    port_id, inferred_schema
                )

            logger.info(
                f"Schema inferred from DataFrame dtypes: {inferred_schema}"
            )

        return inferred_schema

    def _flush_output_batch(self, output_batch: List[Optional[Tuple]]) -> None:
        """
        Flush a batch of output tuples to MainLoop with context switching.

        :param output_batch: List of output tuples to flush
        """
        for output_tuple in output_batch:
            self._switch_context()
            self._context.tuple_processing_manager.current_output_tuple = output_tuple
            self._switch_context()

    def _set_output_state(self, output_state: State) -> None:
        """
        Set the output state after processing by the executor.
        """
        self._context.state_processing_manager.current_output_state = output_state

    def _switch_context(self) -> None:
        """
        Notify the MainLoop thread and wait here until being switched back.
        """
        with self._context.tuple_processing_manager.context_switch_condition:
            self._context.tuple_processing_manager.context_switch_condition.notify()
            self._context.tuple_processing_manager.context_switch_condition.wait()
        self._post_switch_context_checks()

    def _check_and_process_debug_command(self) -> None:
        """
        If a debug command is available, invokes the debugger from this frame.
        """
        if self._context.debug_manager.has_debug_command():
            # Let debugger trace from the current frame.
            # This line will also trigger cmdloop in the debugger.
            # This line has no side effects on the current debugger state.
            self._context.debug_manager.debugger.set_trace()

    def _post_switch_context_checks(self):
        self._check_and_process_debug_command()

    def _infer_schema_from_tuple(self, tuple_like: TupleLike) -> Schema:
        """
        Infer schema from a TupleLike object by examining the types of its values.

        :param tuple_like: A TupleLike object (dict-like with field names and values)
        :return: Inferred Schema
        """
        inferred_schema = Schema()

        # Get field names and values
        if isinstance(tuple_like, Tuple):
            field_names = tuple_like.get_field_names()
            for name in field_names:
                value = tuple_like[name]
                attr_type = self._infer_attribute_type(value)
                inferred_schema.add(name, attr_type)
        elif isinstance(tuple_like, dict):
            for name, value in tuple_like.items():
                attr_type = self._infer_attribute_type(value)
                inferred_schema.add(name, attr_type)
        else:
            # For other TupleLike objects, try to iterate
            for name in tuple_like:
                value = tuple_like[name]
                attr_type = self._infer_attribute_type(value)
                inferred_schema.add(name, attr_type)

        return inferred_schema

    def _infer_schema_from_dataframe(self, df: pandas.DataFrame) -> Schema:
        """
        Infer schema from a pandas DataFrame using its dtypes.

        This is more reliable than inferring from the first tuple because:
        1. DataFrame dtypes are consistent across all rows
        2. pandas already handles type inference for the entire column
        3. Handles nullable integers and other pandas-specific types correctly

        For object dtype columns (which pandas uses for str, list, dict, etc.),
        we sample the first non-null value to determine the actual type.

        :param df: A pandas DataFrame
        :return: Inferred Schema
        """
        inferred_schema = Schema()

        for column_name in df.columns:
            column = df[column_name]
            dtype = column.dtype

            # For object dtype, sample first non-null value to distinguish
            # between STRING, LIST, and STRUCT
            if dtype == np.dtype("object"):
                attr_type = self._infer_type_from_object_column(column)
            else:
                attr_type = self._map_pandas_dtype_to_attribute_type(dtype)

            inferred_schema.add(str(column_name), attr_type)

        return inferred_schema

    def _infer_type_from_object_column(self, column: pandas.Series) -> AttributeType:
        """
        Infer AttributeType from an object dtype column by sampling values.

        Object dtype in pandas is used for str, list, dict, and other Python objects.
        We sample the first non-null value to determine the actual type.

        :param column: A pandas Series with object dtype
        :return: Inferred AttributeType
        """
        # Get non-null values
        non_null = column.dropna()

        if len(non_null) == 0:
            # All values are null, default to STRING
            return AttributeType.STRING

        # Sample first non-null value
        first_value = non_null.iloc[0]

        if isinstance(first_value, list):
            return AttributeType.LIST
        elif isinstance(first_value, dict):
            return AttributeType.STRUCT
        else:
            # Default to STRING for str and other types
            return AttributeType.STRING

    def _map_pandas_dtype_to_attribute_type(self, dtype) -> AttributeType:
        """
        Map a pandas/numpy dtype to an AttributeType.

        :param dtype: A pandas or numpy dtype
        :return: Corresponding AttributeType
        """
        # Check direct mapping first
        if dtype in PANDAS_DTYPE_TO_ATTRIBUTE_TYPE:
            return PANDAS_DTYPE_TO_ATTRIBUTE_TYPE[dtype]

        # Handle nullable integer types (Int8, Int16, Int32, Int64, etc.)
        dtype_str = str(dtype)
        if dtype_str.startswith("Int") or dtype_str.startswith("UInt"):
            return AttributeType.LONG

        # Handle nullable boolean
        if dtype_str == "boolean":
            return AttributeType.BOOL

        # Handle nullable float
        if dtype_str.startswith("Float"):
            return AttributeType.DOUBLE

        # Handle string dtype (pandas StringDtype)
        if dtype_str == "string" or dtype.name == "string":
            return AttributeType.STRING

        # Handle object dtype - typically strings or mixed types
        if dtype == np.dtype("object"):
            return AttributeType.STRING

        # Handle categorical - use the underlying type or default to STRING
        # Must check BEFORE np.issubdtype since categorical can't be converted
        if hasattr(dtype, "categories"):
            return AttributeType.STRING

        # Handle datetime with timezone
        if hasattr(dtype, "tz") or dtype_str.startswith("datetime64"):
            return AttributeType.TIMESTAMP

        # Handle timedelta (must be after categorical check)
        try:
            if np.issubdtype(dtype, np.timedelta64):
                return AttributeType.LONG  # Store as nanoseconds
        except TypeError:
            # Some dtypes can't be checked with issubdtype
            pass

        # Default to BINARY for unknown types (will be pickled)
        logger.debug(f"Unknown pandas dtype '{dtype}', defaulting to BINARY")
        return AttributeType.BINARY

    def _infer_attribute_type(self, value) -> AttributeType:
        """
        Infer AttributeType from a Python value.

        :param value: Python value to infer type from
        :return: Inferred AttributeType
        """
        if value is None:
            # Default to STRING for None values
            return AttributeType.STRING

        value_type = type(value)
        # Use LONG for integers to avoid overflow with large values
        # Python 3 unifies int and long, so always use 64-bit
        if value_type == int:
            return AttributeType.LONG
        elif value_type in FROM_PYOBJECT_MAPPING:
            return FROM_PYOBJECT_MAPPING[value_type]
        else:
            # Default to BINARY for unknown types (will be pickled)
            return AttributeType.BINARY

    def _schemas_are_equal(self, schema1: Schema, schema2: Schema) -> bool:
        """
        Compare two schemas for equality.

        :param schema1: First schema
        :param schema2: Second schema
        :return: True if schemas are equal, False otherwise
        """
        return schema1 == schema2

    def _emit_schema_info(
        self, declared_schema: Schema, inferred_schema: Schema
    ) -> None:
        """
        Emit an INFO console message about schema inference.

        :param declared_schema: The schema declared by the user
        :param inferred_schema: The schema inferred from the actual tuple
        """
        # self._context.console_message_manager.put_message(
        #     ConsoleMessage(
        #         worker_id=self._context.worker_id,
        #         timestamp=current_time_in_local_timezone(),
        #         msg_type=ConsoleMessageType.PRINT,
        #         source="SchemaInference",
        #         title=f"Output schema detected",
        #         message=f"{inferred_schema}",
        #     )
        # )
        return

    def _check_and_update_schema(self, first_tuple: TupleLike) -> Schema:
        """
        Check if the first output tuple's schema matches the declared schema.
        If not, update the output port's schema and emit a warning.

        :param first_tuple: The first tuple produced by the operator
        :return: The schema to use for finalization
        """
        if self._schema_inferred:
            # Already inferred, just return current schema
            return self._context.output_manager.get_port().get_schema()

        self._schema_inferred = True

        declared_schema = self._context.output_manager.get_port().get_schema()
        inferred_schema = self._infer_schema_from_tuple(first_tuple)

        # Check if schemas match
        if not self._schemas_are_equal(declared_schema, inferred_schema):
            # Emit info about schema inference
            self._emit_schema_info(declared_schema, inferred_schema)

            # Update the output port's schema to the inferred one
            self._context.output_manager.get_port().set_schema(inferred_schema)

            # Recreate the port storage writers with the new schema
            for port_id in self._context.output_manager.get_port_ids():
                self._context.output_manager.recreate_port_storage_writer(
                    port_id, inferred_schema
                )

            logger.warning(
                f"Schema mismatch detected. Updated output schema from "
                f"{declared_schema} to {inferred_schema}"
            )

            return inferred_schema

        return declared_schema

    def _report_exception(self, exc_info: ExceptionInfo):
        tb = traceback.extract_tb(exc_info[2])
        filename, line_number, func_name, code_line = tb[-1]
        base_name = os.path.basename(filename)
        module_name, _ = os.path.splitext(base_name)

        # Extract exception type and message
        exception_type = type(exc_info[1]).__name__
        exception_msg = str(exc_info[1])

        source = f"{module_name}:{func_name}:{line_number}"
        # Title shows the exact code line that caused the error
        title: str = (
            f"`{code_line.strip()}` - {exception_type}: {exception_msg}"
            if code_line
            else f"{exception_type}: {exception_msg}"
        )[:300]

        self._context.console_message_manager.put_message(
            ConsoleMessage(
                worker_id=self._context.worker_id,
                timestamp=current_time_in_local_timezone(),
                msg_type=ConsoleMessageType.ERROR,
                source=source,
                title=title,
                message="",
            )
        )

    def stop(self):
        self._running.clear()
