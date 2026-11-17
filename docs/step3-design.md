# Step 3: run state and history live in the lake

Revision 2, 2026-11-16: revision 1 after an independent review, which also ran the one experiment
revision 1 had left open (§1b). Implementable design for step 3 of the Amber Engine Plan ("Store
run state and history in the lake"). Repo paths are relative to the worktree
`/Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine` (branch
`feat/self-contained-engine`), read at commit `f8b43b980`: step 1 and step 2's sub-parts 1–13. Line
numbers are from that commit. Step 2's sub-part 14 was committed while the review ran
(`258d6ae54`); what it changes for this step's briefs is listed at the start of §13. The design
assumes step 2 is complete when step 3 starts (sub-parts 14–21: the unit's compile path is gone,
input files are links, environments travel in the plan). Where one of those sub-parts rewrites a
file, the brief says what step 3 needs there instead of a line.

Measured numbers come from the step 0 proof (`texera-worktrees/sce-step0-proofs/proofs/step0/iceberg-commits/RESULTS.md`:
Lakekeeper v0.11.0, Iceberg Java 1.9.2, Texera's own writer and reader), from the per-row
profile taken after it (the share of `Tuple`'s size computation), and from the review's two probes
against the same lake (§1b). Upstream state was read with `gh` on 2026-11-16.

How to read it: §0–§4 are the design, §1b what the review found and changed, §5 the commit order
and what was left out, §6–§9 users, harness, deployment and risks, §10 upstream work, §11 the
questions for the owner, §12 the author's own attack on revision 1, §13 one brief per sub-part
that an engineer can follow on its own, and the appendix the briefs of the sub-parts left out.

Words used throughout:

- **execution log** (or "the log"): the new Iceberg table, one per execution, that holds the run's
  state changes. It is not the replay log (`workflow_executions.log_location`,
  `fault-tolerance.log-storage-uri`), which stays as it is.
- **label**: six table properties on the log table that repeat the newest state, so a reader gets
  it with one `loadTable`.
- **beat**: the engine refreshing one of those properties on every timer tick.
- **closing record**: the columns the Dashboard service writes into an execution's Postgres row,
  once, when the execution is over.
- **open / closed**: an execution whose row has no closing record yet / has one.

## 0. The step in one picture

```
BEFORE (end of step 2)
  unit ──UPDATE status, last_update_time (every state change)──────────▶ Postgres
  unit ──INSERT result and console locations · UPDATE sizes, row counts, statistics location──▶ Postgres
  unit ──statistics and console rows: after 4096 rows or at the end──▶ lake     (lost when the unit dies)
  unit ──TTL job · clears results 30 s after the last viewer · sends the email──▶ Postgres, lake, SMTP
  Dashboard lists · admin list · quota · the unit manager's idle sweep ◀── Postgres status and sizes
  Kubernetes: statistics and export ◀── the unit (so the unit must be alive)
  a unit that vanishes leaves its run "Running" for ever (#8934, #8618)

AFTER
  unit ──log row + label (each state change) · statistics, console, beat (every 30 s) · tidy──▶ lake
  unit ──nothing──▶ Postgres            (no pool; in Kubernetes no login)
  Dashboard timer (30 s), over open rows:
        label says ended ─────────────────────────▶ copy the outcome
        unit's row terminated, or the beat stopped ─▶ "failed: unit lost"
        created and never started ────────────────▶ take its one start, "failed: never started"
        then: size, email, and later expire results (plan, log and statistics stay)
        ──outcome, reason, ended_at, stored_bytes (once)──▶ Postgres
  unit manager: stamps a unit's row terminated as it does today (a user terminates it, the idle
        sweep does, a listing finds its pod gone); the idle sweep reads ended_at
  browser: live view ◀── the unit's websocket (until step 4)
           a run its unit no longer shows ◀── Dashboard, asked every 5 s until the run is closed
           lists, state, log, statistics, console, export ◀── Dashboard (Postgres row + lake)
           result pages ◀── the unit's websocket, for the run it holds (until the result service
                            takes them, #8995 and #8996)
```

Done when:

1. Killing a unit mid-run shows "failed: unit lost" in the workspace and in the history, in
   single-node, Kubernetes and local-dev.
2. The unit sends no statement to Postgres for a run and holds no connection to it. Evidence: an
   in-repo spec that runs an execution on a unit with no database (sub-part 17), the harness's
   statement log, `pg_stat_activity`, and a unit on a network without Postgres (§7).
3. A day-long run (2,880 timed commits, 10 operators, 28,800 statistics rows) reads its state in
   under 50 ms and its statistics in under a second, during the run and after it (sub-part 7's
   benchmark, and harness scenario y).

## 1. Corrections to the tracker's sketch

Each correction is checked against the code at `f8b43b980` or against upstream with `gh`.

C1. **"Postgres keeps only the fact that the execution exists" cannot hold as written.** Four
things other than "show one execution" need an ending without opening the lake. The admin list
filters by status and sorts by end time in SQL (`AdminExecutionResource.scala:84-87`, `:160-176`).
The history filters by status in SQL (`WorkflowExecutionsResource.scala:321-325`). The unit
manager, another service with no lake client, asks per unit "is any execution still active, and
when did one last end" (`ComputingUnitManagingResource.scala:188-191`, `:247-260`). And the timer
job itself has to find the executions that are still open; without a mark in the row it would read
every execution's log on every tick, for ever. The agreed plan page already says so ("outcome, once
closed", listed under Assumed). So the row gets a closing record, written once by the Dashboard
(D20). The state of an open execution is never in Postgres.

C2. **"When the unit's platform says the unit is gone" does not cover local units, and covers
Kubernetes only in part.** A local unit has no platform: creating one starts nothing and its status
is always Running (`ComputingUnitHelpers.scala:89-91`); single-node's unit is a compose container
the manager never sees (`bin/single-node/docker-compose.yml:406-420`); local-dev's is a host JVM.
In Kubernetes a vanished pod is noticed only when somebody lists units
(`ComputingUnitHelpers.scala:320-336`), and a pod that failed but still exists, or a JVM that
restarted inside a live pod, is not "gone" at all. So the done-when cannot be met in two of the
three modes by asking a platform. The engine therefore also shows that it is alive: a beat in the
log's label (D12), which the Dashboard watches (D26). What the platform said is the fast path
where there is one.

C3. **The Dashboard service cannot ask Kubernetes, and should not start to.** The Kubernetes client
and its rights are the unit manager's (`KubernetesClient.scala`, the manager's Role). The manager
already records what it learns in the unit's row (`terminate_time`, `termination_reason`), and the
Dashboard reads the row (D27). No service calls another, and none calls a unit. A timer in the
manager that asks the platform on its own was in revision 1 and is left to step 6 (§5).

C4. **"The engine writes the log" needs one write path, and today there are thirteen.** State is
set at 13 call sites (`ExecutionRuntimeService.scala:67,81,90,96,106`;
`WorkflowExecutionService.scala:644,662`; `WorkflowService.scala:278,523`;
`ExecutionStatsService.scala:308`; `SyncExecutionResource.scala:438,497`;
`ClusterListener.scala:90`), all through the static `ExecutionStateStore.updateWorkflowState`
(`ExecutionStateStore.scala:39-52`). KILLED, PAUSING and RESUMING never come from the engine
(`ExecutionRuntimeService.scala:79-108`). The errors of a failure are attached after the state is
written (`ExecutionStatsService.scala:306-317`: `updateWorkflowState(FAILED, …).addFatalErrors(…)`),
so "and why" is not known where the state is stored. An unfinished run that the idle clean-up lets
go of gets no ending at all (`WorkflowService.scala:245-251`: a paused run with no viewer is shut
down after 30 s, `WorkflowLifecycleManager.scala:39-49`, `:84-89`). And the agent path ends a run
twice, KILLED then COMPLETED (`SyncExecutionResource.scala:429-439`). Step 3 gives the unit one method
that takes the state and the why, and an ending that happens once (D5, D8).

C5. **"It commits on a timer" needs fewer rows, not only fewer commits.** The engine emits a
statistics snapshot of every operator every 2 s (`application.conf:35`,
`CoordinatorTimerService.scala:82-88`) and again on every worker state change
(`WorkerStateUpdatedHandler.scala:54-56`), and today each one becomes a row per operator
(`ExecutionStatsService.scala:194-202`, `:240-263`). A day of that is 432,000 rows for 10
operators before the bursts. The measured day (28,800 rows, 0.47 s through Texera's reader, 22–38 ms
raw) is one row per operator per commit. So the writer keeps only the newest snapshot between
commits (D10).

C6. **"Tidies the tables" cannot mean compaction for result tables.** Texera reads rows in the
order of each file's sequence number (`IcebergDocument.scala:313`). A compaction keeps that order
only if nothing appends between its plan and its commit. That holds for a table with one writer
that also runs the compaction; a result table has one writer per worker
(`OutputManager.scala:318-335`) and Python writers besides. So log, statistics and console are
compacted, and result tables are left as they are (D13, D14).

C7. **Console output is one table per operator, found only through Postgres.** The table is made on
an operator's first message and registered in `operator_executions`
(`ExecutionConsoleService.scala:143-166`); each row is the message as protobuf text in one column
(`:295-299`). With timed commits that would be one commit per operator per tick. It becomes one
table per execution with real columns, at a location known from the execution alone (D11), which
is also what the plan page draws ("console").

C8. **A reader cannot find an execution's result tables without Postgres today.** Which ports are
stored is decided by the scheduler on the unit; the unit tells its web layer
(`RegionExecutionManager.scala:705-709`, `OperatorPortResultUriAvailable`), which inserts a row per
port (`ExecutionResultService.scala:92-104`). The four namespaces are shared by all executions
(`DocumentFactory.scala:47-56`), so they cannot be listed per execution at a sane cost. The log
therefore also records each stored output port (D2). This is the owner's rule "the unit derives
output locations and reports them", with the lake as where it reports.

C9. **"Sends the email" changes when emails go out.** Today the unit emails only on a state the
engine reports through `ExecutionStateUpdate` (`ExecutionRuntimeService.scala:65-70`): completed and
paused. A kill and a fatal error do not pass that callback (`:102-108`,
`ExecutionStatsService.scala:297-320`), so they send nothing, although the notifier lists them
(`WorkflowEmailNotifier.scala:111-119`). The send itself is SMTP from the unit
(`GmailResource.scala:112-131`), one more outside call the unit makes. A job that closes
executions can email once per execution, on its ending; it cannot see a pause without keeping
more state (D30).

C10. **"Expires results" has nothing to build on.** The unit's TTL job selects rows whose `result`
or `log_location` is non-empty, and `result` is never written, so it matches nothing in the default
configuration (`WorkflowExecutionsResource.scala:98-115`, `ComputingUnitMaster.scala:241-256`).
What really removes results today is the unit, 30 s after the last viewer leaves
(`WorkflowService.scala:245-251`), and the next create (step 2, D8). Neither drops the state table
that is created beside every result table (`RegionExecutionManager.scala:701-704`;
`ExecutionResources.scala:192-234` clears results and console only). Step 3 has one expiry, at the
Dashboard, that knows every table of an execution from its log (D31).

C11. **"The result service serves…" names a service that is not deployed in any mode.** `build.sbt`
has no result-service module. Upstream PR #9356 (open, approved by one reviewer, waiting for the
owner's review) adds the module and its CI legs only; its image, Helm chart, gateway route and
local-dev entry are "a second PR", and the result panel moves in #8996. Its lookups read the
columns this step removes (`operator_port_executions.result_uri`, `output_mode`, `result_count`,
and `workflow_executions.status`). Statistics and export are out of that track's scope ("follow-ups").
They already have a home that reads the lake: the Dashboard registers
`WorkflowExecutionsResource` (`TexeraWebApplication.scala:159`) and serves both in single-node and
local-dev (`bin/single-node/nginx.conf:137`); only Kubernetes sends them to the unit
(`bin/k8s/templates/base/gateway/gateway-routes.yaml:188-191`). So in this step the Dashboard
serves stored state, log, statistics, console and export in every mode, result pages stay on the
unit's websocket for the run the unit holds, and the result service gets a way to find results
that needs no Postgres registry (D34–D36; open decision 3).

C12. **"Status, result locations and row counts leave Postgres" is five columns and two tables.**
`workflow_executions.status`, `last_update_time`, `result` (dead), `runtime_stats_uri`,
`runtime_stats_size` (`sql/texera_ddl.sql:318-339`); `operator_executions` and
`operator_port_executions` with `output_mode` and `result_count` from #9049 (`:540-562`), and the
type `output_mode_enum` (`:107`).

C13. **The read cost of a day is mostly not Iceberg.** `Tuple` computes its in-memory size in its
constructor (`Tuple.scala:55`, about 60% of the per-row cost); the projected schema is rebuilt for
every row (`IcebergDocument.scala:394-398`) and the Amber schema for every record
(`DocumentFactory.scala:96-97`); `getCount` plans the whole table (`IcebergDocument.scala:131-140`),
so a page read plans it twice. The new tables are therefore read without `Tuple` at all (D18),
which is all the day-long target needs. Making `Tuple`-based reads cheaper helps result pages and
is an independent change, left out of this step (§5).

C14. **Texera's Iceberg timestamps have no zone.** `AttributeType.TIMESTAMP` maps to
`TimestampType.withoutZone()` (`IcebergUtil.scala:284`), and a `Timestamp` is stored as the wall
clock it holds (`:303-311`). A run that crosses the autumn clock change reads its times back out of
order (seen in the step 0 proof). The log, statistics and console tables store epoch milliseconds
(D7).

C15. **A reader that resumes from a snapshot breaks when that snapshot is expired.**
`IcebergDocument`'s iterator keeps `lastSnapshotId` and asks for an incremental scan from it
(`IcebergDocument.scala:294-303`); after a tidy that fails with "Starting snapshot (exclusive) … is
not a parent ancestor of end snapshot". The reader that reads a stored port as the next region's
input holds such an iterator. So this step expires no snapshot of a result table: only the
recorder's own three tables are tidied, and nothing reads those through that iterator (D14, D15).

C16. **"The unit holds no Postgres connection" is true of Texera's database, with the REST
catalog.** With `STORAGE_ICEBERG_CATALOG_TYPE=postgres` (the amber specs, and deployments that chose
it) the Iceberg catalog itself is a JDBC connection from the unit, and the manager forwards its
login (`ComputingUnitManagingResource.scala:315-333`). The done-when is checked on the REST
catalog, the default and the only one per-user warehouses work with. Whether the other catalog
types stay is step 5's question.

## 1b. Review findings and what this revision did

Revision 1 was attacked by a reviewer who had not written it: the code was read at `f8b43b980`
(`git show`, since another agent was editing the worktree), two probes were run against the step 0
lake, and this document was then revised. Blocker: a sub-part fails as written. Major: wrong
behaviour, or a done-when missed in a case that happens. Minor: everything else.

**The assumption revision 1 had not tested holds.** Lakekeeper v0.11.0, Postgres 15 and RustFS
1.0.0 from the step 0 `stack.sh`; Iceberg Java 1.9.2 with `RESTCatalog` and `S3FileIO`, set up as
`IcebergUtil.createRestCatalog` sets them up (remote signing, no keys on the client):

- One `table.newTransaction()` holding `newFastAppend()` and `updateProperties()` reaches Lakekeeper
  as one commit: one new metadata file, the sequence number up by one, one snapshot, the
  properties set. A second client sees neither before `commitTransaction()`.
- 300 such commits while three other clients loaded the table in a loop: 16,638 loads, each client
  saw all 301 states, and no load saw a label ahead of its row or a row ahead of its label. The
  control, the same 300 as two commits each: 3,775 of 13,783 loads saw the row without its label,
  so the check does see a gap when there is one.
- 150 beats (properties only): no snapshot added, the state properties untouched; 34 ms p50 on a
  table that had 601 snapshots, 20 ms on fresh tables. Lakekeeper writes one metadata file per
  commit and kept the newest 100.
- A manifest rewrite and an expiry down to one snapshot leave the label, and `total-records` in the
  summary, as they were. Reading a label is one `loadTable`: 0.8 ms p50, 2.7 ms p95.
- Load: 200 tables, each tick one appended file and one beat. 8 at a time: 158 commits a second;
  32 or 64 at a time: about 260. 200 labels read 8 at a time, as the Dashboard's job reads them:
  0.17–0.20 s. One laptop, so the absolute numbers are optimistic.

The probes are two single-file Java programs run on the step 0 worktree's test classpath, without
sbt (`LabelCommitProbe.java`, `ManyRunsProbe.java`; kept for this session under the session
scratchpad's `step3-critic/`).

| Finding | Severity | What this revision did |
|---|---|---|
| R1. Sub-part 14 re-bases `ExecutionResultUris` on the log, but the unit's own lookups (`ExecutionResultService.scala:175`, `:378`, `:421`, `:476`; `SyncExecutionResource.scala:655`) and the e2e `TestUtils` (`:205`, `:284-286`) call it until sub-part 17. Between the two, the e2e specs, which run no recorder, find no result, and the unit's 3 s poll does a Postgres SELECT and reads its own log from the lake, racing the recorder's commit | blocker (ordering) | The unit and `TestUtils` find a run's results in the recorder's memory from sub-part 5 on (briefs 5, 14, 17; D34). From then on `ExecutionResultUris` is only the Dashboard's |
| R2. The workspace stopped asking the Dashboard as soon as its socket was back (D37). A unit whose JVM dies in a pod or container that restarts is back in under a minute, the verdict takes three and a half, and a new socket is first told "Uninitialized" (`WorkflowWebsocketResource.scala:74`): the workspace would show an idle workflow and never "failed: unit lost". Step 2's sub-part 14, committed meanwhile (`258d6ae54`), makes the page forget its execution on exactly that event | major (done-when 1) | D37, §4.6, brief 15: the browser asks while the unit does not show the execution it follows, socket up or down, and keeps that execution apart from the one the unit names; a state event without an id does not replace what it shows; harness q runs a second time with the unit restarted at once |
| R3. A scheduled task that throws is never run again (`ScheduledExecutorService`), so one unexpected error in a tick would end the beat and a healthy run would be closed "unit lost". The beat was also the last step of a tick, behind writes that can hang | major (false verdict) | §4.1: a tick never throws, and the beat is its first step; `ExecutionRecorderSpec` cases; §9 |
| R4. Executions made before the step keep a statistics table, in the old schema (`time TIMESTAMP`, `ResultSchema.scala:27`), at the very location the new readers derive from the row. Revision 1 promised "without statistics" and did not say how. Depending on how the store maps columns the chart would show 1970, the year 50,000 or an error | major (old rows) | §3.3, brief 4: a statistics table without `timeMs` reads as empty, for the route, the heat map and the cost hints alike. §4.4, §8: deleting such an execution after the upgrade finds its tables by name |
| R5. `completionTime` was null for every open row. The history subtracts it from the start time for every row (`workflow-execution-history.component.ts:754`), so one running execution would put about minus thirty million minutes into the processing-time chart. Today the field is `last_update_time` | major (UI) | D21, §3.5, brief 12: never null; while open it is the time of the newest state change, as today |
| R6. More machinery than the done-when needs. Sub-part 8 (timed result commits) also carried a regression: without compaction, which C6 rules out, a slow result becomes one file per writer per interval, and a full read pays 3.5–6 ms per file. Sub-part 10 (a platform interface and a timer in the manager) shortens only the wait of a run nobody watches. Sub-part 1 (cheaper `Tuple` reads) is not on the path the day-long target measures | major (scope) | Sub-parts 1, 8 and 10 are left out (§5; their briefs are in the appendix). D9, D14, D15, D17, D27, D42 and the shapes follow. The three tidy settings are constants. Open decision 6 |
| m1. D3 said a beat "adds no file": Lakekeeper writes a metadata file per commit and keeps 100 | minor | D3 |
| m2. "Every 50 commits" would count beats, which add nothing to tidy | minor | D13, §4.1: appends only |
| m3. §9's "about 35 commits per second with 20 writers" is in no measurement; the probe measured about 260 | minor | §9 |
| m4. With fault tolerance on, the unit's TTL job is what deletes replay logs (`ComputingUnitMaster.scala:241-256`); with the job gone nothing would | minor | D31, D40, §4.4, brief 14: the expiry by age does it |
| m5. An execution closed "never started" would send its owner an email | minor | D30, brief 13 |
| m6. `ended_at` comes from the unit's clock and could lie in the future | minor | D26, §4.3: kept between `starting_time` and the Dashboard's now |
| m7. Two readers of run status were not listed: the editor's lock ("is a run of this workflow in progress", `computing-unit-selection.component.ts:308-327`) and the unit pre-selection (`:396-411`) | minor | §4.5; §6 says how long a lost or never-started execution keeps the editor locked |
| m8. Statistics and console tables were made on first use, so a run that wrote none could be answered from a table of the same name left by an earlier database | minor | §3.1, §4.1: the three tables are made together at the start, each replacing a stale one |
| m9. Check I's "one data file and one snapshot" cannot hold for a lost or stopped unit | minor | §7 H4 |
| m10. A retried append whose first try's outcome was unknown lands twice | minor | §3.8, D42: readers keep one row per `seq` |
| m11. Only `label` was said to tell "no table" from "cannot read"; a lost verdict or a "never started" taken from a failed read would close running executions | minor | §3.8: every read throws on a failure; `IcebergUtil.loadTableMetadata` is not used |
| m12. A raw JVM shutdown hook races the server's own stop | minor | §4.1, brief 5: a Dropwizard `Managed` |
| m13. Results now outlive the tab, but the workspace cannot page them once the unit has let the run go | minor | §6; open decision 5 |
| m14. "Numbers changed" (D10) left out the operator's state | minor | D10 |
| m15. The idle sweep's spec is `ComputingUnitIdleCleanupSpec`, which no brief named | minor | brief 12 |
| m16. Three pull requests for this step alone, on top of step 2's four, is not "three or four in the end" | minor | §5: A, B and C are harness gates; how they fold |
| m17. `ExecutionRecorder.none` was one shared value that remembers outputs: every run and spec using it would see the others' ports | minor | §3.8: a new one each time |
| Checked and found right | – | the 13 state-change sites; the Postgres uses left on the unit after step 2 (§12 item 1; no other in the unit's JVM, its Python workers or cluster workers); the readers of the dropped columns and tables in every service, the frontend, agent-service, the DDL and the deployment files (`WorkflowSearchQueryBuilder` reads `starting_time` only); the engine sends its last statistics before COMPLETED (`WorkerExecutionCompletedHandler.scala:52-70`), so the sample stored at the ending is the final one; `DocumentFactory.icebergTableOf` already throws on a catalog failure |

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| **The log** | | |
| D1 | The log is one Iceberg table per execution: resource type `EXECUTION_LOG`, URI `vfs:///[wh/<w>/]wid/<wid>/eid/<eid>/executionlog`, namespace `execution-log`, table `wid_<wid>_eid_<eid>_executionlog`, in the execution's warehouse. | The agreed layout until step 5 ("plan and log are two more kinds of table"). The URI stays when step 5 maps it to namespace `e_<eid>`, table `log`. The word "execution" keeps it apart from the replay log. |
| D2 | A row is one event. `state` rows: one per change of state (READY, RUNNING, PAUSED, COMPLETED, FAILED, KILLED) with why. `output` rows: one per stored output port (port, table location, output mode). | The newest `state` row is the run's state, so "paused" is recorded. `output` rows are how any reader, and the expiry, find an execution's tables without Postgres (C8). |
| D3 | The newest state is repeated in the table's label: six table properties, written in the same commit as the row they describe (§3.2). The state is read with one `loadTable`. | 1–3 ms against 20–38 ms for the newest row. Properties, not the snapshot summary: they survive compaction and snapshot expiry without being carried forward, and a beat is a 13–17 ms commit that adds no snapshot, data file or manifest (Lakekeeper writes one metadata file per commit and keeps the newest 100). Checked on Lakekeeper with Iceberg Java (§1b): the row and its label are one commit, and no concurrent reader saw one without the other. |
| D4 | The engine is the log's only writer. What the Dashboard concludes about an execution (it did not compile, it was never started, its unit was lost) goes into the execution's Postgres row. | One writer means no conditional appends and no "which ending counts". Engine facts are data in the lake; the control side's conclusions are its own record. Open decision 1. |
| D5 | An execution ends once. After an ending is recorded, later state changes are dropped with a warning. A run replaced by a new one ends KILLED, "replaced by execution N". An unfinished run the idle clean-up lets go of ends KILLED, "stopped: nobody watched it for 30 s". The agent's "targets are done" ends the run COMPLETED, "stopped once its target operators finished", in one step. A unit that is stopped politely ends its runs FAILED, "the computing unit was stopped". | C4. An append-only log cannot be overwritten, and "unit lost" should mean the unit said nothing. |
| D6 | PAUSING and RESUMING are not written to the log. | They are requests in flight, visible on the live socket. They would double the commits of every pause. |
| D7 | Times in the log, statistics and console tables are epoch milliseconds (`LONG`). | C14. |
| D8 | The writer is `ExecutionRecorder`, in an engine package with no web or database imports. It is fed from one method, `ExecutionStateStore.transitionTo(state, errors, reason)`, and from the statistics, console and output events. One thread per execution does all lake I/O for the log, statistics and console. | State changes are made under the state store's lock (`StateStore.scala:50-55`) and on actor and socket threads; a lake call there would stall the live view when the lake is slow. In step 4 the callers move; the recorder does not. |
| **Commits and tidying** | | |
| D9 | Commit policy (§3.1): a log row at once; statistics and console on the timer (`commit.interval-ms`, 30 s), at every state change and at the end; console also when 4,096 rows are buffered. Results are written as today: 4,096 rows per worker, and when the port ends. | A state change must be durable when it happens. Statistics and console may be one interval late; a killed unit loses at most that, and the result rows its writers had buffered, as today. Committing results on the timer too was sub-part 8 and is left out (§5). |
| D10 | Stored statistics are sampled at the commit: one row per operator whose row would differ from its last stored one in any column but the time (its counts, its times, its workers, its state). The live view still gets statistics every 0.5 s from memory. | C5. Rows ≤ commits × operators, which is the measured day. |
| D11 | Console output is one table per execution with columns `seq, timeMs, operatorId, workerId, msgType, source, title, message`, at `vfs:///[wh/<w>/]wid/<wid>/eid/<eid>/consolemessages`. Rows are buffered in memory, at most 50,000; beyond that the oldest are dropped and one row says how many. | C7. One commit per tick whatever the number of operators; found without a registry; readable without decoding protobuf text. The cap bounds memory when the lake is unreachable. |
| D12 | On every tick, as its first step, the recorder refreshes `texera.execution.beat-ms` in the label, whatever the state, also while paused or installing environments. The label also says how often (`beat-every-ms`). A tick never throws. | C2. One small commit per open execution per interval tells any reader the engine is alive, on every platform. First, so a write that hangs later in the tick cannot hold the sign of life back; and a scheduled task that throws is never run again, which would read as a lost unit. |
| D13 | Log, statistics and console are tidied by the recorder, on its own thread: every 50 appends to a table (a beat is not one), and at the end. A tidy merges the small files at the end of the table into one (files under 32 MB, never a file that reached it), rewrites the manifests into one, and expires snapshots. During the run it keeps the snapshots of the last 60 s and at least 5; at the end it keeps 1. These numbers are constants beside the recorder, not settings (§3.7). | Measured: a tidy every 50 commits costs about 0.6 s and keeps commits flat at about 0.1 s; untidied, a day reaches 0.28 s per commit and 14–17 s per read. Merging only small files keeps a tidy cheap for a chatty console. Nobody has a reason to tune them per deployment. |
| D14 | Result and operator-state tables are not tidied in this step: no compaction, no manifest rewrite, no snapshot expiry. The recorder touches only its own three tables. | C6, C15. Nothing tidies them today, and this step does not change how they are written. A compaction would reorder rows under several writers; an expiry would break the reader that resumes from a snapshot. The metadata tidy of revision 1 went out with sub-part 8 (§5). |
| D15 | Readers of the three tidied tables survive a tidy in two ways. A tidy never changes row order (D13) and keeps every snapshot of the last 60 s and at least 5, so the files a read planned usually outlive it. And every read plans the table's current snapshot when it starts, and plans again once if a file it planned is gone (the end-of-run tidy, or a burst of console commits during the read). No reader of these tables resumes from a snapshot id. | C15. |
| D16 | The recorder appends with `newFastAppend`. | 45 ms against 80 ms; the tidy rewrites manifests anyway. Result writers keep `newAppend`. |
| **Reading** | | |
| D17 | Withdrawn in revision 2. (It made `Tuple`-based reads cheaper: a tuple's size on first use, schemas built once per read, `getCount` from the snapshot summary.) | C13. Nothing this step measures reads through `Tuple` (D18). It was sub-part 1 and is left out (§5). |
| D18 | The log, statistics and console are read as Iceberg records mapped straight to their own case classes, never through `Tuple`. | 22–38 ms for a tidied day, measured. |
| D19 | An execution's state is read from the label. No reader needs the newest row. | D3. |
| **Postgres** | | |
| D20 | `workflow_executions` keeps `eid, vid, uid, cuid, whid, name, bookmarked, starting_time, environment_version, log_location`. It gains the closing record `outcome` (3, 4, 5), `outcome_reason`, `ended_at`, and `stored_bytes`, `results_expired_at`, `notification`. It loses `status`, `result`, `last_update_time`, `runtime_stats_uri`, `runtime_stats_size`. Tables `operator_executions` and `operator_port_executions` and type `output_mode_enum` are dropped. Only the Dashboard writes the row. | C1, C12. Each new column is read by something that must not open the lake: lists and the sweep (`outcome`, `ended_at`), the user (`outcome_reason`), quota (`stored_bytes`), the expiry (`results_expired_at`), the email (`notification`). Open decision 2. |
| D21 | The `status` number the API returns stays 0–5: the outcome for a closed execution; for an open one the label's state (READY 0, RUNNING 1, PAUSED 2), 0 when it has no log yet, -1 when the lake cannot be read. A new field `reason` carries `outcome_reason`, for callers who may read the execution's log (§3.5); others get null. `completionTime` stays a time for every row: `ended_at` when closed; while open, the time of the newest state change (the label's `state-time-ms`, never before `starting_time`), and `starting_time` when there is no label to read. | The frontend's status codes and filters stay. -1 already exists in today's data (PAUSING, RESUMING). A reason can quote an error message, which may quote data. `completionTime` is `last_update_time` today, and the history subtracts it from the start time for every row (`workflow-execution-history.component.ts:754`); a null there would wreck its chart while any run is open. |
| D22 | `stored_bytes` is one number: the bytes of the execution's result, state, console, statistics, log and plan tables when it was closed, set again when its results expire. | The quota page only ever adds the three sizes it gets (`user-quota.component.ts:307,333,345`). The unit no longer counts anything. |
| D23 | `operator_port_cache` is not touched. | It belongs to the result-cache work (#5880) and nothing reads or writes it. |
| **The Dashboard's timer job** | | |
| D24 | `ExecutionClosingJob` is a Dropwizard `Managed` object of the Dashboard service with its own single-thread scheduler, every `execution-closing.interval-seconds` (30). | The Dashboard has no actor system (`AmberRuntime.scala:56-77` skips silently). `IdleComputingUnitCleanupJob` is the model. |
| D25 | It learns an ending from the label: `state` is COMPLETED, FAILED or KILLED. It copies that state, the label's reason and `state-time-ms` into the closing record. | One `loadTable` per open execution per tick. |
| D26 | "Unit lost" is decided for an execution with no ending when (a) its unit's row is terminated, or (b) the beat has not changed while the job watched it for `lost-after-seconds` (180, and never less than 4 beats). The job counts its own ticks and compares the beat only with the value it saw before; it never compares the unit's clock with its own. Before it decides, it reads the log's rows; an ending there wins. A read of the lake that fails is never a reason: the execution is looked at again on the next tick. Reason "unit lost", or "unit terminated" when a user terminated the unit. | C2. Works on every platform, survives clock skew and a machine that slept, and a restarted or second Dashboard only decides later, never wrongly. |
| D27 | The Dashboard learns that a unit is gone from the unit's row, `terminate_time` and `termination_reason`, which the manager stamps already: when a user terminates the unit, when the idle sweep does, and when a listing finds its pod gone (`ComputingUnitHelpers.scala:320-336`, called at `ComputingUnitManagingResource.scala:871` and `AdminComputingUnitResource.scala:84`). The workspace lists units whenever its socket drops (`ComputingUnitStatusService.monitorConnectionStatus`), so a pod that vanishes under a watched run is stamped within seconds. This step adds no job and no interface to the manager. | C3. Without a browser on the workflow the beat decides (D26), three minutes later. A timer in the manager that asks the platform, behind a platform interface, was sub-part 10; it belongs to step 6, which designs that interface against more than one platform (§5). |
| D28 | An execution that was created and never started is closed after `never-started-after-seconds` (600): the job takes its one start (the `started` tag on the plan table) and, if it got it, closes the row "failed: never started". If a start got there first, the job leaves it alone. | Rows no longer stay at "Initializing" for ever, and nobody can start an execution the record says was never started. The tag is the same atomic claim a start uses. |
| D29 | A create that fails (compile error, plan not written) closes its own row at once: failed, "compile error: …" or "its plan could not be stored". | No engine and no log exist for it. Replaces `markFailed` (`ExecutionCreator.scala:233,287`). |
| D30 | One email per execution, sent by the Dashboard replica whose UPDATE closed the row, after the UPDATE. Where it goes is the row's `notification` (written at create); the plan row's `notification` column goes. No email when a run pauses, and none for an execution closed at create (a compile error) or as never started. | C9. At most once: a crash between the UPDATE and the send loses an email; the other order would send two with two replicas. An address does not belong in the lake, where step 5's unit can read it. |
| D31 | Expiring an execution drops its result and state tables, its console table and its large binaries, and keeps its plan, log and statistics. It happens when a later execution of the same workflow on the same unit is created (step 2's D8; create first closes the earlier ones that have just ended) and when `result-cleanup.ttl-in-seconds` (86,400) has passed since `ended_at`. The expiry by age also deletes the execution's replay log, when it has one, and clears `log_location`. Deleting an execution or a workflow drops everything. The unit deletes nothing: its TTL job, its clean-all-at-boot and the storage half of its idle clean-up are removed. | C10. Statistics stay because they are small and feed the history charts and the next run's cost hints. With fault tolerance on, the unit's TTL job is what deletes replay logs today (`ComputingUnitMaster.scala:241-256`); without this they would pile up. |
| D32 | Any number of Dashboard replicas run the job. No leader. Closing is `UPDATE … WHERE eid = ? AND ended_at IS NULL`; the never-started claim is an Iceberg tag; expiry is drops that tolerate a missing table and `UPDATE … WHERE results_expired_at IS NULL`. | Each step has exactly one winner by construction; the losers' cost is a few lake reads. |
| D33 | The unit manager's idle sweep reads `ended_at`: a unit is busy while any of its executions has none, and its last activity is the newest `ended_at` or `starting_time`. | The sweep stays a Postgres query in a service with no lake client. Every execution now gets closed, which is what #8618 asks for. |
| **Who serves what, until step 4** | | |
| D34 | The live view stays on the unit's websocket: state, statistics, console lines and result updates from the engine's memory, and result pages, which the unit reads from the lake. The unit knows the result tables of the run it holds from the recorder's memory, from sub-part 5 on, not from Postgres and not from the lake, and answers pages for that run only. | Step 4 replaces the socket with the watch stream; rebuilding it now would be thrown away. Memory, because the recorder writes an `output` row a moment after it is told of the port, and a lookup must not wait for that commit. |
| D35 | Stored state, log, statistics, console and export are served by the Dashboard service by execution, in every mode, from the row and the lake (§3.5). Kubernetes stops routing statistics and export to the unit, and the unit stops registering `WorkflowExecutionsResource`. | C11. They work when the unit is gone, and nothing is added to deploy. |
| D36 | `ExecutionResultUris` keeps its two functions and reads the log instead of `operator_port_executions`. Upstream's result service, once it is in the tree, lists results from the log and counts rows from the tables (§10). The module, its deployment and the panel's move stay with the upstream track. | The smallest contact surface with #9356 and #8996. |
| D37 | `WorkflowStateEvent` carries the execution's id. The browser follows one execution: the one it started, or the one a state event names. While that execution is in flight for the browser and the unit does not show it (the socket is down, or it is up and the unit's state names no execution), the browser asks `GET /api/executions/{eid}/state` every 5 s and shows what it answers: the recorded state while the execution is open, its outcome and reason once it is closed. It stops when a state event names the execution again, when the execution is closed, or when another execution takes its place (a state event names it, or the user starts one). A state event without an id does not replace what the workspace shows for an execution in flight. | That is how "failed: unit lost" reaches the workspace, also when the unit is back before the verdict: a JVM that dies in a pod or container that restarts answers again in under a minute, and the first thing a new socket is told is "Uninitialized" (`WorkflowWebsocketResource.scala:74`). A second tab or a collaborator learns the id from the replayed state. In step 4 the same request is what the browser falls back to when the watch stream cannot be opened. |
| D38 | Cost hints are read from the newest execution of the workflow by the same user whose `outcome` is 3, at the statistics location derived from the row, with the projected raw reader, cached by execution as now. | `CostHintsLoader.scala:123-147` reads `status` and `runtime_stats_uri`, which go. A tidied day reads in tens of milliseconds. |
| D39 | The unit opens no pool. `ComputingUnitMaster` does not call `SqlServer.initConnection`; it declares that it has no database, and `SqlServer.getInstance()` then fails with "a computing unit keeps nothing in Postgres", so a stray use fails loudly. Kubernetes units are no longer given the database login. | The done-when, enforced rather than observed. |
| D40 | Time travel and replay are unchanged: the Dashboard writes `log_location` at create and reads the replay log for the interactions list. A replay log is deleted when its execution's results expire by age (D31), as it is today. | They never used the columns that go. |
| **Errors** | | |
| D41 | Lake unreachable during a run: the recorder keeps what it could not commit and tries again on every tick; the run goes on. A run whose ending could not be written within 2 minutes ends unrecorded and is closed by the Dashboard as lost. | The engine must not fail because its record is late. In practice a run with stored ports fails by itself when the lake is gone, since its result writers commit there too. |
| D42 | Commit conflicts cannot occur: the log, statistics and console have one writer, which also tidies, and the recorder commits to no other table. An append whose first try ended without an answer is tried again and can land twice; readers keep one row per `seq`. | |
| D43 | A unit killed between commits loses at most one interval of statistics and console and the result rows its writers had buffered. The log keeps every state change that was made more than a commit (about 0.1 s) before the kill. The Dashboard closes the execution "failed: unit lost" with `ended_at` = the last beat. | |

## 3. Data shapes

### 3.1 The lake, per execution

All in the execution's warehouse (`user-<uid>-<whid>` with the REST catalog and warehouses on, the
configured default otherwise). Namespaces are the shared ones of today's layout; step 5 maps the
same URIs to one namespace per execution.

| Table | URI (after `vfs:///[wh/<w>/]wid/<wid>/eid/<eid>`) | Namespace | Written by | Commit | Tidy during the run | Tidy at the end |
|---|---|---|---|---|---|---|
| plan (step 2) | `/plan` | `execution-plan` | Dashboard | one per row | none | none |
| execution log | `/executionlog` | `execution-log` | the recorder | each row at once, with the label; a beat every tick (properties only) | every 50 appends: merge small files, rewrite manifests, expire (keep 60 s and ≥ 5) | merge, rewrite, keep 1 snapshot |
| statistics | `/runtimestatistics` | `workflow-runtime-statistics` | the recorder | every tick if a number changed; every state change; the end | as the log | as the log |
| console | `/consolemessages` | `operator-console-messages` | the recorder | every tick if rows are buffered; at 4,096 buffered rows; every state change; the end | as the log | as the log |
| result, per stored port | `/globalportid/<port>/result` | `operator-port-result` | workers (JVM and Python) | as today: 4,096 rows; the port's end | none | none |
| operator state, per stored port | `/globalportid/<port>/state` | `operator-port-state` | workers | as today | none | none |

The recorder makes its three tables together when the run starts, each replacing a table of the
same name left by an earlier database, so nothing stale is ever read for this execution; a run
that printed nothing has an empty console table. A finished execution's log, statistics and
console are one data file, one manifest and one snapshot each (a console or statistics table over
32 MB keeps its full files; a table nothing was written to has none). A run whose unit was lost
or stopped keeps the files and snapshots its last tidy left.

### 3.2 The execution log

Columns (`ResultSchema.executionLogSchema`; every column optional, as in all Texera tables):

| Column | Type | `state` row | `output` row |
|---|---|---|---|
| `seq` | LONG | 1, 2, 3, … in the order the recorder was told | same sequence |
| `timeMs` | LONG | epoch ms on the unit's clock | same |
| `kind` | STRING | `state` | `output` |
| `state` | STRING | `READY`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`, `KILLED` | null |
| `detail` | STRING | JSON, or null when there is nothing to say | JSON |

`detail` of a `state` row:

```json
{"reason": "replaced by execution 346",
 "errors": [{"type": "EXECUTION_FAILURE", "timeMs": 1794873600123, "message": "java.lang.RuntimeException: …",
             "details": "<stack trace>", "operatorId": "PythonUDFV2-operator-…", "workerId": "Worker:WF12-…"}]}
```

Both keys are optional. `errors` are the run's `WorkflowFatalError`s. `detail` of an `output` row:

```json
{"portId": "(logicalOpId=Filter-operator-…,layerName=main,portId=0,isInternal=false,isInput=false)",
 "uri": "vfs:///wh/user-1-7/wid/12/eid/345/globalportid/…/result", "outputMode": "SET_SNAPSHOT"}
```

`portId` is `GlobalPortIdentity.serializeAsString`; `outputMode` is the name of
`OutputPort.OutputMode`. The port's state table is at the same base URI with `/state`.

A row is written only when the state changes, so two reports of RUNNING give one row. A run of a
workflow with one viewed operator, paused once:

```
seq kind    state      detail
 1  state   READY
 2  output             {"portId": "(logicalOpId=Projection-…)", "uri": "vfs:///…/result", "outputMode": "SET_SNAPSHOT"}
 3  state   RUNNING
 4  state   PAUSED
 5  state   RUNNING
 6  state   COMPLETED
```

The label (table properties, set in the commit that appends the `state` row they describe; `beat-ms`
also by itself):

| Property | Value |
|---|---|
| `texera.execution.state` | the newest `state` row's state; absent before the first one |
| `texera.execution.state-seq` | its `seq` |
| `texera.execution.state-time-ms` | its `timeMs` |
| `texera.execution.reason` | its reason, else its first error's message, at most 500 characters; empty when neither |
| `texera.execution.beat-ms` | the unit's clock at the last tick |
| `texera.execution.beat-every-ms` | the recorder's interval |

Data files are named `<kind>_<first seq>_<8 hex>` under the table's location; a merged file
`merged_<8 hex>`.

### 3.3 Statistics and console

Statistics (`RuntimeStatisticsStore`'s schema, which replaces `ResultSchema.runtimeStatisticsSchema`):
as today with `time TIMESTAMP` replaced by `timeMs LONG`: `operatorId STRING, timeMs LONG,
inputTupleCnt LONG, inputTupleSize LONG, outputTupleCnt LONG, outputTupleSize LONG,
dataProcessingTime LONG, controlProcessingTime LONG, idleTime LONG, numWorkers INTEGER, status
INTEGER`. Values are cumulative, as today. All rows of one commit carry the same `timeMs`.

A statistics table with no `timeMs` column was written before this step (`time TIMESTAMP`, at the
same location). The store reads it as empty, so an execution made before the upgrade has no
statistics for the chart, the heat map or the cost hints, and none of them fails on it.

Console (`ConsoleMessageStore`'s schema, which replaces `ResultSchema.consoleMessagesSchema`):
`seq LONG` (1, 2, 3, … per execution), `timeMs LONG`
(the message's own timestamp), `operatorId STRING` (logical), `workerId STRING`, `msgType STRING`
(`PRINT`, `ERROR`, `COMMAND`, `DEBUGGER`), `source STRING`, `title STRING`, `message STRING`. The
stored row is the full message; truncation is for the live view only, as today. The row that
reports dropped messages has `operatorId` empty, `msgType` `ERROR`, `source` `(engine)`, `title`
"N console messages were not stored".

### 3.4 Postgres

After the step (`sql/texera_ddl.sql`):

```sql
CREATE TABLE IF NOT EXISTS workflow_executions
(
    eid                 SERIAL PRIMARY KEY,
    vid                 INT NOT NULL,
    uid                 INT NOT NULL,
    cuid                INT,
    starting_time       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- when it was created
    bookmarked          BOOLEAN DEFAULT FALSE,
    name                VARCHAR(128) NOT NULL DEFAULT 'Untitled Execution',
    environment_version VARCHAR(128) NOT NULL,
    log_location        TEXT,                                           -- the replay log
    whid                INT,
    -- The closing record: written once by the Dashboard service when the execution is over.
    outcome             SMALLINT,          -- 3 completed, 4 failed, 5 killed; NULL while open
    outcome_reason      TEXT,              -- why, in words for the user; NULL when the outcome says it all
    ended_at            TIMESTAMP,         -- NULL while open
    stored_bytes        BIGINT,            -- what its tables in the lake held when it was closed
    results_expired_at  TIMESTAMP,         -- when its results were dropped; plan, log and statistics stay
    notification        TEXT,              -- {"email","workflowName","workflowUrl"}; NULL sends no email
    FOREIGN KEY …  -- unchanged
);
CREATE INDEX idx_workflow_executions_cuid ON workflow_executions (cuid);                 -- unchanged
CREATE INDEX idx_workflow_executions_open ON workflow_executions (eid) WHERE ended_at IS NULL;
CREATE INDEX idx_workflow_executions_unexpired ON workflow_executions (ended_at)
    WHERE ended_at IS NOT NULL AND results_expired_at IS NULL;
```

Two migrations, so every sub-part works on its own:

- `sql/updates/53.sql` (sub-part 9): adds the six columns and the two indexes, and closes every row
  that exists: `outcome = status` where status is 3, 4 or 5, else 4 with
  `outcome_reason = 'closed when Texera was upgraded'`; `ended_at = COALESCE(last_update_time,
  starting_time)`; `results_expired_at = now()`; `stored_bytes = 0`. Executions made before the
  step keep their rows and lose their results (no backward compatibility; §8 says what to do with
  the tables they leave in the lake).
- `sql/updates/54.sql` (sub-part 18): drops the five columns, the two tables and the type.

Both get a changeSet in `sql/changelog.xml`, and the jOOQ classes under
`common/dao/src/main/scala/org/apache/texera/dao/jooq/generated` are regenerated and committed.

`workflow_computing_unit` does not change. Its `terminate_time` is what tells the Dashboard that a
unit is gone.

### 3.5 REST

New, on the Dashboard (`ExecutionResource`, `@Path("/executions")`, `@RolesAllowed(REGULAR, ADMIN)`).
The caller must have created the execution, or own or have been granted its workflow
(`WorkflowAccess.hasGrantedAccess`): the rule upstream's result service uses. Seeing a public
workflow is not enough, because a log or a console can show what a run read from private
datasets. An execution the caller may not read, or that does not exist, is 403, so ids cannot be
probed. The literal last segments keep these routes apart from the ones that take a workflow id
first (`/{wid}/latest`, `/{wid}/stats/{eid}`, …):

| Route | Answer |
|---|---|
| `GET /api/executions/{eid}/state` | `{"eid": 345, "status": 4, "open": false, "reason": "unit lost", "timeMs": 1794873600000}`. Closed: from the row (`timeMs` = `ended_at`). Open: from the label (its state, its reason or null, `timeMs` = `state-time-ms`); no log yet: status 0; lake unreadable: status -1 |
| `GET /api/executions/{eid}/log` | `{"eid": 345, "entries": [{"seq": 1, "timeMs": …, "kind": "state", "state": "READY"}, {"seq": 2, "timeMs": …, "kind": "output", "portId": "…", "uri": "…", "outputMode": "SET_SNAPSHOT"}, {"seq": 6, "timeMs": …, "kind": "state", "state": "FAILED", "reason": "…", "errors": [{…}]}], "closing": {"outcome": 4, "reason": "unit lost", "endedAtMs": …}}`. `closing` is null while open. An execution with no log: `entries: []` |
| `GET /api/executions/{eid}/console?operatorId=&afterSeq=0&limit=1000` | `{"eid": 345, "messages": [{"seq": 17, "timeMs": …, "operatorId": "…", "workerId": "…", "msgType": "PRINT", "source": "…", "title": "…", "message": "…"}], "lastSeq": 17, "more": false}`; `limit` at most 5,000; expired or never written: `messages: []` |

Changed, on the Dashboard:

| Route | Change |
|---|---|
| `GET /api/executions/{wid}`, `GET /api/executions/{wid}/latest` | each entry: `status` and `completionTime` as D21 (`completionTime` is never null); new `reason`; `result` is gone. `?status=` filters closed states in SQL and open states after reading their labels |
| `GET /api/executions/{wid}/stats/{eid}` | reads the statistics table at the location derived from the row; no `cuid` parameter; `timestamp` is epoch ms; the other fields keep the names the server sends today (`dataProcessingTime`, `controlProcessingTime`, `idleTime`, `numWorkers`), which the frontend adopts |
| `POST /api/executions/result/export/dataset`, `…/local` | the body names `executionId` (required) instead of `computingUnitId`; results are found through the execution's log; the upload to the file service carries the caller's own token |
| `GET /api/admin/execution/executionList/…` | `executionStatus` as D21; `end_time` sorts by `ended_at`; a status filter works as for the history |
| `GET /api/quota/user_quota_size` | `[{"eid": 345, "workflowId": 12, "workflowName": "…", "storedBytes": 10485760}]` |
| `PUT /api/executions/delete_executions`, `DELETE /api/quota/deleteCollection/{eid}`, workflow delete | drop every table of the execution, found through its row and its log; an open execution is refused with 409 |
| `POST /api/executions`, `POST /api/executions/{eid}/updates` | create writes `notification` into the row and closes the row itself on a failure (D29); an update is refused 409 when `ended_at` is set |

Removed from the unit: every `/api/executions/*` route (the unit no longer registers
`WorkflowExecutionsResource`). Unchanged on the unit: `POST /api/execution/{eid}/run`,
`GET /api/execution/health`.

If upstream's result service is in the tree (§10): `GET /api/results/executions/{eid}` and its
pages and statistics routes keep their shapes and find results through the log;
`GET /api/results/workflows/{wid}/latest-execution` selects by `outcome IS NOT NULL`.

### 3.6 Websocket (`/wsapi/workflow-websocket`)

| | Message |
|---|---|
| relied on | `WorkflowStateEvent {"state": "Running", "executionId": 345}`; `executionId` is null when the unit holds no run for the workflow (the "Uninitialized" a new socket gets first). Step 2's sub-part 14 added the id (`258d6ae54`); this step changes what the browser does with an event that has none (D37) |
| unchanged | every other event and request. `ResultPaginationRequest` answers for the run the unit holds; with none it answers an empty page (today it falls back to "the newest execution of this workflow on this unit" in Postgres, `ExecutionResultService.scala:417-419`) |
| not in this step | removing `ResultPaginationRequest` (#8996) and the socket itself (step 4) |

### 3.7 Configuration

| Key (env) | Default | Read by |
|---|---|---|
| `storage.iceberg.table.execution-log-namespace` (`STORAGE_ICEBERG_TABLE_EXECUTION_LOG_NAMESPACE`) | `execution-log` | unit, Dashboard |
| `storage.iceberg.table.commit.interval-ms` (`STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS`) | `30000` | unit (the recorder) |
| `execution-closing.interval-seconds` (`EXECUTION_CLOSING_INTERVAL_SECONDS`) | `30` | Dashboard |
| `execution-closing.lost-after-seconds` (`EXECUTION_CLOSING_LOST_AFTER_SECONDS`) | `180` | Dashboard |
| `execution-closing.never-started-after-seconds` (`EXECUTION_CLOSING_NEVER_STARTED_AFTER_SECONDS`) | `600` | Dashboard |
| `result-cleanup.ttl-in-seconds`, `result-cleanup.collection-check-interval-in-seconds` (existing) | `86400`, `86400` | Dashboard (were the unit's) |
| removed: `web-server.clean-all-execution-results-on-server-start` | | |

The engine's `constants.runtime-statistics-persistence-interval` (2 s) stays: it is how often the
coordinator hands the recorder a fresh snapshot, not how often one is stored. When a table is
tidied is not configuration: every 50 appends, files under 32 MB, 5 snapshots and 60 s kept are
constants beside the recorder (`ExecutionRecorder.TidyEveryAppends`, `IcebergTidy.TargetFileBytes`,
`IcebergTidy.RetainSnapshots`, `IcebergTidy.RetainMillis`); the recorder's constructor takes them,
so specs and the benchmark can change them.

### 3.8 Interfaces

Engine side (`amber/src/main/scala/org/apache/texera/amber/engine/common/executionrecord/ExecutionRecorder.scala`):

```scala
trait ExecutionRecorder {
  /** The run changed state. Written at once. Dropped when the state did not change or the run has ended. */
  def state(state: String, errors: Seq[WorkflowFatalError] = Nil, reason: Option[String] = None): Unit
  /** The engine made the result table of a stored output port. Written at once. */
  def output(port: GlobalPortIdentity, uri: URI, mode: OutputMode): Unit
  /** The newest numbers of every operator. Kept; stored at the next commit. */
  def statistics(metrics: Map[String, OperatorMetrics]): Unit
  /** One console message of a logical operator. Buffered; stored at the next commit. */
  def console(operatorId: String, message: ConsoleMessage): Unit
  /** The stored output ports this recorder was told of, for the unit's own reads. */
  def outputs: Seq[ExecutionOutput]
  def resultUri(operatorId: OperatorIdentity, port: PortIdentity): Option[URI]
  /** Waits until everything handed over so far is in the lake, at most `timeout`. */
  def awaitIdle(timeout: FiniteDuration): Boolean
}
object ExecutionRecorder {
  def start(context: WorkflowContext): ExecutionRecorder   // creates the three tables, beats, ticks
  def none: ExecutionRecorder                              // a new one that remembers outputs and writes nothing (specs)
}
```

Storage side (`common/workflow-core/…/core/storage/`, beside `ExecutionPlanStore`):

```scala
final case class ExecutionLogEntry(seq: Long, timeMs: Long, kind: String, state: Option[String], detail: Option[String])
final case class ExecutionLabel(state: Option[String], stateSeq: Long, stateTimeMs: Long, reason: String,
                                beatMs: Long, beatEveryMs: Long) { def ended: Boolean }
final case class ExecutionOutput(port: GlobalPortIdentity, uri: URI, outputMode: String)
object ExecutionLogStore {
  def logUri(wid: WorkflowIdentity, eid: ExecutionIdentity, warehouse: Option[String]): URI
  def create(uri: URI, nowMs: Long, beatEveryMs: Long): Unit         // a new table; replaces a stale one
  def append(uri: URI, entries: Seq[ExecutionLogEntry], nowMs: Long): Unit   // one commit; label from the last state row
  def beat(uri: URI, nowMs: Long): Unit                              // properties only
  def label(uri: URI): Option[ExecutionLabel]                        // None: no such table
  def read(uri: URI): Seq[ExecutionLogEntry]                         // by seq; Nil: no such table
  def outputs(uri: URI): Seq[ExecutionOutput]
  def tidy(uri: URI, atEnd: Boolean): Unit
  def drop(uri: URI): Unit
}
object RuntimeStatisticsStore { create, append(uri, rows), read(uri, columns), tidy, drop }
object ConsoleMessageStore    { create, append(uri, rows), read(uri, operatorId, afterSeq, limit), tidy, drop }
```

Two rules hold for every read of the three stores (`label`, `read`, `outputs`):

- A table that is not there is an answer (`None`, `Nil`). A catalog or an object store that cannot
  answer is thrown. The stores load tables through `DocumentFactory.icebergTableOf`, which makes
  that difference; `IcebergUtil.loadTableMetadata`, which reads every failure as a missing table
  (`IcebergUtil.scala:240-251`), is not used. The closing job depends on it: "no log table" leads
  to "never started" or "unit lost", so an outage must never look like one.
- Log and console rows come back one per `seq` (the first), since an append that is tried again
  after an unanswered commit can land twice.

## 4. Behaviour, step by step

### 4.1 The recorder (unit)

Created by `WorkflowService.startClaimedRun` right after the claim and before the run is built
(`WorkflowService.scala:451`), as `new ExecutionStateStore(ExecutionRecorder.start(context))`. So
whatever fails after the claim is recorded.

1. `start`: a daemon single-thread scheduler `execution-record-<eid>`. Its first task creates the
   log table (`ExecutionLogStore.create`, which sets `beat-ms` and `beat-every-ms`), then the
   statistics and the console table; each replaces a table of that name left by an earlier
   database. Then a tick is scheduled every `commit.interval-ms`, with a fixed delay.
2. `state(s, errors, reason)`: under the recorder's lock: if the run has ended, or `s` equals the
   last state recorded, return (the first with a warning). Otherwise take the next `seq`, remember
   `s`, and hand the thread a task: append the row with its label in one commit, then store the
   statistics sample and the console buffer (step 4's two writes). If `s` is an ending, the task
   goes on to the end tidy of the three tables, cancels the tick, shuts the scheduler down once it
   is idle, and marks the recorder ended.
3. `output(port, uri, mode)`: adds it to the in-memory list at once (the unit's own reads use it),
   takes the next `seq` and hands the thread the append. Told twice of one port, it records once.
4. A tick, on the thread: (a) `ExecutionLogStore.beat`, first, so nothing later in the tick can
   hold the sign of life back; (b) statistics: for every operator whose newest row differs from
   its last stored one (D10), one row, all with the tick's time; append if any; (c) console:
   append the buffer if it is not empty; (d) tidy a table whose appends since its last tidy
   reached 50 (a beat is not an append). `console(…)` also asks for (c) as soon as 4,096 rows are
   buffered. A tick never throws: each step catches what it can fail with, and the tick as a whole
   catches everything else, logs it and returns. A scheduled task that throws is never run again,
   which would end the beat and get a healthy run closed as lost.
5. A write that fails is logged once per kind until one succeeds, and its rows stay: log rows and
   the statistics sample are retried on the next tick, the console buffer keeps growing to its cap.
   A table that could not be created is created on the next tick. A table that existed and is
   gone (the store answers "no such table", not a failure) is not made again: the execution was
   deleted, and the recorder stops. After an ending, the thread retries every 5 s for 2 minutes
   and then gives up. A write that is tried again after a commit that got no answer can land
   twice; readers keep one row per `seq` (§3.8).
6. `awaitIdle(timeout)`: used by the agent path before it reads console output from the lake, and
   when the unit stops (step 7).
7. When the unit stops: `ComputingUnitMaster` manages a Dropwizard `Managed` object whose `stop()`
   runs as the server shuts down on SIGTERM. For every run the unit holds that has not ended it
   calls `transitionTo(FAILED, reason = "the computing unit was stopped")`, then `awaitIdle(5 s)`
   for all. The ending row is written first; the statistics, the console and the end tidy follow
   as far as the 5 s reach.

`ExecutionStateStore.transitionTo(state, errors = Nil, reason = None, clearErrors = false)` is the
only way the unit changes a run's state. Under the metadata store's lock it: returns if the stored
state is already an ending; calls `recorder.state` when `state` is one of the six logged states;
calls `WorkflowMetricsRecorder.onStateChange`; and stores the state with the errors added (or
cleared). It replaces `updateWorkflowState` at all 13 sites, and the "keep the state it ended in"
checks at `WorkflowExecutionService.scala:656-663` and `WorkflowService.scala:273-280`.

### 4.2 A tidy

`IcebergTidy.tidy(table, atEnd)`:

1. Plan the current snapshot; sort the files by sequence number. Take the longest run of files at
   the end that are each smaller than 32 MB. If it has two files or more, read
   them in order into one new Parquet file and commit `newRewrite().validateFromSnapshot(planned)`
   that deletes them and adds it. The new file is the table's newest, and nothing was appended in
   between (one thread), so rows keep their order.
2. `rewriteManifests().clusterBy(_ => "all")`.
3. `expireSnapshots()`: during the run `expireOlderThan(now − 60 s).retainLast(5)`; at the end
   `expireOlderThan(now).retainLast(1)`. Files only expired snapshots used are deleted.

Only the recorder calls it, and only on its own three tables. None of the three commits touches
the table's properties, so the label survives a tidy (checked on Lakekeeper, §1b).

### 4.3 The closing job (Dashboard), one tick

1. One query: every row with `ended_at IS NULL`, joined to its workflow (through its version), its
   warehouse name and its unit's `terminate_time` and `termination_reason`.
2. For each, with at most 8 at a time and a 5 s limit each; anything that throws is logged and the
   execution is looked at again on the next tick:
   1. Its tables are in a per-user warehouse while those are disabled, or its warehouse was deleted
      (`whid` null while warehouses are on): close failed, "its warehouse is no longer available".
   2. Read the label. **Ended** → close with the label's state, reason and `state-time-ms`.
   3. **Unit terminated** (`terminate_time` not null) → go to 6 with "unit terminated" when the
      reason is `USER_REQUESTED`, else "unit lost".
   4. **No log table.** If the plan table has the `started` tag, go to 5 with "no beat". Otherwise
      wait until the row is older than `never-started-after-seconds`, then
      `ExecutionPlanStore.claimStart`; on success (or when there is no plan table at all) close
      failed, "never started"; on `ExecutionAlreadyStartedException` leave it.
   5. **Watching the beat.** The job remembers, per open execution, the beat it last saw and for
      how many of its own consecutive ticks it has not changed. A tick that could not read the
      label does not count. When the count reaches the larger of `lost-after-seconds` and four
      times the label's `beat-every-ms`, divided by the job's interval and rounded up → go to 6
      with "unit lost".
   6. **Before declaring it lost**, read the log's rows. If they hold an ending, close with that
      ending. Otherwise, when the plan is not started yet, take its start, so nothing starts it
      later (a start that got there first changes nothing). Then close failed with the reason,
      `ended_at` = the label's `beat-ms` (now when there is no label).
   A read that throws at any of these points decides nothing (§3.8): not "no log", not "no plan",
   not "lost".
3. Closing is `UPDATE workflow_executions SET outcome = ?, outcome_reason = ?, ended_at = ? WHERE eid
   = ? AND ended_at IS NULL`, with `ended_at` kept between `starting_time` and the Dashboard's now
   (it comes from the unit's clock, the other two from the Dashboard's and the database's). Only
   when it changed a row: sum the `total-files-size` of the execution's tables into
   `stored_bytes`; send the email if `notification` is set and the reason is not "never started";
   log one line. An execution that no unit ever started (closed at create, or as never started)
   has nothing to expire: the same UPDATE sets `results_expired_at`, so the expiry never looks
   for its tables.
4. Every `result-cleanup.collection-check-interval-in-seconds`: up to 200 rows with
   `ended_at < now − ttl AND results_expired_at IS NULL`, oldest first, each through
   `ExecutionExpiry.expire`, which here also deletes the replay log (§4.4).

### 4.4 Expiry and deletion (Dashboard)

`ExecutionExpiry.expire(eid, withReplayLog = false)`: find the tables from the row (workflow,
warehouse) and the log's `output` rows; drop each result table and its state table, the console
table, and the large binaries under `objects/<eid>/`; then `UPDATE … SET results_expired_at =
now(), stored_bytes = <plan + log + statistics> WHERE eid = ? AND results_expired_at IS NULL`. A
missing table is not an error. The job's pass by age calls it with `withReplayLog = true`: when the
row has a `log_location`, the replay log there is deleted (`SequentialRecordStorage.getStorage(…)
.deleteStorage()`, as `ComputingUnitMaster.deleteReplayLog` does today) and the column cleared in
the same UPDATE; a log that cannot be deleted is logged and left.

An execution with no log table has no `output` rows to go by: one made before this step, or one
whose unit died before its first commit. Its tables are then found by name: the tables of the
warehouse's result, state and console namespaces whose names start with `wid_<wid>_eid_<eid>_`
(the underscore after the id keeps execution 3 apart from 34). This lists whole namespaces, so
`expire` does it for these executions only.

`ExecutionExpiry.dropAll(eid)` drops what `expire` drops and the statistics, log and plan tables
as well, and it always searches by name too, in the statistics namespace as well: a delete is
rare and asked for, and it is the last chance to find a table the log does not name. The delete
routes call it before they delete the row. So an execution made before the upgrade, whose row
53.sql marked expired, still gives its storage back when it is deleted.

Create calls `ExecutionExpiry.expireReplaced(wid, cuid, replacedBy)`: the closed, unexpired
executions of the workflow on the unit with a smaller eid (what `clearFinishedExecutions` selects
today, `ExecutionResources.scala:281-321`, with the closing record instead of `status` and the
registry rows). A run that ended in the last seconds is not closed yet, and re-running at once is
the common case, so create first looks at the open executions of the workflow on the unit with a
smaller eid and closes each whose label shows an ending, through the same function the job uses
(`ExecutionCloser.closeIfEnded`: one conditional UPDATE, then size and email, whoever wins).

The delete routes refuse an open execution with 409 "execution N is still open; kill it first":
without its row, nothing could find the tables its unit goes on writing.

### 4.5 Who serves what in this step

| What the browser wants | Served by | From |
|---|---|---|
| A live run: state, operator statistics, console lines, workers, regions, "these pages changed" | the unit's websocket, as today | the engine's memory |
| Result pages, visualization snapshots | the unit's websocket, for the run the unit holds; tables found in memory | lake |
| Result pages of a past execution, or of a run whose unit is gone | not in this step (nor today): upstream's result service (#8995, #8996), which finds them through the log | lake |
| One execution's state, and why it ended | Dashboard `GET /api/executions/{eid}/state` | row if closed, else label |
| Its log | Dashboard `GET /api/executions/{eid}/log` | lake, plus the row's closing record |
| Statistics charts, heat-map restore | Dashboard `GET /api/executions/{wid}/stats/{eid}` | lake |
| Stored console output | Dashboard `GET /api/executions/{eid}/console` | lake |
| Export | Dashboard `POST /api/executions/result/export/*` | lake, then the file service |
| History of a workflow, latest execution, admin list | Dashboard | rows; the label for each open row |
| "Is a run of this workflow in progress?" (the editor's lock, `computing-unit-selection.component.ts:308-327`) and "which unit and warehouse did it last run on?" (`:396-411`) | Dashboard, the history route with `?status=` for Initializing and Running, and `/latest` | rows; the label for each open row |
| Quota sizes | Dashboard | `stored_bytes` |
| Time travel: interactions, replay | Dashboard (unchanged) | the replay log at `log_location` |
| Idle units (not the browser) | unit manager | `ended_at` |

The Dashboard calls no unit for any of it.

### 4.6 What a reader sees in the awkward moments

| Moment | Reader sees |
|---|---|
| Created, not started | status 0; after 10 minutes failed, "never started" |
| Started, log table not made yet (the first second) | status 0 |
| The run ended, the job has not ticked | status from the label (3, 4 or 5), `open: true`; at most 30 s later the row says the same |
| The unit was killed | the last state it recorded, for up to `lost-after-seconds` + 30 s (at most 30 s once its unit's row is stamped terminated, which a listing does within seconds in Kubernetes); then failed, "unit lost" |
| The unit died and is back before the verdict (a restarted container) | the unit says it holds no run; the workspace keeps showing what the Dashboard answers for the execution it follows (D37): its last recorded state, then failed, "unit lost". Pause, resume and kill are off meanwhile; Run works as soon as the socket is up |
| The lake cannot be read | status -1 for open executions; closed ones are unaffected |
| The engine reported after it was declared lost (it was cut off from the lake, not dead) | the row stays failed, "unit lost"; `/log` shows the later rows beside `closing` |

## 5. Sub-parts in commit order

Sizes: S < 300 lines, M 300–900, L > 900 (with specs). Every sub-part leaves the product working on
its own on top of the previous ones. Between sub-parts 5 and 18 the unit writes the lake and
Postgres side by side, and readers move one at a time; after 18 there is one path. Sub-parts keep
the numbers revision 1 gave them; 1, 8 and 10 are left out of this step (below), so the list has
16.

| # | Commit subject | Size | Gate | Depends on | After it lands alone |
|---|---|---|---|---|---|
| 2 | `feat(workflow-core): tidy an Iceberg table under its readers` | M | A | – | works; nothing calls the tidy yet |
| 3 | `feat(workflow-core): keep an execution's log in the lake` | M | A | 2 | works; nothing calls it yet |
| 4 | `feat(workflow-core): store statistics and console as records` | M | A | 2 | works; nothing calls it yet |
| 5 | `feat(amber): write an execution's log from the unit` | L | A | 3 | works; every run also has a log; the unit finds its run's results in memory; Postgres status and registry still written |
| 6 | `feat(amber): commit statistics and console on a timer` | L | A | 4, 5 | works; statistics and console reach the lake every 30 s, in the new tables |
| 7 | `test(amber): benchmark a day of an execution's record` | S | A | 6 | no product change |
| 9 | `feat(dao): record how an execution ended` | S | B | – | works; new columns unused |
| 11 | `feat(amber): close executions at the Dashboard service` | L | B | 5, 9 | works; closing records are written; lists still read `status` |
| 12 | `feat(amber): read an execution's status from its record` | L | B | 11 | works; "unit lost" and "never started" show in lists; the idle sweep reads `ended_at` |
| 13 | `feat(amber): email a run's owner when it is closed` | M | B | 11 | works; the unit sends no email |
| 14 | `feat(amber): expire results at the Dashboard service` | L | B | 5, 12 | works; the unit deletes nothing; results outlive the tab |
| 15 | `feat(frontend): show how a run ended` | M | B | 11, 12 | works; the workspace shows a lost unit |
| 16 | `feat(amber, frontend): serve stored output by execution` | L | C | 6, 14 | works; statistics, console and export never touch a unit |
| 17 | `feat(amber): run an execution without Postgres on the unit` | L | C | 12, 13, 14, 16 | works; the unit opens no pool |
| 18 | `feat(dao, amber): drop run state from Postgres` | M | C | 17 | works; one path |
| 19 | `feat(computing-unit-managing-service): drop units' DB login` | S | C | 17 | works; Kubernetes units cannot log in |

| Gate | Title | Sub-parts | Users see | Harness gate (§7) |
|---|---|---|---|---|
| A | Record every run in the lake | 2–7 | statistics and console survive a dead unit up to the last 30 s; coarser statistics history | 3A: step 2's last gate, plus p, with Check I |
| B | Close executions at the Dashboard service | 9, 11–15 | "failed: unit lost", "never started", reasons in the history; results outlive the tab; one email per run | 3B: + q, r, s, t, w, with Checks I and K |
| C | Take Postgres off the unit | 16–19 | export and statistics work without the unit | 3C: + v, with Checks G, H, I, J, K; the negative controls once; y and sub-part 7's benchmark once |

A, B and C are the points at which the harness is run, each a state that could be merged; the
rest of this document calls them PR A, PR B and PR C. They are not the final split. The owner
wants the whole effort in three or four pull requests, decided once the branch is complete. When
the working history is regrouped, step 3 folds into two at most: "record and close executions
from the lake" (A and B: the lake record, the closing job and the readers, with the unit still
writing Postgres columns nothing reads any more) and "take Postgres off the unit" (C). With B and
C in one pull request, `53.sql` and `54.sql` become one migration.

### Left out of this step

None of the three is needed by the done-when, and each can land on its own later. Their briefs are
in the appendix as revision 1 wrote them, with what the review found.

| Was | What it did | Why it is out | Where it belongs |
|---|---|---|---|
| 1 `perf(workflow-core): compute a tuple's size on first use` | a tuple's size computed on first use, schemas built once per read, `getCount` from the snapshot summary | The new tables are read without `Tuple` (D18), so the day-long target does not depend on it. It touches every result read and how rows are counted | an upstream change of its own, at any time |
| 8 `feat(amber, pyamber): commit slow results on the timer` | result writers (JVM and Python) flush every interval; the recorder tidies result tables' metadata; the polling reader survives an expired snapshot | Neither the tracker's step nor the done-when asks for it. Without compaction, which C6 rules out for result tables, a slow result becomes one file per writer per interval (2,880 in a day), and a full read, an export or the next region's input, pays 3.5–6 ms per file (10–17 s for that day, measured in step 0). Expiring result snapshots needs a change in the reader every stored port goes through | with the result service (#8995, #8996): rows that reach the lake early start to matter when something other than the unit reads them |
| 10 `feat(computing-unit-managing-service): notice lost units` | `UnitPlatform` with a Kubernetes and a local implementation; a timer in the manager that stamps units whose pod is gone | The beat closes a lost run on every platform (D26). In Kubernetes the unit's row is already stamped within seconds whenever a browser is on the workflow (D27). The timer only shortens the wait of a run nobody watches from three and a half minutes to one | step 6, which designs the platform interface against more than one platform |

What therefore stays as it is today: a killed unit loses the result rows its writers had
buffered, up to 4,095 per writer (D9, D43); a slow operator's result shows up when 4,096 rows
exist or the port ends; nothing tidies a result table (D14).

What each sub-part changes, where, and its specs (the briefs in §13 have the detail):

| # | What changes | Main files | Specs added (+) or updated |
|---|---|---|---|
| 2 | append records with properties in one commit; merge small files, rewrite manifests, expire snapshots; the timer setting | + `IcebergAppender.scala`, + `IcebergTidy.scala`, `storage.conf`, `StorageConfig.scala` | + `IcebergAppenderSpec`, + `IcebergTidySpec` |
| 3 | the execution log: resource type, URI, namespace, schema, store with label and beat | `VFSURIFactory.scala`, `DocumentFactory.scala`, `ResultSchema.scala`, + `ExecutionLogStore.scala`, `vfs_uri_factory.py` | + `ExecutionLogStoreSpec`, `VFSURIFactorySpec`, `DocumentFactorySpec`, `test_vfs_uri_factory.py` |
| 4 | statistics and console stores: records, epoch-ms times, one console table per execution | + `RuntimeStatisticsStore.scala`, + `ConsoleMessageStore.scala`, `VFSURIFactory.scala` | + `RuntimeStatisticsStoreSpec`, + `ConsoleMessageStoreSpec` |
| 5 | the recorder (log rows, outputs, beat); one `transitionTo` at the 13 sites; an ending happens once; idle clean-up, supersede, agent path and polite stop record their endings; the unit and the e2e specs find a run's results in the recorder's memory | + `ExecutionRecorder.scala`, `ExecutionStateStore.scala`, `ExecutionRuntimeService.scala`, `WorkflowService.scala`, `WorkflowExecutionService.scala`, `ExecutionStatsService.scala`, `ExecutionResultService.scala`, `SyncExecutionResource.scala`, `ClusterListener.scala`, `ComputingUnitMaster.scala`, e2e `TestUtils.scala` | + `ExecutionRecorderSpec`, `ExecutionStateStoreSpec`, `ExecutionRuntimeServiceSpec`, `WorkflowServiceSpec`, `WorkflowExecutionServiceSpec`, `ExecutionResultServiceSpec`, `SyncExecutionResourceSpec`, `ClusterListenerSpec`, `ComputingUnitMasterSpec` |
| 6 | statistics and console go through the recorder: sampled and committed on the timer, tidied; their readers switch to the stores | `ExecutionRecorder.scala`, `ExecutionStatsService.scala`, `ExecutionConsoleService.scala`, `WorkflowExecutionsResource.scala` (statistics route), `CostHintsLoader.scala`, `SyncExecutionResource.scala`, `ResultSchema.scala`, `ComputingUnitManagingResource.scala` (one forwarded name) | `ExecutionRecorderSpec`, `ExecutionStatsServiceSpec`, `ExecutionConsoleServiceSpec`, `WorkflowExecutionsResourceSpec`, `CostHintsLoaderSpec`, `SyncExecutionResourceSpec`; − `IcebergDocumentConsoleMessagesSpec` |
| 7 | a day-long benchmark of the recorder and the stores | + `ExecutionRecordBench.scala` (test scope); harness `bench/` | the benchmark's eight checks |
| 9 | six columns and two indexes on `workflow_executions`; existing rows closed | `sql/texera_ddl.sql`, + `sql/updates/53.sql`, `sql/changelog.xml`, generated jOOQ | the migration checked by hand; the suites unchanged |
| 11 | the closing job (ending from the label, unit lost, never started); create closes its failures; state and log routes; the state event carries the execution id | + `ExecutionRecords.scala`, + `ExecutionClosing.scala`, + `ExecutionCloser.scala`, + `ExecutionClosingJob.scala`, `TexeraWebApplication.scala`, `ExecutionCreator.scala`, `ExecutionResource.scala`, `WorkflowStateEvent.scala`, `application.conf` | + `ExecutionClosingSpec`, + `ExecutionClosingJobSpec`, `ExecutionResourceSpec`, `TexeraWebApplicationSpec`, `TexeraWebSocketEventSpec` |
| 12 | lists, admin, quota, updates, cost hints, replace-at-create and the idle sweep read the closing record, and the label for open rows | + `ExecutionStatus.scala`, `WorkflowExecutionsResource.scala`, `AdminExecutionResource.scala`, `UserQuotaResource.scala`, `OperatorUpdates.scala`, `CostHintsLoader.scala`, `ExecutionResources.scala`, `ExecutionCreator.scala`, `ComputingUnitManagingResource.scala`, three frontend type files | `WorkflowExecutionsResourceSpec`, `AdminExecutionResourceSpec`, `UserQuotaResourceSpec`, `OperatorUpdatesSpec`, `CostHintsLoaderSpec`, `ExecutionResourceSpec`, `ComputingUnitIdleCleanupSpec`, `ComputingUnitManagingResourceSpec`, two frontend specs |
| 13 | the email is sent by the closing job; the notification moves from the plan row to the Postgres row; the unit's notifier goes | `ExecutionCreator.scala`, `ExecutionPlanStore.scala`, `ResultSchema.scala`, `WorkflowExecutionService.scala`, `ExecutionRuntimeService.scala`, `WorkflowEmailNotifier.scala`, `ExecutionCloser.scala`; − `EmailNotificationService.scala` | `ExecutionClosingJobSpec`, `ExecutionResourceSpec`, `ExecutionPlanStoreSpec`, `WorkflowEmailNotifierSpec`, `ExecutionRuntimeServiceSpec` |
| 14 | one expiry at the Dashboard, found through the log; `ExecutionResultUris`, by now only the Dashboard's, reads the log; deletes drop everything and refuse open executions; the unit's TTL job, clean-at-boot and storage clean-up go | + `ExecutionExpiry.scala`, `ExecutionResultUris.scala`, `ExecutionClosingJob.scala`, `ExecutionCreator.scala`, `WorkflowExecutionsResource.scala`, `WorkflowResource.scala`, `UserQuotaResource.scala`, `WorkflowService.scala`, `ComputingUnitMaster.scala`; − parts of `ExecutionResources.scala` | + `ExecutionExpirySpec`, `ExecutionResultUrisSpec`, `ExecutionClosingJobSpec`, `ExecutionResourceSpec`, `WorkflowResourceSpec`, `WorkflowExecutionsResourceSpec`, `UserQuotaResourceSpec`, `WorkflowServiceSpec`, `ComputingUnitMasterSpec` |
| 15 | reasons in the history and admin list; the workspace asks the Dashboard for the state of a run its unit no longer shows; statistics field names | `execute-workflow.service.ts`, `execution-api.service.ts`, `workflow-websocket.interface.ts`, the history and admin components, the statistics types | their `.spec.ts` files |
| 16 | statistics, console and export by execution from the Dashboard; the unit serves no `/api/executions`; the Kubernetes routes to the unit go | `WorkflowExecutionsResource.scala`, `ExecutionResource.scala`, `ResultExportRequest.scala`, `ResultExportService.scala`, `download.service.ts`, `workflow-result-export.service.ts`, `workflow-executions.service.ts`, `gateway-routes.yaml`, `AccessControlResource.scala`, `ComputingUnitMaster.scala` | `ResultExportServiceSpec`, `WorkflowExecutionsResourceSpec`, `ExecutionResourceSpec`, `AccessControlResourceSpec`, `ComputingUnitMasterSpec`, four frontend specs |
| 17 | the unit writes nothing to Postgres, reads nothing from it and opens no pool | `ExecutionResultService.scala`, `ExecutionStatsService.scala`, `ExecutionConsoleService.scala`, `ExecutionStateStore.scala`, `ExecutionsMetadataPersistService.scala`, `WorkflowExecutionsResource.scala`, `SqlServer.scala`, `ComputingUnitMaster.scala`, e2e `TestUtils.scala`, `build.yml` | + `ComputingUnitWithoutDatabaseSpec`, `ComputingUnitMasterSpec`, `SqlServerSpec`, and every unit-side spec that asserted a Postgres write |
| 18 | the five columns, two tables and one type are dropped | `sql/texera_ddl.sql`, + `sql/updates/54.sql`, `sql/changelog.xml`, generated jOOQ | the suites; fixtures that named the dropped tables |
| 19 | Kubernetes units get no database login | `ComputingUnitManagingResource.scala` | `ComputingUnitManagingResourceSpec`, `KubernetesClientSpec` |

## 6. What users will notice

- A run whose unit dies ends as Failed, "unit lost", within about three and a half minutes; in
  Kubernetes within about half a minute when the pod is gone and somebody has the workflow or the
  unit list open. Today it stays Running for ever. A unit the user terminates ends its run as
  Failed, "unit terminated".
- The workspace shows that ending also when the unit is back before it: it keeps showing the run
  as the record has it, and then Failed, "unit lost". A new run can be started as soon as the
  unit answers again.
- An execution that was created and never started shows Failed, "never started", after ten
  minutes. Today it stays Initializing for ever.
- A workflow counts as having a run in progress, and its editor stays locked when the page is
  opened, until that run's execution is closed: up to three and a half minutes after a unit
  died, up to ten after a start that never happened. Today both last for ever.
- The history and the admin list show why a run failed or was killed: "killed by the user",
  "replaced by execution 12", "stopped: nobody watched it for 30 s", "the computing unit was
  stopped", "compile error: …", or the first error's message.
- A paused run that nobody watches for 30 s was always shut down; it is now recorded as Killed.
  Today its row stays Paused.
- Statistics and console output of a run are in the lake within 30 s, so they survive a dead unit.
- The statistics charts of past executions have one point per operator every 30 s and at every
  state change, not every 2 s. A run of a few seconds has a handful of points.
- Results are no longer deleted 30 s after the last tab closes. They stay until the next execution
  of the same workflow on the same unit is created, or one day after the run ended (configurable).
  The plan, the log and the statistics stay until the execution is deleted. What stays can be
  exported. The result panel shows it only while the unit still holds the run, and the unit
  lets go of a finished run 30 s after its last tab closes, as today; paging a past run's
  results waits for the result service (#8996). So until then this costs storage that only
  export uses (open decision 5).
- One email per run, when it ends, also for a kill, a failure and a lost unit, which sent none.
  No email when a run pauses.
- In Kubernetes the statistics dialog and export work after the unit is gone. Export names the
  execution, so the workspace exports the execution on screen, not "the latest on this unit".
- The quota page shows one size per execution, counted when the execution ends. A running
  execution has no size yet.
- Executions made before the upgrade keep their rows in the history, closed, without results or
  statistics.

## 7. Harness changes (`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e`)

### H1. Driver (`driver/texera_api.py`, `driver/transport.py`, `driver/e2e.py`, new `driver/stack_control.py`)

- `TexeraApi`: `execution_state(eid)`, `execution_log(eid)`, `execution_console(eid, operator_id=None,
  after_seq=0, limit=1000)`, `execution_statistics(wid, eid)` (no `cuid`), `export_local(wid, eid,
  operator_ids, export_type)`, `export_dataset(…)`, `quota_sizes()`, `admin_executions(...)`.
  `list_executions` entries carry `reason`.
- `RunHandle.eid` on every transport from sub-part 11 on, also for a socket that joined a run: read
  from `WorkflowStateEvent.executionId`.
- New seam `StackControl`, chosen by `--target`, so scenarios never run `docker` or `kubectl`
  themselves:

  | Method | single-node | Kubernetes | local-dev |
  |---|---|---|---|
  | `kill_unit()` | `docker kill sce-workflow-runtime-coordinator-service` | `stack/k8s-stack.sh unit-kill <cuid>` (`kubectl delete pod --grace-period=0 --force`) | `stack/localdev-stack.sh unit-kill` (`kill -9` the unit JVM and its Python workers) |
  | `stop_unit()` | `docker stop -t 20 …` | `… unit-stop <cuid>` (`kubectl delete pod`, default grace) | `… unit-stop` (SIGTERM) |
  | `start_unit()` | `docker start …`, wait healthy | create a new unit through the manager; the scenarios after it use that one | `… unit-start`, wait healthy |
  | `pg_activity()` | `docker exec sce-texera-postgres psql … pg_stat_activity` | `… pg-activity` (`kubectl exec` into Postgres) | `… pg-activity` |
  | `unit_env_names()` | `docker inspect` | `… unit-env <cuid>` | the unit's recorded environment |

  In Kubernetes and local-dev the driver still sets `DOCKER_HOST` to a dead socket; the stack
  scripts are what reach the cluster or the processes.
- `--gate 3A|3B|3C` (table in §5). `--scenario y` and the benchmark are never in a default set.

### H2. Stack (`stack/sce_stack.py`, `stack/k8s/k8s_stack.py`, `stack/localdev/localdev_stack.py`)

- `--fast-record` (all three stacks): the unit gets `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS=2000`;
  the Dashboard gets `EXECUTION_CLOSING_INTERVAL_SECONDS=2`,
  `EXECUTION_CLOSING_LOST_AFTER_SECONDS=12`, `EXECUTION_CLOSING_NEVER_STARTED_AFTER_SECONDS=15`,
  `RESULT_CLEANUP_TTL_IN_SECONDS=20`, `RESULT_CLEANUP_COLLECTION_CHECK_INTERVAL_IN_SECONDS=5`. The
  manifest records them. In Kubernetes they are Helm values (the unit's interval reaches pods through the
  manager, which forwards it from sub-part 6 on); in local-dev, exports before each JVM starts.
- `--dashboard-env KEY=VAL` (repeatable), beside `--unit-env`.
- `--unit-no-postgres` (single-node; needs `--isolate-unit`): Postgres is not attached to
  `sce-unit-net`. The network check after generation proves it, and the preflight runs
  `getent hosts texera-postgres` in the unit and expects no answer.
- `k8s-stack.sh` gains `unit-kill`, `unit-stop`, `unit-env`, `pg-activity`; `localdev-stack.sh`
  gains `unit-kill`, `unit-stop`, `unit-start`, `pg-activity`.
- No new image: `images/build.sh` is unchanged.

### H3. Scenarios (`driver/scenarios.py`)

All run with `--fast-record`. "Slow run" is `numbers.csv` → a Python UDF that prints one line and
sleeps 0.1 s per tuple (about 30 s).

| Key | Name | From PR | What it does | Checks |
|---|---|---|---|---|
| p | `record-in-lake` | A | a slow run, paused and resumed once | while it runs: `/log` (from PR B; before that, Lakekeeper through Check I) shows READY, the output rows, RUNNING, PAUSED, RUNNING with rising `seq`; the statistics endpoint returns rows before the end, and their count grows between two reads 5 s apart; console lines are stored before the end (the console table has a snapshot; from PR C the console route returns them); after: the last row is COMPLETED; Check I |
| q | `unit-lost` | B | a slow run; once it is Running and has statistics, `kill_unit()`. Run twice: with the unit left down until the verdict, and with `start_unit()` right after the kill (the unit is back before the verdict) | both times the history entry turns status 4 with reason "unit lost" within lost-after + 3 closing intervals; until then it reads status 1 with a `completionTime` that is a time; `/state` says `open: false`; `/log` has no ending row and a `closing`; statistics and console written before the kill read back; `completionTime` is not before the last state change; after `start_unit()`, scenario a passes on the unit and q's execution is unchanged. In Kubernetes a third pass lists the units once after the kill, as the workspace does when its socket drops: the unit's row is stamped and the verdict comes within 2 closing intervals |
| r | `never-started` | B | create only | after never-started-after + 2 intervals: status 4, "never started"; a start is then refused "already started"; the plan table has `started` |
| s | `polite-stop` | B | a slow run; `stop_unit()` | status 4, reason "the computing unit was stopped", within 2 closing intervals (not after lost-after); `/log` ends with a FAILED row carrying that reason |
| t | `expiry` | B | scenario a's workflow, twice | first execution: after the second create its results are gone (its result and state tables are not in Lakekeeper), its plan, log and statistics are, `/state` still says Completed, `storedBytes` fell, and from PR C export answers 410 "the results of execution N have expired"; second execution: the same after the TTL, without a third create |
| w | `history-outcomes` | B | after d (killed), k (compile error), a (completed) and a UDF that raises | history: 5 "killed by the user", 4 "compile error: …" naming the column, 3 with no reason, 4 with the Python error's first line; the admin list agrees; d's log is RUNNING, PAUSED, RUNNING, KILLED |
| v | `stored-reads-without-unit` | C | a and e, then `stop_unit()` | with the unit down: statistics (the Filter reports 8 output rows), console (10 lines, all `PRINT`), log, state and a local CSV export of a's aggregate (the exact 4 groups) |
| y | `day-long` | C, on demand | §H7 | §H7 |

Existing scenarios: the "persisted status" checks keep their call (`list_executions`). From PR B
on, l5, l6, l9 and l10's rows are expected closed, "never started", by the final check. From
sub-part 14 on, the driver no longer waits for the unit's cleanup `DELETE` (there is none); it
waits the unit's cleanup delay plus 0.5 s.

### H4. Evidence (`driver/evidence.py`)

| Check | Holds when | Gates |
|---|---|---|
| G | no statement at all comes from the unit (by address or by `app=texera-computing-unit`) between a scenario's begin and end marks; and at the end of the run, none since the unit's container started | 3C |
| H | `pg_stat_activity`, sampled at every scenario's start and end, has no backend from a unit address and none named `texera-computing-unit` | 3C |
| I | for every run that was started and has ended: the log table's label state is the expected ending; its rows' `seq` rise by one; and the log, statistics and (when the run printed) console tables each have one data file and one snapshot. The file and snapshot counts are not checked for q and s: a unit that was lost or stopped does not finish its last tidy. Read through Lakekeeper's REST API from the dashboard container, as Check E does | 3A, 3B, 3C |
| J | with `--unit-no-postgres`: the unit cannot resolve `texera-postgres`, is healthy, and every scenario of the gate passes | 3C |
| K | after the last scenario, within lost-after + 3 closing intervals, every execution of the run's workflows has `ended_at` (replaces "no row is left at status 0") | 3B, 3C |

Checks A and B (step 2) keep gating 3A and 3B, where the unit still writes its status, and are
retired in 3C: their windows end at the unit's status UPDATE, which no longer exists, and G is
stronger. C, E and F stay; F passes trivially once the unit sends nothing.

### H5. Negative controls (`./run-negative-control.sh --step 3`, once per gate 3C)

Against the images of step 2's last sub-part, with `--pg-statement-log --isolate-unit
--fast-record`: scenario a must fail Check G (the unit's status UPDATEs) and Check H (the unit's
idle pool); scenario q must stay at status 1 past its deadline; and with `--unit-no-postgres` the
unit must not become healthy. A control that passes, or fails for another reason, fails the gate.

### H6. The three modes

| Mode | Runs | Proof that the unit has no Postgres |
|---|---|---|
| single-node (`run-baseline.sh`) | gates 3A, 3B, 3C | Checks G, H and J |
| Kubernetes (`run-k8s.sh`) | a–e, u, p, q (pod force-deleted; closed by the beat, and in its third pass by the row a listing stamps), s (pod deleted with its grace period), v (after terminating the unit), w | `pg-activity` shows no backend named `texera-computing-unit` and none from the unit pod's address; `unit-env` lists no `STORAGE_JDBC_*`; Envoy's access log shows statistics and export answered by the webserver |
| local-dev (`run-localdev.sh`) | a–e, u, p, q (`kill -9`), s (SIGTERM), v, w | `pg-activity` by application name (every JVM is on 127.0.0.1): none named `texera-computing-unit` |

### H7. The day-long benchmark

Two layers, because the first is exact and takes minutes, and the second proves the product's own
path.

1. `bench/record-bench.sh <worktree>` (new): brings up the throwaway lake of the step 0 proof
   (`stack.sh`, copied from `sce-step0-proofs/proofs/step0/iceberg-commits/` into `bench/`), runs
   sub-part 7's `ExecutionRecordBench` through sbt in the worktree, prints one PASS/FAIL line per
   check, tears down. The bench drives a real `ExecutionRecorder` tick by tick with a simulated
   clock: 2,880 ticks, 10 operators whose numbers change on every tick (28,800 statistics rows),
   one console line per tick, 49 state changes. Checks, thresholds fixed here:

   | Check | Threshold |
   |---|---|
   | `label_read_p95` over the day | < 50 ms |
   | `statistics_read_end` (median of 3, after the end tidy) | < 1 s |
   | `statistics_read_before_tidy_median` (the read right before each tidy) | < 1 s; the maximum is reported |
   | `log_read_end` | < 100 ms |
   | `console_read_1000_rows_end` | < 200 ms |
   | `commit_p50_flat` (last window against the first) | within 1.5× |
   | `rows_complete_and_ordered` (every full read, through every tidy) | exact |
   | `files_at_end` (log, statistics, console) | 1 data file and 1 snapshot each |

2. Scenario y, in each mode: CSV scan of an 8,000-row file → a Python UDF sleeping 0.2 s per tuple →
   eight Projection and Filter operators in a chain (so nine operators' numbers change on every
   tick), on a unit with `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS=400`. A tick then takes about
   0.55 s with its commits, so the run is about 2,900 ticks in about 27 minutes. Every two minutes
   and after the end the driver times, through the gateway: `/state` (20 calls), the statistics
   endpoint (5 calls, with the row count) and `/log`. It fails when, after the end, the statistics
   median is 1 s or more, or fewer than 20,000 rows came back (the run was not a day's worth), or
   the `/state` p95 is 100 ms or more; or when a during-the-run statistics median is 1 s or more.
   The numbers go into the report's `benchmark` section.

## 8. Deployment changes per mode

| Mode | Change | Sub-part |
|---|---|---|
| All | `sql/updates/53.sql` and `54.sql`, applied the way every migration is (liquibase; local-dev's schema step) | 9, 18 |
| All | Upgrade: executions made earlier are closed by 53.sql and lose their results and statistics. Their tables stay in the four shared namespaces of each warehouse, and nothing reads them (an old statistics table reads as empty, §3.3). To get the space back, delete those executions in the UI, before or after the upgrade (afterwards their tables are found by name, §4.4), or empty the namespaces. Units and curated images are recreated at upgrade, as for step 2: a unit of the old image writes no log, so the Dashboard would close each of its runs as lost after three minutes | 9 |
| Single-node | nothing in `nginx.conf`: statistics, export and the new routes fall under `location /api/` (`:137`) | – |
| Single-node | the unit keeps `env_file: .env` until step 5 (so the database login is still in its environment) but opens no connection | 17 |
| Single-node | to tune: `EXECUTION_CLOSING_*`, `RESULT_CLEANUP_*`, `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS` in `.env` | 6, 11, 14 |
| K8s | gateway: remove the statistics regex and the export prefix from the dynamic route (`gateway-routes.yaml:186-191`); they fall to the `/api` rule and the webserver. Neither route sets a request timeout today, so export keeps the gateway's default; a longer one is one rule, like create's (`:149-154`) | 16 |
| K8s | access-control-service: remove `apiExecutionsStats` and `apiExecutionsResultExport` and their case (`AccessControlResource.scala:47-48`, `:84-86`), and the export form's token parsing (`:151`) if nothing else uses it | 16 |
| K8s | unit pods get `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS` when the manager has it (one more name in `optionalComputingUnitEnvNames`, `ComputingUnitManagingResource.scala:351-353`) | 6 |
| K8s | unit pods get no `STORAGE_JDBC_URL`, `STORAGE_JDBC_USERNAME`, `STORAGE_JDBC_PASSWORD` (`ComputingUnitManagingResource.scala:433-436`) | 19 |
| K8s | webserver: more than one replica is fine (D32); it reads the lake more (one `loadTable` per open execution per 30 s) and needs only what step 2 gave it | 11 |
| Local dev | nothing in `frontend/proxy.config.json` or `bin/local-dev/main.sh` (the unit ignores the JDBC exports) | – |
| CI | `.github/workflows/build.yml:719-735`: the smoke boot of `computing-unit-master` says it "boots on postgres only"; it now boots on nothing | 17 |
| Slurm, EC2 later | "unit lost" needs nothing from the platform: the beat works wherever the unit reaches the lake. A platform that can be asked gets the fast path by stamping the unit's row, through whatever interface step 6 gives it | – |

Verification per PR: single-node through the gates; Kubernetes on OrbStack and local-dev through
`run-k8s.sh` and `run-localdev.sh` for PRs B and C (starting OrbStack's Kubernetes restarts
Docker, so warn the user first).

## 9. Risks and how each is tested

| Risk | Test |
|---|---|
| A catalog does not commit a row and its label together, or Lakekeeper treats a properties-only commit differently from the proof | Settled for Lakekeeper by the review's probe (§1b): one commit, and 16,638 concurrent reads never saw one without the other; a beat adds no snapshot. Kept as specs: `ExecutionLogStoreSpec` on the JDBC catalog (after `append`, one new snapshot and the label; a reader between two appends never sees a label ahead of its row), `IcebergAppenderSpec` once against Lakekeeper, and harness Check I. The Dashboard reads the rows before it declares an execution lost (D26), so a label that lagged could delay a verdict, never cause a wrong one |
| A healthy run is declared lost: slow lake, a long tidy, a paused JVM, clock skew, a restarted Dashboard, a tick that fails | `ExecutionClosingSpec`: a beat that changes resets the count; a tick that cannot read does not count; a fresh job starts from zero; the threshold is never below 4 beats. `ExecutionRecorderSpec`: a tick whose statistics, console or tidy step throws, an unexpected error included, has already beaten, and the next tick runs. What remains: a unit cut off from the lake for longer than lost-after while the Dashboard is not. The row then says lost while the engine goes on; `/log` shows both. `lost-after-seconds` is the knob |
| The unit is back before the verdict and the workspace shows an idle workflow instead of the ending | `execute-workflow.service.spec.ts`: a socket that comes back with no execution keeps the poll going until the execution is closed; harness q's second pass; the browser smoke of brief 15 |
| The log, statistics or console lose or reorder rows across a tidy | `IcebergTidySpec` (rows equal and in order after every tidy, with appends between tidies); `ExecutionRecorderSpec`; the benchmark's `rows_complete_and_ordered` |
| The end-of-run tidy deletes a file a reader planned | the three stores' readers plan again once (`ExecutionLogStoreSpec`, `RuntimeStatisticsStoreSpec`: a tidy between plan and read). Result tables are not tidied, so the reader that resumes from a snapshot (C15) is never exposed |
| A store takes an outage for a missing table, and the job closes running executions as never started or lost | §3.8; `ExecutionLogStoreSpec`: a catalog that throws makes `label`, `read` and `outputs` throw; `ExecutionClosingJobSpec`: a lake read that throws leaves the execution open and counts for nothing, also for an execution older than the never-started limit |
| An execution made before the step breaks a page: its statistics table is in the old schema at the location the new reader derives | `RuntimeStatisticsStoreSpec`: a table without `timeMs` reads as empty; `WorkflowExecutionsResourceSpec`: the route answers an empty list for it; `CostHintsLoaderSpec`: no hints, no error |
| A workflow with many more operators than the benchmark's 10 stores proportionally more statistics rows, and the response grows with them (about 200 bytes a row) | the benchmark's `--operators` option reports where a day passes 1 s; the statistics route can thin its answer (`maxPoints`) when a real workflow gets there. Not built |
| Lakekeeper's load: every open execution commits 2–3 times per 30 s, so 300 concurrent runs are about 30 commits a second, and the Dashboard reads 300 labels per tick | Measured on a laptop (§1b): about 260 commits a second with 32 or 64 writers on 200 tables, and 200 labels read in 0.2 s. So a few hundred runs use about a tenth of one small Lakekeeper. Beyond a few thousand the interval has to grow; `beat-every-ms` in the label keeps the Dashboard's threshold in step. Also the benchmark's commit latencies, and scenario y's unit at about two ticks per second for 27 minutes |
| The Dashboard job touches more warehouses than its catalog cache holds (64, `IcebergCatalogInstance.scala:72-73`) and rebuilds clients on every tick | noted; the bound becomes a setting when a deployment has more than 64 users running at once (upstream's result service asks for the same setting) |
| A Postgres use on the unit that this design did not list | D39: the unit has no pool, so it throws. `ComputingUnitWithoutDatabaseSpec` (sub-part 17) runs an execution end to end that way; harness Checks G, H, J; the Kubernetes pod has no login (sub-part 19) |
| With the `postgres` catalog type the unit still connects to Postgres, for the catalog | C16; the done-when is checked on the REST catalog. The in-repo spec asserts on `SqlServer`, not on the catalog |
| About 40 amber specs use `MockTexeraDB` and many assert the Postgres writes that go | sub-parts 5–6 keep those writes; 17 removes them with their assertions; unit-side specs then need no database, which sub-part 17's spec proves |
| Upstream moves under the step: #9356 reads the columns sub-part 18 drops; #9271 and #9272 rewrite `ExecutionResultService`; #8936 changed the frontend's lost-unit handling after the branch's base | §10: rebase before PR B; sub-part 14 switches the result service's lookup when the module is in the tree; step 3's edits to `ExecutionResultService` are single-line replacements |
| Two endings in one log | `ExecutionStateStoreSpec`: after an ending nothing is recorded; `SyncExecutionResourceSpec`: "targets done" writes one COMPLETED row and no KILLED |
| A user starts an execution the job is closing as never started | the `started` tag decides (D28); `ExecutionClosingJobSpec` lets a start take the claim first and the job leaves the execution open; harness r |
| Two Dashboard replicas email twice, or close differently | `ExecutionClosingJobSpec` runs two jobs over one database: one UPDATE wins, one email; the harness cannot run two replicas in single-node; Kubernetes with `webserver.numOfPods=2` (`bin/k8s/values.yaml:230`) once by hand |
| A unit stopped politely does not get its endings out in time | best effort, 5 s; when it fails the execution reads "unit lost" instead (harness s shows the good case) |
| Expiry drops the wrong tables, or leaves some | `ExecutionExpirySpec`: result, state and console gone, plan, log and statistics kept; another execution of the same workflow untouched, also execution 34 when 3 is found by name; the search by name when there is no log; harness t. What it leaves: a result table made in the instant before its unit died, whose `output` row never landed, stays until its execution is deleted or step 5 gives each execution a namespace of its own |
| Old executions' tables are orphaned at upgrade | §8: they go when their executions are deleted, or with the namespaces; no backward compatibility |
| The idle sweep terminates a unit with a live run, or never terminates one | `ComputingUnitIdleCleanupSpec` and `ComputingUnitManagingResourceSpec`: a row with no `ended_at` keeps its unit; every closed row older than the cutoff releases it; the sweep and the closing job are exercised together by Kubernetes q |
| A local unit a user "terminates" keeps running its engine; the execution reads "unit terminated" while the engine goes on | accepted: terminating a local unit never stopped anything; `/log` shows what the engine did afterwards |
| Cluster mode (`--cluster`) | the recorder lives with the coordinator on the master and workers never held a database; not tested, as in step 2 |

## 10. Upstream work that overlaps, and how this design meets it

State on 2026-11-16 (`gh`). The branch's base is `205fe77c4`; #9452 and #8936 merged after it, so
rebase before PR B.

| Upstream | State | Where it meets step 3 | What step 3 does |
|---|---|---|---|
| Result service: discussion #8945, issue #8995, PR #9356 | PR open, one approval, waiting for the owner's review. Adds the `result-service` module and CI legs only; deployment is a later PR | `ResultResource.storedResults` reads `operator_port_executions` (URI, `output_mode`, `result_count`); `getLatestExecution` reads `status IN (3,4,5)`; the PR edits `ExecutionResultUris.scala` (+1/−11) | Keeps `ExecutionResultUris`' two signatures and re-bases them on the log (sub-part 14). If the module is in the tree by then, the same sub-part switches `storedResults` to `ExecutionLogStore.outputs`, the row count to the table's summary and `getLatestExecution` to `outcome IS NOT NULL`. Does not deploy the service or move the panel |
| Result panel through the result service: #8996 | open issue | removes `ResultPaginationRequest`; wants the execution id on pushed updates | Leaves pagination on the socket, for the held run only; adds `executionId` to `WorkflowStateEvent` (D37), which #8996 can use |
| Output mode and row count columns: #8994, #9049 | merged | `operator_port_executions.output_mode`, `result_count` | Dropped in sub-part 18. The mode is in the log's `output` rows; the count is the result table's `total-records` |
| Result cache: discussion #5880; PR #8731 open and on hold; #8732–#8734 closed on 2026-11-16 | design being reworked | no file in common (step 3 leaves scheduling alone). Two rules meet: the cache wants earlier results kept, and "record cache metadata during execution" must not become a unit write to Postgres | Replacing results at create is one call (`ExecutionExpiry.expireReplaced` in `ExecutionCreator`) to remove when the cache needs them. A cache entry can be registered by the closing job from the log's `output` rows of a completed run, and removed by the expiry. Neither is built; `operator_port_cache` is untouched |
| Per-port result metadata and live updates: #9271 (changes requested), #9272 (draft) | open | `ExecutionResultService.scala`, `WorkflowResultStore.scala`, `WebResultUpdateEvent`, `workflow-result.service.ts` | Touches `ExecutionResultService` only where it looks a result up (four lines) and where it writes Postgres (deleted). No restructuring, so either order rebases |
| Agent auth through the gateway: #9043 | open | `AccessControlResource.scala`, `nginx.conf`, the agent's deployment | Sub-part 16 deletes two patterns and one case in `AccessControlResource`; `nginx.conf` is not touched |
| Unit sharing while disabled: #9234 | open | `ComputingUnitAccess` | none; the closing job reads only the unit's `terminate_time` |
| Shared Helm templates: #9452 | merged after the base | 17 chart files | Step 3 edits `gateway-routes.yaml` and the manager's unit environment only; rebase first |
| PVE websocket JSON: #9214 | open | `PveWebsocketResource.scala` | none: step 2's sub-part 21 deletes the file |
| Python worker death fails the run: #9364 | open | `Coordinator`, `PythonWorkflowWorker` | none in files. Its failure arrives as a fatal error and is logged with its why through `transitionTo` |
| Tracing the sync entry point: #9445 | open | `SyncExecutionResource.scala` (+12) | a textual conflict at most, in sub-parts 5 and 17 |
| Lost unit in the frontend: #8934, fixed by #8936 | merged after the base | `execute-workflow.service.ts` resets the run when its unit is gone | Sub-part 15 builds on it: instead of resetting to idle, it asks the state endpoint and shows the outcome |
| Idle sweep and stuck executions: #8618 | open | the sweep's predicate | D33: every execution gets closed, and the sweep reads `ended_at`. The issue's second proposal (check against the pod on a schedule) is not taken up here: it was sub-part 10 and waits for step 6 (D27) |
| The unit's Postgres call sites: #5012 | open | the list | Removes every one that step 2 left: state changes, the URI registry, export, clean-up. Not by an HTTP service that holds the login, as the issue proposes, but by the unit not needing one |

## 11. Open decisions for the owner

1. **Where the Dashboard's verdicts live.** This design: "unit lost", "never started" and "compile
   error" exist only in the execution's Postgres row; the engine is the log's only writer (D4). The
   alternative also appends a closing row to the log, so the lake alone tells the whole story; it
   needs a second writer and a rule for an engine that reports after the verdict. Recommendation:
   the row only. It is what the plan page draws ("unit gone? … outcome, once"), and `/log` already
   returns both.
2. **The closing record.** This design adds six columns to the row: `outcome`, `outcome_reason`,
   `ended_at`, `stored_bytes`, `results_expired_at`, `notification` (D20), all written by the
   Dashboard, none by the unit. The strict reading of "Postgres keeps only the fact that the
   execution exists" keeps one mark (`ended_at`) and reads everything else from the lake: then the
   lists cannot filter or sort by outcome in SQL, every listed row costs a lake read, and the quota
   page needs a cache of sizes somewhere. Recommendation: the six columns.
3. **How much of the result service belongs to this step.** This design keeps step 3 independent
   of upstream's track: the Dashboard serves state, log, statistics, console and export; result
   pages stay on the unit's socket for the run it holds; the result service gets a lake-only
   lookup. So "results of a run whose unit is gone" still waits for #8995's deployment and #8996.
   The alternative brings #9356, its deployment in all three modes and the panel's move into this
   step. Recommendation: review and merge #9356 as it is now; keep step 3 as designed; step 4 needs
   the service deployed in every mode ("stored output" is one of Envoy's three kinds of route), so
   ask for its deployment PR before step 4 starts.
4. **Two changes users will see.** Stored statistics have one point per 30 s (D10), and there is
   one email per run, at its end, none on pause (D30). Both follow from the tracker's text; both
   can be softened at a cost (a shorter interval while a run is young; the job watching for pauses
   and remembering which it reported). Recommendation: as designed.
5. **Retention.** This design keeps step 2's rule (a new execution replaces the results of earlier
   finished executions of the same workflow on the same unit) and adds expiry one day after the end;
   statistics stay with the plan and the log; console output goes with the results (D31). The
   alternatives: age only (results of every run for a day, more storage), or keeping statistics
   only as long as results. One thing to weigh: today a run's results are dropped 30 s after its
   last tab closes, so this step keeps them longer than anything does now, and until the result
   service can page a past run (#8996) only export reads them back. If that storage is not worth
   it yet, the knob is `result-cleanup.ttl-in-seconds`: an hour instead of a day changes nothing
   else. Recommendation: as designed, and drop the replace-at-create call when the result cache
   needs earlier results.
6. **What the review left out of the step.** Three sub-parts of revision 1 are not needed by the
   done-when and are out (§5): committing results on the timer (8), a timer in the unit manager
   that asks Kubernetes which units it lost (10), and cheaper `Tuple`-based reads (1). What users
   would have noticed of them: a slow operator's first rows within 30 s instead of at 4,096 rows
   or the port's end; a lost run that nobody watches closed after one minute in Kubernetes
   instead of three and a half; faster result pages. The first also made a slow result slow to
   read as a whole, because result tables cannot be compacted. Recommendation: leave all three
   out; take 8 up with the result service, 10 with step 6, and send 1 upstream on its own whenever
   convenient. Their briefs are kept in the appendix.

## 12. The author's attack on revision 1, and what it changed

Each line is a way the design could be wrong or leave Postgres on the unit, what was checked, and
the outcome. The review (§1b) repeated the searches of item 1 at `f8b43b980` and found the list
complete. Where revision 2 changed an outcome, the line says so.

1. **A Postgres use on the unit that is not on the list.** Checked by searching
   `SqlServer|jooq|Dao(` over `amber/src/main` and the common modules, and by walking everything
   `ComputingUnitMaster` registers. What step 2 leaves on the unit: the pool at boot
   (`ComputingUnitMaster.scala:145`); state writes (13 sites); `updateRuntimeStatsUri`
   (`ExecutionStatsService.scala:88`); `insertOperatorExecutions` (`ExecutionConsoleService.scala:157`);
   the result registry and its sizes and counts (`ExecutionResultService.scala:92-104`, `:388-389`,
   `:498-503`); the lookups (`:175`, `:377`, `:418-421`, `:475`; `SyncExecutionResource.scala:655`,
   `:939`); the idle clean-up (`WorkflowService.scala:247`); the TTL job and clean-all-at-boot
   (`ComputingUnitMaster.scala:182-204`, `:241-308`); and `WorkflowExecutionsResource` served by
   the unit (`:206`: statistics and export, with their access checks). The auth path was a
   suspect and is clean: `UserAuthenticator`, `JwtParser` and `ServletAwareConfigurator` only
   import jOOQ types, and `UserActivityTracker`, which upserts on authenticated requests, is wired
   only in access-control-service. Outcome: sub-parts 16 and 17 list exactly these, and D39 makes
   anything missed throw.
2. **Sending the email reads Postgres.** The first draft said so. `GmailResource.sendEmail`
   (`:112-131`) does not; only the registration mails do (`:65`, `:195`). Outcome: C9 corrected.
   The email still leaves the unit, because it is an outside call and because of D30.
3. **A lake commit under the state store's lock.** `updateWorkflowState` runs inside
   `StateStore.updateState` (`StateStore.scala:50-55`). A synchronous append there would freeze the
   live view whenever the lake is slow. Outcome: the recorder's thread (D8).
4. **The day-long read misses its target because of the row count, not the reader.** The engine
   persists every 2 s and on every worker state change (C5). Outcome: sampling at the commit (D10);
   without it the benchmark would read 432,000 rows.
5. **Compaction reorders rows.** Readers sort by file sequence number; a merge is safe only with
   no append between plan and commit. Outcome: compaction only where the recorder is the one
   writer (D13). A second pass found that "merge everything" rewrites a large console on every
   tidy; outcome: merge only the small files at the end. Revision 2: result tables are not
   tidied at all (D14).
6. **A tidy breaks a reader.** Three cases were separated: a page read (short; protected by keeping
   60 s of snapshots), the end-of-run tidy (keeps one snapshot; the new readers plan again once),
   and the polling iterator. Outcome: D15. Revision 2: the polling iterator only reads result
   tables, which are no longer tidied, so it is not changed.
7. **Label and row disagree.** Outcome: one commit for both, and the rows are read before any
   "lost" verdict. Revision 2: measured on Lakekeeper, they never disagree for a reader (§1b).
8. **The beat gives false alarms.** Comparing the unit's clock with the Dashboard's fails on skew;
   comparing wall time fails when a laptop sleeps. Outcome: the job counts its own ticks in which
   the beat did not change, and the label carries the beat's interval (D26).
9. **An ending is never written and the run reads "unit lost" although the unit is fine.** Found
   two such paths: the idle clean-up of a paused run, and a polite stop. Outcome: D5.
10. **An ending is written twice.** The agent path. Outcome: D5 and `transitionTo`'s rule.
11. **Console needs Postgres to be found, and one commit per operator.** Outcome: D11.
12. **A never-started execution is closed and then started.** Outcome: the job takes the start
    (D28).
13. **The Dashboard asks Kubernetes.** It has no client and no rights. Outcome: the manager
    stamps the unit's row and the closing job reads the row (D27). Revision 2: with the stamps the
    manager makes today, and no new timer.
14. **`getCount` from the summary is wrong after a rewrite.** Iceberg carries `total-records`
    forward from the previous snapshot for appends, rewrites and manifest rewrites; a table whose
    first snapshot lacked it would not have it. Revision 2: the change went out with sub-part 1;
    the appendix keeps the fallback.
15. **The unit still holds the database login.** True in single-node until step 5 (`env_file`);
    removed in Kubernetes in this step (sub-part 19). The harness's `--unit-no-postgres` proves
    the unit does not need to reach Postgres at all.
16. **The harness itself depends on the unit's statements** (the start window's end, the cleanup
    wait). Outcome: §7 H3 and H4 replace both.
17. **Step 2's unfinished sub-parts rewrite files this step edits** (`WorkflowService`'s old path,
    `SyncExecutionResource`, the environment code). Outcome: the briefs name behaviour and seams
    there, not lines, and sub-part 17's list is checked again by its spec.
18. **Upstream's result service breaks when the registry goes.** Outcome: D36 and §10.
19. **The new routes show a run's output to anyone who can see a public workflow.** The existing
    execution routes check read access, which a public workflow grants to everyone
    (`WorkflowAccess.scala:39-41`). A log or a console can quote data from the runner's private
    datasets. Outcome: the state, log and console routes, and the `reason` in lists, use the rule
    upstream's result service chose (the creator, or a user the workflow was granted to).
20. **An ending the unit knows and the log does not.** The unit counts `TERMINATED` as an ending;
    the log has no such state. Outcome: it is logged as KILLED (brief 5).
21. **Re-running at once no longer replaces the previous results.** Step 2's replace-at-create
    looked at `status`, which the unit set the moment a run ended; the closing record arrives up to
    30 s later. Outcome: create closes the earlier executions whose label already shows an ending
    before it expires what it replaces (§4.4).
22. **A deleted execution's unit recreates its tables.** A recorder that retried "create the table"
    for ever would bring a deleted execution's log back, with no row to find it. Outcome: a table
    that existed and is gone stops the recorder, and the delete routes refuse an open execution
    (§4.1, §4.4).

## 13. Implementation briefs

Each brief stands alone: goal, what it depends on, files, exact behaviour, tests and how to run
them, and when the sub-part is done. Paths are relative to the worktree root. Commit subjects
follow `AGENTS.md`; commit messages end with the attribution lines the session provides. A brief
has the number of its sub-part, so there is no brief 1, 8 or 10 here: those sub-parts are left out
of the step (§5) and their briefs are in the appendix.

**Since `f8b43b980`.** Step 2's sub-part 14 landed as `258d6ae54` while this revision was written.
The briefs' line numbers are still those of `f8b43b980`; find the code by the names they give.
What that commit changes for them:

- `WorkflowStateEvent` already carries `executionId` (none for the "Uninitialized" a new socket is
  sent first), and the browser already keeps it: `currentExecutionId` is set from every state
  event, and an event that names no execution forgets it (`execute-workflow.service.ts:205` at
  `258d6ae54`). So brief 11's change to the event is done, and brief 15 has to add what follows an
  execution through such an event (D37): as committed, the page forgets its execution the moment
  a socket reopens.
- The 13 state-change sites are the same 13 at new lines (`SyncExecutionResource.scala:334`,
  `:392`; `ExecutionRuntimeService.scala:113`; `WorkflowExecutionService.scala:248`, `:266`;
  `WorkflowService.scala:246`, `:485`). `fatalErrorsOf` is gone: the run's error handler builds its
  one `EXECUTION_FAILURE` in place, and that is what brief 5 passes as `errors` there.
- A kill that reaches a run that has ended is already ignored (`ExecutionRuntimeService.scala:102-118`),
  and the commit left open that a pause or a resume still rewrites an ended run's state.
  `transitionTo` (brief 5) settles it for every change of state, so that guard and the one in
  `supersedeCurrentRun` both move into it.
- `WorkflowService.initExecutionService`, the unit's old run route and the unit's clearing of the
  previous run's results at a start are gone, as the briefs assumed. `TestUtils` moved down by
  eleven lines.

**Running tests (every brief).** As in step 2: the jOOQ classes are generated from a Postgres on
`localhost:5432` (user and password `postgres`), and the amber specs that use the Postgres Iceberg
catalog need the same server:

```bash
docker run -d --name texera-tripwire-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 groonga/pgroonga:4.0.1-debian-15
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/texera_ddl.sql
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/iceberg_postgres_catalog.sql
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/texera_lakefs.sql
STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "<Module>/testOnly <fully.qualified.Spec> …"
```

sbt modules: `DAO`, `Config`, `WorkflowCore`, `WorkflowExecutionService` (amber: the Dashboard
service and the unit), `ComputingUnitManagingService`, `AccessControlService`. ScalaTest prints no
per-test lines here; read `<module>/target/test-reports/TEST-<suite>.xml`. Specs that start Python
workers need `UDF_PYTHON_PATH=<venv312>/bin/python`. Frontend: `cd frontend && yarn install
--immutable && npx ng test --watch=false --test-file <spec path>`. Python: `cd amber && python -m
pytest <path>`. Remove the Postgres container afterwards. Never run sbt in a worktree another
agent is building in. Harness: build images from a separate worktree at the commit under test
(`images/build.sh <worktree> <tag>`, with `--frontend` from sub-part 12 on), then
`./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --fast-record -- --gate 3A` (or
3B, 3C).

After a sub-part that changes `sql/texera_ddl.sql` (9, 18): apply the DDL to the local Postgres
again, run `sbt DAO/compile` (its `jooqGenerate` task rewrites
`common/dao/src/main/scala/org/apache/texera/dao/jooq/generated`), and commit the regenerated
classes with the sub-part.

### Brief 2. `feat(workflow-core): tidy an Iceberg table under its readers`

**Goal.** The storage layer can append records with table properties in one commit, and tidy a
table that has one writer. Nothing calls the tidy yet.

**Depends on.** Nothing.

**Files.**
- `common/config/src/main/resources/storage.conf` (under `storage.iceberg.table`) and
  `common/config/src/main/scala/org/apache/texera/common/config/StorageConfig.scala`:
  `commit.interval-ms = 30000` with its env override (§3.7); `icebergTableCommitIntervalMs`. The
  tidy's numbers are not settings (D13).
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/result/iceberg/IcebergAppender.scala`
  (`private[storage] object`):
  - `append(table: Table, records: Iterable[Record], fileName: String, properties: Map[String,
    String] = Map.empty): Unit`: writes one Parquet data file at `<table location>/<fileName>` the
    way `IcebergTableWriter.flushBuffer` does (`:108-131`), then commits
    `newFastAppend().appendFile(file)`. With properties, the append and
    `updateProperties().set(…)` are two operations of one `table.newTransaction()`, committed by
    `commitTransaction()`: one commit to the catalog, on the REST catalog one request that holds
    the snapshot and the properties (measured on Lakekeeper, §1b). Empty `records` with properties
    sets the properties only.
  - `setProperties(table, properties)`: `updateProperties` alone (no snapshot).
- New `.../result/iceberg/IcebergTidy.scala` (`private[storage] object`), written from the step 0
  proof's `tidy` (`sce-step0-proofs/proofs/step0/iceberg-commits/src/IcebergCommitBench.scala:598-645`):
  - `mergeSmallFiles(table, targetBytes): Int`: plan the current snapshot; sort the files by
    `fileSequenceNumber`; take the longest suffix of files each smaller than `targetBytes`; if it
    has fewer than two, return 0; read them in order (`IcebergUtil.readDataFileAsIterator`) into
    one data file `merged_<8 hex>`; commit `newRewrite().validateFromSnapshot(planned)` deleting
    them and adding it; return how many were merged.
  - `rewriteManifests(table)`: `rewriteManifests().clusterBy(_ => "all").commit()`.
  - `expire(table, retainLast, olderThanMs)`: `expireSnapshots().expireOlderThan(olderThanMs)
    .retainLast(retainLast).cleanExpiredFiles(true).commit()`.
  - `tidy(table, atEnd: Boolean)`: merge (`TargetFileBytes` = 32 MB), rewrite, then
    `expire(retainLast = 1, olderThan = now)` at the end, else `expire(RetainSnapshots,
    now − RetainMillis)` (5 and 60 s). The three are constants of the object.
  - `OnIceberg.expireSnapshots` (`OnIceberg.scala:33-47`) stays until sub-part 14.
- `IcebergDocument.scala` is not touched: the tables this tidy is for are never read through it.

**Behaviour.** A merge must run with no append between its plan and its commit; the callers (the
recorder, on its one thread) guarantee that, and `validateFromSnapshot` fails the commit otherwise.
A file that reached `targetBytes` is never rewritten. The tidy is for a table with one writer that
also tidies it; nothing may call it on a result table (D14).

**Tests** (the local Hadoop catalog the storage specs use).
- New `.../result/iceberg/IcebergAppenderSpec.scala`: an append adds one snapshot and one file; with
  properties the same commit sets them (the table's history has one new entry, and a table loaded
  before the commit sees neither, one loaded after sees both); properties only adds no snapshot.
- New `.../result/iceberg/IcebergTidySpec.scala`: 60 appends of 3 rows, then `tidy(atEnd = false)`:
  one data file, at least `retain` snapshots, every row in order; 5 more appends: rows still in
  order in a full read by file sequence number; `tidy(atEnd = true)`: one data file, one manifest,
  one snapshot, and the replaced files are gone from the table's directory; with a tiny
  `targetBytes`, a file over it is left alone and only the files after it merge; one file: nothing
  to merge; properties set before a tidy are the same after it.

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.result.iceberg.IcebergAppenderSpec org.apache.texera.amber.core.storage.result.iceberg.IcebergTidySpec"`,
and once against Lakekeeper: `STORAGE_ICEBERG_CATALOG_TYPE=rest` with the step 0 proof's lake
(`stack.sh up`, `stack.sh env`) for both.

**Done when.** The specs pass on both catalogs; no production code calls `IcebergTidy`.

### Brief 3. `feat(workflow-core): keep an execution's log in the lake`

**Goal.** One Iceberg table per execution holds its state changes and its stored output ports, with
the newest state as a label, behind `ExecutionLogStore` (§3.2, §3.8). Nothing calls it yet.

**Depends on.** 2.

**Files.**
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/VFSURIFactory.scala`:
  `VFSResourceType.EXECUTION_LOG = Value("executionLog")`; `createExecutionLogURI(wid, eid,
  warehouse = None)` through `createNonResultVFSURI`, giving `…/eid/<eid>/executionlog`.
- `DocumentFactory.scala:47-56`: `case EXECUTION_LOG => StorageConfig.icebergTableExecutionLogNamespace`.
- `storage.conf`, `StorageConfig.scala`: `execution-log-namespace = "execution-log"` with
  `${?STORAGE_ICEBERG_TABLE_EXECUTION_LOG_NAMESPACE}`.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/result/ResultSchema.scala`:
  `executionLogSchema` = `seq LONG, timeMs LONG, kind STRING, state STRING, detail STRING`.
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/ExecutionLogStore.scala`
  (package `org.apache.texera.amber.core.storage`, beside `ExecutionPlanStore`):
  - the case classes of §3.8; `States = Seq("READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED",
    "KILLED")`; `EndStates` = the last three; property names as constants.
  - `ExecutionLogDetail`: `forState(reason: Option[String], errors: Seq[WorkflowFatalError]):
    Option[String]` (None when both are empty), `forOutput(port, uri, outputMode): String`,
    `reasonOf(detail)`, `errorsOf(detail)`, `outputOf(detail)`; JSON as in §3.2, written with the
    module's `objectMapper`.
  - `logUri(wid, eid, warehouse)`; every other method refuses a URI that `logUri` could not have
    built (as `ExecutionPlanStore.requirePlanUri` does, `ExecutionPlanStore.scala:293-307`).
  - `create(uri, nowMs, beatEveryMs)`: `DocumentFactory.createDocument(uri, executionLogSchema)`
    (replaces a table left from an earlier database), then `IcebergAppender.setProperties` with
    `beat-ms` and `beat-every-ms`.
  - `append(uri, entries, nowMs)`: entries non-empty with rising `seq`; one data file
    `<kind of the first>_<first seq>_<8 hex>`; properties in the same commit: `beat-ms = nowMs`
    and, when `entries` holds a `state` row, the four state properties of the last one (`reason` =
    the detail's reason, else its first error's message, else empty; cut to 500 characters).
  - `beat(uri, nowMs)`: `setProperties(beat-ms)`.
  - `label(uri)`: `DocumentFactory.icebergTableOf(uri)`; None when there is no table; any other
    catalog failure is thrown.
  - `read(uri)`: the table through `icebergTableOf` as well; plan the current snapshot, read the
    files in sequence order as records, map to entries, sort by `seq` and keep the first row of
    each `seq`; if a planned file is gone (`NotFoundException`), plan and read once more; no
    table: `Nil`; any other failure is thrown (§3.8).
  - `outputs(uri)`: the `output` rows of `read`, parsed; a port recorded twice counts once.
  - `tidy(uri, atEnd)`: `IcebergTidy.tidy`; `drop(uri)`: `DocumentFactory.dropTable`.
- `amber/src/main/python/core/storage/vfs_uri_factory.py`: `EXECUTION_LOG = "executionLog"` in
  `VFSResourceType`, so both parsers accept the same URIs.

**Tests.**
- `VFSURIFactorySpec`, `DocumentFactorySpec`: the URI with and without a warehouse decodes to
  `EXECUTION_LOG`; namespace `execution-log`, table `wid_12_eid_345_executionlog`; not taken for
  another type.
- New `ExecutionLogStoreSpec` (Postgres JDBC catalog, as `ExecutionPlanStoreSpec`): `create` gives a
  label with a beat and no state; a READY row gives the label READY with its seq and time; an
  output row and a RUNNING row in one `append` are one snapshot; `read` returns rows by `seq`;
  `outputs` parses the port, URI and mode; `beat` changes only `beat-ms` and adds no snapshot; a
  FAILED row with two errors and no reason labels the first error's message, cut at 500; `ended` is
  true only for the three endings; a table loaded between two appends never shows a label ahead of
  its rows; a missing table: `label` None, `read` Nil; a catalog that cannot answer (a seam that
  throws) makes `label`, `read` and `outputs` throw, none of them answers "no table"; the same
  rows appended twice read back once; a plan URI is refused; `tidy(atEnd = true)` after 60 appends
  leaves one data file, the same rows and the same label; `create` over an existing table replaces
  it; `drop`, and `drop` of a missing table.
- `amber/src/test/python/core/storage/test_vfs_uri_factory.py`: an execution-log URI decodes.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.ExecutionLogStoreSpec org.apache.texera.amber.core.storage.VFSURIFactorySpec org.apache.texera.amber.core.storage.DocumentFactorySpec"`;
`cd amber && python -m pytest src/test/python/core/storage/test_vfs_uri_factory.py`.

**Done when.** The specs pass; no production code calls the store.

### Brief 4. `feat(workflow-core): store statistics and console as records`

**Goal.** Two stores write and read an execution's statistics and console output as Iceberg records,
with epoch-millisecond times and one console table per execution (§3.3). Nothing calls them yet;
the old schemas and the per-operator console URI stay until sub-part 6.

**Depends on.** 2.

**Files.**
- `VFSURIFactory.scala`: a second `createConsoleMessagesURI(wid, eid, warehouse)` with no operator
  (`…/eid/<eid>/consolemessages`); `createNonResultVFSURI` no longer requires an operator for
  `CONSOLE_MESSAGES` (`:258-262`).
- New `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/RuntimeStatisticsStore.scala`:
  `RuntimeStatisticsRow(operatorId, timeMs, inputTupleCnt, inputTupleSize, outputTupleCnt,
  outputTupleSize, dataProcessingTime, controlProcessingTime, idleTime, numWorkers, status)`; its
  own schema (§3.3); `statisticsUri(wid, eid, warehouse)` = `createRuntimeStatisticsURI`;
  `create(uri)`; `append(uri, rows)` (one file `statistics_<8 hex>`, `IcebergAppender.append`);
  `read(uri, columns: Set[String] = all): Seq[RuntimeStatisticsRow]` in file-sequence order, only
  the asked columns read (the others 0 or empty), planning once more if a file is gone; `Nil` for a
  missing table, and `Nil` for a table whose schema has no `timeMs` column, which is a statistics
  table written before this step (§3.3); `tidy(uri, atEnd)`; `drop(uri)`.
- New `.../storage/ConsoleMessageStore.scala`: `ConsoleRow(seq, timeMs, operatorId, workerId,
  msgType, source, title, message)`; `consoleUri(wid, eid, warehouse)`; `create`; `append(uri,
  rows)` (file `console_<first seq>_<8 hex>`); `read(uri, operatorId: Option[String], afterSeq:
  Long, limit: Int): (Seq[ConsoleRow], Boolean)`: the scan is filtered with `seq > afterSeq` and,
  when given, `operatorId = …` (so whole files are skipped by their column bounds), rows are
  filtered again in memory, sorted by `seq` with one row kept per `seq`, cut at `limit`, and the
  flag says whether more remain; `tidy`; `drop`.

**Behaviour.** Records are built against the Iceberg schema directly (`GenericRecord`), never
through `Tuple`. Both stores load their table through `DocumentFactory.icebergTableOf`: a table
that is not there reads as empty, a catalog or store that cannot answer is thrown (§3.8).

**Tests.** New `RuntimeStatisticsStoreSpec` and `ConsoleMessageStoreSpec` (JDBC catalog): a round
trip of every column; three appends read back in order; a projected read returns the asked columns;
a tidy between a reader's plan and its read (a test seam that runs before the files are opened, as
`ExecutionPlanStore.claimStart(uri, beforeCommit)` has) still returns every row; console: one
operator's rows only, `afterSeq`, `limit` with the flag, a message of 100,000 characters intact,
the same rows appended twice read back once; a missing table reads empty; a catalog that throws
makes `read` throw; a statistics table made with today's schema (`ResultSchema.runtimeStatisticsSchema`,
`time TIMESTAMP`) and holding rows reads as empty, with every column asked and with three; an
execution-wide console URI decodes and resolves to namespace `operator-console-messages`, table
`wid_12_eid_345_consolemessages`.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.RuntimeStatisticsStoreSpec org.apache.texera.amber.core.storage.ConsoleMessageStoreSpec org.apache.texera.amber.core.storage.VFSURIFactorySpec"`.

**Done when.** The specs pass; no production code calls the stores.

### Brief 5. `feat(amber): write an execution's log from the unit`

**Goal.** Every run on a unit has an execution log: one row per state change with its why, one per
stored output port, the label, and a beat. Every state change goes through one method, and a run
ends once. The unit finds the results of the run it holds in the recorder's memory. Postgres is
still written as before.

**Depends on.** 3.

**Files.**
- New `amber/src/main/scala/org/apache/texera/amber/engine/common/executionrecord/ExecutionRecorder.scala`:
  the trait of §3.8; `ExecutionRecorder.start(context)` returns the lake implementation (§4.1,
  steps 1–3 and 5–6, with the log table only; a tick is the beat; statistics and console are
  accepted and ignored until sub-part 6, which also makes their tables at the start);
  `ExecutionRecorder.none`, a new recorder on every call that remembers outputs and writes
  nothing. The implementation takes its clock, its scheduler (None: a caller drives `tick()`, for
  specs and the benchmark), its tidy numbers and its store calls as constructor parameters. A tick
  catches everything (§4.1 step 4). It imports nothing from `org.apache.texera.web` or
  `org.apache.texera.dao`.
- `amber/src/main/scala/org/apache/texera/web/storage/ExecutionStateStore.scala`: the class takes
  `val recorder: ExecutionRecorder = ExecutionRecorder.none` and gains
  `transitionTo(state: WorkflowAggregatedState, errors: Seq[WorkflowFatalError] = Nil, reason:
  Option[String] = None, clearErrors: Boolean = false): Unit` (§4.1). Until sub-part 17 it also
  calls `ExecutionsMetadataPersistService.updateStatus` as `updateWorkflowState` does today
  (`:43-47`). The companion's `updateWorkflowState` is removed.
- The 13 call sites, each becoming one `transitionTo`:

  | Site | Call |
  |---|---|
  | `WorkflowExecutionService.scala:644` | `transitionTo(READY, clearErrors = true)` |
  | `WorkflowExecutionService.scala:662` | `transitionTo(resp.workflowState)` (the "already ended" check moves into `transitionTo`) |
  | `ExecutionRuntimeService.scala:67` | `transitionTo(evt.state)` |
  | `ExecutionRuntimeService.scala:81`, `:90`, `:96` | `transitionTo(PAUSING)`, `(RESUMING)`, `(RUNNING)` |
  | `ExecutionRuntimeService.scala:106` | `transitionTo(KILLED, reason = Some("killed by the user"))` |
  | `ExecutionStatsService.scala:308` | `transitionTo(FAILED, errors = Seq(error))` |
  | `WorkflowService.scala:523` | `transitionTo(FAILED, errors = fatalErrorsOf(t, operatorId, workerId))` |
  | `WorkflowService.scala:278` (`supersedeCurrentRun`, which now takes the new execution's id) | `transitionTo(KILLED, reason = Some(s"replaced by execution $newEid"))` |
  | `SyncExecutionResource.scala:438`, `:497` | `killExecution(service, as, reason)`: shut the client down, stamp the end time, one `transitionTo`. Timeout and console error: `KILLED`, "stopped by its caller". Targets done: `COMPLETED`, "stopped once its target operators finished" |
  | `ClusterListener.scala:90` | `transitionTo(FAILED, errors = Seq(error))` |

- `WorkflowService.scala:451` (`startClaimedRun`): `new ExecutionStateStore(ExecutionRecorder.start(context))`.
- `WorkflowService.scala:245-251` (`cleanUpAfterIdle`): before `unsubscribeAll()`, for a held run
  that has not ended: `transitionTo(KILLED, reason = Some("stopped: nobody watched it for 30 s"))`.
- `ExecutionResultService.scala:338-342`: the `OperatorPortResultUriAvailable` callback also calls
  `stateStore.recorder.output(evt.globalPortId, evt.uri, evt.mode)`; the Postgres insert stays
  until sub-part 17, for the Dashboard's readers of the registry.
- `ExecutionResultService.scala`: `attachToExecution` keeps the run's recorder, and what the unit
  looks up for the run it holds comes from it: `recorder.resultUri(opId, port)` at `:175` (the
  companion's `convertWebResultUpdate` takes the lookup as a parameter), `:377-382` and, for an
  attached run, `:421-425`; `recorder.outputs` in the poll at `:475-476`. The fallback of
  `handleResultPagination` for a service with no run attached (`:414-419`, the newest execution
  in Postgres) stays until sub-part 17.
- `SyncExecutionResource.scala:655`: `recorder.resultUri` of the run it started.
- `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala`: the e2e specs run an
  `AmberClient` with no web layer. `registerResultUriPersistence` (`:284-286`) feeds an
  `ExecutionRecorder.none` it returns, and `readMaterializedResults` (`:199-216`) reads that
  recorder's `resultUri` instead of `ExecutionResultUris` (`:76`, `:205`). The specs keep
  `MockTexeraDB` where they need it for something else.
- `ComputingUnitMaster.scala`: `environment.lifecycle().manage(…)` of a `Managed` whose `stop()`
  is §4.1 step 7, over `WorkflowService.getAllWorkflowServices`. Not a raw JVM shutdown hook: the
  server's own stop runs it, in order, and a spec can call it.

**Why the lookups move here and not in sub-part 17.** Sub-part 14 re-bases `ExecutionResultUris`
on the log. Left on it until 17, the unit would read its own log from the lake on every 3 s poll,
behind a Postgres SELECT, and could ask for a port before the recorder's commit of its `output`
row had landed; and the e2e specs, which write no log, would find no result at all.

**Behaviour.** §4.1. PAUSING and RESUMING reach the state store and the socket, not the log.
`TERMINATED`, which the unit treats as an ending (`WorkflowService.scala:186-187`) and the engine
does not report for a workflow today, is logged as KILLED, so no ending the unit knows of can be
missing from the log. The old path of step 2 (`WorkflowService.initExecutionService`) needs
nothing: step 2's sub-part 14 has removed it (`258d6ae54`), so `startClaimedRun` is the only
place a run's state store is made.

**Tests.**
- New `amber/src/test/scala/org/apache/texera/amber/engine/common/executionrecord/ExecutionRecorderSpec.scala`
  (JDBC catalog, manual clock and ticks): READY, RUNNING, PAUSED, RUNNING, COMPLETED give five
  `state` rows with seq 1–5 and the label after each; RUNNING reported twice is one row; after
  COMPLETED a KILLED is not written; an output is one row and is in `outputs` at once; told twice,
  once; every tick moves `beat-ms` and adds no snapshot; an append that fails (a store seam that
  throws once) is written by the next tick, in order; a tick in which a store seam throws an
  error no step expects (a plain `RuntimeException`) returns normally, and the tick after it
  beats (run through a real scheduler once, to show the timer survives); nothing
  blocks the caller while the store is slow (a seam that waits); an ending tidies the log to one
  file; `awaitIdle` returns true once everything is written and false on a timeout; a log table
  dropped under the recorder is not made again, and the recorder stops; a log table the store
  cannot reach (the seam throws) is not taken for a dropped one, and the recorder goes on; two
  `none` recorders do not see each other's outputs.
- `ExecutionStateStoreSpec`: `transitionTo` stores the state and errors, calls the recorder for the
  six logged states only, drops a change after an ending, and still issues one status UPDATE.
- `ExecutionRuntimeServiceSpec`, `ExecutionStatsServiceSpec`, `WorkflowExecutionServiceSpec`,
  `ClusterListenerSpec`: their state assertions, through `transitionTo`.
- `WorkflowServiceSpec`: a superseded run is KILLED with "replaced by execution N"; the idle
  clean-up of a paused run records KILLED with its reason, of a finished run nothing.
- `SyncExecutionResourceSpec`: "targets done" records one COMPLETED and no KILLED; a timeout KILLED;
  an operator's result is read through the recorder with the registry row deleted.
- `ExecutionResultServiceSpec`: a page and a result update of the attached run are answered from
  the recorder with no row in `operator_port_executions`; a port the recorder was told of a moment
  ago is found at once.
- `ComputingUnitMasterSpec`: the managed object's `stop()` ends a live run FAILED, "the computing
  unit was stopped", and leaves a finished run as it ended.
- The e2e specs pass with `TestUtils` reading results through the recorder.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.amber.engine.common.executionrecord.ExecutionRecorderSpec org.apache.texera.web.storage.ExecutionStateStoreSpec org.apache.texera.web.service.ExecutionRuntimeServiceSpec org.apache.texera.web.service.ExecutionStatsServiceSpec org.apache.texera.web.service.WorkflowExecutionServiceSpec org.apache.texera.web.service.WorkflowServiceSpec org.apache.texera.web.service.ExecutionResultServiceSpec org.apache.texera.web.resource.SyncExecutionResourceSpec org.apache.texera.amber.clustering.ClusterListenerSpec org.apache.texera.web.ComputingUnitMasterSpec"`,
then the amber unit suite and, for `TestUtils`, the integration suite
(`UDF_PYTHON_PATH=… AMBER_TEST_FILTER=integration-only sbt "WorkflowExecutionService/test"`).

**Done when.** The specs pass; `git grep -n "updateWorkflowState" amber/src/main` finds nothing;
`git grep -n "ExecutionResultUris" amber/src/main/scala/org/apache/texera/web/service/ExecutionResultService.scala amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala amber/src/test/scala/org/apache/texera/amber/engine/e2e`
finds only the pagination fallback; on the harness, scenario d's log table holds RUNNING, PAUSED,
RUNNING, KILLED (Check I).

### Brief 6. `feat(amber): commit statistics and console on a timer`

**Goal.** Statistics and console output go through the recorder: stored every 30 s, at every state
change and at the end, in the tables of sub-part 4, tidied during the run and at the end. Their
readers move with them.

**Depends on.** 4, 5.

**Files.**
- `ExecutionRecorder.scala`: `statistics`, `console`, the whole tick and the tidies (§4.1 step 4,
  §4.2): the beat first, then statistics, console and the tidy of a table that reached 50 appends.
  The first task now also makes the statistics and the console table, each replacing a table of
  that name left by an earlier database (§4.1 step 1). `statistics(metrics)` merges into the newest
  snapshot (an operator missing from a later snapshot keeps its last numbers, as
  `computeStatsDiff` did, `ExecutionStatsService.scala:220-238`). A stored row is built as
  `storeRuntimeStatistics` builds it (`:246-261`), with the tick's time, for each operator whose
  row differs from its last stored one in any column but the time (D10). `console` assigns `seq`,
  builds the row from the full message (operator = the logical operator the caller gives) and
  applies the 50,000-row cap.
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionStatsService.scala`: the writer and
  its thread (`:77-91`), the close on a terminal state (`:205-218`), `computeStatsDiff` and
  `storeRuntimeStatistics` (`:220-267`) go; the `RuntimeStatisticsPersist` callback (`:194-202`)
  becomes `stateStore.recorder.statistics(evt.operatorMetrics)`. `updateRuntimeStatsUri` is still
  called once, with `RuntimeStatisticsStore.statisticsUri(…)`, until sub-part 17.
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionConsoleService.scala`: the writers
  and their thread (`:138-166`), both closes (`:207-247`) and the write in `addConsoleMessage`
  (`:291-304`) go; `addConsoleMessage` calls `stateStore.recorder.console(opId, consoleMessage)`.
  When it is constructed it registers the execution's one console table, as
  `insertOperatorExecutions(eid, "*", consoleUri)`, until sub-part 17, so the clean-up paths that
  read the registry still find it.
- `ExecutionResultService.scala:389`: the `updateConsoleMessageSize` call goes (console bytes are
  not counted until `stored_bytes`, sub-part 12).
- `ResultSchema.scala`: `runtimeStatisticsSchema` and `consoleMessagesSchema` go (the stores own
  theirs); `VFSURIFactory.createConsoleMessagesURI` with an operator goes.
- `computing-unit-managing-service/…/resource/ComputingUnitManagingResource.scala:351-353`:
  `optionalComputingUnitEnvNames` gains `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS` (a constant in
  `EnvironmentalVariable`), so a Kubernetes unit gets the interval when the manager has one; its
  spec gains the case.
- Readers: `WorkflowExecutionsResource.retrieveWorkflowRuntimeStatistics` (`:678-735`) reads
  `RuntimeStatisticsStore.read(uri)`, with `timestamp = new Timestamp(timeMs)`;
  `CostHintsLoader.openStatistics` (`:231-232`) reads `RuntimeStatisticsStore.read(uri, Set("operatorId",
  "dataProcessingTime", "controlProcessingTime"))`; `SyncExecutionResource.collectConsoleLogs` and
  `getConsoleMessageUri` (`:894-949`) become `recorder.awaitIdle(5.seconds)` then
  `ConsoleMessageStore.read(consoleUri of the run, Some(opId), 0, 5000)`, with the in-memory
  fallback as today.

**Behaviour.** Rows per commit ≤ operators. Console output and statistics of an execution made
before this sub-part are not readable afterwards (no backward compatibility): its console tables
are per operator, at other locations, and its statistics table, which is at the location the new
store reads, has the old schema and reads as empty (sub-part 4).

**Tests.**
- `ExecutionRecorderSpec`: three snapshots between two ticks store one row per operator whose
  numbers changed, with the tick's time, and none for an operator that did not change; an operator
  whose state alone changed is stored; an operator absent from a snapshot keeps its numbers; a
  state change stores the sample and the console buffer right after its row; 4,096 buffered
  console rows are stored without waiting for the tick; past 50,000 the oldest are dropped and one
  row says how many; after the recorder's number of appends (50; the spec gives it a smaller one)
  a table is tidied (data files drop to one, rows and order kept), and beats do not count towards
  it; the ending leaves one data file and one snapshot in each table that was written to; a tick
  whose statistics or console append throws has moved `beat-ms` before it; a console table with
  rows, left under the execution's name, is empty once the recorder has started.
- `ExecutionStatsServiceSpec`, `ExecutionConsoleServiceSpec`: events reach the recorder; nothing is
  written on the caller's thread; the live events are unchanged.
- `WorkflowExecutionsResourceSpec`: the statistics route returns the stored rows with millisecond
  timestamps, and an empty list for an execution whose statistics table has the old schema.
  `CostHintsLoaderSpec`: the costs of a run stored by the new store; no hints and no error from a
  run whose table has the old schema.
  `SyncExecutionResourceSpec`: an operator's console lines, another operator's left out.
- Delete `amber/src/test/integration/…/IcebergDocumentConsoleMessagesSpec.scala` (its cases are
  `ConsoleMessageStoreSpec`'s).

**Run.** As brief 5, plus `org.apache.texera.web.service.ExecutionConsoleServiceSpec org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResourceSpec org.apache.texera.web.service.execution.CostHintsLoaderSpec`.

**Done when.** The specs pass; on the harness with `--fast-record`, scenario p reads statistics
rows and console lines while the run is still going, and Check I holds after it.

### Brief 7. `test(amber): benchmark a day of an execution's record`

**Goal.** A repeatable measurement that a day-long run's record reads back fast, through the real
recorder and stores (§7 H7, layer 1).

**Depends on.** 6.

**Files.**
- New `amber/src/test/scala/org/apache/texera/amber/engine/common/executionrecord/ExecutionRecordBench.scala`:
  an `object` with `main` (neither ScalaTest nor JUnit runs it), modelled on the step 0 proof's
  `IcebergCommitBench`. Options `--ticks 2880 --operators 10 --console-per-tick 1
  --state-changes 49 --out <dir>`, `--quick` (120 ticks). It builds a recorder with a simulated
  clock and no scheduler, and per tick: new numbers for every operator, the console lines,
  `tick()`; a pause and resume every hour of simulated time. Every 250 ticks, right before each
  tidy, and after the end it times, three times each, `ExecutionLogStore.label`,
  `ExecutionLogStore.read`, `RuntimeStatisticsStore.read` (all columns and three),
  `ConsoleMessageStore.read(…, limit = 1000)`, and records each commit's latency. It writes
  `checkpoints.csv`, `ticks.csv` and `checks.txt` (one `PASS`/`FAIL` line per check of §7 H7).
- Harness: `bench/record-bench.sh` and `bench/stack.sh` (§7 H7).

**Tests.** `--quick` runs in CI's amber job? No: it needs a REST catalog. It is run by hand and by
the harness.

**Run.** `bench/record-bench.sh <worktree>` (about 15 minutes), `--quick` (about 2).

**Done when.** All eight checks pass in two runs on a quiet machine; the commit message carries
the numbers of one run (label p95, statistics read at the end and worst before a tidy, commit p50
first and last window).

### Brief 9. `feat(dao): record how an execution ended`

**Goal.** The execution's row can hold a closing record. Nothing reads or writes it yet.

**Depends on.** Nothing.

**Files.**
- `sql/texera_ddl.sql:318-343`: add `outcome SMALLINT`, `outcome_reason TEXT`, `ended_at TIMESTAMP`,
  `stored_bytes BIGINT`, `results_expired_at TIMESTAMP`, `notification TEXT` and the two partial
  indexes (§3.4). The five columns that go stay until sub-part 18.
- New `sql/updates/53.sql` (the next free number after a rebase), in the form of `52.sql`
  (schema-qualified names, `IF NOT EXISTS`, one transaction): the columns, the indexes, and the
  backfill of §3.4.
- `sql/changelog.xml`: changeSet 53.
- The regenerated jOOQ classes of `workflow_executions`.

**Tests.** `DAO/compile` generates the six fields. By hand, once: a database made from the DDL
before this sub-part, with one row at each status 0–5 and -1; apply `53.sql`; rows 3, 4 and 5 have
`outcome` = their status and no reason, the others outcome 4 and "closed when Texera was upgraded";
every row has `ended_at` and `results_expired_at`. The amber suite passes unchanged.

**Run.** Apply the DDL, `sbt DAO/compile`, then `AMBER_TEST_FILTER=skip-integration sbt WorkflowExecutionService/test`.

**Done when.** The suite passes and `git status` shows the regenerated classes committed.

### Brief 11. `feat(amber): close executions at the Dashboard service`

**Goal.** A timer job in the Dashboard service writes each execution's closing record once: from
the log's ending, or "unit lost", or "never started". A create that fails closes its own row. Two
routes answer an execution's state and its log. Lists still read `status`.

**Depends on.** 5, 9.

**Files.**
- `common/config/src/main/resources/application.conf`, `ApplicationConfig`: the three
  `execution-closing.*` keys (§3.7).
- New `amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionRecords.scala` (the
  row): `OpenExecution(eid, wid, uid, cuid, warehouse, warehouseMissing, startingTime,
  notification, unitTerminatedAt, unitTerminationReason)`; `open(): Seq[OpenExecution]` (one
  SELECT, §4.3 step 1); `close(eid, outcome, reason, endedAt, neverStarted = false): Boolean` (the
  conditional UPDATE, true when it changed a row; with `neverStarted` it also sets
  `results_expired_at`, §4.3 step 3); `setStoredBytes(eid, bytes)`; `tablesOf(eid)`: the plan, log,
  statistics and console URIs from the row's workflow and warehouse (as `planUrisOf` does,
  `ExecutionResources.scala:125-156`).
- New `…/execution/ExecutionClosing.scala`: the decision, with no I/O: given an open execution,
  what was read (label or none, whether the plan is started, whether the read failed), the watch
  state and the settings, one of `Wait`, `CloseEnded(outcome, reason, endedAt)`, `ClaimThenClose`,
  `CheckRowsThenLose(reason)`, `CloseUnavailable`; and the watch update (§4.3 step 2).
- New `…/execution/ExecutionCloser.scala`: what closing does, for the job and (from sub-part 12)
  for create: `close(open, outcome, reason, endedAt): Boolean` (the conditional UPDATE with
  `ended_at` kept between `starting_time` and the Dashboard's now; when it changed a row, the size
  sum and one log line; from sub-part 13 the email) and `closeIfEnded(open): Boolean` (read the
  label; close when it shows an ending). Its lake calls (`ExecutionLogStore.label`, `.read`,
  `ExecutionPlanStore.isStarted`, `.claimStart`, the size sum) and its clock are constructor
  parameters. A lake call that throws is never turned into an answer here: it reaches the job,
  which logs it and leaves the execution for its next tick.
- New `…/execution/ExecutionClosingJob.scala`: a `Managed` job with its own daemon scheduler,
  modelled on `IdleComputingUnitCleanupJob`; a tick is §4.3 steps 1–3, deciding with
  `ExecutionClosing` and acting through `ExecutionCloser`. The watch map lives in the job and
  forgets executions that are no longer open.
- `amber/src/main/scala/org/apache/texera/web/TexeraWebApplication.scala`: `environment.lifecycle().manage(new
  ExecutionClosingJob(…))` after the resources are registered.
- `ExecutionCreator.scala:233`, `:287`: beside `markFailed`, `ExecutionRecords.close(eid, 4,
  "compile error: <the first operator error's message, cut to 500>", now, neverStarted = true)`
  and, for a plan that could not be written, "its plan could not be stored".
- `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/ExecutionResource.scala`:
  `GET /{eid}/state` and `GET /{eid}/log` (§3.5). Both ask `ExecutionRecords.mayRead(uid, eid)`:
  the caller created the execution, or `WorkflowAccess.hasGrantedAccess(wid, uid)`; otherwise, and
  for an eid with no row, 403.
- `amber/src/main/scala/org/apache/texera/web/model/websocket/event/WorkflowStateEvent.scala`:
  `WorkflowStateEvent(state: String, executionId: Option[Long])`, filled from the metadata store by
  `WorkflowExecutionService.createStateEvent` (`:399-405`). Step 2's sub-part 14 has done this
  (`258d6ae54`); nothing is left of it here but to check it is there.

**Behaviour.** §4.3, without the email (sub-part 13) and the expiry pass (sub-part 14).
`stored_bytes` is the sum of `total-files-size` over the plan, log, statistics and console tables
and each output's result and state table; a table that is missing counts 0.

**Tests.**
- New `ExecutionClosingSpec`: every branch of the decision; the watch count rises only on a read
  that succeeded with the same beat, restarts on a new beat, and the threshold is
  `max(lost-after, 4 × beat-every) / interval`, rounded up.
- New `ExecutionClosingJobSpec` (`MockTexeraDB`, JDBC catalog; executions made by
  `ExecutionCreator`, logs written with `ExecutionLogStore`): an ended log closes with its state,
  reason and time; a terminated unit closes "unit lost" (or "unit terminated" for
  `USER_REQUESTED`) on the first tick; a beat that stays still closes "unit lost" after the
  threshold and not one tick sooner; a beat that moves never closes; an ending found in the rows
  while the label still says RUNNING (rows appended through a seam that skips the label) closes
  with that ending; a lake read that throws leaves the execution open and does not count, whatever
  threw (the label, the plan's tag, the rows) and however old the execution is: a catalog that
  throws for ten ticks closes nothing as "never started" or "unit lost"; never started: claimed
  and closed after the limit, not before, and marked expired; a start that wins the claim leaves
  it open; no plan table at all closes "never started"; a per-user warehouse while disabled closes
  "its warehouse is no longer available"; a label whose `state-time-ms` or `beat-ms` lies an hour
  ahead closes with `ended_at` = now, one that lies before `starting_time` with `starting_time`;
  two jobs on one database close once; `stored_bytes` is set.
- `ExecutionResourceSpec`: a compile error leaves a closed row with the reason; `state` for a
  closed row, an open one with a log, one without, an unreadable lake (-1); `log` with its
  `closing`; 403 for a user who only sees the workflow because it is public, and for an eid that
  does not exist; 200 for the creator and for a user the workflow was granted to.
- `TexeraWebApplicationSpec`: the job is managed; the routes resolve beside the existing ones.
  `TexeraWebSocketEventSpec`: the event with and without an id.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres AMBER_TEST_FILTER=skip-integration sbt "WorkflowExecutionService/testOnly org.apache.texera.web.service.execution.ExecutionClosingSpec org.apache.texera.web.service.execution.ExecutionClosingJobSpec org.apache.texera.web.resource.dashboard.user.workflow.ExecutionResourceSpec org.apache.texera.web.TexeraWebApplicationSpec org.apache.texera.web.model.websocket.event.TexeraWebSocketEventSpec"`.

**Done when.** The specs pass; on the harness, q's `/state` says `open: false`, status 4, "unit
lost" (the history still shows status 1 until sub-part 12), and r's row is closed.

### Brief 12. `feat(amber): read an execution's status from its record`

**Goal.** Everything that read `status`, `last_update_time` and the size columns reads the closing
record, and the label for an open execution. After this sub-part nothing reads the columns that go.

**Depends on.** 11.

**Files.**
- New `amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionStatus.scala`:
  `statusOf(outcome, label read)` (D21) and `openStatuses(rows)`: the labels of the open rows of a
  list, at most 8 at a time, 2 s each, -1 on a failure.
- `WorkflowExecutionsResource.scala`: `WorkflowExecutionEntry` (`:506-520`) loses `result` and gains
  `reason` (null unless `ExecutionRecords.mayRead` holds for the caller); `getWorkflowExecutions`
  (`:314-353`) and `retrieveLatestExecutionEntry` (`:555-600`)
  select `outcome`, `outcome_reason`, `ended_at` and fill `status` through `ExecutionStatus`, and
  `completionTime` as D21: `ended_at` for a closed row; for an open one the label's
  `state-time-ms`, not before `starting_time`; `starting_time` when there is no label or it
  cannot be read. It is never null (it stands where `last_update_time` stood, `:338`); the
  `status` filter (`:321-325`, `:657-671`) is `outcome IN (…)` for 3, 4, 5 and, for 0, 1, 2,
  `ended_at IS NULL` followed by a filter on the computed status.
- `AdminExecutionResource.scala:83-87`, `:119-214`: `end_time` sorts by `ended_at`; the filter and
  `executionStatus` as above; the duration is `ended_at − starting_time`, or up to now while open.
- `UserQuotaResource.scala:58-65`, `:108-165`: one query; `QuotaStorage(eid, workflowId,
  workflowName, storedBytes)`.
- `OperatorUpdates.scala:156`, `:242`: an execution with `ended_at` is 409 "execution <eid> has
  ended".
- `CostHintsLoader.scala:123-147`: the newest execution of the workflow by the user with
  `outcome = 3`, its statistics at `RuntimeStatisticsStore.statisticsUri(wid, eid, warehouse)` from
  the row; no `runtime_stats_uri`.
- `ExecutionResources.scala:63-64`, `:281-321`: `EndedStatuses` goes; `finishedExecutionsWithResults`
  selects `ended_at IS NOT NULL`. `ExecutionCreator.scala:270`: before `clearFinishedExecutions`,
  `ExecutionCloser.closeIfEnded` for each open execution of the workflow on the unit with a smaller
  eid, so a run that ended seconds ago is still replaced (§4.4).
- `computing-unit-managing-service/…/resource/ComputingUnitManagingResource.scala`:
  `TerminalWorkflowExecutionStatus` (`:123-130`) goes; `:188-191` become `max(ended_at)`,
  `max(starting_time)` and `bool_or(ended_at IS NULL)`; `liveExecutionExists` (`:247-260`) becomes
  `ended_at IS NULL OR starting_time >= cutoff OR ended_at >= cutoff`.
- Frontend types, so the app compiles and the quota page adds up:
  `frontend/src/app/dashboard/type/workflow-executions-entry.ts` (`reason: string | null`; no
  `result`), `frontend/src/app/common/type/user.ts:84-86` and
  `frontend/src/app/dashboard/component/user/user-quota/user-quota.component.{ts,html}`
  (`storedBytes`).

**Tests.** `WorkflowExecutionsResourceSpec`: a closed row from the record; open rows READY, RUNNING,
PAUSED from their labels; no log 0; an unreadable lake -1; each status filter, the one the editor's
lock sends (Initializing and Running) included; `completionTime` is `ended_at` for a closed row,
the label's state time for an open one and `starting_time` for an open one without a label, and
is null for none. `AdminExecutionResourceSpec`:
the filter, the sort, the duration. `UserQuotaResourceSpec`. `OperatorUpdatesSpec`: 409 on
`ended_at`, whatever `status` says. `CostHintsLoaderSpec`: picks by `outcome`; the derived location.
`ExecutionResourcesSpec`. `ExecutionResourceSpec`: create closes an earlier execution whose label
shows an ending while its row is still open, and then clears its results; one whose label says
RUNNING is left open and untouched. `ComputingUnitIdleCleanupSpec` (the sweep's own spec, which
builds its rows with `status` and `last_update_time` today) and `ComputingUnitManagingResourceSpec`:
an open row keeps its unit off the sweep; a unit whose rows are all closed before the cutoff is
swept; one closed after it is not.
Frontend: `user-quota.component.spec.ts`, `workflow-execution-history.component.spec.ts`.

**Run.** The amber specs named, `sbt "ComputingUnitManagingService/testOnly org.apache.texera.service.resource.ComputingUnitIdleCleanupSpec org.apache.texera.service.resource.ComputingUnitManagingResourceSpec"`,
and the two frontend specs.

**Done when.** The specs pass; `git grep -n "WORKFLOW_EXECUTIONS.STATUS\|LAST_UPDATE_TIME\|RUNTIME_STATS_SIZE\|RESULT_SIZE\|CONSOLE_MESSAGES_SIZE"`
shows only writers (the unit's status write, the size updates sub-part 17 removes) and generated
code; on the harness q's history entry reads 4, "unit lost".

### Brief 13. `feat(amber): email a run's owner when it is closed`

**Goal.** One email per execution that asked for one, sent by the Dashboard when it closes the
execution. The unit sends none, and the address leaves the lake.

**Depends on.** 11.

**Files.**
- `ExecutionCreator.scala:246-259`, `:433-441`: the notification JSON goes into the row
  (`ExecutionsMetadataPersistService.insertCreatedExecution` takes it), not the plan row.
- `common/workflow-core/…/storage/ExecutionPlanStore.scala` (`PlanRecord`, `:55-112`) and
  `ResultSchema.executionPlanSchema`: the `notification` column goes.
- `WorkflowExecutionService.scala:600-608`, `:624-632`: no notification is read or handed on.
  `ExecutionRuntimeService.scala:51-57`, `:70`, `:124-127`: the email service goes.
- `amber/src/main/scala/org/apache/texera/web/service/WorkflowEmailNotifier.scala`: `Notification`
  and `workflowUrl` stay; the class becomes `send(notification, workflowId, outcome, reason,
  endedAt): Unit`, with the subject "[Texera] Workflow <name> (<wid>): <Completed|Failed|Killed>"
  and the reason on its own line. `EmailNotificationService.scala` goes.
- `ExecutionClosingJob.scala`: after a close that changed a row whose `notification` is set, hand
  `send` to a single daemon thread; a failure is logged.

**Behaviour.** D30. An execution closed at create (a compile error) sends no email: the user is
looking at the error. Neither does one closed as never started: nothing ran.

**Tests.** `ExecutionClosingJobSpec`: one email per closed execution with a notification, with its
outcome and reason; none without; none for "never started"; two jobs, one email; a send that
throws leaves the row closed.
`ExecutionResourceSpec`: the row holds the notification; the plan row has no such column.
`ExecutionPlanStoreSpec`, `PhysicalPlanCodecSpec` fixtures without the column.
`WorkflowEmailNotifierSpec` rewritten for `send`. `ExecutionRuntimeServiceSpec`: no email on any
state.

**Run.** The specs named; `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.storage.ExecutionPlanStoreSpec"`.

**Done when.** The specs pass and `git grep -n "EmailNotificationService\|processEmailNotificationIfNeeded"` finds nothing.

### Brief 14. `feat(amber): expire results at the Dashboard service`

**Goal.** One expiry, at the Dashboard, that finds an execution's tables through its log. The unit
deletes nothing.

**Depends on.** 5, 12.

**Files.**
- `common/workflow-core/…/storage/ExecutionResultUris.scala`: the two functions keep their
  signatures; each finds the execution's workflow and warehouse in its row (one SELECT, as
  `planUrisOf`) and reads `ExecutionLogStore.outputs`. `getResultUriByLogicalPortId` keeps its rule
  (an external port of that logical operator and port id). Its callers by now are the Dashboard's
  (delete, export, this sub-part's expiry), the result service if it is in the tree, and on the
  unit only the pagination fallback for a service that holds no run, which sub-part 17 removes;
  the unit's lookups for the run it holds and the e2e specs left it in sub-part 5.
- New `amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionExpiry.scala`:
  `expire(eid, withReplayLog = false)`, `dropAll(eid)`, `expireReplaced(wid, cuid, replacedBy)`
  (§4.4), with the search by table name for an execution that has no log table, and in `dropAll`
  always. Tables in a per-user warehouse are left alone while those are disabled
  (`WarehouseReadGuard.skipWhileDisabled`), and such an execution is not marked expired.
- `ExecutionClosingJob.scala`: the expiry pass (§4.3 step 4), at most once per
  `result-cleanup.collection-check-interval-in-seconds`, with `withReplayLog = true`: it deletes
  the replay log at `log_location` and clears the column, which the unit's TTL job did
  (`ComputingUnitMaster.scala:241-256`).
- `ExecutionCreator.scala:270`: `ExecutionExpiry.expireReplaced` in place of
  `clearFinishedExecutions`, after sub-part 12's `closeIfEnded` step (§4.4).
  `ExecutionResources.clearExecutionResources` and `clearFinishedExecutions` (`:192-321`) go.
- `WorkflowExecutionsResource.removeAllExecutionFiles` (`:373-406`), `WorkflowResource.deleteWorkflow`
  (`:629-690`) and `UserQuotaResource.deleteExecutionCollection`: `ExecutionExpiry.dropAll` for each
  execution, before its row is deleted. The two execution-delete routes answer 409 for an open
  execution and delete nothing. Deleting a workflow drops the tables of all its executions, open
  ones included: a unit still running one finds its tables gone, its run fails, and its recorder
  stops (§4.1 step 5).
- Unit: `WorkflowService.cleanUpAfterIdle` (`:245-251`) clears no storage;
  `ComputingUnitMaster.scala:182-204`, `:241-308`: the clean-all-at-boot and the TTL job go, with
  `getExpiredExecutionsWithResultOrLog` (`WorkflowExecutionsResource.scala:98-115`),
  `ApplicationConfig.cleanupAllExecutionResults` and its key. `OnIceberg.expireSnapshots` goes.
- If `result-service/` is in the tree: `ResultResource.storedResults` reads
  `ExecutionLogStore.outputs` (through `ExecutionResultUris`' lookup of the log), the row count is
  the result document's `getCount`, the mode is the output row's, and `getLatestExecution` selects
  `outcome IS NOT NULL` (§10).

**Tests.** New `ExecutionExpirySpec` (`MockTexeraDB`, JDBC catalog): after `expire`, the result,
state and console tables are gone and the plan, log and statistics tables are there, the row has
`results_expired_at` and a smaller `stored_bytes`; a second `expire` changes nothing; another
execution of the same workflow is untouched; with the log dropped beforehand, the tables are found
by their names, and execution 34's stay when 3 is expired that way; `dropAll` leaves no table,
also for an execution as one made before this step left it (no log; result and state tables,
console tables per operator and a statistics table in the old schema under its name), and also a
result table the log does not name; `expireReplaced` takes closed, unexpired, older executions of
the same workflow and unit only, and leaves a replay log where it is.
`ExecutionResultUrisSpec`: both lookups from a log.
`ExecutionClosingJobSpec`: the pass expires what is past the TTL and nothing younger, once; it
deletes the replay log of an execution that has one and clears `log_location`; it never looks for
the tables of an execution closed as never started.
`ExecutionResourceSpec`: create replaces a closed earlier execution, and one that sub-part 12's
step has just closed; it leaves one that is still running.
`WorkflowResourceSpec`, `WorkflowExecutionsResourceSpec`, `UserQuotaResourceSpec`: deletes drop
every table; deleting an open execution is 409 and drops nothing. `WorkflowServiceSpec`: the idle
clean-up leaves the tables. `ComputingUnitMasterSpec`: no clean-up is scheduled.

**Run.** The specs named.

**Done when.** The specs pass; `git grep -n "clearExecutionResources\|getExpiredExecutionsWithResultOrLog\|recurringCheckExpiredResults"`
finds nothing; harness t.

### Brief 15. `feat(frontend): show how a run ended`

**Goal.** The history and the admin list show why a run ended, and the workspace shows the outcome
of a run its unit no longer shows: because the unit stopped answering, or because it is back and
holds no run.

**Depends on.** 11, 12.

**Files.**
- `frontend/src/app/workspace/types/workflow-websocket.interface.ts`: `WorkflowStateEvent`'s
  `executionId?: number` (there since step 2's sub-part 14).
- `frontend/src/app/workspace/service/execute-workflow/execution-api.service.ts`: `getState(eid)`.
- `frontend/src/app/workspace/service/execute-workflow/execute-workflow.service.ts` (D37):
  - Since step 2's sub-part 14, `currentExecutionId` is the execution of the run the unit holds
    now: set from every state event, forgotten on one that names none. It stays that, for
    changes to a paused operator. Asking the Dashboard needs an execution that outlives such an
    event, so the page keeps a second one, `followedExecutionId`: set from the answer to the
    page's own create and whenever a state event names an execution (another one replaces it),
    and cleared only when the followed execution is closed or the page leaves the workflow.
  - A `WorkflowStateEvent` without an id (what every new socket is sent first, and all a unit
    that holds no run sends) does not change the state shown while the followed execution is in
    flight (Initializing, Running, Pausing, Paused, Resuming, Recovering). With no followed
    execution, or one that is not in flight, it is handled as today.
  - While the followed execution is in flight and the unit does not show it (the socket is not
    connected, or the last state event since it connected carried no id), ask `getState` every
    5 s, the first time 5 s after the unit stopped showing it, so a replay that names the
    execution arrives first. `open: true` → show the status it answers (as the history would);
    `open: false` → the state Completed, Failed (with `reason` as its error message) or Killed,
    and stop.
  - Stop asking when a state event names the followed execution (the unit's view is the truth
    again), when it is closed, when another execution takes its place, and when the page leaves
    the workflow (`resetExecutionAndWorkers`).
  - While the state shown was learned this way, pause, resume and kill are disabled: the unit
    would not know the run. Run is enabled whenever the socket is connected.
  - If the base has upstream's #8936, this replaces its reset to idle: reset only when there is
    no followed execution.
- `frontend/src/app/dashboard/component/user/user-workflow/ngbd-modal-workflow-executions/workflow-execution-history.component.{ts,html}`
  and `frontend/src/app/dashboard/component/admin/execution/admin-execution.component.{ts,html}`,
  `frontend/src/app/common/type/execution.ts`: the reason beside the status (a second line or a
  tooltip); -1 reads "Unknown".
- `frontend/src/app/dashboard/type/workflow-runtime-statistics.ts:28-31` and its users
  (`runtime-statistics-mapper.ts`, `workflow-runtime-statistics.component.ts`,
  `heatmap-stats-restore.service.ts`): the four fields take the names the server sends
  (`dataProcessingTime`, `controlProcessingTime`, `idleTime`, `numWorkers`). This mends a
  mismatch that exists today (the type says `totalDataProcessingTime`, `totalControlProcessingTime`,
  `totalIdleTime`, `numberOfWorkers`, which the server never sent); it does not depend on the rest
  of the step and can go upstream on its own.

**Tests.** `execute-workflow.service.spec.ts`: with the socket down during a run, `getState` is
polled; an open answer shows its status; a closed answer sets Failed with the reason and stops
the polling; a socket that comes back and names the execution stops it; a socket that comes back
with "Uninitialized" and no id leaves the shown state alone and the polling going until the
execution is closed; a state event naming another execution switches to that one; pause and kill
are disabled meanwhile and Run is not; no polling without a followed run, and none after the
page leaves the workflow. `workflow-execution-history.component.spec.ts`,
`admin-execution.component.spec.ts`: the reason is shown. The statistics specs with the server's
names.

**Run.** `npx ng test --watch=false --test-file <each spec>`.

**Done when.** The specs pass; in the browser on the harness stack (`driver/browser_smoke.py`),
killing the unit during a run turns the workspace to Failed, "unit lost", both with the unit left
down and with it started again right after the kill.

### Brief 16. `feat(amber, frontend): serve stored output by execution`

**Goal.** Statistics, console output and export are read by execution id from the Dashboard in
every mode. No request for stored output reaches a unit, and the unit serves none.

**Depends on.** 6, 14.

**Files.**
- `WorkflowExecutionsResource.retrieveWorkflowRuntimeStatistics` (`:678-735`): the statistics
  location comes from `ExecutionRecords.tablesOf(eid)` after checking that the execution is the
  workflow's; no `runtime_stats_uri`. An execution with no statistics table answers an empty list.
- `ExecutionResource.scala`: `GET /{eid}/console` (§3.5), under `ExecutionRecords.mayRead`, as the
  state and log routes.
- `amber/src/main/scala/org/apache/texera/web/model/http/request/result/ResultExportRequest.scala`:
  `executionId: Long` replaces `computingUnitId` (`:43`).
- `amber/src/main/scala/org/apache/texera/web/service/ResultExportService.scala`: built for
  `(workflowIdentity, executionId)`; the execution must be the workflow's;
  `getOperatorDocument` (`:481-500`) and the three `getLatestExecutionId` uses (`:172`, `:208`,
  `:253`) use the execution id; an execution with `results_expired_at` answers 410 "the results of
  execution <eid> have expired"; `saveToDatasets` (`:533-580`) sends the caller's own token, which
  the routes hand it (the `Authorization` header for the dataset route, the form's `token` for the
  local one), instead of signing one (`:557-558`).
- `WorkflowExecutionsResource.scala:852-910`: the two export routes pass the execution and the
  token.
- Frontend: `frontend/src/app/dashboard/service/user/download/download.service.ts:169-275`
  (`executionId` in the body; one URL in every mode);
  `frontend/src/app/workspace/service/workflow-result-export/workflow-result-export.service.ts`
  (the execution on screen: `ExecuteWorkflowService`'s current id, else the workflow's latest
  execution); `workflow-executions.service.ts:88-93` and its callers (no `cuid`).
- Kubernetes: `bin/k8s/templates/base/gateway/gateway-routes.yaml:186-191` (the two matches go);
  `access-control-service/…/AccessControlResource.scala:47-48`, `:84-86` (the two patterns go; the
  form-body token parsing goes if only export used it).
- Unit: `ComputingUnitMaster.scala:206`: `WorkflowExecutionsResource` is no longer registered.

**Tests.** `ResultExportServiceSpec`: an export by execution id; another workflow's execution is
refused; an expired one is 410; the upload carries the caller's token. `WorkflowExecutionsResourceSpec`:
statistics by execution, without the column. `ExecutionResourceSpec`: console (an operator,
`afterSeq`, `limit`, expired). `AccessControlResourceSpec`: the two paths are no longer authorized
as unit routes. `ComputingUnitMasterSpec`: `/api/executions/1/stats/1` is 404 on the unit.
Frontend: `download.service.spec.ts`, `workflow-result-export.service.spec.ts`,
`workflow-executions.service.spec.ts`, `heatmap-stats-restore.service.spec.ts`.

**Run.** The specs named; `sbt "AccessControlService/testOnly org.apache.texera.AccessControlResourceSpec"`.

**Done when.** The specs pass; harness v in single-node; in Kubernetes, Envoy's log shows the
statistics and export requests answered by the webserver.

### Brief 17. `feat(amber): run an execution without Postgres on the unit`

**Goal.** The unit opens no database pool and no code it runs asks for one. A spec runs an
execution end to end that way.

**Depends on.** 12, 13, 14, 16.

**Files.**
- `amber/src/main/scala/org/apache/texera/web/service/ExecutionResultService.scala`: its lookups
  for the run it holds have come from the recorder since sub-part 5. What is left goes:
  `persistOperatorPortResultUri` and `toOutputModeEnum` (`:92-118`), the registry callback's insert
  (`:340`), `updateRuntimeStatsSize` (`:388`) and `updateResultSizeAndCount` (`:497-504`); and
  `handleResultPagination` (`:414-419`) answers an empty page when no run is attached, instead of
  looking the newest execution up in Postgres.
- `ExecutionStatsService.scala:88` (`updateRuntimeStatsUri`) and the registry insert in
  `ExecutionConsoleService` go.
- `ExecutionStateStore.transitionTo`: no `updateStatus`.
- `ExecutionsMetadataPersistService.scala`: `updateStatus`, `markFailed`, `tryGetExistingExecution`,
  `tryUpdateExistingExecution` and `insertNewExecution` go; `insertCreatedExecution` no longer sets
  `status`. `ExecutionCreator.scala:233`, `:287`: `ExecutionRecords.close` only.
- `WorkflowExecutionService.getLatestExecutionId` (`:80-87`) and the companion functions of
  `WorkflowExecutionsResource` only the unit called (`getLatestExecutionID`, `insertOperatorExecutions`,
  `updateRuntimeStatsUri`, `getConsoleMessagesUriByExecutionId`, `getRuntimeStatsUriByExecutionId`,
  `deleteConsoleMessageAndExecutionResultUris`, `updateResultSizeAndCount`, both
  `updateRuntimeStatsSize`, both `updateConsoleMessageSize`; `:123-138`, `:265-312`, `:355-364`,
  `:416-506`) go.
- `common/dao/src/main/scala/org/apache/texera/dao/SqlServer.scala`: `withoutDatabase(reason:
  String)` closes any pool and makes `getInstance()` throw `IllegalStateException(reason)`;
  `initConnection` lifts it. Without either, `getInstance()` throws "SqlServer.initConnection was
  not called" instead of `None.get`.
- `ComputingUnitMaster.scala:145-150`: `SqlServer.withoutDatabase("a computing unit keeps nothing in
  Postgres")` in place of `initConnection`.
- `amber/src/test/scala/org/apache/texera/amber/engine/e2e/TestUtils.scala`: results have been
  found through a recorder since sub-part 5; what is left of its database set-up
  (`initiateTexeraDBForTestCases`, `setUpWorkflowExecutionData`, `cleanupWorkflowExecutionData`,
  `:413-580`) goes where no spec needs it for anything else.
- `.github/workflows/build.yml:719-735`: the smoke boot's comment, and its Postgres service if it
  has one only for this step.

**Behaviour.** After this sub-part the unit's remaining outside calls are the lake, the object
store, the package index, and in Kubernetes with the mounter on, access-control-service (step 5).

**Tests.**
- New `amber/src/test/scala/org/apache/texera/web/ComputingUnitWithoutDatabaseSpec.scala`:
  `SqlServer.withoutDatabase(…)`; a plan row written straight with `ExecutionPlanStore.writePlan`
  (a small workflow encoded as `SavedPlanSpec` encodes one); `WorkflowService.startChecked`; the run
  completes; a page of its result is read through `handleResultPagination`; a second run is paused,
  resumed and killed; a third fails in an operator. Each run's log has the expected rows.
  `SqlServer.getInstance()` still throws at the end. Mutation check, recorded in the commit
  message: with `updateStatus` put back, the spec fails.
- `ComputingUnitMasterSpec`: after `run()`, `SqlServer.getInstance()` throws the reason.
  `SqlServerSpec`: `withoutDatabase`, then `initConnection` works again.
- Every unit-side spec that asserted a Postgres write (`ExecutionResultServiceSpec`,
  `ExecutionStatsServiceSpec`, `ExecutionConsoleServiceSpec`, `ExecutionStateStoreSpec`,
  `ExecutionsMetadataPersistServiceSpec`, `SyncExecutionResourceSpec`, `WorkflowServiceSpec`, the
  e2e specs) loses that assertion and, where nothing else needs it, its `MockTexeraDB`.

**Run.** `STORAGE_ICEBERG_CATALOG_TYPE=postgres sbt "WorkflowExecutionService/testOnly org.apache.texera.web.ComputingUnitWithoutDatabaseSpec org.apache.texera.web.ComputingUnitMasterSpec"`,
`sbt "DAO/testOnly org.apache.texera.dao.SqlServerSpec"`, then the amber unit and integration suites.

**Done when.** The suites pass; `git grep -n "SqlServer" amber/src/main/scala/org/apache/texera/amber amber/src/main/scala/org/apache/texera/web/service/Execution*.scala amber/src/main/scala/org/apache/texera/web/service/Workflow*.scala amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala amber/src/main/scala/org/apache/texera/web/resource/WorkflowWebsocketResource.scala`
shows only `ExecutionsMetadataPersistService`, whose remaining functions are the Dashboard's (the
insert of a created execution and its replay-log location), and `git grep -n "SqlServer" amber/src/main/scala/org/apache/texera/web/ComputingUnitMaster.scala`
only `withoutDatabase`; harness gate 3C's Checks G, H and J, and the negative controls.

### Brief 18. `feat(dao, amber): drop run state from Postgres`

**Goal.** The columns and tables nothing uses are gone.

**Depends on.** 17.

**Files.**
- `sql/texera_ddl.sql`: `workflow_executions` as in §3.4; `operator_executions`,
  `operator_port_executions` (`:540-562`) and `output_mode_enum` (`:105-107`) removed.
- New `sql/updates/54.sql` and its changeSet: drop the five columns, the two tables, the type.
- The regenerated jOOQ classes (the `OperatorExecutions*`, `OperatorPortExecutions*` and
  `OutputModeEnum` files disappear).
- Whatever still names them: `ExecutionResultUrisSpec`'s fixtures, `MockTexeraDB` seed data, and,
  if `result-service/` is in the tree, its spec's fixtures.

**Tests.** The whole build compiles against the new classes; `DAO/test`, the amber suites,
`ComputingUnitManagingService/test`, `AccessControlService/test`.

**Run.** Apply the DDL, `sbt DAO/compile`, then the suites.

**Done when.** The suites pass and `git grep -n -i "operator_port_executions\|operator_executions\|runtime_stats_uri\|runtime_stats_size\|last_update_time\|output_mode_enum" -- . ':!sql/updates'`
finds nothing.

### Brief 19. `feat(computing-unit-managing-service): drop units' DB login`

**Goal.** A Kubernetes unit is not given the database login.

**Depends on.** 17.

**Files.**
- `computing-unit-managing-service/…/resource/ComputingUnitManagingResource.scala:431-436`: the
  three `ENV_JDBC_*` entries and their comment go.
- The manager's own deployment keeps its JDBC settings: it uses Postgres itself.

**Tests.** `ComputingUnitManagingResourceSpec` (the env assertions around `:563-618`): a created
unit's environment has no `STORAGE_JDBC_URL`, `STORAGE_JDBC_USERNAME` or `STORAGE_JDBC_PASSWORD`.
`KubernetesClientSpec`: the pod spec.

**Run.** `sbt "ComputingUnitManagingService/testOnly org.apache.texera.service.resource.ComputingUnitManagingResourceSpec org.apache.texera.service.util.KubernetesClientSpec"`.

**Done when.** The specs pass; in Kubernetes mode of the harness, `unit-env` lists no
`STORAGE_JDBC_*`, every scenario passes, and `pg-activity` shows no backend from the unit pod.

## Appendix. Briefs of the sub-parts left out of this step

Sub-parts 1, 8 and 10 of revision 1 are not part of step 3 (§5, open decision 6). Their briefs are
kept here as revision 1 wrote them, so that they can be taken up later; they were not revised and
still speak of each other and of settings that this revision removed. Each is preceded by what
the review found about it.

### Left out: brief 1. `perf(workflow-core): compute a tuple's size on first use`

**What the review found.** Nothing in this step depends on it, and it depends on nothing: it can
go upstream on its own at any time. The `getCount` half changes how every result page counts its
rows, so keep the fallback to planning and test it on a table that both the JVM and a Python
worker appended to. On Lakekeeper, `total-records` was seen carried through a manifest rewrite and
an expiry (§1b); PyIceberg adds to the previous snapshot's total when there is one, which was not
checked here.

**Goal.** Reading stored rows stops paying for an in-memory size nobody asks for, and counting a
table's rows stops planning the table. No behaviour changes.

**Depends on.** Nothing.

**Files.**
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/tuple/Tuple.scala:55`:
  `override val inMemSize` becomes `override lazy val inMemSize: Long =
  SizeOf.newInstance().deepSizeOf(this)`. No annotation is added or removed.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/result/iceberg/IcebergDocument.scala`:
  in `getUsingFileSequenceOrder`, compute the projected schema once (a `val` of the iterator) and
  use it in `openPendingFile` (`:237-240`) and `next()` (`:394-398`). `getCount` (`:131-140`):
  return `currentSnapshot.summary.get("total-records")` when the table has a current snapshot whose
  summary carries it; 0 when the table has no snapshot; otherwise plan as today.
- `common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/DocumentFactory.scala:95-97`:
  `tupleDeserde` becomes a `def` that returns a function keeping the Amber schema of the last
  Iceberg schema instance it was called with, so each document converts its schema once.

**Behaviour.** The size is the same number as before, computed when first read; the engine reads it
for every tuple (`DataProcessor.scala:130,220`, `DataPayload.scala:41-42`). A tuple read from a
table for a page, an export or statistics never computes it.

**Tests.**
- `common/workflow-core/src/test/scala/org/apache/texera/amber/core/tuple/TupleSpec.scala`: the size
  is positive, the same on a second read, and larger for a larger tuple (the existing cases at
  `:325-326` pass untouched); a tuple that went through Java serialization gives the same size.
- `.../storage/result/iceberg/IcebergDocumentSpec.scala`: `getCount` equals the number of rows read
  after 0, 1 and 3 appends; a projected read returns only the asked columns and every row.

**Run.** `sbt "WorkflowCore/testOnly org.apache.texera.amber.core.tuple.TupleSpec org.apache.texera.amber.core.storage.result.iceberg.IcebergDocumentSpec"`;
then the whole `WorkflowCore/test`.

**Done when.** The specs pass and `git grep -n "override val inMemSize"` finds nothing.

### Left out: brief 8. `feat(amber, pyamber): commit slow results on the timer`

**What the review found.** (1) Decide first how a full read of a slow result stays fast: with a
commit per writer per interval and no compaction (C6), a day leaves 2,880 small files per writer,
and a full read pays 3.5–6 ms for each (step 0). (2) The Python writer retries its own commits
(`iceberg_table_writer.py:101-113`: ten tries with a random back-off), not through the table's
`commit.retry` properties, so revision 1's D42, "Iceberg retries both", held for the JVM writer
only. (3) It
needs two pieces that revision 2 took out of brief 2, because nothing else uses them; they are
part of this brief now:

- `IcebergTidy.tidyMetadata(table)`: rewrite the manifests, then the during-the-run expiry. Spec:
  it leaves every data file and the row order as they were.
- `IcebergDocument.scala:280-313` (`seekToUsableFile`): in the case `(Some(lastId), Some(currId))`
  with `lastId != currId`, when `t.snapshot(lastId) == null` or `lastId` is not an ancestor of
  `currId` (`SnapshotUtil.isAncestorOf`), plan the whole current snapshot instead and position by
  count: the iterator's skip target becomes `from + numOfReturnedRecords` and `numOfSkippedRecords`
  restarts at 0 (make the skip target a `var` beside `from`). Spec (`IcebergDocumentSpec`): open
  `get()`, read part, append, expire the reader's snapshot (`expire(1, now)`), append again, go on
  reading: every row once, in order, no error; the same with a manifest rewrite in between.

(4) The decisions it rested on in revision 1: D9 "plus the timer"; D14 "the recorder tidies
their metadata only (manifests, snapshots) when a table has more than 100 snapshots, checked every
10 ticks, and once at the end, always keeping the last 60 s and at least 5 snapshots"; the last
case of D15, "the polling iterator plans afresh and skips the rows it already returned when its
snapshot is gone". `storage.iceberg.table.commit.interval-ms` would then also be read by the
result writers, Python through the worker's startup config.

**Goal.** A result writer that has rows buffered commits them at least every `commit.interval-ms`,
and the recorder keeps result tables' metadata small. This is the only sub-part that changes how
results are written; the done-when does not depend on it.

**Depends on.** 2, 5.

**Files.**
- `common/workflow-core/…/storage/model/BufferedItemWriter.scala`: `def flush(): Unit` ("write what
  is buffered; a no-op when nothing is"). `IcebergTableWriter.scala:99-136`: `flushBuffer` becomes
  the public `flush()`. The spec doubles that implement the trait get the method.
- `amber/src/main/scala/org/apache/texera/amber/engine/architecture/worker/managers/OutputPortStorageWriterThread.scala`:
  a second signal, `PortStorageWriterFlushSignal`; the loop (`:50-56`) calls
  `bufferedItemWriter.flush()` on it. One daemon scheduler per JVM (in the companion) offers the
  signal to every live result-writer thread's queue every `icebergTableCommitIntervalMs`; a thread
  registers when it starts and unregisters when it stops. State-writer threads
  (`OutputManager.scala:337-346`) do not register.
- Python: `amber/src/main/python/core/storage/iceberg/iceberg_table_writer.py`: `flush()` public
  (`_flush_buffer`); `core/storage/runnables/port_storage_writer.py`: a
  `PortStorageWriterFlushElement`, put on the writer's queue by a daemon timer every interval,
  handled in `receive` with `flush()`; the timer stops in `post_stop`.
  `core/storage/storage_config.py`: `ICEBERG_TABLE_COMMIT_INTERVAL_MS`, set from the worker's
  startup config; `PythonWorkflowWorker.buildStartupConfig` (`PythonWorkflowWorker.scala:83-116`)
  adds `"icebergTableCommitIntervalMs"`.
- `ExecutionRecorder.scala`: every 10th tick, for each known output whose result table has more
  than 100 snapshots, `IcebergTidy.tidyMetadata`; once more for every output at the ending.

**Behaviour.** A flush with an empty buffer does nothing, so an idle port makes no commit. Result
tables are never compacted (D14).

**Tests.** `OutputPortStorageWriterThreadSpec`: a flush signal writes the buffered rows and the
thread goes on; none when empty; the terminate signal still closes. `IcebergTableWriterSpec`:
`flush` twice writes one file. `amber/src/test/python/core/storage/runnables/test_port_storage_writer.py`:
the flush element; the timer stops. `PythonWorkflowWorkerSpec`: the startup config key.
`ExecutionRecorderSpec`: a result table with 150 snapshots is brought down by the 10th tick, its
data files and row order untouched, while a writer appends concurrently.

**Run.** `sbt "WorkflowCore/testOnly …IcebergTableWriterSpec"`; the amber specs as in brief 5 plus
`org.apache.texera.amber.engine.architecture.worker.managers.OutputPortStorageWriterThreadSpec`;
`cd amber && python -m pytest src/test/python/core/storage`.

**Done when.** The specs pass; on the harness with `--fast-record`, a page of scenario p's slow
operator returns rows within two intervals of the run starting, long before 4,096 exist.

### Left out: brief 10. `feat(computing-unit-managing-service): notice lost units`

**What the review found.** Not needed for the done-when: the beat closes a lost run on every
platform, and the two listing endpoints already stamp a unit whose pod is gone, which the
workspace triggers whenever its socket drops (D27). Take it up with step 6, where `UnitPlatform`
gets more than one real implementation; `LocalUnitPlatform` here only ever answers `Unknown`.
Revision 1's shapes for it:

```scala
sealed trait UnitPresence
object UnitPresence {
  case object Present extends UnitPresence
  final case class Gone(why: String) extends UnitPresence   // the platform no longer has the unit
  case object Unknown extends UnitPresence                  // the platform cannot say, or there is none
}
trait UnitPlatform {
  /** What the place these units run says about each of them, now. One round trip for all. */
  def presence(units: Seq[WorkflowComputingUnit]): Map[Integer, UnitPresence]
}
```

and the setting `kubernetes.computing-unit-presence-check-interval-seconds`
(`KUBERNETES_COMPUTING_UNIT_PRESENCE_CHECK_INTERVAL_SECONDS`, 30), which the harness's
`--fast-record` set to 5 for the unit manager.

**Goal.** The unit manager asks each unit's platform, on a timer, whether it still has the unit,
through one small interface, and stamps the units a platform lost. Today that happens only when
somebody lists units.

**Depends on.** Nothing.

**Files.**
- New `computing-unit-managing-service/src/main/scala/org/apache/texera/service/util/platform/UnitPlatform.scala`:
  `UnitPresence` and `UnitPlatform` (§3.8); `UnitPlatforms.forType(unitType, k8s: =>
  KubernetesClient): UnitPlatform`.
- New `…/platform/KubernetesUnitPlatform.scala`: `presence` = one
  `k8s.getAllPodStatusSnapshots`; a unit whose pod name (`KubernetesClient.generatePodName`) is in
  it is `Present`, otherwise `Gone("its pod no longer exists")`. A client failure is thrown.
- New `…/platform/LocalUnitPlatform.scala`: `Unknown` for every unit ("nothing starts or stops a
  local unit, so nothing can be asked").
- `computing-unit-managing-service/src/main/scala/org/apache/texera/service/util/ComputingUnitHelpers.scala:302-336`:
  `reconcileVanishedKubernetesUnits` is rebuilt on `UnitPlatform.presence` (Gone → stamp
  `terminate_time` and `GARBAGE_COLLECTED`, in one batched update, as today); both listing
  endpoints keep calling it.
- New `…/util/UnitPresenceJob.scala`: a `Managed` job like `IdleComputingUnitCleanupJob`: every
  interval, the rows of `workflow_computing_unit` with no `terminate_time`, grouped by type, through
  their platform; each Gone unit is stamped with `UPDATE … WHERE cuid = ? AND terminate_time IS
  NULL`. A platform call that throws is logged and the tick ends.
- `ComputingUnitManagingService.scala:113-120`: register the job when Kubernetes units are enabled.
- `kubernetes.conf`, `KubernetesConfig`: `computing-unit-presence-check-interval-seconds = 30`.

**Behaviour.** A unit's row becomes visible only after its pod was created (the create runs in one
transaction, `ComputingUnitManagingResource.scala:680-792`), so a new unit is never taken for a
vanished one. A pod that exists but failed stays `Present`: its unit is not terminated here, as
today; its run is closed by the beat (D26).

**Tests.** New `UnitPlatformSpec` (a stub client): present, absent, a local unit, a client failure.
New `UnitPresenceJobSpec` (`MockTexeraDB`): a Gone unit is stamped once; a terminated one is left
alone; a failing platform changes nothing; local units are never stamped. `ComputingUnitHelpersSpec`:
the listing reconciliation gives the same result as before.

**Run.** `sbt "ComputingUnitManagingService/testOnly org.apache.texera.service.util.platform.UnitPlatformSpec org.apache.texera.service.util.UnitPresenceJobSpec org.apache.texera.service.util.ComputingUnitHelpersSpec"`.

**Done when.** The specs pass; in Kubernetes, a unit whose pod is deleted with `kubectl` shows
terminated within the interval without anyone listing units.
