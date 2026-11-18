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

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.architecture.handlers.control.replay_current_tuple_handler import (
    RetryCurrentTupleHandler,
)
from core.architecture.managers.exception_manager import ExceptionManager
from core.architecture.managers.pause_manager import PauseType
from proto.org.apache.texera.amber.engine.architecture.rpc import (
    EmptyRequest,
    EmptyReturn,
)
from proto.org.apache.texera.amber.engine.architecture.worker import WorkerState


def _build_handler(state: WorkerState, current_tuple, remaining_iter):
    instance = RetryCurrentTupleHandler.__new__(RetryCurrentTupleHandler)
    state_manager = MagicMock()
    state_manager.confirm_state.side_effect = lambda *states: state in states
    instance.context = SimpleNamespace(
        state_manager=state_manager,
        tuple_processing_manager=SimpleNamespace(
            current_input_tuple=current_tuple,
            current_input_tuple_iter=iter(remaining_iter),
        ),
        pause_manager=MagicMock(),
        exception_manager=ExceptionManager(),
    )
    return instance


class TestRetryCurrentTupleHandler:
    @pytest.fixture
    def running_handler(self):
        return _build_handler(
            WorkerState.RUNNING,
            current_tuple=None,
            remaining_iter=[{"col": "next"}],
        )

    def test_returns_empty_return(self, running_handler):
        result = asyncio.run(running_handler.retry_current_tuple(EmptyRequest()))
        assert isinstance(result, EmptyReturn)

    def test_puts_nothing_back_on_the_input_iterator(self, running_handler):
        # The tuple the executor raised on is still the DataProcessor's to
        # finish, and by then it has left `current_input_tuple`. Chaining that
        # slot back, as this handler once did, put a None on the iterator,
        # which ended the batch the tuple came in.
        asyncio.run(running_handler.retry_current_tuple(EmptyRequest()))
        remaining = list(
            running_handler.context.tuple_processing_manager.current_input_tuple_iter
        )
        assert remaining == [{"col": "next"}]

    def test_forgets_the_exception_the_worker_stopped_on(self, running_handler):
        # MainLoop stops the worker whenever an exception is recorded. One left
        # recorded after a retry would stop it again at the next check, though
        # the tuple went through this time.
        error = ValueError("cannot be processed")
        running_handler.context.exception_manager.set_exception_info(
            (type(error), error, None)
        )
        asyncio.run(running_handler.retry_current_tuple(EmptyRequest()))
        assert not running_handler.context.exception_manager.has_exception()

    def test_keeps_the_exception_of_a_completed_worker(self):
        completed_handler = _build_handler(
            WorkerState.COMPLETED, current_tuple=None, remaining_iter=[]
        )
        error = ValueError("cannot be processed")
        completed_handler.context.exception_manager.set_exception_info(
            (type(error), error, None)
        )
        asyncio.run(completed_handler.retry_current_tuple(EmptyRequest()))
        assert completed_handler.context.exception_manager.has_exception()

    def test_resumes_user_and_exception_pause_in_order(self, running_handler):
        asyncio.run(running_handler.retry_current_tuple(EmptyRequest()))
        actual = [
            call.args[0]
            for call in running_handler.context.pause_manager.resume.call_args_list
        ]
        assert actual == [PauseType.USER_PAUSE, PauseType.EXCEPTION_PAUSE]

    def test_does_not_resume_debug_pause(self, running_handler):
        # Unlike WorkerDebugCommandHandler, retry only releases USER and
        # EXCEPTION pauses — DEBUG_PAUSE must remain in effect so an active
        # debugging session is not silently dropped.
        asyncio.run(running_handler.retry_current_tuple(EmptyRequest()))
        resumed = {
            call.args[0]
            for call in running_handler.context.pause_manager.resume.call_args_list
        }
        assert PauseType.DEBUG_PAUSE not in resumed

    def test_no_op_when_state_is_completed(self):
        completed_handler = _build_handler(
            WorkerState.COMPLETED,
            current_tuple=None,
            remaining_iter=[{"col": "next"}],
        )
        result = asyncio.run(completed_handler.retry_current_tuple(EmptyRequest()))

        # No pause type is resumed: replaying a tuple after completion is
        # meaningless.
        completed_handler.context.pause_manager.resume.assert_not_called()
        assert isinstance(result, EmptyReturn)

    def test_paused_state_resumes(self):
        # The completion guard is `if not confirm_state(COMPLETED)`, so every
        # other state takes the resume path. PAUSED is the most likely
        # real-world entry point (the user hits "retry" while the worker is
        # paused on an exception).
        handler = _build_handler(
            WorkerState.PAUSED,
            current_tuple=None,
            remaining_iter=[{"col": "next"}],
        )
        asyncio.run(handler.retry_current_tuple(EmptyRequest()))

        resumed = [
            call.args[0] for call in handler.context.pause_manager.resume.call_args_list
        ]
        assert resumed == [PauseType.USER_PAUSE, PauseType.EXCEPTION_PAUSE]
