# Step 2 design (TEX-425): critique

Reviewed `step2-design.md` (893 lines) against:

- the worktree at `a6c8f202d`, plus 1d's uncommitted files there (`storedplan.proto`, `PhysicalPlanCodec.scala`, the `WorkflowCompilerSpec` diff), read only;
- the harness at `sce-e2e`;
- the earlier `cu-dashboard-dispatch` worktree, for the commits the design cites (`05a5ba888`, `5eb38a191`, `PostgresUseRecorder`).

Paths below are relative to the worktree unless they say otherwise.

## Verdict

**The corrections hold.** All sixteen corrections (C1–C16) check out in the code. C1 (no namespace per execution until step 5) also matches the agreed plan page: version 2 moved that namespace to step 5.

**The shape is sound:** create at the Dashboard, plan in the lake, start by eid over the socket, inputs as links, environments carried in the plan.

**Nine problems need fixing before implementation.** The most serious:

- The paused-operator update cannot be encoded with 1d's codec.
- An environment install breaks whenever the engine's interpreter is itself a venv, which is the normal case in local-dev. I reproduced this.
- From the first PR that runs a decoded plan until PR D, Python environments silently fall back to the default interpreter.
- The harness's start-window check races with the run's own reads.
- A second start of the same eid is not refused.

One suspicion turned out to be wrong: READY is sent to the browser as "Initializing" (`Utils.scala:121`). So §6's "stays in Initializing while it installs" is correct.

## What checks out

| Claim | Verified at |
|---|---|
| C1: per-execution namespace is step 5; today's four namespaces are chosen by type | `DocumentFactory.scala:43-53`, `storage.conf:51-62`; plan page v2 (memory note) |
| C2: warehouse name only from Postgres | `WorkflowService.scala:91-121` |
| C3: socket cuid and user | `WorkflowWebsocketResource.scala:54-55, 81-84` |
| C4: Strict throws its first error | `WorkflowCompiler.scala:428-433, 453-455` |
| C5: LakeFS presigns for the browser endpoint; file-service is the same call; no S3 presigner; no STORAGE_S3_* on the K8s webserver | `docker-compose.yml:104`, `values.yaml:163`, `ResourceUploadService.scala:344`, `LakeFSFileDocument.scala:105-133`, `webserver-deployment.yaml:44-80` |
| C6: SELECT before every state UPDATE; stats-URI subselect | `ExecutionsMetadataPersistService.scala:101-113`, `WorkflowExecutionsResource.scala:280-297` |
| C7: only K8s units get USER_JWT_TOKEN | `ComputingUnitManagingResource.scala:778-781` |
| C8, C9, C10, C13, C14, C15, C16 | `TexeraWebApplication.scala:100`; `WorkflowCompiler.scala:277-296`; `LogicalOp.scala:500-509`; `ComputingUnitAccess.scala:34-55`; `SyncExecutionResource.scala:207-221, 886-931`; `WorkflowWebsocketResource.scala:114-127`; `WorkerConfig.scala:38`, `ScheduleGenerator.scala:73`, `CostBasedScheduleGenerator.scala:344-351` |
| Links signed for `<release>-rustfs-svc:9000` work from the pool namespace | ExternalName alias, `external-names.yaml:78-86`; `texera.s3.endpoint`, `_helpers.tpl:31-37` |
| Warehouse delete drops every namespace, so a new `execution-plan` namespace does not block it | `LakekeeperClient.scala:131-153` |
| Unit image uses the system python3 and has `python3-venv` | `computing-unit-master.dockerfile:97-103` |

## Major findings

### M1. The update message cannot reuse 1d's operator message

**Design:** `StoredOperatorUpdate { <1d's op message> operator }`, "compiled, bound, encoded like a plan operator" (design §3.1, lines 252-257).

**Why it fails:**

- The changed operator comes from `runtimeReconfiguration`, which returns `newLogicalOp.getPhysicalOp(wid, eid)` (`PythonUDFOpDescV2.scala:221`; Filter, Map, Limit and the Java and R UDFs do the same).
- Its ports carry `Left(SchemaNotAvailableException)` and no links (`PhysicalOp.scala:290-317`).
- 1d refuses any operator with a port that has no schema (`PhysicalPlanCodec.scala:219`).
- 1d's `encodeOperator` is private (`:235`), and `encode` takes a whole plan and checks link consistency.

