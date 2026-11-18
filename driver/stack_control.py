"""Reaching the stack itself: taking the computing unit down and bringing it back, and
asking Postgres who is connected (step-3 design, section 7 H1).

A scenario never runs `docker` or `kubectl`. It calls the `StackControl` the driver
chose for its mode (`--target`):

  kill_unit()       single-node  `docker kill <unit>`
                    Kubernetes   `stack/k8s-stack.sh unit-kill <cuid>` (the pod deleted at once)
                    local-dev    `stack/localdev-stack.sh unit-kill` (kill -9 the JVM and its workers)
  stop_unit()       single-node  `docker stop -t 20 <unit>`
                    Kubernetes   `... unit-stop <cuid>` (the pod deleted with its grace period)
                    local-dev    `... unit-stop` (SIGTERM)
  start_unit()      single-node  `docker start <unit>`, then until it is healthy
                    Kubernetes   a new unit through the manager; the scenarios after it use that one
                    local-dev    `... unit-start`, then until it answers
  pg_activity()     single-node  `docker exec <postgres> psql ...` (pg_stat_activity)
                    Kubernetes   `... pg-activity` (`kubectl exec` into Postgres)
                    local-dev    `... pg-activity`
  unit_env_names()  single-node  `docker inspect <unit>`
                    Kubernetes   `... unit-env <cuid>`
                    local-dev    the environment the stack recorded for the unit

The single-node control is here; the Kubernetes one is in k8s_unit.py and local-dev's in
localdev_unit.py. In those two modes the driver's own `DOCKER_HOST` points at a socket
that does not exist; the stack scripts are what reach the cluster or the processes. Each
prints one JSON document for the driver.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Sequence

from evidence import docker_runner

HARNESS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HARNESS / "lib"))

import pg_activity  # noqa: E402

DEFAULT_CONTAINERS = {
    "postgres": "sce-texera-postgres",
    "workflow-runtime-coordinator-service": "sce-workflow-runtime-coordinator-service",
    "nginx": "sce-texera-nginx",
    "lakekeeper": "sce-texera-lakekeeper",
    "rustfs": "sce-texera-rustfs",
}
#: the network a stack started with --isolate-unit puts its unit on, alone with what it needs
UNIT_NETWORK = "sce-unit-net"
#: Docker's CLI takes DOCKER_HOST over any context. In Kubernetes and local-dev mode the
#: driver points its own at this socket, which does not exist: every `docker` call the
#: driver makes fails at once, so nothing it runs can reach another stack's containers.
NO_DOCKER = "unix:///nonexistent/sce-e2e-kubernetes-mode-has-no-docker-containers.sock"
#: `docker stop` gives the unit this long to stop by itself (design H1)
STOP_GRACE_S = 20
#: how long a restarted unit may take to become healthy
START_TIMEOUT_S = 240.0

Runner = Callable[[Sequence[str], float], subprocess.CompletedProcess]


class StackControlError(RuntimeError):
    """The stack did not do what it was asked."""


class StackControl(ABC):
    #: whether listing the computing units makes the platform notice a unit that is gone
    #: (Kubernetes: the manager stamps the row of a unit whose pod it no longer finds)
    listing_notices_lost_unit = False

    @abstractmethod
    def kill_unit(self) -> dict:
        """The unit dies at once, as when its machine is lost (SIGKILL)."""

    @abstractmethod
    def stop_unit(self) -> dict:
        """The unit is asked to stop and given time to (SIGTERM)."""

    @abstractmethod
    def start_unit(self) -> dict:
        """A unit runs again and answers. When it is another unit than before, the
        answer names it (`cuid`) and the scenarios after this use that one."""

    @abstractmethod
    def pg_activity(self) -> list[dict]:
        """The client connections Postgres holds now: {pid, application_name, client_addr,
        datname, state} each (lib/pg_activity.py)."""

    @abstractmethod
    def unit_env_names(self) -> list[str]:
        """The names of the environment variables the unit was started with."""

    def unit_addresses(self) -> list[str]:
        """The addresses a connection from the unit to Postgres would come from; none when
        the unit is down or cannot be told from the other services by its address."""
        return []

    def cut_unit_off_the_lake(self) -> dict:
        """The unit can no longer reach the lake (its catalog and its object store), while
        everything else still can, and the unit still answers its sessions."""
        raise StackControlError("this stack cannot cut its unit off the lake")

    def rejoin_unit_to_the_lake(self) -> dict:
        """Undoes `cut_unit_off_the_lake`."""
        raise StackControlError("this stack cannot cut its unit off the lake")

    def exec_prefix(self) -> Callable[[bool], list[str]] | None:
        """What runs a command where the unit now runs, when `start_unit` made that another
        place than before; None when it is where it was."""
        return None


class SingleNodeControl(StackControl):
    """The single-node stack: the unit is one container, and so is Postgres."""

    def __init__(self, containers: dict[str, str] | None = None, runner: Runner = docker_runner,
                 wait_gateway: Callable[[], None] | None = None, start_timeout_s: float = START_TIMEOUT_S):
        names = {**DEFAULT_CONTAINERS, **(containers or {})}
        self.unit = names["workflow-runtime-coordinator-service"]
        self.postgres = names["postgres"]
        self.gateway = names["nginx"]
        #: the lake as the unit reaches it: the catalog and the object store
        self.lake = [names["lakekeeper"], names["rustfs"]]
        #: the names each of them answers to on the unit's network, kept while it is off it
        self._lake_aliases: dict[str, list[str]] = {}
        self._run = runner
        #: waits until the gateway answers again, after its restart
        self._wait_gateway = wait_gateway
        self.start_timeout_s = start_timeout_s
        #: the unit's addresses when it was last taken down: where the gateway still looks for it
        self._addresses: list[str] = []

    def _docker(self, *args: str, timeout: float = 60) -> str:
        p = self._run(list(args), timeout)
        if p.returncode != 0:
            raise StackControlError(f"docker {' '.join(args)}: exit {p.returncode}: {p.stdout.strip()[:300]}")
        return p.stdout

    def _down(self, how: str, *args: str) -> dict:
        self._addresses = self.unit_addresses() or self._addresses
        t0 = time.monotonic()
        self._docker(*args, self.unit, timeout=STOP_GRACE_S + 60)
        return {"unit": self.unit, "how": how, "seconds": round(time.monotonic() - t0, 1)}

    def kill_unit(self) -> dict:
        return self._down("docker kill", "kill")

    def stop_unit(self) -> dict:
        return self._down(f"docker stop -t {STOP_GRACE_S}", "stop", "-t", str(STOP_GRACE_S))

    def start_unit(self) -> dict:
        t0 = time.monotonic()
        self._docker("start", self.unit)
        health = self._wait_healthy(t0)
        info = {"unit": self.unit, "health": health, "healthy_after_s": round(time.monotonic() - t0, 1),
                "gateway_restarted": False}
        addresses = self.unit_addresses()
        if addresses != self._addresses:
            # nginx resolved the unit's address when it started; a unit that came back at
            # another one is reachable only after nginx resolves again
            self._docker("restart", self.gateway, timeout=120)
            if self._wait_gateway is not None:
                self._wait_gateway()
            info.update(gateway_restarted=True, addresses_before=self._addresses, addresses=addresses)
        self._addresses = addresses
        return info

    def _wait_healthy(self, t0: float) -> str:
        health = ""
        while time.monotonic() - t0 < self.start_timeout_s:
            health = self._docker("inspect", "--format", "{{.State.Health.Status}}", self.unit).strip()
            if health == "healthy":
                return health
            time.sleep(1)
        raise StackControlError(f"{self.unit} is not healthy {self.start_timeout_s:.0f} s after `docker start` "
                                f"(health: {health or 'none'})")

    def cut_unit_off_the_lake(self) -> dict:
        """Takes the catalog and the object store off the unit's network. It needs a stack
        started with --isolate-unit: there the unit is on that network alone, and the two
        stay on the stack's own, where the Dashboard service reads them."""
        on = json.loads(self._docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", self.unit) or "{}")
        if set(on) != {UNIT_NETWORK}:
            raise StackControlError(f"{self.unit} is on {sorted(on)}, not on {UNIT_NETWORK} alone: the stack "
                                    f"was not started with --isolate-unit")
        t0 = time.monotonic()
        for container in self.lake:
            nets = json.loads(self._docker("inspect", "--format", "{{json .NetworkSettings.Networks}}",
                                           container) or "{}")
            if UNIT_NETWORK not in nets:
                continue
            names = [a for a in dict.fromkeys(nets[UNIT_NETWORK].get("Aliases") or []) if a != container]
            self._lake_aliases[container] = names
            self._docker("network", "disconnect", UNIT_NETWORK, container)
        return {"off": sorted(self._lake_aliases), "network": UNIT_NETWORK,
                "seconds": round(time.monotonic() - t0, 1)}

    def rejoin_unit_to_the_lake(self) -> dict:
        t0 = time.monotonic()
        back = []
        for container, names in list(self._lake_aliases.items()):
            aliases = [arg for name in names for arg in ("--alias", name)]
            self._docker("network", "connect", *aliases, UNIT_NETWORK, container)
            back.append(container)
            del self._lake_aliases[container]
        return {"back": sorted(back), "network": UNIT_NETWORK, "seconds": round(time.monotonic() - t0, 1)}

    def pg_activity(self) -> list[dict]:
        return pg_activity.parse(self._docker("exec", self.postgres, "psql", "-U", "texera", "-d", "texera_db",
                                              *pg_activity.PSQL_ARGS))

    def unit_env_names(self) -> list[str]:
        env = json.loads(self._docker("inspect", "--format", "{{json .Config.Env}}", self.unit) or "[]")
        return sorted(e.split("=", 1)[0] for e in env)

    def unit_addresses(self) -> list[str]:
        nets = json.loads(self._docker("inspect", "--format", "{{json .NetworkSettings.Networks}}",
                                       self.unit) or "{}")
        found = {n.get(key) for n in nets.values() for key in ("IPAddress", "GlobalIPv6Address")}
        return sorted(a for a in found if a)


def stack_script_env() -> dict[str, str]:
    """The environment a stack script runs in: the driver's, without the driver's own guard
    against Docker. The script reaches its own stack's containers (local-dev's Postgres is
    one), as it does when it is run by hand."""
    return {k: v for k, v in os.environ.items() if (k, v) != ("DOCKER_HOST", NO_DOCKER)}


def run_stack_script(script: Path, *args: str, timeout: float = 300) -> object:
    """Run a stack script's subcommand and read the one JSON document it prints."""
    p = subprocess.run([str(script), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                       timeout=timeout, env=stack_script_env())
    if p.returncode != 0:
        raise StackControlError(f"{script.name} {' '.join(args)}: exit {p.returncode}: "
                                f"{(p.stderr or p.stdout).strip()[-400:]}")
    try:
        return json.loads(p.stdout)
    except ValueError:
        raise StackControlError(f"{script.name} {' '.join(args)} printed no JSON: {p.stdout.strip()[:300]}")
