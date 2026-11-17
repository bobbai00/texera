# sce-e2e: a full-stack acceptance harness for Texera

This harness starts the whole Texera stack in single-node mode on this Mac as an
isolated Docker Compose project named `sce`. It then runs real workflows end to
end through the gateway and asserts their results. It is the acceptance check
for each step of the self-contained-engine refactor: build the step's images, run
the harness, and every scenario must pass.

```
./run-baseline.sh --reset            # published images, clean volumes, all scenarios, then down
images/build.sh <worktree> step1     # branch images sce/texera-*:step1 (thin layers on the published ones)
./run-baseline.sh --reset --images sce/step1

# step 2 (the Dashboard creates executions; the unit starts them without Postgres reads)
./run-baseline.sh --images sce/<tag> --pg-statement-log -- --gate A        # PR A
./run-baseline.sh --images sce/<tag> --pg-statement-log -- --gate B
./run-baseline.sh --images sce/<tag> --pg-statement-log --isolate-unit -- --gate C
./run-negative-control.sh            # published images: Checks A, D and F must fail
.venv/bin/python -m unittest discover -s driver/tests   # offline: transports and scenarios vs a fake

# local-dev mode (bin/local-dev.sh's way: infra in Docker, JVMs on the host, ng serve's proxy)
./run-localdev.sh --lock <scratchpad>/sce/stack.lock --reset   # see "Local-dev mode" below
```

Every stack run shares one Docker VM with other agents' work: take the stack lock
first (see "One run at a time" under Notes).

Python comes from a uv-managed venv at `.venv` (created on first use from
`requirements.txt`). Docker is OrbStack's engine.

## Layout

| Path | What it is |
|---|---|
| `stack/sce-stack.sh` | Generates and drives the isolated stack: `generate`, `up`, `down`, `reset`, `status`, `logs` |
| `stack/sce_stack.py` | The generator and controller behind it |
| `stack/generated/` | Output: `docker-compose.yml`, `.env`, `nginx.conf`, `sql/`, `MANIFEST.json`. Regenerated on every `up` |
| `images/build.sh` | Builds branch images from a worktree (`sbt dist`, optional frontend), as thin layers on the published images |
| `build/<tag>/` | Scratch build contexts and `BUILD-MANIFEST.json` (outside any repo) |
| `driver/` | The e2e driver: `e2e.py` (CLI), `transport.py` (start, watch and control a run), `texera_api.py` (REST setup), `workflow.py` (plan builders), `scenarios.py`, `evidence.py` (the step-2 Checks A-F), `data/*.csv` |
| `driver/tests/` | Offline tests: `fake_texera.py` (a fake Texera speaking the step-2 design's protocol), `test_transport.py`, `test_scenarios.py`, `test_evidence.py` (a fake `docker` and a synthetic Postgres log), `test_scenario_evidence.py` (scenarios and evidence together on the fake stack) |
| `run-baseline.sh` | `up`, then wait until healthy, run the driver, print results, then `down` unless `--keep` |
| `run-negative-control.sh` | The step-2 negative control (H5) on the published images |
| `stack/localdev-stack.sh`, `stack/localdev/localdev_stack.py` | Local-dev mode: local-dev's infrastructure (renamed, shifted ports), its schema step, the JVM services as host processes, `ng serve`; `generate`, `build`, `up`, `down`, `reset`, `status`, `logs`, `post-run`, `venv` |
| `driver/localdev_unit.py` | The driver's local-dev mode (`--target localdev`): the dev server as `--base`, local-dev's local unit |
| `run-localdev.sh` | Local-dev mode end to end: lock, clean start, `up`, the driver, `post-run`, `down` |
| `reports/` | JSON reports, one per driver run |

## The stack: `stack/sce-stack.sh`

```
stack/sce-stack.sh [--source <worktree>] up [--images <registry>/<tag>] [--timeout S] [--with-optional] [--bind IP]
                   [--pg-statement-log] [--isolate-unit] [--with-replay-log] [--unit-env KEY=VAL ...]
stack/sce-stack.sh down       # stop and remove containers and the network; keep the volumes
stack/sce-stack.sh reset      # down, then delete only the sce_* volumes
stack/sce-stack.sh status [--json]
stack/sce-stack.sh logs <service|container|alias> [--tail N] [-f]   # aliases: unit, dashboard, gateway, cu-manager, compiler, files
stack/sce-stack.sh generate   # write stack/generated/ only
```

Environment knobs:

| Variable | Effect |
|---|---|
| `SCE_SOURCE` | Default `--source` |
| `SCE_BIND` | Default `--bind` |
| `SCE_UP_TIMEOUT` | Seconds `up` waits; default 900 |
| `SCE_PULL` | `missing` (default), `never` or `always`. The default never re-pulls an image that is already present, so the "published" baseline stays the locally pulled one |

Options for the step-2 evidence checks (design section 7 H2). Each is off by
default, the generator's round-trip check verifies exactly the edit it makes, and
`MANIFEST.json` records them under `options` (values of keys that look like
secrets are masked):

| Option | Effect |
|---|---|
| `--pg-statement-log` | Postgres runs with `log_statement=all` and `log_line_prefix=%m [%p] app=%a db=%d host=%h ` (the compose service has no command upstream; the generator refuses a source whose service has one). Extended-protocol statements log their values on the following `DETAIL:  parameters: $1 = '...'` line of the same pid. It also sets the unit's `WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS=2` (unless `--unit-env` sets it), so the driver's wait for an idle workflow's cleanup (see Evidence) stays short |
| `--isolate-unit` | A second network, `sce-unit-net` (not `internal`: pip needs the package index). The unit is attached only to it; Postgres, Lakekeeper, RustFS and nginx (and agent-service when kept) are on both networks with all their aliases. The unit cannot resolve `file-service`, `texera-lakefs`, `dashboard-service` or `access-control-service`. A network check after generation proves the attachments. It also turns nginx's access log on (`options.gateway_access_log`): the source's one `access_log off;` becomes `sce-access $remote_addr "$request_method $uri" $status` on stdout (`$uri` has no query string, so no websocket token is logged), because the isolated unit still reaches nginx, which proxies file-service and the Dashboard. The generator refuses a source without exactly one `access_log off;` |
| `--with-replay-log` | `FAULT_TOLERANCE_LOG_STORAGE_URI=file:///amber/user-resources/recovery-logs/` for dashboard-service and the unit (both mount `workflow_result_data` there); after the stack is healthy `up` creates that directory owned by uid 1001, since Docker creates the volume as root's |
| `--unit-env KEY=VAL` | Extra unit environment, repeatable (for example `USER_JWT_TOKEN=...` for the negative control) |

- `--source` is the worktree whose `bin/single-node/` (compose, `.env`, nginx) and
  `sql/*.sql` are copied. It defaults to `$SCE_SOURCE`, or else
  `/Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine`.
  `up` regenerates from the source every time, so the stack follows the branch's
  deployment files. `MANIFEST.json` records the source commit and whether the
  worktree had uncommitted changes.
- `--images` defaults to `ghcr.io/apache/latest`, meaning
  `ghcr.io/apache/texera-*:latest`. It also accepts `<registry>:<tag>`.
  `images/build.sh` produces `sce/<tag>`.
- `up` waits for:
  - every healthcheck to pass;
  - the three init jobs to exit 0;
  - `GET http://localhost:8080/api/healthcheck` to return 200 through nginx.

  `up` then restarts nginx, because nginx resolves its upstreams only once at start.

**How it stays away from the user's stopped `texera-single-node` stack and other agents' containers:**

- The compose project is `sce`. Every container is named `sce-<original name>`,
  for example `sce-texera-postgres` and `sce-dashboard-service`.
- Each original service name and container name is kept as a network alias. The
  hostnames baked into `.env` and `nginx.conf` (`texera-postgres`,
  `texera-rustfs`, `dashboard-service` and so on) therefore resolve unchanged.
- The stack has its own network, `sce-net`, and its own volumes: `sce_postgres_data`,
  `sce_rustfs_data` and `sce_workflow_result_data`.
- It uses the original host ports, 8080 (UI/API) and 9000 (RustFS, needed for
  browser presigned URLs). They are bound to `127.0.0.1` by default; use
  `--bind ''` for all interfaces. 5432 is never published.
- `up` refuses to start if another container or process holds those ports. A
  process counts when it accepts connections on `127.0.0.1` or `::1`, so a
  listener on the wildcard address (for example a native local-dev server) is
  caught too. Otherwise the driver's `http://localhost`, which resolves to `::1`
  first, could reach that process instead of this stack. `up` never stops
  anything that is not part of `sce`.

**What is dropped** (none of it is needed for a workflow run; `--with-optional` keeps the first four):

- LiteLLM, agent-service, Jupyter and notebook-migration. nginx answers 503 on
  `/api/agents` and `/api/notebook-migration/`, and the GUI flags for those panels
  are set to false.
- The profile-gated observability services and the example loader.
- The startup banner.

**What is added:** a healthcheck on the computing unit (`GET /api/execution/health`,
port 8085), which has none upstream.

Everything else matches the original compose (service definitions are compared
in the generator's round trip): Postgres (pgroonga), RustFS and its bucket init,
lakeFS, Lakekeeper with migrate and init, file-service, config-service,
access-control-service, CU-managing, compiling, the one unit container
(`workflow-runtime-coordinator-service`), dashboard, and nginx.

## Branch images: `images/build.sh`

```
images/build.sh [--frontend] [--skip-sbt] [--pip auto|always|never] [--registry sce] [--base ghcr.io/apache:latest] <worktree> <tag>
images/build.sh --dry-check <worktree> <tag>     # verify everything, build nothing
```

1. Runs `sbt -batch WorkflowExecutionService/dist FileService/dist ComputingUnitManagingService/dist WorkflowCompilingService/dist ConfigService/dist AccessControlService/dist`
   in the worktree. `--skip-sbt` reuses the zips already in `*/target/universal`.
2. With `--frontend`, builds the frontend with node 24 from nvm and the repo's
   pinned yarn (`yarn install --immutable && yarn build`).
3. Generates the Python protobufs with Homebrew `protoc` and the betterproto
   plugin at amber's pin. The plugin lives in a uv venv at `.venv-proto`, and the
   output goes into the build context, not the worktree. Checked against the
   published unit image: generating from the image commit's `.proto` files gives
   the same code, except for class order in two modules. Upstream added a file
   sort on 2026-10-30, after the images were built.
4. Unzips each dist under `build/<tag>/` (the repo's `.dockerignore` blocks
   `*.zip` and `target/`). It then builds images `FROM ghcr.io/apache/texera-<x>:latest`
   that replace only what the upstream Dockerfiles put there. Files are copied as
   root and owned by `1001:1001` (texera).

   | Image | Replaced in the image |
   |---|---|
   | `workflow-execution-coordinator` (unit) | `/texera/amber/{bin,lib,conf}`, `/texera/amber/src/main/resources`, `/texera/amber/common/config/src/main/resources`, `/texera/amber/src/main/python` (with the generated `proto/`) |
   | `dashboard-service` | the same without Python, plus `/frontend/dist` with `--frontend` |
   | `file-service`, `config-service`, `workflow-compiling-service`, `workflow-computing-unit-managing-service` | `/texera/{bin,lib,conf}`, `/texera/<svc>/src/main/resources`, `/texera/common/config/src/main/resources` |
   | `access-control-service` | `/texera/{bin,lib,conf}`, `/texera/access-control-service/src/main/resources` |
   | `agent-service`, `notebook-migration-service`, `jupyter` | not rebuilt; retagged |

   All images are tagged `sce/texera-<name>:<tag>`.
5. Python packages come from the base unit image. By default (`--pip auto`), the
   unit image reinstalls `amber/requirements.txt` when it differs from the base
   image's `/tmp/requirements.txt`. Drift in `operator-requirements.txt` is only
   reported. As of 2026-11-15, its torch marker differs, which matters only on
   linux/aarch64; use `--pip always` to reinstall it too.
6. Writes `build/<tag>/BUILD-MANIFEST.json` with the source commit, the dirty
   flag and the image IDs. Every image is also labelled `sce.revision`,
   `sce.dirty`, `sce.base` and `sce.source`.

Do not run `build.sh` while another sbt is using the same worktree.

## The driver: `driver/run.sh` (wraps `driver/e2e.py`)

```
driver/run.sh [--base http://localhost:8080] [--scenario a,c | --scenario d ...] [--report path.json]
              [--transport ws|create-ws] [--gate A|B|C|D] [--evidence [CHECKS]] [--negative-control]
              [--legacy-env] [--with-replay-log] [--timeout 300]
              [--unit-uri http://workflow-runtime-coordinator-service:8085] [--list] [--print-token]
```

Setup runs once, over REST through the gateway:

1. Log in as `texera`/`texera` (the admin the dashboard creates at startup).
2. Upload `people.csv`, `depts.csv` and `numbers.csv` as one dataset,
   `sce-e2e-<content hash>`. This uses file-service's multipart path (create,
   then init/part/finish, then version `v1`). The dataset is reused when the
   content is unchanged.
3. Create or reuse the per-user warehouse `sce-e2e`, when `GET /api/warehouse/status`
   says warehouses are enabled. Runs need one with the REST catalog.
4. Create or reuse the local computing unit `sce-e2e-unit`. Its URI is the unit's
   in-network address, `http://workflow-runtime-coordinator-service:8085`.
5. Only when a selected scenario needs them (on `create-ws`): the second user
   `sce-e2e-other` (registered, then set to REGULAR by the admin through
   `PUT /api/admin/user/update`, with its own local unit and warehouse), and a second
   local unit of texera, `sce-e2e-unit-2`, with the same URI (l9).
6. With `--evidence` or `--negative-control`: the evidence preflight (a probe mark
   must appear in the Postgres log; the unit's addresses, networks and env).

Each scenario then creates its own workflow (stored in UI format, so it can be
opened in the browser), runs it through the transport, and checks the outcome.
The driver prints PASS or FAIL per scenario and writes a JSON report. The report
holds the harness's own commit and uncommitted changes (`harness_git`; the results
banner prints it too; a `git archive` copy may name its commit in `.harness-commit`),
every check with its detail, the state timeline, what the unit sent while the
socket opened (`run.opened`), commands sent, operator statistics, a console sample,
the persisted execution row, notes, and with evidence every unit statement of each
window. Exit codes:

| Code | Meaning |
|---|---|
| 0 | All selected scenarios passed (and, with evidence, the final check) |
| 1 | A scenario failed |
| 2 | Setup failed |
| 3 | The stack did not come up (`run-baseline.sh` only) |

Selection: no `--scenario` runs the baseline a, b, c, d, e, u (plus g0 with
`--legacy-env`) on either transport, as before. `--scenario all` is the same on `ws`
and every scenario on `create-ws`. `l` is the group l1-l10. A `create-ws`-only
scenario selected on `ws` fails at once with that message.

`--gate X` picks a step-2 PR gate (design section 5); explicit flags win:

| Gate | Transport | Scenarios | Gating evidence | Stack options |
|---|---|---|---|---|
| A | `ws` | a-e, u, g0 | E | `--pg-statement-log` |
| B | `create-ws` | a-e, u, j, k, l1-l10, m, o, g0 | C, E, F | `--pg-statement-log`; images built with `--frontend` |
| C | `create-ws` | B + f, f2 | A-F | `--pg-statement-log --isolate-unit`; then `./run-negative-control.sh` once |
| D | `create-ws` | a-e, u, j, k, l, m, o, f, f2, g, h, i (g0 retired) | A-F | as C |

Add `--with-replay-log` for m's replay run once the engine's global checkpoint works
(see the verification table below); without it m runs its two refusals only.

### Scenarios

Expected values are computed in Python from the same CSV files, independently
of Texera. Numbers must match to a relative 1e-9. The data's fractions (.25,
.5, .75) are exact in binary floating point, so the expected sums are exact.
Column types are checked separately.

