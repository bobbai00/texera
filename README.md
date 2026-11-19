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
./run-baseline.sh --images sce/<tag> --pg-statement-log -- --gate B
./run-baseline.sh --images sce/<tag> --pg-statement-log --isolate-unit -- --gate C
./run-negative-control.sh            # published images: Checks A, D and F must fail
.venv/bin/python -m unittest discover -s driver/tests   # offline: transports and scenarios vs a fake

# step 3 (a run's record lives in the lake, the Dashboard closes executions, the unit is off Postgres; see the gates under the driver)
./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --isolate-unit --fast-record -- --gate 3A
./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --isolate-unit --fast-record -- --gate 3B
# gate 3C is run twice: with Postgres beside the unit (Checks G and H), and without (Check J)
./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --isolate-unit --fast-record -- --gate 3C
./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --isolate-unit --fast-record --unit-no-postgres -- --gate 3C
./run-negative-control.sh --step 3 --images sce/<step 2's last tag>   # once per gate 3C: G and H must fail, q must stay Running

# the real editor in headless Chromium (see "Browser smoke" below); images built with --frontend
./run-browser-smoke.sh --lock <scratchpad>/sce/stack.lock --reset --images sce/<tag> --source <worktree>

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
| `driver/` | The e2e driver: `e2e.py` (CLI), `transport.py` (start, watch and control a run), `texera_api.py` (REST calls), `workflow.py` (plan builders), `scenarios.py`, `evidence.py` (the step-2 Checks A-D and F, and the step-3 checks), `lake.py` (an execution's tables as Lakekeeper shows them), `record_timing.py` (step 3's timers, as the stack was started), `stack_control.py` (taking the unit down and bringing it back, per mode), `data/*.csv` |
| `driver/tests/` | Offline tests: `fake_texera.py` (a fake Texera speaking the designs' protocols, at step 2 or at a step-3 gate), `fake_record.py`, `fake_lake.py` and `fake_closing.py` (its recorder, its lake and its Dashboard's closing job), `fake_stack.py` (the stack's control over it), `test_transport.py`, `test_scenarios.py`, `test_evidence.py` (a fake `docker` and a synthetic Postgres log), `test_scenario_evidence.py` (scenarios and evidence together on the fake stack), `test_step3_scenarios.py`, `test_step3_evidence.py`, `test_lake.py`, `test_stack_options.py`, `test_stack_control.py`, `test_negative_control.py` |
| `lib/` | What the harness's programs share: `venv.sh` (the Python venv), `record_env.py` (the timers `--fast-record` sets), `pg_activity.py` (who is connected to Postgres) |
| `run-baseline.sh` | `up`, then wait until healthy, run the driver, print results, then `down` unless `--keep` |
| `run-negative-control.sh` | The negative controls (H5 of each design): step 2's on the published images, and with `--step 3` step 3's on the images of step 2's end |
| `driver/browser_smoke.py` | The browser smoke: the real workflow editor in headless Chromium (Playwright), cases B1-B9, with the page's requests and websocket frames recorded |
| `run-browser-smoke.sh` | The browser smoke end to end: lock, `up`, the smoke, API scenario a on the same stack, `down` |
| `stack/localdev-stack.sh`, `stack/localdev/localdev_stack.py` | Local-dev mode: local-dev's infrastructure (renamed, shifted ports), its schema step, the JVM services as host processes, `ng serve`; `generate`, `build`, `up`, `down`, `reset`, `status`, `logs`, `post-run`, `venv`, and for the driver's stack control `unit-kill`, `unit-stop`, `unit-start`, `pg-activity` |
| `driver/localdev_unit.py` | The driver's local-dev mode (`--target localdev`): the dev server as `--base`, local-dev's local unit |
| `run-localdev.sh` | Local-dev mode end to end: lock, clean start, `up`, the driver, `post-run`, `down` |
| `reports/` | JSON reports, one per driver run |

## The stack: `stack/sce-stack.sh`

```
stack/sce-stack.sh [--source <worktree>] up [--images <registry>/<tag>] [--timeout S] [--with-optional] [--bind IP]
                   [--pg-statement-log] [--isolate-unit] [--with-replay-log] [--unit-env KEY=VAL ...]
                   [--fast-record] [--dashboard-env KEY=VAL ...] [--unit-no-postgres [--expect-unit-down]]
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

Options for the evidence checks (section 7 H2 of the step-2 and of the step-3
design). Each is off by default, the generator's round-trip check verifies exactly
the edit it makes, and `MANIFEST.json` records them under `options` (values of keys
that look like secrets are masked):

| Option | Effect |
|---|---|
| `--pg-statement-log` | Postgres runs with `log_statement=all` and `log_line_prefix=%m [%p] app=%a db=%d host=%h ` (the compose service has no command upstream; the generator refuses a source whose service has one). Extended-protocol statements log their values on the following `DETAIL:  parameters: $1 = '...'` line of the same pid. It also sets the unit's `WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS=2` (unless `--unit-env` sets it), so the driver's wait for an idle workflow's cleanup (see Evidence) stays short |
| `--isolate-unit` | A second network, `sce-unit-net` (not `internal`: pip needs the package index). The unit is attached only to it; Postgres, Lakekeeper, RustFS and nginx (and agent-service when kept) are on both networks with all their aliases. The unit cannot resolve `file-service`, `texera-lakefs`, `dashboard-service` or `access-control-service`. A network check after generation proves the attachments. It also turns nginx's access log on (`options.gateway_access_log`): the source's one `access_log off;` becomes `sce-access $remote_addr "$request_method $uri" $status` on stdout (`$uri` has no query string, so no websocket token is logged), because the isolated unit still reaches nginx, which proxies file-service and the Dashboard. The generator refuses a source without exactly one `access_log off;` |
| `--with-replay-log` | `FAULT_TOLERANCE_LOG_STORAGE_URI=file:///amber/user-resources/recovery-logs/` for dashboard-service and the unit (both mount `workflow_result_data` there); after the stack is healthy `up` creates that directory owned by uid 1001, since Docker creates the volume as root's |
| `--unit-env KEY=VAL` | Extra unit environment, repeatable (for example `USER_JWT_TOKEN=...` for the negative control) |
| `--dashboard-env KEY=VAL` | Extra environment for the Dashboard service, repeatable |
| `--fast-record` | Step 3's timers shortened (`lib/record_env.py`), so a scenario sees a commit, a verdict or an expiry in seconds. The unit gets `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS=2000`. The Dashboard service gets `EXECUTION_CLOSING_INTERVAL_SECONDS=2`, `EXECUTION_CLOSING_LOST_AFTER_SECONDS=12`, `EXECUTION_CLOSING_NEVER_STARTED_AFTER_SECONDS=15`, `EXECUTION_CLOSING_REVISE_VERDICT_FOR_SECONDS=180`, `RESULT_CLEANUP_TTL_IN_SECONDS=20` and `RESULT_CLEANUP_COLLECTION_CHECK_INTERVAL_IN_SECONDS=5`. A value given with `--unit-env` or `--dashboard-env` wins. The manifest's `options.record_timing` holds the timers the two services were given, and the driver's waits and deadlines follow it (a timer it does not name keeps the product's default: 30 s, 30 s, 180 s, 600 s, an hour, a day, a day) |
| `--unit-no-postgres` | Needs `--isolate-unit`. Postgres is not attached to `sce-unit-net`, so no network holds both it and the unit: the unit cannot even resolve `texera-postgres` (Lakekeeper, RustFS and nginx stay beside it). The network check after generation proves the attachments, and the driver's preflight, when Check J gates, runs `getent hosts texera-postgres` in the unit and refuses a stack where it answers. With `up --expect-unit-down` it is a negative control instead: `up` waits for every service but the unit, watches the unit for 90 s (`--unit-down-watch`), prints one JSON verdict and exits 0 only when the unit never became healthy and its log says Postgres is why (it names Postgres's host, `PSQLException` or `HikariPool`); a unit that became healthy "passed, so the control proves nothing", and one that stayed down for another reason is "inconclusive" |

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
              [--transport ws|create-ws] [--gate B|C|D|3A|3B|3C] [--evidence [CHECKS]] [--negative-control [2|3]]
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
5. Only when a selected scenario needs it (on `create-ws`): the second user
   `sce-e2e-other` (registered, then set to REGULAR by the admin through
   `PUT /api/admin/user/update`, with its own local unit and warehouse).
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
and every scenario of step 2 on `create-ws`; a step-3 scenario runs when it is named
or when its gate selects it. `l` is the group l1-l8 and l10 (the key l9 is unused). A
`create-ws`-only scenario selected on `ws` fails at once with that message.

`--gate X` picks a harness gate of step 2 or of step 3 (section 5 of each design);
explicit flags win:

| Gate | Transport | Scenarios | Gating evidence | Stack options |
|---|---|---|---|---|
| B | `create-ws` | a-e, u, j, k, l, m, o, g0 | C, F | `--pg-statement-log`; images built with `--frontend` |
| C | `create-ws` | B + f, f2 | A-D, F | `--pg-statement-log --isolate-unit`; then `./run-negative-control.sh` once |
| D | `create-ws` | a-e, u, j, k, l, m, o, f, f2, g, h, i (g0 retired) | A-D, F | as C |
| 3A | `create-ws` | D + p | A-D, F, I | `--pg-statement-log --isolate-unit --fast-record` |
| 3B | `create-ws` | 3A + q, r, s, t, w | A-D, F, I, K | as 3A |
| 3C | `create-ws` | 3B + v | C, D, F, G, H, I, K; and J on a stack started with `--unit-no-postgres` | as 3A, and once more with `--unit-no-postgres`; then `./run-negative-control.sh --step 3` once |

The letter A is unused: that gate gated on Check E alone, which is gone with the plan
table it read.

