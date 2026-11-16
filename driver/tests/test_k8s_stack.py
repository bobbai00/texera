"""Offline tests of the Kubernetes stack controller's decisions (stack/k8s/k8s_stack.py):
when a crash loop fails `up`, how the S3 workaround reads the rendered webserver, the CRD
comparison, Envoy's access log, the refusal verdicts, the post-run check and the gateway
forward. No cluster, helm or kubectl is used; the cluster runs of run-k8s.sh are the
evidence that the controller works against one.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "stack" / "k8s"))

import k8s_stack as ks  # noqa: E402


def deployment(name: str, image: str, env=(), env_from=()) -> dict:
    return {"kind": "Deployment", "metadata": {"name": name},
            "spec": {"template": {"spec": {"containers": [
                {"name": name, "image": image, "env": [{"name": n, "value": "x"} for n in env],
                 "envFrom": list(env_from)}]}}}}


def crd(name: str, schema_note: str, bundle: str | None = "v1.4.1") -> dict:
    ann = {ks.BUNDLE_VERSION: bundle} if bundle else {ks.GEN_VERSION: "v0.18.0"}
    return {"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
            "metadata": {"name": name, "annotations": ann},
            "spec": {"versions": [{"name": "v1", "served": True, "storage": True,
                                   "schema": {"openAPIV3Schema": {"type": "object",
                                                                  "description": schema_note}}}]}}


class CrashLoopTest(unittest.TestCase):
    def test_crashes_before_postgres_is_ready_never_fail_up(self):
        db = {"ready_at": None, "baseline": {}}
        self.assertFalse(ks.crash_loop_fatal("texera-file-service-1", "file-service", 12, db))

    def test_after_postgres_is_ready_three_more_crashes_fail_up(self):
        db = {"ready_at": 100.0, "baseline": {"texera-file-service-1/file-service": 4}}
        self.assertFalse(ks.crash_loop_fatal("texera-file-service-1", "file-service", 4, db))
        self.assertFalse(ks.crash_loop_fatal("texera-file-service-1", "file-service", 6, db))
        self.assertTrue(ks.crash_loop_fatal("texera-file-service-1", "file-service", 7, db))
        # a pod first seen after Postgres became ready counts from its first sighting
        self.assertFalse(ks.crash_loop_fatal("texera-webserver-2", "webserver", 1, db))
        self.assertEqual(db["baseline"]["texera-webserver-2/webserver"], 1)
        self.assertTrue(ks.crash_loop_fatal("texera-webserver-2", "webserver", 4, db))

    def test_postgres_itself_fails_up_after_six_restarts(self):
        db = {"ready_at": None, "baseline": {}}
        self.assertFalse(ks.crash_loop_fatal("texera-postgresql-0", "postgresql", 5, db))
        self.assertTrue(ks.crash_loop_fatal("texera-postgresql-0", "postgresql", 6, db))


class WebserverEnvTest(unittest.TestCase):
    IMAGE = "sce/texera-dashboard-service:step1"

    def test_found_by_image_whatever_its_name(self):
        docs = [deployment("texera-file-service", "sce/texera-file-service:step1"),
                deployment("texera-dashboard-renamed", self.IMAGE, env=["STORAGE_JDBC_URL"])]
        web = ks.workload_with_image(docs, self.IMAGE)
        self.assertEqual(web["metadata"]["name"], "texera-dashboard-renamed")
        self.assertNotIn("STORAGE_S3_ENDPOINT", ks.env_names(web, docs))
        self.assertIsNone(ks.workload_with_image(docs, "sce/texera-dashboard-service:other"))

    def test_env_and_env_from_config_maps_and_secrets(self):
        cm = {"kind": "ConfigMap", "metadata": {"name": "storage"}, "data": {"STORAGE_S3_ENDPOINT": "http://s3"}}
        sec = {"kind": "Secret", "metadata": {"name": "creds"}, "stringData": {"KEY": "v"}}
        web = deployment("texera-webserver", self.IMAGE, env=["A"],
                         env_from=[{"configMapRef": {"name": "storage"}},
                                   {"secretRef": {"name": "creds"}, "prefix": "S3_"}])
        names = ks.env_names(web, [web, cm, sec])
        self.assertEqual(names, {"A", "STORAGE_S3_ENDPOINT", "S3_KEY"})
        self.assertIn("STORAGE_S3_ENDPOINT",
                      ks.env_names(deployment("w", self.IMAGE, env=["STORAGE_S3_ENDPOINT"]), []))


class CrdTest(unittest.TestCase):
    def test_same_absent_and_differs(self):
        chart = [crd("gateways.gateway.networking.k8s.io", "a"), crd("httproutes.gateway.networking.k8s.io", "b"),
                 crd("backends.gateway.envoyproxy.io", "c", bundle=None)]
        cluster = [crd("gateways.gateway.networking.k8s.io", "a"),
                   crd("backends.gateway.envoyproxy.io", "older", bundle=None),
                   crd("addons.k3s.cattle.io", "k3s's own")]
        cluster[1]["metadata"]["creationTimestamp"] = "2026-11-06T20:37:17Z"
        out = ks.compare_crds(chart, cluster)
        self.assertEqual(out["same"], ["gateways.gateway.networking.k8s.io"])
        self.assertEqual(out["absent"], ["httproutes.gateway.networking.k8s.io"])
        self.assertEqual(out["differs"], [{"name": "backends.gateway.envoyproxy.io", "cluster": "v0.18.0",
                                           "chart": "v0.18.0", "cluster_created": "2026-11-06T20:37:17Z"}])

    def test_a_cluster_crd_with_server_defaults_and_status_is_the_same(self):
        mine = crd("gateways.gateway.networking.k8s.io", "a")
        theirs = json.loads(json.dumps(mine))
        theirs["metadata"].update(uid="u", resourceVersion="9", creationTimestamp="t")
        theirs["spec"]["conversion"] = {"strategy": "None"}
        theirs["status"] = {"storedVersions": ["v1"]}
        self.assertEqual(ks.crd_digest(mine), ks.crd_digest(theirs))
        theirs["spec"]["versions"][0]["served"] = False
        self.assertNotEqual(ks.crd_digest(mine), ks.crd_digest(theirs))

    def test_chart_crds_reads_the_subchart_archives(self):
        with tempfile.TemporaryDirectory() as d:
            chart = Path(d)
            (chart / "charts").mkdir()
            with tarfile.open(chart / "charts" / "gateway-helm-1.6.3.tgz", "w:gz") as t:
                for name, doc in (("gateway-helm/crds/gatewayapi-crds.yaml", crd("gateways.gateway.networking.k8s.io", "a")),
                                  ("gateway-helm/templates/deployment.yaml", deployment("eg", "envoyproxy/gateway:v1.6.3"))):
                    data = yaml.safe_dump(doc).encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    t.addfile(info, io.BytesIO(data))
            self.assertEqual([c["metadata"]["name"] for c in ks.chart_crds(chart)],
                             ["gateways.gateway.networking.k8s.io"])


def access_line(path: str, code: int, details: str) -> str:
    return json.dumps({"x-envoy-origin-path": path, "response_code": code, "response_code_details": details,
                       "response_flags": "UAEX" if details == "ext_authz_denied" else "-",
                       "route_name": "httproute/sce-k8s/texera-dynamic-routes/rule/0/match/0/*",
                       "start_time": "2026-11-16T10:34:47.925Z"})


class EnvoyLogTest(unittest.TestCase):
    def test_entries_are_found_by_their_probe_marker(self):
        log = "\n".join([
            "[2026-11-16 10:00:00.000][1][info][main] starting main dispatch loop",
            access_line("/wsapi/workflow-websocket?wid=1&uid=1&cuid=1&sce-probe=up-no-token-1", 403, "ext_authz_denied"),
            access_line("/wsapi/workflow-websocket?wid=1&cuid=1&access-token=x&sce-probe=up-bogus-token-1", 403,
                        "ext_authz_denied"),
            access_line("/wsapi/workflow-websocket?wid=2&uid=1&cuid=1&access-token=t", 101, "via_upstream"),
            access_line("/wsapi/workflow-websocket?cuid=1&sce-probe=up-bogus-token-10", 403, "ext_authz_denied"),
            "{not json sce-probe=",
        ])
        found = ks.parse_access_log(log, {"up-no-token-1", "up-bogus-token-1", "up-missing-1"})
        self.assertEqual(set(found), {"up-no-token-1", "up-bogus-token-1"})
        self.assertEqual(found["up-no-token-1"]["response_code_details"], "ext_authz_denied")

    def test_verdicts(self):
        self.assertEqual(ks.judge_refusal(403, {"response_code_details": "ext_authz_denied"})[:2], (True, True))
        self.assertEqual(ks.judge_refusal(401, {"response_code_details": "ext_authz_denied"})[:2], (True, True))
        self.assertEqual(ks.judge_refusal(403, None)[:2], (True, None))
        refused, by_authz, verdict = ks.judge_refusal(403, {"response_code_details": "via_upstream"})
        self.assertEqual((refused, by_authz), (False, False))
        self.assertIn("not by ext-authz", verdict)
        self.assertEqual(ks.judge_refusal(101, None)[:2], (False, None))
        self.assertEqual(ks.judge_refusal(None, None)[:2], (False, None))


class PostRunTest(unittest.TestCase):
    PROBES = [{"probe": "no-token", "cuid": 1, "status": 403, "refused": True, "marker": "driver-no-token-r"},
              {"probe": "bogus-token", "cuid": 1, "status": 403, "refused": True, "marker": "driver-bogus-token-r"}]
    ENVOY = {"driver-no-token-r": {"response_code": 403, "response_code_details": "ext_authz_denied"},
             "driver-bogus-token-r": {"response_code": 403, "response_code_details": "ext_authz_denied"}}

    def test_a_clean_run(self):
        post = ks.evaluate_post_run(pods_left=[], unit_kept=False, forward={"mode": "relay"},
                                    driver_probes=self.PROBES, envoy=self.ENVOY)
        self.assertEqual((post["failures"], post["warnings"], post["reliable"]), ([], [], True))
        self.assertTrue(all(r["by_ext_authz"] for r in post["gateway_refusals"]))
        report = {"summary": {"result": "PASS"}}
        ks.apply_post_run(report, post)
        self.assertEqual(report["summary"], {"result": "PASS", "reliable": True})

    def test_a_unit_pod_left_behind_fails_the_run(self):
        post = ks.evaluate_post_run(pods_left=["computing-unit-1"], unit_kept=False, forward={"mode": "relay"},
                                    driver_probes=[], envoy={})
        report = {"summary": {"result": "PASS"}}
        ks.apply_post_run(report, post)
        self.assertEqual(report["summary"]["result"], "FAIL")
        self.assertIn("computing-unit-1", report["summary"]["post_run_failures"][0])
        kept = ks.evaluate_post_run(pods_left=["computing-unit-1"], unit_kept=True, forward={"mode": "relay"},
                                    driver_probes=[], envoy={})
        self.assertEqual(kept["failures"], [])

    def test_kubectl_forwarding_marks_the_run_unreliable(self):
        post = ks.evaluate_post_run(pods_left=[], unit_kept=False, forward={"mode": "kubectl"},
                                    driver_probes=[], envoy={})
        self.assertIs(post["reliable"], False)
        self.assertIn("kubectl port-forward", post["warnings"][0])

    def test_a_refusal_that_was_not_ext_authz_fails_and_a_missing_entry_warns(self):
        envoy = {"driver-no-token-r": {"response_code": 403, "response_code_details": "via_upstream"}}
        post = ks.evaluate_post_run(pods_left=[], unit_kept=False, forward={"mode": "relay"},
                                    driver_probes=self.PROBES, envoy=envoy)
        self.assertEqual(len(post["failures"]), 1)
        self.assertIn("no-token", post["failures"][0])
        self.assertEqual(len(post["warnings"]), 1)
        self.assertIn("bogus-token", post["warnings"][0])


class ForwardTest(unittest.TestCase):
    def test_an_unreachable_cluster_ip_fails_instead_of_falling_back_to_kubectl(self):
        with mock.patch.object(ks, "pf_running", return_value=None), \
                mock.patch.object(ks, "relay_target", return_value=("192.0.2.1", 80)), \
                mock.patch.object(ks, "host_reaches", return_value=False), \
                mock.patch.object(ks.subprocess, "Popen") as popen, \
                mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            with self.assertRaises(SystemExit):
                ks.pf_start("sce-k8s", 30080, "relay")
        popen.assert_not_called()
        self.assertIn("--forward kubectl", err.getvalue())


if __name__ == "__main__":
    unittest.main()
