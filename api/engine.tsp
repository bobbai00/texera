// Texera 2.0 engine (computing unit) contract: what the catalog calls on a unit.
// The unit is a pure engine: it receives self-contained execution requests and reports
// back through OpenLineage events; it holds no catalog state of its own.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "@typespec/openapi3";
import "./common.tsp";

using Http;
using Rest;
using OpenAPI;

@service(#{ title: "Texera Computing Unit" })
@info(#{ version: "2.0.0-alpha" })
@server("http://localhost:8085", "the unit")
@useAuth(BearerAuth)
namespace Texera.Engine;

@doc("A dataset file the catalog resolved for this execution: the operator property value and the URL the engine reads.")
model ResolvedInput {
  @doc("The dataset version this file belongs to.")
  dataset: string;
  vno: int32;
  path: string;
  @doc("A URL the unit can read, presigned by the catalog.")
  url: string;
  sizeBytes?: int64;
}

model EnvironmentRequest {
  rid: string;
  vno: int32;
  python?: {
    version?: string;
    packages: string[];
  };
}

@doc("The table the catalog named for an output port, inside the execution's namespace.")
model OutputTable {
  opid: string;
  port: string;
  table: string;
}

@doc("Where an execution's results go in the lake. The unit knows the lake's address from its own configuration; the catalog names the warehouse and the namespace.")
model ResultStore {
  @doc("The warehouse the execution writes to, by its name in the lake: what an Iceberg client passes as `warehouse`.")
  warehouse: string;
  @doc("The namespace the catalog made for this execution: every table of the execution goes there, and the unit's identity was granted write access to it.")
  `namespace`: string;
  @doc("One table per output port, named by the catalog; the engine writes each port's result under its name and reports it as `namespace.table`.")
  tables?: OutputTable[];
}

model Reporting {
  @doc("Where the unit posts OpenLineage events and status: the catalog's /lineage/v1/events. The unit reports as itself, with the client it was given; the catalog accepts an execution's events from the unit that runs it alone.")
  lineageUrl: string;
}

model ExecutionStartRequest {
  eid: string;
  workflow: {
    rid: string;
    vno: int32;
  };
  name?: string;
  @doc("The logical plan JSON; dataset file properties are already rewritten to resolved URLs.")
  logicalPlan: unknown;
  inputs?: ResolvedInput[];
  environment?: EnvironmentRequest;
  resultStore?: ResultStore;
  reporting: Reporting;
  actor: string;
  onBehalfOf?: string;
  parameters?: Record<unknown>;
}

model ExecutionAck {
  eid: string;
  accepted: boolean;
}

model ExecutionState {
  eid: string;
  status: ExecutionStatus;
  operators: Record<OperatorRun>;
  results: PortResult[];
  error?: unknown;
}

model EngineCompileRequest {
  logicalPlan: unknown;
}

model UnitHealth {
  status: string;
  version?: string;
}

model EnvironmentBuild {
  rid: string;
  vno: int32;
  status: "building" | "ready" | "failed";
  message?: string;
}

@route("/api")
namespace Routes {
  @route("/health")
  interface Health {
    @get check(): UnitHealth;
  }

  @route("/operators")
  interface Operators {
    @get list(): OperatorTypeList | Error;
  }

  @route("/compile")
  interface Compile {
    @post compile(@body body: EngineCompileRequest): CompileResult | Error;
  }

  @route("/executions")
  interface Executions {
    @doc("Start an execution; the unit reports progress through OpenLineage events.")
    @post start(@body body: ExecutionStartRequest): ExecutionAck | Error;
    @get @route("/{eid}") status(@path eid: string): ExecutionState | Error;
    @post @route("/{eid}/cancel") cancel(@path eid: string): ExecutionState | Error;
    @doc("Pause the execution; the status turns `paused` once the engine confirms, and the unit reports it.")
    @post @route("/{eid}/pause") pause(@path eid: string): ExecutionState | Error;
    @doc("Resume a paused execution.")
    @post @route("/{eid}/resume") resume(@path eid: string): ExecutionState | Error;
    @doc("A page of a port result. `table` is where the catalog recorded the result, `namespace` the execution's namespace (ResultStore.namespace) and `warehouse` the warehouse it wrote to (ResultStore.warehouse); a unit that no longer holds the execution (after a restart, or another unit that may read the namespace) serves it from there.")
    @get @route("/{eid}/results/{opid}/{port}") result(@path eid: string, @path opid: string, @path port: string, @query offset?: int64, @query limit?: int32, @query table?: string, @query `namespace`?: string, @query warehouse?: string): RowPage | Error;
  }

  @route("/environments")
  interface Environments {
    @doc("Build (or confirm) the Python environment for an environment version on this unit.")
    @post build(@body body: EnvironmentRequest): EnvironmentBuild | Error;
    @get @route("/{rid}/{vno}") status(@path rid: string, @path vno: int32): EnvironmentBuild | Error;
  }
}
