# Step 0 · run-token

**Item:** A token made for one run reaches only that run's namespace in the lake, and stops working once its access is removed.

**Verdict: partially proven.** In the catalog, the claim holds exactly. A run token reads and writes its own namespace (e_42). For every other namespace, Lakekeeper behaves as if it did not exist. Once the Dashboard revokes access (a call of 4–12 ms), the very next request with the same unexpired token is refused. Three things do not match the plan's assumptions; each has a workaround below:

1. **Removing the namespace grant is not enough.** A run *owns* the tables it creates, so it keeps them after the grant is gone. Revoking means deleting the Lakekeeper user too, which removes every grant and ownership the run holds.
2. **Storage credentials outlive the revocation.** Credentials vended through STS before the revocation work until they expire. RustFS will not issue them for less than 900 s. Remote signing has no such window: Lakekeeper stops signing at once.
3. **A run can choose table locations.** A run allowed to create tables can place one at any free path in the warehouse. If it knows an empty namespace's UUID, it can claim that folder, and the namespace can then no longer create tables. This blocks the namespace but leaks no data.

Two settings are required for the claim to hold: OpenFGA's check cache must stay off (with it on, revocation took 3 to 19 s), and managed access must be on for the warehouse (otherwise a run can share its own tables with another run). Operationally, Lakekeeper will not start while the issuer's discovery URL is unreachable.

`run.sh` ran twice from a clean state with the final code: **65/65 PASS** both times. The long mode adds 2 checks (**67/67 PASS**), and the three OpenFGA variants were run as well. Exact outputs are at the end.

## How to run

```
./run.sh                               # ~20 s: up, 65 checks, down
SCE0TOK_WAIT_STS_EXPIRY=1 ./run.sh     # + waits ~15 min for STS expiry and watches the JWKS cache (X1, X2)
SCE0TOK_FGA_CHECK_CACHE=true ./run.sh  # variant: OpenFGA check cache on (E1/E5/E7/G1 fail by design)
SCE0TOK_FGA_CHECK_CACHE=true SCE0TOK_FGA_CACHE_CONTROLLER=true ./run.sh
SCE0TOK_FGA_DATASTORE=memory ./run.sh  # variant: OpenFGA in memory instead of Postgres
SCE0TOK_KEEP=1 ./run.sh                # leave the stack up; ./run.sh --down removes it
```

Each run prints one `PASS`/`FAIL` line per check and writes `results/<stamp>-<variant>.log` and `.json`. The JSON holds every check and every HTTP call: method, templated path, status, and a body summary without values. The containers, network and the locally built issuer image are named `sce0tok-*`. Data lives on tmpfs, so no volume is created. Ports are 127.0.0.1:19500 (Lakekeeper), 19501 (RustFS), 19502 (OpenFGA HTTP, read-only use), 19504 (issuer) and 19505 (second Lakekeeper). Secrets are generated per run into `state/secrets.env` (mode 600), never printed, and deleted at teardown.

| File | What it is |
|---|---|
| `run.sh` | single entry point: preflight, uv venv, secrets, `docker compose up --wait`, checks, teardown |
| `compose.yaml` | Postgres (Lakekeeper DB + OpenFGA DB), OpenFGA, RustFS + init, issuer, Lakekeeper ×2 |
| `issuer/issuer.py`, `issuer/Dockerfile` | the Dashboard stand-in: discovery, JWKS, `/mint` (sub, aud, exp, iss, kid, key, alg, omit), `/rotate` |
| `rustfs/lakekeeper-policy.json` | RustFS IAM policy of the non-root user Lakekeeper vends from (bucket `sce0tok-lake` only) |
| `postgres/init-openfga.sql` | creates OpenFGA's database |
| `runner/run_checks.py`, `runner/lakeproof.py` | the checks (host side, uv venv, `python -I`) |
| `runner/dump_model.py`, `reference/lakekeeper-v0.11.0-openfga-model.txt` | renders the OpenFGA model Lakekeeper writes; the permission names below come from it |
| `results/` | logs and JSON of the runs quoted below |

## Stack and versions

| Component | Version (digest) | Role |
|---|---|---|
| Lakekeeper | `vakamo/lakekeeper:v0.11.0` (sha256:e730a4b0ebde) | Iceberg REST catalog, `LAKEKEEPER__AUTHZ_BACKEND=openfga` |
| OpenFGA | `openfga/openfga:v1.11.2` (sha256:e5891e4676e5) | authorization; Postgres datastore by default |
| Postgres | `postgres:15` (sha256:29342cb52157) | Lakekeeper catalog + OpenFGA tuples |
| RustFS | `rustfs/rustfs:1.0.0` (sha256:8cc980175544), init with `rustfs/rc:v0.1.35` | S3 store with STS AssumeRole |
| Issuer | `python:3.12.14-slim-bookworm` + `cryptography==46.0.7` | OIDC discovery, JWKS, RS256 minting |
| Runner | Python 3.12.12, pyiceberg 0.10.0, pyarrow 26.0.1, boto3 1.40.61 | host side, uv venv |
| Docker | 29.4.0 (OrbStack), compose 5.1.2 | |

Lakekeeper configuration that matters here:

```
LAKEKEEPER__AUTHZ_BACKEND=openfga
LAKEKEEPER__OPENFGA__ENDPOINT=http://sce0tok-openfga:8081        # gRPC port
LAKEKEEPER__OPENID_PROVIDER_URI=http://sce0tok-issuer:8080       # discovery read once at startup
LAKEKEEPER__OPENID_AUDIENCE=texera-lake
LAKEKEEPER__OPENID_SUBJECT_CLAIM=sub                              # user id becomes oidc~<sub>
LAKEKEEPER__ENABLE_KUBERNETES_AUTHENTICATION=false
```

The warehouse storage profile is S3 `flavor: s3-compat`, `path-style-access: true`, `sts-enabled: true`, `sts-token-validity-seconds: 900`, and no role ARN. RustFS accepts any role ARN, and Lakekeeper does not require one for `s3-compat`. The storage credential is a RustFS IAM user limited to the bucket, not the root user. RustFS STS works for such a user. A probe before building the stack showed the effective right is the user's policy intersected with the session policy: credentials from that user, with no session policy, still could not create a bucket.

