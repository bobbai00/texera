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
  @doc("The environment a run in this project uses when the workflow names none.")
  defaultEnvironment?: Uri;
  @doc("The computing unit a run in this project uses when the request and the workflow name none.")
  defaultComputingUnit?: Uri;
  @doc("The agent template a new chat in this project starts with.")
  defaultAgentTemplate?: Uri;
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
  interface Projects extends KindRoutes<Project, ProjectPage, CreateProject, UpdateProject> {}
}
