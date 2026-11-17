# Step 2 (TEX-425): executions are created by the Dashboard service

Revision 2, 2026-11-15: revised after review (`step2-critique.md` in this folder). Implementable
design. Repo paths are relative to the worktree
`/Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine` (branch
`feat/self-contained-engine`), read at `b2e981d58` (step 1c, "save a physical plan and read it
back": `common/workflow-core/src/main/protobuf/org/apache/texera/amber/core/storedplan.proto`,
`common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/PhysicalPlanCodec.scala`,
golden file `common/workflow-core/src/test/resources/storedplan/physical-plan-v1.json`) plus step
1d as it stood uncommitted in that worktree on 2026-11-15: `PlanToRun(savedPlan: String,
logicalPlan: LogicalPlan)` with `PlanToRun.make(compiler, context, logicalPlanPojo)` (compile Strict,
encode, print) in `amber/src/main/scala/org/apache/texera/web/service/PlanToRun.scala`, and
`WorkflowExecutionService.readPlanToRun(savedPlan, context, unitMountRoot)` (parse, decode, check
the decoded ids, settings and warehouse against the run's own context, `requireRunnableUnder`), with
the run keeping its own context. Line numbers are from that state. This design builds on 1d's names;
if 1d lands differently, sub-part 6 adapts to it.

How to read it: §0–§4 are the design, §5 the commit order, §6–§9 users, harness, deployment and
risks, §10 the questions for the owner, and §11 one brief per sub-part that an engineer can follow
on its own. §1b lists every review finding and what this revision did with it.

## 0. The step in one picture

```
CREATE  browser/agent ──POST /api/executions──▶ Dashboard service (no unit involved)
          rights: workflow READ, unit WRITE, unit not terminated · warehouse · replay source
          INSERT workflow_executions (status 0)
          compile Strict for the creator: scan files → links · File Lister listing ·
            dataset/model mounts · Python environments · CSV column limit · cost hints
          plan table, one row: stored plan + logical plan + creator + unit + notification
          clear the results of earlier, finished executions of this workflow on this unit
        ◀── 201 {eid, planUri}             (400 per-operator errors, row FAILED)

START   browser ──ws WorkflowStartRequest{executionId, planUri}──▶ unit
        agent   ──POST /api/execution/{eid}/run {planUri, computingUnitId, …}──▶ unit
          URI: a plan of this eid and the socket's workflow, in the default warehouse or the user's
          row: format version · creator = socket user · unit = socket unit · links not expired
          claim: tag "started" on the plan table (a second start is refused)
          supersede: kill this workflow's run on this unit, write it KILLED
          build the run from the stored plan; READY (the browser shows "Initializing")
          install the plan's Python environments (shared, first sight only) → console
          still wanted? → startWorkflow
          Postgres on the start path: writes only · file service, LakeFS: never

CHANGE  browser ──POST /api/executions/{eid}/updates {operator}──▶ Dashboard: compile, append a row
(paused) browser ──ws OperatorUpdateRequest{executionId, updateId}──▶ unit: read the row, queue it
                                                                   (applied on resume, as today)
```

Done when a unit starts a run without reading Postgres or calling the file service. Evidence: an
in-repo spec (sub-part 18) and the harness's Postgres statement log and network isolation (§7).

## 1. Corrections to the sketch

Review checked C1–C15 against the code; they hold. C16 keeps its finding but changes its
conclusion. C17–C22 are corrections that review found in the sketch itself.

C1. **The plan is not in a namespace per execution in step 2.** The agreed Amber Engine Plan page
says "One namespace per execution arrives with step 5" and "Until step 5, plan and log are two more
kinds of table beside results, statistics and console, in the layout the lake has today"; this
task's own step 5 text lists "one namespace per execution". Today every run table sits in one of
four shared namespaces chosen by resource type (`DocumentFactory.scala:46-53`, `storage.conf:51-62`)
and is named from its VFS URI (`DocumentFactory.scala:43-44`). So step 2 adds a fifth resource type,
`PLAN`, in that layout. Its URI `vfs:///[wh/<w>/]wid/<wid>/eid/<eid>/plan` is what create returns and
start names; step 5 changes only `DocumentFactory`'s mapping (namespace `e_<eid>`, table `plan`), so
no request shape changes then.

C2. **The unit cannot find the plan from the eid alone.** The warehouse a run writes into
(`user-<uid>-<whid>`) is known only from Postgres (`WorkflowService.scala:91-121` reads
`user_warehouse`). So start carries the `planUri` that create returned, and the unit checks that the
URI is a `PLAN` URI for that eid, for the socket's workflow, and in a warehouse the socket's user may
name (D4).

C3. **Start must also check the unit and the user, not only eid and wid.** The plan's links, mounts
and environments are resolved with its creator's access. A browser-supplied `planUri` would
otherwise let any socket on a unit start any plan it can name. The unit checks the plan row's
`computingUnitId` against the socket's `cuid` (`WorkflowWebsocketResource.scala:55`) and its
`createdBy` against the socket's user (`WorkflowWebsocketResource.scala:81-84`).

C4. **Strict compile does not produce per-operator errors.** Strict passes no error list and throws
the first error it meets (`WorkflowCompiler.scala:453-458`, `:479-481`); only Lenient collects
errors per operator. A 400 "with per-operator errors" therefore needs Strict changed: collect every
operator's error like Lenient, then throw them together; binding errors (`bindResources`,
`WorkflowCompiler.scala:286-303`) must carry their operator too.

C5. **LakeFS and file-service links are unusable by units.** LakeFS signs links for the
browser-facing endpoint: `LAKEFS_BLOCKSTORE_S3_PRE_SIGNED_ENDPOINT=${TEXERA_HOST}:${RUSTFS_PORT}` =
`http://localhost:9000` (`bin/single-node/docker-compose.yml:104`, `.env:19-21`) and
`pre_signed_endpoint: http://localhost:31000` (`bin/k8s/values.yaml:163`). file-service's
presign-download is the same LakeFS call (`ResourceUploadService.scala:344`). A unit cannot reach
`localhost:9000`; today it silently falls back to a direct LakeFS fetch
(`LakeFSFileDocument.scala:105-133`; the harness README lists this as an expected unit warning). A
SigV4 signature covers the host, so a link cannot be rewritten after signing. The Dashboard must
find the object's physical address in LakeFS and presign an S3 GET itself against the object-store
endpoint units use. The Dashboard has the LakeFS client settings in every mode (single-node `.env`;
K8s `webserver-deployment.yaml:53-64`; local-dev exports) and `LakeFSStorageClient` is on its
classpath. No S3 presigner exists in the repo yet (`S3StorageClient.scala` has none), and the K8s
webserver has no `STORAGE_S3_*` settings (`webserver-deployment.yaml:44-80`).

C6. **"No connection at all on the start path" is not achievable in step 2, and today even the
state write reads.** The pool opens at boot (`ComputingUnitMaster.scala:145`). State writes on the
start path go through `tryUpdateExistingExecution`, which SELECTs the row by eid before the UPDATE
(`ExecutionsMetadataPersistService.scala:103-114`). `updateRuntimeStatsUri` is an UPDATE with a
subselect on `workflow_version` (`WorkflowExecutionsResource.scala:280-297`), run when the stats
service is built. Step 2 makes these write-only; the check becomes "no SELECT, and no table other
than the three run-state tables", not "no connection".

C7. **In single-node the unit never calls file-service today.** Only K8s units get `USER_JWT_TOKEN`
(`ComputingUnitManagingResource.scala:778-781`); without it `LakeFSFileDocument` presigns through
LakeFS and falls back to a direct LakeFS fetch. A file-service request-log check would pass
trivially in the harness. The meaningful check is "the unit reaches neither file-service nor
LakeFS", enforced by giving the unit a network without them, with a negative control (§7).

C8. **The Dashboard's JSON mapper cannot read a logical plan yet.** It registers only
`DefaultScalaModule` (`TexeraWebApplication.scala:100`); a `LogicalPlanPojo` whose operators use
loop-variable placeholders needs `JSONUtils.registerWorkflowModules` (`JSONUtils.scala:51-52`), as
the unit (`ComputingUnitMaster.scala:137`) and the compiling service (`WorkflowCompilingService.scala:46`)
register.

C9. **Compiling on the Dashboard needs the units' mount root.** A Strict compile writes UDF code
against `RepositoryMountManager.mountRoot`, read from `TEXERA_MOUNT_IN_POD_ROOT` on the compiling host,
and fails without it (`WorkflowCompiler.scala:286-294`). In K8s only the CU manager gets that value
(`bin/k8s/templates/base/workflow-computing-unit-manager/workflow-computing-unit-manager-deployment.yaml:92-93`).
The webserver must get `mounter.podMountRoot` when `mounter.enabled`.

C10. **Changing a paused operator: the base `runtimeReconfiguration` throws, and anyone on the socket
can send it today.** `LogicalOp.runtimeReconfiguration` throws `UnsupportedOperationException` instead
of returning a `Failure` (`LogicalOp.scala:500-509`), so the Dashboard must wrap the call in `Try`.
`ModifyLogicRequest` has no privilege check (`WorkflowWebsocketResource.scala:100-113`); since the
stored plan is bound to its creator's access, the Dashboard accepts changes only from the creator.

C11. **Environment digest: the Dashboard cannot know the unit's interpreter.** Units may run different
images (curated images, and later Slurm or EC2); the system package set is computed on the unit
(`PveManager.scala:132-219`). The plan's digest covers only the canonical package list. The engine
keys its install directory by `sha256(plan digest + its own interpreter identity)`.

C12. **A venv cannot be built in a temp directory and renamed.** Scripts in a venv carry the absolute
path of its interpreter in their shebang lines, so a moved venv's `bin/pip` and any installed console
script break. Install in place under the lock and publish with a completion marker written
atomically; readers require the marker.

C13. **Rights before insert, and a terminated unit.** `ComputingUnitAccess` does not look at
`terminate_time` (`ComputingUnitAccess.scala:34-55`); create must refuse a terminated unit itself.
Rights, warehouse and replay checks run before the insert, so a refused request leaves no row.

C14. **Agent "execute to" and target port counts live on the unit.** The sub-DAG cut
(`SyncExecutionResource.scala:886-931`) and the per-target external input port counts
(`SyncExecutionResource.scala:218-221`) read the logical plan, which the unit no longer has. The cut
moves into create (`targetOperatorIds`); the counts come from the decoded physical plan (D37).

C15. **Environment install must not run on the socket thread.** The websocket handler runs the start
synchronously on the session's thread (`WorkflowWebsocketResource.scala:114-127`), so a multi-minute
pip install there would block kill and heartbeats for that session. The install runs on its own
executor between building the run's services (`WorkflowExecutionService.scala:161-196`) and
`startWorkflow` (`:197`); workers start only after `startWorkflow`, when a region launches.

C16. **More engine settings than the sketch lists come from unit configuration, and they stay
there.** Default workers per operator (`WorkerConfig.scala:38`), region concurrency
(`ScheduleGenerator.scala:73`) and the schedule search (`CostBasedScheduleGenerator.scala:344-351`)
are read from `ApplicationConfig` on the unit. Revision 1 moved them into the plan; that was wrong
(D15): they describe the unit's capacity, which the Dashboard cannot know (C11), and 1c's
`suggestedWorkerNum` already says "Absent: the engine's default" (`storedplan.proto:102-103`).

C17. **1c's stored plan is flat and names no unit.** Run-level fields are top-level fields of
`StoredPhysicalPlan`, with camelCase names printed by `preservingProtoFieldNames`
(`PhysicalPlanCodec.scala:96`); `decode` returns `(WorkflowContext, PhysicalPlan)` (`:164`) with no
unit (`:178`); `FormatVersion` is 1 (`:76`); and 1c states that "a plan does not choose the unit it
runs on" (`:126`). So step 2's additions are top-level fields (format 2), and who and where (creator,
unit) and the email notification are columns of the plan's row, not plan fields (D3).

C18. **A changed operator cannot be stored as a plan operator.** `runtimeReconfiguration` returns
`newLogicalOp.getPhysicalOp(wid, eid)` (`PythonUDFOpDescV2.scala:215-222`; Filter, Map, Limit and the
Java and R UDFs alike), whose ports have no schema (`PhysicalOp.scala:290-317`). The codec refuses a
port without a schema (`PhysicalPlanCodec.scala:260-261`) and `encodeOperator` is private (`:287`).
The unit uses only the op's id, its `OpExecInitInfo` and its repository mounts
(`ExecutionReconfigurationService.scala:121-148`). A narrow message carries exactly those (D34).

C19. **`python -m venv --system-site-packages` run by a venv's interpreter does not see that venv's
packages.** The new venv's `pyvenv.cfg` gets `home` = the base install. Reproduced on Python 3.13
(2026-11-15, scratch): the nested venv cannot import a module of the outer venv; one `.pth` line
naming the outer venv's site directory fixes it, and pip in the nested venv then treats the outer
venv's distributions as installed ("Requirement already satisfied … in outer/lib/python3.13/site-packages"),
while `pip freeze --local` lists only its own. Local-dev runs Python workers on a venv
(`bin/local-dev/main.sh:1443-1447`); the unit image uses the system python3
(`computing-unit-master.dockerfile:97-103`), so the harness alone would not catch this (D21).

C20. **Clearing the previous run's results at create races that run.** Today the unit kills, then
clears (`WorkflowService.scala:257-270`). Clearing drops the tables (`IcebergDocument.scala:98-107`)
and deletes the URI rows and the large binaries (`WorkflowService.scala:425-467`). Done at create, it
would hit a run that is still running (a second tab, a collaborator, Time Travel replay, the agent),
and nothing kills that run if the new create fails or is never started. Create may clear only
finished executions (D8).

C21. **An execution must start once.** A second `WorkflowStartRequest` for the same eid (double
click, reconnect, agent retry) would run it again: result and statistics tables replaced
(`createDocument` with `overrideIfExists = true`), the primary keys of `operator_port_executions` and
`operator_executions` hit (`texera_ddl.sql:540-562`), and a finished row moved back through
0 → 1 → 3 (D32).

C22. **A shared environment install must outlive a kill.** The browser's kill
(`ExecutionRuntimeService.scala:106-113`) and the agent's timeout kill
(`SyncExecutionResource.scala:377-394`) only shut the client down and write KILLED. An install that a
kill cancels would never finish through the agent (240 s, `agent-service/src/types/agent.ts:86`) and
would cancel another run waiting on the same install (D36).

## 1b. Review findings and what this revision did

