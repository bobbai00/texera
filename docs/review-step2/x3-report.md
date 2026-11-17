Batch X3 is finished: 12 commits on 55c14da26 in `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane` (branch `feat/sce-step2-lane`), nothing pushed, worktree clean. Every listed finding is fixed except two sub-claims that are not true in the code, which I left alone (D4's connect timeouts, D18's websocket payload size). Three points need a decision: D2's rule, D17's unused cut and D16's unit-side seams (open issues 1 to 3).

**Commits, oldest first**
1. 43f3a2263 refactor(dao): keep execution status codes in one place (D12)
2. d96ac8a71 fix(amber): give a created execution a status of its own (D1, D33)
3. ca957dbdd refactor(amber): take the create path's seams as parameters (D16)
4. 46d6d0b52 fix(amber): clear results once a later run has its own (D2, D10, D33)
5. a33fa90c3 refactor(amber): fail a create in one way (D25, D22, D28)
6. c39ec680d fix(amber): refuse an unknown target and another's replay (D9, D17, D10, D33)
7. bc71c58aa fix(amber): compile a create's workflow under a deadline (D4)
8. e0622998c fix(amber, frontend, agent-service): one shape for refusals (D5, D22)
9. 7485ba0b3 fix(agent-service): say what happened to a killed run (D8)
10. 115fa96bd fix(computing-unit-managing-service): forward plan settings (D7)
11. e58cf6e81 fix(single-node, frontend): state the create's body limit (D19, D20)
12. bc96c2b7b chore(amber, frontend, k8s): drop create-path leftovers (D18)

**Findings**
- **D1** fixed: a created execution has status 6; details below.
- **D12** fixed: the codes and the sets `Ended` and `NotRunning` are in `org.apache.texera.dao.WorkflowExecutionStatus` (common/dao); amber and the manager read them.
- **D2** fixed, with a deviation: an ended execution is cleared only once a later execution of the workflow on the unit holds result or console rows of its own, and on a background thread.
- **D4** fixed for the compile: its own pool, a 60 s deadline, 504 past it, 503 when the pool is full, the row Failed in both. The connect-timeout part is not true, so no code changed:
  - pgjdbc 42.7.10 already gives up after 10 s (measured).
  - The MySQL driver is no longer shipped.
  - AsterixDB uses Unirest's 10 s default.