| Key | Name | Workflow | Checks |
|---|---|---|---|
| a | `scan-filter-project-aggregate` | CSV scan → Filter `age > 30` → Projection (`dept AS department`, `salary`) → Aggregate (group by `department`: `sum(salary) AS total_salary`, `count(salary) AS n`) | <ul><li>run reaches Completed with no fatal errors</li><li>columns and types (`string, double, integer`)</li><li>exactly 4 groups with exact sums and counts</li><li>the Filter's statistics report 8 output rows</li><li>the persisted execution status is 3 (Completed)</li></ul> |
| b | `python-udf-column` | CSV scan → Python UDF V2 that sets `name_upper = name.upper()` and `age_plus_10 = age + 10` | <ul><li>Completed</li><li>all 7 columns and their types</li><li>all 10 rows, every value</li><li>persisted status 3</li></ul> |
| c | `join-sort` | `depts.csv` (build side) and `people.csv` (probe side) → HashJoin on `dept_id = dept` → Sort `age DESC` (a Python operator) | <ul><li>Completed</li><li>output columns: build side, then probe side minus its key</li><li>the inner join drops `ops` and `fin`, leaving 9 rows</li><li>exact rows in age-descending order</li><li>persisted status 3</li></ul> |
| d | `pause-resume-kill` | `numbers.csv` (300 rows) → Python UDF sleeping 0.2 s per tuple | <ul><li>Running, then the UDF emits rows</li><li>pause reaches Paused and is still Paused after a 5 s hold (the reported output count stays flat too, but the engine sends no statistics while paused, so that alone proves little)</li><li>resume reaches Running, and rows flow again</li><li>kill reaches Killed</li><li>the state order Running → Paused → Running → Killed, with Pausing and Resuming reported</li><li>never Completed</li><li>no work during the pause: rows emitted after resume ≤ (time from the resume request to Killed ÷ 0.2 s) + 2. A worker that kept running through the hold adds about 25 rows, however long the run took to start</li><li>persisted status 5 (Killed)</li></ul> |
| e | `console` | CSV scan → Python UDF that `print()`s one line per tuple | <ul><li>Completed with all 10 rows</li><li>all 10 lines arrive as `ConsoleUpdateEvent`s for that operator</li><li>every message type is `PRINT`</li><li>persisted status 3</li></ul> |
| u | `java-udf-column` | CSV scan → Java UDF adding `name_len` (the unit compiles it with javac) | <ul><li>Completed</li><li>all 6 columns and their types</li><li>every value</li><li>persisted status 3</li></ul> |

Step 2 (design section 7 H3). All but g0 and j need `create-ws`; j also runs on
`ws` (its change goes through the old `ModifyLogicRequest`, and the Dashboard's
refusals are skipped with a note). "No unit statement for its eid" and "the unit
silent after a refused start" are checked by the evidence at the scenario's end;
without `--evidence` they are only noted. A refused start (l5, l6, l8, l9, l10, o's
repeat) waits for the refusal, then 3 s (`REFUSAL_SETTLE_S`), then the evidence
marks "settled": from the start's mark to that mark the unit may run no statement
at all, whatever it names (design D33).

