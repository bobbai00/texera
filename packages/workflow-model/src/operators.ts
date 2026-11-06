// Operator types as the catalog serves them (the operator resources of the system project
// and the person's own custom operators), mapped onto the editor's OperatorSchema, plus the
// guards that fill in what a spec written by an agent may leave out.

import type { Operator, OperatorPortSpec } from "@texera/catalog-client/types";
import type { JsonSchema, OperatorSchema, PortSchema, Positions, WorkflowOperator, WorkflowPort, WorkflowSpec } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const toPort = (p: OperatorPortSpec): PortSchema => ({
  ...(p.displayName ? { displayName: p.displayName } : {}),
  ...(p.allowMultiInputs !== undefined ? { allowMultiLinks: p.allowMultiInputs } : {}),
});

/**
 * One operator resource as the editor's schema. An operator the engine provides has no
 * implementation of its own and is typed by its name; a custom one is typed by its URI with `@vno`.
 */
export function fromOperatorResource(op: Operator): OperatorSchema {
  const custom = !!op.spec.implementation;
  return {
    operatorType: custom ? `${op.metadata.uri}@${op.metadata.head}` : op.spec.operatorType,
    userFriendlyName: op.spec.displayName || op.spec.operatorType,
    operatorDescription: op.spec.description,
    operatorGroupName: op.spec.group || (custom ? "Custom" : "Other"),
    jsonSchema: isRecord(op.spec.propertiesSchema) ? (op.spec.propertiesSchema as JsonSchema) : {},
    inputPorts: (op.spec.inputPorts ?? []).map(toPort),
    outputPorts: (op.spec.outputPorts ?? []).map(toPort),
    ...(custom ? { custom: { rid: op.metadata.rid, vno: op.metadata.head } } : {}),
  };
}

/** Operator schemas by type, for the editor's palette and property panel. */
export const schemaMap = (operators: Operator[]): Map<string, OperatorSchema> =>
  new Map(operators.map(fromOperatorResource).map(s => [s.operatorType, s]));

/** The icon of an operator type, served beside the app; custom operators share one. */
export const operatorImage = (operatorType: string) =>
  operatorType.startsWith("texera://") ? "/operator-images/PythonUDFV2.png" : `/operator-images/${operatorType}.png`;

export const EMPTY_SPEC: WorkflowSpec = { operators: [], links: [] };

/** The catalog's rule for an operator without ports: sources have no input, everything has one output. */
export const isSourceType = (operatorType: string) => /scan|source|generator/i.test(operatorType);

const DEFAULT_INPUTS: WorkflowPort[] = [{ portID: "input-0" }];
const DEFAULT_OUTPUTS: WorkflowPort[] = [{ portID: "output-0" }];

/** An operator with its ports made explicit, as the catalog does before compiling. */
/** The ports an operator's links use on one side, in port order. */
function usedPorts(links: readonly WorkflowSpec["links"][number][], id: string, side: "source" | "target"): WorkflowPort[] {
  const used = new Set(links.filter(l => l[side].operatorID === id).map(l => l[side].portID));
  const index = (portID: string) => Number(portID.slice(portID.lastIndexOf("-") + 1));
  return [...used].sort((a, b) => index(a) - index(b)).map(portID => ({ portID }));
}

/**
 * An operator with its ports spelled out. One that lists none gets the ones its links use, at
 * least one input unless it reads nothing and one output, as the catalog does: no link is lost.
 */
export function withPorts(op: WorkflowOperator, links: readonly WorkflowSpec["links"][number][] = []): WorkflowOperator {
  const inputs = usedPorts(links, op.operatorID, "target");
  const outputs = usedPorts(links, op.operatorID, "source");
  return {
    ...op,
    operatorProperties: isRecord(op.operatorProperties) ? op.operatorProperties : {},
    inputPorts: op.inputPorts?.length
      ? op.inputPorts
      : inputs.length
        ? inputs
        : isSourceType(op.operatorType)
          ? []
          : DEFAULT_INPUTS,
    outputPorts: op.outputPorts?.length ? op.outputPorts : outputs.length ? outputs : DEFAULT_OUTPUTS,
  };
}

/**
 * A version's content as a WorkflowSpec with explicit ports, and where its operators sat when
 * it was made. Specs written by agents may omit ports and properties; those get the catalog's
 * defaults so the rest of the app never checks for them.
 */
export function normalizeSpec(content: unknown): WorkflowSpec {
  if (!isRecord(content)) return { ...EMPTY_SPEC };
  const operators = Array.isArray(content.operators) ? (content.operators as WorkflowOperator[]) : [];
  const links = Array.isArray(content.links) ? (content.links as WorkflowSpec["links"]) : [];
  return {
    operators: operators.map(op => withPorts(op, links)),
    links,
    ...(typeof content.defaultEnvironment === "string" ? { defaultEnvironment: content.defaultEnvironment } : {}),
    ...(typeof content.defaultComputingUnit === "string" ? { defaultComputingUnit: content.defaultComputingUnit } : {}),
    ...(typeof content.defaultWarehouse === "string" ? { defaultWarehouse: content.defaultWarehouse } : {}),
    ...(isRecord(content.layout) ? { layout: content.layout as Positions } : {}),
  };
}
