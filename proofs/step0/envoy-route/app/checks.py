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

"""End-to-end checks against one running mode (compose, local-dev or k8s).

Talks to Envoy as a client would, and reads the units' and the stub's admin
endpoints (never routed by Envoy) to see who was contacted and what they got.
Prints one "PASS|FAIL [mode] check: detail" line per check and exits non-zero
if any check failed. Login tokens and unit keys are never printed.

  --phase main        all checks below except authz-down
  --phase authz-down  run after the stub has been stopped: Envoy must fail closed
"""

import argparse
import asyncio
import hashlib
import json
import sys
import time
from urllib.parse import urlsplit

import aiohttp

ALICE = "login-alice"  # may use units 1001 and 1002
BOB = "login-bob"  # may use unit 1001 only
MALLORY = "login-mallory"  # unknown login
CUID_A, CUID_B = "1001", "1002"
FAKE_KEY = "client-made-up-unit-key"
PATTERN = bytes(range(251))


def fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16]


def bearer(login: str) -> dict:
    return {"Authorization": f"Bearer {login}"}


LOGIN_MARKERS = {fingerprint(f"Bearer {t}") for t in (ALICE, BOB)} | {fingerprint(t) for t in (ALICE, BOB)}


def login_leaked(seen: dict) -> list:
    """Where a login shows up in what a unit received (header values, path, query)."""
    leaks = []
    for name, values in (seen.get("headers") or {}).items():
        for value in values:
            if value in LOGIN_MARKERS or any(t in value for t in (ALICE, BOB)):
                leaks.append(f"header {name}")
    for field in ("path", "query"):
        if any(t in (seen.get(field) or "") for t in (ALICE, BOB)):
            leaks.append(field)
    return leaks


