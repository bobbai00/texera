"""Offline tests of the driver's Kubernetes mode (driver/k8s_unit.py) against a stub of
the managing service's REST API and of the gateway's websocket. They pin the request the
driver sends (the frontend's), the status handling, the gateway probe, the termination,
and that the single-node defaults are untouched. The cluster runs of run-k8s.sh are the
evidence that it works against Texera; these keep the logic honest between them.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import k8s_unit  # noqa: E402


def parse(*argv: str) -> argparse.Namespace:
    """The driver's own defaults for --base and the single-node-only options, plus k8s_unit's
    options, as e2e.py builds them. The environment is restored afterwards (Kubernetes mode
    sets DOCKER_HOST)."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=k8s_unit.SINGLE_NODE_BASE)
    ap.add_argument("--evidence", nargs="?", const="all", default=None)
    ap.add_argument("--negative-control", action="store_true")
    ap.add_argument("--gate", default=None)
    ap.add_argument("--legacy-env", action="store_true")
    ap.add_argument("--stack-manifest", type=Path)
    k8s_unit.add_arguments(ap)
    a = ap.parse_args(list(argv))
    with mock.patch.dict("os.environ", {}, clear=False):
        k8s_unit.resolve_args(a)
    return a


def refused(status: int = 403):
    return k8s_unit.websocket.WebSocketBadStatusException(f"Handshake status {status} Forbidden", status)


REFUSALS = [refused(), refused(), refused()]  # no token, bogus token, a unit without access


class StubResponse:
    def __init__(self, status: int, text: str = ""):
        self.status_code, self.text = status, text


class StubApi:
    """computing-unit-managing-service as the driver sees it through the gateway."""

    token = "jwt"
    uid = 1

    def __init__(self, statuses: list[tuple[str, str | None]], *, types=("kubernetes",), units=None):
        self.statuses = list(statuses)
        self.types = list(types)
        self.units = dict(units or {})  # cuid -> computingUnit
        self.calls: list[tuple[str, str, object]] = []
        self.next_cuid = 7

    def get_json(self, path: str):
        self.calls.append(("GET", path, None))
        if path == "/api/computing-unit/types":
            return {"typeOptions": self.types}
        if path == "/api/computing-unit/limits":
            return {"cpuLimitOptions": ["2", "4"], "memoryLimitOptions": ["2Gi", "4Gi"],
                    "gpuLimitOptions": ["0", "1"]}
        cuid = int(path.rsplit("/", 1)[1])
        status, reason = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return {"computingUnit": dict(self.units[cuid], resource="{}"), "status": status,
                "statusReason": reason}

    def post_json(self, path: str, body: dict):
        self.calls.append(("POST", path, body))
        assert path == "/api/computing-unit/create"
        cuid = self.next_cuid
        self.next_cuid += 1
        self.units[cuid] = {"cuid": cuid, "name": body["name"], "type": "kubernetes",
                            "uri": f"computing-unit-{cuid}.svc:8085", "terminateTime": None}
        return {"computingUnit": dict(self.units[cuid]), "status": "Pending"}

    def request(self, method: str, path: str, expect=None):
        self.calls.append((method, path, None))
        cuid = int(path.split("/")[3])
        self.units[cuid]["terminateTime"] = 1
        return StubResponse(200)

    def list_units(self):
        self.calls.append(("GET", "/api/computing-unit", None))
        return [{"computingUnit": u} for u in self.units.values() if not u.get("terminateTime")]

    def create_workflow(self, name: str, content: dict) -> int:
        self.calls.append(("POST", "/api/workflow/create", name))
        return 42


class StubSocket:
    def __init__(self, messages):
        self.messages = list(messages)

    def recv(self):
        return json.dumps(self.messages.pop(0))

    def close(self):
        pass


