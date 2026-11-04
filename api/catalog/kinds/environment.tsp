// environment: the Python packages a run needs. Versioned; builds are status, per unit.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model PythonEnvironment {
  @doc("Python version range, PEP 440, e.g. `>=3.12,<3.13`.")
  version?: string;
  @doc("Package requirements, PEP 508 lines.")
  packages: string[];
}

model EnvironmentSpec {
  python?: PythonEnvironment;
  @doc("Base image for units that build images; absent means the deployment default.")
  baseImage?: string;
}

model EnvironmentBuild {
  computingUnit: Uri;
  vno: Vno;
  state: "building" | "ready" | "failed";
  message?: string;
  at: utcDateTime;
}

model EnvironmentStatus {
  @doc("Builds of this environment's versions on units.")
  builds?: EnvironmentBuild[];
}

model BuildEnvironment {
  @doc("The version to build; defaults to the head version.")
  vno?: Vno;
  @doc("The unit to build on; defaults to the run resolution order.")
  computingUnit?: Uri;
}

@extension("x-texera-kind", #{ kind: "environment", plural: "environments", versioned: true, content: "spec", parent: "project" })
model Environment is Typed<EnvironmentSpec, EnvironmentStatus>;
model EnvironmentPage is Page<Environment>;
model CreateEnvironment is Create<EnvironmentSpec>;
model UpdateEnvironment is UpdateSpec<EnvironmentSpec>;
model EnvironmentVersion is TypedVersion<EnvironmentSpec>;
model EnvironmentVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/environments")
  interface Environments
    extends VersionedKindRoutes<Environment, EnvironmentPage, CreateEnvironment, UpdateEnvironment, EnvironmentVersion, EnvironmentVersionPage> {
    @doc("Build a version on a unit; returns at once, the build shows in status.")
    @post
    @route("/{rid}/build")
    @extension("x-texera-permission", "use")
    build(@path rid: Rid, @body body: BuildEnvironment): Accepted<EnvironmentBuild> | Error;
  }
}