The runner sits on the host, but Lakekeeper hands out the in-network S3 endpoint (`sce0tok-rustfs:9000`). The runner therefore rewrites only the endpoint of a table's FileIO to `127.0.0.1:19501`. Credentials, paths and signatures are untouched, and for signed requests it sends `Host: sce0tok-rustfs:9000`. This is a property of the test harness, not of the system.

## What was checked

The identities are `texera-dashboard` (bootstrap operator, plays the Dashboard service) and `run-42` (the unit running execution 42). `run-43`, `run-44`, `run-46`, `run-47` and `run-48` appear in specific checks. Each execution namespace `e_<id>` starts with a two-row table `t` created by the Dashboard. run-42 is granted `create` + `modify` on `e_42` only.

**Inside its own namespace (B).** B1 config call, B2 list tables, B3 load + read through vended credentials, B4 append (data files + commit), and B5 create `e_42.run_out`, write it and read it back all pass. B6: a run whose grant was written before Lakekeeper ever saw the identity works too, so the Dashboard can grant before the unit starts.

**Another namespace (C).** With the run token, all of these are refused on `e_43`: load (C1, also through PyIceberg), list tables (C2), create (C3), commit (C4), fetch credentials (C5), rename `e_43.t` into `e_42` (C6), grant itself access through the management API or read e_43's grants (C12), and drop (C13). Listing namespaces returns `[["e_42"]]` (C7). `GET`/`HEAD e_43` answers exactly like a namespace that was never created: `404 NoSuchNamespaceException` (C8). Creating a namespace is refused with `403` (C9). Lakekeeper reports a refusal as 404 "not found or access denied", so a run cannot tell whether e_43 exists.

The run cannot get storage access to e_43's data through a custom location either. Creating an e_42 table located at e_43.t's folder or at e_43's namespace folder fails with `409 LocationAlreadyTaken`, because Lakekeeper refuses any location overlapping an existing table, parent or child. A location at the warehouse root fails with `400 InvalidLocation` (C10a–c). Registering e_43.t's metadata file in e_42 fails with `409` (C11).

**Vended storage credentials (D).** Credentials vended for `e_42.t` put, get and list inside e_42.t's folder (D1). They are refused (`AccessDenied`) on e_43.t's folder (D2), on e_43's namespace folder (D3), on listing the bucket, the warehouse prefix or e_43.t's prefix, and on ListBuckets (D4). They are also refused on a sibling table in the *same* namespace (D5): the scope is one table, not one namespace. The session policy Lakekeeper sent to RustFS was read back from the session token, which RustFS issues as a JWT with `exp`, `parent` and `sessionPolicy` claims (D6):

```json
{"Sid": "TableAccess", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
 "Resource": ["arn:aws:s3:::sce0tok-lake/wh/{ns}/{table}/", "arn:aws:s3:::sce0tok-lake/wh/{ns}/{table}/*"]}
{"Sid": "ListBucketForFolder", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::sce0tok-lake"],
 "Condition": {"StringLike": {"s3:prefix": "wh/{ns}/{table}/*"}}}
```

For a table the run may only read, Lakekeeper vends read-only credentials (P3). With `create` + `select`, a run reads its namespace and writes the tables it creates (P1), but cannot commit to or drop a table it did not create (P2).

**Tokens Lakekeeper must refuse (A).** All of these get `401`: a token expired 120 s ago (A1), one signed by a foreign key under the published kid (A2) or under an unknown kid (A3), `alg: none` (A4), HS256 keyed with the public key (A5), the wrong `aud` (A6), the wrong `iss` (A7), no `exp` (A8), and no `kid` header (A9). A control token gets `200` (A0). During exploration, an `iss` that differed only by a trailing slash was refused as well, and an `aud` list containing `texera-lake` was accepted.

**Remote signing (S).** Lakekeeper signs a GET of e_42.t's metadata file and RustFS serves it (S1). It will not sign e_43.t's files, neither through e_42.t's signer endpoint nor through the warehouse-wide one (S2).

**Revocation (E).** See the next section.

## Revocation: what stops, and how fast

| Step (Dashboard) | Effect on the same unexpired run token | Measured (run A / run B) |
|---|---|---|
| Remove the grant: `POST /management/v1/permissions/namespace/{ns}/assignments {"deletes": [create, modify]}` | e_42.t: load refused (E1), create refused (E2), fresh credentials refused (E3), remote signing refused (E4). **The table the run created stays fully usable** (L4: load 200, commit 200, listed) | call 10.6 / 4.1 ms. The next request was refused on the first try, answered 33.4 / 19.8 ms after the call returned. A concurrent poller loading e_42.t nonstop saw 0 successes among the 36 / 51 requests it started after the call returned; one request that overlapped the call was already refused |
| Delete the user: `DELETE /management/v1/user/oidc~run-42` | everything refused, own tables included: load, commit, list tables, list namespaces, sign (E5). Its ownership tuple is gone (E6) | call 11.8 / 4.2 ms; refused on the first request (14.3 / 10.7 ms) |
| Delete the user only (run-44, grant not removed first) | the grant is gone from `assignments`; load and create refused at once (E7) | call 7.8 / 4.2 ms; refused on the first request (18.6 / 11.0 ms) |
| Delete a user Lakekeeper never saw (run-46) | `404 UserNotFound`, and **its grant stays** (L6); remove it with an explicit `deletes` | — |

Variants (final code, one run each; numbers from their logs):

| OpenFGA setting | E1: grant removed | E5 / E7: user deleted | G1: managed access |
|---|---|---|---|
| Postgres datastore, check cache off (default) | refused on the first request | refused on the first request | effective at once |
| Memory datastore | refused on the first request (7.7 ms) | refused on the first request | effective at once |
| Check cache on, TTL 10 s | still allowed for **19.1 s** (332 tries) | 9.9 s / 10.0 s | **not effective**: the run still shared a table, and run-43 loaded it |
| Check cache + cache controller | still allowed for 3.3 s | 9.5 s / 9.9 s | not effective |

