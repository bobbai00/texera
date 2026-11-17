"""Offline tests of driver/stack_control.py: what the single-node control asks of
`docker` (a fake runner answers), how it reads the answers, and how a stack script's
one JSON document is read. What `docker kill` does to a real unit is seen on a stack.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stack_control  # noqa: E402
from stack_control import SingleNodeControl, StackControlError, pg_activity, run_stack_script  # noqa: E402

UNIT = "sce-workflow-runtime-coordinator-service"


class Docker:
    """`docker <args>` as the control uses it: one unit container on one network."""

    def __init__(self, address: str = "172.30.0.7", health=("starting", "healthy")):
        self.address = address
        #: what `docker inspect` says of the unit's health, call after call
        self.health = list(health)
        self.calls: list[list[str]] = []
        self.fail: dict[str, str] = {}

    def __call__(self, args, timeout=60):
        args = list(args)
        self.calls.append(args)
        if args[0] in self.fail:
            return subprocess.CompletedProcess(args, 1, self.fail[args[0]], "")
        out = ""
        if args[0] == "inspect" and "{{.State.Health.Status}}" in args:
            out = self.health.pop(0) if len(self.health) > 1 else self.health[0]
        elif args[0] == "inspect" and "{{json .NetworkSettings.Networks}}" in args:
            out = json.dumps({"sce-unit-net": {"IPAddress": self.address, "GlobalIPv6Address": ""}})
        elif args[0] == "inspect" and "{{json .Config.Env}}" in args:
            out = json.dumps(["STORAGE_JDBC_URL=jdbc:postgresql://texera-postgres:5432/texera_db",
                              "PATH=/usr/bin", "A=b=c"])
        elif args[0] == "exec" and "psql" in args:
            out = ("101|texera-dashboard|172.30.0.9|texera_db|idle\n"
                   "102|texera-computing-unit|172.30.0.7|texera_db|idle\n")
        return subprocess.CompletedProcess(args, 0, out, "")

    def commands(self) -> list[str]:
        """The commands that change something, in order."""
        return [" ".join(c) for c in self.calls if c[0] not in ("inspect", "exec")]


class SingleNodeControlTest(unittest.TestCase):
    def setUp(self):
        self._sleep = stack_control.time.sleep
        stack_control.time.sleep = lambda s: None
        self.addCleanup(setattr, stack_control.time, "sleep", self._sleep)
        self.docker = Docker()
        self.waited: list[str] = []
        self.control = SingleNodeControl(runner=self.docker, wait_gateway=lambda: self.waited.append("gateway"))

    def test_nothing_is_asked_of_docker_until_a_scenario_asks(self):
        self.assertEqual([], self.docker.calls)
        self.assertFalse(self.control.listing_notices_lost_unit)
        self.assertIsNone(self.control.exec_prefix())  # the unit stays where it was

    def test_kill_and_stop_are_dockers(self):
        self.assertEqual("docker kill", self.control.kill_unit()["how"])
        self.assertEqual("docker stop -t 20", self.control.stop_unit()["how"])
        self.assertEqual([f"kill {UNIT}", f"stop -t 20 {UNIT}"], self.docker.commands())

    def test_start_waits_until_the_unit_is_healthy(self):
        self.control.kill_unit()
        started = self.control.start_unit()
        self.assertEqual(("healthy", False), (started["health"], started["gateway_restarted"]))
        self.assertEqual([f"kill {UNIT}", f"start {UNIT}"], self.docker.commands())
        self.assertEqual([], self.waited)  # same address: the gateway still reaches it

    def test_a_unit_back_at_another_address_gets_the_gateway_restarted(self):
        """nginx resolved the unit's name when it started."""
        self.control.kill_unit()
        self.docker.address = "172.30.0.12"
        started = self.control.start_unit()
        self.assertTrue(started["gateway_restarted"])
        self.assertEqual((["172.30.0.7"], ["172.30.0.12"]), (started["addresses_before"], started["addresses"]))
        self.assertEqual([f"kill {UNIT}", f"start {UNIT}", "restart sce-texera-nginx"], self.docker.commands())
        self.assertEqual(["gateway"], self.waited)
        self.docker.calls.clear()
        self.control.kill_unit()
        self.control.start_unit()  # and it is remembered: no second restart
        self.assertEqual([f"kill {UNIT}", f"start {UNIT}"], self.docker.commands())

    def test_a_unit_that_does_not_get_healthy_is_an_error(self):
        control = SingleNodeControl(runner=Docker(health=("unhealthy",)), start_timeout_s=0.05)
        with self.assertRaisesRegex(StackControlError, "is not healthy .* \\(health: unhealthy\\)"):
            control.start_unit()

    def test_a_docker_that_refuses_is_an_error_with_its_words(self):
        self.docker.fail["kill"] = "Error response from daemon: No such container"
        with self.assertRaisesRegex(StackControlError, "docker kill .*: exit 1: Error response from daemon"):
            self.control.kill_unit()

    def test_postgres_is_asked_who_is_connected(self):
        backends = self.control.pg_activity()
        self.assertEqual(["texera-dashboard", "texera-computing-unit"], [b["application_name"] for b in backends])
        self.assertEqual({"pid": 102, "application_name": "texera-computing-unit", "client_addr": "172.30.0.7",
                          "datname": "texera_db", "state": "idle"}, backends[1])
        asked = self.docker.calls[-1]
        self.assertEqual(["exec", "sce-texera-postgres", "psql", "-U", "texera", "-d", "texera_db"], asked[:7])
        self.assertEqual(pg_activity.QUERY, asked[-1])

    def test_the_units_environment_and_addresses(self):
        self.assertEqual(["A", "PATH", "STORAGE_JDBC_URL"], self.control.unit_env_names())
        self.assertEqual(["172.30.0.7"], self.control.unit_addresses())

    def test_other_container_names_come_from_the_stacks_manifest(self):
        control = SingleNodeControl({"workflow-runtime-coordinator-service": "x-unit", "postgres": "x-pg"},
                                    runner=self.docker)
        control.kill_unit()
        control.pg_activity()
        self.assertEqual(["kill x-unit"], self.docker.commands())
        self.assertEqual("x-pg", self.docker.calls[-1][1])


