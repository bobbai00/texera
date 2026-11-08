// conversation: the state of a chat. The spec holds the chat's choices of how its agent works,
// each optional: the agent, the model the agent uses, its add-on MCP servers. A turn runs with
// the chat's choice, else the default of the nearest project up the chat's project's chain that
// sets one, else the agent's own (ChatSettings). Where an execution runs is not a chat's to
// choose: the call names a unit, else the workflow's, else its project's default applies, for
// everyone alike. Messages
// are an append-only subresource; a turn is one run of the loop, locked on the conversation.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model ConversationSpec {
  @doc("The agent template the next turn runs, chosen by the person or by a handoff; absent: the project's default, which may come from up its chain.")
  template?: Uri;
  @doc("The model endpoint the agent uses in this chat; absent: the project's default, which may come from up its chain, else the agent's own.")
  modelEndpoint?: Uri;
  @doc("The add-on MCP servers of this chat, in place of the agent's and the project's; absent: theirs. The catalog's own server is not an add-on and is never listed here.")
  mcpServers?: Uri[];
  @doc("How the agent's changes go once it has said what it will do: `auto`, it makes them; `manual`, each change waits for a person's approval. Absent: the project's choice, which may come from up its chain, else `auto`.")
  workMode?: WorkMode;
}

@doc("How the agent's changes go: `auto`, it makes them once it has started work; `manual`, each one waits for a person's approval.")
enum WorkMode {
  auto,
  manual,
}

@doc("Where a chat's setting comes from: the chat's own choice, a project's default (the chat's project or one up its chain), the agent's own, or, when nothing chose, the catalog's default.")
enum SettingSource {
  chat,
  project,
  agent,
  default,
}

@doc("One setting of a chat as a turn uses it.")
model Setting {
  uri: Uri;
  name: string;
  from: SettingSource;
  @doc("The project whose default it is, when it comes from a project.")
  project?: ChatProject;
}

@doc("An MCP server a turn mounts.")
model ServerSetting {
  ...Setting;
  @doc("True for the catalog's own server: the agent's basic tools, called as the person. Every other server is an add-on a turn can go without.")
  platform: boolean;
  @doc("The tool names the agent may call; absent: every tool the server exposes.")
  allow?: string[];
}

@doc("A choice that was passed over: what it names is gone, or is not the caller's to use.")
model SkippedSetting {
  @doc("The field of the spec the choice is in.")
  setting: "template" | "modelEndpoint" | "mcpServers";
  uri: Uri;
  from: SettingSource;
  reason: string;
}

@doc("The project a chat is in.")
model ChatProject {
  rid: Rid;
  name: string;
}

@doc("What a turn of a chat runs with, for the caller: each choice of the chat, else the default of the nearest project up the chat's project's chain that sets one, else the agent's own.")
model ChatSettings {
  @doc("Where the chat is: what a turn makes goes into this project, and a list made in a turn is scoped to it.")
  project: ChatProject;
  @doc("The agent, at the version a turn runs.")
  agent: Setting;
  modelEndpoint: Setting;
  @doc("The catalog's own server first, then the add-ons.")
  mcpServers: ServerSetting[];
  @doc("How the agent's changes go in this chat, and where that choice comes from.")
  workMode: WorkModeSetting;
  skipped?: SkippedSetting[];
}

@doc("How the agent's changes go in a chat: the chat's choice, else the nearest project's up the chain, else `auto`.")
model WorkModeSetting {
  mode: WorkMode;
  from: SettingSource;
  @doc("The project whose default it is, when it comes from a project.")
  project?: ChatProject;
}

@doc("A version as a chat knows it: one the chat made, or one it worked from.")
model ChatVersion {
  ...VersionSummary;
  @doc("True when the chat made the version; false for one it worked from.")
  made: boolean;
}

@doc("What a node of a chat's graph stands for: data (a dataset, or a table a run made), a workflow, a model, a function (a custom operator) or a computing unit.")
enum GraphRole {
  data,
  workflow,
  `model`,
  `function`,
  unit,
}

