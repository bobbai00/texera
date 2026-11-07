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
  @doc("The unit is installing its packages.") provisioning,
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
  @doc("The fingerprint of the work that makes the port's rows: its operator, its settings and the engine that runs it, and its inputs' fingerprints. The same work on the same data, in any workflow of the project, has the same fingerprint, so a later run reads these rows instead of making them again. Absent for rows that depend on more, such as a limit with no sort before it.")
  fingerprint?: string;
}

@doc("A result an execution read from an earlier run instead of making it again.")
model ReusedResult {
  operatorID: string;
  portID: string;
  @doc("The earlier execution's port whose stored rows were read.")
  from: Uri;
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

@doc("What the unit an execution ran on had when it ran.")
model ComputingRecord {
  @doc("The profile version its node was made from, with `@vno`.")
  profile?: Uri;
  cpu?: string;
  memory?: string;
  gpu?: int32;
  @doc("The packages added to the runtime, each pinned as installed when the unit says so.")
  packages?: string[];
  @doc("The engine's version.")
  runtime?: string;
}

model ExecutionSpec {
  @doc("The workflow version, with `@vno`.")
  workflow: Uri;
  computingUnit: Uri;
  @doc("What the unit had when it ran: the profile its node was made from, its size and packages.")
  computing?: ComputingRecord;
  @doc("The warehouse the execution keeps its result tables in.")
  warehouse: Uri;
  @doc("The dataset file versions the execution reads, resolved at start.")
  inputs?: Uri[];
  parameters?: Record<unknown>;
  @doc("The compiled plan the execution was started with.")
  plan?: ExecutionPlan;
  @doc("The operator the execution was run up to: only what leads to it ran, and its result was kept.")
  upTo?: string;
  @doc("The results read from earlier runs: each of these operators read the rows its port had stored instead of running.")
  reused?: ReusedResult[];
  @doc("The operators that did not run because only reused results needed them.")
  skipped?: string[];
}

model OperatorRunStatus {
  state: string;
  @doc("Rows the operator has read so far, over all its input ports.")
  rowsIn?: int64;
  @doc("Rows the operator has put out so far, over all its output ports.")
  rowsOut?: int64;
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
