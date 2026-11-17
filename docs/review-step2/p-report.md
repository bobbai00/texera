Pieces 1 to 4 of the batch are committed and green; piece 5 (the rest of X2) was not started, so there is no `wip:` commit and the tree is clean at `c5511fab0`.

## Commits on `feat/sce-step2-lane`
- `14f7b6196` refactor(workflow-core, amber): give every output port its location in the plan
- `542bdd710` refactor(workflow-operator, amber): hand an executor its inputs beside its descriptor
- `b840244fa` refactor(workflow-compiler, amber): compile a workflow for editing or for a run
- `c5511fab0` refactor(workflow-operator, amber): keep the link allow-list out of test code's reach

The whole suite script ran after commit 2 and again on the tip as it stood before one late fix. Both runs match the baseline: only `IcebergRestCatalogIntegrationSpec` aborts, and one integration case is cancelled.

The late fix: commit 3 had accidentally deleted two unrelated cases from `LakeFSInputLinkerSpec`. I restored them by amending commit 3 and replaying commit 4, so the tip differs from the suite-tested tree by those 26 test lines. That spec and both format checks pass on the tip.

Counts on the last whole-suite run:
- **Common:** Config 106, DAO 55, WorkflowCore 1151 (1153 with the two restored cases), WorkflowOperator 3047, WorkflowCompiler 187.
- **Services:** 90, 77, 481, 43, 325.
- **Amber:** unit 2687, integration 56.

Not run: Python tests (pyamber untouched; only the generated proto gains two fields), the frontend and agent suites, and the end-to-end harness.

## Design as it landed

**Port locations (piece 1).**
- `PhysicalOp.storageLocations` holds a URI for every output port of every physical operator.
- The compiler assigns them as the last step of a run compile, using the same URI the scheduler used to build.
- They are stored as `StoredOutputPort.storageLocation = 3`. The codec refuses a port without one, and on read refuses one that does not decode to the plan's workflow, execution, warehouse and that port.
- `CostBasedScheduleGenerator` reads the plan's location. An update keeps the running operator's.
- `EngineBoundarySpec` pins that no class under `amber.engine` references `createPortBaseURI` or `withStorageLocations`.

**Operator inputs (piece 2).**
- `OperatorInputs` in `executor.proto` holds the files (name, link, expiry), a File Lister's listing, and the CSV column limit.
- It sits on `PhysicalOp.inputs` and is stored as `StoredPhysicalOp.inputs = 15`. The plan-level list is gone; the start check reads the earliest expiry from the operators.
- One compiler pass, `InputBinder`, finds them before expansion.
- The engine sends them in `InitializeExecutorRequest.inputs = 5`. The worker wraps them in `ExecutorInputs`, and `ExecFactory` passes that to executor constructors `(String, ExecutorInputs[, Int, Int])`.
- Executors call `inputs.open(name)`, `hasFile`, `listing` and `csvParserMaxColumns`. An executor built for an update or restored from a checkpoint keeps its worker's inputs.
- `InputFile.toString` drops the link's query, so no log line prints a signature, including the RPC DEBUG trace.
- `@SetByCompiler`, `ReadsInputFiles`, `asSent` and the schema filter are removed.

Operator block, from the golden file (schema trimmed):
```json
"outputPorts": [{"port": {...}, "schema": {...},
  "storageLocation": "vfs:///wh/wh-1/wid/7/eid/42/globalportid/(logicalOpId=scan,layerName=main,portId=0,isInternal=false,isInput=false)"}],
"inputs": {
  "files": [{"name": "dataset:///ds-1/d4t4/a.csv",
             "url": "http://texera-rustfs:9000/texera-dataset/a?X-Amz-Signature=...",
             "expiresAtMs": "1763856000000"}],
  "listing": {"files": ["/dataset/a@x.io/ds/v1/a.csv"]},
  "csvParserMaxColumns": 512
}
```

**How a descriptor reads a file during a compile.**
- It works as upstream does: the compile resolves a scan's `fileName` in place and the descriptor opens the resolved file itself, with no link.
- So `descString.fileName` is still the resolved `dataset:///` URI, which is also the `InputFile` name. This is a judgment call against a strict reading of "the descriptor is what the user wrote". I kept it because schema inference and the Python export both read the resolved name.
- The one compile-found value a descriptor needs, the CSV limit, is an argument: `LogicalOp.getPhysicalPlan(wid, eid, inputs)`, which the CSV scan overrides.