@doc("A run of a workflow, as its node in a chat's graph lists it.")
model GraphRun {
  uri: Uri;
  phase: string;
  @doc("The operators its plan had.")
  steps: int32;
  @doc("Those that read an earlier run's rows instead of running.")
  reused: int32;
  startedAt?: utcDateTime;
  finishedAt?: utcDateTime;
  @doc("The unit it ran on, when the caller may see it.")
  unit?: Uri;
}

@doc("A step of a workflow on a chat's graph: one operator of the version it shows.")
model GraphStep {
  @doc("The operator's ID in the workflow; the tables it makes are named by it.")
  id: string;
  @doc("What the step does: a built-in's type (scan, filter, join, ...), predict, or a custom operator's URI at a version.")
  type: string;
  @doc("Its settings, as the workflow version has them.")
  settings?: Record<unknown>;
  @doc("The steps whose rows it reads, in port order.")
  inputs?: string[];
}

@doc("A node of a chat's graph. Nodes come in the order the chat first touched them, so a new one never comes before one already drawn.")
model GraphNode {
  @doc("What the node opens: a resource's URI, or for a table a run made, its port's.")
  uri: Uri;
  role: GraphRole;
  kind: ResourceKind;
  name: string;
  @doc("What the resource says it is.")
  description?: string;
  @doc("The version the chat worked from or made, the newest when there are several.")
  version?: Vno;
  @doc("The chat made it, or a version of it.")
  made: boolean;
  @doc("The turn of this chat that made it; absent for what the chat only worked from.")
  turn?: string;
  @doc("For a workflow, its last run's phase; for a unit, its phase.")
  state?: string;
  @doc("For a workflow, its runs in the chat, newest first.")
  runs?: GraphRun[];
  @doc("For a workflow, the steps of the version its newest run ran, or of the version the chat made or worked from when it has not run, each after the steps it reads.")
  steps?: GraphStep[];
  @doc("For a table a run made, the step that made it.")
  step?: string;
  @doc("For a table a run made, the run.")
  run?: Uri;
  @doc("For a table a run made, its rows.")
  rows?: int64;
}

@doc("An arrow of a chat's graph: data a workflow reads, what it makes, a model or function it uses, the unit it runs on. A workflow that has not run reads, uses and runs on what its version names and its default unit.")
model GraphEdge {
  from: Uri;
  to: Uri;
  relation: "reads" | "makes" | "uses" | "runsOn";
}

@doc("Something the chat's latest plan said it would make that it has not made yet. An earlier plan's items are done or given up.")
model PlannedItem {
  kind?: string;
  name: string;
  detail?: string;
  @doc("The turn whose start_work said so.")
  turn: string;
}

@doc("A call the chat's agent made to an outside MCP server's tool.")
model GraphCall {
  tool: string;
  @doc("What the call asked: its arguments, in short.")
  asked: string;
  @doc("The turn it was made in.")
  turn: string;
}

@doc("An outside MCP server the chat's agent consulted, and its calls, oldest first.")
model GraphSource {
  uri: Uri;
  name: string;
  calls: GraphCall[];
}

@doc("What a chat read, made and ran, and how they connect.")
model ConversationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  planned: PlannedItem[];
  @doc("The outside MCP servers the chat's agent consulted, in the order it first did; the catalog's own server is not among them.")
  sources: GraphSource[];
}

@doc("A resource as a chat knows it, with the versions that count.")
model ChatResource {
  resource: Resource;
  @doc("True when the chat made the resource or a version of it; false for one it only worked from: what a person attached to a message, what the chat's versions and resources name at a version, what its executions ran and read.")
  made: boolean;
  @doc("The versions the chat made and those it worked from, newest first; absent for a kind without versions.")
  versions?: ChatVersion[];
}

model ConversationStatus {
  @doc("The turn in progress, when one is.")
  activeTurn?: string;
  @doc("The person whose turn is in progress.")
  activeTurnBy?: Pid;
  messages: int64;
  lastMessageAt?: utcDateTime;
  @doc("Every template version that has written in this conversation.")
  templates?: Uri[];
}

