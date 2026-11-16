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
    """The driver's own defaults for --base, plus k8s_unit's options, as e2e.py builds them."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=k8s_unit.SINGLE_NODE_BASE)
    k8s_unit.add_arguments(ap)
    a = ap.parse_args(list(argv))
    k8s_unit.resolve_args(a)
    return a


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


@mock.patch("k8s_unit.time.sleep", lambda s: None)
class LifecycleTest(unittest.TestCase):
    def setUp(self):
        k8s_unit._state.update(cuid=None, done=False)
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
        ])
        create = next(body for m, p, body in api.calls if p == "/api/computing-unit/create")
        self.assertEqual(create, {"name": "sce-e2e-k8s-0101-000000", "unitType": "kubernetes",
                                  "cpuLimit": "2", "memoryLimit": "2Gi", "gpuLimit": "0",
                                  "jvmMemorySize": "1G", "shmSize": "64Mi", "uri": ""})
        self.assertEqual((unit["cuid"], unit["type"]), (7, "kubernetes"))
        rec = self.report["setup"]["kubernetes_unit"]
        self.assertEqual([h["status"] for h in rec["status_history"]], ["Pending", "Running"])
        self.assertEqual(rec["gateway_probe"]["attempts"], 2)
        url = conn.call_args.args[0]
        self.assertTrue(url.startswith("ws://127.0.0.1:30080/wsapi/workflow-websocket?"), url)
        self.assertIn("cuid=7", url)
        self.assertIn("wid=42", url)
        self.assertNotIn(("DELETE", "/api/computing-unit/7/terminate", None), api.calls)

        k8s_unit.teardown(api, a, log=self.logged.append, report=self.report)
        self.assertIn(("DELETE", "/api/computing-unit/7/terminate", None), api.calls)
        self.assertEqual(rec["termination"]["http_status"], 200)
        self.assertTrue(rec["termination"]["gone_from_list"])
        k8s_unit.teardown(api, a, log=self.logged.append, report=self.report)  # once only
        self.assertEqual(sum(1 for c in api.calls if c[0] == "DELETE"), 1)

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
        self.run_setup(api, [StubSocket([{"type": "WorkflowStateEvent", "state": "Uninitialized"}])])
        self.assertEqual(self.report["setup"]["kubernetes_unit"]["stale_terminated"], [3])
        self.assertIsNone(api.units[4]["terminateTime"])

    def test_a_deployment_without_kubernetes_units_is_refused(self):
        api = StubApi([("Running", None)], types=("local",))
        with self.assertRaisesRegex(RuntimeError, "does not offer Kubernetes units"):
            self.run_setup(api, [])
        self.assertFalse(any(p == "/api/computing-unit/create" for _, p, _ in api.calls))


if __name__ == "__main__":
    unittest.main()
