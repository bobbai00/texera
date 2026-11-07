// Why a person may look at a workflow but not run it. The catalog refuses a run, and a dry run,
// naming what the caller lacks (`details.needs`, a URI) and the operator that names it; the page
// says it with what is on screen: the operator's name, the file's name, a kind's word.

import { CatalogError } from "../api";
import { parseUri } from "../uri";

/** Whether an error is the catalog refusing this person something the workflow needs. */
export const isRefusal = (error: unknown): error is CatalogError =>
  error instanceof CatalogError && error.status === 403;

/** The operator a refusal is about, when it is about one. */
export const refusedOperator = (error: CatalogError): string | undefined =>
  typeof error.details?.operator === "string" ? error.details.operator : undefined;

/**
 * A refusal in words, for the person refused: what they lack, where the workflow uses it, and
 * whom to ask. Falls back to the catalog's own message for anything it does not recognise.
 */
export function notRunnable(error: CatalogError, nameOf: (operatorID: string) => string): string {
  const needs = typeof error.details?.needs === "string" ? parseUri(error.details.needs) : undefined;
  const operator = refusedOperator(error);
  const by = operator ? nameOf(operator) : "The workflow";
  switch (needs?.ref.kind) {
    case "dataset": {
      const file = needs.subresource?.startsWith("files/") ? needs.subresource.split("/").at(-1) : undefined;
      return `${by} reads ${file ? `${file}, from a dataset` : "a dataset"} not shared with you. Ask the workflow's owner to share it with you.`;
    }
    case "computing-unit":
      return "You may not run on this computing unit. Pick another, or ask its owner to share it with you.";
    case "warehouse":
      return "You may not keep results in this warehouse. Pick another, or ask its owner to share it with you.";
    case "credential":
      return `${by} uses a credential you may not use. Ask its owner to share it with you.`;
    case "operator":
      return "The workflow uses a custom operator not shared with you. Ask the workflow's owner to share it with you.";
    default:
      return error.message;
  }
}
