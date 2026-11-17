# Self-contained Amber engine: handover

State on 2026-11-17, when work stopped. Nothing is merged upstream or opened as a pull request.
Everything is on branches of the fork `github.com/bobbai00/texera`, which is public. The same
handover as a page: https://claude.ai/artifact/1uo7RCdbfrnUpTVFLzvhwG (private to its owner).

## 1. The goal and where it stands

Amber's computing unit becomes a self-contained engine: it takes a stored physical plan with every
location resolved, reads and writes storage, keeps no execution metadata and calls no service during
a run (apache/texera #5011, #5012, #5013; Linear project P-TEX-22). The work is in steps; the owner
set the scope on 2026-11-17 to end after step 3.

| Step | What it does | State | Ticket |
|---|---|---|---|
| 0 | Prove the riskiest assumptions (Envoy routing, per-run lake tokens, Iceberg commit cost) | Done | TEX-423 |
| 1 | Run every workflow from its saved physical plan | Done | TEX-424 |
| 2 | The unit reads nothing from Postgres, and calls no service, to start a run | Built and verified; review fixes mostly in | TEX-425 |
| 3 | Run state in the lake; the unit opens no Postgres connection | 4 of 16 parts | TEX-426 |
| 4 | Only the gateway (Envoy) reaches a unit | Research draft only; not to be built now | TEX-427 |
| 5 | Lock down the unit: per-run credentials, a lake namespace per execution | Later | TEX-428 |
| 6 | Run units on Kubernetes, Slurm and EC2 | Later | TEX-429 |

## 2. How to get it

```bash
# in any clone of texera
git remote add bobbai00 https://github.com/bobbai00/texera.git   # skip if origin is the fork
git fetch bobbai00 feat/self-contained-engine feat/sce-step2-lane \
  spike/sce-step0-proofs fix/checkpoint-on-source-worker sce-e2e-harness
git worktree add ../self-contained-engine bobbai00/feat/self-contained-engine

# the test harness and every document: its own history, on one branch
git clone --branch sce-e2e-harness --single-branch https://github.com/bobbai00/texera.git sce-e2e
```

| Branch | Commit | What it holds |
|---|---|---|
| `feat/self-contained-engine` | `3d84565a5` | The main branch: steps 1 and 2, upstream main `021bf51c1` merged in, three batches of review fixes, step 3 parts 2-5 |
| `feat/sce-step2-lane` | `c5511fab0` | Fix batch P, pieces 1-4, on `e05b2705a`. Not merged into the main branch |
| `spike/sce-step0-proofs` | `ff4729363` | Step 0's proof scripts and results (`proofs/step0/*/RESULTS.md`) |
| `fix/checkpoint-on-source-worker` | `57c64e921` | An upstream bug fix found on the way (a checkpoint on a source worker), on `b71d84698`; rebase on upstream main before proposing it |
| `sce-e2e-harness` | see `git log` | The end-to-end harness, the designs, the reviews and this file. Unrelated history |

Compare the main branch with upstream:
`https://github.com/apache/texera/compare/main...bobbai00:texera:feat/self-contained-engine`.

## 3. The main branch

`feat/self-contained-engine` at `3d84565a5`: 58 commits and one merge over upstream `205fe77c4`.

| Group | Commits | What it does |
|---|---|---|
| Step 1 | `ffbdabea5` to `5e85a37de` (4) | Output partitioning as a value; UDF datasets resolved when planning; a physical plan saved and read back; every workflow run from its saved plan |
| Step 2 | `1b1635e25` to `55c14da26` (21) | The stored plan carries replay, cost hints, inputs, settings, links, dataset listings and resolved Python environments; the plan is stored in the lake; executions are created at the Dashboard (`POST /api/executions`) and started on the unit by id; a paused operator is changed through the Dashboard; the unit has no compile path; the browser and the agent service create, then start; Python environments are kept at the Dashboard and installed by the unit; the unit's environment endpoints are gone; a spec fails if the unit reads Postgres to start a run |
| Upstream | `99098417a` | Merge of upstream main `021bf51c1` (27 commits) |
| Fixes X1 | `3ec12bad6` to `7943df959` (6) | The stored plan is format version 1 with nothing stored twice; the unit's mount root is out of the plan; a 16 MiB plan limit that the listing cap fits; replay logs only where the unit keeps them; one function for a user's warehouse name |
| Fixes X3 | `a2551d262` to `e05b2705a` (12) | A created execution has status 6 (Created) until its unit's first write, so it locks nothing; results are cleared only once a later run has its own; the create compiles under a deadline; one shape for a refused create; replays of another user's run and unknown targets are refused; unit settings forwarded in Kubernetes |
| Step 3, parts 2-4 | `6f3e16729` to `13296d289` (3) | Appending with table properties in one commit and tidying under readers; the execution log store; statistics and console as records |
| Fixes X4 | `7ee293ecf` to `2147aeaec` (6) | A worker closes its executor however it stops; a refused request is a `RequestRefusedEvent`, not a failed run; pause, resume and kill name their execution; console messages stay through Running and errors are listed once |
| Step 3, part 5 | `56654f18b` to `3d84565a5` (6) | The unit writes each run's log (state rows with their reason, the label, a beat) through one `transitionTo`; a finished run stays finished; a run is set up in full or not at all; the unit finds its run's results in memory; the unit's test seams are constructor parameters |

### Verified at `3d84565a5`

| Check | Result |
|---|---|
| Scala suites | No failure. Known non-passes: `IcebergRestCatalogIntegrationSpec` aborts without a REST catalog on :8181; the R UDF case is cancelled where R is not installed |
| Frontend, agent service | 7,292 and 378 tests pass (at `2147aeaec`; part 5 changed neither) |
| Single-node, unit on a network of its own, gate D (all six evidence checks) | 25 of 25 (`reports/baseline-20261117T201515Z.json`) |
| Kubernetes on OrbStack | 17 of 17 (`reports/k8s-20261117T202200Z.json`) |
| Local dev | 25 of 25 (`reports/localdev-20261117T202652Z.json`) |
| Browser smoke | 8 of 9, twice; B9 fails (below) |

The `reports/` directory stays on the machine that ran it; it is not in git.

### Open on the main branch

- Browser case B9 (pick a Python environment in a UDF, then Run) fails twice at `3d84565a5`: the
  create answers 400, "Virtual Environment name is required when not using the default Python
  environment", so the page sent the UDF without the environment's name. It passed at
  `2147aeaec`, and part 5 changed no browser or Dashboard code. The screenshot shows the picker's
  dropdown still open after the pick, so the test's click may not have registered. Not explained.
  The API-level environment scenarios g, h and i pass in all three modes.
- Part 5 has not run against a real REST catalog, and its 20 hand-made breaks of `transitionTo`
  were never run (`tools/step3/`).
- Open issues the batches left (details in `docs/review-step2/x1-report.md`, `x3-report.md`,
  `x4-report.md` and `docs/step3-notes/part-5-report.md`): a page that opens while a run is
  Initializing loses the install messages sent before it; console writers can be closed while a
  commit is in flight; the engine's own e-mail is still sent for a state the run did not take; a
  sync run that ends another way in the 500 ms after "targets ready" is answered Completed;
  update rows still store `logical`; only single-node enforces a body limit on the create.

## 4. Fix batch P, not merged (`feat/sce-step2-lane`)

The owner's decision of 2026-11-17: what the compiler resolves belongs in the plan's operator
block, at port level where it is about a port. Pieces 1-4 are done and their suites pass on their
own branch:

1. Every output port of every physical operator carries its storage location in the plan; the
   scheduler uses it and nothing in the engine builds one.
2. What an operator reads from outside the run (its files with their links, a File Lister's
   listing, the CSV column limit) is `PhysicalOp.inputs`, stored in the operator's block and handed
   to the executor beside its descriptor. `@SetByCompiler` and the hidden descriptor fields are gone,
   and no log line can print a link's signature.
3. A compile is `CompileFor.Editing` or `CompileFor.Run`; the four "unavailable" binders are gone.
4. Test fixtures are out of the main sources, and the link allow-list cannot be widened at run time.

Piece 5 (findings D27, D11, E18/D6, E26, E30, E10) is not started; `docs/review-step2/p-report.md`
lists it in order. Merging P onto the main branch will conflict in the unit's services that X4 and
part 5 rewrote. Visible changes the harness must follow: an operator's JSON with `inputLinks`,
`listing` or `maxColumns` is refused; an operator id that cannot be part of a location (one with
`_`) is that operator's error; two new fields on `InitializeExecutorRequest`. One judgment call to
review: a scan's descriptor still holds the resolved `dataset:///` file name, which schema
inference and the Python export read. A plan at the listing cap (10,000 files, 600-character links)
is about 9 MiB.

## 5. What is left, in order

1. Merge P onto the main branch; make the harness follow it; run the suites, gate D and the browser.
2. Explain and fix B9.
3. P's piece 5.
4. Batch C: the run compile moves into the workflow-compiling-service. The Dashboard authorizes,
   inserts the row, asks for the plan, stores it. To sign links at the Dashboard, the plan's listed
   files need their physical address.
5. Part 5's pending checks: the REST catalog run and the 20 breaks.
6. Step 3, sub-parts 6, 7, 9 and 11-19 (`docs/step3-design.md` section 13, as amended by
   `docs/step3-notes/changes-since-rev2.md`). Run gate 3A after 6-7, 3B after 9 and 11-15, 3C after
   16-19, in all three modes; the negative controls once; the day-long benchmark. The harness for
   all three gates is written and passes its 338 offline tests; no step 3 gate has run on a stack.
7. Before any pull request: one naming pass and one comment-trim pass over the branch (findings
   E9, E22, D15, D21, D23), a fresh merge of upstream, and commit messages without the words of
   this process ("brief", "sub-part", "gate"; finding D35).

A split into four pull requests, for the owner to decide:

| PR | Contents |
|---|---|
| 1 | Run every workflow from a stored plan: step 1, the stored plan's format and store, X1 |
| 2 | Create at the Dashboard, start by id, nothing read on the unit to start: the rest of step 2, X3, X4, P, C |
| 3 | Record and close executions from the lake: step 3 parts 2-15 |
| 4 | Take Postgres off the unit: step 3 parts 16-19 |

`fix/checkpoint-on-source-worker` can go upstream as its own small pull request at any time.

## 6. Decisions

Made by the owner:
- Postgres is removed from the unit completely, with no backward compatibility.
- Amber is a pure engine: a stored plan with resolved locations in; storage reads and writes; no
  execution metadata; no service calls during a run.
- Only the gateway reaches a unit; the Dashboard service does not call units; no relay service for
  live state.
- Units are not tied to Kubernetes (Slurm and EC2 later).
- An execution's state lives in one place; data and metadata stay clearly apart.
- A namespace per execution comes only in step 5.
- 2026-11-17: resolved locations go in the plan's operator block, at port level.
- 2026-11-17: where a review offers a cheaper and a cleaner way, take the cleaner one; the run
  compile moves into the compiling service.
- 2026-11-17: stop after step 3.

Open for the owner:
- Step 3's six choices, being built to the recommendations: Dashboard verdicts ("unit lost",
  "never started") only in the Postgres row; a six-field closing record in Postgres; step 3 stays
  independent of the upstream result service (#9356); statistics at one point per 30 s and one
  e-mail per run, at its end; a new run replaces the finished runs' results of the same workflow
  on the same unit, plus expiry a day after the end, while plan, log and statistics stay; three
  cut sub-parts stay out (`docs/step3-design.md` section 11).
- Whether a scan's descriptor should also stop holding the resolved file name (batch P).
- Whether to propose steps 1-2 upstream before step 3 ends. Recommendation: yes, once the cleanup
  is verified; upstream moved 27 commits in three days.
- Whether to file the upstream bugs below as issues.
- When step 4 resumes: its four questions in `docs/step4-design.md` section 4.

## 7. Upstream bugs found on the way (not caused by this branch)

- `PartitionRule.FirstInput` follows hash-map order, not port order.
- `RUDFOpDesc`'s setter chain is wrong for more than one worker.
- Checkpoints: a source worker read its channel's port before the alignment type (fixed on
  `fix/checkpoint-on-source-worker`); pyamber has no `PrepareCheckpoint` handler; JVM workers fail
  to serialize `OutputManager.outputPortResultWriterThreads` (since #3295). Replay end to end stays
  unverified.
- Helm chart: `Chart.lock` lists minio where `Chart.yaml` lists rustfs, so `helm dependency build`
  fails; Envoy Gateway is always installed; GatewayClass `eg` hangs in Terminating after an
  uninstall; the release must be named `texera`; the pylsp image is amd64 only.
- access-control-service logs every request's headers and token at INFO, and has no PATCH handler
  (Jupyter's rename).
- The editor: a killed operator's box still says Running; the result table stays on page 2 after a
  re-run; a page opened during a run logs a `TypeError` from region colouring when the run ends.
- scalapb-json4s is on two versions (0.12.0 and 0.12.2).

## 8. Running things

`tools/README.md` has the Postgres and Python set-up and every script. In short:

```bash
tools/suite.sh <worktree> <tag> [catalog-db]     # every Scala suite, about 15 minutes
tools/frontend-check.sh <worktree> <tag>         # frontend tests, format, build
(cd agent-service && bun test && bun run typecheck)
SN_STACK_OPTS="--isolate-unit" K8S_SCN=... LD_SCN=... tools/gate.sh <commit> <tag> --gate D
```

The harness's `README.md` describes every mode, scenario, check and gate, and lists every
verification run with its report. Step 3's gates:

```bash
./run-baseline.sh --reset --images sce/<tag> --pg-statement-log --isolate-unit --fast-record -- --gate 3A
./run-k8s.sh --lock <dir> --images sce/<tag> --source <worktree> --fast-record -- --gate 3A
./run-localdev.sh --lock <dir> --reset --fast-record -- --gate 3A
```

## 9. Where the documents are

| Path (on `sce-e2e-harness`) | What |
|---|---|
| `docs/step2-design.md`, `docs/step2-critique.md` | Step 2's design and its critique |
| `docs/step3-design.md` | Step 3's design, revision 2 |
| `docs/step3-notes/changes-since-rev2.md` | What changed since; wins over the design |
| `docs/step3-notes/*-report.md` | Reports of step 3's parts 2-4 and 5, and of its harness |
| `docs/step4-design.md` | Step 4 research notes; not a design |
| `docs/review-step2/` | The two reviews (`engine-side.md`, `dashboard-side.md`), the decision on every finding (`triage.md`), the browser findings, and the reports of batches X1, X3, X4 and P |
| `docs/map/`, `docs/probes/` | A code map of upstream main (2026-11-14); the Lakekeeper probes behind step 3's design |
| `tools/` | The scripts that ran the suites and the gates |

Earlier design pages: "Amber Engine Design" (`https://claude.ai/artifact/GEJYPLLbqxit6WBt2ko7Wt`)
and "Amber Engine Plan" (`https://claude.ai/artifact/HWHk9yddF2Hb1fVtGLjeRQ`). Linear: TEX-425 and
TEX-426 carry the same status as this file.

## 10. The machine this ran on

- The owner's `texera-single-node` stack is stopped: `docker compose -p texera-single-node start`.
- Worktrees under `~/Desktop/projects/texera-worktrees`: `self-contained-engine`, `sce-step2-lane`,
  `sce-step3-lane`, `sce-imgbuild`, `sce-localdev-src`, `sce-step0-proofs`, `sce-e2e`,
  `sce-e2e-step3`.
- Test images `sce/texera-*:step2x` and `sce/texera-*:step3p5`; Docker volumes `sce_*` and
  `e2e-localdev_*`; the test Postgres container `texera-tripwire-pg` on 127.0.0.1:5432.
- OrbStack's Kubernetes has no namespace of the harness left; the Gateway API and Envoy Gateway
  CRDs stay installed.
