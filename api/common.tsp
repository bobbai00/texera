// Shared models of the Texera 2.0 contracts: used by the catalog and the engine (unit) APIs.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";

using Http;
using Rest;
using OpenAPI;

@doc("Resource id, a UUID.")
scalar Rid extends string;

@doc("Principal id, a UUID.")
scalar Pid extends string;

@doc("Execution id, a UUID.")
scalar Eid extends string;

@doc("Version number within a resource, starting at 1.")
scalar Vno extends int32;

@doc("A 200 response carrying T; used where a union with Error would otherwise be ambiguous.")
model Ok<T> {
  @statusCode statusCode: 200;
  @body body: T;
}

@error
model Error {
  code: string;
  message: string;
  details?: Record<unknown>;
}

model RuntimeSpec {
  isolation?: Record<unknown>;
  resources?: Record<unknown>;
}

@doc("An operator type from the registry, with its JSON Schema for properties.")
model OperatorType {
  operatorType: string;
  userFriendlyName: string;
  operatorGroupName: string;
  operatorDescription?: string;
  @doc("JSON Schema of the operator's properties.")
  jsonSchema: unknown;
  inputPorts: unknown[];
  outputPorts: unknown[];
  @doc("Runtime Spec: language, resources, isolation.")
  requires?: RuntimeSpec;
  @doc("The engine image digest that defines this operator version.")
  version?: string;
}

model OperatorTypeList {
  operators: OperatorType[];
  groups: unknown[];
}

model Attribute {
  attributeName: string;
  attributeType: string;
}

model CompileResult {
  ok: boolean;
  @doc("Output schemas per operator id and output port id.")
  operatorOutputSchemas: Record<Record<Attribute[] | null>>;
  @doc("Errors per operator id.")
  operatorErrors: Record<unknown>;
  physicalPlan?: unknown;
}

enum ExecutionStatus {
  pending,
  running,
  paused,
  completed,
  failed,
  cancelled,
}

model OperatorRun {
  state: string;
  @doc("Rows the operator has read so far, over all its input ports.")
  rowsIn?: int64;
  @doc("Rows the operator has put out so far, over all its output ports.")
  rowsOut?: int64;
  error?: unknown;
}

model PortResult {
  opid: string;
  port: string;
  table?: string;
  snapshot?: string;
  tupleCount?: int64;
  bytes?: int64;
  hash?: string;
}

model RowPage {
  @doc("Column names and types of the result.")
  schema: Attribute[];
  @doc("Rows as positional arrays in schema order.")
  rows: unknown[][];
  offset: int64;
  total?: int64;
}

model LineageDatasetRef {
  `namespace`: string;
  name: string;
  facets?: Record<unknown>;
}

model LineageRun {
  runId: string;
  facets?: Record<unknown>;
}

model LineageJob {
  `namespace`: string;
  name: string;
  facets?: Record<unknown>;
}

model LineageEvent {
  eventType: "START" | "RUNNING" | "COMPLETE" | "FAIL" | "ABORT";
  eventTime: utcDateTime;
  run: LineageRun;
  job: LineageJob;
  inputs?: LineageDatasetRef[];
  outputs?: LineageDatasetRef[];
  producer: string;
  schemaURL: string;
}
