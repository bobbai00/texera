// operator: an operator type as a resource. Built-ins are platform-owned, public and versioned
// by the engine image digest; custom operators carry their implementation and are versioned
// by their authors. A workflow names one by its operatorType or its URI with @vno.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model OperatorPortSpec {
  portID: string;
  displayName?: string;
  allowMultiInputs?: boolean;
  isDynamicPort?: boolean;
}

model PythonOperator {
  @doc("The operator's Python source: a class with the engine's UDF interface.")
  code: string;
  @doc("The environment its packages come from; absent means the run's environment.")
  environment?: Uri;
}

model OperatorImplementation {
  python?: PythonOperator;
}

model OperatorSpec {
  @doc("The type name a workflow uses, e.g. CSVFileScan; for a custom operator a name unique in its project.")
  operatorType: string;
  displayName?: string;
  group?: string;
  description?: string;
  inputPorts?: OperatorPortSpec[];
  outputPorts?: OperatorPortSpec[];
  @doc("JSON Schema of the operator's properties.")
  propertiesSchema?: unknown;
  @doc("Absent for a built-in, whose code is in the engine image.")
  implementation?: OperatorImplementation;
  requires?: RuntimeSpec;
}

model OperatorStatus {
  @doc("True for an operator the engine image provides.")
  builtin?: boolean;
  @doc("The engine image digest the head version was read from.")
  engine?: string;
}

@extension("x-texera-kind", #{ kind: "operator", plural: "operators", versioned: true, content: "spec", parent: "project" })
model Operator is Typed<OperatorSpec, OperatorStatus>;
model OperatorPage is Page<Operator>;
model CreateOperator is Create<OperatorSpec>;
model UpdateOperator is UpdateSpec<OperatorSpec>;
model OperatorVersion is TypedVersion<OperatorSpec>;
model OperatorVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/operators")
  interface Operators
    extends VersionedKindRoutes<Operator, OperatorPage, CreateOperator, UpdateOperator, OperatorVersion, OperatorVersionPage> {
    @doc("List the operators the caller may use, built-ins and custom. The summary view carries the type, name, group and description; the full view adds the property schema and ports.")
    @get
    @extension("x-texera-permission", "list")
    @extension("x-mcp", #{
      server: "dataflow",
      tool: "list_operators",
      description: "List the operator types available: without q or group, a compact list of types, names, groups and descriptions; with q (an operator name or part of it) or group, the matching operators with their property JSON Schema and ports. Use the exact operatorType values when building a workflow.",
      readOnlyHint: true,
    })
    list(
      @query q?: string,
      @query group?: string,
      @query parent?: Rid,
      @query project?: Rid,
      @query view?: View,
      @query limit?: int32,
      @query cursor?: string,
    ): Ok<OperatorPage> | Error;
  }
}