class Checks:
    def __init__(self, args: argparse.Namespace):
        self.mode = args.mode
        self.envoy = args.envoy.rstrip("/")
        self.ws_base = "ws" + self.envoy[len("http"):]
        self.admin = {"unit-a": args.unit_a_admin.rstrip("/"), "unit-b": args.unit_b_admin.rstrip("/")}
        self.stub = args.stub_admin.rstrip("/") if args.stub_admin else None
        self.addr = {"unit-a": args.unit_a_address, "unit-b": args.unit_b_address}
        self.ws_seconds = args.ws_seconds
        self.results: list = []
        self.session: aiohttp.ClientSession | None = None
        self.admin_session: aiohttp.ClientSession | None = None

    # ---------------------------------------------------------------- helpers
    def report(self, name: str, ok: bool, detail: str, evidence=None) -> bool:
        print(f"{'PASS' if ok else 'FAIL'} [{self.mode}] {name}: {detail}", flush=True)
        self.results.append({"mode": self.mode, "check": name, "ok": bool(ok), "detail": detail,
                             "evidence": evidence})
        return ok

    async def totals(self) -> dict:
        out = {}
        for unit, url in self.admin.items():
            async with self.admin_session.get(url + "/_admin/requests") as r:
                out[unit] = (await r.json())["total"]
        return out

    async def last_seen(self, unit: str) -> dict:
        async with self.admin_session.get(self.admin[unit] + "/_admin/requests") as r:
            reqs = (await r.json())["requests"]
        return reqs[-1] if reqs else {}

    async def stub_calls(self) -> list:
        async with self.admin_session.get(self.stub + "/_stub/calls") as r:
            return (await r.json())["calls"]

    async def contacted(self, before: dict, settle: float = 0.3) -> dict:
        await asyncio.sleep(settle)
        after = await self.totals()
        return {u: after[u] - before[u] for u in after}

    async def http(self, method: str, path: str, headers=None, data=None):
        async with self.session.request(method, self.envoy + path, headers=headers or {}, data=data,
                                        allow_redirects=False) as r:
            body = await r.read()
            return r.status, dict(r.headers), body

    async def raw(self, request_line: str, headers: list, body: bytes = b"") -> tuple:
        """Send bytes as written (no client-side URL normalisation)."""
        u = urlsplit(self.envoy)
        reader, writer = await asyncio.open_connection(u.hostname, u.port)
        lines = [request_line] + [f"{k}: {v}" for k, v in headers] + ["Connection: close"]
        if body:
            lines.append(f"Content-Length: {len(body)}")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode() + body)
        await writer.drain()
        data = await asyncio.wait_for(reader.read(-1), 15)
        writer.close()
        head, _, rest = data.partition(b"\r\n\r\n")
        status = int(head.split(b"\r\n", 1)[0].split()[1])
        return status, head.decode(errors="replace"), rest

    # ----------------------------------------------------------------- checks
    async def refused(self, name: str, path: str, headers: dict, expect: int, why: str) -> None:
        before = await self.totals()
        status, _, body = await self.http("GET", path, headers)
        hit = await self.contacted(before)
        ok = status == expect and not any(hit.values())
        self.report(name, ok, f"{why}: HTTP {status} (want {expect}), units contacted {hit}",
                    {"status": status, "contacted": hit, "body": body[:200].decode(errors="replace")})

    async def routed(self, name: str, login: str, cuid: str, unit: str, other: str) -> dict:
        before = await self.totals()
        status, headers, body = await self.http("GET", f"/api/units/{cuid}/echo", bearer(login))
        hit = await self.contacted(before)
        seen = json.loads(body) if status == 200 else {}
        key_to_client = any(h.lower() == "x-texera-unit-key" for h in headers)
        ok = (status == 200 and seen.get("unit") == unit and hit[unit] == 1 and hit[other] == 0
              and not key_to_client)
        self.report(name, ok, f"cuid {cuid} -> HTTP {status} answered by {seen.get('unit')}, "
                    f"contacted {hit}, unit key in the client's response={key_to_client}",
                    {"status": status, "contacted": hit, "host_at_unit": seen.get("host"),
                     "response_header_names": sorted(h.lower() for h in headers)})
        return seen

    async def check_unit_view(self, seen_by: dict) -> None:
        problems = []
        for unit, seen in seen_by.items():
            if not seen.get("unit_key_ok") or seen.get("unit_key_count") != 1:
                problems.append(f"{unit}: unit key ok={seen.get('unit_key_ok')} count={seen.get('unit_key_count')}")
            if seen.get("authorization_present"):
                problems.append(f"{unit}: Authorization header reached the unit")
            leaks = login_leaked(seen)
            if leaks:
                problems.append(f"{unit}: login visible in {leaks}")
            if seen.get("user") != "alice":
                problems.append(f"{unit}: X-Texera-User={seen.get('user')!r}")
        self.report("unit-sees-key-not-login", not problems,
                    "both units got exactly one correct X-Texera-Unit-Key, X-Texera-User=alice, "
                    "and no Authorization or login anywhere" if not problems else "; ".join(problems),
                    {u: {"host": s.get("host"), "header_names": sorted((s.get("headers") or {}).keys())}
                     for u, s in seen_by.items()})

    async def check_request_forwarded_to_stub(self) -> None:
        body = b"hello from the client"
        before = await self.totals()
        status, _, rbody = await self.http("POST", f"/api/units/{CUID_A}/echo?alpha=1&beta=two",
                                           bearer(ALICE), data=body)
        hit = await self.contacted(before)
        calls = [c for c in await self.stub_calls() if c["path"] == f"/api/units/{CUID_A}/echo"
                 and c["method"] == "POST" and c["query"] == "alpha=1&beta=two"]
        call = calls[-1] if calls else {}
        auth_ok = (call.get("headers") or {}).get("authorization") == [fingerprint(f"Bearer {ALICE}")]
        seen = json.loads(rbody) if status == 200 else {}
        ok = (status == 200 and bool(call) and auth_ok and call.get("decision") == 200
              and seen.get("method") == "POST" and seen.get("query") == "alpha=1&beta=two"
              and hit == {"unit-a": 1, "unit-b": 0})
        self.report("check-request-has-method-path-query-login", ok,
                    f"stub saw {call.get('method')} {call.get('path')}?{call.get('query')} with the login "
                    f"(match={auth_ok}), forwarded header names {sorted((call.get('headers') or {}).keys())}; "
                    f"unit got {seen.get('method')} ?{seen.get('query')}",
                    {"stub_call": {k: call.get(k) for k in ("method", "path", "query", "check_body_len")},
                     "stub_header_names": sorted((call.get("headers") or {}).keys())})
        # ext_authz cannot change the request body: the stub answered 200 with a body of its own.
        ok_body = (status == 200 and seen.get("body_sha256") == hashlib.sha256(body).hexdigest()
                   and seen.get("body_len") == len(body))
        self.report("authz-cannot-change-body", ok_body,
                    f"unit received the client's {seen.get('body_len')} bytes unchanged although the stub's "
                    f"200 answer had a body of its own; the check request carried {call.get('check_body_len')} "
                    f"body bytes (body not sent to the stub unless configured)",
                    {"unit_body_len": seen.get("body_len")})

    async def check_fake_routing_headers(self) -> None:
        b_addr = self.addr["unit-b"]
        attempts = {
            "Host": {"Host": b_addr},
            "X-Texera-Unit-Address": {"X-Texera-Unit-Address": b_addr},
            "X-Forwarded-Host": {"X-Forwarded-Host": b_addr},
            "X-Envoy-Original-Dst-Host": {"X-Envoy-Original-Dst-Host": b_addr},
            "Forwarded": {"Forwarded": f"host={b_addr}"},
        }
        problems, evidence = [], {}
        for label, extra in attempts.items():
            before = await self.totals()
            status, _, body = await self.http("GET", f"/api/units/{CUID_A}/echo", {**bearer(BOB), **extra})
            hit = await self.contacted(before)
            seen = json.loads(body) if status == 200 else {}
            evidence[label] = {"status": status, "contacted": hit,
                               "unit_saw_address_header": "x-texera-unit-address" in (seen.get("headers") or {})}
            if not (status == 200 and seen.get("unit") == "unit-a" and hit["unit-b"] == 0):
                problems.append(f"{label}: HTTP {status} unit={seen.get('unit')} contacted={hit}")
            if label == "X-Texera-Unit-Address" and evidence[label]["unit_saw_address_header"]:
                problems.append("client X-Texera-Unit-Address reached the unit")
        # The same headers cannot open a unit the login may not use.
        before = await self.totals()
        status, _, _ = await self.http("GET", f"/api/units/{CUID_B}/echo",
                                       {**bearer(BOB), "Host": b_addr, "X-Texera-Unit-Address": b_addr})
        hit = await self.contacted(before)
        evidence["forbidden-with-fake-address"] = {"status": status, "contacted": hit}
        if status != 403 or any(hit.values()):
            problems.append(f"bob->cuid {CUID_B} with B's address: HTTP {status} contacted={hit}")
        self.report("fake-unit-address-cannot-redirect", not problems,
                    "bob asking for cuid 1001 with unit-b's address in Host / X-Texera-Unit-Address / "
                    "X-Forwarded-Host / X-Envoy-Original-Dst-Host / Forwarded always reached unit-a; "
                    "cuid 1002 with B's address stayed 403 and contacted nobody" if not problems
                    else "; ".join(problems), evidence)

    async def check_fake_key(self) -> None:
        problems, evidence = [], {}
        before = await self.totals()
        status, _, body = await self.http("GET", f"/api/units/{CUID_A}/echo",
                                          {**bearer(BOB), "X-Texera-Unit-Key": FAKE_KEY,
                                           "X-Texera-User": "admin"})
        hit = await self.contacted(before)
        seen = json.loads(body) if status == 200 else {}
        values = [v for vs in (seen.get("headers") or {}).values() for v in vs]
        evidence["with-access"] = {"status": status, "contacted": hit, "unit_key_count": seen.get("unit_key_count"),
                                   "user": seen.get("user")}
        if not (status == 200 and seen.get("unit_key_ok") and seen.get("unit_key_count") == 1
                and fingerprint(FAKE_KEY) not in values and seen.get("user") == "bob"):
            problems.append(f"cuid {CUID_A}: HTTP {status}, key ok={seen.get('unit_key_ok')} "
                            f"count={seen.get('unit_key_count')} user={seen.get('user')!r}")
        before = await self.totals()
        status, _, _ = await self.http("GET", f"/api/units/{CUID_B}/echo",
                                       {**bearer(BOB), "X-Texera-Unit-Key": FAKE_KEY})
        hit = await self.contacted(before)
        evidence["without-access"] = {"status": status, "contacted": hit}
        if status != 403 or any(hit.values()):
            problems.append(f"cuid {CUID_B} with a made-up key: HTTP {status} contacted={hit}")
        # An underscore spelling is a different header to Envoy (so the early removal and the
        # ext_authz overwrite miss it) but the same one to frameworks that map "_" and "-" alike.
        before = await self.totals()
        status, _, body = await self.http("GET", f"/api/units/{CUID_A}/echo",
                                          {**bearer(BOB), "X_Texera_Unit_Key": FAKE_KEY})
        hit = await self.contacted(before)
        seen = json.loads(body) if status == 200 else {}
        smuggled = any("_" in h for h in (seen.get("headers") or {}))
        evidence["underscore-spelling"] = {"status": status, "contacted": hit}
        if not ((status == 400 and not any(hit.values())) or (status == 200 and not smuggled)):
            problems.append(f"X_Texera_Unit_Key: HTTP {status}, reached the unit={smuggled}")
        self.report("fake-unit-key-cannot-impersonate", not problems,
                    "a client X-Texera-Unit-Key / X-Texera-User never reaches the unit (it gets one key, the "
                    "right one, and user=bob); a made-up key does not open cuid 1002; the X_Texera_Unit_Key "
                    f"spelling -> HTTP {evidence['underscore-spelling']['status']}, contacted "
                    f"{evidence['underscore-spelling']['contacted']}" if not problems
                    else "; ".join(problems), evidence)

    async def check_raw_tricks(self) -> None:
        b_addr = self.addr["unit-b"]
        auth = ("Authorization", f"Bearer {BOB}")
        envoy_host = urlsplit(self.envoy).netloc
        attempts = {
            "absolute-form URI naming unit-b":
                (f"GET http://{b_addr}/api/units/{CUID_A}/echo HTTP/1.1", [("Host", b_addr), auth]),
            "dot segments /1001/../1002":
                (f"GET /api/units/{CUID_A}/../{CUID_B}/echo HTTP/1.1", [("Host", envoy_host), auth]),
            "encoded dot segments /1001/%2e%2e/1002":
                (f"GET /api/units/{CUID_A}/%2e%2e/{CUID_B}/echo HTTP/1.1", [("Host", envoy_host), auth]),
            "encoded slashes 1001%2F..%2F1002":
                (f"GET /api/units/{CUID_A}%2F..%2F{CUID_B}/echo HTTP/1.1", [("Host", envoy_host), auth]),
            "double slash //api/units/1002":
                (f"GET //api/units/{CUID_B}/echo HTTP/1.1", [("Host", envoy_host), auth]),
        }
        problems, evidence = [], {}
        for label, (line, headers) in attempts.items():
            before = await self.totals()
            try:
                status, _, _ = await self.raw(line, headers)
            except Exception as exc:  # a reset connection is also a refusal
                status = f"error {type(exc).__name__}"
            hit = await self.contacted(before)
            evidence[label] = {"status": status, "contacted": hit}
            if hit["unit-b"] != 0:
                problems.append(f"{label}: reached unit-b (HTTP {status})")
        self.report("raw-request-tricks-cannot-reach-other-unit", not problems,
                    "; ".join(f"{k} -> {v['status']} contacted {v['contacted']}" for k, v in evidence.items())
                    if not problems else "; ".join(problems), evidence)

    async def ws_refused(self, name: str, cuid: str, headers: dict, expect: int, why: str) -> None:
        before = await self.totals()
        status = None
        try:
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{cuid}/watch", headers=headers,
                                               heartbeat=None):
                status = 101
        except aiohttp.WSServerHandshakeError as exc:
            status = exc.status
        hit = await self.contacted(before)
        self.report(name, status == expect and not any(hit.values()),
                    f"{why}: upgrade answered HTTP {status} (want {expect}), units contacted {hit}",
                    {"status": status, "contacted": hit})

    async def ws_route(self, cuid: str, unit: str, other: str) -> None:
        before = await self.totals()
        hello = {}
        try:
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{cuid}/watch",
                                               headers=bearer(ALICE), heartbeat=None) as ws:
                hello = await asyncio.wait_for(ws.receive_json(), 5)
        except aiohttp.WSServerHandshakeError as exc:
            hello = {"error": exc.status}
        hit = await self.contacted(before)
        req = hello.get("request") or {}
        ok = (hello.get("unit") == unit and hit[unit] == 1 and hit[other] == 0 and req.get("unit_key_ok")
              and req.get("unit_key_count") == 1 and not req.get("authorization_present")
              and not login_leaked(req))
        self.report(f"ws-route-{unit[-1]}", ok,
                    f"upgrade for cuid {cuid} answered by {hello.get('unit')}; at the unit: key ok="
                    f"{req.get('unit_key_ok')}, Authorization present={req.get('authorization_present')}, "
                    f"login leaks={login_leaked(req)}; contacted {hit}",
                    {"contacted": hit, "upgrade_headers_at_unit": sorted((req.get("headers") or {}).keys())})

    async def ws_cookie_login(self) -> None:
        """A browser cannot set Authorization on a WebSocket; it can send a cookie."""
        before = await self.totals()
        hello = {}
        try:
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{CUID_A}/watch",
                                               headers={"Cookie": f"texera_login={ALICE}; theme=dark"},
                                               heartbeat=None) as ws:
                hello = await ws.receive_json()
        except aiohttp.WSServerHandshakeError as exc:
            hello = {"error": exc.status}
        hit = await self.contacted(before)
        calls = [c for c in await self.stub_calls() if c["path"] == f"/wsapi/units/{CUID_A}/watch"]
        stub_saw_cookie = bool(calls) and "cookie" in (calls[-1].get("headers") or {})
        req = hello.get("request") or {}
        headers_at_unit = req.get("headers") or {}
        ok = (hello.get("unit") == "unit-a" and hit == {"unit-a": 1, "unit-b": 0} and stub_saw_cookie
              and "cookie" not in headers_at_unit and not req.get("authorization_present")
              and req.get("unit_key_ok") and req.get("user") == "alice" and not login_leaked(req))
        self.report("ws-login-in-cookie", ok,
                    f"browser-style upgrade with the login only in a cookie: answered by {hello.get('unit', hello)}; "
                    f"stub saw the cookie={stub_saw_cookie}; Cookie at the unit={'cookie' in headers_at_unit}; "
                    f"user at the unit={req.get('user')!r}; contacted {hit}",
                    {"contacted": hit, "upgrade_headers_at_unit": sorted(headers_at_unit.keys())})

    async def login_in_url_refused(self) -> None:
        """ext_authz over HTTP can add, replace and remove headers but not query parameters, so a
        login in the URL would reach the unit. The Dashboard has to refuse it outright."""
        before = await self.totals()
        status, _, _ = await self.http("GET", f"/api/units/{CUID_A}/echo?access-token={ALICE}")
        try:
            ws_status = None
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{CUID_A}/watch?access-token={ALICE}",
                                               heartbeat=None):
                ws_status = 101
        except aiohttp.WSServerHandshakeError as exc:
            ws_status = exc.status
        status2, _, _ = await self.http("GET", f"/api/units/{CUID_A}/echo?token={ALICE}", bearer(ALICE))
        hit = await self.contacted(before)
        ok = status == 401 and ws_status == 401 and status2 == 401 and not any(hit.values())
        self.report("login-in-url-refused", ok,
                    f"?access-token= on HTTP -> {status}, on a WebSocket upgrade -> {ws_status}; ?token= next to a "
                    f"valid Authorization -> {status2}; units contacted {hit}",
                    {"http": status, "ws": ws_status, "with_header": status2, "contacted": hit})

    async def ws_both_ways(self) -> None:
        sent, still_open, close_code = 0, False, None
        got = {"echo": 0, "tick": 0, "echoed": set()}
        t0 = time.monotonic()
        try:
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{CUID_A}/watch",
                                               headers=bearer(ALICE), heartbeat=None) as ws:
                hello = await ws.receive_json()

                async def read() -> None:
                    # One reader for the whole session; it ends when the close handshake completes.
                    # (A timed-out aiohttp receive() marks the socket 1006, so no timeouts here.)
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        data = json.loads(msg.data)
                        if data.get("type") == "echo" and data.get("unit") == hello.get("unit"):
                            got["echo"] += 1
                            got["echoed"].add(data.get("data"))
                        elif data.get("type") == "tick":
                            got["tick"] += 1

                reader = asyncio.create_task(read())
                while time.monotonic() - t0 < self.ws_seconds:
                    await ws.send_str(f"msg-{sent}")
                    sent += 1
                    await asyncio.sleep(min(2.0, max(0.0, self.ws_seconds - (time.monotonic() - t0))))
                await asyncio.sleep(0.3)  # let the last echo arrive
                still_open = not ws.closed and not reader.done()
                await ws.close()
                await asyncio.wait_for(reader, 10)
                close_code = ws.close_code
        except aiohttp.WSServerHandshakeError as exc:
            close_code = f"handshake {exc.status}"
        held = time.monotonic() - t0
        echoes, ticks = got["echo"], got["tick"]
        want_ticks = int(self.ws_seconds / 1.5) - 2
        ok = (still_open and sent >= 2 and echoes == sent and got["echoed"] == {f"msg-{i}" for i in range(sent)}
              and ticks >= want_ticks and close_code == 1000)
        longer = " (longer than Envoy's 15s default route timeout)" if held > 15 else ""
        self.report("ws-open-both-ways", ok,
                    f"held {held:.1f}s{longer}: sent {sent}, echoed {echoes}, "
                    f"unit pushed {ticks} ticks (want >= {want_ticks}); open at the end={still_open}; "
                    f"client close code {close_code}",
                    {"held_s": round(held, 1), "sent": sent, "echoes": echoes, "ticks": ticks})

    async def large_response(self) -> None:
        size = 4 * 1024 * 1024
        expected = hashlib.sha256((PATTERN * (size // len(PATTERN) + 1))[:size]).hexdigest()
        digest, got, ttfb, status, unit = hashlib.sha256(), 0, None, None, None
        t0 = time.monotonic()
        async with self.session.get(f"{self.envoy}/api/units/{CUID_B}/big?bytes={size}&chunk=65536&delay_ms=15",
                                    headers=bearer(ALICE)) as r:
            status, unit = r.status, r.headers.get("X-Unit")
            async for chunk in r.content.iter_chunked(65536):
                if ttfb is None:
                    ttfb = time.monotonic() - t0
                digest.update(chunk)
                got += len(chunk)
        total = time.monotonic() - t0
        ok = (status == 200 and unit == "unit-b" and got == size and digest.hexdigest() == expected
              and ttfb is not None and ttfb < total / 2)
        self.report("large-response-streams", ok,
                    f"{got} bytes from {unit}, sha256 match={digest.hexdigest() == expected}, first byte after "
                    f"{(ttfb or 0) * 1000:.0f} ms of {total * 1000:.0f} ms total (streamed, not buffered)",
                    {"bytes": got, "ttfb_ms": round((ttfb or 0) * 1000), "total_ms": round(total * 1000)})

    async def large_upload(self) -> None:
        size = 3 * 1024 * 1024
        body = (PATTERN * (size // len(PATTERN) + 1))[:size]
        status, _, rbody = await self.http("POST", f"/api/units/{CUID_A}/echo", bearer(ALICE), data=body)
        seen = json.loads(rbody) if status == 200 else {}
        ok = status == 200 and seen.get("body_len") == size and seen.get("body_sha256") == hashlib.sha256(body).hexdigest()
        self.report("large-request-body-passes", ok,
                    f"POST of {size} bytes through the check: unit-a got {seen.get('body_len')} bytes, "
                    f"sha256 match={seen.get('body_sha256') == hashlib.sha256(body).hexdigest()}",
                    {"status": status, "unit_body_len": seen.get("body_len")})

    async def set_access(self, login: str, cuid: str, allow: bool) -> None:
        async with self.admin_session.post(self.stub + "/_stub/access",
                                           json={"login": login, "cuid": cuid, "allow": allow}) as r:
            r.raise_for_status()

    async def revocation(self) -> None:
        """The check runs once per request; a WebSocket is one request, checked at the upgrade."""
        echoed_after, new_ws, new_http = None, None, None
        try:
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{CUID_A}/watch",
                                               headers=bearer(BOB), heartbeat=None) as ws:
                await ws.receive_json()  # hello
                await self.set_access(BOB, CUID_A, False)
                await ws.send_str("after-revoke")
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and echoed_after is None:
                    msg = await ws.receive(timeout=5)
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    data = json.loads(msg.data)
                    if data.get("type") == "echo":
                        echoed_after = data.get("data") == "after-revoke"
                try:
                    async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{CUID_A}/watch",
                                                       headers=bearer(BOB), heartbeat=None):
                        new_ws = 101
                except aiohttp.WSServerHandshakeError as exc:
                    new_ws = exc.status
                new_http, _, _ = await self.http("GET", f"/api/units/{CUID_A}/echo", bearer(BOB))
                await ws.close()
        finally:
            await self.set_access(BOB, CUID_A, True)
        ok = echoed_after is True and new_ws == 403 and new_http == 403
        self.report("revocation-applies-to-new-requests-only", ok,
                    f"after revoking bob's use of cuid 1001: his open WebSocket still echoed={echoed_after} "
                    f"(only the upgrade was checked); a new upgrade -> {new_ws}; a new HTTP request -> {new_http}",
                    {"open_socket_kept_working": echoed_after, "new_upgrade": new_ws, "new_http": new_http})

    async def authz_down(self) -> None:
        before = await self.totals()
        status, _, body = await self.http("GET", f"/api/units/{CUID_A}/echo", bearer(ALICE))
        hit = await self.contacted(before)
        try:
            ws_status = None
            async with self.session.ws_connect(f"{self.ws_base}/wsapi/units/{CUID_A}/watch",
                                               headers=bearer(ALICE), heartbeat=None):
                ws_status = 101
        except aiohttp.WSServerHandshakeError as exc:
            ws_status = exc.status
        hit2 = await self.contacted(before)
        ok = not (200 <= status < 300) and ws_status != 101 and not any(hit2.values())
        self.report("authz-down-fails-closed", ok,
                    f"with the stub stopped: HTTP {status}, WebSocket upgrade {ws_status}, units contacted {hit2}",
                    {"status": status, "ws_status": ws_status, "contacted": hit2,
                     "body": body[:120].decode(errors="replace")})

    # ------------------------------------------------------------------- run
    async def run(self, phase: str) -> int:
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout, auto_decompress=False) as self.session, \
                aiohttp.ClientSession(timeout=timeout) as self.admin_session:
            if phase == "authz-down":
                await self.guard("authz-down-fails-closed", self.authz_down())
            else:
                await self.main()
        return 0 if all(r["ok"] for r in self.results) else 1

    async def guard(self, name: str, step):
        """Run one check; an exception is that check's FAIL, and the next check still runs."""
        try:
            return await step
        except Exception as exc:
            self.report(name, False, f"raised {type(exc).__name__}: {exc}")
            return None

    async def main(self) -> None:
        g = self.guard
        await g("login-missing-refused", self.refused("login-missing-refused", f"/api/units/{CUID_A}/echo", {},
                                                      401, "no Authorization"))
        await g("login-invalid-refused", self.refused("login-invalid-refused", f"/api/units/{CUID_A}/echo",
                                                      bearer(MALLORY), 401, "unknown login"))
        await g("login-not-bearer-refused", self.refused("login-not-bearer-refused", f"/api/units/{CUID_A}/echo",
                                                         {"Authorization": "Basic YWxpY2U6eA=="}, 401,
                                                         "Basic instead of Bearer"))
        await g("unit-not-allowed-refused", self.refused("unit-not-allowed-refused", f"/api/units/{CUID_B}/echo",
                                                         bearer(BOB), 403, "bob may not use cuid 1002"))
        await g("unit-unknown-refused", self.refused("unit-unknown-refused", "/api/units/9999/echo", bearer(ALICE),
                                                     403, "no cuid 9999"))
        seen_a = await g("route-a", self.routed("route-a", ALICE, CUID_A, "unit-a", "unit-b")) or {}
        seen_b = await g("route-b", self.routed("route-b", ALICE, CUID_B, "unit-b", "unit-a")) or {}
        await g("unit-sees-key-not-login", self.check_unit_view({"unit-a": seen_a, "unit-b": seen_b}))
        await g("check-request-has-method-path-query-login", self.check_request_forwarded_to_stub())
        await g("fake-unit-address-cannot-redirect", self.check_fake_routing_headers())
        await g("fake-unit-key-cannot-impersonate", self.check_fake_key())
        await g("raw-request-tricks-cannot-reach-other-unit", self.check_raw_tricks())
        await g("ws-login-missing-refused", self.ws_refused("ws-login-missing-refused", CUID_A, {}, 401,
                                                            "no Authorization"))
        await g("ws-unit-not-allowed-refused", self.ws_refused("ws-unit-not-allowed-refused", CUID_B, bearer(BOB),
                                                               403, "bob may not use cuid 1002"))
        await g("ws-route-a", self.ws_route(CUID_A, "unit-a", "unit-b"))
        await g("ws-route-b", self.ws_route(CUID_B, "unit-b", "unit-a"))
        await g("ws-login-in-cookie", self.ws_cookie_login())
        await g("login-in-url-refused", self.login_in_url_refused())
        await g("ws-open-both-ways", self.ws_both_ways())
        await g("large-response-streams", self.large_response())
        await g("large-request-body-passes", self.large_upload())
        await g("revocation-applies-to-new-requests-only", self.revocation())


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--mode", required=True)
    p.add_argument("--phase", choices=["main", "authz-down"], default="main")
    p.add_argument("--envoy", required=True, help="base URL clients use, e.g. http://127.0.0.1:19520")
    p.add_argument("--unit-a-admin", required=True)
    p.add_argument("--unit-b-admin", required=True)
    p.add_argument("--stub-admin")
    p.add_argument("--unit-a-address", required=True, help="unit-a's address as Envoy reaches it")
    p.add_argument("--unit-b-address", required=True, help="unit-b's address as Envoy reaches it")
    p.add_argument("--ws-seconds", type=float, default=17.0)
    p.add_argument("--json-out")
    args = p.parse_args()
    checks = Checks(args)
    code = asyncio.run(checks.run(args.phase))
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(checks.results, f, indent=2)
    return code


if __name__ == "__main__":
    sys.exit(main())
