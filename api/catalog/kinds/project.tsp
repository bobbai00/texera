// project: the container every top-level resource lives in, and the place the work is managed
// from. A project inherits from one other, its base, up to Texera: its people read and use what
// the projects up its chain hold, and its settings fill in what the project's own leave out.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("How a project looks in the app: inside it, and inside every project that inherits from it and sets no look of its own. Texera's is also the sign-in page's.")
model Branding {
  @doc("The name the app shows for the project's work.")
  name?: string;
  @doc("The address of the logo the app shows beside the name.")
  logoUrl?: string;
}

@doc("What the project's work runs with when nothing nearer chooses: a request, a workflow and a chat choose first. A value here wins over the one the project inherits.")
model ProjectDefaults {
  @doc("The agent template a chat runs.")
  agentTemplate?: Uri;
  @doc("The model endpoint the agent uses in a chat; set nowhere up the chain: the agent's own.")
  modelEndpoint?: Uri;
  @doc("The computing unit an execution runs on.")
  computingUnit?: Uri;
  @doc("The profile a new computing unit is made from unless another is chosen.")
  profile?: Uri;
  @doc("The warehouse an execution keeps its results in.")
  warehouse?: Uri;
  @doc("Add-on MCP servers every chat mounts besides the agent's, unless the chat lists its own.")
  mcpServers?: Uri[];
  @doc("How the agent's changes go in a chat that does not choose: `auto` or `manual`; set nowhere up the chain: `auto`.")
  workMode?: WorkMode;
}

@doc("Bounds on the project's work. A project may narrow what it inherits, never widen it: along the chain, the strictest holds.")
model ProjectLimits {
  @doc("How long a finished execution keeps its result tables, as an ISO 8601 duration (`P30D`, `PT12H`); its record and summaries stay. The shortest along the chain holds; set nowhere: forever.")
  results?: duration;
  @doc("The object stores, by endpoint, a warehouse in the project may be kept on besides the deployment's own store. A list narrows what the project inherits: a store must be on Texera's list, which allows none when it is not set, and on every list set along the chain.")
  warehouseEndpoints?: string[];
}

@doc("A project's settings. What it leaves out comes from the projects up its chain.")
model ProjectSpec {
  branding?: Branding;
  defaults?: ProjectDefaults;
  limits?: ProjectLimits;
}

model ProjectStatus {
  @doc("Live resources with this project as parent.")
  resources?: int64;
}

@doc("A project in a chain.")
model ProjectRef {
  rid: Rid;
  name: string;
}

@doc("What a project's work runs with: each preference from the nearest project in its chain that sets it, each limit the strictest along the chain.")
model ProjectSettings {
  @doc("The project and what it inherits from, nearest first: the project, its base, that one's base, and so on to Texera.")
  chain: ProjectRef[];
  branding: Branding;
  defaults: ProjectDefaults;
  limits: ProjectLimits;
  @doc("Where each value comes from: the rid of the project that set it, by the value's path (`branding.name`, `defaults.profile`, `limits.results`). A limit set by several projects names the one whose value holds.")
  from: Record<Rid>;
}

@extension("x-texera-kind", #{ kind: "project", plural: "projects", versioned: false, content: "spec" })
model Project is Typed<ProjectSpec, ProjectStatus>;
model ProjectPage is Page<Project>;
model CreateProject is Create<ProjectSpec>;
model UpdateProject is UpdateSpec<ProjectSpec>;

namespace Routes {
  @route("/projects")
  interface Projects {
    @doc("List the projects the caller may read.")
    @get
    @extension("x-texera-permission", "list")
    list(
      ...Scoped,
      @query parent?: Rid,
      @query project?: Rid,
      @query q?: string,
      @query limit?: int32,
      @query cursor?: string,
    ): Ok<ProjectPage> | Error;

    @doc("Make a project; the caller is its first admin.")
    @post
    @extension("x-texera-permission", "create")
    create(@body body: CreateProject): Created<Project> | Error;

    @get
    @route("/{rid}")
    @extension("x-texera-permission", "read")
    read(@path rid: Rid): Project | Error;

    @doc("Replace the project's settings; its admins do.")
    @put
    @route("/{rid}")
    @extension("x-texera-permission", "admin")
    update(@path rid: Rid, @header("If-Match") ifMatch?: string, @body body: UpdateProject): Project | Error;

    @doc("Delete the project; refused with 409 while it holds resources or another project inherits from it.")
    @delete
    @route("/{rid}")
    @extension("x-texera-permission", "delete")
    delete(@path rid: Rid): void | Error;

    @doc("What the project's work runs with: its settings, with what it inherits filled in, and where each value comes from.")
    @get
    @route("/{rid}/settings")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "project_settings",
      description: "What a project's work runs with: its default agent, model, computing unit, profile and warehouse, its look and its limits, each from the nearest project up its chain that sets it, and the chain itself, up to Texera.",
      readOnlyHint: true,
    })
    settings(@path rid: Rid): ProjectSettings | Error;

    @doc("The projects that inherit from this one, for its admins, who may send any of them back to Texera. Every project inherits from Texera unless it inherits from another, so Texera lists none: 400.")
    @get
    @route("/{rid}/inheritors")
    @extension("x-texera-permission", "admin")
    inheritors(@path rid: Rid): ProjectRef[] | Error;

    @doc("What a turn of a new chat in this project runs with, for the caller.")
    @get
    @route("/{rid}/chat-settings")
    @extension("x-texera-permission", "read")
    chatSettings(@path rid: Rid): ChatSettings | Error;
  }
}
