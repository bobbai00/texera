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


UDF_RANK = '''from pytexera import *
import humanize


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["rank"] = humanize.ordinal(int(tuple_["Id"]))
        yield tuple_
'''

UDF_AUTHED = '''from pytexera import *


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["auth"] = PROPS["apiKey"][-4:]
        tuple_["label"] = PROPS.get("label", "")
        yield tuple_
'''


def run(api: Api, rid: str, name: str = "run", wait: int = 240, **more) -> dict:
    """Starts a run and waits for it; returns the execution envelope."""
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
    """Whether a failed run says a Python module is missing: by name, or as a bare
    ModuleNotFoundError where the unit's Python cannot carry the name."""
    err = error_text(execution)
    return module in err or "ModuleNotFoundError" in err
