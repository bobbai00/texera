# Self-contained Amber engine: handover

State on 2026-11-18. Nothing is merged upstream or opened as a pull request. All of the work is
on branches of the fork `github.com/bobbai00/texera`, which is public (section 2). The handover
of 2026-11-17 as a page: https://claude.ai/artifact/1uo7RCdbfrnUpTVFLzvhwG (private to its owner).

## 1. The goal and where it stands

Amber's computing unit becomes a self-contained engine: it takes a physical plan with every
location resolved, sent with the request to start, reads and writes storage, keeps no execution
metadata and calls no service during a run (apache/texera #5011, #5012, #5013; Linear project P-TEX-22). The work is in steps; the owner
set the scope on 2026-11-17 to end after step 3, and on 2026-11-18 asked for the cleanest design
of that scope, with every runtime command (pause, resume, kill, the debugger, retry) still working.

| Step | What it does | State | Ticket |
|---|---|---|---|
| 0 | Prove the riskiest assumptions (Envoy routing, per-run lake tokens, Iceberg commit cost) | Done | TEX-423 |
| 1 | Run every workflow from its saved physical plan | Done | TEX-424 |
| 2 | The unit reads nothing from Postgres, and calls no service, to start a run | Done: the plan-shape batch is merged and the run compile is in the compiling service | TEX-425 |
| 3 | Run state in the lake; the unit opens no Postgres connection | Built, all parts; verified on single-node only (section 4) | TEX-426 |
| 4 | Only the gateway (Envoy) reaches a unit | Research draft only; not to be built now | TEX-427 |
| 5 | Lock down the unit: per-run credentials, a lake namespace per execution | Later | TEX-428 |
| 6 | Run units on Kubernetes, Slurm and EC2 | Later | TEX-429 |

What is true after step 3:

- The Dashboard service creates an execution (`POST /api/executions`): it authorizes, inserts the
  row, asks the compiling service for the plan, signs the links of the input files, and answers
  the plan without keeping a copy. The client starts the execution on its unit with that plan;
  the unit checks the plan and starts each execution once. A change to a paused operator is
  compiled the same way, against the workflow the editor held, and handed to the unit by the
  client (`docs/step3-notes/changes-since-rev2.md` section 6).
- A unit writes a run's state, statistics and console to tables of the lake, on one thread, and
  beats every 30 s. It opens no connection to Postgres; a stray use of the database on a unit
  fails where it is made.
- The Dashboard service closes each execution once: with the ending its log holds, or as
  "unit lost", "unit terminated" or "never started". A verdict gives way to the log's ending for
  an hour, so a unit that was only cut off from the lake is not lost. The same job sends the
  e-mail and expires results.
- State, log, statistics, console output and exports of an execution are served by the Dashboard
  service from what the execution stored, with the unit up or down. Result pages come from the
  unit's websocket for the run it holds, until the upstream result service takes them (#8995,
  #8996; pull request #9356).
- `workflow_executions` keeps the closing record only; `status`, `result`, `last_update_time`,
  `runtime_stats_uri`, `runtime_stats_size` and the tables `operator_executions` and
  `operator_port_executions` are dropped (`sql/updates/53.sql`, `54.sql`).

## 2. How to get it

```bash
# in any clone of texera
git remote add bobbai00 https://github.com/bobbai00/texera.git   # skip if origin is the fork
git fetch bobbai00 feat/self-contained-engine feat/sce-step2-lane \
  spike/sce-step0-proofs fix/checkpoint-on-source-worker sce-e2e-harness
```

| Branch | Where | Commit | What it holds |
|---|---|---|---|
| `feat/self-contained-engine` | Fork | `852329c0f` | The main branch: everything below. On the Mac it is `claude/amber-engine-cleanup-review-8bf782`, which holds `9abfc1e34` (the plan through the client) on top, not yet pushed |
| `sce-e2e-harness` | Fork | see `git log` | The harness, the designs and reviews under `docs/`, and this file |
| `feat/sce-step2-lane` | Fork | `c5511fab0` | The plan-shape batch, merged into the main branch |
| `spike/sce-step0-proofs` | Fork | `ff4729363` | Step 0's proof scripts and results (`proofs/step0/*/RESULTS.md`) |
| `fix/checkpoint-on-source-worker` | Fork | `57c64e921` | An upstream bug fix found on the way; rebase on upstream main before proposing it |

## 3. What 2026-11-18 added to the main branch

85 commits over `3d84565a5`, 132 over upstream main `fddc4303e`, which is merged in, up to
`852329c0f`; then `9abfc1e34`, the plan through the client (section 1 and
`docs/step3-notes/changes-since-rev2.md` section 6). The final tree is `9abfc1e34`.

| Group | What it does |
|---|---|
| The plan-shape batch, merged | Every output port carries its storage location in the plan; what an operator reads from outside the run is `PhysicalOp.inputs`; a compile is for editing or for a run |
| The rest of that batch | A compile fails when the site's settings cannot be read; a paused operator's change is bound with a repository resolver only; the compiler is out of the engine's packages; a run's Python workers are told where its environments are installed |
| The run compile, moved | The compiling service makes the plan of a run and of a change to a paused operator (`POST /api/compile/run`, `/api/compile/update`); the Dashboard service asks it |
| Step 3, the record | Statistics and console stored on a timer with the beat; an ending is written until it lands; the catalog calls have timeouts; a failed append leaves no file behind |
| Step 3, closing | The closing record (`53.sql`); the closing job with its verdicts; `GET /api/executions/{eid}/state`, `/log`, `/console`; the lists, the quota and the unit manager's idle sweep read the closing record; the e-mail is sent by the Dashboard service |
| Step 3, serving and expiry | Statistics and exports by execution, from the Dashboard service; results expire when a later run replaces them and by age, at the Dashboard service; the unit cleans nothing up |
| Step 3, no Postgres | The unit opens no pool (`SqlServer.withoutDatabase`); the run-state columns and tables are dropped (`54.sql`); a unit created in Kubernetes gets no database login |
| Step 3, the frontend | The page follows an execution its unit no longer shows by asking the Dashboard service every 5 s; the history and the admin's list show how a run ended and why |
| Step 3, the benchmark | `ExecutionRecordBench`, run by `bench/record-bench.sh` of the harness |
| Upstream | Merge of upstream main `fddc4303e` (12 commits). Its new Parquet source is changed to read the link its plan carries |
| Names and comments | `ExecutionWarehouse` for `ExecutionResources`; the agent service's request and response types named as the server's; each design rule said once, in the type that owns it, and member docs kept to what the code does not say (comments only, checked file by file) |

Fixes made on the way, each its own commit:

- A unit starts only an execution that was created for it (`TEXERA_CU_ID`), and an agent's
  synchronous run counts as a watcher of its run.
- A command a run cannot take (a retry, a pause of a run that ended, a checkpoint without replay
  logs, a skip) is answered to its sender as refused; it no longer fails the run. Retry works
  again: the unit's handler had been empty since upstream #2950.
- A pause, resume or retry that the engine fails leaves the run as it was, not between two states.
- pyamber: a retry processes the tuple the UDF raised on, not `None`, and forgets the exception it
  stopped on; a UDF's load error is reported on Python 3.10 too (`add_note` is 3.11).
- A verdict of the Dashboard service is replaced by the ending the log shows later
  (`outcome_from_log`, `execution-closing.revise-verdict-for-seconds`), and such an execution
  keeps its results for that long, however short results are kept.
- An append to a record table writes its own manifest, so nothing of it runs on Iceberg's shared
  worker pool, which takes no work while the JVM exits: a unit that is stopped can record
  "the computing unit was stopped". No table is tidied then, so an expiry cannot leave files
  behind that it failed to delete.
- The admin's list shows an execution's time used in whole seconds; with the end recorded to the
  millisecond it showed fractions with floating-point noise.

## 4. Verified

On the Mac. The final tree is `9abfc1e34` (the plan through the client, over `852329c0f`); a row
that names another commit was run there.

| Check | Result |
|---|---|
| Scala suites (`tools/suite.sh`) | No failure at `9abfc1e34`: config 113, DAO 70, core 1,246, operators 3,113, compiler 232, compiling service 121, access control 84, unit manager 329, config service 44, file service 481, engine unit 2,990, engine integration 46. Not run here: the R UDF case (no R) and `IcebergRestCatalogIntegrationSpec` (no REST catalog on :8181). Run with `LITELLM_BASE_URL` at a closed port: another stack's LiteLLM holds the default :4000, which `LiteLLMProxyAuthSpec` expects to refuse |
| Frontend | 255 files, 7,382 tests; format clean; build OK (at `9abfc1e34`) |
| Agent service | 381 tests; type check and format clean (at `9abfc1e34`) |
| Gate 3C at `9abfc1e34`, unit on a network without Postgres (images `sce/sceB`) | 33 of 33 scenarios (l9 is gone with the plan row); no statement from the unit to Postgres in the whole run; all 38 executions closed (`reports/baseline-20261119T062248Z.json`) |
| Browser smoke at `9abfc1e34` | 9 of 9 (`reports/browser-smoke-20261119T063053Z`), among them a change to a paused operator in the editor (B4), after the page was loaded again (B7) and from a second tab (B8) |
| By hand at `9abfc1e34` (the desktop app's browser pane, the same stack) | A UDF that raises on rows 7 and 20: Pause, Unlock for Logic Change, the code fixed, Confirm Change, Retry Tuple; then the same again for row 20, after the run had resumed. Both changes answered `{operatorId, update}` (201); the execution closed Completed from its log (`READY, RUNNING, PAUSED, RUNNING, PAUSED, RUNNING, COMPLETED`); the export shows rows 1-6 from the first code, 7-19 from the first change and 20-30 from the second |
| Single-node, unit on a network of its own, gate 3C | At `9d6d05bf4`: 33 of 34 scenarios, and no statement from the unit to Postgres in the whole run; scenario v failed on the harness's own wait for a stopped unit, since fixed (`reports/baseline-20261118T162125Z.json`) |
| The same with the unit on a network without Postgres | At `852329c0f`, the final tree: 34 of 34 scenarios; no statement from the unit to Postgres in the whole run; every execution closed; no failed deletion in the unit's log when it was stopped (`reports/baseline-20261118T182606Z.json`) |
| Scenarios x (debugger), z (fix and retry), q2 (cut off and back) | Pass, in both gate runs and the rerun |
| Browser smoke | 9 of 9 in one run on the final images (`852329c0f`, `reports/browser-smoke-20261118T183434Z`). At `9d6d05bf4` B9 had failed once because headless Chromium dropped a request with `net::ERR_NETWORK_IO_SUSPENDED` before it left the machine, and passed when run again |
| By hand in a real browser (the desktop app's browser pane, the same stack) | The Python debugger: a breakpoint set by clicking the code editor's gutter during a run, the worker stopping on it with the line highlighted, `p` of two values answered, Step, the breakpoint cleared, Continue, the run completed. A UDF that raises on row 7: the error in the console, Pause, Unlock for Logic Change, the code fixed in the editor, Confirm Change, Retry Tuple, the run completed with rows 1-6 of the old code and rows 7-300 of the new. Pause and Resume. The unit stopped under a run: the page shows the error "the computing unit was stopped" from the Dashboard service, which closed the execution from its log 25 s after the stop; the admin's list shows it FAILED with that reason. A Python environment created and listed on its page |
| Day-long benchmark | All eight checks pass on the REST lake at `9d6d05bf4` (2,880 ticks of 10 operators, 49 changes of state; `bench/reports/record-bench-20261118T174041Z`): the state reads in 6.1 ms at p95; all 28,800 statistics rows in 38 ms after the end tidy, and in 352 ms at the median (602 ms at worst) right before a tidy; the log in 16 ms and 1,000 console rows in 14 ms after the end tidy; a statistics commit took 51 ms at the median in the first 250 ticks and 70 ms in the last 250 (within the 1.5 times allowed); every read returned every row in order; one data file and one snapshot per table at the end. The short run also passes on the Postgres catalog. During the run the whole log reads more slowly as it grows (up to about 0.3 s at 30 rows, one file per change of state until the end tidy); the frontend reads only the state |

Gate 3C was not run again in full after the harness fix: scenario v was rerun with q2, on the
stricter stack (the unit without Postgres).

Not run on the Mac, and so not verified for step 3:

- Kubernetes mode and local-dev mode of the harness. The Mac's Kubernetes cluster and host ports
  hold other stacks that must not be disturbed: Kubernetes mode installs cluster-wide resources,
  and local-dev mode needs the default ports. Both passed at `3d84565a5` on the first machine.
  What changed for Kubernetes since: the gateway no longer routes statistics and export to a
  unit, the unit manager forwards no database login, upload endpoint or LakeFS endpoint, and the
  chart sets the compiling service's endpoint for the Dashboard service.
- `sql/updates/53.sql` and `54.sql` were applied by their specs on an embedded Postgres, not by
  liquibase against a database of a running deployment.
- The negative controls of step 3, and scenario y (the day-long run through the product). Step
  3's control drives step 2's images, whose create answers where the plan is stored: run it
  from the harness at `5d9ce19a6`, before the plan went through the client (README, "Negative
  control").

## 5. What a unit still reaches, and what is left for later steps

A unit reaches the lake's catalog and the object store. Beyond them, as the design lists for
step 5:

- access-control-service, when a plan's UDF reads a dataset or a model and the mounter is on
  (Kubernetes): the unit asks for the mount with its owner's token.
- The file service, when a Python UDF's own code opens a `DatasetFileDocument`.
- The package index, when a plan names a Python environment; a telemetry collector, when one is
  configured; whatever a source operator is pointed at.

Also left:

- Presigned links of input files and the passwords of SQL sources are in the plan, which the
  browser holds and sends to the unit, and a changed copy of a plan is not detected. A ticket the
  Dashboard signs per execution (execution, unit, the plan's hash, expiry) and per-run
  credentials are step 5.
- Result pages of an execution whose unit no longer holds it are not served until the upstream
  result service is in (#9356). Its lookup reads `operator_port_executions` and
  `workflow_executions.status`, which this branch drops: whichever lands second re-bases that
  lookup on the tables' names (`ExecutionTables.portTables`) and the closing record.
- A unit checks the plan it is sent, but no longer who created the execution or that it was
  created for this unit: both were columns of the plan row. A user with WRITE on a unit who holds
  another user's plan can start it, writing into that execution's tables (never into another
  user's warehouse, which the unit still refuses), and a plan sent to another unit runs there
  (harness scenario l9 went with it). The signed ticket of step 5 names both; carrying the
  creator and the unit in the plan, unsigned, would bring the two checks back now. The owner's
  call.
- With no plan kept, the Dashboard service finds an execution's result and state tables by their
  names, listing the whole result and state namespaces of its warehouse each time it measures,
  exports or expires the execution. Not measured on a catalog with many tables.
- A table of the lake per execution (log, statistics, console, and two per output port) is many
  small tables for the catalog. Measured: section 4's benchmark.
- When a unit is gone, the page shows the run's end and its reason from the Dashboard service, but
  each operator's box keeps the last state its unit reported (Running, say): an operator has no
  state for "ended without finishing". Upstream shows the same after a kill. Choosing what the box
  should say is a UI decision for the owner.

## 6. Before a pull request

1. Run step 3's gates in Kubernetes and local-dev mode on a machine where they can run, and the
   negative controls once.
2. Regroup the history into pull requests. Upstream merges by squash, so the pull request's text
   becomes the commit message; the branch's own messages need no rewrite.

A split, for the owner to decide:

| PR | Contents |
|---|---|
| 1 | Run every workflow from its plan's text: step 1, the plan's format |
| 2 | Create at the Dashboard service, start with the plan the create answered, nothing read on the unit to start: the rest of step 2, with the run compile in the compiling service |
| 3 | Record and close executions from the lake: step 3 up to the frontend |
| 4 | Take Postgres off the unit: stored output by execution, expiry at the Dashboard service, no pool, the dropped columns |

The fixes of section 3 that are upstream's own bugs can go first, each as a small pull request:
the Retry handler, the two pyamber retry fixes, `add_note` on Python 3.10, a command that fails
its run, and `fix/checkpoint-on-source-worker`.

## 7. Decisions

Made by the owner:
- Postgres is removed from the unit completely, with no backward compatibility.
- Amber is a pure engine: a plan with resolved locations in; storage reads and writes; no
  execution metadata; no service calls during a run.
- Only the gateway reaches a unit; the Dashboard service does not call units; no relay service for
  live state.
- Units are not tied to Kubernetes (Slurm and EC2 later).
- An execution's state lives in one place; data and metadata stay clearly apart.
- A namespace per execution comes only in step 5.
- 2026-11-17: resolved locations go in the plan's operator block, at port level.
- 2026-11-17: where a review offers a cheaper and a cleaner way, take the cleaner one; the run
  compile moves into the compiling service.
- 2026-11-17: stop after step 3.
- 2026-11-18: the cleanest design of that scope; fix what is found on the way; the runtime
  commands between the frontend and the engine keep working; review upstream #9356 against it.
- 2026-11-18, evening: no plan in the lake. The Dashboard service answers the plan and the client
  sends it to the engine; the Dashboard keeps no copy; a change to a paused operator is compiled
  against the workflow the editor held when the operator was unlocked for it. Making the plan
  proof against a changed copy comes later, "but not now".

Open for the owner:
- Whether to post the review of #9356 (drafted: approve, with five notes that do not block).
- Step 3's six choices, built to the recommendations (`docs/step3-design.md` section 11).
- Whether a scan's descriptor should also stop holding the resolved file name.
- Whether to propose steps 1-2 upstream before the rest. Upstream moves about ten commits a day.
- Whether to file the upstream bugs below as issues.
- When step 4 resumes: its four questions in `docs/step4-design.md` section 4.

## 8. Upstream bugs found on the way (not caused by this branch)

- `PartitionRule.FirstInput` follows hash-map order, not port order.
- `RUDFOpDesc`'s setter chain is wrong for more than one worker.
- Checkpoints: a source worker read its channel's port before the alignment type (fixed on
  `fix/checkpoint-on-source-worker`); pyamber has no `PrepareCheckpoint` handler; JVM workers fail
  to serialize `OutputManager.outputPortResultWriterThreads` (since #3295). Replay end to end stays
  unverified.
- The unit's Retry handler was empty (since #2950); pyamber retried `None` and kept the exception;
  `add_note` on Python 3.10 (#8768). Fixed on the main branch.
- A websocket command whose handler throws failed the whole run. Fixed on the main branch.
- Iceberg writes an append's manifest on its shared worker pool whatever executor the append
  names, and that pool refuses work during JVM shutdown.
- `AsterixDBConnUtilSpec` and `AsterixDBSourceOpExecSpec` share a global map, so one of them can
  fail when the whole operator suite runs. Not fixed.
- Helm chart: `Chart.lock` lists minio where `Chart.yaml` lists rustfs, so `helm dependency build`
  fails; Envoy Gateway is always installed; GatewayClass `eg` hangs in Terminating after an
  uninstall; the release must be named `texera`; the pylsp image is amd64 only.
- access-control-service logs every request's headers and token at INFO, and has no PATCH handler
  (Jupyter's rename).
- The editor: a killed operator's box still says Running; the result table stays on page 2 after a
  re-run; a page opened during a run logs a `TypeError` from region colouring when the run ends.
- scalapb-json4s is on two versions (0.12.0 and 0.12.2).

## 9. Running things

`tools/README.md` has the Postgres and Python set-up and every script. In short:

```bash
tools/suite.sh <worktree> <tag> [catalog-db]     # every Scala suite, about 20 minutes
tools/frontend-check.sh <worktree> <tag>         # frontend tests, format, build
(cd agent-service && bun test && bun run typecheck)
images/build.sh --frontend --base apache:1.3.0-incubating-rc2 <worktree> <tag>
./run-baseline.sh --reset --images sce/<tag> --source <worktree> \
  --pg-statement-log --isolate-unit --fast-record -- --gate 3C
bench/record-bench.sh <worktree> --env <file that exports STORAGE_JDBC_URL> [--quick]
```

On a machine whose ports 5432, 8080 and 9000 are taken, set `SCE_PG_PORT`, `SCE_TEXERA_PORT`,
`SCE_RUSTFS_PORT` and `SCE_BASE` first; the stack is the Compose project `sce`, and the
benchmark's lake the project `sce-bench`.

Things that cost time on 2026-11-18:

- The build generates jOOQ classes from the Postgres that `STORAGE_JDBC_URL` names. Point it at
  a database of the branch's own schema, and apply `sql/texera_ddl.sql` again after the schema
  changes (with `-v DB_NAME=<db>`; without it the script makes `texera_db` anew).
- Run each sbt module's tests in its own sbt process, as `tools/suite.sh` does.
- After a merge that changes a Java constant used in a Scala annotation, clean the operator
  module before testing.
- The unit image is Python 3.10; the local test interpreter should be 3.12 with
  `amber/requirements.txt`, `operator-requirements.txt` and `dev-requirements.txt`.

The harness's `README.md` describes every mode, scenario, check and gate. New on 2026-11-18:
scenarios x (the Python debugger), z (a UDF raises, its code is fixed, the tuple is retried) and
q2 (the unit is cut off from the lake and comes back); the timer `revise_verdict_for_s`; the
port overrides; `bench/`.

## 10. Where the documents are

| Path (on `sce-e2e-harness`) | What |
|---|---|
| `docs/step2-design.md`, `docs/step2-critique.md` | Step 2's design and its critique |
| `docs/step3-design.md` | Step 3's design, revision 2 |
| `docs/step3-notes/changes-since-rev2.md` | What changed since; wins over the design |
| `docs/step3-notes/*-report.md` | Reports of step 3's parts 2-4 and 5, and of its harness |
| `docs/step4-design.md` | Step 4 research notes; not a design |
| `docs/review-step2/` | The two reviews, the decision on every finding (`triage.md`), the browser findings, and the reports of the fix batches |
| `docs/map/`, `docs/probes/` | A code map of upstream main (2026-11-14); the Lakekeeper probes behind step 3's design |
| `tools/`, `bench/` | The scripts that ran the suites, the gates and the benchmark |

What 2026-11-18 changed against the step 3 design, in one place:

- No plan in the lake: the plan goes from the Dashboard service through the client to the unit
  (`docs/step3-notes/changes-since-rev2.md` section 6). The design's plan table, its `started`
  tag and the unit's reads of it are gone.
- A verdict is not final: it gives way to the log's ending for
  `execution-closing.revise-verdict-for-seconds`, and the recorder writes an ending until it
  lands. The design had the verdict stand.
- A unit knows its own id and refuses an execution created for another unit.
- The Dashboard service asks the compiling service for the plan; the design compiled in the
  Dashboard service.
- A unit that is stopped does not finish its last tidy: it merges no files while the JVM exits.

Earlier design pages: "Amber Engine Design" (`https://claude.ai/artifact/GEJYPLLbqxit6WBt2ko7Wt`)
and "Amber Engine Plan" (`https://claude.ai/artifact/HWHk9yddF2Hb1fVtGLjeRQ`).

## 11. The machines

The first machine (2026-11-17):
- The owner's `texera-single-node` stack is stopped: `docker compose -p texera-single-node start`.
- Worktrees under `~/Desktop/projects/texera-worktrees`; test images `sce/texera-*:step2x` and
  `sce/texera-*:step3p5`; Docker volumes `sce_*` and `e2e-localdev_*`; the test Postgres container
  `texera-tripwire-pg` on 127.0.0.1:5432.

The Mac (2026-11-18):
- The main branch is the session worktree `texera/.claude/worktrees/texera-upgrade-pr-e1b94a`.
- Left running: the Compose project `sce` (http://localhost:38080) and the build's Postgres
  container `sce-build-pg` on 127.0.0.1:35432. Both are this work's own; stop them with
  `./sce-stack.sh down` and `docker rm -f sce-build-pg`.
- Test images `sce/texera-*:sce1` to the newest; volumes `sce_*`.
- No other stack on the Mac was touched.
