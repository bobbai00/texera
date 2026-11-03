// Operator types as the catalog serves them (GET /catalog/v1/operators), mapped onto the
// editor's OperatorSchema, plus the guards that turn a version's untyped content into a
// WorkflowContent.

import type { OperatorType, OperatorTypeList } from "@texera/catalog-client/types";
import type { JsonSchema, OperatorGroup, OperatorMetadata, OperatorSchema, PortSchema, WorkflowContent } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toPort(p: unknown): PortSchema {
  if (!isRecord(p)) return {};
  return {
    displayName: typeof p.displayName === "string" ? p.displayName : undefined,
    allowMultiLinks: typeof p.allowMultiLinks === "boolean" ? p.allowMultiLinks : undefined,
    dependencies: Array.isArray(p.dependencies) ? (p.dependencies as PortSchema["dependencies"]) : undefined,
  };
}

/** One catalog operator type as the editor's schema. */
export function fromCatalogOperator(op: OperatorType): OperatorSchema {
  const extra = op as OperatorType & { dynamicInputPorts?: boolean; dynamicOutputPorts?: boolean };
  return {
    operatorType: op.operatorType,
    operatorVersion: op.version ?? "",
    userFriendlyName: op.userFriendlyName,
    operatorDescription: op.operatorDescription,
    operatorGroupName: op.operatorGroupName,
    jsonSchema: isRecord(op.jsonSchema) ? (op.jsonSchema as JsonSchema) : {},
    inputPorts: (op.inputPorts ?? []).map(toPort),
    outputPorts: (op.outputPorts ?? []).map(toPort),
    dynamicInputPorts: extra.dynamicInputPorts,
    dynamicOutputPorts: extra.dynamicOutputPorts,
  };
}

/** The catalog's operator list as the editor's metadata. Groups come through as the engine's group tree. */
export function fromCatalogOperators(list: OperatorTypeList): OperatorMetadata {
  const groups = (list.groups ?? []).filter(isRecord).map(toGroup);
  return { operators: list.operators.map(fromCatalogOperator), groups };
}

function toGroup(g: Record<string, unknown>): OperatorGroup {
  const children = Array.isArray(g.children) ? g.children.filter(isRecord).map(toGroup) : null;
  return { groupName: String(g.groupName ?? ""), children };
}

/** Operator schemas by type, for the editor's palette and property panel. */
export const schemaMap = (meta: OperatorMetadata): Map<string, OperatorSchema> =>
  new Map(meta.operators.map(o => [o.operatorType, o]));

/** The icon of an operator type, served beside the app. */
export const operatorImage = (operatorType: string) => `/operator-images/${operatorType}.png`;

export const EMPTY_CONTENT: WorkflowContent = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400, executionMode: "PIPELINED" },
};

/**
 * A version's content as WorkflowContent. Content written by agents or older tools may
 * omit positions, comment boxes or settings; those get defaults so the rest of the app
 * never checks for them.
 */
export function normalizeContent(content: unknown): WorkflowContent {
  if (!isRecord(content)) return { ...EMPTY_CONTENT };
  const operators = Array.isArray(content.operators) ? (content.operators as WorkflowContent["operators"]) : [];
  const settings = isRecord(content.settings) ? (content.settings as Partial<WorkflowContent["settings"]>) : {};
  return {
    operators: operators.map(op => ({
      ...op,
      operatorProperties: isRecord(op.operatorProperties) ? op.operatorProperties : {},
      inputPorts: Array.isArray(op.inputPorts) ? op.inputPorts : [],
      outputPorts: Array.isArray(op.outputPorts) ? op.outputPorts : [],
      showAdvanced: op.showAdvanced ?? false,
    })),
    operatorPositions: isRecord(content.operatorPositions)
      ? (content.operatorPositions as WorkflowContent["operatorPositions"])
      : {},
    links: Array.isArray(content.links) ? (content.links as WorkflowContent["links"]) : [],
    commentBoxes: Array.isArray(content.commentBoxes) ? content.commentBoxes : [],
    settings: {
      dataTransferBatchSize: settings.dataTransferBatchSize ?? 400,
      executionMode: settings.executionMode ?? "PIPELINED",
    },
    ...(content.formBinding !== undefined ? { formBinding: content.formBinding } : {}),
  };
}
