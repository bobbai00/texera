# Texera 2.0 progress log

Newest first. Each entry: what was done, how it was verified, what is next.

## 2026-11-07 (session 15, part 6): the diabetes screening use case

The user asked for a diabetes research use case, not too complicated, with models and the
platform's operators: a researcher asks what tools there are, has the agent get data into a
dataset, says what she wants done, and the agent asks for the specs (a profile: small, large or
with a GPU); at the end the resource graph shows a model, a dataset and a computing unit joined
to the workflow. The use case is in `bin/texera-2-0/examples/diabetes/README.md` (four
messages): what the platform gives; the public Pima cohort brought into a dataset; a screening
with the team's onset-risk model, for which the agent asks where to run; Small picked on the
card, a unit made from it, the workflow (the cohort, `predict`, the team's ROC AUC and Risk
calibration operators) run there. What it needed, each its own commit:

- **Kind's GPU** (`3774ad7f2`): the catalog could not list nodes, and a cluster it cannot read
  is not refused for that, so every profile said it could start, GPU included, on a cluster
  with no GPU node. A cluster role lets it read nodes: "no GPU in this cluster".
- **Profiles on Compose** (`2df542c94`): no profile could start, so the agent had nothing to
  offer. A unit made from a profile is now the deployment's own unit with the profile's
  packages (the unit builds their environment per run, as for any unit), its status
  `sized: false`, the app saying "on this deployment's own unit"; GPU does not start. A unit
  from a profile the deployment cannot start is refused with the reason (409 `not_here`) on
  both setups, where a GPU unit used to be made and wait for good. The profile scenario and the
  agent's unit-from-a-profile scenario now run on Compose too (the first in seconds).
- **Data from the internet** (`266fe12fb`): `POST /{datasets,models}/{rid}/import` has the
  catalog fetch a file into the staging area, and the agent has `create_dataset` and
  `import_dataset_file`. Public internet only, checked when each connection is made (after the
  name resolves and after every redirect: loopback, private, link-local and metadata,
  carrier-grade NAT, NAT64, 6to4, reserved), https only, no password in the URL, no proxy, up
  to `TEXERA_IMPORT_MAX_BYTES` (1 GiB); a caller who may not write fetches nothing. Skill
  `importing-data`; `exploring-resources` answers what the platform offers.
- **scikit-learn pinned** (`36ff4580f`): the profiles listed it unpinned, so a unit made today
  installed 1.9.1, where a model saved by 1.7.2 does not load (`'SimpleImputer' object has no
  attribute '_fill_dtype'`). The release pins 1.7.2, the dev stack's and the example's.
- **The agent asks where model work runs**: before the first run of a model in a chat, the
  deployment's unit, Small, Large, and GPU only where one starts. The first two tries offered
  one size ("Local unit" and Medium, then "Local unit" and Small): the agent had loaded
  using-models, not computing-units, so using-models now carries the choices itself. The ask
  card's options wrap within the card (their costs ran past its edge).

Verified on the dev stack: the catalog's suite; the app's 294 tests; the agent runtime's 104;
the scenarios, 54 passed; the use case through the real model as a scenario
(`tests/e2e/test_diabetes.py`, 74 s: AUC 0.845 on the 768 women, called optimistic since the
model was fitted on them, and a calibration table of ten bands) and in the app
(`frontend-next/e2e/diabetes.spec.ts`, 1.4 min, with screenshots of the card and the graph).

## 2026-11-07 (session 15, part 5): everything under a project; projects inherit, up to Texera

The user's design: no "built-in", no global settings, no global admin. Projects inherit from
one another; by default every project inherits from Texera, the project made at install that
holds operators, profiles and the rest, controlled like any other project, with a default
admin. Each project has admins and members, through OpenFGA. Branding and the defaults belong
to a project, inherited, not duplicated. A clean migration without backward compatibility;
quotas are low priority and were not built.

- **Inheritance.** `metadata.base` names the one project a project inherits from; a chain ends
  at Texera (`texera.root`, public, `user:*`). OpenFGA's `inheritor` relation carries only
  `viewer` and `user` up a chain, never editing or owning, and nothing down: a base's admins get
  nothing below. Inheriting is sharing: a project inherits only from a base its admin
  administers too, or from Texera; the base's admins may send it back to Texera; a loop is
  refused; a project others inherit from is not deleted; a public project needs a public chain.
  Lists follow the same rule in Postgres (a recursive walk of the chain), and `?scope=` is the
  project's chain.
- **Settings.** A project's spec is `branding`, `defaults` (agent, model, unit, profile,
  warehouse, add-ons, work mode) and `limits` (results kept, warehouse stores). A preference
  comes from the nearest project that sets it, a limit is the strictest along the chain; Texera's
  store list is the outer bound, empty when unset, so only Texera's admins open the deployment to
  a store. `GET /projects/{rid}/settings` (MCP `project_settings`) says what holds and where
  each value comes from. Runs, compiles, chats, retention and warehouses all read it. The
  settings singleton, `/settings`, `/settings/public` and singleton kinds are gone; `/public`
  serves Texera's look; an unnamed upload goes after `TEXERA_UPLOAD_GRACE`.
- **Admins.** A project's owners are its admins (its settings, base, people), its editors its
  members. The identity provider's administrators are made Texera's admins at sign-in; nobody
  passes a check for being one (the PDP's admin bypass and the principal's flag are gone).
- **Texera and releases.** Texera replaces the Built-in project: what a release ships goes into
  it through the `shipped` ledger, which updates a resource only while its spec and
  description are what the release wrote, never brings back what Texera's admins deleted, and
  drops what no release ships any more and nobody changed. The engine's operators sync the same
  way, and a workflow runs only operator types its project's chain offers, so taking one out of
  Texera takes it from every workflow.
- **App.** A project's Settings tab: what it inherits from (its admins pick another), what its
  work runs with and which project each value comes from, and what it sets itself. People tab
  with admins and members. Lists say "from <project>" for what is inherited; the sidebar wears
  the working project's look; no Settings page, no built-in badge; a chat's setting from a
  project names it.
- **Migration 0012.** Built-in becomes Texera, every other project gets Texera as its base, a
  project's flat defaults move under `defaults` (with their reference edges), the settings row
  goes, administrators get `owner` on Texera, the principal's admin flag and the `shipped`
  ledger table. Tested on a catalog of the old shape (`inherit_migration_test.go`) and run on
  the dev stack's and the kind cluster's data.

Verified: the catalog suite against Postgres (`go test ./...`, new: `projects_test.go` on Texera,
inheritance, loops, settings and releases; `inherit_migration_test.go`; the authorizer contract
with inheritance, on the in-memory model and on the real OpenFGA, `-tags integration`); the agent
runtime (104); the app (294 unit tests, typecheck, lint). On the dev stack, migrated from the data
of the earlier sessions (Built-in became Texera, Diabetes research inherits from it, texera-admin
administers Texera and reads nobody else's projects): the scenarios, 51 passed
(`test_projects.py` new, the results-expiry scenario no longer destructive), and Playwright, 64
passed and 5 skipped (the model), a project's Settings tab among them. On kind, migrated from its own data the same way: `k8s.sh check`
green, 55 scenarios and Playwright 64 passed, 5 skipped (the model). The first cluster run failed
"a long first answer ends up on screen" (1 in 3 alone, 1 in 10 on the dev stack): the test scrolled
up when the live copy alone showed, the catalog's copy then landed above it and the browser's
scroll anchoring kept the live one in place; saved messages now say `data-message-seq` and the
test waits for that copy (20 in 20). The API walkthrough runs against the dev stack as before.

Decided along the way: the relations keep their names (owner, editor, viewer, user) and the app
calls a project's owners admins and its editors members; a project has one base, so every
setting has one answer; Texera stays open to everyone, so a link to it needs no tuple; Texera's
store list is the outer bound of every project's; the model default is left to the agent unless a
chat or a project chooses one. Next: quotas as limits in project settings when wanted.

Then, at the user's request, the administration a project needed: `GET /projects/{rid}/inheritors`
for its admins, with "Send back to Texera" on the Settings tab; a person's role on a project beside
its name; its description edited by its admins; on the People tab a role changed in place and what
each role may do; a member or viewer told that only the admins see its people. Covered in the
catalog's suite, the scenarios (an in-place role change, the inheritors list) and Playwright (alice
manages the study, bob sees himself a viewer, the lab's admin sends the study back). Dev stack:
Playwright 64 passed, 5 skipped. Kind, redeployed: `k8s.sh check` green, 55 scenarios and
Playwright 64 passed, 5 skipped. On the way the long-answer test failed again on the cluster,
waiting for a saved copy that never came: it wrote the turn's messages only after the page had
the whole stream. It now writes them first, as the runtime does (15 in 15 on both stacks).

Then everyone in a project sees its people: a project's grants are listed for whoever may read it,
while changing them stays its admins' (anything else's grants stay its sharers'); the People tab
shows a member or a viewer the list and the roles, and nothing to change. The catalog's suite, the
app's tests, the scenarios and the Playwright tests of projects and sharing passed on the dev stack.
Then the machine's disk filled (99%, 4 GB left of 281 GB, most of it Docker's build cache, shared
with other stacks): the kind redeploy stopped loading an image (`no space left on device`), and
Chrome on the dev stack began to fail its page loads (`ERR_INSUFFICIENT_RESOURCES`, blank pages in
the long sharing test). This session removed its own leftovers (a 3 GB image tarball of an
interrupted load, its Go build cache), and with the user's approval Docker's build cache went
(`docker builder prune -af`, 79 GB back; no image or container). The first Playwright run after
it timed out once at sign-in, on the first page load (the dock test, then 5 in 5 alone).

On the way the dev stack's live log turned out to hold 295 MB from a day of tests: a workflow
deleted while it was open kept its room, since the last save on leaving got a 404 and the room
tried again every 15 seconds, for good, with a warning and a stack trace each time (213 rooms).
The live service sees every resource, so a 404 now means the workflow is gone: its document is
let go and not tried again (`live/src/rooms.ts`; the fake catalog deletes as the real one does,
and two tests cover an open workflow deleted with and without edits not saved yet). The cluster's
live pod had the same leak.

Then, with all of it: dev stack, the scenarios 51 passed and Playwright 64 passed, 5 skipped, the
live log 7 KB after both (19 workflows let go once each); kind, redeployed, `k8s.sh check` green,
55 scenarios and Playwright 64 passed, 5 skipped, its live pod's log the same.

## 2026-11-07 (session 15, part 4): nobody writes the engine's classes

The user's rule: an agent or a person using operators never works on the class template; the
class is the engine's. A custom operator is a Python function under `@returns`, saved as one
of a project's operators.

- **Function only.** The catalog refuses an operator's code that defines no function under
  `@returns`, or a class built on one of the engine's bases (`UDFOperatorV2`,
  `UDFTableOperator`, `FunctionOperator`, …); with no `function` named, the code's one function
  under `@returns` is the operator (`pyfunc.go`). The class compile path is gone (no
  `PythonUDFV2` with a `PROPS` header); secrets always go to a function's arguments. An
  operator saved as a class before is not run: it says to save its code again as a function.
- **Engine-only operators** (`engine_only.go`): `PythonUDFV2`, `DualInputPortsPythonUDFV2`,
  `PythonUDFSourceV2`, `JavaUDF`, `RUDF`, `RUDFSource` (the unit images have no R), and
  `function` and `stored`, which the catalog compiles a workflow into. The operator sync drops
  them (183 operators listed on the dev stack before, 175 after), and a workflow naming one is
  refused on save and at compile, saying what to write instead. Only the catalog writes a
  `stored` source, where it found the reader may see the earlier run.
- **What a class could do, a function does.** A function with no positional parameter is a
  source (`function` with no inputs is a source physical op; the module calls it from
  `GenerateOperator(FunctionSourceOperator)`); a link into one is refused. A function may
  `yield` DataFrames, each put out as it comes, so rows go on and a run can pause between
  them. A setting typed `Credential` is a credential property; the function gets the leased
  secret. Not the same: a function without `by` runs on one worker, where a class with
  `workers` spread rows over several.
- **A bug the change uncovered.** A unit made from a profile builds a venv with the profile's
  packages and pointed only the `PythonUDF*` operators at it, so a function (or a model version
  through `predict`) that imports such a package ran in the default Python and failed; the old
  profile test had passed through `PythonUDFV2`. Found on kind once that test used a function.
  `function` and `predict` now take the environment the unit names (`PythonEnvironment`), and
  the unit gives them its name only: the first fix also set the UDFs' `defaultEnv` on them,
  which the engine's strict plan reading refused ("Unable to process JSON" at start, never at
  compile); found on the dev stack, whose unit builds an environment too, and fixed with a spec
  that reads the rewritten plan as the engine does.
- **Agent.** The python-udf skill drops the `PythonUDFV2` line for sources, yields and
  `Credential` settings; the `python` field says so in brief; a line naming an operator that is
  not there says code of one's own is a function under `@returns` in `python`.
- **App.** New → Operator starts from a function named after the operator (`Time in range` →
  `time_in_range`); the fields the catalog reads from the code are not in the form; a source
  function shows as one.
- **Tests off class code.** e2e `test_controls` pauses and resumes a function that yields a row
  every 0.2 s; `test_credentials` passes a secret to a `Credential` setting; `test_engine_errors`,
  `test_operator` and `test_profile` (humanize, cluster) use functions; Playwright's operator page
  and slow-run tests too. New: Go `TestTheEnginesOwnOperatorsAreNotWrittenByHand`,
  `TestAFunctionThatReadsNoTableIsASource` and pyfunc cases; a Scala source spec; pytexera
  yield, source and `Credential` tests; e2e `test_a_function_that_reads_no_table_is_a_source` and
  `test_the_engines_own_operators_are_not_offered_nor_taken`; agent and app unit tests.

Verified: catalog `go test ./...` against Postgres green; agent runtime 104; pytexera udf 96;
Scala builtin specs 28 with scalafmt clean; frontend vitest 294, tsc and biome clean. On the
dev stack the e2e suite gave 47 passed and 1 failed: the new source test assumed a filter's
rows in order (several workers, no order); fixed, and with the final catalog the function,
operator, credential and error files passed 12 of 12; Playwright 63 passed, 5 skipped (the
model's). Kind, rebuilt from the commits: the first check failed the profile test (a function
importing humanize on the profile's unit), which found the environment bug above; after both
fixes the dev stack's whole e2e suite passed (48), and kind's check passed whole on its second
run (scenarios 52 passed; Playwright 63 passed, 5 skipped). Its first run had one failure in
`collaboration.spec.ts:240`, a pointer still shown 10 s after it left the canvas, which passed
3 of 3 alone against the cluster and in the rerun: presence timing, not this change.
With the final engine the dev stack's Playwright run gave 61 passed, 5 skipped, 2 failed:
`texera2.spec.ts:365` (a long first answer scrolled into view) and `:671` (the other person's
message in a shared chat); both chat-only, both passed 3 of 3 alone right after, and the same
frontend passed whole earlier the same day and on kind.

Next: as part 3 says (E5's rest, E6 R, ML environment images, stored reads across units), and
a parallel mode for functions whose rows are independent, if it is wanted.

## 2026-11-07 (session 15, part 3): the graph's last pieces, nondeterministic functions, kind

- A plan in the chat floating over a page offers Open graph, which opens the chat with its graph.
- The graph orders each column by what its nodes connect to (new nodes go next to their
  neighbours; placed nodes stay put), and draws uses and runs-on arrows faintly until one of
  their ends is chosen.
- A tool call records the MCP server its tool came from (`MessagePart.server`; the runtime
  knows each mounted tool's server). The graph lists the outside servers the agent consulted,
  in the order it first did, each with its calls; the platform's own server is left out. Above
  the graph a strip says "Consulted: biomcp 2 calls", and a click lists what each call asked.
- A Python function that may give other rows for the same input says
  `@returns(..., nondeterministic=True)`. The catalog reads the mark from the code into
  `implementation.python.nondeterministic`; a plan then neither fingerprints, keeps nor reuses
  that function's rows or those of anything after it. The python-udf and texera-workflows
  skills say when to use it; an operator's facts show it.
- The diabetes scenario has a sixth question that reads the literature and the data: given the
  consensus target for time in range, cite the paper and count the adolescents who meet it. Run
  through the real model: two PubMed searches (Battelino 2019), a workflow over the CGM
  readings, and a graph with the dataset, the workflow, the unit, the table and "consulted
  biomcp: 2 calls". The per-participant time in range matches pandas over the same file (one of
  seven above 70%); the model's table had one reading count wrong, which it corrected in its
  text.

Verified: catalog `go test ./...` (the graph's sources: two PubMed calls listed, the catalog's
own server and start_work left out; a sampling function run twice reuses nothing, and the test
fails without the mark); runtime 103; pytexera udf 93; frontend vitest 291; e2e test_reuse and
test_functions on the dev stack (5); Playwright graph.spec on the dev stack (the strip and its
list); the full Playwright suite on the dev stack (63 passed, 5 that need the model skipped).
Kind, rebuilt from these commits with `k8s.sh up` and checked with `k8s.sh check`: the scenarios
on the cluster pass, and Playwright on the cluster 63 passed, 5 skipped. (An earlier kind run,
from before these commits, failed the graph test because its images predated the strip, and once
failed a dock test that passed on a rerun.)

Not done: the stored source reads another unit's tables only where the lake lets that unit (a run
that cannot read one makes it again); environment images for the ML profiles (PyTorch installs
on first use); E5's range sort, broadcast join and the Parquet benchmark; E6, R.

## 2026-11-07 (session 15, part 2): caching from lineage, the profile ladder, the resource graph

- E3, caching from lineage: every port a run stores carries the fingerprint of the work that
  makes it (the engine operator's type and settings, versions named by number, the engine, the
  Python environment for Python operators, the inputs' fingerprints). Reusable: the built-ins (a
  limit only after a sort, a distinct only over every column), functions and predict. A run
  keeps the results of its costliest operators (functions, predict, aggregate, join, sort) though
  nothing shows them; before a run the catalog serves each costly operator whose results the
  project's completed runs stored, that the caller may read and the unit can open, by the
  engine's new `stored` source, and drops what fed only it. The execution records reused and
  skipped, lineage a reused arrow; `fresh` makes everything again. On the canvas a served card
  says "Read from" with the earlier run, a skipped one says it did not run, and the run bar has
  Run fresh. Each plan marks the ports it shows.
- G2, profiles: Small, Medium, Large (data), ML and GPU are seeded; a unit's limits equal its
  requests; a unit provider says whether the deployment can start a unit like a spec (Compose
  none from a profile; a cluster with no GPU, or no node that large, says so), and every read of a
  profile says startable and why not. computing-units offers only what can start here.
- G3, the graph's data: GET /conversations/{rid}/graph, from origins, executions and references:
  data, workflows (with their runs in the chat), models, functions and units; reads, makes, uses,
  runs on; what start_work planned and was not made.
- G4, the view: once a chat starts work the graph takes the left of the chat page, round nodes
  by kind, labelled arrows, columns of dependency on bands (Used first, Made last), planned items
  dashed, places kept for the chat's life; a click shows what a node is and opens it; List is the
  tree that stood there before.
- E5, in part: a unit started from a profile runs an operator that splits on a worker per CPU.

Verified: catalog `go test ./...`; the built-in, function and predict Scala specs and StoredOpSpec
(27); pytexera 92; the runtime 102; frontend vitest 291; e2e on the dev stack 45 (with
test_reuse.py: a 4 s function skipped on the second run, the same rows, a changed last step
reruns only it, fresh recomputes); Playwright: reuse on the canvas, the graph (nodes and arrows
appear, nothing moves when a second workflow arrives, the detail card, the list).

Not done: the stored source reads another unit's tables only where the lake lets that unit (a run
that cannot read one makes it again); the nondeterministic mark on functions; the "Open graph"
line in the floating chat; MCP sources on the graph (tool calls do not record their server yet);
environment images for the ML profiles (PyTorch installs on first use); E5's range sort,
broadcast join and the Parquet benchmark; E6, R.

