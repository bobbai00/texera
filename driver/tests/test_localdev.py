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


# A docker CLI for the schema-step test: it logs the containers it is asked about and answers
# psql like a texera_db whose sql/ ran at init (so the `feedback` table exists). A changeSet
# whose SQL says FAILME fails with a "does not exist" error, one that says ALREADY with an
# "already exists" error; INSERTs into databasechangelog are kept in a file.
FAKE_DOCKER = r"""#!/usr/bin/env bash
state="$FAKE_DOCKER_STATE"
args=("$@")
[[ "${args[0]}" == exec ]] || exit 0
i=1
[[ "${args[1]}" == -i ]] && i=2
[[ "${args[1]}" == -u ]] && i=3
echo "${args[$i]}" >> "$state/containers.log"
rest="${args[*]:$((i + 1))}"
case "$rest" in
    pg_isready*) exit 0 ;;
    *"tablename='feedback'"*) echo 1 ;;
    *"SELECT id FROM public.databasechangelog"*) cat "$state/recorded" 2>/dev/null ;;
    *"CREATE TABLE IF NOT EXISTS public.databasechangelog"*) : ;;
    *"INSERT INTO public.databasechangelog"*)
        printf '%s\n' "$rest" | sed -n "s/.*VALUES ('\([^']*\)'.*/\1/p" >> "$state/recorded" ;;
    *"ON_ERROR_STOP=1 -f -"*)
        sql=$(cat)
        if [[ "$sql" == *FAILME* ]]; then
            echo 'psql:<stdin>:3: ERROR:  constraint "ck_x" of relation "user" does not exist' >&2; exit 3
        fi
        if [[ "$sql" == *ALREADY* ]]; then
            echo 'psql:<stdin>:2: ERROR:  relation "t_already" already exists' >&2; exit 3
        fi ;;
esac
exit 0
"""


@unittest.skipUnless(HAS_SOURCE, f"no local-dev source worktree at {SOURCE}")
class SchemaStepTest(unittest.TestCase):
    """local-dev's schema step, its functions taken from the source's main.sh and run by bash,
    against a fake docker: what it applies, accepts, records, and where it stops."""

    CONTAINER = "e2e-localdev-texera-postgres"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "state"
        self.state.mkdir()
        fake_bin = root / "bin"
        fake_bin.mkdir()
        (fake_bin / "docker").write_text(FAKE_DOCKER)
        (fake_bin / "docker").chmod(0o755)
        self.env = {"PATH": f"{fake_bin}:{os.environ['PATH']}", "FAKE_DOCKER_STATE": str(self.state)}
        self.src = root / "src"
        (self.src / "bin" / "local-dev").mkdir(parents=True)
        (self.src / "bin" / "local-dev" / "main.sh").write_text((SOURCE / "bin" / "local-dev" / "main.sh").read_text())
        (self.src / "sql" / "updates").mkdir(parents=True)
        self.logs = root / "logs"
        self.logs.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def changelog(self, bodies: list[str]) -> None:
        sets = []
        for i, body in enumerate(bodies, 1):
            (self.src / "sql" / "updates" / f"{i}.sql").write_text(f"\\c texera_db\n-- {body}\nSELECT 1;\n")
            sets.append(f'    <changeSet id="{i}" author="t">\n        <sqlFile path="sql/updates/{i}.sql"/>\n'
                        "    </changeSet>")
        (self.src / "sql" / "changelog.xml").write_text(
            "<databaseChangeLog>\n" + "\n".join(sets)
            + '\n    <!-- <changeSet id="99" author="x">\n        <sqlFile path="sql/updates/99.sql"/> -->\n'
            "</databaseChangeLog>\n")

    def run_step(self) -> dict:
        with mock.patch.dict("os.environ", self.env):
            return ls.run_schema_step({"containers": {"postgres": self.CONTAINER}}, self.src, self.logs)

    def test_local_devs_step_ends_up_when_it_fails(self):
        spec = ls.schema_step_spec(SOURCE)
        self.assertTrue(spec["stops_up_on_failure"], spec["why"])
        self.assertEqual(set(spec["functions"]), set(ls.SCHEMA_FUNCTIONS))

    def test_stops_at_the_first_changeset_that_fails_for_another_reason(self):
        self.changelog(["fine", "ALREADY", "FAILME", "never reached"])
        s = self.run_step()
        self.assertFalse(s["ok"])
        self.assertEqual(s["exit_code"], 1)
        self.assertEqual(s["applied"], ["1"])
        self.assertEqual(s["already_in_schema"], ["2"])
        self.assertEqual(s["failed"]["id"], "3")
        self.assertEqual(s["failed"]["path"], "sql/updates/3.sql")
        self.assertIn('constraint "ck_x" of relation "user" does not exist', s["failed"]["error"])
        self.assertEqual(s["recorded"], ["1", "2"])
        self.assertEqual(s["not_recorded"], ["3", "4"])
        self.assertEqual(s["changesets"], 4)  # the commented-out example is not one
        # local-dev's container name never reaches docker
        self.assertEqual(set((self.state / "containers.log").read_text().split()), {self.CONTAINER})

        m: dict = {}
        ls.schema_verdict(m, s, strict=False)  # the default: go on, record the deviation
        (dev,) = m["local_dev_deviations"]
        self.assertEqual(dev["failed_changeset"], "3")
        self.assertIn("does not exist", dev["error"])
        self.assertEqual(dev["not_recorded"], ["3", "4"])
        with self.assertRaises(SystemExit):
            ls.schema_verdict({}, s, strict=True)  # --strict-schema: stop where local-dev stops

    def test_passes_and_records_every_changeset(self):
        self.changelog(["fine", "ALREADY", "fine too"])
        s = self.run_step()
        self.assertTrue(s["ok"])
        self.assertEqual((s["applied"], s["already_in_schema"], s["recorded"], s["not_recorded"]),
                         (["1", "3"], ["2"], ["1", "2", "3"], []))
        m: dict = {}
        ls.schema_verdict(m, s, strict=True)
        self.assertNotIn("local_dev_deviations", m)

    def test_a_failure_that_does_not_end_local_devs_up_is_only_a_warning(self):
        self.changelog(["FAILME"])
        s = dict(self.run_step(), local_dev_stops_up_on_failure=False)
        m: dict = {}
        ls.schema_verdict(m, s, strict=True)
        self.assertNotIn("local_dev_deviations", m)
        self.assertEqual(len(m["warnings"]), 1)


