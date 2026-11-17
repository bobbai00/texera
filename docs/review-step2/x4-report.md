Batch X4 is committed on `feat/sce-step3-lane` in `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step3-lane`: six commits on `60d3821e7`, worktree clean, nothing pushed. Every finding was true in the code; all are fixed except the parts listed under "Left".

One action for you first: the end-to-end driver (`sce-e2e*/driver`, not touched) will break on this batch.
- `transport.py:583-589` sends pause, resume and kill without `executionId`; the unit now refuses those.
- `transport.py:375` and `scenarios.py` `_refused_start` (and line 1140) wait for a `WorkflowErrorEvent` on a refused start; it is now a `RequestRefusedEvent`. Their case-insensitive substrings still match the new texts.

**Commits**
1. `659152b9e` fix(amber): close a worker's executor however it stops (E13)
2. `ee269b92e` refactor(amber): tidy the unit's web layer (E16, E17, E21, E32, E33)
3. `b0b1e9a2b` fix(amber, frontend): tell a refused request from a failed run (D3, E23, B-3)
4. `74b8aad82` fix(amber, frontend): refuse a pause or kill of a stale run (D29)
5. `c115d3a94` fix(amber, frontend): keep console messages, say errors once (B-1, B-2, B-4, B-5)
6. `e6a0c0359` refactor(frontend): call a Python environment an environment (D21)

Commits 2 to 5 were each checked out, compiled, linted and run against the specs they touch. Commit 1 was not checked on its own: its files are independent of the web layer and its specs passed at commit 2.

**Findings**
- **D3**: fixed. The unit answers with `RequestRefusedEvent` to the sender alone; the browser toasts it, and fails its run only for the start it still waits on. Stop, Checkpoint and the console's commands need WRITE on the unit.
- **D29**: fixed. Pause, resume and kill carry `executionId`; the unit refuses one that is not the run it holds.
- **E13**: fixed. `DataProcessor.closeExecutor()` closes once; `WorkflowWorker.postStop` calls it after the DP thread has ended. A killed and a failed run on a real engine leave no temporary copy and close once.
- **E16**: fixed in the web layer (`CheckedStart.cuid`, the "Initialing an AmberClient" log line). The other items are X1's and X2's.
- **E17**: fixed. `sessionUri` and `withoutSecrets` are gone; each entry point logs that it was asked.
- **E21**: fixed for the two named items: `applyStoredUpdate` is an `Either` chain, and the console writers are closed in one place.
- **E23**: fixed for refusals: sentences, one wording per condition, "workflow is not initialized" split in two.
- **E32**: fixed (the `supersedeCurrentRun` comment, "sub-part 16" in `WorkflowWebsocketResourceSpec`).
- **E33**: inline qualified names fixed.
- **D21**: fixed. `PythonEnvironmentService` and `PythonEnvironment` in `service/python-environment`, with `create`, `update`, `list`, `delete`.
- **B-1**: fixed. Cause: the browser's `ConsoleFrameComponent` emptied its displayed list on Initializing→Running. The messages stayed in the browser's store, so they came back with the next message or state. The unit was not at fault.
- **B-2**: fixed. Only an ERROR message's title is red.
- **B-3**: fixed. The canvas menu toasts a run in flight that fails.
- **B-4**: fixed. The unit no longer writes the failed install to the consoles; it is the run's error only.
- **B-5**: fixed. Errors are de-duplicated on type, operator, worker and message.