A step-3 gate also runs in Kubernetes and in local-dev mode, where it selects what
that mode runs (3A: a-e, u, p; 3B: a-e, u, p, q, s, w; 3C: a-e, u, p, q, s, v, w, the
design's H6) and no evidence: the statement log exists on the single-node stack
only. Gate 3A is step 2's last gate plus p, so Check D still gates and the stack
needs `--isolate-unit`, as for gate D (the step-3 design's one-line command leaves
the option out).

Gate 3C is two runs on the single-node stack, because the design's Checks G, H and J
cannot all say something in one. With Postgres beside the unit, G (no statement) and H
(no connection) show that the unit does not use a Postgres it could reach. On a stack
started with `--unit-no-postgres` they hold whatever the unit tries, and J shows that
the unit, and every scenario, works with no Postgres to find. The driver reads the
option from the stack's manifest: J gates on such a stack and is left out, with a
line saying so, on any other. At gate 3C, Kubernetes and local-dev mode also show,
after the setup and after the last scenario, that Postgres holds no connection named
`texera-computing-unit` and none from the unit pod's address, and in Kubernetes that
the unit was given no `STORAGE_JDBC_*` setting (the report's `unit_without_postgres`;
a failure fails the run).

A step-3 gate also tells the scenarios how far the product is (its letter, A to C),
because step 3 lands in parts and a scenario asks a later part's routes only once
they exist. Without a step-3 gate, a run that selects a step-3 scenario is taken to
be on the whole of step 3 (to run one against an earlier part, name the gate too:
`--gate 3A --scenario p`), and any other run is as it was before step 3: it asks for
none of step 3's routes (j, for one).
Until gate 3C a statistics request names the unit (`?cuid=`), as the browser's does:
in Kubernetes the gateway still routes it there.

The driver follows the product as it is now: the create answers the execution's plan
and the start carries it (the transport seam below). Gates B to D keep step 2's
selections and run against that product; images of step 2 itself, whose create
answers where the plan is stored instead, cannot be started on `create-ws`. The `ws`
transport is for the published images: the baseline and step 2's negative control.
Gates B and C apply without g0 and `--legacy-env`, since the unit serves no
environment endpoints any more.

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
| d | `pause-resume-kill` | `numbers.csv` (300 rows) → Python UDF sleeping 0.2 s per tuple | <ul><li>Running, then the UDF emits rows</li><li>pause reaches Paused and is still Paused after a 5 s hold (the reported output count stays flat too, but the engine sends no statistics while paused, so that alone proves little)</li><li>on `create-ws`, before the pause: a `WorkflowKillRequest` naming another execution (this one's id + 1,000,000, as a page still showing an earlier run would send it) is answered to its sender with `RequestRefusedEvent{request, executionId, message: "Execution N is not running here."}`, and the run goes on</li><li>resume reaches Running, and rows flow again</li><li>kill reaches Killed</li><li>the state order Running → Paused → Running → Killed, with Pausing and Resuming reported</li><li>never Completed</li><li>no work during the pause: rows emitted after resume ≤ (time from the resume request to Killed ÷ 0.2 s) + 2. A worker that kept running through the hold adds about 25 rows, however long the run took to start</li><li>persisted status 5 (Killed)</li></ul> |
| e | `console` | CSV scan → Python UDF that `print()`s one line per tuple | <ul><li>Completed with all 10 rows</li><li>all 10 lines arrive as `ConsoleUpdateEvent`s for that operator</li><li>every message type is `PRINT`</li><li>persisted status 3</li></ul> |
| u | `java-udf-column` | CSV scan → Java UDF adding `name_len` (the unit compiles it with javac) | <ul><li>Completed</li><li>all 6 columns and their types</li><li>every value</li><li>persisted status 3</li></ul> |

Step 2 (design section 7 H3). All but g0 and j need `create-ws`; j also runs on
`ws` (its change goes through the old `ModifyLogicRequest`, and the Dashboard's
refusals are skipped with a note). "No unit statement for its eid" and "the unit
silent after a refused start" are checked by the evidence at the scenario's end;
without `--evidence` they are only noted. A refused start (l5, l6, l8, l10, o's
repeat, r's second start) waits for the refusal, then 3 s (`REFUSAL_SETTLE_S`), then
the evidence marks "settled": from the start's mark to that mark the unit may run no
statement at all, whatever it names (design D33).

The scenarios follow the product as it is after the review fixes of step 2 (the
reports X1, X3 and X4 under `docs/review-step2/`), read in its code: what the unit
refuses it answers to the asking session as a `RequestRefusedEvent`, in sentences
the scenarios compare whole (`REFUSED_*` in `driver/scenarios.py`); a pause, a
resume and a kill name their execution; a created execution reads status 6
(Created) until its unit's first write; a client that wants a part of a workflow run
sends that part. And they follow the plan carried by the client: the create answers
201 `{eid, plan}`, the start carries that plan, and the unit checks it (its execution,
its workflow, the warehouse it writes into and whose that is) and takes each
execution's start once, in its memory; a change to a paused operator is made in the
workflow the execution was created from and answered 201 `{operatorId, update}`.
Images older than those fixes fail the checks that say so.

| Key | Name | From PR | What it does | Checks |
|---|---|---|---|---|
| g0 | `environment-legacy` | A-C (`--legacy-env`) | precondition: the unit's `python3 -c "import tabulate"` fails; environment `sce-env0-<hex>` saved through `/api/pve/db` and built through `/wsapi/pve` (create, which installs amber's requirements, then install `tabulate==0.9.0`); Text Input → UDF with that `envName` outputting `tabulate.__version__` | Completed; the row says `0.9.0`; status 3 |
| j | `modify-while-paused` | B | `numbers.csv` → UDF tagging `v1`, 0.05 s per tuple; pause; change the code to tag `v2` (on `create-ws` the update carries the workflow the execution was created from, as every update does); resume | update 201 with `{operatorId, update}` and `ModifyLogicResponse.isValid`; the other user's update 403; `ModifyLogicCompletedEvent` names the UDF; Completed with 300 rows, some `v1`, some `v2`, every `v1` before every `v2` in `n` order; an update after Completed 409; status 3 |
| k | `compile-error-from-create` | B | Projection of a missing column | create 400, saying so as every refusal does (`code`, `message`), with `operatorErrors`, which has the Projection and names the column, and `eid`; that eid's row is 4; no unit statement for it |
| l1-l4, l7 | `refuse-*` | B | unknown unit; other user + texera's workflow; other user + texera's unit; terminated unit; another user's warehouse | 403, 403, 403, 409, 400; no new row |
| l5, l6, l10 | `refuse-*` | B | other user starts texera's execution with the plan its create answered (needs per-user warehouses: the unit checks no creator, so the warehouse a plan writes into is what keeps another user out); a start of one execution carrying another execution's plan; the create's plan moved into another user's warehouse (its `warehouse` and every `vfs:///` location in it together: the unit reads a plan whose locations are not in its own warehouse as unreadable) | one `RequestRefusedEvent` on the starting socket, naming `WorkflowStartRequest` and the execution, with the unit's sentence (l5 and l10: "The plan writes into another user's warehouse."; l6: "The plan is execution B's, not A's."), and no `WorkflowErrorEvent` with it (a refusal is not a run's error); neither on a texera socket watching the workflow; never Running; the row stays 6, Created (left unstarted on purpose, for the final check); no unit statement for the eid; the unit silent from the start until settled |
| l8 | `refuse-second-start` | B | start a completed execution again, with the plan it was started with (the first socket stays open, so no idle cleanup runs; with evidence the unit first settles, 1 s without a statement, so the first run's trailing writes stay out). The new socket gets the held run replayed while it opens (state Completed, its console); that is kept apart from the start's answer | a `RequestRefusedEvent` of the start on the new socket, "Execution N was already started.", and no `WorkflowErrorEvent`; the first socket gets no refusal, no error and no state; never Running after the start; the row stays 3; no unit statement for the eid after the second start; the unit silent from the second start until settled |
| m | `replay` | B | refusals always: a source without a log (with `--with-replay-log` every run has one, so a missing execution instead) and a source of another workflow; with `--with-replay-log`: a slow run on JVM workers only (`numbers.csv` → a Java UDF sleeping 50 ms per tuple; a Python worker cannot take a checkpoint) with a `WorkflowCheckpointRequest` (the only thing that records an interaction), its interactions, a replay from the last one, started | refusals 400 and no row; the source run completes; it lists ≥ 1 interaction; replay create 201; the replay reaches Running, Paused or Completed |
| o | `agent-sync-run` | B | create as the agent service does: the part of the workflow up to the Filter, cut by the client (`Workflow.plan_up_to`), with `engineVersion: "agent"`, no operator named to cut at and no `workflowSettings`; `docker exec <unit> curl -X POST http://localhost:8085/api/execution/<eid>/run` with texera's token and `{plan, computingUnitId, targetOperatorIds, timeoutSeconds, maxOperatorResultCharLimit, maxOperatorResultCellCharLimit}`, the plan the create answered; with evidence, before the repeat the unit settles (its cleanup delay + 1 s, then 1 s without a statement: no socket holds the workflow, so the unit cleans the run up) and the repeat gets a start mark | `success`, state Completed, the Filter's rows exact, the Projection downstream not in the result; a repeat: `success: false`, `errors: ["Execution N was already started."]`; the unit silent from the repeat until settled; status 3 |
| f | `file-lister-scan` | C | File Lister (the e2e dataset's v1) → File Scan From Input (single string, with the file name) → Python UDF adding the content's size and SHA-256 | Completed; 3 rows; the file names are the three logical paths; no value contains `http`; each content is the uploaded bytes: its size and SHA-256, taken in the run, and the cell as a result table shows it (the first 100 characters, then `...`) |
| f2 | `file-scan-needs-lister` | C | Text Input of a dataset path → File Scan From Input | create 400; `operatorErrors` names the File Scan |
| g | `environment-install` | D | precondition as g0; the install root is the unit's `UDF_PYTHON_ENVIRONMENTS_ROOT` (else `/tmp/texera-python-environments`); an earlier install whose marker lists `tabulate==0.9.0` (a `--keep` stack, a rerun) is removed first, since reuse is decided by the marker; environment `sce-env-<hex>` = `{tabulate: ==0.9.0}` through `/api/environments`; the UDF outputs `tabulate.__version__`; run twice, each on its own workflow (installs are keyed by requirements and engine, not by workflow, and run 2 then gets no replay of run 1's console) | run 1: console "Installing Python environment" then "is ready" with `tabulate==0.9.0`, Running only after "ready", row 0.9.0, status 3; run 2: "reused", no "Installing", start-to-Running shorter; exactly one directory under the root whose `texera-environment.json` (read whole by the unit's python3) lists these requirements |
| h | `environment-broken` | D | environment `{sce-e2e-nonexistent-<hex>: ==1.0.0}`; the root's entries (without `*.lock`) listed before and after | Failed (waited with fail-fast off); never Running; the fatal error has "could not be installed" and "No matching distribution found"; it is the run's error only: no console holds an `ERROR` message of it; the UDF emitted 0 rows; status 4; no new entry under the root |
| i | `environment-missing` | D | the UDF names `sce-missing-<hex>` | create 400; the UDF's error names the environment; that row is 4; no unit statement for it |

Step 3 (design section 7 H3): the record a run leaves in the lake, and what the
Dashboard service makes of it. These scenarios wait on the unit's commit timer and
on the Dashboard's closing job, so they need a stack started with `--fast-record`
and refuse to run on one that was not; every wait and every deadline is a multiple
of the stack's timers (below: "commit" 2 s, "closing interval" 2 s, lost-after 12 s,
never-started-after 15 s, TTL 20 s, expiry pass 5 s with `--fast-record`). The "slow
run" is `numbers.csv` → a Python UDF that prints one line and sleeps 0.1 s per tuple
(about 30 s). q and s take the unit down through the stack's control (below); a
scenario from gate 3B refuses to run when the driver takes the product to be
earlier (`--gate`).

| Key | Name | From gate | What it does | Checks |
|---|---|---|---|---|
| p | `record-in-lake` | 3A | the slow run, paused and resumed once | while it runs: the log's label, read from Lakekeeper after each state change, names RUNNING, PAUSED, RUNNING at rising `seq`; at gate 3A the log table holds one row per state change, 4 by then (READY, RUNNING, PAUSED, RUNNING), the label's `seq`; from gate 3B `GET /api/executions/{eid}/log` shows READY, RUNNING, PAUSED, RUNNING and nothing else, with `seq` 1 to 4, and has no `closing`; the statistics endpoint returns rows, their count grows between two reads 2.5 commit intervals (5 s) apart, and each row names an operator and a time in epoch milliseconds; the console table has a snapshot with rows; after: the label names COMPLETED at a higher `seq` (from 3B: `/log`'s last row is COMPLETED); from gate 3C `GET /api/executions/{eid}/console` returns the UDF's stored lines while the run goes and, after it, all 300 in two pages (`afterSeq`, `more`), `seq` 1 to 300; every result table of the run records its port's output mode (`texera.result.output-mode`), the UDF's SET_SNAPSHOT; status 3; Check I |
| q | `unit-lost` | 3B | the slow run; once it is Running and has statistics and console rows in the lake, `kill_unit()`. Twice: the unit left down until the verdict, and `start_unit()` right after the kill. Where a listing of the units makes the platform notice a unit that is gone (Kubernetes), a third pass lists them once after the kill | each pass: the history entry, read every poll interval, says status 1 with a `completionTime` that is a time until it turns 4, "unit lost", within lost-after + 3 closing intervals of the kill (18 s), and not before lost-after less a commit and a closing interval (third pass: within 2 closing intervals of the listing); right after the kill, with the unit gone, the statistics rows read before it read back unchanged and the console table kept its rows (later the console table goes with the results, which the verdict keeps for revise-verdict-for and which then expire by age); once it is closed, `/state` says `open: false`, 4, "unit lost"; `/log` has no ending row and a `closing` with the verdict; its statistics table still holds its rows; `completionTime` is the last beat: not before the last state change, not after the kill. After the second pass: a new socket on the workflow is told "Uninitialized", naming no execution; scenario a passes on the unit that is back; both lost executions' history entries are as they were closed. The readings are in the report (`facts.lost_verdicts`) |
| r | `never-started` | 3B | create, and no start; once it is closed, a start with the create's plan; once that run has ended, a second start | the history says status 6, Created, until it turns 4, "never started", within never-started-after + 2 closing intervals of the create (19 s), and not before never-started-after; `/state` closed, 4, "never started"; the late start is taken and its run completes; its log's ending takes the verdict's place within a label's wait (10 s) + 3 closing intervals of the run's end (16 s): `/state` closed, Completed, no reason, and `/log` ends COMPLETED with the log's closing record; the second start is refused "already started" (as l8 checks it), the row stays 3 |
| s | `polite-stop` | 3B | the slow run; `stop_unit()` | the history turns 4 with reason "the computing unit was stopped" within 2 closing intervals of the stop (the status comes from the log's label at once; the reason with the closing record, a tick later); `/log` ends with a FAILED row carrying that reason |
| t | `expiry` | 3B | scenario a's workflow as one workflow, three executions: the first runs to its end and is closed; the second is created and started at once; the third is created once the second is closed, and never started | first execution: closed Completed, with result, state and console tables in the lake and a size on the quota page; once the second has started, its result tables are gone within a commit interval + one expiry pass + 2 closing intervals of that start (11 s), at an age under the TTL, so it is the later run that replaced them; then its state and console tables are gone too, its log and statistics are there, `/state` still says Completed, and `storedBytes` fell to exactly what the catalog says the log and the statistics hold. Second execution: its results stay although a third execution was created (a create alone replaces nothing) and go by age, within TTL + one expiry pass + 2 closing intervals of its end (29 s) and not before the TTL; then the same as for the first. From gate 3C an export of either then answers 410, "the results of execution N have expired" |
| w | `history-outcomes` | 3B | d, k, a, and a UDF whose module raises as it is loaded (a raise in `process_tuple` only pauses the worker), each as a part with its own checks | once the four are closed, the history says 5 "killed by the user"; 4 "compile error: ..." naming the column; 3 with no reason; 4 with the raised message; the admin's list has the same status and reason for each workflow's newest execution; d's log is READY, RUNNING, PAUSED, RUNNING, KILLED, the last row with the reason |
| v | `stored-reads-without-unit` | 3C | e, then a (each as a part with its own checks; a is the quicker one and runs last); the scenario's sockets are closed; `stop_unit()` | with the unit down (a new socket to it is refused): the console route returns e's 10 lines, all `PRINT`, of its UDF; a local CSV export of a's aggregate (`POST /api/executions/result/export/local`, a form with the request and the user's token, the request naming `executionId`) gives the columns `department, total_salary, n` and exactly the 4 groups; the Filter's newest stored statistics row reports 8 output rows; both executions' `/state` say closed, Completed; a's `/log` is READY, RUNNING, COMPLETED with its closing record. The statistics and the export request carry a `sce-probe` mark, which Kubernetes mode's `post-run` looks up in Envoy's access log. The unit is started again at the end |

What changes for the scenarios of step 2 (design H3):

- j, from gate 3B: the Dashboard refuses a change by the closing record, which its
  job writes a tick after the run ended, so j waits until `/state` says closed before
  its late change (409).
- l5, l6, l10 leave an execution that was never started, at status 6. From gate
  3B Check K expects each closed as failed, "never started".
- From gate 3B the driver no longer waits for the unit's cleanup `DELETE` between
  scenarios (the unit deletes nothing when it lets go of a run); it waits the unit's
  cleanup delay plus 0.5 s, and until the unit is quiet.
- From gate 3C a statistics request names no unit (`?cuid=` is gone).

Results and console output expire by age, and `--fast-record` makes that 20 s after
a run ended (25 s at the latest, with the 5 s expiry pass). Two scenarios read them
later than a moment after the run, and are ordered for it. q reads back what a lost
run stored right after the kill; a verdict keeps the execution's results for as long as
its log's ending may replace it (`revise-verdict-for`, 180 s with `--fast-record`), and
they expire by age after that. v runs
e first and a last and stops the unit at once, and each of its checks says how old the
results were when it read them; a unit that takes most of `docker stop`'s 20 s to stop
leaves v too little time, and the cure is a longer TTL for that stack
(`--dashboard-env RESULT_CLEANUP_TTL_IN_SECONDS=60`; t follows the stack's timers).
t needs its first execution's results replaced while they are younger than the TTL:
closing it, starting the second and the expiry's next look take 16 s of the 20 at
the most, and the same cure applies where they take longer.

Three things here are not the design's revision 2 but what was decided after it
(`docs/step3-notes/changes-since-rev2.md`): the log holds state changes only (p, Check
I), a created execution reads Created until a unit starts it (r, l5, l6, l10), and an
ended execution's results are replaced once a later one has started, by the closing
job's expiry, not by the next create (t).

### The stack's control (`driver/stack_control.py`)

A scenario never runs `docker` or `kubectl`. It asks the `StackControl` the driver
chose for its mode (`ctx.stack`), so the same scenario takes the unit down on the
single-node stack, in Kubernetes and in local-dev:

| Method | single-node | Kubernetes (`k8s_unit.KubernetesControl`) | local-dev (`localdev_unit.LocalDevControl`) |
|---|---|---|---|
| `kill_unit()` | `docker kill sce-workflow-runtime-coordinator-service` | `stack/k8s-stack.sh unit-kill <cuid>`: `kubectl delete pod --grace-period=0 --force`, waited for | `stack/localdev-stack.sh unit-kill`: SIGKILL to the process group of the unit's JVM (its Python workers are in it) |
| `stop_unit()` | `docker stop -t 20 ...` | `... unit-stop <cuid>`: `kubectl delete pod`, with the pod's grace period | `... unit-stop`: SIGTERM to the JVM alone, 20 s for it to stop, then what is left of its group is killed |
| `start_unit()` | `docker start ...`, then until `docker inspect` says healthy; when the unit came back at another address, nginx is restarted (it resolved the name when it started) and the gateway waited for | a new unit, created through the managing service as the first was (waited for with `GET /api/computing-unit/{cuid}`, never by listing the units: a listing stamps the units whose pod is gone, which would end q's wait for the beat). The scenarios after it use that unit; every unit a run made is terminated at its end | `... unit-start`: the unit's launcher again, with the environment `up` gave it, until it is ready; then until it answers a workflow socket through the dev server |
| `pg_activity()` | `docker exec sce-texera-postgres psql ...` | `... pg-activity`: `kubectl exec` into the Postgres pod, with the password that pod holds | `... pg-activity`: `docker exec` into local-dev's Postgres container |
| `unit_env_names()` | `docker inspect` | `... unit-env <cuid>`: the engine container's `env` names in the pod spec, and the pod's address | the names the stack recorded when it started the unit (`MANIFEST.json`, `unit_env_names`) |

Each stack subcommand prints one JSON document. `pg_activity()` is `pg_stat_activity`'s
client backends but the asking one: `{pid, application_name, client_addr, datname,
state}` (`lib/pg_activity.py`). In Kubernetes and local-dev the driver's own
`DOCKER_HOST` still points at a socket that does not exist; the stack scripts are what
reach the cluster or the processes, and the control runs them without that guard
(`stack_script_env`): local-dev's `pg-activity` asks Docker for its own stack's Postgres.

### The transport seam (`driver/transport.py`)

How a run is started, watched and controlled lives only in `transport.py`.
Scenarios call `Transport.start_run(...)`, which returns a `RunHandle`, and use
only these `RunHandle` members:

| Purpose | Members |
|---|---|
| Wait | `wait_for_state`, `wait_until` |
| Control | `pause`, `resume`, `kill`, `ensure_stopped`, `modify_operator`, `send_raw` |
| Observe | `eid`, `plan`, `workflow`, `states`, `state_log`, `command_log`, `stats` / `output_rows`, `console`, `fatal_errors`, `error_event_count`, `refusals`, `modify_responses`, `modify_completed`, `results`, `replayed` |
| Report and clean up | `summary`, `close` |

`eid` is the create's on `create-ws`. A socket that only joined a workflow learns it
from the first `WorkflowStateEvent` that names an execution (`executionId`, there
since step 2's sub-part 14: the run the unit holds for the workflow), and
`replayed["execution_id"]` is what the open sequence named, `None` when the unit held
no run. On `ws` against a unit that names none it stays `None`, and the driver reads
it back. On `create-ws`, `plan` is the plan the create answered, which the start
carried, and `workflow` the create's logical plan, which a change to an operator is
made in; both stay out of the report.

`Transport` also has `open_socket(wid, cuid, token=None)` (a session on the
workflow, nothing sent), `create_only(**kw)` (the raw create response) and
`start_existing(wid, cuid, eid, plan, workflow=None, token=None)` (a socket as the
token's user that sends only the start, with `plan`; a handle with no `workflow`
cannot change an operator), and calls `phase_hook(phase, info)` when the driver
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
- The unit refuses the last command the handle sent (a `RequestRefusedEvent` naming
  that request: a start, a pause, a resume or a kill): what the caller waits for
  will not come. A refusal of something else the socket sent (`send_raw`) fails no
  wait; it is in `refusals`.
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
state or the refusal. The fail-fast paths were checked against the published images:

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
   replayFromExecution?}` (120 s timeout). 201 gives `{eid, plan}`: the plan is text
   for the unit, which the driver passes on as it came, reads nothing from and keeps
   out of its logs and reports (it holds the links its operators read files
   through). Anything else raises `CreateRefused(status, body)`, the body `{code,
   message}` (and `eid`, `operatorErrors` for a workflow that does not compile). The
   request names no operator to run up to: the Dashboard no longer reads
   `targetOperatorIds`, and no client sends its `targetOperatorId`.
2. Open the websocket as above and wait for the end of the open sequence.
3. Send `{"type": "WorkflowStartRequest", "executionId": eid, "plan": plan}`
   as the first marked command. The unit takes each execution's start once, in its
   memory: a second start of it is refused, "Execution N was already started."
4. Pagination and heartbeat as on `ws`. A pause, a resume and a kill name the
   execution (`{"type": "WorkflowPauseRequest", "executionId": eid}`): the unit
   refuses one that is not the run it holds. `modify_operator`:
   `POST /api/executions/{eid}/updates {operator, workflow}`, the workflow being the
   create's logical plan (anything but 201 raises `UpdateRefused`); 201 gives
   `{operatorId, update}`, text for the unit as the plan is; then `{"type":
   "OperatorUpdateRequest", "executionId": eid, "update": update}`, then the
   `ModifyLogicResponse`.
5. What the unit does not do of what the socket asked, it answers to that socket
   alone: `RequestRefusedEvent{request, executionId, message}` (`refusals`). A
   `WorkflowErrorEvent` carries only a run's errors.

On `ws` the handle knows no execution against a unit that names none in its state
events (the published images), and sends the old control frames, which such a unit
takes; where it knows one, its control frames name it.

### Evidence (`driver/evidence.py`, `--evidence [CHECKS]`)

Needs a stack started with `--pg-statement-log` (the preflight fails setup
otherwise). The listed checks gate the scenario (default: A-D and F; the letter E is
unused, as there is no plan table to read); the others are evaluated and reported as
`info`.

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
  l8, o and r settle the unit before their second start.

| Check | Holds when |
|---|---|
| A | start window: no unit statement starts with `SELECT` or `WITH`, and each is an INSERT or UPDATE on `workflow_executions`, `operator_port_executions` or `operator_executions` (a missing window end fails it) |
| B | terminal window: unit statements touch no other table |
| C | every `INSERT INTO workflow_executions` of the scenario has `app=texera-dashboard` and comes from none of the unit's addresses (none at all passes only when no create succeeded) |
| D | needs `--isolate-unit` (else not evaluable, which fails a gating D): `getent hosts file-service texera-lakefs` in the unit finds neither; the unit's log since the start mark names none of `file-service`, `texera-lakefs`, `:9092`, `:8000/api/v1`; and the gateway's access log since the start shows no request from one of the unit's addresses (nginx proxies file-service and the Dashboard, and the isolated unit still reaches nginx). A name that resolves, or the log naming one, fails D outright; when only the gateway log is unreadable (no `sce-access` line since the start), D is not evaluable |
| F | every statement from the unit's addresses in the scenario has `app=texera-computing-unit` (none at all passes; app-named unit statements from none of the known addresses make F not evaluable: the addresses are stale) |

Step 3's checks (its design, section 7 H4) are evaluated only when a gate or
`--evidence` names them, so a step-2 gate reads and reports exactly what it did.
Checks A and B gate 3A and 3B, where the unit still writes its status, and are
retired at gate 3C (not evaluated, unless `--evidence` names one): their windows end
at the unit's status UPDATE, which no longer exists, and G is stronger. C, D and F
stay; F passes trivially once the unit sends nothing.

| Check | Holds when |
|---|---|
| G | no statement at all comes from the unit between the scenario's begin and end marks: by its name or from one of its addresses, on any database, a setting or transaction control included (the step-2 checks skip those), a failed one too. After the last scenario a second part looks at the whole log: none since the unit's container started (`docker inspect`'s `State.StartedAt` at the preflight, against the time docker stamped each log line, so a line of an earlier container that had the unit's address does not count) |
| H | `pg_stat_activity`'s client backends, asked through the stack's control right before the scenario's begin mark and right before its end mark, hold no connection named `texera-computing-unit` and none from one of the unit's addresses. Postgres that cannot be asked makes H not evaluable |
| I | for every run of the scenario that was started and has ended, read from Lakekeeper's REST API, from the dashboard container (`driver/lake.py`: `GET /catalog/v1/config?warehouse=<w>` for the prefix, then the tables, in the warehouse the driver's runs use: texera's, `lakekeeperWarehouseName` or `user-<uid>-<whid>` on Dashboards that do not report it, else the default): the execution log's label names the ending the socket reported; the log holds exactly as many rows as the label's `seq` (more: a row landed twice, or a `seq` was skipped and another repeated; fewer: the label is ahead of its rows, or a `seq` was skipped); and the end tidy has run: the log holds one data file and one snapshot, the statistics table too (a run that never reached Running may have none of either), the console table too when the run printed, and no row when it did not. From gate 3B the rows are read as well, from `GET /api/executions/{eid}/log`: their `seq` are 1, 2, 3, ..., each is a state change (the log holds nothing else), and their states are the ones the run's socket was told, in order (READY for "Initializing"; Pausing and Resuming are not logged; a state told twice is one row). A run whose unit a scenario took down (q, s) is judged by the last state its unit recorded (RUNNING where it was killed, FAILED where it was stopped), its log may hold more than its socket heard, and its files are not counted: a unit that was lost or stopped does not finish its last tidy. A catalog that cannot be read makes I not evaluable |
| J | on a stack started with `--unit-no-postgres` (the preflight refuses any other when J gates): at the scenario's end `getent hosts texera-postgres` in the unit finds nothing (the host is the stack's `STORAGE_JDBC_URL`'s), and `docker inspect` says the unit is healthy. That every scenario passes there is what the scenarios' own checks say |
| K | after the last scenario, read from Postgres (`outcome`, `outcome_reason`, `ended_at` of the run's workflows' executions) every poll interval: every execution has its closing record within lost-after + 3 closing intervals of the last scenario's end (18 s); one that a scenario left unstarted on purpose (l5, l6, l10, t's third) within never-started-after + 2 closing intervals (19 s), since it is closed only once it is that old, and as failed, "never started". K takes the place of the final check on the rows left at status 0 or 6 |

- **When a record is judged.** A state's row and label reach the lake a moment after
  the state reaches the socket, and the end tidy after that, so a record is read
  until nothing is wrong with it, for at most 15 s (`RECORD_SETTLE_S`). The scenario
  runner has the records judged before it closes the scenario's sockets: until step
  3's sub-part 14 the unit clears a run's results and its console table once nobody
  watches it, and after it the Dashboard expires them (with `--fast-record` 20 to 25 s
  after the run ended, so a scenario made of parts, such as w, has each part's
  records judged when the part is over). A console table that is gone together with
  the execution's result tables is therefore reported as not judged (the agent's run
  in scenario o has no socket to hold it); one that is gone while they are still
  there fails.
- **What the catalog shows.** `lake.py` reads a table's properties and snapshots
  and the totals in the current snapshot's summary (`total-records`,
  `total-data-files`, `total-files-size`) from Lakekeeper's REST API. It opens no data
  file, so the rows' `seq` values themselves are not read: gate 3A's "one row per
  `seq`" is the row count against the label's `seq`.

Before each scenario that follows one which sent a start to the unit, the driver
waits (at most 15 s, recorded as `cleanup_wait`) until: the unit's cleanup
`DELETE FROM operator_executions WHERE workflow_execution_id = $1` of every eid the
previous scenario started has appeared; the unit's cleanup delay
(`WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS`) plus 0.5 s has passed since the
previous end mark (sockets close just before it); and the unit has run no statement
for 1 s. The idle cleanup keeps going after its DELETE (a SELECT of
`runtime_stats_uri` 20-40 ms later, then Iceberg work), so waiting for the DELETE alone
did not keep it out of the next windows. `settle_unit()` is the same quiet wait for
scenarios (l8 and r before their second start, o before its repeat). From gate 3B
the unit runs no cleanup statement, so only the delay and the quiet are waited for.
After all scenarios, the final check: no execution of this run's workflows is left
at status 0 (its unit was setting its run up), and at 6 (created, and never started)
only the ones a scenario left unstarted on purpose (l5, l6, l10), which must read 6;
with Check K required (gates 3B and 3C), Check K instead; and with Check G required,
G's look at the whole log (the report's `final_checks` then holds both).

A scenario that took the unit down tells the evidence when it is back
(`unit_restarted`): the unit's addresses are read again, and the ones it had stay
the unit's for what it sent from them.

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

`./run-negative-control.sh --step 3 --images <registry>/<tag>` is step 3's control
(its design, H5), run once per gate 3C against the images of step 2's last sub-part,
whose unit still writes its status to Postgres and boots with a pool:

1. The stack with `--pg-statement-log --isolate-unit --fast-record`, then scenarios a
   and q over `create-ws` with `--negative-control 3`. On each, Check G must fail on
   the unit's status UPDATEs and Check H on an idle connection of the unit; one that
   fails without that reason is "control inconclusive", one that passes "proves
   nothing". In q, which then makes one pass and asks none of step 3's routes, the
   history entry of the killed unit's execution must still say status 1 at every
   reading until past the deadline by which step 3 closes it (lost-after + 3 closing
   intervals); an execution that was closed means the control proved nothing.
2. The stack again with `--unit-no-postgres --expect-unit-down` (see the stack's
   options): the unit must not become healthy, and its log must say Postgres is why.
   The verdict is written to `reports/negative-control-<time>-unit.json`.

The exit code is the driver's, and 1 when the driver's controls held and the unit's
did not. Those images answer a create with where the plan is stored, and this
driver's `create-ws` needs the plan itself: on them a and q fail at their start. Run
step 3's control from the harness as it was before the plan went through the client
(`git worktree add <dir> 5d9ce19a6`), whose `create-ws` speaks those images' protocol;
its Checks G and H are the ones above.

### Offline tests (`driver/tests/`)

```
.venv/bin/python -m unittest discover -s driver/tests -v     # 344 tests (72 of step 2 and 193 of step 3 on the single-node stack, 37 Kubernetes mode, 42 local-dev mode), about 7 minutes
```

- `test_evidence.py` (23): the log parser (parameters, continuation lines,
  interleaved pids, failed statements), the incremental reader, and Checks A-D and F
  against a fake `docker` serving a synthetic log of the old unit (A, B, C, D, F
  fail; the negative control passes) and of the new path (every check passes; the
  controls then fail). Also: a start counts only states after it; the silence of a
  refused start (a read that names no eid fails it); the cleanup wait outlasting the
  trailing SELECT; a scenario that only opened sockets still waits out the cleanup
  delay; `settle_unit`; C refusing a Dashboard-named insert from a unit address; F
  not evaluable with stale addresses; D failing on a gateway request from the unit
  and not evaluable without the gateway log; each negative control "inconclusive"
  when it fails for another reason; the final check passing the rows a scenario left
  unstarted on purpose, at 6, and failing a row left at 0, a created row nobody left
  on purpose, and a refused start's row that reads 0.
- `test_transport.py` (26): both transports against `fake_texera.py`: the create
  body of 3.4, the start by id as the first command, with the plan the create
  answered (no report holds it), the create's answers (201 `{eid, plan}`; a refusal
  `{code, message}`; a workflow that does not compile with `eid` and `operatorErrors`
  beside them), `CreateRefused`, the update, made in the workflow of the create (201
  `{operatorId, update}`), then `OperatorUpdateRequest` with that update; no update
  from a handle that only started its execution; `UpdateRefused` (409 after the
  end), a pause and a resume that name their execution, a refused second start (one
  `RequestRefusedEvent` with the unit's sentence, no error event, nothing on the
  session that holds the run) that is not killed, a wait on it failing at once with
  the refusal, a kill of another execution and a pause that names none refused
  while the run goes on and the handle's own waits hold, a checkpoint without a run
  refused, a start as another user, the unchanged
  `WorkflowExecuteRequest`, `ModifyLogicRequest` and control frames on `ws`,
  environments (new and
  legacy), `/wsapi/pve`, users and unit termination; the open sequence (the fake
  replays the held run 0.1 s after the handshake, as the real unit does: the replay
  stays in `replayed`, the views stay empty; the quiet-period fallback without
  `ClusterStatusUpdateEvent`; a replayed fatal error does not fail a wait; a socket
  that only joined learns the execution's id from the replayed state). And step 3's
  calls against the fake at gate 3B: an execution's state and log (state changes
  and nothing else; a row of another kind has no state), the 403 for
  another user and for an execution that does not exist, the quota sizes, and the
  admin's list read page by page; and at gate 3C: stored console output page by
  page, and an export as the browser sends it (a form with the request and the
  user's token, the request naming the execution).
- `test_scenarios.py` (22): d, g0, j, k, the `l` group, m (with and without a replay
  log), o, f, f2, g, h, i through the real driver code against the fake (and a fake
  `docker exec` for o and the environment scenarios); j on `ws`, with the old
  frames; g removing an earlier install, and failing when run 1 says "reused"; the
  refused starts' sentences; l10's plan moved into the other warehouse whole (its
  `warehouse` and every location in it, from a warehouse or from none); l5 creating
  nothing on a stack without per-user warehouses; a unit that starts an execution
  twice failing l8; o's create as the agent service sends it. And the product of
  before step 2's review fails what follows it: a refusal that comes as a
  `WorkflowErrorEvent` fails l5 and l8, a created row that reads 0 fails l5, a kill
  of another execution that reaches the run fails d, a failed install that is also
  a console `ERROR` fails h.
- `test_scenario_evidence.py` (6): scenarios and evidence together, as e2e.py runs
  them, on a fake stack (the fake reports the statements the design's services run
  and the requests a gateway logs): l8 passes all five checks and its silence check
  although the second socket gets the held run replayed; l5, l6, l10 and the final
  check (their four rows at 6, left on purpose; a refused start's row that reads 0
  fails l5 and the final check); the cleanup between scenarios lands before the next
  begin mark; o's repeat is silent; a refusal path that reads Postgres fails the
  silence check; and the start rule before this fix fails l8's Check A (the review's
  case).

- `test_step3_scenarios.py` (59): the step-3 scenarios through the real driver code
  against the fake at a step-3 gate, with the stack's timers a tenth of
  `--fast-record`'s. Each scenario passes against the product as the design has it,
  and fails on the checks that name the fault when the fake is given one (the faults
  are listed in `fake_record.py`, `fake_closing.py` and `fake_texera.py`):
  - p at gate 3A: refuses a stack without `--fast-record`; fails when statistics, or
    console output, reach the lake only at the end, and when the recorder skips a
    `seq`. At gate 3B it reads `/log`, where the gap shows as `seq [1, 3, 4, 5]`. At
    both it fails when the log also holds an `output` row, as the design's revision 2
    had it.
  - q: both passes, with the readings inside their bounds and no listing of the
    units; fails when a lost unit is never closed (the history stays at 1), when the
    verdict comes at the first tick, when the execution is closed as of the verdict
    and not as of the last beat, and when an open execution has no `completionTime`;
    a reading the gateway did not answer is no verdict. In the fake's Kubernetes
    flavour: a third pass, each pass on a unit of its own, one listing, which stamps
    every unit whose pod is gone.
  - r: fails when the execution is never closed, closed too early, or reads
    Initializing while nobody has started it; when the "never started" verdict stays
    after the late start's run ended; and when the unit takes a second start of it.
  - s: fails when the stop records nothing (the execution then waits for the beat).
  - t: fails when a later run that started replaces nothing, when a create alone
    replaces (the design's revision 2), when an expiry keeps the results, takes the
    log and the statistics too, leaves `storedBytes` as it was, never comes by age,
    or comes before the TTL. Its tests run with a TTL of 3 s, not 2: at a
    tenth of `--fast-record` its waits are a few scheduling delays from the TTL.
  - w: fails on the six checks of a reason when the closing record gives none.
  - j at gate 3B waits for the closing record, and fails when the row stays open.
  - v: every read is made while the unit is down, its statistics and export requests
    are marked, the export names the execution and carries the token in its form; it
    fails on its console, export and statistics checks when stored output needs the
    unit. p at gate 3C reads the console route while the run goes and, after it, in
    two pages; t fails when an export of expired results is not 410.
  - What Kubernetes and local-dev mode show of a unit off Postgres: a pool found by
    its name alone, a Kubernetes unit that was given the database login, a stack
    that cannot be asked.
  - What step 3's negative control reads of q: Running past the deadline holds; a
    closed execution "proved nothing"; anything else is inconclusive.

  Also what gates 3A, 3B and 3C select in each mode, that `--scenario all` and step
  2's gates select what they did, and that a run without a step-3 gate and without a
  step-3 scenario is taken as a run of step 2.
- `test_step3_evidence.py` (70): Check I alone, against a fake `docker` whose catalog
  is the fake lake and a recorder that writes into it: a whole record passes; a label
  ahead of its rows, a gap in `seq`, a row that landed twice, several data files
  after the end, an ending the log does not have, a missing log, console rows of a
  run that printed nothing and a console table gone while the results are still
  there each fail for that reason; a record is read until the end tidy has landed; a
  run that never ran needs no statistics; a stopped unit's tables are not counted
  but its label is, and a lost unit's label is the state the kill found; an
  unreadable catalog is not a verdict; step 2's checks and `--evidence all` are what
  they were. Check I's reading of the log's rows (gate 3B): a gap in `seq` is named,
  so is a row that is no state change, a state the socket was told and the log
  lacks, and a route that fails; a
  unit taken down may have recorded more than its socket heard, but not something
  else; a run without a socket has only its `seq` read. Check K alone, against a
  Postgres that answers the closing records a test gives it: closed executions
  pass; a row left open, or closed after its deadline, fails; a row is watched until
  it is closed; a row left unstarted on purpose has until it is old enough, and must
  be closed as "never started"; the deadlines count from the last scenario's end.
  Then scenarios and evidence together: at gate 3A p passes A-D, F and I, l8, o, h
  and g leave whole records, and each recorder fault fails Check I, and only it, on
  scenario f; at gate 3B a run and a refused start end closed (the latter by the job,
  "never started"), q and s pass A-D, F and I with their records judged as they were
  left, and Check K fails for a row left open, for a lost unit never closed and for
  an unstarted execution never closed. Checks G, H and J alone: any statement of
  the unit fails G (its status UPDATE; a setting sent under its name from an unknown
  address; a statement on another database from its address), one between two
  scenarios fails only G's look at the whole run, and a line stamped before the
  unit started is another container's; a connection named after the unit, or from
  its address, at the scenario's start or at its end, fails H, and a Postgres that
  cannot be asked makes it not evaluable; J fails for a unit that resolves Postgres
  or is not healthy, and the preflight refuses such a stack; A and B are not
  evaluated at gate 3C. At gate 3C with the scenarios: v and q pass C, D and F to J
  and both final checks; a unit that still writes its status fails G and only G,
  one that still opens its pool H, one that is not healthy J. Step 3's negative
  control, against the fake at the end of step 2: a fails G and H as expected, each
  for its reason, and q's execution stays Running past its deadline; against the
  fake at gate 3C the same controls say that they proved nothing.
- `test_lake.py` (8): what `lake.py` reads from the catalog's answers: a tidied
  table, a table nothing was written to ("no snapshot" as a missing key, null or
  -1), a missing table against an outage, a summary without totals, namespaces from
  the services' settings, a name that needs percent-encoding, a listing over several
  pages.
- `test_stack_options.py` (21): `--fast-record` and `--dashboard-env` in the
  single-node generator (against a small source tree written by the test), the Helm
  values and the refusal of a chart that does not hand the timers over, local-dev's
  exports, and the timers the driver reads back from a manifest. `--unit-no-postgres`:
  Postgres is on the default network alone and Lakekeeper, RustFS and nginx stay
  beside the unit; it needs `--isolate-unit`; the network check refuses a compose
  that leaves Postgres reachable. `up --expect-unit-down`: the three verdicts, and
  that every service but the unit is waited for.
- `test_negative_control.py` (6): `run-negative-control.sh` with a stand-in stack and
  driver: step 2's calls are what they were; step 3 runs a and q with
  `--negative-control 3`, then the stack with `--unit-no-postgres --expect-unit-down`;
  its exit code when the unit came up, when the driver's controls failed and when
  the stack did not come up; `--step 3` without `--images` is refused.
- `test_e2e_main.py` (8): the driver's own `main`, from its command line to its
  report, on the fake stack (the fake Texera at a step, a fake `docker` for the
  evidence, the fake lake, the fake stack's control): gate D on the product after
  step 2's review fixes (a refused start's row is left at 6, which the final check
  expects); gate 3C on a stack whose unit has no Postgres (C, D and F to K gate,
  with both final checks) and on one with Postgres beside the unit (J is left out);
  gate 3B ends with Check K and closes what a refused start left; a unit that still
  writes to Postgres fails gate 3C in the scenario and in the look at the whole log;
  step 3's negative control passes on the product of step 2's end and fails on the
  product of step 3; a run without a step-3 gate asks step 2's product for none of
  step 3's routes.
- `test_stack_control.py` (15): the single-node control against a fake `docker`
  (`kill`, `stop -t 20`, `start` and the wait for healthy, nginx restarted only when
  the unit came back at another address, Postgres asked who is connected, the unit's
  environment names, a `docker` that refuses), the parsing of `pg_stat_activity`'s
  rows, how a stack script's one JSON document is read, and that the script does not
  inherit the driver's guard against Docker. The Kubernetes control
  is in `test_k8s_unit.py` (the unit that comes back is created without listing the
  units; every unit a run made is terminated) and the stack's subcommands in
  `test_k8s_stack.py`, with `post-run`'s verdict on the requests v marked (through
  the webserver's route, routed to a unit, not in Envoy's log); local-dev's are in
  `test_localdev.py`, run on throwaway processes (a "JVM" leading a process group
  with a "worker" in it).

`fake_texera.py` models the design, not Texera: a scenario that passes against it
drives the design's protocol and judges its answers as the design says; it proves
nothing about a branch. Where the product's code is known to differ from the design
it follows the code: step 2 is modelled as it is after its review fixes and with the
plan carried by the client (status 6 for a created execution, the create's and the
update's answers, of which the Dashboard keeps nothing, a create that clears only
results a later run replaced, a unit that checks the plan a start carries and takes
each execution's start once, in its memory, `RequestRefusedEvent` in the unit's
sentences, control frames checked against the run the unit holds, a failed install
as the run's error only), and the old `WorkflowExecuteRequest` path stands for the
published images' unit. `step` chooses the product it models: the end of step 2
(the default), or step 3 at a gate. At gate 3A every run started by id has a
recorder (`fake_record.py`) with a thread of its own, as in the design: a state's row
and label land a moment after the state reaches the socket (the log holds state
changes only); statistics and console
output land on the commit timer; the end tidy leaves one data file and one snapshot
per table; and the unit still clears a run's results and console table once nobody
watches it. The fake engine sleeps what a UDF's `time.sleep()` asks for (scaled),
prints what its `print(f"...")` prints, aggregates, and fails a run whose UDF raises
as its module is loaded.

At gate 3B the fake Dashboard closes executions (`fake_closing.py`), with the
design's limits and awkward moments (its section 4.6), because a fake that is kinder
than the product hides bugs: the job ticks on its timer and counts its own ticks
while a beat stands still, so a lost unit's execution reads Running until the count
is full; an execution whose run just ended reads its ending from the label while its
row is still open, and its reason only once the row is closed; a change to an ended
execution is refused only from then on; an unstarted execution is closed "never
started" once it is old enough; for revise-verdict-for after a verdict (a close that
is not the log's) the job gives the execution the ending its log shows by then, so a
late start or a unit that was cut off is not wrong for being late; a lost execution
ended at its unit's last beat; the job's expiry, on its own timer, takes an ended
execution's results when they are older than the TTL (a verdict's not before
revise-verdict-for is over) or when a later execution of the workflow on the unit has
started, and a create alone expires nothing; and the unit deletes nothing. The unit
can be taken down and brought back (`fake_stack.py` is the stack's control over it):
killed, it stops where it is and what it had buffered is lost; stopped politely, it
first ends its runs as FAILED and leaves their tables untidied; while it is down its
sockets and routes answer 502; back, it holds no run and remembers no start. In its
Kubernetes flavour a unit is a pod of its own, a listing stamps the units whose pod
is gone, and until gate 3C a statistics request goes to the unit its `cuid` names.
At gate 3C the unit sends Postgres nothing and opens no pool, a Kubernetes unit is
given no database login, the Dashboard serves stored console output page by page and
exports by execution (410 once the results expired), and a unit that holds no run of
a workflow answers an empty result page.
`faults` makes the recorder, the Dashboard or the unit misbehave in one named way at
a time, for the tests that show a check failing.

## What is verified against a real stack, and what is not yet

Step 2 lands in parts; until PR B there is no `POST /api/executions`, no
`WorkflowStartRequest`, no update endpoint and no `/api/execution/{eid}/run` to test
against. As of 2026-11-16, after the review of the step-2 harness (every report
records the harness commit in `harness_git`):

Verified against a real stack (reports under `reports/`). Each row records a run with
the harness and the images of its date; Check E, scenario l9, the plan tables,
`planUri` and `updateId`, which earlier rows name, are gone since the plan is carried
by the client.

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
| Final status-0 check | published, step2wip | runs; no row left at 0 |
| Gate B as a whole (`--gate B`): `create-ws`, a-e, u, j, k, l1-l10, m (its refusals), o, g0, with C, E and F gating | `sce/texera-*:step2p11` (the tree of `b71d84698`; `--source sce-imgbuild` at `b71d84698`) | all 21 PASS, twice: from empty volumes (`--reset`, `reports/baseline-20261117T013331Z.json`) and again on the same volumes, as the command at the top writes it (`reports/baseline-20261117T013948Z.json`); harness `00e6a81`, no uncommitted change. First real-stack runs of c, d, u, j, l5, l6, l9, l10, m and o on `create-ws`. C: every row inserted by `texera-dashboard` from the Dashboard's address; E: `started` on the plan table of every started run; F: every unit statement named `texera-computing-unit`. j: update 200, `ModifyLogicResponse` valid, `ModifyLogicCompletedEvent`, 11 rows `v1` then 289 `v2`, the other user's update 403, one after the end 409. The refused starts (l5 and l10 "the plan is in another user's warehouse", l6 "the plan is execution 11's, not 10's", l9 "execution 13 was created for computing unit 1, not 3", l8's and o's repeat "already started") reached their sender alone, and the unit ran no statement until after the answer. A and B, reported only, fail on the unit's two SELECTs of `site_settings` (the CSV column limit, until PR C); D is not evaluable without isolation. After the first run the unit's log held no `ERROR` line and the Dashboard's only k's compile error |
| m's replay run on `create-ws` (`--with-replay-log -- --gate B --scenario m`) | step2p11 | still blocked by the engine, as on step2wip: the source run fails right after `WorkflowCheckpointRequest` with `portId has not been set for channel ChannelIdentity(COORDINATOR, Worker:...-CSVFileScan-...-main-0, true)`. `EmbeddedControlMessageManager.isECMAligned` reads the port of the channel the checkpoint came from before it looks at the alignment type, and a source worker gets it on the coordinator's control channel, which has none (`AmberFIFOChannel.getPortId`). Both files are upstream's, untouched by the branch. With a log kept, m's first run completes (`logLocation` set) and both refusals pass. `reports/baseline-20261117T013828Z.json` |
| m's replay run with the source worker's checkpoint fixed (`--with-replay-log -- --gate B --scenario m,d`) | `sce/texera-*:step2ckpt` (sce-imgbuild `57c64e921`: `b71d84698` plus `fix(amber): take a checkpoint on a source worker`; `--source sce-imgbuild`) | the `portId` failure is gone: the CSV scan's worker prepares and finalizes its checkpoint ("Checkpoint finalized, total size = 5040 bytes" in the last report's run). Two older limits of the engine's checkpoint remain, both upstream's, so the interactions, the replay's create and its start are still unverified. (1) With the Python UDF m had until then, the run completes but lists no interaction: pyamber has no `PrepareCheckpoint` handler (`grpclib` `UNIMPLEMENTED` from `WorkerServiceBase.prepare_checkpoint`), so the coordinator's `propagateEmbeddedControlMessage` fails and records no replay destination (`reports/baseline-20261117T015618Z.json`, harness `24842ed`; d PASS, 17 checks, in the same run). m's checkpointed run therefore has JVM workers only now. (2) With the Java UDF the run fails at the checkpoint: `KryoException: InaccessibleObjectException: Unable to make field ... BuiltinClassLoader.parent accessible`, serialization trace `contextClassLoader (OutputPortStorageWriterThread)`, `outputPortResultWriterThreads (OutputManager)`, `outputManager (DataProcessor)`, from `PrepareCheckpointHandler.serializeWorkerState` (`PrepareCheckpointHandler.scala:61`). The checkpoint serializes the whole `DataProcessor`, and a worker whose output port is stored (here the viewed Java UDF) holds its live writer threads there (`OutputManager.scala:123`, upstream #3295, the same on upstream `main` `205fe77c4`). `reports/baseline-20261117T020500Z.json` |
| The browser smoke (`run-browser-smoke.sh --reset`): the frontend that creates an execution and then starts it, in headless Chromium 159 | `sce/texera-*:step2f` (sce-imgbuild `f8b43b980`, built with `--frontend`; `--source sce-imgbuild`) | B1-B6 all PASS (10, 17, 13, 15, 15, 11 checks) from empty volumes, harness `6fe524d`; the same six passed in the run before it. The pages made 10 creates (seven 201, two 400 in B2, one dropped by the page in B6) and one update (200), and sent 7 `WorkflowStartRequest`, 2 `WorkflowPauseRequest`, 2 `WorkflowResumeRequest`, 1 `WorkflowKillRequest`, 1 `OperatorUpdateRequest`, 17 `ResultPaginationRequest` and heartbeats: no `WorkflowExecuteRequest`, no `ModifyLogicRequest`, no uncaught page error. B4: 25 rows `v1`, then 275 `v2`. Scenario a on `create-ws` on the same stack afterwards: PASS (8 checks). The unit's log held no `ERROR` line and the Dashboard's only B2's two compile errors (`logs/` beside the report). `reports/browser-smoke-20261117T025740Z/` |
| The browser smoke with a page that did not start the run (`run-browser-smoke.sh --reset`): B7, the page loaded again, and B8, a second tab | `sce/texera-*:step2b` (sce-imgbuild `258d6ae54`, whose unit names the execution in `WorkflowStateEvent`; `--source sce-imgbuild`) | B1-B8 all PASS (10, 17, 13, 15, 15, 11, 18, 22 checks) from empty volumes, harness `dc7ba1b`. B7 (eid 11): the socket the reloaded page opened was sent `WorkflowStateEvent{state: Paused, executionId: 11}`; the page made no create and no start; `POST /api/executions/11/updates` 200; `OperatorUpdateRequest{executionId: 11, updateId}` of that answer on that socket; `ModifyLogicResponse.isValid`; 25 rows `v1`, then 275 `v2`; status 3. B8 (eid 12): the same in the second tab (`/api/executions/12/updates` 200, 26 rows `v1`, then 274 `v2`); the first page sent nothing after its Pause and showed the run Completed. All pages: 12 creates (nine 201, two 400 in B2, one dropped by the page in B6), 3 updates (200), 3 `OperatorUpdateRequest`, no `WorkflowExecuteRequest`, no `ModifyLogicRequest`, no uncaught page error. Scenario a on `create-ws` on the same stack afterwards: PASS (8 checks). The services' logs of this run were not kept. `reports/browser-smoke-20261117T064614Z/` |
| Gate C as a whole (`--isolate-unit -- --gate C`): gate B's scenarios plus f and f2, all six checks gating, the unit on a network of its own | `sce/texera-*:step2c` (sce-imgbuild `8a9e6988e`, built with `--frontend`; `--source sce-imgbuild`) | Single-node, from empty volumes: 22 of 23 PASS in the first run (harness `0f45a44`, `reports/baseline-20261117T082900Z.json`). f failed its content check alone, a mistake of the harness: it compared a result cell, which shows 100 characters, with the whole file. With f fixed (`e6a10a8`), f and f2 PASS on the same images from empty volumes (13 and 9 checks, `reports/baseline-20261117T084352Z.json`). The checks, first passing with the unit isolated; on scenario a: A, 0 of 4 unit statements offend (the unit starts a run with writes of run state only); B, 0 of 5; C, the row inserted by `texera-dashboard`; D, `getent` resolves neither `file-service` nor `texera-lakefs`, none of 17 unit log lines names one, the gateway served the unit 0 of 2 requests; E, `started` on the plan table; F, 13 statements from the unit's address, all `texera-computing-unit`. Browser smoke B1-B8 PASS (`reports/browser-smoke-20261117T083314Z/report.json`). Kubernetes (`create-ws`, a-e, u, k, l1, l6, l8, f, f2): all PASS but f's content check in the first run, and f after the fix (`reports/k8s-20261117T083646Z.json`, `reports/k8s-20261117T084455Z.json`). Local-dev, the same twelve with the fixed f: all PASS (`reports/localdev-20261117T084149Z.json`) |
| Gate D as a whole (`--isolate-unit -- --gate D`): a-e, u, j, k, l1-l10, m (its refusals), o, f, f2, g, h, i, all six checks gating, the unit on a network of its own; step 2's last gate | `sce/texera-*:step2d` (sce-imgbuild `d7700d580`, the end of step 2 before upstream is merged in; built with `--frontend`; `--source sce-imgbuild`) | Single-node, from empty volumes: all 25 PASS (harness `b41688a`, `reports/baseline-20261117T091102Z.json`). First real-stack runs of g, h and i. g: the unit's python3 cannot import tabulate; run 1's console says "Installing Python environment '...' (1 package)", then "is ready (2.2 s)" with `tabulate==0.9.0`, and Running comes only after it; the row says 0.9.0; run 2, on another workflow, says "reused" and reaches Running in 0.9 s against 3.0 s; one install directory, whose marker lists the requirement. h: Initializing, then Failed, never Running; the fatal error is "Python environment '...' could not be installed: Could not find a version that satisfies the requirement ... No matching distribution found ..."; no directory left. i: create 400 with the UDF's error naming the environment, the row FAILED, no unit statement. Browser smoke B1-B8 PASS (`reports/browser-smoke-20261117T091416Z/report.json`). Kubernetes (`create-ws`; a-e, u, k, l1, l6, l8, m, o, f, f2, g, h, i; what g, h and o run on the unit goes through `kubectl exec`): all 17 PASS (`reports/k8s-20261117T091758Z.json`). Local-dev (`create-ws`, the 25 of the gate; what g, h and o run on the unit runs on the host): all 25 PASS (`reports/localdev-20261117T092238Z.json`) |
| The browser smoke on the merged tree (`run-browser-smoke.sh --reset`): the editor after upstream's #9060 and #9063 (the bottom panel holds the console alone, a result opens beside its operator), and B9, a Python environment of the Dashboard | `sce/texera-*:step2m` (sce-imgbuild `55c14da26`: step 2 with upstream `main` `021bf51c1` merged in and the unit's own Python environments removed; built with `--frontend`; `--source sce-imgbuild`) | With the smoke as it was (harness `ce1fb91`) B1, B2, B4, B5, B7 and B8 failed, each only where it looked for the bottom panel's Result or Static Error tab ("the result panel has no 'Result' tab; tabs ['Console']"; B5 ends at that check); their other checks passed, the rows read over the driver's socket among them (`reports/browser-smoke-20261117T100238Z/`). With the cases reading the result window and the console, B1-B9 all PASS (10, 17, 13, 15, 15, 11, 18, 22, 16 checks), twice in a row, each from empty volumes, harness `f66b67f`, no uncommitted change: `reports/browser-smoke-20261117T105415Z/` and `reports/browser-smoke-20261117T105958Z/`. In both: B4 and B7 26 rows `v1`, then 274 `v2`, B8 25 and 275, read in the UDF's result window (first page `v1`, page 50 `v2`) and over the driver's socket. B9 (eid 13): `POST /api/environments` 201 from the Environments page; the UDF's console said "Installing Python environment 'sce-browser-env-...' (1 package)", then "... is ready (2.9 s)" (3.3 s in the second run), both while the run button said Submitting; the ready message lists `tabulate==0.9.0`; the row says `0.9.0`; the unit's row of the computing-unit menu offers rename, details and disconnect. All pages: 13 creates (ten 201, two 400 in B2, one dropped by the page in B6), 3 updates (200), 10 `WorkflowStartRequest`, 3 `OperatorUpdateRequest`, no `WorkflowExecuteRequest`, no `ModifyLogicRequest`, no uncaught page error. Scenario a on `create-ws` on the same stack afterwards: PASS (8 checks), both times. Noted, not a check: while B9's run was Running the UDF's console was empty (0.4 s and 0.5 s here), its two messages back when the run ended |
| Gate D again with upstream merged in (`--isolate-unit -- --gate D`) | `sce/texera-*:step2m` (sce-imgbuild `55c14da26`: step 2 on upstream `021bf51c1`; built with `--frontend`; `--source sce-imgbuild`) | Single-node, from empty volumes: all 25 PASS, all six checks gating (`reports/baseline-20261117T095935Z.json`). Kubernetes, the 17 of the row above: all PASS (`reports/k8s-20261117T100820Z.json`). Local-dev, the 25: all PASS (`reports/localdev-20261117T101301Z.json`). The browser smoke of that run failed six cases on upstream's own change of the editor (#9060: results beside their operators); with the smoke adapted it passes B1-B9, the row above |

Written and tested offline only (`driver/tests/`), to be validated when the PRs land.
Step 3's product is being built against its design while this is written, so its
rows also name what the harness had to assume (see "Step 3: what is assumed"):

| Part | Lands with | Offline test |
|---|---|---|
| Gate 3A as a whole: p, Check I, `--fast-record` in the three stacks, the catalog read from each mode's stack | step 3's sub-parts 2-7 | `test_step3_scenarios.py`, `test_step3_evidence.py`, `test_lake.py`, `test_stack_options.py` |
| Gate 3B as a whole: q, r, s, t, w, p's and Check I's reading of `/log`, j's wait for the closing record, Check K, the cleanup wait without the unit's DELETE | step 3's sub-parts 9, 11-15 | `test_step3_scenarios.py`, `test_step3_evidence.py`, `test_transport.py` (`RecordApiTest`) |
| The stack's control on a real stack: `docker kill`, `stop` and `start` of the unit and what nginx and the open sockets do then; a pod deleted with and without its grace period, and a second unit made mid-run; local-dev's unit killed, stopped and started again under a running stack; `pg_stat_activity` read in each mode. Also Checks A-D and F across a unit restart (q, s): the unit's boot must log no file-service or LakeFS name (it logged none in a local-dev run of step 2) and run no statement outside the run-state tables | gate 3B | `test_stack_control.py`, `test_k8s_unit.py`, `test_k8s_stack.py`, `test_localdev.py` (`UnitControlTest`), `test_step3_evidence.py` (`ClosingEvidence`) |
| Gate 3C as a whole: v, p's console route, t's 410, Checks G, H and J, the retirement of A and B, `--unit-no-postgres`, the other modes' proof (`unit_without_postgres`), and in Kubernetes Envoy's routes for v's marked requests | step 3's sub-parts 16-19 | `test_step3_scenarios.py`, `test_step3_evidence.py`, `test_stack_options.py`, `test_k8s_stack.py` (`StoredReadsTest`), `test_transport.py` (`StoredOutputApiTest`) |
| Step 3's negative control: G and H failing for their reasons on a unit of step 2's end, q staying at status 1, and that unit not booting without Postgres (what its log says then: the control looks for Postgres's host name, `PSQLException` or `HikariPool`) | gate 3C | `test_step3_evidence.py` (`Step3Control`), `test_stack_options.py` (`UnitDownControlTest`), `test_negative_control.py` |
| What a real stack must still show for gate 3C: how long the unit takes to stop politely (v reads results that expire 20 s after their run; see the scenarios); that `docker inspect`'s `State.StartedAt` and docker's log stamps order a unit's first statement after its start (G's look at the whole log); Envoy's `route_name` for a request the static route answers | gate 3C | - |
| D failing on a gateway request from the unit, F not evaluable with stale addresses, a negative control reported "inconclusive", gate D | PR C-D | `test_evidence.py`, `test_scenario_evidence.py` |
| The driver after step 2's review fixes (reports X1, X3 and X4), read in the product's code at `2147aeaec`: control frames that name the execution and d's kill of another execution; a refused start as one `RequestRefusedEvent` with the unit's sentence (l5, l6, l8, l10, r's second start, o's repeat); the create's and the update's answers (j, k); o's create as the agent service sends it; status 6 in the refused starts' rows and in the final check; h's failed install as the run's error only | the images of step 2 with its review fixes | `test_transport.py`, `test_scenarios.py`, `test_scenario_evidence.py`, `test_evidence.py` |
| m's replay run after the checkpoint: its interactions, the replay's create and start | PR B, and an engine whose global checkpoint works | `test_scenarios.py` (`ReplayScenario`) |
| The plan carried by the client: the create's `{eid, plan}` and the start that carries it, l10's plan moved into the other user's warehouse, the update made in the create's workflow and answered `{operatorId, update}`, a unit that takes an execution's start once, in its memory (l8, o, r), and r's late start replacing the "never started" verdict | Texera `9abfc1e34` | `test_transport.py`, `test_scenarios.py`, `test_scenario_evidence.py`, `test_step3_scenarios.py` (`NeverStarted`) |

What step 2's review fixes changed that no scenario checks yet (from the reports'
"Externally visible changes"; the browser's side is the browser smoke's):

| Report | Not checked |
|---|---|
| X4 | A change the unit refuses (`OperatorUpdateRequest` of an execution it does not hold, or of another user): `ModifyLogicResponse` with `isValid: false` and the unit's sentence. j only makes a change that applies |
| X4 | A frame the unit cannot read ("The request could not be read as a <Type>.", which is what the old `WorkflowExecuteRequest` now gets), a checkpoint, retry, skip, debug command or evaluation with no run ("No execution of this workflow is running here."), and a pause, resume or kill with no run at all. d checks a kill of another execution while a run is held |
| X4 | A session without WRITE on the unit ("You do not have write access to the computing unit."): on the single-node stack every session has WRITE |
| X4 | The sync route after a failed environment install: `errors[0]` carries the run's error and no operator has an `error`. h checks the socket's side only |
| X4, X1 | The start refusals no scenario provokes: a start without a plan, or with one the unit cannot read; a plan of another workflow, input links that expired, a plan in a per-user warehouse while those are disabled, a replay log outside where the unit keeps them; a start for another unit, sent to a unit that knows its id ("This is computing unit X, not Y.": one the unit manager created) |
| X3 | `targetOperatorId`, the Dashboard's own cut of a plan, and its 400 for an operator the plan lacks. No client sends it |
| X3 | The compile's deadline (504 after 60 s) and its queue (503), each leaving the row Failed |
| X3 | A replay of another user's execution (400). m checks a source without a log and a source of another workflow |
| X3 | A create clears an ended execution's results only once a later execution of the workflow on the unit has results of its own. t checks step 3's form of it |
| X3 | What a Created row is not counted as: a run in progress for the editor's lock and the manager's idle sweep, the latest execution for an export; and "CREATED" in the admin's list. The driver checks that the row reads 6 |
| X3 | The words of the create's and the update's refusals: l1-l4, l7, m and j check their statuses |
| X3 | In Kubernetes, the three settings the manager now forwards to unit pods (the allowed link endpoints, the environments' root and install timeout): the Kubernetes stack sets none of them, so nothing shows a unit pod getting one |
| X1 | A UDF that reads a dataset or a model on a unit without a mounter: the create answers 201 and the run fails at its start, naming the operator and what it cannot mount; a change to a paused operator that reads one is refused |
| X1 | A plan, or a change, larger than 16 MiB: 400, the row Failed |

### Step 3: what is assumed

The harness for step 3 was written from the step-3 design (`docs/step3-design.md`,
sections 3 and 7) before the product, and from the two notes that say where the
product differs from it (`docs/step3-notes/`: the report of sub-parts 2 to 4, and what
changed since revision 2). Each thing it takes from them rather than from the
product's code is kept in one place, so that following the product is a one-line
change:

| Assumed | From the design | Where |
|---|---|---|
| The lake's layout: namespaces `execution-log`, `workflow-runtime-statistics`, `operator-console-messages`, `operator-port-result`, `operator-port-state` (or the services' `STORAGE_ICEBERG_TABLE_*_NAMESPACE`), tables `wid_<wid>_eid_<eid>_executionlog`, `..._runtimestatistics`, `..._consolemessages` | 3.1, 3.7 | `EXECUTION_TABLES`, `PORT_TABLES` in `driver/lake.py` |
| The label's six properties, `texera.execution.state`, `.state-seq`, `.state-time-ms`, `.reason`, `.beat-ms`, `.beat-every-ms` | 3.2 | `LABEL_*` in `driver/lake.py` |
| Lakekeeper carries `total-records`, `total-data-files` and `total-files-size` in the summary of the snapshot a tidy leaves | 1b | `_table_state` in `driver/lake.py` |
| The states the log holds, by the name a socket is told: READY for "Initializing"; Pausing and Resuming not logged | D2, D6 | `LOGGED_STATES` in `driver/evidence.py` |
| The statistics route keeps today's field names (`operatorId`, `timestamp`, `inputTupleCount`, `outputTupleCount`, `numWorkers`, `status`), `timestamp` in epoch milliseconds | 3.5 | `StatisticsRow.of` in `driver/texera_api.py` |
| The timers' settings and what `--fast-record` gives them | 3.7, 7 H2 | `TIMERS`, `FAST_RECORD` in `lib/record_env.py`; the product's defaults in `driver/record_timing.py` |
| In Kubernetes, `texeraEnvVars` reaches the webserver and the managing service, and the managing service forwards `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS` to unit pods | 7 H2, 8 | `record_options`, `missing_record_env` in `stack/k8s/k8s_stack.py` |
| `GET /api/executions/{eid}/state` answers `{status, open, reason, timeMs}` | 3.5 | `ExecutionState.of` in `driver/texera_api.py` |
| `GET /api/executions/{eid}/log` answers `{entries[{seq, timeMs, kind, state, reason?, errors?}], closing{outcome, reason, endedAtMs} or null}` | 3.5 | `LogEntry.of`, `ExecutionLog.of` in `driver/texera_api.py` |
| The log holds state changes only: a stored port's location is in the plan, so the design's `output` rows are gone. A row that names no `kind` is taken to be a state change | changes since revision 2, 2 | `LogEntry.of`, `ExecutionLog.states` in `driver/texera_api.py`; `Evidence._log_problems` in `driver/evidence.py` |
| An execution that was created and that no unit has started still reads status 6, Created, once its status comes from the label (a label that names no state); the closing job still closes it "never started" | changes since revision 2, 3 | `STATUS_CREATED` in `driver/scenarios.py` (r) |
| An ended execution's results are replaced by the closing job's expiry once a later execution of its workflow on its unit has started (its label names a state), so within a commit interval + one expiry pass + 2 closing intervals of that start; a create alone replaces nothing | changes since revision 2, 4 | `replaced_verdict_s`, `expired_verdict_s` in `driver/record_timing.py`; `scenario_t` in `driver/scenarios.py` |
| A history entry carries `reason`, and a `completionTime` that is never null | 3.5, D21 | `history_reason`, `history_completion_ms` in `driver/texera_api.py` |
| The admin's list says why an execution ended in a field named `reason` (the design says the list shows reasons, not the field's name), beside today's `workflowId`, `executionId`, `executionStatus` | 3.5, 6 | `AdminExecution.of` in `driver/texera_api.py` |
| The quota route answers `[{eid, storedBytes, ...}]` | 3.5 | `TexeraApi.quota_sizes` |
| The reasons' words: "killed by the user", "the computing unit was stopped", "unit lost", "never started", "compile error: ..." | D5, D26, D28, D29 | `REASON_*` in `driver/texera_api.py` |
| The closing record's columns `outcome`, `outcome_reason`, `ended_at` on `workflow_executions` | 3.4 | `CLOSING_RECORDS` in `driver/evidence.py` |
| After an expiry `stored_bytes` is exactly the `total-files-size` of the log and the statistics table, added up | 4.3, 4.4 | `_check_expired` in `driver/scenarios.py` |
| A log's state rows are the states the run's socket was told, in order (both come from the unit's one `transitionTo`) | 4.1 | `logged_states`, `Evidence._log_problems` in `driver/evidence.py` |
| How long a beat must stand still, and by when a lost or an unstarted execution is closed | D26, 7 H3, H4 | `lost_watch_s`, `lost_verdict_s`, `never_started_verdict_s` in `driver/record_timing.py` |
| A UDF that raises as its module is loaded fails the run with the raised message in the first error (read in step 2's code: a raise in `process_tuple` only pauses the worker) | 7 H3 (w) | `udf_raises_on_load` in `driver/scenarios.py` |
| `GET /api/executions/{eid}/console?operatorId=&afterSeq=&limit=` answers `{messages[{seq, operatorId, msgType, title, message, ...}], lastSeq, more}` | 3.5 | `ConsolePage.of`, `TexeraApi.execution_console` in `driver/texera_api.py` |
| An export's request is today's (`exportType`, `workflowId`, `workflowName`, `operators[{id, outputType}]`, `datasetIds`, `rowIndex`, `columnIndex`, `filename`, all required), with `executionId` in place of `computingUnitId`; the local export stays a form with `request` and `token`, and one operator as `csv` answers the CSV itself, header first (read in step 2's code) | 3.5, brief 16 | `export_request`, `TexeraApi.export_local` in `driver/texera_api.py`; `_export_rows` in `driver/scenarios.py` |
| An export of expired results answers 410 with a body that names "execution N" and "expired" | 3.5, brief 16 | `_check_expired` in `driver/scenarios.py` |
| The unit reaches Postgres by the host of the stack's `STORAGE_JDBC_URL` (else `texera-postgres`) | 7 H2 | `JDBC_URL_ENV`, `DEFAULT_POSTGRES_HOST` in `driver/evidence.py`; `postgres_host` in `stack/sce_stack.py` |
| The unit names its connections `texera-computing-unit` (step 2) | 7 H4 | `UNIT_APP` in `lib/pg_activity.py` |
| In Kubernetes a request that reaches a unit matched the HTTPRoute `texera-dynamic-routes`, whose name is in Envoy's `route_name` (read in the chart) | 7 H6 | `UNIT_ROUTE`, `judge_stored_read` in `stack/k8s/k8s_stack.py` |
| A Kubernetes unit's database login is the three `STORAGE_JDBC_*` settings of its engine container | brief 19 | `_unit_without_postgres` in `driver/e2e.py` |

## `run-baseline.sh`

```
./run-baseline.sh [--reset] [--keep] [--images <registry>/<tag>] [--source <worktree>] [--label text]
                  [--pg-statement-log] [--isolate-unit] [--with-replay-log] [--unit-env KEY=VAL ...]
                  [--fast-record] [--dashboard-env KEY=VAL ...] [--unit-no-postgres] [-- <driver args>]
```

`up` (published images by default, with the stack options given), then wait until
healthy, then `status`, then run the driver. The report goes to
`reports/baseline-<UTC time>.json` and embeds the stack manifest. Afterwards the
script runs `down`, keeping the volumes, unless `--keep` is given. `--reset`
starts from empty volumes.

## Browser smoke: `driver/browser_smoke.py` and `run-browser-smoke.sh`

The scenarios above speak the protocol themselves. The browser smoke drives the page
a user sees: Playwright's headless Chromium opens a workflow in the editor of a
running stack, presses Run, Pause, Resume and Stop, changes a paused operator in the
property editor, opens an operator's result beside the operator and reads its table,
and reads the console. It needs images whose frontend creates an execution and then
starts it with the plan the create answered (`images/build.sh --frontend`, from the
plan carried by the client, `9abfc1e34`, on).

The cases follow the editor as it is from the merge of upstream's `main` on (`step2m`):
the bottom panel holds the console alone (upstream `04bce08d7`, #9060), an operator's
result opens in a window beside the operator (#9063), and errors are console messages.
On older images B1, B2, B4, B5, B7 and B8 fail where they read a result or an error:
those frontends have a Result and a Static Error tab in the bottom panel instead (the
smoke read them there up to harness `104e51e`). B9 also needs the unit that installs a
run's environments and keeps none of its own (step 2's PR D and `55c14da26`).

```
./run-browser-smoke.sh --images sce/<tag> [--source <worktree>] [--reset] [--keep] [--lock <dir>]
                       [--api-scenario a,d | --no-api-scenario] [--label text] [-- <browser_smoke.py args>]
.venv/bin/python driver/browser_smoke.py [--base http://localhost:8080] [--case B1,B3] [--out <dir>]
                                         [--headed] [--slow-mo MS] [--timeout 300] [--list]
```

`run-browser-smoke.sh` takes the stack lock when given `--lock` (otherwise the caller
holds it), runs `up`, the smoke, then the driver's scenario a on `create-ws` on the
same stack, and `down` (with `--keep` the stack and the lock stay). It writes
`reports/browser-smoke-<UTC time>/`: `report.json`, one screenshot or more per case and
`api-scenarios.json`. Exit code: the smoke's (0, 1 a case failed, 2 setup failed), 3 the
stack did not come up, 4 the smoke passed and an API scenario failed. A whole run takes
about four minutes, three of them the nine cases. `playwright` is in `requirements.txt`;
the script installs its Chromium build on first use (`python -m playwright install chromium`).

**Setup and sign-in.** Setup is the driver's (`texera_api.py`, `workflow.py`): the
dataset, the warehouse, the local unit, and one workflow per case stored in UI format.
The page is signed in by putting the driver's token where the frontend keeps it
(localStorage `access_token`, `AuthService.TOKEN_KEY`), and its unit is the one the
frontend remembers for the workflow (localStorage `computing-unit-of-workflow-<wid>`,
`ComputingUnitSelectionComponent`). Both are set by an init script before the page's
own code runs; the warehouse is the one the page preselects (the user's first). Every
case gets a fresh browser context; B8's second tab is a second page of its case's context.
B9's environment is not part of the setup: the case makes it in the page.

**Cases.** Expected rows are computed from the CSV files, as in the scenarios.

| Key | What the page does | Checks |
|---|---|---|
| B1 | CSV scan → Filter `age > 30` → Aggregate by `dept`; Run; a double-click on the Aggregate | create 201 `{eid, plan}`, with the workflow, unit and warehouse in its body; `WorkflowStartRequest{executionId, plan}` of that answer, sent after it; run button Run again, every operator on the canvas `Completed`; the result window that opens beside the Aggregate shows the 4 expected rows; status 3 |
| B2 | A Projection of `sce_no_such_column`. First as the page is: once the editor's own compile (`POST /api/compile`) has answered, the run button says `Invalid Workflow` and is disabled, so for this workflow the create's 400 is reachable only before that answer. Then with the editor's compile request held back (not faked: let through unchanged later): Run, the Projection selected and the console opened, Run again, the compile let through, the Projection's attribute picked in the property editor (`name`), Run, "pin result" in the Projection's right-click menu | 400 with `operatorErrors` naming the column; run button Run again and enabled; nothing sent on the websocket; the console, narrowed to the Projection, shows its error: a message of type ERROR naming the column; the second Run a second 400 with another eid; both rows 4; after the fix 201, the start, Completed, the 10 names over the 2 pages of the Projection's result window; exactly one `WorkflowStartRequest` on the page |
| B3 | `numbers.csv` → a Python UDF sleeping 0.2 s per tuple; Run, Pause, 3 s, Resume, Stop | run button Run, Pause, Resume, Pause, Run (Pausing and Resuming between); the UDF's box says `Paused`, then `Running`; states from the unit Running, Paused, Running, Killed, never Completed; frames `WorkflowStartRequest`, `WorkflowPauseRequest`, `WorkflowResumeRequest`, `WorkflowKillRequest`, once each, in order; status 5 |
| B4 | `numbers.csv` → a UDF tagging `"v" + str(VERSION)`, 0.1 s per tuple, `VERSION = 1` as its last line; Run, Pause; in the property editor Unlock for Logic Change, Edit code content, in the code editor a click behind the last line, End, Backspace, `2`; close; Confirm Change; Resume; a double-click on the UDF | `POST /api/executions/{eid}/updates` 201 with `{operatorId, update}`, its body the UDF with `VERSION = 2` and the workflow the run ran, as it was before the change (both operators, the UDF with `VERSION = 1`); `OperatorUpdateRequest{executionId, update}` of that answer; `ModifyLogicResponse.isValid`; the toast "reconfiguration registered"; Completed; `ModifyLogicCompletedEvent`; the UDF's result window opens on its first page, `v1`, and its last page is `v2`; all 300 rows read back over a second socket (the driver's transport): every `v1` before every `v2`; status 3 |
| B5 | `people.csv` → a UDF stamping its rows with the time its module was loaded; Run, a double-click on the UDF, read the table, Run again, read the table in the window, which was left open | each run: 201, the start with its own eid and plan, Completed, one stamp on all 10 people; two executions with two plans; the window was still open when the second run ended, and its stamp is later (the first run's rows are gone from the table); two start frames |
| B6 (extra) | Run with the create's answer kept from the page (the request reaches the Dashboard; only the 201 is delivered late, as on a slow network); Stop while the button says Submitting; then Run again | the Dashboard created the execution; Stop is offered while Submitting; after Stop the run button is Run; no frame at all for the run that was given up, also after its 201 arrives (the page had dropped the request); the second Run: 201, its start, Completed; the only start frame is the second run's |
| B7 | B4's workflow: Run, Pause; then the page is loaded again (the browser's reload: the page's code starts from nothing and holds no answer of its own create); then B4's change, Confirm Change, Resume | after the reload: run button Resume, stop enabled; the reloaded page's socket was sent `WorkflowStateEvent{state: Paused, executionId}` of the run's eid; no `POST /api/executions*` and no `WorkflowStartRequest` since the reload; then B4's checks, on that eid: the update's path, 201, `OperatorUpdateRequest{executionId, update}`, the rows, status 3 |
| B8 | B4's workflow: Run, Pause in one page; the workflow opened in a second tab (a second page of the same browser context); B4's change, Confirm Change and Resume in that tab | in the second tab: the three checks B7 makes after its reload, then B4's checks on the tab's own requests and frames; the first page sent no update and no `WorkflowResumeRequest`, and shows the run Completed |
| B9 | A Python environment as a user has one now that a unit keeps none: scenario g in the page. First g's precondition, and g's removal of an install of `tabulate==0.9.0` that a kept stack still holds (both run in the unit's container). On the Dashboard: the sidebar's Environments, Create Environment, the name `sce-browser-env-<hex>`, one package row (`tabulate`, `==`, `0.9.0`), Save. In the editor: Text Input → a UDF that outputs `tabulate.__version__`, saved in the engine's own environment; the UDF selected, Default Python Environment unchecked, the environment picked in the Virtual Environment list; the console opened; Run; the console's ready message opened; a double-click on the UDF; the computing-unit menu opened | the unit's own `python3` cannot import tabulate; `POST /api/environments` 201, its body `{name, packages: {tabulate: ==0.9.0}}`, its answer the row; the page's toast and list have the environment, and so has `GET /api/environments`; the Virtual Environment list has it, and shows it picked; create 201 whose UDF carries `defaultEnv: false` and the `envName`; the start; while the run button said Submitting the UDF's console said "Installing Python environment '<name>' (1 package)", then "Python environment '<name>' is ready (N s)"; Completed; with the run ended the console shows both, in that order, and the ready message, opened, lists `tabulate==0.9.0`; the UDF's result window shows `0.9.0`; status 3; in the computing-unit menu no unit's row has a `+` (it was the Python Environment action), and none of the menu's texts and tooltips names an environment |

Every case also checks that the page never sent `WorkflowExecuteRequest` or
`ModifyLogicRequest` and that the page raised no uncaught error.

In B9 everything a user does is done in the page: the environment is made on the
Environments page (six steps) and picked in the property editor. The driver's API saves
the workflow, as in every case, and reads the environment back. What B9 knows of the
unit it reads as scenario g does, with `docker exec` into the unit's container
(`UnitChecks`, scenarios.py's `Ctx` with the case's record), so B9 runs on the
single-node stack only.

**Evidence.** For each page the report holds (`cases[].pages[]`): every request to
`/api/executions*` and `/api/environments*` with its status and a short view of the
bodies (`network.executions_requests`, `network.environments_requests`); every websocket
the page opened and, for the workflow websocket, every frame it sent, whole and timed
(`network.websockets[].sent`, heartbeats counted in `sent_types`), the states the unit
reported, each with the execution it named (`states[].executionId`), and the
`WorkflowErrorEvent`, `ModifyLogicResponse` and `ModifyLogicCompletedEvent` it sent;
every HTTP answer of 400 and up; the run button's text, as it changed
(`run_button_timeline`); what the console showed while it was open, as it changed, with
the run button's text at that moment (`console_timeline`); toasts; console errors and
uncaught page errors. `summary` adds the frames of all pages by type,
`old_requests_sent` and what the pages wrote to `/api/environments*`. The access token
is cut out of everything written. The texts a page hands on to the unit, the plan a
create answers and the change an update answers, are written as their length and
sha256 only: a plan holds the links its operators read files through.

**How the page is driven, and what that depends on.**

- States are read where the page shows them: the run button's text (`#run-button`:
  Run, Submitting, Pause, Pausing, Resume, Resuming), the stop button
  (`button[title^="Stop this run"]`) and each operator's state text on the canvas
  (`[model-id=<operatorID>] .texera-operator-state`). The page has no label for
  Completed or Killed.
- An operator is selected by a mouse click at its box's coordinates (its own boundary
  rect lies over the body, so an element click never becomes "actionable"). A
  double-click and a right-click go to the same place.
- An operator's result is in a window the page pins beside the operator
  (`texera-pinned-result-window[data-operator-id=<operatorID>]`). A double-click on the
  operator opens it (B1, B4, B5, B7, B8, B9), and so does "pin result" in the operator's
  right-click menu (B2). The window stays until it is closed: over a new run (B5), not
  over a reload. It is drawn over the property editor and the console where they meet.
  An operator whose result the run did not keep, or that failed, gets a window with a
  sentence in place of a table; the smoke quotes it when it misses a table.
- The window's table (`.result-table`, the component the bottom panel had) pages over
  the websocket: a page's number turns at once and its rows arrive a moment later, so a
  page turn waits for other rows. The page size follows the window's height and what
  the table draws above its rows (6 rows here, 7 for the Projection's one column). A
  window left open on page 2 over a new run is still on page 2 after it.
- Rows of an operator with two workers (the Projection) are shown in the workers' order,
  not the file's, so rows are compared in any order.
- The console is the bottom panel (`#result-container texera-console-frame`). Nothing
  opens it by itself; the smoke uses its button at the bottom left (`#result-buttons`).
  With one operator selected it shows that operator's messages under "Showing:
  <operator>". An error of a compile or of a run is a message of type ERROR (the type is
  the colour of the message's badge), with its kind as the source tag
  (`COMPILATION_ERROR`, `EXECUTION_FAILURE`). A message that holds more than its title (a
  stack trace, an environment's packages and what pip wrote) opens on a click on the
  title. When a run goes from Initializing to Running the console empties itself until
  the next message or state, so what a unit said while it installed an environment is
  not on show while the run is Running; B9 reads those messages before (the timeline) and
  after, and notes the gap.
- The code editor is Monaco behind the property editor's "Edit code content" button,
  which exists only after "Unlock for Logic Change". Typing a whole program into it
  would be indented and completed by the editor; the case changes one character.
- The Environments page is the dashboard's `/user/python-venv`, reached through the
  sidebar; its form is a modal (`.pve-modal`). A UDF's environment is the property
  editor's Virtual Environment list (`envName`), which is there only while Default
  Python Environment is unchecked. Each time a Python UDF is selected the property editor
  asks `GET /api/environments` and lays its form out again with the answer, so B9 waits
  for that answer before it touches the form. A long list is drawn in part; the list's
  search box then narrows it.
- The computing-unit menu is the editor's unit button (`button.computing-units-dropdown-button`);
  a unit's actions are the icons of its row, each read with the tooltip a pointer on it
  brings up (the row's own tooltip, "Ready to use", shows with it).
- B7's reload is `page.reload()`. The init script runs again in the new document, so the token
  and the unit are where the frontend looks for them, as after a user's reload; the run
  button's texts and the toasts of the earlier load are kept, with a `(page reloaded)` entry
  between. The page's requests and sockets before and after are one record: the socket of the
  first load has no `closed_at` (the browser reports no close for a document that goes away),
  and the answers of the first load are read before the reload, while the browser still
  holds their bodies. B8's tab writes its files as `B8-tab-*`.
- `workflow.py` puts the first operator at x = 80, which in the page is under the
  dashboard's sidebar; the smoke moves its own workflows right and down.
- Noise that is not the change's: `GET /user/workflow/<wid>` (and B9's `/user/workflow`)
  answers 404 with the app (the Dashboard's fallback page), `GET /api/executions/<wid>/latest`
  403 for a workflow never run, `/api/agents` 503 and `/forum/api/*` 405 (not in this
  stack), the shared-editing socket `/rtc/<id>` retried without end and the code editor's
  `ws://localhost:3000/python-language-server` refused (the stack has no server for
  either). A page that opens on a run already going (B7's reload, B8's tab) logs one
  error when the run ends, `TypeError: Cannot read properties of undefined (reading
  'attr')`: the editor colours a region on a `RegionStateEvent`, and such a page was
  never sent the run's regions (`getRegionStateStream` in upstream's
  `workflow-editor.component.ts`; in every B7 and B8 since step2b).

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
`port-forward start|stop|status`, `collect-logs <dir>`, `follow-units <dir>`,
`post-run <report>` (see `run-k8s.sh` below), and what the driver's stack control asks
for, each printing one JSON document: `unit-kill <cuid>`, `unit-stop <cuid>`,
`unit-env <cuid>` and `pg-activity` (see "The stack's control").

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

- `--evidence`, `--negative-control`, a step-2 `--gate` and `--legacy-env`. They read the
  single-node Postgres log and `docker exec` into its fixed container names, which on
  this machine belong to another run's stack. A step-3 gate is accepted: it selects
  what this mode runs (`--gate 3A`: a-e, u, p; `--gate 3B`: a-e, u, p, q, s, w; `--gate 3C`:
  a-e, u, p, q, s, v, w), without that evidence.
- Scenario g0, which uses the legacy environment endpoints of the single-node unit.
- l4, which creates a local unit at `--unit-uri`.
- On `create-ws`, the scenarios that need the second user (j, l2, l3, l5, l7, l10): the
  driver gives that user a local unit. j on `ws` runs.

What g, h and o run where the unit runs (the tabulate precondition, the environment files, the
unit's own `/run` endpoint) runs in the unit's pod: `kubectl exec` into the engine's container of
the pod labelled `type=computing-unit,cuid=<cuid>` in the units' namespace
(`k8s_unit.exec_prefix`).

The step-3 scenarios read the lake's catalog from the webserver's pod (`kubectl exec
deploy/texera-webserver -- curl`, against the `STORAGE_ICEBERG_CATALOG_REST_URI` that pod
itself is configured with), and their waits follow the manifest's
`options.record_timing`: deploy with `--fast-record`, which puts the timers into
`texeraEnvVars`. `up` refuses a chart whose rendered webserver does not get its timers, or
whose managing service does not get the unit's to forward.

q and s take the unit down through `k8s_unit.KubernetesControl` ("The stack's control"
above): `stack/k8s-stack.sh unit-kill <cuid>` deletes the unit's pod at once
(`--grace-period=0 --force`), `unit-stop <cuid>` with its grace period, so the engine gets
SIGTERM and records its runs' endings. The unit that "comes back" is a new one, created as
the first was; the scenarios after it use it, and every unit the run made is terminated at
the end (`setup.kubernetes_unit.later_units` holds their terminations). q's first two passes
never list the units, so the manager does not notice the pod is gone and the execution is
closed by its beat; its third pass lists them once after the kill, as the workspace does when
its socket drops, and the verdict must come within two closing intervals. Until gate 3C the
gateway sends a statistics request to the unit, so while a unit is down q counts the
statistics table's rows in the catalog instead of asking the route.

At gate 3C this mode shows that the unit has no Postgres in three ways (the design's H6):

- After the setup and after the last scenario the driver asks `stack/k8s-stack.sh
  pg-activity` and `unit-env <cuid>`: Postgres holds no connection named
  `texera-computing-unit` and none from the unit pod's address, and the unit's engine
  container was given no `STORAGE_JDBC_*` setting. Both go into the report's
  `unit_without_postgres`; a failure, or a stack that cannot be asked, fails the run.
- Scenario v marks its statistics and its export request (`sce-probe`), and `post-run`
  looks the marks up in Envoy's access log: a request whose `route_name` names the
  HTTPRoute `texera-dynamic-routes` was sent to a computing unit and fails the run; an
  entry that is not found is a warning (`post_run.stored_reads`).

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
6. At the end it calls `DELETE /api/computing-unit/{cuid}/terminate` for every unit it
   made, also from an atexit hook if the driver dies; `--keep-unit` keeps the one in use.

The report gains `target` and `setup.kubernetes_unit`: the request, the status history,
the seconds to Running and to answering, the gateway probe, the refusal probes
(`gateway_refusals`) and the termination.

### `run-k8s.sh`

```
./run-k8s.sh --lock <dir> | --no-lock  [--images <registry>/<tag>] [--source <worktree>] [--port N]
             [--keep] [--label text] [--time-limit MIN] [--no-workarounds] [--forward relay|kubectl]
             [--allow-crd-drift] [--fast-record] [-- <driver args>]
```

The run goes like this:

1. Takes the lock and starts the clock.
2. Runs `down`, then `up`, and starts following the unit pods' logs.
3. Runs the driver with `--target k8s`.
4. Runs `stack/k8s-stack.sh post-run <report>`. This waits up to 90 s for the unit's pod
   to go and reads Envoy's entries for the driver's refusal probes and for the requests
   scenario v marked. It writes the outcome into the report as `post_run`, and into the
   logs directory as `post-run.json`:
   - A unit pod left behind fails the run (`summary.result` becomes FAIL, with
     `summary.post_run_failures`), unless the driver ran with `--keep-unit`.
   - So does a probe that ext-authz did not refuse.
   - So does a request for stored output that Envoy sent to a computing unit (gate 3C).
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

Refused up front, as in Kubernetes mode: `--evidence`, `--negative-control`, a step-2
`--gate` and `--legacy-env` (they read the single-node Postgres log and `docker exec` into its
containers; a step-3 gate selects what this mode runs, without that evidence),
scenario g0 (the legacy environment endpoints of the single-node unit), and `--unit-kind
kubernetes`. `DOCKER_HOST` points at a socket that does not exist, so nothing the driver runs in
this mode can reach a container. What g, h and o run where the unit runs (the tabulate
precondition, the environment files, the unit's own `/run` endpoint) runs on this host, where the
unit is a process: with the engine's Python first on `PATH`, so `python3` is the interpreter the
unit starts its workers with (`localdev_unit.exec_prefix`).

The step-3 scenarios read the lake's catalog with `curl` on this host (the stack publishes
Lakekeeper on 18181, and the manifest's `service_env` names it), and their waits follow the
manifest's `options.record_timing`: start the stack with `--fast-record`, which exports the
unit's timer before the unit's JVM starts and the Dashboard's before `texera-web` starts.

q and s take the unit down through `localdev_unit.LocalDevControl` ("The stack's control"
above): `stack/localdev-stack.sh unit-kill` sends SIGKILL to the process group of the unit's
JVM, which holds its Python workers; `unit-stop` sends SIGTERM to the JVM alone, as `docker
stop` signals a container's main process, waits 20 s for it and kills what is left of the
group; `unit-start` runs the unit's launcher again with the environment `up` gave it (the
`--fast-record` export included), in the same working directory and log, waits until it is
ready, and records its new pid, so `post-run` and `down` find it. The driver then waits
until the unit answers a workflow socket through the dev server's proxy.

At gate 3C (`--gate 3C`: a-e, u, p, q, s, v, w) the driver asks `stack/localdev-stack.sh
pg-activity` after the setup and after the last scenario: no connection may be named
`texera-computing-unit` (the report's `unit_without_postgres`). Every JVM of this stack
reaches Postgres from 127.0.0.1 and is handed the same environment, so here the name is
the only thing that tells the unit's connections apart.

### `run-localdev.sh`

```
./run-localdev.sh --lock <dir> | --no-lock  [--source <worktree>] [--reset] [--keep] [--label text]
                  [--time-limit MIN] [--python PY] [--heap NAME=SIZE ...] [--strict-schema]
                  [--allow-stale-dists] [--fast-record] [-- <driver args>]
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
