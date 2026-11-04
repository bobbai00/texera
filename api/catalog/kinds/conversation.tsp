// conversation: the state of a chat. The spec names the current template; messages are an
// append-only subresource; a turn is one run of the loop, locked on the conversation.
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
  @doc("The agent template the next turn runs; set at the start, by the person, or by a handoff.")
  template: Uri;
  @doc("The computing unit runs in this chat use; defaults to the project's.")
  computingUnit?: Uri;
  environment?: Uri;
}

model ConversationStatus {
  @doc("The turn in progress, when one is.")
  activeTurn?: string;
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
  parts: MessagePart[];
  createdAt: utcDateTime;
  updatedAt?: utcDateTime;
}

model MessagePage is Page<Message>;

model AppendMessage {
  turn?: string;
  role: "user" | "assistant" | "system" | "tool";
  template?: Uri;
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
  }
}