@doc("One message part: text, reasoning, a tool call, a tool result, a resource reference, a file, an error, or an approval: a change the agent asked to make, waiting for a person's yes or no (in `manual` work mode).")
model MessagePart {
  type: "text" | "reasoning" | "tool_call" | "tool_result" | "resource" | "file" | "error" | "approval";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  @doc("A resource URI, with `@vno` when a version is meant.")
  resource?: Uri;
  file?: Record<unknown>;
  @doc("For an approval: whether it waits, or what the person decided.")
  state?: "pending" | "approved" | "declined";
  @doc("For a decided approval: the person who decided.")
  decidedBy?: Pid;
  @doc("For a tool call: the MCP server whose tool it is; absent for the agent's own tools.")
  server?: Uri;
}

model Message {
  conversation: Rid;
  seq: int64;
  @doc("The turn this message belongs to.")
  turn?: string;
  role: "user" | "assistant" | "system" | "tool";
  @doc("The person whose turn it was.")
  author: Pid;
  @doc("For an assistant message: the template version that wrote it.")
  template?: Uri;
  @doc("For an assistant message: the model endpoint that wrote it.")
  modelEndpoint?: Uri;
  @doc("For an assistant message: the MCP servers its turn mounted.")
  mcpServers?: Uri[];
  parts: MessagePart[];
  createdAt: utcDateTime;
  updatedAt?: utcDateTime;
}

model MessagePage is Page<Message>;

model AppendMessage {
  turn?: string;
  role: "user" | "assistant" | "system" | "tool";
  template?: Uri;
  modelEndpoint?: Uri;
  mcpServers?: Uri[];
  parts: MessagePart[];
}

model ReplaceMessage {
  parts: MessagePart[];
  template?: Uri;
}

model StartTurn {
  @doc("Overrides the conversation's template for this turn and the ones after.")
  template?: Uri;
}

model Turn {
  turn: string;
  @doc("The template version the turn runs, with `@vno`.")
  template: Uri;
  startedAt: utcDateTime;
}

@extension("x-texera-kind", #{ kind: "conversation", plural: "conversations", versioned: false, content: "spec", parent: "project" })
model Conversation is Typed<ConversationSpec, ConversationStatus>;
model ConversationPage is Page<Conversation>;
model CreateConversation is Create<ConversationSpec>;
model UpdateConversation is UpdateSpec<ConversationSpec>;

namespace Routes {
  @route("/conversations")
  interface Conversations extends KindRoutes<Conversation, ConversationPage, CreateConversation, UpdateConversation> {
    @get
    @route("/{rid}/messages")
    @extension("x-texera-permission", "read")
    listMessages(@path rid: Rid, @query after?: int64, @query limit?: int32): Ok<MessagePage> | Error;

    @doc("Append a message; `seq` is assigned in order.")
    @post
    @route("/{rid}/messages")
    @extension("x-texera-permission", "write")
    appendMessage(@path rid: Rid, @body body: AppendMessage): Created<Message> | Error;

    @doc("Replace the parts of a message, for the assistant message a turn is still writing.")
    @put
    @route("/{rid}/messages/{seq}")
    @extension("x-texera-permission", "write")
    replaceMessage(@path rid: Rid, @path seq: int64, @body body: ReplaceMessage): Message | Error;

    @doc("Start a turn: takes the conversation's turn lock, refused with 409 while another turn runs.")
    @post
    @route("/{rid}/turns")
    @extension("x-texera-permission", "write")
    startTurn(@path rid: Rid, @body body: StartTurn): Created<Turn> | Error;

    @doc("End a turn: releases the lock.")
    @delete
    @route("/{rid}/turns/{turn}")
    @extension("x-texera-permission", "write")
    endTurn(@path rid: Rid, @path turn: string): void | Error;

    @doc("What this chat made or changed, and what it worked from: each resource the caller may read once, those it made first, newest first, with the versions that count.")
    @get
    @route("/{rid}/resources")
    @extension("x-texera-permission", "read")
    resources(@path rid: Rid): ChatResource[] | Error;

    @doc("The resource graph beside the chat: what it read, made and ran, and how they connect, with what its plans said it would make and has not made yet, and the outside sources its agent consulted.")
    @get
    @route("/{rid}/graph")
    @extension("x-texera-permission", "read")
    graph(@path rid: Rid): ConversationGraph | Error;

    @doc("What a turn of this chat runs with, for the caller.")
    @get
    @route("/{rid}/settings")
    @extension("x-texera-permission", "read")
    settings(@path rid: Rid): ChatSettings | Error;
  }
}
