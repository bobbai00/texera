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
| Who I am, the seeds, workflow versions and edits, sharing, dataset files and references, a conversation's turn and origin, the two MCP servers and the tools each one has, with none on both (acceptance 1, 2) | `test_catalog.py` | | 5 s |
| A run in three phases: the dry run's plan is the run's, stored without secrets; the tables the catalog named, ports, rows, lineage; the keep mark (acceptance 3, 4 at the API) | `test_run.py` | | 15 s |
| Results kept per execution across runs and the unit's idle release; a run deleted with its tables | `test_results.py` | slow | 1 min |
| Old results expire under the retention policy; the record stays; a kept run does not expire | `test_results.py` | destructive | 20 s |
| A Python UDF fails without its environment and completes with it | `test_environment.py` | slow | 2 min |
| A custom operator as a resource, used by URI, pinned environment, deletion refused while referenced (acceptance 5) | `test_operator.py` | slow | 2 min |
| A project shared with a viewer: reads, runs, nothing more; revoked (acceptance 6) | `test_sharing.py` | | 20 s |
| A shared chat is a group chat: a viewer reads and watches, an editor posts and takes the turn under his name, the watch delivers messages, rewrites and the lock to the others | `test_collaboration.py` | | 10 s |
| A run watched through its event stream: operator progress, pause and resume through the catalog, the phase following the unit's word, every row at the end | `test_controls.py` | slow | 1 min |
| A credential in an operator property, leased for the run; a viewer refused before any run exists, until granted use (acceptance 7) | `test_credentials.py` | | 30 s |
| The lake enforces the catalog's decision: namespaces per run, identities per unit, nothing for anyone else | `test_lake.py` | local | 20 s |
| The unit's doors: its API answers the catalog alone, the gateway has no route to it, only the running unit reports on a run | `test_doors.py` | local | 20 s |
| Results survive a restart of the unit | `test_unit_restart.py` | local, destructive | 2 min |
| A computing unit as a resource on Kubernetes: ready, run, spec change rolls it, use granted, terminate, delete | `test_cluster_unit.py` | cluster, slow | 2 min |
| What the engine says reaches whoever asked, through the API and the dataflow tools: a raising operator fails the run in its own words, a compile error, a port with no result; a port is empty until its table is written | `test_engine_errors.py` | | 30 s |
| The agent runtime reaches every MCP server a template mounts, from inside its pod | `test_cluster_agents.py` | cluster | 5 s |
| A chat names the unit its runs use: a tool call made in the chat compiles and runs there, a unit named in the call wins, outside a chat nothing changes, a forged origin is refused | `test_chat_unit.py` | | 20 s |
| The Texera Agent builds, runs, edits and reruns through a chat (acceptance 3, 9) | `test_agents.py` | model, slow | 2 min, about 30 model calls |
| One agent, one chat: it consults the bio tools for research ideas, analyzes the person's data from a run, and shares it with Bob, with no handoff (acceptance 10, 11) | `test_agents.py` | model, slow | 3 min, about 40 model calls |
| The agent's runs go to the unit the chat names, without being told | `test_agents.py` | model, slow | 1 min, about 10 model calls |
| Bob, an editor of Alice's chat, asks the analyst; the question and the answer are his turn, and Alice reads them | `test_agents.py` | model, slow | 30 s, a few model calls |

Markers gate what runs: `model`, `cluster`, `local` and `destructive` tests are skipped unless
the matching flag is given (`--model`, `--cluster`, `--local`, `--destructive`); `test.sh`
passes the right ones per layer. `local` means the Compose stack's host ports (Lakekeeper,
Keycloak, OpenBao, the unit process); `destructive` means other tests may see the effect
(the unit restarts, every finished run on the stack expires), so those run last.

Playwright covers the pages: sign-in, a chat with an upload that becomes a dataset and stays
a card of the message, a turn that fails and says why across a reload, a long first answer
that ends up on screen, the operator page with its versions and sharing, a run's lineage and
its keep mark, two people in one chat (the other's messages and turn arrive live, under their
name), a run page that follows a slow run and pauses and resumes it, and with the model the
two chat scenarios: the agent answering from a workflow it built on the unit the chat names,
and one agent researching, analyzing and sharing in one chat
(`frontend-next/e2e/texera2.spec.ts`). The two model scenarios make the iris dataset they ask
about in a project of their own and remove it at the end with what the chat made, as the
pytest scenarios do; a wiped stack has no iris to find otherwise.

## Rules

- **A test owns its data.** Everything it makes goes into its own project (`project` fixture)
  and is deleted at the end in reference order. What the project's chats made is deleted
  too, wherever it landed (an agent's workflow goes to alice's home project unless the tool
  names a parent). A leftover is reported as a warning, never hidden: one once got shared
  in place of the next test's same-named dataset.
- **Names are plain.** With a project per test there is no need for timestamps; the run id in
  the project's name tells one run's leftovers from another's. A name a prompt gives the
  model is unique across the run's tests as well (`my_iris`), so search finds one.
- **Platform-wide changes are guarded.** `settings_guard` restores the settings,
  `grants_guard` revokes what the test granted.
- **Live state is read from the stream, not polled.** `texera_e2e.events.Watch` reads a
  resource's event stream on a thread; a test acts, then waits for the event its action
  caused (`until`, `next`). A test that would poll the catalog for a phase is testing the
  wrong thing.
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
