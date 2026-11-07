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
  @doc("The operator's Python: a module whose function under `@returns(...)` is the operator, with the helpers and imports it needs. Never a class: the classes that run a function are the engine's, and the catalog refuses code that defines none under @returns.")
  code: string;
  @doc("The function in code that is the operator, `def cgm_metrics(readings, *, tir_low=70)` under `@returns(...)`; absent, the code's one function under @returns. Its positional parameters are its inputs, one table each, and a function with none is a source; its parameters with defaults are its settings, one typed `Credential` naming a credential whose secret it gets; its docstring is its description, and @returns its output columns. It returns a DataFrame, or yields DataFrames as it makes them. The catalog reads all this from the code when the operator is saved, into inputPorts, propertiesSchema and outputColumns.")
  function?: string;
  @doc("Every output column, in order, read from the function's @returns.")
  outputColumns?: Attribute[];
  @doc("For a function, read from `@returns(..., nondeterministic=True)`: it may give other rows for the same input, as a function that samples without a seed, reads the clock or calls out does. No run reuses its rows, nor those of anything after it.")
  nondeterministic?: boolean;
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
  @doc("For an operator the engine image provides: the digest of the image its head version was read from.")
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
      tool: "list_operators",
      description: "List the operator types available: without q or group, a compact list of types, names, groups and descriptions; with q (an operator name or part of it) or group, the matching operators with their property JSON Schema and ports. Use the exact operatorType values when building a workflow.",
      readOnlyHint: true,
    })
    list(
      ...Scoped,
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
