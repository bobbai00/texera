<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Step 0: Envoy asks the Dashboard before forwarding, and routes to a unit by the answer

**Verdict: proven in all three modes.** Docker Compose, local dev and Kubernetes (Envoy Gateway)
each pass the same 25 checks. The final run was 75 of 75 PASS. Every full run from a clean state
passed (see [Runs](#runs)).

How it works: Envoy's `ext_authz` (HTTP) filter sends each unit request (method, path, query,
login) to the Dashboard stand-in. A 200 answer carries three headers:

- `Host: <unit address>`
- `X-Texera-Unit-Key: <key>`
- `X-Texera-User: <user>`

Envoy writes these onto the request. A **dynamic forward proxy** cluster then resolves the rewritten
`Host` by DNS and connects to it. In Envoy Gateway the same cluster type is the `DynamicResolver`
Backend, which upstream Texera already uses for `/wsapi`. The route strips `Authorization` and
`Cookie`, so the unit never sees the login.

## Run it

```
./run.sh                 # all three modes, about 2.5 min; exit code 0 only if every check passed
./run.sh compose k8s     # a subset: compose, local-dev, k8s
WS_SECONDS=5 ./run.sh    # shorter WebSocket hold (default 17 s, longer than Envoy's 15 s route timeout)
KEEP_IMAGE=1 ./run.sh    # keep the sce0env-py:step0 image afterwards
KUBE_CONTEXT=... ./run.sh  # default orbstack
```

**What `run.sh` does:**

- Creates `.venv` with `uv` from the hash-pinned `requirements.lock`.
- Builds `sce0env-py:step0`, the stub and units image.
- Generates fresh unit keys. They are never printed or written to disk; Kubernetes gets them
  through stdin.
- Runs each mode, printing one `PASS`/`FAIL [mode] check: detail` line per check.
- Tears everything down on any exit, including Ctrl-C. A check that crashes counts as a FAIL.
- Installs the Envoy Gateway controller with Helm only if none is running, and leaves it installed.

Each run writes its logs, JSON evidence and the Envoy Gateway `config_dump` to `.out/` (gitignored).

**Requirements:** `uv`, Docker with Compose, `curl`, `jq`, `openssl`. The k8s mode also needs
`kubectl` and `helm`.

**Ports:** everything listens on 127.0.0.1 in 19520-19539 (the map is at the top of `run.sh`).
Kubernetes is reached through `kubectl port-forward` on those ports; Envoy's Service stays
ClusterIP.

## What was built

| Piece | File | Role |
|---|---|---|
| Authorization stub | `app/stub.py` | Stands in for the Dashboard. See the contract below. |
| Fake unit | `app/unit.py` | HTTP + WebSocket echo. Details below. |
| Direct-call probe | `app/probe_direct.py` | Calls a unit bypassing Envoy, from another unit's container or pod, or from the host. |
| Checker | `app/checks.py` | Acts as the client. Counts each unit's requests through their admin ports, so "no unit contacted" is measured, not assumed. |
| Envoy, plain | `envoy/envoy.yaml.tmpl` | Static config for Compose and local dev. Only the authz address differs between the two. |
| Compose | `compose/docker-compose.yaml` | Envoy, stub and units on network `sce0env-net`. Unit app ports are not published. |
| Kubernetes | `k8s/workloads.yaml`, `k8s/gateway.yaml`, `k8s/eg-values.yaml` | Namespace `sce0-envoy`, plus the Gateway API / Envoy Gateway objects and the controller values. |
| Generated xDS | `k8s/eg-generated-xds.json` | What Envoy Gateway turned `k8s/gateway.yaml` into. It is a trimmed `config_dump` and holds no keys. |

**The stub (`app/stub.py`)** behaves like this:

- **Login.** It reads the login from `Authorization: Bearer <login>`, or from the cookie
  `texera_login`. A login in the URL (`access-token` or `token`) is refused with 401.
- **Fake users.** `login-alice` may use units 1001 and 1002. `login-bob` may use 1001 only.
- **Answers.** No valid login gives 401. A path that is not `/(api|wsapi)/units/<digits>/...`, or a
  unit the user may not use, gives 403. Allowed requests get 200 with `Host`, `X-Texera-Unit-Key`,
  `X-Texera-User` and a body of its own.

**The fake unit (`app/unit.py`):**

- **Key.** It refuses (401) any request that does not carry exactly one `X-Texera-Unit-Key` equal
  to its own key.
- **Reporting.** It reports every header it received. Secret header values (`authorization`,
  `cookie`, the unit key) are shown only as sha256 fingerprints.
- **Endpoints.** `/echo` (JSON), `/big` (chunked 4 MiB) and `/watch` (a WebSocket that sends a
  hello, echoes messages and pushes a tick every 1.5 s).

## The routing mechanism, and the alternatives

| Option | Verdict |
|---|---|
| **Answer sets `Host`, dynamic forward proxy cluster resolves it (chosen)** | Works in plain Envoy and in Envoy Gateway. It is the contract upstream Texera's access-control-service already uses (`Response.ok().header("Host", targetHost)`, chart `gateway-backend.yaml` and `gateway-security-policy.yaml`). Unit addresses are DNS names, so the same contract works with container names (Compose), `host.docker.internal:<port>` (local dev) and Service DNS (Kubernetes). The route is not recomputed: the route and cluster stay the same and only the host the cluster connects to changes. |
| `clear_route_cache` / `recomputeRoute: true` | **Not needed, and harmful when the listener names a hostname.** Tested in plain Envoy: virtual host `texera.local` with `clear_route_cache: true` gave **404**. The stub allowed the request, but the re-match used the unit's address as Host and found no virtual host. The same config without recompute reached unit-a. With `domains: ["*"]` recompute was harmless (200). Texera's chart sets a listener hostname whenever `gatewayConfig.hostname` is set, so leave `recomputeRoute` off (the Envoy Gateway default). |
| Answer names a dedicated header (DFP `host_rewrite_header` / Envoy Gateway `HTTPRouteFilter` `urlRewrite.hostname: {type: Header}`) | Available in both, **not tested**. It would keep the public Host until the router. Not chosen, because rewriting `Host` already works everywhere and matches upstream. |
| `original_dst` cluster with `x-envoy-original-dst-host` | Not chosen. It needs an IP:port with no DNS, so the Dashboard would have to track pod and container IPs. Envoy Gateway only exposes it through EnvoyPatchPolicy. |
| One static cluster per unit plus `cluster_header` | Not chosen. Envoy needs a cluster per unit, which means a control plane, or in Kubernetes a Service plus HTTPRoute written for every unit. |

How the two kinds of Envoy differ:

- **Plain Envoy** (`envoy/envoy.yaml.tmpl`) uses the `envoy.filters.http.dynamic_forward_proxy` filter
  together with the DFP cluster.
- **Envoy Gateway** generates only the DFP cluster: `dns_refresh_rate: 30s`, `V4_PREFERRED`, no
  filter. It relies on the cluster resolving hosts itself. Both work.

## Checks

The same checker runs in every mode; each line below is one PASS/FAIL line. "Contacted" is the
change in each unit's own request counter, read from its admin port.

| Check | What must hold |
|---|---|
| `login-missing-refused` | No `Authorization` gives 401 from the stub; no unit contacted. |
| `login-invalid-refused` | Unknown login gives 401; no unit contacted. |
| `login-not-bearer-refused` | `Basic ...` gives 401; no unit contacted. |
| `unit-not-allowed-refused` | bob asking for cuid 1002 gives 403; no unit contacted. |
| `unit-unknown-refused` | cuid 9999 gives 403; no unit contacted. |
| `route-a` / `route-b` | alice asking for 1001 is answered by unit-a only; 1002 by unit-b only. The unit key is not in the client's response. |
| `unit-sees-key-not-login` | The unit sees exactly one `X-Texera-Unit-Key`, and it is the right one, plus `X-Texera-User: alice`. The login appears in no header, path or query. |
| `check-request-has-method-path-query-login` | The stub saw the original method (`POST`), path, query (`alpha=1&beta=two`) and the login. The unit got the same method and query. |
| `authz-cannot-change-body` | The stub's 200 answer has its own body; the unit still got the client's bytes. |
| `fake-unit-address-cannot-redirect` | bob asks for 1001 with unit-b's address in `Host`, `X-Texera-Unit-Address`, `X-Forwarded-Host`, `X-Envoy-Original-Dst-Host` or `Forwarded`. Every request lands on unit-a. Asking for 1002 with B's address stays 403, and nobody is contacted. |
| `fake-unit-key-cannot-impersonate` | A client `X-Texera-Unit-Key` / `X-Texera-User` never reaches the unit (it sees the real key and `user=bob`). A made-up key does not open 1002. `X_Texera_Unit_Key` (underscore spelling) gives 400. |
| `raw-request-tricks-cannot-reach-other-unit` | Raw-socket attempts never reach unit-b: an absolute-form URI naming unit-b; `/1001/../1002`; `/1001/%2e%2e/1002`; `1001%2F..%2F1002` (307 redirect); `//api/units/1002`. |
| `ws-login-missing-refused` / `ws-unit-not-allowed-refused` | A WebSocket upgrade without a login gives 401. bob's upgrade to 1002 gives 403. No unit contacted. |
| `ws-route-a` / `ws-route-b` | The upgrade goes through the same check and routing. At the unit: the right key and no login. |
| `ws-login-in-cookie` | A browser-style upgrade with the login only in a cookie is allowed. The stub saw the cookie; the unit did not. |
| `login-in-url-refused` | `?access-token=` on HTTP and on an upgrade, and `?token=` next to a valid header, all give 401. No unit contacted. |
| `ws-open-both-ways` | The socket is held 17 s, longer than Envoy's 15 s default route timeout. 9 client messages sent and 9 echoed; 11 unit-pushed ticks; still open at the end; close code 1000. |
| `large-response-streams` | 4 MiB chunked from unit-b with a matching sha256. The first byte arrives within 60 ms of a response that takes about 1.1 s in total (6-57 ms across runs and modes), so Envoy streams and does not buffer. |
| `large-request-body-passes` | 3 MiB POST through the check reaches the unit with a matching sha256. |
| `revocation-applies-to-new-requests-only` | After bob's access is revoked, his **open** WebSocket keeps working. A new upgrade and a new HTTP request get 403. This records a limit (see below). |
| `direct-call-without-key-refused-by-unit` | Bypassing Envoy, from unit-b's container or pod, or from the host in local dev: no key, a made-up key, or a user login alone all give 401 from the unit. |
| `authz-down-fails-closed` | Stub stopped. **Plain Envoy:** 403 for HTTP and for the upgrade. **Envoy Gateway:** 500 for HTTP and 403 for the upgrade. No unit contacted in either. |

## Runs

| Run | Start state | Result |
|---|---|---|
| 1 | Clean; controller installed by hand earlier with the same Helm command | 72/72 PASS (24 checks per mode). Added after this run: the revocation check, plus two assertions inside existing checks (unit key not in the client's response; the `X_Texera_Unit_Key` spelling) |
| 2 | Clean, **controller uninstalled** (`helm uninstall eg`) | 75/75 PASS; `run.sh` installed the controller itself |
| 3 | Clean, controller running | 75/75 PASS |
| 4 | Clean, controller running | 75/75 PASS |
| 5 (final, output below) | Clean, controller running; after adding license headers to every file | 75/75 PASS |

After every run there were no `sce0env*` containers, networks, volumes or image, no namespace
`sce0-envoy`, no GatewayClass `sce0-envoy`, no proxy Deployment or Service for it in
`envoy-gateway-system`, no listener on 19520-19539, and no stub, unit or port-forward processes.

### Output of the final run (verbatim)

```
INFO run 2026-11-16T01:15:52Z: docker 29.4.0, compose 5.1.2, orbstack 2.1.3 (2010300), python 3.13.11 aiohttp 3.14.5
INFO [compose] envoy 1.36.4 (envoyproxy/envoy:distroless-v1.36.4)
PASS [compose] login-missing-refused: no Authorization: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] login-invalid-refused: unknown login: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] login-not-bearer-refused: Basic instead of Bearer: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] unit-not-allowed-refused: bob may not use cuid 1002: HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] unit-unknown-refused: no cuid 9999: HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] route-a: cuid 1001 -> HTTP 200 answered by unit-a, contacted {'unit-a': 1, 'unit-b': 0}, unit key in the client's response=False
PASS [compose] route-b: cuid 1002 -> HTTP 200 answered by unit-b, contacted {'unit-a': 0, 'unit-b': 1}, unit key in the client's response=False
PASS [compose] unit-sees-key-not-login: both units got exactly one correct X-Texera-Unit-Key, X-Texera-User=alice, and no Authorization or login anywhere
PASS [compose] check-request-has-method-path-query-login: stub saw POST /api/units/1001/echo?alpha=1&beta=two with the login (match=True), forwarded header names ['authorization', 'content-length', 'host', 'x-envoy-expected-rq-timeout-ms', 'x-envoy-internal']; unit got POST ?alpha=1&beta=two
PASS [compose] authz-cannot-change-body: unit received the client's 21 bytes unchanged although the stub's 200 answer had a body of its own; the check request carried 0 body bytes (body not sent to the stub unless configured)
PASS [compose] fake-unit-address-cannot-redirect: bob asking for cuid 1001 with unit-b's address in Host / X-Texera-Unit-Address / X-Forwarded-Host / X-Envoy-Original-Dst-Host / Forwarded always reached unit-a; cuid 1002 with B's address stayed 403 and contacted nobody
PASS [compose] fake-unit-key-cannot-impersonate: a client X-Texera-Unit-Key / X-Texera-User never reaches the unit (it gets one key, the right one, and user=bob); a made-up key does not open cuid 1002; the X_Texera_Unit_Key spelling -> HTTP 400, contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] raw-request-tricks-cannot-reach-other-unit: absolute-form URI naming unit-b -> 200 contacted {'unit-a': 1, 'unit-b': 0}; dot segments /1001/../1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}; encoded dot segments /1001/%2e%2e/1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}; encoded slashes 1001%2F..%2F1002 -> 307 contacted {'unit-a': 0, 'unit-b': 0}; double slash //api/units/1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] ws-login-missing-refused: no Authorization: upgrade answered HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] ws-unit-not-allowed-refused: bob may not use cuid 1002: upgrade answered HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] ws-route-a: upgrade for cuid 1001 answered by unit-a; at the unit: key ok=True, Authorization present=False, login leaks=[]; contacted {'unit-a': 1, 'unit-b': 0}
PASS [compose] ws-route-b: upgrade for cuid 1002 answered by unit-b; at the unit: key ok=True, Authorization present=False, login leaks=[]; contacted {'unit-a': 0, 'unit-b': 1}
PASS [compose] ws-login-in-cookie: browser-style upgrade with the login only in a cookie: answered by unit-a; stub saw the cookie=True; Cookie at the unit=False; user at the unit='alice'; contacted {'unit-a': 1, 'unit-b': 0}
PASS [compose] login-in-url-refused: ?access-token= on HTTP -> 401, on a WebSocket upgrade -> 401; ?token= next to a valid Authorization -> 401; units contacted {'unit-a': 0, 'unit-b': 0}
PASS [compose] ws-open-both-ways: held 17.3s (longer than Envoy's 15s default route timeout): sent 9, echoed 9, unit pushed 11 ticks (want >= 9); open at the end=True; client close code 1000
PASS [compose] large-response-streams: 4194304 bytes from unit-b, sha256 match=True, first byte after 57 ms of 1087 ms total (streamed, not buffered)
PASS [compose] large-request-body-passes: POST of 3145728 bytes through the check: unit-a got 3145728 bytes, sha256 match=True
PASS [compose] revocation-applies-to-new-requests-only: after revoking bob's use of cuid 1001: his open WebSocket still echoed=True (only the upgrade was checked); a new upgrade -> 403; a new HTTP request -> 403
PASS [compose] direct-call-without-key-refused-by-unit: bypassing Envoy: no key -> 401, made-up key -> 401, user login only -> 401
PASS [compose] authz-down-fails-closed: with the stub stopped: HTTP 403, WebSocket upgrade 403, units contacted {'unit-a': 0, 'unit-b': 0}
INFO [local-dev] envoy 1.36.4 (envoyproxy/envoy:distroless-v1.36.4)
PASS [local-dev] login-missing-refused: no Authorization: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] login-invalid-refused: unknown login: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] login-not-bearer-refused: Basic instead of Bearer: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] unit-not-allowed-refused: bob may not use cuid 1002: HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] unit-unknown-refused: no cuid 9999: HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] route-a: cuid 1001 -> HTTP 200 answered by unit-a, contacted {'unit-a': 1, 'unit-b': 0}, unit key in the client's response=False
PASS [local-dev] route-b: cuid 1002 -> HTTP 200 answered by unit-b, contacted {'unit-a': 0, 'unit-b': 1}, unit key in the client's response=False
PASS [local-dev] unit-sees-key-not-login: both units got exactly one correct X-Texera-Unit-Key, X-Texera-User=alice, and no Authorization or login anywhere
PASS [local-dev] check-request-has-method-path-query-login: stub saw POST /api/units/1001/echo?alpha=1&beta=two with the login (match=True), forwarded header names ['authorization', 'content-length', 'host', 'x-envoy-expected-rq-timeout-ms', 'x-envoy-internal']; unit got POST ?alpha=1&beta=two
PASS [local-dev] authz-cannot-change-body: unit received the client's 21 bytes unchanged although the stub's 200 answer had a body of its own; the check request carried 0 body bytes (body not sent to the stub unless configured)
PASS [local-dev] fake-unit-address-cannot-redirect: bob asking for cuid 1001 with unit-b's address in Host / X-Texera-Unit-Address / X-Forwarded-Host / X-Envoy-Original-Dst-Host / Forwarded always reached unit-a; cuid 1002 with B's address stayed 403 and contacted nobody
PASS [local-dev] fake-unit-key-cannot-impersonate: a client X-Texera-Unit-Key / X-Texera-User never reaches the unit (it gets one key, the right one, and user=bob); a made-up key does not open cuid 1002; the X_Texera_Unit_Key spelling -> HTTP 400, contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] raw-request-tricks-cannot-reach-other-unit: absolute-form URI naming unit-b -> 200 contacted {'unit-a': 1, 'unit-b': 0}; dot segments /1001/../1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}; encoded dot segments /1001/%2e%2e/1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}; encoded slashes 1001%2F..%2F1002 -> 307 contacted {'unit-a': 0, 'unit-b': 0}; double slash //api/units/1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] ws-login-missing-refused: no Authorization: upgrade answered HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] ws-unit-not-allowed-refused: bob may not use cuid 1002: upgrade answered HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] ws-route-a: upgrade for cuid 1001 answered by unit-a; at the unit: key ok=True, Authorization present=False, login leaks=[]; contacted {'unit-a': 1, 'unit-b': 0}
PASS [local-dev] ws-route-b: upgrade for cuid 1002 answered by unit-b; at the unit: key ok=True, Authorization present=False, login leaks=[]; contacted {'unit-a': 0, 'unit-b': 1}
PASS [local-dev] ws-login-in-cookie: browser-style upgrade with the login only in a cookie: answered by unit-a; stub saw the cookie=True; Cookie at the unit=False; user at the unit='alice'; contacted {'unit-a': 1, 'unit-b': 0}
PASS [local-dev] login-in-url-refused: ?access-token= on HTTP -> 401, on a WebSocket upgrade -> 401; ?token= next to a valid Authorization -> 401; units contacted {'unit-a': 0, 'unit-b': 0}
PASS [local-dev] ws-open-both-ways: held 17.3s (longer than Envoy's 15s default route timeout): sent 9, echoed 9, unit pushed 11 ticks (want >= 9); open at the end=True; client close code 1000
PASS [local-dev] large-response-streams: 4194304 bytes from unit-b, sha256 match=True, first byte after 20 ms of 1082 ms total (streamed, not buffered)
PASS [local-dev] large-request-body-passes: POST of 3145728 bytes through the check: unit-a got 3145728 bytes, sha256 match=True
PASS [local-dev] revocation-applies-to-new-requests-only: after revoking bob's use of cuid 1001: his open WebSocket still echoed=True (only the upgrade was checked); a new upgrade -> 403; a new HTTP request -> 403
PASS [local-dev] direct-call-without-key-refused-by-unit: bypassing Envoy: no key -> 401, made-up key -> 401, user login only -> 401
PASS [local-dev] authz-down-fails-closed: with the stub stopped: HTTP 403, WebSocket upgrade 403, units contacted {'unit-a': 0, 'unit-b': 0}
INFO [k8s] envoy gateway: controller already running; docker.io/envoyproxy/gateway:v1.6.3; gateway api CRDs v1.4.1 experimental; kubernetes v1.33.9+orb1; helm v4.2.0+g0646808
INFO [k8s] envoy proxy 1.36.4 (docker.io/envoyproxy/envoy:distroless-v1.36.4)
PASS [k8s] login-missing-refused: no Authorization: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] login-invalid-refused: unknown login: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] login-not-bearer-refused: Basic instead of Bearer: HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] unit-not-allowed-refused: bob may not use cuid 1002: HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] unit-unknown-refused: no cuid 9999: HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] route-a: cuid 1001 -> HTTP 200 answered by unit-a, contacted {'unit-a': 1, 'unit-b': 0}, unit key in the client's response=False
PASS [k8s] route-b: cuid 1002 -> HTTP 200 answered by unit-b, contacted {'unit-a': 0, 'unit-b': 1}, unit key in the client's response=False
PASS [k8s] unit-sees-key-not-login: both units got exactly one correct X-Texera-Unit-Key, X-Texera-User=alice, and no Authorization or login anywhere
PASS [k8s] check-request-has-method-path-query-login: stub saw POST /api/units/1001/echo?alpha=1&beta=two with the login (match=True), forwarded header names ['authorization', 'content-length', 'host', 'x-envoy-expected-rq-timeout-ms', 'x-envoy-internal']; unit got POST ?alpha=1&beta=two
PASS [k8s] authz-cannot-change-body: unit received the client's 21 bytes unchanged although the stub's 200 answer had a body of its own; the check request carried 0 body bytes (body not sent to the stub unless configured)
PASS [k8s] fake-unit-address-cannot-redirect: bob asking for cuid 1001 with unit-b's address in Host / X-Texera-Unit-Address / X-Forwarded-Host / X-Envoy-Original-Dst-Host / Forwarded always reached unit-a; cuid 1002 with B's address stayed 403 and contacted nobody
PASS [k8s] fake-unit-key-cannot-impersonate: a client X-Texera-Unit-Key / X-Texera-User never reaches the unit (it gets one key, the right one, and user=bob); a made-up key does not open cuid 1002; the X_Texera_Unit_Key spelling -> HTTP 400, contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] raw-request-tricks-cannot-reach-other-unit: absolute-form URI naming unit-b -> 200 contacted {'unit-a': 1, 'unit-b': 0}; dot segments /1001/../1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}; encoded dot segments /1001/%2e%2e/1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}; encoded slashes 1001%2F..%2F1002 -> 307 contacted {'unit-a': 0, 'unit-b': 0}; double slash //api/units/1002 -> 403 contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] ws-login-missing-refused: no Authorization: upgrade answered HTTP 401 (want 401), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] ws-unit-not-allowed-refused: bob may not use cuid 1002: upgrade answered HTTP 403 (want 403), units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] ws-route-a: upgrade for cuid 1001 answered by unit-a; at the unit: key ok=True, Authorization present=False, login leaks=[]; contacted {'unit-a': 1, 'unit-b': 0}
PASS [k8s] ws-route-b: upgrade for cuid 1002 answered by unit-b; at the unit: key ok=True, Authorization present=False, login leaks=[]; contacted {'unit-a': 0, 'unit-b': 1}
PASS [k8s] ws-login-in-cookie: browser-style upgrade with the login only in a cookie: answered by unit-a; stub saw the cookie=True; Cookie at the unit=False; user at the unit='alice'; contacted {'unit-a': 1, 'unit-b': 0}
PASS [k8s] login-in-url-refused: ?access-token= on HTTP -> 401, on a WebSocket upgrade -> 401; ?token= next to a valid Authorization -> 401; units contacted {'unit-a': 0, 'unit-b': 0}
PASS [k8s] ws-open-both-ways: held 17.3s (longer than Envoy's 15s default route timeout): sent 9, echoed 9, unit pushed 11 ticks (want >= 9); open at the end=True; client close code 1000
PASS [k8s] large-response-streams: 4194304 bytes from unit-b, sha256 match=True, first byte after 11 ms of 1047 ms total (streamed, not buffered)
PASS [k8s] large-request-body-passes: POST of 3145728 bytes through the check: unit-a got 3145728 bytes, sha256 match=True
PASS [k8s] revocation-applies-to-new-requests-only: after revoking bob's use of cuid 1001: his open WebSocket still echoed=True (only the upgrade was checked); a new upgrade -> 403; a new HTTP request -> 403
PASS [k8s] direct-call-without-key-refused-by-unit: bypassing Envoy: no key -> 401, made-up key -> 401, user login only -> 401
INFO [k8s] with no stub endpoints the SecurityPolicy says: False ExtAuth: no ready endpoints for the related Service sce0-envoy/authz-stub.
PASS [k8s] authz-down-fails-closed: with the stub stopped: HTTP 500, WebSocket upgrade 403, units contacted {'unit-a': 0, 'unit-b': 0}
SUMMARY 75 passed, 0 failed (modes: compose local-dev k8s)
```

## Versions

| Component | Version |
|---|---|
| Envoy (Compose and local dev) | 1.36.4, image `envoyproxy/envoy:distroless-v1.36.4` (build `bad8280d.../1.36.4/Clean/RELEASE/BoringSSL`) |
| Envoy Gateway controller | v1.6.3, image `docker.io/envoyproxy/gateway:v1.6.3`, chart `oci://docker.io/envoyproxy/gateway-helm` v1.6.3 (the version Texera's chart pins) |
| Envoy proxy run by Envoy Gateway | 1.36.4, image `docker.io/envoyproxy/envoy:distroless-v1.36.4` |
| Gateway API CRDs | bundle v1.4.1, experimental channel (shipped with gateway-helm v1.6.3) |
| Kubernetes | v1.33.9+orb1 (OrbStack 2.1.3, single node) |
| Docker / Compose / Helm | 29.4.0 / 5.1.2 / v4.2.0 |
| Stub, units, checker | Python 3.13.17 in the image (`python:3.13.17-alpine3.24`), 3.13.11 on the host; aiohttp 3.14.5 (hash-pinned) |

## Config the real deployment needs

### The Dashboard's check endpoint (all modes)

- **Methods and paths.** Answer every method under a prefix (`/authz/...`). Envoy sends the
  check with the client's method and `prefix + original path + query`. Today's
  `AccessControlResource` handles only GET, POST, PUT and DELETE; a PATCH, HEAD or OPTIONS check
  would get 405, which Envoy passes to the client as a denial.
- **What the check carries.** By default: `authorization`, `content-length`, `host`,
  `x-envoy-expected-rq-timeout-ms` and `x-envoy-internal`, with **no body** (0 bytes). `cookie`
  arrives only when configured: `allowed_headers` in plain Envoy, `headersToExtAuth` in Envoy
  Gateway.
- **Refusing.** Missing or invalid login gives 401; a unit the user may not use gives 403. The
  status and body go to the client. Refuse any login in the URL.
- **Allowing.** Answer 200 with `Host: <unit host:port>`, `X-Texera-Unit-Key` and `X-Texera-User`.
  **Never answer 200 without `Host`.** Envoy would then route by the client's own Host and send
  the unit key along with it (SSRF plus a key leak). The stub always sets it; the real endpoint
  must deny when it has no address.

### Envoy in Compose and local dev (`envoy/envoy.yaml.tmpl`)

- **Connection manager:**
  - `normalize_path: true`, `merge_slashes: true`, `path_with_escaped_slashes_action: UNESCAPE_AND_REDIRECT`
  - `headers_with_underscores_action: REJECT_REQUEST`
  - `upgrade_configs: [websocket]`
  - `early_header_mutation_extensions` that remove `x-texera-unit-key`, `x-texera-unit-address`
    and `x-texera-user`
- **`ext_authz` filter** (HTTP, `failure_mode_allow: false`):
  - `path_prefix: /authz`
  - `allowed_headers: cookie`
  - `allowed_upstream_headers: host, x-texera-unit-key, x-texera-user`
- **Forwarding:** the `dynamic_forward_proxy` filter, then `router`. Routes are prefixes
  `/api/units/` and `/wsapi/units/` to the DFP cluster, with
  `request_headers_to_remove: [authorization, cookie]` and `timeout: 0s`.
- **Compose:** a unit's address is its container name. Units must join a network Envoy is on.
  Units publish no ports.
- **Local dev:** the authz cluster and the unit addresses are `host.docker.internal:<port>`. On
  OrbStack this reaches host processes bound to 127.0.0.1; the run used exactly that.
  **Not tested:** Linux Docker Engine, which needs `--add-host host.docker.internal:host-gateway`
  and cannot reach 127.0.0.1-only host processes.

### Envoy Gateway in Kubernetes (`k8s/gateway.yaml`)

- **Controller:** `config.envoyGateway.extensionApis.enableBackend: true` (`k8s/eg-values.yaml`,
  same as Texera's chart).
- **`Backend`:** `type: DynamicResolver`.
- **`HTTPRoute`:** `PathPrefix` `/api/units` and `/wsapi/units` to that Backend, with filter
  `RequestHeaderModifier remove: [Authorization, Cookie]` and `timeouts.request: "0s"`.
- **`SecurityPolicy` on that HTTPRoute:** `extAuth` with `failOpen: false`,
  `headersToExtAuth: [Cookie]` and `http` set to `{backendRefs: dashboard, path: /authz,
  headersToBackend: [Host, X-Texera-Unit-Key, X-Texera-User]}`.
- **`ClientTrafficPolicy` on the Gateway:** `headers.earlyRequestHeaders.remove:
  [X-Texera-Unit-Key, X-Texera-Unit-Address, X-Texera-User]`.

What Envoy Gateway generated from this (`k8s/eg-generated-xds.json`):

- The ext_authz filter is `disabled: true` on the listener and enabled per route.
- The routes carry `request_headers_to_remove: [Authorization, Cookie]`, `upgrade_configs: websocket`,
  `timeout: 0s` **and `idle_timeout: 0s`**.
- The cluster is `dynamic_forward_proxy` with `per_connection_buffer_limit_bytes: 32768`. That
  limit did not stop 4 MiB responses or 3 MiB uploads.
- On the listener: `normalize_path`, `merge_slashes`, `UNESCAPE_AND_REDIRECT`, `REJECT_REQUEST`
  for underscores, and the early header mutation above.

## What did not work as assumed, and the workarounds

1. **The cluster's Gateway API was broken before this test.** The `gatewayclasses` CRD had been
   `Terminating` since 2026-05-29. Its deletion was blocked by the finalizer
   `gateway-exists-finalizer.gateway.networking.k8s.io` on the stale GatewayClass `eg`, a leftover
   of an old `texera` Helm release, and no controller was running to remove it.
   - **Effect.** No GatewayClass could be created. `helm install` of the controller failed:
     `resource CustomResourceDefinition//gatewayclasses.gateway.networking.k8s.io not ready.
     status: Terminating` (Helm 4 waits for CRDs).
   - **Workaround (as the task allowed).** Removed that finalizer from `eg`. The pending CRD
     deletion then finished within 6 s, and Helm re-created the CRD (bundle v1.4.1, experimental,
     the same as the other Gateway API CRDs here).
   - **Result.** The stale `eg` GatewayClass is gone and the cluster's Gateway API works again.
     The other 19 CRDs were unchanged (`kubectl diff` against the v1.6.3 chart showed no
     difference). `run.sh` now detects this state and reports it instead of hanging.
2. **"Auth service down" looks different in Envoy Gateway.**
   - Plain Envoy fails closed with 403 (`ext_authz.error` counted).
   - When the stub's Service has no ready endpoints, Envoy Gateway marks the SecurityPolicy
     invalid (`ExtAuth: no ready endpoints for the related Service ...`) and replaces the
     targeted routes with a **direct 500**. WebSocket upgrades get **403**, because a
     direct-response route has no upgrade config.
   - Still fail-closed, and no unit is contacted. Clients must treat 500 and 403 on unit routes as
     "try again" while the Dashboard restarts. The Dashboard needs more than one ready replica.
3. **A browser WebSocket cannot send `Authorization`, and today's `?access-token=` would reach the
   unit.** HTTP ext_authz can add, replace and remove headers but not query parameters. (gRPC
   ext_authz has `query_parameters_to_remove`; not tested.)
   - **Workaround, proven in all modes:** the login rides in a cookie. Envoy forwards it to the
     check and strips it before the unit.
   - The Dashboard must refuse a login in the URL; also proven.
   - **Consequence:** the frontend and Dashboard switch the unit WebSocket to a cookie, or to a
     short-lived single-use ticket.
4. **An open WebSocket is never re-checked.** ext_authz checks once per request, and a WebSocket
   is one request. Revoking access stops new requests and upgrades (403) but not an open socket.
   The unit cannot close it on its own either, since it never sees a login. Options:
   - a maximum connection or stream duration on the route;
   - an expiry carried in what Envoy hands the unit, for example a short-lived signed grant from
     the Dashboard instead of a static key, which the unit checks offline.
5. **Timeouts differ between the two kinds of Envoy.** With `timeouts.request: "0s"`, Envoy
   Gateway also sets `idle_timeout: 0s`, so an idle WebSocket is never cut. Plain Envoy with
   `timeout: 0s` keeps the 5 min HCM stream idle timeout. Pick one deliberately; heartbeats make
   either safe. A finite route timeout, which is Envoy's 15 s default, would cut long exports
   and sockets.
6. **The current upstream chart differs from this design in three ways:**
   - `gateway-security-policy.yaml` forwards `x-user-*` answer headers but does not strip
     client-supplied ones early;
   - it does not remove `Authorization` before the unit;
   - `AccessControlResource` accepts the login from `?access-token=`.

   The new design needs the early removal, the route header removal and a cookie-only browser
   login shown here.

## What it means for the plan

- **"Only Envoy connects to a unit"** and **"the Dashboard answers but never calls a unit"** hold
  with one mechanism in all three deployment modes. The Dashboard only answers checks; Envoy does
  the routing and attaches the key.
- **The unit key works as the unit's only gate.** A unit that never sees a login refused every
  call without its key, including one from a neighbouring unit and one carrying a user's login.
  This is what keeps a unit safe in local dev, where any local process can reach its port. In
  Kubernetes, a NetworkPolicy should still limit unit ingress to Envoy.
- **The key stays inside.** It never reached the client, and a client could not inject or replace
  it.
- **Streaming and WebSockets are fine through the check.** Large bodies stream both ways, and an
  open socket outlives the 15 s route timeout.
- **Open design items:**
  - the browser WebSocket login (cookie or ticket);
  - access revocation for open sockets (lifetime cap or expiring grant);
  - Dashboard availability, since every unit request waits on one check: plain Envoy timeout
    2 s here, Envoy Gateway default 10 s.

## Cluster and machine state

- **Left installed, as asked:** the Envoy Gateway controller, Helm release `eg` (chart
  gateway-helm v1.6.3) in namespace `envoy-gateway-system`, with the Backend and EnvoyPatchPolicy
  APIs enabled.
  - Remove it with `helm uninstall eg -n envoy-gateway-system` **before installing the full
    Texera chart**. That chart bundles its own Envoy Gateway as a subchart, and two controllers
    with the same `controllerName` would both reconcile the same GatewayClass.
  - The Gateway API and Envoy Gateway CRDs stay either way (Helm does not delete CRDs).
- **Removed by `run.sh`:** namespace `sce0-envoy`, GatewayClass `sce0-envoy`, the proxy Envoy
  Gateway ran for it, all `sce0env*` containers and networks, the image, and the host processes
  and port-forwards.
- **Found and left alone:** leftovers of the old `texera` release, which are not this test's to
  remove:
  - MutatingWebhookConfiguration `envoy-gateway-topology-injector.texera`. It is harmless:
    `failurePolicy: Ignore`, and it only selects the `texera` namespace.
  - ClusterRole and ClusterRoleBinding `texera-envoy-gateway-certgen:texera`.
