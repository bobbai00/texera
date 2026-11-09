"""Workflows the scenarios build over the iris file, and how they run them."""
from __future__ import annotations

from .client import Api


def scan(file_uri: str) -> dict:
    return {"operatorID": "scan", "operatorType": "CSVFileScan",
            "operatorProperties": {"fileName": file_uri, "fileEncoding": "UTF_8", "hasHeader": True}}


def link(src: str, dst: str, lid: str = "l1") -> dict:
    return {"linkID": lid, "source": {"operatorID": src, "portID": "output-0"}, "target": {"operatorID": dst, "portID": "input-0"}}


def average_by_species(file_uri: str, attribute: str = "PetalLengthCm", result: str = "avg") -> dict:
    """Scan the iris file and average one measure per species; the result port is `avg`."""
    agg = {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
           "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": attribute, "result attribute": result}]}}
    return {"operators": [scan(file_uri), agg], "links": [link("scan", "avg")]}


def with_operator(file_uri: str, operator_type: str, properties: dict | None = None, opid: str = "op") -> dict:
    """Scan the iris file into one operator (built-in type or a custom operator's URI)."""
    op = {"operatorID": opid, "operatorType": operator_type, "operatorProperties": properties or {}, "viewResult": True}
    return {"operators": [scan(file_uri), op], "links": [link("scan", opid)]}


# Each iris row's Id as an ordinal, by humanize: a package the public unit lacks.
RANK = '''import humanize
import pandas as pd


@returns(Id=int, rank=str)
def humanize_rank(rows: pd.DataFrame) -> pd.DataFrame:
    """Each row's Id as an ordinal, by humanize."""
    return pd.DataFrame({"Id": rows["Id"], "rank": [humanize.ordinal(int(n)) for n in rows["Id"]]})
'''

# The same rank without a package the platform lacks.
ORDINAL = '''import pandas as pd


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


@returns(Id=int, rank=str)
def ordinal_rank(rows: pd.DataFrame) -> pd.DataFrame:
    """Each row's Id as an ordinal: 1st, 2nd, 3rd."""
    return pd.DataFrame({"Id": rows["Id"], "rank": [_ordinal(int(n)) for n in rows["Id"]]})
'''

# Each row with the end of the secret it gets as its Credential setting, and a label.
AUTHED = '''import pandas as pd


@returns(Id=int, auth=str, label=str)
def authed_tag(rows: pd.DataFrame, *, apiKey: Credential, label: str = "") -> pd.DataFrame:
    """Each row with the end of the key it was given, and a label."""
    return pd.DataFrame({"Id": rows["Id"], "auth": apiKey[-4:], "label": label})
'''


def function_operator(api: Api, project: str, name: str, code: str, description: str | None = None) -> dict:
    """Saves code whose one function under @returns is an operator of the project."""
    more = {"description": description} if description else {}
    return api.create("operators", name, {"implementation": {"python": {"code": code}}}, project=project, **more)


def at_head(operator: dict) -> str:
    """The operator's URI at its newest version, as a workflow names it."""
    return f"{operator['metadata']['uri']}@{operator['metadata']['head']}"


def run(api: Api, rid: str, name: str = "run", wait: int = 240, **more) -> dict:
    """Starts an execution and waits for it; returns the execution envelope."""
    return api.post(f"/workflows/{rid}/run", {"waitSeconds": wait, "name": name, **more})


def rows(api: Api, rid: str, eid: str, opid: str = "avg", limit: int = 10) -> dict:
    """A page of a port's rows: {schema, rows, total}."""
    return api.get(f"/workflows/{rid}/executions/{eid}/operators/{opid}/ports/output-0/rows?limit={limit}")


def row_values(page: dict) -> list:
    return page["rows"]


def column(page: dict, name: str) -> int:
    return [a["attributeName"] for a in page["schema"]].index(name)


def error_text(execution: dict) -> str:
    st = execution["status"]
    return str(st.get("error") or st.get("operators") or "")


def missing_module(execution: dict, module: str) -> bool:
    """Whether a failed execution says a Python module is missing: by name, or as a bare
    ModuleNotFoundError where the unit's Python cannot carry the name."""
    err = error_text(execution)
    return module in err or "ModuleNotFoundError" in err
