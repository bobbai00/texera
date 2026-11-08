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
| Who I am, the seeds, workflow versions and edits, sharing, dataset files and references, a new chat that stores nothing and what it runs with, a turn and its origin, the one MCP server and every tool it has (acceptance 1, 2) | `test_catalog.py` | | 5 s |
| A dataset's import reaches the public internet only: the platform's own gateway by name and by address, private and metadata addresses, plain http, a password in the URL are refused and nothing is staged; a viewer imports nothing | `test_import.py` | | 1 s |
| Running a workflow in three phases: the dry run's plan is the execution's, stored without secrets; the tables the catalog named, ports, rows, lineage; the keep mark (acceptance 3, 4 at the API) | `test_run.py` | | 15 s |
| Results kept per execution, through later executions and the unit's idle release; an execution deleted with its tables | `test_results.py` | slow | 1 min |
| A project's limit expires its own old results, nobody else's; the record stays; a kept execution does not expire; Texera's admins sweep | `test_results.py` | | 20 s |
| A unit made from a profile has its packages: a Python function that imports one fails on the deployment's unit and completes there; the execution records the profile version and each package as installed; the unit saved as the profile's next version and as a new one, its packages pinned; on Compose the unit is the deployment's own with the profile's packages | `test_profile.py` | slow | 3 min on a cluster, seconds on Compose |
| A custom operator as a resource, used by URI and run, deletion refused while referenced (acceptance 5) | `test_operator.py` | slow | 1 min |
| A project shared with a viewer: reads, runs, nothing more; revoked (acceptance 6) | `test_sharing.py` | | 20 s |
| What others shared with a person is one list whatever its kind and project (a project, a chat, a workflow, a dataset), not what is inside a project they were given; a grant taken back takes the thing off it | `test_sharing.py` | | 5 s |
| A watch ends when what let the watcher read is taken back, on the project the resource lives in, though nothing about the resource changed | `test_sharing.py` | | 20 s |
| A shared chat is a group chat: a viewer reads and watches, an editor posts and takes the turn under his name, the watch delivers messages, rewrites and the lock to the others | `test_collaboration.py` | | 10 s |
| A note is a message of no turn: said under its writer's name while someone else's turn runs, which it leaves untouched | `test_collaboration.py` | | 5 s |
| The document of a workflow's live session is the live service's alone to read and write; only it saves a version in the names of the people who edited; an edit against a head that moved is a conflict | `test_collaboration.py` | | 5 s |
| An execution watched through its event stream: operator progress, pause and resume through the catalog, the phase following the unit's word, every row at the end | `test_controls.py` | slow | 1 min |
| A credential in an operator property, leased for the execution; a viewer refused before any execution exists, until granted use (acceptance 7) | `test_credentials.py` | | 30 s |
| An execution keeps its results in a warehouse chosen like a unit: the one the project inherits from Texera unless the project's default or the request names another; the rows are written there and read from there | `test_warehouse.py` | | 15 s |
| Using a warehouse is a permission of its own: a viewer runs into Texera's, and into the project's once given the use of it | `test_warehouse.py` | | 15 s |
| A warehouse on a store of its own: an address Texera does not list is refused, a project's own list narrowing and never widening it, the lake refuses a wrong key and nothing is made, the right one is taken and written to; its place cannot change and its credential stays | `test_warehouse.py` | | 10 s |
| A warehouse goes only when nothing keeps results in it and nothing names it | `test_warehouse.py` | | 10 s |
| The lake holds an execution's namespace in the warehouse it names and not in the deployment's; a person's own token gets nothing from it | `test_warehouse.py` | cluster | 10 s |
| The lake enforces the catalog's decision: namespaces per execution, identities per unit, nothing for anyone else | `test_lake.py` | local | 20 s |
| The unit's doors: its API answers the catalog alone, the gateway has no route to it, only the running unit reports on an execution | `test_doors.py` | local | 20 s |
| Results survive a restart of the unit | `test_unit_restart.py` | local, destructive | 2 min |
| A computing unit as a resource on Kubernetes: ready, run, spec change rolls it, use granted, terminate, delete | `test_cluster_unit.py` | cluster, slow | 2 min |
| What the engine says reaches whoever asked, through the API and the MCP tools: a raising operator fails the execution in its own words, a compile error, a port with no result; a port is empty until its table is written | `test_engine_errors.py` | | 30 s |
| The agent runtime reaches every add-on a chat mounts, from inside its pod; the catalog's own server is the one marked `platform` | `test_cluster_agents.py` | cluster | 5 s |
| A run in a chat goes where any run goes: the unit the project inherits from Texera when nothing is named, a workflow's own unit, a unit named in the call; a forged origin is refused | `test_chat_runs.py` | | 30 s |
| Texera is what every project inherits from: open to everyone, its admins (the identity provider's administrator) change and add to it and nobody else does, its look is the sign-in page's; a project inherits from a base only its admin administers, its people read what the base holds and change none of it, the base's admins get nothing below and send it back to Texera; settings come from the nearest project and limits from the strictest; a public project's contents are listed as they can be opened | `test_projects.py` | | 20 s |
| A scope is a project and what it inherits; a call made in a chat is scoped to the chat's project and what it makes goes there | `test_scope.py` | | 10 s |
| A chat stores choices of how its agent works only (no unit); the catalog resolves what a turn runs with: the chat's choice, then the nearest project's up its chain (Texera's at the top, each named), then the agent's own; a choice someone may not use is passed over for them | `test_chat_settings.py` | | 15 s |
| The Texera Agent builds, runs, edits and reruns through a chat that stores nothing; what it makes is in the chat's project, and every answer records its agent version, model and servers (acceptance 3, 9) | `test_agents.py` | model, slow | 2 min, about 30 model calls |
| One agent, one chat: it consults the bio tools for research ideas, analyzes the person's data from an execution, and shares it with Bob, with no handoff (acceptance 10, 11) | `test_agents.py` | model, slow | 3 min, about 40 model calls |
| The agent's executions go to the unit the person names in their words; the chat stores no unit | `test_agents.py` | model, slow | 1 min, about 10 model calls |
| Asked to, the agent makes a unit from a profile, runs on it and keeps the results in the warehouse it was told | `test_agents.py` | model, slow | 3 min, about 15 model calls |
| Bob, an editor of Alice's chat, asks the analyst; the question and the answer are his turn, and Alice reads them | `test_agents.py` | model, slow | 30 s, a few model calls |
| The diabetes use case: a researcher asks what the platform gives her (nothing is made), has the agent bring the public Pima cohort into a dataset (the file byte for byte), asks to screen it with the team's onset-risk model; the agent asks where it runs, offering what can start here and no GPU where none starts; she picks Small; the unit is made from Small, every run goes to it, and the chat's graph joins the cohort, the model and the team's operators to the workflow and the workflow to the unit | `test_diabetes.py` | model, slow | 5 to 10 min, about 40 model calls |

Markers gate what runs: `model`, `cluster`, `local` and `destructive` tests are skipped unless
the matching flag is given (`--model`, `--cluster`, `--local`, `--destructive`); `test.sh`
passes the right ones per layer. `local` means the Compose stack's host ports (Lakekeeper,
Keycloak, OpenBao, the unit process); `destructive` means other tests may see the effect
(the unit restarts, every finished run on the stack expires), so those run last.

Playwright covers the pages, in twelve files under `frontend-next/e2e/`. `texera2.spec.ts`, the
app: sign-in, a chat started by its first message with an upload that becomes a dataset and stays a card of the message, the agent's page (on show, read-only),
the project a person works in (what the lists show, where new things go, the pick kept; a
project made in the app is worked in at once and the dialog names it; with every project in
view the dialog and the chat box ask which project and make nothing until told), the sidebar
collapsed to a rail that lies over nothing, a
chat's model, unit and add-ons chosen in its box, a turn that fails and says why across a
reload, a long first answer that ends up on screen, the operator page with its versions and
sharing, a computing unit made from a profile with a size of its own (its page says how it
differs from the profile, and a package added there is saved on it), the deployment's unit
saved as a profile of one's own in the project one works in, a project's Settings tab saying what it
inherits from and where each value comes from (its admin sends it back to Texera, and working in it
the app wears its look), a warehouse made from its page and kept as its
project's (the dialog asks where it keeps its tables; an execution's page names it and shows
the rows; it stays while results are in it), an execution's lineage and its keep mark, two
people in one chat (the other's messages and turn arrive live, under their name), an
execution's page that follows a slow one on its canvas (the operator's card running, paused,
done, with its rows) and pauses and resumes it, and with the model the two
chat scenarios: the agent answering from a workflow it built in the chat's project on the
unit named in the question, and one agent researching, analyzing and sharing in one chat. The two
model scenarios make the iris dataset they ask
about in a project of their own, work in that project, and remove it at the end with what the
chat made, as the pytest scenarios do; a wiped stack has no iris to find otherwise.

