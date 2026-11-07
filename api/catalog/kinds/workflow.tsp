// workflow: a dataflow graph. The spec is the whole plan plus the defaults of its executions; every spec
// write is a version. Executions are nested under it (kinds/execution.tsp).
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";
import "./execution.tsp";
import "./dataset.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("A port of an operator in a workflow.")
model WorkflowPort {
  @doc("input-<n> or output-<n>.")
  portID: string;
  displayName?: string;
  allowMultiInputs?: boolean;
  isDynamicPort?: boolean;
}

@doc("An operator instance in a workflow.")
model WorkflowOperator {
  @doc("Unique within the workflow, e.g. scan or avg.")
  operatorID: string;
  @doc("A built-in operator type, e.g. CSVFileScan, or the URI of a custom operator with `@vno`.")
  operatorType: string;
  @doc("Property values following the operator type's JSON Schema. A file property takes a dataset file URI, texera://datasets/{rid}@{vno}/files/{path}.")
  operatorProperties: Record<unknown>;
  @doc("Defaults to one input port input-0 (none for sources).")
  inputPorts?: WorkflowPort[];
  @doc("Defaults to one output port output-0.")
  outputPorts?: WorkflowPort[];
  @doc("Store this operator's output so it can be read after the execution.")
  viewResult?: boolean;
  markedForReuse?: boolean;
  isDisabled?: boolean;
  customDisplayName?: string;
}

model WorkflowLinkEnd {
  operatorID: string;
  portID: string;
}

@doc("A link from one operator's output port to another's input port.")
model WorkflowLink {
  linkID: string;
  source: WorkflowLinkEnd;
  target: WorkflowLinkEnd;
}

@doc("A place on the canvas: the top left corner of an operator's card.")
model CanvasPoint {
  x: float64;
  y: float64;
}

model WorkflowSpec {
  operators: WorkflowOperator[];
  links: WorkflowLink[];
  @doc("Where each operator's card sits on the canvas, by operator. It is the app's: nothing that runs the workflow reads it, a move alone makes no version, a version keeps the places it was made with, and an operator with no place is placed beside what it connects to. A spec written without it keeps the places of the operators it kept.")
  layout?: Record<CanvasPoint>;
  @doc("The computing unit an execution uses when the request names none.")
  defaultComputingUnit?: Uri;
  @doc("The warehouse an execution keeps its results in when the request names none.")
  defaultWarehouse?: Uri;
}

model WorkflowStatus {
  lastExecution?: Rid;
  executions?: int64;
}

