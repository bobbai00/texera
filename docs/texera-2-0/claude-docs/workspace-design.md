# Texera as the Workspace for Agentic Collaborative Research

Nov 2, 2026 · @JB

Texera becomes the open, self-hosted workspace where scientists and AI agents work on governed data, with one catalog of resources, one access-control decision point and one lineage graph. The AI-scientist loop and agent governance became commodities in 2026; an open, governed, inspectable workspace did not. This document gives the target entity model, the catalog and access-control design, and the refactoring path from today's code.

## Target entity model

One envelope, Resource plus Version plus Principal plus grant, carries every kind of resource; the kinds differ only in what a version points at. The diagram keeps the conventions of `er-diagram-refactoring.drawio`: entities in blue, attributes in orange, relationships as diamonds, arrows toward the 1-side. Files: `texera-designs/er-diagram-target.drawio.xml` (open in draw.io), `er-diagram-target.png`, and `gen_er_diagram_target.py`, which regenerates the XML.

&#91;image: Target entity model\]

Six rules the diagram encodes:

- **Principal** generalizes User, Agent and Group. Grants and memberships are written against Principal, so an agent is granted a dataset the way a user is, and a group is a principal that has members.
- **Resource** generalizes thirteen kinds, Project among them. The envelope holds rid, kind, visibility and the parent project; kind-specific fields live in the kind's own table.
- **Version** is a weak entity of Resource. Its content reference is the only thing that differs per kind, and `derived from` edges between versions are the lineage graph.
- **grant**(Principal, Resource, relation) replaces the four `*_user_access` tables. Exactly one owner per resource; public is viewer granted to everyone; listability is a separate relation.
- **Project** is a Resource kind, not a second kind of principal set. A resource lives in exactly one project, projects nest, and a grant on a project applies to everything below it, which is how a team shares without per-user grants. There is no project membership relation: membership is a grant on the project.
- **Execution** records the actor and the principal it acted for, pins the version numbers of its workflow, environment, datasets and models, and produces one Port Result per operator output port, each an Iceberg table with its snapshot recorded.

New against the current diagram: Principal with Agent and Group, Project, the Resource and Version envelope, Macro, Environment, Credential, Agent Template, Skill, MCP Server with Tool, Operator as a versioned catalog entry with Operator Instance inside the workflow version, Conversation with Message, Warehouse and Port Result as products of execution, and `derived from`. An organization or a lab is a top-level project. Left out on purpose: Task and the sandbox relation between Agent Template and Environment, which the note covers.

**Chat versus agent.** They are different things and the model keeps them apart. An agent is a Principal: an identity with a sponsor, a template version and grants, and it outlives any chat. A conversation is a Resource: a thread of messages owned by the person who opened it, scoped to a project, and shareable, forkable and publishable like a dataset. Today's `TexeraAgent` class is both at once, one in-memory object per workflow holding the identity, the settings, the message tree and the user's token, which is why a chat is lost on restart, cannot be shared, and cannot hold two agents or two people.

- **Message** is a weak entity of Conversation: seq, author principal, on-behalf-of principal, parts (text, tool calls, tool results), created at. An execution is requested in a message, not in a conversation.
- **Participation is a grant.** Editor on a conversation may post, viewer may read; adding an agent to a chat means granting it editor. There is no participant table and no conversation type in the OpenFGA model.
- **A conversation version is a checkpoint** at a message seq. Opening a chat on a workflow writes a `derived from` edge from the workflow version to the first checkpoint, and every version an agent writes in a turn is derived from that turn's checkpoint. Context and provenance are lineage, so "chats about this workflow" is a lineage query rather than a new relation.
- **Share a template or a chat, never an agent instance.** A shared template gives each user their own agent, sponsored by that user with that user's memory. A shared chat has one agent instance for all participants, sponsored by the chat's owner, acting for whichever participant's turn it is under the intersection rule.
- **Protocol mapping:** conversation rid = A2A contextId, message = A2A Message, a long-running turn = A2A Task; tool calls inside a message are the MCP and OpenTelemetry GenAI spans.

**Group versus project.** The first draft duplicated one relation: project membership carried the same owner, editor and viewer values as a grant. The fix is to make Project a Resource kind. A grant on a project is then an ordinary grant that OpenFGA extends to everything the project contains, `project_member` disappears, and projects nest, so an organization or a lab is a top-level project and a public project publishes a whole study, the model scientists know from OSF. Group stays a Principal kind and nothing else: a named set of principals such as an identity-provider group, a core facility that supports several labs, or a fleet of agents, granted once instead of per member. Nested projects cover the single-lab case without groups, so the UI can defer groups until the identity provider lands. Migration: every user gets a home project, existing resources move into their owner's home project, and the rows of the four access tables become grants.

**Units, nodes and runtime requirements.** A Computing Unit is a cluster, not a pod: it has Nodes, each with a role {master, worker, sandbox}, a capacity, a runtime class and an image digest, which is what the engine's cluster mode already assumes. One Runtime Spec schema states what an operator type, an agent template or, by aggregation, a workflow version needs: runtime and version, environment, resources, isolation, placement. A node satisfies a Runtime Spec when its capacity covers it; the compiler places each operator instance on a worker node and each agent turn on a sandbox node, so an agent's sandboxing is a node of a unit rather than a separate concept. An agent records the agent that spawned it, and a template's sub-agent policy says which templates it may spawn.

**Agent orchestration.** Two forms, no new kind. The static form is a workflow whose operator instances bind agent templates: the built-in `agent` operator type is an A2A client, so a coordinator that hands work to two workers and waits for both is a four-node workflow the engine schedules, with fan-out, fan-in, loops and port-level lineage for free. A composite agent template names such a workflow as its body and is one agent to its callers. The dynamic form is an agent spawning sub-agents under its template's policy and reaching them through conversations or A2A tasks. Either way the tree is recorded on the agent principal: `spawned by` and, when it runs for an operator instance, `for (eid, opid)`.

| Kind | Version content | Storage engine | Protocol at the edge |
| --- | --- | --- | --- |
| Project | release manifest: the pinned versions of what it contains (optional) | Postgres | nesting, roles and public projects as in OSF; RO-Crate export of a release |
| Workflow | graph JSON, reverse deltas as today | Postgres | own OpenAPI; runs through a WES-shaped execution API |
| Macro | graph JSON with ports, expanded by the compiler | Postgres | same as Workflow; exportable as a GA4GH TRS tool |
| Dataset | lakeFS commit | lakeFS over S3 (RustFS or cloud) | S3 wire API, fsspec client, CSI mount |
| Model | lakeFS commit plus registry metadata | lakeFS; OCI ModelPack artifact for serving | VFS plus an MLflow-shaped registry API |
| Environment | pylock hash plus OCI artifact digest | OCI registry (Zot or Harbor), built by BuildKit | PEP 751 lockfile; Kubernetes image volume |
| Computing Unit | node list: role, capacity, runtime class and image digest per node | Kubernetes | Kubernetes API, RuntimeClass and DRA; the Agent Sandbox CRD for sandbox nodes |
| Warehouse and Table | Iceberg snapshot id per table | Lakekeeper over S3 | Iceberg REST catalog |
| Credential | OpenBao lease id | OpenBao | OpenBao API; secrets never in Postgres |
| Agent Template | JSON: A2A card, model, prompts, skills, MCP servers with tool allowlists, operator allowlist, requires (Runtime Spec), sub-agent policy, body (a workflow version, composite templates only), memory, budget, approval policy | Postgres | A2A Agent Card is a section of it; sub-agents and peers through conversations and A2A tasks; a composite template's body is a workflow of agent operator instances |
| Skill | folder commit (`SKILL.md`, scripts, references) | lakeFS | Agent Skills specification |
| MCP Server | `server.json` manifest | Postgres; packaged servers run in-cluster | MCP; MCP Registry API |
| Conversation | checkpoint at a message seq; messages are append-only rows (seq, author, parts) | Postgres | A2A contextId, Message and Task; OTel GenAI spans for tool calls |

Operator is a catalog entry rather than a Resource: versioned by image digest, with a JSON Schema spec and a Runtime Spec, pinned by the workflow and macro versions that use it. The built-in agent operator type is an A2A client whose instances bind an agent template; that is how agents enter workflows.

## Catalog layer: storage and API

The catalogs that matter all keep their metadata in a relational database, and the most recently designed ones use one generic entity table with a JSON column rather than a table per kind. Texera should do the same on the Postgres it already runs.

