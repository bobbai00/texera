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

"""A fake computing unit: HTTP and WebSocket echo that reports what it received.

App port (only Envoy should reach it):
  ANY  /api/units/<cuid>/echo       -> JSON: unit name, method, path, query,
                                       headers (secrets as fingerprints), body size + sha256
  GET  /api/units/<cuid>/big        -> a chunked body of ?bytes= (default 4 MiB),
                                       written in ?chunk= pieces with ?delay_ms= between
  GET  /wsapi/units/<cuid>/watch    -> WebSocket: a hello carrying the upgrade request's
                                       headers, an echo per client message, and a tick
                                       every 1.5 s pushed by the unit

Every request must carry exactly one X-Texera-Unit-Key equal to this unit's key,
or it is refused with 401. Every request is recorded, refused or not.

Admin port (for the test runner, never routed by Envoy):
  GET  /_admin/requests   POST /_admin/reset
"""

import asyncio
import collections
import hashlib
import hmac
import os
import signal
import sys
import time

from aiohttp import WSMsgType, web

NAME = os.environ["UNIT_NAME"]
KEY = os.environ["UNIT_KEY"]
KEY_HEADER = "X-Texera-Unit-Key"
SENSITIVE = {"authorization", "cookie", "x-texera-unit-key"}
PATTERN = bytes(range(251))  # the /big body is this, repeated

SEEN: collections.deque = collections.deque(maxlen=2000)
TOTAL = 0


def fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:16]


def redacted_headers(headers) -> dict:
    out: dict = {}
    for name, value in headers.items():
        lname = name.lower()
        out.setdefault(lname, []).append(fingerprint(value) if lname in SENSITIVE else value)
    return out


def describe(request: web.Request) -> dict:
    keys = request.headers.getall(KEY_HEADER, [])
    raw_path, _, query = request.raw_path.partition("?")
    return {
        "unit": NAME,
        "method": request.method,
        "path": raw_path,
        "query": query,
        "host": request.headers.get("Host"),
        "headers": redacted_headers(request.headers),
        "unit_key_count": len(keys),
        "unit_key_ok": len(keys) == 1 and hmac.compare_digest(keys[0].encode(), KEY.encode()),
        "authorization_present": "Authorization" in request.headers,
        "user": request.headers.get("X-Texera-User"),
    }


def log(line: str) -> None:
    print(time.strftime("%H:%M:%S"), NAME, line, flush=True)


@web.middleware
async def record_and_check_key(request: web.Request, handler):
    global TOTAL
    info = describe(request)
    info["t"] = time.time()
    SEEN.append(info)
    TOTAL += 1
    log(f"{request.method} {info['path']} key_ok={info['unit_key_ok']} "
        f"authorization={'present' if info['authorization_present'] else 'absent'}")
    if not info["unit_key_ok"]:
        return web.json_response({"unit": NAME, "error": "unit key missing or wrong"}, status=401)
    request["info"] = info
    return await handler(request)


async def echo(request: web.Request) -> web.Response:
    body = await request.read()
    info = dict(request["info"])
    info["body_len"] = len(body)
    info["body_sha256"] = hashlib.sha256(body).hexdigest()
    return web.json_response(info, headers={"X-Unit": NAME})


async def big(request: web.Request) -> web.StreamResponse:
    total = int(request.query.get("bytes", str(4 * 1024 * 1024)))
    chunk = int(request.query.get("chunk", "65536"))
    delay = int(request.query.get("delay_ms", "10")) / 1000.0
    body = (PATTERN * (total // len(PATTERN) + 1))[:total]
    response = web.StreamResponse(headers={"Content-Type": "application/octet-stream", "X-Unit": NAME})
    response.enable_chunked_encoding()
    await response.prepare(request)
    for offset in range(0, total, chunk):
        await response.write(body[offset:offset + chunk])
        if delay:
            await asyncio.sleep(delay)
    await response.write_eof()
    return response


async def watch(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=None, autoping=True)
    await ws.prepare(request)
    await ws.send_json({"type": "hello", "unit": NAME, "request": request["info"]})

    async def ticker() -> None:
        n = 0
        while not ws.closed:
            await asyncio.sleep(1.5)
            n += 1
            try:
                await ws.send_json({"type": "tick", "unit": NAME, "n": n})
            except (ConnectionResetError, RuntimeError):
                return

    tick_task = asyncio.create_task(ticker())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await ws.send_json({"type": "echo", "unit": NAME, "data": msg.data})
            elif msg.type == WSMsgType.BINARY:
                await ws.send_bytes(msg.data)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        tick_task.cancel()
    log(f"websocket closed with code {ws.close_code}")
    return ws


async def not_found(request: web.Request) -> web.Response:
    return web.json_response({"unit": NAME, "error": "no such path"}, status=404)


async def admin_requests(_request: web.Request) -> web.Response:
    return web.json_response({"unit": NAME, "total": TOTAL, "requests": list(SEEN)})


async def admin_reset(_request: web.Request) -> web.Response:
    global TOTAL
    SEEN.clear()
    TOTAL = 0
    return web.json_response({"ok": True})


async def admin_health(_request: web.Request) -> web.Response:
    return web.Response(text="ok\n")


async def serve() -> None:
    host = os.environ.get("UNIT_HOST", "0.0.0.0")
    app_port = int(os.environ.get("APP_PORT", "8080"))
    admin_port = int(os.environ.get("ADMIN_PORT", "8081"))

    app = web.Application(middlewares=[record_and_check_key], client_max_size=64 * 1024 * 1024)
    app.router.add_route("*", "/api/units/{cuid}/echo", echo)
    app.router.add_get("/api/units/{cuid}/big", big)
    app.router.add_get("/wsapi/units/{cuid}/watch", watch)
    app.router.add_route("*", "/{tail:.*}", not_found)

    admin = web.Application()
    admin.router.add_get("/_admin/requests", admin_requests)
    admin.router.add_post("/_admin/reset", admin_reset)
    admin.router.add_get("/_admin/health", admin_health)

    runners = []
    for application, port in ((app, app_port), (admin, admin_port)):
        runner = web.AppRunner(application, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, host, port).start()
        runners.append(runner)
    log(f"listening on {host}:{app_port} (app) and {host}:{admin_port} (admin)")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        for runner in runners:
            await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        sys.exit(0)
