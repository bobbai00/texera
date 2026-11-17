**Verdict**

1. Not ready as it stands: one blocker on this side. The create, compile and authorization path at the Dashboard is otherwise sound and well tested, and the three deployment modes agree on routes and timeouts.
2. Fix first: an execution that is created and never started stays at status 0 forever. Existing code reads status 0 as a live run, so the editor locks on reopening the workflow and a Kubernetes unit is never idle-reclaimed. The create has by then already cleared the previous run's results.
3. Fix second: the unit answers a refused request with a `WorkflowErrorEvent`, which the browser shows as the run failing. A READ user of a shared unit gets this from Stop, Checkpoint and the console; "try starting it again" has no button.
4. Fix third: the run compile now executes inside the Dashboard on a request thread, including connections to hosts the request names, with no deadline.
5. After that: the REST shape, a few half-migrated pieces, a comment trim, and commit messages written in terms of briefs and sub-parts.

Everything below is from reading code and git history; nothing was built or run.

**Findings**

1. **blocker — created-but-unstarted executions stay "Initializing" forever.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/service/ExecutionsMetadataPersistService.scala:87` inserts the row at status 0; nothing ever moves it if no start is claimed.
   - Ways in:
     - Stop while "Submitting": `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/frontend/src/app/workspace/service/execute-workflow/execute-workflow.service.ts:469-475` aborts the XHR, but the server still completes the create.
     - A reload, leaving the page, or switching units during the create.
     - The proxy's 120 s timeout.
     - Any start the unit refuses before its claim, including the transient "could not be read; try starting it again".
     - The agent stopping between its two calls (`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/agent-service/src/agent/tools/workflow-execution-tools.ts:330`) or not reaching the unit.
   - Consequences:
     - `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/frontend/src/app/workspace/component/power-button/computing-unit-selection.component.ts:255-266` asks for Running or Initializing executions on every unit selection. It then shows "There are ongoing executions…" and locks the canvas, each time the workflow is opened.
     - `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/computing-unit-managing-service/src/main/scala/org/apache/texera/service/resource/ComputingUnitManagingResource.scala:190-191` counts every non-terminal status as active, so the unit is never idle-terminated. Its own comment at 106-121 calls this permanent.
     - The plan table, with its links and credentials, stays until someone deletes the execution.
   - Change:
     - Give "created" its own status that no reader treats as running, and list it as not-active in the manager.
     - Have the Dashboard expire such rows: take the start claim (`ExecutionPlanStore.claimStart`, so no unit can start it later), mark the row KILLED, drop the plan table.
     - Optionally let the browser and agent abandon an execution at once when a start is refused.

2. **major — the create clears the previous run's results before the new run is started.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/service/execution/ExecutionCreator.scala:257`.
   - Every case in finding 1 therefore also destroys the results the unit still holds and shows; after a reload the page shows a Completed run whose tables are gone.
   - It also runs on the request thread, adding table drops to every "Submitting".
   - Change: clear only what an already-started execution replaced (change the `eid < N` predicate in `ExecutionResources.scala:297`), and do it off the request thread, since its failures are already only logged.

