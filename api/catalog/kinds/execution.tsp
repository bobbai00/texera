// execution: one run of one workflow version, nested under its workflow. The spec is the
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
  completed,
  failed,
  cancelled,
}

model ExecutionSpec {
  @doc("The workflow version, with `@vno`.")
  workflow: Uri;
  @doc("The environment version, with `@vno`.")
  environment?: Uri;
  computingUnit: Uri;
  @doc("The dataset file versions the run reads, resolved at start.")
  inputs?: Uri[];
  parameters?: Record<unknown>;
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
  @doc("When the retention policy dropped the run's result tables: the summaries stay, the rows are gone.")
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

@doc("Save an output port's result as a dataset version.")
model SavePort {
  @doc("The dataset that gets the new version; a new dataset is created when absent.")
  dataset?: Rid;
  @doc("The new dataset's name, when `dataset` is absent.")
  name?: string;
  @doc("The file inside the dataset version; defaults to `<operatorID>.csv`.")
  path?: string;
  @doc("What the version holds, recorded on it.")
  message?: string;
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
