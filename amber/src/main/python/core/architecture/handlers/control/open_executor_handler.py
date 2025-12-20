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

from core.architecture.handlers.control.control_handler_base import ControlHandler
from proto.org.apache.amber.engine.architecture.rpc import EmptyReturn, EmptyRequest


class OpenExecutorHandler(ControlHandler):

    async def open_executor(self, req: EmptyRequest) -> EmptyReturn:
        executor = self.context.executor_manager.executor

        # Inject input port names for operators that support it
        # (e.g., UDFMultiTableOperator)
        if hasattr(executor, "_set_input_port_names"):
            port_names = self.context.input_manager.get_input_port_display_names()
            executor._set_input_port_names(port_names)

        # Inject a completion checker for operators that need to wait for all ports
        # This uses input_manager.all_ports_completed() which is accurate even
        # in multi-phase execution
        if hasattr(executor, "_set_all_ports_completed_checker"):
            executor._set_all_ports_completed_checker(
                self.context.input_manager.all_ports_completed
            )

        executor.open()
        return EmptyReturn()