3. **major — a refused request is reported as a failed run.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/resource/WorkflowWebsocketResource.scala:108-114,152-153`.
   - The browser maps every `WorkflowErrorEvent` to Failed and unlocks the editor (`execute-workflow.service.ts:239-245`).
   - Stop and Checkpoint are not gated on unit access (`/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/frontend/src/app/workspace/component/menu/menu.component.html:447-460,481-486`); Run/Pause/Resume are (line 472). Skip, retry and debug commands in `console-frame.component.ts:257,290,298` are not gated either.
   - So a READ user of a shared unit who clicks any of these sees a live run as Failed until the next state event. Upstream had no gate, so this is new behaviour.
   - "try starting it again" (`WorkflowService.scala:124`) is advice no client can follow: the only action is a new create.
   - Change: add a separate event for refusals (request type, optional execution id, message), shown as a toast. Fail the page's run only when a refused start names the execution it just asked to start. Disable the ungated controls without WRITE. Have the browser re-send the start once for the retryable refusals.

4. **major — the run compile executes inside the Dashboard.**
   - Where: `ExecutionCreator.scala:214-217`. Upstream's Dashboard never compiled.
   - Compile runs descriptor I/O chosen by the request. `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/source/sql/SQLSourceOpDesc.scala:128` opens a JDBC connection to the request's host with no connect timeout (`MySQLConnUtil.scala:39`, `PostgreSQLConnUtil.scala:39`); the AsterixDB source issues HTTP.
   - A blackholed host holds a Dashboard request thread past the 120 s route timeout. The service holding the S3 keys, JWT secret and catalog access becomes the origin of user-directed connections.
   - The compiling service has the same exposure for editing, but holds far less.
   - Change: run `PlanToRun.make` on a bounded executor with a deadline below the route timeout (503/504 `{code,message}`, row FAILED), and give compile-time connections a timeout. Or host the run compile in the compiling service and keep only binding at the Dashboard. State it in `docs/security`.

5. **major — REST surface.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/ExecutionResource.scala:72-75,98`.
   - a) Status 400 carries two body shapes, `{code,message}` and `{eid,operatorErrors,errors}`, told apart by shape-sniffing in the browser (`execution-api.service.ts:92-103`) and the agent (`execution-api.ts:128-131`). Keep one shape: `{code, message, eid, operatorErrors}`.
   - b) `errors` is always empty (`CreateExecutionFailure.scala:41`), and graph problems that belong to no operator go out as plain 400s instead. Drop it or use it.
   - c) `operatorErrors` is a map whose key repeats `WorkflowFatalError.operatorId`, and both clients rely on JSON object order. Send a list.
   - d) The update creates a row but answers 200; creates elsewhere answer 201.
   - e) The first path segment after `/executions/` is a wid in every existing route (`/{wid}`, `/{wid}/latest`, `/{wid}/stats/{eid}`) and an eid in `/{eid}/updates`. Say so in the class doc or nest the new routes.
   - f) The 201 echoes `wid` and `computingUnitId`, which no client reads.
   - g) The unit's route is `/api/execution/{eid}/run` (singular) beside `/api/executions`.

6. **major — the engine still depends on the compiler.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/Workflow.scala:23,44`.
   - `fromCompilationResult` is the last compiler import under `amber.engine`, and its only main-code caller is the Dashboard's `PlanToRun.make` (`PlanToRun.scala:148`).
   - Change: move those lines into `PlanToRun.make`.
   - Related: `web.service.execution` mixes Dashboard-only code (`ExecutionCreator`, `OperatorUpdates`, `CostHintsLoader`, `UserEnvironmentResolver`) with unit-only code (`StoredExecutionStart`). The only thing keeping the compile path off the unit is what `ComputingUnitMaster` registers. Split the packages and add one test that the unit's classes do not reference `common.compiler`.

7. **major — new unit-side settings cannot reach Kubernetes units.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/computing-unit-managing-service/src/main/scala/org/apache/texera/service/resource/ComputingUnitManagingResource.scala:351-353,431-447`. The manager forwards a fixed list.
   - Not forwarded: `STORAGE_INPUT_LINKS_ALLOWED_ENDPOINTS`, `UDF_PYTHON_ENVIRONMENTS_ROOT`, `UDF_PYTHON_ENVIRONMENTS_INSTALL_TIMEOUT_MINUTES`, `STORAGE_ICEBERG_TABLE_PLAN_NAMESPACE`.
   - The advertised override `STORAGE_INPUT_LINKS_S3_ENDPOINT` therefore works only half-way on K8s: the Dashboard signs for the other address and units refuse it.
   - None of the new settings appears in the single-node `.env`, Helm values or any README.
   - Change: add them to `optionalComputingUnitEnvNames` and document them.