**Compile purpose (piece 3, E7).**
- Sealed `CompileFor.Editing(files, settings)` and `CompileFor.Run(files, settings, inputLinker, lister, repositories, environments)` replace `CompilationErrorHandling`, `RunBindings` and the four `Unavailable` binders.
- The call is now `new WorkflowCompiler(context, purpose).compile(pojo)`.
- `WorkflowCompiler.bindResources(op, repositories)` is a plain function.
- `PlanToRun.make(context, bindings, plan, replay, replayLog)` is the run compile's single entry point, and `PlanToRun.bindingsFor(uid)` returns a `CompileFor.Run`.

**Link allow-list (piece 4, E4).**
- `StorageConfig.inputLinksAllowedEndpoints` is a `val`, and `LinkDocument` takes endpoints with no default.
- The endpoints travel `CoordinatorConfig.inputLinkEndpoints` (defaulting to the unit's) → `InitializeExecutorRequest.inputLinkEndpoints = 6` → `ExecutorInputs`.
- The fixture file server, linker and lister moved to test sources as `FixtureInputs`. The compiler's and amber's tests reach it through a test-to-test dependency.
- Engine tests on fixture files use `TestUtils.readingFixtureLinks`.

## Externally visible so far
- **Stored format (still version 1):** `storageLocation` on output ports, `inputs` on operators, no top-level `inputs`.
- **Plan size at the listing cap:** 9,273,303 bytes (about 9 MiB) for 10,000 files with 600-character links, down from 10,522,913.
- **REST:** an operator JSON carrying `inputLinks`, `listing` or `maxColumns` is now rejected as an unknown property; it used to be accepted and overwritten.
- **Run compile:** an operator id that cannot be part of a location (for example one containing `_`) is that operator's error.
- **Internal RPC:** fields 5 and 6 on `InitializeExecutorRequest`.
- **Websocket and configuration keys:** no change.

## Open issues
- The Python export calls `CSVScanSourceOpDesc.sourceSchema()` outside a compile, so it now infers under the default 512 columns and no longer sees a raised site limit.

## What is left, in the order I would do it
All of piece 5. I read the findings and confirmed D27, D11, E18/D6 and E26 in the code; I did not check E30 or E10 in the code.

1. **D27:** add a strict site-settings read so `CompileSettings.fromSiteSettings` fails when the database does not answer. No row or a non-number stays the default. `PlanToRunSpec`'s three `bindingsFor` cases will then need a database.
2. **D11:** `OperatorUpdates` takes only a repository resolver. Add a guard case in `InputBinderSpec` that operators overriding `runtimeReconfiguration` get nothing from the binder (today: Limit, Filter and Map bases, the Python, R and Java UDFs).
3. **E18/D6:** inline `Workflow.fromCompilationResult` into `PlanToRun.make`, move its two cases to `PlanToRunSpec`, and extend `EngineBoundarySpec` to forbid compiler references under `amber.engine`. Then fix the stale comments in `WorkflowCompiler`'s class doc, `Workflow.scala` and `PhysicalOp.scala` (E32).
4. **E26:** state the bounds beside `constants.max-listed-files`. Measured: about 927 bytes of plan text per file, so roughly 18,000 files fit in the 16 MiB row. The init message is about 685 bytes per file by my estimate, so roughly 45,000 files under the 30 MiB frame; that figure should be measured.
5. **E30 (first item):** `PythonEnvironmentIntegrationSpec` installs under a root of its own.
6. **E10 (one item):** pin `ExecutionEnvironmentService.prepare()` with two environments.
7. **E32/E33 leftovers:** the "sub-part 16" comment in `WorkflowWebsocketResourceSpec`. Then run the whole suite once.

## For the batch that moves the run compile (batch C)
- `PlanToRun` still imports the engine's `Workflow` (until E18 is done) and amber's `UserEnvironmentResolver`.
- `InputFile` carries a name and a link but no address. A scan's name is its resolved URI, but a listed file's physical address is not in the plan, so signing links at the Dashboard needs that added.

## Traps for whoever continues
- Running several modules' tests in one sbt call after other modules makes `WorkflowCompilingServiceRunSpec` fail on the JDBC driver. Run it first or alone, as the suite script does.
- Amber test runs leave an untracked `jacoco.exec` at the worktree root; delete it before staging.

Working notes are at `/private/tmp/claude-501/-Users-jiadongb-Desktop-projects-texera/110f62ac-4583-4269-8645-82b6251b3c39/scratchpad/p/NOTES.md`.