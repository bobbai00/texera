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
from core.util.expression_evaluator import ExpressionEvaluator
from proto.org.apache.texera.amber.engine.architecture.rpc import (
    EvaluatedValue,
    EvaluatePythonExpressionRequest,
)


class EvaluateExpressionHandler(ControlHandler):
    async def evaluate_python_expression(
        self, req: EvaluatePythonExpressionRequest
    ) -> EvaluatedValue:
        tpm = self.context.tuple_processing_manager
        runtime_context = {
            r"self": self.context.executor_manager.executor,
            # The tuple waiting to be processed, else the one being processed:
            # the executor has taken it by the time its worker can be stopped
            # in it.
            r"tuple_": (
                tpm.current_input_tuple
                if tpm.current_input_tuple is not None
                else tpm.input_tuple_in_process
            ),
            r"input_": tpm.current_input_port_id,
        }

        evaluated_value: EvaluatedValue = ExpressionEvaluator.evaluate(
            req.expression, runtime_context
        )

        return evaluated_value