`canvas.spec.ts`, the canvas: an operator is a card that says its settings in words, in one
line or each on its own, keeps its result at a click on its eye (in the workflow), and is
edited in place with no panel beside it, the card under it making room; a right click turns
it off and deletes it; the arrows are curves; a workflow too large to see at once offers a map,
which lies over the canvas only once the viewer opens it and stays as they left it; a run
stays on the workflow's page, where each card says how its operator did and the rows it read
and put out, only kept results have tabs, a click on a card shows its result and lights its
port, the same version is run again from the page as an execution with a name of its own, and
a run up to one operator runs only what leads to it and changes no version; an execution's
page is the workflow as it ran, and a visualization's result is the chart it drew, whole, not
a table of its HTML; "Tidy up" lays a workflow out so a join stands between its branches
and no card lies on an arrow, and makes no version; the bar beside Run says where a run goes
(the unit, the profile it is made from, the warehouse), a warehouse picked there is where the
run keeps its results, and the execution's page and its lineage card say so, with each
package as installed. Editing like an editor: several cards picked at once (a Ctrl or Cmd
click, a Shift box) go with one key, and Ctrl+Z brings them back with their arrows (Ctrl+Shift+Z
does it again); a new operator's card opens with its first setting ready to type in, Backspace
editing the setting and never removing the operator, and an operator with nothing linked says
it needs an input; a setting that names a column offers the input's columns with their types.
The results float in a window over the canvas: each named as its card names it (two
aggregates told apart), pointing at one rings its card, no card lies under the window when it
opens, and it moves by its title bar, stays where it was put across a reload, folds, goes back
on a double click, and says "ran v1" once the workflow moves on.

