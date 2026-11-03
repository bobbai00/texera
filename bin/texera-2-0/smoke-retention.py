#!/usr/bin/env python3
"""Every execution keeps its results.

Runs one workflow twice (v1, then an edited v2) and reads the first execution's results again:
right after the second run, and again after the unit's idle release has fired (30 s after a run
ends, by default). Also checks that each result is stored under its own engine execution id,
derived from the catalog's execution id, so runs on different units, or on one unit across a
restart, can never overwrite each other's tables.

Usage: smoke-retention.py [--idle-seconds 40]
Needs the dev stack, the catalog and the unit.
"""
import argparse
import importlib.util
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def engine_id(catalog_eid: str) -> int:
    """The unit's EngineIds.of: both UUID halves mixed, as a positive 63-bit number."""
    value = uuid.UUID(catalog_eid).int
    bits = ((value >> 64) ^ (value & ((1 << 64) - 1))) & ((1 << 63) - 1)
    return bits or 1


def rows(tok: str, eid: str) -> list:
    return c.api(tok, "GET", f"/catalog/v1/executions/{eid}/results/avg/output-0?limit=10")["rows"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--idle-seconds", type=int, default=40)
    args = parser.parse_args()

    tok = c.token("alice", "alice")
    c.ensure_iris(tok)
    ds = next(d for d in c.api(tok, "GET", "/catalog/v1/datasets?q=iris")["items"] if d["metadata"]["name"] == "iris")
    dsrid, dsv = ds["metadata"]["rid"], ds["metadata"]["headVersion"]
    content = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan",
             "operatorProperties": {"fileName": f"dataset://{dsrid}@{dsv}/iris.csv", "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": True,
             "operatorProperties": {"groupByKeys": ["Species"],
                                    "aggregations": [{"aggFunction": "average", "attribute": "PetalLengthCm", "result attribute": "avg"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/catalog/v1/workflows/with-content", {"name": f"retention {time.strftime('%H%M%S')}", "content": content})
    rid = wf["workflow"]["metadata"]["rid"]

    first = c.api(tok, "POST", f"/catalog/v1/workflows/{rid}/executions", {"waitSeconds": 180, "name": "petal length"})
    first_rows = rows(tok, first["eid"])
    print(f"v1 run {first['eid'][:8]}: {first['status']}, {first_rows}")

    c.api(tok, "POST", f"/catalog/v1/workflows/{rid}/edit", {
        "patch": [{"op": "replace", "path": "/operators/1/operatorProperties/aggregations/0/attribute", "value": "SepalLengthCm"}],
        "expectedHead": 1, "message": "sepal instead of petal"})
    second = c.api(tok, "POST", f"/catalog/v1/workflows/{rid}/executions", {"waitSeconds": 180, "name": "sepal length"})
    second_rows = rows(tok, second["eid"])
    print(f"v2 run {second['eid'][:8]}: {second['status']}, {second_rows}")

    ok = first["status"] == "completed" and second["status"] == "completed" and first_rows and first_rows != second_rows
    after_second = rows(tok, first["eid"])
    print(f"v1 results after the v2 run: {'same' if after_second == first_rows else after_second}")
    ok &= after_second == first_rows

    for run in (first, second):
        tables = [r.get("table") or "" for r in run["results"]]
        expected = f"/eid/{engine_id(run['eid'])}/"
        own = bool(tables) and all(expected in t for t in tables)
        print(f"run {run['eid'][:8]} stored under engine id {engine_id(run['eid'])}: {own}")
        ok &= own

    print(f"waiting {args.idle_seconds}s for the unit's idle release")
    time.sleep(args.idle_seconds)
    late_first, late_second = rows(tok, first["eid"]), rows(tok, second["eid"])
    print(f"after the idle release: v1 {'same' if late_first == first_rows else late_first}, "
          f"v2 {'same' if late_second == second_rows else late_second}")
    ok &= late_first == first_rows and late_second == second_rows

    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