class LeftoverProcessTest(unittest.TestCase):
    """`down` finds what an earlier `up` left without a pid file."""

    def test_kinds(self):
        src = "/w/src"
        kind = ls.stack_process_kind
        self.assertEqual(kind("ng serve (gui)", f"{src}/frontend", src), "frontend")  # the CLI's own title
        self.assertEqual(kind("/n/node --max-old-space-size=8192 ./node_modules/@angular/cli/bin/ng serve",
                              f"{src}/frontend", src), "frontend")
        self.assertEqual(kind("/w/src/frontend/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.4",
                              f"{src}/frontend", src), "frontend")
        self.assertIsNone(kind("ng serve (gui)", "/elsewhere/frontend", src))  # another checkout's dev server
        self.assertIsNone(kind("-zsh", f"{src}/frontend", src))  # a shell in the directory
        self.assertEqual(kind("/py/bin/python -u src/main/python/texera_run_python_worker.py 41 x",
                              f"{src}/amber", src), "python worker")
        self.assertEqual(kind(f"/jdk/bin/java -cp {ls.DIST_DIR}/amber-1/lib/a.jar Main", "/", None), "service")

    def test_finds_and_stops_a_dev_server_under_the_clis_title(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp).resolve()
            (src / "frontend").mkdir()
            (src / "other").mkdir()
            title = "ng serve (gui)"
            ours = subprocess.Popen(["bash", "-c", f'exec -a "{title}" sleep 60'], cwd=src / "frontend",
                                    start_new_session=True)
            theirs = subprocess.Popen(["bash", "-c", f'exec -a "{title}" sleep 60'], cwd=src / "other",
                                      start_new_session=True)
            try:
                for _ in range(50):  # until exec has renamed it
                    found = {pid for pid, _g, _c in ls.orphan_processes(str(src))}
                    if ours.pid in found:
                        break
                    import time
                    time.sleep(0.1)
                self.assertIn(ours.pid, found)
                self.assertNotIn(theirs.pid, found)
                done = ls.stop_orphans(str(src))
                self.assertTrue(any(f"pid {ours.pid}" in line and "stopped" in line for line in done), done)
                self.assertIsNotNone(ours.wait(10))
                self.assertIsNone(theirs.poll())
                self.assertEqual(ls.orphan_processes(str(src)), [])
            finally:
                for p in (ours, theirs):
                    if p.poll() is None:
                        p.kill()
                        p.wait()


