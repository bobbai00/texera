#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Checks the team's project on a stack against the folder load.py put there, and runs what it
holds. No model is asked anything.

    python verify.py --data ~/texera-diabetes --gw http://localhost:28088
    python verify.py --data ~/texera-diabetes --gw https://texera.example.edu --against http://localhost:28088

What it checks: what load.py puts in the project is all there; every file of every dataset and
model reads back as the bytes in the folder; every workflow executes on the project's unit and
keeps rows; a unit made from the Small profile starts, runs a workflow to the same rows and ends;
each teammate reads the project; an execution's lineage names the data and the model it read; the
project wears the folder's brand. With --against, the same workflows are executed on that stack
too and their rows compared: the same project gives the same answers wherever it runs.

What it made is removed again: its executions and the unit. Only the standard library is used.
"""

import argparse
import concurrent.futures
import hashlib
import json
import math
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import load

# How long an execution or a unit may take before it counts as failed.
EXECUTION_SECONDS = 900
UNIT_SECONDS = 600
PAGE = 1000


class Report:
    """What was checked, as it is checked."""

    def __init__(self) -> None:
        self.checks, self.failed = 0, []

    def check(self, ok: bool, what: str, detail: str = "") -> bool:
        self.checks += 1
        if ok:
            print(f"   ok    {what}")
        else:
            self.failed.append(what)
            print(f"   FAIL  {what}{': ' + detail if detail else ''}")
        return ok


def read(person: load.Person, path: str) -> tuple[int, bytes]:
    """The whole of what a path holds, whatever it is. The catalog bounds each answer, so a large
    file comes as parts (206), asked for one after the other until the size it names is there."""
    whole = b""
    while True:
        headers = {"Authorization": f"Bearer {person.token}"}
        if whole:
            headers["Range"] = f"bytes={len(whole)}-"
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{person.gw}/catalog/v1{path}", headers=headers), timeout=600) as r:
                status, part, span = r.status, r.read(), r.headers.get("Content-Range", "")
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        whole += part
        size = span.rsplit("/", 1)[-1]
        if status != 206 or not part or not size.isdigit() or len(whole) >= int(size):
            return 200 if status == 206 else status, whole


def project_of(person: load.Person, name: str) -> dict | None:
    status, projects = person.call("GET", "/projects?limit=500")
    if status != 200:
        return None
    return next((p for p in projects["items"] if p["metadata"]["name"] == name), None)


def loaded(person: load.Person, project: str) -> dict[str, dict[str, dict]]:
    """What load.py put in the project: by kind, by name."""
    status, found = person.call("GET", f"/resources?project={project}&limit=500")
    out: dict[str, dict[str, dict]] = {}
    for item in found["items"] if status == 200 else []:
        if load.LOADED in (item["metadata"].get("labels") or {}):
            out.setdefault(item["kind"], {})[item["metadata"]["name"]] = item
    return out


def cards(folder: pathlib.Path) -> dict[str, pathlib.Path]:
    """Each resource's folder, by the name its card gives it."""
    return {json.loads((f / "card.json").read_text())["name"]: f for f in load.folders(folder) if (f / "card.json").exists()}


def files_of(folder: pathlib.Path) -> dict[str, pathlib.Path]:
    return {p.name: p for p in sorted(folder.iterdir()) if p.is_file() and p.name != "card.json" and not p.name.startswith(".")}


def holdings(report: Report, data: pathlib.Path, has: dict[str, dict[str, dict]]) -> None:
    for kind, sub in (("dataset", "datasets"), ("model", "models")):
        want, got = set(cards(data / sub)), set(has.get(kind, {}))
        report.check(want == got, f"{len(want)} {sub}, by name", f"missing {sorted(want - got)}, not the folder's {sorted(got - want)}")
    want = {load.OPERATOR_NAMES.get(p.stem, p.stem) for p in (load.HERE / "operators").glob("*.py")}
    got = set(has.get("operator", {}))
    report.check(want == got, f"{len(want)} operators, by name", f"missing {sorted(want - got)}, not the team's {sorted(got - want)}")
    report.check(len(has.get("workflow", {})) > 0, f"{len(has.get('workflow', {}))} workflows")
    if load.brand_of(data):
        report.check(len(has.get("agent-template", {})) == 1, "the brand's agent", str(sorted(has.get("agent-template", {}))))


