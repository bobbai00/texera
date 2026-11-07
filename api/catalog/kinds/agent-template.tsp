// agent-template: the definition of an agent. A turn of a conversation runs one template
// version: its prompt, skills, MCP servers, model endpoint and loop settings.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("The agent's card, as A2A presents it and as handoff candidates are described.")
model AgentCard {
  name: string;
  description: string;
}

model McpBinding {
  @doc("An MCP server resource URI.")
  server: Uri;
  @doc("Tool names the agent may call; absent means every tool the server exposes.")
  allow?: string[];
}

@doc("How the runtime's loop runs the agent; the runtime's defaults apply to what is absent.")
model LoopSpec {
  @doc("When a reply without a tool call is the answer: `free`, always; `after_result`, only once a result-showing tool succeeded in the turn, else the reply is sent back with a correction.")
  answer?: "free" | "after_result";
  @doc("Tools whose successful result counts as a shown result.")
  resultTools?: string[];
  @doc("Model steps per turn.")
  maxSteps?: int32;
  @doc("Sampling temperature.")
  temperature?: float64;
}

model AgentTemplateSpec {
  card: AgentCard;
  @doc("The model endpoint the agent uses unless a chat or its project names another.")
  `model`: Uri;
  @doc("The system prompt, Markdown.")
  prompt: string;
  @doc("Skill resource URIs, loaded on demand.")
  skills?: Uri[];
  @doc("The MCP servers the agent mounts. The catalog's own server holds its basic tools and is listed like any other; the rest are add-ons.")
  mcpServers?: McpBinding[];
  @doc("Templates this agent may hand the conversation to.")
  handoffs?: Uri[];
  loop?: LoopSpec;
}

model AgentTemplateStatus {}

@extension("x-texera-kind", #{ kind: "agent-template", plural: "agent-templates", versioned: true, content: "spec", parent: "project" })
model AgentTemplate is Typed<AgentTemplateSpec, AgentTemplateStatus>;
model AgentTemplatePage is Page<AgentTemplate>;
model CreateAgentTemplate is Create<AgentTemplateSpec>;
model UpdateAgentTemplate is UpdateSpec<AgentTemplateSpec>;
model AgentTemplateVersion is TypedVersion<AgentTemplateSpec>;
model AgentTemplateVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/agent-templates")
  interface AgentTemplates
    extends VersionedKindRoutes<AgentTemplate, AgentTemplatePage, CreateAgentTemplate, UpdateAgentTemplate, AgentTemplateVersion, AgentTemplateVersionPage> {}
}
