"""Offline tests of local-dev mode: the driver's side (driver/localdev_unit.py: defaults,
refusals, the unit the frontend's dialog would create, the probe through the dev server)
and the stack controller's decisions (stack/localdev/localdev_stack.py: what it reads from
the source's bin/local-dev, the renamed infrastructure, the remapped environment). No
Docker, JVM or dev server is started; run-localdev.sh's runs are the evidence that the
mode works against Texera.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

HARNESS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HARNESS / "driver"))
sys.path.insert(0, str(HARNESS / "stack" / "localdev"))

import k8s_unit  # noqa: E402
import localdev_stack as ls  # noqa: E402
import localdev_unit  # noqa: E402

SOURCE = Path(os.environ.get("SCE_LOCALDEV_SOURCE", str(ls.DEFAULT_SOURCE)))
HAS_SOURCE = (SOURCE / "bin" / "local-dev" / "main.sh").exists()


def parse(*argv: str) -> argparse.Namespace:
    """e2e.py's defaults for the options local-dev mode reads, plus k8s_unit's (which owns
    --target), resolved in e2e.py's order. DOCKER_HOST is restored afterwards."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=localdev_unit.SINGLE_NODE_BASE)
    ap.add_argument("--unit-uri", default=localdev_unit.SINGLE_NODE_UNIT_URI)
    ap.add_argument("--unit-name", default="sce-e2e-unit")
    ap.add_argument("--timeout", type=float, default=300)
    ap.add_argument("--evidence", nargs="?", const="all", default=None)
    ap.add_argument("--negative-control", action="store_true")
    ap.add_argument("--gate", default=None)
    ap.add_argument("--legacy-env", action="store_true")
    ap.add_argument("--stack-manifest", type=Path)
    k8s_unit.add_arguments(ap)
    a = ap.parse_args(list(argv))
    with mock.patch.dict("os.environ", {}, clear=False) as env:
        env.pop("SCE_BASE", None)
        env.pop("SCE_UNIT_URI", None)
        k8s_unit.resolve_args(a)
        localdev_unit.resolve_args(a)
    return a


class StubApi:
    """The deployment as the driver sees it through the dev server."""

    token = "jwt"
    uid = 1

    def __init__(self, types=("local",), units=()):
        self.types = list(types)
        self.units = [dict(u) for u in units]
        self.calls: list[tuple] = []

    def get_json(self, path):
        self.calls.append(("GET", path))
        assert path == "/api/computing-unit/types"
        return {"typeOptions": self.types}

    def list_units(self):
        return [{"computingUnit": u} for u in self.units]

    def ensure_local_unit(self, name, uri):  # texera_api.TexeraApi's contract
        self.calls.append(("ensure_local_unit", name, uri))
        for u in self.units:
            if u["name"] == name and u["uri"] == uri:
                return u
        u = {"cuid": 5 + len(self.units), "name": name, "uri": uri, "type": "local"}
        self.units.append(u)
        return u

    def create_workflow(self, name, content):
        self.calls.append(("POST", "/api/workflow/create", name))
        return 77


class DevPage:
    status_code = 200
    headers = {"Content-Type": "text/html"}
    text = "<html><head><title>Texera</title></head><body><texera-root></texera-root></body></html>"