def file_bytes(report: Report, person: load.Person, data: pathlib.Path, has: dict[str, dict[str, dict]], kinds=(("dataset", "datasets"), ("model", "models"))) -> None:
    for kind, sub in kinds:
        same, total, wrong = 0, 0, []
        for name, folder in cards(data / sub).items():
            item = has.get(kind, {}).get(name)
            if not item:
                continue
            rid, head = item["metadata"]["rid"], item["metadata"]["head"]
            status, listing = person.call("GET", f"/{sub}/{rid}/versions/{head}/files")
            listed = {f["path"]: f.get("size") for f in (listing.get("files") or [])} if status == 200 else {}
            local = files_of(folder)
            if listed != {n: p.stat().st_size for n, p in local.items()}:
                wrong.append(f"{name}: lists {sorted(listed)}")
            for file, path in local.items():
                total += 1
                status, body = read(person, f"/{sub}/{rid}/versions/{head}/files/{urllib.parse.quote(file)}")
                if status == 200 and hashlib.sha256(body).digest() == hashlib.sha256(path.read_bytes()).digest():
                    same += 1
                else:
                    wrong.append(f"{name}/{file}: {status}, {len(body)} bytes")
        report.check(not wrong, f"{same} of {total} files of the {sub} read back as the folder's bytes", "; ".join(wrong[:4]))


def execute(person: load.Person, rid: str, **where) -> tuple[dict | None, str]:
    """Runs a workflow to its end; the execution and its last phase, or why it was refused."""
    status, made = person.call("POST", f"/workflows/{rid}/run", {"waitSeconds": 300, "name": "verify", **where})
    if status // 100 != 2:
        return None, f"refused, {status}: {str(made)[:300]}"
    deadline = time.time() + EXECUTION_SECONDS
    while made["status"]["phase"] in ("pending", "queued", "running") and time.time() < deadline:
        time.sleep(5)
        status, again = person.call("GET", f"/workflows/{rid}/executions/{made['metadata']['rid']}")
        if status == 200:
            made = again
    return made, made["status"]["phase"]


def last_step(spec: dict) -> str:
    """The operator a workflow ends at: the one nothing reads from. Its result is the workflow's."""
    read_from = {link["source"]["operatorID"] for link in spec.get("links") or []}
    return [o["operatorID"] for o in spec["operators"] if o["operatorID"] not in read_from][-1]


def kept_rows(person: load.Person, workflow: dict, eid: str) -> tuple[list[str], list[list]] | None:
    """Every row of the workflow's result in an execution, with the columns' names. An execution
    keeps what every step gave; the result is its last step's, whatever that step is called."""
    rid, operator = workflow["metadata"]["rid"], last_step(workflow["spec"])
    names, rows, offset = [], [], 0
    while True:
        status, page = person.call("GET", f"/workflows/{rid}/executions/{eid}/operators/{operator}/ports/output-0/rows?offset={offset}&limit={PAGE}")
        if status != 200 or not isinstance(page, dict) or "rows" not in page:
            return None
        names = [a["attributeName"] for a in page["schema"]]
        rows.extend(page["rows"])
        offset += len(page["rows"])
        if not page["rows"] or offset >= (page.get("total") or 0):
            return names, rows


def in_order(rows: list[list]) -> list[list]:
    """Rows in an order that does not depend on how they were computed: by what is not a
    fraction first, since sums of fractions differ in their last digits from one run to the next."""
    def key(row: list):
        return [("" if v is None else str(v)) for v in row if not isinstance(v, float)], [round(v, 6) for v in row if isinstance(v, float)]
    return sorted(rows, key=key)


def same_rows(a: tuple[list[str], list[list]], b: tuple[list[str], list[list]]) -> str:
    """"" when two results are the same rows, else what differs first."""
    if a[0] != b[0]:
        return f"columns {a[0]} against {b[0]}"
    if len(a[1]) != len(b[1]):
        return f"{len(a[1])} rows against {len(b[1])}"
    for x, y in zip(in_order(a[1]), in_order(b[1])):
        for v, w in zip(x, y):
            close = math.isclose(v, w, rel_tol=1e-9, abs_tol=1e-9) if isinstance(v, float) and isinstance(w, float) else v == w
            if not close:
                return f"{x} against {y}"
    return ""


