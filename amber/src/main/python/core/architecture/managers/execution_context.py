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
ExecutionContext provides thread-local storage for execution-related information.
This allows BigObjectManager and other utilities to automatically access
execution_id and operator_id without requiring explicit parameters.
"""

import threading
from typing import Optional


class ExecutionContext:
    """
    Thread-local storage for execution context information.
    Similar to Scala's ExecutionContext.
    """

    _thread_local = threading.local()

    @classmethod
    def set_execution_id(cls, execution_id: int) -> None:
        """Set the execution ID for the current thread."""
        cls._thread_local.execution_id = execution_id

    @classmethod
    def get_execution_id(cls) -> Optional[int]:
        """Get the execution ID for the current thread, or None if not set."""
        return getattr(cls._thread_local, "execution_id", None)

    @classmethod
    def set_operator_id(cls, operator_id: str) -> None:
        """Set the operator ID for the current thread."""
        cls._thread_local.operator_id = operator_id

    @classmethod
    def get_operator_id(cls) -> Optional[str]:
        """Get the operator ID for the current thread, or None if not set."""
        return getattr(cls._thread_local, "operator_id", None)

    @classmethod
    def clear(cls) -> None:
        """Clear all execution context information for the current thread."""
        if hasattr(cls._thread_local, "execution_id"):
            delattr(cls._thread_local, "execution_id")
        if hasattr(cls._thread_local, "operator_id"):
            delattr(cls._thread_local, "operator_id")
