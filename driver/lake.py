"""An execution's tables in the lake, as the catalog shows them.

Step 3 (design sections 3.1 and 3.2) keeps an execution's record in Iceberg tables:
its log, its statistics, its console output, and a result and a state table per
stored output port. This module reads what Lakekeeper's REST API (the Iceberg REST
catalog) says about them: whether a table exists, its properties (the log's label),
how many snapshots it holds, and the totals Iceberg keeps in the current snapshot's
summary (data files, rows, bytes). It never opens a data file, so it needs no access
to the object store.

Lakekeeper is asked from wherever the stack can reach it (a `Fetch`): the dashboard
container on the single-node stack; the webserver's pod in Kubernetes; this host in
local-dev.

The names below are the design's. The product may still move one; each is a constant
here, read nowhere else.
"""

from __future__ import annotations

import json
import subprocess
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

#: given the path after the catalog's URI, runs curl there: stdout is the body, a newline, the status
Fetch = Callable[[str], subprocess.CompletedProcess]
CURL = ("curl", "-s", "-w", "\n%{http_code}")
DEFAULT_CATALOG_URI = "http://texera-lakekeeper:8181/catalog"
DEFAULT_WAREHOUSE = "texera"

#: design 3.1: an execution's own tables, kind -> (namespace setting, its default, table suffix)
EXECUTION_TABLES = {
    "log": ("STORAGE_ICEBERG_TABLE_EXECUTION_LOG_NAMESPACE", "execution-log", "executionlog"),
    "statistics": ("STORAGE_ICEBERG_TABLE_RUNTIME_STATISTICS_NAMESPACE", "workflow-runtime-statistics",
                   "runtimestatistics"),
    "console": ("STORAGE_ICEBERG_TABLE_CONSOLE_MESSAGES_NAMESPACE", "operator-console-messages",
                "consolemessages"),
}
#: design 3.1: the tables of a stored output port, kind -> (namespace setting, its default)
PORT_TABLES = {
    "result": ("STORAGE_ICEBERG_TABLE_RESULT_NAMESPACE", "operator-port-result"),
    "state": ("STORAGE_ICEBERG_TABLE_STATE_NAMESPACE", "operator-port-state"),
}
#: design 3.2: the label, six properties of the log table
LABEL_STATE = "texera.execution.state"
LABEL_STATE_SEQ = "texera.execution.state-seq"
LABEL_STATE_TIME_MS = "texera.execution.state-time-ms"
LABEL_REASON = "texera.execution.reason"
LABEL_BEAT_MS = "texera.execution.beat-ms"
LABEL_BEAT_EVERY_MS = "texera.execution.beat-every-ms"
#: the output modes a result is recorded with (`output_mode_enum`)
OUTPUT_MODES = ("SET_SNAPSHOT", "SET_DELTA", "SINGLE_SNAPSHOT")
#: a namespace listing is followed for at most this many pages
MAX_LIST_PAGES = 200


def docker_fetch(runner: Callable[[Sequence[str], float], subprocess.CompletedProcess], container: str,
                 catalog_uri: str) -> Fetch:
    """curl inside `container` of the single-node stack (`runner` runs `docker <args>`)."""
    return lambda path: runner(["exec", container, *CURL, f"{catalog_uri}{path}"], 60)


def host_fetch(catalog_uri: str) -> Fetch:
    """curl on this host (local-dev publishes Lakekeeper on a local port)."""
    return lambda path: subprocess.run([*CURL, f"{catalog_uri}{path}"], stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, timeout=60)


def pod_fetch(kubectl: Sequence[str], workload: str) -> Fetch:
    """curl inside a pod of `workload` (`kubectl`: the command up to the namespace), against the
    catalog that pod itself is configured with, so the driver needs no address of its own."""
    script = 'exec curl -s -w "\\n%{http_code}" "${STORAGE_ICEBERG_CATALOG_REST_URI%/}$1"'
    return lambda path: subprocess.run([*kubectl, "exec", workload, "--", "sh", "-c", script, "sh", path],
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                       timeout=60)