8. **major — the agent reports a superseded run as a timeout.**
   - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/agent-service/src/agent/tools/workflow-execution-tools.ts:466-469` turns any Killed into "Workflow execution was killed (timeout)."
   - Since this branch, a run superseded by another Run returns Killed at once with no error.
   - Change: use `result.errors` when present; otherwise say the run was stopped or replaced.

9. **minor — a replay may read another user's replay log.**
   - Where: `ExecutionCreator.scala:387-414` requires only the same workflow.
   - Cost hints are deliberately restricted to the caller's own runs. Upstream had no check, so this is already tighter, but the two rules disagree.
   - Change: add `WORKFLOW_EXECUTIONS.UID = uid`, or say why not. Whether a replay log holds data tuples needs checking.

10. **minor — READ on the workflow is enough to create, and public workflows count.**
    - Where: `ExecutionCreator.scala:358`.
    - The execution lands in the workflow's history under the latest version, and its creator cannot delete it (delete needs WRITE).
    - No test covers a public workflow or cross-user clearing on a shared unit. Decide and pin with a test.

11. **minor — `OperatorUpdates.boundFor` builds everything to use two things.**
    - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/service/execution/OperatorUpdates.scala:382-389`.
    - It builds a full `RunBindings` (a `site_settings` SELECT, linker, lister, environment resolver) and a `WorkflowCompiler` to call `bindResources`, which uses only `repositories` and `mountRoot`.
    - Change: make `bindResources` a function of those two. Add a guard test that no operator overriding `runtimeReconfiguration` has a `@SetByCompiler` property.

12. **minor — execution status codes are defined three times.**
    - Where: `Utils.maptoStatusCode` in the engine; `ExecutionResources.EndedStatuses` (`ExecutionResources.scala:63-64`, new); `TerminalWorkflowExecutionStatus` in the manager (`ComputingUnitManagingResource.scala:123-130`).
    - Change: move the mapping and the ended set to `common/dao`, beside the table.

13. **minor — the unit copies the Dashboard's warehouse naming.**
    - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/service/execution/StoredExecutionStart.scala:205-206` matches `user-<uid>-[0-9]+`; `WarehouseResource.scala:58-59` mints it.
    - Change: one shared function.
    - Related: `planUri` puts an internal `vfs://` locator into the public REST answer and the websocket frame. It is acceptable as an opaque locator; say in the response doc that clients must not interpret it.

14. **minor — `PlanToRun` is a one-field wrapper and a grab-bag.**
    - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/amber/src/main/scala/org/apache/texera/web/service/PlanToRun.scala:65`.
    - Its derived `toString` prints the whole plan, credentials and links included.
    - The object also holds `bindingsFor` (deployment wiring) and `settingsProblem` (settings validation).
    - Change: return `String`, or keep the type and override `toString`; move the other two to where they belong.

15. **minor — three near-identical names.**
    - `ExecutionResource` (REST), `ExecutionResources` (an object about storage), `WorkflowExecutionsResource` (REST, same path). In this codebase "Resource" means endpoint.
    - Change: rename `ExecutionResources`, for example to `ExecutionArtifacts`.

16. **minor — test seams as a production idiom.**
    - `object X extends X` with `protected def … // A seam for a spec` appears 17 times in main code (5 in `ExecutionCreator`, 3 in `OperatorUpdates`, 2 in `ExecutionResource`).
    - Upstream's newer code uses constructor or by-name parameters with production defaults (`LiteLLMProxyResource`, `KubernetesClient`). Align.

17. **minor — the plan is cut three times.**
    - Where: `CreateExecutionRequest.scala:68`, `ExecutionCreator.scala:321-324`.
    - The browser cuts client-side and omits `targetOperatorIds`. The agent cuts client-side (`workflow-execution-tools.ts:210`) and also sends the field, so the Dashboard's `upstreamOf` re-cuts an already-cut plan.
    - The field is a list where only a singleton has meaning, and an unknown target silently compiles the whole workflow.
    - Change: pick one place to cut; make it `Option[String]`; answer 400 for an unknown id.

