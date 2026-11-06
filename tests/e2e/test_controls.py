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

"""An execution is interactive through the catalog alone: its watch shows the operators' progress
as the unit reports it, pause and resume go to the unit and the phase follows the unit's
word, and the result is whole at the end. The unit itself stays behind its doors."""
import pytest

from texera_e2e import workflows as w
from texera_e2e.events import Watch, phase

UDF_SLOW = '''from pytexera import *
import time


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        time.sleep(0.2)
        yield tuple_
'''


@pytest.mark.slow
def test_a_run_is_watched_paused_and_resumed(alice, bob, project, iris, unit):
    udf = {"code": UDF_SLOW, "workers": 1, "retainInputColumns": True, "outputColumns": []}
    wf = alice.create("workflows", "slow iris", w.with_operator(iris.file, "PythonUDFV2", udf, opid="slow"), project=project)
    rid = wf["metadata"]["rid"]
    run = alice.post(f"/workflows/{rid}/run", {"name": "slow execution", "computingUnit": unit})
    eid = run["metadata"]["rid"]
    path = f"/workflows/{rid}/executions/{eid}"
    watch = Watch(alice, eid)

    # The execution goes; the unit's progress reports reach the watcher operator by operator.
    running = watch.until(lambda r: phase(r) == "running", timeout=120)
    assert running["kind"] == "execution"
    progressed = watch.until(lambda r: (r["status"].get("operators") or {}).get("slow", {}).get("rowsOut", 0) > 0, timeout=60)
    assert progressed["status"]["operators"]["slow"]["state"] in ("Running", "Paused", "Pausing")
    # What it read is said beside what it put out: the slow operator reads every row it puts out.
    assert progressed["status"]["operators"]["slow"]["rowsIn"] >= progressed["status"]["operators"]["slow"]["rowsOut"]

    # Pause: the catalog forwards it and reports what the unit says, not what was asked.
    assert bob.status("POST", f"{path}/pause") in (403, 404), "only a reader of the execution controls it"
    assert alice.status("POST", f"{path}/resume") == 409, "nothing to resume while it runs"
    alice.post(f"{path}/pause")
    paused = watch.until(lambda r: phase(r) == "paused", timeout=30)
    assert alice.get(path)["status"]["phase"] == "paused"
    assert alice.status("POST", f"{path}/pause") == 409
    put_out = paused["status"]["operators"]["slow"].get("rowsOut", 0)
    assert put_out < 150, "paused before the end"

    # Resume: it runs to completion, with every row.
    alice.post(f"{path}/resume")
    watch.until(lambda r: phase(r) == "running", timeout=30)
    done = watch.until(lambda r: phase(r) in ("completed", "failed", "cancelled"), timeout=180)
    assert phase(done) == "completed", w.error_text(done)
    assert any(p["operatorID"] == "slow" and p.get("rows") == 150 for p in done["status"]["ports"]), done["status"]["ports"]
    assert alice.status("POST", f"{path}/resume") == 409 and alice.status("POST", f"{path}/pause") == 409