class ArgsTest(unittest.TestCase):
    def test_single_node_defaults_are_unchanged(self):
        a = parse()
        self.assertEqual((a.target, a.unit_kind, a.base), ("single-node", "local", k8s_unit.SINGLE_NODE_BASE))
        self.assertFalse(k8s_unit.wanted(a))

    def test_k8s_target_uses_the_gateway_forward_of_the_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "MANIFEST.json"
            manifest.write_text(json.dumps({"gateway_url": "http://127.0.0.1:31234"}))
            with mock.patch.object(k8s_unit, "K8S_MANIFEST", manifest), \
                    mock.patch.dict("os.environ", {}, clear=False) as env:
                env.pop("SCE_BASE", None)
                a = parse("--target", "k8s")
                self.assertEqual((a.unit_kind, a.base), ("kubernetes", "http://127.0.0.1:31234"))
                b = parse("--target", "k8s", "--base", "http://example:1")
                self.assertEqual(b.base, "http://example:1")
        self.assertTrue(k8s_unit.wanted(parse("--unit-kind", "kubernetes")))

    def test_k8s_mode_refuses_options_that_reach_the_single_node_stack(self):
        for flags, named in ((["--evidence"], "--evidence"), (["--evidence", "F"], "--evidence"),
                             (["--negative-control"], "--negative-control"), (["--gate", "A"], "--gate"),
                             (["--legacy-env"], "--legacy-env")):
            with self.assertRaises(SystemExit) as cm:
                parse("--target", "k8s", *flags)
            self.assertIn(named, str(cm.exception))
            with self.assertRaises(SystemExit):
                parse("--unit-kind", "kubernetes", *flags)
        a = parse("--evidence", "--gate", "A", "--legacy-env")  # single-node: untouched
        self.assertEqual((a.unit_kind, a.evidence, a.stack_manifest), ("local", "all", None))

    def test_a_step_3_gate_is_not_single_node_only(self):
        """A step-3 gate names what Kubernetes mode runs (design H6); step 2's gates gate on
        the statement log, which only the single-node stack has."""
        portable = frozenset({"3A"})
        ap = argparse.ArgumentParser()
        ap.add_argument("--base", default="http://127.0.0.1:30080")
        ap.add_argument("--gate", default=None)
        ap.add_argument("--evidence", default=None)
        k8s_unit.add_arguments(ap)
        with mock.patch.dict("os.environ", {}, clear=False):
            a = ap.parse_args(["--target", "k8s", "--gate", "3A"])
            k8s_unit.resolve_args(a, portable_gates=portable)  # accepted
            for refused in (["--gate", "D"], ["--gate", "3A", "--evidence", "I"]):
                with self.assertRaises(SystemExit) as cm:
                    k8s_unit.resolve_args(ap.parse_args(["--target", "k8s", *refused]), portable_gates=portable)
                self.assertIn(refused[-2], str(cm.exception))

    def test_k8s_mode_reads_its_own_manifest_and_cuts_the_driver_off_docker(self):
        with mock.patch.dict("os.environ", {}, clear=False) as env:
            env.pop("DOCKER_HOST", None)
            a = parse("--target", "k8s", "--base", "http://127.0.0.1:30080")
            self.assertEqual(a.stack_manifest, k8s_unit.K8S_MANIFEST)
            self.assertNotIn("DOCKER_HOST", env)  # parse() restores the environment
            k8s_unit.resolve_args(a)
            self.assertEqual(env["DOCKER_HOST"], k8s_unit.NO_DOCKER)
        mine = Path("/tmp/m.json")
        self.assertEqual(parse("--target", "k8s", "--stack-manifest", str(mine)).stack_manifest, mine)

    def test_k8s_mode_refuses_scenarios_that_need_the_single_node_stack(self):
        a = parse("--target", "k8s", "--base", "http://127.0.0.1:30080")
        for keys, transport in ((["a", "g0"], "ws"), (["l4"], "create-ws"), (["j"], "create-ws"),
                                (["l2", "l10"], "create-ws")):
            with self.assertRaises(SystemExit) as cm:
                k8s_unit.check_selection(a, keys, transport)
            for k in keys:
                if k != "a":
                    self.assertIn(k, str(cm.exception))
        # the baseline, j on ws (no second user there) and the create-ws scenarios on the unit itself
        k8s_unit.check_selection(a, ["a", "b", "c", "d", "e", "u", "j"], "ws")
        k8s_unit.check_selection(a, ["k", "l1", "l6", "l8", "m", "f", "f2", "i"], "create-ws")
        # what runs a command where the unit runs does so in the unit's pod
        k8s_unit.check_selection(a, ["g", "h", "o"], "create-ws")
        k8s_unit.check_selection(parse(), ["g0", "o", "l4", "j"], "create-ws")  # single-node: anything

    def test_commands_for_the_unit_run_in_the_pod_labelled_with_its_id(self):
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "MANIFEST.json"
            manifest.write_text(json.dumps({"context": "ctx", "unit_namespace": "units"}))
            kubectl = ["kubectl", "--context", "ctx", "-n", "units"]
            found = mock.Mock(returncode=0, stdout="pod/computing-unit-7\n")
            with mock.patch.object(k8s_unit, "K8S_MANIFEST", manifest), \
                    mock.patch("k8s_unit.subprocess.run", return_value=found) as run:
                prefix = k8s_unit.exec_prefix(7)
            self.assertEqual(run.call_args.args[0],
                             [*kubectl, "get", "pods", "-l", "type=computing-unit,cuid=7", "-o", "name"])
            self.assertEqual(prefix(False), [*kubectl, "exec", "pod/computing-unit-7",
                                             "-c", "computing-unit-master", "--"])
            self.assertEqual(prefix(True), [*kubectl, "exec", "-i", "pod/computing-unit-7",
                                            "-c", "computing-unit-master", "--"])
            for answer in (mock.Mock(returncode=0, stdout=""), mock.Mock(returncode=1, stdout="refused"),
                           mock.Mock(returncode=0, stdout="pod/a\npod/b\n")):
                with mock.patch.object(k8s_unit, "K8S_MANIFEST", manifest), \
                        mock.patch("k8s_unit.subprocess.run", return_value=answer), \
                        self.assertRaises(RuntimeError):
                    k8s_unit.exec_prefix(7)


