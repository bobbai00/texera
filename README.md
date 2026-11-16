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
| `driver/tests/` | Offline tests: `fake_texera.py` (a fake Texera speaking the step-2 design's protocol), `test_transport.py`, `test_scenarios.py`, `test_evidence.py` (a fake `docker` and a synthetic Postgres log) |
| `run-baseline.sh` | `up`, then wait until healthy, run the driver, print results, then `down` unless `--keep` |
| `run-negative-control.sh` | The step-2 negative control (H5) on the published images |
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
| `--pg-statement-log` | Postgres runs with `log_statement=all` and `log_line_prefix=%m [%p] app=%a db=%d host=%h ` (the compose service has no command upstream; the generator refuses a source whose service has one). Extended-protocol statements log their values on the following `DETAIL:  parameters: $1 = '...'` line of the same pid. It also sets the unit's `WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS=2` (unless `--unit-env` sets it), so an idle workflow's cleanup never lands in the next scenario's windows |
| `--isolate-unit` | A second network, `sce-unit-net` (not `internal`: pip needs the package index). The unit is attached only to it; Postgres, Lakekeeper, RustFS and nginx (and agent-service when kept) are on both networks with all their aliases. The unit cannot resolve `file-service`, `texera-lakefs`, `dashboard-service` or `access-control-service`. A network check after generation proves the attachments |
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
holds every check with its detail, the state timeline, commands sent, operator
statistics, a console sample, the persisted execution row, notes, and with
evidence every unit statement of each window. Exit codes:

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
refusals are skipped with a note). "No unit statement for its eid" is checked by
the evidence at the scenario's end; without `--evidence` it is only noted.

