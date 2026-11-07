// project: the container every top-level resource lives in. Grants and defaults flow down.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model ProjectSpec {
  @doc("The computing unit an execution in this project uses when the request and the workflow name none.")
  defaultComputingUnit?: Uri;
  @doc("The warehouse an execution in this project keeps its results in when the request and the workflow name none.")
  defaultWarehouse?: Uri;
  @doc("The agent template a chat in this project runs when the chat names none.")
  defaultAgentTemplate?: Uri;
  @doc("The model endpoint the agent uses in a chat of this project when the chat names none; absent: the agent's own.")
  defaultModelEndpoint?: Uri;
  @doc("Add-on MCP servers every chat in this project mounts besides the agent's, unless the chat lists its own.")
  mcpServers?: Uri[];
  @doc("How the agent's changes go in a chat of this project when the chat does not choose: `auto` or `manual`; absent: `auto`.")
  defaultWorkMode?: WorkMode;
}

model ProjectStatus {
  @doc("Live resources with this project as parent.")
  resources?: int64;
}

@extension("x-texera-kind", #{ kind: "project", plural: "projects", versioned: false, content: "spec" })
model Project is Typed<ProjectSpec, ProjectStatus>;
model ProjectPage is Page<Project>;
model CreateProject is Create<ProjectSpec>;
model UpdateProject is UpdateSpec<ProjectSpec>;

namespace Routes {
  @route("/projects")
  interface Projects extends KindRoutes<Project, ProjectPage, CreateProject, UpdateProject> {
    @doc("What a turn of a new chat in this project runs with, for the caller.")
    @get
    @route("/{rid}/chat-settings")
    @extension("x-texera-permission", "read")
    chatSettings(@path rid: Rid): ChatSettings | Error;
  }
}
