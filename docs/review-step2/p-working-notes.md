# Batch P working notes (scratch; not for the repo)

## Decisions
- C1: PhysicalOp.storageLocations: Map[PortIdentity, URI]; StoredOutputPort.storageLocation=3; compiler (Strict) locateOutputPorts;
  codec checks location decodes to plan's wid/eid/warehouse + port (decode-based, both ways); scheduler uses op.storageLocation.
  operator id that cannot name a location -> operator's compile error (run compile).
- C2 shape: proto OperatorInputs{files: repeated InputFile{name,url,expiresAtMs}, listing: FileListing{files}, csvParserMaxColumns: optional int32} in executor.proto
  PhysicalOp.inputs; StoredPhysicalOp.inputs=15; InitializeExecutorRequest.inputs=5
  ExecutorInputs(handle: plan inputs + link endpoints) in core.executor; ExecFactory ctor shapes (String, ExecutorInputs) / (String, ExecutorInputs, Int, Int)
  Descriptor: fileName still resolved in place (upstream; python export depends on it). LogicalOp.getPhysicalPlan(wid, eid, inputs) - CSV overrides for limit.
  Compiler pass InputBinder (pre-expansion) -> Map[OperatorIdentity, OperatorInputs]; resolves+links scans atomically.
  Remove: SetByCompiler, ReadsInputFiles, propertiesSetByCompiler, schema filter, asSent, LogicalPlan binders, ExecutionPlan.inputs, PlanInput, StoredPlanInput, WorkflowCompilationResult.inputs
  CSV sourceSchema() outside a compile -> DefaultMaxColumns (python export edge: report)
- C3: CompileFor sealed (Editing(files, settings) | Run(...)); remove CompilationErrorHandling, RunBindings, *.Unavailable
- C4: fixtures -> workflow-operator test sources; allow-list val; CoordinatorConfig.inputLinkEndpoints -> InitializeExecutorRequest.inputLinkEndpoints -> ExecutorInputs; LinkDocument endpoints required
- C5: D11, D27, E26, E18/D6, E30(1), E10(1), E32/E33

## E32 in files touched
- PhysicalOp.scala:166 "left out as the function it replaced was" (history)
- WorkflowCompiler.scala:250 "the engine `Workflow` wrapper stays in amber" (stale)
- Workflow.scala:40-42 engine doc narrating Dashboard flow (goes with E18)

## Report items
- python export CSV limit edge
- operator id '_' -> compile error
- stored format changes

## Progress (after context reset)
- C2: all main + tests compile; targeted specs pass (WO source/metadata 745, WC 189, core codec etc 150, amber touched 331)
- Verified: both the shared objectMapper and the Dashboard's (Dropwizard 1.3.23) REJECT unknown operator properties
  -> a request sending maxColumns/inputLinks/listing is now refused at parse (400), was accepted-and-overwritten. REPORT as REST-visible.
- New tests in C2: InputBinderSpec (20), LogicalPlanSpec getAncestorOpIds, WorkflowCompilerSpec (signature/log, descriptor-holds-none),
  AsyncRPCServerSpec trace-without-signature, DataProcessorRPCHandlerInitializerSpec update keeps inputs, ExecutorInputsSpec
- TODO C2: WorkflowCompiler class doc; RunBindings docs; mutation checks; scalafix/scalafmt; full review; commit; full suite
- C2 committed 542bdd710. Full suite after C2 = baseline (common 55/3046/189/1155/106, services 90/77/481/43/325, amber unit 2685, integration 56 + 1 cancelled, IcebergRestCatalogIntegrationSpec aborts). Saved: p/suite-after-c2.summary
- Plan size at cap (10,000 files, 600-char links): 9,273,303 bytes = 8.84 MiB (927 B/file)
- NOTE: running several modules' tests in ONE sbt invocation makes WorkflowCompilingServiceRunSpec fail (JDBC driver/classloader); run modules in separate sbt invocations.
- C3 drafts in p/c3 (CompileFor.scala, scripts/apply3.py applies everything to the worktree)
- E7 name: reviewer suggested `CompileFor` with Editing/Run -> used.
- C5 guard for D11: reconfigurable ops = LimitOpDesc, RUDFOpDesc, JavaUDFOpDesc, MapOpDesc(base), PythonUDFOpDescV2, FilterOpDesc(base): none reads files
- Review docs: /Users/jiadongb/Desktop/projects/texera-worktrees/sce-e2e/docs/review-step2/{engine-side,dashboard-side,triage,x1-report,x3-report,x4-report}.md

## WIND-DOWN (coordinator asked at ~11:50 to wrap up; do NOT start commit 5)
- C3 committed deee37af6 (CompileFor). C4 (E4) in working tree: compiles, formatted, common suites pass (Config 106, WO 3046, WC 187),
  amber unit 2687 pass; amber integration running (c4-amber-int.log). Then: mutation check, format --check, commit with p/msg-c4.txt.
- Not started: commit 5 (D27, D11, E18/D6, E26, E30, E10, E32/E33). Plan for each is in the final report draft.
- C4 committed 02c3daa7a (E4). Tree clean. Verified: Config 106, WO 3046 (1 cancelled), WC 187, amber unit 2687, amber integration 56 (+1 cancelled, known abort).
  Final whole-suite run on 02c3daa7a started 12:01 (p/suite-after-c4.out, sce/suite-p.summary).
- Commit 5 NOT started. Order to do it: D27, D11, E18/D6 (+E32 comments), E26, E30, E10, E32/E33 leftovers.
- FINAL (12:16): branch tip c5511fab0. Commits: 14f7b6196, 542bdd710, b840244fa (C3 amended: two LakeFSInputLinkerSpec tests that a cut had deleted are back), c5511fab0 (C4 replayed).
  Whole suite ran on 02c3daa7a (= tip minus those 26 restored test lines): baseline-equal. Restored spec + format checks pass on the tip. Tree clean. No wip commit: commit 5 not started.