| Key | Name | From PR | What it does | Checks |
|---|---|---|---|---|
| g0 | `environment-legacy` | A-C (`--legacy-env`) | precondition: the unit's `python3 -c "import tabulate"` fails; environment `sce-env0-<hex>` saved through `/api/pve/db` and built through `/wsapi/pve` (create, which installs amber's requirements, then install `tabulate==0.9.0`); Text Input → UDF with that `envName` outputting `tabulate.__version__` | Completed; the row says `0.9.0`; status 3 |
| j | `modify-while-paused` | B | `numbers.csv` → UDF tagging `v1`, 0.05 s per tuple; pause; change the code to tag `v2`; resume | update 200 with `{updateId, operatorId}` and `ModifyLogicResponse.isValid`; the other user's update 403; `ModifyLogicCompletedEvent` names the UDF; Completed with 300 rows, some `v1`, some `v2`, every `v1` before every `v2` in `n` order; an update after Completed 409; status 3 |
| k | `compile-error-from-create` | B | Projection of a missing column | create 400, `operatorErrors` has the Projection and names the column; the 400's eid row is 4; no unit statement for it |
| l1-l4, l7 | `refuse-*` | B | unknown unit; other user + texera's workflow; other user + texera's unit; terminated unit; another user's warehouse | 403, 403, 403, 409, 400; no new row |
| l5, l6, l9, l10 | `refuse-*` | B | other user starts texera's execution; a start naming another execution's `planUri`; a socket for texera's second unit; a `planUri` in another user's warehouse | a `WorkflowErrorEvent` on the starting socket with the design's message (l5: "only the user who created" or, with warehouses on, "another user's warehouse"; l6: "the plan is execution"; l9: "computing unit"; l10: "another user's warehouse"); none on a texera socket watching the workflow; never Running; the row stays 0 (allowed in the final check); no unit statement for the eid; the unit silent from the start until settled |
| l8 | `refuse-second-start` | B | start a completed execution again (the first socket stays open, so no idle cleanup runs; with evidence the unit first settles, 1 s without a statement, so the first run's trailing writes stay out). The new socket gets the held run replayed while it opens (state Completed, its console); that is kept apart from the start's answer | "already started" on the new socket; the first socket gets no error and no state; never Running after the start; the row stays 3; no unit statement for the eid after the second start; the unit silent from the second start until settled |
| m | `replay` | B | refusals always: a source without a log (with `--with-replay-log` every run has one, so a missing execution instead) and a source of another workflow; with `--with-replay-log`: a slow run on JVM workers only (`numbers.csv` → a Java UDF sleeping 50 ms per tuple; a Python worker cannot take a checkpoint) with a `WorkflowCheckpointRequest` (the only thing that records an interaction), its interactions, a replay from the last one, started | refusals 400 and no row; the source run completes; it lists ≥ 1 interaction; replay create 201; the replay reaches Running, Paused or Completed |
| o | `agent-sync-run` | B | create with `targetOperatorIds` [Filter]; `docker exec <unit> curl -X POST http://localhost:8085/api/execution/<eid>/run` with texera's token and `{planUri, computingUnitId, targetOperatorIds, timeoutSeconds, maxOperatorResultCharLimit, maxOperatorResultCellCharLimit}`; with evidence, before the repeat the unit settles (its cleanup delay + 1 s, then 1 s without a statement: no socket holds the workflow, so the unit cleans the run up) and the repeat gets a start mark | `success`, state Completed, the Filter's rows exact, the Projection downstream not in the result; a repeat: `success: false`, "already started"; the unit silent from the repeat until settled; status 3 |
| f | `file-lister-scan` | C | File Lister (the e2e dataset's v1) → File Scan From Input (single string, with the file name) | Completed; 3 rows; the file names are the three logical paths; no value contains `http`; each content equals the uploaded bytes |
| f2 | `file-scan-needs-lister` | C | Text Input of a dataset path → File Scan From Input | create 400; `operatorErrors` names the File Scan |
| g | `environment-install` | D | precondition as g0; the install root is the unit's `UDF_PYTHON_ENVIRONMENTS_ROOT` (else `/tmp/texera-python-environments`); an earlier install whose marker lists `tabulate==0.9.0` (a `--keep` stack, a rerun) is removed first, since reuse is decided by the marker; environment `sce-env-<hex>` = `{tabulate: ==0.9.0}` through `/api/environments`; the UDF outputs `tabulate.__version__`; run twice, each on its own workflow (installs are keyed by requirements and engine, not by workflow, and run 2 then gets no replay of run 1's console) | run 1: console "Installing Python environment" then "is ready" with `tabulate==0.9.0`, Running only after "ready", row 0.9.0, status 3; run 2: "reused", no "Installing", start-to-Running shorter; exactly one directory under the root whose `texera-environment.json` (read whole by the unit's python3) lists these requirements |
| h | `environment-broken` | D | environment `{sce-e2e-nonexistent-<hex>: ==1.0.0}`; the root's entries (without `*.lock`) listed before and after | Failed (waited with fail-fast off); never Running; the fatal error has "could not be installed" and "No matching distribution found"; the UDF emitted 0 rows; status 4; no new entry under the root |
| i | `environment-missing` | D | the UDF names `sce-missing-<hex>` | create 400; the UDF's error names the environment; that row is 4; no unit statement for it |

### The transport seam (`driver/transport.py`)

How a run is started, watched and controlled lives only in `transport.py`.
Scenarios call `Transport.start_run(...)`, which returns a `RunHandle`, and use
only these `RunHandle` members:

| Purpose | Members |
|---|---|
| Wait | `wait_for_state`, `wait_until` |
| Control | `pause`, `resume`, `kill`, `ensure_stopped`, `modify_operator`, `send_raw` |
| Observe | `eid`, `plan_uri`, `states`, `state_log`, `command_log`, `stats` / `output_rows`, `console`, `fatal_errors`, `error_event_count`, `modify_responses`, `modify_completed`, `results`, `replayed` |
| Report and clean up | `summary`, `close` |

`Transport` also has `open_socket(wid, cuid, token=None)` (a session on the
workflow, nothing sent), `create_only(**kw)` (the raw create response) and
`start_existing(wid, cuid, eid, plan_uri, token=None)` (a socket as the token's user
that sends only the start), and calls `phase_hook(phase, info)` when the driver
sets one: `create` before an execution is created, `created` with its eid,
`start` before the start is sent (the evidence marks).

**The open sequence.** The unit answers a new socket (`WorkflowWebsocketResource.myOnOpen`)
with `WorkflowStateEvent` "Uninitialized", then replays the execution the workflow holds
on that unit, if any (its statistics, worker assignment, duration, console, state and
errors: a second socket on a completed run gets "Completed" and the old run's console),
and sends `ClusterStatusUpdateEvent` last. `open_socket` returns only after that event,
so everything replayed precedes the first command. The handle keeps the open sequence
in `replayed` (the report's `run.opened`: what closed it, its states, console and error
counts, event types); its views (`states`, `state_log`, `console`, `fatal_errors`,
`error_event_count`, `stats`, `modify_*`) hold only what arrived after it, so a
replayed "Completed" is not this run's, a replayed error does not fail a wait, and a
replayed console is not this run's console. Without `ClusterStatusUpdateEvent` the
sequence ends 5 s after the handshake plus 1 s without a message. Seen on the real
unit (step1, 2026-11-16): a second socket on a completed run opened in 0.08 s, closed
by `ClusterStatusUpdateEvent`, with `["Uninitialized", "Completed"]`, the 3 console
messages and both operators' statistics in `replayed`, and an empty view at return and
2 s later. Limit: events of a run that is still live on the workflow keep arriving
after the open; the scenarios start a run on a workflow only when nothing runs there.

Waits fail fast, raising `RunFailed` with the cause instead of running out the
timeout, when any of these happens:

- A `WorkflowErrorEvent` arrives.
- An unexpected terminal state arrives. The error event that follows it is
  included in the message.
- An operator sends an `ERROR` console message. On a Python exception, Texera
  pauses that worker for debugging (the operator's statistics show `Paused`),
  while the workflow state stays `Running`. Without this rule, a broken UDF would
  only show up as a 300 s timeout. With it, the scenario fails in about a second
  and the report carries the Python traceback.

After each scenario, the runner kills any run that is still alive
(`ensure_stopped`), so the next scenario starts on an idle unit. A socket on
which nothing arrived after its open sequence (a watcher, or a refused start) is
left alone: a kill there would reach whatever run the workflow holds. When a start
went out and nothing came back yet, `ensure_stopped` first waits up to 5 s for a
state or the refusal. These paths were checked against the published images:

| Probe | Outcome |
|---|---|
| A UDF that raises | FAIL in 1.0 s with the traceback; the run was killed (persisted status 5) |
| A scan of a missing dataset file | FAIL in 0.1 s with `FileNotFoundException: Could not read from "/dataset/..."` (status 4) |

`ws`, the browser path on upstream main, on the published images and on step 2's
PR A (the unit creates the execution):

1. Open a websocket through the gateway to
   `/wsapi/workflow-websocket?wid&uid&cuid&access-token`.
2. Send `WorkflowExecuteRequest`, with `computingUnitId` and `warehouseId`.
3. Send `WorkflowPauseRequest`, `WorkflowResumeRequest` or `WorkflowKillRequest`
   to control the run; `ModifyLogicRequest{operator}` to change a paused operator.
4. Read results with `ResultPaginationRequest`, which returns a `PaginatedResultEvent`.
5. Send a heartbeat every 10 s.

The eid is not known at start; the driver reads it back (`latest_execution`).

`create-ws`, step 2 from PR B on (design 3.4-3.6):

1. `POST /api/executions` with `{wid, executionName, engineVersion, logicalPlan,
   workflowSettings, emailNotificationEnabled: false, computingUnitId, warehouseId?,
   replayFromExecution?, targetOperatorIds?}` (120 s timeout). 201 gives
   `{eid, wid, computingUnitId, planUri}`; anything else raises
   `CreateRefused(status, body)`.
2. Open the websocket as above and wait for the end of the open sequence.
3. Send `{"type": "WorkflowStartRequest", "executionId": eid, "planUri": planUri}`
   as the first marked command.
4. Pause, resume, kill, pagination and heartbeat as on `ws`. `modify_operator`:
   `POST /api/executions/{eid}/updates {operator}` (a 4xx raises `UpdateRefused`),
   then `{"type": "OperatorUpdateRequest", "executionId": eid, "updateId": ...}`,
   then the `ModifyLogicResponse`.

### Evidence (`driver/evidence.py`, `--evidence [CHECKS]`)

Needs a stack started with `--pg-statement-log` (the preflight fails setup
otherwise). The listed checks gate the scenario (default: all six); the others are
evaluated and reported as `info`.

- **Marks.** Before create, before start, and around every scenario (`begin`,
  `end`) the driver runs `docker exec sce-texera-postgres psql -U texera -d texera_db
  -Atc "SELECT 'sce-mark:<scenario>:<phase>:<eid>:<id>'"`. The log is cut at marks
  and statements, never by clock.
- **Parsing.** `docker logs --timestamps` of Postgres, read incrementally (`--since`
  the newest timestamp, nothing read twice). `LOG: statement:` and
  `LOG: execute <name>:` lines, their tab-continued lines, and the following
  `DETAIL: parameters:` line of the same pid; an ERROR's `STATEMENT:` too (folded
  into its `execute` line when it repeats it). Kept: `db=texera_db`; dropped: empty
  statements (pgjdbc's validation), BEGIN/COMMIT/ROLLBACK/SET/SHOW and the marks.
  Tables are read after `from|join|into|update`, quoted or not, schema dropped.
- **Attribution.** A statement is the unit's when `app=texera-computing-unit`, or
  when its `host` is one of the unit container's addresses (`docker inspect`), on
  any network, so this works without `--isolate-unit` too.
- **Windows** (per started run; a run counts as started when a state other than
  "Uninitialized" arrived on its socket after its start was sent: the handle's
  `state_log` index is taken at the start mark, and what the unit replays while a
  socket opens is not in that log): the start window runs from the start mark to
  the unit's first `UPDATE workflow_executions SET ... status ... WHERE ... eid`
  whose parameters put the status at 1, 4 or 5 and the eid at the run's, inclusive;
  the terminal window to its first status 3, 4 or 5.
- **Refused starts** (`expect_silent_since_start`): after the refusal and the
  scenario's settle, a `settled` mark; between the start mark and it, no unit
  statement at all, whatever it names (a read that names no eid, or names it
  through `IN`/`ANY`, would pass "no unit statement for the eid"). Nothing else runs
  on the unit then: the previous cleanup was waited out, the sockets stay open, and
  l8 and o settle the unit before their second start.

| Check | Holds when |
|---|---|
| A | start window: no unit statement starts with `SELECT` or `WITH`, and each is an INSERT or UPDATE on `workflow_executions`, `operator_port_executions` or `operator_executions` (a missing window end fails it) |
| B | terminal window: unit statements touch no other table |
| C | every `INSERT INTO workflow_executions` of the scenario has `app=texera-dashboard` and comes from none of the unit's addresses (none at all passes only when no create succeeded) |
| D | needs `--isolate-unit` (else not evaluable, which fails a gating D): `getent hosts file-service texera-lakefs` in the unit finds neither; the unit's log since the start mark names none of `file-service`, `texera-lakefs`, `:9092`, `:8000/api/v1`; and the gateway's access log since the start shows no request from one of the unit's addresses (nginx proxies file-service and the Dashboard, and the isolated unit still reaches nginx). A name that resolves, or the log naming one, fails D outright; when only the gateway log is unreadable (no `sce-access` line since the start), D is not evaluable |
| E | Lakekeeper's REST API, from the dashboard container (`GET /catalog/v1/config?warehouse=<w>` for the prefix, then the table `wid_<wid>_eid_<eid>_plan` in namespace `execution-plan` or `STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`) has a ref named `started`. The warehouse comes from the `planUri`, else texera's (`lakekeeperWarehouseName`, or `user-<uid>-<whid>` on Dashboards that do not report it), else the default |
| F | every statement from the unit's addresses in the scenario has `app=texera-computing-unit` (none at all passes; app-named unit statements from none of the known addresses make F not evaluable: the addresses are stale) |

Before each scenario that follows one which sent a start to the unit, the driver
waits (at most 15 s, recorded as `cleanup_wait`) until: the unit's cleanup
`DELETE FROM operator_executions WHERE workflow_execution_id = $1` of every eid the
previous scenario started has appeared; the unit's cleanup delay
(`WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS`) plus 0.5 s has passed since the
previous end mark (sockets close just before it); and the unit has run no statement
for 1 s. The idle cleanup keeps going after its DELETE (a SELECT of
`runtime_stats_uri` 20-40 ms later, then Iceberg work), so waiting for the DELETE alone
did not keep it out of the next windows. `settle_unit()` is the same quiet wait for
scenarios (l8 before its second start, o before its repeat). After all scenarios,
the final check: no execution of this run's workflows is left at status 0, except
the refused starts (l5, l6, l9, l10).

### Negative control (`./run-negative-control.sh`, `--negative-control`)

The script brings the stack up on the published images with `--pg-statement-log
--isolate-unit`, takes texera's token (`driver/run.sh --print-token`), brings it up
again with `--unit-env USER_JWT_TOKEN=<token>` (the unit is recreated and reads
datasets through file-service, the K8s path, which it cannot reach), runs scenario a
over `ws` with `--negative-control`, then takes the stack down. With
`--negative-control`, A, D and F must fail, each for its own reason: A on at least
one unit `SELECT`/`WITH` in the start window, D on unit log lines naming
`file-service` or `texera-lakefs` while `getent` resolves neither, F on statements
from the unit's address that carry another application name. A control that fails
for another reason (A only because no status UPDATE came, D because a name resolves
or only through the gateway) reports "control inconclusive" and fails the run, as
does a control that passes; a passing run records "controls failed as expected".
The scenario's own checks and the other evidence are reported only. Take the
source from a clean worktree (for example `--source <step-1 worktree>`): its
deployment files and DDL are the ones the stack uses.

### Offline tests (`driver/tests/`)

```
.venv/bin/python -m unittest discover -s driver/tests -v     # 96 tests (55 single-node, 25 Kubernetes mode, 16 local-dev mode), about 55 s
```

- `test_evidence.py` (21): the log parser (parameters, continuation lines,
  interleaved pids, failed statements), the incremental reader, and Checks A-F
  against a fake `docker` serving a synthetic log of the old unit (A, B, C, D, F
  fail; the negative control passes) and of the new path (every check passes; the
  controls then fail). Also: a start counts only states after it; the silence of a
  refused start (a read that names no eid fails it); the cleanup wait outlasting the
  trailing SELECT; a scenario that only opened sockets still waits out the cleanup
  delay; `settle_unit`; C refusing a Dashboard-named insert from a unit address; F
  not evaluable with stale addresses; D failing on a gateway request from the unit
  and not evaluable without the gateway log; each negative control "inconclusive"
  when it fails for another reason.
- `test_transport.py` (15): both transports against `fake_texera.py`: the create
  body of 3.4, the start by id as the first command, `CreateRefused`, the update then
  `OperatorUpdateRequest`, `UpdateRefused` (409 after the end), a refused second
  start that is not killed, a start as another user, the unchanged
  `WorkflowExecuteRequest`, `ModifyLogicRequest` on `ws`, environments (new and
  legacy), `/wsapi/pve`, users and unit termination; the open sequence (the fake
  replays the held run 0.1 s after the handshake, as the real unit does: the replay
  stays in `replayed`, the views stay empty; the quiet-period fallback without
  `ClusterStatusUpdateEvent`; a replayed fatal error does not fail a wait).
- `test_scenarios.py` (14): g0, j, k, l1-l10, m (with and without a replay log), o,
  f, f2, g, h, i through the real driver code against the fake (and a fake
  `docker exec` for o and the environment scenarios); j on `ws`; g removing an
  earlier install, and failing when run 1 says "reused".
- `test_scenario_evidence.py` (5): scenarios and evidence together, as e2e.py runs
  them, on a fake stack (the fake reports the statements the design's services run,
  the requests a gateway logs and its plan tables): l8 passes all six checks and its
  silence check although the second socket gets the held run replayed; l5, l6, l9,
  l10 and the final check; the cleanup between scenarios lands before the next begin
  mark; o's repeat is silent; a refusal path that reads Postgres fails the silence
  check; and the start rule before this fix fails l8's Check A (the review's case).

`fake_texera.py` models the design, not Texera: a scenario that passes against it
drives the design's protocol and judges its answers as the design says; it proves
nothing about a branch.

## What is verified against a real stack, and what is not yet

Step 2 lands in parts; until PR B there is no `POST /api/executions`, no
`WorkflowStartRequest`, no update endpoint and no `/api/execution/{eid}/run` to test
against. As of 2026-11-16, after the review of the step-2 harness (every report
records the harness commit in `harness_git`):

Verified against a real stack (reports under `reports/`):

| Part | Images | Result |
|---|---|---|
| `ws` baseline a-e, u after the review fixes | `sce/texera-*:step1` (source `sce-imgbuild` `5e85a37de`) | a, b, c, d, e, u all PASS with the same checks as before (8, 7, 7, 14, 6, 7), no stack options, `ws`, default selection; harness `38fac82`, no uncommitted change. `reports/baseline-20261116T111713Z.json` |
| The open sequence (`open_socket`, `replayed`, the views) | step1 | a probe on that stack: a second socket on a workflow whose run completed opened in 0.08 s, closed by `ClusterStatusUpdateEvent`; `replayed` held `["Uninitialized", "Completed"]`, the 3 console messages and both operators' statistics; the handle's states, console, errors and statistics were empty at return and 2 s later |
| Negative control (H5), `run-negative-control.sh --source <sce-imgbuild>` | published `ghcr.io/apache/latest` | controls failed as expected, each for its own reason: A (6 of 8 start-window statements offend, SELECTs of `user_warehouse`, the latest `workflow_executions`, `workflow_version`, `dataset`, ...), D (`getent` resolves neither; the unit's log has `UnknownHostException: file-service`; the gateway served 0 of 3 requests since the start to the unit), F (8 statements from the unit's address, all `app=PostgreSQL JDBC Driver`). B, C (the unit inserts the row) and E (no plan table) fail too; scenario a itself fails (the compile cannot read the CSV header through file-service). Harness `38fac82` (uncommitted changes only in `README.md` and `run-k8s.sh`, Kubernetes mode's). `reports/negative-control-20261116T111839Z.json` |
| `--isolate-unit`'s gateway access log (Check D) | published, step2wip | nginx writes `sce-access <addr> "<method> <uri>" <status>`; in each isolated run D read the 3 requests logged since the start, none from the unit |
| Evidence on step2wip, unit isolated, scenario a, all six checks gating | `sce/texera-*:step2wip` (sce-integrate `e31d185fa`: step 1 + sub-parts 1, 2, 3, 4, 5, 7, 19) | F passes; A (8 of 10: the unit still compiles and reads at start), B, C (`texera-computing-unit` inserts the row), D (`UnknownHostException: texera-lakefs` in the unit's log; `getent` resolves neither; no gateway request from the unit), E fail, as expected before PR B and C. Scenario a fails: the isolated unit cannot read the CSV (expected until PR C's links). Overall FAIL, as expected. `reports/baseline-20261116T112009Z.json` |
| Evidence on step2wip, not isolated: a, c, e, u, F gating; the cleanup wait | step2wip | all PASS with F gating and passing; A, B, C, E fail on each as expected, D not evaluable without isolation. Each wait saw the previous run's cleanup DELETE 1.9-2.1 s after its end mark and returned after 3.0-3.1 s (then 1 s quiet), never timing out. In the Postgres log of the kept rerun, all 6 unit statements of each cleanup (3 SELECTs, the 2 DELETEs, then the SELECT of `runtime_stats_uri`) precede the next begin mark, by about 1.4 s, and no unit statement falls between a begin mark and its start mark. `reports/baseline-20261116T112110Z.json`, `reports/baseline-20261116T112249Z.json` |
| Evidence on step2wip, not isolated: a, b, c, d, e, u, j (`ws`), g0, F gating (before the review fixes) | step2wip | all 8 PASS with F gating and passing on each; j over `ws`: ModifyLogicResponse valid, ModifyLogicCompletedEvent, 300 rows, every v1 before every v2; g0: the legacy environment built in 37 s, the UDF's row says tabulate 0.9.0. `reports/baseline-20261116T100824Z.json` |
| REST helpers for the second user and environments | step2wip | the review's probe on that stack: `ensure_user` (register, the admin sets REGULAR through `set_role`, log in), the second user's local unit and warehouse, `terminate_unit` (HTTP 200; `ensure_local_unit` then skips it), `ensure_environment` on `/api/environments` (201 create, 409 then the list, PUT on a change) and `list_environments` |
| g's and h's listing of the install root | the step2wip unit image | `LIST_ENVIRONMENTS_PY` under the image's own python3 (a throwaway container, no stack): a pretty-printed marker parses, a directory without a marker is listed with `marker: null`, `*.lock` is skipped |
| `--pg-statement-log` | published, step2wip | the log carries `app= db= host=` and DETAIL parameters as designed; an unnamed connection shows `app=[unknown]` (LakeFS) or `app=PostgreSQL JDBC Driver` (the published services) |
| `--isolate-unit` | published, step2wip | the unit is on `sce-unit-net` only, the stack comes up healthy, runs start through nginx, and `getent` in the unit resolves neither `file-service` nor `texera-lakefs` |
| `--unit-env` | published | `USER_JWT_TOKEN` recreates only the unit (and reruns lakekeeper-init); the unit then calls file-service |
| `--with-replay-log` | step2wip | the shared volume is root's and the services run as uid 1001, so `up` creates `recovery-logs` and gives it to 1001 (without that the coordinator cannot create its log and the run hangs in Initializing). Then d passes, the row's `logLocation` is set and the Dashboard reads the log. Pause and resume record no interaction, and a `WorkflowCheckpointRequest` (the only thing that records one) fails the run: `portId has not been set for channel ... call setPortId before getPortId`, an upstream engine bug. So m's replay run fails on today's engine; its refusals do not need the option. (That failure is fixed on step2ckpt; see the last row for what fails next) |
| The Lakekeeper lookup of Check E | published, step2wip | config → prefix → table works against Lakekeeper; a missing plan table reports the warehouse's namespaces |
| Final status-0 check | published, step2wip | runs; no row left at 0 |
| Gate B as a whole (`--gate B`): `create-ws`, a-e, u, j, k, l1-l10, m (its refusals), o, g0, with C, E and F gating | `sce/texera-*:step2p11` (the tree of `b71d84698`; `--source sce-imgbuild` at `b71d84698`) | all 21 PASS, twice: from empty volumes (`--reset`, `reports/baseline-20261117T013331Z.json`) and again on the same volumes, as the command at the top writes it (`reports/baseline-20261117T013948Z.json`); harness `00e6a81`, no uncommitted change. First real-stack runs of c, d, u, j, l5, l6, l9, l10, m and o on `create-ws`. C: every row inserted by `texera-dashboard` from the Dashboard's address; E: `started` on the plan table of every started run; F: every unit statement named `texera-computing-unit`. j: update 200, `ModifyLogicResponse` valid, `ModifyLogicCompletedEvent`, 11 rows `v1` then 289 `v2`, the other user's update 403, one after the end 409. The refused starts (l5 and l10 "the plan is in another user's warehouse", l6 "the plan is execution 11's, not 10's", l9 "execution 13 was created for computing unit 1, not 3", l8's and o's repeat "already started") reached their sender alone, and the unit ran no statement until after the answer. A and B, reported only, fail on the unit's two SELECTs of `site_settings` (the CSV column limit, until PR C); D is not evaluable without isolation. After the first run the unit's log held no `ERROR` line and the Dashboard's only k's compile error |
| What a refused start leaves in the lake (not a harness check: Check E looks only at started runs) | step2p11 | a probe on the gate's stack with `Evidence.plan_table_refs`: the plan tables of l5's, l6's (both), l9's and l10's executions hold `main` only; those of a's, l8's and o's hold `main` and `started` |
| m's replay run on `create-ws` (`--with-replay-log -- --gate B --scenario m`) | step2p11 | still blocked by the engine, as on step2wip: the source run fails right after `WorkflowCheckpointRequest` with `portId has not been set for channel ChannelIdentity(COORDINATOR, Worker:...-CSVFileScan-...-main-0, true)`. `EmbeddedControlMessageManager.isECMAligned` reads the port of the channel the checkpoint came from before it looks at the alignment type, and a source worker gets it on the coordinator's control channel, which has none (`AmberFIFOChannel.getPortId`). Both files are upstream's, untouched by the branch. With a log kept, m's first run completes (`logLocation` set) and both refusals pass. `reports/baseline-20261117T013828Z.json` |
| m's replay run with the source worker's checkpoint fixed (`--with-replay-log -- --gate B --scenario m,d`) | `sce/texera-*:step2ckpt` (sce-imgbuild `57c64e921`: `b71d84698` plus `fix(amber): take a checkpoint on a source worker`; `--source sce-imgbuild`) | the `portId` failure is gone: the CSV scan's worker prepares and finalizes its checkpoint ("Checkpoint finalized, total size = 5040 bytes" in the last report's run). Two older limits of the engine's checkpoint remain, both upstream's, so the interactions, the replay's create and its start are still unverified. (1) With the Python UDF m had until then, the run completes but lists no interaction: pyamber has no `PrepareCheckpoint` handler (`grpclib` `UNIMPLEMENTED` from `WorkerServiceBase.prepare_checkpoint`), so the coordinator's `propagateEmbeddedControlMessage` fails and records no replay destination (`reports/baseline-20261117T015618Z.json`, harness `24842ed`; d PASS, 17 checks, in the same run). m's checkpointed run therefore has JVM workers only now. (2) With the Java UDF the run fails at the checkpoint: `KryoException: InaccessibleObjectException: Unable to make field ... BuiltinClassLoader.parent accessible`, serialization trace `contextClassLoader (OutputPortStorageWriterThread)`, `outputPortResultWriterThreads (OutputManager)`, `outputManager (DataProcessor)`, from `PrepareCheckpointHandler.serializeWorkerState` (`PrepareCheckpointHandler.scala:61`). The checkpoint serializes the whole `DataProcessor`, and a worker whose output port is stored (here the viewed Java UDF) holds its live writer threads there (`OutputManager.scala:123`, upstream #3295, the same on upstream `main` `205fe77c4`). `reports/baseline-20261117T020500Z.json` |

Written and tested offline only (`driver/tests/`), to be validated when the PRs land:

| Part | Lands with | Offline test |
|---|---|---|
| Scenarios f, f2 | PR C (16, 17) | `test_scenarios.py` |
| Scenarios g, h, i: environments used by runs, the install root from the unit's env, removing an earlier install, h's listing before and after | PR D (20) | `test_scenarios.py` (the `/api/environments` CRUD and the listing script are verified above) |
| Checks A, B and D passing, D failing on a gateway request from the unit, F not evaluable with stale addresses, a negative control reported "inconclusive", gates C and D | PR C-D | `test_evidence.py`, `test_scenario_evidence.py` |
| m's replay run after the checkpoint: its interactions, the replay's create and start | PR B, and an engine whose global checkpoint works | `test_scenarios.py` (`ReplayScenario`) |

## `run-baseline.sh`

```
./run-baseline.sh [--reset] [--keep] [--images <registry>/<tag>] [--source <worktree>] [--label text]
                  [--pg-statement-log] [--isolate-unit] [--with-replay-log] [--unit-env KEY=VAL ...]
                  [-- <driver args>]
```

`up` (published images by default, with the stack options given), then wait until
healthy, then `status`, then run the driver. The report goes to
`reports/baseline-<UTC time>.json` and embeds the stack manifest. Afterwards the
script runs `down`, keeping the volumes, unless `--keep` is given. `--reset`
starts from empty volumes.

## Notes and caveats

- **Baseline mix.** The baseline combines the published images (built
  2026-10-15, near upstream `40ced5bdb`) with the worktree's current deployment
  files and DDL. Since then the DDL has only gained a nullable column pair and an
  enum, so the old images run against it unchanged.
- **Expected unit warnings.** The unit logs a warning when it reads a dataset.
  In single-node, lakeFS presigned URLs point at `localhost:9000`, which a
  container cannot reach, so the unit falls back to a direct lakeFS fetch.
  Upstream does the same.
- **Base-image drift.** Thin images inherit the base image's OS and Python
  packages. `--base` takes a registry and one tag, not per-image digests. To pin
  the bases, retag today's images under a fixed tag (for each image,
  `docker tag ghcr.io/apache/texera-<x>:latest sce-base/texera-<x>:2026-11-15`)
  and pass `--base sce-base:2026-11-15`.
- **The generated `.env` wins.** Compose lets shell variables override an env
  file during interpolation. The stack script therefore removes every variable
  the generated `.env` defines from compose's environment. An exported
  `IMAGE_TAG` or `TEXERA_PORT` cannot silently change the images that `--images`
  asked for, or move a port.
- **The source worktree is only read.** `git status` (the dirty flag in
  `MANIFEST.json` and `BUILD-MANIFEST.json`) runs with `GIT_OPTIONAL_LOCKS=0`, so
  it never locks the index of a worktree someone else is committing in.
- **One run at a time.** Only one copy of the stack can run at a time (fixed
  names and ports). Other compose projects, including the user's own
  `texera-single-node`, are never started, stopped or reused.
- **The stack lock.** Stack runs share an 8 GB Docker VM with other agents' work
  (a Kubernetes deployment). Before any `up`, take the lock and release it when the
  run is over (at most 45 minutes at a time):
  `until mkdir <scratchpad>/sce/stack.lock 2>/dev/null; do sleep 30; done; echo "<who> $(date)" > <scratchpad>/sce/stack.lock/owner`,
  then `stack/sce-stack.sh down; rm -rf <scratchpad>/sce/stack.lock`. Wait for one
  run's `down` to finish before the next `up`: an `up` racing a `down` fails with
  "network sce-net not found".
- **Kubernetes mode.** `stack/k8s-stack.sh` and `driver/k8s_unit.py` (`--target k8s`)
  are a separate mode with their own README notes; the single-node path above does
  not use them.
- **Local-dev mode.** `stack/localdev-stack.sh`, `driver/localdev_unit.py` (`--target
  localdev`) and `run-localdev.sh` are another mode (last section). Its JVM services use
  local-dev's fixed ports, 8080 among them, so it never runs beside the single-node stack;
  the stack lock serializes them.
- **One working tree, several agents.** Agents commit in this checkout at the same
  time, and the git index is shared: a plain `git commit` takes whatever another
  agent has staged. Commit with `git commit --only -- <your paths>` (a new file
  needs `git add -N` first), and leave files you did not write alone.
- **Python exceptions do not end a run.** A Python UDF exception leaves the
  workflow `Running`, with its worker paused, until someone kills it. This is
  upstream behavior in the published images, not something the harness
  introduces. The harness turns it into a fast FAIL, as described under the
  transport seam above.

## Kubernetes mode: `stack/k8s-stack.sh` and `run-k8s.sh`

The same scenarios against a real Kubernetes deployment: OrbStack's cluster (kube
context `orbstack`), Texera installed from a worktree's Helm chart (`bin/k8s`) with the
images under test, the browser's path through Envoy Gateway (ext-authz to
access-control-service, then dynamic routing to the unit pod), and a computing unit
that the driver creates through computing-unit-managing-service, as the frontend does.

