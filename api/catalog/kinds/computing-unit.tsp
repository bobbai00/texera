// computing-unit: an engine deployment that runs executions. Unversioned and reconciled: the
// spec is what was asked for, the status what is running. Computing nodes are a subresource.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";
import "./profile.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

enum UnitProvider {
  @doc("An already running unit reachable at `endpoint`; the dev stack's default.") static,
  @doc("A unit the catalog starts as a local process or container.") local,
  @doc("A ComputingUnit custom resource reconciled by the unit operator.") kubernetes,
}

model ComputingNodeSpec {
  name: string;
  role: "master" | "worker" | "sandbox";
  @doc("The profile version the node was made from, with `@vno`; what the node has may have changed since.")
  profile?: Uri;
  cpu?: string;
  memory?: string;
  gpu?: int32;
  @doc("Python packages the node adds to the platform's runtime, PEP 508 lines.")
  packages?: string[];
}

model ComputingNodeStatus {
  name: string;
  role: "master" | "worker" | "sandbox";
  ready: boolean;
  message?: string;
}

model EngineSpec {
  @doc("The engine image, by tag or digest; absent means the deployment default.")
  image?: string;
}

model EngineStatus {
  @doc("The digest of the engine image that is running; operator versions are keyed by it.")
  digest?: string;
  version?: string;
}

model ComputingUnitSpec {
  provider: UnitProvider;
  @doc("For `static`: the unit's base URL as the catalog reaches it.")
  endpoint?: string;
  @doc("For `static`: the OAuth client the unit authenticates to the lake as, configured by its operator; the catalog grants its subject each execution's tables. A unit the catalog provisions gets a client of its own.")
  clientId?: string;
  engine?: EngineSpec;
  computingNodes?: ComputingNodeSpec[];
}

@doc("The identity a unit runs with, minted by the catalog in the identity provider: the lake's grants name its subject.")
model UnitIdentity {
  @doc("The OAuth client the unit authenticates as.")
  clientId: string;
  @doc("The subject its tokens carry.")
  subject: string;
}

model ComputingUnitStatus {
  phase: "pending" | "ready" | "failed" | "terminated";
  identity?: UnitIdentity;
  message?: string;
  engine?: EngineStatus;
  computingNodes?: ComputingNodeStatus[];
  @doc("The packages the unit installed for its node, each pinned as installed: what an execution on it has.")
  installed?: string[];
}

@doc("A computing unit to make from a profile.")
model ComputingUnitFromProfile {
  @doc("What to call it. Left out, it is called after its profile: Small unit.")
  name?: string;
  @doc("The project the unit goes into; absent: the chat's project in a chat, else the caller's own.")
  parent?: Rid;
  @doc("The profile, with `@vno`, or its head.")
  profile: Uri;
  @doc("Wait up to this many seconds for the unit to be ready (or failed); it is returned as it is then.")
  waitSeconds?: int32;
}

@doc("How to save a unit as a profile.")
model SaveUnitAsProfile {
  @doc("Save it as the next version of this profile; absent: as a new profile.")
  profile?: Uri;
  @doc("The new profile's name; required for a new profile.")
  name?: string;
  @doc("The project a new profile goes into; absent: the unit's, when the caller may add to it, else the chat's project in a chat, else the caller's own.")
  parent?: Rid;
}

@extension("x-texera-kind", #{ kind: "computing-unit", plural: "computing-units", versioned: false, content: "spec", parent: "project" })
model ComputingUnit is Typed<ComputingUnitSpec, ComputingUnitStatus>;
model ComputingUnitPage is Page<ComputingUnit>;
model CreateComputingUnit is Create<ComputingUnitSpec>;
model UpdateComputingUnit is UpdateSpec<ComputingUnitSpec>;

namespace Routes {
  @route("/computing-units")
  interface ComputingUnits extends KindRoutes<ComputingUnit, ComputingUnitPage, CreateComputingUnit, UpdateComputingUnit> {
    @doc("The units the caller may run on, with live status.")
    @get
    @route("/available")
    @extension("x-texera-permission", "list")
    @extension("x-mcp", #{
      tool: "list_computing_units",
      description: "List the computing units the caller can run workflows on, with status. An execution that names no unit runs on the workflow's default, else its project's, which may come from up the project's chain (project_settings).",
      readOnlyHint: true,
    })
    available(...Scoped): ComputingUnit[] | Error;

    @doc("Make a computing unit from a profile: one node of the profile's size with its packages, on the deployment's Kubernetes.")
    @post
    @route("/from-profile")
    @extension("x-texera-permission", "create")
    @extension("x-mcp", #{
      tool: "create_computing_unit",
      description: "Make a computing unit from a profile: one node of the profile's size with its Python packages. Find profiles with search_resources (kind profile). The unit goes into the chat's project unless another is named. It is pending until its engine answers: waitSeconds (up to 600) waits until it is ready, and a run on it is refused before then.",
    })
    fromProfile(@body body: ComputingUnitFromProfile): Created<ComputingUnit> | Error;

    @doc("Save a unit as a profile: the next version of a profile the caller may change, or a new profile. Packages are saved as the unit installed them, each pinned. The unit is then made from what was saved.")
    @post
    @route("/{rid}/profile")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "save_unit_as_profile",
      description: "Save a computing unit as a profile, so others can make a unit like it: as the next version of a profile (profile, which the caller may change), or as a new one (name). Its packages are saved pinned to the versions installed.",
    })
    saveAsProfile(@path rid: Rid, @body body: SaveUnitAsProfile): Profile | Error;

    @post
    @route("/{rid}/terminate")
    @extension("x-texera-permission", "write")
    terminate(@path rid: Rid): ComputingUnit | Error;

    @get
    @route("/{rid}/computing-nodes")
    @extension("x-texera-permission", "read")
    listNodes(@path rid: Rid): ComputingNodeStatus[] | Error;

    @get
    @route("/{rid}/computing-nodes/{name}")
    @extension("x-texera-permission", "read")
    readNode(@path rid: Rid, @path name: string): ComputingNodeStatus | Error;

    @doc("The operator types the unit's engine provides, as its registry reports them.")
    @get
    @route("/{rid}/operators")
    @extension("x-texera-permission", "run_on")
    operators(@path rid: Rid, @query q?: string, @query group?: string): OperatorTypeList | Error;
  }
}
