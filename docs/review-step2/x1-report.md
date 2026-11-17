Batch X1 is finished: six commits on `feat/self-contained-engine` in `/Users/jiadongb/Desktop/projects/texera-worktrees/self-contained-engine`, worktree clean, nothing pushed. The full suite ran once at the end with no failure; only the known `IcebergRestCatalogIntegrationSpec` abort remains.

## Commits
- `3ec12bad6` refactor(workflow-core): store a plan in one format, once
- `062c29ae7` refactor(amber, workflow-operator): keep the unit's mount root out of the plan
- `886100733` fix(workflow-core, amber): give a stored plan a size limit the listing cap fits
- `175ff1917` fix(amber): refuse a plan whose replay logs are not where the unit keeps them
- `a083c95eb` refactor(workflow-core, amber): name a user's warehouse in one place
- `7943df959` refactor(amber): hand a made plan over as its text

## Findings
- **E1** fixed: the format is version 1 (it called itself 3), with no gap and no `reserved`; goldens are renamed `*-v1*.json`; any other version is refused.
- **E8** fixed: operators are saved in id order. Links stay in the plan's existing `links` list and the per-port copies are gone; the list is saved in an order each port's own order is read from. `read` parses once and checks the version once; `decode`'s checks stay.
- **E15** fixed: gone are `sizeBytes` (link, listed file, input), the one-arm `oneof`, the stored environment digest (derived), and the plan-row columns `kind`, `formatVersion`, `createdAt`. The unit no longer reads `logical`. `ExecutionPlan.inputs` is kept, with unread fields removed only.
- **E15, cost hints** left on `WorkflowContext`: the only reader is the scheduler's `CostEstimator` through the context, so moving them needs a new path into the engine and is not the smaller shape.
- **E5** fixed: see below.
- **E24** fixed, both parts: a locator's repository and commit must each match `[A-Za-z0-9][A-Za-z0-9._-]*`, the mount authority's own rule. A replay source or replay log outside the unit's log location is refused at start.
- **E10/E26 (size)** fixed: see numbers below.
- **D13** fixed: `UserWarehouse.nameOf` / `isOwnedBy` in workflow-core is used by `WarehouseResource` and by the unit's start check. `CreateExecutionResponse` says `planUri` is opaque to clients.
- **D14** fixed: `PlanToRun.make` returns the text and the wrapper class is gone; `PlanRecord.toString` leaves the body out.
- **E16/E21** fixed: checks a decoded plan cannot fail, `RepositoryMounts.byRoot`, the duplicated plan-URI check (now `ExecutionPlanStore.planTableOf`), the version checked three times, and SHA-256 hex written three times (now Guava).
- **E16, `ExecutionPlanStore.isStarted`** left: step 3's design names it (`sce-e2e/docs/step3-design.md` line 1717).

## E5 mechanism
- **Plan:** pinning a dataset or model writes the locator `<repositoryName>:<commitHash>` as the parameter's value, encoded as that language's injector encodes any value. The operator lists its locators directly as `repeated string repositoryMounts`.
- **Unit:** `UdfRepositoryDirectories.mountedUnder(root)` swaps each encoded locator for the encoded mount directory. It runs once in `startStored` before the engine is built, and again for each stored change to a paused operator. Workers get the same code as before, so the parameter is still a path, in Python, R and Java.
- **Removed:** `StoredRepositoryMounts`, `RunBindings.mountRoot`, `requireMountableUnder`, `byRoot`, and the Helm env on the Dashboard.
- **Unit without a mounter:** a run that reads a dataset or model fails at start, before any region, with "Operator X reads datasets or models (repo:commit), which this computing unit cannot mount." A stored change that reads one is refused with the same text. Plans that read none are unaffected.
- **Not verified against a real R runtime:** the R path is covered only by comparing generated code strings; the R integration case is cancelled in this environment.