So sub-part 8 cannot be implemented as written.

**What the unit actually uses:** only `op.id`, `op.opExecInitInfo` and `op.repositoryMounts`, through `UpdateExecutorRequest(op.id, op.opExecInitInfo)`, `ensureMounted` and `requireResourcesBound` (`ExecutionReconfigurationService.scala:121-148`).

**Fix:** a narrow message:

```
StoredOperatorUpdate { formatVersion, executionId, updateId,
                       PhysicalOpIdentity id, OpExecInitInfo opExecInitInfo,
                       StoredRepositoryMounts repositoryMounts,
                       PythonEnvironmentSpec pythonEnvironment }
```

The unit checks that `id` is in the running plan.

### M2. `--system-site-packages` from a venv interpreter does not see that venv's packages

**Reproduced here** (Python 3.13):

- `outer/bin/python -m venv --system-site-packages inner` writes `home = <base install>` into `pyvenv.cfg`.
- `inner/bin/python` cannot import a module that sits in `outer`'s site-packages.

**Why it matters:**

- Local-dev's UDF interpreter is normally a venv: `$VIRTUAL_ENV/bin/python` or `venv312/bin/python` (`bin/local-dev/main.sh:1443-1447`).
- A curated image may be built the same way.
- Every Python worker of an operator with an environment would fail to import `pyarrow`, `pandas`, `loguru` and the generated protobufs.
- The harness cannot catch this, because the unit image uses the system python3.

**Fix:**

1. After `python -m venv`, ask the base interpreter for `site.getsitepackages()` (and the user site directory).
2. Write those paths into a `.pth` file in the new venv's site-packages.
3. Include them in the engine identity.
4. Add a `PythonEnvironmentStoreSpec` case whose base interpreter is a venv.
5. Add local-dev to the per-PR verification of PR D.

### M3. From the first decoded-plan PR until PR D, Python environments silently fall back

**How the venv is found today:** through `workerConfig.cuid`, which comes from `workflowContext.cuid` (`ScheduleGenerator.scala:42` → `WorkerConfig.scala:29-50`). When cuid is None, the worker falls back to the default interpreter without an error (`PythonWorkflowWorker.scala:237-246`).

**Where cuid gets lost:**

- 1d's `decode` builds the context with cuid None (`PhysicalPlanCodec.scala:149`).
- §4's start builds the context from "wid, eid, settings, warehouse, limits, cost hints" (design lines 405-407), again with no cuid.
- D29 removes cuid only in sub-part 17, and the design calls PRs C and D independent.

**Result:** from 1d (if it runs the decoded context) or PR B (sub-part 9) until PR D, a UDF with `envName` runs on the default interpreter. That is exactly the silent fallback this step sets out to remove. No harness scenario uses an environment before PR D.

**Fix:**

- Until sub-part 17, set the unit's cuid (the socket's cuid, checked against the header) on the context the unit runs.
- Assert this in `WorkflowExecutionServiceSpec`.
- Add a pre-PR-D harness scenario: build an environment through `/wsapi/pve`, then run a UDF that imports from it.

### M4. Check A's start window races with the run's own reads

**The race:**

- The result service reads `operator_port_executions` as soon as a run reaches a terminal state (`ExecutionResultService.scala:302-313`), and again 2 s after RUNNING (`:286-295`).
- The "after the first Running" mark is a `docker exec … psql` that the driver runs only after it receives the Running event.
- Scenarios a, b, c and e end within about a second.
- So the final `SELECT … operator_port_executions` can be logged before the mark. Check A then fails on a correct build, and the gate becomes flaky.

**Fix:**

- End window A at the unit's own `UPDATE workflow_executions SET status = $1 … WHERE eid = $3` with parameters 1 and the scenario's eid. Read the `DETAIL: parameters:` line of the same process.
- Keep the driver marks only as coarse bounds.

### M5. A second start of the same execution is not refused

**The gap:** §4's start checks type, eid, wid, cuid, user, version and expiry, and the spec list has no "already started" case.

**What a repeated `WorkflowStartRequest` does** (double click, socket reconnect, agent retry, or on purpose): it kills the run and starts the same eid again.