An earlier run of the same two cache variants measured 9.2 s and 3.2 s for E1, and 9.5–10.0 s for E5 and E7. Lakekeeper does not ask OpenFGA for higher consistency, so the check cache delays every revocation, and every grant change, by about the TTL and sometimes about twice the TTL. The cache controller does not fix that. OpenFGA's default is off. The deployment must pin `OPENFGA_CHECK_QUERY_CACHE_ENABLED=false`, or accept a revocation window of up to twice the TTL.

## Storage credentials vended before the revocation

- **They keep working.** After the grant was removed and after the user was deleted, credentials vended earlier still put and get in the table's folder (L5, and the note after E6). STS credentials cannot be recalled. Lakekeeper refuses to *renew* them: the `client.refresh-credentials-endpoint` (`GET …/tables/{t}/credentials`) answers 404 after revocation (E3). So the window is the remaining lifetime of what the run already holds.
- **They stop at their expiry.** In the long run, the pre-revocation credentials were refused at the `exp` in their session token (`exp+0s`; an earlier long run gave `exp+1s`), about 900 s after they were issued. RustFS answers `InvalidRequest` rather than `ExpiredToken` (X1, quoted below).
- **Lifetime.** It is set per warehouse by `sts-token-validity-seconds` in the storage profile. Lakekeeper's default is 3600 s. RustFS clamps the requested `DurationSeconds` to [900, 43200]: asking for 60 gives 900 and asking for 86400 gives 43200. Lakekeeper took every value tried (unset, 60, 900, 43200, 86400) and reported the real expiry to the client in `s3.session-token-expires-at-ms` (L8 and the notes). A probe straight against RustFS gave the same bounds for 1, 10 and 899 s, and 3600 s when no duration is sent. **The shortest possible window on RustFS is 15 minutes.**
- **Lakekeeper caches vended credentials.** A later load of the same table returns the cached credentials while they are valid. During exploration (not part of `run.sh`), a load returned credentials with 3529 s left of 3600. The window after revocation is therefore bounded by those credentials' expiry, which can come sooner than "fetch time + validity" but never later.
- **Remote signing closes the window.** With `X-Iceberg-Access-Delegation: remote-signing`, the client never holds a storage credential. Lakekeeper checks authorization on every signing request and stops signing on the next request after revocation (S1, E4, E5). The cost is one Lakekeeper round trip per S3 request. Texera's current single-node stack already runs with `sts-enabled: false`, that is, remote signing. In pyiceberg 0.10.0 the S3 remote signer exists only in the fsspec FileIO (`pyiceberg/io/fsspec.py`), not in the PyArrow one; Python clients were not exercised with remote signing here.

## What the Dashboard calls

Setup, once per deployment (Dashboard identity):

| Call | Body | Answer |
|---|---|---|
| `POST /management/v1/bootstrap` | `{"accept-terms-of-use": true, "is-operator": true}` | 204; the caller becomes server `operator`, hence `project_admin` of every project and able to create and grant everywhere |
| `POST /management/v1/warehouse` | `warehouse-name`, `storage-profile` (s3, `sts-enabled: true`, `sts-token-validity-seconds: 900`), `storage-credential` | 201 |
| `POST /management/v1/permissions/warehouse/{warehouse_id}/managed-access` | `{"managed-access": true}` | 200; owners can no longer grant (G1) |

Per execution, to grant (`sub` = `run-<execution id>`, used once):

| Call | Body | Answer |
|---|---|---|
| `POST /catalog/v1/{warehouse_id}/namespaces` | `{"namespace": ["e_<id>"]}` | 200; `properties.namespace_id` is the id the next call needs |
| `POST /management/v1/permissions/namespace/{namespace_id}/assignments` | `{"writes": [{"type": "create", "user": "oidc~run-<id>"}, {"type": "modify", "user": "oidc~run-<id>"}]}` (or `select` instead of `modify`, see below) | 204 |
| `POST /management/v1/user` | `{"id": "oidc~run-<id>", "name": "run-<id>", "user-type": "application", "update-if-exists": true}` | 201 the first time, 200 after. Not needed for authorization (B6), but makes the later `DELETE` find the user (L6) |
| mint the run token (no call) | header `{"alg": "RS256", "kid": <current>}`; claims `iss`, `sub: run-<id>`, `aud: texera-lake`, `exp` | — |

Per execution, to revoke (both calls; order does not matter):

| Call | Body | Answer |
|---|---|---|
| `POST /management/v1/permissions/namespace/{namespace_id}/assignments` | `{"deletes": [{"type": "create", "user": "oidc~run-<id>"}, {"type": "modify", "user": "oidc~run-<id>"}]}` | 204 |
| `DELETE /management/v1/user/oidc~run-<id>` | — | 204, or 404 if Lakekeeper never saw the user. Removes every tuple of the user, including ownership of the tables it created |

The Dashboard needs no warehouse-level grant for the run. In Lakekeeper's model, `warehouse.can_get_config = can_get_metadata = describe or can_get_metadata from namespace`: one namespace grant is enough to use the warehouse.

Namespace permission names (Lakekeeper v0.11 OpenFGA model, read from the store), and what the run gets from each:

| Name | Gives on the namespace | Gives on its tables (inherited) |
|---|---|---|
| `describe` | get metadata, list tables | get metadata |
| `select` | describe | `can_read_data` (read-only vended credentials, P3) |
| `create` | `can_create_table`, `can_create_view`, `can_create_namespace` (nested). The creator becomes `ownership` of what it creates (verified for tables) | — |
| `modify` | select; also `can_delete` and `can_update_properties` *of the namespace itself* | `can_commit`, `can_write_data`, `can_drop`, `can_rename` |
| `ownership` | all of the above, plus `manage_grants` unless managed access is on | same |
| `pass_grants`, `manage_grants` | delegation; never give these to a run | same |

