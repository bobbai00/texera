# Step 4: reach the engine only through Envoy

**Draft, research notes; not a design yet.** 2026-11-17. Step 4 will not be built now (work stops
after step 3), so this file only keeps what was learned while preparing its design: what reaches
a unit today (§1), the corrections to the tracker's sketch (§2), the choices I consider settled
(§3), the open questions and what to read or try next (§4). No implementation briefs. Nothing
here was reviewed.

Repo paths are relative to `/Users/jiadongb/Desktop/projects/texera-worktrees/sce-step2-lane`
(branch `feat/sce-step2-lane`) at `bc96c2b7b`: step 2, upstream `021bf51c1`, fix batch X3. Not in
that tree: batches X1, P, C, X4 and all of step 3. Line numbers are from that commit.

- † marks a fact taken from a helper agent's reading pass at that commit and not re-read by me.
  The line numbers I spot-checked in the same files matched.
- "(proof)" is `sce-step0-proofs/proofs/step0/envoy-route/RESULTS.md`. "(docs)" is the Envoy 1.36
  or Envoy Gateway 1.6 API reference, read 2026-11-17. "(validated)" is `envoy --mode validate`
  on `envoyproxy/envoy:distroless-v1.36.4`, run for this file. Nothing else was run.
- Short names: `WEB/` = `amber/src/main/scala/org/apache/texera/web/`; `FE/` =
  `frontend/src/app/`; `MR` =
  `computing-unit-managing-service/src/main/scala/org/apache/texera/service/resource/ComputingUnitManagingResource.scala`;
  `KC` = `…/service/util/KubernetesClient.scala`; `ACR` =
  `access-control-service/src/main/scala/org/apache/texera/service/resource/AccessControlResource.scala`;
  `GW/` = `bin/k8s/templates/base/gateway/`.

## 1. What reaches a unit today, and what each path checks

### 1.1 The unit's doors

| Door | Caller | What the unit checks |
|---|---|---|
| websocket `/wsapi/workflow-websocket?wid&uid&cuid&access-token` (`WEB/resource/WorkflowWebsocketResource.scala:51-54`) | the browser | Handshake (`WEB/ServletAwareConfigurator.scala`): if all four `x-user-*` headers are present, user and unit privilege are taken from them, with no token (`:50-76`); otherwise the JWT in `access-token` is verified and the session is given WRITE (`:79-99`); a failure is only logged (`:101-104`). Open: `wid` and `cuid` are read from the query and checked against nothing (`:61-62` of the resource); the session is sent "Uninitialized" (`:76`), subscribed to the workflow's service (`:77-79`) and sent `ClusterStatusUpdateEvent` (`:80`). Per frame (`:132-166`): a heartbeat and a result page are open to every session; everything else needs WRITE on the socket's unit (`:152-153`); a start goes to `startStoredExecution` (`:177-209`); a stored change is its execution's creator's (`:219-232`); any other command goes to the run the workflow's service holds (`:158-164`) |
| `POST /api/execution/{eid}/run` (`WEB/resource/SyncExecutionResource.scala:152-158`) | agent-service | the Jersey JWT filter and `@RolesAllowed` (`WEB/ComputingUnitMaster.scala:161-168`); the start checks below, with the unit id taken from the body (`:163-174`). No check of WRITE on the unit (review finding E6) |
| `GET /api/execution/health` (`:862-864`) | the harness only | nothing |
| `/api/executions/*`, ten routes (`WEB/ComputingUnitMaster.scala:199`) | the Kubernetes gateway, for statistics and export | their own; step 3's sub-part 16 removes them from the unit |
| TCP 2552, the actor system | the unit itself | listens on `localhost` outside cluster mode (`amber/src/main/scala/org/apache/texera/amber/engine/common/AmberRuntime.scala:89-99`); Python worker channels too (`…/pythonworker/PythonProxyServer.scala:173`, `PythonProxyClient.scala:63`) |

Start checks (`WEB/service/WorkflowService.scala:102-124`, `WEB/service/execution/StoredExecutionStart.scala`):
a user; the URI is the plan table of that execution, of the socket's workflow, in the default
warehouse or one of the user's own (`:70-101`; own warehouse `:83-84`); the row is a plan in this
unit's format, `createdBy` is the user (`:136-137`), `computingUnitId` equals the unit id **the
request supplied** (`:138-142`), ids match the location, no input link expired (`:144-160`). Then
claim, supersede, build under the run lock (`WorkflowService.scala:354-378`, `:233-259`, `:406-454`).

Command handlers: pause `WEB/service/ExecutionRuntimeService.scala:79-84`, resume `:87-99`, kill
`:102-119`, checkpoint `:122-133` (an `assert` on the replay-log setting), skip `:60-62` (throws),
retry `WEB/service/ExecutionConsoleService.scala:359-361` (empty), evaluate `:364-389`, debug
`:392-407` (echoed to the console as `"USER-" + uid`, `:398`). What a handler throws goes to the
run's error handler and the run is recorded FAILED (`WEB/WebsocketInput.scala:36-43`,
`WorkflowService.scala:461-493`).

How a session catches up and is counted: every store replays the difference from its empty state
to a new subscriber (`WEB/storage/StateStore.scala:37-46`; `WEB/SessionState.scala:75-85`;
`WorkflowService.scala:261-286`). Sessions are counted per workflow; a run that is not RUNNING and
has no session for 30 s is let go and its engine shut down
(`WEB/WorkflowLifecycleManager.scala:39-49`, `:63-91`; `WorkflowService.scala:214-220`;
`common/config/src/main/resources/application.conf:85-86`). A run started by the agent has no
session, so the rule applies to it from READY on (read, not run).

