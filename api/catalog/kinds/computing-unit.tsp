// computing-unit: an engine deployment that runs executions. Unversioned and reconciled: the
// spec is what was asked for, the status what is running. Computing nodes are a subresource.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

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
  cpu?: string;
  memory?: string;
  gpu?: int32;
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
  @doc("The path the gateway proxies the unit's WebSocket and HTTP API at.")
  gatewayPath?: string;
  message?: string;
  engine?: EngineStatus;
  computingNodes?: ComputingNodeStatus[];
  @doc("Environment versions built on this unit.")
  environments?: Uri[];
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
      server: "dataflow",
      tool: "list_computing_units",
      description: "List the computing units the caller can run workflows on, with status.",
      readOnlyHint: true,
    })
    available(): ComputingUnit[] | Error;

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
