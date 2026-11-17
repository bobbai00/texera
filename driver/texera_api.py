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
  GET  /api/executions/{wid}                 dashboard-service  -> [{eId,status,logLocation,...}]
  GET  /api/executions/{wid}/interactions/{eid}  dashboard-service  -> [interaction id]
  POST /api/auth/register                    dashboard-service  {username,email,password} -> {accessToken}
  GET  /api/admin/user/list, PUT /api/admin/user/update   dashboard-service (ADMIN) User POJO
  DELETE /api/computing-unit/{cuid}/terminate  cu-managing
  POST /api/pve/db, GET /api/pve/db          the unit (legacy environments, until step 2's sub-part 21)
  WS   /wsapi/pve?cuid&pveName&action=create|install[&packages=[..]]  the unit; lines until __DONE__

Step 2 (design section 3), not on the published images:
  POST /api/executions                       dashboard-service  3.4 -> 201 {eid,wid,computingUnitId,planUri}
  POST /api/executions/{eid}/updates         dashboard-service  3.5 {operator} -> 200 {updateId,operatorId}
  GET/POST /api/environments, PUT/DELETE /api/environments/{veid}   dashboard-service 3.8

Step 3 (its design, section 3.5). The product is being built against that design, so
each answer is read in one place here (the classes below) and the scenarios use their
fields: a name the product chooses differently is one line to change.
  GET  /api/executions/{wid}/stats/{eid}[?cuid]  dashboard-service  -> [{operatorId, timestamp (epoch ms),
                                             inputTupleCount, outputTupleCount, numWorkers, status, ...}]
                                             read from the lake from sub-part 6 on; until sub-part 16 a
                                             Kubernetes gateway routes it to the unit `cuid` names
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
from typing import Any, Callable

from dataclasses import dataclass

import requests
import websocket  # websocket-client

# workflow_executions.status codes (Utils.maptoStatusCode upstream)
EXECUTION_STATUS = {0: "Uninitialized/Ready", 1: "Running", 2: "Paused", 3: "Completed",
                    4: "Failed", 5: "Killed", -1: "Other"}


class TexeraApiError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"{method} {url} -> HTTP {status}: {body[:600]}")