| Finding | Verdict | Resolution |
|---|---|---|
| M1: the update cannot use 1c's operator message | agree, narrower message | C18, D34; message in format 2 (sub-part 4); used by 10 and 11. No environment field: the Dashboard refuses an environment change, and a Python worker's interpreter is fixed when it starts |
| M2: nested venv does not see the engine venv's packages | agree, reproduced | C19, D21: the new venv gets a `.pth` file that runs `site.addsitedir` for each of the engine interpreter's site directories (so `.pth` files and editable installs there work too); a `PythonEnvironmentInstallerSpec` case whose engine interpreter is a venv; a local-dev run in PR D's verification |
| M3: environments silently fall back from the first decoded run | agree | D29: until sub-part 20 the unit sets its cuid (the socket's, equal to the row's) on the context it runs; asserted in `WorkflowServiceSpec`; harness scenario g0 (old environment path) in the gates of PRs A–C. 1d as written keeps the run's own context (with its cuid) and only compares the decoded one (`requirePlanOf`), and sub-part 6 keeps that; the gap opens with the first run built from a stored plan alone, sub-part 11's start by id, which therefore carries the fix |
| M4: Check A's window races the run's reads | agree | §7 H4: the start window ends at the unit's own first status UPDATE for the eid with a value other than 0, read with its `DETAIL: parameters` line from the same backend pid; statements attributed by `app=` and `host=` |
| M5: a second start is not refused | agree, different claim | D32: the claim is a tag `started` on the plan table, atomic in both catalogs; no marker table and no in-memory set; spec with two racing claims; harness l8 |
| M6: create clears a live run's results | agree | C20, D8: create clears only finished executions that still hold results, after the plan is written; the unit writes KILLED for the run it supersedes |
| M7: K8s Dashboard has no S3 settings when it starts clearing runs | agree | sub-part 7, the first commit of PR B |
| M8: install end on kill undefined | agree | C22, D36, sub-part 20 |
| M9: sub-part 9 left main broken | agree | D35: sub-part 11 adds the new paths beside the old, 12 and 13 switch the clients, 14 deletes the old paths |
| m1: workflow delete leaks plan tables | agree | D38; sub-part 6 drops plan tables in execution, workflow and quota deletes |
| m2: PRs C and D share `RunBindings` | agree | `RunBindings` is created in sub-part 15; sub-part 20 depends on 15 and 16 |
| m3: 1c's real shape | agree | C17; §3.1 written on 1c's shape; D3 puts creator, unit and notification in row columns |
| m4: D15 contradicted C11 | agree | D15 revised: the plan carries no run limits |
| m5: links fetched from any URL; links in the logical column | agree | D11: the unit opens only allowed object-store endpoints; sidecars never reach the `logical` column; a spec that a request's sidecar is dropped |
| m6: start opens any warehouse the URI names | agree | D4: warehouse checked before any catalog is opened |
| m7: plan integrity depends on step 5 | agree | §9 |
| m8: superseded runs stay RUNNING; never-started rows stay 0 | agree for superseded runs; never-started rows left to step 3 | D8; §9 (same class as #8618; the idle sweep is off by default) |
| m9: a refused start marks the previous run failed | agree | D33 |
| m10: distinct external ports; check the service's cuid | first agree (D37); second disagree | `WorkflowService` is keyed by wid on purpose (collaborators on one workflow share a session). The rule is "the request's unit is the plan's unit". The service's cuid matters only for local units sharing one JVM, where pagination already behaves this way today; unchanged by this step (§9) |
| m11: status defaults to 1; agent sends no settings | agree | D6, §3.4 |
| m12: single-node create timeout | agree | D31 |
| m13: one LakeFS stat per listed file | agree | D10: links from the listing's physical addresses |
| m14: cost hints read a whole statistics table per create | agree | D16: cached by source eid |
| m15: one link endpoint per deployment | partly | one setting now, read through `InputLinkEndpoints.endpointFor(unit)` on the Dashboard, so step 6 can map unit kinds to endpoints without a format change; nothing in step 2 needs a second endpoint (K8s pool units reach the same RustFS name through the ExternalName alias) |
| m16: user-visible changes missing | agree | §6 |
| Missing call sites | agree | `texera-agent.spec.ts` in 13; `deleteWorkflow` in 6; `WorkflowMetricsRecorder.onStart` on the start-by-id path in 11 (the old path keeps it after its insert until 14) |
| Harness items 1–6 | agree | §7 |

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Create and updates live in a new resource `ExecutionResource` (`@Path("/executions")`: `POST ""`, `POST "/{eid}/updates"`), registered only in `TexeraWebApplication`. | The unit registers `WorkflowExecutionsResource` (`ComputingUnitMaster.scala:205`) for the K8s stats and export routes until step 3, so the new methods cannot live there. Jersey 2 merges root resources that share a path; no method overlaps (`WorkflowExecutionsResource` has no root POST and no `/{x}/updates`). `TexeraWebApplicationSpec` proves both resolve. |
| D2 | Plan location: resource type `PLAN`, namespace `execution-plan` (`STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`), table `wid_<wid>_eid_<eid>_plan`, in the run's warehouse. | The agreed layout until step 5 (C1); the URI stays the same when step 5 maps it to namespace `e_<eid>`, table `plan`. |
| D3 | One plan table per execution: one plan row written at create, update rows appended. The row's columns hold the creator (`createdBy`), the unit it was created for (`computingUnitId`) and the email notification; the stored plan, the engine's input, names neither user nor unit. | 1c: "a plan does not choose the unit it runs on" (C17). The columns are what the unit's web layer checks and uses until step 4 (Envoy's check) and step 3 (email from the Dashboard) take them over; then the columns go and the plan format does not change. |
| D4 | Start carries `{executionId, planUri}`. Before opening any catalog the unit checks the URI: type `PLAN`, eid = `executionId`, wid = the socket's workflow, warehouse absent or `user-<socket uid>-<digits>` and readable (`WarehouseReadGuard.assertReadable`). After reading the row: `createdBy` = socket user, `computingUnitId` = socket unit. | C2, C3. A browser-chosen URI must not make the unit open another user's warehouse. |
| D5 | Only the execution's creator may start it or change its operators. | Links, mounts and environments in the plan were resolved with the creator's access. |
| D6 | Create inserts the row with status 0 set explicitly (the column defaults to 1, `texera_ddl.sql:324`) before compiling, and sets 4 (FAILED) on a compile error or a failed plan write. Rights, warehouse and replay refusals insert nothing. | Compile failures stay in the history as today; refused requests leave no trace (C13). |
| D7 | Strict compile collects every operator's error and throws `WorkflowCompilationFailed(errors)`; binding errors carry their operator. | The create 400 shows errors per operator (C4). |
| D8 | After the plan is written, create clears every earlier execution of the same workflow and unit that has finished (status 3, 4 or 5) and still has result or console rows. It never touches a live run. At start, the unit kills the run it supersedes and writes it KILLED, so the next create clears it. | C20. Same retention as today once runs end; a compile error leaves the previous results on screen. |
| D9 | `vid` stays "latest saved version" (`ExecutionsMetadataPersistService.scala:63`). | No product change; the stored logical plan is the exact provenance. |
| D10 | Links: the Dashboard presigns S3 GETs itself (AWS SDK `S3Presigner`) against `storage.input-links.s3-endpoint` (default `storage.s3.endpoint`), path style, TTL 7 days (604800 s, the SigV4 maximum; clamped). A scan file's object is found with one LakeFS stat; a File Lister's listing already carries each object's physical address, so listed files need no stat. The endpoint is chosen by `InputLinkEndpoints.endpointFor(unit)`: one setting today. | C5. One setting keeps units platform-neutral now; the function is where step 6 maps unit kinds (Slurm, EC2) to endpoints. Listing-based links keep a 10,000-file create within the route timeout. |
| D11 | A link rides in a hidden descriptor sidecar `inputLinks` (key: the name the executor reads); the plan's `inputs` lists operator, name, expiry and size, never the link. Every compile drops a sidecar value that came with the request; the `logical` column never holds a sidecar. The unit's `LinkDocument` opens only URLs whose scheme, host and port are in `storage.input-links.allowed-endpoints` (default: the unit's `storage.s3.endpoint`). | Executors receive links through `descString`, the path they already use. A link is a 7-day bearer secret. A missed compile path must not become a request forgery from the unit. |
| D12 | Expiry: the unit refuses to start a plan whose earliest link has expired ("input links expired at T; run the workflow again"); an executor opening an expired link fails its operator with the same message; nothing refreshes links. | Explicit, early failure; a new execution gets new links. |
| D13 | File Lister lists at plan time, for the creator, with a read check on the dataset (sidecar `listing`). File Scan From Input gets links for the union of the listings of the File Listers upstream of it (at most 10,000 files per plan); with no File Lister upstream, create fails at that operator. Local unit paths and run-time resolution are removed. | A plan can bind only names known when it is made; reading the unit's disk by a name from data is a hole (`FileScanOpExec.scala:52-58`). Today's File Lister checks no access at all (`FileListerSourceOpExec.scala:80-92`). |
| D14 | CSV column limit: every compile reads `site_settings.csv_parser_max_columns` once into the CSV descriptor's hidden sidecar `maxColumns`; the executor requires it. | `site_settings` stays a Dashboard-side table (`CSVScanSourceOpExec.scala:108,130-131`). |
| D15 | The plan carries no run limits. Default workers per operator, region concurrency and the schedule search stay unit configuration. | C16. Per-operator worker counts already travel as `suggestedWorkerNum`; site limits that change what a run computes (CSV columns, File Lister cap) are fixed inside operators at plan time. |
| D16 | Cost hints: the Dashboard computes per-logical-operator seconds from the newest COMPLETED execution of the same workflow by the same user (the fold of `CostEstimator.scala:120-164`, moved), cached by source eid (256 entries). | Keeps the feature without data from another user's warehouse entering this plan. A finished run's statistics never change; an uncompacted one-hour run's table takes 5.4 s to read (measured 2026-11-14), so it is read once per source run. |
| D17 | Notification `{email, workflowName, workflowUrl}` is a plan-row column (JSON; null = no email). The unit still sends the email until step 3. | Removes the unit's SELECT at notifier construction (`WorkflowEmailNotifier.scala:39`). |
| D18 | Replay `{sourceExecutionId, logLocation, interaction}`: the Dashboard checks that the source belongs to the same workflow and has a log. The replay-log write location comes from the Dashboard's `fault-tolerance.log-storage-uri` and is written to the row at create. | The unit stops reading and writing `log_location` (`WorkflowService.scala:285-311`). |
| D19 | A reused result (not implemented) will be a `StoredPlanInput` variant `result = 4` {source eid, global port, table URI} that `CostBasedScheduleGenerator` reads instead of scheduling the producing operators. | "A reused result is one more input": the place exists (field number reserved), nothing is built for it. |
| D20 | `PhysicalOp.pveName: String` becomes `pythonEnvironment: PythonEnvironmentRef` = `EngineDefault` / `Named(name)` / `Resolved(spec)`; spec = `{name, requirements (canonical, sorted), digest}`; resolved from `virtual_environments` for the creator; a missing row is a compile error; operators with an environment are pinned to the coordinator node (`PreferCoordinator`). Encoding a `Named` operator fails. | One field with explicit states; no silent fallback; in cluster mode an environment exists only where it was installed. |
| D21 | Engine install: key = `sha256(plan digest + "\n" + engine identity)`; engine identity = sha256 of the engine interpreter's real path, `sys.version`, platform, site directories and `pip freeze --all`, computed once per JVM. `<engine python> -m venv <root>/<key>` in place; then `<venv site-packages>/texera-engine-site.pth` with one line `import site; site.addsitedir(r'<dir>')` per engine site directory (`site.getsitepackages()`, plus the user site when enabled and present); then `pip install -r requirements -c constraints` where constraints = the engine's `pip freeze --all` `name==version` lines minus editable, URL and `pip` lines. Per-key single flight in the JVM plus a file lock; marker `texera-environment.json` written last (tmp + atomic move); 30 min timeout; root configurable. | C11, C12, C19. The same result whether the engine interpreter is a system Python or a venv; engine packages stay pinned; concurrent runs share one install; a broken install leaves nothing behind. |
| D22 | A Python worker takes its interpreter from the spec; a missing install fails the worker (no fallback). | Replaces the silent fallback (`PythonWorkflowWorker.scala:237-246`). |
| D23 | Environment rows are edited at `/api/environments` on the Dashboard, uid-scoped, validated on the server; the "system packages" list (`GET /api/pve/system`) is dropped. | The Dashboard cannot know a unit's image; each run's console shows the installed versions. |
| D24 | The requirement grammar lives in `common/workflow-core` and is checked by the Dashboard on write and at compile, and by the engine again before pip runs. | A plan line such as `--index-url …` would otherwise reach pip. |
| D25 | Agent: create at the Dashboard (with `targetOperatorIds`; `workflowSettings` defaulted as `SyncExecutionResource.scala:176-179` did), then `POST /api/execution/{eid}/run` on the unit with `{planUri, computingUnitId, …}`. | C14; same response shape, so agent-service's adapter stays. |
| D26 | Unit run-state writes are write-only: one `UPDATE … WHERE eid` per state change, `runtime_stats_uri` by eid. The idle cleanup clears the execution the service ran, and result pagination reads the service's own execution, instead of `MAX(eid)`. | C6. After create-before-start, `MAX(eid)` can be an execution that never started. |
| D27 | Every service names its Postgres connections (`ApplicationName`). | Attribution for the done-when check, and readable `pg_stat_activity` in production. |
| D28 | Format 2 in sub-part 4 (run fields and the update message), format 3 in sub-part 20 (environment). Each comes with a golden file; the unit refuses any other version. | Units are recreated at upgrade (no backward compatibility); 1c's rule that a format change brings a new version. |
| D29 | `WorkflowContext.cuid` stays until sub-part 20. A run started by id (sub-part 11) takes its context from the decoded plan and the unit sets `cuid` on it (the socket's unit, equal to the row's); the old path (1d, sub-part 6) keeps its own context, cuid included. Sub-part 20 removes `cuid` with the per-unit venvs. | A decoded plan has no unit (`PhysicalPlanCodec.scala:178`); without this a UDF's environment would silently fall back to the default interpreter for runs started by id until PR D (`PythonWorkflowWorker.scala:237-246`). |
| D30 | The Dashboard registers `JSONUtils.registerWorkflowModules` on Dropwizard's mapper. | C8. |
| D31 | Create gets 120 s in every mode: K8s gateway rule `Exact /api/executions` with `timeouts.request: "120s"`; single-node nginx `location = /api/executions` with `proxy_read_timeout 120s`; the dev proxy entry `/api/executions` with `proxyTimeout: 120000`. | Create compiles, reads files for schema inference, lists and presigns. Envoy's default route timeout is 15 s, nginx's 60 s. |
| D32 | An execution starts once. After its checks and before it kills or builds anything, the unit claims the plan by creating the tag `started` on the plan table's current snapshot. Iceberg refuses a second ref of that name in both catalogs, so a double click, a reconnect, an agent retry, a restarted unit or another unit is refused with "execution 345 was already started". | C21. A tag is atomic (REST: the commit's `assert-ref-snapshot-id` requirement; JDBC: the metadata-pointer swap; the loser's commit fails and a reload finds the tag), needs no extra table and records which snapshot was started. |
| D33 | A refused start answers only the session (or HTTP caller) that sent it, with a `WorkflowErrorEvent`; it writes no state and leaves every run's store alone. | Today's catch block writes the error into the previous execution's store (`WorkflowWebsocketResource.scala:138-161`), which every socket on the workflow sees. |
| D34 | A paused-operator change is stored as `StoredOperatorUpdate{formatVersion, executionId, updateId, opId, opExecInitInfo, repositoryMounts}`. The unit requires `opId` to be in the running plan. The Dashboard refuses a change of the operator's Python environment, so the message carries none. | C18; exactly what `UpdateExecutorRequest` and the mount step need. |
| D35 | The protocol switch takes three steps inside PR B: sub-part 11 adds the new start, update and agent paths beside the old ones; 12 and 13 switch the browser and the agent; 14 deletes the old paths and the unit's compile. | Every commit leaves main working; the step's end state has one path. |
| D36 | Environment installs are shared and outlive the run that asked. One install per key runs to completion or to its own timeout; every run that needs the key waits on it. Killing or superseding a run only ends its waiting. When the install ends, a run starts the engine only if it is still wanted (client active, state not terminal). Only a failed or timed-out install removes its directory. | C22. |
| D37 | The agent path's "targets done" wait counts, per target, the distinct external input port ids over that logical operator's physical operators. | The unit no longer has the logical operator; counting physical ports would double a HashJoin's and the wait would never fire. |
| D38 | Plan tables are dropped wherever an execution's data is deleted: execution delete (`WorkflowExecutionsResource.removeAllExecutionFiles`, also reached from quota delete, `UserQuotaResource.scala:168`) and workflow delete (`WorkflowResource.deleteWorkflow`, which has its own cleanup, `WorkflowResource.scala:628-690`). The URI is rebuilt from (wid, eid, `whid` → `user_warehouse.lakekeeper_warehouse_name`). A deleted warehouse drops its namespaces itself (`LakekeeperClient.scala:131-153`). | m1. |

## 3. Data shapes

### 3.1 Stored plan: format 2 (sub-part 4) and format 3 (sub-part 20)

Field numbers continue after 1c's last (`links = 7` on `StoredPhysicalPlan`, `repositoryMounts = 14`
on `StoredPhysicalOp`). 1c's printing and reading rules apply unchanged: camelCase names, every field
written except one whose comment says what its absence means, a `oneof` always set, a reader
refusing any other form.

```proto
// StoredPhysicalPlan (1c: formatVersion 1..links 7) gains, in format 2:
  // Where the run replays from. Absent: no replay.
  StoredReplaySource replay = 8;
  // Where the run writes its replay log, an absolute URI. Absent: it writes none.
  optional string replayLogLocation = 9;
  // Statistics of an earlier run for the scheduler's cost model. Absent: no history, and a
  // region costs the number of its ports whose results are stored.
  StoredCostHints costHints = 10;
  // What operators read from outside the run, each (operator, name) once, ordered by them.
  repeated StoredPlanInput inputs = 11;

message StoredReplaySource {
  int64 sourceExecutionId = 1;
  string logLocation = 2;            // an absolute URI
  string interaction = 3;            // the embedded control message id to replay to
}
message StoredCostHints {
  int64 sourceExecutionId = 1;
  repeated StoredOperatorCost operators = 2;   // each logical operator once, ordered by id
}
message StoredOperatorCost {
  string logicalOperatorId = 1;
  double seconds = 2;                // finite, at least 0
}
message StoredPlanInput {
  string logicalOperatorId = 1;
  string name = 2;                   // the key in that operator's inputLinks sidecar
  oneof source {
    StoredInputFile file = 3;        // a file read through a link (sub-part 16)
    // 4 is kept for a reused result (D19): source execution, global port, table URI.
  }
}
message StoredInputFile {
  int64 expiresAtMs = 1;             // when the link stops working, ms since the epoch
  int64 sizeBytes = 2;
}

// A change to one operator of a paused run (D34). Read and written with the plan's format version.
message StoredOperatorUpdate {
  int32 formatVersion = 1;
  ExecutionIdentity executionId = 2;
  string updateId = 3;
  PhysicalOpIdentity opId = 4;
  OpExecInitInfo opExecInitInfo = 5;
  // The datasets and models the new code reads. Absent: none.
  StoredRepositoryMounts repositoryMounts = 6;
}

// Format 3 (sub-part 20). StoredPhysicalOp: `string pveName = 13` is removed
// (`reserved 13; reserved "pveName";`) and it gains
  // The Python environment the operator's workers run in. Absent: the engine's own interpreter.
  StoredPythonEnvironment pythonEnvironment = 15;
message StoredPythonEnvironment {
  string name = 1;                   // for messages only
  repeated string requirements = 2;  // canonical lines, sorted, each once: "tabulate==0.9.0"
  string digest = 3;                 // lowercase hex sha256 of the lines joined by "\n"
}
```

Scala side (`common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/ExecutionPlan.scala`,
new; named apart from 1d's `PlanToRun`, which is the saved text plus the logical plan on the amber
side):

```scala
final case class ReplaySource(sourceExecutionId: ExecutionIdentity, logLocation: URI, interaction: String)
final case class InputFile(expiresAtMs: Long, sizeBytes: Long)
final case class PlanInput(logicalOperatorId: OperatorIdentity, name: String, file: InputFile)
final case class CostHints(sourceExecutionId: ExecutionIdentity, secondsByLogicalOperator: Map[String, Double])
final case class ExecutionPlan(
    context: WorkflowContext,         // ids, settings, warehouse, costHints; cuid None when decoded
    plan: PhysicalPlan,
    replay: Option[ReplaySource] = None,
    replayLog: Option[URI] = None,
    inputs: Seq[PlanInput] = Seq.empty
)
final case class OperatorUpdate(executionId: ExecutionIdentity, updateId: String, opId: PhysicalOpIdentity,
    opExecInitInfo: OpExecInitInfo, repositoryMounts: Option[RepositoryMounts])
```

`WorkflowContext` gains `var costHints: Option[CostHints] = None`. `PhysicalPlanCodec` after
sub-part 4: `encode(plan: ExecutionPlan)`, `decode(stored): ExecutionPlan` (replacing 1c's
`encode(context, plan)` and pair-returning `decode`), `toJson`, `fromJson`,
`encodeUpdate(executionId, updateId, op)`, `decodeUpdate(stored): OperatorUpdate`, `updateToJson`,
`updateFromJson`; `FormatVersion = 2` (3 from sub-part 20). 1d's `PlanToRun.make` and
`readPlanToRun` switch to the new signatures in sub-part 4.

### 3.2 Hidden descriptor sidecars (inside `descString`)

Removed from the operator's UI schema in `OperatorMetadataGenerator`, the way `stateReferences` is
(`OperatorMetadataGenerator.scala:126-127`). Every compile sets them from scratch, so a value sent by
a browser never survives; they are never written into the plan row's `logical` column.

| Descriptor | Sidecar | Set by | Example |
|---|---|---|---|
| `ScanSourceOpDesc` subclasses (CSV, ParallelCSV, CSVOld, JSONL, Arrow, FileScanSource) and `FileScanOpDesc` (trait `ReadsInputs`) | `"inputLinks": {name: {"url": …, "expiresAtMs": …, "sizeBytes": …}}` | Strict compile | `{"dataset:///ds-12/9f3c…/people.csv": {"url": "http://texera-rustfs:9000/texera-lakefs/…/data/gx1…?X-Amz-Expires=604800&…", "expiresAtMs": 1763856000000, "sizeBytes": 412}}` |
| `FileListerSourceOpDesc` | `"listing": [logical paths, sorted]` | Strict compile | `["/dataset/texera@texera.io/sce-e2e-1a2b/v1/depts.csv", …]` |
| `CSVScanSourceOpDesc` | `"maxColumns": int` | every compile | `512` |

Keys: a scan source reads its resolved `fileName` (`dataset:///repo/hash/path`); File Scan From Input
reads the logical path a File Lister emitted.

### 3.3 Lake layout

| | Value |
|---|---|
| Warehouse | the run's: `user-<uid>-<whid>` with the REST catalog and warehouses on; the configured default otherwise (JDBC catalog in tests) |
| Namespace | `execution-plan` (`storage.iceberg.table.plan-namespace`, env `STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`), created on first use by `IcebergUtil.createTable` |
| Table | `wid_<wid>_eid_<eid>_plan` (from the URI by `DocumentFactory.sanitizeURIPath`) |
| URI | `vfs:///wh/<w>/wid/<wid>/eid/<eid>/plan`, or `vfs:///wid/<wid>/eid/<eid>/plan` without a warehouse |
| Rows | one plan row (`entryId` "plan"), then one row per paused-operator update (`entryId` "update-<uuid>") |
| Claim | tag `started` on the snapshot current at start (D32) |
| Deletion | D38 |
| Step 5 | same URI, mapped to namespace `e_<eid>`, table `plan` |

Columns (`ResultSchema.executionPlanSchema`; nullable, as every Texera Iceberg column is):

| Column | Type | Plan row | Update row |
|---|---|---|---|
| `entryId` | STRING | `plan` | `update-<uuid>` |
| `kind` | STRING | `plan` | `update` |
| `formatVersion` | INTEGER | 2 (3 from sub-part 20) | same |
| `body` | STRING | `PhysicalPlanCodec.toJson(StoredPhysicalPlan)` | `updateToJson(StoredOperatorUpdate)` |
| `logical` | STRING | the request's `LogicalPlanPojo` JSON as received, sidecars removed | the posted operator JSON, sidecars removed |
| `createdAt` | TIMESTAMP | create time | post time |
| `createdBy` | INTEGER | the creator's uid | the poster's uid (always the creator) |
| `computingUnitId` | INTEGER | the unit the execution was created for | same as the plan row |
| `notification` | STRING | `{"email": …, "workflowName": …, "workflowUrl": …}` or null | null |

Writes: plan row: `DocumentFactory.createDocument(uri, executionPlanSchema)` (an existing table at a
fresh eid can only be stale; it is replaced), one writer named `plan`. Update rows: open the
document, one writer named after the entry id (data files are named after the writer, so names stay
unique). Reads: all rows (a handful), picked by `entryId`.

API (`common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/ExecutionPlanStore.scala`,
package `org.apache.texera.amber.core.storage`, built on `DocumentFactory`, `IcebergDocument` and
`IcebergCatalogInstance`): `planUri(wid, eid, warehouse)`, `writePlan(uri, record)`,
`readPlan(uri)`, `appendUpdate(uri, record)`, `readUpdate(uri, updateId)`, `claimStart(uri)`,
`isStarted(uri)`, `drop(uri)`; `PlanRecord`; `NoStoredPlanException`, `NoSuchUpdateException`,
`ExecutionAlreadyStartedException`.

### 3.4 Create: `POST /api/executions` (Dashboard; `@RolesAllowed(REGULAR, ADMIN)`)

Request:
```json
{
  "wid": 12,
  "executionName": "Untitled Execution",
  "engineVersion": "1.4.0-SNAPSHOT",
  "logicalPlan": {"operators": [], "links": [], "opsToViewResult": ["udf-1"], "opsToReuseResult": []},
  "workflowSettings": {"dataTransferBatchSize": 400, "executionMode": "PIPELINED"},
  "emailNotificationEnabled": false,
  "computingUnitId": 3,
  "warehouseId": 7,
  "replayFromExecution": {"eid": 340, "interaction": "<embedded control message id>"},
  "targetOperatorIds": ["op-a"]
}
```
Optional: `executionName` (empty keeps the column default), `workflowSettings` (absent:
`{dataTransferBatchSize: ApplicationConfig.defaultDataTransferBatchSize, executionMode: PIPELINED}`),
`emailNotificationEnabled` (false), `warehouseId`, `replayFromExecution`, `targetOperatorIds`. With
exactly one target, only its upstream sub-DAG is compiled (`LogicalPlanPojo.upstreamOf`, moved from
`SyncExecutionResource.computeSubDAGIfNeeded`). Settings sent as `outputPortsNeedingStorage` are
ignored; the compiler decides them.

| Outcome | Status | Body |
|---|---|---|
| created | 201 | `{"eid": 345, "wid": 12, "computingUnitId": 3, "planUri": "vfs:///wh/user-1-7/wid/12/eid/345/plan"}` |
| compile error (row 345 marked FAILED) | 400 | `{"eid": 345, "operatorErrors": {"<logical op id>": <WorkflowFatalError>}, "errors": [<WorkflowFatalError>]}`; `WorkflowFatalError` serialized as the compiling service serializes `WorkflowCompilationFailure.operatorErrors` (`{type:{name}, timestamp:{seconds,nanos}, message, details, operatorId, workerId}`) |
| bad request: warehouse missing / not owned / feature off; replay source of another workflow or without a log; malformed plan | 400 | `{"code": 400, "message": "…"}` (no row) |
| no READ on the workflow, no WRITE on the unit, unknown unit | 403 | `{"code": 403, "message": "…"}` (no row) |
| unit terminated | 409 | `{"code": 409, "message": "computing unit 3 is terminated"}` (no row) |
| plan write failed (row marked FAILED) | 500 | `{"code": 500, "message": "…"}` |

### 3.5 Change a paused operator: `POST /api/executions/{eid}/updates` (Dashboard)

Request: `{"operator": {"operatorID": "PythonUDFV2-operator-…", "operatorType": "PythonUDFV2", "code": "…", …}}`
(the operator JSON the browser sends in `ModifyLogicRequest` today, `execute-workflow.service.ts:449-460`).

