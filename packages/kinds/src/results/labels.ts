// A result is named as its operator's card names it: the name a person gave it, else its
// type's; what it does in a few words; its type, for its icon. Two aggregates are told apart.

import {
  describeProperties,
  type OperatorSchema,
  operatorLabel,
  summarize,
  type WorkflowSpec,
} from "@texera/workflow-model";
import { isUri } from "../uri";
import type { ResultLabel } from "./ResultsWindow";

export function resultLabel(
  spec: WorkflowSpec | undefined,
  schemas: Map<string, OperatorSchema> | undefined,
  operatorID: string
): ResultLabel {
  const op = spec?.operators.find(o => o.operatorID === operatorID);
  if (!op) return { title: operatorID };
  const schema = schemas?.get(op.operatorType);
  const title = op.customDisplayName || schema?.userFriendlyName || operatorLabel(op);
  // A resource's URI says nothing to a person reading a tab.
  const said = schema ? describeProperties(schema.jsonSchema, op.operatorProperties ?? {}).filter(l => !isUri(l.short)) : [];
  const summary = summarize(said);
  return { title, type: op.operatorType, ...(summary ? { summary } : {}) };
}