By the model, `create` + `modify` (the grant tested above) also lets the run drop tables the Dashboard put in the namespace, and drop the namespace itself; this was not exercised. `create` + `select` (P1–P3) lets the run create tables and fully use them, since it owns them, read everything else, and change nothing it did not create. If the Dashboard creates a table the run must write (for example a log table), it can add `modify` on that table alone: `POST /management/v1/permissions/warehouse/{warehouse_id}/table/{table_id}/assignments`.

## What the issuer must do

Measured against Lakekeeper v0.11.0:

- **Discovery** at `<issuer>/.well-known/openid-configuration` needs only `issuer` and `jwks_uri` (I1). Plain HTTP works. Lakekeeper reads it once, at startup.
- **JWKS**: RSA public keys with `kid`, `n` and `e` (the issuer also sets `use: sig`, `alg: RS256`).
- **Token header**: `alg: RS256`; `none` and HS256 are refused. A `kid` naming a published key is required: no kid, an unknown kid, or a foreign key under a known kid are all refused.
- **Claims**:
  - `sub` is required; the Lakekeeper user id becomes `oidc~<sub>`.
  - `exp` is required, and Lakekeeper accepts a token up to about 60 s after it (L2: 50 s late accepted, 70 s late refused).
  - `iss`, when present, must equal the discovery `issuer` exactly (A7).
  - `aud`, when present, must contain `texera-lake` (A6); a list containing it works (exploration).
  - Missing `aud`, missing `iss`, missing `iat`, and an `nbf` in the future are all **accepted** (L3).
- **Consequence:** the trust anchor is the signing key, not the claims. Any token signed with that key and carrying no `aud` is accepted, including a token minted with `sub: texera-dashboard`, which is the lake's operator. The lake-token key pair must be dedicated: it must not sign the Dashboard's user-session JWTs or anything else. Keep it as secret as the lake's admin credentials.
- **Key rotation:**
  - Publish the new key, then sign with it. Lakekeeper fetches the JWKS when it sees an unknown kid, so new-key tokens are accepted at once and old-key tokens keep working while both keys are published (K1).
  - To retire a key, remove it from the JWKS. **Lakekeeper keeps trusting it until its next JWKS fetch** (L9), and it fetches only when a token with an unknown kid arrives. No periodic refresh happened in 12 minutes (exploration probe), nor in the 872 s of the long run (X2).
  - To make a retirement take effect, present any token with an unknown kid, which forces the fetch (K2), or restart Lakekeeper. This must be part of the response to a leaked key.
