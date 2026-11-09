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

"""Leaves a person's space as the demo starts from. It says what would go, and changes nothing
until --apply:

    python clean.py --gw http://localhost:28088                 # what would go
    python clean.py --gw http://localhost:28088 --apply         # alice's space, ready to present
    python clean.py --gw http://localhost:28088 --apply --user bob

For each person:

- the demo's project goes back to what load.py put there, which it labelled: everything else goes
  (chats and the files attached to them, workflows, executions, a dataset someone kept);
- their home project is emptied;
- every other project they own goes whole;
- the project they work in becomes the demo's, so the first page is the project.

Projects of other people are left alone. Run load.py afterwards if the demo's project is not there
yet. Only the standard library is used.
"""

import argparse
import sys
import urllib.parse

from load import LOADED, PROJECT, Person

# Deleted in this order, so nothing goes while something still reads it: a chat's attached files
# go with the chat, once no workflow reads them.
ORDER = ["workflow", "conversation", "dataset", "model", "operator", "computing-unit"]


def holdings(person: Person, project: str) -> list[dict]:
    """What a project holds, apart from itself and its executions."""
    query = urllib.parse.urlencode({"project": project, "limit": 500})
    items = person.must("GET", f"/resources?{query}")["items"]
    return [i for i in items if i["kind"] not in ("project", "execution")]


def in_order(items: list[dict]) -> list[dict]:
    rank = {kind: n for n, kind in enumerate(ORDER)}
    return sorted(items, key=lambda i: rank.get(i["kind"], len(ORDER)))


def is_loaded(resource: dict) -> bool:
    return LOADED in (resource["metadata"].get("labels") or {})


def show(items: list[dict]) -> None:
    for item in in_order(items):
        print(f"     {item['kind']}: {item['metadata']['name']}")
    if not items:
        print("     nothing")


class Cleaner:
    def __init__(self, person: Person):
        self.person, self.failed = person, 0

    def attempt(self, what: str, method: str, path: str, body=None) -> None:
        status, out = self.person.call(method, path, body)
        if status // 100 != 2:
            self.failed += 1
            print(f"     ! {what}: {status} {str(out)[:200]}")

    def executions(self, workflow: dict) -> None:
        """A workflow's executions."""
        rid = workflow["metadata"]["rid"]
        for e in self.person.must("GET", f"/workflows/{rid}/executions?limit=500")["items"]:
            self.attempt(
                f"execution of {workflow['metadata']['name']}",
                "DELETE",
                f"/workflows/{rid}/executions/{e['metadata']['rid']}",
            )

    def remove(self, items: list[dict]) -> None:
        """Units stop first, a workflow's executions go before it, and then each thing, in order."""
        for item in items:
            if item["kind"] == "computing-unit":
                self.attempt(
                    f"stopping {item['metadata']['name']}",
                    "POST",
                    f"/computing-units/{item['metadata']['rid']}/terminate",
                    {},
                )
        for item in in_order(items):
            if item["kind"] == "workflow":
                self.executions(item)
            self.attempt(
                f"{item['kind']} {item['metadata']['name']}",
                "DELETE",
                f"/resources/{item['metadata']['rid']}",
            )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--gw", default="http://localhost:8088", help="the gateway")
    ap.add_argument(
        "--user", action="append", help="whose space; alice unless given, and may be repeated"
    )
    ap.add_argument("--project", default=PROJECT, help="the demo's project")
    ap.add_argument("--apply", action="store_true", help="really do it")
    args = ap.parse_args()
    gw = args.gw.rstrip("/")

    failed = 0
    for user in args.user or ["alice"]:
        person = Person(gw, user)
        me = person.must("GET", "/me")
        pid, home = me["principal"]["pid"], me["homeProject"]
        cleaner = Cleaner(person)
        print(f"== {user}")

        owned = [
            p
            for p in person.must("GET", "/projects?limit=500")["items"]
            if p["metadata"].get("owner") == pid
        ]
        demo = next((p for p in owned if p["metadata"]["name"] == args.project), None)

        if demo:
            rid = demo["metadata"]["rid"]
            held = holdings(person, rid)
            kept = [i for i in held if is_loaded(i)]
            if not kept:
                print(f"   {args.project}: left as it is, for nothing in it is marked as load.py's; run load.py")
            else:
                print(f"   {args.project}: back to what load.py put there")
                going = [i for i in held if not is_loaded(i)]
                show(going)
                if args.apply:
                    cleaner.remove(going)
                    for workflow in kept:
                        if workflow["kind"] == "workflow":
                            cleaner.executions(workflow)
                for unit in kept:
                    if unit["kind"] == "computing-unit":
                        phase = person.must("GET", f"/computing-units/{unit['metadata']['rid']}")["status"].get("phase")
                        print(f"   {unit['metadata']['name']}: {phase}")

        for project in owned:
            rid, name = project["metadata"]["rid"], project["metadata"]["name"]
            if project is demo:
                continue
            held = holdings(person, rid)
            print(f"   {name}: {'emptied' if rid == home else 'goes whole'}")
            show(held)
            if args.apply:
                # What a project's settings name cannot go while they do.
                cleaner.attempt(f"settings of {name}", "PUT", f"/projects/{rid}", {"spec": {}})
                cleaner.remove(held)
                if rid != home:
                    cleaner.attempt(f"project {name}", "DELETE", f"/projects/{rid}")

        if demo:
            print(f"   works in {args.project}")
            if args.apply:
                # A person's last chats are gone with the chats: only the working project stays.
                cleaner.attempt(
                    "the working project",
                    "PUT",
                    "/me/preferences",
                    {"project": demo["metadata"]["rid"]},
                )
        failed += cleaner.failed

    if not args.apply:
        print("\nNothing was changed: --apply does it.")
    if failed:
        sys.exit(f"\n{failed} could not be done")


if __name__ == "__main__":
    main()
