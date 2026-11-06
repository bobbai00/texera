// execution: one workflow version run once, nested under its workflow. The spec is the
// resolved request (every reference pinned with @vno); the status is the phase, the operators
// and the ports. Operators and ports are subresources.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

enum ExecutionPhase {
  pending,
  @doc("The environment is being built on the unit.") provisioning,
  running,
  @doc("Paused on the unit; resume continues it.") paused,
  completed,
  failed,
  cancelled,
}

@doc("One output port's table in the lake, named by the catalog before the execution starts.")
model PortTable {
  operatorID: string;
  portID: string;
  @doc("The table's name inside the execution's namespace.")
  table: string;
}

@doc("What the catalog compiled for an execution, as data: what it reads and writes, by URI. No secret and no URL that expires; those are bound when the execution starts and never stored.")
model ExecutionPlan {
  @doc("The namespace in the execution's warehouse that it writes to; absent for a dry run.")
  `namespace`?: string;
  @doc("One table per output port the engine writes, inside the namespace: the ports of operators marked viewResult and of operators nothing reads.")
  outputs: PortTable[];
  @doc("The custom operator versions compiled in, with `@vno`.")
  operators?: Uri[];
  @doc("The credentials the operators name; leased for the execution at start, their values never stored.")
  credentials?: Uri[];
  @doc("The engine's logical plan, with dataset files and credentials still named by URI.")
  logicalPlan: unknown;
}

model ExecutionSpec {
  @doc("The workflow version, with `@vno`.")
  workflow: Uri;
  @doc("The environment version, with `@vno`.")
  environment?: Uri;
  computingUnit: Uri;
  @doc("The warehouse the execution keeps its result tables in.")
  warehouse: Uri;
  @doc("The dataset file versions the execution reads, resolved at start.")
  inputs?: Uri[];
  parameters?: Record<unknown>;
  @doc("The compiled plan the execution was started with.")
  plan?: ExecutionPlan;
}

model OperatorRunStatus {
  state: string;
  tuples?: int64;
  error?: unknown;
  @doc("The computing node that ran it.")
  computingNode?: string;
}

@doc("An output port's result, as the unit reported it at completion.")
model PortSummary {
  operatorID: string;
  portID: string;
  @doc("The Iceberg table identifier.")
  table?: string;
  @doc("The Iceberg snapshot id.")
  snapshot?: string;
  rows?: int64;
  bytes?: int64;
  hash?: string;
  schema?: Attribute[];
}

model ExecutionStatus {
  phase: ExecutionPhase;
  error?: unknown;
  operators?: Record<OperatorRunStatus>;
  ports?: PortSummary[];
  startedAt?: utcDateTime;
  finishedAt?: utcDateTime;
  @doc("When the retention policy dropped the execution's result tables: the summaries stay, the rows are gone.")
  resultsExpiredAt?: utcDateTime;
}

@doc("A port of an execution: an output port with its result, or an input port with its binding.")
model ExecutionPort {
  uri: Uri;
  operatorID: string;
  portID: string;
  direction: "input" | "output";
  @doc("For an output port: its result.")
  result?: PortSummary;
  @doc("For an input port: the dataset file URI or the upstream port URI it read.")
  boundTo?: Uri;
}

@extension("x-texera-kind", #{
  kind: "execution",
  plural: "executions",
  versioned: false,
  content: "spec",
  parent: "workflow",
  nested: true,
  index: #["/status/phase", "/spec/computingUnit"],
})
model Execution is Typed<ExecutionSpec, ExecutionStatus>;
model ExecutionPage is Page<Execution>;

namespace Routes {
  @route("/executions")
  interface Executions {
    @doc("Executions across workflows the caller may read.")
    @get
    @extension("x-texera-permission", "list")
    list(
      @query workflow?: Rid,
      @query conversation?: Rid,
      @query computingUnit?: Rid,
      @query phase?: ExecutionPhase,
      @query limit?: int32,
      @query cursor?: string,
    ): Ok<ExecutionPage> | Error;
  }
}