## 2026-11-07 (session 15, on Linux): the work gate, operators as lines, functions and models, a diabetes team's project

The user approved both plans with one change (start_work governed by the chat's work mode, so in
manual mode every change waits for a yes), asked for the skills to follow the engine, and asked
for a diabetes use case on real data: a team with data, models and operators, and a scientist
who asks the agent what the team has and analyzes with it.

- G1, the work gate: the agent reads and asks first (`ask` with choices), says its plan with
  `start_work`, and only then may change anything; in manual mode each change is an approval
  card in the chat, approved or declined by whoever is in it (AG-UI interrupt and resume).
- E0: an average over an uneven split is the mean of all rows (partials merged in a final
  stage); the catalog keeps the ports the unit describes.
- E1: ten built-ins (scan, filter, project, compute, aggregate, join, union, distinct, sort,
  limit) with flat settings and a SQL expression language (typed, three-valued, did-you-mean
  errors). Workflows are written as lines, `set night: filter(readings, where="...")`: parsed,
  printed and applied all at once in workflow-model, and the agent's create_workflow,
  edit_workflow and get_workflow take and give lines, resolve files and models by name, know each
  type's ports, and answer with each operator's columns and each mistake on its line. The
  operator sync no longer lets `filter` overwrite `Filter`.
- Skills: texera-workflows (lines, the core operators, every function), python-udf (functions
  first), reading-results; new: computing-units, exploring-resources, using-models.
- E2: a Python function under `@returns` is a custom operator; the catalog reads its inputs,
  settings and columns from the code; the engine's `function` operator calls it on each worker's
  rows, whole groups with `by`; the agent defines functions in `python` and calls them by name.
- E4: a model version has a contract (framework, entry, inputs, outputs, needs, grouped);
  `predict` checks it before anything runs and runs the version on Python workers through a
  loader (sklearn, or a Python entry); the run records that it used the version; the dataset file
  tools read a model's card and files.
- The use case, `bin/texera-2-0/examples/diabetes`: prepare.py downloads the Pima cohort, the
  130-hospital encounters, the Efron progression data and a week of adolescent T1D CGM (Cronin et
  al. 2024), and fits three models (onset risk AUC 0.847, readmission AUC 0.663, progression R2
  0.407); operators/ holds the team's functions (CGM metrics, ROC AUC, calibration, odds ratio);
  load.py makes alice's project "Diabetes research" with bob on the team; scenario.py asks the five
  questions.

Verified: catalog `go test ./...` with the database; WorkflowOperator built-in specs (26);
amber Python 92 in pytexera/udf, 1406 overall (the Iceberg tests need a Postgres on 5432, absent
here); agent-runtime 102; workflow-model 80; frontend vitest 287 and tsc; e2e on the dev stack:
built-ins, functions (CGM metrics by patient equal pandas), models (a fitted logistic
regression's classes and risks equal scikit-learn's, used-lineage recorded); the model scenarios
(4 of 5; the fifth needs kind); the diabetes session through the real model, five turns, each
answer checked against independent computations (the HbA1c odds ratios against a pandas run,
the AUC against scikit-learn, the CGM metrics against the study's published values).

Found by running it, and fixed: two predict workers on one host raced fetching a model's files;
the agent could not read a model's card, so it doubted how the model treats a 0.

Next: E3 caching from lineage; G2 to G4, the profile ladder and the resource graph; E5
parallelism; E6 R, at low priority. Follow-ups: a built-in's card could show its line; the
operator page's starter could be a function; the unit's environment for every Python operator and
run-scoped credentials (E2); the runtime sends a temperature Haiku 5.5 ignores, with a warning per
step.

## 2026-11-06 (session 14, part 2): two designs, with plans

Design only; nothing in the code changed. The user reviewed the resource graph design and named
two big efforts: the resource graph (simple, visually distinct from the workflow canvas, opened
when the agent starts writing, with an agent that clarifies, reads and asks first, and profiles
with GPU and ML environments), and a simpler engine declaration with efficiency and caching
(operators as simple as dataflow-agent's native mode, core operators in Scala instead of pandas,
Python for user code, R at low priority, Amber's parallelism, caching from lineage, models in
workflows with their lineage).

- The Claude Doc "Texera 2.0: The Resource Graph" (https://claude.ai/artifact/HKWSujDmAbLpRHM7JEkQ9Z)
  was rewritten: four agent phases with an `ask` tool and a `start_work` call that opens the graph
  (writes refused before it), a profile ladder, five node kinds and four labelled arrows in fixed
  columns, a data model with no new table, the demo phase by phase, and phases G1 to G5.
- A new Claude Doc, "Texera 2.0: Operators, Runtimes and Caching"
  (https://claude.ai/artifact/YTxrrUqJfphVt6Sa5zv15v): one-line operators backed by one Scala
  contract each, SQL expressions, Python functions as custom operators (`by` for parallelism),
  runtimes, worker counts from the unit, fingerprints of port results reused through the
  catalog's lineage, models through `predict` and a loader, and phases E0 to E6.

Found while reading the engine, recorded in the engine doc: with the default two workers,
Aggregate's second stage averages the first stage's per-worker averages without weights, so an
uneven split gives a wrong mean (`AggregateOpExec.onFinish` emits `finalAgg`, and
`AggregationOperation.getFinal` keeps AVERAGE); and the catalog keeps only port entries with a
`portID` (`portSpecs` in `compute.go`) while the unit sends them keyed `id`, so every built-in
operator resource has no ports. Phase E0 fixes both.

A fresh-eyes review of both docs (a subagent reading them against the code) changed the designs:
settings store resource URIs and the line shows names; the workflow document keeps its shape;
a Python function is a custom operator (no new kind) with `@returns` columns; caching rewrites the
plan in the catalog (skipped operators removed, a `stored` source reads each found table) instead
of changing Amber's scheduler, and a shown hit is copied into the new execution; fingerprints
include kernel and package versions; E1 opens with a spike on the expression engine (Calcite
against DuckDB); range sort and a parallel final aggregate are new work in E5; the write gate
covers only the platform server's tools, and no work id or new chat part is needed; graph
columns are ranks of dependency, dashed means planned only; the phases' dependencies and tests
were corrected (G4 closes on today's operators, the demo needs E1 to E4).

Next: the user's review of both designs; E0 can go first either way.

## 2026-11-06 (session 14, on Linux): what using it found, fixed; the resource graph designed

The user, after sessions 7 to 13 on the Mac: operators could not be deleted and editing felt
unpolished; people on one canvas took time to see each other; a person a thing was shared
with saw its lineage flash and never show; an execution's results were fixed under the canvas
and hard to map to the workflow; sharing, resource control and runs were not reliable enough;
two workflows could not have the same name ("each resource should have a unique ID, that
should not be the name"); and "play around with the front end" for smoothness bugs. Later in
the session: design a resource graph beside the chat (the Claude Doc "Texera 2.0: The Resource
Graph", https://claude.ai/artifact/HKWSujDmAbLpRHM7JEkQ9Z), design only.

Found by driving the app in a browser (scripts in the session's scratchpad, then a sweep of
every page on the kind cluster's production build), each fixed with a test:

- **Canvas**: picking several cards never worked (the store's "no single one" was put back
  on the canvas as "none"), so several could not be deleted; React Flow's delete key missed
  the first press after a modifier click; a new operator left the keyboard on the list, so
  Backspace deleted it; no undo; column settings never offered columns (the catalog keys ports
  `output-0`, the app read `0_false`); an unlinked operator said "Schema is not available".
  Now: pick several and delete with one key, Ctrl/Cmd+Z and Shift+Z (a Y.UndoManager of the
  person's own edits), a new card takes the keyboard in its first setting, columns to pick,
  "Needs an input". (`cc7263bcb`)
- **Lineage for a person it was shared with** blinked between the placeholder and the graph
  every 20 ms with some 2,700 requests in 12 s: a refused card asked again on mount and set the
  tab pending. The tab waits for first answers only. (`618e15b81`)
- **Names are labels** (migration 0010): no unique index, no `name_taken`, executions named by
  their start without numbers, the app's numbering workarounds gone. (`a88e69368`)
- **A run refused** says what the caller lacks and where the workflow names it (the unit, a
  dataset an operator reads, a custom operator, a credential), and the workflow page says so
  before Run, above the canvas and on the operator's card. (`3a4288094`)
- **Results in a window** over the canvas, named as their cards, pointing them out, moved,
  sized, folded, kept; "ran v1" when the canvas moved on; doubles read 5.552. (`5a9140bce`)
- **The live session**: the head shows at once while the session is joined ("Connecting");
  the live service asks its three questions at once. Measured here and on kind: both canvases
  editable in about 0.5 s, a cursor seen in 36 to 47 ms. The Mac's slowness was not reproduced.
  (`31eb1be1b`)
- **A run that fails as the engine starts** (the coordinator's preStart) now fails instead of
  running for good: the client actor supervises its coordinator and keeps an early fatal error
  for the first listener. (`5fc70075b`)
- **Resource control** (the sweep): a viewer was offered rename, delete, keep, "Work in this
  project" and a chat box that failed on send; every 4xx was retried twice (the generated
  client threw the raw body, so the retry rule never saw a 403), so a link not shared took 3 s;
  a rename threw away an edit in progress; a save over another's change was a dead end; a
  deleted execution stayed on its workflow's page and a deleted project's page stayed open;
  a refused rename stayed in the header; Enter in search opened a new chat; the operator
  library and a file's preview stopped at 100 silently; a select opened scrolled past its
  first option; a workflow's name vanished beside a chat; the chat button hid a table's last
  cells. All fixed: the client's errors are CatalogErrors with their status; pages ask the
  catalog what the person may do (`useMay`); the spec editor keeps its draft and offers Keep
  mine or Take theirs.

- **Found by the gates**: a unit's packages saved while it started were refused with 412,
  because any read of a unit probes it and records a new status, and with it a new etag,
  between a page's read and its write; a save refused only for that now goes again
  (`dd64a34ce`). The agent's validate and run tools still said "the chat's unit"; they say the
  workflow's default, the project's or the platform's (`8a8c48f28`).

Verified: the local gate on a wiped stack, every layer green but one test: Go, bun (runtime,
live), vitest (273), sbt, the adapters and the engine's integration suites, 36 scenarios and 5
local ones, 60 browser tests without the model (4 skipped), the model scenarios (4, 1
skipped), and 63 of 64 browser tests with the model; the one failure, the canvas card back to
its place, was a pixel of rounding, since allowed (`eab76c931`, 4 of 4 runs green). On the kind
cluster, rebuilt from `dd64a34ce` and rolled: `k8s.sh check` green, 40 scenarios (the unit made
as a resource among them) and 60 browser tests (the 4 that need the model skipped there).

Not fixed: the inline styles cmdk and Base UI inject are refused by the app's CSP (a console
error only; a nonce through the gateway is the fix). A cluster upgraded in place keeps the
realm it first imported, so the sign-in theme needs the realm's `loginTheme` set (done here
with kcadm) or the cluster made anew.

Next: the user's review of the resource graph design, then its phase 1 if approved.

## 2026-11-06 (session 13, part 5): two fixes found by using it

- **A Keycloak restart no longer breaks making units**: the catalog keeps Keycloak's admin token
  for an hour, so after Keycloak restarted every admin call answered 401 and "Create computing
  unit" failed with 502. An admin call refused with 401 now gets a new token and tries once more
  (`adapters/keycloak/workloads.go`; `TestAnAdminCallAfterKeycloakRestartedGetsANewToken`).
- **An operatorID with `_` is refused before it runs**: the engine names a port's results with
  `_` between the parts and throws on an operatorID that has one, while it lays out regions; it
  only logs that, so the execution stayed "running" for good (charlie's two runs, `join_geo`).
  Validate and Run now answer 400 naming the operator and its `-` spelling, and the workflow
  skill says so (`catalog/plan.go`; `TestAnOperatorIDWithAnUnderscoreIsRefusedBeforeItRuns`).
  Charlie's two runs were cancelled; the two workflows still carry `_` IDs, left for charlie or
  the agent to rename.

Verified: Go suite green; on the stack, a unit made right after restarting Keycloak (201),
charlie's workflow refused with the message, and a copy with `-` IDs ran to completed (deleted
after). Next: the engine reports nothing when a run fails while it starts (an actor's
`preStart`), so another such failure would hang a run the same way; it should end the execution
as failed.

## 2026-11-06 (session 13, part 4): polish: a chat window, sharing that says what is missing, the sign-in page, Executions under Work

The user asked for four details, designed and agreed first, and to get them done fast.

- **The chat beside a page is a window** that moves by its header, sizes by its top left corner
  (the bottom right one stays), stays on screen, comes back where it was left (this browser),
  and blocks nothing else on the page; a double click on its header puts it back
  (`packages/chat/src/dock-window.ts`, pure, tested).
- **Sharing says what the person cannot open of what it uses**: `GET /resources/{rid}/needs
  ?principal=` lists what the resource's head version names (lineage's references), of the
  kinds that hold data or code, that the principal (a user, or a group as its grants name it)
  may not read, of what the caller may read, each `shareable` or not. Under each person in the
  Access list: "Can't open N things this uses: …", "Share them too" (viewer on each the sharer
  may share; the existing grant route), and "Ask the owner" for the rest.
- **Sign-in in Texera's look**: realm login theme `texera`, extending Keycloak's `keycloak.v2`
  with CSS and the logo; mounted from the `keycloak-theme` config map (Kubernetes) or the theme
  directory (compose). The flow is unchanged: the app never sees a password.
- **Executions are under Work** in the sidebar, after Workflows; the Activity group is gone.

Verified: Go suite green (new `TestSharingSaysWhatThePersonCannotOpenOfWhatItUses`); vitest 258
(`dock-window.test.ts`); typecheck; Playwright 47 without a model (new: the sign-in page's
look, the chat window moved, sized, kept and put back while the page stays in use, sharing a
workflow says what Bob cannot open and shares it). The model scenarios were not rerun: nothing
the agent does changed.

## 2026-11-06 (session 13, part 3): lineage says who made each thing; a chat says who started it

The user: "the linear event should show that xxx created by a chat. and a chat created by a
user". What the catalog already recorded (a resource's and a version's `createdBy`, and its
`origin`: the chat, the turn, the agent version) is now said where lineage is read.

What was decided:
- **On the card, not as cards.** Arrows in lineage mean data moved; making something is
  authorship, so each card carries a line saying who made what it names, and no chat or person
  becomes a card of its own (one chat that edits and runs a workflow many times would otherwise
  add an arrow for each, and what people made by hand would have no such card).
- **"by Alice Liddell"** for what a person made; **"by 💬 <the chat>"** for what the agent made
  in a chat, the chat's name a link that opens it beside. The whole sentence, "Made by Texera
  Agent for Bob Builder, in the chat …", is on hover. A card for several versions names the
  newest one's maker ("v3 by …").
- **A chat says who started it**, on its page and beside a page: "started by Alice Liddell".

Done:
- `MadeBy` and `useMadeBy` (the line, and the sentence); `useRanOn` gives where an execution ran
  as one sentence. A lineage card opens what it names through a button laid under its words,
  so the chat's name is a target of its own, and its tooltip says everything the card says in
  full; cards are 80 px high for four lines. An execution's facts carry its maker.

Verified: vitest 254; typecheck; the k8s check, 40 cluster scenarios and 44 Playwright without
a model (new in `lineage.spec.ts`: the dataset "by" its person, the workflow and its execution
"by" the chat they were made in, the full sentence on hover, the chat's name opening the chat,
which says who started it, and a card still opening what it names); with the model, the 4
Playwright scenarios. The first try of the line, "by Texera Agent in <chat>", cut the chat's
name off a 248 px card, and the test could not click it: the visible line now names the chat.
: a chat chooses no computing unit

The user: "does chat have to bind with computing unit? i don't think so right? currently it
seems to be binded and there is a selector in the chat box". Agreed: a chat chooses how its
agent works (the agent, its model, its add-ons); where an execution runs is the run's to say.

What was decided:
- **One rule for where a run goes**, the same for a person and for an agent in a chat: the
  unit the call names, else the workflow's `defaultComputingUnit`, the project's, the
  platform's. The chat's unit was a hidden extra rule: the Run bar said one unit, the agent's
  run of the same workflow went to another.
- **Saying it in words** is how a person picks a unit in a chat ("run it on my GPU unit"); the
  agent names it in the call, and the execution records it.
- **A unit made for a workflow becomes its default unit**: the agent's rule and its Python
  skill say to set `defaultComputingUnit` (with `edit_workflow`) when it makes a unit for the
  packages a workflow needs, so the person's later runs from the Run bar go there too.
- **The Run bar proposes the same default** as the catalog (the workflow's, the project's,
  the platform's unit); a unit picked there is for that page's runs. It no longer remembers a
  unit in the browser, which was one more rule.

Done:
- **The contract**: `ConversationSpec.computingUnit`, `ChatSettings.computingUnit` and the
  `computingUnit` setting of `skipped` are gone.
- **The catalog**: the chat's unit left the run and compile chains (`chatUnit`, the resolver,
  `usableUnit`); migration `0009` drops the unit chats chose.
- **The runtime**: the turn state no longer names a unit.
- **The app**: the chat box's unit picker, the chat page's "Computing unit" row and the Run
  bar's browser memory are gone.
- **The agent**: rule 5 and the Python skill, as above; the MCP instructions name the chain.

Verified: Go suite green (`TestARunInAChatGoesWhereAnyRunGoes` in place of the chat-unit test;
`TestAChatLetsGoOfTheUnitItChose` for the migration); runtime 73; vitest 254; typecheck; the
k8s check, 40 cluster scenarios (`test_chat_runs.py` in place of `test_chat_unit.py`) and 43
Playwright without a model (new: the Run bar proposes the workflow's own unit, else the
platform's, and a pick is the page's alone; no unit picker in the chat box); with the model, 5
pytest scenarios (the agent runs on the unit the person names in words; it makes a unit from a
profile) and 4 Playwright scenarios (the core loop on the unit named in the question). On the
stack, migration 0009 left no chat naming a unit.
: what a chat made and worked from, as a tree beside it

The user, on "From this chat": "show it in hierarchy ... datasets, you then show dataset;
workflows ... you then show workflow, and execution is nested under that specific workflow",
then "there should also be versions there, the hierarchy is resource, version, then sub
resource if needed ... dataset, version, files. make sure each component is foldable".

What was decided:
- **A tree, every level folding**: a section per kind in the sidebar's order, each resource,
  its versions newest first, and under a version what belongs to it: the executions that ran
  a workflow version, the files of a dataset version (read when the version is opened). Every
  section, what the chat made and each newest version start open.
- **What counts is the catalog's record, nothing guessed from tool results.** Made: the chat
  is the origin of the resource or of one of its versions, so a workflow the agent changed
  counts with the versions it made. Worked from, dimmed: what a person attached, what the
  chat's versions and other resources name at a version (the files a workflow reads, the
  profile version a unit was made from), what its executions ran and read. A name with no
  version (a unit, a warehouse, a credential) is a live link, not something worked from; a
  search hit or a listed unit is neither. Before, every resource any tool returned was listed.

Done:
- **The contract**: `GET /conversations/{rid}/resources` answers `ChatResource[]` (`resource`,
  `made`, `versions` of `ChatVersion` with `made`); `origin=` on `GET /resources` keeps the
  same "made".
- **The catalog** (`chat_resources.go`): made, then worked from, each resource the caller may
  read once; what the chat worked from does not depend on who asks, only what of it they see.
  The store finds the versions a chat made (index `resource_version_origin_idx`, migration
  `0008`), versions by name, references by exact name, and what people attached.
- **The app**: `FromThisChat` (with the pure `chatTree`) beside a chat and on the chat's page;
  a running execution's row is watched until it ends; the tree is asked again whenever a tool
  answers. Gone: the rail, and the chat model's list of every resource a tool returned.

Verified: Go suite green (new `TestWhatAChatMadeIsFoundByTheChat`,
`TestAChatListsWhatItMadeAndWhatItWorkedFrom`: made then worked from, versions, a search not
counted, a viewer seeing only what is theirs to read); vitest 256 (`chat-tree.test.ts`);
typecheck; the k8s check's cluster scenarios; Playwright 41 of 42 without a model plus the
new `chat-tree.spec.ts` (made through a chat turn with the runtime's service token: sections in
order, every level folding, the run's row ending `completed`, the dataset's file, a version
opened beside). The one failure, `collaboration.spec.ts` "two people edit one workflow at the
same moment", is intermittent and older than this work (4 of 4 on rerun). With the model: the
core-loop browser scenario (the built workflow, its version and run in the tree) and
`test_the_agent_builds_runs_edits_and_reruns`.
: computing profiles replace environments; where a run goes, said at Run and in lineage

Part C of the work the user decided on Nov 6. Their words: "maybe we call it a 'computing
profile'", "the profile is on node of that unit, i.e. how many cpu / gpu / memory, how many
additional packages", "whever save that unit as profile then create version or new profile",
"go with minimum clean design"; and, before starting, that the agent must still be able to
make a unit from a profile and pick the warehouse a run keeps its results in, and work on the
same canvas as a person.

What was decided:
- **A profile is what a node is made of**: memory, CPU, GPUs and the Python packages it adds
  to the platform's runtime, versioned. It replaces the environment kind; nothing chooses
  packages per run any more (no workflow, project, settings, chat or operator environment).
- **A unit is made from a profile version and may change since**; its page says how it
  differs. **Saving makes the version**: "Save as profile" is the next version of its profile
  (when the person may change it) or a new profile, packages pinned to what the unit installed.
- **An execution records what the unit had**: the profile version, the size, the runtime, each
  package as installed (`spec.computing`).
- **Where a run goes is said in words**: `on <unit> (<profile> vN) · results in <warehouse>`
  beside Run, with the warehouse to pick, on the execution's page and on its lineage card.

Done:
- **The contract**: kind `profile` (`ProfileSpec`); a node names its `profile` and lists its
  `packages`; a unit's status says what it `installed`; `POST /computing-units/from-profile`
  (`create_computing_unit`, with `waitSeconds`) and `POST /computing-units/{rid}/profile`
  (`save_unit_as_profile`); `ExecutionSpec.computing`; settings `defaults.profile`. Gone:
  `environment` (kind, routes, every field that named one), `RuntimeSpec.environment`.
- **The catalog** (`profiles.go`): a unit's spec gets its node from the profile it names where
  the node says nothing, the version pinned; a run asks the unit for the environment of its
  packages, keyed by the list (the same list is one environment on a unit, built once), waits
  for it in `provisioning`, and records what was installed in the unit's status and the
  execution's record; a unit given other packages forgets what it installed. Saving a unit as
  a profile makes the next version of a profile or a new one (the platform's only as new),
  and moves the unit to it when the caller may change the unit. The seed ships
  `python-default` (2 GB, pandas, numpy, scikit-learn), the unit made from it, and the default.
- **The engine**: `EnvironmentManager` keyed by that list, tries a failed build again, and
  answers each asked package as the environment has it, installed or already in the runtime.
- **Kubernetes**: a node's GPUs are reserved (`nvidia.com/gpu`).
- **The migration** (`0007_profiles.sql`): an environment becomes a profile with its packages,
  in every version; what named one goes; a reference to one names the profile.
- **The app**: the profile kind; the unit's "Node" tab (made from, how it differs, size and
  packages to change, "Save as profile"); "New computing unit" from a profile; the Run bar's
  sentence and warehouse picker; the execution's "Ran" section; the lineage card's third line.
- **The agent**: its Python skill and the server's instructions say to make a unit from a
  profile that has a package, and to wait for it.

## 2026-11-06 (session 12, part B): where operators sit, in versions; one layout for every graph; people and the agent on one canvas

Part B of the canvas work the user decided on Nov 6. Their words on the layout: "I am
thinking the layout should be ... the CRDT event. but i don't know if we are gonna create new
version or not? can we achieve it being affected by CRDT while not save as a version?"; on the
layout engine, "go with minimum clean design"; and, before starting, that the agent and a
person must work properly on one canvas.

What was decided:
- **Three layers, each with one home.** Presence (where someone points, the card they have
  open) is the session's awareness, never stored. The document (what runs and where operators
  sit) is shared and stored continuously. A version is a snapshot of the document, made only
  when what runs changes; it holds the places of that moment. A move alone makes no version.
- **The places are in the spec** (`spec.layout`, beside operators and links); nothing that
  runs a workflow reads them, and the agent never sees them.
- **One layered layout for every graph**: dagre (MIT), for the canvas, the pictures in chats
  and lineage, replacing two hand-written layouts.

Done:
- **The contract**: `WorkflowSpec.layout`, a `CanvasPoint` by operator.
- **The live service** (`rooms.ts`) makes a version when what runs changes (`runOf`) and saves
  it with the places of that moment (`versionSpecOf`); a version written elsewhere puts the
  places it moved on the canvas and leaves the others, and an operator it gives no place goes
  beside what it connects to (`placeMissing`: right of what it reads from, else left of what
  it feeds, else under everything, in the first free spot).
- **The catalog** keeps a place only for an operator the spec has, and a spec written without
  places (a whole spec, as the agent may write one) keeps the places its workflow had
  (`layout.go`); a JSON Patch keeps them by itself. The MCP bridge takes the places out of
  every workflow spec in a tool's answer.
- **One layout** (`layered` in `workflow-model/layout.ts`, on `@dagrejs/dagre` 3.1.3): columns
  by depth, a lane for an arrow that skips a column, columns ordered against crossings, a join
  between its branches. Used where nothing is placed, by "Tidy up", for pictures (which keep a
  workflow's own arrangement, drawn smaller, when it has one) and for lineage (its group spacing
  went).
- **Older versions and executions** are drawn with their own places (`fixedDocument`,
  `WorkflowCanvas`).
- **The agent on the canvas**: what arrives from elsewhere is pointed out for a moment and
  brought into view (`arrivals.ts`).
- **People on the canvas** (`Cursors.tsx`): each sees where the others point, with their
  name, and a mark on the card another has open, in the colour that person has everywhere.

Found on the way and fixed:
- **An operator that lists no ports got one input**, in the app and in the catalog, so a join
  written as an agent may write it (no ports, two links in) lost the arrow into its second
  input on the canvas. Both now give such an operator the ports its links use
  (`withPorts`, `defaultPorts`).
- **The app dropped a workflow's default warehouse when it read a version** (`normalizeSpec`);
  nothing was lost because the edits it made never touched the field, but a pinned version did
  not say it. It now keeps it, and the places.

## 2026-11-06 (session 12, on the Mac): the canvas, part A: what a run keeps, a run up to an operator, a status that can be read

After trying the polish of session 11, the user asked for changes, and decided them in
discussion before any code: no line from a result to its port, the port lit instead and a
click on an operator showing its result; on each operator only "eyes (toggle on or off) and run
button, click then it will run to there"; the rule for what a run keeps, as proposed ("i
agree with your rules"); editing as I judged most elegant; a status where running cannot be
mistaken for waiting. Then "ok go ahead ... with proper checkpoint after you done and tested
something completely". This is the first of three parts (A: the canvas and its results; B:
the layout and people together; C: computing profiles), each committed when done and tested.
The run-twice fix of session 11 went first, as its own commit.

What was decided:
- **A run keeps the results of the operators with their eye on, of the operators nothing reads
  from, and of the operator it went up to.** Nothing else is a result. Before, the engine's own
  stores for its schedule were listed too, read from the unit's memory, and gone when the unit
  restarted: the "result not available" the user saw.
- **The eye is Texera's "view result"**, in the workflow, one click on the card; the run button
  runs up to the operator and changes nothing in the workflow. Turning off and deleting are on a
  right click.
- **A card opened for editing stays within its column; the cards under it make room.**

Done:
- **The catalog** (`plan.go` `upTo`, `executions.go`, `lineage.go`). `RunWorkflow.upTo` runs the
  operator and everything it reads from; the execution records it (`spec.upTo`). A port the
  plan keeps no table for is not listed in `status.ports`, and its rows are refused without
  asking the unit. What the unit reports of a port is put onto what the plan said of it, so a
  report without a table no longer drops the table's name.
- **Rows in and out.** An operator's status says `rowsIn` and `rowsOut` (they replace
  `tuples`); the unit counts both in one place (`OperatorRows`).
