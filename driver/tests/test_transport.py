"""Offline tests of the transports and TexeraApi's step-2 calls against the fake
Texera (tests/fake_texera.py): the wire shapes of design sections 3.4-3.8, and of the
step-3 design's section 3.5 (the routes of an execution's record).

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import sys
import time
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_texera import FakeTexera  # noqa: E402
from record_timing import RecordTiming  # noqa: E402
from texera_api import ExecutionLog, TexeraApi, TexeraApiError  # noqa: E402
from transport import (CreateRefused, CreateStartTransport, UpdateRefused,  # noqa: E402
                       WebSocketTransport)
from workflow import Workflow, csv_scan, python_udf, text_input  # noqa: E402

TAG = '''from pytexera import *
class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_, port):
        tuple_["tag"] = "{tag}"
        yield tuple_
'''


class FakeCase(unittest.TestCase):
    #: the product the fake models (FakeTexera's options)
    fake_options: dict = {}

    def setUp(self):
        self.fake = FakeTexera(**self.fake_options)
        self.base = self.fake.start()
        self.api = TexeraApi(self.base)
        self.api.login("texera", "texera")
        self.wid = self.api.create_workflow("w", {})
        self.cuid = int(self.api.create_local_unit("u", "http://unit:8085")["cuid"])
        self.whid, _ = self.api.ensure_warehouse("wh")
        self.phases = []

        def hook(phase, info):
            self.phases.append((phase, {k: v for k, v in info.items() if k != "handle"}))
        self.t = CreateStartTransport(self.base, lambda: self.api.token, lambda: self.api.uid,
                                      api=self.api, log=lambda m: None)
        self.t.phase_hook = hook
        self.handles = []

    def tearDown(self):
        for h in self.handles:
            h.close()
        self.fake.stop()

    def plan(self, tag="v1"):
        wf = Workflow("w")
        src = wf.add("numbers", "CSVFileScan", csv_scan("/dataset/x/ds/v1/numbers.csv"), n_in=0)
        udf = wf.add("tagger", "PythonUDFV2", python_udf(TAG.format(tag=tag), out_columns=[("tag", "string")]))
        wf.link(src, udf)
        return wf, udf

    def start(self, wf, udf, **kw):
        h = self.t.start_run(wid=self.wid, cuid=self.cuid, warehouse_id=self.whid,
                             logical_plan=wf.logical_plan([udf]), execution_name="run", **kw)
        self.handles.append(h)
        return h


class CreateWsTest(FakeCase):
    def test_create_then_start_by_id(self):
        wf, udf = self.plan()
        h = self.start(wf, udf)
        self.assertEqual(h.wait_for_state("Completed", timeout=30), "Completed")
        create = next(r for r in self.fake.rest_log if r["path"] == "/api/executions")
        body = create["body"]
        # design 3.4: the request shape
        self.assertEqual(self.wid, body["wid"])
        self.assertEqual(self.cuid, body["computingUnitId"])
        self.assertEqual(self.whid, body["warehouseId"])
        self.assertIs(False, body["emailNotificationEnabled"])
        self.assertEqual({"dataTransferBatchSize": 400, "executionMode": "PIPELINED"}, body["workflowSettings"])
        self.assertEqual(["operators", "links", "opsToViewResult", "opsToReuseResult"], list(body["logicalPlan"]))
        self.assertNotIn("replayFromExecution", body)
        self.assertNotIn("targetOperatorIds", body)
        # 3.6: the first marked command is the start by id
        sent = [w["msg"] for w in self.fake.ws_log if w["msg"]["type"] != "HeartBeatRequest"]
        self.assertEqual({"type": "WorkflowStartRequest", "executionId": h.eid, "planUri": h.plan_uri}, sent[0])
        self.assertEqual("WorkflowStartRequest", h.command_log[0][1])
        self.assertEqual(f"vfs:///wh/user-1-{self.whid}/wid/{self.wid}/eid/{h.eid}/plan", h.plan_uri)
        res = h.results(udf, page_size=50)
        self.assertEqual(300, len(res["rows"]))
        self.assertEqual(["create", "created", "start"], [p for p, _ in self.phases])
        self.assertEqual(h.eid, self.phases[1][1]["eid"])

    def test_target_and_replay_reach_the_body(self):
        wf, udf = self.plan()
        resp = self.t.create_only(wid=self.wid, cuid=self.cuid, warehouse_id=self.whid,
                                  logical_plan=wf.logical_plan([udf]), execution_name="x",
                                  target_operator_ids=[udf], replay_from={"eid": 5, "interaction": "i"})
        body = self.fake.rest_log[-1]["body"]
        self.assertEqual([udf], body["targetOperatorIds"])
        self.assertEqual({"eid": 5, "interaction": "i"}, body["replayFromExecution"])
        self.assertEqual(400, resp.status_code)  # the fake has no execution 5

    def test_refused_create_raises_with_status_and_body(self):
        wf, udf = self.plan()
        with self.assertRaises(CreateRefused) as cm:
            self.t.start_run(wid=self.wid, cuid=999, warehouse_id=self.whid,
                             logical_plan=wf.logical_plan([udf]), execution_name="x")
        self.assertEqual(403, cm.exception.status)
        self.assertEqual(403, cm.exception.body["code"])
        self.assertFalse(any(w["msg"]["type"] == "WorkflowStartRequest" for w in self.fake.ws_log))

    def test_modify_operator_posts_then_names_the_update(self):
        wf, udf = self.plan()
        h = self.start(wf, udf)
        h.wait_for_state("Running", timeout=30)
        h.wait_until(lambda: h.output_rows(udf) >= 10, 30, "rows")
        h.pause()
        h.wait_for_state("Paused", timeout=30)
        out = h.modify_operator(wf.operator_json(udf, code=TAG.format(tag="v2")))
        post = next(r for r in self.fake.rest_log if r["path"] == f"/api/executions/{h.eid}/updates")
        self.assertEqual(udf, post["body"]["operator"]["operatorID"])
        self.assertEqual("PythonUDFV2", post["body"]["operator"]["operatorType"])
        self.assertTrue(out["updateId"].startswith("update-"))
        self.assertEqual(udf, out["operatorId"])
        self.assertTrue(out["response"]["isValid"])
        msg = next(w["msg"] for w in self.fake.ws_log if w["msg"]["type"] == "OperatorUpdateRequest")
        self.assertEqual({"type": "OperatorUpdateRequest", "executionId": h.eid, "updateId": out["updateId"]}, msg)
        h.resume()
        h.wait_for_state("Completed", timeout=30)
        h.wait_until(lambda: bool(h.modify_completed), 10, "completed event", fail_fast=False)
        self.assertEqual([udf], h.modify_completed[0]["opIds"])
        tags = {r["tag"] for r in h.results(udf)["rows"]}
        self.assertEqual({"v1", "v2"}, tags)
        with self.assertRaises(UpdateRefused) as cm:
            h.modify_operator(wf.operator_json(udf))
        self.assertEqual(409, cm.exception.status)

    def test_start_existing_refused_twice_and_not_killed(self):
        wf, udf = self.plan()
        h = self.start(wf, udf)
        h.wait_for_state("Completed", timeout=30)
        again = self.t.start_existing(wid=self.wid, cuid=self.cuid, eid=h.eid, plan_uri=h.plan_uri)
        self.handles.append(again)
        again.wait_until(lambda: again.error_event_count > 0, 10, "refusal", fail_fast=False)
        self.assertIn("already started", again.fatal_errors[0]["message"])
        # the unit replayed the held run while the socket opened; none of it is this start's
        self.assertEqual(["Uninitialized", "Completed"], again.replayed["states"])
        self.assertEqual([], again.states)
        self.assertIsNone(again.ensure_stopped(timeout=1))
        self.assertFalse(any(w["msg"]["type"] == "WorkflowKillRequest" for w in self.fake.ws_log))

    def test_open_waits_for_the_replay_and_keeps_it_apart(self):
        """The reviewer's probe: a second socket on a workflow whose run completed gets
        "Uninitialized", ~0.1 s later the held run's statistics, console and state, then
        ClusterStatusUpdateEvent. open_socket returns after all of it."""
        self.api.ensure_environment("env-r", {"tabulate": "==0.9.0"})
        wf = Workflow("w")
        src = wf.add("one", "TextInput", text_input(["x"]), n_in=0)
        udf = wf.add("tab", "PythonUDFV2", python_udf("import tabulate\ntabulate.__version__",
                                                      out_columns=[("tabulate_version", "string")],
                                                      env_name="env-r"))
        wf.link(src, udf)
        h = self.start(wf, udf)
        h.wait_for_state("Completed", timeout=30)
        self.assertEqual(2, len(h.console(udf)))  # Installing, then ready
        self.assertEqual(["Initializing", "Running", "Completed"], h.states)
        self.assertEqual(["Uninitialized"], h.replayed["states"])
        self.assertIsNone(h.replayed["execution_id"])  # the unit held no run of the workflow then
        second = self.t.open_socket(self.wid, self.cuid)
        self.handles.append(second)
        r = second.replayed
        self.assertEqual("ClusterStatusUpdateEvent", r["closed_by"])
        self.assertEqual(["Uninitialized", "Completed"], r["states"])
        # a socket that only joined learns the execution from the state event that names it
        self.assertEqual((h.eid, h.eid), (second.eid, r["execution_id"]))
        self.assertEqual(2, r["console_messages"])
        self.assertEqual([], second.states)
        self.assertEqual([], second.console(udf))
        self.assertEqual({}, second.stats(udf))
        self.assertEqual(0, second.error_event_count)
        self.assertIn("opened", second.summary())

    def test_open_without_cluster_status_ends_after_a_quiet_period(self):
        self.fake.send_cluster_status = False
        self.t.open_cluster_wait_s, self.t.open_quiet_s = 0.3, 0.2
        wf, udf = self.plan()
        h = self.start(wf, udf)
        h.wait_for_state("Completed", timeout=30)
        second = self.t.open_socket(self.wid, self.cuid)
        self.handles.append(second)
        self.assertTrue(second.replayed["closed_by"].startswith("no ClusterStatusUpdateEvent"),
                        second.replayed)
        self.assertEqual(["Uninitialized", "Completed"], second.replayed["states"])
        self.assertEqual([], second.states)

    def test_a_refused_start_after_a_failed_run_does_not_fail_fast_on_the_replay(self):
        """A replayed fatal error belongs to the held run: waits on the new socket do not
        fail on it, and its error count starts at zero."""
        wf = Workflow("w")
        src = wf.add("missing", "CSVFileScan", csv_scan("/dataset/x/ds/v1/no-such.csv"), n_in=0)
        h = self.start(wf, src)
        with self.assertRaises(Exception):
            h.wait_for_state("Completed", timeout=30)
        self.assertTrue(h.fatal_errors)
        again = self.t.start_existing(wid=self.wid, cuid=self.cuid, eid=h.eid, plan_uri=h.plan_uri)
        self.handles.append(again)
        self.assertEqual(1, again.replayed["error_events"])
        again.wait_until(lambda: again.error_event_count > 0, 10, "the refusal")  # fail_fast on
        self.assertIn("already started", again.fatal_errors[0]["message"])
        self.assertEqual(1, again.error_event_count)

    def test_start_existing_as_another_user(self):
        other_token = self.api.register_user("other", "other@example.com", "pw")
        self.assertIsNotNone(other_token)
        wf, udf = self.plan()
        resp = self.t.create_only(wid=self.wid, cuid=self.cuid, warehouse_id=self.whid,
                                  logical_plan=wf.logical_plan([udf]), execution_name="x")
        created = resp.json()
        h = self.t.start_existing(wid=self.wid, cuid=self.cuid, eid=created["eid"],
                                  plan_uri=created["planUri"], token=other_token)
        self.handles.append(h)
        h.wait_until(lambda: h.error_event_count > 0, 10, "refusal", fail_fast=False)
        start = [w for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowStartRequest"][-1]
        self.assertNotEqual(1, start["uid"])  # the socket was the other user's
        self.assertIn("another user's warehouse", h.fatal_errors[0]["message"])


class WsTest(FakeCase):
    def setUp(self):
        super().setUp()
        self.t = WebSocketTransport(self.base, lambda: self.api.token, lambda: self.api.uid,
                                    log=lambda m: None, api=self.api)
        self.t.phase_hook = lambda phase, info: self.phases.append((phase, info))

    def test_execute_request_is_unchanged(self):
        wf, udf = self.plan()
        plan = wf.logical_plan([udf])
        h = self.t.start_run(wid=self.wid, cuid=self.cuid, warehouse_id=self.whid, logical_plan=plan,
                             execution_name="run")
        self.handles.append(h)
        h.wait_for_state("Completed", timeout=30)
        sent = next(w["msg"] for w in self.fake.ws_log if w["msg"]["type"] == "WorkflowExecuteRequest")
        self.assertEqual({
            "type": "WorkflowExecuteRequest", "executionName": "run", "engineVersion": "sce-e2e",
            "logicalPlan": plan, "replayFromExecution": None,
            "workflowSettings": {"dataTransferBatchSize": 400, "executionMode": "PIPELINED"},
            "emailNotificationEnabled": False, "computingUnitId": self.cuid, "warehouseId": self.whid,
        }, sent)
        self.assertIsNone(h.eid)
        self.assertEqual(["create", "start"], [p for p, _ in self.phases])

    def test_modify_sends_the_old_message(self):
        wf, udf = self.plan()
        h = self.t.start_run(wid=self.wid, cuid=self.cuid, warehouse_id=self.whid,
                             logical_plan=wf.logical_plan([udf]), execution_name="run")
        self.handles.append(h)
        h.wait_until(lambda: h.output_rows(udf) >= 10, 30, "rows")
        h.pause()
        h.wait_for_state("Paused", timeout=30)
        op = wf.operator_json(udf, code=TAG.format(tag="v2"))
        out = h.modify_operator(op)
        self.assertTrue(out["response"]["isValid"])
        msg = next(w["msg"] for w in self.fake.ws_log if w["msg"]["type"] == "ModifyLogicRequest")
        self.assertEqual({"type": "ModifyLogicRequest", "operator": op}, msg)
        self.assertFalse(any(r["path"].endswith("/updates") for r in self.fake.rest_log))

    def test_ws_has_no_separate_create(self):
        with self.assertRaises(NotImplementedError):
            self.t.create_only(wid=1)


class ApiTest(FakeCase):
    def test_environments(self):
        row = self.api.ensure_environment("ml", {"tabulate": "==0.9.0"})
        self.assertTrue(row["created"])
        again = self.api.ensure_environment("ml", {"tabulate": "==0.9.0", "requests": ""})
        self.assertFalse(again["created"])
        self.assertEqual({"tabulate": "==0.9.0", "requests": ""}, self.api.list_environments()[0]["packages"])
        self.assertEqual("PUT", self.fake.rest_log[-2]["method"])
        legacy = self.api.ensure_environment("old", {"tabulate": "==0.9.0"}, legacy=True)
        self.assertTrue(legacy["created"])
        self.assertEqual("/api/pve/db", next(r["path"] for r in reversed(self.fake.rest_log)
                                             if r["method"] == "POST"))

    def test_legacy_build_reads_until_done(self):
        out = self.api.build_legacy_environment(self.cuid, "env0", ["tabulate==0.9.0"], timeout=10)
        self.assertEqual("__DONE__", out["create"][-1])
        self.assertIn("install", out["install"][0])

    def test_users_and_units(self):
        other = self.api.ensure_user("sce-e2e-other", "o@example.com", "pw")
        self.assertEqual("REGULAR", other.role)
        self.assertEqual("REGULAR", TexeraApi(self.base).with_token(other.token).role)
        same = self.api.ensure_user("sce-e2e-other", "o@example.com", "pw")
        self.assertEqual(other.uid, same.uid)
        unit = self.api.create_local_unit("t", "http://unit:8085")
        self.assertEqual(200, self.api.terminate_unit(int(unit["cuid"])).status_code)


class RecordApiCase(FakeCase):
    """A run to its end on the fake at a step-3 gate, and its execution once it is closed."""

    def run_once(self):
        wf, udf = self.plan()
        h = self.start(wf, udf)
        h.wait_for_state("Completed", timeout=30)
        return h

    def closed(self, eid: int):
        for _ in range(100):
            state = self.api.execution_state(eid)
            if not state.open:
                return state
            time.sleep(0.05)
        self.fail(f"execution {eid} was not closed")


class RecordApiTest(RecordApiCase):
    """TexeraApi's step-3 calls, against the fake at gate 3B."""

    fake_options = {"step": "3B", "timing": RecordTiming(commit_interval_s=0.2, closing_interval_s=0.1)}

    def test_state_and_log_of_an_execution(self):
        h = self.run_once()
        state = self.closed(h.eid)
        self.assertEqual((3, False, None), (state.status, state.open, state.reason))
        self.assertGreater(state.time_ms, 1_700_000_000_000)
        log = self.api.execution_log(h.eid)
        self.assertEqual(["READY", "RUNNING", "COMPLETED"], log.states)  # state changes, and nothing else
        self.assertTrue(log.whole)
        self.assertEqual((True, 3, None, state.time_ms), (log.closed, log.outcome, log.reason, log.ended_at_ms))

    def test_a_row_of_the_log_that_is_no_state_change_has_no_state(self):
        log = ExecutionLog.of({"eid": 1, "closing": None, "entries": [
            {"seq": 1, "timeMs": 5, "state": "READY"},  # a row that names no kind is a state change
            {"seq": 2, "timeMs": 6, "kind": "output", "portId": "p"},
            {"seq": 3, "timeMs": 7, "kind": "state", "state": "RUNNING"}]})
        self.assertEqual(["READY", None, "RUNNING"], log.states)
        self.assertEqual(["state", "output", "state"], [e.kind for e in log.entries])

    def test_another_user_may_not_read_them(self):
        h = self.run_once()
        other = self.api.ensure_user("sce-e2e-other", "o@example.com", "pw")
        for read in (other.execution_state, other.execution_log):
            with self.assertRaises(TexeraApiError) as cm:
                read(h.eid)
            self.assertEqual(403, cm.exception.status)
        with self.assertRaises(TexeraApiError) as cm:
            self.api.execution_state(999)  # an execution that does not exist is 403 too
        self.assertEqual(403, cm.exception.status)

    def test_quota_sizes_and_the_admins_list(self):
        h = self.run_once()
        self.closed(h.eid)
        sizes = self.api.quota_sizes()
        self.assertEqual([h.eid], list(sizes))
        self.assertGreater(sizes[h.eid], 0)
        other_wid = self.api.create_workflow("another", {})
        listed = self.api.admin_executions([self.wid, other_wid], page_size=1)
        self.assertEqual([self.wid], list(listed))  # the other workflow has no execution
        self.assertEqual((h.eid, "COMPLETED", None),
                         (listed[self.wid].eid, listed[self.wid].status_name, listed[self.wid].reason))
        pages = [r["path"] for r in self.fake.rest_log if "/executionList/" in r["path"]]
        self.assertEqual(["/api/admin/execution/executionList/1/0/end_time/desc",
                          "/api/admin/execution/executionList/1/1/end_time/desc"], pages)


