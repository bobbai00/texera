# Triage of the two reviews of steps 1-2

The reviews are `engine-side.md` (findings E1-E33) and `dashboard-side.md` (findings D1-D36), next to
this file. They were written against the tree at d7700d580, before upstream main was merged in;
find the code by name. This file says which findings are fixed now, in which batch, and what was
decided where a review offered a choice. A batch fixes exactly its own findings. If a finding turns
out wrong when you look at the code, say so and leave the code alone.

General rules for every batch

- The product must behave the same unless the finding is about behaviour. Every behaviour change
  gets a test that fails without it.
- No stored-plan compatibility is owed to anything: the format has never been released.
- Keep comments proportionate. Do not add a paragraph where a line will do, and where you touch a
  documentation comment that repeats the design ("the unit asks no service") or lists every
  validation in a `@throws`, shorten it. A full trim pass comes later; do not start one.
- Names: do not start renames beyond what a finding in your batch asks for. A naming pass comes
  later.
- List every externally visible change you make (REST bodies and status codes, websocket messages,
  status values in the database, configuration keys, environment variables, routes): the
  end-to-end harness has to follow each one.

## Batch X1: the stored plan, the plan store, mounts

- E1. The stored format is version 1, with field numbers that have no gap and no `reserved`
  tombstone; golden files and specs speak of one format ("another version is refused").
- E8. Operators are always saved in id order. A link is stored once. `read` no longer re-prints,
  re-parses and diffs the text; `decode`'s semantic checks stay.
- E15. A stored field has a reader in this branch or is named by step 3's design
  (`sce-e2e/docs/step3-design.md`), otherwise it goes: `sizeBytes` on links and inputs, the one-arm
  `oneof`, the stored environment digest (derive it), plan-row columns nobody reads. The unit reads
  only the columns it uses. Keep `ExecutionPlan.inputs`: step 5 needs the list of what a run reads.
  Put cost hints where replay and inputs are, if that is the smaller, clearer shape.
- E5. The unit's mount root is not part of a plan and not a Dashboard setting. A plan carries the
  repository locators; the unit, which knows its root, supplies it when its worker runs the code.
  `StoredRepositoryMounts.root`, `RunBindings.mountRoot`, `requireMountableUnder` and the
  Dashboard's mount-root setting (Helm) go. No user-facing message names an environment variable.
  A unit that cannot mount fails the run with a clear message when the run needs a mount.
- E24. A mount locator's repository and commit are restricted to the characters such names can
  have; a replay source or replay log outside the unit's configured log location is refused.
- E10/E26 (the part about sizes). A plan at the listing cap, with links of real length (a presigned
  object-store URL is 400-600 characters), must store, read back and start. Today the store pins a
  4 MiB body and such a plan may be larger. Make the numbers agree (the cap's default, the store's
  limit, the message a user gets when a plan is too large) and pin it with a test.
- D13. One shared function for a per-user warehouse's name; the response doc says the plan URI is
  opaque to clients.
- D14. Plan text cannot reach a log through a `toString`. Drop the one-field wrapper unless it
  prevents a real mix-up.
- E16, E21 where they are in this area: `ExecutionPlanStore.isStarted` (test-only), checks a decoded
  plan cannot fail, `RepositoryMounts.byRoot`, the duplicated plan-URI check, the format version
  checked in three places, SHA-256 hex written three times.

## Batch X2: the compiler and the operators (after X1, same worktree)

- E7. One sealed purpose replaces the pair "error handling + bindings": a compile is for editing
  (files, settings) or for a run (everything a run binds). No binder that throws "unavailable". The
  binders run as one compiler pass.
- E3, the smaller form. Every `@SetByCompiler` property is cleared by one generic step before
  binding, with a test over every operator class; the engine does not print payloads that carry
  descriptors (presigned links) at any log level, or prints them with links redacted. The larger
  form (bound values as their own field of the physical operator, outside the descriptor) is the
  owner's decision and is not part of this batch.
- E4. No test fixture in main sources widens the link allow-list: the fixture file server and its
  linker and lister move to test sources, the allow-list is immutable, endpoints are passed in.
- D11. Binding a paused operator's change builds only what it uses; a test pins that no operator
  that can be changed while paused has a compiler-set property (or handles it).
- D27. The site's settings are read or the compile fails; no silent default when the database does
  not answer.
