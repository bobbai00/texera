"""A fake lake for the offline tests: Iceberg tables as the step-3 design writes them
(sections 3.1, 3.2 and 4.2), and what Lakekeeper's REST API answers about them.

A table keeps what the catalog can show without opening a data file: its properties,
its refs, its snapshots and, in each snapshot's summary, the totals Iceberg carries
forward (rows, data files, bytes). It also keeps the rows, for the fake Dashboard's
routes. An append is one commit: one data file, one snapshot and, when given, the
properties, together. Setting properties alone adds no snapshot. A tidy merges the
data files into one, rewrites the manifests (one more snapshot) and expires
snapshots: during a run it keeps the last 60 s and at least five, at the end one.

It models the design, as fake_texera.py does. What Lakekeeper really answers is
checked on a real stack.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
import urllib.parse

#: a tidy during a run keeps the snapshots of this long, and at least RETAIN_SNAPSHOTS
RETAIN_MS = 60_000
RETAIN_SNAPSHOTS = 5


def now_ms() -> int:
    return int(time.time() * 1000)


class FakeTable:
    def __init__(self, where: str):
        self.where = where
        self.rows: list[dict] = []
        self.properties: dict[str, str] = {}
        self.refs: dict[str, dict] = {}
        #: rows per data file of the current snapshot
        self.files: list[int] = []
        self.snapshots: list[dict] = []
        self.appends_since_tidy = 0
        self._next_snapshot = 1

    @property
    def size_bytes(self) -> int:
        return sum(400 + 60 * n for n in self.files)

    def _commit(self, operation: str) -> None:
        """A new snapshot of the table as it is now; `main` moves to it."""
        sid = self._next_snapshot
        self._next_snapshot += 1
        self.snapshots.append({
            "snapshot-id": sid, "timestamp-ms": now_ms(),
            "summary": {"operation": operation, "total-records": str(len(self.rows)),
                        "total-data-files": str(len(self.files)), "total-files-size": str(self.size_bytes)},
        })
        self.refs["main"] = {"snapshot-id": sid, "type": "branch"}

    def append(self, rows: list[dict], properties: dict[str, str] | None = None) -> None:
        self.rows.extend(rows)
        self.files.append(len(rows))
        self.properties.update(properties or {})
        self._commit("append")
        self.appends_since_tidy += 1

    def set_properties(self, properties: dict[str, str]) -> None:
        self.properties.update(properties)

    def tidy(self, at_end: bool, merge: bool = True) -> None:
        """Design 4.2. A table nothing was written to has nothing to tidy."""
        if not self.snapshots:
            return
        if merge and len(self.files) >= 2:
            self.files = [len(self.rows)]
            self._commit("replace")
        self._commit("replace")  # the manifests rewritten into one
        keep = 1 if at_end else RETAIN_SNAPSHOTS
        young = now_ms() + 1 if at_end else now_ms() - RETAIN_MS
        last = len(self.snapshots) - keep
        self.snapshots = [s for i, s in enumerate(self.snapshots) if i >= last or s["timestamp-ms"] >= young]
        self.appends_since_tidy = 0

    def metadata(self) -> dict:
        meta = {"format-version": 2, "location": f"s3://texera-iceberg/{self.where}",
                "properties": dict(self.properties), "snapshots": [dict(s) for s in self.snapshots],
                "refs": {k: dict(v) for k, v in self.refs.items()}}
        if self.snapshots:
            meta["current-snapshot-id"] = self.refs["main"]["snapshot-id"]
        return meta


class FakeLake:
    """Tables by (warehouse, namespace, name), behind one lock."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.tables: dict[tuple[str, str, str], FakeTable] = {}
        #: (warehouse, namespace): made with its first table, and kept when its tables go
        self.namespaces: set[tuple[str, str]] = set()
        #: the catalog cannot answer (an outage): every request is a 503
        self.unreadable = False
        #: tables per page of a namespace listing
        self.page_size = 100
        self.requests: list[str] = []

    # ------------------------------------------------------------- tables

    def create(self, warehouse: str, namespace: str, name: str) -> FakeTable:
        """A new, empty table; one of that name left by an earlier database is replaced."""
        with self.lock:
            table = FakeTable(f"{warehouse}/{namespace}/{name}")
            self.tables[(warehouse, namespace, name)] = table
            self.namespaces.add((warehouse, namespace))
            return table

    def table(self, warehouse: str, namespace: str, name: str) -> FakeTable | None:
        with self.lock:
            return self.tables.get((warehouse, namespace, name))

    def drop(self, warehouse: str, namespace: str, name: str) -> bool:
        with self.lock:
            return self.tables.pop((warehouse, namespace, name), None) is not None

    def names(self, warehouse: str, namespace: str) -> list[str]:
        with self.lock:
            return sorted(n for w, ns, n in self.tables if (w, ns) == (warehouse, namespace))

    # --------------------------------------------------- Lakekeeper's REST API

    @staticmethod
    def prefix_of(warehouse: str) -> str:
        """Lakekeeper serves a warehouse under an id of its own, not under its name."""
        return "wh-" + hashlib.sha1(warehouse.encode()).hexdigest()[:12]

    def _warehouse_of(self, prefix: str) -> str | None:
        with self.lock:
            known = {w for w, _ in self.namespaces}
        return next((w for w in known if self.prefix_of(w) == prefix), None)

    def rest(self, path: str) -> tuple[int, dict]:
        """The answer to GET <catalog URI><path>."""
        self.requests.append(path)
        if self.unreadable:
            return 503, {"error": {"message": "the catalog is not available", "code": 503}}
        parts = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(parts.query)
        segments = [urllib.parse.unquote(s) for s in parts.path.strip("/").split("/")]
        if segments == ["v1", "config"]:
            warehouse = (query.get("warehouse") or [""])[0]
            return 200, {"overrides": {"prefix": self.prefix_of(warehouse)}, "defaults": {}}
        warehouse = self._warehouse_of(segments[1]) if len(segments) > 1 else None
        if segments[:1] != ["v1"] or warehouse is None:
            return 404, {"error": {"message": "Warehouse does not exist", "code": 404}}
        rest = segments[2:]
        with self.lock:
            if rest == ["namespaces"]:
                return 200, {"namespaces": sorted([ns] for w, ns in self.namespaces if w == warehouse)}
            if len(rest) == 3 and rest[0] == "namespaces" and rest[2] == "tables":
                return self._list(warehouse, rest[1], (query.get("pageToken") or ["0"])[0])
            if len(rest) == 4 and rest[0] == "namespaces" and rest[2] == "tables":
                table = self.tables.get((warehouse, rest[1], rest[3]))
                if table is None:
                    return 404, {"error": {"message": "Table does not exist", "code": 404}}
                return 200, {"metadata-location": f"{table.metadata()['location']}/metadata/v.json",
                             "metadata": table.metadata(), "config": {}}
        return 404, {"error": {"message": f"no route {path}", "code": 404}}

    def _list(self, warehouse: str, namespace: str, token: str) -> tuple[int, dict]:
        if (warehouse, namespace) not in self.namespaces:
            return 404, {"error": {"message": "Namespace does not exist", "code": 404}}
        names = self.names(warehouse, namespace)
        start = int(token)
        page = names[start:start + self.page_size]
        more = start + self.page_size < len(names)
        return 200, {"identifiers": [{"namespace": [namespace], "name": n} for n in page],
                     "next-page-token": str(start + self.page_size) if more else None}

    def fetch(self, path: str) -> subprocess.CompletedProcess:
        """`curl -s -w "\\n%{http_code}"` of the catalog, as the driver's lake.Fetch wants it."""
        status, body = self.rest(path)
        return subprocess.CompletedProcess(["curl", path], 0, f"{json.dumps(body)}\n{status}", "")
