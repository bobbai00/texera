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
from core.architecture.managers.pause_manager import PauseType
from proto.org.apache.texera.amber.engine.architecture.rpc import (
    EmptyReturn,
    EmptyRequest,
)
from proto.org.apache.texera.amber.engine.architecture.worker import (
    WorkerState,
)


class RetryCurrentTupleHandler(ControlHandler):
    async def retry_current_tuple(self, req: EmptyRequest) -> EmptyReturn:
        if not self.context.state_manager.confirm_state(WorkerState.COMPLETED):
            # The tuple the executor raised on is still the DataProcessor's to
            # finish (DataProcessor.process_tuple): letting the worker go on is
            # what has it processed once more. Nothing is put back on the input
            # iterator, which would process the tuple twice.
            #
            # The exception it stopped on is over. Left recorded, it would stop
            # the worker again at MainLoop's next check, whatever the tuple
            # does this time.
            self.context.exception_manager.get_exc_info()
            self.context.pause_manager.resume(PauseType.USER_PAUSE)
            self.context.pause_manager.resume(PauseType.EXCEPTION_PAUSE)
        return EmptyReturn()
