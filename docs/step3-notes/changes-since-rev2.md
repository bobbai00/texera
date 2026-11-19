# Step 3: what changed since revision 2 of the design

Read this with `docs/step3-design.md`. Where the two disagree, this file wins; the code as it
landed wins over both. Dates are 2026-11-17.

## 1. Sub-parts 2-4 have landed

Commits `2b9dcc571`, `8c16902ac`, `60d3821e7` (branch `feat/sce-step3-lane`). Their report, with
the interfaces as built and what was measured on Lakekeeper, is `parts-2-4-report.md` beside this
file. What later sub-parts must know:

- `IcebergReader.read` exists and owns "plan again once when a file is gone"; it also starts over
  on the AWS SDK's `NoSuchKeyException`, which is what Lakekeeper's store reports for an expired
  snapshot's manifest list.
- Iceberg does not refuse a merge that an append overtook. A merged file therefore takes the data
  sequence number of the newest file it replaces, and readers order files by data sequence number.
- The appender takes a file-name prefix and adds 32 random hex digits; every append is one
  transaction, with or without properties.
- Log rows are built with `ExecutionLogEntry.state(...)` and read through `entry.reason`; there is
  no public `ExecutionLogDetail` and nothing reads errors back as `WorkflowFatalError`.
- `ExecutionLabel.reason` is an `Option`, not an empty string.
- A write to a missing table throws `NoSuchExecutionTableException`.
- The console's `read` stops when the page is full and treats a row whose `seq` does not rise as
  a repeat, so `append` requires `seq` to rise within and across appends. The "N messages were
  not stored" row needs a `seq` above the rows before it.
- Statistics rows have no `seq`: a retried append can store a sample twice.
- `ExecutionLogStore.create` is two commits (the table, then the beat properties): a reader in
  between sees a beat of 0.
- Nothing returns a table's stored bytes yet (sub-part 11 needs it), and nothing lists a
  namespace's tables by prefix.
- `STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS` is not yet in the unit manager's list of forwarded
  settings.
- Lakekeeper returns `table.snapshots()` in no chronological order.

## 2. The log holds state changes only

The owner decided that every output port's storage location is written into the plan when the
plan is made (fix batch P of `docs/review-step2/triage.md`). The unit takes a port's location from
the plan. The Dashboard side, which makes plans, finds an execution's result tables by the same
function that assigned them (from the workflow, the execution, the operator, the port and the
warehouse), without reading the plan's body; a port that was not stored has no table, which reads
as "nothing there".

So the log needs no `output` rows. Sub-part 5's recorder writes state rows, the label and the
beat; `ExecutionLogStore.outputs`, `ExecutionLogEntry.output`, `ExecutionOutput` and the `output`
kind are removed there. Sub-parts 11, 14 and 16 find tables through the plan's locations, not
through the log. Check I of the harness (a run's tables each have one data file and one snapshot)
is unchanged.

## 3. A created execution has a status of its own

Review fix D1 (`docs/review-step2/x3-report.md`): the Dashboard inserts the row as Created (6);
the unit's first write makes it 0. Until sub-part 18 drops the column this stays as it is. When
sub-part 12 derives status from the closing record and the label, it must keep the distinction: an
open execution whose label has no state is Created, not Initializing, and nothing that means "a
run in progress" counts it (the editor's lock, the manager's idle sweep, "latest execution",
replace-at-create). The closing job still closes it as "never started" after the configured time.
The design's line "its editor stays locked ... up to ten minutes after a start that never
happened" no longer holds: such an execution locks nothing.

## 4. What the reviews left to step 3

- Sub-part 5, as it gives every state change one `transitionTo`:
  - a finished state is final everywhere (finding E2 lists the four hand-written guards and the
    four places without one: pause and resume, the sync kill, the error handlers; "targets ready"
    ends COMPLETED directly, not KILLED then COMPLETED);
  - `WorkflowExecutionService` is not built in two phases with null `var`s (E19): one value holds a
    run's services, and a failure while building them shuts the client down;
  - the null `resultUpdateCancellable` (E20);
  - the unit-side test seams become constructor parameters with production defaults, as the
    Dashboard's did: `WorkflowService.storedRun`, `WorkflowExecutionService.environmentInstaller`
    and `createAmberRuntime`, `ExecutionReconfigurationService.readUpdate`,
    `SyncExecutionResource.workflowServiceOf`, `PythonWorkflowWorker.environments`.
- Sub-part 13: no failed or killed run has ever sent its e-mail, because the unit's trigger
  carries only COMPLETED and PAUSED (E12). The closing job sends one e-mail per ended run.
- Sub-part 14: today a create clears an ended execution's results once a later execution of the
  workflow on the unit has result or console rows of its own (D2 as landed). The expiry job
  replaces that rule with the label's: a later execution has started.
- Sub-parts 6 and 12: `CostHintsLoader` scans a run's whole statistics table on the create's
  request path (D26). A per-operator summary written when a run ends would make it one small
  read; do it if it is cheap where the statistics move.
