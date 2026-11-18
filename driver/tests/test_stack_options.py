"""Offline tests of the stack options of step 3 (design section 7 H2) in the three stack
controllers, and of what the driver reads back from their manifests. The single-node
generator runs against a small source tree written here; nothing is started.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

HARNESS = Path(__file__).resolve().parents[2]
for sub in ("driver", "lib", "stack", "stack/k8s", "stack/localdev"):
    sys.path.insert(0, str(HARNESS / sub))

import k8s_stack as ks  # noqa: E402
import localdev_stack as ls  # noqa: E402
import record_env  # noqa: E402
import sce_stack as ss  # noqa: E402
from record_timing import RecordTiming  # noqa: E402

UNIT = "workflow-runtime-coordinator-service"
DASHBOARD = "dashboard-service"
FAST_UNIT = {"STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS": "2000"}
FAST_DASHBOARD = {"EXECUTION_CLOSING_INTERVAL_SECONDS": "2", "EXECUTION_CLOSING_LOST_AFTER_SECONDS": "12",
                  "EXECUTION_CLOSING_NEVER_STARTED_AFTER_SECONDS": "15",
                  "EXECUTION_CLOSING_REVISE_VERDICT_FOR_SECONDS": "180", "RESULT_CLEANUP_TTL_IN_SECONDS": "20",
                  "RESULT_CLEANUP_COLLECTION_CHECK_INTERVAL_IN_SECONDS": "5"}

COMPOSE = """
services:
  postgres:
    image: groonga/pgroonga:latest
    container_name: texera-postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ../../sql:/docker-entrypoint-initdb.d
  lakekeeper:
    image: lakekeeper:latest
    container_name: texera-lakekeeper
  rustfs:
    image: rustfs:latest
    container_name: texera-rustfs
  file-service:
    image: ${IMAGE_REGISTRY:-ghcr.io/apache}/texera-file-service:${IMAGE_TAG:-latest}
    container_name: file-service
    env_file: .env
  dashboard-service:
    image: ${IMAGE_REGISTRY:-ghcr.io/apache}/texera-dashboard-service:${IMAGE_TAG:-latest}
    container_name: dashboard-service
    env_file: .env
  workflow-runtime-coordinator-service:
    image: ${IMAGE_REGISTRY:-ghcr.io/apache}/texera-workflow-execution-coordinator:${IMAGE_TAG:-latest}
    container_name: workflow-runtime-coordinator-service
    env_file: .env
    environment:
      - USER_SYS_ENABLED=true
  nginx:
    image: nginx:latest
    container_name: texera-nginx
    ports:
      - "${TEXERA_PORT:-8080}:8080"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
volumes:
  postgres_data:
"""
NGINX = """http {
    access_log off;
    server {
        location /api/ {
            proxy_pass http://dashboard-service:8080;
        }
    }
}
"""


class SingleNodeCase(unittest.TestCase):
    """sce_stack.generate against a source tree with the services the options touch."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / "src"
        sn = self.source / "bin" / "single-node"
        sn.mkdir(parents=True)
        (sn / "docker-compose.yml").write_text(COMPOSE)
        (sn / ".env").write_text("IMAGE_TAG=latest\nTEXERA_PORT=8080\n")
        (sn / "nginx.conf").write_text(NGINX)
        (self.source / "sql").mkdir()
        (self.source / "sql" / "texera_ddl.sql").write_text("-- ddl\n")
        self.out = Path(self.tmp.name) / "generated"

    def generate(self, **options) -> tuple[dict, dict]:
        """(the manifest, the generated compose services)."""
        manifest = ss.generate(self.source, "sce", "step3", "127.0.0.1", False,
                               ss.StackOptions(**options), out_dir=self.out)
        return manifest, yaml.safe_load((self.out / "docker-compose.yml").read_text())["services"]

    @staticmethod
    def env_of(service: dict) -> dict:
        return dict(item.split("=", 1) for item in service.get("environment") or [])


