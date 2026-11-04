"""What the cluster holds for a unit, through kubectl when it is around."""
from __future__ import annotations

import os
import shutil
import subprocess

CONTEXT = os.environ.get("TEXERA2_KUBE_CONTEXT", "kind-texera2")
NAMESPACE = os.environ.get("TEXERA2_KUBE_NAMESPACE", "texera2")


def available() -> bool:
    return shutil.which("kubectl") is not None


def _run(args: list[str], timeout: int = 60) -> str:
    try:
        out = subprocess.run(["kubectl", "--context", CONTEXT, "-n", NAMESPACE, *args], capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def held_for(rid: str) -> list[str]:
    """The deployment, service and secret names labelled with the unit; [] without kubectl."""
    out = _run(["get", "deploy,svc,secret", "-l", f"texera.apache.org/unit={rid}", "-o", "name"])
    return out.split() if out else []


def memory_request(rid: str) -> str:
    return _run(["get", "deploy", f"unit-{rid}", "-o", "jsonpath={.spec.template.spec.containers[0].resources.requests.memory}"])


def rolled_out(rid: str) -> None:
    _run(["rollout", "status", f"deploy/unit-{rid}", "--timeout=600s"], timeout=620)