18. **minor — dead code and leftovers.**
    - `ExecutionResources.planUriOf` (`ExecutionResources.scala:117`) is called only by its spec.
    - The `newWorkflowExecuted` session flag is written at `execute-workflow.service.ts:380-389` and read nowhere (upstream's, kept and re-tested here).
    - `FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT` in `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/bin/k8s/templates/base/workflow-compiling-service/workflow-compiling-service-deployment.yaml:45-47`.
    - `MAX_WORKFLOW_WEBSOCKET_REQUEST_PAYLOAD_SIZE_KB` (config, manager forwarding, both values files) existed for the plan-carrying frame that is gone.
    - A stale comment "(sub-part 16)" at `WorkflowWebsocketResourceSpec.scala:1272`.
    - No leftover of the removed requests or pve routes was found in Scala, TypeScript, nginx, Helm or the proxy.

19. **minor — the dev-proxy glob.**
    - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/frontend/proxy.config.json:78-83`.
    - `"/api/execution[s]"` is a character-class trick to match one exact path, there only for `proxyTimeout`. The `/api` entry sets no timeout at all, so the entry only lowers the limit. Delete it.

20. **minor — the plan-size limit differs by mode.**
    - Single-node: nginx's default 1 MB body limit, answered with an HTML 413. K8s and dev: none.
    - Change: set `client_max_body_size` explicitly on `location = /api/executions`, or document it.

21. **minor — one concept, several vocabularies.**
    - Python environment: `virtual_environments`/`veid`, `EnvironmentResource`, `PythonEnvironment`, `envName`, `WorkflowPveService`/`UserPveRecord`/`savePve` (`virtual-environment.service.ts:24,42`), `UserVenvComponent`, `.pve-modal`.
    - Paused change: `/updates`, `OperatorUpdates`, `OperatorUpdateRequest`, answered by `ModifyLogicResponse`, `modifyOperatorLogic`, "reconfiguration registered".
    - Ids: `eid` in REST, `executionId` on the socket.
    - Types: `SyncRunRequest` vs the agent's `RunExecutionRequest`; `CreateExecutionResponse` vs `CreatedExecution`.
    - Rename the TypeScript environment service now; the rest can follow.

22. **minor — user-facing messages.**
    - Style is mixed within one class: "execution 5 has ended" beside "Execution 5 keeps its plan…"; "computing unit 3 is terminated" beside "You do not have access to workflow 12."
    - Field names leak: "computingUnitId is 0" reaches agent users.
    - A network failure shows Angular's "Http failure response for api/executions: 0 Unknown Error", and a spec pins that wording (`execute-workflow.service.spec.ts:515`).
    - "The request's engine version is too long." gives no limit.

23. **minor — a comment trim pass is warranted, in places.**
    - Comment share in new files is 21–53% against roughly 0–32% in untouched neighbours: `PlanToRun.scala` 46%, `ExecutionResource.scala` 47%, `CreateExecutionRequest.scala` 53%, versus `WarehouseResource` 16%, `ResultExportService` 11%.
    - The create's order and status table is written out in `ExecutionCreator`'s class doc, its `create` doc, `ExecutionResource.create`, and the browser's and agent's API files. Keep it once and link.
    - `PlanToRun.make`'s `@throws` spends nine lines restating the codec's rules.

24. **minor — services depend on REST resource companions.**
    - `UserEnvironmentResolver.scala:52` calls `EnvironmentResource.packagesOf`; `ExecutionCreator` calls `WorkflowResource.getWorkflowName`.
    - This is upstream's habit too. A small store object for `virtual_environments` would serve both.

25. **minor — `ExecutionCreator` error handling.**
    - Failures travel three ways: `Left`, thrown JAX-RS exceptions, and a private `ExecutionNotCreated` rethrown by `failingTheExecution`.
    - `failingTheExecution` (`ExecutionCreator.scala:270-285`) catches `Throwable` and writes to the database on fatal errors.
    - `updateLogLocation` swallows its failure, so the plan can name a replay log the row does not. Set the location in the same statement or transaction as the insert.

26. **minor — `CostHintsLoader` is heavy for a hint.**
    - It scans a run's whole statistics table on the create's request path (about 5.4 s for an hour-long run, per the commit message), and that needs the LRU, single-flight and 30 s wait machinery.
    - Change: a per-operator summary written when the run completes would make it one small read. Reasonable to defer to step 3.

27. **minor — `CompileSettings.fromSiteSettings` falls back silently.**
    - Where: `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler/CompileSettings.scala:55-59`.
    - When Postgres does not answer it uses 512, while the rest of the branch makes such failures a 500.

28. **minor — per-user environments on shared workflows.**
    - A collaborator running a shared workflow needs their own environment of the same name ("You have no Python environment named 'ml'."), possibly with different packages. Upstream's per-unit environments worked for everyone on the unit.
    - State this in the PR; consider a message that names the cause.

29. **minor — control requests do not name an execution.**
    - Pause, resume and kill go to "whatever run the unit holds", although state events now carry `executionId`. Send it and let the unit refuse a stale one.

30. **minor — no version signal between Dashboard and unit.**
    - A unit pod or curated image from before the upgrade cannot read `WorkflowStartRequest`. The page stays at Initializing or shows a generic error, and the created row is left at 0.
    - Change: say in the PR that units must be recreated, or have the unit advertise its protocol version in the handshake.

31. **minor — pre-existing, but against the stated goals.**
    - `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/bin/single-node/docker-compose.yml:428-429`: `dashboard-service` still `depends_on` the unit container.
    - The agent addresses units through a Kubernetes DNS template (`workflow-execution-tools.ts:279-280`) instead of the unit's recorded URI.

32. **minor — connection names.**
    - They do not match the OTel service names: "texera-dashboard" vs "texera-web-application", "texera-computing-unit" vs "computing-unit-master". Reuse the OTel names.
    - Make `applicationName` mandatory rather than defaulting to "texera".

33. **minor — tests.**
    - Authorization is pinned at the Dashboard for workflow, unit, warehouse and creator-only updates, with no-row-left assertions. Sampled Dashboard specs showed latch-based waits rather than sleeps.
    - Gaps: public-workflow create; cross-user clearing; replay of another user's execution; anything about abandoned creates; route parity across nginx, gateway and proxy (checked by hand only).
    - Three "be served at …" cases assert annotations by reflection. The behavioural route test in `TexeraWebApplicationSpec` is skipped when Postgres is not reachable at the configured URL.
    - Frontend and agent specs test behaviour (HTTP mock plus socket spy, fetch by route).

34. **The builders' notes.**
    - `OperatorUpdates` reads site settings but applies none: real, harmless today; fix now (finding 11).
    - Pause/Stop not disabled without write access: half true. Run/Pause/Resume are disabled; Stop, Checkpoint and console commands are not. Fix now (finding 3).
    - Unused `FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT` in the compiling service's Helm template: real; delete now.
    - No PATCH handler in the access-control check: real and upstream's (GET/POST/PUT/DELETE exist at 205fe77c4). Separate PR.
    - `Chart.lock` lists minio where `Chart.yaml` lists rustfs: upstream's; the branch touches neither file. Separate fix.
    - Result table stays on page 2 after a re-run: upstream's by the code; the frontend result code is untouched and nothing resets the page index. Not confirmed by running main.
    - A killed operator's box still says Running: upstream's; a kill sets only the workflow state. Follow-up.

35. **minor — shape for upstream.**
    - The 27 commit messages speak of "the brief", "sub-part N", "D29", "gate A", the sce-e2e harness and `sce/texera-*` images. Rewrite them.
    - A 35k-line change will be asked to split. The commits already fall into independent groups: connection naming and status writes; `/api/environments`; plan codec and store; create, start, browser and agent together; links, listing and CSV limit; environment install and pve removal.

36. **minor — adjacent, upstream's.**
    - `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane/access-control-service/src/main/scala/org/apache/texera/service/resource/AccessControlResource.scala:134-136,148` logs every request's headers and the extracted JWT at INFO, while this branch took care to keep tokens out of the unit's log.

**Checked and fine**

- No race between create and start: the plan row is committed before the 201, and the claim tag makes a start single.
- The Dashboard makes no call to a unit.
- A second user cannot start or change another's execution; both paths are creator-only.
- The 401 interceptor covers token expiry on the create.
- Create and update SQL is by primary key or the cuid index.
- No Dashboard endpoint returns plan text.
- `EnvironmentResource` is clean and scoped per user.
- nginx, gateway and dev proxy agree on every route added and removed, and the RustFS alias makes the signed host resolvable from the unit namespace.