```
LOCK=<scratchpad>/sce/stack.lock                                  # the stack lock ("One run at a time")
./run-k8s.sh --lock $LOCK --images sce/step1 --source <worktree>  # clean namespace, deploy, a-e and u, checks, logs, down
./run-k8s.sh --lock $LOCK --source <worktree>                     # the published images, same chart

# by hand, holding the lock yourself:
stack/k8s-stack.sh --source <worktree> up --images sce/step1      # deploy only: http://127.0.0.1:30080
driver/run.sh --target k8s [--scenario a,d]                       # against it
stack/k8s-stack.sh down
```

`run-k8s.sh` refuses to start without `--lock <dir>` (or `SCE_STACK_LOCK`): it begins with
`down`, so an unlocked run would tear down another run's deployment, and the Docker VM is
shared with the single-node stack. `--no-lock` is only for a machine where nothing else
deploys. The lock is taken with `mkdir` (the run waits while another holds it), its owner
file names the run, and it is released at the end. The run is bounded: `--time-limit`
(default 40 minutes from taking the lock, `SCE_K8S_TIME_LIMIT`) stops whatever step is
running, after which the logs are collected, the deployment is taken down and the lock is
released (exit 5), so the lock is held under 45 minutes even then. A normal run holds it
for about 7 minutes.

