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

"""Puts a diabetes research team's project into a Texera stack: the datasets and models that
prepare.py wrote, and the team's Python operators in operators/, in a project of the owner's
that the team member may edit.

    python load.py --data ~/texera-diabetes                         # http://localhost:8088, alice's, bob on the team
    python load.py --data ~/texera-diabetes --gw http://localhost:28088

What is already there by name is left as it is, so a second run adds only what is missing.
Only the standard library is used.
"""

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent

PROJECT = "Diabetes research"
PROJECT_DESCRIPTION = (
    "The diabetes team's data, models and tools: a cohort followed for diabetes onset, hospital "
    "encounters with readmission, disease progression after a year, and a week of CGM of "
    "adolescents with type 1 diabetes."
)
# The operators' names as people say them, by the function each is.
OPERATOR_NAMES = {
    "cgm_metrics": "CGM metrics",
    "roc_auc": "ROC AUC",
    "calibration": "Risk calibration",
    "odds_ratio": "Odds ratio",
}


def token(gw: str, user: str, password: str) -> str:
    data = urllib.parse.urlencode(
        {
            "grant_type": "password",
            "client_id": "texera-app",
            "username": user,
            "password": password,
        }
    ).encode()
    with urllib.request.urlopen(
        f"{gw}/auth/realms/texera/protocol/openid-connect/token", data, timeout=60
    ) as r:
        return json.load(r)["access_token"]