@mock.patch("k8s_unit.time.sleep", lambda s: None)
class LifecycleTest(unittest.TestCase):
    def setUp(self):
        k8s_unit._state.update(cuids=[], done=False)
        self.report = {"setup": {}}
        self.logged: list[str] = []

    def run_setup(self, api, sockets):
        a = parse("--target", "k8s", "--base", "http://127.0.0.1:30080")
        with mock.patch("k8s_unit.websocket.create_connection", side_effect=sockets) as conn:
            unit = k8s_unit.setup(api, a, run_id="0101-000000", log=self.logged.append, report=self.report)
        return a, unit, conn

    def test_creates_waits_for_running_probes_the_gateway_then_terminates(self):
        api = StubApi([("Pending", None), ("Pending", None), ("Running", None)])
        a, unit, conn = self.run_setup(api, [
            ConnectionResetError("503 Service Unavailable"),  # the pod runs, its JVM is not up yet
            StubSocket([{"type": "ClusterStatusUpdateEvent"},
                        {"type": "WorkflowStateEvent", "state": "Uninitialized"}]),
            *REFUSALS,
        ])
        create = next(body for m, p, body in api.calls if p == "/api/computing-unit/create")
        self.assertEqual(create, {"name": "sce-e2e-k8s-0101-000000", "unitType": "kubernetes",
                                  "cpuLimit": "2", "memoryLimit": "2Gi", "gpuLimit": "0",
                                  "jvmMemorySize": "1G", "shmSize": "64Mi", "uri": ""})
        self.assertEqual((unit["cuid"], unit["type"]), (7, "kubernetes"))
        rec = self.report["setup"]["kubernetes_unit"]
        self.assertEqual([h["status"] for h in rec["status_history"]], ["Pending", "Running"])
        self.assertEqual(rec["gateway_probe"]["attempts"], 2)
        url = conn.call_args_list[1].args[0]
        self.assertTrue(url.startswith("ws://127.0.0.1:30080/wsapi/workflow-websocket?"), url)
        self.assertIn("cuid=7", url)
        self.assertIn("wid=42", url)
        self.assertIn("access-token=jwt", url)
        # then the same socket without valid credentials: all refused, each marked for Envoy's log
        probes = rec["gateway_refusals"]
        self.assertEqual([(p["probe"], p["cuid"], p["status"], p["refused"]) for p in probes],
                         [("no-token", 7, 403, True), ("bogus-token", 7, 403, True),
                          ("unit-without-access", 100007, 403, True)])
        urls = [c.args[0] for c in conn.call_args_list[2:]]
        self.assertNotIn("access-token", urls[0])
        self.assertIn("access-token=sce-e2e-not-a-token", urls[1])
        self.assertIn("access-token=jwt", urls[2])
        self.assertIn("cuid=100007", urls[2])
        for p, u in zip(probes, urls):
            self.assertIn(f"sce-probe={p['marker']}", u)
        self.assertNotIn(("DELETE", "/api/computing-unit/7/terminate", None), api.calls)

        k8s_unit.teardown(api, a, log=self.logged.append, report=self.report)
        self.assertIn(("DELETE", "/api/computing-unit/7/terminate", None), api.calls)
        self.assertEqual(rec["termination"]["http_status"], 200)
        self.assertTrue(rec["termination"]["gone_from_list"])
        k8s_unit.teardown(api, a, log=self.logged.append, report=self.report)  # once only
        self.assertEqual(sum(1 for c in api.calls if c[0] == "DELETE"), 1)

    def control(self, api, a) -> k8s_unit.KubernetesControl:
        manifest = Path(tempfile.mkdtemp()) / "MANIFEST.json"
        manifest.write_text(json.dumps({"namespace": "sce-k8s", "context": "ctx", "unit_namespace": "units"}))
        with mock.patch.object(k8s_unit, "K8S_MANIFEST", manifest):
            return k8s_unit.KubernetesControl(api, a, run_id="0101-000000", cuid=7, log=self.logged.append)

    def test_the_stacks_control_deletes_the_pod_through_the_stack_script(self):
        api = StubApi([("Running", None)])
        a, _unit, _conn = self.run_setup(api, [StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}]),
                                              *REFUSALS])
        control = self.control(api, a)
        self.assertTrue(control.listing_notices_lost_unit)
        answers = {"unit-kill": {"pod": "computing-unit-7"}, "unit-stop": {"pod": "computing-unit-7"},
                   "pg-activity": [{"pid": 1, "application_name": "texera-dashboard"}],
                   "unit-env": {"cuid": 7, "address": "10.42.0.9", "env_names": ["A", "B"]}}
        with mock.patch("k8s_unit.run_stack_script", side_effect=lambda script, *args: answers[args[2]]) as run:
            self.assertEqual({"pod": "computing-unit-7"}, control.kill_unit())
            self.assertEqual({"pod": "computing-unit-7"}, control.stop_unit())
            self.assertEqual(answers["pg-activity"], control.pg_activity())
            self.assertEqual(["A", "B"], control.unit_env_names())
            self.assertEqual(["10.42.0.9"], control.unit_addresses())
        self.assertEqual([(k8s_unit.K8S_STACK, "--namespace", "sce-k8s", "unit-kill", "7"),
                          (k8s_unit.K8S_STACK, "--namespace", "sce-k8s", "unit-stop", "7"),
                          (k8s_unit.K8S_STACK, "--namespace", "sce-k8s", "pg-activity"),
                          (k8s_unit.K8S_STACK, "--namespace", "sce-k8s", "unit-env", "7"),
                          (k8s_unit.K8S_STACK, "--namespace", "sce-k8s", "unit-env", "7")],
                         [c.args for c in run.call_args_list])
        gone = k8s_unit.StackControlError("expected one pod of computing unit 7, found 0")
        with mock.patch("k8s_unit.run_stack_script", side_effect=gone):
            self.assertEqual([], control.unit_addresses())  # a unit whose pod is gone has no address

    def test_the_unit_that_comes_back_is_a_new_one_made_without_listing_the_units(self):
        """A listing makes the manager stamp units whose pod is gone, which ends a wait for
        the beat at once (design D27): `start_unit` must not cause one."""
        api = StubApi([("Running", None)])
        a, _unit, _conn = self.run_setup(api, [StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}]),
                                              *REFUSALS])
        control = self.control(api, a)
        api.calls.clear()
        with mock.patch("k8s_unit.websocket.create_connection", side_effect=[
                StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}])]) as conn:
            started = control.start_unit()
        self.assertEqual((8, "sce-e2e-k8s-0101-000000-2"), (started["cuid"], started["name"]))
        self.assertEqual(8, control.cuid)
        self.assertNotIn(("GET", "/api/computing-unit", None), api.calls)
        self.assertIn("cuid=8", conn.call_args.args[0])
        self.assertIn("wid=42", conn.call_args.args[0])  # the setup's probe workflow
        create = next(body for m, p, body in api.calls if p == "/api/computing-unit/create")
        self.assertEqual(("kubernetes", "2", "2Gi"), (create["unitType"], create["cpuLimit"], create["memoryLimit"]))
        # every unit the run made is terminated at its end, the setup's and the later one
        k8s_unit.teardown(api, a, log=self.logged.append, report=self.report)
        self.assertEqual([("DELETE", "/api/computing-unit/7/terminate", None),
                          ("DELETE", "/api/computing-unit/8/terminate", None)],
                         [c for c in api.calls if c[0] == "DELETE"])
        rec = self.report["setup"]["kubernetes_unit"]
        self.assertEqual((7, 200, ["8"]), (rec["cuid"], rec["termination"]["http_status"], list(rec["later_units"])))

    def test_keep_unit_keeps_the_one_in_use(self):
        api = StubApi([("Running", None)])
        a, _unit, _conn = self.run_setup(api, [StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}]),
                                              *REFUSALS])
        with mock.patch("k8s_unit.websocket.create_connection", side_effect=[
                StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}])]):
            self.control(api, a).start_unit()
        a.keep_unit = True
        k8s_unit.teardown(api, a, log=self.logged.append, report=self.report)
        self.assertEqual([("DELETE", "/api/computing-unit/7/terminate", None)],
                         [c for c in api.calls if c[0] == "DELETE"])
        self.assertEqual(8, self.report["setup"]["kubernetes_unit"]["kept"])

    def test_a_failed_unit_fails_setup_at_once_and_is_terminated(self):
        api = StubApi([("Failed", "The computing unit's image could not be pulled.")])
        with self.assertRaisesRegex(RuntimeError, "could not be pulled"):
            self.run_setup(api, [])
        self.assertIn(("DELETE", "/api/computing-unit/7/terminate", None), api.calls)

    def test_leftover_units_of_the_harness_are_terminated_first(self):
        api = StubApi([("Running", None)], units={
            3: {"cuid": 3, "name": "sce-e2e-k8s-old", "type": "kubernetes", "terminateTime": None},
            4: {"cuid": 4, "name": "someone-else", "type": "kubernetes", "terminateTime": None},
        })
        self.run_setup(api, [StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}]), *REFUSALS])
        self.assertEqual(self.report["setup"]["kubernetes_unit"]["stale_terminated"], [3])
        self.assertIsNone(api.units[4]["terminateTime"])

    def test_a_gateway_that_lets_a_bogus_token_through_fails_setup(self):
        api = StubApi([("Running", None)])
        with self.assertRaisesRegex(RuntimeError, "did not refuse the unit's socket for: bogus-token"):
            self.run_setup(api, [StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}]),
                                 refused(401), StubSocket([]), refused(403)])
        probes = self.report["setup"]["kubernetes_unit"]["gateway_refusals"]
        self.assertEqual([p["status"] for p in probes], [401, 101, 403])
        self.assertIn(("DELETE", "/api/computing-unit/7/terminate", None), api.calls)  # not left running

    def test_a_deployment_without_kubernetes_units_is_refused(self):
        api = StubApi([("Running", None)], types=("local",))
        with self.assertRaisesRegex(RuntimeError, "does not offer Kubernetes units"):
            self.run_setup(api, [])
        self.assertFalse(any(p == "/api/computing-unit/create" for _, p, _ in api.calls))


if __name__ == "__main__":
    unittest.main()
