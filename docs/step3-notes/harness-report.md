All five commits are on branch `step3` in `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e-step3`; nothing is pushed, the worktree is clean, and no stack, container or build was started. Everything is tested offline only (338 tests pass); no gate has run on a real stack.

**Commits**
- `0ce4c57` gate 3A: p, Check I, `--fast-record`, `--gate 3A` (166 tests)
- `4139bc9` gate 3B: q, r, s, t, w, Check K, the stack's control, `--gate 3B` (250)
- `b2edc22` gate 3C: v, Checks G, H, J, `--unit-no-postgres`, `run-negative-control.sh --step 3`, `--gate 3C` (310)
- `0f4e4c3` step 3 follows `docs/step3-notes/changes-since-rev2.md` (325)
- `0a3d3f4` `driver: follow the product after the step 2 review fixes` (338)

**Things you should know first**
- **Expiry rule, my reading.** I read `changes-since-rev2.md` section 4 as: the closing job's expiry drops an ended execution's results once a later execution of the workflow on the unit has started, and a create alone drops nothing. t now runs three executions on that reading. If the product instead applies the rule at a create, t fails on its first half; the deadline is `replaced_verdict_s` in `driver/record_timing.py`.
- **Bug fixed in my 3B work.** Stack scripts run by the control inherited the driver's `DOCKER_HOST` guard, so local-dev's `pg-activity` would have failed on a real stack. They now run without it (`stack_script_env` in `driver/stack_control.py`).
- **README outside step 3.** The last commit edits the step-2 gates note, scenario rows d, j, k, l5-l10, l8, o, h, the transport section, the final-check sentence, the test list and the fake's description. These may meet your edits at merge.
- **Gate A no longer applies** to the new images (no `WorkflowExecuteRequest`); B and C apply without g0 and `--legacy-env`; D applies as it stands.
- **Stricter than you asked.** Refused starts now compare the unit's whole sentence, not a substring, and d sends a kill naming another execution that must be refused.
- **`export_dataset` (H1) was not built**: no scenario calls it.

**Commands per gate**
- Single-node, 3A and 3B: `./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --isolate-unit --fast-record -- --gate 3A` (or `3B`)
- Single-node, 3C, two runs: the same with `--gate 3C`, then once more adding `--unit-no-postgres`; then `./run-negative-control.sh --step 3 --images sce/<step 2's last tag>`
- Kubernetes: `./run-k8s.sh --lock <dir> --images sce/<tag> --source <worktree> --fast-record -- --gate 3A|3B|3C`
- Local-dev: `./run-localdev.sh --lock <dir> --reset --fast-record -- --gate 3A|3B|3C`
- Runnable: 3A is gate D plus p with Check I; 3B adds q, r, s, t, w and Check K; 3C adds v and G, H, J and retires A and B. Kubernetes and local-dev run a-e, u, p (3A), plus q, s, w (3B), plus v (3C), with no statement-log evidence.

**Assumptions about the product, and where each lives**

In `driver/lake.py`:
- Lake namespaces and table names: `EXECUTION_TABLES`, `PORT_TABLES`
- The label's six properties: `LABEL_*`
- Snapshot summary totals from Lakekeeper: `_table_state`

In `driver/texera_api.py`:
- Statistics route fields, time in epoch ms: `StatisticsRow.of`
- `/state` shape: `ExecutionState.of`
- `/log` shape; a row with no `kind` is a state change: `LogEntry.of`, `ExecutionLog.of`
- History `reason`, and `completionTime` never null: `history_reason`, `history_completion_ms`
- Admin list's field is named `reason`: `AdminExecution.of`
- Quota `[{eid, storedBytes}]`: `TexeraApi.quota_sizes`
- Words of the reasons: `REASON_*`
- Console route shape: `ConsolePage.of`, `execution_console`
- Export by `executionId`, local form with `request` and `token`: `export_request`, `export_local`

In `driver/evidence.py`:
- Logged states by socket name: `LOGGED_STATES`
- The log holds state changes only, and they equal what the socket was told: `logged_states`, `_log_problems`
- Closing columns `outcome`, `outcome_reason`, `ended_at`: `CLOSING_RECORDS`
- Postgres host comes from `STORAGE_JDBC_URL`: `JDBC_URL_ENV`, `DEFAULT_POSTGRES_HOST` (also `postgres_host` in `stack/sce_stack.py`)

In `driver/scenarios.py`:
- An unstarted execution still reads 6 once status comes from the label: `STATUS_CREATED` (r)
- `stored_bytes` after expiry equals plan + log + statistics exactly, and the 410 names "execution N" and "expired": `_check_expired`
- CSV export has its header first: `_export_rows`
- A UDF that raises at load fails the run with its message: `udf_raises_on_load`
- The unit's refusal sentences, read in the product's code: `REFUSED_*`
- r assumes a start after "never started" is refused "Execution N was already started."

Elsewhere:
- Timer settings and `--fast-record` values: `TIMERS`, `FAST_RECORD` in `lib/record_env.py`; defaults and all deadlines in `driver/record_timing.py`
- The unit's connection name: `UNIT_APP` in `lib/pg_activity.py`
- Kubernetes forwards the commit interval to unit pods (not yet, per the parts 2-4 report): `record_options`, `missing_record_env` in `stack/k8s/k8s_stack.py`
- Envoy's `route_name` names `texera-dynamic-routes` for unit routes: `UNIT_ROUTE`, `judge_stored_read` in `stack/k8s/k8s_stack.py`
- A Kubernetes unit's login is `STORAGE_JDBC_*`: `_unit_without_postgres` in `driver/e2e.py`
- The old unit's log when Postgres is missing: `POSTGRES_FAILURE_MARKS` in `stack/sce_stack.py`

**Design gaps and how I settled them**
- Gate 3A still needs `--isolate-unit` (Check D gates); the design's command omits it.
- `--scenario all` stays step 2's set; step-3 scenarios run when named or by gate.
- "seq rises by one" cannot be read from the catalog: at 3A row count against the label's seq; from 3B the `/log` rows, also compared with the socket's states.
- History `reason` appears only once closed: s and w wait for the closing record; j waits for closure before its 409.
- Check K has two deadlines: started runs, and rows left unstarted on purpose (must close "never started").
- q: a lower bound on the verdict, `completionTime` equals the last beat, and stored output is read back right after the kill, because results expire by age from the last beat.
- w's failing UDF raises at load; a raise in `process_tuple` only pauses the worker.
- Gate 3C needs two single-node runs: G and H say something only with Postgres beside the unit, J only without. The driver reads which from the manifest.
- v against the 20 s TTL: e first, a last, TTL-bound reads first; the README suggests `--dashboard-env RESULT_CLEANUP_TTL_IN_SECONDS=60` for a slow stop.
- G counts every unit statement; its whole-run part counts from the container's start time.
- No Check K in Kubernetes or local-dev (H6 lists none).
- After revision 2: the log's `output` rows and their switch are removed; r and refused starts expect status 6; t follows the new expiry rule.

**Only a real stack can validate**
- Every gate as a whole, and gate D again on the images with the review fixes.
- Killing, stopping and starting the unit in each mode, with nginx and open sockets; `pg_stat_activity` in each mode.
- Checks A-F across a unit restart.
- How long a polite stop takes (v), and t's replacement landing under the TTL (worst case 16 s of 20).
- Docker's `StartedAt` against its log stamps (G).
- Envoy's `route_name` for static routes.
- The old unit's log without Postgres.
- Every response shape and wording listed above.

What the review fixes changed that no scenario checks yet is listed in the last commit's message and in the README, at `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e-step3/README.md`.