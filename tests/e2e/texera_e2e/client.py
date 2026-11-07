"""The catalog through the gateway, as one person (or nobody)."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class ApiError(Exception):
    """A response the caller did not expect; carries the status and the parsed body."""

    def __init__(self, method: str, path: str, status: int, body: Any):
        super().__init__(f"{method} {path} -> {status}: {str(body)[:300]}")
        self.status, self.body = status, body


def _decode(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode(errors="replace")


@dataclass
class Api:
    """One caller of the catalog's API; `token` empty for an anonymous call."""

    gw: str
    token: str = ""
    timeout: int = 300

    @property
    def base(self) -> str:
        return f"{self.gw}/catalog/v1"

    def call(self, method: str, path: str, body: Any = None, *, headers: dict | None = None, raw: bytes | None = None,
             content_type: str = "application/json") -> tuple[int, Any]:
        """Sends the request and returns (status, body) whatever the status."""
        h = {"Content-Type": content_type, **(headers or {})}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        url = path if path.startswith("http") else f"{self.base}{path}"
        req = urllib.request.Request(url, method=method, headers=h, data=data)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, _decode(r.read())
        except urllib.error.HTTPError as e:
            return e.code, _decode(e.read())

    def _ok(self, method: str, path: str, body: Any = None, **kw) -> Any:
        status, out = self.call(method, path, body, **kw)
        if status // 100 != 2:
            raise ApiError(method, path, status, out)
        return out

    def get(self, path: str) -> Any:
        return self._ok("GET", path)

    def post(self, path: str, body: Any = None) -> Any:
        return self._ok("POST", path, body if body is not None else {})

    def put(self, path: str, body: Any = None) -> Any:
        return self._ok("PUT", path, body if body is not None else {})

    def delete(self, path: str) -> Any:
        return self._ok("DELETE", path)

    def status(self, method: str, path: str, body: Any = None) -> int:
        return self.call(method, path, body)[0]

    def upload(self, path: str, data: bytes, content_type: str = "text/csv") -> Any:
        return self._ok("PUT", path, raw=data, content_type=content_type)

    def download(self, path: str) -> bytes:
        h = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        with urllib.request.urlopen(urllib.request.Request(f"{self.base}{path}", headers=h), timeout=self.timeout) as r:
            return r.read()

    # --- the person ---
    def me(self) -> dict:
        return self.get("/me")

    def pid(self) -> str:
        return self.me()["principal"]["pid"]

    def home(self) -> str:
        return self.me()["homeProject"]

    def root(self) -> str:
        """Texera: the project every project inherits from."""
        return self.me()["rootProject"]

    def settings(self, project: str) -> dict:
        """What a project's work runs with: its settings with what it inherits filled in, each
        value's source by its path."""
        return self.get(f"/projects/{project}/settings")

    # --- resources ---
    def create(self, plural: str, name: str, spec: Any, *, project: str | None = None, **more) -> dict:
        body = {"name": name, "spec": spec, **more}
        if project:
            body["parent"] = project
        return self.post(f"/{plural}", body)

    def grant(self, rid: str, pid: str, relation: str) -> dict:
        return self.put(f"/resources/{rid}/grants/{pid}", {"relation": relation})

    def revoke(self, rid: str, pid: str) -> None:
        self.call("DELETE", f"/resources/{rid}/grants/{pid}")

    def mcp(self, method: str, params: dict | None = None, id: int = 1, headers: dict | None = None) -> tuple[int, Any]:
        """One JSON-RPC call to the catalog's MCP server behind the gateway; the first SSE event's data."""
        body = {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **(headers or {})}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(f"{self.gw}/mcp/catalog", method="POST", headers=h, data=json.dumps(body).encode())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                for line in r:
                    text = line.decode().strip()
                    if text.startswith("data:"):
                        return r.status, json.loads(text[5:].strip())
                    if text.startswith("{"):
                        return r.status, json.loads(text)
                return r.status, None
        except urllib.error.HTTPError as e:
            return e.code, _decode(e.read())


def token(gw: str, user: str, password: str) -> str:
    """A person's access token from Keycloak, through the gateway."""
    data = urllib.parse.urlencode({"grant_type": "password", "client_id": "texera-app", "username": user, "password": password}).encode()
    with urllib.request.urlopen(f"{gw}/auth/realms/texera/protocol/openid-connect/token", data, timeout=60) as r:
        return json.load(r)["access_token"]


def client_token(token_url: str, client_id: str, secret: str, scope: str = "openid") -> tuple[int, str]:
    """A client-credentials token, as a service or a unit gets one; (status, token)."""
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret, "scope": scope}).encode()
    try:
        with urllib.request.urlopen(token_url, data, timeout=60) as r:
            return r.status, json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        return e.code, ""


def uri_rid(uri: str) -> str:
    """The rid of a texera:// URI (any kind), without a version."""
    return uri.rsplit("/", 1)[-1].split("@", 1)[0]