class FastRecordTest(SingleNodeCase):
    def test_no_option_leaves_the_services_and_the_timers_alone(self):
        manifest, services = self.generate()
        self.assertEqual({"USER_SYS_ENABLED": "true"}, self.env_of(services[UNIT]))
        self.assertNotIn("environment", services[DASHBOARD])
        opts = manifest["options"]
        self.assertEqual((False, {}, {}, {}),
                         (opts["fast_record"], opts["record_timing"], opts["unit_env"], opts["dashboard_env"]))
        self.assertEqual("none", ss.describe_options(opts))

    def test_fast_record_shortens_the_units_and_the_dashboards_timers(self):
        manifest, services = self.generate(fast_record=True)
        self.assertEqual({"USER_SYS_ENABLED": "true", **FAST_UNIT}, self.env_of(services[UNIT]))
        self.assertEqual(FAST_DASHBOARD, self.env_of(services[DASHBOARD]))
        self.assertNotIn("environment", services["file-service"])
        opts = manifest["options"]
        self.assertTrue(opts["fast_record"])
        self.assertEqual({"commit_interval_ms": 2000, "closing_interval_s": 2, "lost_after_s": 12,
                          "never_started_after_s": 15, "revise_verdict_for_s": 180, "result_ttl_s": 20,
                          "expiry_check_interval_s": 5},
                         opts["record_timing"])
        self.assertIn("fast record", ss.describe_options(opts))

    def test_an_explicit_setting_wins_and_the_manifest_follows_it(self):
        manifest, services = self.generate(
            fast_record=True, unit_env=["STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS=500"],
            dashboard_env=["EXECUTION_CLOSING_LOST_AFTER_SECONDS=40", "SMTP_PASSWORD=hunter2"])
        self.assertEqual("500", self.env_of(services[UNIT])["STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS"])
        dashboard = self.env_of(services[DASHBOARD])
        self.assertEqual(("40", "2", "hunter2"), (dashboard["EXECUTION_CLOSING_LOST_AFTER_SECONDS"],
                                                  dashboard["EXECUTION_CLOSING_INTERVAL_SECONDS"],
                                                  dashboard["SMTP_PASSWORD"]))
        opts = manifest["options"]
        self.assertEqual((500, 40), (opts["record_timing"]["commit_interval_ms"],
                                     opts["record_timing"]["lost_after_s"]))
        self.assertEqual("<set, 7 chars>", opts["dashboard_env"]["SMTP_PASSWORD"])  # masked in the manifest

    def test_dashboard_env_alone_and_with_the_replay_log(self):
        manifest, services = self.generate(dashboard_env=["RESULT_CLEANUP_TTL_IN_SECONDS=60"],
                                           with_replay_log=True)
        self.assertEqual({ss.REPLAY_LOG_ENV: ss.REPLAY_LOG_URI, "RESULT_CLEANUP_TTL_IN_SECONDS": "60"},
                         self.env_of(services[DASHBOARD]))
        self.assertEqual({"result_ttl_s": 60}, manifest["options"]["record_timing"])
        self.assertFalse(manifest["options"]["fast_record"])

    def test_a_malformed_item_is_refused(self):
        for bad in (["NOEQUALS"], ["1BAD=x"], ["=x"]):
            with mock.patch("sys.stderr", new_callable=io.StringIO) as err, self.assertRaises(SystemExit):
                ss.StackOptions(dashboard_env=bad)
            self.assertIn("--dashboard-env takes KEY=VALUE", err.getvalue())


class UnitWithoutPostgresTest(SingleNodeCase):
    """--unit-no-postgres: no network holds both the unit and Postgres."""

    @staticmethod
    def networks_of(services: dict) -> dict[str, list[str]]:
        return {name: sorted(svc["networks"]) for name, svc in services.items()}

    def test_postgres_is_not_on_the_units_network(self):
        manifest, services = self.generate(isolate_unit=True, unit_no_postgres=True)
        nets = self.networks_of(services)
        self.assertEqual((["unit"], ["default"]), (nets[UNIT], nets["postgres"]))
        # what the unit still needs is beside it: the lake's catalog and store, and the gateway
        self.assertEqual({"lakekeeper", "rustfs", "nginx"}, {n for n, on in nets.items() if on == ["default", "unit"]})
        opts = manifest["options"]
        self.assertTrue(opts["unit_no_postgres"])
        self.assertIn("unit isolated on sce-unit-net, without Postgres", ss.describe_options(opts))

    def test_without_the_option_postgres_stays_beside_the_unit(self):
        manifest, services = self.generate(isolate_unit=True)
        self.assertEqual(["default", "unit"], self.networks_of(services)["postgres"])
        self.assertFalse(manifest["options"]["unit_no_postgres"])

    def test_it_needs_a_unit_on_a_network_of_its_own(self):
        with mock.patch("sys.stderr", new_callable=io.StringIO) as err, self.assertRaises(SystemExit):
            ss.StackOptions(unit_no_postgres=True)
        self.assertIn("--unit-no-postgres needs --isolate-unit", err.getvalue())

    def test_the_network_check_refuses_a_compose_that_leaves_postgres_reachable(self):
        _, services = self.generate(isolate_unit=True)  # Postgres on both networks
        with mock.patch("sys.stderr", new_callable=io.StringIO) as err, self.assertRaises(SystemExit):
            ss._check_networks(services, ss.StackOptions(isolate_unit=True, unit_no_postgres=True))
        self.assertIn("postgres is on ['default', 'unit'], want ['default']", err.getvalue())

    def test_the_name_of_postgres_is_read_from_the_generated_environment(self):
        with mock.patch.object(ss, "GEN_DIR", self.out):
            self.assertEqual("texera-postgres", ss.postgres_host())  # nothing generated yet: the stack's name
            self.out.mkdir()
            (self.out / ".env").write_text("A=1\nSTORAGE_JDBC_URL=jdbc:postgresql://pg.internal:5432/texera_db\n")
            self.assertEqual("pg.internal", ss.postgres_host())