Never start, stop or reconfigure OrbStack's Kubernetes from a script: toggling it
restarts Docker and every container on the machine. `up` only checks that the context
answers.

### What `up` does

1. Copies `<source>/bin/k8s` to `stack/k8s/generated/chart/`, dereferencing symlinks so
   `files/*.sql` carry the worktree's `sql/` DDL, and resolves the subcharts there with
   `helm dependency update`. The result is cached in `generated/deps-cache/`, keyed by
   Chart.yaml's dependency list. The repository's `Chart.lock` still lists minio where
   `Chart.yaml` has rustfs, so `helm dependency build` (what `bin/k8s/install.sh` runs)
   fails. The worktree is never written to.
2. Writes `generated/values-sce.yaml`, layered after the chart's `values-development.yaml`
   (`--profile default` drops that layer):
   - `texera.imageRegistry` and `texera.imageTag` from `--images`. They name every Texera
     service and `KUBERNETES_IMAGE_NAME`, the image the managing service starts units from;
   - pull policy `Never` for a local registry (`sce`), `IfNotPresent` otherwise, for the
     services and, through `KUBERNETES_IMAGE_PULL_POLICY`, the unit pods. OrbStack's
     cluster runs on Docker's image store, so the local tags are already there;
   - units in `<namespace>-units` (`workflowComputingUnitPool.namespace`);
   - agent-service, LiteLLM, notebook migration (and its Jupyter pool) and the example
     data loader turned off;
   - the workarounds listed below.
3. Renders the chart into `generated/rendered.yaml`, checks that every Texera image is in
   the local Docker store and that units would start from `--images`, and writes
   `generated/MANIFEST.json`: source commit, resolved subcharts, image IDs, values files,
   workarounds.
4. Preflight. The context must answer. No other Envoy Gateway controller may run (see
   below). GatewayClass `eg` must not belong to another release. Neither namespace may
   exist. The port must be free.
5. Compares the cluster's CRDs with the chart's: the Gateway API bundle and Envoy
   Gateway's own CRDs, all shipped in the gateway-helm subchart's `crds/`. Helm installs a
   chart's CRDs only when they are absent, and never upgrades or deletes them, so CRDs
   left by an earlier install stay in force. Each CRD's versions and schemas are hashed
   on both sides (the API server keeps them as applied). Absent CRDs are fine (Helm
   installs them). If any differ, `up` refuses, naming them with their bundle versions
   and creation times, unless `--allow-crd-drift` is given. The outcome is
   `MANIFEST.json`'s `crds`.
6. `helm install texera` into the namespace (default `sce-k8s`). Then waits for every
   Deployment, StatefulSet and DaemonSet and for the lakeFS and Lakekeeper init Jobs,
   and fails fast on image errors or a failed Job. The y-websocket and Python language
   servers are not waited for: the chart has no switch for them, and they are not on a
   run's path. Crash loops are judged against Postgres. The chart has no
   wait-for-database step, so every JVM service and lakeFS crashes with `Connection to
   texera-postgresql:5432 refused` until Postgres is up, 3 or 4 times on a normal `up`.
   A crash loop therefore fails `up` only once its container has restarted 3 more times
   after `texera-postgresql` became Ready (Postgres itself: 6 restarts). The restarts
   before that are recorded under `readiness` in the manifest.
7. Exposes the gateway on `127.0.0.1:<port>` (default 30080) and checks that every
   backend answers through Envoy: `/api/healthcheck` 200 from the webserver, and any
   status but Envoy's 502/503/504 from config-service, the managing service, file-service
   and the compiling service.
8. Checks that ext-authz refuses. It sends three workflow-websocket handshakes through
   the gateway: no token, a bogus token, and texera's own token for cuid 999999, a unit
   nobody has access to. Each carries a `sce-probe=<marker>` query parameter. Each must
   get 401 or 403, and Envoy's access-log entry for its marker must say
   `response_code_details: ext_authz_denied`: Envoy refused because ext-authz said no,
   not because a backend did. A refusal that is not ext-authz's fails `up`. So does a
   handshake that is let through. A refusal whose entry has not reached the log after
   45 s only warns. The outcome is `MANIFEST.json`'s `gateway_refusals`.

`down` deletes the Gateway and GatewayClass while the release's Envoy Gateway still
runs, uninstalls the release, and deletes both namespaces without waiting out pod grace
periods. That removes any unit pod and the PVCs, and local-path deletes their volumes.
It also removes the cluster-scoped objects Helm leaves behind: the Envoy Gateway
subchart's hook ClusterRole, ClusterRoleBinding and topology webhook, all named after
the namespace. It does not remove the CRDs: Helm never deletes them, and other
installs may use them. They are cluster-wide and outlive every run, which is why
`up` compares them with the chart's. A full `down` takes about 20 s. Other commands:
`status`, `logs <alias|deploy/name|unit|unit-<cuid>|envoy>`,
`port-forward start|stop|status`, `collect-logs <dir>`, `follow-units <dir>` and
`post-run <report>` (see `run-k8s.sh` below).

### The gateway on 127.0.0.1

OrbStack does not publish Services on the Mac (`k8s.expose_services` is off), so the
gateway is forwarded. The default, `--forward relay`, is `stack/k8s/gateway_relay.py`: a
TCP relay to the envoy Service's ClusterIP, which OrbStack routes from macOS. When the
relay's interpreter cannot reach the ClusterIP, `up` fails and says so. It never falls
back to kubectl on its own. `kubectl port-forward` is used only when asked for
(`--forward kubectl`). It exits ("lost connection to pod") as soon as Envoy resets any
one forwarded connection, and the end of every workflow websocket does that. The harness
restarts it a second later, but requests in between fail: in the first trial, every
scenario after the first failed with "connection refused". So a run through it is marked
unreliable. The manifest's `gateway_forward` has `reliable: false` and a warning, and
`post-run` sets `summary.reliable: false` in the report and warns that failures may be
the forwarder's.

The relay runs under `/usr/bin/python3`. macOS's Local Network privacy check refuses
192.168.x.x to the harness venv's ad-hoc-signed Python (`EHOSTUNREACH`, "No route to
host") but not to Apple-signed binaries such as `/usr/bin/python3` and `curl`. The same
check is a likely cause of the earlier note that Bun could not reach the LoadBalancer IP.

### The driver in Kubernetes mode

`driver/run.sh --target k8s` (or `--unit-kind kubernetes` with any `--base`; `--base`
defaults to the manifest's gateway URL). The code is in `driver/k8s_unit.py`; `e2e.py`
only calls it.

What needs the single-node stack is refused before any setup, with the reason:

- `--evidence`, `--negative-control`, `--gate` and `--legacy-env`. They read the
  single-node Postgres log and `docker exec` into its fixed container names, which on
  this machine belong to another run's stack.
- Scenarios g0, g, h and o, which `docker exec` into the single-node unit container.
- l4 and l9, which create local units at `--unit-uri`.
- On `create-ws`, the scenarios that need the second user (j, l2, l3, l5, l7, l10): the
  driver gives that user a local unit. j on `ws` runs.

`--stack-manifest` defaults to `stack/k8s/generated/MANIFEST.json`, not the single-node
one. As a second guard, the driver sets `DOCKER_HOST` to a socket that does not exist.
Docker's CLI prefers it to any context, so nothing the driver runs in Kubernetes mode can
reach a container on this machine.

1. Setup is the same as in single-node: log in, upload the dataset, create the warehouse.
2. Instead of the local unit row, the driver:
   - checks `GET /api/computing-unit/types` offers `kubernetes` and reads `/limits`;
   - terminates leftover units named `sce-e2e-k8s-*`;
   - calls `POST /api/computing-unit/create` with
     `{unitType: "kubernetes", cpuLimit, memoryLimit, gpuLimit, jvmMemorySize: "1G",
     shmSize: "64Mi"}`. These are the frontend's defaults: the first CPU and memory option
     offered, GPU 0. `--k8s-unit-*` overrides them.
3. Polls `GET /api/computing-unit/{cuid}` until `Running`. `Failed` and `Unknown` fail at
   once, with the status reason. Then it opens the workflow websocket through the
   gateway until the unit answers the handshake: the pod reports Running before its JVM
   listens, so for the first second or two Envoy answers 503.
4. Opens the same socket without valid credentials: no token, a bogus token (both for
   the live unit), and its own token for a cuid that does not exist. The gateway must
   refuse each (401/403), or setup fails and the unit is terminated. Each probe carries
   a `sce-probe` marker, so `post-run` can check in Envoy's log that ext-authz refused it.
5. The scenarios select that unit exactly as single-node selects the local one: the
   websocket's `cuid=` and `computingUnitId`.
6. At the end it calls `DELETE /api/computing-unit/{cuid}/terminate`, also from an atexit
   hook if the driver dies; `--keep-unit` skips this.

The report gains `target` and `setup.kubernetes_unit`: the request, the status history,
the seconds to Running and to answering, the gateway probe, the refusal probes
(`gateway_refusals`) and the termination.

### `run-k8s.sh`

```
./run-k8s.sh --lock <dir> | --no-lock  [--images <registry>/<tag>] [--source <worktree>] [--port N]
             [--keep] [--label text] [--time-limit MIN] [--no-workarounds] [--forward relay|kubectl]
             [--allow-crd-drift] [-- <driver args>]
```

The run goes like this:

1. Takes the lock and starts the clock.
2. Runs `down`, then `up`, and starts following the unit pods' logs.
3. Runs the driver with `--target k8s`.
4. Runs `stack/k8s-stack.sh post-run <report>`. This waits up to 90 s for the unit's pod
   to go and reads Envoy's entries for the driver's refusal probes. It writes the outcome
   into the report as `post_run`, and into the logs directory as `post-run.json`:
   - A unit pod left behind fails the run (`summary.result` becomes FAIL, with
     `summary.post_run_failures`), unless the driver ran with `--keep-unit`.
   - So does a probe that ext-authz did not refuse.
   - A run through kubectl port-forward gets `summary.reliable: false`.
5. Collects the logs, runs `down` and releases the lock, also when a step fails, the
   time limit is reached or the run is interrupted (INT or TERM). Everything a step
   started is stopped first. `--keep` skips `down`, but the lock is still released.

Exit codes:

| Code | Meaning |
|---|---|
| 0, 1, 2 | The driver's |
| 3 | The deployment did not come up |
| 4 | The driver passed but `post-run` failed |
| 5 | The time limit was reached |
| 64 | Usage error, including a missing `--lock` |

It writes `reports/k8s-<time>.json` and `reports/k8s-<time>-logs/`. The logs directory
holds:

- every container's log (previous instances too), descriptions and events;
- the gateway objects and the release's values;
- `harness-git.txt` and `post-run.json`;
- `units/`, the unit pods' logs, streamed while they live (a terminated unit's pod is
  deleted).

