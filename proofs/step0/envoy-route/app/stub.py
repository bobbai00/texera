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

"""Authorization stub that stands in for the Dashboard service.

Envoy's ext_authz HTTP filter sends this stub a copy of every request that
names a unit: same method, the original path and query string under the
/authz prefix, and the request headers Envoy is told to forward (by default
Host, Method, Path, Content-Length and Authorization; Cookie is added in our
config). The login is read from Authorization: Bearer <login>, or from the
cookie texera_login=<login> (what a browser WebSocket can send). The stub answers:

  401  the login is missing or unknown, or a login is in the URL (access-token /
       token query parameter): ext_authz over HTTP cannot strip a query
       parameter, so such a login would reach the unit
  403  the path does not name a unit this login may use
  200  allowed; the answer carries
         Host: <unit address>          -> Envoy routes to it (dynamic forward proxy)
         X-Texera-Unit-Key: <key>      -> the header the unit checks
         X-Texera-User: <user>         -> who is calling, for the unit
       and a body, which Envoy is expected to ignore (ext_authz cannot
       replace the request body).

The stub never contacts a unit. Logins and units are fake; the unit keys
and addresses come from the environment. Nothing secret is printed.
"""

import collections
import hashlib
import json
import os
import re
import sys
import time
from urllib.parse import parse_qsl

from aiohttp import web

# Fake logins: token -> (user, cuids the user may use).
LOGINS = {
    "login-alice": ("alice", {"1001", "1002"}),
    "login-bob": ("bob", {"1001"}),
}

# A path names a unit when it starts with /api/units/<cuid> or /wsapi/units/<cuid>.
# The cuid is digits only, so encoded separators or dot segments never parse as one.
UNIT_PATH = re.compile(r"^/(?:api|wsapi)/units/(?P<cuid>[0-9]+)(?:/[^?#]*)?$")
CHECK_PREFIX = "/authz"
SENSITIVE = {"authorization", "cookie", "x-texera-unit-key"}

CALLS: collections.deque = collections.deque(maxlen=2000)


def fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16]


def redacted_headers(headers) -> dict:
    out: dict = {}
    for name, value in headers.items():
        lname = name.lower()
        out.setdefault(lname, []).append(fingerprint(value) if lname in SENSITIVE else value)
    return out


def load_units() -> dict:
    units = {}
    for cuid, prefix in (("1001", "UNIT_A"), ("1002", "UNIT_B")):
        units[cuid] = {
            "name": os.environ[f"{prefix}_NAME"],
            "address": os.environ[f"{prefix}_ADDR"],
            "key": os.environ[f"{prefix}_KEY"],
        }
    return units


UNITS = load_units()


def log(line: str) -> None:
    print(time.strftime("%H:%M:%S"), line, flush=True)


async def check(request: web.Request) -> web.StreamResponse:
    raw = request.raw_path  # not decoded: what Envoy sent, with the query string
    raw_path, _, query = raw.partition("?")
    path = raw_path[len(CHECK_PREFIX):] or "/"
    body = await request.read()
    call = {
        "t": time.time(),
        "method": request.method,
        "path": path,
        "query": query,
        "headers": redacted_headers(request.headers),
        "check_body_len": len(body),
    }
    CALLS.append(call)

    if any(k in ("access-token", "token") for k, _ in parse_qsl(query, keep_blank_values=True)):
        call["decision"] = 401
        log(f"authz {request.method} {path} -> 401 (login in the URL is not accepted)")
        return web.json_response({"error": "send the login in a header or cookie, not the URL"}, status=401)

    auth = request.headers.get("Authorization", "")
    login = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
    if not login:
        login = request.cookies.get("texera_login", "")
    if login not in LOGINS:
        call["decision"] = 401
        log(f"authz {request.method} {path} -> 401 (no valid login)")
        return web.json_response(
            {"error": "login required"},
            status=401,
            headers={"WWW-Authenticate": 'Bearer realm="texera"'},
        )
    user, allowed = LOGINS[login]

    match = UNIT_PATH.match(path)
    cuid = match.group("cuid") if match else None
    if cuid is None or cuid not in allowed or cuid not in UNITS:
        call["decision"] = 403
        log(f"authz {request.method} {path} -> 403 (user {user} may not use this path)")
        return web.json_response({"error": "unit not allowed"}, status=403)

    unit = UNITS[cuid]
    call["decision"] = 200
    call["unit"] = unit["name"]
    log(f"authz {request.method} {path} -> 200 {unit['name']} (user {user})")
    return web.Response(
        status=200,
        text="ext_authz answer body: Envoy must not use this as the request body\n",
        headers={
            "Host": unit["address"],
            "X-Texera-Unit-Key": unit["key"],
            "X-Texera-User": user,
        },
    )


async def calls(_request: web.Request) -> web.Response:
    return web.json_response({"count": len(CALLS), "calls": list(CALLS)})


async def access(request: web.Request) -> web.Response:
    """Grant or revoke a login's use of a unit: {"login": ..., "cuid": ..., "allow": bool}."""
    change = await request.json()
    user, allowed = LOGINS[change["login"]]
    (allowed.add if change["allow"] else allowed.discard)(str(change["cuid"]))
    log(f"access: {user} {'may' if change['allow'] else 'may no longer'} use cuid {change['cuid']}")
    return web.json_response({"user": user, "cuids": sorted(allowed)})


async def reset(_request: web.Request) -> web.Response:
    CALLS.clear()
    return web.json_response({"ok": True})


async def health(_request: web.Request) -> web.Response:
    return web.Response(text="ok\n")


def main() -> None:
    host = os.environ.get("STUB_HOST", "0.0.0.0")
    port = int(os.environ.get("STUB_PORT", "9000"))
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_get("/_stub/calls", calls)
    app.router.add_post("/_stub/reset", reset)
    app.router.add_post("/_stub/access", access)
    app.router.add_get("/_stub/health", health)
    app.router.add_route("*", CHECK_PREFIX + "{tail:.*}", check)
    log(f"authz stub on {host}:{port}; units: "
        + json.dumps({c: {"name": u["name"], "address": u["address"]} for c, u in UNITS.items()}))
    web.run_app(app, host=host, port=port, access_log=None, print=None)


if __name__ == "__main__":
    sys.exit(main())