Results on the socket: a page request is answered by the unit reading the lake
(`WEB/service/ExecutionResultService.scala:414-469`); a result update carries a count and dirty
pages for a table (`:192-196`), all rows for a snapshot (`:197-198`), new rows for a delta
(`:199-201`), and table statistics (`:381-390`); counts are polled from the tables (`:289-300`,
`:472-519`).

Registries: requests `WEB/model/websocket/request/TexeraWebSocketRequest.scala:29-81`, events
`WEB/model/websocket/event/TexeraWebSocketEvent.scala:29-43` (not registered there but sent:
`ClusterStatusUpdateEvent`, `RegionUpdateEvent`, `RegionStateEvent`,
`ExecutionDurationUpdateEvent`).

The unit's server: Dropwizard 1.3.23, Jersey 2.25.1 (`amber/build.sbt:104`, `:158`), so no JAX-RS
SSE API, but Jersey's `ChunkedOutput`; gzip is on by default in that Dropwizard. Port 8085, no
admin connector, no bind host (`amber/src/main/resources/computing-unit-master-config.yml:18-31`);
Jersey at `/api/*` (`ComputingUnitMaster.scala:147`); a request log line with peer address,
method, URI without query and status already exists (`:204-226`). The Dashboard is the same sbt
module and Dropwizard, with an admin connector on 8081 (`amber/src/main/resources/web-config.yml:22-27`).
access-control-service is Dropwizard 4.0.7.

### 1.2 How each mode routes to a unit

| Mode | Websocket | Check on the way |
|---|---|---|
| Kubernetes | HTTPRoute `<release>-dynamic-routes`: prefix `/wsapi`, a statistics regex, the export prefix, Jupyter's path, to a `DynamicResolver` Backend (`GW/gateway-routes.yaml:171-204`, `GW/gateway-backend.yaml`). The route names the backend `texera-dynamic-backend` literally (`:204`); the Backend is named after the release | SecurityPolicy `extAuth` to access-control-service, path `/api/auth`, `headersToBackend` the four `x-user-*` and `Host` (`GW/gateway-security-policy.yaml:24-39`†). Not set: `failOpen`, `headersToExtAuth`, a timeout, early removal of client headers, removal of `Authorization` |
| Single-node | nginx `location /wsapi/` to `workflow-runtime-coordinator-service:8085` (`bin/single-node/nginx.conf:141-147`) | none |
| Local dev | the Angular dev proxy, `/wsapi` to `localhost:8085`, `ws: true` (`frontend/proxy.config.json:83-88`†) | none |

The agent service goes straight to the unit in every mode: `EXECUTION_ENDPOINT_TEMPLATE` =
`http://computing-unit-{cuid}.<pool>-svc.<pool namespace>.svc.cluster.local:8085`
(`bin/k8s/templates/base/agent-service/agent-service-deployment.yaml:60-61`†),
`WORKFLOW_EXECUTION_SERVICE_ENDPOINT` (`bin/single-node/.env:124`†, `bin/local-dev/main.sh:710`;
`agent-service/src/config/env.ts:34-35`).

What access-control-service answers (`ACR`): it handles the websocket path, statistics and export
(`:46-48`, `:79-80`) and Jupyter (`:78`, `:97-120`). For a unit (`:122-203`) it takes the token
from the query, the `Authorization` header or the body (`:138-147`), `cuid` from the query
(`:149-156`), refuses only privilege NONE (`:166-168`), and answers 200 with the four `x-user-*`
headers and `Host` = the unit row's `uri` (`:184-203`). It logs every header and the token at
INFO (`:135`, `:148`, `:282`). It answers GET, POST, PUT, DELETE only (`:266-304`). Its path
`/api/auth` is not reachable from outside: the static route sends only `/api/models` and
`/api/chat` to it, and the Dashboard has its own `/api/auth`.

Envoy Gateway is the subchart `gateway-helm` 1.6.3 (`bin/k8s/Chart.yaml:58-61`†), with
`enableBackend` and `enableEnvoyPatchPolicy` (`bin/k8s/values.yaml:649-654`†). The chart has no
`EnvoyProxy` and no `ClientTrafficPolicy`. Envoy's pods run in the **release's namespace** with
labels `gateway.envoyproxy.io/owning-gateway-name=<release>-gateway`,
`gateway.envoyproxy.io/owning-gateway-namespace=<ns>`, `app.kubernetes.io/name=envoy`,
`app.kubernetes.io/component=proxy`; the Service is `envoy-<ns>-<gateway>-<hash>`, LoadBalancer
(`sce-e2e/reports/k8s-20261117T100820Z-logs/sce-k8s-get-all.txt`, `…-describe-pods.txt`). When
notebooks are on, a policy on the whole dynamic route closes idle upstream connections after 30 s
(`GW/gateway-jupyter-traffic-policy.yaml:33-39`†). The `/api` and `/` catch-all goes to the
webserver (`GW/gateway-routes.yaml:160-169`); the create has its own 120 s rule (`:149-159`).

### 1.3 Who can open a connection to a unit's port

| Mode | Today |
|---|---|
| Kubernetes | one NetworkPolicy in the unit namespace admits every namespace but the unit namespace itself, on every port (`GW/workflow-computing-units-network-policy.yaml:23-34`). The only others in the chart are Jupyter's and the Postgres subchart's† |
| Single-node | one network, `texera-single-node`, for every container (`bin/single-node/docker-compose.yml:842-844`†). The unit publishes no port; published are RustFS 9000, Jupyter 9100, nginx 8080† |
| Local dev | the unit is a host JVM on every interface |

### 1.4 How a unit is created, addressed and recorded

- Table `workflow_computing_unit`: `uri TEXT NOT NULL DEFAULT ''`, `type` `local` or
  `kubernetes`, `terminate_time` (`sql/texera_ddl.sql:246-258`†, `:100`†);
  `computing_unit_user_access` (`:688-696`†). Highest migration is 52; step 3 takes 53 and 54.
