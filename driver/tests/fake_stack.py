"""The stack's control (driver/stack_control.py) over the fake Texera, for the offline
tests: what `docker kill`, a deleted pod or a killed JVM does to a real unit, it does to
the fake's (fake_texera.py: take_unit_down, bring_unit_up).

With the fake in its Kubernetes flavour a unit is a pod of its own: the control takes
down the unit in use, and the unit that comes back is a new one, created through the
fake's REST API as the driver's Kubernetes control creates one.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stack_control import StackControl  # noqa: E402


class FakeStack(StackControl):
    def __init__(self, fake, api=None, cuid: int | None = None):
        self.fake, self.api = fake, api
        #: Kubernetes flavour: the unit in use
        self.cuid = cuid
        #: how long a unit takes until it answers again
        self.start_delay_s = 0.0
        #: what the scenarios asked of the stack, in order
        self.calls: list[str] = []

    @property
    def listing_notices_lost_unit(self) -> bool:
        return self.fake.kubernetes

    def _down(self, how: str, polite: bool) -> dict:
        self.calls.append(how)
        self.fake.take_unit_down(polite=polite, cuid=self.cuid if self.fake.kubernetes else None)
        return {"how": how, "cuid": self.cuid}

    def kill_unit(self) -> dict:
        return self._down("kill", polite=False)

    def stop_unit(self) -> dict:
        return self._down("stop", polite=True)

    def start_unit(self) -> dict:
        self.calls.append("start")
        time.sleep(self.start_delay_s)
        if not self.fake.kubernetes:
            self.fake.bring_unit_up()
            return {"healthy_after_s": self.start_delay_s}
        unit = self.api.post_json("/api/computing-unit/create", {
            "name": f"fake-unit-{len(self.calls)}", "unitType": "kubernetes", "uri": ""})["computingUnit"]
        self.cuid = int(unit["cuid"])
        return {"cuid": self.cuid}

    def pg_activity(self) -> list[dict]:
        return self.fake.backends()

    def unit_env_names(self) -> list[str]:
        return sorted(self.fake.unit_env)

    def unit_addresses(self) -> list[str]:
        return [self.fake.unit_address] if self.fake.unit_up else []
