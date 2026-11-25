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

import pytest

from core.storage.execution_namespace import execution_namespace


@pytest.mark.parametrize(
    ("eid", "namespace"),
    [
        (0, "execution-0"),
        (40, "execution-40"),
        (2**63 - 1, "execution-9223372036854775807"),
    ],
)
def test_the_namespace_is_named_after_the_execution(eid, namespace):
    # The Dashboard Service makes the namespace under the name the Scala side
    # gives it (ExecutionNamespace.of), and the Python worker has to find it, so
    # both sides spell it alike for every execution id, the largest Long included.
    assert execution_namespace(eid) == namespace