class UnitDownControlTest(unittest.TestCase):
    """`up --expect-unit-down`: the verdict on a unit that must not start without Postgres."""

    BOOT = ["INFO  ComputingUnitMaster - starting", "ERROR com.zaxxer.hikari.pool.HikariPool - Exception during pool "
            "initialization.", "org.postgresql.util.PSQLException: The connection attempt failed.",
            "Caused by: java.net.UnknownHostException: texera-postgres"]

    def test_a_unit_that_stays_down_because_of_postgres_is_the_control_holding(self):
        verdict = ss.unit_down_verdict(["starting"] * 20 + ["unhealthy"] * 10, self.BOOT, "texera-postgres")
        self.assertTrue(verdict["ok"])
        self.assertTrue(verdict["verdict"].startswith("failed as expected"))
        self.assertEqual((["starting", "unhealthy"], 30, 3),
                         (verdict["unit_health_seen"], verdict["looks"], len(verdict["log_lines_naming_postgres"])))

    def test_a_unit_that_becomes_healthy_passed_so_nothing_is_proved(self):
        verdict = ss.unit_down_verdict(["starting", "starting", "healthy"], self.BOOT[:1], "texera-postgres")
        self.assertFalse(verdict["ok"])
        self.assertIn("PASSED, so the control proves nothing", verdict["verdict"])

    def test_a_unit_that_stays_down_for_another_reason_is_inconclusive(self):
        verdict = ss.unit_down_verdict(["starting"] * 30, ["OutOfMemoryError: Java heap space"], "texera-postgres")
        self.assertFalse(verdict["ok"])
        self.assertIn("control inconclusive: the unit did not become healthy, but its log names neither "
                      "texera-postgres nor PSQLException nor HikariPool", verdict["verdict"])

    def test_the_control_is_only_for_a_stack_without_postgres_for_the_unit(self):
        with mock.patch("sys.stderr", new_callable=io.StringIO) as err, self.assertRaises(SystemExit):
            ss.expect_unit_down(mock.Mock(), {"options": {"unit_no_postgres": False}})
        self.assertIn("--expect-unit-down is the negative control of --unit-no-postgres", err.getvalue())

    def test_every_service_but_the_unit_is_waited_for(self):
        services = {"postgres": {"healthcheck": {}}, ss.UNIT_SERVICE: {"healthcheck": {}}}
        rows = [{"Service": "postgres", "State": "running", "Health": "healthy"},
                {"Service": ss.UNIT_SERVICE, "State": "restarting", "Health": ""}]
        with mock.patch.object(ss, "compose_services", return_value=services), \
                mock.patch.object(ss, "compose_ps", return_value=rows), mock.patch.object(ss, "log") as said:
            ss.wait_healthy(5, {}, skip=frozenset({ss.UNIT_SERVICE}))  # returns at once: only Postgres counts
        self.assertIn(f"not waited for: {ss.UNIT_SERVICE}", said.call_args.args[0])


