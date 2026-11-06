// conversation: the state of a chat. The spec holds the chat's choices, each optional: its
// agent, the model the agent uses, the computing unit its executions prefer, its add-on MCP servers.
// A turn runs with the chat's choice, else the project's, else the agent's own or the
// platform's default (ChatSettings). Messages are an append-only subresource; a turn is one
// run of the loop, locked on the conversation.
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
  @doc("The agent template the next turn runs, chosen by the person or by a handoff; absent: the project's default, else the platform's.")
  template?: Uri;
  @doc("The model endpoint the agent uses in this chat; absent: the project's default, else the agent's own.")
  modelEndpoint?: Uri;
  @doc("The computing unit a compile or an execution started in this chat uses when the call names none; absent: the workflow's, the project's or the platform's default. A preference, not a binding: a call can always name another unit.")
  computingUnit?: Uri;
  @doc("The add-on MCP servers of this chat, in place of the agent's and the project's; absent: theirs. The platform's own server is not an add-on and is never listed here.")
  mcpServers?: Uri[];
}

@doc("The level a setting of a chat comes from.")
enum SettingSource {
  chat,
  project,
  agent,
  platform,
}

@doc("One setting of a chat as a turn uses it.")
model Setting {
  uri: Uri;
  name: string;
  from: SettingSource;
}

@doc("An MCP server a turn mounts.")
model ServerSetting {
  ...Setting;
  @doc("True for the platform's own server, the catalog: the agent's basic tools, called as the person. Every other server is an add-on a turn can go without.")
  platform: boolean;
  @doc("The tool names the agent may call; absent: every tool the server exposes.")
  allow?: string[];
}

@doc("A choice that was passed over: what it names is gone, or is not the caller's to use.")
model SkippedSetting {
  @doc("The field of the spec the choice is in.")
  setting: "template" | "modelEndpoint" | "computingUnit" | "mcpServers";
  uri: Uri;
  from: SettingSource;
  reason: string;
}

@doc("The project a chat is in.")
model ChatProject {
  rid: Rid;
  name: string;
}

@doc("What a turn of a chat runs with, for the caller: each choice of the chat, else the project's, else the agent's own or the platform's default.")
model ChatSettings {
  @doc("Where the chat is: what a turn makes goes into this project, and a list made in a turn is scoped to it.")
  project: ChatProject;
  @doc("The agent, at the version a turn runs.")
  agent: Setting;
  modelEndpoint: Setting;
  @doc("The unit a compile or an execution uses when the call names none; absent when nothing names one.")
  computingUnit?: Setting;
  @doc("The platform's own server first, then the add-ons.")
  mcpServers: ServerSetting[];
  skipped?: SkippedSetting[];
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

@doc("One message part: text, reasoning, a tool call, a tool result, a resource reference, a file, or an error.")
model MessagePart {
  type: "text" | "reasoning" | "tool_call" | "tool_result" | "resource" | "file" | "error";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  @doc("A resource URI, with `@vno` when a version is meant.")
  resource?: Uri;
  file?: Record<unknown>;
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

    @doc("The resources whose origin is this conversation.")
    @get
    @route("/{rid}/resources")
    @extension("x-texera-permission", "read")
    resources(@path rid: Rid): Resource[] | Error;

    @doc("What a turn of this chat runs with, for the caller.")
    @get
    @route("/{rid}/settings")
    @extension("x-texera-permission", "read")
    settings(@path rid: Rid): ChatSettings | Error;
  }
}
