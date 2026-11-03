#!/usr/bin/env python3
"""Environments end to end: a Python UDF that imports a package the unit's base Python lacks.

Run without an environment, the UDF fails (ModuleNotFoundError). Run with an Environment
resource that lists the package, the unit builds that environment version (a venv layered on
its base Python) and the same workflow version completes. The execution records the
environment version it ran in.

Needs the dev stack, the catalog and the unit.
"""
import importlib.util
import sys
import time

spec = importlib.util.spec_from_file_location("smoke_chat", __file__.rsplit("/", 1)[0] + "/smoke-chat.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

UDF = '''from pytexera import *
import humanize


class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["rank"] = humanize.ordinal(int(tuple_["Id"]))
        yield tuple_
'''


def main() -> int:
    tok = c.token("bob", "bob")
    c.ensure_iris(tok)
    ds = next(d for d in c.api(tok, "GET", "/catalog/v1/datasets?q=iris")["items"] if d["metadata"]["name"] == "iris")
    dsrid, dsv = ds["metadata"]["rid"], ds["metadata"]["headVersion"]

    env = c.api(tok, "POST", "/catalog/v1/environments", {"name": f"py-humanize {time.strftime('%H%M%S')}",
                "spec": {"python": {"packages": ["humanize==4.11.0"]}}})
    erid = env["metadata"]["rid"]
    print(f"environment {erid[:8]} v{env['metadata']['headVersion']}: {env['spec']['python']['packages']}")

    content = {
        "operators": [
            {"operatorID": "scan", "operatorType": "CSVFileScan",
             "operatorProperties": {"fileName": f"dataset://{dsrid}@{dsv}/iris.csv", "fileEncoding": "UTF_8", "hasHeader": True}},
            {"operatorID": "udf", "operatorType": "PythonUDFV2", "viewResult": True,
             "operatorProperties": {"code": UDF, "workers": 1, "retainInputColumns": True, "defaultEnv": True,
                                    "outputColumns": [{"attributeName": "rank", "attributeType": "string"}]}},
        ],
        "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "udf", "portID": "input-0"}}],
    }
    wf = c.api(tok, "POST", "/catalog/v1/workflows/with-content", {"name": "humanize ranks", "content": content})
    wrid = wf["workflow"]["metadata"]["rid"]
    val = c.api(tok, "POST", f"/catalog/v1/workflows/{wrid}/validate", {})
    print(f"workflow {wrid[:8]} v1 validates: {val['ok']} {val['operatorErrors'] or ''}")

    plain = c.api(tok, "POST", f"/catalog/v1/workflows/{wrid}/executions", {"waitSeconds": 240, "name": "no environment"})
    err = str(plain.get("error") or plain.get("operators"))
    print(f"run without the environment: {plain['status']}; mentions humanize: {'humanize' in err}")

    started = time.time()
    with_env = c.api(tok, "POST", f"/catalog/v1/workflows/{wrid}/executions", {"waitSeconds": 600, "environment": erid, "name": "with environment"})
    print(f"run with the environment: {with_env['status']} in {time.time() - started:.0f}s; recorded environment {with_env.get('environment')}")
    ok = val["ok"] and plain["status"] == "failed" and with_env["status"] == "completed"
    ok &= (with_env.get("environment") or {}).get("rid") == erid
    if with_env["status"] == "completed":
        page = c.api(tok, "GET", f"/catalog/v1/executions/{with_env['eid']}/results/udf/output-0?limit=3")
        cols = [a["attributeName"] for a in page["schema"]]
        print(f"columns: {cols}\nfirst rows: {page['rows']}")
        ok &= "rank" in cols and page["rows"][0][cols.index("rank")] == "1st"
    else:
        print(f"error: {str(with_env.get('error'))[:500]}")
    print("\nRESULT:", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