- **D5** fixed: one refusal shape, `errors` gone, both clients order the errors by the plan they sent, the update answers 201, the 201 carries `{eid, planUri}`.
- **D7** fixed: the manager forwards four more settings; they are documented in the single-node `.env` and README and both Helm values files.
- **D8** fixed: a killed run with no reason reads "The run was stopped, or replaced by another run of the workflow."; a reason the unit gives is passed on.
- **D9** fixed: replaying another user's execution is a 400.
- **D10** checked: no rule changed; two tests pin it (below).
- **D16** fixed on the Dashboard's create path (`ExecutionCreator`, `OperatorUpdates`, `ExecutionResource`, `CostHintsLoader`); the unit's side is left.
- **D17** fixed: `targetOperatorId` is one optional id and an unknown one is a 400; the agent no longer names a target, so no plan is cut twice.
- **D18** fixed for `planUriOf`, the `newWorkflowExecuted` flag, the compiling service's `FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT` and the stale spec comment. `MAX_WORKFLOW_WEBSOCKET_REQUEST_PAYLOAD_SIZE_KB` stays: upstream #6858 raised it because large result frames were dropped.
- **D19** fixed: the dev proxy's `"/api/execution[s]"` entry is deleted.
- **D20** fixed: nginx states the limit on the create; the gateway route's comment says Kubernetes sets none.
- **D22** fixed: refusals are sentences, name no request field and state the engine version's limit; the browser no longer shows Angular's "Http failure response".
- **D25** fixed: a create fails only by a JAX-RS exception; the log location is written in the insert's transaction.
- **D28** fixed: the missing environment's message says each user keeps their own.
- **D33** fixed: tests for creates that are never started (sweep, clearing, latest execution, editor's lock) and for a replay of another user's execution.

**D1 in detail**
- **Value and name:** 6, `WorkflowExecutionStatus.Created` (frontend `CREATED_EXECUTION_STATUS`). It shows as "Created" in the history and "CREATED" in the admin list.
- **Writers:** `ExecutionsMetadataPersistService.insertCreatedExecution` writes 6. The unit's first write still makes it 0, and a create that fails after the insert makes it 4.
- **Readers changed, and what each does with a created row:**
  - Manager's idle sweep: does not count it as a run in progress; its creation still counts as activity.
  - `WorkflowExecutionsResource.getLatestExecutionID` (export, result paging after a restart): passes over it.
  - Clearing at a create: neither clears it nor treats it as a replacement.
  - Admin list, server and browser: names it CREATED, filters by it, shows time used and end as "Not Available", disables Kill.
  - History: lists it as Created with a clock icon, finds it by `status:created`, counts no time for it in the chart.
  - Time Travel: leaves it out.
  - Heat-map restore: passes over it.
- **Readers that needed no change:**
  - The editor's lock asks only for running and initializing rows, so a created row no longer locks (pinned by a spec).
  - The update route refuses only ended executions.
  - The unit preselect (`/latest`) and the quota page do not read the status.
  - The history route's `?status=` filter does not take "created".
- **SQL:** none. The column is a SMALLINT with no constraint. Rows created before this change keep 0.

**D10: upstream's rule**
- On upstream main (021bf51c1) the unit alone authorizes a run. `WorkflowExecuteRequest` needs WRITE on the computing unit, the agent's `POST /api/execution/{wid}/{cuid}/run` needs only a signed-in user, and nothing on the run path checks the workflow.
- In the editor, whoever can open a workflow can press Run: the owner, a READ or WRITE grant, or any signed-in user when it is public.
- The create asks for READ on the workflow, public included, and WRITE on the unit, so it allows what upstream allows.
- Upstream's unit also cleared the previous run's results whoever ran it.
- Tests: "let any user run a public workflow on a unit of their own" and "clear what a run of another user replaced on a unit they share".

**Externally visible changes**

Dashboard REST:
- **`POST /api/executions` request:** `targetOperatorIds` (list) is replaced by `targetOperatorId` (optional string). An id the plan lacks is a 400, "The workflow has no operator <id> to run up to." The old field is ignored, not refused, so a caller that still sends it gets the whole workflow compiled.
- **201 body:** was `{eid, wid, computingUnitId, planUri}`, now `{eid, planUri}`.
- **Workflow does not compile:** was 400 `{eid, operatorErrors, errors}`, now 400 `{code: 400, message, eid, operatorErrors}`.
- **New answers, all `{code, message}`:**
  - 504 "Execution <eid> could not be created: compiling the workflow took longer than 60 seconds." The row is Failed.
  - 503 "Execution <eid> could not be created: too many workflows are being compiled. Try again in a moment." The row is Failed.
  - 400 "Execution <eid> is another user's: only your own executions can be replayed."
- **`POST /api/executions/{eid}/updates`:** was 200, now 201; body unchanged.
- **Status values:** `status` 6 in `GET /api/executions/{wid}` and `/{wid}/latest`; `executionStatus` "CREATED" in the admin list, whose filter takes it.

Message texts of the create:
- "The request names no workflow: wid is N." is now "The request names no workflow."
- "The request names no computing unit: computingUnitId is N." is now "The request names no computing unit to run the workflow on."
- "The request's engine version is too long." is now "The request's engine version is longer than the 107 characters an execution keeps."
- "computing unit N is terminated" is now "Computing unit N is terminated."
- "per-user warehouses are disabled in this deployment" is now "Per-user warehouses are disabled in this deployment."
- "a warehouse must be selected for this execution" is now "A warehouse must be selected for this execution."
- "no warehouse with id N owned by this user" is now "You have no warehouse with id N."
- The missing-environment compile error gains " Each user keeps their own environments, so to run this workflow, create one with this name."

Message texts of the update:
- "execution N has ended" is now "Execution N has ended."
- "execution N has no stored plan" is now "Execution N has no stored plan."
- "the operator's Python environment cannot change while the run is paused" is now capitalized and ends with a period.

Database:
- `workflow_executions.status` is 6 from the create until the unit's first write.
- `log_location` is written in the transaction that inserts the row.
- A run's results are cleared at the first create after a later run has results, not at the next create.
- No DDL.

Settings:
- No new config key or environment variable. The compile's limits are constants (8 threads, 32 waiting, 60 s).
- The manager forwards four more variables to Kubernetes units when they are set:
  - `STORAGE_INPUT_LINKS_ALLOWED_ENDPOINTS`
  - `STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`
  - `UDF_PYTHON_ENVIRONMENTS_ROOT`
  - `UDF_PYTHON_ENVIRONMENTS_INSTALL_TIMEOUT_MINUTES`

Deployment:
- **nginx (single-node):** `client_max_body_size 1m;` in `location = /api/executions`. This is nginx's default made explicit.
- **Dev proxy:** the `"/api/execution[s]"` entry is gone, so the create has no proxy timeout.
- **Helm:** `FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT` is gone from the workflow-compiling-service deployment.
- Everything else under `bin/` is comments and one README table.

Clients:
- **Agent:** sends no target in the create; new killed-run text.
- **Browser:** for a create the Dashboard did not answer, one of three messages:
  - "The Dashboard service could not be reached."
  - "The workflow is larger than this deployment accepts in one request." (413)
  - "The Dashboard service answered <status> <text>."

No route, websocket message or unit endpoint changed.

**Tests**
- **Suite script:** no failure. Summary at `/private/tmp/claude-501/-Users-jiadongb-Desktop-projects-texera/110f62ac-4583-4269-8645-82b6251b3c39/scratchpad/sce/suite-x3.summary`.
  - common: 55, 3045 (1 cancelled, 2 pending), 195, 1144 (1 pending), 106.
  - services: 90, 77, 481, 43, 325 (321 before).
  - amber unit: 2683 (2677 before), 1 pending.
  - integration: 56, with the R case cancelled and `IcebergRestCatalogIntegrationSpec` aborting, as in the baseline.
- **Commit the script ran on:** 6a83b76e5. HEAD bc96c2b7b differs from it by one comment in `agent-service/src/api/execution-api.ts`, so I did not run the script again.
- **Scala format:** `scalafixAll --check` and `scalafmtCheckAll` pass.
- **Frontend on HEAD:** 7,267 passed and 1 skipped, which this batch did not add (7,256 before); `yarn format:ci` and `yarn build:ci` pass.
- **agent-service on HEAD:** 378 pass (374 before); typecheck clean.
- **Helm:** `helm template` renders with both values files, in a scratch copy.
- **Broken by hand, each failing its tests:** the sweep's status set, the latest-execution filter, the clearing rule and its hand-off, the replay's owner check, the unknown-target check, the workflow read check, the cancel at the deadline, the resource's no-argument constructor, the chart's created case.
- **Not verified:** only the final tree was built; the intermediate commits were not built one by one.

**Open issues**
1. **D2 deviates from the triage's wording.** "Started" is judged by result or console rows, not by status, because a create that fails is recorded Failed like a run that failed on its unit. A run that starts and writes nothing therefore replaces nothing.
2. **D17: the Dashboard's cut has no caller.** The browser and the agent both cut the plan themselves and name no target. Making the Dashboard the one place would change the browser's run controls (X4). The harness still sends `targetOperatorIds` (`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e/driver/transport.py`, line 846), which is now ignored.
3. **D16 on the unit's side.** Six `protected def` seams remain, in files outside this batch, and no batch lists them:
   - `WorkflowService.storedRun`
   - `WorkflowExecutionService.environmentInstaller` and `createAmberRuntime`
   - `ExecutionReconfigurationService.readUpdate`
   - `SyncExecutionResource.workflowServiceOf`
   - `PythonWorkflowWorker.environments`
4. **Time Travel** still lists other users' executions that kept a log; choosing one now gets D9's 400.
5. **Created rows are never closed** (step 3). With `web-server.clean-all-execution-results-on-server-start` on (default off), a unit's boot marks a created row that has a log location Failed. An execution that failed at its create is still the "latest" one for export.
6. **D4, for Batch C.** The deadline answers the request, but a compile-time read that has connected and then hangs keeps its pool thread, since pgjdbc has no read timeout by default. Eight of them make creates answer 503.
7. **Body limit.** Only the single-node nginx enforces one; the Kubernetes gateway and the dev proxy have none.
8. **Unit-side message style.** The unit's own refusals, such as `StoredExecutionStart`'s "per-user warehouses are disabled in this deployment", keep the old style; they are X4's.
9. **Merging with X1/X2.**
   - My only change in their area is the message in `common/workflow-compiler/.../PythonEnvironmentResolver.scala` and its expectation in `WorkflowCompilerSpec.scala`.
   - Likely conflicts: the `bindingsFor` parameters of `ExecutionCreator` and `OperatorUpdates`, and `CreateExecutionResponse.scala`.
   - The README states the default 10000 for `CONSTANTS_MAX_LISTED_FILES`, which X1 may change.