Review of the engine side and shared libraries at d7700d580 (read-only; nothing built, run or changed).

All paths are under W = /Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane. Prefixes used below:
- A = W/amber/src/main/scala/org/apache/texera
- C = W/common/workflow-core/src/main/scala/org/apache/texera/amber/core
- K = W/common/workflow-compiler/src/main/scala/org/apache/texera/common/compiler
- O = W/common/workflow-operator/src/main/scala/org/apache/texera/amber/operator
- PROTO = W/common/workflow-core/src/main/protobuf/org/apache/texera/amber/core/storedplan.proto
- T = W/amber/src/test/scala/org/apache/texera
- CT = W/common/workflow-core/src/test/scala/org/apache/texera/amber/core

## VERDICT

1. The goal holds on the unit: on both start paths (socket, agent's sync run) I found no Postgres read, no call to another Texera service and no lookup by name; a second, bottom-up sweep of every sink agrees. No blocker found.
2. Not ready to propose as it stands: about a dozen things a careful maintainer would send back, most of them cheap.
3. First, clean the stored-plan format of the branch's own history and accidents: version 3 and a reserved field in a format never released, operator order tied to Scala's small sets, data stored two and three times.
4. Second, give "a finished run stays finished" one home: it is hand-written four times and missing in four places, which is where three of the seven notes come from.
5. Third, make what the compiler binds safe: presigned links sit in `descString`, test code in the main jar widens the link allow-list, and `Strict` now means "make a plan to run". Then trim the documentation, which is about 1.5 times the neighbours' overall and 2 to 3 times in the small type files.

## FINDINGS

"Inherited" marks a defect older than the branch that the branch touches.

1. **[major] The stored format carries the branch's history.**
   - Where: PROTO:119-121 (`reserved 13; reserved "pveName"`, with a comment about formats 1 and 2); C/workflow/PhysicalPlanCodec.scala:88 (`FormatVersion = 3`); goldens named `*-v3.json`; CT/workflow/PhysicalPlanCodecSpec.scala:1794-1817 (builds "version 1" and "version 2" texts); CT/storage/ExecutionPlanStoreSpec.scala:135,148 (`formatVersion = 2`).
   - Why: formats 1 and 2 exist only in this branch's commits. Upstream would get a first format called 3 with a tombstone.
   - Change: version 1, fields renumbered without the gap, goldens renamed, the old-versions test reduced to "another version is refused".

2. **[major, inherited bug plus new duplication] Finished states are not absorbing.**
   - Where: A/web/storage/ExecutionStateStore.scala:39-52 is the one place every state change passes, and it accepts any transition.
   - The guard is hand-written at A/web/service/WorkflowService.scala:242-249, ExecutionRuntimeService.scala:108-115, WorkflowExecutionService.scala:278-286 and :300-315.
   - It is missing at: pause and resume (ExecutionRuntimeService.scala:79-99); the sync kill (A/web/resource/SyncExecutionResource.scala:381-398, used for timeout, console error and targets-ready); the error handlers (WorkflowService.scala:480-491, ExecutionStatsService.scala:300-317).
   - Effects:
     - A Pause after COMPLETED leaves the run PAUSING for good and writes status -1 to its row (A/amber/engine/common/Utils.scala:160-171).
     - A late Resume also applies queued reconfigurations.
     - A sync timeout that loses the race records a finished run KILLED.
     - Targets-ready writes KILLED then COMPLETED: two row writes and a "Killed" event to every session.
     - An exception in bookkeeping after completion turns COMPLETED into FAILED.
   - Change: in `updateWorkflowState`, return the store unchanged when it is already finished and delete the four guards. Give `WorkflowExecutionService` one `end(state)` used by the kill handler, supersede, the sync resource and `failBeforeStart`. Let targets-ready end COMPLETED directly.

3. **[major] What the compiler binds lives in the descriptor JSON, so links are in `descString`.**
   - Where: O/source/scan/ReadsInputFiles.scala:42-44, plus `maxColumns` and `listing`.
   - (a) With `TEXERA_SERVICE_LOG_LEVEL=DEBUG`, A/amber/engine/common/rpc/AsyncRPCServer.scala:64-66 prints every InitializeExecutor and UpdateExecutor payload, so each presigned link is logged in full. The redaction in C/storage/InputLink.scala:39-40 does not apply to a string.
   - (b) The compile mutates the request's operators, which is why `asSent` (K/model/LogicalPlanPojo.scala:192-195) and the schema filter exist.
   - (c) "The compiler replaces whatever arrived" is promised by O/metadata/annotations/SetByCompiler.java:27-35 but done by hand per type (K/model/LogicalPlan.scala:169, 197, 270, 282). A new marked field that no binder clears passes every test.
   - (d) Expiry and size are stored again in the plan's `inputs` (finding 15).
   - Preferred change: one field on `PhysicalOp` for what the compiler bound (links by name, listing, settings), its own message in the stored plan, handed to the executor beside `descString`.
   - Minimum: clear every marked property generically before binding, add one test over all operator classes, and stop printing those two payloads.

4. **[major] Test code in the main jar widens the link allow-list.**
   - Where: O/TestOperators.scala:83-164 adds a loopback HTTP file server to main sources; its constructor appends itself to the allow-list (:123). The list is a `@volatile var` "because in test we need to override it" (W/common/config/src/main/scala/org/apache/texera/common/config/StorageConfig.scala:94-96).
   - Why: the allow-list is the one control that keeps a plan's link from pointing the unit elsewhere.
   - Change: move the fixtures to test sources (the build already has a test-to-test dependency), make the list a `val`, and pass endpoints through `openInputFile` (C/storage/model/LinkDocument.scala:101-105 already takes them).

5. **[major] A unit-local, Kubernetes-named path is now a Dashboard setting and part of the plan.**
   - Where: A/web/service/PlanToRun.scala:92 reads `TEXERA_MOUNT_IN_POD_ROOT` on the Dashboard; O/udf/UdfUiParameterSupport.scala:75 writes `<root>/<repo>/<commit>` into the UDF code; PROTO:206-211 stores the root; C/storage/RepositoryMountManager.scala:163-179 refuses another root; K/WorkflowCompiler.scala:285-290 names the variable in a user-facing error.
   - Why: before the branch the unit computed this path itself. `RunBindings.mountRoot` assumes one root for every unit. Single-node sets none, so such a UDF now fails at compile time with a Kubernetes variable name.
   - Change: keep the root out of the plan. The plan carries locators and the code carries a path relative to the root; the unit completes it when it hands the worker its code. `StoredRepositoryMounts.root`, `RunBindings.mountRoot` and `requireMountableUnder` then go.
   - Minimum: a neutral configuration key, and no variable name in the message.

6. **[major] "Created for this unit" compares the plan with what the request says.**
   - Where: A/web/service/execution/StoredExecutionStart.scala:138-142. `cuid` is the socket's query parameter (A/web/resource/WorkflowWebsocketResource.scala:62,70) or the REST body (A/web/resource/SyncExecutionResource.scala:165-173).
   - Why: on the socket in Kubernetes the gateway vouches for it. On the sync path nothing does, and that path has no WRITE check on the unit either. Any signed-in user who reaches a unit's port can run their own execution there. The exposure is older than the branch (step 4), but the check reads as protection it does not give.
   - Change: let the unit know its own id where it has one (`TEXERA_CU_ID` is already read at RepositoryMountManager.scala:105; make it optional configuration) and compare with that. Drop `computingUnitId` from `SyncRunRequest`.

7. **[major] `Strict` now means "make a plan to run", and `RunBindings` is half null objects.**
   - Where: K/WorkflowCompiler.scala:536-547 derives linking, listing, resolving and pinning from `errorHandling == Strict`. K/RunBindings.scala:56-85 `forEditing` fills four of seven fields with objects that throw.
   - Why: two switches must agree. When they do not, the `IllegalStateException` of an `Unavailable` binder is reported as the operator's own error (K/WorkflowCompiler.scala:319).
   - Also: the two binders take their options in opposite ways (`bindScanFiles(files, Option[linker])`, `bindListedFiles(Option[lister], linker)`), and all three sit on the plan model with type switches on four operator classes (K/model/LogicalPlan.scala:166-311).
   - Change: a sealed `CompileFor` with `Editing(files, settings)` and `Run(...)`. The compiler takes one and derives both behaviours, with no null objects; the binders move into one compiler pass.

8. **[major] The codec's order rule turns on Scala's `Set1`-`Set4`.**
   - Where: C/workflow/PhysicalPlanCodec.scala:120-121, 393-395. Operators are saved in set order when there are at most four and by id otherwise. The doc (:63-71) says order cannot be kept for larger plans anyway.
   - Change: always by id.
   - Related, minor: each link is stored three times (PROTO:68, 170-174, 181) and checked for agreement (PhysicalPlanCodec.scala:724-776). Store it once.
   - Related, minor: `read` (:968-1000) re-prints, re-parses and diffs the text, with `withDefaultMessages` (:1011-1039) and `difference` (:1048-1086). That is about 140 lines to refuse text this codec did not write, when there is one writer per version. Store protobuf bytes, or drop the byte-shape check; the semantic checks in `decode` are the valuable ones.

9. **[major] Documentation: a trim pass is warranted.**
   - Numbers (comment lines to code lines): the 28 new files 0.46; thirty untouched neighbours 0.30.
   - Touched files, base to head: WorkflowService.scala 0.16 to 0.32; WorkflowExecutionService.scala 0.10 to 0.29; WorkflowWebsocketResource.scala 0.06 to 0.29.
   - Small type files are mostly prose: C/storage/DatasetVersionLister.scala 31 comment lines to 11 code; C/workflow/ResourceBinding.scala 23 to 8; C/storage/InputLink.scala 40 to 21; C/workflow/ExecutionPlan.scala 51 to 33.
   - Examples: A/web/service/PlanToRun.scala:97-125 (28 lines, 9 of them a `@throws` repeating the codec's); PhysicalPlanCodec.scala:205-230 (a 16-line `@throws` listing every check); WorkflowExecutionService.scala:171-187.
   - "The unit asks no service" is restated in at least eight docs: InputLink.scala:26-28, DatasetVersionLister.scala:35-37, ReadsInputFiles.scala:29-32, LinkDocument.scala:80-82, C/workflow/PythonEnvironment.scala:69-72, K/CompileSettings.scala:27-29, CostEstimator.scala:53, WorkflowEmailNotifier.scala:100. One sentence is pasted on twelve proto messages.
   - Change: say the design once, keep member docs to what the signature does not say, drop `@throws` lists that enumerate validations.

10. **[major] Tests: the spec that carries the claim has limited reach, and several risky behaviours are not pinned.**
    - Reach of T/web/service/UnitStartReadsNoPostgresFixture.scala:372-384, 421-446:
      - It hears jOOQ through `SqlServer` only (W/common/dao/src/test/scala/org/apache/texera/dao/StatementRecorder.scala:37-40): not raw JDBC, not the Iceberg catalog's pool, not the Python process.
      - It starts at `startStoredExecution`.
      - Before RUNNING it checks only each statement's verb, so an UPDATE with a subselect passes.
      - After RUNNING it allows SELECTs on the three run-state tables.
      - It does not run: the sync start, a stored update, an environment install, replay, a mount.
      - Change: add those five cases to the same fixture (FakePython stands in for pip).
    - Not pinned at all:
      - Late pause and resume.
      - The sync timeout kill, and a superseded sync run returning at once.
      - `prepare()` with two environments: completing after the first would pass every case (A/web/service/ExecutionEnvironmentService.scala:191).
      - The installer's other-process lock arm and lock-wait deadline (PythonEnvironmentInstaller.scala:227-238).
      - The general reset of `@SetByCompiler` properties.
      - A plan at real link length: the 10,000-file case uses 70-character links, and ExecutionPlanStoreSpec pins a 4 MiB body.
    - T/web/service/ExecutionResultServiceSpec.scala:1228-1235 sets `resultUpdateCancellable` by reflection before every engine event, which hides finding 20.

11. **[major] File Scan From Input: a compatibility break, and more links than it reads.**
    - Where: K/model/LogicalPlan.scala:261-311; O/source/scan/file/FileScanOpExec.scala:42-49.
    - It reads only names a File Lister upstream lists. That follows from the design, but it breaks workflows that compute names; call it out in the proposal.
    - It is linked to every listed file whatever it will read: up to 10,000 bearer links per operator, each valid 7 days by default (W/common/config/src/main/resources/storage.conf:157), kept in the plan table until the execution is deleted.
    - Change: default lifetime in hours; keep 7 days as the cap.

12. **[major] Status e-mail rides in the plan row and is sent by the unit.**
    - Where: the `notification` column (C/storage/ExecutionPlanStore.scala:53-65) holds an address, a workflow name and a Dashboard URL so that the unit can send SMTP with the site's credentials (A/web/service/WorkflowEmailNotifier.scala:121-134).
    - Why: that is personal data in the lake, in a column headed for removal once the Dashboard sees run state.
    - Inherited: the only trigger is the engine's own state event (ExecutionRuntimeService.scala:65-70), which carries COMPLETED and PAUSED. No failed or killed run has ever mailed, though WorkflowEmailNotifier.scala:111-116 lists both.
    - Change: drive the notifier from the run's state store after finding 2; say in the proposal that it moves to the Dashboard.

13. **[major, inherited, narrowed by this branch] A killed or failed run leaves its scans' temporary copies.**
    - Where: `executor.close()` runs only on normal completion (A/amber/engine/architecture/worker/DataProcessor.scala:197); `WorkflowWorker.postStop` (:151-156) does not close.
    - Copies come from C/storage/model/LinkDocument.scala:172-184. For CSVOld and ParallelCSV they are made in the constructor, a whole file per worker (O/source/scan/csvOld/CSVOldScanSourceOpExec.scala:38, O/source/scan/csv/ParallelCSVScanSourceOpExec.scala:41).
    - Change: close the executor in `postStop`, which also frees SQL sources' connections on kill.

14. **[minor] Environments default to /tmp and are never evicted.**
    - Where: W/common/config/src/main/resources/udf.conf:37.
    - Why: `installedIn` (PythonEnvironmentInstaller.scala:150-157) trusts the marker plus the interpreter. The marker is the youngest file, so on hosts that clean /tmp by age it can outlive the packages, and nothing reinstalls.
    - Change: default under the unit's working directory now; eviction can follow.

15. **[minor] Carried but not consumed.**
    - `ExecutionPlan.inputs` has one reader, StoredExecutionStart.scala:153, for the earliest expiry.
    - `sizeBytes` on `InputLink`, `ListedFile` and `InputFile` is never read.
    - PROTO:257-262 is a `oneof` with one arm and a comment reserving 4.
    - `StoredPythonEnvironment.digest` (PROTO:221-222) is stored, then recomputed and compared (PhysicalPlanCodec.scala:619-624).
    - Plan row: `kind` is derivable from `entryId`; `formatVersion` is in a column and in the body; `createdAt` is read by nobody; the unit reads `logical`, which it never uses (ExecutionPlanStore.scala:317).
    - Cost hints sit on `WorkflowContext` (C/workflow/WorkflowContext.scala:43) while replay, replay log and inputs sit on `ExecutionPlan`.

16. **[minor] Dead code and leftovers.**
    - `ExecutionPlanStore.isStarted` (:283-286) is used by tests only.
    - `StateTransferFunc` and the second half of `runtimeReconfiguration`'s result (O/LogicalOp.scala:161, 503): six descriptors build it, and its one caller drops it (A/web/service/execution/OperatorUpdates.scala:354).
    - Checks a decoded plan cannot fail: `requireResourcesBound` at WorkflowExecutionService.scala:101, ExecutionReconfigurationService.scala:151, 187 and RegionExecutionManager.scala:381; `requireEnvironmentResolved` at :102; the `Named` arm at PythonEnvironmentInstaller.scala:133-137.
    - `CheckedStart.cuid` feeds one log line.
    - `RepositoryMounts.byRoot` groups by root where a unit allows one.
    - WorkflowExecutionService.scala:164 logs "Initialing an AmberClient" where none is made.

17. **[minor] `sessionUri` is a leftover.**
    - Where: WorkflowService.scala:327-336, 354-357, 422-426.
    - Why: a URI crosses three layers to end one log line. It is stripped of secrets twice, and the REST path invents `sync-execution://<wid>` to have one (SyncExecutionResource.scala:173).
    - Change: log at the entry point; `withoutSecrets` (StoredExecutionStart.scala:170-187) goes too.

18. **[minor] The engine package still imports the compiler.**
    - Where: A/amber/engine/architecture/coordinator/Workflow.scala:23, 44-59, for `fromCompilationResult`. Its only caller is the Dashboard half (PlanToRun.scala:148), which copies the context first because that function mutates it (:139-146).
    - Change: inline three lines in `PlanToRun.make`.
    - Also: `Workflow` is now the first two fields of `ExecutionPlan`; `PlanToRun` is a one-String case class (:65) read once.
    - Also: unit-side and Dashboard-side classes share `web.service` and `web.service.execution`. Split by package, so a test can assert that the unit imports no compiler.

19. **[minor, inherited shape] `WorkflowExecutionService` is built in two phases with null `var`s.**
    - Where: :161-169; readers defend at WorkflowWebsocketResource.scala:227 and SyncExecutionResource.scala:216, 385.
    - Why: `startStored` builds the services outside any try (:204-227). If a constructor after the client throws (ExecutionStatsService.scala:77-91 creates an Iceberg table), the next start's supersede hits a null in `unsubscribeAll` (:353-364) and fails that next run with a NullPointerException.
    - Change: build one `Option[RunServices]`; shut the client down on failure.

20. **[minor, inherited] A/web/service/ExecutionResultService.scala:315 dereferences a possibly null `resultUpdateCancellable`.** Its neighbours at :303 and :325 are guarded. See note 3 below.

21. **[minor] Duplicated logic.**
    - The plan-URI check: StoredExecutionStart.scala:194-202 and ExecutionPlanStore.scala:294-308.
    - The per-user warehouse name: built at A/web/resource/dashboard/user/warehouse/WarehouseResource.scala:59, matched by regex at StoredExecutionStart.scala:205-206.
    - The format version is checked in three places.
    - `applyStoredUpdate` (A/web/service/ExecutionReconfigurationService.scala:94-169) repeats the start's record checks with nine early returns where `StoredExecutionStart` uses an `Either` chain.
    - "Close every console writer" appears three times (ExecutionConsoleService.scala:218-225, 262-268, 272-280).
    - The temp-copy code is in LinkDocument.scala:172-185 and C/storage/model/LakeFSFileDocument.scala:111-127.
    - SHA-256 hex is written three times; `pythonLiteral` duplicates pybuilder's `pyStringLiteral`.
    - Seven finished-state sets exist.

22. **[minor] Names.**
    - One artefact is called "stored plan", "saved plan", "plan to run", `ExecutionPlan` and `PlanRecord`. `PhysicalPlanCodec` encodes `ExecutionPlan`s into `StoredPhysicalPlan`. Pick "stored plan": `StoredExecutionPlan`, `ExecutionPlanCodec`.
    - `OperatorUpdateRequest` is answered by `ModifyLogicResponse` (WorkflowWebsocketResource.scala:112).
    - `RunBindings.forEditing` contradicts its own type name.
    - There are two `requireRunnableUnder` (PhysicalPlanCodec.scala:346, WorkflowExecutionService.scala:99) and two `planUriOf`.
    - `cuid` sits beside `computingUnitId`; RepositoryMountManager.scala mixes "pod" and "computing unit".
    - O/udf/python/PythonUDFOpDescV2.scala:165 says "Virtual Environment" for what everything else calls a Python environment.

23. **[minor] User-facing messages.**
    - Refusals from the unit's web layer are lower-case fragments. "workflow is not initialized" covers two conditions (WorkflowWebsocketResource.scala:187, 189). The codec and operators use sentences.
    - One condition has two wordings: "unknown plan format 2; this unit reads 3" and "The plan is in format version 2, but this reader reads version 3."
    - "has no stored plan" is built in four places.
    - Two messages name environment variables.
    - Failures after the claim reach the user as `t.toString`, class name first (WorkflowService.scala:485).
    - FileScanOpExec.scala:45 throws `java.io.FileNotFoundException` where the rest use vfs2's.

24. **[minor] Paths taken from a plan.**
    - C/workflow/RepositoryMounts.scala:61-69 accepts any non-empty repository and commit, and RepositoryMountManager.scala:150-153 resolves them without normalising. `../..:x` or `/etc:x` names a path outside the root. On the unit the path is only tested for being a mount; I did not read the mount authority's own check. Change: restrict both parts to `[A-Za-z0-9._-]+`.
    - The replay source and replay log are only required to be absolute (PhysicalPlanCodec.scala:848-852) and are read and written by scheme, while links from the same plan are held to an allow-list. Change: require them under the unit's log root, or state why the link is the exception.

25. **[minor] pip.**
    - A/amber/engine/architecture/pythonworker/environment/ProcessRunner.scala:71-72 gives pip the unit's whole environment, and nothing passes `--only-binary`. A source distribution's build code therefore runs with the unit's secrets. A UDF can already read them, so this belongs on step 5's list.
    - The first run of an environment calls the package index: the one outbound call a start can make. Document it for units without egress.

26. **[minor] `constants.max-listed-files` has unstated ceilings.**
    - Every worker of a File Scan From Input is sent the whole link map in one message; cluster mode drops messages above 30 MiB (W/common/config/src/main/resources/cluster.conf:59).
    - At 10,000 files a plan with one lister and one scan is about 8 MB, and at about 50,000 the init message passes 30 MiB. Both are my estimates from 400-character links, not measured.
    - Change: state the ceiling beside the key.

27. **[minor, inherited] Scan executors infer their schema again from the file.**
    - Where: O/source/scan/csv/CSVScanSourceOpExec.scala:46, O/source/scan/json/JSONLScanSourceOpExec.scala:45, and the two in finding 13.
    - Why: the plan already holds the port's schema, so this is an extra GET per worker.
    - Change: hand the executor the plan's schema.

28. **[minor] Tests: duplication and weight.**
    - Refusal messages are asserted in four specs (StoredExecutionStartSpec, WorkflowServiceSpec, WorkflowWebsocketResourceSpec, SyncExecutionResourceSpec).
    - Binder rules are in LogicalPlanSpec:615-1275 and again in WorkflowCompilerSpec:1901-2460.
    - Each codec rule is checked both ways, with about 140 verbatim-message assertions.
    - SavedPlanSpec runs 13 workflows twice, though every e2e spec already runs the plan read back (T/amber/engine/e2e/TestUtils.scala:141-156).
    - WorkflowWebsocketResourceSpec (829 to 1660 lines) compiles, writes plan tables and builds a coordinator per case, for refusals that StoredExecutionStartSpec pins as pure functions.
    - PresignedLinkObjectStoreSpec starts a container for four cases that test the store's signature checks, not Texera.

29. **[minor] Tests that depend on timing (read from code, not run).**
    - T/amber/engine/architecture/pythonworker/environment/ProcessRunnerSpec.scala:69-79: a 300 ms limit must cover a shell start.
    - ExecutionEnvironmentServiceSpec:387-410: 50 ms reminders.
    - WorkflowExecutionServiceSpec:1186, 1226, 1250: `Thread.sleep(300)` negatives that can pass vacuously.
    - LinkDocumentSpec:287-298, 379-391: 1 s expiry windows.
    - LinkDocumentSpec and ScanExecutorInputLinkSpec count `inputFile*` in the shared temp directory, so another JVM breaks them.

30. **[minor] Test hygiene.**
    - W/amber/src/test/integration/org/apache/texera/amber/engine/e2e/PythonEnvironmentIntegrationSpec.scala:131, 153-160 uses the unit's real root and uninstalls there. The key ignores the name, so it deletes a developer's own `tabulate==0.9.0` environment.
    - Goldens are regenerated only by copying a temp file that a failed assertion names.
    - Helpers are copied: `NoHints`/`FixtureCreator` three times, `TestAmberClient` twice, `whileDatabaseUnreachable` four times.
    - Seams added to main for tests: WorkflowService.scala:108, 296-297, 303; WorkflowExecutionService.scala:337, 342; ExecutionReconfigurationService.scala:172; SyncExecutionResource.scala:134; ExecutionPlanStore.scala:241. There are two different seams for the same plan read, and the REST path uses only the default argument.

31. **[minor, inherited] `PartitionRule.FirstInput`.** See note 7.

32. **[minor] Comments that tell history or are stale.**
    - PROTO:119.
    - C/workflow/PhysicalOp.scala:166: "left out as the function it replaced was".
    - WorkflowService.scala:229-230: "as they did before a superseded run was recorded".
    - Workflow.scala:40-42: an engine doc narrating the Dashboard's flow.
    - K/WorkflowCompiler.scala:250: "the engine `Workflow` wrapper stays in amber", no longer true.
    - T/web/resource/WorkflowWebsocketResourceSpec.scala:1272: "sub-part 16".
    - PythonEnvironmentInstaller.scala:431 names the key `udf.python.environments.root`; it is `python.environments.root`.
    - Main code is otherwise free of process words.

33. **[minor] Formatting.**
    - Inline fully qualified names where neighbours import: SyncExecutionResource.scala:213, 234, 382, 402; WorkflowService.scala:419.
    - `return` out of a catch at WorkflowExecutionService.scala:198-202.
    - Three JSON libraries in new code: Jackson, json4s in the codec, and play-json for the three-field `Notification`.

**Fine, one line each:**
- `ExecutionPlanStore`: the tag as the claim, URI validation, and missing table kept apart from catalog failure.
- `LinkDocument`: endpoint check before connecting, no redirects, expiry.
- `PythonRequirements`, and its re-check on decode.
- The installer's concurrency: I found no race that corrupts an install.
- The start under `runLock`: the check-then-start after an install is benign, because a stopped client drops the command.
- `PartitionRule` as data; `InputLinker` and `DatasetVersionLister` as seams.
- The Python changes.

## THE SEVEN NOTES

1. **Late pause or resume: real; fix now.** Finding 2. No test either way.
2. **Sync timeout kill: real but narrow; fix with note 1.** Same unguarded function.
3. **Null `resultUpdateCancellable`: real as a latent defect, but not reachable through fail-before-start.** That path changes the store. Line 315 sits in the callback for the engine's own state event, which has three emit sites and carries only COMPLETED and PAUSED. It would need COMPLETED before the start answer on the first run a service holds, which I could not construct. If it happened, `AmberClient.registerCallback` (A/amber/engine/common/client/AmberClient.scala:142-149) would hand the NullPointerException to the error handler and a completed run would read FAILED. One-line guard; do it now.
4. **Temp copies on kill: real; worth the small fix.** Finding 13.
5. **Environment eviction and /tmp: real; change the default now, evict later.** Finding 14.
6. **No e-mail on fail-before-start: real, as a special case of an older gap.** No failed or killed run mails at all. Finding 12. Not blocking.
7. **`FirstInput` in hash-map order: real and inherited; not worth changing in this branch.**
   - Where: A/amber/engine/architecture/scheduling/resourcePolicies/ResourceAllocator.scala:183-193.
   - The branch documents it and pins it (ResourcePoliciesSpec:269-289).
   - Sorting by port would change the output partitioning of every two-input operator on the default rule, so do it separately.
   - Note that the name now goes into the stored format.

## KUBERNETES

- One assumption widened: the mount root (finding 5). It was the unit's; it is now also the Dashboard's, the compiler's and the format's.
- Nothing else new is Kubernetes-only. Links, listings, environments and the start by id are plain configuration and lake access.
- Two older shape assumptions remain: `ServletAwareConfigurator` picks its mode by header presence, and environments and FUSE mounts assume workers share the coordinator's node (`PreferCoordinator`, K/WorkflowCompiler.scala:347-351).

## POINT 1: WHAT THE UNIT STILL READS OR CALLS

**UNEXPECTED: none.** Two things a start can touch that are not Texera's database or services:
- The package index, on the first use of an environment.
- Postgres as the Iceberg catalog when `storage.iceberg.catalog.type=postgres`. This is lake metadata, and invisible to the no-Postgres spec.

**Step 3 (run state):**
- Status UPDATE on every state change: ExecutionStateStore.scala:39-52. Write.
- `runtime_stats_uri` UPDATE at start: ExecutionStatsService.scala:88. Write.
- INSERT into `operator_port_executions` per stored port at region launch: ExecutionResultService.scala:338-342. Write.
- INSERT into `operator_executions` on an operator's first console line, including install messages before the engine starts: ExecutionConsoleService.scala:163-167. Write.
- Each result poll: SELECT result URIs, UPDATE size and count (ExecutionResultService.scala:472-519). Read and write.
- Each result change: SELECT stats and console URIs, then UPDATE sizes (:377-389). Read and write.
- Result paging: SELECT the result URI (:421-425). Before the service has attached to a run, also the newest execution by workflow and unit (:418). Read.
- End of a sync run: SELECT result and console URIs (SyncExecutionResource.scala:522-526, 802-816). Read.
- Idle clean-up: SELECTs and DELETEs of the run's rows (WorkflowService.scala:214-220, into A/web/service/execution/ExecutionResources.scala:192-234). Read and write.
- `GET /api/executions/{wid}/stats/{eid}`, routed to units: access checks and the stats URI. Read.
- The TTL job, from 2 s after boot, selects every unit's executions and rewrites rows read-then-write (A/web/ComputingUnitMaster.scala:192-197, 236-250). Inherited.

**Step 5 (credentials, mounts, UDF code, export):**
- Mounts: POST to access-control with the unit's `USER_JWT_TOKEN`, at region launch and on resume after a change that names mounts (RepositoryMountManager.scala:93-132).
- `pytexera.DatasetFileDocument` calls file-service by path with the same token (W/amber/src/main/python/pytexera/storage/dataset_file_document.py:91-177). This is the only by-name resolution left, and only from UDF code.
- Export: reads rows, may insert a workflow version, and POSTs to file-service with a token the unit mints (A/web/service/ResultExportService.scala:546-559).
- SMTP for status mail (finding 12).
- The Python worker is handed the S3 keys and inherits the unit's environment.
- The JWT signing secret is on the unit.

**Boot:**
- The Postgres pool (ComputingUnitMaster.scala:140-145).
- No user-table read by any auth path.
- `checkip.amazonaws.com` in cluster mode only.

**Lake, as designed:**
- Plan row read, `started` tag commit, update row read.
- Statistics, console, result and state tables.
- Presigned GETs at the allowed endpoint.
- Large binaries.
- Replay logs at the plan's URIs.

**Inherited, not on the run path:** the unit registers the whole `WorkflowExecutionsResource` (ComputingUnitMaster.scala:199), though only stats and export are routed to it. Delete, rename, bookmarks and history are live on its port.

## NOT VERIFIED

- Whether the mount authority validates repository names.
- Whether `LinkDocument`'s endpoint parsing accepts host names `java.net.URI` rejects (an underscore).
- The size estimates in finding 26.
- Every flakiness claim: no test was run.