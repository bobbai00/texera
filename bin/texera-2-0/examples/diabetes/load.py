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

"""Puts a diabetes research team's project into a Texera stack: the datasets and models prepare.py
wrote, the team's Python operators in operators/, workflows they made, a computing unit of the
team's, and the teammate who works in it.

    python load.py --data ~/texera-diabetes                         # http://localhost:8088, alice's, bob on the team
    python load.py --data ~/texera-diabetes --gw http://localhost:28088

What is already there by name is left as it is, so a second run adds only what is missing.

A folder brand/ beside the data gives the project a look of its own: brand.json with a `name` and
a `description`, logo-small.png and logo-large.png. The project then wears them, its description
is that one, and its chats run the platform's agent under the brand's name. --sign-in-page gives
the whole deployment that look as well, the sign-in page included, as its administrator.

Only the standard library is used.
"""

import argparse
import base64
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent

PROJECT = "Diabetes research"
UNIT = "Team unit"
# What this script puts in the project carries this label: the demo's own work does not, which is
# how clean.py tells them apart.
LOADED = "texera.demo"
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

    def __init__(self, gw: str, user: str, password: str | None = None):
        self.gw, self.user, self.token = gw, user, token(gw, user, password or user)

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


def folders(parent: pathlib.Path) -> list[pathlib.Path]:
    """The folders under one, in order, and nothing a file browser leaves there."""
    return sorted(p for p in parent.iterdir() if p.is_dir() and not p.name.startswith("."))


def upload(
    person: Person, plural: str, rid: str, folder: pathlib.Path, skip=("card.json",)
) -> None:
    for path in sorted(folder.iterdir()):
        if path.is_file() and path.name not in skip and not path.name.startswith("."):
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
    """A model version from its folder; its contract.json says what it reads and adds."""
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
    person.must(
        "POST", f"/models/{made['metadata']['rid']}/commit", {"message": card["message"]}
    )
    print(f"   model {card['name']}: {card['metrics']}")
    return made["metadata"]["uri"]


def workflow(person: Person, project: str, name: str, description: str, file: str, step: dict) -> str:
    """A workflow the team already made: a scan of a file, and one step that keeps its result."""
    found = named(person, "workflows", project, name)
    if found:
        print(f"   {name}: there")
        return found["metadata"]["uri"]
    spec = {
        "operators": [
            {
                "operatorID": "readings",
                "operatorType": "scan",
                "operatorProperties": {"file": file},
            },
            {"operatorID": "summary", "viewResult": True, **step},
        ],
        "links": [
            {
                "linkID": "readings-summary",
                "source": {"operatorID": "readings", "portID": "output-0"},
                "target": {"operatorID": "summary", "portID": "input-0"},
            }
        ],
    }
    made = person.must(
        "POST",
        "/workflows",
        {"name": name, "description": description, "parent": project, "spec": spec},
    )
    print(f"   {name}")
    return made["metadata"]["uri"]


def team_workflows(person: Person, project: str, datasets: dict[str, str], metrics: str) -> list[str]:
    """The workflows the team already made, one over each of its main datasets."""
    operator = person.must("GET", f"/operators/{metrics.rsplit('/', 1)[1]}")
    made = [workflow(
        person,
        project,
        "CGM metrics per adolescent",
        "The consensus CGM metrics of each of the seven adolescents with type 1 diabetes.",
        f"{datasets['cgm']}@1/files/cgm.csv",
        {"operatorType": f"{metrics}@{operator['metadata']['head']}", "operatorProperties": {}},
    )]
    summaries = [
        (
            "Onset rate by pregnancies",
            "How often women were diagnosed within five years, by their number of pregnancies.",
            "pima",
            "pima_cohort.csv",
            ["Pregnancies"],
            ["women = count(*)", "onset_rate = avg(Outcome)"],
        ),
        (
            "Readmission by HbA1c result",
            "Hospital encounters by the HbA1c result and whether the patient came back.",
            "hospitals",
            "encounters.csv",
            ["A1Cresult", "readmitted"],
            ["encounters = count(*)"],
        ),
        (
            "Diabetes by age band",
            "The share of US adults with diabetes or prediabetes, by the survey's age band.",
            "health-indicators",
            "health_indicators.csv",
            ["Age"],
            ["people = count(*)", "share_with_diabetes = avg(Diabetes_binary)"],
        ),
        (
            "Diagnosis by gender",
            "How many patients were diagnosed, and how old they were, by gender.",
            "early-stage",
            "early_stage.csv",
            ["diagnosis", "gender"],
            ["patients = count(*)", "mean_age = avg(age)"],
        ),
        (
            "Retinopathy image findings",
            "What the retinal images with signs of retinopathy show, against those without.",
            "retinopathy",
            "retinal_features.csv",
            ["signs_of_retinopathy"],
            ["images = count(*)", "mean_microaneurysms = avg(microaneurysms_1)"],
        ),
    ]
    for name, description, folder, file, by, outputs in summaries:
        made.append(
            workflow(
                person,
                project,
                name,
                description,
                f"{datasets[folder]}@1/files/{file}",
                {"operatorType": "aggregate", "operatorProperties": {"by": by, "outputs": outputs}},
            )
        )
    return made


def mark(person: Person, uris: list[str]) -> None:
    """Labels what this script put in the project, keeping any other labels."""
    for uri in uris:
        rid = uri.split("/")[-1].split("@")[0]
        labels = person.must("GET", f"/resources/{rid}")["metadata"].get("labels") or {}
        if LOADED not in labels:
            person.must("PATCH", f"/resources/{rid}", {"labels": {**labels, LOADED: "team"}})