- `createDocument` replaces the result and statistics tables (`DocumentFactory.scala:99-113`, `IcebergUtil.createTable` with `overrideIfExists = true`).
- The port and console INSERTs hit primary keys (`texera_ddl.sql:540-562`).
- A finished execution's row goes back through 0 → 1 → 3.

**Fix:** start each eid only once.

- Refuse an eid this unit already started; the unit can track that in memory.
- Claim the plan atomically in the lake before running, for example by creating a `…_started` marker table (`createTable` fails if it exists). This covers unit restarts and other units.
- Add the case to `WorkflowWebsocketResourceSpec` and a harness case "l8: start twice".

### M6. Create clears the previous run's results while that run may still be running

**Today:** the unit kills the old run, then clears it (`WorkflowService.scala:257-270`).

**D8:** clears at create, before compiling (§4 step 5), and kills only at start. Clearing:

- drops the tables (`IcebergDocument.clear` calls `dropTable`, `IcebergDocument.scala:98-107`);
- deletes the URI rows and the large binaries (`WorkflowService.scala:425-467`).

**When the old run is still running** (a second tab, a collaborator, Time Travel replay, the agent — anything that bypasses the disabled Run button in `menu.component.ts:520-546`):

- its writers fail on the dropped tables;
- the resulting `WorkflowErrorEvent` reaches every socket on the wid, including the browser waiting for its create;
- tables and rows it creates after the clear are never cleared.

**If that create then fails to compile or is never started,** the old run keeps running with its results gone. Nothing kills it.

**Fix:**

- At create, clear only previous (wid, cuid) executions in a terminal state (3, 4 or 5) — all of them, not just MAX(eid). This also survives created-but-never-started rows in the chain.
- Clear after the plan is written, so a compile error leaves results on screen.
- Have the unit write KILLED for the run it supersedes. That is an UPDATE by eid, which is allowed. The next create then sees it as terminal and clears it.

### M7. Kubernetes: moving the cleanup to the Dashboard in PR B leaks large binaries until PR C

**Why:**

- `clearExecutionResources` ends with `LargeBinaryManager.deleteByExecution` (`WorkflowService.scala:466`), which needs STORAGE_S3_*.
- The K8s webserver has none (`webserver-deployment.yaml:44-80`). Sub-part 13 (PR C) adds them, but sub-part 7 (PR B) already moves the cleanup.
- The failure is only logged (`LargeBinaryManager.scala:91-105`).
- `cu-dashboard-dispatch` commit `5eb38a191` records this failure: "deleting a run's large binaries failed and was only logged, leaking storage".

**Fix:** give the webserver its S3 settings in sub-part 7, or in a commit before it.

### M8. How an environment install ends on kill is undefined, and some installs can never finish

**The design says** (D21, §4) that kill or supersede "destroys the pip process and removes the directory". **But sub-part 17** cancels only in `unsubscribeAll`. The two kill paths do something else:

- The browser's kill (`ExecutionRuntimeService.scala:106-113`) and the agent's timeout kill (`SyncExecutionResource.scala:377-394`) call `client.shutdown()` and set KILLED; they do not call `unsubscribeAll`.
- So the installer would carry on and later call `startWorkflow` on a shut-down client.

**If kill does cancel and delete as written:**

- An install longer than the agent's 240 s execution timeout (`agent-service/src/types/agent.ts:87`) is killed and deleted on every attempt, so it never completes through the agent.
- One run's kill cancels an install that another run on the same unit is waiting for ("concurrent runs share one install").

**Fix:**

- One install per key runs to completion or to its own timeout and is shared by every waiter.
- A killed or superseded run only stops waiting.
- The installer checks the run's state before calling `startWorkflow`.
- The directory is removed only when the install fails.

### M9. Sub-part 9 leaves main broken

The design says so itself: "main works: **no** alone" (§5 line 553).

**Fix:**

1. **9a:** add `WorkflowStartRequest`, `ModifyLogicRequest{executionId, updateId}` and `POST /api/execution/{eid}/run` beside the old paths.
2. **10 and 11:** switch the frontend and the agent.
3. **9b:** delete `WorkflowExecuteRequest`, the old sync path and the unit's compile.

Both paths then exist only inside PR B, never in the step's end state, and every commit is green and bisectable.