class DriverArgsTest(unittest.TestCase):
    def test_single_node_defaults_are_unchanged(self):
        a = parse()
        self.assertEqual((a.target, a.base, a.unit_uri), ("single-node", localdev_unit.SINGLE_NODE_BASE,
                                                          localdev_unit.SINGLE_NODE_UNIT_URI))
        self.assertFalse(localdev_unit.wanted(a))
        self.assertIsNone(a.stack_manifest)

    def test_localdev_target_goes_through_the_dev_server(self):
        with tempfile.TemporaryDirectory() as d:
            missing = Path(d) / "none.json"
            with mock.patch.object(localdev_unit, "MANIFEST", missing), \
                    mock.patch.object(k8s_unit, "guard_docker") as guard:
                a = parse("--target", "localdev")
            self.assertEqual(a.base, "http://localhost:4200")
            # the frontend's buildLocalComputingUnitUri(window.location) for that page
            self.assertEqual(a.unit_uri, "http://localhost:4200/wsapi")
            self.assertEqual(a.unit_kind, "local")
            self.assertEqual(a.stack_manifest, missing)
            guard.assert_called_once()  # DOCKER_HOST at a socket that does not exist
        with mock.patch.dict("os.environ", {}, clear=False):
            k8s_unit.guard_docker()
            self.assertEqual(os.environ["DOCKER_HOST"], k8s_unit.NO_DOCKER)

    def test_explicit_base_and_unit_uri_win(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            a = parse("--target", "localdev", "--base", "http://127.0.0.1:4300")
            self.assertEqual((a.base, a.unit_uri), ("http://127.0.0.1:4300", "http://127.0.0.1:4300/wsapi"))
            b = parse("--target", "localdev", "--unit-uri", "http://localhost:8085")
            self.assertEqual(b.unit_uri, "http://localhost:8085")

    def test_the_manifest_names_the_dev_server(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict("os.environ", {}, clear=False):
            m = Path(d) / "MANIFEST.json"
            m.write_text(json.dumps({"frontend_url": "http://localhost:4211"}))
            with mock.patch.object(localdev_unit, "MANIFEST", m):
                a = parse("--target", "localdev")
            self.assertEqual((a.base, a.unit_uri), ("http://localhost:4211", "http://localhost:4211/wsapi"))

    def test_refuses_what_reads_the_single_node_stack(self):
        for flags, named in ((["--evidence"], "--evidence"), (["--negative-control"], "--negative-control"),
                             (["--gate", "A"], "--gate"), (["--legacy-env"], "--legacy-env")):
            with mock.patch.dict("os.environ", {}, clear=False), self.assertRaises(SystemExit) as cm:
                parse("--target", "localdev", *flags)
            self.assertIn(named, str(cm.exception))
        with mock.patch.dict("os.environ", {}, clear=False), self.assertRaises(SystemExit) as cm:
            parse("--target", "localdev", "--unit-kind", "kubernetes")
        self.assertIn("local", str(cm.exception))

    def test_refuses_the_unit_container_scenarios(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            a = parse("--target", "localdev")
        localdev_unit.check_selection(a, ["a", "b", "c", "d", "e", "u", "j"], "ws")
        for key in ("g0", "g", "h", "o"):
            with self.assertRaises(SystemExit) as cm:
                localdev_unit.check_selection(a, ["a", key], "create-ws")
            self.assertIn(key, str(cm.exception))
        localdev_unit.check_selection(parse(), ["g0", "o"], "create-ws")  # single-node: not ours to refuse


class DriverSetupTest(unittest.TestCase):
    def setUp(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            self.a = parse("--target", "localdev")
        self.report = {"setup": {}}
        self.logs: list[str] = []

    def run_setup(self, api, page=DevPage()):
        with mock.patch.object(localdev_unit.requests, "get", return_value=page) as get, \
                mock.patch.object(k8s_unit, "wait_reachable",
                                  return_value={"attempts": 1, "seconds": 0.2, "first_state": "Uninitialized"}) as ws:
            unit = localdev_unit.setup(api, self.a, run_id="0101-000000", log=self.logs.append, report=self.report)
        return unit, get, ws

    def test_creates_the_unit_the_frontend_dialog_would(self):
        api = StubApi(types=["local"])
        unit, get, ws = self.run_setup(api)
        self.assertEqual(unit["type"], "local")
        self.assertEqual(api.calls[1], ("ensure_local_unit", "sce-e2e-unit", "http://localhost:4200/wsapi"))
        rec = self.report["setup"]["localdev"]
        self.assertEqual(rec["unit_request"], {"name": "sce-e2e-unit", "unitType": "local", "cpuLimit": "NaN",
                                               "memoryLimit": "NaN", "gpuLimit": "NaN", "jvmMemorySize": "NaN",
                                               "shmSize": "NaN", "uri": "http://localhost:4200/wsapi"})
        self.assertTrue(rec["unit"]["created"])
        self.assertEqual(rec["create_dialog_default_type"], "local")
        self.assertEqual(self.report["target"], "localdev")
        get.assert_called_once()
        self.assertEqual(get.call_args.args[0], "http://localhost:4200/")
        # the probe opens the workflow socket through the dev server, for this unit
        self.assertEqual(ws.call_args.args[:5], ("http://localhost:4200", "jwt", 1, unit["cuid"], 77))

    def test_reuses_an_existing_unit(self):
        api = StubApi(units=[{"cuid": 3, "name": "sce-e2e-unit", "uri": "http://localhost:4200/wsapi",
                              "type": "local"}])
        unit, _, _ = self.run_setup(api)
        self.assertEqual(unit["cuid"], 3)
        self.assertFalse(self.report["setup"]["localdev"]["unit"]["created"])

    def test_fails_without_local_units_or_without_the_app(self):
        with self.assertRaises(RuntimeError):
            self.run_setup(StubApi(types=["kubernetes"]))

        class NotTheApp(DevPage):
            text = "<html>nginx</html>"

        with self.assertRaises(RuntimeError):
            self.run_setup(StubApi(), page=NotTheApp())


class StackUnitTest(unittest.TestCase):
    def test_remap_env_points_local_dev_at_the_shifted_ports(self):
        exports = {"STORAGE_JDBC_URL": "jdbc:postgresql://localhost:5432/texera_db?currentSchema=texera_db,public",
                   "STORAGE_ICEBERG_CATALOG_REST_URI": "http://localhost:8181/catalog",
                   "STORAGE_LAKEFS_ENDPOINT": "http://localhost:8000/api/v1",
                   "STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME": "localhost:5432/texera_iceberg_catalog",
                   "STORAGE_S3_ENDPOINT": "http://$HOST_LAN_IP:9000",
                   "TEXERA_DASHBOARD_SERVICE_ENDPOINT": "http://localhost:8080"}
        ports = {"postgres": 15432, "lakefs": 18000, "lakekeeper": 18181, "rustfs": 19000}
        env = ls.remap_env(exports, ports, "http://10.0.0.5:19000")
        self.assertEqual(env["STORAGE_JDBC_URL"],
                         "jdbc:postgresql://localhost:15432/texera_db?currentSchema=texera_db,public")
        self.assertEqual(env["STORAGE_ICEBERG_CATALOG_REST_URI"], "http://localhost:18181/catalog")
        self.assertEqual(env["STORAGE_LAKEFS_ENDPOINT"], "http://localhost:18000/api/v1")
        self.assertEqual(env["STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME"],
                         "localhost:15432/texera_iceberg_catalog")
        self.assertEqual(env["STORAGE_S3_ENDPOINT"], "http://10.0.0.5:19000")
        self.assertEqual(env["TEXERA_DASHBOARD_SERVICE_ENDPOINT"], "http://localhost:8080")  # a service port stays
        with self.assertRaises(SystemExit):
            ls.remap_env({"X": "http://$OTHER:1"}, ports, "http://10.0.0.5:19000")

    def test_remap_port_binds_loopback_and_refuses_the_unexpected(self):
        self.assertEqual(ls._remap_port("5432:5432", "postgres"), "127.0.0.1:15432:5432")
        self.assertEqual(ls._remap_port("8181:8181", "lakekeeper"), "127.0.0.1:18181:8181")
        with self.assertRaises(SystemExit):
            ls._remap_port("4000:4000", "litellm")
        with self.assertRaises(SystemExit):
            ls._remap_port("5433:5433", "postgres")

    def test_heaps(self):
        self.assertEqual(ls.parse_heaps([])["texera-web"], "1g")
        self.assertEqual(set(ls.parse_heaps(["all=768m"]).values()), {"768m"})
        self.assertEqual(ls.parse_heaps(["file-service=2g"])["file-service"], "2g")
        for bad in (["file-service"], ["nope=1g"], ["texera-web=lots"]):
            with self.assertRaises(SystemExit):
                ls.parse_heaps(bad)

    def test_pid_file_identity(self):
        """A pid file whose process start time differs is another process: never ours to stop."""
        me = {"pid": os.getpid(), "lstart": ls.ps_lstart(os.getpid())}
        self.assertTrue(ls.record_alive(me))
        self.assertFalse(ls.record_alive(dict(me, lstart="Thu Jan  1 00:00:00 1970")))
        self.assertFalse(ls.record_alive({"pid": 0}))


@unittest.skipUnless(HAS_SOURCE, f"no local-dev source worktree at {SOURCE}")
class StackGenerateTest(unittest.TestCase):
    """generate() against the real source worktree's bin/single-node and bin/local-dev."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "generated"
        cls.m = ls.generate(SOURCE, "10.1.2.3", out_dir=cls.out)
        cls.compose = yaml.safe_load((cls.out / "docker-compose.yml").read_text())
        cls.env = json.loads((cls.out / "service.env.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_local_dev_infrastructure_renamed_and_shifted(self):
        svcs = self.compose["services"]
        self.assertEqual(set(svcs), {"postgres", "rustfs", "rustfs-init", "lakefs", "lakekeeper-migrate",
                                     "lakekeeper", "lakekeeper-init"})
        self.assertEqual(self.compose["name"], "e2e-localdev")
        self.assertEqual(self.compose["networks"]["default"]["name"], "e2e-localdev-net")
        self.assertEqual({v["name"] for v in self.compose["volumes"].values()},
                         {"e2e-localdev_postgres_data", "e2e-localdev_rustfs_data"})
        for name, svc in svcs.items():
            self.assertTrue(svc["container_name"].startswith("e2e-localdev-texera-"), name)
            self.assertIn(name, svc["networks"]["default"]["aliases"])
        self.assertEqual(svcs["postgres"]["ports"], ["127.0.0.1:15432:5432"])
        self.assertEqual(svcs["lakefs"]["ports"], ["127.0.0.1:18000:8000"])
        self.assertEqual(svcs["lakekeeper"]["ports"], ["127.0.0.1:18181:8181"])
        self.assertEqual(svcs["rustfs"]["ports"], ["${RUSTFS_PORT:-9000}:9000"])
        self.assertIn("RUSTFS_PORT=19000", (self.out / ".env").read_text().splitlines())
        self.assertEqual(svcs["lakekeeper-init"]["environment"], {"STORAGE_S3_ENDPOINT": "http://10.1.2.3:19000"})
        self.assertIn("./sql:/docker-entrypoint-initdb.d:ro", svcs["postgres"]["volumes"])
        self.assertTrue((self.out / "sql" / "texera_ddl.sql").exists())
        self.assertNotIn(str(SOURCE), (self.out / "docker-compose.yml").read_text().split("\n", 2)[2])

    def test_services_follow_local_devs_catalog(self):
        names = [s["name"] for s in self.m["services"]]
        self.assertEqual(names, ["config-service", "access-control-service", "file-service",
                                 "workflow-compiling-service", "computing-unit-master",
                                 "computing-unit-managing-service", "texera-web"])
        by = {s["name"]: s for s in self.m["services"]}
        self.assertEqual((by["computing-unit-master"]["cwd"], by["computing-unit-master"]["launcher"]),
                         ("amber", "bin/computing-unit-master"))
        self.assertEqual(by["computing-unit-master"]["zip_glob"], by["texera-web"]["zip_glob"])
        self.assertEqual(by["computing-unit-master"]["sbt"], "WorkflowExecutionService")
        self.assertEqual(by["config-service"]["cwd"], ".")

    def test_service_environment_is_local_devs(self):
        self.assertEqual(self.env["STORAGE_ICEBERG_CATALOG_TYPE"], "rest")
        self.assertEqual(self.env["STORAGE_S3_ENDPOINT"], "http://10.1.2.3:19000")
        self.assertEqual(self.env["STORAGE_ICEBERG_CATALOG_REST_URI"], "http://localhost:18181/catalog")
        self.assertIn("localhost:15432/texera_db", self.env["STORAGE_JDBC_URL"])
        self.assertEqual(self.env["USER_SYS_EMAIL_VERIFICATION"], "false")
        self.assertFalse([k for k, v in self.env.items() if "$" in v])
        self.assertTrue(all(v.startswith("<set") for k, v in self.m["service_env"].items()
                            if "PASSWORD" in k or "SECRET" in k or "KEY" in k))


if __name__ == "__main__":
    unittest.main()
