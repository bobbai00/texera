Sub-part 5 is committed in full on `feat/sce-step3-lane` and there is no `wip:` commit: nothing is uncommitted, the tree is clean, and nothing is pushed. Two checks you asked for were not done: the REST-catalog run and the hand-breaking of `transitionTo` and its call sites. No lake was ever up and I never took the stack lock.

**Commits (over `2147aeaec`)**
1. `56654f18b` feat(workflow-core): drop output rows from the execution log
2. `66f38725c` refactor(amber): take the unit's seams as parameters
3. `307af0458` fix(amber): set a run up in full or not at all (E19)
4. `d62f237c9` fix(amber): read a run's last results when it was never polled (E20)
5. `b3132678e` feat(amber): find the held run's results in memory
6. `3d84565a5` feat(amber): write an execution's log from the unit (recorder, `transitionTo`, E2, the unit's stop)

**What is verified**
- **Full suite**, once, on `3d84565a5`: no failure except the two known ones (`IcebergRestCatalogIntegrationSpec` aborted, the R case cancelled). Amber unit 2750 passed (2696 before), integration 56, workflow-core 1243 (the three output-row cases are gone).
- **Format**: `scalafixAll --check` and `scalafmtCheckAll` are clean on the committed tree.
- **Recorder broken by hand 18 ways**: 17 failed a case at once. The 18th (an ending that does not close the log until it is written) survived, so I added a case, which now fails under it.
- E19 and E20 were each checked with one break.
- The suite left no log table behind in the lane's catalog.

**Not done**
- **REST catalog**: never started. A script is ready but was never run: `/private/tmp/claude-501/-Users-jiadongb-Desktop-projects-texera/110f62ac-4583-4269-8645-82b6251b3c39/scratchpad/step3-p5/rest-check.sh`. I expect no product change is needed, since the amber specs use the ambient catalog, but that is unverified.
- **Breaking `transitionTo` and the sites by hand**: 20 mutations are listed in `/private/tmp/claude-501/-Users-jiadongb-Desktop-projects-texera/110f62ac-4583-4269-8645-82b6251b3c39/scratchpad/step3-p5/mut-web.py`, with a runner at `/private/tmp/claude-501/-Users-jiadongb-Desktop-projects-texera/110f62ac-4583-4269-8645-82b6251b3c39/scratchpad/step3-p5/mutate-batch.py`. Neither was run.

**Design as built**
- **Recorder interface** (`amber/src/main/scala/org/apache/texera/amber/engine/common/executionrecord/ExecutionRecorder.scala`):
  - `state(state, errors, reason)` returns at once. It drops a repeat of the current state and anything after an ending.
  - `statistics` and `console` are accepted and ignored, as defaults in the trait.
  - `awaitIdle(timeout)` is true once nothing is left to write, which includes after the recorder stopped or gave up.
  - `ExecutionRecorder.start(context)` writes the lake; `ExecutionRecorder.none` is one value.
- **Recorder threading**:
  - One lock guards the queue of unwritten rows, the seq, the last state and a closed flag; callers only queue under it.
  - One daemon thread per run (`execution-record-<eid>`) makes every lake call: it makes the table, appends queued rows oldest first in one commit, and beats on each tick.
  - A write that fails stays queued for the next tick and is reported once. A tick catches everything.
  - After the ending row it tidies once and shuts itself down. A queued ending is retried every 5 s for 2 min, then given up.
  - A table that is gone stops the recorder and is never remade.
  - Specs pass `timed = false` and call `tick()`, which runs one tick on that same thread.
- **The held run's outputs**: `ResultUris` (`amber/src/main/scala/org/apache/texera/web/storage/ResultUris.scala`), a concurrent map on `ExecutionStateStore.resultUris`.
  - It is fed by the `OperatorPortResultUriAvailable` callback, which still inserts the Postgres row.
  - It is read by `ExecutionResultService`, `SyncExecutionResource.collectOperatorResult` and `TestUtils.resultUrisOf`.
  - The only Postgres lookup left is the pagination fallback when no run is attached.
- **`transitionTo(state, errors = Nil, reason = None): Boolean`** on `ExecutionStateStore`, under the metadata store's lock:
  - A run in COMPLETED, FAILED, KILLED or TERMINATED is left untouched and the call answers false.
  - Otherwise it tells the recorder, writes the status column and the metrics, and stores the state with the errors. An ending then stamps the end time.
  - PAUSING and RESUMING are not logged; TERMINATED is logged as KILLED.
- **`WorkflowExecutionService.end(state, errors, reason)`** shuts the engine down and calls `transitionTo`. The sync resource, the cluster listener, a failed install and the unit's stop use it.
- **`ComputingUnitMaster.EndRunsOnStop`** ends every held run and waits 5 s in all for the logs.

**Reason texts in the log**
- KILLED: "killed by the user", "replaced by execution N", "stopped: nobody watched it for 30 s" (the configured timeout), "stopped by its caller" (sync timeout or console error).
- COMPLETED: "stopped once its target operators finished" for a sync run; no reason when the engine completes it.
- FAILED: "the computing unit was stopped"; otherwise the errors, with the first one's message in the label.

**Where it differs from the brief** (also in the body of `3d84565a5`)
- `transitionTo` has no `clearErrors`, returns whether the state was taken, and stamps the end time itself.
- The recorder has no inline mode and no tidy numbers: the log is tidied at its end only.
- The idle clean-up records its kill after letting go of the run, not before, so the kill does not re-arm the clean-up.
- `WorkflowService` takes `startRecord` as a parameter.
- The log's `kind` column and the `ExecutionLogEntry` shape are kept.
- The brief's `killExecution` became `end`.

**What is left, in order**
1. Run the REST-catalog check.
2. Run the web-layer mutations.
3. Run your harness (scenario d should log RUNNING, PAUSED, RUNNING, KILLED).
4. Decide the open issues:
   - The engine-event email is still sent for a state the run did not take (finding 12).
   - A sync run that ends otherwise in the 500 ms between "targets ready" and its stop is still answered "Completed"; the log says how it really ended.
   - A run failed through its error handler keeps its engine until it is superseded or cleaned up (as before).
   - A recorder that gives up leaves a log with no ending.
   - The cluster listener's member-removed arm still has no test.
5. Hand-offs to later sub-parts:
   - **Sub-part 6** must implement `statistics` and `console` in the lake recorder, make their two tables in the first task, and add the rest of the tick with a tidy counter. `awaitIdle` and the end tidy must then cover those tables too.
   - **Sub-part 11** needs nothing more from the unit.
   - **Sub-part 17** removes `updateStatus` from `transitionTo`, the registry insert, the pagination fallback, and the rows `RetryingDatabaseE2ESpec` still seeds.