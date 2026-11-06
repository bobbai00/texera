"""Computing units as the scenarios wait for them."""
import time

from .client import Api


def wait_ready(api: Api, rid: str, seconds: int = 600) -> tuple[str, float]:
    """Waits until a unit is ready, at most `seconds`; returns its last phase and how long it took."""
    phase, started = None, time.time()
    while time.time() - started < seconds:
        phase = api.get(f"/computing-units/{rid}")["status"]["phase"]
        if phase == "ready":
            break
        time.sleep(5)
    return phase, time.time() - started