def data_url(path: pathlib.Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def brand_of(data: pathlib.Path) -> dict | None:
    """The look in the data folder's brand/, if it has one."""
    folder = data / "brand"
    if not (folder / "brand.json").exists():
        return None
    return {
        **json.loads((folder / "brand.json").read_text()),
        "logoUrl": data_url(folder / "logo-small.png"),
        "logoLargeUrl": data_url(folder / "logo-large.png"),
    }


def wear(person: Person, project: str, brand: dict, **defaults) -> None:
    """Gives a project a look, keeping the rest of its settings."""
    spec = person.must("GET", f"/projects/{project}").get("spec") or {}
    spec["branding"] = brand
    if defaults:
        spec["defaults"] = {**(spec.get("defaults") or {}), **defaults}
    person.must("PUT", f"/projects/{project}", {"spec": spec})


def brand_agent(person: Person, project: str, brand_name: str) -> str:
    """The platform's agent, as the project's own under the brand's name."""
    name = f"{brand_name} Agent"
    found = named(person, "agent-templates", project, name)
    if found:
        print(f"   {name}: there")
        return found["metadata"]["uri"]
    query = urllib.parse.urlencode({"scope": project, "limit": 100})
    agents = person.must("GET", f"/agent-templates?{query}")["items"]
    platform = next(a for a in agents if a["metadata"]["name"] == "Texera Agent")
    spec = json.loads(json.dumps(platform["spec"]).replace("Texera Agent", name))
    made = person.must(
        "POST",
        "/agent-templates",
        {"name": name, "description": platform["metadata"].get("description", ""), "parent": project, "spec": spec},
    )
    print(f"   {name}")
    return made["metadata"]["uri"]


def team_unit(person: Person, project: str, name: str, profile_name: str) -> str:
    """A computing unit the team keeps in its project, from one of the profiles it can use."""
    found = named(person, "computing-units", project, name)
    if found:
        print(f"   {name}: there")
        return found["metadata"]["uri"]
    query = urllib.parse.urlencode({"scope": project, "limit": 100})
    profiles = person.must("GET", f"/profiles?{query}")["items"]
    profile = next(p for p in profiles if p["metadata"]["name"] == profile_name)
    made = person.must(
        "POST",
        "/computing-units/from-profile",
        {"name": name, "parent": project, "profile": profile["metadata"]["uri"]},
    )
    print(f"   {name}: from the profile {profile_name}")
    # The team's unit is ready when the demo starts: a unit still starting is not offered.
    for _ in range(60):
        unit = person.must("GET", f"/computing-units/{made['metadata']['rid']}")
        if unit["status"].get("phase") == "ready":
            print(f"   {name}: ready")
            return made["metadata"]["uri"]
        time.sleep(5)
    sys.exit(f"{name} did not become ready in five minutes")


def operator(person: Person, project: str, path: pathlib.Path) -> str:
    function = path.stem
    name = OPERATOR_NAMES.get(function, function)
    code = path.read_text()
    found = named(person, "operators", project, name)
    if found:
        # A list gives an operator's summary; its code is in the operator itself.
        found = person.must("GET", f"/operators/{found['metadata']['rid']}")
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
    ap.add_argument("--project", default=PROJECT, help="the project's name")
    ap.add_argument(
        "--unit-profile",
        default="python-default",
        help="the profile of the team's computing unit",
    )
    ap.add_argument(
        "--sign-in-page",
        action="store_true",
        help="give the whole deployment the brand's look as well, as texera-admin",
    )
    args = ap.parse_args()
    gw = args.gw.rstrip("/")
    owner = Person(gw, args.owner)

    print(f"== the project, {args.owner}'s")
    found = next(
        (
            p
            for p in owner.must("GET", "/projects?limit=500")["items"]
            if p["metadata"]["name"] == args.project
        ),
        None,
    )
    project = (
        found
        or owner.must(
            "POST",
            "/projects",
            {"name": args.project, "description": PROJECT_DESCRIPTION, "spec": {}},
        )
    )["metadata"]["rid"]
    print(f"   {args.project}: {project}")
    if args.team:
        member = Person(gw, args.team).must("GET", "/me")["principal"]["pid"]
        owner.must(
            "PUT", f"/resources/{project}/grants/{member}", {"relation": "editor"}
        )
        print(f"   {args.team} edits it")

    print("== datasets")
    datasets = {
        folder.name: dataset(owner, project, folder)
        for folder in folders(args.data / "datasets")
    }
    print("== models")
    models = [model(owner, project, folder) for folder in folders(args.data / "models")]
    print("== operators")
    operators = {
        path.stem: operator(owner, project, path)
        for path in sorted((HERE / "operators").glob("*.py"))
    }
    print("== workflows")
    workflows = team_workflows(owner, project, datasets, operators["cgm_metrics"])
    print("== the team's computing unit")
    unit = team_unit(owner, project, UNIT, args.unit_profile)
    loaded = [*datasets.values(), *models, *operators.values(), *workflows, unit]
    brand = brand_of(args.data)
    if brand:
        print(f"== the look of {brand['name']}")
        agent = brand_agent(owner, project, brand["name"])
        loaded.append(agent)
        wear(owner, project, brand, agentTemplate=agent)
        owner.must("PATCH", f"/resources/{project}", {"description": brand["description"]})
        if args.sign_in_page:
            wear(Person(gw, "texera-admin", "admin"), owner.must("GET", "/me")["rootProject"], brand)
    mark(owner, loaded)
    print(f"\n{gw}/projects/{project}")


if __name__ == "__main__":
    main()