class Person:
    """One caller of the catalog API through the gateway."""

    def __init__(self, gw: str, user: str):
        self.gw, self.user, self.token = gw, user, token(gw, user, user)

    def call(
        self,
        method: str,
        path: str,
        body=None,
        *,
        raw: bytes | None = None,
        content_type: str = "application/json",
    ):
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": content_type,
        }
        data = (
            raw
            if raw is not None
            else (None if body is None else json.dumps(body).encode())
        )
        req = urllib.request.Request(
            f"{self.gw}/catalog/v1{path}", method=method, headers=headers, data=data
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                out = r.read()
                return r.status, (json.loads(out) if out[:1] in (b"{", b"[") else out)
        except urllib.error.HTTPError as e:
            out = e.read()
            return e.code, (
                json.loads(out) if out[:1] == b"{" else out.decode(errors="replace")
            )

    def must(self, method: str, path: str, body=None, **kw):
        status, out = self.call(method, path, body, **kw)
        if status // 100 != 2:
            sys.exit(f"{method} {path} -> {status}: {str(out)[:600]}")
        return out


def named(person: Person, plural: str, project: str, name: str):
    """The resource of a kind named so in the project, if there is one."""
    query = urllib.parse.urlencode({"project": project, "limit": 500})
    for item in person.must("GET", f"/{plural}?{query}")["items"]:
        if item["metadata"]["name"] == name:
            return item
    return None


def upload(
    person: Person, plural: str, rid: str, folder: pathlib.Path, skip=("card.json",)
) -> None:
    for path in sorted(folder.iterdir()):
        if path.is_file() and path.name not in skip:
            kind = "text/csv" if path.suffix == ".csv" else "application/octet-stream"
            person.must(
                "PUT",
                f"/{plural}/{rid}/files/{path.name}",
                raw=path.read_bytes(),
                content_type=kind,
            )


def dataset(person: Person, project: str, folder: pathlib.Path) -> str:
    card = json.loads((folder / "card.json").read_text())
    found = named(person, "datasets", project, card["name"])
    if found and found["metadata"]["head"] > 0:
        print(f"   dataset {card['name']}: there, version {found['metadata']['head']}")
        return found["metadata"]["uri"]
    made = found or person.must(
        "POST",
        "/datasets",
        {
            "name": card["name"],
            "description": card["description"],
            "parent": project,
            "spec": {"format": "csv"},
        },
    )
    upload(person, "datasets", made["metadata"]["rid"], folder)
    version = person.must(
        "POST",
        f"/datasets/{made['metadata']['rid']}/commit",
        {"message": card["message"]},
    )
    print(
        f"   dataset {card['name']}: version {version['vno']}, {len(version['content']['files'])} files"
    )
    return made["metadata"]["uri"]


def model(person: Person, project: str, folder: pathlib.Path) -> str:
    card = json.loads((folder / "card.json").read_text())
    found = named(person, "models", project, card["name"])
    if found and found["metadata"]["head"] > 0:
        print(f"   model {card['name']}: there, version {found['metadata']['head']}")
        return found["metadata"]["uri"]
    made = found or person.must(
        "POST",
        "/models",
        {
            "name": card["name"],
            "description": card["description"],
            "parent": project,
            "spec": card["spec"],
        },
    )
    upload(person, "models", made["metadata"]["rid"], folder)
    version = person.must(
        "POST",
        f"/models/{made['metadata']['rid']}/commit",
        {"message": card["message"], "contract": card["contract"]},
    )
    print(f"   model {card['name']}: version {version['vno']}, {card['metrics']}")
    return made["metadata"]["uri"]


def operator(person: Person, project: str, path: pathlib.Path) -> str:
    function = path.stem
    name = OPERATOR_NAMES.get(function, function)
    code = path.read_text()
    found = named(person, "operators", project, name)
    if found:
        python = (found["spec"].get("implementation") or {}).get("python") or {}
        if python.get("code") == code:
            print(f"   operator {name}: there, version {found['metadata']['head']}")
            return found["metadata"]["uri"]
        spec = {
            **found["spec"],
            "implementation": {"python": {"code": code, "function": function}},
        }
        updated = person.must(
            "PUT",
            f"/operators/{found['metadata']['rid']}",
            {"spec": spec, "message": "the code in operators/"},
        )
        print(f"   operator {name}: version {updated['metadata']['head']}")
        return found["metadata"]["uri"]
    made = person.must(
        "POST",
        "/operators",
        {
            "name": name,
            "parent": project,
            "spec": {
                "group": "Diabetes",
                "implementation": {"python": {"code": code, "function": function}},
            },
        },
    )
    inputs = len(made["spec"].get("inputPorts") or [])
    settings = sorted(made["spec"]["propertiesSchema"]["properties"])
    print(
        f"   operator {name}: {made['spec']['operatorType']}, {inputs} input, settings {', '.join(settings)}"
    )
    return made["metadata"]["uri"]


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--data", type=pathlib.Path, required=True, help="the folder prepare.py wrote"
    )
    ap.add_argument("--gw", default="http://localhost:8088", help="the gateway")
    ap.add_argument(
        "--owner",
        default="alice",
        help="whose project it is (password = name, as on the dev stack)",
    )
    ap.add_argument("--team", default="bob", help="who else edits it; empty for nobody")
    args = ap.parse_args()
    gw = args.gw.rstrip("/")
    owner = Person(gw, args.owner)

    print(f"== the project, {args.owner}'s")
    found = next(
        (
            p
            for p in owner.must("GET", "/projects?limit=500")["items"]
            if p["metadata"]["name"] == PROJECT
        ),
        None,
    )
    project = (
        found
        or owner.must(
            "POST",
            "/projects",
            {"name": PROJECT, "description": PROJECT_DESCRIPTION, "spec": {}},
        )
    )["metadata"]["rid"]
    print(f"   {PROJECT}: {project}")
    if args.team:
        member = Person(gw, args.team).must("GET", "/me")["principal"]["pid"]
        owner.must(
            "PUT", f"/resources/{project}/grants/{member}", {"relation": "editor"}
        )
        print(f"   {args.team} edits it")

    print("== datasets")
    for folder in sorted((args.data / "datasets").iterdir()):
        dataset(owner, project, folder)
    print("== models")
    for folder in sorted((args.data / "models").iterdir()):
        model(owner, project, folder)
    print("== operators")
    for path in sorted((HERE / "operators").glob("*.py")):
        operator(owner, project, path)
    print(f"\n{gw}/projects/{project}")


if __name__ == "__main__":
    main()