class ActivityTest(unittest.TestCase):
    def test_a_name_with_the_separator_in_it_is_still_one_name(self):
        rows = pg_activity.parse("7|odd|name|10.0.0.5|texera_db|active\n8|||postgres|\n\nnot a row\n")
        self.assertEqual([{"pid": 7, "application_name": "odd|name", "client_addr": "10.0.0.5",
                           "datname": "texera_db", "state": "active"},
                          {"pid": 8, "application_name": "", "client_addr": "", "datname": "postgres", "state": ""}],
                         rows)

    def test_only_client_backends_but_this_one_are_asked_for(self):
        self.assertIn("backend_type = 'client backend'", pg_activity.QUERY)
        self.assertIn("pid <> pg_backend_pid()", pg_activity.QUERY)


class StackScriptTest(unittest.TestCase):
    def script(self, body: str) -> Path:
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        path = Path(d.name) / "some-stack.sh"
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_the_one_json_document_is_read(self):
        script = self.script('echo "[stack] deleting" >&2\nprintf \'{"pod": "%s", "args": %s}\\n\' "$2" "$#"\n')
        self.assertEqual({"pod": "7", "args": 2}, run_stack_script(script, "unit-kill", "7"))

    def test_a_script_that_fails_is_an_error_with_its_last_words(self):
        script = self.script('echo "[stack] ERROR: expected one pod of computing unit 7" >&2\nexit 1\n')
        with self.assertRaisesRegex(StackControlError, "some-stack.sh unit-env 7: exit 1: .*expected one pod"):
            run_stack_script(script, "unit-env", "7")

    def test_a_script_that_prints_no_json_is_an_error(self):
        with self.assertRaisesRegex(StackControlError, "printed no JSON: done"):
            run_stack_script(self.script("echo done\n"), "unit-kill")


if __name__ == "__main__":
    unittest.main()