`lineage.spec.ts`: a workflow's lineage as a graph at its two levels: the dataset, the
workflow and its executions as cards with the arrows' words, then the file, the version that
ran and each result; a person the workflow is shared with, without its dataset, sees the graph
once and steadily (it used to blink without end), the dataset drawn "Not shared with you".

`graph.spec.ts`: the graph beside a chat, made the way the runtime makes it, in a turn, so no
model is needed: a workflow over iris in the frame of its unit, one arrow for the read and one
for each table, no arrow for a unit or a function, the plan's dataset dashed; nothing moves when
a second workflow arrives; Detail shows the steps in order with each table level with its step,
Overview only names, a double-click opens a workflow at its steps, and a click opens its details
with its run (`test-results/resource-graph.png`, `resource-graph-detail.png`).

`dock.spec.ts`, the agent beside a page: on the page of every kind (fourteen, made in a
project of the test's or taken from the built-ins) the chat button opens a chat whose message
tells the agent the kind, the name and the URI of what is on screen, in the project the
person works in, and the dock stays on that chat, busy with the question from the moment it
shows; with every project in view the box proposes the page's own project and the
person may choose another; the app remembers the chat used beside a page; the operator
selected on a canvas is told; and with the model, the agent answers about "this" dataset from
its file and about "this" workflow without making another.

`sharing.spec.ts`: a project, a chat, a workflow and a dataset are each shared from the Share
button of their page (the link, copied; the person found by name; the owner's own grant not
one to take back), and the other person finds all four under "Shared with me" and opens each;
a link to something not shared says so on the page of every kind and opens once it is shared;
a grant taken back in the dialog closes the page the other has open, with no reload, and takes
the thing off their list; a person shared a workflow but not the dataset it reads is told
before Run, above the canvas and on the scan's card, what is missing and whom to ask, and runs
once it is shared; a person is offered only what the catalog lets them do: a viewer reads (no
rename, no delete, no keep, no "Work in this project", a chat box that says it is for reading),
an editor changes, and only the owner deletes.

`resources.spec.ts`, a resource's page keeps what the person is doing: an edit of a spec in
progress survives a rename, and a save over someone else's change says so and asks whose to
keep; deleting an execution takes it off its workflow's page (the count, the results window),
and deleting a project from its own page leaves it.

`pages.spec.ts`: search opens what matches with Enter, and offers a new chat first when nothing
is typed; a library lists every one of its kind, not the first hundred; a file's preview says
it shows the first rows, of how many; a list opens from its first option, whichever is picked.

`collaboration.spec.ts`, people together: who has a page open is shown at its top right on
every kind's page and in a chat; two people see each other come and go; two people edit one
workflow at the same moment (an operator added, a property changed, an operator dragged) and
the versions name them both, the layout being one for everyone and no version of its own;
where operators sit goes into the next version, and an older version is drawn as it was laid
out; what the agent adds through its patch arrives beside what it reads from, pointed out,
and nothing else moves; the people on one canvas see where the other points and the card the
other has open; a viewer watches and cannot change; a version written through the API arrives on an open canvas
beside an edit not saved yet; a workflow the catalog does not take as a version says so on
everyone's page, does not run, and is saved once put right; a note is posted from the chat
box without asking the agent, also during someone else's turn; what a chat runs with changes
in everyone's box at once; and with the model, one of two people asks the agent, which answers
from what the other said under his name, while the other watches the answer arrive.

`diabetes.spec.ts`, with the model: the diabetes use case in the app. A project of the test's
own holds the team's onset-risk model (fitted by the scenarios' Python, `texera_e2e.diabetes`)
and two of its operators; the researcher asks what there is, has the agent bring the public
Pima cohort into a dataset, asks for the screening, picks Small on the agent's question card,
and the graph shows the cohort read by the workflow, the model and the operators on its card,
and the workflow in the frame of her unit; a double-click shows its steps, predict with the model
among them (`test-results/diabetes-ask.png`, `diabetes-graph.png`, `diabetes-graph-steps.png`).
`e2e/support.ts` holds what the files share: signing in, the API caller, a page of every kind,
and the tidying up each scenario owes the stack.

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
- **Model tests assert outcomes**, never wording: resources made in the chat, executions completed,
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
profile scenario accepts a bare `ModuleNotFoundError` there. The known
limits of the system itself are in the handoff.
