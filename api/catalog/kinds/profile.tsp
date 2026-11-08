// profile: what a computing node is made of: its size and the Python packages it adds to the
// platform's runtime. Versioned. A computing unit is made from a profile version and may then
// change (packages added, size changed); saving a unit as a profile makes the next version of
// its profile, or a new profile. A run records what its unit actually had, so an execution can
// be reproduced from it.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("What a computing node is made of.")
model ProfileSpec {
  @doc("CPU, as Kubernetes counts it: `2`, `500m`; absent: the deployment's default.")
  cpu?: string;
  @doc("Memory, as Kubernetes counts it: `4Gi`; absent: the deployment's default.")
  memory?: string;
  @doc("GPUs; absent: none.")
  gpu?: int32;
  @doc("Python packages added to the platform's runtime, PEP 508 lines; a profile saved from a unit pins each to what was installed: `pandas==2.2.3`.")
  packages?: string[];
  @doc("The platform release the profile was saved on, as the unit's engine reported it.")
  runtime?: string;
}

@doc("Whether this deployment can start a unit from the profile, as the catalog finds when the profile is read: a cluster without GPUs starts no GPU unit, and on Compose a unit from a profile is the deployment's own unit.")
model ProfileStatus {
  @doc("Whether a unit made from the profile can start in this deployment.")
  startable?: boolean;
  @doc("Why not, in a person's words: \"no GPU in this cluster\".")
  notHere?: string;
  @doc("Whether a unit made from it is held to the profile's CPU, memory and GPUs. False where such a unit is the deployment's own, as on Compose: it has the profile's packages, and the size the unit was started with.")
  sized?: boolean;
}

@extension("x-texera-kind", #{ kind: "profile", plural: "profiles", versioned: true, content: "spec", parent: "project" })
model Profile is Typed<ProfileSpec, ProfileStatus>;
model ProfilePage is Page<Profile>;
model CreateProfile is Create<ProfileSpec>;
model UpdateProfile is UpdateSpec<ProfileSpec>;
model ProfileVersion is TypedVersion<ProfileSpec>;
model ProfileVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/profiles")
  interface Profiles
    extends VersionedKindRoutes<Profile, ProfilePage, CreateProfile, UpdateProfile, ProfileVersion, ProfileVersionPage> {}
}