### Workarounds and choices (each recorded in MANIFEST.json)

| What | Why | Upstream? |
|---|---|---|
| `STORAGE_S3_ENDPOINT=http://texera-rustfs-svc:9000` added through `texeraEnvVars` | The chart's webserver Deployment sets no `STORAGE_S3_*`, so `POST /api/warehouse` builds per-user Lakekeeper warehouses on storage.conf's `http://localhost:9000`. `texeraEnvVars` is the only values hook that reaches the webserver. The chart's other S3 values already equal storage.conf's defaults. Step 2 sub-part 7 fixes this; the step-1 chart does not have the fix. `up` renders the chart first and adds the variable only when the rendered Deployment that runs the dashboard image (found by image, whatever its name) gets no `STORAGE_S3_ENDPOINT` through `env` or an `envFrom` ConfigMap or Secret; `MANIFEST.json`'s `webserver.s3_endpoint_from_chart` records what the chart gave. `--no-workarounds` turns it off | chart bug |
| `helm install --server-side=false` | A consequence of the row above: file-service and the managing service now list `STORAGE_S3_ENDPOINT` twice (same value), and Helm 4's default server-side apply rejects duplicate keys | no |
| `helm dependency update` in a scratch copy | `Chart.lock` is out of sync with `Chart.yaml` | chart bug |
| Release name `texera` | `gateway-routes.yaml` points the dynamic route at Backend `texera-dynamic-backend`, whatever the release is called, and the values hard-code `texera-postgresql` and `texera-rustfs-svc` | chart limitation |
| No other Envoy Gateway in the cluster | The `gateway-helm` dependency has no `condition`, so the chart always installs a controller, and two controllers both reconcile GatewayClass `eg`. The earlier proof's release `eg` (namespace envoy-gateway-system) was uninstalled on 2026-11-16 for this reason. `up` refuses to run beside another controller and never touches it | chart limitation |
| Gateway and GatewayClass deleted before `helm uninstall` | Envoy Gateway puts a finalizer on GatewayClass `eg`. Once its controller is uninstalled, nothing removes the finalizer and the class hangs in Terminating, which blocks the next install. This happened in the first trial; `up` and `down` now also clear such a finalizer when the class is this release's | ordering of chart parts |
| Optional services off | Not on a run's path, and memory: the Docker VM's 8 GB is shared with the single-node stack | no |
| Crash loops judged against Postgres's readiness | The chart has no wait-for-database step, so the JVM services and lakeFS crash until Postgres is up (step 6 of `up`) | chart limitation |
| CRDs stay after `down` and are compared on `up` | Helm installs CRDs only when absent and never upgrades or deletes them (step 5 of `up`) | Helm behavior |

Like single-node, the unit logs a warning when it reads a dataset: the presigned URL
from lakeFS points at `localhost:31000` (the chart's `pre_signed_endpoint`), which a pod
cannot reach, so it falls back to a direct lakeFS fetch.

### Verified

2026-11-16, OrbStack Kubernetes v1.33.9 (one node, 10 CPU, 8 GB shared with Docker),
Helm v4.2.0. Chart and DDL from `sce-imgbuild` at the Step 1 commit `5e85a37de`. The
harness ran from a `git archive` copy of `3b28d86`, so the evidence is tied to a commit
(the driver was being edited at the time); the third row reran the final commit,
`fade0db`. Each run started from no namespace and ended with `down`.

| Report (`reports/`) | Images | Result | Notes |
|---|---|---|---|
| `k8s-20261116T101706Z` | `sce/texera-*:step1` | a b c d e u PASS, 49/49 checks | `up` 124 s; unit Running 2.6 s after create, answering through the gateway at 5.3 s; `down` 22 s |
| `k8s-20261116T102034Z` | `sce/texera-*:step1` | a b c d e u PASS, 49/49 checks | `up` 75 s; unit 2.5 s / 5.2 s; `down` 21 s |
| `k8s-20261116T103323Z` | `sce/texera-*:step1` | a b c d e u PASS, 49/49 checks | the final commit `fade0db`: `up` 75 s; unit 2.7 s / 5.3 s; `down` 20 s; the unit log's first line names image ID `sha256:bf87e878...`, the one `build/step1/BUILD-MANIFEST.json` records |
| `k8s-20261116T102304Z` | `ghcr.io/apache/texera-*:latest` (published) | a b c d e u PASS, 49/49 checks | `up` 77 s; unit 2.5 s / 5.1 s; `down` 19 s |
| `k8s-20261116T102547Z` | `sce/texera-*:step1`, `--no-workarounds` | setup FAIL (control) | `POST /api/warehouse` -> 502: `Lakekeeper create warehouse 'user-1-1' failed (HTTP 400): ... "Failed to decompress file: Failed to finish decompressing file: invalid gzip header", "type": "FileDecompressionError"` |
| `k8s-20261116T102748Z` | published, `--no-workarounds` | setup FAIL (control) | the same error |

What the runs establish:

- The chart deploys as it is, with Helm 4's server-side apply (the control runs). With the
  S3 workaround it deploys with client-side apply.
- Every Texera service and every unit pod ran the requested image. The kubelet events
  show `Container image "sce/texera-workflow-execution-coordinator:step1" already
  present` for `computing-unit-1`, and the manager's `KUBERNETES_IMAGE_NAME` names that
  image. The logs directories hold both.
- Every workflow websocket went through ext-authz. access-control-service logged
  `Authorizing request for path: auth/wsapi/workflow-websocket`, then
  `Routing CU 1 to recorded host:
  computing-unit-1.texera-workflow-computing-unit-svc.sce-k8s-units.svc.cluster.local:8085`.
- The unit went Pending -> Running through the managing service and was terminated
  through it (HTTP 200); its pod was gone after the run.
- `down` left no namespace, release, GatewayClass, metrics APIService, hook object or
  PersistentVolume behind. The Gateway API and Envoy Gateway CRDs stay: Helm never
  deletes CRDs. Those in the cluster predate the harness (created 2026-11-06) and match
  the chart's: Gateway API bundle v1.4.1, the one gateway-helm 1.6.3 ships.

Branch against upstream: no difference in Kubernetes mode. Both pass all six
scenarios with the same checks and similar timings. No scenario fails on both. The one
upstream defect is the chart's: without the S3 workaround, setup fails identically on
both image sets.

`driver/tests/test_k8s_unit.py` and `driver/tests/test_k8s_stack.py` add offline tests of
the Kubernetes path to the offline suite.

**After the review fixes.** These guard rails were added after the review: the lock, the
time limit, the CRD comparison, the crash-loop rule, the ext-authz refusal checks, the
forward without a fallback, the driver's refusals and `post-run`. They were then verified
on the final code: harness `90597f6`, run from a `git archive` copy by
`./run-k8s.sh --lock ... --images sce/step1`, chart `5e85a37de`, from no namespace,
ending with `down`. The offline suite passed 80 of 80 on the same code (`38fac82`; only
`run-k8s.sh` and the README changed after it).

| Report (`reports/`) | Images | Result | Notes |
|---|---|---|---|
| `k8s-20261116T112432Z` | `sce/texera-*:step1` | a b c d e u PASS, 49/49 checks; `post-run` ok | `up` 135 s; unit Running 3.3 s after create, answering at 7.8 s; `down` 19 s; the lock was held 3 minutes |

What the run adds:

- **CRDs.** All 20 of the chart's CRDs were in the cluster exactly as the chart has
  them (Gateway API bundle v1.4.1), so `up` went ahead.
- **Crash loops.** Postgres was Ready by the time `helm install` returned: Helm waits
  for the chart's hook Jobs, which need the database. The six services that use
  Postgres had restarted twice each before that, and none restarted after.
- **Refusals at `up`.** No token, a bogus token, and texera's token for cuid 999999 each
  got 403. Envoy's entry for each says `ext_authz_denied`, with response flag `UAEX`.
- **Refusals by the driver.** On the live unit's socket, no token and a bogus token each
  got 403, and so did texera's token for cuid 100001. `post-run` found each in Envoy's
  log as `ext_authz_denied`. Envoy logged 15 requests on `texera-dynamic-routes`: 9
  routed (3 readiness attempts, 6 scenarios, each with a `Routing CU 1` line from
  access-control-service) and 6 denied.
- **Image.** The unit pod ran `sce/texera-workflow-execution-coordinator:step1`, image ID
  `sha256:bf87e878...`, the one `build/step1/BUILD-MANIFEST.json` records.
- **Cleanup.** `post-run` found no unit pod left, and the forward was the relay
  (`summary.reliable: true`). After `down` the cluster had only its own namespaces. No
  Helm release, GatewayClass, metrics APIService, hook object or PersistentVolume was
  left, no relay or follower process ran, and port 30080 was free. The CRDs stay, as
  described above.

## Local-dev mode: `stack/localdev-stack.sh` and `run-localdev.sh`

The same scenarios against Texera run the way `bin/local-dev.sh` runs it on a developer's
machine: the infrastructure in Docker, every JVM service as a host process started from its
dist launcher, and the frontend on the Angular dev server. The driver talks only to the dev
server (`http://localhost:4200`), whose proxy (`frontend/proxy.config.json`) sends `/api` to
each service on its fixed port and `/wsapi` to the computing unit, exactly as a developer's
browser does. The source is a worktree of its own (default
`texera-worktrees/sce-localdev-src`, `--source` or `$SCE_LOCALDEV_SOURCE`), because the build
and the services write into it. All of that is gitignored output (`git status` stays clean):
`target/` directories, jOOQ's generated sources, amber's Python protobufs and `__pycache__`,
`frontend/node_modules` and `.angular/`, and the services' own `log/`, `logs/` and `amber/logs/`.

On the Step 1 source, `bin/local-dev.sh up` itself stops at its schema step, on any fresh
volume: `sql/updates/31.sql` fails. That is a bug of the repository's local-dev ("local-dev's
schema step" below). This mode runs the step as local-dev does, records the failure as a
deviation and goes on; `--strict-schema` stops it there instead.

```
LOCK=<scratchpad>/sce/stack.lock
stack/localdev-stack.sh build --codegen-only   # under the lock: Postgres alone for jOOQ's codegen (~30 s)
stack/localdev-stack.sh build                  # no lock needed: sbt dist of the six services (~90 s here)
./run-localdev.sh --lock $LOCK --reset         # clean start, up, a-e and u, post-run, down, lock released

# by hand, holding the lock yourself:
stack/localdev-stack.sh up [--strict-schema]   # http://localhost:4200 (dev server)
driver/run.sh --target localdev [--scenario a,d]
stack/localdev-stack.sh status | logs <svc> [-f]
stack/localdev-stack.sh down                   # `reset` also removes the volumes
```

### What it reads from the source

local-dev's own configuration, from the source's `bin/local-dev/main.sh`, so the mode follows
the branch's local-dev: its `DOCKER_INFRA_SERVICES`, its service catalog (`SERVICES` in start
order, each JVM service's `SVC_LAUNCHER`, `SVC_CWD`, `SVC_ZIP_GLOB`, `SVC_PORT`, `SVC_HEALTH`),
its environment (every `export X="${X:-default}"`) and its schema step (the functions `up`
runs right after the infrastructure, below). The infrastructure is
`bin/single-node/docker-compose.yml` merged with `bin/local-dev/docker-compose.override.yml`,
as local-dev's `docker compose -f ... -f ...` merges them. `generate` writes
`stack/localdev/generated/` (`docker-compose.yml`, `.env`, `sql/`, `service.env.json`,
`MANIFEST.json`); a round-trip check proves every kept service is the source's except for
the keys rewritten on purpose (names, network, ports, the DDL mount, lakekeeper-init's
`STORAGE_S3_ENDPOINT`). A changed shape of main.sh stops `generate` with the reason.

### What `up` does

1. Refuses to start when this stack already runs, or when any port it needs is taken by a
   container or a host process (it names the holder and never stops anything); the unit's
   Pekko port 2552 is one of them. Refuses a dist zip that does not match the source (see
   "Builds"). Checks JDK 17 (`$JAVA_HOME`, `java_home -v 17`, SDKMAN), node 24 (nvm) and the
   UDF Python (below).
2. Infrastructure: `docker compose up -d` (project `e2e-localdev`), then waits for the
   healthchecks and the three init jobs (exit 0). Checks that Lakekeeper's default warehouse
   stores the LAN endpoint and that RustFS answers there from the host.
3. local-dev's schema step, as `bin/local-dev.sh up` runs it right after `infra_up` (next
   section). On this source it fails, as it does for local-dev; `up` goes on and records the
   deviation, or stops with `--strict-schema`.