## Minor findings

### Wrong claims and ordering

**m1. Workflow delete does not call `removeAllExecutionFiles`.**
- Design §3.3 says it does, for "execution and workflow delete" (line 286).
- `WorkflowResource.deleteWorkflow` has its own cleanup (`WorkflowResource.scala:628-690`). The only callers of `removeAllExecutionFiles` are `WorkflowExecutionsResource.scala:798` and `UserQuotaResource.scala:168`.
- So a deleted workflow's plan tables leak.
- Fix: drop them there too, rebuilding each URI with `ExecutionPlanStore.planUri(wid, eid, whid → lakekeeper_warehouse_name)`.

**m2. PRs C and D are not independent.**
- Sub-part 17 edits `RunBindings.scala` (design line 683), which sub-part 13 creates (line 621).
- Fix: 17 depends on 13, or 17 creates `RunBindings`.

**m3. 1d's actual shape differs from what the design assumed.**
- There is no separate header message. Header fields sit at the top level of `StoredPhysicalPlan`, with camelCase names printed by `preservingProtoFieldNames` (`storedplan.proto:51-61`; `PhysicalPlanCodec.scala:81`). The design's snake_case `user_id` would print inconsistently.
- `decode` returns a `(WorkflowContext, PhysicalPlan)` pair, so the new fields need their own decoded-header type.
- `FormatVersion` is 1 (`:64`).
- 1d states that "a plan does not choose the unit it runs on" (`:103`), while the design adds `computing_unit_id`. Say it is the step-2 start check, which step 4 replaces with the Dashboard's answer to Envoy.

**m4. D15 contradicts C11's reasoning and 1d.**
- D15 has the Dashboard decide default workers per operator and region concurrency, yet C11 argues the Dashboard cannot know the unit.
- 1d's `suggestedWorkerNum` says "Absent: the engine's default" (`storedplan.proto:102-103`).
- K8s units have per-unit CPU limits, and Slurm or EC2 units will differ.
- Fix: the plan carries only per-run overrides; absent means the unit's own default.

### Security

**m5. Links are fetched from whatever URL the descriptor holds.**
- "Every compile clears and recomputes" the `inputLinks` sidecar is the only guard. A missed path would be a server-side request forgery from the unit — cloud metadata, internal services — with the response returned as rows.
- Fix: `LinkDocument` accepts only the configured object-store host or hosts.
- Never write sidecars (links, 7-day bearer secrets) into the stored `logical` column.
- Add a spec that a browser-supplied `inputLinks` is dropped on every `ReadsInputs` descriptor.

**m6. Start opens whatever warehouse the browser's `planUri` names.**
- Fix: before touching the catalog, require the URI's warehouse to be the default one or `user-<socket uid>-<n>` (`WarehouseResource.scala:58-59`), and apply `WarehouseReadGuard`.

**m7. Plan integrity depends on step 5.**
- The unit trusts a plan because only the Dashboard writes it. But units run user code with full Lakekeeper access and, in single-node, share one container.
- Add this to the risk table as a step-5 dependency.

### Run state and the unit

**m8. A superseded run's row stays RUNNING.**
- `unsubscribeAll` kills the run without writing a state (`WorkflowService.scala:257-259`).
- The CU idle sweep treats any status other than 3, 4 or 5 as active (`ComputingUnitManagingResource.scala:123-130, 190-191`). Together with never-started rows at status 0, this keeps K8s units from idle termination.
- Fix: write KILLED for the superseded eid at start.

**m9. A refused start marks the previous execution failed.**
- The websocket's catch block records the error as COMPILATION_ERROR on the previous execution's store when one exists (`WorkflowWebsocketResource.scala:138-161`).
- Fix: send a refused start's `WorkflowErrorEvent` straight to that session.

**m10. Two checks for the synchronous run path:**
- Count *distinct* external input port ids across a logical operator's physical operators. Otherwise the "targets completed" wait never fires.
- Check the header cuid against the `WorkflowService`'s own cuid as well. The service is keyed by wid only (`WorkflowService.scala:126-145`).

**m11. Create defaults.**
- `workflow_executions.status` defaults to 1 (`texera_ddl.sql:324`), and `insertNewExecution` never sets it. Assert status 0 after create in `ExecutionResourceSpec`.
- The agent sends no `workflowSettings`, so create must default it as `SyncExecutionResource` did (`:176-179`).