@dataclass
class StatisticsRow:
    """One stored sample of an operator's statistics. The field names are the ones the
    server sends today (WorkflowRuntimeStatistics), which the design keeps; counts are
    cumulative."""

    operator_id: str
    #: epoch milliseconds (design D7); kept as sent, so a scenario can check the type
    time_ms: Any
    input_count: int
    output_count: int
    num_workers: int
    status: int

    @classmethod
    def of(cls, row: dict) -> "StatisticsRow":
        return cls(operator_id=str(row.get("operatorId")), time_ms=row.get("timestamp"),
                   input_count=int(row.get("inputTupleCount") or 0),
                   output_count=int(row.get("outputTupleCount") or 0),
                   num_workers=int(row.get("numWorkers") or 0), status=int(row.get("status") or 0))


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
        self.set_token(token)
        return token

    def set_token(self, token: str) -> None:
        self.token = token
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        self.claims = json.loads(base64.urlsafe_b64decode(payload))

    def with_token(self, token: str) -> "TexeraApi":
        """Another client of the same deployment, acting as the token's user."""
        other = TexeraApi(self.base, self.timeout)
        other.set_token(token)
        return other

    def token_for(self, username: str, password: str) -> str:
        """A token of another user (by logging in as them); this client is unchanged."""
        return TexeraApi(self.base, self.timeout).login(username, password)

    @property
    def role(self) -> str:
        return str(self.claims.get("role") or "")

    # --------------------------------------------------------------------- users

    def register_user(self, username: str, email: str, password: str) -> str | None:
        """POST /api/auth/register; the new (INACTIVE) user's token, or None when the
        name already exists (log in instead) or the deployment mails a code first."""
        r = self.request("POST", "/api/auth/register",
                         json={"username": username, "email": email, "password": password},
                         auth=False, expect=None)
        if r.status_code == 200:
            return (r.json() or {}).get("accessToken")
        if "exists already" in r.text:
            return None
        raise TexeraApiError("POST", r.url, r.status_code, r.text)

    def list_users(self) -> list[dict]:
        return self.get_json("/api/admin/user/list") or []

    def set_role(self, uid: int, role: str) -> None:
        """The admin's PUT /api/admin/user/update with the user's row and a new role."""
        user = next((u for u in self.list_users() if int(u.get("uid", -1)) == int(uid)), None)
        if user is None:
            raise RuntimeError(f"no user {uid} in /api/admin/user/list")
        self.request("PUT", "/api/admin/user/update", json={
            "uid": uid, "name": user.get("name"), "email": user.get("email"), "role": role,
            "comment": user.get("comment") or "",
        }, expect=(200, 204))

    def ensure_user(self, username: str, email: str, password: str, role: str = "REGULAR") -> "TexeraApi":
        """A client logged in as `username` with `role` (registered and activated by this
        client, which must be an admin, when needed)."""
        try:
            other = TexeraApi(self.base, self.timeout)
            other.login(username, password)
        except TexeraApiError:
            if self.register_user(username, email, password) is None:
                raise RuntimeError(f"user {username} exists with another password, or registration "
                                   f"needs an emailed code here")
            other = TexeraApi(self.base, self.timeout)
            other.login(username, password)
        if other.role != role:
            self.set_role(other.uid, role)
            other.login(username, password)  # the role travels in the token
        if other.role != role:
            raise RuntimeError(f"{username} still has role {other.role}, not {role}")
        return other

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
        return self.create_local_unit(name, uri)

    def terminate_unit(self, cuid: int) -> requests.Response:
        return self.request("DELETE", f"/api/computing-unit/{cuid}/terminate", expect=None,
                            headers={"Content-Type": "application/json"})

    def create_local_unit(self, name: str, uri: str) -> dict:
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

    def list_executions(self, wid: int) -> list[dict]:
        """Every execution of the workflow ([] when the caller cannot read it)."""
        return self.get_json(f"/api/executions/{wid}") or []

    def execution_entry(self, wid: int, eid: int) -> dict | None:
        return next((e for e in self.list_executions(wid) if e.get("eId") == eid), None)

    def wait_entry_status(self, wid: int, eid: int, want: int, timeout: float = 30) -> dict | None:
        """Poll one execution's row until its status is `want`; the last row seen."""
        deadline = time.time() + timeout
        entry = None
        while True:
            entry = self.execution_entry(wid, eid)
            if (entry and entry.get("status") == want) or time.time() > deadline:
                return entry
            time.sleep(1)

    def execution_interactions(self, wid: int, eid: int) -> list[str]:
        return self.get_json(f"/api/executions/{wid}/interactions/{eid}") or []

    # --------------------------------------------- step 2: create and update

    def create_execution(self, body: dict) -> requests.Response:
        """POST /api/executions (design 3.4); the raw response, any status. The
        Dashboard compiles here, so allow the 120 s the gateway gives it."""
        return self.request("POST", "/api/executions", json=body, expect=None,
                            timeout=max(self.timeout, 130))

    def post_operator_update(self, eid: int, operator: dict) -> requests.Response:
        """POST /api/executions/{eid}/updates (design 3.5); the raw response."""
        return self.request("POST", f"/api/executions/{eid}/updates", json={"operator": operator},
                            expect=None, timeout=max(self.timeout, 130))

    # ------------------------------------------------- step 3: the stored record

    def execution_statistics(self, wid: int, eid: int, cuid: int | None = None) -> list[StatisticsRow]:
        """The stored statistics of an execution, oldest first. `cuid`, as the browser
        sends it until the Dashboard serves statistics by execution alone (step 3's
        sub-part 16): a Kubernetes gateway routes the request to that unit."""
        query = f"?cuid={cuid}" if cuid is not None else ""
        return [StatisticsRow.of(r) for r in self.get_json(f"/api/executions/{wid}/stats/{eid}{query}") or []]

    # ------------------------------------------------------------ environments

    def list_environments(self, legacy: bool = False) -> list[dict]:
        """The caller's environments: /api/environments (step 2's sub-part 19 on) or
        the unit's legacy /api/pve/db."""
        return self.get_json("/api/pve/db" if legacy else "/api/environments") or []

    def ensure_environment(self, name: str, packages: dict[str, str], legacy: bool = False) -> dict:
        """The caller's environment `name` holding `packages`: created (201), or the
        existing row updated when its packages differ."""
        path = "/api/pve/db" if legacy else "/api/environments"
        r = self.request("POST", path, json={"name": name, "packages": packages}, expect=None)
        if r.status_code == 201:
            row = r.json() or {}
            return {"veid": row.get("veid"), "name": name, "packages": row.get("packages", packages),
                    "created": True}
        if r.status_code != 409:
            raise TexeraApiError("POST", r.url, r.status_code, r.text)
        row = next((e for e in self.list_environments(legacy) if e.get("name") == name), None)
        if row is None:
            raise RuntimeError(f"environment {name} exists (409) but is not in the caller's list")
        if (row.get("packages") or {}) != packages:
            self.request("PUT", f"{path}/{row['veid']}", json={"name": name, "packages": packages})
        return {"veid": row.get("veid"), "name": name, "packages": packages, "created": False}

    def build_legacy_environment(self, cuid: int, name: str, packages: list[str], *,
                                 timeout: float = 1800, log: Callable[[str], None] | None = None) -> dict:
        """The unit's legacy environment path (/wsapi/pve): create the venv (it installs
        amber's requirements, which takes minutes), then install `packages` into it.
        Returns {"create": [lines], "install": [lines]}; raises on a [PVE][ERR]/[ERR]
        line, a missing __DONE__ or the timeout."""
        out = {}
        for action, extra in (("create", {}),
                              ("install", {"packages": json.dumps(list(packages))})):
            query = urllib.parse.urlencode({"cuid": cuid, "pveName": name, "action": action,
                                            "access-token": self.token or "", **extra})
            lines = self._pve_socket(f"{self.ws_url('/wsapi/pve')}?{query}", timeout, log)
            errors = [ln for ln in lines if ln.startswith("[PVE][ERR]") or ln.startswith("[ERR]")]
            if errors or not lines or lines[-1] != "__DONE__":
                raise RuntimeError(f"/wsapi/pve {action} {name} failed: "
                                   f"{(errors or lines[-5:] or ['no output'])[:5]}")
            out[action] = lines
        return out

    def ws_url(self, path: str) -> str:
        parts = urllib.parse.urlsplit(self.base)
        scheme = "wss" if parts.scheme == "https" else "ws"
        return urllib.parse.urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + path, "", ""))

    @staticmethod
    def _pve_socket(url: str, timeout: float, log: Callable[[str], None] | None) -> list[str]:
        deadline = time.monotonic() + timeout
        ws = websocket.create_connection(url, timeout=30)
        lines: list[str] = []
        try:
            while time.monotonic() < deadline:
                ws.settimeout(max(1.0, min(300.0, deadline - time.monotonic())))
                try:
                    msg = ws.recv()
                except websocket.WebSocketConnectionClosedException:
                    break
                except websocket.WebSocketTimeoutException:
                    continue
                if not msg:
                    break
                lines.append(msg)
                if log and (msg.startswith("[PVE]") or msg.startswith("[ERR]") or len(lines) % 50 == 0):
                    log(f"    pve: {msg[:200]}")
                if msg == "__DONE__":
                    break
        finally:
            try:
                ws.close()
            except Exception:
                pass
        return lines