class RecordEnvTest(unittest.TestCase):
    def test_fast_record_is_the_designs(self):
        self.assertEqual(FAST_UNIT, record_env.fast_record_env("unit"))
        self.assertEqual(FAST_DASHBOARD, record_env.fast_record_env("dashboard"))

    def test_record_timing_names_only_what_was_set(self):
        self.assertEqual({}, record_env.record_timing({}, {}))
        self.assertEqual({"lost_after_s": 12}, record_env.record_timing(
            {"UNRELATED": "1"}, {"EXECUTION_CLOSING_LOST_AFTER_SECONDS": "12",
                                 "EXECUTION_CLOSING_INTERVAL_SECONDS": "soon"}))
        # a timer belongs to one service: the unit's in the Dashboard's environment says nothing
        self.assertEqual({}, record_env.record_timing({}, FAST_UNIT))

    def test_the_driver_reads_the_manifests_timers_and_keeps_the_products_defaults(self):
        self.assertEqual(RecordTiming(), RecordTiming.from_manifest({}))
        self.assertFalse(RecordTiming().fast)
        self.assertEqual((30.0, 180.0, 86400.0), (RecordTiming().commit_interval_s, RecordTiming().lost_after_s,
                                                  RecordTiming().result_ttl_s))
        fast = RecordTiming.from_manifest({"options": {"record_timing": record_env.FAST_RECORD}})
        self.assertEqual(RecordTiming(commit_interval_s=2.0, closing_interval_s=2.0, lost_after_s=12.0,
                                      never_started_after_s=15.0, revise_verdict_for_s=180.0, result_ttl_s=20.0,
                                      expiry_check_interval_s=5.0),
                         fast)
        self.assertTrue(fast.fast)
        self.assertEqual(0.5, fast.poll_s)
        partly = RecordTiming.from_manifest({"options": {"record_timing": {"lost_after_s": 12}}})
        self.assertEqual((12.0, 30.0), (partly.lost_after_s, partly.closing_interval_s))
        self.assertFalse(partly.fast)  # the expiry still takes a day


def deployment(name: str, image: str, env=()) -> dict:
    return {"kind": "Deployment", "metadata": {"name": name},
            "spec": {"template": {"spec": {"containers": [
                {"name": name, "image": image, "env": [{"name": n, "value": "x"} for n in env]}]}}}}


class KubernetesFastRecordTest(unittest.TestCase):
    WEB, MANAGER = "sce/texera-dashboard-service:t", "sce/texera-workflow-computing-unit-managing-service:t"

    def test_the_values_carry_both_services_timers(self):
        opts = ks.record_options(True)
        self.assertEqual((True, FAST_UNIT, FAST_DASHBOARD), (opts["fast_record"], opts["unit_env"],
                                                             opts["dashboard_env"]))
        self.assertEqual(2000, opts["record_timing"]["commit_interval_ms"])
        self.assertEqual({"fast_record": False, "unit_env": {}, "dashboard_env": {}, "record_timing": {}},
                         ks.record_options(False))

    def test_a_chart_that_does_not_hand_the_timers_over_is_refused(self):
        """The webserver reads its own timers; the managing service forwards the unit's."""
        opts = ks.record_options(True)
        given = [deployment("texera-webserver", self.WEB, env=FAST_DASHBOARD),
                 deployment("texera-manager", self.MANAGER, env=FAST_UNIT)]
        self.assertEqual([], ks.missing_record_env(given, "sce", "t", opts))
        not_forwarded = [given[0], deployment("texera-manager", self.MANAGER)]
        self.assertEqual(["STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS (texera-workflow-computing-unit-managing-service)"],
                         ks.missing_record_env(not_forwarded, "sce", "t", opts))
        self.assertEqual(7, len(ks.missing_record_env([], "sce", "t", opts)))
        self.assertEqual([], ks.missing_record_env([], "sce", "t", ks.record_options(False)))


class LocalDevFastRecordTest(unittest.TestCase):
    def test_exports_reach_the_units_and_the_dashboards_jvm_only(self):
        m = {"options": ls.record_options(True)}
        base = {"STORAGE_JDBC_URL": "jdbc:x"}

        def env(name: str) -> dict:
            return ls.launch_env(m, {"name": name, "java_opts": "-Xmx1g"}, base)

        self.assertEqual({**base, "JAVA_OPTS": "-Xmx1g", **FAST_UNIT}, env("computing-unit-master"))
        self.assertEqual({**base, "JAVA_OPTS": "-Xmx1g", **FAST_DASHBOARD}, env("texera-web"))
        self.assertEqual({**base, "JAVA_OPTS": "-Xmx1g"}, env("file-service"))
        self.assertEqual({**base, "JAVA_OPTS": "-Xmx1g"},
                         ls.launch_env({"options": ls.record_options(False)},
                                       {"name": "texera-web", "java_opts": "-Xmx1g"}, base))
        self.assertEqual(2000, m["options"]["record_timing"]["commit_interval_ms"])


if __name__ == "__main__":
    unittest.main()