- `POST /api/computing-unit/create` (`MR:582-589`). Which types exist is a deployment switch, not
  a role (`MR:528-535`; `common/config/src/main/resources/computing-unit.conf:20-23`: local on by
  default; `bin/k8s/values.yaml:482-485`†: local off, Kubernetes on).
- Local: the address is required and checked for nothing (`MR:663-664`), stored as typed
  (`MR:743`). The form pre-fills the page's origin plus `/wsapi`
  (`FE/common/util/computing-unit.util.ts:369-371`†). Nothing outside Kubernetes dials it. Status
  is always Running (`…/service/util/ComputingUnitHelpers.scala:90-91`†); terminate only stamps
  the row (`MR:971-978`†).
- Kubernetes: `uri = KubernetesClient.generatePodURI(cuid)` (`MR:763`), no scheme:
  `<prefix>-<cuid>.<service>.<namespace>.svc.cluster.local:8085` (`KC:50-54`), resolvable through
  the pod's hostname and subdomain (`KC:307-308`) and a headless Service†. Labels
  `type=computing-unit`, `cuid`, `name` (`KC:207-209`). No probe and no service account are set
  (`KC:203-310`†).
- The pod's environment is literals in the pod spec. Required: `AUTH_JWT_SECRET` (`MR:335-339`).
  Per unit: `USER_JWT_TOKEN`, a token of the unit's creator (`MR:734`, `:782`). Also the JDBC and
  S3 logins (`MR:434-448`†) and an optional list (`MR:350-356`). The manager's Role has no rule
  for `secrets`†.
- The manager never connects to a unit: Kubernetes API only†. The Dashboard never does either,
  and never reads `uri`†.
- A unit's whole row, `uri` included, is sent to browsers (`MR:484-495`†);
  `GET /api/computing-unit/{cuid}` gives it to any signed-in user (`MR:908-939`).
- Access: `ComputingUnitAccess.getComputingUnitAccess`
  (`common/auth/src/main/scala/org/apache/texera/auth/util/ComputingUnitAccess.scala:34-54`); the
  owner has WRITE; no admin override; it ignores the sharing switch and `terminate_time`†.
- At create the Dashboard checks WRITE on the unit and that it is not terminated
  (`WEB/service/execution/ExecutionCreator.scala:457-476`†) and writes `createdBy` and
  `computingUnitId` into the plan row (`:288-289`†).
- What a unit is told about itself: `TEXERA_CU_ID` only with mounting on
  (`common/workflow-core/src/main/scala/org/apache/texera/amber/core/storage/RepositoryMountManager.scala:103-117`†);
  `USER_JWT_TOKEN` (`:106`; `amber/src/main/python/pytexera/storage/dataset_file_document.py:91`);
  the signing secret, through `common/config/src/main/resources/auth.conf:25-26`, which has a
  literal default that single-node relies on (`bin/single-node/.env` sets none).
- Who reads the signing secret on a unit: `ServletAwareConfigurator.scala:90`,
  `WEB/auth/JwtAuth.scala:31-43`, `WEB/service/ResultExportService.scala:534` (step 3 moves
  export). After step 3 and this step: nobody.

### 1.5 What the browser does with the socket

- URL, token, heartbeat, reconnect (read): same origin; the token from
  `localStorage["access_token"]` in the query; a heartbeat every 10 s; redial every 3 s, without
  limit, with the URL built at open (`FE/workspace/service/workflow-websocket/workflow-websocket.service.ts:48-49`,
  `:65-68`, `:119-126`, `:131-162`). "Connected" means an event has arrived†. HTTP requests get
  `Authorization` from `JwtModule` (`FE/app.module.ts:203-210`†); a 401 signs the user out
  (`FE/common/service/unauthorized-http-interceptor.service.ts:59-89`†). There is no login cookie†.
- Opened when a unit is selected, reopened with a reset of the page's run state when the pair
  (unit, workflow) changes (`FE/common/service/computing-unit/computing-unit-status/computing-unit-status.service.ts:185-207`†).
  The page polls `GET api/computing-unit/{cuid}` every 2 s (`:110-126`†).