- **Load:** Lakekeeper fetches the JWKS on every token with an unknown kid (seen in the issuer's access log during exploration), so the JWKS endpoint must be cheap to serve.
- **Availability:**
  - Lakekeeper fetches the discovery document at startup and **exits** (code 1, within about a second) if it cannot (L10), so it cannot start or restart while the issuer is unreachable.
  - Once running, it keeps accepting tokens signed with a key it has cached while the issuer is down. Only a token with a new kid fails, because the JWKS cannot be fetched (I2).
  - Discovery and JWKS change only at key rotation. Serving them as static files from a replicated endpoint, rather than from the Dashboard process, keeps Lakekeeper independent of the Dashboard's uptime.

## Did not work as assumed, and the workarounds

| Assumption | What happened | Workaround |
|---|---|---|
| Removing the run's namespace grant revokes the run | It keeps `ownership` of every table it created and can still load, commit and list them (L4) | Revoke = delete the grant **and** `DELETE /management/v1/user/oidc~run-<id>` (E5–E7). Provision the user at grant time so the delete always finds it (L6) |
| Revocation stops storage access | STS credentials vended earlier keep working until they expire (L5, X1) | Accept a window of at most `sts-token-validity-seconds` (≥ 900 s on RustFS), or use remote signing (immediate, S1/E4) |
| Credentials can be made short-lived | RustFS will not go below 900 s (L8) | 900 s is the floor; anything shorter needs remote signing |
| A run stays inside its namespace's folder | A run may give a table any free location in the warehouse. It cannot reach existing data (C10, D2–D5), but knowing an empty namespace's location it can claim that folder, and the owner then cannot create tables (L7) | Never leave an execution namespace empty: create it with its first table (the plan), which makes its folder unclaimable (C10b). Never show a unit another namespace's id. Lakekeeper v0.11 has no switch to forbid custom locations; an egress filter or an upstream option would be needed to close it fully |
| A run cannot pass its access on | Without managed access, the owner of a table can grant it to another identity (L1: run-43 then loaded run-42's table) | Turn on managed access for the warehouse at setup (G1) |
| Revocation is immediate | Only with OpenFGA's check cache off; with it on (TTL 10 s), 3–19 s (variants) | Pin `OPENFGA_CHECK_QUERY_CACHE_ENABLED=false` |
| `aud`/`iss` protect the lake from other tokens | Tokens without them are accepted (L3) | Dedicated signing key for lake tokens; always set `iss` and `aud` anyway |
| Removing a key from the JWKS stops it | Lakekeeper caches the key set until an unknown kid arrives (L9, X2) | Force a refetch (unknown-kid token) or restart Lakekeeper when retiring a key |
| The issuer only matters when a token is checked | Lakekeeper reads the discovery document at startup and exits without it (L10) | Serve discovery + JWKS as static files from a replicated endpoint; Lakekeeper then starts without the Dashboard. A running Lakekeeper is unaffected by an issuer outage until a key changes (I2) |

## What this means for the plan

- **Access control lives in the catalog, keyed by a per-run identity.** The Dashboard mints one token per run (`sub: run-<execution id>`, never reused), grants `create` + `select` (or `modify`) on that execution's namespace, and revokes by removing that grant and deleting the user. Each is one or two management calls of a few milliseconds. The Dashboard never needs to reach the unit.
- **The token can live as long as the run.** Revocation does not depend on expiry, and a unit "calls no service" except the lake, so it cannot fetch a new token mid-run. Set `exp` to the run's maximum duration. The unit renews *storage* credentials itself through Lakekeeper's credentials endpoint, which is authorization-checked.
- **Storage revocation needs a decision.** Vended STS credentials (fast, standard in Iceberg clients) leave a window of up to 15 minutes after revocation. Remote signing (immediate, already Texera's current mode) costs a Lakekeeper round trip per object request and, in Python, the fsspec FileIO. Either way the reach is one table's folder, never another namespace's data.
- **Network rules for the unit.** OpenFGA has no authentication in this setup: the runner read its model without credentials, and anyone who reaches that API could write tuples. Anyone who reaches Postgres or RustFS's admin API could do worse. A unit may reach only Lakekeeper's REST API and the S3 data path. The issuer's minting endpoint, and the signing key it uses, must stay with the Dashboard.
- **Lakekeeper's own deployment.** Bootstrap with the Dashboard identity as operator, turn on managed access per warehouse, keep OpenFGA's check cache off, use a non-root RustFS user for vending, and create every execution namespace together with its first table. Serve the issuer's discovery document and JWKS from somewhere that is up whenever Lakekeeper may restart.

## Exact outputs

The two default runs used the final scripts. The long run and the three variants used the same scripts, except for the last change to `run.sh`, a one-line fix that only affects `./run.sh --down`.

### Default, run A: complete console output

`results/20261116T014324Z-default.log` (the log file also holds the compose output; the `.json` next to it holds every check and call).

```
01:43:24 run-token proof, log results/20261116T014324Z-default.log
versions:
  docker 29.4.0 (OrbStack), compose 5.1.2
  vakamo/lakekeeper:v0.11.0 sha256:e730a4b0ebde
  openfga/openfga:v1.11.2 sha256:e5891e4676e5
  rustfs/rustfs:1.0.0 sha256:8cc980175544
  rustfs/rc:v0.1.35 sha256:adb45b565390
  postgres:15 sha256:29342cb52157
  python:3.12.14-slim-bookworm sha256:392307d22300
  runner: python 3.12.12, pyiceberg 0.10.0, pyarrow 26.0.1, boto3 1.40.61
01:43:25 starting the stack
01:43:37 stack healthy after 12s; RustFS init: rustfs-init: bucket sce0tok-lake and user for Lakekeeper ready
CONFIG openfga datastore=postgres, openfga check cache=false, cache controller=false, warehouse sts-token-validity-seconds=900, wait for STS expiry=False
SETUP ok   issuer discovery reachable
SETUP ok   Lakekeeper accepts the Dashboard's token -- Lakekeeper 0.11.0, authz openfga
SETUP ok   bootstrap: the Dashboard identity becomes the server operator -- 204
SETUP ok   warehouse 'lake' on RustFS with STS vending (validity 900s) -- 201
SETUP ok   namespaces e_42 and e_43, each with a 2-row table t
SETUP ok   grant oidc~run-42 'create' + 'modify' on namespace e_42 only -- 204
SETUP ok   provision user oidc~run-42 in Lakekeeper -- 201
PASS  B1   run token gets the catalog config for the warehouse
PASS  B2   run token lists the tables of e_42 -- 200 ['t']
PASS  B3   run token loads e_42.t and reads its data through vended credentials -- rows=2
PASS  B4   run token appends to e_42.t (data files + commit) -- rows=3
PASS  B5   run token creates e_42.run_out, writes it and reads it back -- rows=2
PASS  C1   run token cannot load e_43.t -- 404 NoSuchTableException
PASS  C1b  PyIceberg load of e_43.t fails for the run -- NoSuchTableError
PASS  C2   run token cannot list the tables of e_43 -- 404 NoSuchNamespaceException
PASS  C3   run token cannot create a table in e_43 -- 404 NoSuchNamespaceException
PASS  C4   run token cannot commit to e_43.t -- 404 NoSuchTableException
PASS  C5   run token cannot get storage credentials for e_43.t -- 404 NoSuchTableException
PASS  C6   run token cannot rename e_43.t into e_42 -- 404 NoSuchTableException
PASS  C7   listing namespaces with the run token shows e_42 and not e_43 -- 200 [['e_42']]
PASS  C8   e_43 looks exactly like a namespace that does not exist -- GET e_43 404 NoSuchNamespaceException, GET e_99 404 NoSuchNamespaceException, HEAD e_43 404
PASS  C9   run token cannot create a namespace outside e_42 -- 403 WarehouseActionForbidden
PASS  C10a run cannot create an e_42 table located at e_43.t's folder -- 409 LocationAlreadyTaken
PASS  C10b run cannot create an e_42 table located at e_43's namespace folder (it holds e_43.t) -- 409 LocationAlreadyTaken
PASS  C10c run cannot create an e_42 table located at the warehouse root -- 400 InvalidLocation
PASS  C11  run cannot register e_43.t's metadata file as a table in e_42 -- 409 AlreadyExistsException
PASS  C12  run token cannot grant itself access to e_43 or read e_43's grants -- grant 401 Unauthorized, read grants 403 ActionForbidden
PASS  C13  run token cannot drop e_43.t -- 404 NoSuchTableException
PASS  D1   e_42.t credentials write, read and list e_42.t's folder -- put ALLOWED, get ALLOWED, list-own-prefix ALLOWED
PASS  D2   e_42.t credentials are refused on e_43.t's folder -- get metadata DENIED(AccessDenied), put DENIED(AccessDenied)
PASS  D3   e_42.t credentials are refused on e_43's namespace folder -- DENIED(AccessDenied)
PASS  D4   e_42.t credentials cannot list the bucket, the warehouse prefix, e_43's folder or the buckets -- bucket DENIED(AccessDenied), wh/ DENIED(AccessDenied), e_43.t/ DENIED(AccessDenied), ListBuckets DENIED(AccessDenied)
PASS  D5   e_42.t credentials are refused on a sibling table (e_42.run_out): scope is one table -- DENIED(AccessDenied)
PASS  D6   the STS session policy Lakekeeper requested names only e_42.t's prefix -- parent=lakekeeper resources=['arn:aws:s3:::sce0tok-lake/{e_42.t}/', 'arn:aws:s3:::sce0tok-lake/{e_42.t}/*', 'arn:aws:s3:::sce0tok-lake']
NOTE  vended credential lifetime -- session token exp in 897s, Lakekeeper's s3.session-token-expires-at-ms in 897s (warehouse sts-token-validity-seconds=900)
PASS  L1   limit: without managed access, the run can share a table it created with another run -- run-42 grants select on e_42.run_out to run-43: 204; run-43 loads it: 200
SETUP ok   Dashboard turns on managed access for the warehouse -- 200
PASS  G1   with managed access on, the run cannot share its tables -- grant: 401 Unauthorized; run-43 load: 404 NoSuchTableException
PASS  A0   control: a fresh run token reaches the catalog -- 200
PASS  A1   an expired run token (exp 120 s ago) is refused -- 401
PASS  A2   a token signed by a different key under the published kid is refused -- 401
PASS  A3   a token signed by a different key under an unknown kid is refused -- 401
PASS  A4   an unsigned token (alg none) is refused -- 401
PASS  A5   an HS256 token keyed with the public key (algorithm confusion) is refused -- 401
PASS  A6   a token for another audience is refused -- 401
PASS  A7   a token from another issuer is refused -- 401
PASS  A8   a token without exp is refused -- 401
PASS  A9   a token without a kid header is refused -- 401
PASS  L2   limit: Lakekeeper still accepts a token up to about 60 s after its exp (clock leeway) -- exp 10s ago -> 200, exp 50s ago -> 200, exp 70s ago -> 401, exp 90s ago -> 401
PASS  L3   limit: a token with no aud or no iss claim is accepted, and nbf is not checked -- no aud claim -> 200, no iss claim -> 200, nbf 10 min ahead -> 200, no iat -> 200
PASS  S1   remote signing: Lakekeeper signs a read of e_42.t's metadata and RustFS serves it -- sign 200, GET 200
PASS  S2   remote signing: Lakekeeper will not sign a read of e_43.t's files for the run -- via e_42.t's signer endpoint 404 NoSuchTableException, via the warehouse signer endpoint 404 NoSuchTableException
SETUP ok   Dashboard removes run-42's grant on e_42 -- 204 in 10.6 ms
PASS  E1   right after the grant is removed, the same unexpired run token is refused on e_42.t -- revoke call 10.6 ms; next request refused on the first request (404 NoSuchTableException, 33.4 ms); concurrent poller: 80 ok before the call, statuses during it [200, 404], 36 refused and 0 ok among requests started after it
PASS  E2   after the grant is removed, the run cannot create tables in e_42 -- 403 NamespaceActionForbidden
PASS  E3   after the grant is removed, the run cannot fetch fresh credentials for e_42.t -- 404 NoSuchTableException
PASS  E4   after the grant is removed, Lakekeeper stops signing requests for e_42.t -- 404 NoSuchTableException
PASS  L4   limit: after the grant is removed, the run still loads and commits the table it created (it owns it) -- load run_out 200, commit run_out 200, list e_42 200 ['run_out']
PASS  L5   limit: storage credentials vended before the revocation keep working after it (until they expire) -- get ALLOWED, put ALLOWED; they expire in 896s
SETUP ok   Dashboard deletes user oidc~run-42 -- 204 in 11.8 ms
PASS  E5   right after the user is deleted, the same token is refused on everything in e_42, its own tables included -- load run_out: refused on the first request (404 NoSuchTableException, 14.3 ms); then commit 404 NoSuchTableException, list e_42 404 NoSuchNamespaceException, list namespaces 404 WarehouseNotFound, sign 404 WarehouseNotFound
PASS  E6   deleting the user removed its ownership of e_42.run_out -- 200 []
NOTE  credentials vended for e_42.run_out before the user deletion -- put after deletion: ALLOWED
SETUP ok   grant oidc~run-44 on e_44 without provisioning the user -- 204
PASS  B6   a run granted before Lakekeeper ever saw it reads its namespace (no provisioning needed) -- rows=2
PASS  E7   deleting the user alone also removes its namespace grant; the same token is refused at once -- delete 204 in 7.8 ms; load e_44.t: refused on the first request (404 NoSuchTableException, 18.6 ms); create 404 NoSuchNamespaceException; grants left []
PASS  L6   limit: deleting a user Lakekeeper never saw does not remove its grants (revoke must delete them explicitly) -- grant 204; delete user 404 UserNotFound; grants left [{'type': 'select', 'user': 'oidc~run-46'}]
NOTE  explicit grant removal for the never-seen user -- 204
SETUP ok   grant oidc~run-48 'create' + 'select' on e_42 (the narrower alternative) -- 204
PASS  P1   with 'create' + 'select', a run reads the namespace and writes the tables it creates -- rows e_42.t=3, e_42.r48=1
PASS  P2   with 'create' + 'select', the run cannot change or drop a table it did not create -- commit e_42.t 403 TableActionForbidden, drop e_42.t 403 TableActionForbidden
PASS  P3   for a table the run may only read, Lakekeeper vends read-only storage credentials -- get ALLOWED, put DENIED(AccessDenied), policy actions ['s3:GetObject', 's3:ListBucket']
PASS  L7   limit: a run that knows an empty namespace's location can claim it with a custom table location; that namespace then cannot create tables -- run creates e_42.squat at e_45's folder: 200; Dashboard creates e_45.t: 409 LocationAlreadyTaken
NOTE  STS lifetime for sts-token-validity-seconds=unset -- warehouse create 201, credentials really expire in 3599s, Lakekeeper tells the client 3599s
NOTE  STS lifetime for sts-token-validity-seconds=60 -- warehouse create 201, credentials really expire in 899s, Lakekeeper tells the client 899s
NOTE  STS lifetime for sts-token-validity-seconds=900 -- warehouse create 201, credentials really expire in 899s, Lakekeeper tells the client 899s
NOTE  STS lifetime for sts-token-validity-seconds=43200 -- warehouse create 201, credentials really expire in 43199s, Lakekeeper tells the client 43199s
NOTE  STS lifetime for sts-token-validity-seconds=86400 -- warehouse create 201, credentials really expire in 43199s, Lakekeeper tells the client 43199s
PASS  L8   limit: vended credentials cannot be shorter than 900 s on RustFS (asking for 60 s gives 900 s) -- asked 60 s, got 899s
PASS  I1   a Lakekeeper whose issuer's discovery document holds only issuer + jwks_uri accepts that issuer's tokens, and refuses tokens naming the other issuer -- iss=/minimal -> 200, iss=root issuer -> 401
PASS  L10  limit: Lakekeeper does not start when the issuer's discovery URL cannot be reached -- exit code 1 after 0.4s: Error: Failed to fetch openid configuration from http://sce0tok-no-such-issuer:8080/.well-known/openid-configuration: error sending request for url (http://sce0
PASS  K1   after the issuer adds a new key, tokens signed with it are accepted at once and old ones still work -- new kid -> 200, old kid -> 200
PASS  L9   limit: a key the issuer stopped publishing is still trusted until Lakekeeper refetches the JWKS -- old-kid token right after retirement -> 200
PASS  K2   once Lakekeeper refetches the JWKS (any unknown kid triggers it), the retired key is refused -- unknown-kid token 401, then old-kid token 401, current-kid token 200
PASS  I2   with the issuer stopped, a running Lakekeeper still accepts tokens signed with a cached key -- cached kid -> 200, unknown kid -> 401
CALLS made by the Dashboard identity (method, path, status, body summary):
CALL  GET    /management/v1/info                                                                  200 
CALL  POST   /management/v1/bootstrap                                                             204 keys=accept-terms-of-use,is-operator,user-name,user-type
CALL  POST   /management/v1/warehouse                                                             201 keys=storage-credential,storage-profile,warehouse-name
CALL  POST   /catalog/v1/{warehouse_id}/namespaces                                                200 keys=namespace
CALL  POST   /management/v1/permissions/namespace/{e_42_id}/assignments                           204 writes=[create:oidc~run-42, modify:oidc~run-42]
CALL  POST   /management/v1/user                                                                  201 keys=id,name,update-if-exists,user-type
CALL  POST   /management/v1/permissions/warehouse/{warehouse_id}/table/{e_42.run_out_id}/assignments 204 deletes=[select:oidc~run-43]
CALL  POST   /management/v1/permissions/warehouse/{warehouse_id}/managed-access                   200 managed-access=True
CALL  POST   /management/v1/permissions/namespace/{e_42_id}/assignments                           204 deletes=[create:oidc~run-42, modify:oidc~run-42]
CALL  DELETE /management/v1/user/oidc~run-42                                                      204 
CALL  GET    /management/v1/permissions/warehouse/{warehouse_id}/table/{e_42.run_out_id}/assignments 200 
CALL  POST   /management/v1/permissions/namespace/{e_44_id}/assignments                           204 writes=[create:oidc~run-44, modify:oidc~run-44]
CALL  DELETE /management/v1/user/oidc~run-44                                                      204 
CALL  GET    /management/v1/permissions/namespace/{e_44_id}/assignments                           200 
CALL  POST   /management/v1/permissions/namespace/{e_44_id}/assignments                           204 writes=[select:oidc~run-46]
CALL  DELETE /management/v1/user/oidc~run-46                                                      404 
CALL  POST   /management/v1/permissions/namespace/{e_44_id}/assignments                           204 deletes=[select:oidc~run-46]
CALL  POST   /management/v1/permissions/namespace/{e_42_id}/assignments                           204 writes=[create:oidc~run-48, select:oidc~run-48]
CALL  POST   /management/v1/permissions/namespace/{e_42_id}/assignments                           204 deletes=[create:oidc~run-48, select:oidc~run-48]
CALL  DELETE /management/v1/user/oidc~run-48                                                      204 
CALL  POST   /management/v1/permissions/namespace/{e_42_id}/assignments                           204 writes=[create:oidc~run-47]
CALL  POST   /catalog/v1/{warehouse_id}/namespaces/e_45/tables                                    409 keys=name,schema
CALL  POST   /catalog/v1/{uuid}/namespaces                                                        200 keys=namespace
CALL  POST   /catalog/v1/{uuid}/namespaces/n/tables                                               200 keys=name,schema
REPORT results/20261116T014324Z-default.json
SUMMARY 65 checks: 65 PASS, 0 FAIL
01:43:44 checks finished with exit code 0
01:43:44 tearing down
01:43:45 teardown done: 0 containers, 0 networks, 0 volumes named sce0tok* left
```

### Default, run B

`results/20261116T014345Z-default.log`: the same 65 checks with the same outcomes. A diff of the two outputs with every number blanked out shows no difference. The lines that carry timings, and the summary:

```
01:43:45 run-token proof, log results/20261116T014345Z-default.log
01:43:58 stack healthy after 12s; RustFS init: rustfs-init: bucket sce0tok-lake and user for Lakekeeper ready
SETUP ok   Dashboard removes run-42's grant on e_42 -- 204 in 4.1 ms
PASS  E1   right after the grant is removed, the same unexpired run token is refused on e_42.t -- revoke call 4.1 ms; next request refused on the first request (404 NoSuchTableException, 19.8 ms); concurrent poller: 144 ok before the call, statuses during it [200, 404], 51 refused and 0 ok among requests started after it
SETUP ok   Dashboard deletes user oidc~run-42 -- 204 in 4.2 ms
PASS  E5   right after the user is deleted, the same token is refused on everything in e_42, its own tables included -- load run_out: refused on the first request (404 NoSuchTableException, 10.7 ms); then commit 404 NoSuchTableException, list e_42 404 NoSuchNamespaceException, list namespaces 404 WarehouseNotFound, sign 404 WarehouseNotFound
PASS  E7   deleting the user alone also removes its namespace grant; the same token is refused at once -- delete 204 in 4.2 ms; load e_44.t: refused on the first request (404 NoSuchTableException, 11.0 ms); create 404 NoSuchNamespaceException; grants left []
PASS  L10  limit: Lakekeeper does not start when the issuer's discovery URL cannot be reached -- exit code 1 after 0.2s: Error: Failed to fetch openid configuration from http://sce0tok-no-such-issuer:8080/.well-known/openid-configuration: error sending request for url (http://sce0
SUMMARY 65 checks: 65 PASS, 0 FAIL
01:44:04 teardown done: 0 containers, 0 networks, 0 volumes named sce0tok* left
```

### Long mode (`SCE0TOK_WAIT_STS_EXPIRY=1`)

`results/20261116T012738Z-default-long.log`: the same 65 checks with the same outcomes, plus X1 and X2. Its CONFIG, the wait, the long-mode checks, I2 (which runs last), and the summary:

```
01:27:38 run-token proof, log results/20261116T012738Z-default-long.log
CONFIG openfga datastore=postgres, openfga check cache=false, cache controller=false, warehouse sts-token-validity-seconds=900, wait for STS expiry=True
PASS  L10  limit: Lakekeeper does not start when the issuer's discovery URL cannot be reached -- exit code 1 after 0.6s: Error: Failed to fetch openid configuration from http://sce0tok-no-such-issuer:8080/.well-known/openid-configuration: error sending request for url (http://sce0
NOTE  waiting for the pre-revocation credentials to expire -- in 895s
PASS  X1   the credentials vended before the revocation stop working when they expire -- DENIED(InvalidRequest) at exp+0s
PASS  X2   limit: with no unknown kid to trigger a refetch, Lakekeeper kept trusting a retired key for the whole wait -- retired-key token still accepted 872s after retirement
PASS  I2   with the issuer stopped, a running Lakekeeper still accepts tokens signed with a cached key -- cached kid -> 200, unknown kid -> 401
SUMMARY 67 checks: 67 PASS, 0 FAIL
01:42:55 checks finished with exit code 0
01:42:56 teardown done: 0 containers, 0 networks, 0 volumes named sce0tok* left
```

### Variant: OpenFGA check cache on (TTL 10 s)

`results/20261116T012524Z-fga-check-cache.log`: CONFIG, every FAIL, the revocation lines, and the summary.

```
CONFIG openfga datastore=postgres, openfga check cache=true, cache controller=false, warehouse sts-token-validity-seconds=900, wait for STS expiry=False
FAIL  G1   with managed access on, the run cannot share its tables -- grant: 204; run-43 load: 200
FAIL  E1   right after the grant is removed, the same unexpired run token is refused on e_42.t -- revoke call 2.2 ms; next request first request still answered 200; refused only after 19.1 s (332 attempts); concurrent poller: 278 ok before the call, statuses during it [200], 309 refused and 9442 ok among requests started after it
FAIL  E5   right after the user is deleted, the same token is refused on everything in e_42, its own tables included -- load run_out: first request still answered 200; refused only after 9.9 s (160 attempts); then commit 404 NoSuchTableException, list e_42 404 NoSuchNamespaceException, list namespaces 404 WarehouseNotFound, sign 404 WarehouseNotFound
FAIL  E7   deleting the user alone also removes its namespace grant; the same token is refused at once -- delete 204 in 4.7 ms; load e_44.t: first request still answered 200; refused only after 10.0 s (158 attempts); create 404 NoSuchNamespaceException; grants left []
SUMMARY 65 checks: 61 PASS, 4 FAIL
```

### Variant: OpenFGA check cache + cache controller

`results/20261116T012624Z-fga-check-cache-controller.log`: CONFIG, every FAIL, the revocation lines, and the summary.

```
CONFIG openfga datastore=postgres, openfga check cache=true, cache controller=true, warehouse sts-token-validity-seconds=900, wait for STS expiry=False
FAIL  G1   with managed access on, the run cannot share its tables -- grant: 204; run-43 load: 200
FAIL  E1   right after the grant is removed, the same unexpired run token is refused on e_42.t -- revoke call 2.8 ms; next request first request still answered 200; refused only after 3.3 s (58 attempts); concurrent poller: 314 ok before the call, statuses during it [200], 332 refused and 1759 ok among requests started after it
FAIL  E5   right after the user is deleted, the same token is refused on everything in e_42, its own tables included -- load run_out: first request still answered 200; refused only after 9.5 s (151 attempts); then commit 404 NoSuchTableException, list e_42 404 NoSuchNamespaceException, list namespaces 404 WarehouseNotFound, sign 404 WarehouseNotFound
FAIL  E7   deleting the user alone also removes its namespace grant; the same token is refused at once -- delete 204 in 5.1 ms; load e_44.t: first request still answered 200; refused only after 9.9 s (158 attempts); create 404 NoSuchNamespaceException; grants left []
SUMMARY 65 checks: 61 PASS, 4 FAIL
```

### Variant: OpenFGA memory datastore

`results/20261116T012706Z-fga-memory.log`: CONFIG, every FAIL, the revocation lines, and the summary.

```
CONFIG openfga datastore=memory, openfga check cache=false, cache controller=false, warehouse sts-token-validity-seconds=900, wait for STS expiry=False
PASS  E1   right after the grant is removed, the same unexpired run token is refused on e_42.t -- revoke call 4.0 ms; next request refused on the first request (404 NoSuchTableException, 7.7 ms); concurrent poller: 145 ok before the call, statuses during it [200], 85 refused and 0 ok among requests started after it
PASS  E5   right after the user is deleted, the same token is refused on everything in e_42, its own tables included -- load run_out: refused on the first request (404 NoSuchTableException, 7.6 ms); then commit 404 NoSuchTableException, list e_42 404 NoSuchNamespaceException, list namespaces 404 WarehouseNotFound, sign 404 WarehouseNotFound
PASS  E7   deleting the user alone also removes its namespace grant; the same token is refused at once -- delete 204 in 3.0 ms; load e_44.t: refused on the first request (404 NoSuchTableException, 7.7 ms); create 404 NoSuchNamespaceException; grants left []
SUMMARY 65 checks: 65 PASS, 0 FAIL
```
