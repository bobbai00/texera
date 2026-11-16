"""REST calls the e2e driver makes against a Texera deployment (through its gateway).

Everything here is setup and bookkeeping: login, datasets, the per-user
warehouse, computing units, workflows, and the persisted execution record.
How a run is started, watched and controlled lives in transport.py.

Endpoint shapes were read from upstream main (2026-10/11):
  POST /api/auth/login                       dashboard-service  {username,password} -> {accessToken}
  GET  /api/dataset/list                     file-service
  POST /api/dataset/create                   file-service       -> DashboardDataset{dataset{did}}
  POST /api/dataset/multipart-upload?type=init|finish|abort&ownerEmail&datasetName&filePath...
  POST /api/dataset/multipart-upload/part?...&partNumber=N   (octet-stream body)
  POST /api/dataset/{did}/version/create     file-service       text/plain "" -> {datasetVersion{name}}
  GET  /api/warehouse/status                 dashboard-service  -> {enabled, warehouses[]}
  POST /api/warehouse                        dashboard-service  {name} -> {whid,...}
  GET  /api/computing-unit                   cu-managing        -> [DashboardWorkflowComputingUnit]
  POST /api/computing-unit/create            cu-managing        -> {computingUnit{cuid,uri}}
  POST /api/workflow/create                  dashboard-service  {name,content} -> {workflow{wid}}
  GET  /api/executions/{wid}/latest          dashboard-service  -> {eId,status,...}
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
from typing import Any

import requests

# workflow_executions.status codes (Utils.maptoStatusCode upstream)
EXECUTION_STATUS = {0: "Uninitialized/Ready", 1: "Running", 2: "Paused", 3: "Completed",
                    4: "Failed", 5: "Killed", -1: "Other"}


class TexeraApiError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"{method} {url} -> HTTP {status}: {body[:600]}")


class TexeraApi:
    def __init__(self, base: str, timeout: float = 60.0):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.token: str | None = None
        self.claims: dict[str, Any] = {}

    # ------------------------------------------------------------------ plumbing

    def url(self, path: str) -> str:
        return f"{self.base}{path}"

    def request(self, method: str, path: str, *, expect=(200,), auth: bool = True,
                **kw) -> requests.Response:
        headers = dict(kw.pop("headers", {}) or {})
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        kw.setdefault("timeout", self.timeout)
        url = self.url(path)
        resp = self.session.request(method, url, headers=headers, **kw)
        if expect and resp.status_code not in expect:
            raise TexeraApiError(method, url, resp.status_code, resp.text)
        return resp

    def get_json(self, path: str, **kw) -> Any:
        return self.request("GET", path, **kw).json()

    def post_json(self, path: str, body: Any, **kw) -> Any:
        resp = self.request("POST", path, json=body, **kw)
        return resp.json() if resp.content else None

    # ---------------------------------------------------------------- readiness

    def wait_ready(self, timeout: float = 300) -> None:
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            try:
                r = self.session.get(self.url("/api/healthcheck"), timeout=5)
                if r.status_code == 200:
                    return
                last = f"HTTP {r.status_code}"
            except requests.RequestException as e:
                last = str(e)
            time.sleep(2)
        raise RuntimeError(f"{self.base}/api/healthcheck not ready after {timeout}s ({last})")

    # --------------------------------------------------------------------- auth

    def login(self, username: str, password: str) -> str:
        body = self.post_json("/api/auth/login", {"username": username, "password": password},
                              auth=False)
        token = (body or {}).get("accessToken")
        if not token:
            raise RuntimeError(f"login returned no accessToken: {body}")
        self.token = token
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        self.claims = json.loads(base64.urlsafe_b64decode(payload))
        return token

    @property
    def uid(self) -> int:
        return int(self.claims["userId"])

    @property
    def email(self) -> str:
        return str(self.claims.get("email") or self.claims.get("sub"))

    # ----------------------------------------------------------------- datasets

    def list_datasets(self) -> list[dict]:
        return self.get_json("/api/dataset/list") or []

    def find_dataset(self, name: str) -> dict | None:
        for d in self.list_datasets():
            ds = d.get("dataset") or {}
            if ds.get("name") == name and d.get("isOwner", True):
                return d
        return None

    def create_dataset(self, name: str, description: str = "", public: bool = False) -> int:
        body = self.post_json("/api/dataset/create", {
            "datasetName": name,
            "datasetDescription": description,
            "isDatasetPublic": public,
            "isDatasetDownloadable": True,
        })
        return int(body["dataset"]["did"])

    def upload_file(self, dataset_name: str, file_path: str, data: bytes) -> None:
        """The browser's multipart path, through file-service (works in single-node,
        unlike /dataset/{did}/upload whose presigned URLs point at localhost)."""
        q = {
            "ownerEmail": self.email,
            "datasetName": dataset_name,
            "filePath": file_path,
        }
        init = dict(q, type="init", fileSizeBytes=len(data), partSizeBytes=max(len(data), 1))
        r = self.request("POST", "/api/dataset/multipart-upload?" + urllib.parse.urlencode(init),
                         headers={"Content-Type": "application/json"})
        if "missingParts" not in r.text:
            raise RuntimeError(f"multipart init for {file_path} returned {r.text[:300]}")
        try:
            self.request("POST", "/api/dataset/multipart-upload/part?"
                         + urllib.parse.urlencode(dict(q, partNumber=1)),
                         data=data, headers={"Content-Type": "application/octet-stream"})
            self.request("POST", "/api/dataset/multipart-upload?"
                         + urllib.parse.urlencode(dict(q, type="finish")),
                         headers={"Content-Type": "application/json"})
        except Exception:
            self.request("POST", "/api/dataset/multipart-upload?"
                         + urllib.parse.urlencode(dict(q, type="abort")),
                         headers={"Content-Type": "application/json"}, expect=None)
            raise

    def create_version(self, did: int) -> dict:
        r = self.request("POST", f"/api/dataset/{did}/version/create", data=b"",
                         headers={"Content-Type": "text/plain"})
        return r.json()["datasetVersion"]

    def ensure_dataset(self, name: str, files: dict[str, bytes], description: str = "") -> dict:
        """Create `name` with `files` as its first version (v1); reuse it if it exists.

        Returns {did, version, paths{file -> scan path}}. The scan path is the
        logical path an operator's fileName takes: /dataset/<owner>/<name>/<version>/<file>.
        """
        existing = self.find_dataset(name)
        if existing:
            did = int(existing["dataset"]["did"])
            versions = self.get_json(f"/api/dataset/{did}/version/list") or []
            if versions:
                version = sorted(versions, key=lambda v: v.get("dvid", 0))[0]["name"]
                return {"did": did, "version": version, "reused": True,
                        "paths": {f: f"/dataset/{self.email}/{name}/{version}/{f}" for f in files}}
            # created by a run that died before its version: upload again below
        else:
            did = self.create_dataset(name, description)
        for fname, data in files.items():
            self.upload_file(name, fname, data)
        version = self.create_version(did)["name"]
        return {"did": did, "version": version, "reused": False,
                "paths": {f: f"/dataset/{self.email}/{name}/{version}/{f}" for f in files}}

    # ---------------------------------------------------------------- warehouse

    def warehouse_status(self) -> dict | None:
        """None when the deployment has no warehouse endpoint (feature absent)."""
        r = self.request("GET", "/api/warehouse/status", expect=None)
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise TexeraApiError("GET", r.url, r.status_code, r.text)
        return r.json()

    def ensure_warehouse(self, name: str) -> tuple[int | None, dict | None]:
        """(whid or None when runs need no warehouse, the status document)."""
        status = self.warehouse_status()
        if not status or not status.get("enabled"):
            return None, status
        for w in status.get("warehouses") or []:
            if w.get("name") == name:
                return int(w["whid"]), status
        created = self.post_json("/api/warehouse", {"name": name})
        return int(created["whid"]), status

    # ----------------------------------------------------------- computing units

    def list_units(self) -> list[dict]:
        return self.get_json("/api/computing-unit") or []

    def ensure_local_unit(self, name: str, uri: str) -> dict:
        """A `local` unit is only a row with a stored URI; reuse ours if present."""
        for u in self.list_units():
            cu = u.get("computingUnit") or {}
            if (cu.get("name") == name and cu.get("uri") == uri
                    and str(cu.get("type", "")).lower() == "local"
                    and not cu.get("terminateTime")):
                return cu
        body = self.post_json("/api/computing-unit/create", {
            "name": name,
            "unitType": "local",
            "cpuLimit": "NaN",
            "memoryLimit": "NaN",
            "gpuLimit": "NaN",
            "jvmMemorySize": "NaN",
            "shmSize": "NaN",
            "uri": uri,
        })
        return body["computingUnit"]

    # ---------------------------------------------------------------- workflows

    def create_workflow(self, name: str, content: dict) -> int:
        body = self.post_json("/api/workflow/create", {"name": name,
                                                        "content": json.dumps(content)})
        return int(body["workflow"]["wid"])

    # ----------------------------------------------------------------- executions

    def latest_execution(self, wid: int) -> dict | None:
        r = self.request("GET", f"/api/executions/{wid}/latest", expect=None)
        if r.status_code != 200:
            return None
        return r.json()

    def wait_execution_status(self, wid: int, want: int, timeout: float = 30) -> dict | None:
        """Poll the persisted execution row until its status code is `want`."""
        deadline = time.time() + timeout
        entry = None
        while time.time() < deadline:
            entry = self.latest_execution(wid)
            if entry and entry.get("status") == want:
                return entry
            time.sleep(1)
        return entry
