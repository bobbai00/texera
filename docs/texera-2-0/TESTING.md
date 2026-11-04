# Testing Texera 2.0

Four layers, one runner each, one entry point: `bin/texera-2-0/test.sh`. Every layer but the
first needs the stack (`bin/texera-2-0/up.sh`). Reports land in `logs/texera-2-0/reports/*.xml`
(JUnit) and the step logs in `logs/texera-2-0/tests/`.

| Layer | Command | What runs | Needs |
| --- | --- | --- | --- |
| unit | `test.sh unit` | `go test` (the server tests validate every response against the contract), `sbt test`, `bun test`, vitest, typecheck and lint | nothing but the toolchain and the dev Postgres |
| contract | `test.sh contract` | the catalog's adapters against OpenBao, RustFS and OpenFGA (`-tags integration`); the engine's integration suites on the lake, as the catalog's client | the stack |
| scenario | `test.sh scenario` | the end-to-end scenarios in `tests/e2e/` (pytest) against the gateway, as alice, bob and the administrator | the stack |
| ui | `test.sh ui` | Playwright (`frontend-next/e2e`) against the gateway, without a model | the stack, Chromium |
| evals | `test.sh evals` | the scenarios that drive real agents through the real model (`-m model`), then Playwright's model scenarios | the stack with a model key |
| cluster | `test.sh cluster` (`k8s.sh check`) | the scenarios and Playwright against the Kubernetes deployment, plus the unit made as a resource | `k8s.sh up`, kubectl for the cluster assertions |
| gate | `test.sh gate` | `down.sh --wipe`, `up.sh`, then unit, contract, scenario, ui and evals | everything above |

`test.sh all` is the gate without the wipe. Arguments after `scenario`, `evals` and `cluster` go
to pytest: `test.sh scenario -k sharing`, `test.sh scenario -x tests/e2e/test_run.py`.

## The scenarios

One module per use case, against any stack by URL (`--gw`). Each test makes a project of
alice's and deletes it with everything in it at the end, so names stay plain and nothing
leaks between tests; what a test must change platform-wide (the retention policy, grants to
Bob) goes through a guard fixture that puts it back.

| Use case | Module | Markers | About |
| --- | --- | --- | --- |
| Who I am, the seeds, workflow versions and edits, sharing, dataset files and references, a conversation's turn and origin, the two MCP servers (acceptance 1, 2) | `test_catalog.py` | | 5 s |
| Validate, run, ports and rows, the lineage, a result saved as a dataset version (acceptance 3, 4 at the API) | `test_run.py` | | 15 s |
| Results kept per execution across runs and the unit's idle release; a run deleted with its tables | `test_results.py` | slow | 1 min |
| Old results expire under the retention policy; the record stays | `test_results.py` | destructive | 10 s |
| A Python UDF fails without its environment and completes with it | `test_environment.py` | slow | 2 min |
| A custom operator as a resource, used by URI, pinned environment, deletion refused while referenced (acceptance 5) | `test_operator.py` | slow | 2 min |
| A project shared with a viewer: reads, runs, nothing more; revoked (acceptance 6) | `test_sharing.py` | | 20 s |
| A credential in an operator property, leased for the run, refused to a viewer until granted use (acceptance 7) | `test_credentials.py` | | 30 s |
| The lake enforces the catalog's decision: namespaces per run, identities per unit, nothing for anyone else | `test_lake.py` | local | 20 s |
| Results survive a restart of the unit | `test_unit_restart.py` | local, destructive | 2 min |
| A computing unit as a resource on Kubernetes: ready, run, spec change rolls it, use granted, terminate, delete | `test_cluster_unit.py` | cluster, slow | 2 min |
| The Data Analyst builds, edits, reruns and saves through a chat (acceptance 3, 4, 9) | `test_agents.py` | model, slow | 3 min, about 40 model calls |
| The Bio Researcher answers with cited ideas, hands off to the analyst, which runs and shares with Bob (acceptance 10, 11) | `test_agents.py` | model, slow | 3 min, about 40 model calls |

Markers gate what runs: `model`, `cluster`, `local` and `destructive` tests are skipped unless
the matching flag is given (`--model`, `--cluster`, `--local`, `--destructive`); `test.sh`
passes the right ones per layer. `local` means the Compose stack's host ports (Lakekeeper,
Keycloak, OpenBao, the unit process); `destructive` means other tests may see the effect
(the unit restarts, every finished run on the stack expires), so those run last.

Playwright covers the pages: sign-in, a chat with an upload that becomes a dataset, the
agent switcher and `/mode`, the template page, the operator page, a saved result's lineage,
and with the model the two chat scenarios (`frontend-next/e2e/texera2.spec.ts`).

## Rules

- **A test owns its data.** Everything it makes goes into its own project (`project` fixture)
  and is deleted at the end in reference order. Resources the agents make in a chat land in
  alice's home project; the model names them, so they are left alone.
- **Names are plain.** With a project per test there is no need for timestamps; the run id in
  the project's name tells one run's leftovers from another's.
- **Platform-wide changes are guarded.** `settings_guard` restores the settings,
  `grants_guard` revokes what the test granted.
- **Model tests assert outcomes**, never wording: resources made in the chat, runs completed,
  versions bumped, grants given. One rerun of a model test is a flake, two are a bug.
- **Secrets stay out of the repo.** The dev stack's credentials are the realm's; the model key
  comes from `.env` or the environment through `up.sh`.

## Adding a scenario

1. Pick the module for the use case, or add `tests/e2e/test_<use_case>.py` with a docstring
   that names what it proves and which acceptance item it covers.
2. Take fixtures: `alice`, `bob`, `admin`, `anon`, `project`, `iris`, `unit`, the guards.
   Build workflows with `texera_e2e.workflows`, chats with `texera_e2e.chat`, the lake with
   `texera_e2e.lake`, the cluster with `texera_e2e.kube`.
3. Mark it: `model`, `cluster`, `local`, `destructive`, `slow` as it needs; keep it under the
   `--gw` it can run against.
4. Add its row to the table above.

## What is not covered

Scale and performance; the hourly retention loop (the sweep is tested on demand); blob
removal against S3 on the stack (tested in memory); contract suites for the Lakekeeper and
Keycloak-workloads adapters (covered end to end by the lake scenario); CI (the gate runs by
hand). One difference between the targets: the cluster's unit image runs Python 3.10, where a
failed UDF cannot name its missing module (the engine's error notes need 3.11), so the
environment and operator scenarios accept a bare `ModuleNotFoundError` there. The known
limits of the system itself are in the handoff.