| Key | Name | From PR | What it does | Checks |
|---|---|---|---|---|
| g0 | `environment-legacy` | A-C (`--legacy-env`) | precondition: the unit's `python3 -c "import tabulate"` fails; environment `sce-env0-<hex>` saved through `/api/pve/db` and built through `/wsapi/pve` (create, which installs amber's requirements, then install `tabulate==0.9.0`); Text Input → UDF with that `envName` outputting `tabulate.__version__` | Completed; the row says `0.9.0`; status 3 |
| j | `modify-while-paused` | B | `numbers.csv` → UDF tagging `v1`, 0.05 s per tuple; pause; change the code to tag `v2`; resume | update 200 with `{updateId, operatorId}` and `ModifyLogicResponse.isValid`; the other user's update 403; `ModifyLogicCompletedEvent` names the UDF; Completed with 300 rows, some `v1`, some `v2`, every `v1` before every `v2` in `n` order; an update after Completed 409; status 3 |
| k | `compile-error-from-create` | B | Projection of a missing column | create 400, `operatorErrors` has the Projection and names the column; the 400's eid row is 4; no unit statement for it |
| l1-l4, l7 | `refuse-*` | B | unknown unit; other user + texera's workflow; other user + texera's unit; terminated unit; another user's warehouse | 403, 403, 403, 409, 400; no new row |
| l5, l6, l9, l10 | `refuse-*` | B | other user starts texera's execution; a start naming another execution's `planUri`; a socket for texera's second unit; a `planUri` in another user's warehouse | a `WorkflowErrorEvent` on the starting socket with the design's message (l5: "only the user who created" or, with warehouses on, "another user's warehouse"; l6: "the plan is execution"; l9: "computing unit"; l10: "another user's warehouse"); none on a texera socket watching the workflow; never Running; the row stays 0 (allowed in the final check); no unit statement for the eid |
| l8 | `refuse-second-start` | B | start a completed execution again (the first socket stays open, so no idle cleanup runs) | "already started" on the new socket; the first socket gets no error and no state; never Running; the row stays 3; no unit statement for the eid after the second start |
| m | `replay` | B | refusals always: a source without a log (with `--with-replay-log` every run has one, so a missing execution instead) and a source of another workflow; with `--with-replay-log`: a slow run with a `WorkflowCheckpointRequest` (the only thing that records an interaction), its interactions, a replay from the last one, started | refusals 400 and no row; the source run completes; it lists ≥ 1 interaction; replay create 201; the replay reaches Running, Paused or Completed |
| o | `agent-sync-run` | B | create with `targetOperatorIds` [Filter]; `docker exec <unit> curl -X POST http://localhost:8085/api/execution/<eid>/run` with texera's token and `{planUri, computingUnitId, targetOperatorIds, timeoutSeconds, maxOperatorResultCharLimit, maxOperatorResultCellCharLimit}` | `success`, state Completed, the Filter's rows exact, the Projection downstream not in the result; a repeat: `success: false`, "already started"; status 3 |
| f | `file-lister-scan` | C | File Lister (the e2e dataset's v1) → File Scan From Input (single string, with the file name) | Completed; 3 rows; the file names are the three logical paths; no value contains `http`; each content equals the uploaded bytes |
| f2 | `file-scan-needs-lister` | C | Text Input of a dataset path → File Scan From Input | create 400; `operatorErrors` names the File Scan |
| g | `environment-install` | D | precondition as g0; environment `sce-env-<hex>` = `{tabulate: ==0.9.0}` through `/api/environments`; the UDF outputs `tabulate.__version__`; run twice | run 1: console "Installing Python environment" then "is ready" with `tabulate==0.9.0`, Running only after "ready", row 0.9.0, status 3; run 2: "reused", no "Installing", start-to-Running shorter; one `texera-environment.json` with these requirements under `/tmp/texera-python-environments` |
| h | `environment-broken` | D | environment `{sce-e2e-nonexistent-<hex>: ==1.0.0}` | Failed (waited with fail-fast off); the fatal error has "could not be installed" and "No matching distribution found"; the UDF emitted 0 rows; status 4; no `texera-requirements.txt` naming the package is left |
| i | `environment-missing` | D | the UDF names `sce-missing-<hex>` | create 400; the UDF's error names the environment; that row is 4; no unit statement for it |

### The transport seam (`driver/transport.py`)

How a run is started, watched and controlled lives only in `transport.py`.
Scenarios call `Transport.start_run(...)`, which returns a `RunHandle`, and use
only these `RunHandle` members:

| Purpose | Members |
|---|---|
| Wait | `wait_for_state`, `wait_until` |
| Control | `pause`, `resume`, `kill`, `ensure_stopped`, `modify_operator`, `send_raw` |
| Observe | `eid`, `plan_uri`, `states`, `state_log`, `command_log`, `stats` / `output_rows`, `console`, `fatal_errors`, `error_event_count`, `modify_responses`, `modify_completed`, `results` |
| Report and clean up | `summary`, `close` |

`Transport` also has `create_only(**kw)` (the raw create response) and
`start_existing(wid, cuid, eid, plan_uri, token=None)` (a socket as the token's user
that sends only the start), and calls `phase_hook(phase, info)` when the driver
sets one: `create` before an execution is created, `created` with its eid,
`start` before the start is sent (the evidence marks).

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
which nothing started (a watcher, or a refused start) is left alone. These paths
were checked against the published images:

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
2. Open the websocket as above and wait for the handshake's state event.
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
  the handshake's arrived): the start window runs from the start mark to the unit's
  first `UPDATE workflow_executions SET ... status ... WHERE ... eid` whose
  parameters put the status at 1, 4 or 5 and the eid at the run's, inclusive; the
  terminal window to its first status 3, 4 or 5.

| Check | Holds when |
|---|---|
| A | start window: no unit statement starts with `SELECT` or `WITH`, and each is an INSERT or UPDATE on `workflow_executions`, `operator_port_executions` or `operator_executions` (a missing window end fails it) |
| B | terminal window: unit statements touch no other table |
| C | every `INSERT INTO workflow_executions` of the scenario has `app=texera-dashboard` (none at all passes only when no create succeeded) |
| D | needs `--isolate-unit` (else not evaluable, which fails a gating D): `getent hosts file-service texera-lakefs` in the unit finds neither, and the unit's log since the start mark names none of `file-service`, `texera-lakefs`, `:9092`, `:8000/api/v1` |
| E | Lakekeeper's REST API, from the dashboard container (`GET /catalog/v1/config?warehouse=<w>` for the prefix, then the table `wid_<wid>_eid_<eid>_plan` in namespace `execution-plan` or `STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`) has a ref named `started`. The warehouse comes from the `planUri`, else texera's (`lakekeeperWarehouseName`, or `user-<uid>-<whid>` on Dashboards that do not report it), else the default |
| F | every statement from the unit's addresses in the scenario has `app=texera-computing-unit` (none at all passes) |

Before each scenario the driver waits up to 15 s for the unit's
`DELETE FROM operator_executions WHERE workflow_execution_id = $1` of the previous
scenario's last started eid (its idle cleanup, 2 s after the sockets close); the
report records the wait. After all scenarios, the final check: no execution of this
run's workflows is left at status 0, except the refused starts (l5, l6, l9, l10).

### Negative control (`./run-negative-control.sh`, `--negative-control`)

The script brings the stack up on the published images with `--pg-statement-log
--isolate-unit`, takes texera's token (`driver/run.sh --print-token`), brings it up
again with `--unit-env USER_JWT_TOKEN=<token>` (the unit is recreated and reads
datasets through file-service, the K8s path, which it cannot reach), runs scenario a
over `ws` with `--negative-control`, then takes the stack down. With
`--negative-control`, A, D and F must fail; the scenario's own checks and the other
evidence are reported only. A control that passes fails the run; a passing run
records "controls failed as expected".

### Offline tests (`driver/tests/`)

```
.venv/bin/python -m unittest discover -s driver/tests -v     # 34 tests, about 50 s
```

- `test_evidence.py`: the log parser (parameters, continuation lines, interleaved
  pids, failed statements), the incremental reader, and Checks A-F, the cleanup
  wait and the expectations against a fake `docker` serving a synthetic log of the
  old unit (A, B, C, D, F fail; the negative control passes) and of the new path
  (every check passes; the controls then fail).
- `test_transport.py`: both transports against `fake_texera.py`: the create body
  of 3.4, the start by id as the first command, `CreateRefused`, the update then
  `OperatorUpdateRequest`, `UpdateRefused` (409 after the end), a refused second
  start that is not killed, a start as another user, the unchanged
  `WorkflowExecuteRequest`, `ModifyLogicRequest` on `ws`, environments (new and
  legacy), `/wsapi/pve`, users and unit termination.
- `test_scenarios.py`: g0, j, k, l1-l10, m (with and without a replay log), o, f,
  f2, g, h, i through the real driver code against the fake (and a fake
  `docker exec` for o and the environment scenarios); j on `ws`.

`fake_texera.py` models the design, not Texera: a scenario that passes against it
drives the design's protocol and judges its answers as the design says; it proves
nothing about a branch.

## What is verified against a real stack, and what is not yet

Step 2 lands in parts; until PR B there is no `POST /api/executions`, no
`WorkflowStartRequest`, no update endpoint and no `/api/execution/{eid}/run` to test
against. As of 2026-11-16:

Verified against a real stack (reports under `reports/`):

| Part | Images | Result |
|---|---|---|
| `--pg-statement-log` | published, step2wip | the log carries `app= db= host=` and DETAIL parameters as designed; an unnamed connection shows `app=[unknown]` (LakeFS) or `app=PostgreSQL JDBC Driver` (the published services) |
| `--isolate-unit` | published, step2wip | the unit is on `sce-unit-net` only, the stack comes up healthy, runs start through nginx, and `getent` in the unit resolves neither `file-service` nor `texera-lakefs` |
| `--unit-env` | published | `USER_JWT_TOKEN` recreates only the unit (and reruns lakekeeper-init); the unit then calls file-service |
| Negative control (H5), `run-negative-control.sh` | published `ghcr.io/apache/latest` | controls failed as expected: A (6 of 8 start-window statements offend: SELECTs of `user_warehouse`, `workflow_version`, the latest `workflow_executions`, `dataset`, `dataset_version`, and the SELECT before each state UPDATE), D (`UnknownHostException: file-service` in the unit's log), F (8 statements from the unit's address, all `app=PostgreSQL JDBC Driver`). Also B, C (the unit inserts the row) and E (no plan table) fail. Scenario a itself fails: the compile cannot read the CSV header through file-service. `reports/negative-control-20261116T100558Z.json` |
| Evidence on step2wip, unit isolated, scenario a, F gating | `sce/texera-*:step2wip` (sce-integrate `e31d185fa`: step 1 + sub-parts 1, 2, 3, 4, 5, 7, 19) | F passes (every unit statement `app=texera-computing-unit`); A fails (8 of 10: the unit still compiles and reads at start); B, C, D (`texera-lakefs` in the unit's log), E fail as expected. Scenario a fails: the isolated unit cannot reach LakeFS to read the CSV (expected until PR C's links). `reports/baseline-20261116T100721Z.json` |
| Evidence on step2wip, not isolated: a, b, c, d, e, u, j (`ws`), g0, F gating | step2wip | all 8 PASS with F gating and passing on each; A, B, C, E fail on each as expected (the unit still compiles, reads and inserts; no plan table yet), D not evaluable without isolation. j over `ws`: ModifyLogicResponse valid, ModifyLogicCompletedEvent, 300 rows, every v1 before every v2. g0: the legacy environment built in 37 s, the UDF's row says tabulate 0.9.0. The cleanup wait saw the unit's DELETE of each previous execution 1.8-2.1 s after the sockets closed. `reports/baseline-20261116T100824Z.json` |
| `--with-replay-log` | step2wip | the shared volume is root's and the services run as uid 1001, so `up` now creates `recovery-logs` and gives it to 1001 (without that the coordinator cannot create its log and the run hangs in Initializing). Then d passes, the row's `logLocation` is set and the Dashboard reads the log. Pause and resume record no interaction, and a `WorkflowCheckpointRequest` (the only thing that records one) fails the run: `portId has not been set for channel ... call setPortId before getPortId`, an upstream engine bug. So m's replay run fails on today's engine; its refusals do not need the option |
| The Lakekeeper lookup of Check E | published, step2wip | config → prefix → table works against Lakekeeper; a missing plan table reports the warehouse's namespaces |
| Final status-0 check | published, step2wip | runs; no row left at 0 |
| `ws` baseline a-e, u after all changes | `sce/texera-*:step1` | a, b, c, d, e, u all PASS with the same checks as before (8, 7, 7, 14, 6, 7), no stack options, `ws`, default selection. `reports/baseline-20261116T101451Z.json` |

Written and tested offline only (`driver/tests/`), to be validated when the PRs land:

| Part | Lands with | Offline test |
|---|---|---|
| `create-ws` transport: create (3.4), start by id (3.6), `create_only`, `start_existing` | PR B (sub-parts 9, 11) | `test_transport.py` |
| `modify_operator` through `POST /api/executions/{eid}/updates` + `OperatorUpdateRequest` (3.5) | PR B (10, 11) | `test_transport.py`, `test_scenarios.py` j |
| Scenarios j (its create-ws refusals), k, l1-l10, m, o | PR B | `test_scenarios.py` |
| Scenarios f, f2 | PR C (16, 17) | `test_scenarios.py` |
| Scenarios g, h, i and `ensure_environment` on `/api/environments` for runs | PR D (20) | `test_scenarios.py` (`/api/environments` itself exists in step2wip but no scenario using it ran there) |
| Checks A-E passing (C's insert by `app=texera-dashboard`, E's `started` tag), refused starts' "no unit statement", `--gate` | PR A-D | `test_evidence.py` |
| m's replay run | PR B, and an engine whose global checkpoint works | `test_scenarios.py` (`ReplayScenario`) |
| `register_user`/`set_role`/`ensure_user`, `terminate_unit` | PR B (l-scenarios) | `test_transport.py` against the fake |

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
- **Python exceptions do not end a run.** A Python UDF exception leaves the
  workflow `Running`, with its worker paused, until someone kills it. This is
  upstream behavior in the published images, not something the harness
  introduces. The harness turns it into a fast FAIL, as described under the
  transport seam above.
