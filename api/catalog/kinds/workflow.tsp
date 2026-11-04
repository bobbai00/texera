// workflow: a dataflow graph. The spec is the whole plan plus the run defaults; every spec
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
  @doc("Store this operator's output so it can be read after the run.")
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

model WorkflowSpec {
  operators: WorkflowOperator[];
  links: WorkflowLink[];
  @doc("The environment a run uses when the request names none.")
  defaultEnvironment?: Uri;
  @doc("The computing unit a run uses when the request names none.")
  defaultComputingUnit?: Uri;
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
}

model ValidateWorkflow {
  @doc("Compile this version; defaults to the head version.")
  vno?: Vno;
  @doc("Compile this draft spec instead of a stored version.")
  spec?: WorkflowSpec;
  @doc("The unit whose compiler answers; defaults to the run resolution order.")
  computingUnit?: Uri;
}

model RunWorkflow {
  @doc("The workflow version to run; defaults to the head version.")
  vno?: Vno;
  @doc("Overrides the workflow's and the project's default unit.")
  computingUnit?: Uri;
  @doc("Overrides the workflow's and the project's default environment; `@vno` pins a version, else the head.")
  environment?: Uri;
  @doc("Per-run inputs; the version itself stays as authored.")
  parameters?: Record<unknown>;
  @doc("Wait up to this many seconds for the run to finish before returning.")
  waitSeconds?: int32;
  name?: string;
}

namespace Routes {
  @route("/workflows")
  interface Workflows
    extends VersionedKindRoutes<Workflow, WorkflowPage, CreateWorkflow, UpdateWorkflow, WorkflowVersion, WorkflowVersionPage> {
    @post
    @extension("x-texera-permission", "create")
    @extension("x-mcp", #{
      server: "dataflow",
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
      server: "dataflow",
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
      server: "dataflow",
      tool: "edit_workflow",
      description: "Edit a workflow by applying an RFC 6902 JSON Patch to its head spec (paths like /operators/- or /links/-), or by giving a full new spec; creates a new version and returns it. Validate afterwards with validate_workflow.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    edit(@path rid: Rid, @body body: EditWorkflow): WorkflowVersion | Error;

    @doc("Compile a version or a draft on a computing unit: output schemas per port and errors per operator.")
    @post
    @route("/{rid}/validate")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      server: "dataflow",
      tool: "validate_workflow",
      description: "Compile a workflow version (or a draft spec) on a computing unit: returns each operator's output schema per port and any errors per operator.",
      readOnlyHint: true,
    })
    validate(@path rid: Rid, @body body: ValidateWorkflow): CompileResult | Error;

    @doc("Run a workflow version; the execution is created under the workflow.")
    @post
    @route("/{rid}/run")
    @extension("x-texera-permission", "execute")
    @extension("x-mcp", #{
      server: "dataflow",
      tool: "run_workflow",
      description: "Run a workflow version on a computing unit. Returns the execution; with waitSeconds it waits for completion and includes operator states and port results.",
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
      server: "dataflow",
      tool: "get_execution",
      description: "Get an execution of a workflow: phase, per-operator states, errors and port results.",
      readOnlyHint: true,
    })
    readExecution(@path rid: Rid, @path eid: Rid): Execution | Error;

    @post
    @route("/{rid}/executions/{eid}/cancel")
    @extension("x-texera-permission", "execute")
    cancelExecution(@path rid: Rid, @path eid: Rid): Execution | Error;

    @doc("What a port of an execution holds: for an output port its result, for an input port its binding.")
    @doc("Delete a finished run with its result tables; refused with 409 while it runs or while a dataset version derives from it.")
    @delete
    @route("/{rid}/executions/{eid}")
    @extension("x-texera-permission", "delete")
    deleteExecution(@path rid: Rid, @path eid: Rid): void | Error;

    @get
    @route("/{rid}/executions/{eid}/operators/{operatorID}/ports/{portID}")
    @extension("x-texera-permission", "read")
    readPort(@path rid: Rid, @path eid: Rid, @path operatorID: string, @path portID: string): ExecutionPort | Error;

    @doc("A bounded page of an output port's rows.")
    @get
    @route("/{rid}/executions/{eid}/operators/{operatorID}/ports/{portID}/rows")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      server: "dataflow",
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

    @doc("Save an output port's result as a dataset version; lineage records it as derived from the port.")
    @post
    @route("/{rid}/executions/{eid}/operators/{operatorID}/ports/{portID}/save")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      server: "dataflow",
      tool: "save_result_as_dataset",
      description: "Save an operator's output in a completed execution as a new dataset version (a CSV file), so later workflows can read it. Creates a dataset unless one is given; lineage records the port that produced it.",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
    savePort(
      @path rid: Rid,
      @path eid: Rid,
      @path operatorID: string,
      @path portID: string,
      @body body: SavePort,
    ): Created<DatasetVersion> | Error;
  }
}
