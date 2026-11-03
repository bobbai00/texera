// Texera 2.0 catalog contract.
//
// One envelope (Resource + Version + Principal + grant) carries every kind of resource.
// Kind-specific routes return the typed envelope; generic routes return the untyped one.
// Operations tagged `x-mcp` are also exposed as tools by the catalog's MCP server
// (see cmd/mcpgen); the rest stay REST only.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "@typespec/openapi3";
import "./common.tsp";

using Http;
using Rest;
using OpenAPI;

@service(#{ title: "Texera Catalog" })
@info(#{ version: "2.0.0-alpha" })
@server("http://localhost:8080", "the gateway")
@useAuth(BearerAuth)
namespace Texera.Catalog;

// ---------------------------------------------------------------------------
// Identifiers and shared models
// ---------------------------------------------------------------------------

enum ResourceKind {
  project,
  workflow,
  dataset,
  environment,
  computing_unit,
  agent_template,
  mcp_server,
  skill,
  conversation,
}

enum Visibility {
  private,
  public,
}

enum PrincipalKind {
  user,
  agent,
  group,
}

enum Relation {
  owner,
  editor,
  viewer,
}

@error

model Page<T> {
  items: T[];
  @doc("Opaque cursor for the next page; absent on the last page.")
  nextCursor?: string;
}

@doc("Where a resource or version came from: the chat turn that produced it.")
model Origin {
  conversation: Rid;
  seq: int64;
}

model VersionRef {
  rid: Rid;
  vno: Vno;
}

@doc("A reference to a resource (or an execution) as messages and events carry it.")
model ResourceRef {
  @doc("A resource kind, or execution.")
  kind: string;
  rid: string;
  vno?: Vno;
}

model Principal {
  pid: Pid;
  kind: PrincipalKind;
  displayName: string;
  @doc("OIDC subject for users; absent for agents and groups.")
  subject?: string;
  email?: string;
  @doc("The user that manages an agent or a group.")
  sponsor?: Pid;
  createdAt: utcDateTime;
}

model ResourceMetadata {
  rid: Rid;
  name: string;
  description?: string;
  @doc("The containing project; absent only for a top-level project.")
  project?: Rid;
  owner: Pid;
  visibility: Visibility;
  labels?: Record<string>;
  @doc("The newest version number.")
  headVersion: Vno;
  createdBy: Pid;
  onBehalfOf?: Pid;
  origin?: Origin;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

@doc("The untyped envelope, served by the generic routes.")
model Resource {
  apiVersion: "catalog.texera.apache.org/v1";
  kind: ResourceKind;
  metadata: ResourceMetadata;
  spec: Record<unknown>;
  status?: Record<unknown>;
}

@doc("The typed envelope, served by the kind routes.")
model Typed<Spec, Status> {
  apiVersion: "catalog.texera.apache.org/v1";
  kind: ResourceKind;
  metadata: ResourceMetadata;
  spec: Spec;
  status?: Status;
}

model CreateResource<Spec> {
  name: string;
  description?: string;
  @doc("The containing project; defaults to the caller's home project.")
  project?: Rid;
  visibility?: Visibility;
  labels?: Record<string>;
  spec: Spec;
  @doc("Set when an agent creates the resource inside a chat turn.")
  origin?: Origin;
}

model UpdateMetadata {
  name?: string;
  description?: string;
  project?: Rid;
  visibility?: Visibility;
  labels?: Record<string>;
}

enum ContentKind {
  @doc("The content is JSON stored inline.") json,
  @doc("A dataset manifest: files with sizes and hashes under the version's S3 prefix.") manifest,
  @doc("An OCI image digest.") oci_digest,
  @doc("A conversation checkpoint: the message seq.") checkpoint,
}

model ResourceVersion {
  rid: Rid;
  @doc("The kind of the resource this is a version of.")
  kind: ResourceKind;
  vno: Vno;
  contentKind: ContentKind;
  @doc("Reference for non-inline content: an S3 prefix, an OCI digest, a message seq.")
  contentRef?: string;
  @doc("Inline content for `json` and `manifest` kinds.")
  content?: unknown;
  message?: string;
  createdBy: Pid;
  onBehalfOf?: Pid;
  origin?: Origin;
  createdAt: utcDateTime;
}

model CreateVersion {
  @doc("The full content of the new version. Required unless `patch` is given.")
  content?: unknown;
  @doc("An RFC 6902 JSON Patch applied to the head version's content.")
  patch?: unknown[];
  @doc("The head version the caller saw; refused with 409 when it moved.")
  expectedHead?: Vno;
  message?: string;
  origin?: Origin;
}

model Grant {
  rid: Rid;
  principal: Pid;
  relation: Relation;
  createdAt: utcDateTime;
}

model GrantRequest {
  relation: Relation;
}

model VersionEdge {
  from: VersionRef;
  to: VersionRef;
  kind: "derived" | "read" | "produced";
  execution?: Eid;
}

model Lineage {
  @doc("Versions this version was derived from, read, or produced by.")
  upstream: VersionEdge[];
  downstream: VersionEdge[];
}

// ---------------------------------------------------------------------------
// Kind specs
// ---------------------------------------------------------------------------

model ProjectSpec {
  defaultEnvironment?: Rid;
  defaultComputingUnit?: Rid;
}

model ProjectStatus {}

@doc("A workflow's content lives in its versions (the logical plan JSON); the spec holds only pinned defaults.")
model WorkflowSpec {
  defaultEnvironment?: Rid;
  defaultComputingUnit?: Rid;
}

model WorkflowStatus {
  lastExecution?: Eid;
}

model DatasetSpec {
  @doc("Content type hints for the files, free-form.")
  format?: string;
}

model DatasetStatus {
  @doc("Files staged for the next version, not yet committed.")
  stagedFiles: int32;
  bytes: int64;
}

model PythonEnvironment {
  @doc("Python version range, PEP 440, e.g. `>=3.12,<3.13`.")
  version?: string;
  @doc("Package requirements, PEP 508 lines.")
  packages: string[];
}

model EnvironmentSpec {
  python?: PythonEnvironment;
  @doc("Base image for sandboxes and units; absent means the deployment default.")
  baseImage?: string;
}

model EnvironmentStatus {
  @doc("Units that have built this environment version, keyed by unit rid.")
  builtOn?: Record<Vno>;
}

enum ComputingUnitKind {
  @doc("An already running unit reachable at `endpoint`; the dev stack's default.") static,
  @doc("A unit the catalog starts on the local docker daemon.") local,
  @doc("A ComputingUnit custom resource reconciled by the unit operator.") kubernetes,
}

model NodeSpec {
  name: string;
  role: "master" | "worker" | "sandbox";
  cpu?: string;
  memory?: string;
  gpu?: int32;
}

model ComputingUnitSpec {
  unitKind: ComputingUnitKind;
  @doc("For `static`: the unit's base URL inside the cluster, e.g. http://cu-master:8085.")
  endpoint?: string;
  nodes?: NodeSpec[];
  image?: string;
}

model ComputingUnitStatus {
  phase: "pending" | "ready" | "failed" | "terminated";
  @doc("The URL the gateway proxies the unit's WebSocket and HTTP API at.")
  gatewayPath?: string;
  message?: string;
  nodes?: NodeStatus[];
}

model NodeStatus {
  name: string;
  role: "master" | "worker" | "sandbox";
  ready: boolean;
}

model AgentCard {
  name: string;
  description: string;
  skills?: AgentSkillRef[];
}

model AgentSkillRef {
  id: string;
  name?: string;
  description?: string;
}

model ModelSpec {
  @doc("Model name as the LLM gateway knows it, e.g. claude-haiku-5-5.")
  name: string;
  maxOutputTokens?: int32;
  budgetUsd?: float64;
}

model McpBinding {
  @doc("An MCP Server resource, as rid or rid@vno.")
  server: string;
  @doc("Tool names the agent may call; absent means every tool the server exposes.")
  allow?: string[];
}

model SubagentPolicy {
  @doc("Templates this agent may spawn, as rid or rid@vno.")
  templates?: string[];
  maxConcurrent?: int32;
  maxDepth?: int32;
  lifetime?: "execution" | "conversation" | "pinned";
}


@doc("How the runtime's ReAct loop runs the template's agent; the runtime's defaults apply to what is absent.")
model LoopSpec {
  @doc("When a reply without a tool call is the answer: `free`, always; `after_result`, only once a result-showing tool succeeded in the turn, else the reply is sent back with a correction.")
  answer?: "free" | "after_result";
  @doc("Tools whose successful result counts as a shown result; default run_workflow, get_port_result and save_result_as_dataset.")
  resultTools?: string[];
  @doc("Model steps per turn.")
  maxSteps?: int32;
  @doc("Sampling temperature; default 0.2.")
  temperature?: float64;
}

@doc("An agent template: card, model, prompts, skills, tools, requirements, sub-agent policy and, for a composite, the body workflow.")
model AgentTemplateSpec {
  card: AgentCard;
  `model`?: ModelSpec;
  @doc("System prompt and objective, Markdown.")
  prompts?: Record<string>;
  @doc("Skill resources, as rid or rid@vno.")
  skills?: string[];
  tools?: {
    mcp?: McpBinding[];
    @doc("Operator types the agent may use; absent means every operator.")
    operators?: string[];
  };
  loop?: LoopSpec;
  requires?: RuntimeSpec;
  subagents?: SubagentPolicy;
  @doc("Composite only: the workflow whose agent operator instances form the team.")
  body?: VersionRef;
}

model AgentTemplateStatus {}

enum McpTransport {
  streamable_http,
  stdio,
}

model McpServerSpec {
  transport: McpTransport;
  @doc("For streamable_http: the server URL.")
  url?: string;
  @doc("For stdio: the command and arguments, run inside the agent's sandbox.")
  command?: string[];
  @doc("Static headers, e.g. a bearer token reference `secret:...` resolved by the runtime.")
  headers?: Record<string>;
  @doc("Set for the built-in Texera MCP server; the runtime mounts it at the gateway's /mcp.")
  builtin?: boolean;
}

model McpServerStatus {
  @doc("Tool names discovered at the last health check.")
  tools?: string[];
  lastChecked?: utcDateTime;
  reachable?: boolean;
}

@doc("A skill's content (SKILL.md) lives in its versions; the spec is the frontmatter.")
model SkillSpec {
  name: string;
  description: string;
}

model SkillStatus {}

model ConversationSpec {
  @doc("The template the principal agent is spawned from; the chat's mode.")
  template: VersionRef;
  @doc("The computing unit runs in this chat use.")
  computingUnit?: Rid;
  environment?: Rid;
}

model ConversationStatus {
  @doc("The principal agent of this conversation.")
  agent?: Pid;
  messages: int64;
  lastMessageAt?: utcDateTime;
}

// ---------------------------------------------------------------------------
// Messages and agents
// ---------------------------------------------------------------------------

@doc("One message part: text, a tool call, a tool result, a resource reference, or a file.")
model MessagePart {
  type: "text" | "reasoning" | "tool_call" | "tool_result" | "resource" | "file" | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  resource?: ResourceRef;
  file?: Record<unknown>;
}

model Message {
  conversation: Rid;
  seq: int64;
  role: "user" | "assistant" | "system" | "tool";
  author: Pid;
  onBehalfOf?: Pid;
  parts: MessagePart[];
  createdAt: utcDateTime;
}

model PostMessage {
  role: "user" | "assistant" | "system" | "tool";
  parts: MessagePart[];
}

model Agent {
  pid: Pid;
  template: VersionRef;
  spawnedBy?: Pid;
  conversation?: Rid;
  execution?: Eid;
  opid?: string;
  lifetime: "execution" | "conversation" | "pinned";
  status: "active" | "retired";
  createdAt: utcDateTime;
}

model SpawnAgent {
  template: VersionRef;
  conversation?: Rid;
  execution?: Eid;
  opid?: string;
  lifetime?: "execution" | "conversation" | "pinned";
  displayName?: string;
}

// ---------------------------------------------------------------------------
// Operators, compilation, executions, results, lineage
// ---------------------------------------------------------------------------




model CompileRequest {
  @doc("Compile this version; defaults to the head version.")
  vno?: Vno;
  @doc("Compile this content instead of a stored version (unsaved drafts).")
  content?: WorkflowContent;
}

@doc("A port of an operator in a workflow.")
model WorkflowPort {
  @doc("input-<n> or output-<n>.")
  portID: string;
  displayName?: string;
  allowMultiInputs?: boolean;
  isDynamicPort?: boolean;
}

@doc("An operator instance in a workflow.")
model WorkflowOperator {
  @doc("Unique within the workflow, e.g. scan or avg.")
  operatorID: string;
  @doc("An operatorType from the operator registry (list_operators), e.g. CSVFileScan.")
  operatorType: string;
  operatorVersion?: string;
  @doc("Property values following the operator type's JSON Schema. A file property takes a dataset URI dataset://<rid>@<vno>/<path>.")
  operatorProperties: Record<unknown>;
  @doc("Defaults to one input port input-0 (none for sources).")
  inputPorts?: WorkflowPort[];
  @doc("Defaults to one output port output-0.")
  outputPorts?: WorkflowPort[];
  @doc("Store this operator's output so it can be read with get_port_result.")
  viewResult?: boolean;
  markedForReuse?: boolean;
  isDisabled?: boolean;
  customDisplayName?: string;
}

model WorkflowLinkEnd {
  operatorID: string;
  portID: string;
}

@doc("A link from one operator's output port to another's input port.")
model WorkflowLink {
  linkID: string;
  source: WorkflowLinkEnd;
  target: WorkflowLinkEnd;
}

@doc("A workflow version's content: a dataflow graph.")
model WorkflowContent {
  operators: WorkflowOperator[];
  links: WorkflowLink[];
}

@doc("One RFC 6902 JSON Patch operation.")
model JsonPatchOperation {
  `op`: "add" | "remove" | "replace" | "move" | "copy" | "test";
  @doc("A JSON Pointer, e.g. /operators/- to append an operator or /operators/1/operatorProperties/limit.")
  path: string;
  from?: string;
  value?: unknown;
}

@doc("An edit of a workflow: a JSON Patch over the head content, or full new content.")
model EditWorkflow {
  patch?: JsonPatchOperation[];
  content?: WorkflowContent;
  @doc("The head version the caller saw; refused with 409 when it moved.")
  expectedHead?: Vno;
  @doc("What changed, recorded on the new version.")
  message?: string;
}



model RunRequest {
  @doc("The workflow version to run; defaults to the head version.")
  vno?: Vno;
  computingUnit?: Rid;
  environment?: Rid;
  @doc("Per-run inputs, e.g. {conversation, turn}; the version itself stays as authored.")
  parameters?: Record<unknown>;
  origin?: Origin;
  @doc("Wait up to this many seconds for the run to finish before returning.")
  waitSeconds?: int32;
  name?: string;
}



model Execution {
  eid: Eid;
  name?: string;
  workflow: VersionRef;
  environment?: VersionRef;
  computingUnit: Rid;
  actor: Pid;
  onBehalfOf?: Pid;
  origin?: Origin;
  parameters?: Record<unknown>;
  status: ExecutionStatus;
  error?: unknown;
  @doc("Dataset and model versions read, pinned at start.")
  inputs: VersionRef[];
  operators: Record<OperatorRun>;
  results: PortResult[];
  createdAt: utcDateTime;
  startedAt?: utcDateTime;
  finishedAt?: utcDateTime;
}


model DatasetFile {
  path: string;
  size: int64;
  @doc("SHA-256 of the content.")
  sha256?: string;
  contentType?: string;
}

model DatasetManifest {
  files: DatasetFile[];
}

model CommitDataset {
  message?: string;
  origin?: Origin;
}

@doc("Save an execution's port result as a dataset version.")
model SaveResult {
  @doc("The dataset that gets the new version; a new dataset is created when absent.")
  dataset?: Rid;
  @doc("The new dataset's name, when `dataset` is absent.")
  name?: string;
  @doc("The file inside the dataset version; defaults to `<opid>.csv`.")
  path?: string;
  @doc("What the version holds, recorded on it.")
  message?: string;
}

model FileLink {
  @doc("A presigned URL valid for `expiresInSeconds`.")
  url: string;
  expiresInSeconds: int32;
}

// OpenLineage RunEvent, the subset the engine posts and the catalog stores.




// ---------------------------------------------------------------------------
// Named envelopes per kind (so generated clients get Workflow, Dataset, ... types)
// ---------------------------------------------------------------------------

model Project is Typed<ProjectSpec, ProjectStatus>;
model ProjectPage is Page<Project>;
model CreateProjectRequest is CreateResource<ProjectSpec>;

model Workflow is Typed<WorkflowSpec, WorkflowStatus>;
model WorkflowPage is Page<Workflow>;
model CreateWorkflowRequest is CreateResource<WorkflowSpec>;

model Dataset is Typed<DatasetSpec, DatasetStatus>;
model DatasetPage is Page<Dataset>;
model CreateDatasetRequest is CreateResource<DatasetSpec>;

model Environment is Typed<EnvironmentSpec, EnvironmentStatus>;
model EnvironmentPage is Page<Environment>;
model CreateEnvironmentRequest is CreateResource<EnvironmentSpec>;

model ComputingUnit is Typed<ComputingUnitSpec, ComputingUnitStatus>;
model ComputingUnitPage is Page<ComputingUnit>;
model CreateComputingUnitRequest is CreateResource<ComputingUnitSpec>;

model AgentTemplate is Typed<AgentTemplateSpec, AgentTemplateStatus>;
model AgentTemplatePage is Page<AgentTemplate>;
model CreateAgentTemplateRequest is CreateResource<AgentTemplateSpec>;

model McpServer is Typed<McpServerSpec, McpServerStatus>;
model McpServerPage is Page<McpServer>;
model CreateMcpServerRequest is CreateResource<McpServerSpec>;

model Skill is Typed<SkillSpec, SkillStatus>;
model SkillPage is Page<Skill>;
model CreateSkillRequest is CreateResource<SkillSpec>;

model Conversation is Typed<ConversationSpec, ConversationStatus>;
model ConversationPage is Page<Conversation>;
model CreateConversationRequest is CreateResource<ConversationSpec>;

model Whoami {
  principal: Principal;
  homeProject: Rid;
}

model PrincipalPage is Page<Principal>;
model CreateWorkflowWithContent {
  name: string;
  description?: string;
  project?: Rid;
  content: WorkflowContent;
  origin?: Origin;
}

model WorkflowWithVersion {
  workflow: Workflow;
  version: ResourceVersion;
}

model ResourcePage is Page<Resource>;
model VersionPage is Page<ResourceVersion>;
model ExecutionPage is Page<Execution>;

// ---------------------------------------------------------------------------
// Access decisions (AuthZEN 1.0)
// ---------------------------------------------------------------------------

model AuthzSubject {
  type: string;
  id: string;
  properties?: Record<unknown>;
}

model AuthzAction {
  name: string;
}

model AuthzResource {
  type: string;
  id: string;
  properties?: Record<unknown>;
}

model AuthzRequest {
  subject: AuthzSubject;
  action: AuthzAction;
  resource: AuthzResource;
  context?: Record<unknown>;
}

model AuthzResponse {
  decision: boolean;
  context?: Record<unknown>;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

@route("/catalog/v1")
namespace Routes {
  @route("/me")
  interface Me {
    @doc("The calling principal and its home project; creates both on first login.")
    @get
    @extension("x-mcp", #{ tool: "whoami", description: "Who am I: the calling principal and home project.", readOnlyHint: true })
    get(): Whoami | Error;
  }

  @route("/principals")
  interface Principals {
    @get list(@query q?: string, @query kind?: PrincipalKind, @query limit?: int32): Ok<PrincipalPage> | Error;
    @get read(@path pid: Pid): Principal | Error;
  }

  @route("/resources")
  interface Resources {
    @doc("Search resources the caller may read.")
    @get
    @extension("x-mcp", #{ tool: "search_resources", description: "Search the catalog for resources the caller can read: workflows, datasets, templates, units, environments, conversations. Filter by kind, project or text.", readOnlyHint: true })
    search(
      @query q?: string,
      @query kind?: ResourceKind,
      @query project?: Rid,
      @query origin?: Rid,
      @query limit?: int32,
      @query cursor?: string,
    ): Ok<ResourcePage> | Error;

    @get
    @route("/{rid}")
    @extension("x-mcp", #{ tool: "get_resource", description: "Get one resource by rid, with its metadata, head version number and spec.", readOnlyHint: true })
    read(@path rid: Rid): Resource | Error;

    @patch @route("/{rid}") updateMetadata(@path rid: Rid, @body body: UpdateMetadata): Resource | Error;

    @delete @route("/{rid}") delete(@path rid: Rid): void | Error;

    @get
    @route("/{rid}/versions")
    @extension("x-mcp", #{ tool: "list_versions", description: "List the versions of a resource, newest first.", readOnlyHint: true })
    listVersions(@path rid: Rid, @query limit?: int32, @query cursor?: string): Ok<VersionPage> | Error;

    @get
    @route("/{rid}/versions/{vno}")
    @extension("x-mcp", #{ tool: "get_version", description: "Get one version of a resource with its content.", readOnlyHint: true })
    readVersion(@path rid: Rid, @path vno: Vno): ResourceVersion | Error;

    @doc("Create a new version from full content or a JSON Patch to the head.")
    @post
    @route("/{rid}/versions")
    createVersion(@path rid: Rid, @body body: CreateVersion): ResourceVersion | Error;

    @get
    @route("/{rid}/lineage")
    @extension("x-mcp", #{ tool: "get_lineage", description: "Get the lineage of a resource version: what it was derived from, what read it, what it produced.", readOnlyHint: true })
    lineage(@path rid: Rid, @query vno?: Vno): Lineage | Error;

    @get @route("/{rid}/grants") listGrants(@path rid: Rid): Grant[] | Error;
    @put @route("/{rid}/grants/{pid}") grant(@path rid: Rid, @path pid: Pid, @body body: GrantRequest): Grant | Error;
    @delete @route("/{rid}/grants/{pid}") revoke(@path rid: Rid, @path pid: Pid): void | Error;
  }

  interface KindRoutes<T, TPage, TCreate, Spec> {
    @get list(@query project?: Rid, @query q?: string, @query limit?: int32, @query cursor?: string): Ok<TPage> | Error;
    @post create(@body body: TCreate): T | Error;
    @get read(@path rid: Rid): T | Error;
    @put updateSpec(@path rid: Rid, @body body: Spec): T | Error;
  }

  @route("/projects") interface Projects extends KindRoutes<Project, ProjectPage, CreateProjectRequest, ProjectSpec> {}

  @route("/workflows")
  interface Workflows extends KindRoutes<Workflow, WorkflowPage, CreateWorkflowRequest, WorkflowSpec> {
    @doc("Create a workflow with its first version's content (the logical plan JSON).")
    @post
    @route("/with-content")
    @extension("x-mcp", #{ tool: "create_workflow", description: "Create a new workflow from a logical plan JSON ({operators, links}); returns the workflow and its version 1.", readOnlyHint: false, destructiveHint: false })
    createWithContent(@body body: CreateWorkflowWithContent): WorkflowWithVersion | Error;

    @doc("The head version's content, or a given version.")
    @get
    @route("/{rid}/content")
    @extension("x-mcp", #{ tool: "get_workflow", description: "Get a workflow's logical plan JSON (operators, links) at the head or a given version.", readOnlyHint: true })
    content(@path rid: Rid, @query vno?: Vno): ResourceVersion | Error;

    @doc("Edit a workflow: a JSON Patch to the head content yields a new version.")
    @post
    @route("/{rid}/edit")
    @extension("x-mcp", #{ tool: "edit_workflow", description: "Edit a workflow by applying an RFC 6902 JSON Patch to its head content (paths like /operators/- or /links/-); creates a new version and returns it. Validate afterwards with validate_workflow.", readOnlyHint: false, destructiveHint: false })
    edit(@path rid: Rid, @body body: EditWorkflow): ResourceVersion | Error;

    @doc("Compile a version or draft content: output schemas per port and errors per operator.")
    @post
    @route("/{rid}/validate")
    @extension("x-mcp", #{ tool: "validate_workflow", description: "Compile a workflow version (or draft content) on a computing unit: returns each operator's output schema per port and any errors per operator.", readOnlyHint: true })
    validate(@path rid: Rid, @body body: CompileRequest, @query computingUnit?: Rid): CompileResult | Error;

    @doc("Run a workflow version on a computing unit; returns the execution.")
    @post
    @route("/{rid}/executions")
    @extension("x-mcp", #{ tool: "run_workflow", description: "Run a workflow version on a computing unit. Returns the execution; with waitSeconds it waits for completion and includes operator states and port results.", readOnlyHint: false, destructiveHint: false, idempotentHint: false })
    run(@path rid: Rid, @body body: RunRequest): Execution | Error;

    @get
    @route("/{rid}/executions")
    listExecutions(@path rid: Rid, @query limit?: int32, @query cursor?: string): Ok<ExecutionPage> | Error;
  }

  @route("/executions")
  interface Executions {
    @get list(@query workflow?: Rid, @query conversation?: Rid, @query limit?: int32, @query cursor?: string): Ok<ExecutionPage> | Error;

    @get
    @extension("x-mcp", #{ tool: "get_execution", description: "Get an execution: status, per-operator states, errors and port results.", readOnlyHint: true })
    read(@path eid: Eid): Execution | Error;

    @post @route("/{eid}/cancel") cancel(@path eid: Eid): Execution | Error;

    @doc("A page of a port result's rows, bounded.")
    @get
    @route("/{eid}/results/{opid}/{port}")
    @extension("x-mcp", #{ tool: "get_port_result", description: "Read a bounded page of rows from an operator's output port in an execution (schema and rows).", readOnlyHint: true })
    result(@path eid: Eid, @path opid: string, @path port: string, @query offset?: int64, @query limit?: int32): RowPage | Error;

    @doc("Save a port result as a new dataset version (CSV). Lineage records it as produced by the execution's workflow version.")
    @post
    @route("/{eid}/results/{opid}/{port}/save")
    @extension("x-mcp", #{ tool: "save_result_as_dataset", description: "Save an operator's output in a completed execution as a new dataset version (a CSV file), so later workflows can read it. Creates a dataset unless one is given; lineage records the execution that produced it.", readOnlyHint: false, destructiveHint: false, idempotentHint: false })
    saveResult(@path eid: Eid, @path opid: string, @path port: string, @body body: SaveResult): ResourceVersion | Error;
  }

  @route("/datasets")
  interface Datasets extends KindRoutes<Dataset, DatasetPage, CreateDatasetRequest, DatasetSpec> {
    @doc("Upload a file into the dataset's staging area; commit makes a version.")
    @put
    @route("/{rid}/files/{path}")
    upload(@path rid: Rid, @path path: string, @header contentType: "application/octet-stream", @body data: bytes): DatasetFile | Error;

    @delete
    @route("/{rid}/files/{path}")
    unstage(@path rid: Rid, @path path: string): void | Error;

    @get
    @route("/{rid}/staged")
    staged(@path rid: Rid): DatasetManifest | Error;

    @doc("Commit the staged files as a new version.")
    @post
    @route("/{rid}/commit")
    @extension("x-mcp", #{ tool: "commit_dataset_version", description: "Commit a dataset's staged files as a new immutable version.", readOnlyHint: false, destructiveHint: false })
    commit(@path rid: Rid, @body body: CommitDataset): ResourceVersion | Error;

    @get
    @route("/{rid}/versions/{vno}/files")
    @extension("x-mcp", #{ tool: "list_dataset_files", description: "List the files of a dataset version with sizes.", readOnlyHint: true })
    files(@path rid: Rid, @path vno: Vno): DatasetManifest | Error;

    @doc("Read a file of a version, bounded by `maxBytes`.")
    @get
    @route("/{rid}/versions/{vno}/files/{path}")
    @extension("x-mcp", #{ tool: "read_dataset_file", description: "Read the beginning of a dataset file (bounded bytes), e.g. to inspect a CSV header.", readOnlyHint: true })
    download(@path rid: Rid, @path vno: Vno, @path path: string, @query maxBytes?: int32): {
      @header contentType: "application/octet-stream";
      @body data: bytes;
    } | Error;

    @doc("A presigned URL for a file of a version, for engines and browsers.")
    @get
    @route("/{rid}/versions/{vno}/files/{path}/link")
    link(@path rid: Rid, @path vno: Vno, @path path: string): FileLink | Error;
  }

  @route("/environments") interface Environments extends KindRoutes<Environment, EnvironmentPage, CreateEnvironmentRequest, EnvironmentSpec> {}

  @route("/computing-units")
  interface ComputingUnits extends KindRoutes<ComputingUnit, ComputingUnitPage, CreateComputingUnitRequest, ComputingUnitSpec> {
    @doc("Units the caller may run on, with live status.")
    @get
    @route("/available")
    @extension("x-mcp", #{ tool: "list_computing_units", description: "List the computing units the caller can run workflows on, with status.", readOnlyHint: true })
    available(): ComputingUnit[] | Error;

    @post
    @route("/{rid}/terminate")
    terminate(@path rid: Rid): ComputingUnit | Error;
  }

  @route("/agent-templates") interface AgentTemplates extends KindRoutes<AgentTemplate, AgentTemplatePage, CreateAgentTemplateRequest, AgentTemplateSpec> {}
  @route("/mcp-servers") interface McpServers extends KindRoutes<McpServer, McpServerPage, CreateMcpServerRequest, McpServerSpec> {}
  @route("/skills") interface Skills extends KindRoutes<Skill, SkillPage, CreateSkillRequest, SkillSpec> {}

  @route("/conversations")
  interface Conversations extends KindRoutes<Conversation, ConversationPage, CreateConversationRequest, ConversationSpec> {
    @get
    @route("/{rid}/messages")
    messages(@path rid: Rid, @query after?: int64, @query limit?: int32): Message[] | Error;

    @post
    @route("/{rid}/messages")
    @extension("x-mcp", #{ tool: "post_message", description: "Append a message to a conversation the caller may post to.", readOnlyHint: false, destructiveHint: false })
    post(@path rid: Rid, @body body: PostMessage): Message | Error;

    @doc("Resources whose origin is this conversation.")
    @get
    @route("/{rid}/resources")
    resources(@path rid: Rid): Resource[] | Error;
  }

  @route("/agents")
  interface Agents {
    @post spawn(@body body: SpawnAgent): Agent | Error;
    @get read(@path pid: Pid): Agent | Error;
    @post
    @route("/{pid}/retire")
    retire(@path pid: Pid): Agent | Error;
    @get list(@query conversation?: Rid, @query execution?: Eid): Agent[] | Error;
  }

  @route("/operators")
  interface Operators {
    @get
    @extension("x-mcp", #{ tool: "list_operators", description: "List the operator types available on the engine with their property JSON Schema, ports and descriptions. Use the exact operatorType values when building a workflow.", readOnlyHint: true })
    list(@query group?: string, @query q?: string): OperatorTypeList | Error;
  }
}

@route("/lineage/v1")
namespace LineageRoutes {
  @route("/events")
  interface Events {
    @doc("OpenLineage run events posted by engines; service authentication.")
    @post
    ingest(@body body: LineageEvent): void | Error;
  }
}

@route("/access/v1")
namespace AccessRoutes {
  @route("/evaluation")
  interface Evaluation {
    @doc("AuthZEN access evaluation.")
    @post evaluate(@body body: AuthzRequest): AuthzResponse | Error;
  }
}