class Catalog:
    """Lakekeeper's REST API."""

    def __init__(self, fetch: Fetch):
        self._fetch = fetch
        self._bases: dict[str, str] = {}

    def get(self, path: str) -> tuple[int, Any]:
        """(HTTP status, parsed body); status 0 when curl itself failed."""
        p = self._fetch(path)
        if p.returncode != 0:
            return 0, p.stdout[:300]
        body, _, code = p.stdout.rpartition("\n")
        try:
            return int(code), json.loads(body) if body.strip() else None
        except ValueError:
            return int(code) if code.isdigit() else 0, body[:300]

    def base(self, warehouse: str) -> tuple[str | None, str]:
        """The path under which the catalog serves `warehouse` (/v1/<prefix>), from its
        config; (None, why) when it does not answer for the warehouse."""
        if warehouse in self._bases:
            return self._bases[warehouse], ""
        code, cfg = self.get(f"/v1/config?warehouse={urllib.parse.quote(warehouse, safe='')}")
        if code != 200 or not isinstance(cfg, dict):
            return None, f"catalog config for warehouse {warehouse}: HTTP {code} {str(cfg)[:200]}"
        prefix = (cfg.get("overrides") or {}).get("prefix") or (cfg.get("defaults") or {}).get("prefix")
        self._bases[warehouse] = f"/v1/{prefix}" if prefix else "/v1"
        return self._bases[warehouse], ""

    def load_table(self, warehouse: str, namespace: str, table: str) -> "TableState":
        where = f"{warehouse}.{namespace}.{table}"
        base, why = self.base(warehouse)
        if base is None:
            return TableState(where, exists=False, error=why)
        name = urllib.parse.quote(table, safe="")
        code, body = self.get(f"{base}/namespaces/{namespace}/tables/{name}")
        return _table_state(where, code, body)

    def list_tables(self, warehouse: str, namespace: str) -> tuple[list[str] | None, str]:
        """The names of every table of a namespace ([] when there is no such namespace);
        (None, why) when the catalog cannot be asked."""
        base, why = self.base(warehouse)
        if base is None:
            return None, why
        names: list[str] = []
        token = None
        for _ in range(MAX_LIST_PAGES):
            query = f"?pageToken={urllib.parse.quote(str(token), safe='')}" if token else ""
            code, body = self.get(f"{base}/namespaces/{namespace}/tables{query}")
            if code == 404:
                return [], ""
            if code != 200 or not isinstance(body, dict):
                return None, f"{warehouse}.{namespace}: HTTP {code} {str(body)[:200]}"
            names += [str(i.get("name")) for i in body.get("identifiers") or []]
            token = body.get("next-page-token")
            if not token:
                return names, ""
        return None, f"{warehouse}.{namespace}: more than {MAX_LIST_PAGES} pages of tables"


@dataclass
class TableState:
    """What the catalog says about one table. A table that is not there has `exists`
    False and no `error`; one the catalog could not be asked about has an `error`."""

    where: str
    exists: bool
    error: str = ""
    properties: dict[str, str] = field(default_factory=dict)
    snapshots: int = 0
    #: totals of the current snapshot; None when its summary does not carry one
    data_files: int | None = 0
    records: int | None = 0
    size_bytes: int | None = 0

    def describe(self) -> str:
        if self.error:
            return f"{self.where}: {self.error}"
        if not self.exists:
            return f"{self.where}: no such table"
        return (f"{self.where}: {self.records} row(s), {self.data_files} data file(s), "
                f"{self.snapshots} snapshot(s)")


def _total(summary: dict, key: str) -> int | None:
    value = str(summary.get(key, ""))
    return int(value) if value.isdigit() else None