class StoredOutputApiTest(RecordApiCase):
    """TexeraApi's calls for stored output, against the fake at gate 3C."""

    fake_options = {"step": "3C", "timing": RecordTiming(commit_interval_s=0.2, closing_interval_s=0.1)}
    PRINTS = TAG.replace('tuple_["tag"] = "{tag}"', 'print(f"line {{tuple_[\'n\']}}")')

    def plan(self, tag="v1"):
        wf = Workflow("w")
        src = wf.add("numbers", "CSVFileScan", csv_scan("/dataset/x/ds/v1/numbers.csv"), n_in=0)
        udf = wf.add("printer", "PythonUDFV2", python_udf(self.PRINTS.format(tag=tag)))
        wf.link(src, udf)
        return wf, udf

    def test_console_output_page_by_page(self):
        h = self.run_once()
        self.closed(h.eid)
        self.assertTrue(self.fake.runs[h.eid].recorder.await_idle(5))  # the last lines land after the ending
        first = self.api.execution_console(h.eid, limit=250)
        self.assertEqual((250, 250, True), (len(first.messages), first.last_seq, first.more))
        self.assertEqual({"seq", "timeMs", "operatorId", "workerId", "msgType", "source", "title", "message"},
                         set(first.messages[0]))
        rest = self.api.execution_console(h.eid, after_seq=first.last_seq, limit=250)
        self.assertEqual(([251, 300], False), ([rest.messages[0]["seq"], rest.messages[-1]["seq"]], rest.more))
        self.assertEqual([], self.api.execution_console(h.eid, operator_id="another-operator").messages)
        asked = self.fake.rest_log[-1]["query"]
        self.assertEqual({"afterSeq": ["0"], "limit": ["1000"], "operatorId": ["another-operator"]}, asked)

    def test_an_export_is_a_form_with_the_users_token_and_names_the_execution(self):
        wf, udf = self.plan()
        h = self.start(wf, udf)
        h.wait_for_state("Completed", timeout=30)
        answer = self.api.export_local(self.wid, h.eid, [udf], "csv", probe="mark-1")
        self.assertEqual(200, answer.status_code)
        self.assertEqual(301, len(answer.text.splitlines()))  # the header and the 300 rows
        sent = self.fake.rest_log[-1]
        self.assertEqual(("/api/executions/result/export/local", {"sce-probe": ["mark-1"]}, ""),
                         (sent["path"], sent["query"], sent["token"]))  # no Authorization header: the form has it
        form = urllib.parse.parse_qs(sent["body"])
        self.assertEqual([self.api.token], form["token"])
        self.assertEqual({"exportType": "csv", "workflowId": self.wid, "workflowName": "",
                          "operators": [{"id": udf, "outputType": "csv"}], "datasetIds": [], "rowIndex": 0,
                          "columnIndex": 0, "filename": "", "executionId": h.eid}, json.loads(form["request"][0]))
        another = self.api.create_workflow("another", {})  # the execution must be the workflow's
        refused = self.api.export_local(another, h.eid, [udf])
        self.assertEqual((500, {"error": f"execution {h.eid} is not an execution of workflow {another}"}),
                         (refused.status_code, refused.json()))


if __name__ == "__main__":
    unittest.main()