| Catalog | Store | Shape | Authorization data |
| --- | --- | --- | --- |
| [Apache Polaris 1.8](https://polaris.apache.org/releases/1.8.0/metastores/) | PostgreSQL via JDBC, recommended for production; in-memory default; MongoDB in beta | one `entities` table (id, parent\_id, type\_code, name, entity\_version, `properties` JSONB) plus `grant_records` (securable, grantee, privilege) | same database |
| [Apache Gravitino](https://github.com/apache/gravitino/blob/main/docs/how-to-use-relational-backend-storage.md) | H2 default; MySQL 5.7 and 8.0; PostgreSQL 12 to 16 | one table per entity type; versioned SQL scripts | own tables: users, groups, roles, owners |
| [Unity Catalog OSS](https://docs.unitycatalog.io/server/configuration/) | H2 default; PostgreSQL through Hibernate | one table per securable | own tables |
| [OpenMetadata](https://docs.open-metadata.org/latest/main-concepts/high-level-design) | MySQL or PostgreSQL plus Elasticsearch | one `<entity>_entity` table per kind holding a JSON document; all relationships in one `entity_relationship` graph table | policies as entities |
| [DataHub](https://docs.datahub.com/docs/architecture/metadata-serving) | MySQL, PostgreSQL or Cassandra as a document store; search and graph indexes fed by Kafka change logs | versioned aspects per entity URN; latest is version 0 | policies as aspects |
| Lakekeeper | PostgreSQL | tables per concept | OpenFGA, external |
| lakeFS | KV store on PostgreSQL, DynamoDB or CosmosDB; refs on object storage | key-value | Enterprise only |

**Texera catalog schema.** Keep Postgres, add the envelope, keep the kind tables as extensions keyed by `rid`:

```sql
principal(pid, kind {user, agent, group}, display_name, sponsor_pid, created_at)  -- sponsor manages an agent or a group
user(pid REFERENCES principal, email, role, ...)          -- today's user table, keyed by pid
agent(pid REFERENCES principal, template_rid, template_vno, spawned_by_pid, conversation_rid, eid, opid,
      lifetime {execution, conversation, pinned}, status)
                                                          -- eid, opid set when spawned for an agent operator instance;
                                                          -- conversation_rid when it serves a chat, as principal or team member
group_member(group_pid, member_pid)
resource(rid UUID, kind, name, parent_rid, visibility {private, public},
         created_by_pid, on_behalf_of_pid, created_at, deleted_at)
         -- parent_rid is the containing project; NULL only when kind = project (a top-level project)
resource_version(rid, vno, content_kind {json, lakefs_commit, oci_digest, bao_lease, checkpoint, manifest},
                 content_ref, created_by_pid, on_behalf_of_pid, created_at,
                 PRIMARY KEY (rid, vno))
version_edge(from_rid, from_vno, to_rid, to_vno, kind {derived, read, produced}, eid)   -- the roll-up
message(conversation_rid REFERENCES resource, seq, author_pid, on_behalf_of_pid,
        parts JSONB, created_at, PRIMARY KEY (conversation_rid, seq))   -- append-only
operator(type, image_digest, spec JSONB, requires JSONB, PRIMARY KEY (type, image_digest))   -- requires = Runtime Spec
operator_instance(workflow_rid, vno, opid, type, properties JSONB, binds_rid,
                  PRIMARY KEY (workflow_rid, vno, opid))   -- materialized from the version JSON; binds_rid = Agent Template, agent operator only
execution(eid, workflow_rid, workflow_vno, env_rid, env_vno, cu_rid, image_digest,
          actor_pid, on_behalf_of_pid, conversation_rid, message_seq, parameters JSONB, status, ...)
                                                          -- parameters: per-run inputs such as {conversation, turn}; the version stays as authored
execution_input(eid, rid, vno)                            -- datasets and models read, pinned
port_result(eid, opid, port, warehouse_rid, table_id, snapshot_id, tuple_count, bytes, hash,
            PRIMARY KEY (eid, opid, port))                 -- today's operator_port_executions + snapshot + hash
port_edge(eid, opid, port, from_eid, from_opid, from_port) -- consumes; from_eid <> eid when reused by hash
port_input(eid, opid, port, rid, vno)                     -- a source port and the dataset or model version it read
project(rid REFERENCES resource, default_env_rid, default_cu_rid, budget)   -- no project_member: membership is a grant
computing_unit(rid REFERENCES resource, kind {pool, provisioned, external}, cluster_credential_rid, image_digest)
node(cu_rid, name, role {master, worker, sandbox}, capacity JSONB, runtime_class, image_digest, status,
     PRIMARY KEY (cu_rid, name))                           -- a unit is a cluster; the engine's cluster mode
credential(rid REFERENCES resource, kind {api_key, cloud_role, kubeconfig, db_password, oauth_client}, scope, vault_path)
agent_template(rid REFERENCES resource, card JSONB, requires JSONB, subagents JSONB, body_rid, body_vno, ...)
                                                          -- card = A2A Agent Card; body = a workflow version, composite only
workflow(rid REFERENCES resource, ...)   dataset(rid REFERENCES resource, lakefs_repo)
environment(rid REFERENCES resource, base_image)
conversation(rid REFERENCES resource, title)   -- a checkpoint version's content_ref is a message seq
```

- `rid` is a UUID, which agents and external systems carry; today's integer ids stay as legacy columns on the kind tables during migration.
- Access tuples do not live in these tables. They live in OpenFGA, whose Postgres schema runs in the same cluster; the catalog writes the structural tuples (`resource#parent`, `group#member`, `resource#owner`) through an outbox table in the same transaction, so the two stores cannot drift. A project grant is an ordinary grant tuple on the project's rid.
- A row in a kind table cannot exist without its `resource` row: a foreign key, not a convention.
- Search stays on pgroonga, already deployed; no Elasticsearch.

**API protocol.** Three layers:

- The catalog API is Texera-owned, written in TypeSpec and emitted as OpenAPI 3.1 plus JSON Schema. Every kind is served in one shape, `GET /catalog/v1/{kind}/{rid}` returning `{apiVersion, kind, metadata {rid, name, project, owner, visibility, labels, version}, spec {...}, status {...}}`, the Kubernetes convention, so the frontend, the agent and the MCP server handle any kind generically. Versions at `/catalog/v1/{kind}/{rid}/versions/{vno}`, lineage at `/catalog/v1/lineage`, grants and decisions under `/access/v1`.
- Standards sit beside it where one exists and are vendored, not re-implemented: Iceberg REST for tables, S3 for files, MCP for tools, A2A for agent cards and tasks, AG-UI for the chat stream, OpenLineage for lineage events, AuthZEN for access decisions.
- Every catalog write emits a CloudEvent (`io.texera.resource.version.created` and so on) that lineage, search indexing and audit consume. This is DataHub's change-log pattern without Kafka at first: a Postgres outbox table drained by the catalog service.

### One contract, four generated surfaces

The TypeSpec file is the only hand-written description of the API. Everything a client or a model sees is generated from it, and the only hand-written code behind it is one Go service layer that the REST handlers and the MCP tools both call in process.

| Surface | Generated by | License | What comes out |
| --- | --- | --- | --- |
| OpenAPI document | `@typespec/openapi3` with `openapi-versions: ["3.1.0", "3.0.0"]` | MIT | the 3.1 document is canonical and served at `/catalog/v1/openapi.json`; the 3.0 document feeds the Go generator until its 3.1 support, initial since 2.8.0, has settled |
| Go server | `oapi-codegen` 2.8 strict server with its request validation middleware | Apache-2.0 | one interface with a method per operation; the catalog implements it once |
| TypeScript client | `@hey-api/openapi-ts` with the TanStack Query plugin | MIT | a typed client, one query or mutation hook per operation, Zod schemas; the frontend writes no DTO |
| Java client | `openapi-generator`, generator `java` with the `native` library | Apache-2.0 | the few calls the engine, the compiler and file-service make to the catalog |
| MCP tools | `cmd/mcpgen`, about 300 lines of Texera code over `kin-openapi` and the official `modelcontextprotocol/go-sdk` | MIT, MIT | one tool per operation tagged `x-mcp`, its input schema from the parameters and body, a handler that calls the strict-server interface in process |
| A2A, AG-UI | nothing generated; fixed protocols with SDKs | Apache-2.0, MIT | `a2a-js` and `a2a-go` for tasks, `@ag-ui/core` and `@ag-ui/client` for the chat stream |

The MCP surface is curated, not mirrored. About fifteen task-shaped operations carry the `x-mcp` tag and the rest stay REST only, which is what Speakeasy and Stainless both report from generating servers for large APIs: one tool per endpoint floods the model's context. The tag holds the tool name, a description written for a model, and the MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Two things were checked and dropped: Microsoft's `typespec-mcp` emitter, archived in August 2026, and `ogen-mcp`, which is GPL-3.0. Two options stay open: a Code Mode pair, `search` and `execute`, running model-written TypeScript against the generated client in a sandbox once the tool count grows, as Anthropic and Stainless describe; and MCP Apps, `ui://` resources stable since January 2026, so a Texera workflow renders inside Claude or ChatGPT.

One operation, written once:

```typespec
@route("/catalog/v1/workflows/{rid}/executions")
@post
@extension("x-mcp", #{
  tool: "run_workflow",
  description: "Run a workflow version on a computing unit. Returns the execution; poll get_execution or read its port results.",
  readOnlyHint: false, destructiveHint: false, idempotentHint: false
})
op run(@path rid: Rid, @body body: RunRequest): Execution | Error;
```

What comes out of it, in Go and TypeScript:

```go
// catalog_gen.go, oapi-codegen: the one interface the service implements
type StrictServerInterface interface {
    Run(ctx context.Context, req RunRequestObject) (RunResponseObject, error)
    // ...
}

// mcp_tools_gen.go, cmd/mcpgen: the tool, its schema and the in-process call
mcp.AddTool(server, &mcp.Tool{
    Name:        "run_workflow",
    Description: "Run a workflow version on a computing unit. ...",
    InputSchema: runWorkflowSchema, // {rid, body: RunRequest}, from the OpenAPI document
    Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: ptr(false), IdempotentHint: false},
}, func(ctx context.Context, _ *mcp.CallToolRequest, in RunWorkflowInput) (*mcp.CallToolResult, Execution, error) {
    out, err := api.Run(ctx, RunRequestObject{Rid: in.Rid, Body: &in.Body}) // same PDP check, same audit row
    return nil, out.(Run201JSONResponse).Execution, err
})
```

```ts
// generated by @hey-api/openapi-ts; the app calls it like this
const run = useMutation(runWorkflowMutation());
run.mutate({ path: { rid }, body: { version: 4, computingUnit: unit.rid } });
```

## Operators, ports, compute, credentials and MCP

### Operators and port-level lineage

Today `workflow_version` stores reverse deltas of the workflow JSON, and operator types are code in the engine image, pinned only by the `cu_image` digest a unit was started from. Results are one Iceberg table per (workflow, execution, global port) at `vfs://{warehouse}/wid/{wid}/eid/{eid}/globalportid/{opid}:{port}/result`, recorded in `operator_port_executions`, and `operator_port_cache` already keys reuse by a SHA-256 of the upstream sub-DAG. Lineage is the foreign-key chain only: nothing records which dataset commit a scan read or which port fed which.

Port level is the right granularity, and the model now has three identities for it:

- **Operator** (type) is a catalog entry versioned by engine image digest; the digest fixes both the implementation and the JSON Schema.
- **Operator Instance** is a weak entity of a workflow version: (rid, vno, opid) with property values; links are part of the version content, and a macro version has the same shape.
- **Port Result** is a weak entity of Execution: (eid, opid, port) pointing at an Iceberg table identity, its snapshot id, stats and a content hash. It is today's `operator_port_executions` row plus snapshot and hash.

Lineage edges live at the port level and roll up:

- `consumes` is materialized per execution from the links, and points at an earlier execution's port result when a result is reused by hash. `operator_port_cache` becomes an index over port results instead of a separate table.
- Source operators record the dataset or model version they read; export commits a dataset version. Both become edges from the port result.
- `derived from` between resource versions is the roll-up computed from port edges. The UI and agents query the roll-up, auditors the port level.
- The content hash is hash(operator version, properties, input hashes, environment version): one identity for reuse, for OpenLineage and for "has this been computed before".
- OpenLineage mapping: job = (workflow rid, opid) in the project namespace, run = one operator execution, inputs = upstream port results and dataset versions, outputs = port result tables with `datasetVersion` = snapshot id. One event per operator completion, readable by Marquez or any consumer.
- Port results are products, not resources. Retention is a policy: keep the last N executions per workflow, plus anything referenced by a `derived from` edge or pinned by a conversation checkpoint.

### Compute and credentials

Today a unit is `local` or `kubernetes`, a pod started from a `cu_image` digest with a free-text resource string. The pod receives the shared JWT secret, the JDBC user and password, the Lakekeeper URI, the lakeFS endpoint and the owner's seven-day token. Model calls pass through access-control-service, which swaps the user's token for the LiteLLM master key. There is no credential store: SQL source operators carry passwords in workflow JSON.

Kubernetes stays the only execution substrate. A unit's kind says where its pod runs, and an EC2 instance is a node, never a second backend:

| Kind | Where the pod runs | Provisioned by | Credential |
| --- | --- | --- | --- |
| pool | the platform cluster's node pool | today's unit manager | none |
| provisioned | a node pool created on demand in the platform's cloud account: GPU, spot, specific EC2 instance types | Karpenter NodePool or Cluster API MachineDeployment | the platform's own cloud role |
| external | the user's or lab's cluster: EKS, GKE, on-prem | registered by the user | kubeconfig or cloud role, a Credential resource |

Device needs are DRA resource claims on the pod, from the operator constraints. Five rules for credentials:

1. **The catalog stores metadata only**: kind {api\_key, cloud\_role, kubeconfig, db\_password, oauth\_client}, scope and a vault path. Secret bytes live in OpenBao, Vault-API compatible and deployed as a service, never bundled, under KV v2 or a dynamic-secrets engine with leases.
2. **Operators and MCP servers reference a credential by rid.** A property with JSON Schema format `credential` holds the rid; at run time the executor asks the catalog, which checks `can_use` and returns a lease scoped to (execution, credential). Nothing secret sits in workflow JSON, Postgres or pod environment variables.
3. **Prefer federation to stored keys for clouds.** The user's AWS account trusts Texera's OIDC issuer through an IAM role with a `sub` condition on the project or user, and the unit calls `AssumeRoleWithWebIdentity` with its delegated token, the same pattern as GitHub Actions and EKS IRSA. GCP workload identity federation and Azure federated credentials are the same shape. Stored access keys are the fallback, in OpenBao with rotation.
4. **Model keys come in two tiers.** Platform keys live in OpenBao and are read by LiteLLM through its Vault secret-manager integration, never by Texera code; every principal, user or agent, gets a LiteLLM virtual key with a budget, which replaces the master-key swap. Bring-your-own keys sit under the user's OpenBao path and LiteLLM reads them per team, so the user's own key serves the user's calls.
5. **Sharing a credential is a grant.** Viewer may use, editor may rotate, owner may delete; use is logged per execution; the secret is never readable through the API.

Platform secrets leave the pod. A unit runs with a service-account identity plus a delegated user token, reaches the catalog through the gateway, and reads and writes tables with credentials vended by Lakekeeper instead of static S3 keys; #5011 already removes the Postgres connection.

### Runtime Spec: one requirement schema

Operators, agent templates and workflows all need the same statement: which runtime, which environment, how much hardware, how isolated. One schema, written once in TypeSpec, is carried as `requires` on the operator type and on the agent template, and computed for a workflow version as the union of its instances' requirements.

| Field | Content | Executes as (Kubernetes) | Exports as |
| --- | --- | --- | --- |
| runtime | language {python, r, jvm} and a version range | the Environment's container image | CWL `SoftwareRequirement` |
| environment | Environment rid@vno: pylock plus OCI artifact | image volume | CWL `DockerRequirement` |
| resources | cpu, memory, ephemeral storage, gpu {class, count} | `resources.requests` and `limits`; a DRA `ResourceClaimTemplate` for devices | CWL `ResourceRequirement`; GA4GH TES `resources` |
| isolation | runtime class {none, gvisor, kata}; network {none, egress allowlist}; filesystem {read-only, mounts} | `runtimeClassName`, `securityContext`, NetworkPolicy; the Agent Sandbox CRD for sandbox nodes | - |
| placement | labels, affinity, colocation with data | `nodeAffinity`, topology keys | TES `zones` |

Placement is the compiler's job: a physical operator goes to a worker node whose capacity covers its Runtime Spec, and an agent turn goes to a sandbox node whose runtime class matches the template's isolation. A unit that cannot satisfy a workflow's aggregate spec is rejected at compile time with the missing field named, an error today's free-text `resource` column cannot give.

A unit is a list of nodes. The engine already runs as a cluster (`ClusterListener`, `GetAvailableNodeAddresses`, executor deployment by node address), and the Kubernetes unit manager today starts exactly one pod. The change is a Node table and a manager that starts a master pod plus worker and sandbox pods, all pinned to one image digest and joined through the cluster seed.

### The Texera MCP server

Main has no MCP. The dknet-ai-agent branch gives agent-service an MCP client over Streamable HTTP, with servers listed in config and keys in environment variables, plus a bio-mcp-service. Those are tool servers the agent consumes; what is missing is Texera as a server.

One built-in MCP server, `texera`, is itself an MCP Server resource in the catalog, mounted at `/mcp` behind the gateway and written against the 2026-07-28 revision: stateless with `server/discover`, long-running work through the tasks extension polled with `tasks/get`, change notifications through `subscriptions/listen`, and OpenTelemetry trace context in `_meta`, so a tool call and the execution it starts share one trace.

- Tools are generated from the catalog's TypeSpec contract (One contract, four generated surfaces, above), so REST and MCP cannot drift. The first set, about fifteen: `search_resources`, `get_resource`, `list_versions`, `get_lineage`, `get_workflow`, `edit_workflow` (a JSON patch to a draft that yields a new version), `validate_workflow`, `list_operators` with their JSON Schema, `list_computing_units`, `create_computing_unit`, `run_workflow` (returns the execution), `get_execution`, `get_port_result` (a resource link plus a bounded sample), `read_dataset_file` (bounded), `commit_dataset_version`, `post_message`.
- Resources use URI templates: `texera://workflow/{rid}@{vno}`, `texera://execution/{eid}`, `texera://execution/{eid}/port/{opid}/{port}`, `texera://dataset/{rid}@{vno}/{path}`. Large data never travels through MCP; the link points at the Table API or the file API, where credential vending applies.
- Authorization follows the MCP authorization spec: the server is an OAuth 2.1 resource server whose protected-resource metadata names the identity provider; external clients such as Claude Code or a lab's own agent register through Client ID Metadata Documents; in-app agents present the delegated token. The PDP checks every call for actor, on-behalf-of and the template's tool allowlist, then it is audited.
- The engine is not an MCP server. Units keep their internal execution protocol and the MCP server routes to them, so authorization stays in one place. An agent inside a unit, if ever wanted, is a second instance of the same server with a unit-scoped token.
- One client path. The in-app agent becomes an MCP client of this server for everything except canvas sync, and external servers such as bio-mcp are registered as MCP Server resources with credentials from the catalog and proxied through the same gateway, so the allowlist and the audit log apply to every tool alike. Envoy AI Gateway's MCP gateway, which aggregates servers behind one endpoint with OAuth and tool filtering by claims, is the candidate for that proxy.

### Agent templates as a protocol

No existing protocol covers a template that states requirements, spawns sub-agents and talks to peers. A2A 1.0 covers discovery and communication and is opaque about an agent's internals by design. Oracle's Open Agent Specification is the one framework-neutral template format, with Agents and Flows, but it says nothing about sandboxes or compute, and adoption outside Oracle is thin. The de facto agent files, Claude subagents, Copilot `.agent.md` and AGENTS.md, are Markdown for one vendor's tool. So the template is Texera-owned, kept clean by one rule: every section is either a standard document carried verbatim or a reference to a catalog resource.

| Section | Content | Standard |
| --- | --- | --- |
| card | name, description, skills, capabilities, interfaces, signatures | A2A Agent Card 1.0, served at `/.well-known/agent-card.json` for the agent principal |
| model | LiteLLM model name, budget | - |
| prompts | system prompt and objective, as versioned files | - |
| skills | Skill rid@vno list | Agent Skills, SKILL.md |
| tools | MCP Server rid@vno with a tool allowlist; operator and workflow allowlists | MCP; server.json |
| requires | Runtime Spec: sandbox isolation, environment for code execution, resources | the table above; Agent Sandbox CRD |
| subagents | templates it may spawn, max concurrent, max depth, default lifetime {execution, conversation, pinned} | Texera-owned |
| body | composite only: a workflow version whose agent operator instances bind the member templates, between the built-in ConversationInput and ConversationOutput operators; runs once per turn | the engine; export as Open Agent Spec Flow |
| communication | in-platform: conversations it may join; external: A2A endpoints it may call | A2A Task and Message |
| memory, approval | retention policy; actions that need a human | Texera-owned |

Spawn semantics follow the principal model. A spawned agent is a principal whose sponsor is the spawner's sponsor and whose authority is the intersection of the spawner's and its template's; it is ephemeral unless pinned, records `spawned by`, and runs its turns in a sandbox node that satisfies its `requires`. Agents communicate in-platform by posting to a conversation they are granted on, which is also how a person watches a multi-agent run; across platforms they use A2A tasks with the conversation rid as contextId. Export adapters produce an A2A card, a Claude or Copilot agent file, and an Open Agent Spec document when a lab wants one.

### Agent orchestration: static and dynamic

The coordinator pattern, one agent handing its work to two others and waiting for both, needs no new kind. Texera already has a scheduler for graphs with fan-out, fan-in and loops: the engine. The built-in `agent` operator type is an A2A client. An instance binds an agent template; at execution the engine spawns one agent principal per instance on a sandbox node, turns each input tuple into an A2A message, and emits the task's artifacts on its output ports. A composite agent template names such a workflow as its body, so a whole orchestration is itself an agent with a card, and templates nest. Dynamic delegation stays inside the agent: its template's sub-agent policy says what it may spawn, and the spawn API records the tree.

| Pattern | How Texera models it | Standard |
| --- | --- | --- |
| sequential, parallel fan-out and fan-in | a workflow of agent operator instances, scheduled by the engine | the engine's DAG; export as Open Agent Spec Flow |
| loop until a condition or a budget | the existing LoopStart and LoopEnd operators around agent instances | - |
| coordinator that decides at runtime whom to spawn | the coordinator's template sub-agent policy; spawned agents are principals with spawned by | A2A tasks between agents |
| handoff and agents-as-tools | an agent calls a peer's A2A endpoint, or a workflow through the Texera MCP server | A2A, MCP |
| human approval inside a run | the agent operator posts to the conversation bound to the execution and waits for a message | A2A input-required state; an AG-UI interrupt in the chat |
| mixing data operators and agents | ordinary: a scan feeds an agent, an agent feeds a Python UDF | - |
| a chat mode that is a team | the mode is a composite template; its body runs as one execution per turn and the members keep their memory across turns | the engine; AG-UI subagent events in the chat |

What was checked and rejected: a separate Agent Workflow kind duplicates Workflow and would need its own scheduler, versions and lineage; Oracle's Open Agent Spec Flows (Start, End, LLM, Agent, Tool, Branching, Map nodes) and Microsoft Agent Framework's declarative YAML are the only orchestration formats with a published schema, and both lack data operators, placement and lineage, so they are export targets; Google ADK's Sequential, Parallel and Loop agents are the same three shapes as the engine's DAG plus loops. Serverless Workflow 1.0 is a generic control-flow DSL without an agent or data model.

**Modes are templates; teams are composite templates.** The picker a person sees when starting a chat lists the agent templates they can read: Texera's built-in General, Workflow Builder, Data Analyst and Research, a lab's own, their own. Starting a chat creates a Conversation resource and spawns one agent from the chosen template as the conversation's principal; changing mode mid-chat spawns a new principal in the same conversation, and the messages stay because they belong to the conversation, not to the agent. A plain template is one agent: prompts, skills, MCP servers with allowlists, a Runtime Spec, a sub-agent policy. A team such as Research is a composite template whose body is a workflow: ConversationInput feeds a lead agent, the lead fans out to a searcher and an analyst, a verifier checks their claims, LoopEnd repeats until the verifier agrees, ConversationOutput streams the answer. Each member is an ordinary agent operator instance bound to its own template, so the searcher's MCP servers and skills are preconfigured in `tpl:searcher`, not in the team.

Turn semantics, so this runs on the engine without a second scheduler:

- A user turn on a composite agent is one execution of the body on the user's unit, with `execution.parameters = {conversation, turn}`. ConversationInput reads the new message and a window of history from the catalog; ConversationOutput posts each output tuple as a streamed part of the assistant message. Every member's output is a port result, so which search produced which claim is a port edge.
- An agent operator instance carries `lifetime`. `execution` spawns a fresh agent per run, right for stateless workers; `conversation` keeps the member across turns, right for a lead that must remember the plan: the engine asks the catalog for the agent with that conversation and opid, the A2A `contextId` is the conversation rid, and each turn is a new task. The template's `subagents.lifetime` is the default and the instance may override it.
- The agent operator is JVM-native, an A2A client in Scala, so a turn spawns no Python worker; a warm unit starts the body in well under a second and the model calls dominate.
- The composite's runtime is the same agent process in team mode: it accepts the A2A task or the AG-UI run, submits the execution, and projects engine events onto the chat stream. An operator starting is a step, an agent instance is a subagent, ConversationOutput tuples are text and tool results, a failure is a run error. The person can also open the body workflow beside the chat and watch each member's results as tables, like any run.
- The dynamic form stays available inside a member: the lead's own sub-agent policy may allow `tpl:searcher`, so it can spawn a second searcher when the plan calls for one. The static body fixes the pipeline, the policy covers judgment calls, and both compose.

The Research mode as the catalog stores it. The composite template:

```json
{ "card": { "name": "Research", "description": "Finds, reads and verifies literature for a question", "skills": [ { "id": "literature-review" } ] },
  "body": { "workflow": "wf:research-team@4" },
  "subagents": { "templates": [], "maxDepth": 2, "lifetime": "conversation" },
  "requires": { "isolation": { "runtimeClass": "gvisor", "network": "egress-allowlist" } } }
```

One member, with its tools and skills preconfigured:

```json
{ "card": { "name": "searcher", "skills": [ { "id": "search-literature" } ] },
  "model": { "name": "claude-sonnet-5-5", "budget": { "usd": 2 } },
  "prompts": { "system": "file:prompts/searcher.md@3" },
  "skills": [ "skill:pubmed-search@2", "skill:citation-format@1" ],
  "tools": { "mcp": [ { "server": "mcp:bio-mcp@7", "allow": [ "pubmed_search", "europepmc_fetch" ] },
                      { "server": "mcp:texera@1", "allow": [ "read_dataset_file", "commit_dataset_version" ] } ] },
  "requires": { "resources": { "cpu": 1, "memory": "2Gi" } },
  "subagents": { "templates": [], "maxDepth": 0, "lifetime": "execution" } }
```

The body, an ordinary workflow version:

```json
{ "operators": [
    { "operatorID": "in",      "operatorType": "ConversationInput",  "operatorProperties": { "history": 20 } },
    { "operatorID": "loop",    "operatorType": "LoopStart" },
    { "operatorID": "lead",    "operatorType": "Agent", "operatorProperties": { "template": "tpl:research-lead@2", "lifetime": "conversation" } },
    { "operatorID": "search",  "operatorType": "Agent", "operatorProperties": { "template": "tpl:searcher@3" } },
    { "operatorID": "analyze", "operatorType": "Agent", "operatorProperties": { "template": "tpl:analyst@1" } },
    { "operatorID": "verify",  "operatorType": "Agent", "operatorProperties": { "template": "tpl:verifier@1" } },
    { "operatorID": "end",     "operatorType": "LoopEnd", "operatorProperties": { "until": "$verified == true", "maxIterations": 3 } },
    { "operatorID": "out",     "operatorType": "ConversationOutput" } ],
  "links": [ "in:0->loop:0", "loop:0->lead:0", "lead:0->search:0", "lead:1->analyze:0",
             "search:0->verify:0", "analyze:0->verify:1", "verify:0->end:0", "end:0->loop:1", "end:1->out:0" ] }
```

## Access control: status and what must change

Authorization on `main` is a per-service convention: each service queries the four access tables itself, and access-control-service is a proxy for three route families, not a decision point.

| Area | On `main` today | Problem |
| --- | --- | --- |
| Authentication | HS256 JWT with one shared secret (`JwtAuth.scala`, `HMAC_SHA256`), expiry from `jwtExpirationMinutes`; the secret is injected into every computing-unit pod as `AUTH_JWT_SECRET` | any pod can mint a token for any user; no rotation; no machine identities |
| Authorization data | `workflow_user_access`, `dataset_user_access`, `model_user_access`, `computing_unit_user_access`, each with `privilege_enum` NONE, READ, WRITE; sharing user by user by email | four copies of one idea; no groups or projects; a WRITE collaborator can change visibility ([#8889](https://github.com/apache/texera/issues/8889)) |
| Enforcement | checks re-implemented in the Dashboard Service (13 files), file-service (5), computing-unit service (4), notebook-migration (2) and the compiler; `@RolesAllowed` for admin only | drift: the `deleteCollection` quota endpoint is unauthenticated; WebSocket result reads check the CU grant, not the workflow; `FileResolver` and the compiler read private dataset schemas |
| access-control-service | Envoy ext-authz for `/auth/{path}` (CU routes, CU grant), `/chat` (swaps the user JWT for the LiteLLM master key), `/models`, `/mounts/{cuid}` | route logic with its own checks; no other service asks it anything |
| External engines | Lakekeeper anonymous (`internalOpenFGA: false`); lakeFS one admin account; per-user warehouses are key prefixes | whatever reaches Lakekeeper or lakeFS has everything |
| Agents | routes unauthenticated ([#5268](https://github.com/apache/texera/issues/5268), [#5561](https://github.com/apache/texera/issues/5561)); agents in memory ([#5267](https://github.com/apache/texera/issues/5267)); `disabledTools` not enforced ([#9122](https://github.com/apache/texera/issues/9122)); edits recorded as the user's | no agent identity; no audit distinction between user and agent |

What must be done, in order:

1. **One decision point.** access-control-service becomes the PDP: `POST /access/v1/evaluation` in the AuthZEN shape (subject, action, resource, context), answered from OpenFGA. Every service calls it and none reads access tables. Envoy ext-authz uses it for coarse route checks, services for object-level checks. OpenFGA already ships in the Lakekeeper chart.
2. **One model.** The OpenFGA model below. Lakekeeper's authorizer points at the same store, so Iceberg access follows Texera grants.
3. **Identity.** RS256 tokens with a JWKS endpoint from Keycloak or Dex, with Texera's login as an OIDC client; service accounts for CU, agent-service and file-service; RFC 8693 token exchange mints short-lived delegated tokens for a run or an agent turn, scoped to one project. `AUTH_JWT_SECRET` leaves the CU pods.
4. **Agent principals.** Agent rows in `principal` with a required sponsor; delegated tokens carry an `act` claim; every catalog write stores `actor_pid` and `on_behalf_of_pid`.
5. **Audit.** The PDP logs every decision with the request id and the catalog logs every write, both queryable per resource.

OpenFGA authorization model:

```
model
  schema 1.1

type user
type agent
  relations
    define sponsor: [user]
type group
  relations
    define member: [user, agent, group#member]

type resource
  relations
    define parent: [resource]
    define owner: [user, agent]
    define editor: [user, agent, group#member] or owner or editor from parent
    define viewer: [user, agent, group#member, user:*] or editor or viewer from parent
    define listable: [user:*]
    define can_read: viewer
    define can_write: editor
    define can_share: owner or owner from parent
    define can_delete: owner or owner from parent
```

There is no project type: a project is a `resource` of kind project, `parent` is the containing project, and the recursion through `parent` is what makes nesting work. Invariants the catalog enforces, not the model: exactly one `owner` tuple per resource; `visibility = public` writes the `viewer: user:*` tuple; the `parent` tuple is written in the same transaction as the `resource` row and is absent only for a top-level project. A project owner can share and delete what the project contains, which is why `can_share` and `can_delete` include `owner from parent`.

There is no conversation type in the model. A conversation is a `resource`, and an agent joins a chat by receiving the `editor` relation on it. The agent's own grants never widen what a chat may do: every message it writes carries `on_behalf_of_pid`, and each tool call inside the turn is checked under the intersection rule for that participant.

Enforcement path for one agent turn: user token, then token exchange, then a delegated token with `sub` = user, `act` = agent and `scope` = project; the MCP gateway checks `can_write` for the user and the template allowlist for the tool; the tool call reaches the catalog, which stores both principals and emits the lineage event.

Authentication is centralized in three standard components, and no service parses a token or keeps an access table of its own. Today the gateway's SecurityPolicy applies ext-authz only to the dynamic unit routes, and every static route validates the HS256 token inside the service with the shared secret; that is the pattern to retire.

| Concern | Standard | Component | Can be swapped for |
| --- | --- | --- | --- |
| Login and identity | OIDC and OAuth 2.1; RS256 with JWKS discovery | Keycloak, or Dex for a small footprint; today's Google, ORCID and Apple logins become brokered identity providers | any OIDC issuer |
| Token verification | JWT validation at the edge: Envoy Gateway SecurityPolicy `jwt` provider on every route | the gateway injects verified identity headers | any gateway with a JWT filter |
| Delegation | RFC 8693 token exchange with the `act` claim, standard in Keycloak since 26.2 | the issuer, called by agent-service and the unit manager | - |
| Workload identity | Kubernetes projected service-account tokens, or SPIFFE/SPIRE | units and services | - |
| Authorization decisions | AuthZEN 1.0 evaluation API | access-control-service as the PDP over OpenFGA | Cedar and AWS Verified Permissions, OPA or Topaz, any AuthZEN PDP |
| Enforcement points | ext-authz at the gateway; checks in the catalog, the MCP server and file-service; Lakekeeper's OpenFGA authorizer on the same store | one decision path | - |
| Agents and external clients | MCP authorization: OAuth 2.1 resource server, protected-resource metadata (RFC 9728), Client ID Metadata Documents | the MCP server | - |
| Audit | PDP decision log and OpenTelemetry | PDP and catalog | any OTLP backend |

## Service topology

One gateway, one identity provider, one catalog, one unit operator, one agent runtime binary, one engine. Everything else is a deployed standard component. The diagram shows the services and the protocol on every edge; the table lists the routes the gateway serves.

&#91;image: Service topology\]

Amber is the engine, and it lives inside every unit rather than as a service of its own. A unit's master node runs ComputingUnitMaster: the scheduler and controller actors, the WebSocket API the app and the agent runtime speak, the sync run endpoint, and the compiler library. Its worker nodes run ComputingUnitWorker with the Python and R runtimes, and the Pekko cluster joins them. Amber keeps its actor model, its operator library and its WebSocket protocol. What changes sits at its edges: metadata, results and lineage go to the catalog instead of Postgres; placement reads the Runtime Spec; the WebSocket types come from `engine.tsp`; and three built-in operators join the library, Agent, ConversationInput and ConversationOutput. Amber never talks to Kubernetes; the unit operator creates its pods from the CRD.

Routes, all behind the gateway's JWT check and ext\_authz:

| Route | Service | Protocol | Who calls it |
| --- | --- | --- | --- |
| `/` | the app, static files | HTTPS | people |
| `/auth/*` | Keycloak | OIDC, OAuth 2.1 with PKCE, RFC 8693 token exchange | the app; services exchanging tokens |
| `/catalog/v1/*` | catalog | OpenAPI 3.1, the envelope | the app, agents, the engine, the compiler, file-service |
| `/access/v1/*` | catalog PDP | AuthZEN 1.0; the gateway's ext\_authz calls it on every route | the gateway; services with their own checks |
| `/mcp` | catalog MCP server | MCP 2026-07-28 over Streamable HTTP; OAuth 2.1 resource server | in-app agents, Claude Code, a lab's agents |
| `/agents/{pid}/a2a` | the agent runtime process for that principal | A2A 1.0, JSON-RPC and SSE | peers, the engine's agent operator, external callers |
| `/agents/{pid}/ag-ui` | the same process | AG-UI 1.0 over SSE | the app |
| `/units/{rid}/wsapi` | the unit's master | the engine WebSocket, typed from `engine.tsp` | the app, the agent runtime |
| `/rtc` | y-websocket | Yjs | the app |
| `/llm/*` | LiteLLM | OpenAI-compatible; virtual keys per principal | agent runtimes, operators |
| `/iceberg/*` | Lakekeeper | Iceberg REST with credential vending | the engine; the app's table preview |
| `/lineage/v1` | catalog | OpenLineage events in | the engine |
| `/mcp-ext/{server}` | Envoy AI Gateway MCP route, optional | MCP with OAuth and claim-based tool filtering | agent runtimes reaching lab-registered MCP servers |

Inside the cluster, the catalog writes ComputingUnit custom resources and the unit operator reconciles them into master, worker and sandbox pods; agent runtime processes run on sandbox nodes; every service exports OTLP to the collector the chart already ships. Three identities flow: a person's token from Keycloak, a delegated token the catalog mints for an agent through token exchange, and a service-account token a unit exchanges for its owner's. No service verifies a token itself; the gateway does, and the PDP decides.

## Refactoring plan

Nothing is rewritten for its own sake, and nothing is kept for its own sake. A survey of `main` at 07fffb3d5 on 2026-11-02 gives the distance to the target. The engine, the Python and R runtimes, the compiler, lakeFS, Lakekeeper, RustFS and LiteLLM stay. One catalog replaces the Dashboard Service and the four access tables. The three thin Scala services are rewritten where the survey found them unsound. Every boundary gets a standard. Language follows the job: Go for the control plane (catalog, unit operator), because that ecosystem supplies the Kubernetes controller runtime and the OpenFGA, MCP, A2A and OpenLineage SDKs as single static binaries; TypeScript stays for the agent runtime and the frontends; Scala stays for the engine and the compiler; Python and R stay for operators. Every new dependency is Apache-2.0, MIT or BSD, and OpenBao is deployed, never bundled.

### Order of work

Protocols first, generators second, code third. Each step ends with something that runs.

| Step | What is done | Ends with |
| --- | --- | --- |
| 0. Settle the protocols, one week | one decision record per boundary: identity (OIDC, JWKS, RFC 8693), API (TypeSpec to OpenAPI 3.1, the envelope), authorization (AuthZEN, the OpenFGA model), lineage (OpenLineage with the texera facets), events (CloudEvents), tools (MCP 2026-07-28), agents (A2A 1.0 plus the Texera extension URIs), chat (AG-UI 1.0), compute (the ComputingUnit CRD, Runtime Spec), environments (pylock, OCI), tables and files (Iceberg REST, S3), skills (Agent Skills), telemetry (OTel GenAI conventions plus Texera attributes) | `api/` holds `catalog.tsp`, `engine.tsp`, the JSON Schemas for Runtime Spec, agent templates and the CRD, and the OpenFGA model; the ER diagram is the schema |
| 1. The codegen framework, one to two weeks | the repository layout below; `make generate` emits OpenAPI 3.1 and 3.0, the Go strict server, the TypeScript client with Query hooks and Zod, the Java client, the MCP tool table and the engine protocol types; a mock server from the OpenAPI document so the app starts before the catalog exists; a CI job that fails on drift; the design-token package; the sandbox interface with its local provider | an empty catalog that answers every generated route with 501, and an app that lists mock workflows through the generated client |
| 2. The walking skeleton: M0 and the first slice of M1 | Keycloak and the gateway JWT provider; the catalog with resources, versions and grants for the workflow kind; the PDP on every route; the migration script for workflows; the app's login, library and workflow page | log in with ORCID, see migrated workflows, open one, get 403 on someone else's |
| 3. M1 breadth | the other kinds, projects, the grant migration, search, the outbox, read-only MCP tools; the app's registry for every kind and the share dialog | the M1 proof |
| 4. M2 | executions and lineage; the engine reports to the catalog; the app's execution page; the editor essentials | the M2 proof |
| 5. M3 | the CRD and unit operator; environments; OpenBao and virtual keys; the Kubernetes sandbox provider | the M3 proof |
| 6. M4 | the agent runtime on AI SDK 7: A2A server, AG-UI stream, MCP client, skills; conversations in the catalog; the app's chat with modes | the M4 proof |
| 7. M5 | the agent operator, ConversationInput and ConversationOutput, composite templates; the app's team view | the M5 proof |
| 8. M6 | Yjs behind the gateway, observability on, signing, Helm as OCI, the cutover and the Angular deletion | one stack, one frontend |

Two concerns cut across every step.

- Observability. Every service uses the OpenTelemetry API from day one and nothing else: the agent runtime through `@ai-sdk/otel` with the GenAI semantic conventions, the catalog and the operator through the Go SDK, the engine through its existing instrumentation, the app through trace headers on every request. `traceparent` crosses REST, A2A, AG-UI, MCP and the engine WebSocket, and every span carries `texera.principal`, `texera.on_behalf_of`, `texera.execution` and `texera.conversation`. The chart's collector, Prometheus, Tempo, Loki and Grafana stay off by default and turn on at M6; nothing in the code changes when they do. Persisted AG-UI streams double as the evaluation corpus.
- Sandboxes. The word covers two things. A sandbox node is a unit node class for agent processes, with a runtime class such as gVisor and an egress allowlist; it arrives with the CRD at M3. The sandbox interface is AI SDK 7's `experimental_sandbox`: a provider that runs a command with streaming output, a working directory, environment variables and an abort signal, which is what Code Mode and a code-execution tool call. Step 1 defines the interface with a local provider that runs inside the agent's own pod, about a hundred lines; M3 adds the Kubernetes provider on sandbox nodes for templates whose `requires.isolation` asks for one. Nothing in the agent code changes between the two.

### Where the code is today

| Area | Today, with evidence | Verdict |
| --- | --- | --- |
| Identity | HS256 with one shared secret (`JwtAuth.scala:49`), a default literal in `auth.conf:25`, a plain env value in `values.yaml:537`, copied into every CU pod; 7-day tokens in localStorage; four hand-written logins (local, Google, ORCID, Apple); agent-service decodes the token without verifying it (`auth-api.ts:24-58`) | replace: Keycloak and JWKS |
| Access decisions | four `*_user_access` tables with NONE, READ, WRITE; the owner stored three ways (`workflow_of_user`, `owner_uid`, `workflow_computing_unit.uid`); the ext-authz `/api/auth` matches path patterns only, accepts READ for writes, ignores the method and logs tokens at INFO (`AccessControlResource.scala:46-216`); no projects since migration 45 | replace: OpenFGA behind a PDP |
| Dashboard Service | Dropwizard 1.3.23 (`amber/build.sbt:104`) while every other service is on 4.0.7; twenty resources with hand-kept TypeScript DTOs; no OpenAPI anywhere in the repo | replace: the catalog |
| Workflow versions | reverse RFC 6902 patches replayed backwards from `workflow.content` (`WorkflowVersionResource.scala:83-100`); `operatorVersion` is a JGit commit of a path prefix that no longer exists (`LogicalOp.scala:473`) | full snapshots; an operator registry |
| Operators | 166 types in one `@JsonSubTypes` list (`LogicalOp.scala:171-443`); only PythonUDFV2 carries an environment name; no image, Python version, CPU or GPU field; metadata served by the Dashboard Service only | keep the code; registry rows with a Runtime Spec |
| Compiler | a standalone service, but the CU compiles in-process (`WorkflowExecutionService.scala:118`); it needs Postgres for `FileResolver`; the physical plan is never persisted; `opsToReuseResult` is ignored | keep; one library (the unify-workflow-compiler worktree); persist the plan |
| Execution metadata | the CU writes `workflow_executions` and `operator_port_executions` over JDBC with credentials in env; previous results are deleted before each run (`WorkflowService.scala:261`); `operator_port_cache` is never read or written outside tests; `environment_version` is the engine version string | rewrite the path: OpenLineage events to the catalog |
| Compute | one bare Pod per unit, no service account, no NetworkPolicy, secrets as env (`KubernetesClient.scala:146-315`); cluster mode exists (`ComputingUnitWorker`, a runner image built nightly and referenced nowhere, the master IP fetched from checkip.amazonaws.com); placement is round robin and `ExecutionClusterInfo` is empty | rewrite: a Go operator with a CRD |
| Environments | `virtual_environments` is never consulted at execution; venvs are `pip` into `/tmp/texera-pve` per unit; `cu_image` registers admin-validated images, nothing builds | rewrite: an environment kind, pylock plus OCI |
| Datasets, models, warehouses | file-service over the lakeFS SDK with static keys, presign through lakeFS, an S3 proxy servlet; Lakekeeper authentication off and `allowall`, static S3 keys in the warehouse credential, no vending; the `aws` flavor never written | keep file-service; Lakekeeper auth on; vend credentials |
| Secrets and model keys | JWT secret, admin password, SMTP and ORCID secrets as plain values; LiteLLM master key only, swapped in by the `/chat` proxy | OpenBao; LiteLLM virtual keys |
| Agents | in-memory `agentStore` with ids `agent-N`; custom WebSocket frames; `generateText` per step, no token streaming; tools edit an in-memory workflow and POST `/workflow/persist`; no approval, no sub-agents; MCP only on a branch 1478 commits behind, with static `x-api-key`; a chat API with the AI SDK stream and SQLite in the frontend-next worktree | rewrite in place: A2A server, MCP client, catalog persistence |
| Collaboration | stock y-websocket at `/rtc` with no authentication, room = wid, LevelDB; the legacy `/wsapi/collab` still registered | keep; behind the gateway and the PDP |
| Frontend | Angular 21 with jointjs, hand-written services, `access_token` in localStorage; frontend-next (React 19, xyflow) untracked | keep; generated client; OIDC login |
| Observability | an OTel module with one span and five metrics, off by default; no OpenLineage; no OTel in the Python worker | turn on; add OpenLineage |
| Release | nightly images to ghcr with no signing or SBOM; the Helm chart is not published; `Chart.lock` is stale | cosign, SBOM, chart as OCI |

### Target components

| Component | Language | Action | Standard at the boundary |
| --- | --- | --- | --- |
| API contract | TypeSpec | new: one file; the Go server, the TypeScript and Java clients and the MCP tools are generated from it | OpenAPI 3.1, JSON Schema, x-mcp |
| Keycloak | - | deploy; broker Google, ORCID and Apple | OIDC, OAuth 2.1, RFC 8693, JWKS |
| Envoy Gateway | - | keep; a JWT provider plus ext\_authz on every route | JWT, ext\_authz |
| catalog | Go | new: resources, versions, grants, projects, executions, lineage, PDP, MCP server, outbox | TypeSpec to OpenAPI 3.1, AuthZEN 1.0, OpenLineage, MCP 2026-07-28, CloudEvents |
| OpenFGA | - | deploy | OpenFGA API |
| unit-operator | Go, controller-runtime | new; replaces computing-unit-managing-service | Kubernetes CRD, RuntimeClass, DRA; the agent-sandbox CRD once stable |
| engine | Scala | keep; metadata and results through the catalog; node-aware placement; the agent operator as an A2A client; ConversationInput and ConversationOutput | Pekko cluster, Iceberg REST, OpenLineage client, A2A |
| compiler | Scala | keep as one library; registry and Runtime Spec from the catalog; persisted physical plan | - |
| operator runtime | Python, R | keep | Arrow Flight; pylock environments |
| file-service | Scala | keep; drops its access resources; registers versions with the catalog | lakeFS API, S3 presign |
| agent runtime | TypeScript, Bun | rewrite in place on AI SDK 7: one process per agent, with a team mode for composite templates | A2A 1.0, AG-UI 1.0, MCP client with OAuth, Agent Skills |
| OpenBao, LiteLLM | - | deploy; virtual keys per principal | Vault API, OpenAI-compatible |
| Lakekeeper, lakeFS, RustFS | - | keep; Lakekeeper auth on | Iceberg REST with vending, S3 |
| y-websocket | - | keep, behind the gateway | Yjs |
| frontend | TypeScript, React | new: frontend-next is the only frontend; Angular gets no further work and is deleted at the cutover | generated OpenAPI client, AG-UI 1.0, OIDC with PKCE |

Why Go for the two new services. The catalog and the unit operator sit on Kubernetes, Envoy and OpenFGA, and that ecosystem is written in Go: controller-runtime for the operator, the reference ext\_authz and OpenFGA SDKs, the official MCP and A2A SDKs, the CloudEvents SDK. Each service is one static binary that idles in a few tens of megabytes, against several hundred for each of today's JVM services, which matters for the single-node stack and for every lab's cluster. The server generated from TypeSpec is idiomatic Go, and contributors from the cloud-native projects the design adopts can read it. The alternatives were weighed. Kotlin on the JVM keeps one backend language and the jOOQ models, but puts a second-class operator SDK and a heavy process under the PDP that every request hits. TypeScript on Bun would unify the agent runtime and the app, but has no controller runtime and puts a single-threaded runtime under the control plane. Rust buys nothing here, since the catalog is bound by Postgres, not by CPU. The cost of Go is a fourth language in the repository and a learning curve for Scala contributors, which Go keeps small.

Why the agent runtime stays on TypeScript with AI SDK 7 and no framework. The runtime's own work is small and Texera-specific: the tool loop, an A2A server, an AG-UI stream, an MCP client, a skills loader and the catalog client. AI SDK 7 (June 2026, Apache-2.0) supplies the loop as `ToolLoopAgent` with `toolApproval`, OpenTelemetry GenAI spans from `@ai-sdk/otel`, an MCP client with OAuth, and a sandbox abstraction that a Texera sandbox node can implement for Code Mode later. `@a2a-js/sdk` supplies the A2A server and `@ag-ui/core` the event types and encoder. The agent service and the prototype's chat already run on this SDK, so the distance is the AG-UI mapping from the stream events, about two hundred lines, since AG-UI lists no AI SDK integration of its own. Every alternative was weighed against that:

| Option | What it brings | Why not here |
| --- | --- | --- |
| Mastra (TypeScript, Apache-2.0 core) | AG-UI and A2A 1.0 first-party, MCP 2026-07-28 with stored tasks, suspend and resume, memory, evals, weekly releases | it wants to be the server and the store: its memory and workflows duplicate the catalog and the engine, its deployment is one bundled server rather than one process per agent in a sandbox, and enterprise features sit under a source-available license |
| Pydantic AI (Python, MIT) | AG-UI with interrupts for every feature of the spec, an MCP client with OAuth, elicitation and sampling, durable execution on Temporal or DBOS, Pydantic Evals, Python beside the operators and LiteLLM | a rewrite of the agent service; A2A moved out to the separate FastA2A package; about twice the memory and a slower start for one process per agent; no shared types with the app. The one alternative worth a spike if the team wants the runtime in Python |
| OpenAI Agents SDK (TypeScript, MIT) | handoffs, approvals, MCP, tracing | model-neutral only through adapters; OpenAI-shaped primitives |
| Claude Agent SDK, Claude Managed Agents | a complete harness with sandboxes and session logs | Claude only, and the managed form is hosted; a self-hosted, model-neutral workspace cannot build on it, though AI SDK 7's `HarnessAgent` can run such harnesses as a mode later |
| LangGraph.js, Strands TypeScript, ADK JS | graphs with checkpointers; A2A and AG-UI bridges | graph state and sessions duplicate what the engine and the catalog own; ADK JS is pre-1.0 |
| Go (ADK Go, Eino) | one language with the control plane | thin AG-UI, evals and provider ecosystem; the LLM tooling lives in TypeScript and Python |

Bun stays the development runtime (MIT, Anthropic-owned since December 2025) and the code stays Node 22 compatible, which AI SDK 7 requires, so either runtime can ship the container.

Retired: the Dashboard Service (TexeraWebApplication), access-control-service, computing-unit-managing-service, the four access tables, auth\_provider, operator\_port\_cache, the /chat proxy, /wsapi/collab, the agent-service in-memory store and the Angular frontend. Until the cutover the current stack stays deployed unchanged and the new stack runs beside it, as the texera-next compose profile already does; the M1 migration runs once more at the cutover.

### Milestones, each one runnable end to end

| Milestone | Builds | Removes | Proof on the local stack |
| --- | --- | --- | --- |
| M0 identity, S | a Keycloak realm with the three IdPs; the gateway JWT provider; JwtAuthFilter on JWKS; user.subject; agent-service verifies; the app's OIDC login with PKCE, shell and tokens (F0) | JwtAuth.jwtToken, the four login resources, auth\_provider, AUTH\_JWT\_SECRET | log in with ORCID through Keycloak, open and run a workflow; grep -r AUTH\_JWT\_SECRET bin/ returns nothing |
| M1 catalog, XL | the TypeSpec contract and the generated Go server, TypeScript and Java clients; the Go service with the envelope schema; the OpenFGA model and outbox; the PDP and ext\_authz on every route; migration of users, workflows (patch chains materialized), datasets, models and units, and of the four access tables into grants; one home project per user; the app's library, projects and share dialogs on the generated client (F1); read-only MCP tools | WorkflowResource, WorkflowAccessResource, WorkflowVersionResource, HubResource, DashboardResource, AdminUserResource, WarehouseResource, DatasetAccessResource, ModelAccessResource, ComputingUnitAccessResource, ResourceAccess, /api/auth | a lab project with a nested RNA-seq project; the lab group granted viewer; a member sees the dataset, a non-member gets 403 at the gateway; the MCP search\_resources tool returns the same set |
| M2 executions and lineage, M | the CU posts OpenLineage run events per operator with a texera\_port facet; execution, port\_result, port\_edge and port\_input tables; execution parameters; the persisted physical plan; reuse by hash; the lineage API; the app's execution page with the lineage chain and the editor essentials (F2); Marquez optional | JDBC credentials in CU pods (#5011), result deletion before each run, operator\_port\_cache | run twice with one operator changed: the unchanged subtree is reused by hash; a port's upstream chain ends at a dataset commit |
| M3 compute, environments, secrets, L | the ComputingUnit CRD and reconciler: master, workers and sandboxes, seeds from a headless Service, service-account tokens exchanged for the owner's token; Runtime Spec on registry rows with compile-time placement; the environment kind built by BuildKit from pylock; OpenBao leases; LiteLLM virtual keys; Lakekeeper vending; the app's unit, environment and credential pages (F3) | computing-unit-managing-service, the PveManager pip path, static S3 keys and USER\_JWT\_TOKEN in pods, the /chat proxy | a unit with one master and two workers; a Python operator that requires a GPU lands on the GPU worker; the pod spec shows no secret env; the lease is revoked after the run |
| M4 agents and MCP, L | the Texera MCP server generated from x-mcp inside the catalog; the agent runtime as a per-agent process with an A2A server, an AG-UI stream and an MCP client; conversations and messages in the catalog; the template, skill and MCP server kinds; the spawn API; a sandbox node per agent; approvals as input-required; the app's chat over AG-UI with the mode picker, and the template, skill and MCP server pages (F4) | agentStore, the custom frames, auth-api.ts, the SQLite store, the X-Agent-Workflow-Id hashing policy | the agent builds and runs a workflow with MCP tools only, then spawns two sub-agents to summarize two port results; the conversation shows three principals and spawned by |
| M5 agent workflows, M | the agent operator type with lifetime; ConversationInput and ConversationOutput; composite templates run once per turn; the built-in Research and Data Analyst modes; an agent-driven LoopEnd; Open Agent Spec Flow export; the app's team view and composite template editor (F5) | - | a Research chat: lead, searcher, analyst and verifier, looped until the verifier accepts, each member's results open as tables beside the chat; the same body is one A2A task to an external caller |
| M6 retire and publish, M | Yjs behind the gateway; OTel on with Python spans; cosign and SBOM; the Helm chart as OCI; RO-Crate and CWL export; the app's co-editing, version history, hub and admin pages (F6); the cutover | the rest of the Dashboard Service, /wsapi/collab, Dropwizard 1.3, the Angular frontend | the single-node stack runs with no Scala process other than the engine and the compiler, and serves one frontend |

Absorbed issues: M0 [#5561](https://github.com/apache/texera/issues/5561); M2 [#5011](https://github.com/apache/texera/issues/5011) and [#5363](https://github.com/apache/texera/issues/5363); M3 [#6870](https://github.com/apache/texera/issues/6870); M4 [#5267](https://github.com/apache/texera/issues/5267), [#5268](https://github.com/apache/texera/issues/5268), [#9075](https://github.com/apache/texera/issues/9075) and [#9122](https://github.com/apache/texera/issues/9122); M5 [#8913](https://github.com/apache/texera/issues/8913), since macros ride the same registry. Sizes are relative: S is days, M a few weeks, L a quarter for one engineer, XL more than that and the item to split first.

### Concrete examples

**One envelope, one API.** The catalog API in TypeSpec; the emitter produces OpenAPI 3.1 and the TypeScript, Java and Go clients, which replaces the hand-kept DTOs.

```typescript
model Resource<Spec> {
  apiVersion: "catalog.texera.apache.org/v1";
  kind: ResourceKind;
  metadata: { rid: uuid; name: string; project: uuid; owner: uuid; visibility: "private" | "public"; version: int32 };
  spec: Spec;
  status?: Record<unknown>;
}
@route("/catalog/v1/{kind}/{rid}") op get(@path kind: ResourceKind, @path rid: uuid): Resource<unknown>;
@route("/catalog/v1/{kind}/{rid}/versions/{vno}") op getVersion(@path kind: ResourceKind, @path rid: uuid, @path vno: int32): ResourceVersion;
@route("/access/v1/evaluation") op evaluate(subject: Principal, action: string, resource: uuid): { decision: boolean };
```

**A unit is a cluster.** The CRD the unit operator reconciles. The engine's cluster mode takes its seeds from the headless Service instead of checkip.amazonaws.com.

```yaml
apiVersion: compute.texera.apache.org/v1alpha1
kind: ComputingUnit
metadata: { name: cu-7f3a, namespace: texera-units }
spec:
  owner: { pid: 0f9c... }      # sponsor of the unit's service-account identity
  image: ghcr.io/apache/texera-workflow-execution-coordinator@sha256:...
  nodes:
    - { name: master,  role: master,  capacity: { cpu: 2, memory: 8Gi } }
    - { name: w-cpu,   role: worker,  replicas: 2, capacity: { cpu: 4, memory: 16Gi } }
    - { name: w-gpu,   role: worker,  capacity: { cpu: 8, memory: 32Gi, gpu: { class: a10g, count: 1 } } }
    - { name: sandbox, role: sandbox, runtimeClass: gvisor, network: egress-allowlist, capacity: { cpu: 1, memory: 2Gi } }
status: { phase: Ready, seeds: ["pekko://Amber@cu-7f3a-master.cu-7f3a.texera-units.svc:2552"] }
```

**Requirements travel with the operator type; placement happens at compile time.** A registry row, published by the compiler at start-up for each of the 166 types plus `agent`:

```json
{ "type": "PythonUDFV2", "image_digest": "sha256:9c1e...",
  "requires": { "runtime": { "name": "python", "version": ">=3.11,<3.13" },
                "environment": "env:rna-seq@3",
                "resources": { "cpu": 2, "memory": "4Gi", "gpu": { "class": "a10g", "count": 1 } },
                "isolation": { "network": "none" } } }
```

The compiler aggregates `requires` over the instances of a workflow version, matches each against the unit's nodes and rejects a unit with the missing field named: `op-12 requires gpu a10g x1; unit cu-7f3a has no node with gpu`.

**The coordinator pattern, both forms.** Static, as a workflow version whose instances bind templates; wrapped in LoopStart and LoopEnd with the condition `$accepted == true`, it repeats until the reviewer agrees:

```json
{ "operators": [
    { "operatorID": "coord",   "operatorType": "Agent", "operatorProperties": { "template": "tpl:coordinator@2" } },
    { "operatorID": "workerA", "operatorType": "Agent", "operatorProperties": { "template": "tpl:literature@5" } },
    { "operatorID": "workerB", "operatorType": "Agent", "operatorProperties": { "template": "tpl:analysis@3" } },
    { "operatorID": "merge",   "operatorType": "Union" },
    { "operatorID": "review",  "operatorType": "Agent", "operatorProperties": { "template": "tpl:coordinator@2" } } ],
  "links": [ "coord:0->workerA:0", "coord:1->workerB:0", "workerA:0->merge:0", "workerB:0->merge:1", "merge:0->review:0" ] }
```

Dynamic, as the coordinator's own template, where the model decides at run time whom to spawn within the policy:

```json
{ "card": { "name": "coordinator", "skills": [ { "id": "plan-and-delegate" } ] },
  "subagents": { "templates": [ "tpl:literature@5", "tpl:analysis@3" ], "maxConcurrent": 2, "maxDepth": 1, "lifetime": "ephemeral" },
  "communication": { "conversations": "own", "a2a": [ "https://peer.lab.edu/agents/curator" ] },
  "requires": { "isolation": { "runtimeClass": "gvisor", "network": "egress-allowlist" }, "resources": { "cpu": 1, "memory": "2Gi" } } }
```

**Grants come out of the four tables once.** The outbox drainer turns rows into OpenFGA tuples in the same transaction:

```sql
INSERT INTO access_outbox(object, relation, subject)
SELECT 'resource:' || r.rid,
       CASE WHEN a.privilege = 'WRITE' THEN 'editor' ELSE 'viewer' END,
       'user:' || p.pid
FROM workflow_user_access a
JOIN resource r  ON r.legacy_wid = a.wid
JOIN principal p ON p.legacy_uid = a.uid
WHERE a.privilege <> 'NONE';
-- the same for dataset_user_access, model_user_access and computing_unit_user_access;
-- owners become resource#owner; is_public becomes resource#viewer@principal:*;
-- every migrated resource lands in its owner's home project
```

**The CU reports lineage in OpenLineage; the catalog stores it at port level.** One event per operator run, with two Texera facets:

```json
{ "eventType": "COMPLETE", "eventTime": "2026-11-02T20:41:03Z",
  "run": { "runId": "e-91c2...", "facets": { "texera_execution": { "eid": 3321, "workflow": "wf:7d2e@14", "unit": "cu:7f3a" } } },
  "job": { "namespace": "texera", "name": "wf:7d2e/op-12" },
  "inputs":  [ { "namespace": "texera", "name": "e-91c2/op-9/0",  "facets": { "texera_port": { "table": "wh.e3321.op9_0",  "snapshot": 7731 } } } ],
  "outputs": [ { "namespace": "texera", "name": "e-91c2/op-12/0", "facets": { "texera_port": { "table": "wh.e3321.op12_0", "snapshot": 7744, "hash": "sha256:...", "tuples": 18200 } } } ] }
```

**The gateway verifies identity once; the PDP decides once.**

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
spec:
  targetRefs: [ { group: gateway.networking.k8s.io, kind: HTTPRoute, name: texera-api } ]
  jwt:
    providers:
      - name: keycloak
        issuer: https://id.texera.example/realms/texera
        remoteJWKS: { uri: https://id.texera.example/realms/texera/protocol/openid-connect/certs }
        claimToHeaders: [ { claim: sub, header: x-principal } ]
  extAuth: { http: { backendRef: { name: catalog, port: 8090 }, path: /access/v1/ext-authz } }
```

### Decisions to take before M1

Taken on 2026-11-02: AG-UI 1.0 over SSE for the chat stream; about fifteen curated MCP tools generated from x-mcp, with Code Mode as a later addition; frontend-next is the only frontend and Angular gets no further work; the agent runtime stays on TypeScript and AI SDK 7 with no framework; the sandbox is an interface with a local provider until M3; observability is the OpenTelemetry API everywhere now and the chart's backends at M6.

Still open:

- Go for the catalog and the unit operator, or the JVM with Kotlin and the Java SDKs for the same standards. The plan assumes Go; the case for it is under Target components.
- OpenBao as the vault, or Kubernetes Secrets with an operator until a lab needs cloud roles.
- The default lifetime of spawned agents, execution or conversation, and the retention policy for port results.
- Whether project owners get can\_share and can\_delete over everything below them, as the OpenFGA model drafts it.

One rule for every milestone: no new kind gets its own access table or version table, and no service verifies a token with a shared secret.

## Frontend: the chat-first app

The prototype in `frontend-next/` (worktree `feat/frontend-next-poc`; 8,300 lines; React 19, Vite 8, TanStack Router and Query, Zustand, AI SDK 7, Base UI, React Flow, Tailwind 4) runs one slice end to end on the real stack: attach a CSV, ask for a workflow, watch the agent build and run it, open the result beside the chat. It becomes the only frontend. Angular gets no further work: the deployed stack keeps serving it unchanged until the cutover, nothing in it is ported, and its directory is deleted when the app becomes the default. What a review of every file found:

| Area | Verdict | Evidence |
| --- | --- | --- |
| shell: sidebar, page, resizable panel, command menu | keep | 394 lines; the panel opens any kind beside the chat (`app/AppShell.tsx:86-98`); the command menu fetches all five kinds client-side (`app/CommandMenu.tsx:32,70`) and moves to catalog search |
| resource registry | rework | the shape is right, one entry per kind with slug, icon, lazy Card and View and prefetch (`features/resources/registry.tsx:46-114`); the `Resource` type and the five hand-written adapters (`features/resources/api.ts:56-153`, an N+1 over workflows at `:94-123`) give way to the generated envelope types, with `payload` typed per kind instead of `unknown` |
| chat | rework | AI SDK UI message stream over SSE (`features/chat/ChatView.tsx:77-97`, `agent-service/src/chat/chat-agent.ts:127-128`); keep `useChat`, `MessageItem` and the parts, replace the transport with AG-UI, replace the tool-name label table (`features/chat/parts/ToolPart.tsx:30-43`) with typed resource parts; no modes, one system prompt (`chat-prompt.ts:26-43`); no regenerate or branch |
| workflow editor | keep | `graph.ts`, `plan.ts`, `properties/schema.ts` and `compile.interpret` are pure TypeScript with no React import, ready to become `@texera/workflow-model`; `editor.ts` autosaves whole content every 800 ms (`features/workflow/editor.ts:69-72`) and moves to a catalog version write; `PropertyForm.tsx` is 522 lines and loses its native selects and textareas |
| execution | keep the engine client, rework the target | `engine.ts` speaks the engine WebSocket verbatim (`features/execution/engine.ts:187-203`); the token travels as a query parameter (`:147`) and a unit is auto-created with `NaN` limits (`features/execution/target.ts:81-94`); both go when units are catalog resources |
| design system | keep the tokens, grow the components | oklch tokens for light and dark with per-kind accents (`styles/globals.css:29-88`), no hex in TSX; five primitives only, so tabs are hand-rolled three times and selects are native; 18 uses of `text-[10px]` and `text-[11px]` want a token |
| auth | rework | the JWT sits in localStorage shared with Angular (`features/auth/session.ts:20-29`); `session.ts` is the one seam, and OIDC with PKCE replaces it |
| data layer | replace | 33 hand-coded endpoint strings and hand-mirrored DTOs across ten files (`features/workflow/types.ts:20-21`); the generated client removes all of them and the `queryOptions` pattern stays |
| security | keep | strict CSP with Trusted Types (`security-headers.ts:30-46`); workflow HTML only in an opaque-origin sandbox (`components/data/SandboxedFrame.tsx:43-60`); the frame's `connect-src https:` narrows to the storage origins |
| build and tests | keep, add | Vite 8, TypeScript 7 strict, Biome, Vitest; 8 unit test files, none for components or the chat; two real-stack Playwright scripts without a runner |

Target architecture, by layer:

| Layer | Choice | Standard or library | Why |
| --- | --- | --- | --- |
| framework | React 19, TypeScript, Vite 8, Bun | - | the prototype; the comparison doc holds the measurements |
| routing and server state | TanStack Router and Query | - | file routes, loaders that prefetch, one cache for every kind |
| API | generated client and hooks from the catalog's OpenAPI | `@hey-api/openapi-ts`, MIT | no DTO or endpoint string in the app; drift fails the build |
| chat | AG-UI 1.0 over SSE from the agent runtime | `@ag-ui/core`, `@ag-ui/client`, MIT | one request in, typed events out: text, tool calls, state as JSON Patch, steps, subagents, interrupts for approval; first-party integrations from Microsoft Agent Framework, Google ADK, LangGraph, Mastra and Pydantic AI, so a lab's own agent plugs in |
| live runs | the engine WebSocket, typed from `engine.tsp` in the contract | generated TypeScript unions and JSON Schema; Scala contract tests on the engine side | replaces the hand-mirrored event types in `engine.ts` without rewriting the engine's web layer |
| identity | OIDC authorization code with PKCE against Keycloak; access token in memory, refresh by the IdP | `oidc-client-ts`, Apache-2.0 | no JWT in localStorage, no token in a URL |
| UI primitives | Base UI with tokens | `@base-ui/react`, MIT; shadcn/ui's default since 2026 | accessible, unstyled, render-prop composition; the prototype is already on it |
| canvas, code, grids | React Flow; CodeMirror 6 loaded on demand; TanStack Table and Virtual | MIT | JointJS (MPL-2.0) leaves the dependency list |
| styling | Tailwind 4 with oklch tokens, light and dark, a density setting | - | the prototype's tokens plus `text-2xs`, focus-ring and spacing scales |
| markdown and charts | Streamdown; Plotly and Vega HTML in the sandboxed frame | Apache-2.0 | - |

Information architecture. It is a chat app, and every resource the chat touches is a first-class page:

- Left rail: projects, then conversations grouped by project, then the library (workflows, datasets, runs, units, templates, environments, credentials). New chat opens the mode picker: the templates the person can read, with each card's name, description and skills and the project it belongs to.
- Center: the conversation. Assistant messages carry text, tool parts rendered as resource cards (`{kind, rid, vno}` from the envelope, never a tool name), subagent strips for teams, and approval requests when a run finishes with an interrupt.
- Right: the resource panel. A card opens its kind beside the chat: the workflow canvas with live operator state, a dataset's files and table preview, an execution's port results and lineage chain, a template's sections, a unit's nodes. The same component renders the full page.
- URLs: `/c/{rid}` conversation, `/p/{rid}` project, `/w/{rid}` and `/w/{rid}@{vno}` workflow, `/d/{rid}` dataset, `/x/{eid}` execution, `/t/{rid}` template, `/u/{rid}` unit; the open panel is a search parameter, so every view is a link.

Rules that keep it clean, enforced in CI:

- One registry entry per kind and generated types only; a kind with hand-written fetch code fails review.
- Tokens only: no hex and no arbitrary pixel values outside the token files; light and dark from the same tokens.
- Budgets: initial JavaScript under 300 KB compressed, with every route and the canvas, code editor and grid as lazy chunks; a 400-operator workflow opens in under one second and drags under 20 ms per frame on the bench harness; no heap growth across ten open-close cycles of the editor.
- Accessibility: Base UI primitives only, keyboard paths for the canvas, Lighthouse accessibility at 95 or better.
- Security: the prototype's CSP and Trusted Types, workflow HTML in the opaque-origin frame with `connect-src` limited to the storage origins.
- Tests: Vitest for the pure model and the components, Playwright against the single-node stack in CI, contract tests from the OpenAPI document.
- ASF: a LICENSE-binary manifest from the Vite build, checked like the Angular one; Category A dependencies only.

Frontend track, one row per milestone:

| Milestone | The app delivers | Proof |
| --- | --- | --- |
| F0 with M0 | OIDC login with PKCE, the shell, the tokens, the generated client wired to the first catalog routes | log in with ORCID, see the library, open a workflow |
| F1 with M1 | projects, library and share dialogs on the generated client; every kind through the registry; catalog search in the command menu | share a nested project with a group from the app; a non-member's link gets the 403 page |
| F2 with M2 | the execution page with port results and the lineage chain; run compare; the editor essentials: undo and redo, copy and paste, property validation, the UDF code editor loaded on demand | click a port result and walk upstream to the dataset commit; write and run a Python UDF in the app |
| F3 with M3 | units with their nodes, environments from pylock, credentials; dataset uploads with progress and new versions | create a unit with a GPU worker and watch its nodes come up |
| F4 with M4 | chat over AG-UI with the mode picker; template, skill and MCP server pages; approvals as interrupts | start a Research chat, approve a tool call, see the spawned sub-agents |
| F5 with M5 | the team view in chat; the composite template editor, which is the workflow editor with agent operators | open the Research body beside the chat and watch each member's results per turn |
| F6 with M6 | Yjs co-editing through the gateway, version history, the hub and admin pages; the app becomes the default and the Angular directory is deleted | two people edit one workflow; the single-node stack serves one frontend |

### Code organization

Workspaces in one repository; generated code is committed and diff-checked in CI:

```text
api/                        catalog.tsp, engine.tsp, json-schema/ (runtime-spec, agent-template, computing-unit), openfga/model.fga
gen/                        the outputs of `make generate`: openapi/, go/, ts/, java/
catalog/                    Go, new
unit-operator/              Go, new
agent-runtime/              TypeScript, AI SDK 7; agent-service/ rewritten in place: a2a/, ag-ui/, mcp/, skills/, team/, tools/, sandbox/
frontend-next/              the one React frontend: routes/, shell/, main.tsx; composition only. Renamed frontend/ at the cutover, when the Angular directory goes
packages/
  catalog-client/           generated: types, client, Query hooks, Zod; used by the frontend and agent-runtime
  engine-protocol/          generated from engine.tsp: the WebSocket request and event unions; used by the frontend and agent-runtime
  workflow-model/           pure TypeScript: graph, link rules, schema to form model, plan; used by the frontend and agent-runtime
  ui/                       tokens, Base UI primitives, icons, layout: Shell, PanelStack, ResourceHeader
  kinds/                    one folder per resource kind, and the registry
  chat/                     the AG-UI client, the conversation reducer, the message parts, the composer
amber/                      Scala, kept: the Amber engine, ComputingUnitMaster and ComputingUnitWorker, the WebSocket API, the sync run endpoint
common/workflow-core/       Scala, kept: tuples, schemas, storage, the engine's protobuf
common/workflow-operator/   Scala, kept: the operator library; LoopStart and LoopEnd today, Agent, ConversationInput and ConversationOutput at M5
common/workflow-compiler/   Scala, kept: the one compiler library; placement by Runtime Spec at M3
workflow-compiling-service/ Scala, kept as the thin host of that library for the frontend's schema propagation and the catalog's validate_workflow
common/pybuilder/           kept: builds the Python and R runtime environments, from pylock at M3
file-service/               Scala, kept: lakeFS and S3 behind the catalog's dataset kind
pyright-language-service/   kept: the language server behind the UDF code editor
notebook-migration-service/ kept, out of scope
common/auth, dao, resource  Scala, retired with the Dashboard Service, access-control-service, computing-unit-managing-service and config-service
frontend/                   Angular, deleted at the cutover; frontend-next/ takes the name
bin/, sql/                  deployment, the single-node stack, the chart, migrations
```

Three generated packages carry every wire type: the catalog client, the engine protocol, and the AG-UI and A2A types from their SDKs. Operator property forms need no generation; they render the operator's JSON Schema at run time. The agent runtime imports the same `catalog-client` and `workflow-model`, so an agent's edit and a person's edit obey one set of link rules.

One module per kind. Each folder under `packages/kinds` exports a `KindSpec`, `{ kind, label, icon, accent, Card, Panel, Page, actions, queries }`, and the registry is the only place that maps a kind to code. `ResourceView` takes `{ ref: { kind, rid, vno? }, mode: "card" | "panel" | "page" }` and resolves through the registry, so the chat, the library, the panel and the page render one component at three sizes. The card is the smallest: icon, name, one meta line, a status chip, and two actions, open beside and expand. The panel adds the header with breadcrumb, the kind's actions and share, then the kind's body: the canvas with live operator state for a workflow, files and a table preview for a dataset, port results and the lineage chain for an execution, the sections for a template, the nodes for a unit. The page is the panel at full width with its own route. Adding a kind is one folder and one registry line.

Chat on the same parts. `packages/chat` turns the AG-UI stream into a conversation view model and renders it with part components: `TextPart` through Streamdown, `ReasoningPart`, `ToolCallPart` with status, arguments and result, `SubagentPart` as the team strip, `ApprovalPart` for an interrupt, `StatePart` for the live draft. A tool result that carries a resource reference renders `ResourceView` in card mode, never a tool name. A card's open-beside pushes onto the `PanelStack`, expand navigates to the page, and the open panel lives in the URL, so a chat link reopens the same view. The StateDelta events of a workflow-building turn feed the draft the workflow panel shows, so the person watches the agent's edits on the canvas as they stream.

Design in one place. `packages/ui` holds the tokens (color, type, space, radius, motion, density) as CSS variables with light and dark from one set, the per-kind accents, and the primitives on Base UI: Button, Menu, Tabs, Select, Dialog, Toast, Tooltip, Popover, Input, Badge, Skeleton, Kbd, Avatar. No kind module defines a color or a size; it composes primitives and tokens. Ladle renders every primitive and every kind at all three sizes in both themes, and the visual diff runs in CI.

## Who else is in this space

Six groups overlap the target as of late October 2026. None covers it, and what each lacks is similar.

| Group | Examples | Strong at | Missing for the target |
| --- | --- | --- | --- |
| AI-scientist products | [Edison Scientific](https://docs.edisonscientific.com/) with Kosmos and the former FutureHouse agents; [Gemini for Science](https://blog.google/innovation-and-ai/technology/research/gemini-for-science-io-2026/), gradual Labs access since I/O 2026; [Claude Science](https://www.anthropic.com/news/claude-science-ai-workbench), beta since 2026-06-30; [Phylo Biomni Lab](https://phylo.bio/biomni); Shanghai AI Lab's [InkStone](https://discovery.intern-ai.org.cn/); OpenAI's [Prism](https://techcrunch.com/2026/01/27/openai-launches-prism-a-new-ai-workspace-for-scientists/), now with a [migration guide to Codex](https://help.openai.com/en/articles/20001615-prism-to-codex-migration-guide) | Literature, analysis and cited reports in one loop; findings traced to code or passage | Thin collaboration: Claude Science keeps projects, files and history on one computer; closed SaaS or vendor-run on-prem |
| Enterprise science platforms | [Microsoft Discovery](https://learn.microsoft.com/azure/microsoft-discovery/concept-discovery-agent), GA 2026-06-02; DP Technology's [Bohrium with SciMaster](https://arxiv.org/abs/2512.20469) | Closest to the full vision: shared projects, agents as immutable versions bound to projects, tools, knowledge bases, HPC | Closed; tied to one vendor's cloud |
| Science platforms adding agents | [Galaxy](https://docs.galaxyproject.org/en/latest/releases/26.1_announce_user.html), MIT since February 2026, GalaxyAI and a built-in MCP server in 26.1; [Code Ocean](https://docs.codeocean.com/user-guide/aqua-and-agents-guide) with its Aqua agent; [Seqera Co-Scientist](https://seqera.io/blog/copilot-to-co-scientist/); Latch, Benchling, DNAnexus, Synapse | Domain scientists, reproducible runs, lineage per run | Agents are recent assistants; Galaxy shares one object at a time; the rest are closed |
| Data platforms with agents | [Databricks Genie and Unity Gateway](https://databricks.com/blog/whats-new-unity-catalog-data-ai-summit-2026); Snowflake CoWork; Dataiku; Hex; Deepnote; [KNIME](https://docs.knime.com/ap/5.11/ai/agents/turn-a-workflow-into-a-tool); [Jupyter AI 3](https://github.com/jupyterlab/jupyter-ai/releases/tag/v3.0.0); marimo; Posit | One catalog governing data, models, agents, MCP servers and skills with lineage, shipped by Databricks in June 2026 | Built for analysts and engineers; governance closed or paid; the open ones are notebooks |
| Open research agents and tool ecosystems | [Biomni](https://github.com/snap-stanford/Biomni); [ToolUniverse](https://github.com/mims-harvard/ToolUniverse), over 1,000 MCP tools; [K-Dense Scientific Agent Skills](https://github.com/K-Dense-AI/scientific-agent-skills), 177 skills; [Ai2 Asta](https://allenai.org/asta); InternAgent | Open methods, tools and skills in the standards Texera would adopt | Single-user libraries; no multi-user governance or lineage |
| Agent control planes | [AWS AgentCore](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available); Microsoft Agent 365 with [Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id); [Google Gemini Enterprise Agent Platform](https://docs.cloud.google.com/iam/docs/agent-identity-overview); [OpenAI Frontier](https://openai.com/index/introducing-openai-frontier/); [GitHub Agent HQ](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/); open source: [LibreChat](https://www.librechat.ai/docs/features/access_control), [Dify](https://github.com/langgenius/dify/blob/main/LICENSE), Open WebUI, Sim | Agents as owned principals, gateway policy, registries, immutable versions | No research data, compute or lineage; the open ones have no agent identity, so agents run with the caller's credentials |

The closest closed analogs are Microsoft Discovery, for its agent and project model, and Code Ocean, for governed, reproducible units that non-coders drive through an agent. The open peer to watch is Galaxy: MIT-licensed, built for biologists, and since 26.1 routing both its own agents and outside agents through one authorized MCP layer.

Texera's real differences:

- An interactive dataflow engine that shows results per operator
- Table and file versioning on Iceberg and lakeFS
- The chance to govern the whole graph rather than one object at a time

## Sources

Pages opened between 2026-10-29 and 2026-11-02.

- [Edison Scientific docs](https://docs.edisonscientific.com/)
- [Gemini for Science, Google I/O 2026](https://blog.google/innovation-and-ai/technology/research/gemini-for-science-io-2026/)
- [Claude Science announcement](https://www.anthropic.com/news/claude-science-ai-workbench) and [core concepts](https://claude.com/docs/claude-science/core-concepts)
- [Phylo Biomni Lab](https://phylo.bio/biomni) and [Biomni](https://github.com/snap-stanford/Biomni)
- [OpenAI Prism launch](https://techcrunch.com/2026/01/27/openai-launches-prism-a-new-ai-workspace-for-scientists/) and [Prism to Codex migration guide](https://help.openai.com/en/articles/20001615-prism-to-codex-migration-guide)
- [Intern Discovery, Shanghai AI Lab](https://discovery.intern-ai.org.cn/)
- [Microsoft Discovery GA](https://azure.microsoft.com/en-us/blog/announcing-microsoft-discovery-general-availability-and-microsoft-discovery-app-preview/) and [agent concepts](https://learn.microsoft.com/azure/microsoft-discovery/concept-discovery-agent)
- [Bohrium and SciMaster, arXiv 2512.20469](https://arxiv.org/abs/2512.20469)
- [Galaxy 26.1 release](https://docs.galaxyproject.org/en/latest/releases/26.1_announce_user.html) and [Galaxy license](https://github.com/galaxyproject/galaxy/blob/dev/LICENSE.txt)
- [Code Ocean Aqua and agents](https://docs.codeocean.com/user-guide/aqua-and-agents-guide)
- [Seqera Co-Scientist](https://seqera.io/blog/copilot-to-co-scientist/)
- [Databricks Unity Catalog at Data and AI Summit 2026](https://databricks.com/blog/whats-new-unity-catalog-data-ai-summit-2026)
- [KNIME: turn a workflow into a tool](https://docs.knime.com/ap/5.11/ai/agents/turn-a-workflow-into-a-tool)
- [Jupyter AI 3.0](https://github.com/jupyterlab/jupyter-ai/releases/tag/v3.0.0)
- [ToolUniverse](https://github.com/mims-harvard/ToolUniverse), [K-Dense Scientific Agent Skills](https://github.com/K-Dense-AI/scientific-agent-skills), [Ai2 Asta](https://allenai.org/asta)
- [Entra Agent ID](https://learn.microsoft.com/en-us/entra/agent-id/whats-new-agent-id)
- [Google Cloud agent identity](https://docs.cloud.google.com/iam/docs/agent-identity-overview)
- [GitHub agent control plane GA](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/), [per-operation agent permissions](https://github.blog/changelog/2026-09-09-enterprise-managed-permissions-for-github-copilot-agent-operations/), [custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [AgentCore Policy GA](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available)
- [OpenAI Frontier](https://openai.com/index/introducing-openai-frontier/) and [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- [Letta's next phase](https://www.letta.com/blog/our-next-phase/)
- [Agentic AI Foundation projects](https://aaif.io/news/agentic-ai-foundation-announces-four-new-projects)
- [LibreChat access control](https://www.librechat.ai/docs/features/access_control) and [Dify license](https://github.com/langgenius/dify/blob/main/LICENSE)
- [Agent Skills specification](https://agentskills.io/specification), [MCP Registry](https://github.com/modelcontextprotocol/registry), [A2A specification](https://a2a-protocol.org/latest/specification/)
- [Kubernetes image volumes, KEP-4639](https://www.kubernetes.dev/resources/keps/4639/) and [dynamic resource allocation](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
- Texera issues: [#8913](https://github.com/apache/texera/issues/8913), [#9075](https://github.com/apache/texera/issues/9075), [#8011](https://github.com/apache/texera/issues/8011), [#8711](https://github.com/apache/texera/issues/8711), [#9122](https://github.com/apache/texera/issues/9122), [#5267](https://github.com/apache/texera/issues/5267), [#5561](https://github.com/apache/texera/issues/5561)

Catalog storage, opened 2026-11-02:

- [Polaris metastores](https://polaris.apache.org/releases/1.8.0/metastores/) and [Polaris JDBC schema](https://github.com/apache/polaris/blob/main/persistence/relational-jdbc/src/main/resources/postgres/schema.sql)
- [Gravitino relational backend](https://github.com/apache/gravitino/blob/main/docs/how-to-use-relational-backend-storage.md)
- [Unity Catalog server configuration](https://docs.unitycatalog.io/server/configuration/)
- [OpenMetadata high-level design](https://docs.open-metadata.org/latest/main-concepts/high-level-design)
- [DataHub metadata serving](https://docs.datahub.com/docs/architecture/metadata-serving)
- Texera code read on `main` at a46ddc6eb: `common/auth/.../JwtAuth.scala`, `access-control-service/.../AccessControlResource.scala`, `sql/texera_ddl.sql`

Execution, compute, credentials and MCP, opened 2026-11-02:

- [MCP specification 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog): stateless protocol, tasks extension, subscriptions/listen, Client ID Metadata Documents
- [Keycloak 26.2: standard token exchange](https://www.keycloak.org/2025/05/standard-token-exchange-kc-26-2)
- [LiteLLM: HashiCorp Vault secret manager](https://docs.litellm.ai/docs/secret_managers/hashicorp_vault) and [custom secret managers](https://docs.litellm.ai/docs/secret_managers/custom_secret_manager.md)
- Texera main: `sql/texera_ddl.sql` (`operator_port_executions`, `operator_port_cache`, `workflow_computing_unit`, `cu_image`, `user_warehouse`), `VFSURIFactory.scala`, `ComputingUnitManagingResource.scala`, `bin/k8s/templates/base/gateway/gateway-security-policy.yaml`; branch `deployment/dknet-ai-agent`: `agent-service/src/agent/mcp/mcp-client-manager.ts`, `bio-mcp-service`

Runtime requirements and agent templates, opened 2026-11-02:

- [A2A protocol specification](https://a2a-protocol.org/latest/specification/) (v1.0, March 2026, Linux Foundation): Agent Card, Task, Message, signatures
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox): SIG Apps Sandbox CRD over gVisor and Kata RuntimeClasses, alpha in 2026
- [Open Agent Specification](https://github.com/oracle/agent-spec) (Oracle, Agents and Flows) and its [technical report](https://arxiv.org/abs/2510.04173)
- [CWL requirements](https://www.commonwl.org/v1.2/CommandLineTool.html#ResourceRequirement): ResourceRequirement, SoftwareRequirement, DockerRequirement; [GA4GH TES](https://github.com/ga4gh/task-execution-schemas) resources
- Texera main: `amber/src/main/scala/org/apache/texera/amber/clustering/ClusterListener.scala`, `engine/architecture/common/ExecutorDeployment.scala`, `engine/architecture/scheduling` (region plan, resource allocation)

Orchestration formats and SDKs for the plan (2026-11-02); the code survey covered `main` at 07fffb3d5 and the worktrees feat-incorporate-mcps, feat-frontend-next-poc, feat-5267-agent-service-persistence, feat-5268-agent-service-access-control, refactor-remove-litellm-proxy-access-control and refactor-unify-workflow-compiler.

- [Open Agent Spec flows API](https://oracle.github.io/agent-spec/api/flows.html): Start, End, LLM, Agent, Tool, Branching and Map nodes; the export target for agent workflows
- [Microsoft Agent Framework declarative workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative): YAML workflows, preview
- [Google ADK workflow agents](https://google.github.io/adk-docs/agents/workflow-agents): Sequential, Parallel and Loop agents beside LLM-driven delegation
- [Serverless Workflow 1.0.0](https://serverlessworkflow.netlify.app/blog/releases/release-100): a generic control-flow DSL, no agent or data model
- [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk): v1.7 tracks the 2026-07-28 revision; client OAuth still marked experimental
- [a2a-go](https://github.com/a2aproject/a2a-go): A2A 1.0 server and client for Go, module path v2
- [OpenLineage 1.46.0](https://openlineage.io/docs/releases/1_46_0): the official Go client, April 2026

API generation, chat transport and frontend, opened 2026-11-02; the frontend review covered every file under `frontend-next/src` and `agent-service/src/chat` in worktree `feat/frontend-next-poc`:

- [TypeSpec OpenAPI 3 emitter options: openapi-versions, output-file, seal-object-schemas, enum-strategy](https://github.com/microsoft/typespec/blob/main/packages/openapi3/README.md)
- [typespec-mcp, archived 2026-08-27](https://github.com/microsoft/typespec-mcp)
- [oapi-codegen releases: 2.8.0 initial OpenAPI 3.1, 2.8.1 strict-server binding fix](https://github.com/oapi-codegen/oapi-codegen/releases)
- [@hey-api/openapi-ts, MIT, TanStack Query plugin](https://github.com/hey-api/openapi-ts)
- [ogen-mcp: a Code Mode server from OpenAPI, GPL-3.0](https://pkg.go.dev/github.com/ethpandaops/ogen-mcp)
- [Speakeasy: a comparison of MCP server generators](https://www.speakeasy.com/blog/comparison-mcp-server-generators)
- [Stainless: lessons from converting OpenAPI specs to MCP servers](https://www.stainless.com/blog/what-we-learned-converting-complex-openapi-specs-to-mcp-servers)
- [Anthropic: code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP Apps extension, SEP-1865, stable 2026-01-26](https://modelcontextprotocol.io/community/working-groups/apps.md)
- [Envoy AI Gateway MCP gateway: aggregation, OAuth, tool filtering by claims](https://aigateway.envoyproxy.io/docs/capabilities/mcp/)
- [AG-UI 1.0 specification](https://docs.ag-ui.com/spec/1.0) and [AG-UI events](https://docs.ag-ui.com/concepts/events)
- [ag-ui repository: MIT, integrations, A2A partnership](https://github.com/ag-ui-protocol/ag-ui)
- [CopilotKit A2A middleware: send\_message\_to\_a2a\_agent](https://docs.copilotkit.ai/a2a-protocol)
- [a2a-js 1.0: client streaming, express adapters, extensions](https://github.com/a2aproject/a2a-js)
- [A2A extensions: AgentExtension, the A2A-Extensions header, metadata keyed by URI](https://a2a-protocol.org/latest/topics/extensions/)
- [Agent Skills specification](https://agentskills.io)
- [shadcn/ui on Base UI](https://github.com/shadcn-ui/ui/discussions/9562)

Agent runtime options, opened 2026-11-02:

- [AI SDK 7 changelog: ToolLoopAgent, toolApproval, @ai-sdk/otel, MCP OAuth, sandbox, HarnessAgent](https://vercel.com/changelog/ai-sdk-7)
- [Mastra A2A: v0.3 and v1.0, signed cards, A2AAgent client](https://mastra.ai/docs/agents/a2a)
- [Mastra and CopilotKit over AG-UI](https://mastra.ai/docs/frameworks/agentic-uis/copilotkit)
- [Mastra release 1.81.0, 2026-11-02](https://github.com/mastra-ai/mastra/releases/tag/%40mastra/core%401.81.0)
- [Pydantic AI AG-UI adapter](https://pydantic.dev/docs/ai/integrations/ui/ag-ui/)
- [Pydantic AI MCP client: MCPToolset, OAuth, elicitation, sampling](https://pydantic.dev/docs/ai/mcp/client/)
- [FastA2A, the A2A bridge for Pydantic AI, now a separate repository](https://github.com/datalayer/fasta2a)
- [AG-UI integrations index](https://docs.ag-ui.com/integrations)
- [OpenAI Agents SDK for TypeScript](https://www.npmjs.com/package/@openai/agents)
- [Microsoft Agent Framework release candidate: .NET and Python, A2A, AG-UI, MCP](https://devblogs.microsoft.com/foundry/microsoft-agent-framework-reaches-release-candidate/)
- [Strands Agents TypeScript v0.7.0: A2A](https://strandsagents.com/changelog/harness/typescript-v0.7.0/index.md)
- [ADK for TypeScript](https://github.com/google/adk-js) and [the AG-UI ADK JS integration](https://docs.ag-ui.com/integrations/google-adk-js.md)
- [LangChain JS changelog: deep agents with async subagents](https://docs.langchain.com/oss/javascript/releases/changelog.md)
- [Claude Agent SDK and Managed Agents compared](https://www.truefoundry.com/blog/claude-agent-sdk-vs-claude-managed-agents)
- [Anthropic acquires Bun, MIT license kept](https://simonwillison.net/b/9175)
