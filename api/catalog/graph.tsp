// The lineage graph a person reads, the same beside a chat and on a resource's page. Its nodes
// are versions, grouped in their resources: a resource stands with the versions of it that took
// part. An execution hangs off the version it ran, and the results it kept are parts of it. An
// arrow joins two versions and names the parts it joins: from what a workflow version reads or
// uses to that version, the operator that names a file; from an execution to the dataset
// version that keeps one of its results, the port the file came from. An arrow into a
// workflow version is solid once an execution of the version used what it names, dashed while
// the version only names it. Where an execution ran is said on it, not drawn. It is the lineage
// record (lineage.tsp) resolved for a person: names, versions, how each execution went.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";
import "./core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("What a resource on the graph stands for: data, a model, a workflow, or a function a workflow calls (a custom operator).")
enum GraphRole {
  data,
  workflow,
  `model`,
  `function`,
}

@doc("A version of a resource on the graph: one an execution ran or read, one a workflow version on the graph names, one that keeps a result, or a workflow's newest.")
model GraphVersion {
  vno: Vno;
  @doc("Beside a chat: the chat made this version.")
  made: boolean;
  @doc("For a workflow: how many executions of the version the graph knows. It lists the newest of them.")
  executions?: int32;
  @doc("Who made the version, and the chat turn when an agent made it for them; absent for a resource the caller may not read.")
  createdBy?: Pid;
  origin?: Origin;
}

@doc("A resource on the graph, with the versions of it that took part, the newest first.")
model GraphNode {
  @doc("The resource's URI, without a version.")
  uri: Uri;
  role: GraphRole;
  kind: ResourceKind;
  @doc("Its name; empty for a resource the caller may not read.")
  name: string;
  @doc("What the resource says it is.")
  description?: string;
  @doc("False for a resource the caller may not read: it stands, unnamed, where it is named.")
  readable: boolean;
  versions: GraphVersion[];
  @doc("Beside a chat: the chat made it, or a version of it.")
  made: boolean;
  @doc("Beside a chat: the turn that made it.")
  turn?: string;
}

@doc("The computing unit an execution ran on, said on the execution.")
model GraphUnit {
  uri: Uri;
  name: string;
  @doc("How it stands: starting, ready, and so on.")
  state?: string;
  @doc("The CPU of its main node, as Kubernetes counts it; absent when it reserves none.")
  cpu?: string;
  @doc("The memory of its main node, as Kubernetes counts it.")
  memory?: string;
  @doc("The GPUs of its main node.")
  gpu?: int32;
}

@doc("An execution of a workflow version.")
model GraphExecution {
  uri: Uri;
  @doc("The workflow it is an execution of, without a version.")
  workflow: Uri;
  @doc("The version of the workflow it ran.")
  version: Vno;
  name: string;
  phase: string;
  @doc("The operators its plan had.")
  steps: int32;
  @doc("Those that read an earlier execution's rows instead of running.")
  reused: int32;
  startedAt?: utcDateTime;
  finishedAt?: utcDateTime;
  @doc("The unit it ran on, when the caller may see it.")
  unit?: GraphUnit;
  @doc("The profile version the unit was made from, and the warehouse that keeps its results.")
  profile?: Uri;
  warehouse?: Uri;
  @doc("Beside a chat: the chat started it.")
  made: boolean;
  @doc("Who started it, and the chat turn when an agent did for them.")
  createdBy: Pid;
  origin?: Origin;
}

@doc("What an execution kept of one operator's output, and shows.")
model GraphResult {
  @doc("Its port's URI: the execution's, then the operator and the port.")
  uri: Uri;
  execution: Uri;
  @doc("The operator it came out of, as the version that ran has it: its ID, its type and the name a person gave it.")
  operator: string;
  operatorType: string;
  displayName?: string;
  rows?: int64;
}

@doc("What an arrow joins inside the versions at its ends. A part is named by its path in its version, as a texera:// name goes on after the version.")
model GraphPart {
  @doc("In `from`: a file of a dataset or model version (`files/<path>`), or an output port of an execution (`operators/<id>/ports/<port>`). Absent where `from` is used whole, as a function or a model is.")
  from?: string;
  @doc("In `to`: the operator of the workflow version that names `from` (`operators/<id>`), or the file of the dataset version that keeps a result (`files/<path>`).")
  to?: string;
  @doc("The operator at either end, as its version has it: its type and the name a person gave it.")
  operatorType?: string;
  displayName?: string;
  @doc("An execution of the workflow version ran this operator, or read an earlier execution's rows of it instead; false while the version only names `from`. True for a kept result.")
  executed: boolean;
}

@doc("An arrow between two versions, with the parts it joins. `reads` and `uses`: a dataset, model or function version to the workflow version whose operators name it. `keeps`: an execution to the dataset version that keeps one of its results.")
model GraphEdge {
  @doc("A dataset, model or function at a version; for `keeps`, an execution.")
  from: Uri;
  @doc("A workflow at a version; for `keeps`, a dataset at a version.")
  to: Uri;
  relation: "reads" | "uses" | "keeps";
  @doc("One of its parts was executed; false while the workflow version only names `from`.")
  executed: boolean;
  @doc("The parts it joins, each once, in the order the version has them.")
  parts: GraphPart[];
}

@doc("Something the chat's latest plan said it would make that it has not made yet. An earlier plan's items are done or given up.")
model PlannedItem {
  kind?: string;
  name: string;
  detail?: string;
  @doc("The turn whose start_work said so.")
  turn: string;
}

@doc("A call the chat's agent made to an outside MCP server's tool.")
model GraphCall {
  tool: string;
  @doc("What the call asked: its arguments, in short.")
  asked: string;
  @doc("The turn it was made in.")
  turn: string;
}

@doc("An outside MCP server the chat's agent consulted, and its calls, oldest first.")
model GraphSource {
  uri: Uri;
  name: string;
  calls: GraphCall[];
}

@doc("A lineage graph: its resources with the versions that took part, the executions of those versions with the results they kept, the arrows into each workflow version and those from an execution to the dataset versions that keep its results. Beside a chat, what the chat read, made and ran; on a resource's page, what the resource came from and what came of it.")
model ResourceGraph {
  @doc("Beside a chat, the workflows in the order the chat came to them, so a new one never comes before one drawn.")
  nodes: GraphNode[];
  @doc("The newest first, at most three of each version.")
  executions: GraphExecution[];
  results: GraphResult[];
  edges: GraphEdge[];
  @doc("Beside a chat: what its latest plan said it would make and has not made yet.")
  planned: PlannedItem[];
  @doc("Beside a chat: the outside MCP servers its agent consulted, in the order it first did; the catalog's own server is not among them.")
  sources: GraphSource[];
  @doc("Beside a chat: the computing units it made that no execution on the graph ran on yet, which its next execution will likely run on.")
  units: GraphUnit[];
}