@extension("x-texera-kind", #{ kind: "workflow", plural: "workflows", versioned: true, content: "spec", parent: "project" })
model Workflow is Typed<WorkflowSpec, WorkflowStatus>;
model WorkflowPage is Page<Workflow>;
model CreateWorkflow is Create<WorkflowSpec>;
model UpdateWorkflow is UpdateSpec<WorkflowSpec>;
model WorkflowVersion is TypedVersion<WorkflowSpec>;
model WorkflowVersionPage is Page<VersionSummary>;

@doc("One RFC 6902 JSON Patch operation.")
model JsonPatchOperation {
  `op`: "add" | "remove" | "replace" | "move" | "copy" | "test";
  @doc("A JSON Pointer into the spec, e.g. /operators/- to append an operator or /operators/1/operatorProperties/limit.")
  path: string;
  from?: string;
  value?: unknown;
}

@doc("An edit of a workflow: a JSON Patch over the head spec, or a full new spec.")
model EditWorkflow {
  patch?: JsonPatchOperation[];
  spec?: WorkflowSpec;
  @doc("The head version the caller saw; refused with 409 when it moved.")
  expectedHead?: Vno;
  @doc("What changed, recorded on the new version.")
  message?: string;
  @doc("The people whose edits this version holds, when the platform's live service saves a workflow they edited together: the first is recorded as the version's creator, all of them as its contributors. Refused from anyone else.")
  onBehalfOf?: Pid[];
}

@doc("A dry run: the engine's compile result and the plan the catalog would start an execution with.")
model WorkflowValidation {
  ...CompileResult;
  plan?: ExecutionPlan;
}

model ValidateWorkflow {
  @doc("Compile this version; defaults to the head version.")
  vno?: Vno;
  @doc("Compile this draft spec instead of a stored version.")
  spec?: WorkflowSpec;
  @doc("The unit whose compiler answers; defaults to the one an execution would resolve to.")
  computingUnit?: Uri;
}

model RunWorkflow {
  @doc("The workflow version to run; defaults to the head version.")
  vno?: Vno;
  @doc("Overrides the workflow's and the project's default unit.")
  computingUnit?: Uri;
  @doc("Overrides the workflow's and the project's default warehouse: where the execution keeps its results.")
  warehouse?: Uri;
  @doc("Inputs of this execution alone; the version itself stays as authored.")
  parameters?: Record<unknown>;
  @doc("Wait up to this many seconds for the execution to finish before returning.")
  waitSeconds?: int32;
  @doc("Run up to this operator: only the operators it reads from, directly or not, and itself. Its result is kept; the workflow does not change.")
  upTo?: string;
  @doc("The execution's name. Without one the catalog names it by its start, `execution <UTC time>`. A name is a label: another execution may have the same, and the rid tells them apart.")
  name?: string;
}

namespace Routes {
  @route("/workflows")
  interface Workflows
    extends VersionedKindRoutes<Workflow, WorkflowPage, CreateWorkflow, UpdateWorkflow, WorkflowVersion, WorkflowVersionPage> {
    @post
    @extension("x-texera-permission", "create")
    @extension("x-mcp", #{
      tool: "create_workflow",
      description: "Create a workflow from a spec {operators, links}; returns the workflow with its version 1. Every later edit_workflow makes a new version of the same workflow.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    create(@body body: CreateWorkflow): Created<Workflow> | Error;

    @get
    @route("/{rid}")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "get_workflow",
      description: "Get a workflow: its metadata, head version number and spec (operators, links, defaults). Use get_version for an older version.",
      readOnlyHint: true,
    })
    read(@path rid: Rid): Workflow | Error;

    @doc("Edit a workflow: a JSON Patch to the head spec, or a full spec, yields a new version.")
    @post
    @route("/{rid}/edit")
    @extension("x-texera-permission", "write")
    @extension("x-mcp", #{
      tool: "edit_workflow",
      description: "Edit a workflow by applying an RFC 6902 JSON Patch to its head spec (paths like /operators/- or /links/-), or by giving a full new spec; creates a new version and returns it. Pass expectedHead, the head you read, so an edit someone made in between is not written over: on a conflict, read the workflow again and redo the edit. Validate afterwards with validate_workflow.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    edit(@path rid: Rid, @body body: EditWorkflow): WorkflowVersion | Error;

    @doc("Compile a version or a draft on a computing unit: output schemas per port and errors per operator.")
    @post
    @route("/{rid}/validate")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "validate_workflow",
      description: "Compile a workflow version (or a draft spec) on a computing unit: returns each operator's output schema per port and any errors per operator. Leave computingUnit out to use the workflow's default unit, else its project's or the platform's.",
      readOnlyHint: true,
    })
    validate(@path rid: Rid, @body body: ValidateWorkflow): WorkflowValidation | Error;

    @doc("Run a workflow version; the execution is created under the workflow.")
    @post
    @route("/{rid}/run")
    @extension("x-texera-permission", "execute")
    @extension("x-mcp", #{
      tool: "run_workflow",
      description: "Run a workflow version on a computing unit. Returns the execution; with waitSeconds it waits for completion and includes operator states, errors and port results. Leave computingUnit out to use the workflow's default unit, else its project's or the platform's; name one only when the person asks for another. Results are kept in the warehouse of the workflow, its project or the platform; name one only when the person asks.",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
    run(@path rid: Rid, @body body: RunWorkflow): Created<Execution> | Error;

    @get
    @route("/{rid}/executions")
    @extension("x-texera-permission", "read")
    listExecutions(
      @path rid: Rid,
      @query phase?: ExecutionPhase,
      @query limit?: int32,
      @query cursor?: string,
    ): Ok<ExecutionPage> | Error;

    @get
    @route("/{rid}/executions/{eid}")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "get_execution",
      description: "Get an execution of a workflow: phase, per-operator states, errors and port results.",
      readOnlyHint: true,
    })
    readExecution(@path rid: Rid, @path eid: Rid): Execution | Error;

    @post
    @route("/{rid}/executions/{eid}/cancel")
    @extension("x-texera-permission", "execute")
    cancelExecution(@path rid: Rid, @path eid: Rid): Execution | Error;

    @doc("Pause a running execution; refused with 409 unless it runs. The phase turns `paused` when the unit confirms.")
    @post
    @route("/{rid}/executions/{eid}/pause")
    @extension("x-texera-permission", "execute")
    @extension("x-mcp", #{
      tool: "pause_execution",
      description: "Pause a running execution of a workflow; it keeps its state and resume_execution continues it.",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
    pauseExecution(@path rid: Rid, @path eid: Rid): Execution | Error;

    @doc("Resume a paused execution; refused with 409 unless it is paused.")
    @post
    @route("/{rid}/executions/{eid}/resume")
    @extension("x-texera-permission", "execute")
    @extension("x-mcp", #{
      tool: "resume_execution",
      description: "Resume a paused execution of a workflow.",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
    resumeExecution(@path rid: Rid, @path eid: Rid): Execution | Error;

    @doc("Delete a finished execution with its result tables; refused with 409 while it runs or while a dataset version derives from it.")
    @delete
    @route("/{rid}/executions/{eid}")
    @extension("x-texera-permission", "delete")
    deleteExecution(@path rid: Rid, @path eid: Rid): void | Error;

    @doc("What a port of an execution holds: for an output port its result, for an input port its binding.")
    @get
    @route("/{rid}/executions/{eid}/operators/{operatorID}/ports/{portID}")
    @extension("x-texera-permission", "read")
    readPort(@path rid: Rid, @path eid: Rid, @path operatorID: string, @path portID: string): ExecutionPort | Error;

    @doc("A bounded page of an output port's rows.")
    @get
    @route("/{rid}/executions/{eid}/operators/{operatorID}/ports/{portID}/rows")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "get_port_result",
      description: "Read a bounded page of rows from an operator's output port in an execution (schema and rows).",
      readOnlyHint: true,
    })
    readRows(
      @path rid: Rid,
      @path eid: Rid,
      @path operatorID: string,
      @path portID: string,
      @query offset?: int64,
      @query limit?: int32,
    ): RowPage | Error;
  }
}
