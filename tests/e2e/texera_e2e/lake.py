"""Lakekeeper and Keycloak as a unit or a bystander reaches them, around the catalog."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

LAKE = os.environ.get("TEXERA_E2E_LAKE", "http://localhost:18181")
KEYCLOAK = os.environ.get("TEXERA_E2E_KEYCLOAK", "http://localhost:18081/auth/realms/texera")
SECRETS = os.environ.get("TEXERA_E2E_SECRETS", "http://localhost:18200")
SECRETS_TOKEN = os.environ.get("TEXERA_E2E_SECRETS_TOKEN", "texera-dev-root")
UNIT_CLIENT = (os.environ.get("TEXERA_E2E_UNIT_CLIENT_ID", "texera-unit"), os.environ.get("TEXERA_E2E_UNIT_CLIENT_SECRET", "texera-unit-secret"))


def token_url() -> str:
    return f"{KEYCLOAK}/protocol/openid-connect/token"


def http(method: str, url: str, token: str | None = None, headers: dict | None = None) -> tuple[int, object]:
    h = {"Content-Type": "application/json", **(headers or {})}
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")


def lake_get(path: str, token: str | None = None, headers: dict | None = None) -> tuple[int, object]:
    return http("GET", f"{LAKE}{path}", token, headers)


def prefix(token: str, warehouse: str = "texera") -> str:
    status, cfg = lake_get(f"/catalog/v1/config?warehouse={warehouse}", token)
    if status != 200:
        raise RuntimeError(f"lake config: {status} {cfg}")
    return cfg["overrides"].get("prefix") or cfg["defaults"].get("prefix")


def namespaces(token: str, pfx: str) -> tuple[int, list[str]]:
    status, listing = lake_get(f"/catalog/v1/{pfx}/namespaces", token)
    return status, [n[0] for n in listing.get("namespaces", [])] if status == 200 else []


def tables(token: str, pfx: str, namespace: str) -> tuple[int, list[str]]:
    status, listing = lake_get(f"/catalog/v1/{pfx}/namespaces/{namespace}/tables", token)
    return status, [t["name"] for t in listing.get("identifiers", [])] if status == 200 else []


def load_table(token: str, pfx: str, namespace: str, table: str) -> int:
    status, _ = lake_get(f"/catalog/v1/{pfx}/namespaces/{namespace}/tables/{urllib.parse.quote(table, safe='')}", token,
                         {"X-Iceberg-Access-Delegation": "vended-credentials"})
    return status


def unit_secret(rid: str) -> tuple[int, str]:
    """A provisioned unit's credential from the dev secret store (the dev root token stands in
    for the pod); ('', status) when it is not there."""
    status, body = http("GET", f"{SECRETS}/v1/texera/data/units/{rid}", headers={"X-Vault-Token": SECRETS_TOKEN})
    secret = (body or {}).get("data", {}).get("data", {}).get("secret", "") if status == 200 else ""
    return status, secret


def execution_namespace(eid: str) -> str:
    return "e_" + eid.replace("-", "")