def execute_all(person: load.Person, workflows: dict[str, dict]) -> dict[str, dict]:
    """Every workflow run on the project's own unit: its phase, its rows, how long it took."""
    out = {}
    for name, item in sorted(workflows.items()):
        rid, started = item["metadata"]["rid"], time.time()
        made, phase = execute(person, rid)
        eid = made["metadata"]["rid"] if made else None
        kept = kept_rows(person, item, eid) if made and phase == "completed" else None
        out[name] = {"rid": rid, "eid": eid, "phase": phase, "rows": kept, "seconds": time.time() - started, "execution": made}
        print(f"      {person.gw.split('//')[1][:28]:28} {name}: {phase}, {len(kept[1]) if kept else 0} rows, {time.time() - started:.0f}s", flush=True)
    return out


def a_unit(report: Report, person: load.Person, project: str, workflow: dict, expected: tuple | None, made: list) -> None:
    """A unit made from the Small profile runs a workflow to the same rows, and ends."""
    status, profiles = person.call("GET", f"/profiles?scope={project}&limit=100")
    small = next((p for p in profiles["items"] if p["metadata"]["name"] == "Small"), None) if status == 200 else None
    if not report.check(small is not None, "the Small profile is offered to the project"):
        return
    status, unit = person.call("POST", "/computing-units/from-profile", {"parent": project, "profile": small["metadata"]["uri"]})
    if not report.check(status // 100 == 2, "a unit is made from the Small profile", str(unit)[:300]):
        return
    rid, uri = unit["metadata"]["rid"], unit["metadata"]["uri"]
    report.check(unit["metadata"]["name"] == "Small unit", "it is called after its size", unit["metadata"]["name"])
    started, phase = time.time(), None
    while time.time() - started < UNIT_SECONDS:
        status, now = person.call("GET", f"/computing-units/{rid}")
        phase = now["status"]["phase"] if status == 200 else None
        if phase == "ready":
            break
        time.sleep(5)
    report.check(phase == "ready", f"the unit is ready ({time.time() - started:.0f}s)", str(phase))
    if phase == "ready":
        ran, last = execute(person, workflow["metadata"]["rid"], computingUnit=uri)
        if ran:
            made.append((person, workflow["metadata"]["rid"], ran["metadata"]["rid"]))
        kept = kept_rows(person, workflow, ran["metadata"]["rid"]) if ran and last == "completed" else None
        report.check(last == "completed" and kept is not None, f"{workflow['metadata']['name']} executes on it", last)
        if kept and expected:
            report.check(same_rows(kept, expected) == "", "with the rows the project's unit gave", same_rows(kept, expected))
    status, ended = person.call("POST", f"/computing-units/{rid}/terminate", {})
    report.check(status // 100 == 2 and ended["status"]["phase"] == "terminated", "the unit ends when told to", str(ended)[:200])
    status, _ = person.call("DELETE", f"/resources/{rid}")
    report.check(status // 100 == 2, "and goes", str(status))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=pathlib.Path, required=True, help="the folder prepare.py wrote and load.py loaded")
    ap.add_argument("--gw", default="http://localhost:8088", help="the gateway of the stack to check")
    ap.add_argument("--against", default="", help="the gateway of another stack with the same project: its rows are compared")
    ap.add_argument("--owner", default="alice", help="whose project it is (passwords: the dev stack's, or TEXERA_PASSWORDS)")
    ap.add_argument("--team", default="bob", help="who else edits it, names separated by commas; empty for nobody")
    ap.add_argument("--project", default=load.PROJECT, help="the project's name")
    ap.add_argument("--no-unit", action="store_true", help="do not make a unit from a profile")
    args = ap.parse_args()
    gw, report, made = args.gw.rstrip("/"), Report(), []
    owner = load.Person(gw, args.owner)

    print(f"== the project on {gw}")
    found = project_of(owner, args.project)
    if not report.check(found is not None, f"{args.owner} has {args.project}"):
        sys.exit(1)
    project = found["metadata"]["rid"]
    has = loaded(owner, project)
    holdings(report, args.data, has)
    brand = load.brand_of(args.data)
    if brand:
        status, settings = owner.call("GET", f"/projects/{project}")
        wears = ((settings.get("spec") or {}).get("branding") or {}).get("name") if status == 200 else None
        report.check(wears == brand["name"], f"the project wears {brand['name']}", str(wears))

    print("== files")
    file_bytes(report, owner, args.data, has)

    print("== the team")
    for name in filter(None, args.team.split(",")):
        mate = load.Person(gw, name)
        theirs = loaded(mate, project)
        report.check({k: set(v) for k, v in theirs.items()} == {k: set(v) for k, v in has.items()}, f"{name} sees what {args.owner} sees")
        first = next(iter(cards(args.data / "datasets").items()), None)
        if first and first[0] in has.get("dataset", {}):
            item, (file, path) = has["dataset"][first[0]], next(iter(files_of(first[1]).items()))
            status, body = read(mate, f"/datasets/{item['metadata']['rid']}/versions/{item['metadata']['head']}/files/{urllib.parse.quote(file)}")
            report.check(status == 200 and body == path.read_bytes(), f"and reads {first[0]}", str(status))

    print("== executions")
    workflows = has.get("workflow", {})
    stacks = {gw: owner}
    if args.against:
        other = load.Person(args.against.rstrip("/"), args.owner)
        theirs = project_of(other, args.project)
        if report.check(theirs is not None, f"{args.project} is on {args.against} too"):
            stacks[args.against.rstrip("/")] = other
            there = loaded(other, theirs["metadata"]["rid"])
            report.check({k: set(v) for k, v in there.items()} == {k: set(v) for k, v in has.items()}, "both stacks hold the same things, by kind and name")
    with concurrent.futures.ThreadPoolExecutor(len(stacks)) as pool:
        jobs = {
            at: pool.submit(execute_all, person, workflows if at == gw else loaded(person, project_of(person, args.project)["metadata"]["rid"]).get("workflow", {}))
            for at, person in stacks.items()
        }
        ran = {at: job.result() for at, job in jobs.items()}
    for at, results in ran.items():
        made.extend((stacks[at], r["rid"], r["eid"]) for r in results.values() if r["eid"])
    here = ran[gw]
    done = [n for n, r in here.items() if r["phase"] == "completed" and r["rows"] and r["rows"][1]]
    report.check(len(done) == len(workflows), f"{len(done)} of {len(workflows)} workflows execute and keep rows", "; ".join(f"{n}: {r['phase']}" for n, r in here.items() if n not in done)[:600])
    if args.against and args.against.rstrip("/") in ran:
        there, differ = ran[args.against.rstrip("/")], []
        for name in done:
            other = there.get(name)
            if not other or not other["rows"]:
                differ.append(f"{name}: {other['phase'] if other else 'not there'} on the other stack")
            elif same_rows(here[name]["rows"], other["rows"]):
                differ.append(f"{name}: {same_rows(here[name]['rows'], other['rows'])}")
        report.check(not differ, f"{len(done) - len(differ)} of {len(done)} give the same rows on both stacks", "; ".join(differ)[:900])

    print("== lineage")
    through = next((n for n in sorted(done) if any(o["operatorType"] == "predict" for o in workflows[n]["spec"]["operators"])), None)
    if through:
        spec, eid = workflows[through]["spec"], here[through]["eid"]
        reads = load.rid_of(spec["operators"][0]["operatorProperties"]["file"].split("/files/")[0])
        model = load.rid_of(next(o for o in spec["operators"] if o["operatorType"] == "predict")["operatorProperties"]["model"])
        status, upstream = owner.call("GET", f"/resources/{eid}/lineage?direction=upstream")
        text = json.dumps(upstream) if status == 200 else ""
        report.check(reads in text and model in text, f"the execution of {through} names the dataset and the model it read", f"{status}")

    if not args.no_unit and done:
        print("== a unit from a profile")
        name = min(done, key=lambda n: here[n]["seconds"])
        a_unit(report, owner, project, workflows[name], here[name]["rows"], made)

    print("== what this made goes")
    gone = 0
    for person, rid, eid in made:
        status, _ = person.call("DELETE", f"/workflows/{rid}/executions/{eid}")
        gone += status // 100 == 2
    report.check(gone == len(made), f"{gone} of {len(made)} executions removed")

    print(f"\n{report.checks} checks, {len(report.failed)} failed" + ("".join(f"\n  {f}" for f in report.failed)))
    sys.exit(1 if report.failed else 0)


if __name__ == "__main__":
    main()
