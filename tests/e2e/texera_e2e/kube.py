"""What the cluster holds for a unit, through kubectl when it is around."""
from __future__ import annotations

import json
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


def fetch_from(deployment: str, url: str) -> str:
    """What a pod of a deployment with Bun gets from a URL: an HTTP status, or why it got none."""
    script = "try{const r=await fetch(process.argv[1],{signal:AbortSignal.timeout(5000)});console.log(r.status)}catch(e){console.log(e.code||e.message)}"
    return _run(["exec", f"deploy/{deployment}", "-c", deployment, "--", "bun", "-e", script, url])


def memory_request(rid: str) -> str:
    return _run(["get", "deploy", f"unit-{rid}", "-o", "jsonpath={.spec.template.spec.containers[0].resources.requests.memory}"])


def rolled_out(rid: str) -> None:
    _run(["rollout", "status", f"deploy/unit-{rid}", "--timeout=600s"], timeout=620)


def lake_namespaces(warehouse: str, token: str) -> list[str] | None:
    """The namespaces of a warehouse as the lake lists them to the caller of the token, asked
    from inside the cluster (the lake has no door outside it); None when the lake has no such
    warehouse for them."""
    script = (
        "const [w,t]=process.argv.slice(1);const h={authorization:'Bearer '+t};const base='http://lakekeeper:8181/catalog/v1';"
        "const c=await fetch(base+'/config?warehouse='+encodeURIComponent(w),{headers:h});"
        "if(!c.ok){console.log(JSON.stringify(null))}else{const j=await c.json();const p=(j.overrides&&j.overrides.prefix)||(j.defaults&&j.defaults.prefix);"
        "const n=await fetch(base+'/'+p+'/namespaces',{headers:h});const l=await n.json();console.log(JSON.stringify((l.namespaces||[]).map(x=>x[0])))}"
    )
    out = _run(["exec", "deploy/live", "-c", "live", "--", "bun", "-e", script, warehouse, token])
    return json.loads(out) if out else None