- **The card** (`OperatorNode.tsx`). The eye stays in sight while it is on; the run, the eye
  when off and the pencil appear when the card is pointed at, picked or focused, and take no
  room until then. The per-card "show more" is gone: how much cards say is the canvas's choice.
  A running card has a bar moving along its edge and its rows count up ("150 → 3 rows"); an
  arrow moves while its operator runs and has put rows out (`to-flow.ts`). A port whose result
  is kept is lit, the one on screen more. The bar over the results says "3 of 7 done" and for
  how long.
- **Editing** (`room.ts`, `EditorCanvas.tsx`, `PropertyForm.tsx`). The open card is as wide as
  its column allows; the cards under it in its band are drawn lower while it is open and go back
  when it closes; nothing moves in the workflow. Code is a few lines in the card and all of it
  in a larger editor.
- **Results** (`ResultsPanel.tsx`). Only kept results have tabs; a click on a card shows its
  result; `Connector.tsx` is deleted.
- The agent's skills say which results a run keeps and how to run up to an operator; its
  `run_workflow` tool has `upTo` from the contract.

Found on the way and fixed:
- **A completed execution could leave an operator "Running".** The unit's last report read the
  operators' states from statistics that had not caught up with the run's end; once in a few
  runs the last operator stayed "Running" for good, which the new bar made plain. The last
  report now says each operator's state as the run ended it (`settledState`): its own final
  state, else completed when the run completed, failed for the operator it failed on, and
  killed for any other, which the app shows as "Stopped", not as a failure.
- **The hidden buttons of a card took room from its name**, cutting "CSV File Scan" short on
  every card. Found in the test's screenshots.

## 2026-11-05 (session 11, later): a workflow can be run again

Reported after the polish was pushed: "Could not start the execution: conflict:
resource_name_idx", sometimes; then, more exactly, that a version run once could not be run
again, on the same unit or another.

The cause: the "Run" button named every execution `<workflow's name> v<version>` (since
session 9), and a name is the only one of its kind under its parent, so the second run of a
version was refused, in the name of the index. An execution nobody named had the same flaw
within one second (session 10's note).

Done:
- **The catalog names an execution nobody named, and the name is free**: `execution <UTC
  time>`, numbered when two of one workflow start within a second (`createNumbered` in
  `executions.go`). The app's "Run" names nothing any more. The rule is in the contract
  (`RunWorkflow.name`), so the agent's `run_workflow` reads it too.
- **A taken name is refused in words**: 409 `name_taken`, "another execution here already has
  this name", for anything made or renamed under a name another has (`store.ErrNameTaken`,
  `wrap`). It said `conflict: resource_name_idx`.

Verified: the catalog's suites with two new tests (six executions of one workflow within
seconds, each with its own name and at least one numbered; a name the caller chose refused in
words, for an execution and for a workflow); `make generate` reproduces the tree; the browser
scenario of an execution on the canvas now runs the same version a second time from the page;
the catalog and frontend images rebuilt and rolled out on OrbStack's cluster.

Also said by the user after trying the polish, and answered with an opinion, not yet with
code (their decisions are awaited): no line from a result to its port, the port lit instead
and a click on an operator showing its result; the icons in an open card are unclear (the eye
means "view result" in Texera, and was used for on and off); a button on an operator to run
up to it; results that were there and later "not available" (ports nobody marked, stored as a
side effect of scheduling and readable only through the unit that ran them); an open card
grows over its neighbours and the arrows; no cursors of other people; places are not part of
a version; and where what the agent adds is placed.

## 2026-11-05 (session 11, on the Mac): the canvas, executions on it, lineage as a graph, and where new things go

Asked to put everything else aside and polish the front end. The list: the icon at the top
left of a page lay over the resource's own icon; text was too small in many places; an
operator on the canvas showed almost nothing, and clicking it threw a panel open beside the
canvas; arrows were rigid; an execution did not show which operator was running or how a
result mapped to its operator and port; visualizations came out as raw tables; lineage was a
list of URIs; and, as a bug, things made after switching to another project still went to the
person's own. Session 10 (the warehouse) was committed and pushed first, at the user's word.

What was decided:
- **An operator is a card, edited where it is.** It says its settings in words, in one line
  or each on a line, as the viewer chooses; it opens into its own form. There is no panel
  beside the canvas any more.
- **An execution is shown on the canvas of the workflow that ran**, on the workflow's page
  and on its own, and a result is tied to the operator and port it came out of by a line.
- **How a canvas is looked at is the viewer's**, not the workflow's: how much the cards say,
  the card open, the result on screen are in no document and no version.
- **One rule for where new things go**: into the project the person works in, wherever they
  make them; with every project in view the app asks. The chat beside a page follows it too,
  which replaces session 9's rule (the resource's project when writable).

Done:
- **Shell and type.** A collapsed sidebar is a rail of its own (the way back, a new chat, the
  search), so nothing floats over a page; that floating button was what lay over the
  resource's icon. The two small text sizes are a step larger (nothing under 12px). A page's
  header is the name and one line: the tiny uppercase kind is gone (the icon says it), and so
  is the word "private".
