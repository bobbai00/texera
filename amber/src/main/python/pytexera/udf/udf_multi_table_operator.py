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

from abc import abstractmethod
from typing import Iterator, Optional, Dict, Set, Callable

from pyamber import *


class UDFMultiTableOperator(TableOperator):
    """
    Base class for multi-table user-defined operators that process multiple
    input tables together. Input tables are automatically stored as named
    attributes based on the port names configured in the workflow.

    Port names are automatically obtained from the workflow configuration.
    The port display names become attribute names accessible via self.<port_name>.

    Subclasses must implement process_tables() method.

    Example:
        class ProcessTablesOperator(UDFMultiTableOperator):

            def process_tables(self) -> Iterator[Optional[TableLike]]:
                # Access tables via self.<port_name>
                # Port names come from the workflow's port display names
                # e.g., if ports are named "products" and "merchants":
                merged = self.products.merge(self.merchants, on='id')
                yield merged
    """

    def __init__(self):
        super().__init__()
        self._port_tables: Dict[int, Table] = {}
        self._completed_ports: Set[int] = set()
        # Port names from workflow configuration (port_index -> display_name)
        self._input_port_names: Dict[int, str] = {}
        # Function to check if all ports are completed (set by framework)
        self._all_ports_completed_checker: Optional[Callable[[], bool]] = None

    def _set_input_port_names(self, port_names: Dict[int, str]) -> None:
        """
        Internal method called by the framework to set input port names
        from the workflow configuration.

        :param port_names: Dictionary mapping port index to display name
        """
        # Sanitize port names: replace hyphens with underscores for valid Python identifiers
        sanitized_names = {}
        for port_idx, name in port_names.items():
            sanitized_name = name.replace("-", "_")
            sanitized_names[port_idx] = sanitized_name
        self._input_port_names = sanitized_names

    def _set_all_ports_completed_checker(
        self, checker: Callable[[], bool]
    ) -> None:
        """
        Internal method called by the framework to set a function that checks
        if all input ports have completed.

        :param checker: A callable that returns True if all ports are completed
        """
        self._all_ports_completed_checker = checker

    def open(self) -> None:
        """
        Open a context of the operator. Usually can be used for loading/initiating
        some resources, such as a file, a model, or an API client.
        """
        pass

    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        """
        Internal method that collects tables from each port.
        When all ports have completed, assigns tables to named attributes
        and calls process_tables().

        Do not override this method - implement process_tables() instead.
        """
        # Store the table for this port
        self._port_tables[port] = table
        self._completed_ports.add(port)

        # Check if all ports are completed using the framework's checker
        # This is more reliable than counting port names because port names
        # may be assigned incrementally in multi-phase execution
        if self._all_ports_completed_checker is not None:
            all_completed = self._all_ports_completed_checker()
        else:
            # Fallback: use port names count (may not work in multi-phase execution)
            num_expected_ports = (
                len(self._input_port_names) if self._input_port_names else 1
            )
            all_completed = len(self._completed_ports) >= num_expected_ports

        if not all_completed:
            # Not all ports complete yet, don't emit anything
            return

        # All ports have completed - assign tables to named attributes
        for port_idx, port_name in self._input_port_names.items():
            if port_idx in self._port_tables:
                setattr(self, port_name, self._port_tables[port_idx])
            else:
                # Port not received, set to None
                setattr(self, port_name, None)

        # Call user's process_tables implementation
        yield from self.process_tables()

    @abstractmethod
    def process_tables(self) -> Iterator[Optional[TableLike]]:
        """
        Process all input tables together. Override this method in your subclass.

        All input tables are available as named attributes based on the port
        display names configured in the workflow.

        For example, if ports are named "products" and "merchants", then:
        - self.products contains the DataFrame from the first port
        - self.merchants contains the DataFrame from the second port

        :return: Iterator[Optional[TableLike]], producing one TableLike object
            at a time, or None.
        """
        yield

    def close(self) -> None:
        """
        Close the context of the operator.
        """
        pass
