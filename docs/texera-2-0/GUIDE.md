# Using Texera 2.0

Texera 2.0 is a chat-first data analysis platform. A person asks an agent; the agent builds and
runs workflows through the Texera MCP server; every dataset, workflow, execution, operator and
agent is a resource of one catalog, versioned, shareable, and linked by lineage. Everything
below runs on one machine with the dev stack, or on a local Kubernetes cluster with one
command. This guide goes from the first sign-in to executions, agents, the API by hand and your own
agents; the deeper documents are listed at the end.

## 1. Bring it up

Prerequisites: Docker with Compose v2, Go, JDK 17 with sbt, Bun 1.3, uv 0.9 (the table with
versions and why: `bin/texera-2-0/README.md`). Then, from the repository root:

```
cp .env.example .env            # ANTHROPIC_API_KEY=... (the agents need a model; everything else works without)
bin/texera-2-0/up.sh            # the containers, then the catalog, the computing unit, the agent runtime, the live service, the frontend
```

`up.sh` takes a few minutes the first time (the Python environment, the engine's compilation)
and is idempotent: run it again after a change to restart what changed. Open
**http://localhost:8088** and sign in as `alice` / `alice` or `bob` / `bob` (`texera-admin` /
`admin` is one of Texera's admins). Logs are in `logs/texera-2-0/<service>.log`.

```
bin/texera-2-0/down.sh          # stop everything, keep the data
bin/texera-2-0/down.sh --wipe   # stop everything and delete the volumes (a fresh realm, store and lake)
```

The same stack on Kubernetes: `bin/texera-2-0/k8s.sh up`, then http://localhost:28088 (section 8).

| Piece | Where | Role |
| --- | --- | --- |
| Gateway (Envoy) | :8088 | the only entry point: the app, `/catalog/v1`, `/mcp/*`, `/agents/*`, `/auth` |
| Catalog (Go) | :8090 | the control plane: resources, versions, grants, executions, lineage, the MCP server |
| Computing unit (Amber) | :28085 | runs workflows; reached by the catalog only |
| Agent runtime (Bun) | :23002 | runs one chat turn at a time |
| Frontend (vite) | :5174 | the workspace, served through the gateway |
| Keycloak, OpenFGA, OpenBao, Postgres, RustFS, Lakekeeper | containers | identity, authorization, secrets, the store, blobs, the lake |

## 2. The workspace

**A chat.** The home page is where a chat starts: say what you want, and your first message
makes the chat, in the project you work in. Every chat runs the Texera Agent: it answers data
questions by building and running workflows, and grounds research questions in the biomedical
literature. The foot of the box shows what the chat runs with: the agent, its model and the
add-on tools. Change one and the chat stores your choice; a chat you never touch stores nothing
and follows its project's and the platform's defaults. Where its executions run is not a chat's
choice: they go where any execution goes (see "Computing units"), and you say "run it on my GPU
unit" in words when you want another. Attach a CSV from the box
and it becomes a dataset of the chat's project, shown as a card of your message. What the
agent makes shows as a card in its message. Beside the chat, "From this chat" holds what the
chat made and what it worked from as a tree: a section per kind, each resource, its versions,
and under a version the executions that ran it or the files it holds. Every level folds. What
the chat made reads plainly; what it worked from (what you attached, what its workflows read,
the workflow a run ran) is dimmed. What a search or a list only returned is not in it.
Each answer is labelled with the version of the agent and the model that wrote it. A turn that
fails says why in the chat, and still does after a reload.

**A chat with others.** Share a conversation like any resource and it is a group chat: an
editor posts and takes turns, a viewer reads along. Their messages arrive as they are sent,
under their names; one person talks to the agent at a time, and while Bob's turn runs Alice
sees "Bob is talking to the Texera Agent", watches the answer arrive, and waits to ask. A
message asks the agent unless it is posted as a note (the button beside Send): a note is said
to the people in the chat, takes no turn, and can be posted while someone else's turn runs.
The agent reads everything said, each person's message under their name, and is told whom it
is answering, so "run it" from Bob after "use the 2020 data" from Alice means what the two of
them meant. What the chat runs with is one choice for everyone in it: a model or an add-on
changed by one person changes in everyone's box. A choice that someone in the chat may not use
(the owner's own model or unit) is passed over for them: their turn runs with the next
default, and the chat says so. The same works from the API: a grant on the conversation is the
membership, every message carries its author, a message of no turn is a note, and the turn
lock names its holder.

**The agent beside a page.** Every resource's page has a chat button at its bottom right. It
opens a chat beside the page, and each message tells the agent what you are looking at: the
kind, the name and the URI of the resource, the version if you opened one, and on a workflow's
canvas the operator you selected. "What does this do?" needs no more than that. An edit of the
page still on its way is saved before the agent is asked, so it reads what you see. It is an
ordinary chat: it is bound to nothing, it is in the resource's project when you may write
there and in your own otherwise, you can open it as a full page, and the app remembers which
chat you last used beside each page. It is a window over the page that blocks nothing else on
it: drag its header to move it, its top left corner to size it, double-click the header to put
it back; this browser remembers where you left it.

**Who is here.** The people who have a resource's page open are shown at its top right, you
first, each with their own colour: on every kind's page and in a chat. Hover an icon for the
name.

**Projects.** Everything lives in a project, and you work in one at a time, picked at the top
of the sidebar: "Personal", your home project, until you pick another, or "All projects". The
lists show the project you work in and what it inherits, each inherited thing saying which
project it comes from; what you make goes into it (a chat, a workflow, anything, from a library page, the home page or the chat beside
a page), and so does what the agent makes in a chat of that project. The "New …" dialog says
which project that is. With "All projects" there is no one project to make things in, so the
dialog and the chat box ask which; beside a page the chat box proposes that page's project.
A project you make is the one you work in from then on, and a project's page has "Work in
this project". A name is a label, so two
things in a project may have the same name; each has its own address. Share a project and everything in it is
shared the same way; make it public and everyone can read what is in it.

**Inheritance.** A project inherits from one other, its *base*, up to **Texera**, the project at
the top of every chain; a new project and your home inherit from Texera unless you pick one of
your own. Its people read and use what the projects up its chain hold (the engine's operators,
the profiles, the agent, a lab's shared functions) and change none of it; the base's admins get
nothing in the projects below. Inheriting is sharing, so a project inherits only from a project
its admin administers too, or from Texera, which is open to everyone; the base's admins may send
a project back to Texera; a chain never loops; a project others inherit from cannot be
deleted; and a project is public only when everything it inherits is.

**A project's settings** are its spec: its look (`branding`: a name and a logo the app wears
inside it), its `defaults` (the agent, the model, the computing unit, the profile a new unit is
made from, the warehouse, the add-on tools and the work mode of its chats) and its `limits`
(how long results are kept, which object stores a warehouse may use). What a project leaves
out it inherits: a look or a default comes from the nearest project up the chain that sets it,
a limit is the strictest along it, so a project narrows what it inherits and never widens it.
Its Settings tab shows what holds and which project each value comes from
(`GET /projects/{rid}/settings`), what it inherits from, and what it sets itself.

**Admins and members.** A project's owners are its admins: they change the project itself, its
settings, its base and its people. Its editors are its members: they work in it. A project's page
says your role beside its name (admin, member or viewer). Its People tab shows everyone in it who
is in it and with which role; its admins add people, change a person's role in place and remove
them there, and the person who made the project stays its admin.
On its Settings tab its admins say what it is for, choose what it inherits from, and see the
projects that inherit from it, each with "Send back to Texera"
(`GET /projects/{rid}/inheritors`). Texera is a
project like any other: the release ships into it (the agent, its skills and MCP servers, the
model endpoint, the deployment's unit and its profile, the profile ladder, the warehouse, the
engine's operators), and its admins change, add or delete any of it for everyone; a later
release updates only what they left alone and never brings back what they deleted. Taking an
engine operator out of Texera takes it from every workflow: a workflow runs only operators its
project offers along its chain. The identity provider's administrators (`texera-admin`) are
made Texera's admins when they sign in, and they make others admins on its People tab; nobody
passes the authorization checks for being an administrator.

**The library.** Every kind has a page under its plural, linked from the sidebar: what you
make and keep (`/workflows`, `/datasets`, `/models`, `/operators`, `/computing-units`,
`/profiles`, `/warehouses`), what happened (`/executions`, across workflows), what the agent is made
of (`/agent-templates`, `/skills`, `/mcp-servers`, `/model-endpoints`, `/credentials`),
and `/projects`. "New …" opens a form generated from the
kind's schema; a new computing unit asks for the profile it is made from and its size, a new warehouse for where it
keeps its tables. A resource's page has its
spec (a form, the JSON a click away), its versions, who can access it, its lineage and the raw
envelope; `?panel=` opens a second resource beside the first.

**Workflows.** The editor is a canvas over the spec: operators (the engine's, which Texera
offers every project unless its admins took one away, and the custom operators of the
workflow's project and what it inherits, by URI) joined by arrows. An operator is a card:
its name, and its settings in one line as a person would say them (a file by its name, a
filter as `medal = Gold`). "Compact | Detailed" at the top of the canvas chooses how much every
card says; "Detailed" lists each setting on a line. A card has the operator's own two buttons:
the eye keeps its result on every run (it stays in sight while it is on), and the run button
runs up to it. The pencil on a card (or a double click) opens the card into its form, where
the operator is renamed and set (properties from its JSON Schema; code a few lines in the card
and all of it in a larger editor); the open card stays within its column and the cards under
it move down while it is open. A right click turns an operator off or on, or deletes it.
Nothing opens beside the canvas. "Add operator" opens the list of operators; a workflow with
none opens with it. Where operators sit belongs to the workflow: a move is shared at once with
everyone on the canvas and makes no version, and the next version holds the places of that
moment, so an older version and an execution's page are drawn as they were laid out. "Tidy
up" lays the workflow out again, left to right, a join between its branches and no card on an
arrow. What the agent adds goes beside what it connects to and is pointed out for a moment.
The people on a canvas see where each other points and which card each has open. A workflow of a dozen operators or more has a
map button with the zoom buttons; the map opens over a corner of the canvas and stays open or
closed as you left it. A file property takes a dataset file URI,
`texera://datasets/{rid}@{vno}/files/{path}`. The editor compiles as you edit, on a unit, and
a card says what is wrong with its operator. Every save is a version; an execution pins the
version it ran.

**An execution on the canvas.** "Run" starts an execution and the page stays where it is:
each card says where its operator stands (waiting, running, paused, done, failed with the
reason, or stopped when the run ended before it finished) and the rows it has read and put
out, second by second; a running card
has a bar moving along its edge, and an arrow moves while rows go along it. The bar over the
results says how far the execution is ("3 of 7 done") and for how long. A run keeps the
results of the operators whose eye is on, of the operators nothing reads from, and of the
operator a run was asked to go up to; under the canvas is one tab for each, named after its
operator. A click on a card puts its result on screen: its card is ringed and the port it came
out of is lit (a port whose result is kept is lit too); a tab brings its operator into view. A
run up to an operator (its run button) runs only what leads to it and shows its result; the
workflow does not change. A result is a table (paged rows), or, for a visualization operator,
the chart it drew. The results fold away; "Execution" opens the execution's own page beside the
workflow.

**A workflow edited together.** Everyone who may change a workflow edits the same document at
once: an operator one person adds, a property they change or a place they drag an operator to
shows on the others' canvases as it happens, and two people changing different properties of
one operator both keep their change. Someone who may only view watches. Nobody's browser
saves: the live service saves a version a moment after the edits stop, and the version names
the people whose edits it holds. A version written elsewhere, by an agent or the API, arrives
on the open canvas beside the edits not saved yet. "Run", and a question to the agent beside
the page, first have the session save, so they are about exactly what is on screen. If the
catalog does not take the workflow as a version (a file property that names a file that does
not exist, the catalog being away), the page says "Not saved" and why, for everyone in the
session; the edits stay, a run does not start, and the session keeps trying.

**Executions.** An execution's page is the workflow as it ran, on the same canvas (the
version it pinned, laid out from its graph, not editable): each card says how its operator
did, as the unit reports it while the execution goes, and the results are under it, tied to
their operators and ports the same way. "Details" has what it read, where it ran (the unit,
the profile version the unit was made from, the warehouse), what the unit had (its size, each
package as installed) and the record as the catalog holds it; "Lineage" its lineage. "Pause" holds a running one where it is
and "Resume" continues it; "Stop" cancels a live one; "Keep" marks a finished one so the
retention policy leaves its results alone; "Delete" removes it with its tables. The page
follows the execution without reloading. Results live with the execution: to use them again,
run again or read the rows. An execution lives under its workflow; the sidebar lists them
across workflows because that is how people look for one.

**Lineage.** A resource's "Lineage" is a graph that reads left to right: what was read, what
ran, what came out. Each thing is a card with its name and what it is; each arrow says what
happened (read, ran, produced, saved as, referenced by), drawn dashed when a spec only names
the thing and nothing ran. "Resources" shows one card per dataset, workflow and execution,
with an execution's results folded into it. "Data flow" shows the parts: the file an operator
read, the workflow version that ran, the execution, and the result of each output port with
its rows. A workflow shows its two most recent executions and folds the earlier ones into one
card that opens on a click. A card opens its resource beside the page; something that was not
shared with you is a card that says so. Each card also says who made it: "by Alice Liddell" for
what a person made, or "by" a chat for what the agent made in one (the whole of it, with the
person the agent worked for, on hover). The chat's name opens the chat beside, and a chat says
who started it.

**Datasets.** Upload files (they stay staged), then commit a version; download or presign any
file of any version. Uploading the same bytes twice stores them once. A file on the internet is
staged the same way without passing through you: `POST /datasets/{rid}/import` with `{"url",
"path"}` has the catalog fetch it (the agent's `import_dataset_file`). Only an https file on
the public internet comes in: an address on a private network, the platform's own services
among them, is refused when the connection is made, after every redirect, and so is a redirect
to plain http or a URL with a password in it; a file over `TEXERA_IMPORT_MAX_BYTES` (1 GiB by
default) is not staged.

**Sharing.** A resource is private or public. Grants give a person or group a relation:
`viewer` reads and runs, `editor` writes too, `owner` everything; `user` is "may use" for a
computing unit, a warehouse, a credential or a model endpoint, and viewing never implies using. The Share
button at the top right of a resource's page (a project, a chat, a workflow, a dataset, any
kind) shows its link and who it is shared with, and finds people by name or email, logged in
or not. What others gave you is under "Shared with me" in the sidebar, in one list whatever
its kind and project; a project you were given is also one you can work in. A link to
something that was not shared with you says so instead of failing, and opens once it is.
Taking a grant back takes the thing off the other person's list and closes a page they have
open, within half a minute. Under each person something is shared with, the list says what they
cannot open of what it uses, from its lineage: the datasets a workflow reads, its custom
operators ("Can't open 1 thing this uses: iris"). "Share them too" gives them viewer on each one
you may share; for the rest it says to ask the owner. The unit and the warehouse it names are
left out: whoever opens it runs on their own.

**Texera's settings** are what every project inherits unless it sets its own: the look of the
sign-in page and of every project without one, the defaults (agent, unit, profile, warehouse),
the stores a warehouse may be on at all, and how long results are kept (section 5). Its admins
change them on Texera's Settings tab.

## 3. Agents

One agent is the entry to every chat: the **Texera Agent**. It runs one turn of a
conversation at a time, on the person's behalf and with the person's own permissions.

**What it is made of.** A system prompt, tools, and skills.

- **Basic tools**: the platform's own MCP server, the catalog, plus `load_skill`. The catalog
  server holds every tool of the platform, because a workflow is a resource and running it is
  one of its verbs: resources with their versions, lineage and sharing, dataset files,
  operators, computing units and profiles (`create_computing_unit` from a profile,
  `save_unit_as_profile`), and `create_workflow`, `edit_workflow`, `validate_workflow`,
  `run_workflow`, `get_execution`, `get_port_result`, pause and resume. The agent lists it like
  any other server; nothing is mounted behind its back.
- **Add-ons**: any other MCP server; the platform ships the bio server (PubMed, genes,
  variants, proteins). An add-on that cannot be reached is left out of the turn and the agent
  is told, so it says so instead of answering from memory; the turn goes on with the rest.
- **Skills** are Markdown the agent loads by name when it needs them (building workflows,
  Python operators, reading results, the literature review), so the prompt stays short.
- The agent is told, at every step, today's date, the project the chat is in and the computing
  unit an execution falls back to. It works where the chat is: its searches cover the chat's
  project and what it inherits, up to Texera, unless it names another scope, and what it makes
  goes there; `project_settings` tells it what a project runs with and where each value comes
  from.
- Asked from beside a page, it is also told what the person is looking at (the resource and,
  on a canvas, the selected operator), and "this" means that. In a chat several people write
  in, it reads each message under its writer's name and is told whom it is answering.
- It edits a workflow by a patch against the head it read and names that head
  (`expectedHead`): if someone changed the workflow in the editor meanwhile, the edit is
  refused as a conflict and the agent reads the workflow again, instead of the patch landing
  on the wrong operator. What it writes arrives on the canvases of whoever has the workflow
  open.

**What a chat runs with.** A chat stores choices and nothing else: its agent, the model, the
computing unit its executions prefer, its add-on servers. A turn runs with the chat's choice,
else the default of the nearest project up the chat's project's chain (Texera's at the top),
else the agent's own; each setting says which project it came from. The add-ons a chat lists
take the place of the agent's and the project's; the catalog server is not an add-on and
stays. The catalog decides, in one place: `GET /conversations/{rid}/settings` says what a turn
would run with and which level chose each, `GET /projects/{rid}/chat-settings` the same for a
chat not started yet. The runtime builds what it says, and each answer records the agent
version, the model and the servers that wrote it.

**Where it is defined.** The agent is a file in the repository,
`catalog/internal/catalog/agents/texera-agent.md` (its card and its system prompt), next to the
skills in `skills/*.md`; the model endpoint, the skills and the MCP servers it uses are a few
lines of `seed.go`. The catalog ships it at start into Texera, as Texera's default agent. A
changed file is a new version at the next start, unless Texera's admins changed the agent
themselves (then theirs stays); a turn runs the newest version, and every message records the
version that wrote it, so a change is traceable and is undone by reverting the file. What an
older release shipped and nobody changed is removed at the next start, and a chat that named it
falls back to the default. The model, its key and the bio server's address come from the deployment
(`TEXERA_MODEL_NAME`, the key in `.env`, `TEXERA_BIOMCP_URL`).

- **Model endpoints** name a provider and a model (`anthropic`, or `openai_compatible` with a
  base URL) and the **credential** whose secret is the key. The runtime holds no key: it
  leases the credential for the turn, as the person. Register your own and pick it in a chat's
  box.
- **MCP servers** are any streamable-HTTP server; a header value `credential:<uri>` or
  `credential:<uri>#<field>` is replaced by the leased secret. Register your own and switch it
  on in a chat's add-ons, or list it in a project for all its chats.
- The conversation keeps the history; the runtime is stateless, so one turn runs at a time
  (`409 turn_active` otherwise) and a crash loses nothing.

Not offered for now: making agents of your own in the app (the API makes them, and a chat can
name one), switching agents in a chat, handing a chat from one agent to another, and asking
before the agent acts. The `/mode` command and the handoff tool remain in the code for when
they return.

## 4. Workflows and executions, by the API

`bin/texera-2-0/examples/walkthrough.py` is the tour, runnable as is, and prints every
request it makes: sign in, a project, a dataset with a committed file, a workflow, the plan
an execution would use, the execution, its rows and lineage, the keep mark, sharing with Bob,
the MCP tools, cleanup (`--chat` adds one turn with the Texera Agent; `--gw http://localhost:28088` runs it
against the cluster). The pieces, as curl:

```
GW=http://localhost:8088
TOKEN=$(curl -s -d grant_type=password -d client_id=texera-app -d username=alice -d password=alice \
  $GW/auth/realms/texera/protocol/openid-connect/token | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
api() { curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

api $GW/catalog/v1/me                                                   # who I am, my home project
api -X POST $GW/catalog/v1/datasets -d '{"name":"iris","spec":{"format":"csv"}}'          # -> metadata.rid
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" -X PUT \
  --data-binary @bin/texera-2-0/examples/iris.csv $GW/catalog/v1/datasets/$DS/files/iris.csv
api -X POST $GW/catalog/v1/datasets/$DS/commit -d '{"message":"first upload"}'            # -> version 1
api -X POST $GW/catalog/v1/datasets/$DS/import -d '{"url":"https://raw.githubusercontent.com/plotly/datasets/master/diabetes.csv"}'  # staged as diabetes.csv
api -X POST $GW/catalog/v1/workflows -d @workflow.json                                    # {"name":..., "spec":{"operators":[...],"links":[...]}}
api $GW/catalog/v1/computing-units/available                                              # a unit with status.phase ready
api -X POST $GW/catalog/v1/workflows/$WF/validate -d '{}'                                 # compile: schemas, errors, and the plan
api -X POST $GW/catalog/v1/workflows/$WF/run -d '{"name":"first execution","waitSeconds":240}'  # -> the execution, completed
api "$GW/catalog/v1/workflows/$WF/executions/$EID/operators/avg/ports/output-0/rows?limit=10"
api "$GW/catalog/v1/resources/$EID/lineage?direction=upstream"                            # the execution used the file
api -X PATCH $GW/catalog/v1/resources/$EID -d '{"labels":{"texera.keep":"true"}}'         # keep its results
api -X PUT $GW/catalog/v1/resources/$PROJECT/grants/$BOB -d '{"relation":"viewer"}'       # share
```

A workflow spec names operators by type (`scan`, `filter`, `aggregate`, `CSVFileScan`, … ;
`GET /operators?q=Aggregate` gives each type's properties schema) or by a custom operator's
URI, and links ports `output-0` to `input-0`. The engine's own operators that run code
(`PythonUDFV2`, `JavaUDF`, the R UDFs) and those the catalog compiles a workflow into
(`function`, `stored`) are not offered and a workflow that names one is refused: code of a
project's own is a custom operator. The spec in the walkthrough is a complete
example. `viewResult: true` on an operator stores its output so the rows can be read; an
operator nothing reads is stored anyway.

**How an execution starts.** `POST /workflows/{rid}/run` goes through three phases in the catalog.
It authorizes everything the compiled plan names before anything is written: execute on the
workflow, run on the unit, use on the warehouse, read on every dataset file and custom
operator, use on every credential; a refusal leaves nothing behind. It compiles the version into a plan
that is data: the engine's logical plan with files and credentials still named by URI, the
custom operators compiled in, and one table per output port the engine writes, named
`<operator>_<port>` inside the execution's own namespace `e_<rid>` in its warehouse. `validate`
returns the same plan, so a dry run shows what an execution would do. Then it materializes: the execution is
stored with its plan (`spec.plan`, no secret, no URL that expires) and its warehouse
(`spec.warehouse`), its namespace is opened there for the unit's identity, and the engine receives a bound copy with presigned inputs and
leased secrets. The unit reports back as itself through OpenLineage events, and only the unit
running an execution may report on it. `status.ports[]` lists the tables from the start and
fills in rows and snapshots as they are reported; the rows are read by namespace and table,
so a restarted unit, or another unit, serves them from the lake.

With `waitSeconds` the call returns the finished execution; without it, watch it. Every
resource has an event stream, `GET /resources/{rid}/events`, server-sent events for as long
as the connection stays open: `resource` with the envelope after each change (for an execution:
`status.phase`, the operators' states and counts, the ports as they fill), `message` for a
conversation's messages, `deleted` when it goes.

```sh
curl -sN -H "Authorization: Bearer $TOKEN" $GW/catalog/v1/resources/$EID/events
# event: resource
# data: {"kind":"execution",...,"status":{"phase":"running","operators":{"scan":{"state":"Running","tuples":80}}}}
```

An execution's phases are pending, provisioning, running, paused, completed, failed and
cancelled. `POST .../executions/{eid}/pause` holds a running one (the phase turns `paused`
when the unit confirms), `.../resume` continues it, `.../cancel` ends it; a verb that does not
fit the phase answers 409. A workflow with an execution still going on the same unit answers
409 to another.

**Custom operators, credentials.**

- A **custom operator** is a Python function under `@returns(column=type, ...)`: its
  positional parameters are its inputs, one DataFrame each (none makes it a source), its
  parameters after `*` its settings (one typed `Credential` takes a credential), its
  docstring its description. The catalog reads all of it from the code when the operator is
  saved, and refuses code that defines no such function, a class included: the classes that
  run a function are the engine's. It returns a DataFrame or yields DataFrames as it makes
  them, and runs with the packages of the unit it runs on (section 6). A workflow uses it by
  URI with `@vno` as the `operatorType`, with its settings as the instance's properties;
  the catalog compiles the call into the engine's `function`. Deleting an operator a
  workflow version uses is refused, the dependents listed.
- A **credential** holds a secret written once (`PUT /credentials/{rid}/secret`) and never
  read back. A property whose schema says `format: credential` (a function's setting typed
  `Credential`) takes a credential URI; the
  catalog leases the secret for the execution and puts it in the plan the engine receives, never in
  a version or an execution. The caller must be allowed to use the credential.

## 5. Results: warehouses, keeping and losing

An execution runs on a computing unit and keeps its results in a warehouse. A warehouse is a
resource, like a unit: a place in an object store whose tables the lake (Lakekeeper, an Iceberg
REST catalog) manages. The deployment's own is Texera's, and every project keeps its results
there unless something names another. A project can have its own: "New warehouse" makes one on
the deployment's store,
in a place of its own, or on a store of yours (`spec.storage`: the endpoint, the region, the
bucket, a folder in it, and a credential whose secret holds `accessKeyId` and
`secretAccessKey`). Such a store is S3-compatible and hands out short-lived keys itself (STS,
as MinIO and RustFS do): the lake gives a unit access to one table's files that way, and no
unit ever holds the store's key. Texera's admins list the stores a warehouse may be on at all
(`limits.warehouseEndpoints` of Texera; the deployment's own always is), a project's admins may
narrow that list for their project and what inherits from it, and the lake tries a
store before it takes it, so a wrong key or a bucket that is not there is refused when the
warehouse is made. A warehouse does not move: its place is chosen once, and its key follows
its credential when the secret is replaced.

An execution keeps its results in the warehouse the request names (`warehouse` of `run`), else
the workflow's (`defaultWarehouse`), else the project's default (`defaults.warehouse`, which may
come from up its chain), and records it
(`spec.warehouse`); its page shows it. The bar beside Run says it before a run, `on <unit>
(<profile> vN) · results in <warehouse>`, and picks another warehouse for the runs started
there; an execution's card in lineage says the same. On a warehouse's page, "Keep <project>'s results here"
makes it the project's default, for its admins. Whoever runs needs `use` on the warehouse
(grant `user`; Texera's is everyone's). Reading is decided by the execution, not by the warehouse: whoever
may read an execution reads its rows, through the catalog. A warehouse is deleted only when no
execution keeps results in it (`409 in_use`).

Results are Iceberg tables in the execution's own namespace of its warehouse, written by the
unit's own identity and readable through the catalog alone. A project's `limits.results` (an
ISO 8601 duration, `P30D`) is how long a finished execution of it keeps its tables; the shortest
along its chain holds, Texera's included, and set nowhere, forever. The catalog sweeps hourly
(`POST /retention/sweep` runs one now, for Texera's admins); an expired execution keeps its
record and summaries and answers 410 to its rows. The label `texera.keep` on an execution (the
Keep button) exempts it. `DELETE /workflows/{rid}/executions/{eid}` removes a finished execution
with its tables; an uploaded file nobody committed belongs to no project and goes after the
deployment's grace period (`TEXERA_UPLOAD_GRACE`, a day).

## 6. Computing units

A computing unit is the engine deployment an execution goes to, and a resource: `provider:
static` is a unit already running at an `endpoint` (the dev stack's "local unit", started by
`run-unit.sh`, which presents the realm's `texera-unit` client to the lake), `provider:
kubernetes` is one the catalog starts and reconciles on the cluster (section 8): one pod of
the engine, with the memory, CPU and GPUs its master node asks for (a GPU is an
`nvidia.com/gpu` limit; changing the size rolls the pod). A unit answers the catalog's client alone: there
is no route to it through the gateway and no person's token opens it; people and agents run
through the catalog, which authorizes and compiles first. Toward the lake and the catalog a
unit has an identity of its own, and reaches only the namespaces of the executions it ran.
Grant `user` on a unit to let someone run on it; `GET /computing-units/available` lists the
ones you may use.

An execution goes to the unit the request names, else the workflow's default unit, the
project's or the platform's, the same for a run you start and one the agent starts in a chat.
The Run bar proposes that unit, and a unit you pick there is for that page's runs. When the
agent makes a unit for a workflow (it needs packages the platform's unit lacks), it makes it
the workflow's default unit, so the workflow's later runs go there, yours from the Run bar
too. Naming a unit gives no right to it: you must be allowed to run on it.

**Profiles.** A profile is what a unit's node is made of: its memory, CPU and GPUs, and the
Python packages it adds to the platform's runtime (PEP 508 lines), versioned. A unit is made
from a profile version ("New computing unit" proposes the settings' default profile and lets
you change the size; `POST /computing-units/from-profile` with `waitSeconds` waits until it is
ready): its node gets the profile's size and packages and names the version. On a cluster the
unit is a pod of that size; a profile the cluster cannot start, a GPU where no node has one, is
refused with the reason (409 `not_here`), and its status says so when read (`startable`,
`notHere`). On Compose, with no cluster, a unit from a profile is the deployment's own unit
with the profile's packages, not its size (the profile's status says `sized: false`), and a
GPU profile does not start. A unit may change
since, another size or a package added on its page, and its page says how it differs from its
profile. A run installs the unit's packages first, once per list of packages on a unit (the
execution is `provisioning` meanwhile), and records what the unit had in `spec.computing`: the
profile version, the size, the runtime, each package as installed (`pandas==2.2.3`). "Save as
profile" (`POST /computing-units/{rid}/profile`) keeps a unit for others to make units from: as
the next version of its profile when you may change that one, or as a new profile (the
platform's own only as new), each package pinned to what the unit installed; the unit is then
made from what was saved.

## 7. Your own agents and tools

Anything that holds a person's token can do what the person can:

- **The MCP server.** `POST {gw}/mcp/catalog` is a streamable HTTP MCP server (`Accept:
  application/json, text/event-stream`) with one tool per operation of the contract: what
  exists (`whoami`, `search_resources`, `resolve_uri`, `get_resource`, `list_versions`,
  `get_version`, `get_lineage`, `grant_access`, `search_principals`, the dataset file tools,
  `list_operators`, `list_computing_units`), the verbs of a unit (`create_computing_unit` from
  a profile, `save_unit_as_profile`) and the verbs of a workflow and its executions
  (`create_workflow`, `get_workflow`, `edit_workflow`, `validate_workflow`, `run_workflow`,
  `get_execution`, `pause_execution`, `resume_execution`, `get_port_result`). A list takes a
  `scope`, a project: it then holds that project and what it inherits up its chain, and
  `project_settings` says what a project runs with. A tool that fails answers
  with the status and the words of the error, the engine's own when the engine refused. Point
  Claude Code, an SDK agent or any MCP client at it with a bearer token. The walkthrough shows
  one call.
- **The chat protocol.** `POST {gw}/agents/conversations/{rid}/ag-ui` runs one turn of the
  conversation's agent with an AG-UI `RunAgentInput` (only the new user message; the
  history is the catalog's) and streams AG-UI events back: text, tool calls and results,
  `texera.resource` cards, `texera.handoff`. `GET {gw}/agents/templates/{rid}/.well-known/
  agent-card.json` and `POST .../a2a` expose a template to A2A clients.
- **The live session.** `{gw}/live/sessions` is a WebSocket speaking the Hocuspocus (Yjs)
  protocol, one session per resource, named by its rid; the person's token goes in the
  protocol's first message. Whoever may read the resource joins and says who they are in the
  session's awareness state (`user: {pid, name}`). For a workflow the session also holds the
  document people edit at once, and its own awareness state says how the document stands with
  the catalog (`catalog: {vno, refused?}`). The live service loads and saves; it asks the
  catalog who a token is and what they may do, and again every half minute.
- **The contract.** `api/catalog/` (TypeSpec) is the source; `gen/openapi/3.1.0/
  Texera.Catalog.openapi.yaml` the OpenAPI document; `packages/catalog-client` the generated
  TypeScript client; `tests/e2e/texera_e2e/` a small Python client the scenarios use.
- **Tokens.** People sign in through Keycloak (the public client `texera-app`; the password
  grant works for scripts, PKCE for the app). Its sign-in pages wear Texera's look: the realm's
  login theme `texera` (`bin/texera-2-0/keycloak/themes/texera`) is Keycloak's own `keycloak.v2`
  with the app's page, card, colours and logo, mounted from a config map on Kubernetes. Services use client credentials
  (`texera-services` is the platform's own). A token must carry the audience `texera`.

## 8. Testing and deploying

```
bin/texera-2-0/test.sh unit        # no stack: the catalog, the engine, the runtime, the frontend
bin/texera-2-0/test.sh contract    # the adapters and the engine against the stack's peers
bin/texera-2-0/test.sh scenario    # the end-to-end scenarios (pytest, tests/e2e), one module per use case
bin/texera-2-0/test.sh ui          # Playwright against the stack, no model
bin/texera-2-0/test.sh evals       # the real agents through the real model
bin/texera-2-0/test.sh gate        # a wiped stack, then everything
bin/texera-2-0/k8s.sh up           # the stack on a local kind cluster at http://localhost:28088
bin/texera-2-0/k8s.sh check        # the scenarios and Playwright against the cluster, plus a unit made as a resource
```

`docs/texera-2-0/TESTING.md` explains the layers, what each scenario proves, the fixtures and
how to add one. On the cluster, units are resources: create one from `/computing-units` with
`provider: kubernetes` and it becomes a Deployment the catalog reconciles; a changed spec
rolls it; `terminate` removes it. Details, the images and the manifests:
`bin/texera-2-0/README.md`, `bin/dockerfiles/`, `deploy/kubernetes/`.

## 9. When something does not work

- **The agents do not answer.** No model key: put `ANTHROPIC_API_KEY` in `.env` and run
  `up.sh` again (the key is loaded into the secret store; the runtime leases it per turn).
- **A port is held.** `up.sh` refuses to start a service on a port another process holds and
  names it; another worktree of this repository must be stopped with its own `down.sh`.
- **401 from the gateway.** The token is missing, expired or for another issuer; a realm
  change (`bin/texera-2-0/keycloak/texera-realm.json`) needs `down.sh --wipe`, Keycloak
  imports a realm once.
- **403** on a change to Texera or to what it holds, for someone who is not one of its admins;
  on a project's settings or base, for a member who is not its admin; on a base one does not
  administer.
- **409.** A delete of something still referenced or still holding children, or of a project
  others inherit from (the response lists them); Texera made private or deleted (`root`); a
  public project inheriting from a private one (`private_base`); an execution on a unit that already runs one of this
  workflow; a unit with an execution on it being changed.
- **410** on an execution's rows: its results expired under the retention policy; keep the
  ones you need.
- **403** where you expected to be allowed: viewing never implies using; ask for `user` on the
  unit, credential or model endpoint, or `editor` to write.
- **An execution failed.** Its page and `get_execution` give the reason: an operator's own
  exception (a Python operator that raises fails it, with its traceback, instead of waiting), a
  compile error per operator, or what the engine refused.
- **"Not saved" on a workflow.** The catalog did not take the workflow as a version, and the
  banner says why: a file property that names a file that does not exist, or the catalog being
  away. The edits stay in the session and are saved once the cause is gone.
- **"The workflow's live session cannot be reached."** The live service is down or the
  gateway does not route `/live/`: `logs/texera-2-0/live.log`, or `kubectl -n texera2 logs
  deploy/live`. The workflow is shown as it was last saved and cannot be edited meanwhile; the
  people icons at the top right are missing for the same reason.
- **A conflict (409, `head is N, expected M`) on `edit_workflow`.** Someone changed the
  workflow after you read it: read it again and redo the edit on that head.
- **The unit is not ready.** `logs/texera-2-0/unit.log`; the engine compiles with sbt on the
  first start and the catalog shows the unit as pending until its health answers.
- **Playwright has no browser.** `cd frontend-next && bunx playwright install chromium`, or
  `TEXERA_E2E_BROWSER_CHANNEL=chrome` for an installed Chrome.

## 10. Where to read more

| Document | What it holds |
| --- | --- |
| `bin/texera-2-0/README.md` | the dev stack: prerequisites, ports, the lake, Kubernetes |
| `docs/texera-2-0/TESTING.md` | the test layers, the scenario catalog, the rules, adding a scenario |
| `docs/texera-2-0/API-REQUESTS.md` | the conventions between the parts beyond the contract, including how an execution works |
| `docs/texera-2-0/PLAN.md`, `PROGRESS.md` | the milestone with its decisions and acceptance list; what was done, verified and comes next |
| `docs/texera-2-0/claude-docs/handoff.md` | where things stand, the gotchas, the next steps |
| `catalog/README.md`, `agent-runtime/README.md`, `live/README.md`, `frontend-next/README.md` | each part's run instructions, layout and rules |
| `api/catalog/*.tsp` | the contract: every kind, route, permission and MCP tool |
| `AGENTS.md` | the map of the repository and the rules for working in it |