- Run (`FE/workspace/service/execute-workflow/execute-workflow.service.ts:367-429`†):
  `POST api/executions` answers `{eid, planUri}`
  (`WEB/model/http/response/execution/CreateExecutionResponse.scala`), then `WorkflowStartRequest`
  on the socket. Pause, resume, kill, checkpoint, skip, retry `:469-522`†; a change to a paused
  operator `:530-548`†. The page's execution id comes only from state events (`:157`, `:227`†).
  Lost unit (#8936) `:194-206`†.
- Results (`FE/workspace/service/workflow-result/workflow-result.service.ts`†): page requests
  `:322-385`, matched by a request id with no timeout `:346-424`; a snapshot replaces the held
  rows and a delta is ignored `:255-262`; the page cache is never filled. Callers: the result
  table (`…/result-table-frame.component.ts:482-510`), the result modal, the operator preview,
  the report generator. Column statistics from the update, `result-table-frame.component.ts:242-259`.
- Console†: debug commands from `…/console-frame/console-frame.component.ts:271-289` and
  `FE/workspace/service/operator-debug/udf-debug.service.ts:89-148`; Skip and Retry `:313-327` of
  the console frame; a message's `source` is shown (`console-frame.component.html:209-213`);
  `PythonExpressionEvaluateRequest` has no sender.
- Other consumers†: cluster status is "Number of Machines" (`menu.component.html:522`); "Connecting"
  on Run (`menu.component.ts:485-492`); Run, Pause and Resume need WRITE on the unit
  (`menu.component.html:471`), Kill, Checkpoint, Skip, Retry and debug do not (X4 changes some).
- The admin page opens a socket with a workflow and no unit and sends kill, pause or resume
  (`FE/dashboard/component/admin/execution/admin-execution.component.ts:304-337`†); the unit's
  open handler reads `cuid` unconditionally, so this cannot work (not run).
- Kubernetes only: statistics and export go to the unit with `?cuid=`; local export posts the
  token as a form field (`FE/dashboard/service/user/download/download.service.ts:240-272`†).
  Step 3 moves both.
- Other browser connections, none to a unit†: `/rtc` (shared editing), `/python-language-server`
  (own Deployment), `/api/agents/:id/react`.
- `GET /api/executions/{wid}/latest` (`WEB/resource/dashboard/user/workflow/WorkflowExecutionsResource.scala:554-603`):
  the workflow's newest execution, anybody's, for whoever can see the workflow; 403 "Executions
  doesn't exist" when there is none.

### 1.6 The agent service

`executeWorkflowHttp` (`agent-service/src/agent/tools/workflow-execution-tools.ts:268-371`):
create at the Dashboard, then `POST <unit>/api/execution/{eid}/run` with the user's token and
`{planUri, computingUnitId, targetOperatorIds, timeoutSeconds, maxOperatorResultCharLimit,
maxOperatorResultCellCharLimit}`. Always one target†. The unit enforces the timeout (default
240 s†), kills on an operator's console error, and ends the run early as Completed once the
target completed (`SyncExecutionResource.scala:256-266`, `:301-311`, `:322-336`); it cuts the
target's rows to two character budgets (`:513-698`). A stop of the agent sends nothing to the
unit†. The agent service checks its own callers only on `POST /api/agents`† (upstream #9043).

### 1.7 Deployment files

- nginx only proxies: 14 locations, no static files (`nginx.conf:30-150`†); `/api/agents` with
  upgrade and one-day timeouts (`:104-112`†); the create with `client_max_body_size 1m` and 120 s
  (`:126-132`); uploads unlimited†; everything else nginx's default megabyte (commit `e58cf6e81`).
- Compose: the unit `docker-compose.yml:406-420`; the Dashboard and the agent `depends_on` the
  unit (`:427-429`, `:478-484`); nginx `:541-557`; `.env:121`† points the agent's LLM calls at
  nginx; access-control-service is part of single-node and of local dev.
- Local dev: every JVM on the host; infrastructure from the single-node compose file plus
  `bin/local-dev/docker-compose.override.yml`, which publishes 5432, 8000, 8181, 4000†. Ports in
  use: 4200, 8080, 8081, 8085, 8888, 9090–9098, 3001, 1234. Every service but the unit has a
  health path, `/api/healthcheck` (`bin/local-dev/main.sh:915-990`).
- Kubernetes: ExternalName services let a unit reach the file, config and Dashboard services,
  Postgres, RustFS and Lakekeeper (`bin/k8s/templates/base/external-names/external-names.yaml:45-93`†).
- The release tarball lists `nginx.conf` (`.github/scripts/create-release-tarballs.sh:121`).
- Login tokens in logs today: 19 lines of Envoy's log and 38 of access-control-service's in
  `sce-e2e/reports/k8s-20261117T100820Z-logs/`; none in the unit's†.

## 2. Corrections to the tracker's sketch

C1. **"The browser opens a websocket straight to the unit" is true of no mode as written.**
Kubernetes passes Envoy and a check; single-node passes nginx, which checks nothing; local dev the
dev proxy (§1.2). True in all three: the login token is in the URL and reaches the unit. What
connects straight to a unit, everywhere, is the agent service.

C2. **The websocket is not the only door**, and the port is open to more than the front door
(§1.1, §1.3). In Kubernetes any pod that can connect can name any user through the `x-user-*`
headers.

C3. **"Only starting a run checks write access" was true before step 2.** Now everything but a
heartbeat and a result page needs WRITE on the unit. What nobody checks is the workflow: `wid` is
a free parameter, so whoever may use a unit can watch any workflow's run on it and read its
pages; with WRITE, pause or kill it. In single-node every signed-in user has WRITE. So the check
must name an execution (S1, S9).

C4. **Today's answerer is access-control-service, not the Dashboard.** And an endpoint whose
answer carries a unit's key must not be reachable from outside; the Dashboard is where every
unclaimed `/api` path goes (S11; Q1).

C5. **"Swaps the login token for the key" cannot be done for a websocket.** Its token is in the
URL, and Envoy cannot remove a query parameter after an HTTP check (proof, "What did not work", 3).
The proof's way out was a cookie. With commands as requests the stream only flows down, so it can
be a GET read with `fetch`, with the login in `Authorization` (S3).

C6. **"Start, watch, commands and health" leaves out result pages**, which travel on the socket
both ways, rows included (S7; Q2).

C7. **"The current state first" is how every store already replays** (§1.1). What a stream needs
and a socket never had is an end (S5).

C8. **Three request types do nothing or harm**: retry is empty, skip fails the run, evaluate has
no sender; a checkpoint without a replay log fails the run too (S6).

C9. **"One check, the key" needs an exception**: health, which whoever starts a unit asks without
a key. Today only the harness asks; the product has no probe in any mode (S12).

C10. **Five uses of the user's identity on the unit must go somewhere**: creator of the
execution, own warehouse, the unit id from the request, creator of a stored change, the console
label (§1.1; S9, S10, S13).

C11. **A local unit's typed address is dialled by nothing outside Kubernetes, and would steer the
gateway there** (§1.4): once every mode routes by the answer, a typed address lets a user aim the
gateway at any host it reaches (S16; Q4).

C12. **Replacing nginx changes defaults**: nginx's megabyte and 60 s between reads go; Envoy ends
any answer after 15 s unless told otherwise and has no body limit. In local dev the dev server
stays in front, since it serves the page (S17).

C13. **In Kubernetes the unit's route shares its HTTPRoute, its SecurityPolicy and an idle
policy with Jupyter**, and misnames its backend (§1.2; S18).

C14. **"No login token reaches one" can hold for requests only.** A Kubernetes unit is started
with the signing secret and its creator's token (§1.4). The secret can stop being sent in this
step; the token is used for calls the unit makes (mounts, UDF dataset reads) and is step 5's.

C15. **The agent's run has two things only the unit does**: the early end and the timeout (S8).

C16. **A unit keeps a finished run for its viewers and counts them by socket**, because only it
can page results (§1.1; S5).

C17. **The admin page's pause, resume and kill cannot work today** (§1.5; S9).

C18. **Login tokens are in the gateway's and access-control-service's logs today** (§1.7). Not a
unit, so not the done-when, but whatever answers the check must not log header values.

## 3. Choices I consider settled, and why

"Settled" means I would not reopen them without a new fact. The owner has seen none of them.
Those that rest on an owner's call point to §4.

| # | Choice | Why |
|---|---|---|
| S1 | Every request to a unit names an execution: `/api/engine/executions/{eid}/{start, watch, pause, resume, kill, checkpoint, debug, updates/{id}/apply}`. The client's path and the unit's are the same; the gateway changes only the host. No route names a unit or a workflow | C3. The unit is found from the execution's row, so the check can be about the execution, and a client cannot ask one unit about another's run. One prefix, which collides with no Dashboard route (`/api/executions/…` are records) |
| S2 | A command is a request with an answer: 202, or a status with `{code, message}`. A refusal changes nothing in the run | The tracker. It ends two faults of the socket: a refusal shown as a failed run (review finding D3; X4's `RequestRefusedEvent` becomes the HTTP answer) and a handler's exception recorded as the run's failure (C8) |
| S3 | The watch is a GET answered with a stream of lines (`application/x-ndjson`, one JSON event per line), read by the browser with `fetch`. Not a websocket | C5. The login is in one header in every request, and one route rule removes it. No cookie, no ticket, no upgrade on a unit's route. Jersey 2.25's `ChunkedOutput` can write it. Cost: Q5 |
| S4 | The lines are today's events with today's JSON. A watch starts with the stores' replay, then changes. No "Uninitialized". A blank line every 15 s. Each watcher has its own bounded queue and writer; one that does not read is dropped | C7: the replay exists and is race-free, and the browser's handlers stay. A late and a second watcher are the same case. The engine's threads must never wait for a client. The blank line keeps idle timeouts away (plain Envoy: 5 min) |
| S5 | A watch ends when the execution's record is complete: a last line (`ExecutionRecordedEvent`), sent after step 3's recorder is idle. The unit holds an execution from its start until then. The 30 s rule stays for a run that is neither running nor ended, counting watches | C16. A reader of stored output needs to know when everything is there; step 3 writes console and statistics after the ending's own commit. Holds only if pages leave the unit (S7) |
| S6 | Not carried over: retry, skip, evaluate, the heartbeat request. A checkpoint without a replay log is refused | C8 |
| S7 | The stream carries no rows: a result update says the mode and the committed count per operator. Rows are read as stored output at `/api/results/executions/{eid}/…`, in the shapes of upstream's result service (Appendix C) | C6; the owner's line between data and metadata. The socket's removal forces the panel's paging to be rewritten anyway; writing it against the final routes once beats writing it against the unit and again for #8996. Who serves the routes, and whether this belongs to the step: Q2 |
| S8 | Start takes one option, `stopAfter` (operators after whose completion the engine ends the run as Completed). A timeout is the client's: it sends kill | C15. The early end needs the engine's view of its ports and must not be a client naming an outcome; a timeout needs nothing the client lacks. Cost: if the agent service dies, its run goes on |
| S9 | Who may pass: start, the execution's creator with WRITE on its unit; watch, whoever may read the execution (step 3's rule: creator, or owner or grantee of the workflow); pause, resume, kill, checkpoint, debug, the creator or a reader with WRITE on the unit; applying a stored change, the creator; pause, resume, kill also an admin | Each is today's rule moved off the unit, or today's rule (WRITE on the unit) narrowed to people who can see the run. The admin rule makes C17 work. A policy, so worth one look by the owner (Q10) |
| S10 | An allowed check is answered with `Host` (the unit's address), the unit's key, and for a start the plan's location. The client names no storage location. Never 200 without `Host` | Proof: without `Host` Envoy routes by the client's own. It is also what the owner agreed on 2026-11-14 ("allowed, which unit, the unit's key, the namespace"); step 5 adds the run's lake credentials to the same answer |
| S11 | Whatever answers the check is not reachable through the gateway, reads Postgres only, caches nothing (three indexed reads per request; a watch is one request), and logs who, what and the verdict, never a header's value | C4, C18. Which service: Q1 |
| S12 | The unit's one check is the key, in a filter in front of everything but health: exactly one key header equal to its own, else 401. It also refuses a request carrying `Authorization`, `Cookie` or a query. Health is `GET /api/healthcheck`, a constant, no key. No code on the unit reads a login token; the unit is not given the signing secret; a unit without a key does not start | The owner's decision ("the engine knows nothing about people"). Refusing a login makes a gateway that forgets to strip it fail loudly. C9, C14 |
| S13 | The key is the unit's identity. The comparison of the plan's unit with a number from the request goes; the creator and warehouse checks move to the check | C10, review finding E6 |
| S14 | On engine routes the gateway removes `Authorization` and `Cookie` before the unit and a client's own key and plan headers before anything reads them. The check refuses any query string | Proof (`unit-sees-key-not-login`, `fake-unit-key-cannot-impersonate`, `login-in-url-refused`). No engine route takes a parameter |
| S15 | Keys are not stored. A unit that something creates gets `HMAC-SHA256(deployment secret, cuid)`, which the creator puts in its environment and the answerer computes again; a local unit's key is a deployment setting. A unit's key changes with the unit | A key column would be in the row that is sent whole to browsers (§1.4). No table, no migration, nothing secret in Postgres; a launcher for Slurm or EC2 does the same. To confirm: Q9 |
| S16 | A unit's address is a DNS name and a port: the row's `uri` for a created unit, as today. Nothing in the path asks Kubernetes | Already true of the Kubernetes check (`ACR:184-202`). The local unit: Q4 |
| S17 | Envoy 1.36.4 in every mode. Engine routes: no limit on the watch, 60 s on the rest; the check has 5 s and fails closed; every other route states its limit; no body limit at the gateway. The check's headers are named in `ExtAuthz.allowed_headers`; the filter is off for the listener and on for the engine routes; no route recomputing (Appendix A) | C12; proof. Single-node and local dev can share one file (same service ports in both). Replacing nginx: Q3 |
| S18 | Kubernetes: a route and a policy of the engine's own, early removal of the two headers, and a NetworkPolicy that admits only the gateway's pods (by the labels of §1.2) to port 8085. Single-node: the unit on a network of its own with the gateway, Lakekeeper and RustFS. Local dev: only the key | C13. Compose has no rule about direction, and a host process cannot be fenced: say so, and prove what holds (Appendix B). The step must not claim "only Envoy can connect" for local dev |
| S19 | The browser follows one execution: its own create, else the workflow's newest from the record (`/latest`, at load and every 5 s while idle and visible). Create, start, watch. When a watch cannot be opened it asks step 3's `/state` (D37) | A reload, a second tab and a collaborator find the run where it is written. Cost: a run started elsewhere shows up within 5 s, not at once |
| S20 | The agent service uses the same routes: create, start with `stopAfter`, watch, kill on a console error, on its timeout and on a stop, rows from stored output | C15; one interface |
| S21 | Goes: the websocket and its handshake, sessions, the sync run, the JWT filter on the unit; `planUri` in the create's answer; access-control-service's unit rule and the `x-user-*` headers; `AUTH_JWT_SECRET` for units; the agent's two unit addresses | The done-when, by removal |

Left out on purpose: ending an open watch when access is taken away (a watch ends with its
execution; commands are checked each time); a gateway route for a unit's health; TLS between
gateway and unit; what a unit may connect to (step 5); cluster mode.

A workable order, each step leaving the product working (a sketch, not sized or reviewed): keys
for units; engine routes on the unit beside the old doors; the watch; the check's answerer;
result routes; Envoy in single-node, in local dev, the chart's engine route; the page's results
over HTTP; the page on the engine routes; the local unit; the agent; then remove the old doors;
then close the network. Between the second and the removal a unit has two doors and clients move
one at a time.

## 4. Open questions, and what I would read or try next

Owner's calls:

- Q1. **Who answers the check.** My pick: the Dashboard, on its admin listener (8081), because
  the answer needs the plan's location now and step 5's lake credentials later, which only the
  service that created the execution has. The other: access-control-service, where the check is
  today; it is not behind the `/api` catch-all, and a Dashboard restart would not refuse
  commands, but it has no storage code (`build.sbt:149-150`: Auth, Config, DAO, Resource). Next:
  ask the owner; read how step 5 means to issue the run's lake token; try a servlet on
  Dropwizard 1.3's admin context (`environment.admin().addServlet`).
- Q2. **Do result pages leave the unit in this step, and who serves `/api/results`.** My pick:
  yes, served by the Dashboard in upstream's shapes until upstream's service is deployed. The
  cheapest alternative keeps pages on the unit as one more engine route; then rows stay on the
  stream, a unit must keep finished runs for viewers (S5 falls), and the panel is rewritten
  twice. Next: the owner's answer to step 3's open decision 3; ask #9356's author about the
  deployment PR and #8996; read #9356's `ResultResource` in full and step 3's final
  `ExecutionResultUris`.
- Q3. **Envoy replaces nginx in single-node** (an unconfirmed assumption of the plan page), or
  sits behind it for engine routes only (two proxies; nginx must not buffer the watch). Next:
  ask; try the file of Appendix A against a single-node stack: a dataset upload over 1 MB and
  over 5 minutes, the agent's websocket, an LLM chat that streams.
- Q4. **The local unit.** My pick: the deployment names it (address and key in settings) and a
  user types no address. The other keeps typed addresses and makes the gateway dial them: then
  admin-only and an allow-list. Next: ask; read what step 6 wants from a unit a user brings.

To find out:

- Q5. **The six-connection limit.** Over plain HTTP a browser gives a site six HTTP/1.1
  connections, across tabs; each open watch takes one (websockets do not count). Behind TLS
  (HTTP/2) there is none. Try: seven tabs with a `fetch` stream each through Envoy on
  `http://localhost`. If it bites: a websocket whose login rides in `Sec-WebSocket-Protocol`,
  rewritten by the check's answer; not tried.
- Q6. **Is a line delivered at once through every hop.** Suspects: Dropwizard's gzip on the unit
  (turn it off), the Angular dev server's compression (`Cache-Control: no-transform`), Jersey's
  flushing. Try: a 20-line resource returning `ChunkedOutput`, read with `curl -N` directly,
  through Envoy and through `ng serve`.
- Q7. **Does OrbStack's Kubernetes enforce NetworkPolicy.** Not known (the memory note and
  `sce-e2e/docs/map/deploy.json:262`† both say unchecked). Try: two pods and a deny-all policy on
  the approved cluster.
- Q8. **How the agent service names the gateway inside a cluster** whose gateway has a host name
  and TLS. Ideas: a ClusterIP Service over Envoy's pods plus the public name as `Host`; or the
  public URL. Check: whether Bun's `fetch` sends a caller-set `Host`; Envoy Gateway's container
  port for listener 80; `EnvoyProxy.envoyService.name` would give a stable name but renames the
  LoadBalancer Service on upgrade.
- Q9. **The key scheme** (S15): confirm derivation over a stored key; where the secret lives in
  the chart (`texeraEnvVars` hands every value to every service); what a rotation asks of
  deployers.
- Q10. **The rule for commands** (S9): is "creator, or a reader with WRITE on the unit" what the
  owner wants for collaborators; should an admin also watch.
- Q11. **Local dev on Linux.** Envoy in a container reaches host services through
  `host.docker.internal`, which on Linux needs `host-gateway` and services that listen on every
  interface (proof: not tested). Try on a Linux host.
- Q12. **`stopAfter`: an option of start, or part of the stored plan.** Batches P and C change
  the plan and where it is made. Read the plan's final format first.
- Q13. **What this rests on in step 3 and X4, once they exist**: `ExecutionRecords.mayRead`,
  `ended_at`, the recorder's `awaitIdle`, `GET /api/executions/{eid}/state` and `/console`;
  `RequestRefusedEvent` and the execution id on pause, resume and kill (seen uncommitted in
  `sce-step3-lane` on 2026-11-17). Re-read them as built.
- Q14. **Envoy Gateway settings the proof did not use**: `extAuth.timeout`, a regex match with
  `timeouts.request: "0s"` beside a prefix on the same backend, whether an upgrade can be turned
  off per route. Try with the proof's `run.sh k8s`.

## Appendix A. Envoy facts, and the configuration that validated

From the docs, beyond the proof:

- Envoy 1.36 `ext_authz`: `authorization_request.allowed_headers` is deprecated in favour of the
  filter's own `allowed_headers`. On a refusal every header of the answer but `Host` goes to the
  client unless `allowed_client_headers` is set; on success none does. `status_on_error` defaults
  to 403. The body is not sent to the check unless `with_request_body` is set. No cache of
  answers exists.
- Envoy Gateway 1.6: `extAuth.timeout` defaults to 10 s, `failOpen` to false; without
  `headersToBackend` no header of the answer reaches the request;
  `ClientTrafficPolicy.headers.earlyRequestHeaders`; `BackendTrafficPolicy.timeout.http` has
  `maxStreamDuration`; the client's stream idle timeout defaults to 5 minutes; proxies are
  deployed in the controller's namespace by default; `EnvoyProxy` can set pod labels and the
  Service's name.
- Envoy Gateway generates the filter `disabled: true` on the listener and turns it on per route
  with an empty `envoy.config.route.v3.FilterConfig`, and names the check's headers in the
  filter's `allowed_headers` (`sce-step0-proofs/proofs/step0/envoy-route/k8s/eg-generated-xds.json`).

Validated on Envoy 1.36.4: a single-node file with these pieces, and the same file with every
upstream host replaced by `host.docker.internal`. Envoy's YAML takes no merge keys (`<<`). The
nine service clusters are plain `STRICT_DNS` clusters and are left out here; the routes for
records are prefixes to them, each with `timeout: 0s`, the create with `120s`, `/api/agents` with
`idle_timeout: 86400s`.

```yaml
# inside the HttpConnectionManager
use_remote_address: true
normalize_path: true
merge_slashes: true
path_with_escaped_slashes_action: UNESCAPE_AND_REDIRECT
common_http_protocol_options: { headers_with_underscores_action: REJECT_REQUEST }
upgrade_configs: [{ upgrade_type: websocket }]            # for /api/agents; off on engine routes
access_log:                                               # the path without its query, no header
- name: envoy.access_loggers.stdout
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
    log_format:
      text_format_source:
        inline_string: "%START_TIME% %DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT% \"%REQ(:METHOD)% %PATH(NQ:ORIG)%\" %RESPONSE_CODE% %RESPONSE_CODE_DETAILS% %UPSTREAM_CLUSTER% %UPSTREAM_HOST% %DURATION%\n"
early_header_mutation_extensions:
- name: envoy.http.early_header_mutation.header_mutation
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.http.early_header_mutation.header_mutation.v3.HeaderMutation
    mutations: [{ remove: x-texera-unit-key }, { remove: x-texera-plan-uri }]
# routes, first match wins
- match: { safe_regex: { regex: "^/api/engine/executions/[0-9]+/watch$" } }
  route: { cluster: units, timeout: 0s, upgrade_configs: [{ upgrade_type: websocket, enabled: false }] }
  request_headers_to_remove: [authorization, cookie]
  typed_per_filter_config:
    envoy.filters.http.ext_authz: { "@type": type.googleapis.com/envoy.config.route.v3.FilterConfig, config: {} }
- match: { path_separated_prefix: "/api/engine" }
  route: { cluster: units, timeout: 60s, upgrade_configs: [{ upgrade_type: websocket, enabled: false }] }
  request_headers_to_remove: [authorization, cookie]
  typed_per_filter_config:
    envoy.filters.http.ext_authz: { "@type": type.googleapis.com/envoy.config.route.v3.FilterConfig, config: {} }
# http_filters
- name: envoy.filters.http.ext_authz
  disabled: true
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
    transport_api_version: V3
    failure_mode_allow: false
    status_on_error: { code: ServiceUnavailable }
    allowed_headers: { patterns: [{ exact: authorization, ignore_case: true }] }
    http_service:
      server_uri: { uri: "http://dashboard-service:8081", cluster: dashboard-gate, timeout: 5s }
      path_prefix: /gate
      authorization_response:
        allowed_upstream_headers:
          patterns:
          - { exact: host, ignore_case: true }
          - { exact: x-texera-unit-key, ignore_case: true }
          - { exact: x-texera-plan-uri, ignore_case: true }
- name: envoy.filters.http.dynamic_forward_proxy
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig
    dns_cache_config: { name: units, dns_lookup_family: V4_ONLY }
- name: envoy.filters.http.router
  typed_config: { "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router, suppress_envoy_headers: true }
# clusters
- name: units
  connect_timeout: 2s
  lb_policy: CLUSTER_PROVIDED
  cluster_type:
    name: envoy.clusters.dynamic_forward_proxy
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig
      dns_cache_config: { name: units, dns_lookup_family: V4_ONLY }
```

Validation checks the file's shape, not its behaviour. Whether a per-route `FilterConfig` turns a
disabled filter on is shown only by Envoy Gateway's own output in the proof.

Local dev, if Envoy runs in a container there: lakefs already takes host port 8000; 8090 is
free; Chrome refuses port 10080.

## Appendix B. Harness facts for later (`sce-e2e`, `main` at `14fe3ad`, branch `step3`)†

- Free letters: scenarios n, x, z; checks from L. `run-negative-control.sh` has no step option
  on `main`; step 3's uncommitted work adds one.
- Where the harness reaches a unit other than through the front door: scenario o, a `curl` to
  `localhost:8085/api/execution/{eid}/run` run where the unit runs (`driver/scenarios.py:1205-1210`);
  the compose healthcheck it adds (`stack/sce_stack.py:80-86`); local dev's probes
  (`stack/localdev/localdev_stack.py:1507-1520`).
- What breaks when the socket and the sync run go: all of `WebSocketRunHandle` and the open
  sequence keyed on `ClusterStatusUpdateEvent` (`driver/transport.py:271-726`, `:403-461`); the
  literal `create-ws` (`driver/e2e.py:58-66`); the refused starts l5, l6, l8, l9, l10
  (`driver/scenarios.py:880-912`, `:1012-1029`; l9, a socket for another unit, has no
  equivalent); o; m's raw checkpoint request (`:1153`); `ensure_stopped`
  (`driver/transport.py:512-534`); `wait_reachable` and the gateway probes
  (`driver/k8s_unit.py:217-282`; `stack/k8s/k8s_stack.py:105-109`, `:1128-1156`); the browser
  smoke's frame checks (`driver/browser_smoke.py:77`, `:933-949`, `:1294-1299`, `:1404-1408`);
  `driver/tests/fake_texera.py:605`, `:742-791`.
- If Envoy replaces nginx: `stack/sce_stack.py` requires `nginx.conf` (`:408`) with exactly one
  `access_log off;` (`:237-240`) and names the service `nginx` (`:87`, `:107`, `:854`); Check D
  parses nginx's log line (`driver/evidence.py:98`).
- `--isolate-unit` puts the unit alone on `sce-unit-net` with Postgres, Lakekeeper, RustFS, nginx
  and the agent on both (`stack/sce_stack.py:107`, `:519-522`). It limits what the unit reaches,
  not who reaches the unit.
- Reusable: `StackControl` (branch `step3`, `driver/stack_control.py:63-98`); Envoy's access
  records and `judge_refusal` (`stack/k8s/k8s_stack.py:1077-1125`); `gateway_relay.py`.
- Nothing today looks at traffic to the unit, at headers the unit received, or for tokens in
  logs.
- Evidence I would build for the done-when: (L) every connection the unit accepted came from the
  gateway: in single-node a `tcpdump` container in the unit's network namespace, elsewhere the
  peer address in the unit's request log; (M) the captured bytes hold none of the driver's tokens
  and nothing shaped like a JWT, and the unit's request log, extended to name each request's
  headers, names neither `Authorization` nor `Cookie`; (N) the unit serves nothing without its
  key; (O) a connection from every other container or pod fails, with "this cluster does not
  enforce NetworkPolicy" as a named failure; (P) no response and no log holds a unit's key.
  Negative controls on step 3's images: M must find the token in the websocket's request line,
  O's connections must succeed, a handshake with a token and no key must be answered 101. Local
  dev gets no O: only the key protects the unit there, and the report should say so.

## Appendix C. Upstream state on 2026-11-17 (`gh`)

- Result service, apache/texera#9356 (open; module and CI only; deployment "a second PR"; the
  panel's move is #8996, an open issue; #8995). Port 9102. Routes:
  `GET /api/results/workflows/{wid}/latest-execution`; `GET /api/results/executions/{eid}` →
  `[{operatorId, portIndex, outputMode, rowCount}]`;
  `GET /api/results/executions/{eid}/operators/{operatorId}/pages?port&pageIndex&pageSize&columnOffset&columnLimit&columnSearch`
  → `{table, schema, rowCount}`, `pageSize` at most 1,000, a visualization's row sent whole;
  `…/operators/{operatorId}/statistics?port`. Read rule: the execution's creator, or
  `WorkflowAccess.hasGrantedAccess`; else 403. It is Dropwizard 4 (jakarta), so its resource class
  cannot be registered in the Dashboard as it is.
- #9043 (open, updated 2026-11-17): the agent service's callers checked through
  access-control-service, with `auth_request` in `nginx.conf` and a SecurityPolicy in the chart.
- #9271, #9272 (open): per-port result metadata and updates; they touch
  `ExecutionResultService`, `WebResultUpdateEvent`, `workflow-result.service.ts`.
- #9175, #8446 (open): Envoy's 15 s route timeout on downloads, in `gateway-routes.yaml`.
- #8971 (open): a service mesh; adds an `EnvoyProxy` object.
- #9234 (open): `ComputingUnitAccess` ignores grants while sharing is off.
- #9445 (open): a trace span in `SyncExecutionResource`.
