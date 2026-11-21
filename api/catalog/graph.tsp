// The lineage graph a person reads, the same beside a chat and on a resource's page. Its boxes
// are resources, each with the versions of it that took part. An execution hangs off the
// version it ran, and the results it kept follow it. An arrow runs from what a workflow version
// reads or uses to that version: drawn solid once an execution of the version used it, dashed
// while the version only names it. Where an execution ran is said on it, not drawn. It is the
// lineage record (lineage.tsp) resolved for a person: names, versions, how each execution went.
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

@doc("A version of a resource on the graph: one an execution ran or read, one a workflow version on the graph names, or a workflow's newest.")
model GraphVersion {
  vno: Vno;
  @doc("For data and a model: the files of the version that were read or named, by path, in the order first named.")
  files?: string[];
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

@doc("An arrow: a dataset, model or function at a version, to the workflow version that reads or uses it.")
model GraphEdge {
  @doc("A dataset, model or function at a version.")
  from: Uri;
  @doc("A workflow at a version.")
  to: Uri;
  relation: "reads" | "uses";
  @doc("An execution of the workflow version ran the operator that names it, or read an earlier execution's rows of that operator instead; false when the version only names it.")
  executed: boolean;
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

@doc("A lineage graph: its resources with the versions that took part, the executions of those versions with the results they kept, and the arrows into each workflow version. Beside a chat, what the chat read, made and ran; on a resource's page, what the resource came from and what came of it.")
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