## Plan size
- A plan-table row body is at most 16 MiB (`ExecutionPlanStore.MaxBodyBytes`). That is below the JSON reader's 20,000,000-character string limit and the 30 MiB cluster frame.
- At the default cap of 10,000 files with 600-character links, a plan measured 10,522,913 bytes (about 10 MiB). That works out to roughly 450 bytes per file plus the link, for paths of about 100 characters.
- By that arithmetic, links up to about 1,200 characters fit at the cap, and about 15,900 files fit at 600-character links. These ceilings are for whoever documents `constants.max-listed-files`.
- A larger plan is refused before anything is written. `POST /api/executions` answers 400 and marks the row FAILED: "Execution N could not be created. The plan is X MiB, and a stored plan may be at most 16 MiB. A plan holds a link to each file its operators read, so a workflow that lists fewer files makes a smaller plan."
- Pinned by specs:
  - the store keeps exactly 16 MiB and refuses one byte more;
  - the codec reads a 16 MiB plan that is nearly one string;
  - a plan at the cap with 600-character links is stored, passes `checkStoredStart`, and builds its scan's executor.

## Externally visible changes
**Stored format**
- `formatVersion` is 1.
- Fields at their default are omitted from the JSON.
- `StoredPhysicalOp.repositoryMounts = 13` is `repeated string`; `pythonEnvironment = 14` is `{name, requirements}`.
- Stored ports are `{port, schema}`.
- `StoredPlanInput` is `{logicalOperatorId, name, expiresAtMs}`.
- `StoredOperatorUpdate.repositoryMounts = 6` is `repeated string`.
- Links in descriptors are `{url, expiresAtMs}`.

**Plan table**
- Columns are `entryId, body, logical, createdBy, computingUnitId, notification`.

**REST**
- `POST /api/executions`: the 400 above for an oversized plan. A UDF reading a dataset on a deployment without a mounter now creates (201) and fails at the unit's start; before, the compile failed naming `TEXERA_MOUNT_IN_POD_ROOT`.
- `POST /api/executions/{eid}/updates`: 400 "The change is X MiB, and a stored change may be at most 16 MiB."; the no-mount-root 400 is gone.

**Unit start and paused changes (new messages)**
- "the plan replays the log at URI, outside where this computing unit keeps replay logs"
- "the plan writes its replay log to URI, outside ..."
- "..., and this computing unit keeps no replay logs"
- the cannot-mount message above
- "The code of operator X does not name L, which its plan says it reads."
- "Operator X reads datasets or models (...), but it is no UDF whose code names them."
- "The plan is in format version N, but this reader reads version 1."
- Removed: both messages that named `TEXERA_MOUNT_IN_POD_ROOT`.

**Configuration and Helm**
- `bin/k8s/templates/base/webserver/webserver-deployment.yaml` no longer sets `TEXERA_MOUNT_IN_POD_ROOT`; the unit manager still does. `helm template` renders with the mounter on and off.
- No new keys or values, no route change, no new status value.
- A unit now needs `fault-tolerance.log-storage-uri` (`FAULT_TOLERANCE_LOG_STORAGE_URI`) covering the Dashboard's log location to start a plan that names replay logs.

## Tests
| Module | Passed | Notes |
|---|---|---|
| Config | 105 | |
| DAO | 51 | |
| WorkflowCore | 1142 | 1 pending |
| WorkflowOperator | 3050 | 1 cancelled, 2 pending |
| WorkflowCompiler | 194 | |
| WorkflowCompilingService | 77 | |
| AccessControlService | 90 | |
| ComputingUnitManagingService | 321 | |
| ConfigService | 43 | |
| FileService | 481 | |
| amber unit | 2674 | 1 pending |
| amber integration | 56 | 1 cancelled, `IcebergRestCatalogIntegrationSpec` aborted, as in the baseline |

Format checks pass. Behaviour changes in the last five commits were checked by breaking the code by hand (about 25 mutations, all caught).

## Open issues
- Update rows still store `logical` (the operator as changed). Nothing reads it and step 3 does not name it; I kept it as the only record of what a pause changed. Say if it should go.
- A unit with a mount root but missing the access-control URL, unit id or user token still fails at region launch with upstream's "<VAR> is not set in this computing unit." I left upstream's manager alone.
- `WorkflowCompiler.bindPlanResources` still catches `IllegalStateException`; only the "unavailable" resolver raises it now, and E7 removes that.
- The directory swap matches the encoded locator literal, so a plain string parameter whose value is exactly a locator the same UDF reads would be swapped too.
- A deployment that moved its replay-log root can no longer replay logs kept under the old root, and the chart sets that key for neither service.
- The plan-size spec reads links through the descriptor helper in `ExecutionResourceSpec`; batch P will move those links.