4. Builds what is missing: `sbt dist` when a dist zip is missing (against this stack's
   Postgres, see "Builds"), amber's Python protobufs when `amber/src/main/python/proto` is empty
   (`bin/python-proto-gen.sh` with the betterproto plugin at amber's pin), `yarn install
   --immutable` (node 24) when `frontend/node_modules` is missing or older than `yarn.lock`.
   local-dev decides differently: it rebuilds a service whenever a hash of its sources changed
   since its last build, or a launcher is missing. The harness builds only a missing zip (what
   this mode was asked to do, to keep sbt off a shared machine) and refuses a stale one instead
   of rebuilding it.
5. Unzips each dist under `.state/localdev/dist/` (again when the zip changes) and starts the
   services in local-dev's order, each in its own process group, from local-dev's working
   directory: the worktree root, and `amber/` for the dashboard and the unit (amber finds its
   config and its Python tree from there). Pid files (pid, process group, start time, command)
   go to `.state/localdev/pids/`, each service's output to `<logs>/<service>.log`. `up` waits
   until each service listens on local-dev's port and answers its health check: local-dev's
   `SVC_HEALTH`, or, where it has none, `/api/healthcheck` on the managing service's
   application port and `/api/execution/health` on the unit.
6. Starts `ng serve` in the source's `frontend/` (node 24, `--max-old-space-size` taken from
   `yarn start`, 8192: with 4096 the dev build runs out of memory in its setup phase; it peaks
   at about 4.4 GB), waits until `http://localhost:4200/` serves the app, then checks through
   the proxy that `/api/healthcheck` (the dashboard) and `/api/config/pre-login` (config-service,
   the first thing a browser loads) answer 200. A normal `up` takes about a minute.
7. Compares the TCP ports each process group listens on (`lsof`) with the ports step 1
   reserved for it, and warns about any other: a port the pre-flight check cannot see taken.
   The manifest records them (`listening`).

| Service (local-dev's name) | Port | Working dir | `JAVA_OPTS` |
|---|---|---|---|
| config-service | 9094 | worktree | `-Xmx512m -XX:+ExitOnOutOfMemoryError` |
| access-control-service | 9096 | worktree | `-Xmx512m ...` |
| file-service | 9092 | worktree | `-Xmx512m ...` |
| workflow-compiling-service | 9090 | worktree | `-Xmx1g ...` |
| computing-unit-master (the unit, `ComputingUnitMaster`) | 8085 (Pekko 2552) | `amber/` | `-Xmx1g ...` |
| computing-unit-managing-service | 8888 (local-dev watches its admin port 8082) | worktree | `-Xmx512m ...` |
| texera-web (the Dashboard, `TexeraWebApplication`) | 8080 (admin 8081) | `amber/` | `-Xmx1g ...` |
| frontend (`ng serve`) | 4200 | `frontend/` | node `--max-old-space-size=8192` |

`--heap NAME=SIZE` (or `all=SIZE`) changes a heap; `--frontend-heap MB` the dev server's.

### local-dev's schema step, and the repository bug it hits

**What local-dev does.** `bin/local-dev.sh up` runs `infra_ensure_db_schema` right after
`infra_up` and before the build. On a fresh volume Postgres has already run `sql/` itself
(compose mounts it as `/docker-entrypoint-initdb.d`), so the `feedback` table exists and the
step replays every changeSet of `sql/changelog.xml` that `public.databasechangelog` does not
list: all 30 (23 to 52) on a fresh volume, each through `psql -v ON_ERROR_STOP=1`, each recorded
afterwards. A failed changeSet is accepted only when every psql error says "already exists".
Any other failure ends `up`: main.sh runs under `set -euo pipefail`, and `cmd_up` calls the step
as a plain statement.

**How the harness runs it.** The four functions (`infra_ensure_db_schema`,
`infra_apply_sql_updates`, `parse_changelog_changesets`, `_sql_errors_all_already_exist`) are
copied from the source's main.sh into `<logs>/local-dev-schema/schema-step.sh` unchanged but for
the container name (`local pg="texera-postgres"` becomes `e2e-localdev-texera-postgres`), and
run by the bash main.sh's `#!/usr/bin/env bash` finds (Homebrew bash 5.3 here), with `REPO_ROOT`
the source and `LOG_DIR` that directory. Stand-ins for local-dev's `tui_*` output helpers print
local-dev's messages as tab-separated lines the harness reads back. The outcome goes into
MANIFEST.json `schema` (changeSets applied, already in the schema, recorded and not; the failure
and psql's error) and so into the report. Whether a failure ends local-dev's `up` is read from
main.sh too: a plain call in `cmd_up`, `set -e`, a plain dispatch of `up`. If main.sh changes
shape (a function or the container line gone, or `cmd_up` no longer running the step), `up`
stops and says so. `build` runs the step too, before jOOQ's codegen, as local-dev reconciles the
schema before any build.

**When it fails.** With `--strict-schema` (or `$SCE_LOCALDEV_STRICT_SCHEMA=1`; `run-localdev.sh
--strict-schema`), `up` stops where local-dev's `up` stops: exit 1 before the build and any
service (run-localdev.sh exits 3). By default it goes on, as a recorded deviation. The changeSets
from the failed one on stay unapplied and unrecorded, as local-dev leaves them. MANIFEST.json
`local_dev_deviations`, the end of `up`, `status`, `post-run` and the report's
`summary.local_dev_deviations` name the deviation; it does not change `summary.result`.

**The bug (a local-dev bug of the repository).** At the Step 1 commit `5e85a37de`, and at
upstream main `205fe77c4` (the newest fetched here; its `sql/` and `bin/local-dev/` are
identical to Step 1's), the step fails on every fresh volume:

```
postgres: sql/updates/31.sql failed
psql:<stdin>:29: ERROR:  constraint "ck_nulltest" of relation "user" does not exist
```

It applies 23 to 27, 29 and 30, accepts 28 (`dataset_owner_uid_name_key` already exists) and
stops at 31. `sql/texera_ddl.sql` no longer defines `ck_nulltest`: 33.sql moved the credentials
from `user` to `auth_provider` and dropped the constraint (`IF EXISTS`). 31.sql still drops it
without `IF EXISTS`, and the rule accepts only "already exists" (#7064's fix). So
`bin/local-dev.sh up` exits before the build, on a fresh volume and on every later `up`, since
31 is never recorded. The probe below shows it: on the kept volume, with 23 to 30 recorded, 31
fails first. Step 1 changes neither `sql/` nor `bin/local-dev`.

The schema itself is complete: the DDL already holds every update, and the review's replay of 23
to 52 changed nothing in a `pg_dump --schema-only`. That is why the services work once the
harness goes on. The fix belongs upstream: `DROP CONSTRAINT IF EXISTS` in 31.sql, or a rule that
also accepts a replayed drop of what the DDL no longer has.

### The services' environment

local-dev's exports, with the infrastructure ports remapped: `STORAGE_JDBC_URL` and the
Iceberg Postgres URI on `localhost:15432`, `STORAGE_LAKEFS_ENDPOINT` on 18000,
`STORAGE_ICEBERG_CATALOG_REST_URI` on 18181, and `STORAGE_S3_ENDPOINT=http://<LAN IP>:19000`
(the LAN IP detected as local-dev detects it: the default route's interface, else en0-en10;
`$HOST_LAN_IP` or `--lan-ip` override). `STORAGE_ICEBERG_CATALOG_TYPE=rest`, as local-dev sets
it. Added: `UDF_PYTHON_PATH`, `JAVA_HOME`, `PATH` (JDK first), `HOST_LAN_IP`, `LANG`, and the
heap cap. Nothing else from the caller's environment reaches the services (no stray
`STORAGE_*`, no `AWS_*` for the Python workers' S3 client). `MANIFEST.json` records it, secrets
masked.

UDF workers run on a Python 3.11 venv with amber's requirements: `--python`,
`$SCE_LOCALDEV_PYTHON`, `.state/localdev/py311` (`stack/localdev-stack.sh venv` builds it with
uv) or, by default, the step-1 checks' venv `<scratchpad>/sce/step1cd/py311`, used read-only.
`up` refuses an interpreter that cannot import pyarrow, pandas and loguru (local-dev's check)
and reports every pin of `amber/requirements.txt` it does not match. local-dev itself looks
for a 3.12; an explicit `UDF_PYTHON_PATH` is its documented override.

### How it stays away from other stacks

- Compose project `e2e-localdev`; containers `e2e-localdev-<original container name>` (for
  example `e2e-localdev-texera-postgres`) with the original service and container names as
  aliases on the project's own network `e2e-localdev-net`; volumes `e2e-localdev_postgres_data`
  and `e2e-localdev_rustfs_data`. local-dev's own compose would name its containers
  `texera-postgres` and so on and join the network `texera-single-node`, so it cannot run beside
  the user's single-node stack; this copy can.
- Infrastructure host ports moved by 10000. Postgres 15432, LakeFS 18000 and Lakekeeper 18181
  are bound to 127.0.0.1 only; RustFS 19000 is published on all interfaces, as upstream, because
  the LAN endpoint must be reachable from Lakekeeper's container and from the host's JVMs and
  Python workers. Here 5432 belongs to `texera-tripwire-pg` and 8000 to `texera-lakefs`.
- The services keep local-dev's ports, which `proxy.config.json` names.
- `down` stops only the processes it started (each pid file's start time is checked; a pid
  now owned by another process is left alone), newest first: the dev server, then the services
  in reverse start order (a nanosecond stamp in each pid file). Leftovers without a pid file
  are found by what they run:
  - a JVM by its dist under `.state/localdev/dist`;
  - the dev server and its esbuild by their working directory, the source's `frontend/` (the
    Angular CLI retitles its process, so `ps` shows `ng serve (gui)` rather than the node
    command line), or as whoever listens on 4200 from there;
  - the unit's Python workers by `texera_run_python_worker` in the source's `amber/`.

  A leftover's whole process group is stopped when the group is the stack's (the leftover leads
  it, or its leader is gone or a leftover too); otherwise only the process is. Each group gets
  SIGTERM, then SIGKILL after 20 s (a zombie no longer counts as a member), so the unit's Python
  workers go with it. Then `docker compose down` of the project. `down` fails, naming them, if a
  container, the network or a process of the stack remains. Volumes stay; `reset` removes them.
  The source worktree is the harness's own, so a dev server in its `frontend/` is this stack's.

Left out: LiteLLM and Jupyter (infrastructure), notebook-migration-service and agent-service
(services), and `yarn start`'s y-websocket process (shared editing, `/rtc`). None of them is on
a workflow run's path.

### Builds (`stack/localdev-stack.sh build`)

common/dao's jOOQ codegen reads the schema from Postgres while sbt compiles. Two phases:

1. When jOOQ's generated sources are missing (or `--force`), this stack's Postgres is started
   alone (Docker: hold the lock), `sbt DAO/compile` runs against it, and the container is
   removed. About 30 s.
2. `sbt <Project>/dist` for the six services (images/build.sh's list). No Docker: with Postgres
   gone the codegen fails fast ("Connection to localhost:15432 refused") and the generated
   sources stay, as `common/dao/build.sbt` intends. The betterproto plugin is put last on `PATH`,
   so amber's compile regenerates the Python protobufs itself (`genPythonProto`). About 90 s here.

`--codegen-only` stops after phase 1, so phase 2 can run without the lock. Phase 1 runs
local-dev's schema step before the codegen (with `--strict-schema` as for `up`). `--force`
regenerates jOOQ (Postgres: hold the lock) and rebuilds every dist. sbt runs as local-dev runs it
(`-no-colors -J-XX:+UseG1GC`), with the heap capped at 3g (`$SCE_LOCALDEV_SBT_HEAP`). `up` builds
by itself when a zip is missing, with the infrastructure already up.

**What a dist was built from.** Each build records, in `.state/localdev/dist-provenance.json`,
what every zip it wrote was built from: the source's HEAD and its build inputs with uncommitted
changes, read before sbt starts. If HEAD moves or a build input is modified while sbt runs, the
commit is left unknown. Build inputs are the files under a JVM project's `src/main` (amber's
Python tree aside: the unit runs it from the worktree), `*.sbt` and `project/`, tracked or
untracked; ignored ones (jOOQ's generated sources) are left out.

`up` refuses a zip, before starting anything, when:

- its record names another commit and a build input differs between the two;
- its record says the source changed while it was built;
- a build input was modified after the zip was written. That is local-dev's own first check
  (`svc_src_changed`'s fast path).

`--allow-stale-dists` runs it anyway, as a warning. A zip without a record (built outside the
harness, or before it recorded builds, like the zips of the runs below) is only a warning: its
commit is not recorded, only that no build input changed after it was written. local-dev itself
assumes such a jar matches the sources (its "lazy seed"). Each service's `zip_provenance` is in
the manifest.

### The driver in local-dev mode

`driver/run.sh --target localdev` (code in `driver/localdev_unit.py`). `--base` defaults to the
manifest's dev server URL, `http://localhost:4200`. Every REST call and every workflow socket
goes through the dev server's proxy.

local-dev registers no unit by itself. A developer gets one from the workspace's unit
selector. The create dialog offers the types of `GET /api/computing-unit/types`, and here that
is only `local`, since Kubernetes units are off. "Connect to a Local Computing Unit" sends
`POST /api/computing-unit/create` with `{name, unitType: "local", cpuLimit: "NaN", memoryLimit:
"NaN", gpuLimit: "NaN", jvmMemorySize: "NaN", shmSize: "NaN", uri}`. The URI is the dialog's
default, `buildLocalComputingUnitUri(window.location)`, which is the page origin plus `/wsapi`
(`http://localhost:4200/wsapi`). The workflow socket then opens at
`/wsapi/workflow-websocket?...&cuid=<that unit>` on the page origin, and the proxy forwards it
to the unit on 8085. The unit takes the user from the token in the query and uses the cuid
only as a key.

Setup does the same:

1. It checks that the base serves the Texera app (`<texera-root>`).
2. It checks that `local` is offered.
3. It creates the unit with the dialog's body and URI, or reuses its own.
4. It opens a workflow socket through the proxy until the unit answers.

The scenarios then select that unit by cuid, as in single-node. The report gains `target` and
`setup.localdev`: the dev server page, the types offered, the request, the unit, and the probe.

Refused up front, as in Kubernetes mode: `--evidence`, `--negative-control`, `--gate` and
`--legacy-env` (they read the single-node Postgres log and `docker exec` into its containers),
scenarios g0, g, h and o (`docker exec` into the single-node unit container; the unit is a host
process here), and `--unit-kind kubernetes`. `DOCKER_HOST` points at a socket that does not
exist, so nothing the driver runs in this mode can reach a container.

### `run-localdev.sh`

```
./run-localdev.sh --lock <dir> | --no-lock  [--source <worktree>] [--reset] [--keep] [--label text]
                  [--time-limit MIN] [--python PY] [--heap NAME=SIZE ...] [--strict-schema]
                  [--allow-stale-dists] [-- <driver args>]
```

1. Takes the lock (waiting while another run holds it). The owner file names the run. Starts
   the clock; `--time-limit` defaults to 40 minutes (`$SCE_LOCALDEV_TIME_LIMIT`).
2. Clean start: `down`, or `reset` with `--reset` (empty volumes).
3. `up`, logging to `reports/localdev-<time>-logs/`; then `status`.
4. The driver with `--target localdev`, writing `reports/localdev-<time>.json`, which embeds
   the stack manifest.
5. `post-run`: every service still alive and healthy, and the unit's leftover Python workers
   counted. The outcome goes into the report as `post_run` (a dead service sets
   `summary.result` to FAIL) and into `post-run.json`. It also puts the run's deviations from
   local-dev and its warnings next to the result (`summary.local_dev_deviations`,
   `summary.warnings`) and prints them.
6. Saves the infrastructure containers' logs (`<logs>/infra/`), runs `down` and releases the
   lock. This also happens when a step fails, the time limit is reached, or the run is
   interrupted. With `--keep` the stack stays up, and so does the lock: the stack still holds
   its ports and the Docker VM. The owner file says so, and `stack/localdev-stack.sh down`, then
   removing the lock, is the caller's job, within the shared rule's 45 minutes. At the time
   limit `--keep` does not apply.

Exit codes: the driver's (0, 1, 2), 3 if the stack did not come up, 4 if `post-run` failed,
5 at the time limit, 64 for a usage error.

### Verified

2026-11-16, after the review's fixes: harness `2832a0a`, no uncommitted change. Source
`sce-localdev-src`, detached at the Step 1 commit `5e85a37de`, clean throughout. JDK Temurin
17.0.19, node v24.15.0, UDF Python 3.11.14 (the step-1 venv, every `amber/requirements.txt` pin
matched). OrbStack Docker, LAN IP 192.168.50.162 (en1). The dists are the ones the build below
made. They predate build records, so `up` ran them with that warning; no build input changed
after they were written.

| Report (`reports/`) | Result | Notes |
|---|---|---|
| `localdev-20261116T131339Z` | a b c d e u PASS, 49/49 checks; post-run ok, no Python worker left | clean start (`--reset`); `up` 44 s (infra 6 s, schema step 1 s, services 8 s, dev server 14 s); driver 20 s; lock held 05:13:39 to 05:15:08 |
| `localdev-20261116T131514Z` | a b c d e u PASS, 49/49 checks; post-run ok, no Python worker left | clean start; `up` 48 s (infra 6 s, schema step 1 s, services 7 s, dev server 19 s); driver 20 s; lock held 05:15:14 to 05:16:42 |

In both runs, local-dev's schema step failed at 31 as described above: 23 to 27, 29 and 30
applied, 28 already in the schema, 31 to 52 not recorded. Each report lists this in
`summary.local_dev_deviations`; it is the runs' only deviation from local-dev. Every process
listened on exactly the ports reserved for it (the unit on 8085 and 2552). After each run, the
stack left no container, network, process, listener or pid file; the other containers' start
times and the Docker networks were unchanged, and the volumes were kept.

Probes of the fixes, in one lock hold (05:10:29 to 05:13:27):

| Probe | Outcome |
|---|---|
| `run-localdev.sh --reset --keep -- --scenario a` | a PASS, 8/8 (`localdev-20261116T131029Z`). The stack and the lock stayed; the owner file gained `--keep: stack left running since ...`, and the script printed the `down` and `rm -rf` to run |
| Then the dev server's pid file removed, and `down` | `leftover pid 70316 (ng serve (gui)): stopped`; the services stopped texera-web first and config-service last; `down` found nothing left |
| `up --strict-schema` on the kept volume | stopped at 31 at once (23 to 30 recorded by the run before): `local-dev's schema step failed at changeSet 31 (sql/updates/31.sql): psql:<stdin>:29: ERROR:  constraint "ck_nulltest" of relation "user" does not exist`; exit 1, no service started |
| `reset`, then `up --strict-schema` on empty volumes | 23 to 27, 29 and 30 applied, 28 accepted, stopped at 31; exit 1, no service started |
| Offline suite | 114/114. `test_localdev.py` (34 tests) runs local-dev's own schema functions against a fake `docker`, finds a dev server under the CLI's title, checks provenance in a scratch git repository, and runs `run-localdev.sh` with a stand-in stack (`--keep`, the time limit, the flags) |

Earlier runs, before the review's fixes. In these, `up` did not run local-dev's schema step,
so they say nothing about it:

| Report (`reports/`) | Harness | Result | Notes |
|---|---|---|---|
| `localdev-20261116T121303Z` | `471525f` + this mode uncommitted (trial) | a b c d e u PASS, 49/49 checks; post-run ok | `--reset`; `up` 56 s (infra 6 s, services 10 s, dev server 25 s); lock held 2 min |
| `localdev-20261116T121959Z` | `1d77279`, no uncommitted change | a b c d e u PASS, 49/49 checks; post-run ok | clean start (`--reset`: empty volumes, nothing running); `up` 40 s (infra 6 s, services 5 s, dev server 14 s); driver 22 s; lock held about 1 min |
| `localdev-20261116T122133Z` | `1d77279`, no uncommitted change | a b c d e u PASS, 49/49 checks; post-run ok | clean start; `up` 47 s (infra 6 s, services 7 s, dev server 19 s); driver 19 s; lock about 1 min |
| `localdev-20261116T122446Z` | `e184270` (the final code), no uncommitted change | a b c d e u PASS, 49/49 checks; post-run ok | clean start; `up` 41 s (infra 6 s, services 7 s, dev server 14 s); driver 18 s; lock about 1 min |

The build before all of them (`reports/localdev-build-codegen-logs`, `reports/localdev-build-dist-logs`):
`build --codegen-only` held the lock 27 s (jOOQ: 224 generated sources from the step-1 DDL in
this stack's Postgres); `build` then ran `sbt dist` of the six services in 90 s without Docker
(the codegen's "Connection to localhost:15432 refused" fallback, as intended), and amber's compile
wrote the Python protobufs. The source's `git status` stayed clean throughout.

Probes of the guard rails, on `1d77279`:

| Probe | Outcome |
|---|---|
| A listener on 127.0.0.1:9094, then `up` | refused before writing or starting anything: `9094 (config-service) is in use by Python (pid 53116)`; no container, no pid file |
| `run-localdev.sh`, then the time-limit signal (USR1) right after `up` started the seven JVMs | exit 5; the step's process tree stopped (the JVMs with it), `down` found nothing left to stop, the project's containers and network removed, no process or pid file left, lock released (`reports/localdev-20261116T122333Z-logs`) |

What the runs establish:

- **The dev server's proxy carried everything.** Base `http://localhost:4200`; the transport
  endpoint `ws://localhost:4200/wsapi/workflow-websocket`; the dev server served the app
  (`<title>Texera</title>`). Login, dataset upload (file-service's multipart path), warehouse,
  unit and workflow calls and the six runs' sockets all went through it.
- **local-dev's unit.** The managing service offered `["local"]` only. The unit was created as
  the dialog creates it, with URI `http://localhost:4200/wsapi`, and answered a socket through
  the proxy on the first attempt (0.1 s).
- **Storage as local-dev sets it up.** REST catalog (Lakekeeper) with the LAN endpoint: the
  default warehouse `texera` stores `http://192.168.50.162:19000/`. The per-user warehouse
  `user-1-1` was created through the Dashboard. A Python operator's worker writes its output
  port's table itself (`assign_port_handler.py`: pyiceberg through Lakekeeper, then the LAN
  endpoint), and the driver read b's, c's (the Sort) and e's results back exactly.
- **local-dev's schema step, as local-dev runs it.** local-dev's own functions ran against this
  stack's Postgres right after the infrastructure, and failed on this source exactly where
  `bin/local-dev.sh up` stops. Past that step (the recorded deviation), the services and every
  scenario work.
- **Clean `down`.** No container, network, process or listener of the stack left, volumes kept,
  the other containers on the machine untouched, and `git status` of the source clean.

Observed upstream, besides the schema step's failure above (a local-dev bug of the repository,
which stops `bin/local-dev.sh up`):

- The Dashboard and the unit log
  `org.eclipse.jgit.errors.RepositoryNotFoundException: repository not found: <worktree>/amber`
  at startup. `OPVersion` runs `Git.open(".")`; local-dev starts amber's services from `amber/`
  without `TEXERA_HOME`, and `Git.open` does not search parent directories. The compiling
  service, started from the worktree root, logs the same for the worktree itself, because JGit
  cannot open a linked worktree's `.git` file. Operator versions then read `N/A`. Not on a
  run's path.
- The unit logs one `WARN [org.apache.iceberg.util.Tasks] ... Retrying task after failure: ...
  Commit failed: CatalogCommitConflicts => Requirement failed: Branch or tag `main` already
  exists` per run, during scenario c, with a `CommitFailedException` stack trace from
  `IcebergTableWriter.flushBuffer` (`OutputPortStorageWriterThread`). Iceberg retries the
  commit and the results read back are exact. Kubernetes mode's unit logs show it too, so it
  comes from the engine's result writer with Lakekeeper, not from local-dev. Not a failure.