- **The card** (`workflow/OperatorNode.tsx`, `workflow-model/summary.ts`). The operator's
  name and its settings as a person would say them: a file by its name, a filter as
  `medal = Gold`, code by its length, defaults left out. "Compact | Detailed" for the canvas
  and a chevron for one card (`canvas-view.ts`); the pencil or a double click opens the card
  into the form the panel had; Escape or "Done" closes it. The list of operators opens from
  "Add operator", and by itself for a workflow with none. Arrows are curves, drawn the same
  on every graph (`shell/canvas.ts`). The layout is for cards (`layout.ts`); cards that say
  more draw their rows further apart by one factor without moving anything (`density.tsx`);
  the canvas opens at a size its words can be read at and keeps in view the card that matters
  (`framing.ts`). The map of a workflow of a dozen operators or more lies over the canvas, so
  it is closed until the viewer opens it from a button with the zoom buttons, and stays as
  they left it (`controls.tsx`). A workflow's picture in a chat keeps operators as icons. The
  places kept for the icons operators once were are a leftover the live service drops
  (`live.ts`).
- **An execution on the canvas** (`execution/overlay.ts`, `results/`). Each card says where
  its operator stands (waiting, running, paused, done, failed and why) and its rows, second by
  second. Under the canvas, one tab per output port that holds a result; the one on screen
  rings its card, and a line runs from the tab to the port, following the canvas. "Run" stays
  on the page. An execution's page is the version that ran on the same canvas with the same
  results under it; its other tabs are Lineage and Details.
- **Charts.** A visualization operator's result is shown as the chart it drew. The unit cut
  every string to 100 characters for a table's cell, the chart's HTML included, so no chart
  could have been shown: it now serves the one `html-content` cell of such a result whole
  (`UnitApiResource.rowsOf`).
- **Lineage** (`lineage/`, built by a second agent in parallel). A graph read left to right,
  a card per thing and the words for what happened on each arrow, at two levels: resources
  (dataset, workflow, executions, results folded in) and data flow (file, version, execution,
  each result). Older executions fold into one card.
- **Where new things go** (`scope.tsx`, `preferences.ts`). `useDestination` is the one rule;
  the "New …" dialog names the project, and with every project in view asks for it, as the
  chat box does. A project made in the app is worked in at once; a project's page has "Work
  in this project". Preferences have one writer: it reads what the catalog has before it
  changes it, so the project pick and the dock's memory cannot overwrite each other, and it
  decides what is on screen meanwhile: a change shows at once and stays while it is written,
  and one the catalog did not take goes from the screen again.

Found on the way and fixed:
- **A result first read while its execution ran stayed as it was then.** A page of rows was
  kept for good; read early it was empty and stayed empty after the execution finished. A
  running execution's page now follows the rows reported so far.
- **The canvas and the editor answered each other over what was selected**, without end, once
  a card could open at the same moment it was picked. The store's pick is put onto the canvas
  only when the store changed it.
- **A canvas changed while its tab was not the one shown came back empty.** On an
  execution's page, "Detailed" and then at once "Details" and back left every card invisible:
  the canvas gave React Flow new cards whenever their spacing changed, which threw away what
  it had measured of them, and a card that is not on screen is not measured again. It keeps
  what was measured now, as the editor's canvas did; and a canvas framed while it had no room
  (which left it no place at all) is framed again when it is shown.
- **A chat made by its first message stood empty for a moment, with its box free.** The page
  that starts a chat leaves the first message for it, and the chat took the message only
  after it had drawn itself once: an instant that looks like the end of an answer. A model
  scenario took it for that, once in ten runs, and read the answer before there was one. A
  chat is busy with its first message from the first time it is drawn (`ChatView.tsx`).
- **The map lay over operators.** It sat at the top right of a large workflow, on the cards of
  the first row; see the map above.
- **A table's way to its next page lay under the button of the chat beside the page.** It
  stood at the right end of the results' footer, the corner that button floats over. It
  stands at the left, after the count of rows.
- **The line from a result ran across the form of a card open for editing.** While a card is
  open the line is not drawn; it is back when the card closes.
- **Nothing was made in the wrong project in the cases tried**: the reported bug could not be
  reproduced by picking a project and making things, as Alice or as Bob. What the catalog
  holds of that session (a chat in Bob's own project 25 s after his project "test" was made,
  no pick stored) fits a project that was made and looked at but not picked. The rule above
  closes that (a new project is worked in), the whole-object writes that could undo a pick,
  and the moment after a page loads when the working project was taken to be the person's own.

Verified, on OrbStack's cluster, upgraded in place (the frontend, live service and engine
images were rebuilt; nothing was wiped):
- Unit: frontend 231 tests with types and lint (74 new: what a card says of an operator's
  settings, the layout for cards, how a canvas is looked at, an execution on the cards and
  which result is a chart, the lineage graph's model and layout, where new things go, the one
  writer of preferences); live service 15; runtime 75; the engine's `UnitApiResourceSpec` 13
  (new: a table's cell is cut, a visualization's page is not).
- `k8s.sh check` on the final images: 40 scenarios and 35 Playwright tests (nine new: the four
  of `canvas.spec.ts`, the lineage graph, a project made in the app, "All projects" asking in
  the dialog and in the chat beside a page, the sidebar's rail). The bundle the cluster
  serves was compared with the tree source by source, through its source maps.
- With the model (Haiku 5.5), by hand: 4 scenarios (`pytest -m model`) and 4 Playwright
  scenarios. The one beside a page failed once before the fix above and passed nine runs of
  ten without it; with it, every run since.
- The scenario of the chat beside every page, twelve times in a row (168 chats), after its
  stand-in for the runtime was put in the runtime's order: the catalog has the turn before
  the stream says it is over. It wrote the turn after, and once in a few runs the chat then
  showed the answer without the question.
- By eye, in screenshots of the built stack (1440 by 900, light and dark): a workflow compact,
  detailed and with a card open; its latest execution with a table and with a chart and the
  line to the port; an execution's page; lineage at both levels; the rail; the dialogs with
  every project in view.
- A workflow of 151 operators on the cards (a scan and five chains of thirty): the first card
  1.2 s after the page is asked for, "Detailed" settled within 0.4 s, 60 frames a second while
  it is dragged, a card's form open in 0.1 s. Measured once, on the development build.

Not verified:
- **The reported bug itself**: nothing reproduced it, as said above.
- **The engine's whole suite.** One function of the unit's API changed; its spec ran and the
  scenarios read rows and a chart through it, but `sbt test` and the Python tests were not
  run again.
- **A chart where the internet cannot be reached.** Every visualization operator writes a
  page that loads Plotly from its CDN, and the frame it is shown in lets it. Where the CDN
  cannot be reached the frame stays empty.
- **Browsers other than Chromium, and screens narrower than a laptop's.**
- **The Compose stack**, as in sessions 9 and 10.

Seen and not changed:
- **The button of the chat beside a page floats over the page's bottom right corner**, on
  whatever is there: the last column of a table, the end of a chart's axis. That corner is
  where the button was asked for in session 9, so it stays; the results' controls were moved
  out of its way, and nothing to click belongs there.
- **Opening any dropdown logs a refused inline style** in the browser's console: the
  component library adds a `<style>` to hide a scrollbar and the page's policy
  (`style-src 'self'`) refuses it. Nothing shows wrong; it has been so since the dropdowns
  were added.
- **`packages/` is still outside the frontend's lint** (session 8's note). The files made or
  rewritten this session, and the lines changed in the others, were put through it by hand.
  Two findings in lines not changed remain (`workflow/View.tsx`, an effect's dependencies;
  `ui/primitives.tsx`, a label with no control).
