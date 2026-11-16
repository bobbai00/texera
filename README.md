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
```

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
| `driver/` | The e2e driver: `e2e.py` (CLI), `transport.py` (start, watch and control a run), `texera_api.py` (REST setup), `workflow.py` (plan builders), `scenarios.py`, `data/*.csv` |
| `run-baseline.sh` | `up`, then wait until healthy, run the driver, print results, then `down` unless `--keep` |
| `reports/` | JSON reports, one per driver run |

## The stack: `stack/sce-stack.sh`

```
stack/sce-stack.sh [--source <worktree>] up [--images <registry>/<tag>] [--timeout S] [--with-optional] [--bind IP]
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
              [--transport ws] [--timeout 300] [--unit-uri http://workflow-runtime-coordinator-service:8085] [--list]
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

Each scenario then creates its own workflow (stored in UI format, so it can be
opened in the browser), runs it through the transport, and checks the outcome.
The driver prints PASS or FAIL per scenario and writes a JSON report. The report
holds every check with its detail, the state timeline, commands sent, operator
statistics, a console sample, and the persisted execution row. Exit codes:

| Code | Meaning |
|---|---|
| 0 | All selected scenarios passed |
| 1 | A scenario failed |
| 2 | Setup failed |
| 3 | The stack did not come up (`run-baseline.sh` only) |

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

### The transport seam (`driver/transport.py`)

How a run is started, watched and controlled lives only in `transport.py`.
Scenarios call `Transport.start_run(...)`, which returns a `RunHandle`, and use
only these `RunHandle` members:

| Purpose | Members |
|---|---|
| Wait | `wait_for_state`, `wait_until` |
| Control | `pause`, `resume`, `kill`, `ensure_stopped` |
| Observe | `states`, `state_log`, `command_log`, `stats` / `output_rows`, `console`, `fatal_errors`, `results` |
| Report and clean up | `summary`, `close` |

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
(`ensure_stopped`), so the next scenario starts on an idle unit. These paths
were checked against the published images:

| Probe | Outcome |
|---|---|
| A UDF that raises | FAIL in 1.0 s with the traceback; the run was killed (persisted status 5) |
| A scan of a missing dataset file | FAIL in 0.1 s with `FileNotFoundException: Could not read from "/dataset/..."` (status 4) |

Today's transport is `ws`, the browser path on upstream main and on the
published images:

1. Open a websocket through the gateway to
   `/wsapi/workflow-websocket?wid&uid&cuid&access-token`.
2. Send `WorkflowExecuteRequest`, with `computingUnitId` and `warehouseId`.
3. Send `WorkflowPauseRequest`, `WorkflowResumeRequest` or `WorkflowKillRequest`
   to control the run.
4. Read results with `ResultPaginationRequest`, which returns a `PaginatedResultEvent`.
5. Send a heartbeat every 10 s.

To accept a refactor step that moves this, for example "the Dashboard creates
the execution, and the gateway routes start, watch and commands to the unit":
write a new `Transport` subclass, register it in `TRANSPORTS`, and run with
`--transport <name>`. The scenarios and the REST setup stay as they are.

## `run-baseline.sh`

```
./run-baseline.sh [--reset] [--keep] [--images <registry>/<tag>] [--source <worktree>] [--label text] [-- <driver args>]
```

`up` (published images by default), then wait until healthy, then
`status`, then run the driver. The report goes to
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
- **Python exceptions do not end a run.** A Python UDF exception leaves the
  workflow `Running`, with its worker paused, until someone kills it. This is
  upstream behavior in the published images, not something the harness
  introduces. The harness turns it into a fast FAIL, as described under the
  transport seam above.