- Sub-part 12: Time Travel still lists other users' executions that kept a log, and replaying
  one is refused (D9); the list should offer only what can be replayed.

## 5. Other work the remaining sub-parts start from

- Fix batch X4 (the unit's web layer): a refused request is answered by an event of its own, not
  a `WorkflowErrorEvent`; pause, resume and kill name their execution and a stale one is refused.
- Fix batch C: the run compile moves from the Dashboard into the workflow-compiling-service; the
  Dashboard's create authorizes, inserts the row, asks for the plan, stores it. Sub-part 11's
  "a create closes its own failures" applies to that shape.
- The stored plan is format version 1; the plan table's columns are `entryId, body, logical,
  createdBy, computingUnitId, notification` (`docs/review-step2/x1-report.md`). Sub-part 13 moves
  `notification` to Postgres as designed.

## 6. The plan goes through the client (2026-11-18)

The owner's decision on the evening of 2026-11-18: the Dashboard service answers the plan to the
client, the client sends it to the engine, and the Dashboard keeps no copy. Making the plan proof
against a changed copy is left for later. This replaces the plan table of step 2's design and
every part of step 3 that read it.

1. Create: `POST /api/executions` answers `{eid, plan}`; the plan is text the client passes on
   unread. A plan over 16 MiB (`PhysicalPlanCodec.MaxPlanBytes`) is refused (400), and the
   execution is closed as "its plan is too large".
2. Start: `WorkflowStartRequest{executionId, plan}` over the socket, and `plan` in the body of the
   unit's `POST /api/execution/{eid}/run` for the agent. The unit checks the plan before it starts
   it (`ExecutionStart.check`): its execution, its workflow, its warehouse and whose it is, its
   replay logs, its input links. The codec already ties each storage location to the plan's own
   execution and warehouse.
3. One start: a unit starts each execution once, held in its memory
   (`WorkflowService.startedExecutions`). The `started` tag the unit and the closing job both
   took is gone, and so is the unit's check of the creator and unit a plan row named.
4. A change to a paused operator: `POST /api/executions/{eid}/updates {operator, workflow}`
   answers `{operatorId, update}`, and the client sends `OperatorUpdateRequest{executionId,
   update}`. The workflow is what the editor held when the operator was unlocked for the change
   (`snapshotWorkflowForLogicChange` in the frontend). The compiler refuses a workflow it cannot
   read (400). The unit checks the update against the plan it runs: the execution, the operator,
   and the Python environment, a check that moved from the Dashboard. Update ids are gone; an
   update is capped as a plan is.
5. Tables by name: the Dashboard finds an execution's result and state tables by their names
   (`wid_<w>_eid_<e>_...`, `ExecutionTables.portTables`), for exports, stored bytes and expiry.
6. Closing: the job takes no claim. An execution with no log after `never-started-after-seconds`
   is closed "never started", with no e-mail and no measure, and a late start's log ending
   replaces that verdict as it replaces any other. Only a create that failed closes with its
   results marked expired (`ExecutionRecords.close(unstartable = true)`).
7. Gone: `ExecutionPlanStore`, the plan namespace (`STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`),
   `VFSResourceType.PLAN` in Scala and Python, and `ResultSchema.executionPlanSchema`.

Safety now: the browser holds the plan, signed input links included, as it already holds signed
links to dataset files; users already run their own code on the unit, which holds the lake's
keys. The lock-down later: a ticket the Dashboard signs per execution (execution, unit, the plan's
hash, expiry), files only through signed links, and tables through the catalog with a pass per
execution.

## 7. Upstream's result service, merged in (2026-11-19)

Upstream merged its result service (#9356): a module that serves an execution's result pages with
no computing unit. It read `operator_port_executions` and `workflow_executions.status`, which
step 3 drops. Merged into the branch, it is re-based on what the branch keeps:

1. Finished: the caller's latest finished execution is the newest with a closing record
   (`ended_at` set). Upstream's `TerminalWorkflowExecutionStatus` is not kept: the DAO's
   `WorkflowExecutionStatus.Ended` already says which outcomes end an execution.
2. Results: an execution's results are the result tables of its external output ports, found by
   the tables' names (`ExecutionTables.portTables`), in the warehouse its row names. A per-user
   warehouse that is off answers 503, as the export does.
3. Output mode: the engine records each port's output mode as a property of the result table it
   makes (`texera.result.output-mode`, `ExecutionTables.resultTableProperties` and
   `outputModeOf`), so a reader tells a visualization by the table. A table made before records
   none, and is not taken for a visualization.
4. Row count: counted from the table, as the page's own count is.
5. Tables can be made with properties (`DocumentFactory.createDocument(uri, schema,
   properties)`); the execution log is made with its first beat in that one commit.

Nothing calls the service yet: its deployment is upstream's next pull request, and #8996 moves the
frontend to it. The API is upstream's, but for `rowCount`, which is always a number here.