- **A message that arrives in the instant a turn ends is passed over.** While a person's own
  turn is on screen the chat does not take messages from the watch, and it reads the history
  once at the end of the request; what the watch brings between that read and the chat
  counting as free again (someone else's note, in a group chat) shows only when the history
  is next read. The runtime writes a turn before it ends the stream, so a person's own turn
  is never affected; seen while reading why the scenario above failed.
- **Rows of a port in the middle** and **two executions in one second**, as in session 10.
  The app now says what happened to such rows ("it was not kept, and the computing unit that
  held it has restarted") and how to keep them.

Left out, by decision: a chart the app chooses for a result that is a table (only what a
visualization operator drew is shown as a chart); a small picture of the result inside a card;
cards that can be resized; places kept per density (an operator has one place, for cards that
say one line); other people's cursors and selections on the canvas; lineage below a result
(columns) and of chats and agents; choosing an execution's unit or warehouse on the canvas; a
layout for phones.

Next: lint over `packages/` as its own commit; the refused inline style (a nonce, or the rule in the app's own stylesheet); a
chart picked for a table, kept as a visualization operator so that it is in the version;
results read without the unit that ran; the items carried from session 10.

## 2026-11-05 (session 10, on the Mac): a warehouse is a resource: an execution runs on a unit and keeps its results in a warehouse

Asked, after a discussion of how the result warehouse is managed and how it should be, to
implement what was agreed, quickly and cleanly, and to test it. The agreed view is one
sentence: an execution runs on a computing unit and keeps its results in a warehouse. Until
now there was one warehouse, made by the catalog at startup from its environment and named
nowhere in the model; the engine ignored the warehouse a start request named; and the engine
still carried main's per-user warehouse feature, switched off.

What was decided:
- **A warehouse is a resource, like a computing unit.** The platform's own is built in; a
  project owns any other. There is no warehouse per person: what justifies a second warehouse
  is a different place to keep data, not a different person.
- **It is chosen like a unit and used like a unit.** The request's, else the workflow's, the
  project's, the platform's; whoever runs needs `use` on it. Reading stays decided by the
  execution.
- **Isolation is one rule.** A namespace per execution inside its warehouse, opened for the
  identity of the unit that runs it. People who may run on one unit share that unit; nothing
  special is promised on top of that.

Done:
- **The contract.** A kind `warehouse` (`api/catalog/kinds/warehouse.tsp`): `spec.storage`
  absent is a place of its own on the deployment's store; present, a store of the owner's
  (endpoint, region, bucket, a folder, a credential). `status.name` is its name in the lake.
  An execution records its warehouse (`spec.warehouse`, required); a workflow and a project
  name a default (`defaultWarehouse`), the settings the platform's (`defaults.warehouse`), a
  run may name one (`warehouse`); the settings list the stores a warehouse of someone's own
  may be on (`warehouseEndpoints`). The engine's `ResultStore` is the warehouse and the
  namespace (the lake's address went: a unit knows it from its own configuration), and a
  read of rows names the warehouse.
- **The catalog** (`internal/catalog/warehouses.go`, one file). The `Lake` port makes,
  updates and removes warehouses and opens namespaces in one; the Lakekeeper adapter no longer
  makes a warehouse of its own at startup. The platform's warehouse is seeded as a built-in
  and brought up to date at every start; any other is made in the lake when it is created,
  and the lake tries its storage first, so a refusal (a wrong key, no such bucket) is the
  caller's 400 with the lake's reason and nothing is made. A warehouse's place cannot change;
  its key follows its credential when the secret is replaced. The warehouse of an execution
  is resolved in one place and checked with the rest of the plan (`use`); expiry and deletion
  drop the namespace in the execution's own warehouse. A warehouse goes only when no
  execution keeps results in it. Executions made before this are given the platform's
  warehouse at the next start.
- **The engine.** A start request's warehouse is where the run writes everything, and a read
  names the warehouse it reads from; the unit keeps a catalog client per warehouse. What was
  left of the per-user warehouse feature of main is deleted (the lookup of a user's warehouse,
  the engine's own Lakekeeper client, the switch and the read guard).
- **The app.** Warehouses in the sidebar with a page like every kind's. "New warehouse" asks
  where it keeps its tables: the platform's store, or a store of one's own with its address,
  bucket, folder and credential. A warehouse's page shows its place and, for the project's
  writers, one button: "Keep <project>'s results here". An execution's page names its
  warehouse beside its unit. Sharing offers "may use", as for a unit.

Found on the way and fixed:
- **The lake writes a store's address back with a slash at its end.** Compared as text, the
  platform's warehouse looked moved at every start and its storage would have been replaced
  instead of its key refreshed. Found by reading the running lake before the first deploy;
  the adapter now compares places, and has its first tests (a stand-in for Lakekeeper's
  management API).
- **A warehouse cannot be dropped for some seconds after its last table.** Lakekeeper clears
  the files of dropped tables in the background and refuses to drop the warehouse meanwhile
  (`WarehouseHasUnfinishedTasks`, five to nine seconds here). The adapter waits for it, up to
  half a minute, so nobody above it retries; a warehouse that still holds a namespace is
  refused at once, in the lake's words.
- **A stale engine test.** `create_table` in the Python engine stopped making a namespace that
  is already there when units got identities of their own; its test still expected the call
  and failed. It now states the rule.

Verified, on OrbStack's cluster, upgraded in place from the stack session 9 left (no wipe; the
catalog's database was dumped first):
- **The upgrade itself.** The platform's warehouse was seeded as a built-in and the lake's
  `texera` warehouse kept as it was; all 214 executions in the store were given it (8 of them
  live, Alice's own); the rows of every result table of those 8 read back the same before and
  after, through the new engine.
- Unit: `make generate` reproduces the tree; catalog `gofmt`, `go vet`, `go test` (new: the
  warehouse suite, the Lakekeeper adapter); runtime 75 tests, live service 15, frontend 157,
  each with types and lint; the engine's `sbt test` 5,347 passed and its Python tests 1,409.
- **Against the real lake.** A warehouse on the platform's store is made in a tenth of a
  second; one on a store of its own is refused with Lakekeeper's own reason for a wrong key
  ("the request signature we calculated does not match") and for a bucket that is not there,
  taken with the right key, and refused before the lake is asked when nobody listed the
  address. A workflow ran into each kind and its rows were read back; the lake listed the
  execution's namespace in the warehouse the execution names and not in the platform's.
- `k8s.sh check` on the final images: 40 scenarios (new: `test_warehouse.py`, five) and 26
  Playwright tests (new: a warehouse made from its page and kept as its project's; the page
  of every kind is now fourteen, for the agent beside it, for who is on it and for a link
  that was not shared).
- With the model (Haiku 5.5), by hand: 4 scenarios (`pytest -m model`) and 4 Playwright
  scenarios, as before.

Not verified:
- **A store other than the stack's own RustFS.** The scenario for a store of one's own names
  the stack's RustFS with a place and a credential of its own, so the path is the real one
  (the lake's check, the key from the credential, keys handed out per table), but no second
  store and no second key were tried. AWS S3 itself will not work as it is: it hands out
  short-lived keys only for a role, and a warehouse names an access key (left out below).
- **The Compose stack**, as in session 9: `test.sh gate`, the `local` scenarios and the
  engine's integration suites on the REST catalog were not run; the cluster was upgraded in
  place.
- **The frontend's lint still does not reach `packages/`** (session 8's note).

Seen and not changed:
- **Rows of a port the catalog names no table for** (an operator in the middle that nothing
  marks as a result) are served from the memory of the unit that ran the execution, so they
  are gone when that unit restarts. Restarting the units for this upgrade took them from four
  of Alice's earlier executions; their result tables were untouched. The tables are still in
  the lake under the engine's own keys; the catalog has no name for them.
- **Two executions of one workflow started in the same second** collide on their default
  name, as two chats did before session 9.

Left out, by decision: what a warehouse holds and what it costs (usage per warehouse, quotas);
reading results without the unit that ran the execution; a store that needs a role instead of
a key (AWS S3); taking the deployment's own store key away from the units; choosing a
warehouse for one workflow or one run from the app (the API takes both; the app sets the
project's); a warehouse that can be restored after it is deleted.

Next: `test.sh gate` on the Compose stack; a second store with its own key (MinIO beside
RustFS) in the scenario; usage per warehouse; results read from the warehouse when the unit
is gone, the ports in the middle included; roles for AWS S3; the warehouse picker beside the
unit's on a workflow's page; the items carried from session 9.

## 2026-11-05 (session 9, on the Mac): people together: sharing, a workflow and a chat shared live, the agent beside every page

Asked for sharing as a core experience (a project, a chat, a workflow or a dataset shared with
another person, who finds it and opens it, with access decided as everywhere else: by the
catalog asking OpenFGA; there is no access control service of our own any more),
collaboration on a chat and on a workflow that reuses an existing CRDT, an icon of the people
on a page at its top right, and a chat agent on every resource's page that knows the page; all
of it clean and minimal, and tested on every kind of page. Three research passes and two rounds
of design discussion came first; no code was written until the design was agreed.

What was decided:
- **The catalog stays the authority.** Who may do what and what the versions are is the
  catalog's. A live session is a working copy of one resource, named by its rid.
- **A chat needs no CRDT.** Its messages are an ordered log the catalog already holds and
  streams; the session of a chat carries who is there. No product found models a chat as a
  CRDT.
- **A workflow is a Yjs document** in a session of Hocuspocus 4.8 (MIT), on Bun. Y-Sweet is
  orphaned, y/hub and Liveblocks' server are AGPL, the Go port is too young. Loading and
  saving belong to the service, never to a browser: the stale saves of a leader browser are
  what other products had to fix later.
- One layout for everyone; every save stays a version; a message asks the agent unless it is
  posted as a note; the chat beside a page is bound to nothing.

Done:
- **The agent beside a page.** A chat button at the bottom right of every resource's page
  (`packages/chat/src/ChatDock.tsx`, mounted once in the shell). The chat is an ordinary
  conversation; each message carries AG-UI's `context` of the run: the kind, the name and the
  URI of what is on screen, the version when one is open, and what the page adds (the operator
  selected on a canvas). The runtime writes it into the turn's state, and the agent's prompt
  says what "this" then means. The page settles before the agent is asked: a workflow's
  session saves, so the agent reads what is on screen. The app remembers the chat used beside
  each page (`preferences.dock`); the chat is made in the resource's project when the person
  may write there.
- **The live service** (`live/`, a workspace member; `@texera/service-auth` holds the service
  token it shares with the runtime). One session per resource behind the gateway at
  `/live/sessions`; the token goes in the protocol's first message and the service asks the
  catalog who it is and what they may do, again every half minute. Its rules are one file,
  `live/src/rooms.ts`, and `live/README.md` states them.
- **Who is here.** Everyone in a session says who they are in its awareness state; the page of
  every kind and every chat shows them at its top right, the person first, each with a colour
  of their own (`shell/Presence.tsx`).
- **A workflow edited together.** `@texera/workflow-model/live` is the spec as a document:
  operators and links keyed by id, an operator's properties a map of their own, the layout
  beside them and not in the spec. Everything that writes goes through one function,
  `applyChange(doc, from, to)`: a person's edit, a version written elsewhere, the first load.
  The editor's store holds no draft and saves nothing (`workflow/document.ts`,
  `workflow/editor.ts`): it mirrors the document. The service saves a moment after the edits
  stop, as a version that names the people whose edits it holds (`onBehalfOf`, `contributors`
  on a version; migration 0005 with the table that keeps a session's document), follows the
  workflow's event stream and takes a version written elsewhere into the open document, and
  says in the session's own awareness state how the document stands with the catalog. A
  version the catalog refuses leaves the edits on screen with "Not saved" and why, for
  everyone; such a document is not let go when the last person leaves, and the save is tried
  again. `Run` asks the session to save and runs the version it answers with.
- **A chat together.** The runtime keeps the answer in the catalog while it streams
  (`run/keeper.ts`, every 400 ms, one write at a time), so everyone else in the chat watches
  it arrive. In a chat several people write in, the model reads each message under its
  writer's name and is told whom it is answering. A note is a message of no turn, posted from
  the box without asking the agent, also while someone else's turn runs.
- **Sharing.** A Share button at the top right of every page: the link, and who it is shared
  with. `GET /resources?shared=true` and a "Shared with me" page in the sidebar: what a person
  holds a grant on and does not own, whatever its kind and project. A link to something not
  shared says so (`shell/OpenError.tsx`). A watch asks the right to read again on every beat,
  and a page turned away by the watch or by the session asks the catalog again, so a grant
  taken back closes an open page within half a minute.
- **The agent beside people.** The workflow skill and the `edit_workflow` tool tell the agent
  to name the head it read (`expectedHead`); an edit against a head that moved is a conflict,
  refused before the patch is tried on a spec the agent never read.

Found on the way and fixed:
- **Grants could be lost on their way to the authorizer.** Two relays of the outbox at the
  same moment (two requests, or a request and the timer) sent the same entries; OpenFGA
  refuses a request that holds a tuple already there, the adapter read that as "already
  written", and a new tuple that shared the request was dropped and marked done. An owner was
  then refused on their own resource for good. It showed when four browser files ran at once.
  The relay now runs one at a time and applies entries in order (of several about one tuple,
  the newest stands); the adapter has OpenFGA ignore duplicates itself, pinned by the port's
  contract test; and every start of the catalog writes the authorizer's whole copy again
  (`Relay.Rebuild`, from the store's `AllTuples`, which nothing called), which put back what
  this stack had lost.
- The gateway's `/mcp` route also matched the app's `/mcp-servers/...` pages, which then came
  back blank (401). The MCP and live routes are prefixes with the trailing slash.
- A list asked for more than 200 items silently returned 50, so the operator palette showed 50
  of 165 operators. A page now holds what was asked for up to the most, and the palette reads
  every page.
- Two chats started in the same second in one project collided on their name.
- The share form offered to take back the owner's own grant, which the catalog refuses.
- The places each person kept for a canvas in their preferences are no longer read; migration
  0006 drops them.

Verified, on OrbStack's cluster, upgraded in place from the stack session 8 left (no wipe;
Alice's own chats, workflows and units were kept, and the scenarios' leftovers removed):
- Unit: `make generate` reproduces the tree; catalog `gofmt`, `go vet`, `go test` (new suites:
  the live document and the versions saved for people, the shared list, a page of the size
  asked for, a watch that ends with the right to read, a stale patch as a conflict, the relay,
  the rebuild over the real tables, migration 0006) and the authorizer's contract test against
  the stack's OpenFGA; runtime 75 tests, types, lint; live service 15 tests, types, lint;
  frontend 154 tests and types.
- `k8s.sh check` on the final images: 35 scenarios (new: the shared list, a watch ended by a
  grant taken back, a note, the live document's routes) and 25 Playwright tests in four files
  (new: `dock.spec.ts`, `sharing.spec.ts`, `collaboration.spec.ts`, 16 tests; `TESTING.md`
  says what each proves). The page of every kind, thirteen of them, is covered for the agent
  beside it, for who is on it, and for a link that was not shared.
- With the model (Haiku 5.5), by hand: 4 scenarios (`pytest -m model`) and 4 Playwright
  scenarios. New: asked "what is this dataset" and "what does this workflow do" from beside
  their pages, the agent read that dataset's file and that workflow and made no other; and
  asked by Alice for Bob's number plus one, it answered 42 from the note Bob had posted
  (41), naming both, while Bob watched the answer arrive before the turn ended.

Not verified:
- **The Compose stack.** `up.sh` and `down.sh` start and stop the live service the way they
  do the runtime, and the gateway's Compose configuration routes `/live/`, but `test.sh gate`
  and the `local` scenarios were not run; the cluster was upgraded in place.
- **The engine's sbt modules** were not rerun (untouched).
- **The frontend's lint still does not reach `packages/`** (session 8's note); the new files
  there pass the type check and their tests only.
- **A restart of the live service while a document is unsaved** loses those edits by design
  (see `live/README.md`); nothing tests it.

Left out, by decision: other people's cursors and selections on the canvas; text merged inside
a property (two people typing in one Python operator's code is last write wins); a turn that
outlives the request of the person who asked, and a stop any member can use; a grant to a
group expanded in "Shared with me"; more than one live service; approval before the agent
shares or deletes.

Next: `test.sh gate` on the Compose stack; the lint over the packages (its own commit); a
rebuild of the authorizer on request for a catalog too large to rewrite at every start; the
items left out above, cursors first; a `cancel_execution` tool; smaller tool results and a
summary of long chats.

## 2026-11-05 (session 8, on the Mac): built-ins by project, chats that store choices, one MCP server

Asked, after five rounds of design discussion with no code, to implement what was agreed:
built-in components that every project inherits, a chat that is bound to no computing unit,
the dataflow MCP server merged into the catalog's, and the noun "execution" instead of "run";
with one principle, a strictly clean design. Session 7's split of the tools into two servers
and its `texera.builtin` label are replaced by this entry.

Done:
- **One MCP server.** `/mcp/catalog` holds all 23 tools: a workflow is a resource and running
  it is a verb. `/mcp/dataflow`, the `server` tag of `x-mcp` in the contract and the seeded
  `dataflow` server are gone. A test pins the tool list, and another that the server's
  instructions name every tool and no word shaped like a tool that is not one.
- **Built in means "in the platform's project".** The system project is named Built-in, is
  public and usable by everyone, and is the only mark: the `texera.builtin` label, the public
  visibility of each built-in, `spec.builtin` of an MCP server, `status.builtin` of an
  operator and `catalogTools` of an agent template are removed (migration 0004 clears them on
  an existing stack). One rule in `Service.require`: a permission that changes something, on a
  resource of that project, is `409 builtin` for everyone but the platform, administrators
  included, and nothing is added to the project or moved into it. The seed makes the project
  what the release ships: a changed spec is a new version, a changed description is taken,
  and what an older release shipped is removed (`retire`), the settings' defaults moving off
  it. A list shows what can be opened: a public project makes its resources everyone's to
  list.
- **A chat stores choices and is bound to nothing.** A conversation's spec is optional
  choices (`template`, `modelEndpoint`, `computingUnit`, `environment`, `mcpServers`); a new
  chat stores `{}`. `catalog/internal/catalog/chat_settings.go` is the one place that says
  what a turn runs with: the chat's choice, else the project's default
  (`defaultModelEndpoint` and `mcpServers` are new on a project), else the agent's own or the
  platform's. Add-ons a chat lists replace the agent's and the project's; the catalog's own
  server always stays; a choice the caller may not use is passed over and reported
  (`skipped`). `GET /conversations/{rid}/settings` answers for a chat,
  `GET /projects/{rid}/chat-settings` for one not started yet. The runtime reads the answer
  at each hop and builds the agent from it; an answer records its model endpoint and servers
  (migration 0003). A chat's unit is a preference: "Automatic" stores none, a call can name
  another, and one the caller may not run on is passed over.
- **Scope.** A list takes `?scope=<project>`: that project and the platform's. A call made in
  a chat defaults to the chat's project, for lists and for where a new resource goes (it went
  to the person's home project).
- **The app.** The sidebar picks the project a person works in (Personal by default, kept in
  the preferences, or all projects) and groups the kinds: Work, Activity (Executions), Agent
  (Agents first), Projects. A chat starts by typing; its box shows the agent and picks the
  model, the unit and the add-ons, and each pick says what its kind says about it (the model
  an endpoint serves, a unit's state). A built-in has a badge in lists and a read-only page.
  "New computing unit" asks for memory and CPU. A chat's details say what it runs with and
  which level chose each.
- **Naming.** The noun is "execution" wherever a person or an agent reads it: the contract's
  descriptions, the app, the prompt and the skills, the API's messages ("the execution is not
  running"), the default name (`execution <UTC time>`), the docs, the tests. The verb stays
  "run": `run_workflow`, `POST /workflows/{rid}/run`, the Run button.
- **Found on the way and fixed.** A resource without versions whose new spec named nothing
  kept its old reference edges, so a unit or a model endpoint that a project or a chat once
  named could never be deleted (`SpecUpdate.From`, `replaceReferences`). The chat box looked
  idle between sending and the first event of the stream. The browser tests left their
  datasets, workflows and operators in Alice's Personal project on every run, and the
  scenarios' cleanup skipped skills and a project's defaults; both clean up now.

Verified, on OrbStack's cluster, upgraded in place four times from the stack session 7 left
(no wipe; the data in it was kept):
- Unit: `make generate` reproduces the tree; catalog `gofmt`, `go vet`, `go test` (new suites:
  built-ins, chat settings, scope, released references, the built-ins' migration, the seed's
  description and removal); runtime 64 tests, types, lint; frontend 102 tests and types.
- `k8s.sh check` on the final images: 30 scenarios (new: `test_builtin.py`, `test_scope.py`,
  `test_chat_settings.py`) and 11 Playwright tests (new: the agent's page, the project scope,
  the chat's settings, the unit's size).
- With the model (Haiku 5.5), by hand since no script runs them on a cluster: 4 scenarios
  (`pytest -m model`) and 2 Playwright scenarios, one of them an execution that went to the
  unit the chat prefers with no unit in the agent's call.
- A walk through the app in a browser as Alice, in a project made for it and removed at the
  end, with 15 checks made outside the page: the averages the agent reported against the CSV
  (5.006, 5.936, 6.588); the chat storing `{}`; the workflow the agent made being in the
  chat's project; the execution on the unit the settings fall back to, under the name
  `execution <time>`; every answer recording its agent version, its model endpoint and two
  servers; the model picker naming the model each endpoint serves; and, in the same chat, a
  literature question answered with three papers, each returned by a PubMed tool call of that
  turn. PubMed, which answered HTTP 500 all through session 7, answered. The one problem the
  browser logged is a Content Security Policy warning about an inline style, there before
  this session.

Not verified:
- **The Compose stack and a deployment from nothing.** `test.sh gate` and the `local`
  scenarios (the lake, the unit's doors, the unit restart) were not run, and the cluster was
  only upgraded in place. A seed into an empty database is covered by the Go tests alone.
- **The engine's sbt modules** were not rerun (untouched).
- **The frontend's lint does not reach `packages/`.** `bun run lint` passes, but biome skips
  paths outside its config's root, so it checks the app's 19 files and none of the 128 under
  `packages/*/src`, where most of the frontend is; this has been so since the first commit.
  Run over the packages with a config of their own, biome reports 133 findings: 87 files to
  format, 26 with unsorted imports, and 20 from lint rules (13 accessibility findings in
  `ui/src/data-table.tsx`, `ui/src/primitives.tsx` and `kinds/src/shell/Access.tsx`, 6 from
  one suppression comment placed where it does not apply in `kinds/src/workflow/View.tsx`, and
  an index used as a key in the agent's form). None is a behaviour bug. Fixing it is a
  mechanical change of about 3,900 lines in 94 files, left out of this entry on purpose.

Left for later, by decision: approvals and a Manual or Auto mode; the agent creating units;
sub-agents and background runs; duplicating a built-in to customise it; the Keycloak theme and
Google sign-in; a size limit and GPUs for units.

Next: make the lint cover the packages (its own commit); `test.sh gate` on the Compose stack;
a `cancel_execution` tool; smaller tool results and a summary of long chats; a grant to a
group is not expanded when a list is filtered.

## 2026-11-05 (session 7, on the Mac): one agent, a clean tool split, errors that say why

Asked, after an end-to-end run of the cluster deployment through the browser with the real
model found six defects, to fix them and to simplify the agents: one agent as the entry to
every chat, basic tools with MCP servers as add-ons, no overlap between the catalog and the
dataflow MCP servers, and a proper way to store and manage the agent. One commit on top of
`ca4f8c750`.

Done:
- **One agent.** The Data Analyst and the Bio Researcher are replaced by the Texera Agent,
  the settings' default and the only seeded template. Its card and system prompt are a file,
  `catalog/internal/catalog/agents/texera-agent.md`, embedded like the skills (`prompts.go`
  is gone); `seed.go` gives it the model endpoint, the four skills, the dataflow server and
  the bio add-on, and the loop rule `free` (one agent answers every kind of question, so
  "compute before you answer a data question" is a rule of the prompt, checked by the
  evals). The app has no agent picker, no switcher and no agent templates link; the kind, its
  page, `/mode` and the handoff tool stay in the code, unused. On a stack seeded by an older
  release the old agents stay for the chats that use them, and the settings' default moves
  to the Texera Agent when it pointed at one of them.
- **Built-ins change only through the platform.** `UpdateSpec` and `Delete` refuse a
  resource labelled `texera.builtin` for anyone but the service caller (`409 builtin`):
  the seed already overwrote such an edit at the next start, silently, also an
  administrator's.
- **The two MCP servers share no tool.** An `x-mcp` operation under `/workflows` is a
  dataflow tool (9: create, get, edit, validate, run, get_execution, pause, resume,
  get_port_result); the dataset file tools, `list_operators` and `list_computing_units` moved
  to the catalog server (14); `create_agent_template` is no longer a tool. The contract was
  regenerated; `make generate` reproduces the tree.
- **Basic tools and add-ons.** A server with `spec.builtin` is the platform's and a turn
  fails without it. Any other server is an add-on: one that cannot be reached within 10 s,
  or whose credential cannot be leased, is left out of the turn, and the agent is told so in
  the turn state. One unreachable server used to fail every turn of every agent that mounted it.
- **The chat's unit** (defect 1). The unit picked when a chat starts was stored and never
  read. The catalog now applies it: a compile or a run takes its unit from the request, else
  from the conversation named by the call's origin, else from the workflow, the project, the
  settings. The agent is also told the unit, with the date, at the end of every step's
  prompt (`chat-context.ts`), and passes none.
- **The bio server on Kubernetes** (defect 2). `deploy/kubernetes/texera.yaml` sets
  `TEXERA_BIOMCP_URL=http://gateway:28088/bio-mcp`; the default, the public URL, is the pod
  itself from inside the agent runtime, so every Bio Researcher turn on a cluster failed with
  "Unable to connect". `test_cluster_agents.py` reads every add-on's URL from the runtime's
  pod; `k8s.sh check` ran no model test, which is how this went unseen.
- **A failed turn stays on screen** (defect 3). A turn that failed outside the loop left no
  record, and the page dropped the live error when it re-read the history. The runtime
  writes the error as a part of an assistant message; the page keeps an error the catalog
  never got (`settled`), and settles only once its own request is over.
- **The end of an answer is on screen** (defect 4). The chat scrolled on new messages only;
  when the persisted copy replaced the live one, `content-visibility` gave it a 120 px
  placeholder and the chat lost its end. The newest messages are always laid out and the chat
  follows its content's size while it is at the end.
- **The engine's errors reach whoever asked** (defect 5). Three causes. The generated client
  decoded every error body into the contract's `Error` and failed when the unit answered
  Dropwizard's numeric code, so every refusal became `502 … cannot unmarshal`: the client now
  reads the status and the body itself and the catalog keeps their class and words
  (`UnitFailed`). The unit answers in the contract's shape (`UnitErrorMapper`). And a Python
  operator that raised paused its worker for a console nobody attends, so the run waited for
  ever: the unit fails the run with the exception as its error. A port the plan names answers
  an empty page until its table is written, instead of an error at the start of every run.
- **Smaller.** An attachment travels as AG-UI binary content, is kept as a resource part of
  the person's message and stays a card (it turned into a line of text with a URI after the
  turn, and never reached the chat's resources); a resource shows once per message; a failed
  tool shows the error's own message.
- `k8s.sh up` works on a local cluster that is not kind (`TEXERA2_KUBE_CONTEXT=orbstack`):
  the gateway is made a LoadBalancer there, which such a cluster publishes on localhost.

Verified, on OrbStack's cluster from a deleted namespace, deployed by `k8s.sh up` alone:
- Unit: catalog `go vet` and `go test` (with the new suites for the engine client, the MCP
  bridge and split, the one agent, built-ins, the chat's unit, the unit's errors); runtime
  65 tests, types, lint; frontend 79 tests, types, lint; engine module 1389 tests and
  `scalafmtCheck`. The other sbt modules were not rerun (untouched).
- `k8s.sh check`: 22 scenarios (7 new: engine errors, the chat's unit, the runtime reaching
  its servers) and 7 Playwright tests (new: a failed turn across a reload, a long first
  answer on screen).
- With the model (Haiku 5.5), by hand since no script runs them on a cluster: 4 scenarios
  (`pytest -m model`) and 2 Playwright scenarios, among them a run going to the chat's unit
  with no unit in the agent's call, and one agent researching, analyzing and sharing.
- A walk through the app in a browser, checked against numbers computed from the CSV, the
  catalog and the engines' logs: an attached CSV answered correctly with the answer's end on
  screen; a unit created from the library page, ready in 4 s; a chat on it whose run went
  there (the agent passed no unit; that unit's engine log names the run, the static unit's
  does not); a Python operator raising `"boom pid " + str(os.getpid())` failed the run and
  the agent reported the pid, which only the engine knew.

Not verified:
- **PubMed.** NCBI's `esearch` with `retmode=json` answered HTTP 500 all day, also from this
  machine, so every literature search failed and no citation could be checked. The agent
  said so and cited nothing from memory.
- **The Compose stack.** Only the cluster was run: the `local` scenarios (the lake, the
  unit's doors, the unit restart) and `test.sh gate` were not. The doors were probed by hand
  from a pod (nobody 401, a person 403).

Next: run `test.sh gate` on the Compose stack; a `cancel_execution` tool (the dataflow
server pauses and resumes but cannot cancel); smaller tool results and a summary of long
chats (one question still replays every tool result of the chat at every step); approval
before a tool that shares or deletes; `PLAN.md` still describes two agents.

## 2026-11-04 (session 6, close): both gates green; the model scenarios own their data

Asked to make sure the branch works end to end in both modes before stopping: the Compose
stack with host processes (`test.sh gate`: wipe, up, every layer) and the kind cluster with
units made as resources (`k8s.sh up && k8s.sh check`). Also asked whether both modes put the
gateway in front: they do, the one `envoy.yaml` (JWT against the realm's keys, then the
catalog's `ext-authz` decision, the catalog verifying the token itself as well); `k8s.sh`
derives the cluster's copy from it and only the gateway is exposed there.

Done (one commit): the two Playwright scenarios that drive the real model asked about "my
dataset named iris" without making one; nothing seeds it (the pytest scenarios make theirs in
a per-test project and delete it), so on a wiped stack the Data Analyst found no iris and,
rightly, built nothing. Each now makes the dataset in a project of its own and removes it
after the test with what the chat made (runs, workflows, the conversation), passing or not.

Verified: the local gate from a wiped stack: catalog, runtime, frontend and engine unit
tests; the adapter and engine contract suites; the scenarios (14, then the 5 local and
destructive ones); Playwright without the model (7); the real-agent scenarios (3). The model
Playwright step failed on the iris gap and passed on rerun after the fix (2 of 2, nothing
left behind for alice or bob); the model-free suite passed again with the cleanup hook in
place. The cluster gate after `k8s.sh up` rolled the branch's images: 15 scenarios including
the unit made as a resource beside the static one (gone again at the end), 7 Playwright tests.

Next: unchanged from the entry below. The model-free Playwright tests still leave their
uniquely named workflows and datasets in alice's home project; the model scenarios no longer do.

## 2026-11-04 (session 6, later still): watch, group chat, run controls

The question was how people and agents collaborate: several people in one chat, and the
engine's interactivity (pause, status, results while a run goes), which 2.0 had routed out
when it closed the unit's doors. Both land on one primitive, "watch a resource", with the
catalog as the one entry for every verb.

Done (one commit on `texera-2-0`):
- `GET /resources/{rid}/events`: server-sent events for whoever may read the resource, fed by
  an in-process broker on the store's writes (`store.Change`, `catalog.Broker`): `resource`
  after each change, `message` for a conversation's messages, `deleted`. Opens with the
  messages after `after` and the resource itself; a keepalive every fifteen seconds; each
  change re-read through the watcher's permissions. Envoy routes it without a timeout.
- A shared chat is a group chat with no new model: a grant is the membership, every message
  has its author, the turn lock records its holder (`status.activeTurnBy`). The chat page
  follows the stream, names the others' messages, shows "Bob is talking to the Data Analyst"
  and disables sending (not stopping) while his turn runs.
- Run controls through the catalog: `pause` and `resume` (contract, MCP tools, unit routes
  that feed the engine's input bus, a `paused` phase), 409 when the phase does not fit; the
  unit reports progress once a second (operator states and counts as OpenLineage RUNNING
  events) and its pause/resume transitions, and the catalog ignores progress that arrives
  after the terminal report. The run page watches instead of polling (a slow poll stays as a
  fallback) and has Pause and Resume.
- The generated TypeScript client leaves the streaming route out (hey-api's query plugin
  cannot type it); `packages/kinds/src/watch.ts` reads it by hand, `useWatch` keeps the
  resource's query fresh. `openapi-ts` now runs under Bun to pre-process the document.

Verified: catalog `go vet` and the whole suite (new `watch_test.go`: the group chat over the
stream, the run watched with progress, pause/resume forwarded and the phase following the
unit, late progress ignored; the route coverage test); the unit's `UnitApiResourceSpec`
(paused mapping) and the web specs; frontend typecheck, lint and vitest (watch reader, the
author in the history); scenarios: fourteen pass against the stack including the new
`test_collaboration.py` and `test_controls.py` (a real Python run paused and resumed, every
row at the end); Playwright: the run page follows a slow run and pauses and resumes it, two
browsers in one chat; the evals scenario "Bob asks in Alice's chat" with the model.

Next: token-level streaming of a reply to the other members (today step by step, as the
runtime rewrites the message); the canvas as a shared document (Yjs with a sync service, as
the 1.0 frontend had); the rest of the engine's interactive protocol as catalog verbs
(retry, skip, reconfigure, the Python console); Postgres LISTEN/NOTIFY behind the broker when
the catalog runs as replicas. Steps 4 and 5 of the authorize/compile/materialize note stay
deferred.

## 2026-11-04 (session 6, on Linux): M1 steps S1 to S10

Done and verified (branch `texera-2-0`, each step a pushed commit):
- S1 Contract v2 under `api/catalog/`: the envelope, one file per kind (fifteen kinds), the
  subresources, the AuthZEN and OpenLineage routes, `x-texera-kind`, `x-texera-permission`
  and `x-mcp` (with the server); OpenFGA model v2 (owner, editor, viewer, user; parent;
  computed permissions). Actions are verb subresources (`/{rid}/run`), not `:verb`, because
  Go's router cannot match a colon inside a segment; the URI grammar never carried verbs.
- S2 `cmd/catalogen` emits the kind table (Go and TS), the JSON Schema bundle, the MCP tool
  table, the permission table and the index migration; oapi-codegen generates types only; the
  server is generic over the kind table and validated against the OpenAPI document in tests.
  `internal/uri` is the one grammar with round-trip tests and the reference extractor.
- S3 Stack: OpenBao (dev mode, `texera` KV v2 mount) with `up.sh` loading the model key over
  stdin; Envoy serves `/catalog/v1/settings/public` without a token and routes `/bio-mcp` to
  the bio MCP service copied from dknet-ai-public (`bio-mcp-service/`, a bun workspace,
  :23010, dev API key `texera-bio-dev-key`).
- S4 Store (eleven tables, generic over kinds, tests on the stack's Postgres) and ports
  (Identity, Authorizer, SecretStore, BlobStore, UnitProvider, LineageSink) with one adapter
  each plus memory adapters; contract suites pass in memory and against OpenBao, RustFS and
  OpenFGA under `-tags integration`.
- S5 `internal/catalog` (one Service, one file per area), `internal/server` (generic routes
  from the kind table plus the actions), `internal/mcp` (the bridge: a tool call is the
  operation's request against the API in process), `cmd/catalog` wiring. Tests: every
  response validated against the contract; every operation of the permission table routed;
  lifecycle, sharing, files, references and delete refusal, a run against a fake unit with
  OpenLineage events, ports, rows, save with derivedFrom and the lineage walks, conversations
  and turns, origins, credentials and leases, units and AuthZEN. `go test -p 1 ./...` green
  (the store and server suites share the test database, so serial).

Decisions taken while implementing (PLAN.md decisions still hold):
- The outbox relay flushes synchronously on the write path (`Relay.Flush`), so a resource is
  visible to the authorizer before its request answers; the background loop retries failures.
- Downloads are served as `application/octet-stream` as the contract says, with the file's
  own type in `X-Texera-Content-Type`; a ranged read answers 206 with `Content-Range`.
- A slash inside a file path is percent-encoded in the URL (`files/dir%2Ffile.csv`); the Go
  router also accepts the raw form.
- The run resolution order is request, workflow, project, settings; the settings singleton is
  seeded with the Data Analyst template, the default environment and the dev unit.
- `view=summary|full` applies to the operator list only (the property schemas are heavy);
  other lists carry full envelopes.

- S6 Engine, verified unchanged against the new catalog on the live stack. Per decision 7 the
  dev database and the OpenFGA store were dropped and recreated (the old `principal` table
  lacked `admin`), and Envoy was recreated so it knew the public settings and `/bio-mcp`
  routes. `smoke-catalog.sh` green end to end (seeds, versions, sharing, files and references,
  a conversation turn with an origin, both MCP servers: 10 catalog and 13 dataflow tools);
  `smoke-run.sh` green (validate, run, ports, rows, the used/produced/derivedFrom lineage,
  the saved CSV); `smoke-env.py` PASS (a UDF importing `humanize` fails without an
  environment and completes with one, the build shows `ready`, the execution pins `@1`).
- S7 Agent runtime rewritten as a stateless turn runner over contract v2: `config.ts` carries
  no model key (the endpoint and its leased secret come from the catalog), templates, skills,
  MCP servers and model endpoints are read by URI through `resolve`, the ReAct loop takes
  `interruptTools` and reports an `interrupted` outcome, the turn pins the template version
  at `startTurn`, persists each step through `replaceMessage`, handles `/mode` natively and
  runs the handoff loop (the conversation's template changes, `texera.handoff` is emitted).
  `bun test` 45/45, typecheck and lint clean. On the stack with the real model: the Data
  Analyst answered the iris question in 11.8 s (search, files, read, skill, create, validate,
  run, port result, answer); `smoke-chat.py --demo` ran the M1 scenario: the Bio Researcher
  gave three cited CRISPR off-target ideas, then handed the conversation to the Data Analyst,
  which built and ran the workflow and reported the averages; the conversation's template
  changed and every assistant message carries the template version that wrote it.

- S8 Frontend rebuilt on contract v2 (commit 60516ce70). The kinds package takes what a kind is
  from the generated kind table and names everything with the one URI grammar (`uri.ts`,
  mirroring `internal/uri`, with round-trip tests); a generic page renders any kind from its
  envelope: a form generated from the kind's JSON Schema (JSON a click away), versions, access
  (visibility and grants with principal search), lineage walked over the edge table plus the
  specs that reference it. One file per kind; folders for the workflow editor (the spec holds no
  positions, the app lays the graph out), the execution page (phase, operators, the port view
  with paged rows, save as dataset), the agent template form, the shared files tabs and the
  credential's write-only secret form. The engine WebSocket client is gone: runs are the
  catalog's. Routes are the catalog's paths (`/workflows/{rid}/executions/{eid}`); `?panel=`
  holds the same path. The chat labels every assistant message with the template version that
  wrote it, shows the current agent with a switcher that goes through `/mode`, and renders
  handoffs as dividers; the runtime records a handoff or a switch as a system note naming the
  new template (commit 7b20b051d). vitest 55 green; typecheck and lint clean.
- S9 Agents demo. Playwright on Chrome against the dev stack, six tests green: sign-in and a
  chat with an attachment that becomes a dataset; switching agents through the switcher and
  `/mode` without a model; creating an agent template from its page, editing it into v2 and
  starting a chat with it; a saved result's lineage (derived from the port, the run, the file it
  read); with the model, the Data Analyst's loop that tracks the workflow it built, and the Bio
  Researcher's cited ideas followed by the handoff to the Data Analyst, whose answer carries the
  averages and who then shares the dataset with Bob through the catalog server (checked as Bob).
  `smoke-chat.py --demo` runs the same three turns from the command line.

Decisions taken in S8 and S9:
- Names are unique per project and kind, so a new chat is named by its agent and its start
  time, and a second upload of the same file name gets its own dataset.
- The switcher sends `/mode <uri>` through the runtime rather than writing the conversation's
  spec itself: one path for a change of hands, recorded the same way whoever asked for it.
- System notes stay out of the model's history; the model sees a change of agent through the
  labelled messages.

- S10 Close. The gate ran as `down.sh --wipe && up.sh && test.sh` on this machine: the wiped
  stack came up with the model key loaded into OpenBao; thirteen steps, twelve green on the
  first run (catalog, runtime and frontend suites; engine `sbt test` 145 s and its integration
  suites 199 s; smoke-catalog, smoke-run, retention, environments, the real-model chat, the
  Playwright suite of six, the unit restart). The one failure was the demo's last turn: on a
  wiped stack Bob had never logged in, so `search_principals` found nobody to share with. The
  demo now logs Bob in first and passes (ideas, handoff, analysis, share, checked as Bob); the
  limitation and its extension point (a user search on the Identity port) are recorded in
  `API-REQUESTS.md`. Admins come from the Keycloak realm role `admin`, so no admins group is
  seeded. The frontend and dev READMEs, the root README table, the conventions note and the
  design doc ("Texera 2.0 Resource Model and Implementation Architecture", rev 19: the
  catalog and its peers, lineage, agents as templates, conversations and turns, and the
  closing sections) are current. M1 is closed.

- After the close, the two acceptance items not yet exercised live, now smoke tests in
  `test.sh`: `smoke-operator.py` (a custom Python operator created as a resource, used by its
  URI in a workflow, failing without its package and completing in a pinned environment, its
  column in the result, the workflow recorded as its dependent, deletion refused with 409) and
  `smoke-share.py` (Alice shares her project with Bob as viewer; Bob finds the workflow, the
  run and the dataset in search, reads them, runs the workflow on the platform's unit, and gets
  403 on edit, delete, lease and the grant list; revoked afterwards). Playwright gained the
  operator page: created from the library, its code in the generated form, found in a new
  workflow's palette by its URI. The sharing smoke needed one model change: `user` is no
  longer implied by `viewer` (an explicit grant, editors, or inherited), so a project viewer
  cannot lease its owner's credentials; the system project grants `user` to `user:*` so the
  platform's unit, credentials and model endpoint stay usable by everyone; environments need
  only `read`. All eleven acceptance items are now demonstrated.

- Sharing with people who have not logged in yet: the Identity port gained `SearchUsers`, the
  Keycloak adapter asks the admin API with the service client's token (the realm now gives
  `texera-services` the `view-users` role), and `Principals` merges the directory into the
  catalog's rows, recording a found person so they can be granted access; their first login
  takes the principal over (server test, live check against a never-logged-in admin, the
  share form in Playwright). The demo smoke no longer logs Bob in first.

- A custom operator declares the columns its code adds in `implementation.python.outputColumns`
  (typed `Attribute[]`), replacing the `x-texera-output-columns` key. The workflow editor keeps
  a person's canvas positions in their preferences (`canvas[rid]`), loaded when the editor
  opens and saved debounced after a move; the spec stays the engine's plan. A README for the
  catalog. `test.sh e2e` on the reused (not wiped) stack: the shell smokes now name what they
  make with a timestamp, since names are unique per project and kind, and the Playwright
  assertions accept the averages as the model rounds them.

- A screenshot tour of the generic pages (dataset, run, template, credential, model endpoint,
  environment, unit, project, settings, chat) found one bug: a link carrying `?panel=` lost
  its panel on arrival, because the panel sync's two directions undid each other; one ref now
  records the last value either side wrote, and the chat test reloads the page to prove the
  panel comes back. Also: the side panel has its own attribute (`data-side-panel`), library
  rows join description and facts cleanly, generated labels write URL, URI and ID, and the
  settings page is read-only for non-administrators. `test.sh e2e` on the reused stack:
  eleven of eleven, Playwright seven of seven.

- Credentials in operator properties (the user's pick). A property whose schema says
  `format: credential` holds a credential URI; when a run starts the catalog leases every
  credential the plan names for that execution, with the caller's permission, and puts the
  secret where the URI was in the plan the engine receives. Versions and executions keep the
  URI; a compile leaves it in place. A custom operator now receives its instance properties
  in its code as `PROPS` (they no longer reach the engine as operator properties), with
  credentials substituted. The property form shows a credential picker for such fields, and
  the workflow skill tells agents the rule. Checks: a server test on the plan the fake unit
  receives and on the stored documents, and `smoke-credential.py` on the stack (the code saw
  the leased secret, the version keeps the URI, a project viewer is refused until granted
  `user` on the credential).

- Kubernetes, in one command (the user's pick, with the unit provider next). `k8s.sh up`
  creates a kind cluster when missing (Kubernetes 1.33, since this host is on cgroup v1 and
  newer kubelets refuse it; inotify limits raised), builds the five images (catalog, agent
  runtime, frontend, bio MCP server, computing unit), loads them, renders the config maps from
  the dev stack's own files, puts the model key in a Secret that the `openbao-init` job moves
  into OpenBao, applies the kustomize manifests (now with OpenBao, the bio server, RBAC) and
  waits; `k8s.sh check` runs the smokes against the cluster. The gateway is a node port kind
  maps to localhost:28088. Playwright passes against the cluster.
- The Kubernetes unit provider. The UnitProvider port now names the unit (`Endpoint(rid,
  spec)` reconciles, `Terminate(rid, spec)` releases); the `kube` adapter makes a unit of
  `provider: kubernetes` a Deployment and a Service in the catalog's namespace, named after
  the rid, with the spec's image and the master node's memory and cpu, under a service account
  that may touch nothing else (`rbac.yaml`); `unitmux` offers static and Kubernetes units side
  by side; deleting the resource terminates it. A `user` grant on a unit now lets a person
  compile, build and run on it without reading its spec, as the model always said (the run,
  validate and build paths loaded the unit through the read-checked lookup). Checks: the
  adapter against the fake clientset, a server test for a user-only grant, and
  `smoke-k8s-unit.py` on the cluster: ready in 10 s, a run completes, Bob refused then allowed,
  terminate removes the workloads, delete succeeds.

- Lakekeeper on OpenFGA, on the design the user approved: "executed by" stays the person and
  the catalog keeps deciding who reads a result (placement carries the grants, as built); the
  unit is the person's executor at the lake and presents an identity of its own. Lakekeeper
  now authenticates every caller against Keycloak and authorizes with OpenFGA (a store of its
  own on the same server); the catalog bootstraps it as the operator at startup and creates
  the `texera` warehouse with credential vending (RustFS honours session policies, checked).
  Two new ports: Workloads (the Keycloak adapter mints one confidential client per unit the
  catalog provisions, with `manage-clients` on the service client; the secret goes to OpenBao
  and to the unit's Kubernetes Secret, the subject to `status.identity`; a static unit names
  its operator's client in `spec.clientId`, the dev stack's `texera-unit`) and Lake (the
  Lakekeeper adapter: bootstrap, warehouse, namespaces and grants). A run's tables now really
  live in `e_<execution rid>`: the engine honoured only its configured per-type namespaces
  before, so `ExecutionNamespaces` registers the catalog's namespace for the execution (the
  start request, and the `namespace` parameter of a later read), the Python workers get it in
  their startup config, both Iceberg clients authenticate as the unit's client (OAuth2 client
  credentials, scope `openid`, since Keycloak refuses unknown scopes) with vended credentials,
  and neither side tries to create a namespace that exists. Keycloak's discovery document
  names the public issuer, which Lakekeeper reaches through a `socat` forward in its own
  network namespace (`lakekeeper-net` in Compose, owning the published port, so Lakekeeper can
  restart inside it; an `auth` sidecar in the pod); `up.sh` waits on the one-shot containers
  with `docker wait`, since `docker compose wait` ignores ones that already exited. The
  warehouse init script is gone. Checks: the adapter against the fake clientset (the identity
  Secret, read once), server tests (the seeded unit's identity; a run opens its namespace for
  the unit's subject, the engine is told it and a read names it, deleting the execution drops
  it; a provisioned unit's client and credential exist and go with it; an unknown static
  client is refused), `smoke-lake.py` on the stack (the run completes; the lake refuses an
  anonymous caller and alice's own token; the unit lists only its run's namespace, loads a
  table with vended credentials; a second unit's identity gets 403/404; deleting it deletes
  its client and credential), `test.sh e2e` from a wiped stack: thirteen of thirteen once the
  demo smoke was corrected (it chatted as Bob and asked to share with Bob, passing only on
  grants Playwright had left behind; it now chats as alice, revokes Bob's earlier grant and
  checks the turn's own), `k8s.sh check` on a redeployed cluster: the unit's identity Secret,
  a run on it, Bob refused then allowed, terminate and delete. Known limit: the units still
  hold the store's static key for large binaries, which also reaches the warehouse's files; a
  key scoped to the objects prefix closes that.

- Retention. A finished run can be deleted (`DELETE /workflows/{rid}/executions/{eid}`,
  `can_delete`; 409 while it runs or while a dataset version derives from it) and goes with
  its namespace. The settings gained `retention` (ISO 8601 durations): `results` expires the
  tables of finished runs older than the policy, keeping the record and its summaries with
  `status.resultsExpiredAt` set, so rows, ports and saves answer 410 `expired`; `blobs`
  (default a day) removes uploaded files that no version manifest and no staging names, from
  the blob store and the table. The catalog sweeps hourly; `POST /settings/retention/sweep`
  runs one now for administrators and says what it did. The store's filter learned "field
  absent" and "updated before"; the BlobStore port learned Delete. The run page has a Delete
  button for finished runs and says when the results expired. Checks: a server test (refused
  while running, bob refused, deleted with its namespace; a sweep without a policy does
  nothing, `PT0S` expires the cancelled run once and its rows answer 410; a fresh unstaged
  upload survives the day's grace and goes under `PT0S` while the committed file's blob
  stays), `smoke-retention.py` extended on the stack (delete 204 then 404; the sweep expired
  the finished runs, the v2 run says when and answers 410; the policy is cleared afterwards).
  The cluster was not redeployed for this: retention is catalog-internal.

- Updating a unit, the one gap left in "computing units managed as resources" (the user asked
  for it before quotas). `PUT /computing-units/{rid}` now reaches the cluster: the Kubernetes
  provider compares what runs with what the spec asks (image, requests, environment,
  replicas; only the fields the catalog sets, since the API server fills in defaults) and
  rolls the Deployment when they differ, at once from the update's hook and again on any
  probe. The provider cannot change, and a unit with a run on it (pending, provisioning or
  running) answers 409 until the run is over; a static unit's identity follows its
  `clientId`. Checks: the provider test (a changed image and memory reach the Deployment in
  one update, the same spec again is none), a server test (the memory change is taken and the
  identity kept, a provider change is 400, a unit with a run on it is 409 until the run is
  cancelled), and `smoke-k8s-unit.py` on the rebuilt cluster: the memory request goes from
  2Gi to 3Gi, the rollout completes, the unit is ready again and a run on it completes.

- The test framework (the user's ask: a self-contained, framework-oriented way to test the
  MVP end to end, real agents and frontend included). Four layers with one runner each behind
  `test.sh unit | contract | scenario | ui`, plus `evals` (real agents through the real
  model), `cluster` (the same scenarios and Playwright against the Kubernetes deployment;
  `k8s.sh check` delegates to it) and `gate` (a wiped stack, then everything). The eleven
  smoke scripts became thirteen pytest scenarios in `tests/e2e/`, one module per use case,
  over a helper package (the API as a person, AG-UI turns, the lake, kubectl) and fixtures: a
  project per test deleted with everything in it at the end, the iris dataset, a ready unit,
  guards that put the settings and the grants back; markers `model`, `cluster`, `local`,
  `destructive`, `slow` gate what runs. JUnit reports from pytest and Playwright in
  `logs/texera-2-0/reports/`. `docs/texera-2-0/TESTING.md` is the guide and the scenario
  catalog. The first full run found a real bug: after an hour the unit's Lakekeeper token
  expired and the Iceberg Java client refreshes it by OAuth token exchange, which Keycloak
  refuses unless enabled on the client; `texera-unit` and the catalog-minted unit clients now
  have it on (the exchange was checked by hand; the realm change needs a wipe).

  Verified: `test.sh unit`, `contract`, `scenario` (twelve, then the three local ones),
  `ui` (seven), `evals` (both real-agent scenarios and Playwright with the model) all green on
  the local stack; `test.sh cluster` green on the redeployed cluster (thirteen scenarios
  including the unit lifecycle, Playwright) once the environment and operator scenarios
  accepted the cluster image's bare `ModuleNotFoundError` (its Python 3.10 lacks the error
  notes the engine uses to name the module).

- The run in three phases, steps 1 to 3 of the note "Texera 2.0: Authorize, Compile,
  Materialize" (the user's ask: a clean execution path, authorization first at the catalog,
  compilation at the catalog, one resolved plan to the engine, which reads presigned inputs
  and writes Iceberg tables through Lakekeeper).
  1. The unit's doors. A unit's API answers the catalog's own client alone (`SERVICE`, the
     token whose `azp` is `texera-services`; a person's token is 403 at the unit, nobody's
     401, the health probe stays open); the gateway has no route to units any more
     (`gatewayPath` left the unit's status). On the way back the unit reports as itself: the
     client it was given for the lake (`UnitIdentity`, a token cached and renewed), not a
     service token passed in the start request. The catalog's resolver makes no person out of
     a unit's token (`Caller.Unit`), and `POST /lineage/v1/events` takes an execution's events
     from the unit that runs it alone (the sender's subject must be the unit's identity): a
     person, an admin, the platform's client and another unit get 403. A unit's tokens carry
     `aud: texera` through an audience mapper (realm and minted clients) so the catalog
     verifies them like everyone's.
  2. Authorize, compile, materialize. `compile(spec)` is pure: the engine's logical plan with
     files and credentials still named by URI, the custom operators compiled in with their
     pinned environments, and the tables the run will write. `authorizePlan` then requires,
     before anything is written: execute on the workflow, run on the unit, read on the
     environment, every dataset and every custom operator the plan names, use on every
     credential; a refusal leaves no execution behind (it used to leave a failed one).
     Materialize stores the execution with `spec.plan` (namespace, outputs, operators,
     credentials, logicalPlan: no secret, no URL that expires), opens its namespace, and
     sends the engine a bound copy with presigned inputs and leased secrets. `validate`
     returns the same plan (`WorkflowValidation.plan`), so a dry run shows what a run would
     do. The run's environment is one: the request's, else the one the custom operators pin
     (a pin that disagrees with the request or with another pin is 409), else the defaults.
     Save-as-dataset left the MVP (route, tool, prompt text, frontend button, tests): results
     live with the run; the label `texera.keep` on an execution keeps its results past the
     retention policy (a Keep toggle on the run page, `PATCH /resources/{rid}`).
  3. Catalog-named tables. The plan holds one table per output port the engine writes (the
     ports of `viewResult` operators and of operators nothing reads, the engine's own rule;
     the first cut named every port and the run page opened on a table that never existed),
     `<operator>_<port>` in lower case inside `e_<rid>`. The start request carries them
     (`resultStore.tables`); the engine keeps an `ExecutionLayout` per run (namespace and
     named ports, Scala and Python workers alike), writes each named port there and reports
     `namespace.table`; `status.ports[]` lists the tables from the start and the catalog
     refuses a reported table the plan does not name (400). Rows are read by namespace and
     table, so a unit that did not run the execution, or restarted since, serves them from
     the lake without the engine's URI.

  What the checks found on the way: the first cut of step 3 named a table for every output
  port, and the run page opened on a table the engine never writes (Playwright caught it);
  the websocket handshake spec still expected a person's token to be a caller; and the
  real-agent sharing scenario once granted Bob a same-named leftover of the previous test
  (an agent's workflow lands in the person's home project unless the tool names a parent, so
  the per-test cleanup could not delete the dataset it referenced, and the fixture hid the
  failure): the fixtures now name each test's dataset uniquely, delete what a project's chats
  made wherever it landed, and report leftovers as warnings. Where a chat's resources should
  land by default is an open product question, recorded under Next.

  Verified on this machine with the test framework, every layer against the restarted
  stack: `test.sh scenario` 12 scenarios plus the 5 local ones (`test_doors` new: a person's
  token 403 at the unit, nobody 401, the catalog's client 200, health open, no gateway route;
  only the running unit's token reports, a person, the platform's client and another unit
  403); `test.sh ui` the 5 Playwright tests that need no model (the lineage test now walks
  the run's `used` edge and flips the keep mark); `test.sh evals` both real-agent scenarios
  and all 7 Playwright tests with the model; `test.sh unit` (Go, runtime, frontend, engine 1379 specs); `test.sh
  contract` (adapters, engine integration suites); and the cluster redeployed from scratch
  (`k8s.sh down && k8s.sh up`, the realm with the audience mapper) with `test.sh cluster`: 13
  scenarios and Playwright green. One flake seen and not fixed: a model call stalled for four
  minutes in a Playwright run (no error, the next turn fine); the runtime has no per-step
  timeout.

Next: a resource a chat makes lands in the person's home project unless the tool names a
parent; the conversation's project is the likelier default (the turn's origin names it).
Steps 4 and 5 of the same note (the agent turn resolved by a catalog endpoint that
authorizes every reference and leases before the runtime executes, the MCP server enforcing
the template's allowlist; then the small alignments: `defaultPorts` and `validateGraph` at
write time, `read` to build an environment, one reconcile loop for the built-ins, the pure
event mapping out of ingest); quotas and metering, groups beyond admins, a purge of
soft-deleted resources; the units' static S3 key for large binaries scoped to the objects
prefix; Python 3.11 in the unit image; contract suites for the Lakekeeper and
Keycloak-workloads adapters; CI for the gate; a per-step timeout in the agent runtime (one
model call stalled for four minutes during a Playwright run, with no error logged); the
license-header check (`.github/workflows/check-header.yml`, `license-eye header check`)
fails on this branch, 361 files without a header, most of them the 2.0 code under `catalog/`,
`packages/`, `tests/e2e/`, `api/` and `docs/`: a `license-eye header fix` sweep before any
pull request to the main repository.

## 2026-11-03 (session 5, on Linux)

Done and verified:
- The dev stack runs as local processes on any Docker host (Ubuntu 20.04 here); no OrbStack, no
  Kubernetes. Lakekeeper's base URI is `localhost:18181` and the warehouse's S3 endpoint is
  `127.0.0.1:19001` on both sides: the host's published RustFS port, and inside Lakekeeper's
  network namespace a socat sidecar (`lakekeeper-s3`) forwarding to the rustfs container.
  `k8s.sh` and `deploy/kubernetes` stay as a deployment check, out of the development path.
- The engine's Python environment is managed by uv: a repo-root `pyproject.toml` (Python 3.12,
  the pins of `amber/*requirements.txt`, torch CPU on Linux x86_64) with `uv.lock` committed;
  `up.sh` runs `uv sync --all-extras` and `bin/python-proto-gen.sh` when `.venv` is missing, and
  the unit and `test.sh` run workers from `.venv/bin/python`. `up.sh` checks the prerequisites,
  finds Go/bun/uv under `~`, and reads `ANTHROPIC_API_KEY` from a gitignored repo-root `.env`
  (`export` lines allowed). Playwright drives the installed Google Chrome where it ships no
  Chromium for the host. `stop` in `lib.sh` waits for the process to exit, so a unit restart no
  longer races the actor port.
- The agent runtime runs the Dataflow Agent's ReAct loop on AI SDK 7
  (`agent-runtime/src/run/react-loop.ts`): before every model call `prepareStep` renders the
  turn's state into the system prompt (step budget, the resources the turn touched with the
  ids to reuse, whether a result was shown); `onStepFinish` records each step; the answer policy
  (`free` or `after_result`) sends a reply that computed nothing back with a correction, once by
  default; a provider refusal is retried once and a cut-off reply continued once; the step limit
  and a refusal end the turn as `RUN_ERROR`; corrections are `texera.correction` CUSTOM events.
  The contract gained `AgentTemplateSpec.loop` (LoopSpec: answer, resultTools, maxSteps,
  temperature); `make generate` regenerated the Go server, the TS client and the MCP table.
- The Data Analyst template follows the Dataflow Agent: a prompt with the role, the resources,
  the way of working and the answer rule; `loop.answer = after_result`; three skills the
  platform ships as SKILL.md (`catalog/internal/server/skills/`, embedded, the license comment
  stripped before storage): texera-workflows, python-udf, reading-results, loaded on demand with
  `load_skill`. A changed shipped skill gets a new version authored by the platform.
- Verified: `up.sh` from a clean checkout; `smoke-catalog.sh`; `smoke-run.sh` (a run through
  Lakekeeper and RustFS, the result saved as a dataset version); the runtime's `bun test` 49/49
  with typecheck and lint; the frontend's typecheck, lint and vitest; the catalog's
  `go test ./...` on the stack's Postgres; `smoke-chat.py` with Claude Haiku 5.5 PASS (turn 1:
  search, list files, read the header, load_skill, create, validate, run, read rows, answer in
  9 steps and 10.6 s with the right averages; turn 2 edits to v2 and reruns in 5 steps; the save
  turn makes a dataset version with lineage to the run; no correction was needed); Playwright
  4/4 on Chrome, the real-model Data Analyst test included. Docs: the handoff and design docs
  are copied under `docs/texera-2-0/claude-docs/`.

- Prompt caching: the instructions are a cacheable system message in AI SDK 7's `instructions`
  option, the conversation's newest message carries a second breakpoint, and the turn's state is
  re-rendered as the newest user message (not in the system prompt, which broke the cached
  prefix). The MCP `list_operators` without `q` or `group` is a compact list (types, names,
  groups, descriptions); with them, the schemas and ports as before. Tests in both packages.
  Measured on a real Data Analyst turn: 99,330 of 116,579 input tokens read from cache (Haiku
  writes cache increments only above its 2k-token minimum, so small steps are not re-cached);
  a bare `list_operators` is 43 KB instead of 910 KB.
- `bin/texera-2-0/test.sh` end to end on this machine: 13 of 13 checks pass in 8 m 35 s,
  including the engine integration suites and the unit-restart check that failed in the handoff.

Next:
- The frontend's template editor does not expose `loop` yet; the catalog accepts it.
- CI installs the engine's Python with `uv pip install -r amber/*requirements.txt`; switch CI
  and the images to the lockfile (`uv sync`) so one definition serves all three.
- Tool approval (AI SDK `toolApproval` + AG-UI interrupts), A2A tasks and sub-agents remain
  unwired, as before.

## 2026-11-03 (session 4)

Done and verified:
- The engine has no metadata layer left. Deleted `common/dao` (jOOQ, MockTexeraDB), `common/auth`
  and `sql/`; nothing in `amber/` or `common/` opens a database or imports those packages.
  The unit's caller is a `UnitPrincipal` built from the verified token (subject, name, email,
  role); WebSocket handshakes verify the token too, and the old mode that trusted `x-user-*`
  headers from the retired access-control service is gone. From workflow-core and the
  operators: the LakeFS documents and client, `RepositoryMountManager` with the execution-time
  binding on `PhysicalOp` (the scheduler no longer asks a mount authority before workers run),
  the file-lister operator, the database dataset resolution in `FileResolver` (datasets arrive as
  catalog-presigned URLs; local paths still work), and the CSV column limit read from a database
  table (now `constants.csv-max-columns`). UDF dataset/model parameters carry the URL the catalog
  resolved. The cost estimator reads the previous run's runtime statistics from the workflow
  context the unit fills from its registry. Engine specs moved off MockTexeraDB onto the
  in-memory registry (`ExecutionRegistry.adopt/forget` for fixtures).
- Results after a unit restart: the catalog passes the table its lineage recorded
  (`?table=` on the unit's result route) and a unit that no longer holds the run reads it there,
  after checking the table is that execution's result for that port (`recordedResult`).
  `smoke-restart.py` restarts the unit and reads an old run's results.
- A duplicate start of one execution id is refused atomically (409).
- CI for 2.0: `.github/workflows/build.yml` (contract drift, Go catalog with Postgres, TypeScript,
  engine with Postgres-backed Iceberg + binary LICENSE/NOTICE check, Python worker), uploads
  coverage per flag (`codecov.yml` rewritten); `required-checks.yml` and the backport caller
  updated. Not run on GitHub from here; YAML validated and every step's command run locally.
  `amber/LICENSE-binary-java` and `amber/NOTICE-binary` regenerated (409 jars match exactly).
  TypeSpec and hey-api packages pinned to the lockfile versions. `.gitignore` and
  `.dockerignore` no longer ignore `catalog/` (a 1.x rule that hid the whole Go catalog).
- Kubernetes: `deploy/kubernetes` (kustomize, namespace `texera2`) with images
  `bin/dockerfiles/{catalog,agent-runtime,frontend,computing-unit-master}.dockerfile`;
  `bin/texera-2-0/k8s.sh up|status|down` builds, renders the realm/gateway/warehouse config from
  the dev stack's files, creates the model-key secret and waits. The catalog takes explicit
  `TEXERA_OIDC_JWKS_URL`/`TEXERA_OIDC_TOKEN_URL` so in-cluster services verify tokens whose issuer
  is the public URL. The frontend image serves dist/ with nginx and the app's CSP, rendered by
  `frontend-next/scripts/nginx-conf.ts` from `security-headers.ts`. On OrbStack:
  smoke-catalog, smoke-run (with save + produced lineage), smoke-retention, smoke-env,
  smoke-chat (real model, three turns), smoke-templates (external MCP via host.docker.internal)
  and Playwright 4/4 all pass against `http://localhost:28088`.
- `test.sh` now runs every sbt module (`sbt test`, integration-tagged suites excluded) in
  `suites`, and the integration-tagged engine suites against the dev stack's Lakekeeper plus the
  unit-restart check in `e2e`. Go tests fail instead of skipping when Postgres is missing.

Next:
- Release engineering for the new images: binary LICENSE/NOTICE for the Go catalog and the Bun
  agent runtime, image publishing, a Helm chart with production settings (TLS, secrets,
  persistent volumes sized for use).
- A Kubernetes unit operator (units created per person or team) on top of the static unit.
- Retention driven by the catalog: tell it when a run's results expire.

## 2026-11-03 (session 3)

Done and verified:
- Executions produce versions. `POST /catalog/v1/executions/{eid}/results/{opid}/{port}/save`
  (MCP tool `save_result_as_dataset`, 20 tools now) writes a completed run's port result as a CSV
  into a new or existing dataset and commits a version, attributed like any write (agent on behalf
  of the person, origin the chat turn). Lineage gets a `produced` edge from the workflow version
  the run executed to the dataset version, with the execution on the edge, so the chain reads
  dataset@v <- workflow@v <- the dataset versions it read. Saving refuses incomplete runs and
  datasets with hand-staged files. Result pages keep exact numbers (json.Number) from the unit.
  The run page has a "Save as dataset" button; the lineage view labels edges by direction
  ("produced by", "read by").
- Built-in templates follow the platform: on start the catalog compares each built-in template's
  spec with the shipped one and, when they differ, writes a new version authored by the platform
  ("updated by the platform"). The Data Analyst prompt now mentions saving results.
- Chat history replays as steps. A recorded assistant turn (text, calls, results, more text) used
  to be replayed as one assistant message plus one block of results, so the model saw its answer
  before the results it was based on and apologized for it in later turns. It is now replayed
  step by step; calls without a recorded result get an error result so the history stays valid.
- Execution results outlive the run. A new run no longer clears the previous run's results, and
  the unit's idle release (30 s after a run with nobody watching) keeps them; only the retention
  sweep (`result-cleanup.ttl-in-seconds`, one day by default) drops stored results, through
  `amber/.../web/execution/ExecutionStorage`. The old clean-up only stayed harmless because a
  32-bit narrowing of workflow ids kept it from ever matching.
- Engine ids come from the catalog's UUIDs (`EngineIds`, both halves mixed): execution ids from the
  catalog's execution id (a fresh UUID for WebSocket runs), workflow ids from the rid. Result tables
  are named by (workflow id, execution id) and creating one replaces an existing table, so the old
  per-process counter would have overwritten earlier runs' tables after a unit restart or across
  units. "Newest run" uses a creation sequence.
- Retired and deleted: access-control-service, computing-unit-managing-service, config-service,
  file-service, workflow-compiling-service, notebook-migration-service, common/resource, the
  Angular frontend, agent-service, pyright-language-service, and under bin/ local-dev,
  single-node, k8s, the forum, y-websocket-server, pylsp, the mounter and their Dockerfiles. The
  operator icons moved to `frontend-next/public/operator-images`. LICENSE no longer lists deleted
  assets and lists `bin/texera-2-0/examples/iris.csv`; orphaned license texts are gone.
- A repeated start of one execution id gets 409 and leaves the running execution alone (the id is
  claimed atomically; before, a racing duplicate could shut the run down and report it failed).
- One command each: `bin/texera-2-0/up.sh` (idempotent, refuses ports held by other stacks),
  `down.sh [--wipe]`, `test.sh [suites|e2e]` (helpers in `lib.sh`). Verified from a cold start.

Verification (all on the live stack, real model claude-haiku-5-5):
- `test.sh` (11 steps, all pass, twice, once from a cold `up.sh`): catalog go vet + uncached go
  test; agent runtime types, lint, 41 tests; frontend types, lint, 49 tests; engine specs
  (`org.apache.texera.web.*` plus ReadonlyHttpFileDocumentSpec); smoke-catalog, smoke-run (with
  save + produced lineage), smoke-retention, smoke-env, smoke-chat (three turns: build, edit +
  rerun, save as dataset), smoke-templates, Playwright 4/4 (sign-in and attach, library,
  real-model chat, save from the run page with lineage).
- New catalog tests: TestSavedResultsAreDatasetVersionsProducedByTheRun (in-memory S3 fake in the
  harness, exact numbers, CSV quoting, carried-forward files, staged-file conflict, access, failed
  runs), TestBuiltInTemplatesFollowThePlatform.

Next:
- `common/dao` and `sql/`: replace the `User` POJO in common/auth with an engine principal and move
  the engine specs off MockTexeraDB; then drop both.
- `FileResolver` still carries the LakeFS/database dataset path; 2.0 reads presigned URLs only.
- CI: `.github/workflows` and `codecov.yml` still describe the 1.x build; a 2.0 pipeline runs
  `test.sh suites` and `make check-drift` once the generated files are committed.
- Results after a unit restart: the unit's registry is in memory, so an old run's results can no
  longer be paged through a restarted unit although the tables remain. Serve reads by the recorded
  table, checked against the engine id derived from the catalog's execution id.
- Retention is unit-local; the catalog should learn when a run's results expire, and saved
  datasets are the way to keep them.
- A 2.0 Kubernetes deployment (unit operator, the Kubernetes sandbox provider).

## 2026-11-03 (session 2)

Done and verified:
- Amber is a pure engine. Deleted from `amber/`: every dashboard/auth/hub/admin/quota/model/
  dataset/workflow/PVE/AI-assistant/email/result-export resource, `TexeraWebApplication`, HS256
  `JwtAuth`, and all SQL (SqlServer/jOOQ tables/DAOs). Replaced by `web/execution/`:
  `ExecutionRegistry` (in-memory execution records), `UnitApiResource` (the unit API of
  `api/engine.tsp`: health, operators in the contract's OperatorTypeList shape, compile,
  executions start/status/cancel/results, environments build/status), `LineageReporter`
  (OpenLineage run + operator events to the catalog), `EnvironmentManager` (one venv per
  environment version, layered on the unit's base Python through a .pth, uv when available),
  `UnitJwtAuth` (RS256 via Keycloak JWKS, issuer + audience). `ReadonlyHttpFileDocument` in
  workflow-core lets scans read presigned dataset URLs. Actor and HTTP ports are configurable
  (`TEXERA_ACTOR_PORT`, `TEXERA_UNIT_PORT`). The remaining DAO dependency is POJO-only
  (`User`, `UserRoleEnum` via common/auth); no database is opened.
- jOOQ sources are generated against the texera2 Postgres (`texera_db` from `sql/texera_ddl.sql`;
  the pgroonga errors are expected): `STORAGE_JDBC_URL=jdbc:postgresql://localhost:15432/texera_db?currentSchema=texera_db,public STORAGE_JDBC_USERNAME=texera STORAGE_JDBC_PASSWORD=texera sbt DAO/jooqGenerate`.
- Unit runs on the host: `bin/texera-2-0/run-unit.sh` (HTTP :28085, actor :2652; 8085/18085/2552
  belong to other stacks on this machine), `stop-unit.sh` stops only this worktree's unit.
  Python: `amber/venv` symlinks to the main repo's 3.12 venv; Python protos via
  `PATH=<venv>/bin:$PATH bin/python-proto-gen.sh`.
- Shared hostnames for host + containers (OrbStack): `texera2-rustfs.orb.local:9000` and
  `texera2-lakekeeper.orb.local:8181` (network aliases in the compose file; Lakekeeper base URI
  and warehouse endpoint use them).
- `bin/texera-2-0/smoke-run.sh` passes: dataset iris v1 → workflow scan→aggregate v1 → validate on
  the unit (schemas) → run (completed; scan 150 tuples, avg 3) → paged results (correct means)
  → lineage: version_edge dataset@1→workflow@1 (read, eid), port_input, port_edge, port_result.
- Fixed: unit operator registry fetch carries the service token; state-store diff handlers only
  fire with a WebSocket subscriber, so the reporter subscribes to the hot state stream.

- Real-model chat (Claude Haiku 5.5) passes end to end (`bin/texera-2-0/smoke-chat.py`, as bob):
  turn 1 the Data Analyst agent searches, reads the CSV header, creates a workflow (v1),
  validates, runs on the unit and answers correctly; turn 2 it edits the same workflow with a
  JSON patch (v2, message recorded) and reruns. Workflow, versions and executions carry
  createdBy=agent, onBehalfOf=person, origin={conversation, seq}; user messages are authored by
  the person; lineage dataset@1 -> workflow@1 and @2.
- Provenance plumbing: the runtime's per-turn `TurnContext` sends X-Texera-Agent,
  X-Texera-Service-Token and X-Texera-Origin to the built-in MCP server only (third-party MCP
  servers never get the person's token); the catalog honors the origin only with a valid agent
  assertion and prefers it over a body-supplied origin; Envoy passes these headers to ext_authz.
- Typed workflow content in the contract (WorkflowContent/WorkflowOperator/WorkflowLink,
  JsonPatchOperation, EditWorkflow): the MCP tool schemas are real objects now (the model had
  been sending `content` as a string when the schema was `true`). MCP tools return file text for
  binary responses (read_dataset_file). MCP in-memory tests in `catalog/internal/mcp`.
- Templates + pluggable MCP (`smoke-templates.py`): bob registers an external MCP server
  (`agent-runtime/examples/mcp-iris-facts`, :23010), creates a template binding it with an
  allowlist beside the built-in server, edits it to v2, chats in that mode; the agent uses
  species_facts and convert_length together with run_workflow.
- Environments (`smoke-env.py`): a Python UDF importing `humanize` fails without an environment
  and completes with one (`humanize==4.11.0`, built by the unit in ~5 s); the execution records
  the environment version.
- Agent runtime on :23002 (`run-agent-runtime.sh`, key from TEXERA_ENV_FILE); 3002 belongs to
  another stack.

- Catalog HTTP test suite (`catalog/internal/server/{harness,api}_test.go`): a local OIDC issuer
  (RSA/JWKS/client credentials) and a fake unit that reports OpenLineage back; covers auth,
  seeded modes, versioning/patch/conflict, PDP sharing, agent attribution + origin precedence,
  runs with port lineage and failure reporting, MCP over HTTP (401 carries resource_metadata),
  ext_authz. Run with `go test -p 1 ./...` (store and server tests share catalog_test).
- Frontend on the live stack: `frontend-next` (vite :5174 behind Envoy) with OIDC PKCE; Playwright
  `e2e/texera2.spec.ts` passes 3/3 including the real-model core loop (bob asks the Data Analyst,
  answer with the right means in ~12 s, the built workflow listed under "From this chat", opened
  beside with canvas, versions and lineage). Fixes on the way: Keycloak realm (built-in scopes
  kept, audience mapper on the clients, pinned user ids), `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=false`
  (dynamic URLs lost the gateway port), Envoy must be restarted after a realm re-import (JWKS
  cache), message parts persisted in stream order, ResourceRef with kind in message parts and
  `kind` on ResourceVersion, listings no longer reported as touched resources, Select shows labels.

Next (updated 2): retire the old services and Angular from the build, one-command up/test scripts, docs.
Old next: agent runtime live with Haiku 5.5 (template → MCP tools → workflow → run → answer), an
external MCP server plugged into a template, a Python UDF in a custom environment, the frontend
against the live stack (fork stopped at "app builds"), then delete retired services.

## 2026-11-03 (session 1, ended at the usage limit)

Done and verified:
- Contract: `api/common.tsp`, `api/catalog.tsp` (79 operations, 19 tagged `x-mcp`), `api/engine.tsp`
  (the unit API), `api/openfga/model.fga`. `make generate` emits OpenAPI 3.0/3.1 to `gen/openapi/`,
  the Go strict server (`catalog/internal/api`), the Go unit client (`catalog/internal/engine`), the
  MCP tool table (`catalog/internal/mcp/tools.gen.go` via `cmd/mcpgen`) and the TypeScript client
  (`packages/catalog-client`, hey-api with TanStack Query + Zod; TS 5.9 pinned for the generator).
- Dev stack `bin/texera-2-0/` (project `texera2`): Postgres 15432, Keycloak 18081 (realm `texera`,
  users alice/bob/texera-admin, clients `texera-app` PKCE and `texera-services` client-credentials,
  tokens carry `sub`, `aud=texera`, issuer `http://localhost:8088/auth/realms/texera`), OpenFGA 18082,
  RustFS 19001 (buckets `texera`, `datasets`), Lakekeeper 18181 (warehouse `texera`), Envoy 8088
  (jwt_authn on Keycloak JWKS, ext_authz to the catalog, routes to host services; public routes skip
  ext_authz). README in that directory.
- Catalog (Go, `catalog/`): store with migrations and integration tests (`catalog_test` db), OIDC
  verification (go-oidc; discovery must use Keycloak directly on 18081 because Keycloak rewrites
  URLs from X-Forwarded headers), service tokens, OpenFGA model + outbox drainer, PDP (grants
  authoritative, OpenFGA secondary), ext_authz endpoint, all 79 handlers, S3 datasets with staged
  files and immutable version prefixes, workflow content→logical plan conversion with
  `dataset://rid@vno/path` resolution to presigned URLs, executions + OpenLineage ingestion
  contract (see `internal/server/lineage.go`), agents, conversations/messages, seeded system
  principal, static unit, built-in `texera` MCP server, `python-default` environment, templates
  "Data Analyst" and "General", MCP server (go-sdk, bearer auth, stateless streamable HTTP).
  `go build ./... && go vet ./... && go test ./internal/...` green.
- `bin/texera-2-0/smoke-catalog.sh` passes through the gateway: whoami, seeds, workflow create by
  content, edit by JSON patch (v2), structural validation error, versions, lineage, sharing
  (bob 403 → viewer → 200, edit 403), dataset upload/commit/files/download/presign, conversation +
  agent spawn + message + resources-from-chat, MCP initialize/tools/list (19 tools)/tools/call,
  MCP 401 without a token.
- Agent runtime (`agent-runtime/`, built by a fork): AI SDK 7 ToolLoopAgent, AG-UI SSE endpoint,
  minimal A2A, MCP tools over the user's token, skills, sandbox interface; 35 tests green. It uses
  its own fetch layer over the contract because of the client-config path bug, now fixed in
  `packages/catalog-client/openapi-ts.config.ts` (`runtimeConfigPath: ./src/client-config.ts`).
- Frontend fork was still running when the session ended; check `frontend-next/README.md` and
  `docs/texera-2-0/API-REQUESTS.md` for what it produced.

Running processes left on the host: the catalog (`catalog/bin/catalog`, log in the session
scratchpad), the dev stack containers.

Next (in order):
1. Engine boundary in `amber/`: `POST /api/executions` (ExecutionStartRequest), `/api/compile`,
   `/api/operators`, `/api/executions/{eid}/results/{opid}/{port}`, `/api/environments`, JWKS auth,
   https readonly file documents, ExecutionReporter posting OpenLineage events per the contract in
   `catalog/internal/server/lineage.go`, no Postgres. Run it on the host at :8085 (sbt, per the memory
   note on JdkOptions) so the seeded static unit turns `ready`.
2. Wire the agent runtime against the live catalog (`bun run dev` on 3002) and run a real-model
   turn with `ANTHROPIC_API_KEY` from the main repo's `.env` (model `claude-haiku-5-5`).
3. Frontend against the live stack at `http://localhost:8088/`.
4. Delete the retired services and Angular; update `docs/texera-2-0/PLAN.md`.