class PortsAndOrderTest(unittest.TestCase):
    def test_preflight_covers_the_units_pekko_port(self):
        m = {"ports": {"postgres": 15432}, "services": [{"name": "computing-unit-master", "local_dev_port": 8085},
                                                        {"name": "texera-web", "local_dev_port": 8080}]}
        ports = set(ls.all_ports(m).values())
        self.assertTrue({8085, 2552, 8080, 8081, 15432, 4200} <= ports, ports)
        self.assertEqual(ls.expected_ports(m)["computing-unit-master"], {8085, 2552})

    def test_stop_order_is_reverse_start_order(self):
        recs = [{"name": n, "started_at": "2026-11-16T12:00:00+00:00", "started_ns": ns}
                for n, ns in (("config-service", 1), ("texera-web", 3), ("access-control-service", 2),
                              ("frontend", 9))]
        self.assertEqual([r["name"] for r in ls.stop_order(recs)],
                         ["frontend", "texera-web", "access-control-service", "config-service"])


class ProvenanceTest(unittest.TestCase):
    """What a dist zip was built from, and when `up` refuses it."""

    def setUp(self):
        import subprocess
        self.sp = subprocess
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name).resolve() / "repo"
        (self.repo / "svc" / "src" / "main" / "scala").mkdir(parents=True)
        (self.repo / "frontend" / "src").mkdir(parents=True)
        (self.repo / "amber" / "src" / "main" / "python").mkdir(parents=True)
        self.scala = self.repo / "svc" / "src" / "main" / "scala" / "A.scala"
        self.scala.write_text("object A\n")
        (self.repo / "build.sbt").write_text("// build\n")
        (self.repo / "frontend" / "src" / "x.ts").write_text("x\n")
        (self.repo / "amber" / "src" / "main" / "python" / "p.py").write_text("p\n")
        (self.repo / "README.md").write_text("r\n")
        (self.repo / ".gitignore").write_text("target/\n")
        self.git("init", "-q")
        self.commit("first")
        self.zip = self.repo / "svc" / "target" / "universal" / "svc.zip"
        self.zip.parent.mkdir(parents=True)
        self.zip.write_bytes(b"zip")
        self.set_time(self.zip, 2000)
        for f in (self.scala, self.repo / "build.sbt"):
            self.set_time(f, 1000)
        self.patch = mock.patch.object(ls, "PROVENANCE", Path(self.tmp.name) / "provenance.json")
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def git(self, *args):
        return self.sp.run(["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                           check=True, stdout=self.sp.PIPE, text=True).stdout.strip()

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    @staticmethod
    def set_time(path, t):
        os.utime(path, (1_700_000_000 + t, 1_700_000_000 + t))

    def test_build_inputs(self):
        self.assertEqual(sorted(ls.build_inputs(self.repo)), ["build.sbt", "svc/src/main/scala/A.scala"])

    def test_recorded_build_of_head_is_current(self):
        state = ls.source_state(self.repo)
        rec = ls.record_provenance(self.repo, [self.zip], state, t_start=1_700_000_000 + 1500)
        self.assertEqual(rec[str(self.zip)]["head"], state["head"])
        info, stale, caveats = ls.dist_provenance(self.repo, [self.zip], state)
        self.assertEqual((stale, caveats), ([], []))
        self.assertEqual(info[str(self.zip)]["built_from"], state["head"])

    def test_a_build_input_modified_after_the_build_is_stale(self):
        state = ls.source_state(self.repo)
        ls.record_provenance(self.repo, [self.zip], state, t_start=1_700_000_000 + 1500)
        self.scala.write_text("object A { val changed = 1 }\n")
        self.set_time(self.scala, 3000)
        info, stale, caveats = ls.dist_provenance(self.repo, [self.zip], ls.source_state(self.repo))
        self.assertEqual(len(stale), 1)
        self.assertIn("modified after it was built", stale[0])
        self.assertTrue(any("uncommitted changes" in c for c in caveats))

    def test_a_record_of_another_commit(self):
        state = ls.source_state(self.repo)
        ls.record_provenance(self.repo, [self.zip], state, t_start=1_700_000_000 + 1500)
        (self.repo / "README.md").write_text("docs only\n")
        self.set_time(self.repo / "README.md", 3000)
        self.commit("docs")
        _info, stale, _c = ls.dist_provenance(self.repo, [self.zip], ls.source_state(self.repo))
        self.assertEqual(stale, [])  # HEAD moved, no build input changed
        self.scala.write_text("object A { val v2 = 2 }\n")
        self.set_time(self.scala, 1500)  # even with an mtime older than the zip
        self.commit("code")
        _info, stale, _c = ls.dist_provenance(self.repo, [self.zip], ls.source_state(self.repo))
        self.assertEqual(len(stale), 1)
        self.assertIn("1 build input(s) differ at HEAD", stale[0])

    def test_no_record(self):
        _info, stale, caveats = ls.dist_provenance(self.repo, [self.zip], ls.source_state(self.repo))
        self.assertEqual(stale, [])
        self.assertEqual(len(caveats), 1)
        self.assertIn("no build record for svc.zip", caveats[0])
        self.set_time(self.zip, 500)  # older than the sources: stale even without a record
        _info, stale, _c = ls.dist_provenance(self.repo, [self.zip], ls.source_state(self.repo))
        self.assertEqual(len(stale), 1)


class PostRunTest(unittest.TestCase):
    def test_deviations_and_warnings_reach_the_report_summary(self):
        dev = {"step": "schema", "error": "ERROR: x", "local_dev": "stops", "harness": "went on"}
        m = {"local_dev_deviations": [dev], "warnings": ["w1"], "services": []}
        rows = [{"name": "texera-web", "alive": True, "health": "ok", "pid": 1, "port": 8080, "log": None}]
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "r.json"
            report.write_text(json.dumps({"summary": {"result": "PASS"}}))
            with mock.patch.object(ls, "load_manifest", return_value=m), \
                    mock.patch.object(ls, "service_states", return_value=rows), \
                    mock.patch.object(ls, "pid_records", return_value=[]):
                ls.cmd_post_run(argparse.Namespace(report=str(report), out=None))
            summ = json.loads(report.read_text())["summary"]
        self.assertEqual(summ["result"], "PASS")
        self.assertEqual(summ["local_dev_deviations"], ["schema: ERROR: x"])
        self.assertEqual(summ["warnings"], ["w1"])


FAKE_STACK = r"""#!/usr/bin/env bash
echo "$*" >> "$(dirname "$0")/../calls.log"
exit 0
"""
FAKE_DRIVER = r"""#!/usr/bin/env bash
sleep "${FAKE_DRIVER_SLEEP:-0}"
exit 0
"""


class RunLocaldevLockTest(unittest.TestCase):
    """run-localdev.sh with a stand-in stack and driver: the lock stays with a kept stack."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "stack").mkdir()
        (self.home / "driver").mkdir()
        (self.home / "run-localdev.sh").write_text((HARNESS / "run-localdev.sh").read_text())
        for rel, text in (("stack/localdev-stack.sh", FAKE_STACK), ("driver/run.sh", FAKE_DRIVER)):
            (self.home / rel).write_text(text)
        for rel in ("run-localdev.sh", "stack/localdev-stack.sh", "driver/run.sh"):
            (self.home / rel).chmod(0o755)
        self.lock = self.home / "lock"

    def tearDown(self):
        self.tmp.cleanup()

    def run_it(self, *args, sleep=0, usr1_after=None):
        import signal
        import subprocess
        import time
        p = subprocess.Popen([str(self.home / "run-localdev.sh"), "--lock", str(self.lock), *args],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env=dict(os.environ, FAKE_DRIVER_SLEEP=str(sleep)))
        if usr1_after is not None:
            time.sleep(usr1_after)
            p.send_signal(signal.SIGUSR1)  # what the watchdog sends at the time limit
        out, _ = p.communicate(timeout=60)
        calls = (self.home / "calls.log").read_text().splitlines()
        return p.returncode, out, calls

    def test_without_keep_the_stack_goes_down_and_the_lock_is_released(self):
        rc, out, calls = self.run_it()
        self.assertEqual(rc, 0, out)
        self.assertEqual(calls[-1], "down --no-collect")
        self.assertFalse(self.lock.exists())

    def test_keep_keeps_the_lock_with_the_stack(self):
        rc, out, calls = self.run_it("--keep")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("down --no-collect", calls[1:])  # only the clean start's `down`
        self.assertTrue(self.lock.exists())
        self.assertIn("--keep", (self.lock / "owner").read_text())
        self.assertIn("stack/localdev-stack.sh down && rm -rf", out)

    def test_the_time_limit_overrides_keep(self):
        rc, out, calls = self.run_it("--keep", sleep=20, usr1_after=3)
        self.assertEqual(rc, 5, out)
        self.assertEqual(calls[-1], "down --no-collect")
        self.assertFalse(self.lock.exists())

    def test_flags_reach_up(self):
        rc, out, calls = self.run_it("--strict-schema", "--allow-stale-dists")
        self.assertEqual(rc, 0, out)
        up = next(c for c in calls if c.startswith("up "))
        self.assertIn("--strict-schema", up)
        self.assertIn("--allow-stale-dists", up)


if __name__ == "__main__":
    unittest.main()