### Deployment and performance

**m12. Single-node gets no longer create timeout.**
- nginx's `/api/` uses the default 60 s `proxy_read_timeout` (`nginx.conf:128-132`), while K8s gets 120 s.
- Fix: add `location = /api/executions` with a matching timeout, and the same in the local-dev proxy.

**m13. A File Lister plan makes create slow.**
- D10 stats each listed object in LakeFS: up to 10,000 round trips against a 120 s route.
- Fix: use the physical addresses LakeFS's listing already returns (`retrieveObjectsOfVersion`, `ObjectStats.physicalAddress`) and presign locally.

**m14. Cost hints add to every create.**
- They read the newest completed run's whole runtime-statistics table: 5.4 s for an uncompacted one-hour run (measured 2026-11-14).
- Fix: cache per (wid, uid, source eid).

**m15. One link endpoint for the whole deployment.**
- The link endpoint is a single global setting, but K8s pool units and later Slurm or EC2 units may need different ones.
- Fix: choose it by the unit's type at create; the unit is known then.

### Things users will notice that §6 leaves out

**m16.**
- Environments become per user. A collaborator running a shared workflow whose UDF names the owner's environment now gets a compile error.
- Existing rows with specs outside the new grammar (`~=`, extras, comma lists) now fail.
- Install output goes to the operators' console, not to "the run's log" that the tracker text names. That is fine until step 3, but say so.
- `starting_time` becomes the create time, so durations include the install and the gap between create and start.

## Missing call sites and specs

- `agent-service/src/agent/texera-agent.spec.ts` asserts the old URL `/api/execution/7/0/run` (`:1021`; also `:1071, :1106, :1156`). Add it to sub-part 11.
- `WorkflowResource.deleteWorkflow` needs the plan-table drop (m1).
- `WorkflowMetricsRecorder.onStart(eid)` runs after the insert (`WorkflowService.scala:282-283`). Keep it on the unit's start path.

**Postgres reads left on the unit after the design.** None are on the start path, and all are allowed until step 3:

| Read | Where |
|---|---|
| Result poll at RUNNING + 2 s, and once more at the end | `ExecutionResultService.scala:286-313, 463-470` |
| Result page lookup, `getLatestExecutionID`, which joins `workflow_version` — so a browser that pages during a run would fail Check B's table rule; the harness only pages after the end mark | `ExecutionResultService.scala:405-417` |
| SELECT before the size UPDATEs | `WorkflowExecutionsResource.scala:438-506` |
| Console URI lookup for the agent's result | `SyncExecutionResource.scala:826-840` |
| Idle cleanup | |
| TTL job | |

The start-path removals themselves are complete:

| Removed read | Sub-part |
|---|---|
| insert, warehouse, replay, log location | 7 / 9 |
| `CostEstimator` | 5 |
| email notifier's workflow name | 5 |
| `SiteSettings` CSV column limit | 12 |
| File Lister query | 14 |
| `FileScanOpExec` name resolution | 14 |
| `LakeFSFileDocument` | 13 |

## Harness changes beyond the design

1. **Cut window A at the unit's own RUNNING UPDATE for the eid** (M4).
   - Attribute statements by `%h` (the unit container's address, distinct on `sce-unit-net`) as well as `app=`. A non-Hikari connection would otherwise go unattributed.
2. **Add negative controls.**
   - Run checks A, B and D once against the published images (`ws` transport), with `USER_JWT_TOKEN` set on the unit to emulate the K8s file-service path. They must fail.
   - Without this, Check D proves little in single-node, because the old unit never called file-service there (C7).
3. **Add "l8 start twice" (M5)** and a pre-PR-D environment scenario (M3).
4. **Resolve the status-0 contradiction.** l5 and l6 expect "row stays 0", while the final check expects no status-0 rows (lines 808 and 836). Exclude rows refused at start.
5. **Check D: grep the unit log for the specific hosts** (`file-service`, `texera-lakefs`, `:8000/api/v1`) rather than generic words such as "presign" that a link reader may log.
6. **Before every scenario, wait for the previous wid's cleanup statements to appear in the log**, rather than relying on the 3 s pause.