def _table_state(where: str, code: int, body: Any) -> TableState:
    """A table from the catalog's answer to a load (the Iceberg REST LoadTableResult)."""
    if code == 404:
        return TableState(where, exists=False)
    if code != 200 or not isinstance(body, dict):
        message = (body.get("error") or {}).get("message") if isinstance(body, dict) else body
        return TableState(where, exists=False, error=f"HTTP {code} {str(message)[:200]}")
    meta = body.get("metadata") or {}
    state = TableState(where, exists=True, properties=dict(meta.get("properties") or {}),
                       snapshots=len(meta.get("snapshots") or []))
    current = meta.get("current-snapshot-id")
    if current in (None, -1):  # nothing was ever committed: no file, no row
        return state
    summary = next((s.get("summary") or {} for s in meta.get("snapshots") or []
                    if s.get("snapshot-id") == current), {})
    state.data_files = _total(summary, "total-data-files")
    state.records = _total(summary, "total-records")
    state.size_bytes = _total(summary, "total-files-size")
    return state


def _number(properties: dict[str, str], key: str) -> int | None:
    value = str(properties.get(key, "")).strip()
    return int(value) if value.lstrip("-").isdigit() else None


@dataclass
class Label:
    """The newest state of an execution, as its log table's properties repeat it."""

    state: str | None
    state_seq: int | None
    state_time_ms: int | None
    reason: str
    beat_ms: int | None
    beat_every_ms: int | None

    @classmethod
    def of(cls, table: TableState) -> "Label":
        p = table.properties
        return cls(state=p.get(LABEL_STATE) or None, state_seq=_number(p, LABEL_STATE_SEQ),
                   state_time_ms=_number(p, LABEL_STATE_TIME_MS), reason=p.get(LABEL_REASON) or "",
                   beat_ms=_number(p, LABEL_BEAT_MS), beat_every_ms=_number(p, LABEL_BEAT_EVERY_MS))


class Lake:
    """The tables of executions, by workflow and execution id."""

    def __init__(self, catalog: Catalog, default_warehouse: str = DEFAULT_WAREHOUSE,
                 env: dict[str, str] | None = None):
        self.catalog = catalog
        self.default_warehouse = default_warehouse
        env = env or {}
        self.namespaces = {kind: env.get(setting) or default
                           for kind, (setting, default, *_) in {**EXECUTION_TABLES, **PORT_TABLES}.items()}

    @staticmethod
    def result_table_name(uri: str) -> str:
        """The name of the table at a result's location, as the product names it: the path
        below the warehouse, its slashes made underscores (DocumentFactory.sanitizeURIPath)."""
        path = urllib.parse.unquote(urllib.parse.urlparse(uri).path).removeprefix("/")
        if path.startswith("wh/"):
            path = path.split("/", 2)[2]
        return path.replace("/", "_")

    @staticmethod
    def table_name(wid: int, eid: int, kind: str) -> str:
        return f"wid_{wid}_eid_{eid}_{EXECUTION_TABLES[kind][2]}"

    def table(self, warehouse: str | None, wid: int, eid: int, kind: str) -> TableState:
        """One of an execution's own tables: `log`, `statistics` or `console`."""
        return self.catalog.load_table(warehouse or self.default_warehouse, self.namespaces[kind],
                                       self.table_name(wid, eid, kind))

    def port_tables(self, warehouse: str | None, wid: int, eid: int, kind: str) -> tuple[list[str] | None, str]:
        """The `result` or `state` tables of an execution's stored ports, found by name
        (as the product's own expiry finds them without a log, design 4.4); (None, why)
        when the namespace cannot be listed."""
        names, why = self.catalog.list_tables(warehouse or self.default_warehouse, self.namespaces[kind])
        if names is None:
            return None, why
        # the underscore after the id keeps execution 3 apart from 34
        return sorted(n for n in names if n.startswith(f"wid_{wid}_eid_{eid}_")), ""