- E26. The ceilings of `constants.max-listed-files` are stated beside the key.
- E18/D6. `Workflow.fromCompilationResult` moves to its one caller; nothing under
  `amber.engine` imports the compiler. Add a guard test only if a cheap, reliable one exists.
- E30 (first item). `PythonEnvironmentIntegrationSpec` installs under a root of its own.
- E10 (one item). `ExecutionEnvironmentService.prepare()` with two environments is pinned.
- E32, E33 in the files of this batch.

## Batch X3: the Dashboard's create path, REST, deployment

- D1 (blocker). "Created" is a status of its own. The Dashboard inserts the row as created; the
  unit's first write makes it ready, as now. Nothing that means "a run in progress" counts a
  created row: the editor's lock, the manager's idle sweep, replace-at-create. The history shows it
  as created. Closing rows that are never started is step 3's closing job, not this batch.
- D12. Status codes and the set of ended statuses live in one place (`common/dao`).
- D2. A create clears only the results of ended executions that a newer, started execution has
  replaced, and not on the request thread.
- D4. The run compile runs on a bounded executor with a deadline below the route's timeout; when
  it passes, the row is FAILED and the answer is a gateway-timeout error in the usual error shape.
  Compile-time database connections of the SQL sources get a connect timeout.
- D5. One body shape for a 400 (`code`, `message`, and when there are any `eid` and
  `operatorErrors`); `errors` goes; no client depends on JSON object order; the update answers 201;
  the 201 of a create carries only what a client reads. `operatorErrors` stays a map, as the
  compiling service's response has it. The unit's `/api/execution/{eid}/run` keeps its path.
- D7. The manager forwards the new unit-side settings to Kubernetes units; the new settings are
  documented where the others are (single-node `.env`, Helm values, the deployment READMEs).
- D8. The agent says what happened to a run that was stopped or replaced.
- D9. A replay reads only the caller's own executions.
- D10. Who may run a workflow is what upstream allows (check it), pinned by tests: a public
  workflow, and clearing across users on a shared unit.
- D16. Test seams are constructor parameters with production defaults, the idiom upstream's newer
  code uses, not `object X extends X` with protected methods.
- D17. An unknown target operator is a 400; the plan is cut in one place.
- D18, D19, D20. Dead code and leftovers named there; the dev-proxy glob entry; an explicit body
  size limit for the create in nginx, stated for the other modes.
- D22, D25, D28. Message style, one way for a create to fail, the log location written with the
  row, a missing environment's message that names the cause.
- D33. Tests for abandoned creates and for a replay of another user's execution.

## Batch X4: the unit's web layer, the websocket, the browser (after X3, same worktree)

- D3. A refused request is not a failed run. The unit answers a refusal with an event of its own;
  the browser shows it as a notification, and fails its run only when the refused start is the one
  it asked for. Stop, Checkpoint and the console's commands are disabled without write access to
  the unit, as Run, Pause and Resume are. No message advises what no client can do.
- D29. Pause, resume and kill name their execution; the unit refuses a stale one.
- E13. A worker that stops for any reason closes its executor once, so a killed run leaves no
  temporary copy and no open connection.
- E16, E17, E21, E23, E32, E33 where they are in the unit's web layer: dead code, the `sessionUri`
  thread, the stored update's checks written like the start's, "close every console writer"
  written once, one style for refusal messages, inline fully qualified names.
- D21. The browser's environment service and types use the word "environment".

## Not fixed now, and why

- E2, E19, E20 (finished states are final; `WorkflowExecutionService` built in two phases; the
  null `resultUpdateCancellable`): step 3's sub-part 5 rebuilds exactly this code around one
  `transitionTo`; they are fixed there.
- E12, D26, D2's final form: step 3 moves the e-mail, the cost hints' source and the expiry to the
  Dashboard's closing job.
- E6, D31: unit identity and how a unit is addressed are step 4's subject.
- E11: the 7-day default lifetime of links stays (a run that opens a file late must not fail), and
  that File Scan From Input reads only listed files is the design; both go into the pull request's
  text.
- E14, E25: eviction of environments and pip's environment are on step 5's and step 6's lists.
- E22, D15, D21 (the rest), E9, D23: one naming pass and one comment trim pass over the whole
  branch at the end.
- E27, E31, D24, D32, D36, D34's upstream items: inherited behaviour, or upstream's own; separate
  changes.
- E28, E29 (test weight and timing), D35 (commit messages): handled when the history is regrouped
  into pull requests, except where a batch touches the test anyway.