| Outcome | Status | Body |
|---|---|---|
| stored | 200 | `{"updateId": "update-4f6c…", "operatorId": "PythonUDFV2-operator-…"}` |
| not the creator; no READ on the workflow or WRITE on the unit | 403 | `{"code": 403, "message": …}` |
| unknown eid, or operator not in the plan | 404 | |
| execution ended (status 3, 4 or 5) | 409 | |
| loop variables; operator does not support the change; compile or binding error; environment changed | 400 | `{"code": 400, "message": "…"}` (the text today's `ModifyLogicResponse.errorMessage` carries) |

### 3.6 Websocket (`/wsapi/workflow-websocket`, unchanged URL)

| | Message |
|---|---|
| added (11) | `{"type": "WorkflowStartRequest", "executionId": 345, "planUri": "vfs:///wh/user-1-7/wid/12/eid/345/plan"}`; needs unit WRITE on the socket, as execute did |
| added (11) | `{"type": "OperatorUpdateRequest", "executionId": 345, "updateId": "update-4f6c…"}`; answered as today with `ModifyLogicResponse{opId, isValid, errorMessage}` and, after resume, `ModifyLogicCompletedEvent{opIds}` |
| removed (14) | `WorkflowExecuteRequest`, `ModifyLogicRequest` |
| events | unchanged. A refused start answers that session only, with `WorkflowErrorEvent{fatalErrors: [{type: EXECUTION_FAILURE, message, operatorId: ""}]}`, and writes no state. Install progress arrives as `ConsoleUpdateEvent`s on each operator that uses the environment |

### 3.7 Unit REST for agents

| | |
|---|---|
| added (11) | `POST /api/execution/{eid}/run` (`@RolesAllowed(REGULAR, ADMIN)`), body `{"planUri": "…", "computingUnitId": 3, "targetOperatorIds": ["op-a"], "timeoutSeconds": 60, "maxOperatorResultCharLimit": 20000, "maxOperatorResultCellCharLimit": 4000}` → `SyncExecutionResult` (unchanged shape); a refused start → `{"success": false, "state": "Error", "operators": {}, "errors": ["…"]}` |
| removed (14) | `POST /api/execution/{wid}/{cuid}/run` |
| unchanged | `GET /api/execution/health` (the harness's unit healthcheck) |

### 3.8 Environment CRUD (Dashboard)

| Route | Body / result |
|---|---|
| `GET /api/environments` | `200 [{"veid": 1, "name": "ml", "packages": {"tabulate": "==0.9.0", "requests": ""}}]`, the caller's rows, as stored |
| `POST /api/environments` | `{"name", "packages"}` → `201` row; `400` invalid; `409` name exists for this user |
| `PUT /api/environments/{veid}` | `{"name", "packages"}` → `200` row; `400`; `404` not the caller's; `409` |
| `DELETE /api/environments/{veid}` | `204`; `404` |
| removed (21, unit) | `/api/pve/system`, `/api/pve/db*`, `/api/pve/pves*`, `/api/pve/{cuid}/{pve}/packages/{pkg}`, `/wsapi/pve` |

Validation (`PythonRequirements` in `common/workflow-core`, shared with the engine): name
`^[A-Za-z0-9._-]{1,128}$`; at most 200 packages; package name `^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$`
(≤128); spec `""`, `==V`, `>=V` or `<=V` with `V` matching `^[A-Za-z0-9][A-Za-z0-9.+!*_-]{0,63}$`.
Anything with a leading `-`, a space, `,`, `;`, `@`, `/`, `:` or `[` is refused. Canonical line: PEP
503-normalized name (lowercase, runs of `-_.` → `-`) plus spec; lines sorted and distinct; digest =
sha256 of the lines joined by `\n`. The table and its JSONB `packages` shape stay
(`sql/texera_ddl.sql:306-315`). Rows written before this step are listed as stored; one outside the
grammar fails the compile of any operator naming it, with the offending line, until it is edited.

### 3.9 Configuration added

| Key (env) | Default | Read by |
|---|---|---|
| `storage.iceberg.table.plan-namespace` (`STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`) | `execution-plan` | Dashboard, unit |
| `storage.input-links.s3-endpoint` (`STORAGE_INPUT_LINKS_S3_ENDPOINT`) | `""` = `storage.s3.endpoint` | Dashboard |
| `storage.input-links.ttl-seconds` (`STORAGE_INPUT_LINKS_TTL_SECONDS`) | `604800` (clamped to it) | Dashboard |
| `storage.input-links.path-style-access` (`STORAGE_INPUT_LINKS_PATH_STYLE_ACCESS`) | `true` | Dashboard |
| `storage.input-links.allowed-endpoints` (`STORAGE_INPUT_LINKS_ALLOWED_ENDPOINTS`, comma-separated) | `""` = `storage.s3.endpoint` | unit |
| `constants.max-listed-files` (`CONSTANTS_MAX_LISTED_FILES`) | `10000` | Dashboard compile |
| `udf.python.environments.root` (`UDF_PYTHON_ENVIRONMENTS_ROOT`) | `/tmp/texera-python-environments` | unit |
| `udf.python.environments.install-timeout-minutes` (`UDF_PYTHON_ENVIRONMENTS_INSTALL_TIMEOUT_MINUTES`) | `30` | unit |

## 4. Behavior, step by step

**Create** (`ExecutionCreator`, Dashboard), in this order:
1. uid from the session.
2. The body parses (`logicalPlan` through the workflow modules) else 400; `wid` and
   `computingUnitId` present else 400.
3. Rights: `WorkflowAccess.hasReadAccess(wid, uid)` else 403;
   `ComputingUnitAccess.getComputingUnitAccess(cuid, uid) == WRITE` else 403 (an unknown unit
   answers 403); the unit row's `terminate_time` is null else 409.
4. Warehouse: `ExecutionResources.resolveLakekeeperWarehouseName(warehouseId, uid)` (moved from
   `WorkflowService`); its `IllegalArgumentException` → 400.
5. Replay source, when given: its row exists, belongs to `wid` (through `workflow_version`) and has
   a `log_location`; else 400.
6. Insert the row: `vid` latest, uid, cuid, whid, name, `environment_version`, status 0 explicitly,
   `starting_time` now; when `fault-tolerance.log-storage-uri` is set, `log_location` =
   `<root>/<wid>/<eid>/` (an UPDATE right after the insert, which returns the eid).
7. Build the context (wid, eid, the request's settings or the defaults, warehouse, `costHints` from
   `CostHintsLoader.load(wid, uid)`) and compile Strict with `RunBindings` for the creator:
   `FileResolver.forUser(uid)`, `FileResolver.repositoryVersionResolverForUser(uid)`, the
   deployment's mount root, `CompileSettings` (15), the input linker (16), the dataset lister (17),
   the environment resolver (20); the sub-DAG cut when exactly one `targetOperatorIds`.
   `WorkflowCompilationFailed` → status 4, 400. Any other failure → status 4, 500.
8. `PlanToRun.make` (1d's, extended) encodes the `ExecutionPlan`: the context with the compiler's
   `outputPortsNeedingStorage`, the plan, replay `{source eid, its log_location, interaction}`,
   replay log (step 6's location), inputs (from the compile result, sub-part 16).
9. `ExecutionPlanStore.writePlan(planUri, PlanRecord(…))` with `logical` = the request's
   plan JSON serialized before compiling, sidecars removed; `notification` when
   `emailNotificationEnabled` and the user has an email: `{email, workflowName, workflowUrl}`, the URL
   built from the request URI as `WorkflowEmailNotifier.createDashboardUrl` builds it today
   (`http://<host>[:port]/user/workspace/<wid>`). A failed write → status 4, 500.
10. `ExecutionResources.clearFinishedExecutions(wid, cuid, exceptEid = eid)`: every execution of
    `wid` on `cuid` with status 3, 4 or 5 that still has a row in `operator_port_executions` or
    `operator_executions` gets `clearExecutionResources` (moved from `WorkflowService`); failures
    are logged, not answered.
11. 201 `{eid, wid, computingUnitId, planUri}`.

**Start** (`WorkflowService.startStoredExecution`, unit; the same function serves the socket and the
agent's REST path):
1. The caller's uid is required.
2. URI checks, before any catalog is opened (`StoredExecutionStart.checkUri`): `decodeURI(planUri)`
   gives type `PLAN`, eid = `executionId`, wid = the socket's workflow (REST path: the workflow the
   URI names); its warehouse is absent or matches `user-<uid>-<digits>`, and
   `WarehouseReadGuard.assertReadable(planUri)` passes.
3. `ExecutionPlanStore.readPlan(planUri)`; a missing table → refused ("execution 345 has no stored
   plan").
4. Row checks: `kind` plan, `formatVersion` = `PhysicalPlanCodec.FormatVersion`, `createdBy` = uid,
   `computingUnitId` = the socket's cuid (REST path: the body's `computingUnitId`).
5. Decode the body; its eid and wid equal the URI's; the earliest `inputs[].expiresAtMs` is in the
   future.
6. Under the `WorkflowService`'s lock: `ExecutionPlanStore.claimStart(planUri)`; already started →
   refused.
7. Supersede: if this `WorkflowService` holds a run whose state is not COMPLETED, FAILED, KILLED or
   TERMINATED, shut its client down, stamp its end time, write KILLED for it (one UPDATE by its eid),
   then unsubscribe it; a finished run is only unsubscribed.
8. Build the run: the decoded context with `cuid = Some(socket cuid)` until sub-part 20 (D29);
   `CoordinatorConfig` with `stateRestoreConfOpt` from `replay` and `faultToleranceConfOpt` from
   `replayLog`; `requireRunnableUnder(plan, mountRoot)` (repository mounts, 1b) and, from sub-part
   20, `requireEnvironmentsResolved`; `WorkflowMetricsRecorder.onStart(eid)`; construct
   `WorkflowExecutionService` with the plan, the row and `planUri`; publish it.
9. Create the `AmberClient` and the services; READY (one UPDATE, status 0); from sub-part 20,
   install the plan's environments; then, if the run is still wanted, `startWorkflow`.

A refusal at 1–6 sends one `WorkflowErrorEvent` to the caller only and writes nothing (D33).

**Environment install** (`PythonEnvironmentInstaller`, unit, sub-part 20), for each distinct spec in
the plan, in plan order:
1. Validate every line with `PythonRequirements` (D24) and recompute the digest; a mismatch fails.
2. Key = first 32 hex chars of `sha256(digest + "\n" + engine identity)`. Engine identity, once per
   JVM: run the engine interpreter with a short script that prints JSON
   `{executable: realpath(sys.executable), version: sys.version, platform: platform.platform(),
   siteDirs: site.getsitepackages() + [site.getusersitepackages()] if site.ENABLE_USER_SITE and it is
   a directory}`, then `<engine python> -m pip freeze --all`; identity = sha256 of both outputs.
3. `<root>/<key>/texera-environment.json` exists → reuse.
4. Otherwise single flight: a JVM map from key to the install's future; the first caller runs the
   install on the installer's executor (2 threads), every other caller waits on the same future. The
   install takes the file lock `<root>/<key>.lock`, checks the marker again, deletes any half-built
   `<root>/<key>`, runs `<engine python> -m venv <root>/<key>`, writes
   `<root>/<key>/lib/pythonX.Y/site-packages/texera-engine-site.pth` with one
   `import site; site.addsitedir(r'<dir>')` line per engine site directory, writes
   `texera-requirements.txt` and `texera-constraints.txt` (the engine's freeze lines `name==version`
   without `-e`, `@`-URL and `pip` lines), runs `<root>/<key>/bin/python -m pip install --no-input
   --progress-bar off --disable-pip-version-check -r texera-requirements.txt -c texera-constraints.txt`
   (env `PYTHONUNBUFFERED=1`, `PIP_NO_INPUT=1`), runs `pip freeze --local` for the installed
   versions, and writes the marker (tmp file + `ATOMIC_MOVE`) with `{digest, engineIdentity,
   requirements, installed, seconds, finishedAt}`.
5. After 30 minutes the pip process tree is destroyed; a timeout or a failure removes `<root>/<key>`
   and fails the future with pip's last 200 lines. The map entry is removed when the future
   completes, so a later run retries a failed install.
6. Console messages on every operator of the waiting run that uses the environment:
   `PRINT "Installing Python environment 'ml' (3 packages)"` (or
   `"Waiting for Python environment 'ml', which another run is installing"`), every 30 s
   `PRINT "Still installing 'ml' (60 s)"`, then `PRINT "Python environment 'ml' is ready (41.2 s)"` or
   `PRINT "Python environment 'ml' reused"`, whose message body holds the installed versions and, for a
   fresh install, pip's output tail. On failure: `ERROR "Python environment 'ml' could not be
   installed"` with pip's last 200 lines; the run fails before start with
   `WorkflowFatalError(EXECUTION_FAILURE, "Python environment 'ml' could not be installed: <pip's last ERROR line>",
   details = pip's tail, operatorId = the first operator using it)`, and its console writers are
   closed so the messages reach the lake.
7. The run waits on all its installs without holding the socket thread. When they complete it starts
   the engine only if its client is still active and its state is not terminal (D36). A kill during
   the install (browser or agent) writes KILLED as today and ends the waiting; the install goes on.

**Change while paused** (Dashboard `OperatorUpdates`, then unit): Dashboard: the row by eid → wid,
uid, cuid, whid, status (unknown → 404); caller = creator, READ on wid and WRITE on cuid (else 403);
status not 3/4/5 (else 409); read the plan row's `logical` column and parse it; the operator must
exist (else 404); refuse loop-variable references (moved from
`ExecutionReconfigurationService.scala:103-114`); refuse a changed Python environment;
`Try(currentOp.runtimeReconfiguration(wid, eid, currentOp, newOp))`; bind with the creator's
bindings; `encodeUpdate`; `appendUpdate`. Unit: `executionId` = the running execution; read the
update row (kind update, version, `createdBy` = the run's creator); decode; `opId` in the running
plan; build the queued op as the running op with the new `opExecInitInfo` and mounts;
`requireResourcesBound`; queue it; on resume `UpdateExecutorRequest` and mounts as today
(`ExecutionReconfigurationService.scala:121-148`).

**Cleanup**: create clears finished executions (D8); the unit's idle cleanup clears the execution its
`WorkflowService` ran (D26); deletes drop plan tables (D38); the unit's TTL job is unchanged.

## 5. Sub-parts in commit order

Sizes: S < 300 lines, M 300–900, L > 900 (with specs). Every sub-part leaves the product working on
its own on top of the previous ones.

| # | Commit subject | Size | PR | Depends on |
|---|---|---|---|---|
| 1 | `feat(dao): name each service's database connections` | S | A | – |
| 2 | `refactor(amber): write run state without reading it first` | S | A | – |
| 3 | `feat(workflow-core): keep an execution's plan in the lake` | M | A | – |
| 4 | `feat(workflow-core): carry replay, cost hints and inputs in a stored plan` | M | A | 1d |
| 5 | `refactor(amber): hand the scheduler its cost hints` | S | A | 4 |
| 6 | `refactor(amber): run the plan the unit reads back from the lake` | L | A | 1d, 2, 3, 4, 5 |
| 7 | `fix(k8s): give the Dashboard its object-store settings` | S | B | – |
| 8 | `feat(workflow-compiler): fail a run compile with all errors` | S | B | – |
| 9 | `feat(amber): create executions at the Dashboard service` | L | B | 6, 7, 8 |
| 10 | `feat(amber): change a paused operator through the Dashboard` | M | B | 9 |
| 11 | `feat(amber): start a stored execution by id on the unit` | L | B | 6, 9, 10 |
| 12 | `feat(frontend): create an execution, then start it` | M | B | 11 |
| 13 | `feat(agent-service): create the execution before running it` | S | B | 11 |
| 14 | `feat(amber): drop the unit's compile path` | M | B | 12, 13 |
| 15 | `feat(workflow-operator): carry the CSV column limit in the plan` | S | C | 14 |
| 16 | `feat(amber, workflow-operator): read input files from links` | L | C | 7, 15 |
| 17 | `feat(workflow-operator): list a dataset version when planning` | M | C | 16 |
| 18 | `test(amber): pin a unit starting runs without Postgres reads` | M | C | 16, 17 |
| 19 | `feat(amber, frontend): edit Python environments at the Dashboard` | M | D | – |
| 20 | `feat(amber): install a run's Python environments on the unit` | L | D | 14, 15, 16, 19 |
| 21 | `feat(amber, frontend): drop Python environments from the unit` | M | D | 20 |

| PR | Title | Sub-parts | Users see | Harness gate (§7) |
|---|---|---|---|---|
| A | Store each run's plan in the lake | 1–6 | nothing | `ws`: a–e with Check E; g0 |
| B | Create executions at the Dashboard service | 7–14 | Run asks the Dashboard first; errors per operator before the unit is involved | `create-ws`: a–e, j, k, l1–l10, m, o, all with Checks C, E and F; g0 |
| C | Resolve a run's inputs when its plan is made | 15–18 | File Scan From Input narrowed; links | + f, f2; Checks A–F on every scenario; negative controls once |
| D | Carry Python environments in the plan | 19–21 | environments installed at Run | + g, h, i (g0 retired); Checks A–F on all; one local-dev environment run by hand |

PR D needs PR B and sub-parts 15 and 16, so it lands after PR C.

## 6. What users will notice

- Run first asks the Dashboard. A refused run (rights, warehouse, compile) fails before anything
  reaches the unit, with errors on the operators.
- A compile error no longer clears the previous run's results from the result panel.
- Clicking Run twice, or a reconnect, cannot run the same execution twice.
- A run replaced by a new one on the same unit is recorded as Killed (today its row stays Running).
- An execution's start time is when Run was clicked (create), so its duration includes environment
  installs and the moment between create and start.
- The first run with a new environment stays in "Initializing" while it installs. The console of each
  operator using it shows "Installing…", "Still installing…" every 30 s, then "ready" with the
  installed versions and pip's output; later runs say "reused"; a run that joins another run's
  install says so. This is the run's console; a separate run log arrives with step 3.
- A broken package list fails the run at start with pip's message.
- Environments are per user: a name resolves to the runner's own environments, and a missing one
  fails at Run on that operator. A collaborator running a shared workflow whose UDF names the owner's
  environment needs one of their own with that name (open decision 3).
- Existing environments whose package specs fall outside the new grammar (`~=`, `!=`, extras, comma
  lists, URLs) fail at Run until edited.
- The workspace "Python Environments" dialog is gone; environments are edited on the Environments page
  and installed when a run starts. The preinstalled-package list is no longer shown.
- File Lister lists only datasets the runner can read, and File Scan From Input reads only files
  listed by a File Lister upstream of it, never the unit's local files.
- Only the user who started a run can change its operators while it is paused.
- A run paused for more than 7 days fails when it next opens an input file.

## 7. Harness changes (`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e`)

### H1. Driver protocol (`driver/transport.py`, `driver/texera_api.py`, `driver/workflow.py`, `driver/e2e.py`)

- New transport `create-ws` (class `CreateStartTransport`, registered in `TRANSPORTS`; `ws` stays for
  the published-image baseline and for PR A):
  1. `POST {base}/api/executions` with the body of §3.4 (`emailNotificationEnabled: false`).
     201 → `{eid, planUri}`; 4xx/5xx → raise `CreateRefused(status, json)`.
  2. Open `/wsapi/workflow-websocket?wid&uid&cuid&access-token` as today; wait for the handshake's
     state event.
  3. Send `WorkflowStartRequest{executionId, planUri}` as the first marked command.
  4. Pause, resume, kill, pagination and heartbeat unchanged.
- `RunHandle` gains `eid` and `plan_uri` (`None` on `ws`, where the driver reads the eid back with
  `TexeraApi.latest_execution`) and `modify_operator(operator_json) -> dict`: `POST
  /api/executions/{eid}/updates`, then `OperatorUpdateRequest{executionId, updateId}`, then wait for
  `ModifyLogicResponse`; a 4xx raises `UpdateRefused`. `ws` implements it with the old
  `ModifyLogicRequest{operator}`.
- The reader records `ModifyLogicResponse` and `ModifyLogicCompletedEvent` (today they fall into
  `other`).
- `Transport.create_only(**kw) -> requests.Response`; `Transport.start_existing(wid, cuid, eid,
  plan_uri, token)` opens a socket as the token's user and sends only the start (for l5, l6, l8–l10);
  `RunHandle.send_raw(msg)`. `start_run` takes optional `replay_from` and `target_operator_ids`.
- `TexeraApi`: `create_execution`, `post_operator_update`, `list_environments`,
  `ensure_environment(name, packages)` (`/api/environments` from PR D; `/api/pve/db` before),
  `build_legacy_environment(cuid, name, packages)` (`/wsapi/pve` create, then install; waits for
  `__DONE__`), `register_user(name, email, password)`, `set_role(uid, role)` (admin
  `PUT /api/admin/user/update`), `terminate_unit(cuid)`, `execution_interactions(wid, eid)`,
  `list_executions(wid)`, `token_for(user)`.
- `workflow.py`: `file_lister(version_path)`, `file_scan_from_input(attribute, output_file_name)`,
  `text_input(lines)`, `python_udf(..., env_name=None)` (sets `defaultEnv: false` and `envName`).
- `e2e.py`: `--transport create-ws` (default for step-2 images), `--evidence`, `--legacy-env`
  (enables g0), `--negative-control`; setup of a second user `sce-e2e-other` (register; the admin
  sets role REGULAR; its own local unit and warehouse) and of a second local unit of the main user
  (`sce-e2e-unit-2`, same URI) for l9.

### H2. Stack (`stack/sce_stack.py`, `stack/sce-stack.sh`)

- `--pg-statement-log`: Postgres `command: ["postgres", "-c", "log_statement=all", "-c",
  "log_line_prefix=%m [%p] app=%a db=%d host=%h "]` (the compose service has no command today,
  `bin/single-node/docker-compose.yml:74-88`). Extended-protocol statements log their values on a
  following `DETAIL:  parameters: $1 = '…', …` line of the same pid.
- `--isolate-unit`: a second network `sce-unit-net` (not `internal`, so pip can reach the package
  index); the unit is attached only to it; Postgres, Lakekeeper, RustFS and nginx (and agent-service
  when kept) are on both networks with their aliases. The unit cannot resolve `file-service`,
  `texera-lakefs`, `dashboard-service` or `access-control-service`.
- `--with-replay-log`: `FAULT_TOLERANCE_LOG_STORAGE_URI=file:///amber/user-resources/recovery-logs/`
  for dashboard-service and the unit (both mount `workflow_result_data` there).
- `--unit-env KEY=VAL` (repeatable; for example `WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS=2`,
  `USER_JWT_TOKEN=…` for the negative control).
- The generator's round-trip check accepts these edits; `MANIFEST.json` records them.
- `images/build.sh`: build with `--frontend` from PR B on (protocol change). The unit base image
  already has `python3-venv`. agent-service is not rebuilt (the harness drives the unit's REST path
  directly in scenario o; agent-service's own suite covers sub-part 13).

### H3. Scenarios (`driver/scenarios.py`)

| Key | Name | From PR | What it does | Checks |
|---|---|---|---|---|
| g0 | `environment-legacy` | A–C (`--legacy-env`) | precondition: `docker exec <unit> python3 -c "import tabulate"` fails; environment `sce-env0-<hex>` built through `/api/pve/db` and `/wsapi/pve` (create, then install `tabulate==0.9.0`; slow, installs amber's requirements); UDF with that `envName` outputs `tabulate.__version__` | Completed; the row says `0.9.0` (a silent fallback would fail the import) |
| f | `file-lister-scan` | C | File Lister (the e2e dataset v1) → File Scan From Input (single string, include file name) | Completed; 3 rows; file names are the three logical paths; no value contains `http`; contents equal the uploaded bytes |
| f2 | `file-scan-needs-lister` | C | Text Input of a dataset path → File Scan From Input | create 400; `operatorErrors` names the File Scan |
| g | `environment-install` | D | precondition as g0; environment `sce-env-<hex>` = `{tabulate: ==0.9.0}` through `/api/environments`; UDF outputs `tabulate.__version__`; run twice | 1st: Initializing until the install ends; the UDF's console has "Installing" then "ready" with `tabulate==0.9.0`; rows show 0.9.0; status 3. 2nd: "reused", no "Installing", start-to-Running shorter; one directory with `texera-environment.json` under `/tmp/texera-python-environments` |
| h | `environment-broken` | D | environment `{sce-e2e-nonexistent-<hex>: ==1.0.0}` | Failed (wait with fail-fast off); fatal error contains "could not be installed" and "No matching distribution found"; the UDF emitted 0 rows; status 4; no directory left for that key |
| i | `environment-missing` | D | UDF names `sce-missing-<hex>` | create 400; the UDF's operator error names the environment; that row status 4; no unit statement for its eid |
| j | `modify-while-paused` | B | numbers.csv → UDF tagging `v1`, 0.05 s per tuple; pause; change the code to tag `v2`; resume | update 200 and `ModifyLogicResponse.isValid`; `ModifyLogicCompletedEvent`; Completed with 300 rows, some `v1`, some `v2`; the second user's update 403; an update after Completed 409 |
| k | `compile-error-from-create` | B | Projection of a missing column | create 400 with the Projection in `operatorErrors`, message names the column; that row status 4; no unit statement for its eid |
| l | `rights-refusals` | B | l1 unknown unit; l2 other user + texera's workflow; l3 other user + texera's unit; l4 terminated unit; l5 other user starts texera's created execution on a socket; l6 start naming another execution's `planUri`; l7 warehouse of another user; l8 start a completed execution again; l9 start on a socket for texera's second unit a plan created for the first; l10 a `planUri` naming another user's warehouse | l1–l3 403, l4 409, l7 400, and no new row; l5, l6, l9, l10 `WorkflowErrorEvent` on that socket only, never Running, row stays 0, no unit statement for the eid; l8 `WorkflowErrorEvent` "already started", row stays 3, no unit statement |
| m | `replay` | B | refusals always: source without a log, source from another workflow (400); with `--with-replay-log`: run, list interactions, create a replay, start | refusals 400; replay create 201 and the run reaches a non-failed state |
| o | `agent-sync-run` | B | create with `targetOperatorIds` [Filter]; `docker exec <unit> curl -X POST http://localhost:8085/api/execution/<eid>/run` with the token and `{planUri, computingUnitId, …}` | `success`, state Completed, Filter's rows exact; a repeat of the call → `success: false`, "already started" |

### H4. Evidence (`driver/evidence.py`, new; `--evidence`, every `create-ws` scenario)

- Marks: before create, before start and after the terminal state the driver runs
  `docker exec sce-texera-postgres psql -U texera -d texera_db -Atc "SELECT 'sce-mark:<scenario>:<phase>:<eid>'"`;
  the log is cut between marks and statement boundaries, so no clock comparison is needed.
- Parsing: `LOG:  statement:` and `LOG:  execute <name>:` lines (with continuation lines) joined
  with the next `DETAIL:  parameters:` line of the same pid; keep `db=texera_db`; drop empty
  statements (pgjdbc validation) and `BEGIN/COMMIT/ROLLBACK/SET/SHOW`; tables are read after
  `from|join|into|update`, quoted or not.
- Attribution: a statement is the unit's when `app=texera-computing-unit` or, with `--isolate-unit`,
  `host=<the unit's address on sce-unit-net>`. Check F: every statement from the unit's address
  carries `app=texera-computing-unit` (a connection the pool did not name would otherwise go
  unnoticed); it holds from sub-part 1 on.
- Start window: from the start mark to the unit's first `UPDATE workflow_executions … status …
  WHERE … eid` whose parameters put the status at 1, 4 or 5 and the eid at the scenario's (RUNNING
  or an early FAILED/KILLED). The run's own result reads come only after RUNNING
  (`ExecutionResultService.scala:286-313`), so they cannot fall inside.
- Check A (start window): no unit statement starts with `SELECT` or `WITH`; every unit statement is
  an INSERT or UPDATE on `workflow_executions`, `operator_port_executions` or `operator_executions`.
- Check B (start mark → the unit's terminal status UPDATE for the eid): unit statements touch no other
  table (`dataset`, `dataset_version`, `user`, `site_settings`, `virtual_environments`,
  `user_warehouse`, `workflow`, `workflow_version`, `workflow_computing_unit`, …).
- Check C: the only `INSERT INTO workflow_executions` for the scenario comes from `app=texera-dashboard`.
- Check D (no file service, no LakeFS), with `--isolate-unit`:
  `docker exec <unit> getent hosts file-service texera-lakefs` finds neither, and the unit's log since
  the start mark names none of `file-service`, `texera-lakefs`, `:9092`, `:8000/api/v1`.
- Check E (PR A on): from the dashboard container, Lakekeeper's REST API
  (`GET /catalog/v1/config?warehouse=<name>` for the prefix, then the table under namespace
  `execution-plan`) shows `wid_<wid>_eid_<eid>_plan` with a ref named `started`.
- Before each scenario the driver waits (up to 15 s) until the unit's
  `DELETE FROM operator_executions WHERE workflow_execution_id = $1` for the previous scenario's eid
  appears in the log; the unit runs with `WEB_SERVER_WORKFLOW_STATE_CLEANUP_IN_SECONDS=2`.
- After all scenarios: no row of the e2e workflows is left at status 0, except the rows whose start a
  scenario refused on purpose (l5, l6, l9, l10).
- The report stores every unit statement of each window.

### H5. Negative controls (`--negative-control`, once per gate from PR C on)

Run scenario a against the published images with `ws`, `--isolate-unit`, `--pg-statement-log` and
`--unit-env USER_JWT_TOKEN=<texera's token>` (the K8s file-service path). Check A must fail (the old
unit SELECTs while starting), Check D must fail (the old unit names `file-service`) and Check F must
fail (the old unit's connections carry no name; its statements are found by its address). The report
records "controls failed as expected"; a control that passes fails the gate.

## 8. Deployment changes per mode

| Mode | Change | Sub-part |
|---|---|---|
| Single-node | dashboard-service `depends_on` lakekeeper (healthy), lakekeeper-init (completed), lakefs (healthy): it compiles and writes plans | 9 |
| Single-node | nginx `location = /api/executions` with `proxy_read_timeout 120s` | 9 |
| Single-node | none for links: the Dashboard's and the unit's `STORAGE_S3_ENDPOINT` are both `http://texera-rustfs:9000` (`.env:64`); the Dashboard's S3 keys must read LakeFS's bucket (both are RustFS's keys) | – |
| Single-node | delete `location /api/pve/` from `bin/single-node/nginx.conf` (`:121-125`); `/api/environments` reaches the Dashboard through `/api/` | 21 |
| Single-node | none for environments: venvs go to the unit's `/tmp`, reinstalled after a container restart | – |
| K8s | webserver `STORAGE_S3_ENDPOINT/REGION/AUTH_USERNAME/AUTH_PASSWORD` from the `texera.s3.*` helpers (as `5eb38a191` in `cu-dashboard-dispatch`); pool-namespace pods reach the same `<release>-rustfs-svc` name through the existing ExternalName alias, so links signed for that host work | 7 |
| K8s | gateway rule `Exact /api/executions` + POST, 120 s, to webserver-svc | 9 |
| K8s | webserver `TEXERA_MOUNT_IN_POD_ROOT` = `mounter.podMountRoot` when `mounter.enabled` | 9 |
| K8s | remove `PathPrefix /api/pve` from the dynamic HTTPRoute (`gateway-routes.yaml:179-181`); remove the pve paths from `AccessControlResource` | 21 |
| K8s | unit pods and agent-service: unchanged settings (the agent still calls the unit at `EXECUTION_ENDPOINT_TEMPLATE`, now `/api/execution/{eid}/run`; it already has `TEXERA_DASHBOARD_SERVICE_ENDPOINT`) | 13 |
| Local dev | `frontend/proxy.config.json`: `/api/executions` with `proxyTimeout: 120000` | 9 |
| Local dev | delete the `/api/pve` entry from `frontend/proxy.config.json` (`:73-77`); nothing in `bin/local-dev/main.sh` (the native Dashboard already gets the S3 and LakeFS settings) | 21 |
| All | units need egress to the package index for environment installs (allowed until step 5) | 20 |
| Slurm / EC2 later | set `STORAGE_INPUT_LINKS_S3_ENDPOINT` (Dashboard) and `STORAGE_INPUT_LINKS_ALLOWED_ENDPOINTS` (unit) to an endpoint those units reach; a writable `UDF_PYTHON_ENVIRONMENTS_ROOT`; index egress | – |

Verification per PR: single-node through the harness; K8s on OrbStack by hand for PRs B and C (create
through the gateway, a CSV run, a File Lister run; starting OrbStack's Kubernetes restarts Docker, so
warn the user first); local-dev by hand for PR D (an environment run with the engine on `venv312`,
the C19 case).

## 9. Risks and how each is tested

| Risk | Test |
|---|---|
| A run built from a stored plan alone has no unit id, so environments silently fall back until PR D (1d and sub-part 6 keep the run's own context, so they are not affected; sub-part 11's start by id is) | sub-part 11 sets the socket's cuid on the run's context (D29); `WorkflowServiceSpec` asserts it; harness g0 in the gates of PRs A–C |
| A catalog does not refuse the second `started` tag | `ExecutionPlanStoreSpec`: two threads claim on the JDBC catalog, exactly one wins; harness l8 and o (repeat) against Lakekeeper |
| Plan integrity: until step 5 units run user code with the unit's full lake access (and in single-node share one container), so code in one run could rewrite another execution's stored plan before it starts | none in step 2; trust in the stored plan rests on step 5 (per-execution namespace, per-run token); listed in the step-5 brief |
| Links point at a host units cannot reach, or the signature breaks behind a proxy | `ObjectStorePresignerSpec` pins the host; harness a–f read every input through links with the unit unable to reach LakeFS (Check D) |
| A link URL from a missed compile path makes the unit fetch an internal address | `LinkDocumentSpec`: a URL outside the allowed endpoints is refused before any connection; `WorkflowCompilerSpec`: a request's `inputLinks` is replaced on every `ReadsInputs` descriptor |
| A paused or long run outlives its links | `LinkDocumentSpec` (expired message); `StoredExecutionStartSpec` (expired plan refused); TTL clamp in `ObjectStorePresignerSpec` |
| Large File Lister listings bloat the plan and every File Scan worker's `descString`; in cluster mode a large `InitializeExecutorRequest` may exceed Pekko's frame size | `WorkflowCompilerSpec` cap at 10,000; codec spec with 10,000 inputs; cluster mode not tested in step 2 (noted) |
| Created but never started executions stay at status 0 and count as live for the K8s idle sweep (opt-in, off by default; same class as #8618) | harness final check (refused starts excepted); step 3's timer job closes them |
| A superseded run's writers fail when the next create clears it | cannot happen: create clears only finished runs; `ExecutionResourceSpec` pins that a status-1 run is untouched |
| The Dashboard now compiles: LakeFS reads, listing and presigning add latency to Run and load to the Dashboard | harness timings in the report; 120 s create timeout in all modes |
| Cost hints read a large statistics table on create | `CostHintsLoaderSpec` pins the cache (one read per source eid) |
| pip runs on the unit: slow first runs, index outages, package build code running with the unit's secrets until step 5 | g, h; `PythonEnvironmentInstallerSpec` timeout; listed for step 5 |
| The engine interpreter is a venv (local-dev, some curated images) | `PythonEnvironmentInstallerSpec` case with a venv engine interpreter (C19); local-dev run in PR D's verification |
| Concurrent runs install the same environment; a kill cancels a shared install | `PythonEnvironmentInstallerSpec`: two runs, one install; a killed waiter does not cancel it; the survivor starts |
| A user's pin conflicts with the engine's packages | constraint file; pip's resolver message reaches the fatal error (h shows the path) |
| Venv directories accumulate on long-lived units | none in step 2 beyond `/tmp`; listed for step 6 |
| Jersey refuses two resources at `/executions` | `TexeraWebApplicationSpec` boots the app and resolves both |
| Registering the workflow modules changes other Dashboard JSON | `TexeraWebApplicationSpec` and the existing Dashboard resource specs |
| A Dashboard newer than a unit (or older) | version check: `StoredExecutionStartSpec` |
| False done-when results from unrelated unit queries (idle cleanup, TTL job, pagination) | known-eid cleanup and pagination (D26), cleanup wait in the harness, window ends at the unit's own status UPDATE; the TTL job runs at boot + 2 s and daily |
| Local units share one JVM and one `WorkflowService` per workflow: a second local unit's socket on the same workflow uses the first unit's service | pre-existing, unchanged; l9 shows the start check still binds the plan to its unit |
| UDF dataset mounts still call access-control-service from the unit (K8s with the mounter on); export and `pytexera.DatasetFileDocument` still call file-service | outside the done-when (start path, single-node); listed for step 5 |

## 10. Open decisions for the owner

1. `pytexera.DatasetFileDocument` (UDF code reads a dataset file by path through file-service with
   the unit owner's token, K8s only; it raises without `USER_JWT_TOKEN`, so it does not work in
   single-node or local-dev today): keep it until step 5 removes the token (this design), or remove it
   in step 2, leaving File Lister + File Scan and dataset parameters (K8s mounter) as the ways to read
   dataset files.
2. File Scan From Input narrowed to files listed by an upstream File Lister (D13). The alternative is
   a new property on File Scan From Input naming the dataset versions it may read, which the Dashboard
   would list and link. This design takes the narrowing.
3. A Python environment name resolves to the runner's own environments only (this design). The
   alternative also looks at the workflow owner's environments when the runner has none of that name,
   so a collaborator can run a shared workflow without copying the owner's environment.

## 11. Implementation briefs

Each brief stands alone: goal, what it depends on, files, exact behaviour, tests and how to run
them, and when the sub-part is done. Paths are relative to the worktree root. Commit subjects follow
`AGENTS.md` (Conventional Commits, module scopes); commit messages end with the attribution lines the
session provides.

**Running tests (every brief).** The jOOQ classes are generated from a Postgres on
`localhost:5432` (user and password `postgres`), and amber specs that use the Postgres Iceberg
catalog need the same server:

```bash
docker run -d --name texera-tripwire-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 groonga/pgroonga:4.0.1-debian-15
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/texera_ddl.sql
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/iceberg_postgres_catalog.sql
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/texera_lakefs.sql
STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "<Module>/testOnly <fully.qualified.Spec> …"
```

sbt modules: `DAO` (common/dao), `Config`, `WorkflowCore`, `WorkflowOperator`, `WorkflowCompiler`,
`WorkflowExecutionService` (amber: both the Dashboard service and the unit), `WorkflowCompilingService`,
`ComputingUnitManagingService`, `AccessControlService`. ScalaTest prints no per-test lines here; read
`<module>/target/test-reports/TEST-<suite>.xml`. Specs that start Python workers need
`UDF_PYTHON_PATH=<path to venv312>/bin/python`; integration specs (`amber/src/test/integration`) run
with `AMBER_TEST_FILTER=integration-only`. Frontend: `cd frontend && yarn install --immutable && npx
ng test --watch=false --test-file <spec path>`. Agent service: `cd agent-service && bun install && bun
test <spec paths> && bun run typecheck`. Remove the Postgres container afterwards (it clashes with
`bin/local-dev.sh`). Never run sbt in a worktree another agent is building in. Harness
(`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e`, see its `README.md`): build images
from a separate worktree checked out at the commit under test (`images/build.sh <worktree> <tag>`,
with `--frontend` from sub-part 12 on), then `./run-baseline.sh --reset --images sce/<tag> -- <driver
args>`.

### Brief 1. `feat(dao): name each service's database connections`

**Goal.** Every Postgres connection a service opens carries the service's name as
`application_name`, so the Postgres log and `pg_stat_activity` show which service sent a
statement. Nothing else changes.

**Depends on.** Nothing.

**Files.**
- `common/dao/src/main/scala/org/apache/texera/dao/SqlServer.scala`: the private constructor and
  `SqlServer.initConnection(url, user, password, applicationName: String = "texera")` take the
  name; the Hikari config sets `cfg.setPoolName(s"texera-hikari-$applicationName")` and
  `cfg.addDataSourceProperty("ApplicationName", applicationName)` (Hikari passes data-source
  properties to pgjdbc as connection properties when it is given a JDBC URL).
- Production callers pass a constant:
  `amber/src/main/scala/org/apache/texera/web/TexeraWebApplication.scala:110` → `"texera-dashboard"`;
  `amber/src/main/scala/org/apache/texera/web/ComputingUnitMaster.scala:145` → `"texera-computing-unit"`;
  `file-service/src/main/scala/org/apache/texera/service/FileService.scala:72` → `"texera-file-service"`;
  `computing-unit-managing-service/src/main/scala/org/apache/texera/service/ComputingUnitManagingService.scala:44` → `"texera-computing-unit-manager"`;
  `workflow-compiling-service/src/main/scala/org/apache/texera/service/WorkflowCompilingService.scala:64` → `"texera-workflow-compiling-service"`;
  `access-control-service/src/main/scala/org/apache/texera/service/AccessControlService.scala:51` → `"texera-access-control-service"`;
  `config-service/src/main/scala/org/apache/texera/service/ConfigService.scala:48` → `"texera-config-service"`;
  `notebook-migration-service/src/main/scala/org/apache/texera/service/NotebookMigrationService.scala:54` → `"texera-notebook-migration-service"`.
- Test callers (`common/dao/src/test/scala/org/apache/texera/dao/MockTexeraDB.scala:151`,
  `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala:244`) keep the default.

**Behaviour.** The names are constants, not configuration. `createDSLContext()` is unchanged.

**Tests.**
- `common/dao/src/test/scala/org/apache/texera/dao/SqlServerSpec.scala`: after
  `initConnection(jdbcUrl, "postgres", "", "texera-spec")`,
  `select current_setting('application_name')` through `createDSLContext()` returns `texera-spec`;
  without a name it returns `texera`.
- `amber/src/test/scala/org/apache/texera/web/TexeraWebApplicationSpec.scala` and
  `amber/src/test/scala/org/apache/texera/web/ComputingUnitMasterSpec.scala`: after `run()`, the same
  query returns `texera-dashboard` and `texera-computing-unit`.

**Run.** `sbt "DAO/testOnly org.apache.texera.dao.SqlServerSpec"`, then
`STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.TexeraWebApplicationSpec org.apache.texera.web.ComputingUnitMasterSpec"`.

**Done when.** The specs pass; once the harness has `--pg-statement-log` (§7 H2), every
`db=texera_db` line from a Texera service carries `app=texera-<name>`.

### Brief 2. `refactor(amber): write run state without reading it first`

**Goal.** The unit's run-state writes become single UPDATEs by eid, with no SELECT before them and
no subselect, so starting a run needs no Postgres read for state. The values written do not change.

**Depends on.** Nothing.

**Files.**
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionsMetadataPersistService.scala`: add
  `updateStatus(eid: ExecutionIdentity, status: Byte, at: Timestamp): Unit`
  (`UPDATE workflow_executions SET status = ?, last_update_time = ? WHERE eid = ?`) and
  `updateLogLocation(eid: ExecutionIdentity, location: String): Unit`; both log and swallow a failure
  the way `tryUpdateExistingExecution` does. Keep `tryUpdateExistingExecution`: the unit's TTL job
  (`ComputingUnitMaster.scala:250`) still uses it, and runs outside any start.
- `amber/src/main/scala/org/apache/texera/web/storage/ExecutionStateStore.scala`:
  `updateWorkflowState` calls `updateStatus(metadataStore.executionId, maptoStatusCode(state), now)`.
  Codes stay as `Utils.maptoStatusCode` gives them, -1 for PAUSING and RESUMING included.
- `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/WorkflowExecutionsResource.scala:280-297`:
  `updateRuntimeStatsUri(eid: Long, uri: URI)` =
  `UPDATE workflow_executions SET runtime_stats_uri = ? WHERE eid = ?` (drop the `wid` parameter and
  the `workflow_version` subselect).
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionStatsService.scala:88`: the new signature.
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala:289-291`: `updateLogLocation`.
- New test helper `common/dao/src/test/scala/org/apache/texera/dao/StatementRecorder.scala`: a jOOQ
  `ExecuteListener` installed in place on a `DSLContext`'s configuration
  (`context.configuration().set(new DefaultExecuteListenerProvider(recorder))`, so contexts derived
  from it, such as a transaction's, are covered) that records the SQL text, the thread and the first
  `org.apache.texera` frame of every statement while `record { … }` runs. Adapt
  `texera-worktrees/cu-dashboard-dispatch/amber/src/test/scala/org/apache/texera/web/PostgresUseRecorder.scala`.

**Behaviour.** One statement per state change; an unknown eid updates nothing and does not fail.

**Tests.**
- `amber/src/test/scala/org/apache/texera/web/service/ExecutionsMetadataPersistServiceSpec.scala`:
  `updateStatus` issues exactly one statement, an UPDATE, after which the row holds the status and
  time; unknown eid: no error; `updateLogLocation` likewise.
- `amber/src/test/scala/org/apache/texera/web/storage/ExecutionStateStoreSpec.scala`: a state change is
  one UPDATE and no SELECT.
- `amber/src/test/scala/org/apache/texera/web/resource/dashboard/user/workflow/WorkflowExecutionsResourceSpec.scala`:
  `updateRuntimeStatsUri` is one UPDATE by eid.
- `amber/src/test/scala/org/apache/texera/web/service/ExecutionStatsServiceSpec.scala`: built with the
  new signature.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.ExecutionsMetadataPersistServiceSpec org.apache.texera.web.storage.ExecutionStateStoreSpec org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResourceSpec org.apache.texera.web.service.ExecutionStatsServiceSpec"`.

**Done when.** The specs pass, and `git grep -n "tryUpdateExistingExecution" amber/src/main` shows only
the definition and the TTL job.

### Brief 3. `feat(workflow-core): keep an execution's plan in the lake`

**Goal.** One Iceberg table per execution holds its stored plan, the updates to its paused operators
and its start claim, behind a small API. Nothing calls it yet.

**Depends on.** Nothing.

**Files.**
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/VFSURIFactory.scala`:
  `VFSResourceType.PLAN = Value("plan")`; `createPlanURI(wid: WorkflowIdentity, eid: ExecutionIdentity,
  warehouse: Option[String] = None): URI` giving `vfs:///[wh/<w>/]wid/<wid>/eid/<eid>/plan` (through
  `createNonResultVFSURI`, no operator).
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/DocumentFactory.scala`:
  `resolveNamespace(PLAN) = StorageConfig.icebergTablePlanNamespace`; a package-private
  `icebergTableOf(uri): Option[org.apache.iceberg.Table]` (catalog `IcebergCatalogInstance.getInstance(warehouse)`,
  the namespace and table name the URI resolves to, `IcebergUtil.loadTableMetadata`).
- `common/config/src/main/resources/storage.conf`: under `storage.iceberg.table`,
  `plan-namespace = "execution-plan"` and `plan-namespace = ${?STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE}`;
  `common/config/src/main/scala/org/apache/texera/common/config/StorageConfig.scala`:
  `icebergTablePlanNamespace`.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/result/ResultSchema.scala`:
  `executionPlanSchema` = `entryId STRING, kind STRING, formatVersion INTEGER, body STRING,
  logical STRING, createdAt TIMESTAMP, createdBy INTEGER, computingUnitId INTEGER, notification STRING`.
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/ExecutionPlanStore.scala`
  (package `org.apache.texera.amber.core.storage`, because `IcebergDocument` is
  `private[storage]`):
  - `final case class PlanRecord(entryId: String, kind: String, formatVersion: Int, body: String,
    logical: String, createdAt: Timestamp, createdBy: Int, computingUnitId: Int, notification:
    Option[String])` with `toTuple`/`fromTuple` over `executionPlanSchema`.
  - `NoStoredPlanException(uri)`, `NoSuchUpdateException(uri, updateId)`,
    `ExecutionAlreadyStartedException(eid)` (message "execution <eid> was already started").
  - `planUri(wid, eid, warehouse): URI` = `VFSURIFactory.createPlanURI`.
  - `writePlan(uri, record)`: requires `entryId == "plan"` and `kind == "plan"`;
    `DocumentFactory.createDocument(uri, executionPlanSchema)` (replaces a stale table at that name),
    writer `"plan"`, `open`, `putOne(record.toTuple)`, `close`.
  - `readPlan(uri): PlanRecord`: `DocumentFactory.openDocument(uri)` (a missing table →
    `NoStoredPlanException`); read all rows; the one with `entryId == "plan"`, else
    `NoStoredPlanException`.
  - `appendUpdate(uri, record)`: requires `kind == "update"` and `entryId` starting `update-`; open
    the document; writer named `record.entryId`; one row; close.
  - `readUpdate(uri, updateId): PlanRecord`: the one row with that `entryId`, else
    `NoSuchUpdateException`.
  - `claimStart(uri)`: `icebergTableOf(uri)` (missing or no current snapshot →
    `NoStoredPlanException`), then
    `table.manageSnapshots().createTag("started", table.currentSnapshot().snapshotId()).commit()`.
    Iceberg raises `IllegalArgumentException("Ref started already exists")` when the loaded table
    already has the tag → `ExecutionAlreadyStartedException`. When two claims race, the loser's commit
    fails (`CommitFailedException`: the REST catalog's `assert-ref-snapshot-id` requirement, or the
    JDBC catalog's metadata-pointer swap; Iceberg's retry re-applies the operation on its stale base
    and fails again): reload the table, and if it has the tag → `ExecutionAlreadyStartedException`,
    otherwise rethrow.
  - `isStarted(uri): Boolean` = the table's refs contain `started`.
  - `drop(uri)`: `DocumentFactory.openDocument(uri)._1.clear()` (drops the table and its tags); a
    missing table is a no-op.
- `amber/src/main/python/core/storage/vfs_uri_factory.py`: `PLAN = "plan"` in `VFSResourceType`, so
  both URI parsers accept the same URIs.

**Behaviour.** Strings are stored as given; `createdAt` is a wall-clock TIMESTAMP like the other
Texera tables. No retries beyond Iceberg's commit retries (the table properties
`IcebergUtil.createTable` sets).

**Tests.**
- `common/workflow-core/src/test/scala/org/apache/texera/amber/core/storage/VFSURIFactorySpec.scala`:
  build and decode with and without a warehouse; the decode gives `PLAN`, the eid, the wid and the
  warehouse; a PLAN URI is not taken for another type, nor another type's for PLAN.
- `.../storage/DocumentFactorySpec.scala`: namespace `execution-plan`, table `wid_12_eid_345_plan`
  for both URI shapes.
- New `.../storage/ExecutionPlanStoreSpec.scala` (Postgres JDBC catalog): write then read a plan
  (every column, notification null and set); writing twice at one eid replaces; append two updates
  and read each; a missing update fails; a missing table fails with `NoStoredPlanException`;
  `claimStart` once succeeds and `isStarted` is then true; a second `claimStart` fails with
  `ExecutionAlreadyStartedException`; two threads claiming at once: exactly one succeeds; `drop`
  then `readPlan` fails; `drop` of a missing table is a no-op.
- `amber/src/test/python/core/storage/test_vfs_uri_factory.py`: a PLAN URI decodes.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.ExecutionPlanStoreSpec org.apache.texera.amber.core.storage.VFSURIFactorySpec org.apache.texera.amber.core.storage.DocumentFactorySpec"`;
`cd amber && python -m pytest src/test/python/core/storage/test_vfs_uri_factory.py`.

**Done when.** The specs pass; no production code calls the store yet.

### Brief 4. `feat(workflow-core): carry replay, cost hints and inputs in a stored plan`

**Goal.** Format 2 of the stored plan: the run-level fields the engine needs besides the physical
plan (replay source, replay-log location, cost hints, inputs), and a message for one paused
operator's update. No behaviour change: nobody fills the new fields yet.

**Depends on.** 1c (`b2e981d58`, committed) and 1d (`PlanToRun.make`,
`WorkflowExecutionService.readPlanToRun`), since this brief changes the codec's signatures they
call.

**Files.**
- `common/workflow-core/src/main/protobuf/org/apache/texera/amber/core/storedplan.proto`: add to
  `StoredPhysicalPlan`
  `StoredReplaySource replay = 8; optional string replayLogLocation = 9; StoredCostHints costHints = 10;
  repeated StoredPlanInput inputs = 11;` and the messages `StoredReplaySource{int64
  sourceExecutionId = 1; string logLocation = 2; string interaction = 3}`, `StoredCostHints{int64
  sourceExecutionId = 1; repeated StoredOperatorCost operators = 2}`, `StoredOperatorCost{string
  logicalOperatorId = 1; double seconds = 2}`, `StoredPlanInput{string logicalOperatorId = 1; string
  name = 2; oneof source { StoredInputFile file = 3; }}` (a comment keeps 4 for a reused result),
  `StoredInputFile{int64 expiresAtMs = 1; int64 sizeBytes = 2}`, and `StoredOperatorUpdate{int32
  formatVersion = 1; ExecutionIdentity executionId = 2; string updateId = 3; PhysicalOpIdentity opId
  = 4; OpExecInitInfo opExecInitInfo = 5; StoredRepositoryMounts repositoryMounts = 6}`. Each field
  carries a comment saying what its absence means, in 1c's style.
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/ExecutionPlan.scala`:
  `ReplaySource(sourceExecutionId: ExecutionIdentity, logLocation: URI, interaction: String)`,
  `InputFile(expiresAtMs: Long, sizeBytes: Long)`, `PlanInput(logicalOperatorId: OperatorIdentity,
  name: String, file: InputFile)`, `CostHints(sourceExecutionId: ExecutionIdentity,
  secondsByLogicalOperator: Map[String, Double])`, `ExecutionPlan(context: WorkflowContext, plan:
  PhysicalPlan, replay: Option[ReplaySource] = None, replayLog: Option[URI] = None, inputs:
  Seq[PlanInput] = Seq.empty)`, `OperatorUpdate(executionId, updateId, opId: PhysicalOpIdentity,
  opExecInitInfo: OpExecInitInfo, repositoryMounts: Option[RepositoryMounts])`. (Named apart from
  1d's `PlanToRun`, the saved text plus the logical plan on the amber side.)
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/WorkflowContext.scala`:
  `var costHints: Option[CostHints] = None`, a last constructor parameter with a default.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/PhysicalPlanCodec.scala`:
  `FormatVersion = 2`; `encode(plan: ExecutionPlan): StoredPhysicalPlan` and
  `decode(stored): ExecutionPlan` replace `encode(context, plan)` and the pair-returning `decode`
  (the decoded context has `cuid = None` and `costHints` set). Rules, refused both ways with 1c's
  `refuse`: replay `logLocation` absolute, `interaction` non-empty, source id > 0;
  `replayLogLocation` absolute; cost hints source id > 0, operators sorted by id, each once, seconds
  finite and ≥ 0 (encode sorts); inputs: each (operator, name) once, ordered by them (encode sorts),
  `expiresAtMs` > 0, `sizeBytes` ≥ 0, the `oneof` set. New `encodeUpdate(executionId:
  ExecutionIdentity, updateId: String, op: PhysicalOp): StoredOperatorUpdate` (refuses an op that
  still holds a resource binding, has no executor, belongs to another execution, or an empty
  `updateId`), `decodeUpdate(stored): OperatorUpdate`, `updateToJson`, `updateFromJson` with the
  plan's strictness (version first, then the exact form). Generalize the private JSON helpers
  (`withDefaultMessages`, `difference`, the version check) over the message companion so plan and
  update share them.
- `common/workflow-core/src/test/resources/storedplan/`: new goldens `physical-plan-v2.json` (every
  field set) and `operator-update-v2.json`; delete `physical-plan-v1.json` (a reader reads only its
  own version).
- `common/workflow-core/src/test/scala/org/apache/texera/amber/core/workflow/PhysicalPlanRoundTrip.scala`:
  `assertRoundTrips(plan: ExecutionPlan)`, plus `assertRoundTrips(context, plan)` wrapping
  `ExecutionPlan(context, plan)` for the existing callers (1c's specs and `WorkflowCompilerSpec`).
- 1d's callers: `amber/src/main/scala/org/apache/texera/web/service/PlanToRun.scala`
  (`encode(ExecutionPlan(compiled.context, compiled.physicalPlan))`) and
  `WorkflowExecutionService.readPlanToRun` (`decode(…)` gives an `ExecutionPlan`; compare its
  `context`, return its `plan`).

**Behaviour.** A plan with none of the new fields prints no `replay`, `replayLogLocation` or
`costHints` and `"inputs": []`. A format 1 text is refused with "The plan is in format version 1, but
this reader reads version 2."

**Tests.**
- `common/workflow-core/src/test/scala/org/apache/texera/amber/core/workflow/PhysicalPlanCodecSpec.scala`:
  every new field round trips, and each one absent; each malformed value above is refused on read;
  the golden v2 file is exactly what the encoder prints for its plan; a v1 text is refused with the
  version message; an update round trips through message and JSON; an update for a bound op, for
  another execution, or with an empty id is refused; `updateFromJson` refuses an extra field, a
  missing field and another version.
- `common/workflow-compiler/src/test/scala/org/apache/texera/common/compiler/WorkflowCompilerSpec.scala`:
  unchanged expectations through the wrapper.

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.workflow.PhysicalPlanCodecSpec" "WorkflowCompiler/testOnly org.apache.texera.common.compiler.WorkflowCompilerSpec"`,
then `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.WorkflowExecutionServiceSpec"`.

**Done when.** The specs pass; `physical-plan-v2.json` is the only plan golden.

### Brief 5. `refactor(amber): hand the scheduler its cost hints`

**Goal.** The scheduler's cost model reads past statistics from the run's context. The engine no
longer queries Postgres or opens a statistics table; the web layer computes the hints (on the unit in
PR A, on the Dashboard from sub-part 9).

**Depends on.** 4 (`CostHints`, `WorkflowContext.costHints`).

**Files.**
- New `amber/src/main/scala/org/apache/texera/web/service/execution/CostHintsLoader.scala`:
  `load(wid: Long, uid: Int): Option[CostHints]`. One SELECT: `eid, runtime_stats_uri` of the newest
  (`starting_time` descending) execution of `wid` (through `workflow_version`) with `status = 3`,
  `uid = uid` and a non-empty `runtime_stats_uri`. Skip a URI that `WarehouseReadGuard.skipWhileDisabled`
  refuses. Open the document and fold, per operator id (field 0),
  `max((dataProcessingTime + controlProcessingTime) / 1e9)` (fields 6 and 7 of
  `ResultSchema.runtimeStatisticsSchema`), as `CostEstimator.scala:120-164` does today. Empty →
  None. Cache by source eid (256 entries, LRU; a finished run's statistics never change). Any
  failure is logged and gives None. A protected `openStatistics(uri)` seam lets the spec count opens.
- `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/CostEstimator.scala`:
  `DefaultCostEstimator` takes the estimates from `workflowContext.costHints.map(_.secondsByLogicalOperator)`;
  delete `getOperatorExecutionTimeInSeconds` and the `SqlServer`, jOOQ table and `DocumentFactory`
  imports; keep the log line for "no past execution statistics".
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala`: after creating the run's
  context, `workflowContext.costHints = CostHintsLoader.load(wid, uid)`, so the hints are encoded
  into the stored plan.

**Behaviour.** The same cost model. The source run is now the same user's newest completed run, a
deliberate narrowing: no statistics from another user's warehouse enter this user's plan. Without
one, a region costs the number of its ports whose results are stored, as before.

**Tests.**
- `amber/src/test/scala/org/apache/texera/amber/engine/architecture/scheduling/DefaultCostEstimatorSpec.scala`:
  with hints, a region costs its longest operator; without, the number of port configs; the spec uses
  no database (no `MockTexeraDB`).
- New `amber/src/test/scala/org/apache/texera/web/service/execution/CostHintsLoaderSpec.scala`
  (`MockTexeraDB` + Postgres JDBC catalog): the newest COMPLETED run of the same user is chosen; a
  newer completed run of another user is ignored; FAILED runs are ignored; an empty statistics table
  gives None; a second load of the same source does not reopen the table.
- `CostBasedScheduleGeneratorSpec`: unchanged results with hints set on the context.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.amber.engine.architecture.scheduling.DefaultCostEstimatorSpec org.apache.texera.web.service.execution.CostHintsLoaderSpec org.apache.texera.amber.engine.architecture.scheduling.CostBasedScheduleGeneratorSpec"`.

**Done when.** The specs pass, and `git grep -ln "SqlServer\|WorkflowExecutionsResource" -- amber/src/main/scala/org/apache/texera/amber/`
lists no scheduling file (only `PythonWorkflowWorker.scala` remains, for `PveManager`, until
sub-part 20).

### Brief 6. `refactor(amber): run the plan the unit reads back from the lake`

**Goal.** Every run goes through the lake. The unit, which still compiles in PR A, writes the
compiled plan and the run's record to the execution's plan table, claims it, reads it back and runs
what it read, with the replay, replay-log and notification settings taken from what it read. Also
the PR-A-sized cleanups: the superseded run is written KILLED, the idle cleanup and result pagination
use the execution the service holds, deletes drop plan tables, and `lastCompletedLogicalPlan` goes.
Users see no change.

**Depends on.** 1d, 2, 3, 4, 5.

**Files.**
- `amber/src/main/scala/org/apache/texera/web/service/PlanToRun.scala` (1d): `make(compiler,
  context, logicalPlan, replay: Option[ReplaySource] = None, replayLog: Option[URI] = None)` encodes
  `ExecutionPlan(compiled.context, compiled.physicalPlan, replay, replayLog)`.
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala`:
  - Constructor: replace `coordinatorConfig` and `userEmailOpt` by `replay: Option[ReplaySource]`,
    `replayLog: Option[URI]`, `notificationRequested: Boolean`, `userEmail: Option[String]`; keep
    the rest (1d's `makePlanToRun` seam included).
  - `executeWorkflow()`: `planToRun = makePlanToRun(compiler)` (passing `replay`, `replayLog`); build
    the plan row `PlanRecord("plan", "plan", PhysicalPlanCodec.FormatVersion, planToRun.savedPlan,
    logical = the request's `LogicalPlanPojo` JSON (`objectMapper.writeValueAsString`, done before
    the compile mutates the operators), now, uid, workflowContext.cuid.get, notification)` where
    notification = when `notificationRequested` and an email is known,
    `{"email", "workflowName": WorkflowResource.getWorkflowName(wid), "workflowUrl"}` with the URL
    built from `sessionUri` exactly as `WorkflowEmailNotifier.createDashboardUrl` builds it today;
    `planUri = ExecutionPlanStore.planUri(wid, eid, workflowContext.warehouse)`;
    `ExecutionPlanStore.writePlan(planUri, record)`; then `runStoredPlan(planUri)`.
  - New `runStoredPlan(planUri)`: `ExecutionPlanStore.claimStart(planUri)`;
    `val stored = ExecutionPlanStore.readPlan(planUri)`;
    `val executionPlan = WorkflowExecutionService.readPlanToRun(stored.body, workflowContext, mountRoot)`
    (1d's checks against the run's own context; it now returns the decoded `ExecutionPlan`);
    `CoordinatorConfig.default` with `stateRestoreConfOpt = executionPlan.replay.map(r =>
    StateRestoreConfig(r.logLocation, EmbeddedControlMessageIdentity(r.interaction)))` and
    `faultToleranceConfOpt = executionPlan.replayLog.map(FaultToleranceConfig(_))`; the email notifier
    from `stored.notification`; then the client, the services, READY and `startWorkflow` as today. Any
    failure goes to `errorHandler` as today. Keep `planUri` on the service (sub-part 11 reads updates
    from it).
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala`:
  - `initExecutionService`: uid and warehouse as today; `supersedeCurrentRun()` instead of a bare
    `unsubscribeAll()`; clear the previous execution and insert as today; replay source and replay-log
    location computed as today (`tryGetExistingExecution` for the source's `log_location`,
    `ApplicationConfig.faultToleranceLogRootFolder` for the write location, written with
    `updateLogLocation`) and passed to `WorkflowExecutionService` instead of a `CoordinatorConfig`;
    `workflowContext.costHints` (sub-part 5).
  - New `supersedeCurrentRun()`: when `executionService` holds a run whose state is not COMPLETED,
    FAILED, KILLED or TERMINATED: `client.shutdown()` (when created), stamp its stats end time,
    `updateWorkflowState(KILLED, …)` on its metadata store (one UPDATE by its eid), then
    `unsubscribeAll()` on it; a finished run is only unsubscribed.
  - Idle cleanup (the `WorkflowLifecycleManager` callback): clear the execution this service holds
    (`executionService.getValue.workflowContext.executionId`), not `getLatestExecutionId`; nothing
    when it holds none.
  - Delete `lastCompletedLogicalPlan` and its diff handler (no reader).
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionRuntimeService.scala` and
  `WorkflowEmailNotifier.scala`: the notifier takes `(workflowId, email, workflowName, workflowUrl)`;
  no `WorkflowResource.getWorkflowName` and no `sessionUri` inside it.
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionResultService.scala`:
  `attachToExecution` remembers the execution id; `handleResultPagination` uses it, and calls
  `getLatestExecutionId(wid, cuid)` only when the service has attached to none (after a unit restart).
- `amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala`:
  `shutdownPreviousExecution` calls `workflowService.supersedeCurrentRun()`.
- New `amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionResources.scala`:
  `planUriOf(eid): Option[URI]` (one SELECT joining `workflow_executions`, `workflow_version` and
  `user_warehouse` on `whid`; a null `whid` means the default warehouse).
- `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/WorkflowExecutionsResource.scala`
  `removeAllExecutionFiles`: collect each execution's plan URI before deleting the rows and
  `ExecutionPlanStore.drop` them with the other documents (skipping those
  `WarehouseReadGuard.skipWhileDisabled` refuses). This also covers quota delete
  (`UserQuotaResource.scala:168`).
- `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/WorkflowResource.scala`
  `deleteWorkflow` (`:628-690`): collect the plan URIs with the other URIs before the transaction and
  drop them after it.
- `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala`: `buildWorkflow` (1d's
  `fromSavedPlan`) keeps the in-memory round trip; e2e specs do not need a catalog for plans.

**Behaviour.** Every run creates its plan table and the `started` tag before the engine starts. A
replayed run and a run with email notification behave as today. The superseded run's row reads
Killed instead of staying Running.

**Tests.**
- `amber/src/test/scala/org/apache/texera/web/service/WorkflowExecutionServiceSpec.scala` (Postgres
  JDBC catalog): the plan row's columns (createdBy, computingUnitId, notification null and set, the
  logical JSON is the request as sent); the engine is handed the plan read back from the lake (a
  seam captures it; it equals the decoded body); the table carries `started`; replay and replay-log
  configs come from the stored plan; a failed plan write fails the run through `errorHandler`.
- `amber/src/test/scala/org/apache/texera/web/service/WorkflowServiceSpec.scala`: a live previous run
  is written KILLED (one UPDATE by its eid) and a finished one is not; the idle cleanup clears the held
  execution and nothing else; `lastCompletedLogicalPlan` is gone.
- `amber/src/test/scala/org/apache/texera/web/service/ExecutionResultServiceSpec.scala`: pagination
  reads the attached execution even when a newer row exists for (wid, cuid).
- `WorkflowExecutionsResourceSpec`: `removeAllExecutionFiles` drops the plan table;
  `amber/src/test/scala/org/apache/texera/web/resource/dashboard/file/WorkflowResourceSpec.scala`:
  `deleteWorkflow` drops its executions' plan tables; `UserQuotaResourceSpec` likewise.
- `SyncExecutionResourceSpec`: the previous run is written KILLED.
- `WorkflowEmailNotifierSpec`, `ExecutionRuntimeServiceSpec`: name and URL are given.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.* org.apache.texera.web.resource.*"`;
`UDF_PYTHON_PATH=… AMBER_TEST_FILTER=integration-only sbt "WorkflowExecutionService/testOnly org.apache.texera.amber.engine.e2e.*"`.
Harness: images from this commit; `./run-baseline.sh --reset --images sce/<tag> -- --transport ws`
with Check E, and once with `--legacy-env --scenario g0`.

**Done when.** The specs pass; harness `ws` a–e pass and Check E finds each scenario's plan table
with its `started` tag; g0 passes (the environment's package is imported, no fallback).

### Brief 7. `fix(k8s): give the Dashboard its object-store settings`

**Goal.** On Kubernetes the webserver (the Dashboard service) gets the object-store endpoint,
region and credentials the unit manager gets. From sub-part 9 it clears runs, which deletes their
large binaries in the object store, and from sub-part 16 it presigns input links; without these
settings it falls back to `localhost:9000` and the deletion fails silently (`LargeBinaryManager.scala:91-105`).

**Depends on.** Nothing.

**Files.** `bin/k8s/templates/base/webserver/webserver-deployment.yaml`: after
`STORAGE_ICEBERG_CATALOG_REST_S3_BUCKET` add

```yaml
            # Object storage: the Dashboard deletes a run's large binaries when it clears the run,
            # registers each user's warehouse against this store, and presigns input links.
            - name: STORAGE_S3_ENDPOINT
              value: {{ include "texera.s3.endpoint" . }}
            {{- if .Values.storage.s3.endpoint }}
            - name: STORAGE_S3_REGION
              value: {{ .Values.storage.s3.region | quote }}
            {{- end }}
            - name: STORAGE_S3_AUTH_USERNAME
              valueFrom:
                secretKeyRef:
                  name: {{ include "texera.s3.secretName" . }}
                  key: {{ include "texera.s3.accessKeyIdKey" . }}
            - name: STORAGE_S3_AUTH_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ include "texera.s3.secretName" . }}
                  key: {{ include "texera.s3.secretAccessKeyKey" . }}
```

(the helpers are in `bin/k8s/templates/base/_helpers.tpl:31-57`; this is commit `5eb38a191` of
`texera-worktrees/cu-dashboard-dispatch`).

**Behaviour.** No code change.

**Tests.** The rendered webserver deployment carries the four variables with the chart's default
values, and with an external store (`--set storage.s3.endpoint=https://s3.example`), where the region
appears too.

**Run.** `helm dependency build bin/k8s` once (the chart pulls postgresql, rustfs, lakefs, gateway,
lakekeeper and metrics-server), then `helm lint bin/k8s`; `helm template t bin/k8s | grep -A4
"STORAGE_S3_"`; the same with `--set storage.s3.endpoint=https://s3.example`.

**Done when.** The rendered webserver has the four variables. On OrbStack (warn the user first:
starting OrbStack's Kubernetes restarts Docker), creating a warehouse succeeds and, after sub-part 9,
a create logs "Deleted large binaries for execution …" for a cleared run.

### Brief 8. `feat(workflow-compiler): fail a run compile with all errors`

**Goal.** A Strict compile reports every operator's error at once, each attributed to its
operator, so create can answer 400 with errors per operator.

**Depends on.** Nothing.

**Files.**
- `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/WorkflowCompiler.scala`:
  Strict uses an error buffer like Lenient (`compile`, `:449-500`). After file resolution, expansion
  and schema collection, any error → throw `WorkflowCompilationFailed` built with
  `convertErrorListToWorkflowFatalErrorMap` (first error per operator). `bindPlanResources` binds each
  operator inside `Try`, appending `(op.id.logicalOpId, error)`; any binding error → throw the same
  way. `bindResources(op)` (used for a single edited operator) keeps throwing its own exception.
- New `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/WorkflowCompilationFailed.scala`:
  `class WorkflowCompilationFailed(val operatorErrors: Map[OperatorIdentity, WorkflowFatalError])
  extends RuntimeException(…)` whose message lists up to five `"<operator id>: <message>"` lines.
- `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/CompilationErrorHandling.scala`:
  doc comment for Strict.

**Behaviour.** A valid workflow compiles to the same plan. The unit's old path (until sub-part 14)
reports the exception through its error handler as before; the message now names every operator.

**Tests.**
- `common/workflow-compiler/src/test/scala/org/apache/texera/common/compiler/WorkflowCompilerSpec.scala`:
  two broken operators → both in `operatorErrors`; a binding failure (an unreadable dataset version)
  names its operator; a valid plan is unchanged.
- `amber/src/test/scala/org/apache/texera/web/service/WorkflowExecutionServiceSpec.scala`: the error
  event carries the new message.
- `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala` and specs that matched the
  old exception type.

**Run.** `sbt "WorkflowCompiler/testOnly org.apache.texera.common.compiler.WorkflowCompilerSpec"`;
`STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.WorkflowExecutionServiceSpec"`.

**Done when.** The specs pass.

### Brief 9. `feat(amber): create executions at the Dashboard service`

**Goal.** `POST /api/executions` on the Dashboard service creates an execution: it checks rights,
compiles for the creator, records the execution, writes the plan to the lake and clears earlier
finished results. Nothing calls it until sub-part 12; the unit is not involved.

**Depends on.** 6, 7, 8.

**Files.**
- New `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/ExecutionResource.scala`:
  `@Path("/executions") @Consumes(JSON) @Produces(JSON) class ExecutionResource` with
  `@POST @RolesAllowed(Array("REGULAR", "ADMIN")) def create(request: CreateExecutionRequest,
  @Auth user: SessionUser, @Context uriInfo: UriInfo): Response`.
- New `amber/src/main/scala/org/apache/texera/web/model/http/request/execution/CreateExecutionRequest.scala`:
  `CreateExecutionRequest(wid: Long, executionName: String = "", engineVersion: String, logicalPlan:
  LogicalPlanPojo, workflowSettings: Option[WorkflowSettings], emailNotificationEnabled: Boolean =
  false, computingUnitId: Int, warehouseId: Option[Int], replayFromExecution:
  Option[ReplayExecutionInfo], targetOperatorIds: List[String] = Nil)`; move `ReplayExecutionInfo`
  here from `amber/src/main/scala/org/apache/texera/web/model/websocket/request/WorkflowExecuteRequest.scala`
  (which imports it until sub-part 14).
- New `amber/src/main/scala/org/apache/texera/web/model/http/response/execution/CreateExecutionResponse.scala`
  (`eid, wid, computingUnitId, planUri`) and `CreateExecutionFailure.scala` (`eid, operatorErrors:
  Map[String, WorkflowFatalError], errors: List[WorkflowFatalError]`), serialized as the compiling
  service serializes `WorkflowFatalError`.
- New `amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionCreator.scala`: the steps
  below, with seams for the resolvers so the spec can use fixtures.
- `amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionResources.scala` (from 6):
  move `resolveLakekeeperWarehouseName` from `WorkflowService` (which calls it here until sub-part
  14) and `clearExecutionResources(eid)` (public now); add `clearFinishedExecutions(wid, cuid,
  exceptEid)`: every execution of `wid` (through `workflow_version`) on `cuid` with status 3, 4 or 5,
  other than `exceptEid`, that has a row in `operator_port_executions` or `operator_executions` →
  `clearExecutionResources`, each in its own `try` with a log line.
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionsMetadataPersistService.scala`:
  `insertCreatedExecution(wid, uid, name, environmentVersion, cuid, whid): ExecutionIdentity` (status
  0 explicitly, `starting_time` now) and `markFailed(eid)` (status 4, `last_update_time` now).
- `amber/src/main/scala/org/apache/texera/web/TexeraWebApplication.scala`: register
  `ExecutionResource`; in `initialize`, `JSONUtils.registerWorkflowModules(bootstrap.getObjectMapper)`.
- `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/model/LogicalPlanPojo.scala`:
  `upstreamOf(targetId: String): LogicalPlanPojo`, moved from `SyncExecutionResource.computeSubDAGIfNeeded`
  (`:886-931`, same semantics: the target and everything upstream; `opsToViewResult` = the target;
  `opsToReuseResult` filtered; an unknown target leaves the plan whole); `SyncExecutionResource` calls
  it until sub-part 14.
- `bin/single-node/docker-compose.yml`: dashboard-service `depends_on` adds lakekeeper
  (`service_healthy`), lakekeeper-init (`service_completed_successfully`) and lakefs
  (`service_healthy`).
- `bin/single-node/nginx.conf`: before `location /api/`, add
  `location = /api/executions { proxy_pass http://dashboard-service:8080; proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 120s; }`.
- `frontend/proxy.config.json`: an `"/api/executions"` entry to the Dashboard's target with
  `"proxyTimeout": 120000`, before the `/api` entry.
- `bin/k8s/templates/base/gateway/gateway-routes.yaml`: in the static routes, before the `/api`
  catch-all, a rule matching `path: {type: Exact, value: /api/executions}` and `method: POST`, with
  `timeouts: {request: "120s"}`, to `webserver-svc:8080`.
- `bin/k8s/templates/base/webserver/webserver-deployment.yaml`: `TEXERA_MOUNT_IN_POD_ROOT` =
  `{{ .Values.mounter.podMountRoot }}` when `.Values.mounter.enabled`.

**Behaviour.** In this order:
1. uid from the session.
2. The body parses (else 400 `{"code": 400, "message"}`); `logicalPlan` goes through the workflow
   modules (loop-variable placeholders included).
3. `WorkflowAccess.hasReadAccess(wid, uid)` else 403;
   `ComputingUnitAccess.getComputingUnitAccess(cuid, uid) == PrivilegeEnum.WRITE` else 403 (an unknown
   unit too); the unit row's `terminate_time` null else 409 "computing unit <cuid> is terminated".
4. `resolveLakekeeperWarehouseName(warehouseId, uid)`; its `IllegalArgumentException` → 400.
5. Replay source when given: the row exists, its version belongs to `wid`, its `log_location` is set;
   else 400.
6. `insertCreatedExecution`; when `ApplicationConfig.faultToleranceLogRootFolder` is set,
   `updateLogLocation(eid, <root>/<wid>/<eid>/)`.
7. Context `new WorkflowContext(wid, eid, settings, cuid = Some(cuid), warehouse)` where settings are
   the request's or `WorkflowSettings(dataTransferBatchSize = ApplicationConfig.defaultDataTransferBatchSize)`;
   `context.costHints = CostHintsLoader.load(wid, uid)`; the plan to compile is
   `logicalPlan.upstreamOf(t)` when `targetOperatorIds == List(t)`; `logical` = the request plan's
   JSON, serialized now. Compile with `new WorkflowCompiler(context, FileResolver.forUser(uid),
   FileResolver.repositoryVersionResolverForUser(uid), RepositoryMountManager.mountRoot)` through
   `PlanToRun.make(compiler, context, plan, replay, replayLog)`.
   `WorkflowCompilationFailed` → `markFailed(eid)`, 400 with `{eid, operatorErrors, errors}`; any
   other exception → `markFailed`, 500.
8. `ExecutionPlanStore.writePlan(planUri(wid, eid, warehouse), PlanRecord("plan", "plan",
   FormatVersion, savedPlan, logical, now, uid, cuid, notification))`, notification when
   `emailNotificationEnabled` and the user has an email: `{"email", "workflowName":
   WorkflowResource.getWorkflowName(wid), "workflowUrl": "http://<host>[:port]/user/workspace/<wid>"}`
   from `uriInfo.getRequestUri` (the shape `WorkflowEmailNotifier` builds today). A failed write →
   `markFailed`, 500.
9. `clearFinishedExecutions(wid, cuid, eid)`.
10. 201 `{eid, wid, computingUnitId, planUri}`.

**Tests.**
- New `amber/src/test/scala/org/apache/texera/web/resource/dashboard/user/workflow/ExecutionResourceSpec.scala`
  (`MockTexeraDB` + Postgres JDBC catalog; fixture file and repository resolvers): 403 without READ;
  403 without WRITE; 403 unknown unit; 409 terminated; 400 for each warehouse rule (missing while
  enabled, not owned, given while disabled); 400 replay of another workflow and without a log; 400
  malformed plan; 400 compile errors keyed by operator and the row at status 4; 201: the row at
  status 0 (not the column default 1), `starting_time` set, `log_location` when configured; the plan
  row's columns (createdBy, computingUnitId, notification null and set, logical as sent); the decoded
  plan's context (eid, wid, warehouse, settings with `outputPortsNeedingStorage`), replay, replay log,
  cost hints; one target cuts the sub-DAG; absent settings get the defaults; earlier finished
  executions of the same (wid, cuid) are cleared (URI rows deleted, tables dropped) while a status-1
  one, other units' and other workflows' stay; a compile error clears nothing; no row on any refusal.
- `amber/src/test/scala/org/apache/texera/web/TexeraWebApplicationSpec.scala`: after boot, POST
  `/api/executions` and GET `/api/executions/{wid}` both resolve; a plan with a `$k` placeholder
  parses.
- `amber/src/test/scala/org/apache/texera/web/ComputingUnitMasterSpec.scala`: the unit answers 404 or
  405 to POST `/api/executions`.
- `common/workflow-compiler` spec for `upstreamOf` (new `LogicalPlanPojoSpec.scala` if none exists).

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.resource.dashboard.user.workflow.ExecutionResourceSpec org.apache.texera.web.TexeraWebApplicationSpec org.apache.texera.web.ComputingUnitMasterSpec" "WorkflowCompiler/testOnly org.apache.texera.common.compiler.model.LogicalPlanPojoSpec"`;
`helm template t bin/k8s` shows the new route and, with `--set mounter.enabled=true`, the mount root
on the webserver.

**Done when.** The specs pass; on the harness stack (images from this commit) a `create_only` call
returns 201, its plan table exists (Check E's lookup), and the row is at status 0.

### Brief 10. `feat(amber): change a paused operator through the Dashboard`

**Goal.** `POST /api/executions/{eid}/updates` on the Dashboard compiles a changed operator of a
paused execution for its creator and stores it as one row in the execution's plan table. Nothing
calls it until sub-part 12.

**Depends on.** 9.

**Files.**
- `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/ExecutionResource.scala`:
  `@POST @Path("/{eid}/updates") @RolesAllowed(Array("REGULAR", "ADMIN")) def postUpdate(@PathParam("eid")
  eid: Long, request: OperatorUpdateRequestBody, @Auth user: SessionUser): Response`.
- New `amber/src/main/scala/org/apache/texera/web/model/http/request/execution/OperatorUpdateRequestBody.scala`
  (`operator: LogicalOp`) and `.../response/execution/OperatorUpdateResponse.scala` (`updateId,
  operatorId`).
- New `amber/src/main/scala/org/apache/texera/web/service/execution/OperatorUpdates.scala`.

**Behaviour.**
1. The execution row by eid: wid (through `workflow_version`), uid, cuid, whid, status; unknown → 404.
2. Caller = the row's uid, READ on wid and WRITE on cuid; else 403.
3. Status 3, 4 or 5 → 409 "execution <eid> has ended".
4. `readPlan(planUri)` (the URI from `ExecutionResources.planUriOf(eid)`); parse its `logical`
   column with the workflow modules into a `LogicalPlan`; the posted operator's id must be in it, else
   404.
5. Refuse loop variables, moved from `ExecutionReconfigurationService.scala:103-114`: the current
   or the new operator has `stateReferences`, or sits inside a loop block and holds a whole-string
   `$name` → 400 "<name> refers to loop variables, so it can't be changed while the workflow runs."
6. A Python UDF whose `defaultEnv`/`envName` differ from the current operator's → 400 "the
   operator's Python environment cannot change while the run is paused".
7. `Try(currentOp.runtimeReconfiguration(wid, eid, currentOp, newOp))` (the base class throws
   `UnsupportedOperationException`) and a `Failure` → 400 with its message.
8. `new WorkflowCompiler(context, FileResolver.forUser(uid), FileResolver.repositoryVersionResolverForUser(uid),
   mountRoot).bindResources(op)`; a failure → 400 with its message.
9. `updateId = "update-" + UUID.randomUUID()`;
   `body = updateToJson(encodeUpdate(ExecutionIdentity(eid), updateId, boundOp))`;
   `ExecutionPlanStore.appendUpdate(planUri, PlanRecord(updateId, "update", FormatVersion, body,
   logical = the posted operator's JSON, now, uid, cuid, None))`.
10. 200 `{updateId, operatorId}`.

**Tests.** New `amber/src/test/scala/org/apache/texera/web/service/execution/OperatorUpdatesSpec.scala`
(through `ExecutionResource`, `MockTexeraDB` + JDBC catalog, with an execution created by
`ExecutionCreator`): 403 for another user, and for the creator after losing READ or WRITE; 404 unknown
eid and unknown operator; 409 ended; 400 loop variables; 400 for an operator that does not support
reconfiguration (base class throws); 400 environment changed; 400 binding error; 200 appends a row
whose body `decodeUpdate`s to the op id with the new code, whose `logical` is the posted operator, and
whose `createdBy` is the poster.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.execution.OperatorUpdatesSpec org.apache.texera.web.resource.dashboard.user.workflow.ExecutionResourceSpec"`.

**Done when.** The specs pass.

### Brief 11. `feat(amber): start a stored execution by id on the unit`

**Goal.** The unit starts an execution the Dashboard created, by its id: over the websocket
(`WorkflowStartRequest`) and over the agent's REST path (`POST /api/execution/{eid}/run`). It also
applies a stored paused-operator update (`OperatorUpdateRequest`). The old `WorkflowExecuteRequest`,
`ModifyLogicRequest` and `POST /api/execution/{wid}/{cuid}/run` stay until sub-part 14, so the
browser and the agent can switch in 12 and 13 while every commit works.

**Depends on.** 6, 9, 10.

**Files.**
- `amber/src/main/scala/org/apache/texera/web/model/websocket/request/TexeraWebSocketRequest.scala`:
  `case class WorkflowStartRequest(executionId: Long, planUri: String)` and
  `case class OperatorUpdateRequest(executionId: Long, updateId: String)`, both added to
  `@JsonSubTypes`.
- New `amber/src/main/scala/org/apache/texera/web/service/execution/StoredExecutionStart.scala`, pure
  checks returning `Either[String, …]` with these messages:
  - `checkUri(planUri, executionId, socketWorkflowId: Option[Long], uid)`: "not an execution plan"
    (decode fails or type is not `PLAN`); "the plan is execution <x>'s, not <eid>'s"; "the plan
    belongs to workflow <x>, not to this one" (socket path only); "the plan is in another user's
    warehouse" (warehouse present and not `user-<uid>-<digits>`); the `WarehouseReadGuard.assertReadable`
    message.
  - `checkRecord(record, decoded: ExecutionPlan, uri, uid, cuid, nowMs)`: "unknown plan format
    <v>; this unit reads <FormatVersion>"; "only the user who created execution <eid> may start it";
    "execution <eid> was created for computing unit <x>, not <cuid>"; "the plan's ids do not match its
    location"; "input links expired at <time>; run the workflow again".
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala`: new
  `startStoredExecution(executionId: Long, planUri: URI, user: User, cuid: Int, sessionUri: URI):
  Either[String, WorkflowExecutionService]`:
  1. `checkUri` (nothing touches a catalog before it passes);
  2. `ExecutionPlanStore.readPlan(planUri)` (`NoStoredPlanException` → "execution <eid> has no stored
     plan"); `PhysicalPlanCodec.decode(fromJson(record.body))` (its `IllegalArgumentException` → its
     message); `checkRecord`;
  3. under `this.synchronized`: `ExecutionPlanStore.claimStart(planUri)`
     (`ExecutionAlreadyStartedException` → its message); `supersedeCurrentRun()` (sub-part 6);
  4. the run's context is the decoded one with `context.cuid = Some(cuid)`, commented "until sub-part
     20 removes per-unit environments; without it a UDF's environment falls back silently";
     `WorkflowMetricsRecorder.onStart(eid)`; a new `ExecutionStateStore` holding the eid; a
     `WorkflowExecutionService` built for a stored plan (below); register it with the lifecycle
     manager, `executionService.onNext`, then `start`.
  Any exception before step 3 is a refusal (Left); after it, failures go to the run's error handler as
  for any run.
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala`: split sub-part
  6's `runStoredPlan` into the old path's "claim, read back, check against my context" and a shared
  `startFrom(executionPlan, record, planUri)` (requireRunnableUnder; coordinator config from the plan;
  notifier from the record; client, services, READY, `startWorkflow`); a second constructor (or
  factory `forStoredPlan`) that takes the decoded `ExecutionPlan`, the record and `planUri` and has no
  compiler.
- `amber/src/main/scala/org/apache/texera/web/resource/WorkflowWebsocketResource.scala`:
  - `WorkflowStartRequest`: WRITE on the socket's unit, a user and a `WorkflowService` are required;
    `startStoredExecution(executionId, URI.create(planUri), user, socketCuid, session.getRequestURI)`;
    a refusal sends `WorkflowErrorEvent(Seq(WorkflowFatalError(EXECUTION_FAILURE, now, message, "",
    "")))` to this session only and does nothing else. Handle its exceptions inside this case, never
    in the shared catch block (which writes into the previous run's store, `:138-161`).
  - `OperatorUpdateRequest`: the running execution's eid must be `executionId`, else
    `ModifyLogicResponse("", isValid = false, "execution <eid> is not running here")`; otherwise send
    `executionReconfigurationService.applyStoredUpdate(updateId)`.
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionReconfigurationService.scala`:
  constructor also takes `planUri: URI` and `creator: Int`; new `applyStoredUpdate(updateId):
  ModifyLogicResponse`: `ExecutionPlanStore.readUpdate(planUri, updateId)`; `kind == "update"`,
  `formatVersion == FormatVersion`, `createdBy == creator`; `decodeUpdate(updateFromJson(body))`;
  its `executionId` is the running one; its `opId` is in `workflow.physicalPlan` (else "operator <x>
  is not in the running plan"); queue `(workflow.physicalPlan.getOperator(opId).copy(opExecInitInfo =
  u.opExecInitInfo, repositoryMounts = u.repositoryMounts), None)` after `requireResourcesBound()`;
  answer `ModifyLogicResponse(opId.logicalOpId.id, isValid = true, "")`, or `isValid = false` with the
  reason. `performReconfigurationOnResume` is unchanged.
- `amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala`: `@POST
  @Path("/{eid}/run") def runStoredExecution(@PathParam("eid") eid: Long, request: SyncRunRequest,
  @Auth user: SessionUser): SyncExecutionResult` with `SyncRunRequest(planUri: String,
  computingUnitId: Int, targetOperatorIds: List[String], timeoutSeconds: Int,
  maxOperatorResultCharLimit: Int, maxOperatorResultCellCharLimit: Int)`. The workflow is the one the
  URI names (after `checkUri` with no socket workflow); `WorkflowService.getOrCreate(wid,
  computingUnitId)`; `startStoredExecution(eid, planUri, user.getUser, computingUnitId,
  URI(s"sync-execution://$wid"))`; a refusal → `SyncExecutionResult(success = false, state =
  "Error", operators = Map.empty, compilationErrors = None, errors = Some(List(message)))`. Move the
  waiting and result collection of `executeWorkflowSync` (`:207-361`) into a private method both
  paths call. Target counts (D37):
  `plan.getPhysicalOpsOfLogicalOp(OperatorIdentity(t)).flatMap(_.inputPorts.keys).filterNot(_.internal).map(_.id).distinct.size`.

**Behaviour.** §4 Start. A refused start writes nothing anywhere and is seen only by its sender.

**Tests.**
- New `amber/src/test/scala/org/apache/texera/web/service/execution/StoredExecutionStartSpec.scala`:
  every check and message above; no catalog call before `checkUri` passes (a catalog stub counts
  calls).
- `amber/src/test/scala/org/apache/texera/web/resource/WorkflowWebsocketResourceSpec.scala` (JDBC
  catalog; plans written with `ExecutionCreator`): an accepted start reaches READY and the engine seam
  receives the decoded plan with `context.cuid` = the socket's; each refusal (no WRITE, no user, each
  `StoredExecutionStart` case, already started) reaches only this session, changes no row
  (`StatementRecorder` sees nothing), reaches no other session on the workflow, and leaves the previous
  run's store as it was; a second start of the same eid → "already started"; `OperatorUpdateRequest`
  for another eid → invalid response.
- `amber/src/test/scala/org/apache/texera/web/model/websocket/request/TexeraWebSocketRequestSpec.scala`:
  serde of both new requests.
- `amber/src/test/scala/org/apache/texera/web/service/ExecutionReconfigurationServiceSpec.scala`: a
  stored update is queued and, on resume, dispatched with the new executor and its mounts ensured;
  unknown update, op not in the plan, another execution, another creator, another format → invalid.
- `amber/src/test/scala/org/apache/texera/web/resource/SyncExecutionResourceSpec.scala`: the new path
  runs by eid; another user, another unit and a second call are refused; a HashJoin target expects 2
  external input ports.
- `amber/src/test/scala/org/apache/texera/web/service/WorkflowServiceSpec.scala`: start by id
  supersedes a live run (KILLED written) and sets the socket's cuid on the context.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.execution.StoredExecutionStartSpec org.apache.texera.web.resource.WorkflowWebsocketResourceSpec org.apache.texera.web.model.websocket.request.TexeraWebSocketRequestSpec org.apache.texera.web.service.ExecutionReconfigurationServiceSpec org.apache.texera.web.resource.SyncExecutionResourceSpec org.apache.texera.web.service.WorkflowServiceSpec"`.
Harness with images from this commit (no `--frontend` needed yet): `--transport ws` a–e, and
`--transport create-ws --scenario a,b,e,l8,o`.

**Done when.** The specs pass; the old path still passes a–e; the new path passes a, b, e, l8 and o.

### Brief 12. `feat(frontend): create an execution, then start it`

**Goal.** The browser creates an execution at the Dashboard, then starts it on the unit over its
websocket; a paused operator's change is posted to the Dashboard, then named to the unit.

**Depends on.** 11.

**Files.**
- New `frontend/src/app/workspace/service/execute-workflow/execution-api.service.ts`
  (`@Injectable({ providedIn: "root" })`, `HttpClient`): `create(body: CreateExecutionRequest):
  Observable<CreateExecutionResponse>` → `POST ${AppSettings.getApiEndpoint()}/executions`;
  `postUpdate(eid: number, operator: LogicalOperator): Observable<{ updateId: string; operatorId:
  string }>` → `POST …/executions/${eid}/updates` with `{ operator }`. Types `CreateExecutionRequest`
  (§3.4 fields), `CreateExecutionResponse` (`eid, wid, computingUnitId, planUri`),
  `CreateExecutionFailure` (`eid, operatorErrors: Record<string, WorkflowFatalError>, errors:
  WorkflowFatalError[]`).
- `frontend/src/app/workspace/service/execute-workflow/execute-workflow.service.ts`:
  - `sendExecutionRequest` (`:353-395`): after the form debounce, set the local state to
    `Initializing` (through `updateExecutionState`), call `create` with the same fields as today plus
    `wid` (from `workflowActionService`); on success keep `currentExecutionId` and `currentPlanUri`
    and send `WorkflowStartRequest { executionId, planUri }`; on a 400 with `operatorErrors`, set
    `Failed` with `errorMessages` = the operator errors (in plan order) followed by `errors`, each as
    the `WorkflowFatalError` received (the result panel keeps the previous results, as the Dashboard
    did not clear them); on any other error, `Failed` with one `EXECUTION_FAILURE` message
    (`error.error?.message` or the status text). Nothing is sent on the socket after a failed create.
  - `modifyOperatorLogic` (`:449-460`): `postUpdate(currentExecutionId, operator)`, then send
    `OperatorUpdateRequest { executionId, updateId }`; an HTTP error → `notificationService.error(message)`
    and nothing sent.
- `frontend/src/app/workspace/types/workflow-websocket.interface.ts`: add `WorkflowStartRequest` and
  `OperatorUpdateRequest` to `TexeraWebsocketRequestTypeMap`; remove `WorkflowExecuteRequest` and
  `ModifyLogicRequest` from it.

**Behaviour.** Replay (`executeWorkflowWithReplay`) sends `replayFromExecution` in the create body.
The unit's `WorkflowErrorEvent` for a refused start arrives on the socket as any error event does.

**Tests.**
- New `frontend/src/app/workspace/service/execute-workflow/execution-api.service.spec.ts`
  (`HttpTestingController`): URLs, methods and bodies.
- `frontend/src/app/workspace/service/execute-workflow/execute-workflow.service.spec.ts`: create, then
  start, in that order, with the create's eid and planUri; a 400 → `Failed` with the operator errors
  and nothing sent on the socket; 403, 409 and 500 → `Failed`; replay passes `replayFromExecution`;
  modify posts, then sends `OperatorUpdateRequest`; a modify 400 → error toast and nothing sent.

**Run.** `cd frontend && npx ng test --watch=false --test-file src/app/workspace/service/execute-workflow/execution-api.service.spec.ts`
and `--test-file src/app/workspace/service/execute-workflow/execute-workflow.service.spec.ts`;
`yarn lint`.

**Done when.** The specs pass; with `--frontend` images, a run, a pause-change-resume and a compile
error work in the browser on the harness stack, and the driver's `create-ws` a–e pass.

### Brief 13. `feat(agent-service): create the execution before running it`

**Goal.** The agent creates the execution at the Dashboard, then asks the unit to run it by id.

**Depends on.** 11.

**Files.**
- `agent-service/src/agent/tools/workflow-execution-tools.ts` (`executeWorkflowHttp`, `:251-320`):
  1. `POST ${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions` with
     `Authorization: Bearer ${config.userToken}` and `{ wid: workflowId, executionName:
     "agent-execution", engineVersion: "agent", logicalPlan, computingUnitId, warehouseId?,
     targetOperatorIds: logicalPlan.opsToViewResult ?? [], emailNotificationEnabled: false }`;
  2. on 201, `POST ${executionEndpoint}/api/execution/${eid}/run` (the endpoint chosen as today from
     `EXECUTION_ENDPOINT_TEMPLATE` or the backend config) with `{ planUri, computingUnitId,
     targetOperatorIds, timeoutSeconds, maxOperatorResultCharLimit, maxOperatorResultCellCharLimit }`;
     the response goes through `adaptLegacySyncExecutionResult` as today.
  Both calls take the abort signal.
- `agent-service/src/api/execution-api.ts`: a create 400 becomes a `WorkflowExecutionSummary` with
  state FAILED and one `COMPILATION_ERROR` per `operatorErrors` entry (operator id and message) plus
  the general `errors`; a 403, 409 or 500 becomes an ERROR summary with the response's message.
- `agent-service/src/agent/texera-agent.spec.ts` (`:1021`, `:1071`, `:1106`, `:1156`) and
  `agent-service/src/agent/tools/workflow-execution-tools.spec.ts` (`:697`, `:870-871`): the URL
  expectations.

**Behaviour.** No new settings: agent-service already has `TEXERA_DASHBOARD_SERVICE_ENDPOINT`
(`agent-service/src/config/env.ts:31`).

**Tests.** `workflow-execution-tools.spec.ts`: two calls in order, both with the user's token, the
second naming the first's eid and planUri; a create 400 → compilation errors per operator; a create
403 → error summary and no second call; an abort before the second call stops it.
`execution-api.spec.ts`: the 400 mapping. `texera-agent.spec.ts`: updated URLs.

**Run.** `cd agent-service && bun test src/agent/tools/workflow-execution-tools.spec.ts src/api/execution-api.spec.ts src/agent/texera-agent.spec.ts && bun run typecheck`.

**Done when.** The tests pass; on local-dev an agent run of a small workflow succeeds (the harness
does not rebuild agent-service; scenario o covers the unit side).

### Brief 14. `feat(amber): drop the unit's compile path`

**Goal.** The unit no longer compiles, inserts executions or accepts the old start and change
messages. One path is left: create at the Dashboard, start by id on the unit.

**Depends on.** 12, 13.

**Files.**
- Delete `amber/src/main/scala/org/apache/texera/web/model/websocket/request/WorkflowExecuteRequest.scala`
  (`ReplayExecutionInfo` already lives with the create request) and `ModifyLogicRequest`; drop both
  from `@JsonSubTypes` in `TexeraWebSocketRequest.scala`.
- `amber/src/main/scala/org/apache/texera/web/resource/WorkflowWebsocketResource.scala`: drop the two
  cases.
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala`: delete
  `initExecutionService`, `createWorkflowContext`, the insert, the previous-run clearing, the warehouse,
  replay and replay-log code, `convertToJson`, and the `clearExecutionResources` copy (the idle cleanup
  calls `ExecutionResources.clearExecutionResources`).
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala`: only the
  stored-plan entry remains (no `WorkflowCompiler`, no `request`, no `makePlanToRun`, no
  `readPlanToRun`/`requirePlanOf`, whose checks `StoredExecutionStart` now makes).
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionReconfigurationService.scala`: delete
  `modifyOperatorLogic`, `refersToLoopVariables` and the `bindResources` parameter.
- `amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala`: delete
  `POST /{wid}/{cuid}/run`, `SyncExecutionRequest`, `computeSubDAGIfNeeded` and the compile heuristics
  of `handleExecutionError`.
- `amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/Workflow.scala`:
  `Workflow(context, physicalPlan)` (no logical plan). `Workflow.fromCompilationResult` stays only if
  `PlanToRun.make` (now used by the Dashboard's `ExecutionCreator`) still needs it.
- `amber/src/main/scala/org/apache/texera/web/ComputingUnitMaster.scala:136-137`: drop
  `registerWorkflowModules` (nothing on the unit parses a logical plan now).
- `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala`: `buildWorkflow` keeps
  1d's in-memory round trip (`PlanToRun.make`, then `PhysicalPlanCodec.decode(fromJson(…))` and
  `requireRunnableUnder`, since `readPlanToRun` is gone). The e2e reconfiguration specs drive the
  engine directly and need no change; the specs that send the old messages are listed under Tests.

**Behaviour.** `git grep -n "WorkflowCompiler" amber/src/main/scala/org/apache/texera/web/service
amber/src/main/scala/org/apache/texera/web/resource/WorkflowWebsocketResource.scala
amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala` finds only
`ExecutionCreator` and `OperatorUpdates` (Dashboard side).

**Tests.** `TexeraWebSocketRequestSpec` (an old message is refused by the mapper and answered with an
error event), `WorkflowWebsocketResourceSpec`, `ExecutionReconfigurationServiceSpec`,
`SyncExecutionResourceSpec` (the old route answers 404), `WorkflowServiceSpec`,
`WorkflowExecutionServiceSpec` (each drops its old-path cases), then the whole amber suite, unit and
integration.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/test"`;
`UDF_PYTHON_PATH=… STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=integration-only sbt "WorkflowExecutionService/test"`.
Harness, `--frontend` images: PR B's gate (`create-ws`: a–e, j, k, l1–l10, m, o with Checks C and E;
`--legacy-env` g0).

**Done when.** The specs pass and PR B's gate passes.

### Brief 15. `feat(workflow-operator): carry the CSV column limit in the plan`

**Goal.** The CSV scan reads its column limit from its descriptor, set at every compile from the
site setting, so the unit no longer reads `site_settings`. This brief also introduces `RunBindings`,
the one value that carries everything a compile binds.

**Depends on.** 14.

**Files.**
- `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/source/scan/csv/CSVScanSourceOpDesc.scala`:
  `@JsonProperty("maxColumns") var maxColumns: Option[Int] = None` (a hidden sidecar); inference
  (`:88-140`) uses `maxColumns.getOrElse(CompileSettings.DefaultCsvMaxColumns)`.
- `.../scan/csv/CSVScanSourceOpExec.scala`: `maxColumns = desc.maxColumns.getOrElse(throw new
  IllegalStateException("The CSV scan has no column limit: its plan was not made by a run's compile."))`;
  delete `getMaxColumns` (`:130-131`) and the `SiteSettings` import.
- `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/metadata/OperatorMetadataGenerator.scala`:
  remove `maxColumns` from the generated UI schema, as `stateReferences` is (`:126-127`).
- New `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/CompileSettings.scala`:
  `final case class CompileSettings(csvParserMaxColumns: Int)`; `DefaultCsvMaxColumns` (today's
  `CSVScanSourceOpExec.DEFAULT_MAX_COLUMNS`); `fromSiteSettings()` =
  `SiteSettings.getInt("csv_parser_max_columns", DefaultCsvMaxColumns)` (callers with Postgres only:
  the Dashboard and the compiling service).
- New `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/RunBindings.scala`:
  `final case class RunBindings(files: ScanFileResolver, repositories: RepositoryVersionResolver,
  mountRoot: Option[Path], settings: CompileSettings)` with `forEditing(files, settings)`
  (`RepositoryVersionResolver.Unavailable`, no mount root). `WorkflowCompiler(context, bindings:
  RunBindings)` replaces 1b's `(context, fileResolver, repositoryResolver, mountRoot)`.
- `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/WorkflowCompiler.scala`
  and `model/LogicalPlan.scala`: on every compile, Strict or Lenient, before expansion, set
  `maxColumns = Some(settings.csvParserMaxColumns)` on each `CSVScanSourceOpDesc`, replacing any value
  from the request.
- Callers: `ExecutionCreator`, `OperatorUpdates`, `PlanToRun` users,
  `workflow-compiling-service/src/main/scala/org/apache/texera/service/resource/WorkflowCompilationResource.scala`,
  `WorkflowToPythonResource.scala`, `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala`
  and the specs that build a `WorkflowCompiler`.

**Behaviour.** The limit used is the site setting's value at create time. A plan made outside a
compile has no limit and its CSV scan fails with the message above.

**Tests.** `common/workflow-operator/src/test/scala/org/apache/texera/amber/operator/source/scan/csv/CSVScanSourceOpExecSpec.scala`
(the limit comes from the descriptor; a missing one fails with the message; no `SiteSettings`);
inference honours `maxColumns`; `OperatorMetadataGeneratorSpec` (no `maxColumns` in the schema);
`WorkflowCompilerSpec` (both modes set it; a request's value is replaced);
`workflow-compiling-service/src/test/scala/org/apache/texera/service/resource/WorkflowCompilationResourceSpec.scala`.

**Run.** `sbt "WorkflowOperator/testOnly org.apache.texera.amber.operator.source.scan.csv.* org.apache.texera.amber.operator.metadata.OperatorMetadataGeneratorSpec" "WorkflowCompiler/testOnly org.apache.texera.common.compiler.WorkflowCompilerSpec" "WorkflowCompilingService/testOnly org.apache.texera.service.resource.WorkflowCompilationResourceSpec"`,
then the amber specs that construct compilers.

**Done when.** The specs pass and `git grep -n "SiteSettings" common/workflow-operator` finds nothing.

### Brief 16. `feat(amber, workflow-operator): read input files from links`

**Goal.** Every file a scan source reads is read through a presigned link the Dashboard made when it
created the execution. The unit no longer asks file-service or LakeFS for anything, and it opens no
URL outside the configured object store.

**Depends on.** 7 (the K8s Dashboard's S3 settings), 15 (`RunBindings`).

**Files.**
- New `common/workflow-core/src/main/scala/org/apache/texera/service/util/ObjectStorePresigner.scala`:
  `class ObjectStorePresigner(endpoint: URI, region: String, accessKey: String, secretKey: String,
  pathStyle: Boolean)` with `presignGet(bucket, key, ttlSeconds): (String, Long)` (URL, expiry in ms)
  over AWS SDK v2 `S3Presigner` (`endpointOverride`, `S3Configuration.pathStyleAccessEnabled`,
  `StaticCredentialsProvider`); TTL clamped to [60, 604800]; `fromConfig(endpoint)` takes region and
  keys from `StorageConfig`.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/util/LakeFSStorageClient.scala`:
  `statObject(repo, commit, path): ObjectStats` (no presign). `retrieveObjectsOfVersion` already
  returns `physicalAddress` and `sizeBytes`; `parsePhysicalAddress` gives (bucket, key).
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/InputLink.scala`:
  `final case class InputLink(url: String, expiresAtMs: Long, sizeBytes: Long)`; `trait InputLinker {
  def link(fileUri: URI): InputLink; def linkObject(physicalAddress: String, sizeBytes: Long):
  InputLink }`; `InputLinker.Unavailable` (throws "input links are made only when a run's plan is
  made").
- New `.../core/storage/LakeFSInputLinker.scala`: `link(dataset:///repo/hash/path or model:///…)` →
  `statObject` → `linkObject(physicalAddress, size)` → `presignGet(bucket, key, ttl)`. Move the URI
  parsing out of `LakeFSFileDocument` into its companion so both share it.
- New `amber/src/main/scala/org/apache/texera/web/service/execution/InputLinkEndpoints.scala`:
  `endpointFor(unit: WorkflowComputingUnit): URI` = `storage.input-links.s3-endpoint`, or
  `storage.s3.endpoint` when empty, for every unit kind today (the place step 6 maps kinds).
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/model/LinkDocument.scala`:
  `class LinkDocument(link: InputLink, name: String) extends ReadonlyVirtualDocument[Nothing]`.
  Before connecting: the URL's scheme, host and port must be one of
  `StorageConfig.inputLinksAllowedEndpoints` (else `IllegalArgumentException("refusing to read <name>:
  its link does not point at the object store")`); now past `expiresAtMs` →
  `IOException("the input link for <name> expired at <ISO time>; run the workflow again")`. GET with a
  30 s connect and 5 min read timeout; 200 → `LengthCheckedInputStream(stream, contentLength, name)`;
  403 past expiry → the expiry message; other codes → "could not read <name>: HTTP <code>". `asFile()`
  downloads once into a temp file. Never log the query string.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/model/LakeFSFileDocument.scala`:
  drop the `USER_JWT_TOKEN` / file-service branch (`:40-63`, `:136-170`); it now reads through LakeFS's
  presign with the direct-fetch fallback (today's behaviour without a token). It is used only where
  plans are made (schema inference on the Dashboard and in the compiling service) and by export.
- `common/config/src/main/resources/storage.conf` and `StorageConfig.scala`: `storage.input-links {
  s3-endpoint, ttl-seconds, path-style-access, allowed-endpoints }` with the env overrides of §3.9.
- New `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/source/scan/ReadsInputs.scala`:
  `@JsonProperty("inputLinks") var inputLinks: Map[String, InputLink] = Map.empty`;
  `def plannedInputNames: Seq[String]`; `def openPlannedInput(name): ReadonlyVirtualDocument[_]` =
  `new LinkDocument(inputLinks.getOrElse(name, throw new IllegalStateException(s"<operator> has no
  link for $name: its plan was not made to run")), name)`.
- `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/source/scan/ScanSourceOpDesc.scala`:
  `with ReadsInputs`, `plannedInputNames = fileName.toSeq`. Schema inference takes the document it
  reads: `sourceSchemaFrom(document)`, with `sourceSchema()` =
  `sourceSchemaFrom(DocumentFactory.openReadonlyDocument(new URI(fileName.get)))` for the compile side
  (which may not reach the link endpoint, for example a Slurm-only one).
- Every scan pair: `csv/CSVScanSourceOp{Desc,Exec}`, `csv/ParallelCSVScanSourceOp{Desc,Exec}`,
  `csvOld/CSVOldScanSourceOp{Desc,Exec}`, `json/JSONLScanSourceOp{Desc,Exec}`,
  `arrow/ArrowSourceOp{Desc,Exec}`, `file/FileScanSourceOp{Desc,Exec}`: descriptors implement
  `sourceSchemaFrom(document)`; executors open `desc.openPlannedInput(desc.fileName.get)` for data and
  call `desc.sourceSchemaFrom(that document)` where they inferred a schema at run time
  (`CSVScanSourceOpExec.scala:43`, `ParallelCSVScanSourceOpExec.scala:42`,
  `CSVOldScanSourceOpExec.scala:39`); no executor calls `DocumentFactory.openReadonlyDocument`.
  `file/FileScanUtils.scala`: `createTuplesFromFile(document, displayFileName, …)` takes a document.
- `OperatorMetadataGenerator.scala`: hide `inputLinks`.
- `RunBindings`: add `inputLinker: InputLinker` (`Unavailable` in `forEditing`).
- `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/model/LogicalPlan.scala`
  and `WorkflowCompiler.scala`: `bindInputs(linker, errorList): Seq[PlanInput]`, after
  `resolveScanSourceOpFileName` and before expansion (the links must be in `descString`). Strict: for
  each `ReadsInputs` operator, clear `inputLinks`, link each planned name, set the sidecar, collect
  `PlanInput(opId, name, InputFile(expiresAtMs, sizeBytes))`; errors per operator. Lenient: clear
  `inputLinks` only. `WorkflowCompilationResult` gains `inputs`; `PlanToRun.make` puts them in the
  `ExecutionPlan`.
- `ExecutionCreator`: the linker is `new LakeFSInputLinker(ObjectStorePresigner.fromConfig(InputLinkEndpoints.endpointFor(unit)),
  StorageConfig.inputLinksTtlSeconds)`; the `logical` column removes the keys `inputLinks`, `listing`
  and `maxColumns` from every operator object.
- `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala` and
  `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/TestOperators.scala`: a
  fixture linker that serves the fixture files from an in-process HTTP server on 127.0.0.1 (JDK
  `com.sun.net.httpserver.HttpServer`), with the allowed endpoints set to it for the test JVM.

**Behaviour.** §3.2, D10–D12. Create fails per operator when an object cannot be found or presigned.
The unit's start check refuses a plan whose earliest link has expired (sub-part 11).

**Tests.**
- New `LinkDocumentSpec` (local HTTP server): bytes; length mismatch; expired before connecting;
  403 after expiry; another host refused before any connection (the server sees no request); the URL
  query never appears in an exception message.
- New `ObjectStorePresignerSpec`: the URL's host is the configured endpoint; path style;
  `X-Amz-Expires` ≤ 604800; TTL clamp.
- New `LakeFSInputLinkerSpec` (stubbed objects API): stat then presign for a dataset URI;
  `linkObject` makes no LakeFS call.
- Scan executor specs (`CSVScanSourceOpExecSpec` and the others): read through a link; no dataset URI
  opened.
- `LakeFSFileDocumentSpec`: no file-service path.
- `WorkflowCompilerSpec`: Strict links every reader and fills `inputs`; Lenient links none; a
  request's `inputLinks` is replaced on every `ReadsInputs` descriptor.
- `ExecutionResourceSpec`: the `logical` column has no sidecar keys even when the request sent them.
- `PhysicalPlanCodecSpec`: a plan with 10,000 inputs round trips.
- The amber e2e specs pass through the fixture linker.

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.* org.apache.texera.service.util.ObjectStorePresignerSpec" "WorkflowOperator/testOnly org.apache.texera.amber.operator.source.scan.*" "WorkflowCompiler/testOnly org.apache.texera.common.compiler.WorkflowCompilerSpec"`;
the amber specs with `STORAGE_ICEBERG_CATALOG_TYPE=postgres`, unit and integration. Harness:
`--isolate-unit --evidence` with `create-ws` a–e.

**Done when.** The specs pass; on the harness stack with `--isolate-unit`, a–e pass and Check D holds
(the unit resolves neither `file-service` nor `texera-lakefs` and its log names neither).

### Brief 17. `feat(workflow-operator): list a dataset version when planning`

**Goal.** File Lister lists its dataset version when the plan is made, for the creator and only if
the creator can read it; File Scan From Input reads only files a File Lister upstream of it listed,
through links made from the listing.

**Depends on.** 16.

**Files.**
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/DatasetVersionLister.scala`:
  `final case class ListedFile(logicalPath: String, physicalAddress: String, sizeBytes: Long)`;
  `trait DatasetVersionLister { def list(versionPath: String, limit: Int): Seq[ListedFile] }`;
  `Unavailable`.
- New `.../core/storage/LakeFSDatasetVersionLister.scala` (`uid`): parse the version path (move
  `FileListerSourceOpExec.parseDatasetVersionPath` and `canonicalVersionPath` here), resolve the
  repository and version hash with `FileResolver.repositoryVersionResolverForUser(uid)` (refused
  when the user cannot read it), `LakeFSStorageClient.retrieveObjectsOfVersion(repo, hash)` →
  `ListedFile(s"$versionPath/${obj.getPath}", obj.getPhysicalAddress, obj.getSizeBytes)`; more than
  `limit` → error "dataset version <path> lists more than <limit> files".
- `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/source/dataset/FileListerSourceOpDesc.scala`:
  hidden sidecar `listing: Seq[String]`.
- `.../source/dataset/FileListerSourceOpExec.scala`: emits `desc.listing` as `filename` tuples; no
  `SqlServer`, no LakeFS; no listing → "File Lister has no listing: its plan was not made to run".
- `.../source/scan/file/FileScanOpDesc.scala`: `with ReadsInputs`; its planned names are set by the
  compiler.
- `.../source/scan/file/FileScanOpExec.scala`: for each incoming name, `desc.openPlannedInput(name)`;
  a name with no link → "File Scan From Input reads only files listed by a File Lister upstream of it;
  <name> is not one of them"; delete `locate`, local paths and `FileResolver`.
- `OperatorMetadataGenerator.scala`: hide `listing`.
- `RunBindings`: add `lister: DatasetVersionLister` (`Unavailable` in `forEditing`).
- `WorkflowCompiler.scala` / `model/LogicalPlan.scala`: `bindListings(lister, cap, errorList)`,
  Strict only, before `bindInputs`: each File Lister's listing (sorted logical paths) into its
  sidecar; each File Scan From Input's planned names = the union of the listings of the File Listers
  upstream of it (any path through other operators); none upstream → error on it "File Scan From
  Input needs a File Lister upstream of it"; over `cap` in total → error. `bindInputs` links listed
  files with `linkObject(physicalAddress, size)`, no stat.
- `common/config/src/main/resources/application.conf` and `ApplicationConfig.scala`:
  `constants.max-listed-files` (10000, `CONSTANTS_MAX_LISTED_FILES`).
- `ExecutionCreator`: `lister = new LakeFSDatasetVersionLister(uid)`.

**Behaviour.** D13. A user who cannot read the dataset gets a compile error on the File Lister.

**Tests.** `FileListerSourceOpExecSpec` (emits the listing; no database); new `FileScanOpExecSpec`
(a listed name is read through its link; an unlisted name and a local path are refused with the
message); `WorkflowCompilerSpec` (union through a UDF; the cap error; the no-upstream error); new
`LakeFSDatasetVersionListerSpec` (stubbed client: paths, physical addresses, access refusal, cap).

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.LakeFSDatasetVersionListerSpec" "WorkflowOperator/testOnly org.apache.texera.amber.operator.source.dataset.* org.apache.texera.amber.operator.source.scan.file.*" "WorkflowCompiler/testOnly org.apache.texera.common.compiler.WorkflowCompilerSpec"`.
Harness: scenarios f and f2.

**Done when.** The specs pass and harness f and f2 pass with Checks A–F.

### Brief 18. `test(amber): pin a unit starting runs without Postgres reads`

**Goal.** An in-repo spec that fails if the unit reads Postgres while starting a run, or touches a
table other than the three run-state tables during it: the step's done-when, kept by CI.

**Depends on.** 16, 17.

**Files.** New `amber/src/test/scala/org/apache/texera/web/service/UnitStartReadsNoPostgresSpec.scala`
using `StatementRecorder` (sub-part 2).

**Behaviour.**
1. Outside the recording: `MockTexeraDB`, the Postgres JDBC catalog, a user, a workflow, a local unit,
   warehouses off; the fixture linker and HTTP server (sub-part 16) and a stub lister listing two
   fixture files; the LakeFS endpoint set to a closed port (`http://127.0.0.1:1`), so any LakeFS call
   would fail the run. `ExecutionCreator` creates two executions: CSV scan → Filter, and File Lister →
   File Scan From Input.
2. For each: record from `WorkflowService.startStoredExecution(…)` until the metadata store reports
   RUNNING: no statement starts with `SELECT` or `WITH`; each is an INSERT or UPDATE on
   `workflow_executions`, `operator_port_executions` or `operator_executions`.
3. Keep recording until COMPLETED: no other table appears (the result service's SELECTs on those three
   tables are allowed until step 3).
4. The run completes with the expected rows.

**Tests.** The spec itself; it must fail when a `SiteSettings.getInt` call is put back into
`CSVScanSourceOpExec` (check once by hand, do not commit).

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.UnitStartReadsNoPostgresSpec"`.

**Done when.** The spec passes in CI's amber job; PR C's harness gate passes, including the negative
controls (§7 H5).

### Brief 19. `feat(amber, frontend): edit Python environments at the Dashboard`

**Goal.** Environment definitions (rows of `virtual_environments`) are listed, created, edited and
deleted at the Dashboard service, scoped to the caller and validated by one shared grammar. The
frontend uses these endpoints. The unit's `/api/pve/db*` endpoints stay, unused, until sub-part 21.

**Depends on.** Nothing in this step (it is grouped in PR D).

**Files.**
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/PythonRequirements.scala`:
  `validateName(name): Either[String, String]`; `canonicalLines(packages: Map[String, String]):
  Either[String, Seq[String]]` with the rules of §3.8 (PEP 503 name normalization; spec `""`, `==V`,
  `>=V` or `<=V`; at most 200; refuses a leading `-`, space, `,`, `;`, `@`, `/`, `:` or `[`; lines
  sorted and distinct); `digest(lines)` = lowercase hex sha256 of the lines joined by `\n`;
  `validateLine(line)` for the engine's re-check.
- New `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/environment/EnvironmentResource.scala`
  (`@Path("/environments")`, `@RolesAllowed(Array("REGULAR", "ADMIN"))`): `GET` (the caller's rows),
  `POST` (201; 400 invalid; 409 the name exists for this user), `PUT /{veid}` (200; 400; 404 not the
  caller's; 409), `DELETE /{veid}` (204; 404). Adapt `VirtualEnvironmentResource` from commit
  `05a5ba888` of `texera-worktrees/cu-dashboard-dispatch`
  (`amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/environment/VirtualEnvironmentResource.scala`)
  and add the validation.
- `amber/src/main/scala/org/apache/texera/web/TexeraWebApplication.scala`: register it.
- `frontend/src/app/workspace/service/virtual-environment/virtual-environment.service.ts`: `savePve`,
  `updateUserPve`, `listUserPves`, `deleteUserPve` call `/api/environments` (same method names).
- `frontend/src/app/dashboard/component/user/user-venv/user-venv.component.ts`: the server's name rule
  in the form; a 400's message shown as the error.

**Behaviour.** §3.8. Rows written before this step are listed as stored; saving one requires it to
pass the grammar.

**Tests.** New `EnvironmentResourceSpec` (uid scoping; 409 duplicate; 404 another user's row; 400 for
`-r x`, `pkg @ http://…`, `a,b`, `x y`, `pkg[extra]`; the 201 shape); new `PythonRequirementsSpec`
(canonical lines, normalization, digest, each refusal);
`frontend/src/app/workspace/service/virtual-environment/virtual-environment.service.spec.ts`;
`frontend/src/app/dashboard/component/user/user-venv/user-venv.component.spec.ts`.

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.workflow.PythonRequirementsSpec"`;
`STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.resource.dashboard.user.environment.EnvironmentResourceSpec"`;
`cd frontend && npx ng test --watch=false --test-file src/app/workspace/service/virtual-environment/virtual-environment.service.spec.ts`
and `--test-file src/app/dashboard/component/user/user-venv/user-venv.component.spec.ts`.

**Done when.** The specs pass; the Environments page lists, saves and deletes through `/api/environments`.

### Brief 20. `feat(amber): install a run's Python environments on the unit`

**Goal.** The plan carries the package list of every Python environment its operators name. The
unit installs a list the first time it sees it, shares the install between runs, reports it on the
console, and fails the run at start with pip's message when it cannot install. No fallback to the
default interpreter remains.

**Depends on.** 14, 15, 16, 19.

**Files.**
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/PythonEnvironment.scala`:
  `sealed trait PythonEnvironmentRef`; `case object EngineDefault`; `case class Named(name: String)`;
  `case class Resolved(spec: PythonEnvironmentSpec)`; `PythonEnvironmentSpec(name: String,
  requirements: Seq[String], digest: String)` requiring sorted, distinct, valid lines and the matching
  digest (`PythonRequirements`).
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/PhysicalOp.scala`:
  `pythonEnvironment: PythonEnvironmentRef = EngineDefault` replaces `pveName` (`:220`);
  `withPythonEnvironment` replaces `withPveName` (`:414`); `requireEnvironmentResolved()` (a `Named`
  op → `IllegalStateException`).
- `storedplan.proto` and `PhysicalPlanCodec.scala`: format 3; `StoredPhysicalOp` drops `pveName`
  (`reserved 13; reserved "pveName";`) and gains `StoredPythonEnvironment pythonEnvironment = 15`;
  `Resolved` ↔ the message, `EngineDefault` ↔ absent, `Named` refused on encode; goldens
  `physical-plan-v3.json` and `operator-update-v3.json` replace the v2 ones.
- UDF descriptors: `common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/udf/python/PythonUDFOpDescV2.scala:160-177`,
  `DualInputPortsPythonUDFOpDescV2.scala:112-170`, `source/PythonUDFSourceOpDescV2.scala:88-113`:
  `.withPythonEnvironment(if (defaultEnv) EngineDefault else Named(envName.trim))`.
- New `common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/PythonEnvironmentResolver.scala`
  (`resolve(name): PythonEnvironmentSpec`, `Unavailable`); `RunBindings` gains `environments`;
  `WorkflowCompiler`: `bindEnvironments`, Strict, after expansion: each `Named(n)` →
  `Resolved(resolver.resolve(n))` plus `locationPreference = Some(PreferCoordinator)`; errors per
  operator ("Python environment '<n>' does not exist", or the grammar error with the offending line).
  Lenient leaves `Named`.
- New `amber/src/main/scala/org/apache/texera/web/service/execution/DashboardPythonEnvironmentResolver.scala`:
  the row of `virtual_environments` with (uid, name); its JSONB packages through
  `PythonRequirements.canonicalLines`. Used by `ExecutionCreator` and `OperatorUpdates`.
- New `amber/src/main/scala/org/apache/texera/amber/engine/architecture/pythonworker/environment/EngineInterpreter.scala`:
  the engine interpreter's identity, site directories and constraint lines (§4 Environment install,
  step 2), computed once per JVM through a process-runner seam like `PveManager.runProcess`.
- New `.../pythonworker/environment/PythonEnvironmentInstaller.scala`: `ensure(spec, listener):
  Future[InstalledEnvironment]` and `installedInterpreter(spec): Option[Path]`, implementing §4
  Environment install steps 1–5 exactly: per-key single flight in the JVM, file lock, `venv`, the
  `texera-engine-site.pth` file, requirements and constraints files, pip with the given flags and
  environment, `pip freeze --local`, the marker by atomic move, the 30-minute timeout destroying the
  process tree, removal of the directory on failure only, the map entry removed on completion. Root
  and timeout from `udf.conf` (`udf.python.environments.root`, `install-timeout-minutes`, with the env
  overrides of §3.9) through `UdfConfig`.
- `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/config/WorkerConfig.scala`:
  `pythonEnvironment: PythonEnvironmentRef` replaces `pveName` and `cuid`; `generateWorkerConfigs(op)`
  loses its `cuid` parameter; `ResourceAllocator.scala` and `ScheduleGenerator.scala:42` stop passing
  it.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/WorkflowContext.scala`:
  remove `cuid` and every use (`StoredExecutionStart`/`startStoredExecution`'s cuid line,
  `PhysicalPlanCodec.decode`, `PhysicalPlanRoundTrip`'s "no unit" assertion, `TestUtils`).
- `amber/src/main/scala/org/apache/texera/amber/engine/architecture/pythonworker/PythonWorkflowWorker.scala:235-246`:
  `choosePythonBin()` → `EngineDefault` → `PythonUtils.getPythonExecutable`; `Resolved(spec)` →
  `PythonEnvironmentInstaller.installedInterpreter(spec)` or fail "Python environment '<name>' is not
  installed on this unit"; `Named` → fail. Remove the `PveManager` import.
- `amber/src/main/scala/org/apache/texera/amber/engine/common/client/AmberClient.scala`: `def
  isActive: Boolean`.
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionConsoleService.scala`:
  `addUnitMessage(operatorId, msgType, title, message)` (a `ConsoleMessage` with the unit as source,
  through the same store-and-writer path as worker messages) and a public `closeWriters()`.
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala`: in `startFrom`,
  after READY: `requireEnvironmentsResolved`; the distinct `Resolved` specs in plan order; none →
  `startWorkflow` now; otherwise `PythonEnvironmentInstaller.ensure` each, with a listener that writes
  §4's console messages to every operator using that environment and a 30 s "still installing" ticker;
  when all complete (on the installer's thread, never the socket's): if `!client.isActive` or the state
  is terminal, do nothing; on failure, close the console writers and report the fatal error of §4
  step 6 through `errorHandler`; otherwise `startWorkflow`.
- `amber/src/main/scala/org/apache/texera/web/service/execution/OperatorUpdates.scala`: the environment
  check of sub-part 10 compares resolved environments.
- `frontend/src/app/workspace/component/property-editor/operator-property-edit-frame/operator-property-edit-frame.component.ts:703`:
  `envName` choices from `listUserPves()` (the Dashboard's list), not `fetchPVEs(cuid)`.

**Behaviour.** §4 Environment install; D20–D22, D36. A missing environment fails create on that
operator. A kill during the install ends only that run's waiting.

**Tests.**
- New `PythonEnvironmentInstallerSpec` (fake runner): fresh install; reuse by marker; two waiters, one
  install; a killed waiter does not stop the install and the other waiter's run starts; failure removes
  the directory and reports pip's tail; timeout; the constraints drop `-e`, URL and `pip` lines; an
  invalid line is refused before pip; a digest mismatch is refused; the `.pth` file lists the engine's
  site directories.
- New `PythonEnvironmentInstallIntegrationSpec` (tag `IntegrationTest`): builds a one-module wheel with
  `pip wheel` and installs it offline (`PIP_NO_INDEX=1`, `PIP_FIND_LINKS=<dir>`) twice, once with the
  system interpreter and once with an engine interpreter that is itself a venv holding a module the
  worker imports (C19): the installed venv imports both.
- `PythonWorkflowWorkerSpec`: fail-closed cases replace the fallback cases (`:185-217`).
- `PhysicalOpSpec`; `PhysicalPlanCodecSpec` (format 3, goldens); `WorkflowCompilerSpec` (a missing
  environment is an error on that operator; `Named` → `Resolved`; `PreferCoordinator`).
- `WorkflowExecutionServiceSpec`: an install failure → FAILED before start with the console messages;
  reuse; a kill during the install → KILLED and `startWorkflow` never called.
- `ExecutionResourceSpec`: missing environment → 400.
- `frontend/src/app/workspace/component/property-editor/operator-property-edit-frame/operator-property-edit-frame.component.spec.ts`.

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.workflow.*" "WorkflowCompiler/testOnly org.apache.texera.common.compiler.WorkflowCompilerSpec"`;
`STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.amber.engine.architecture.pythonworker.* org.apache.texera.web.service.*"`;
`UDF_PYTHON_PATH=… AMBER_TEST_FILTER=integration-only sbt "WorkflowExecutionService/testOnly org.apache.texera.amber.engine.architecture.pythonworker.environment.PythonEnvironmentInstallIntegrationSpec"`;
the frontend spec. Harness g, h, i. Local-dev by hand: an environment run with the engine on
`venv312`.

**Done when.** The specs pass; harness g, h and i pass with Checks A–F;
`git grep -ln "SqlServer\|PveManager\|WorkflowExecutionsResource" -- amber/src/main/scala/org/apache/texera/amber/`
finds nothing.

### Brief 21. `feat(amber, frontend): drop Python environments from the unit`

**Goal.** The unit serves no environment endpoint and keeps no per-unit environment; the routes to
them are gone in every mode.

**Depends on.** 20.

**Files.**
- Delete `amber/src/main/scala/org/apache/texera/web/resource/pythonvirtualenvironment/{PveResource,PveWebsocketResource,PveManager}.scala`
  and their specs (`amber/src/test/scala/org/apache/texera/web/resource/pythonvirtualenvironment/{PveResourceSpec,PveWebsocketResourceSpec}.scala`).
- `amber/src/main/scala/org/apache/texera/web/ComputingUnitMaster.scala`: unregister them (`:130-135`,
  `:165`).
- `frontend/src/app/workspace/service/virtual-environment/virtual-environment.service.ts`: delete
  `getSystemPackages`, `fetchPVEs`, `getUserPackages`, `deleteEnvironments`, `deletePackage`,
  `getPveWebSocketUrl`.
- `frontend/src/app/workspace/component/power-button/computing-unit-selection.component.{ts,html}`:
  delete the environments modal, its button and the delete-on-terminate call (`:146`, `:742`, `:975`,
  `:1089-1106`, `:1190`, `:1259`, `:1398`); `frontend/src/styles.scss`: the modal's styles.
- `bin/single-node/nginx.conf`: delete `location /api/pve/` (`:121-125`).
- `frontend/proxy.config.json`: delete the `/api/pve` entry (`:73-77`).
- `bin/k8s/templates/base/gateway/gateway-routes.yaml`: delete the `PathPrefix /api/pve` match
  (`:179-181`).
- `access-control-service/src/main/scala/org/apache/texera/service/resource/AccessControlResource.scala`:
  delete `pveRoute`, `pvePvesCuidPath`, `pvePackagesCuidPath` and the path-cuid lookup (`:49-53`,
  `:85`, `:158-159`).

**Behaviour.** `/api/pve/*` and `/wsapi/pve` answer 404 (single-node, local-dev) or 403 (K8s
gateway's check).

**Tests.** `ComputingUnitMasterSpec` (no `/wsapi/pve`, no `/api/pve`);
`access-control-service/src/test/scala/org/apache/texera/AccessControlResourceSpec.scala` (pve paths
now 403; the cuid-from-path cases removed);
`frontend/src/app/workspace/component/power-button/computing-unit-selection.component.spec.ts`;
`virtual-environment.service.spec.ts`; `helm template` shows no `/api/pve`.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.ComputingUnitMasterSpec" "AccessControlService/testOnly org.apache.texera.AccessControlResourceSpec"`;
the frontend specs.

**Done when.** The specs pass;
`git grep -n "api/pve\|wsapi/pve\|PveManager\|PveResource\|PveWebsocketResource\|pveName\|fetchPVEs\|getPveWebSocketUrl" -- bin amber/src/main frontend/src/app access-control-service/src/main`
finds nothing; PR D's harness gate passes (g, h, i; g0 retired).