**Left, and why**
- The `return` out of a catch in `WorkflowExecutionService.startStored` (E33): on lines X1 rewrites and sub-part 5 rebuilds.
- Run errors after the claim still read `t.toString` (E23): that is a run's error, not a refusal.
- "unknown plan format …" and "unknown update format …" keep their old style (X1's wording).
- "Could not load Python virtual environments" and the `UserVenvComponent` / `.pve-*` names: outside D21's "service and types".

**Externally visible changes**

Requests:
- `WorkflowPauseRequest`, `WorkflowResumeRequest` and `WorkflowKillRequest` are now `{executionId: number}` (they were `{}`). A frame without it binds 0 and is refused.

Events:
- New `RequestRefusedEvent {request?: string, executionId?: number, message: string}`, sent only to the session that asked. `request` is the frame's type; `executionId` is present for a start, pause, resume or kill.
- `WorkflowErrorEvent` now carries only a run's errors.
- A refused `OperatorUpdateRequest` is still `ModifyLogicResponse {opId: "", isValid: false, errorMessage}`.

What the unit answers:
- Unreadable frame: "The request could not be read." or "The request could not be read as a <Type>."
- No WRITE on the unit: "You do not have write access to the computing unit."
- Pause, resume or kill of another execution, or with no run: "Execution N is not running here."
- Checkpoint, retry, skip, debug command or evaluate with no run: "No execution of this workflow is running here." (was "workflow execution is not initialized").
- A request that throws: "The request failed on this computing unit: <message or exception class>". The stack trace is only in the unit's log.

Start refusals, also on the sync REST route:
- "A signed-in user is required to start an execution."
- "This connection is not open on a workflow." / "This connection is not open on a computing unit." (both were "workflow is not initialized")
- "The request does not name an execution's plan." (was "not an execution plan")
- "The plan is execution A's, not B's."
- "The plan belongs to workflow W, not to this one."
- "The plan is in another user's warehouse."
- "Execution N keeps its plan in warehouse 'w', and per-user warehouses are disabled in this deployment."
- "Execution N has no stored plan."
- "Only the user who created execution N may start it."
- "Execution N was created for computing unit A, not B."
- "The plan's ids do not match its location."
- "The plan's input links expired at T. Run the workflow again."
- "The stored plan of execution N cannot be read[: why]."
- "The plan of execution N could not be read. Run the workflow again."
- "Execution N was already started."
- "Execution N could not be claimed for its start[, as its plan was being changed]. Run the workflow again."
- "Execution N could not be started, because of an error on this computing unit."

Update refusals (in `ModifyLogicResponse.errorMessage`):
- "Only the user who created execution N may change its operators."
- "The request names no change to apply."
- "Execution N has no change X."
- "Change X of execution N could not be read."
- "The change is execution A's, not B's."
- "The change stored as X names itself Y."
- "Operator X is not in the running plan."

Logs:
- "Asked to start execution N." on the socket and "Asked to run execution N." on the sync route.
- The start line is "Execution N of workflow W starts on computing unit U from its plan at <uri>." with no "as asked at".

Consequences of B-4:
- The sync result's `operators[op].error` is no longer set for a failed install; `errors[0]` carries "EXECUTION_FAILURE: Python environment 'x' could not be installed: <reason>". The agent service formats both, so the agent still learns why, without pip's full output.
- The AI Fix tab is no longer offered for an install failure.
- A second UDF of the same environment shows no error in its own console, because the run's error names the first.

**What a browser test should now see**

D3:
- A refusal shows as an error toast (`.ant-message-error`) with the unit's message; the run on screen is unchanged.
- A refused start the page waits for shows "Run failed: <message>", the Run button returns, and the console lists the refusal as an ERROR row.
- On a unit shared read-only, these are disabled:
  - `button[title^="Stop this run"]`
  - `#run-button`
  - `#checkpoint-button`
  - the four `.console-input-container button` and the `.console-input-container input[nz-input]`
- The Form View's `button.run` reads "No access" and is disabled, also mid-run.

D29:
- The page's frames carry `executionId`.
- A raw pause or kill frame with another id gets the toast "Execution N is not running here." and the run goes on.
- The admin page sends its row's `executionId`; it shows nothing on a refusal, because it does not listen to its socket.

B-1: the "Installing Python environment 'x' (N packages)" and "… is ready" / "… reused" rows (`.console-message-entry`) stay listed through Initializing→Running and after.

B-2: their titles are `.collapse-message-header` without class `error` (bold, not red); an ERROR row with a body has `.collapse-message-header.error`.

B-3: with the console closed, a failed install toasts "Run failed: Python environment 'x' could not be installed: <reason>".
- The error is cut after 200 characters with "…".
- " (and N more error(s) in the console)" is appended when there are more.
- A refused create toasts "Run failed: <first error>".
- A page that opens on an already-failed run gets no toast.

B-4: after a failed install the console lists the "Installing …" row and one ERROR row titled "Python environment 'x' could not be installed: <reason>", with pip's output as its body.

B-5: after a refused create, the editor's compile adds no second row for the same operator and message.

**Tests**
- Scala `suite.sh`: no failure.

  | Suite | Result | Baseline |
  |---|---|---|
  | WorkflowCore | 1248 | 1248 |
  | amber unit | 2691 | 2677 (16 added, 2 removed with `withoutSecrets`) |
  | amber integration | 56 passed, R case cancelled, `IcebergRestCatalogIntegrationSpec` aborting | same |

  It ran on a tree whose Scala sources are those of `e6a0c0359`; only four frontend files changed afterwards.
- `scalafixAll --check` and `scalafmtCheckAll` are clean.
- Frontend: `yarn test` 7281 passed, 1 skipped (7256 before); `yarn format:ci` and `yarn build:ci` pass.
- Four Scala and eleven frontend behaviours were broken by hand; each was caught by a test.
- The first full run caught `PythonEnvironmentIntegrationSpec` still expecting the unit's console ERROR; it is updated in commit 5.

**Open issues**
- **Late-join console loss**: a page that opens while a run is Initializing loses the install messages sent so far. The unit sends a joining session the console before the state (`ExecutionStateStore.getAllStores` order), and the browser's console store clears on an Initializing state event. Read from code, not fixed. Either reorder the stores or stop clearing on the snapshot.
- **Console writer race**: `ExecutionConsoleService.unsubscribeAll` closes writers on the caller's thread while the writer thread may still be committing. It showed once as a retried Iceberg commit in the integration log. It predates this batch and is not fixed.
- **Merge with X1**: `applyStoredUpdate` is rewritten, but the `requireResourcesBound()` call and its comment are byte-identical and in place inside `changedBy`. Their removal should merge cleanly, or conflict on two lines at the `catch`.
- **Merge with X3**: `errorsOfFailedCreate`'s fallback now calls `startFailure` (three lines beside X3's parsing). The "sub-part 16" comment line may overlap D18. Status mapping and create parsing are untouched.