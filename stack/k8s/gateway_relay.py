#!/usr/bin/env python3
"""TCP relay from 127.0.0.1:<port> to the Envoy gateway Service's ClusterIP.

Started by k8s_stack.py (`up`, `port-forward start`) as the default way the harness
reaches the gateway. OrbStack routes Service ClusterIPs from macOS, so connections go
straight to the Service. Unlike `kubectl port-forward`, which exits ("lost connection to
pod") as soon as the pod side resets any one forwarded connection -- closing a workflow
websocket through Envoy does that -- every connection here is independent.

Stdlib only, Python 3.9+: it runs under the Apple-signed /usr/bin/python3. macOS's Local
Network privacy check refuses connections to 192.168.x.x from the ad-hoc-signed uv Python
of the harness venv (EHOSTUNREACH, "No route to host"), not from platform binaries.

  gateway_relay.py --listen 127.0.0.1:30080 --target 192.168.194.252:80 \
                   [--context orbstack --namespace sce-k8s --selector <svc label selector>]
  gateway_relay.py --check 192.168.194.252:80      exit 0 if this interpreter can connect

With --selector, a failed connect re-reads the Service's ClusterIP through kubectl (the
Service may have been recreated) and retries once.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import socket
import subprocess
import sys


def stamp() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def hostport(s: str) -> tuple[str, int]:
    host, _, port = s.rpartition(":")
    return host, int(port)


def resolve(context: str, namespace: str, selector: str) -> tuple[str, int] | None:
    p = subprocess.run(["kubectl", "--context", context, "-n", namespace, "get", "services", "-l", selector,
                        "-o", "jsonpath={.items[0].spec.clusterIP} {.items[0].spec.ports[0].port}"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30)
    parts = p.stdout.split()
    if p.returncode != 0 or len(parts) != 2:
        return None
    return parts[0], int(parts[1])


async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter):
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst.write(data)
            await dst.drain()
        if dst.can_write_eof():
            dst.write_eof()
        return None
    except (ConnectionError, OSError, RuntimeError) as e:
        return e


async def serve(a) -> None:
    state = {"target": hostport(a.target), "conns": 0, "failed": 0}
    print(f"{stamp()} relay {a.listen} -> {state['target'][0]}:{state['target'][1]}", flush=True)

    async def connect():
        return await asyncio.wait_for(asyncio.open_connection(*state["target"]), 5)

    async def handle(cr: asyncio.StreamReader, cw: asyncio.StreamWriter) -> None:
        state["conns"] += 1
        try:
            ur, uw = await connect()
        except (OSError, asyncio.TimeoutError):
            if a.selector:
                new = await asyncio.get_running_loop().run_in_executor(
                    None, resolve, a.context, a.namespace, a.selector)
                if new and new != state["target"]:
                    print(f"{stamp()} target now {new[0]}:{new[1]}", flush=True)
                    state["target"] = new
            try:
                ur, uw = await connect()
            except (OSError, asyncio.TimeoutError) as e:
                state["failed"] += 1
                print(f"{stamp()} cannot reach {state['target']}: {e!r} ({state['failed']} failed of "
                      f"{state['conns']})", flush=True)
                cw.close()
                return
        up = asyncio.ensure_future(pipe(cr, uw))
        down = asyncio.ensure_future(pipe(ur, cw))
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        if any(t.result() is not None for t in done):
            for t in pending:  # one side reset: drop the other direction too
                t.cancel()
        elif pending:
            await asyncio.wait(pending, timeout=600)
            for t in pending:
                t.cancel()
        for w in (uw, cw):
            try:
                w.close()
            except Exception:  # noqa: BLE001
                pass

    host, port = hostport(a.listen)
    server = await asyncio.start_server(handle, host, port, reuse_address=True)
    async with server:
        await server.serve_forever()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", help="IP:PORT to test a connection to, then exit")
    ap.add_argument("--listen", default="127.0.0.1:30080")
    ap.add_argument("--target", help="IP:PORT of the envoy Service")
    ap.add_argument("--context", default="orbstack")
    ap.add_argument("--namespace", default="sce-k8s")
    ap.add_argument("--selector", default="", help="label selector of the envoy Service (re-resolve)")
    a = ap.parse_args()
    if a.check:
        try:
            with socket.create_connection(hostport(a.check), timeout=3):
                return 0
        except OSError as e:
            print(f"{a.check}: {e!r}", file=sys.stderr)
            return 1
    if not a.target:
        ap.error("--target is required")
    try:
        asyncio.run(serve(a))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
