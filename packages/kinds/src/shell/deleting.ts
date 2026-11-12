// The words and the way out of the one question every delete asks: what goes with the thing,
// what the catalog said when it refused, and where the person stands once it is gone.

import { CatalogError } from "../api";
import type { KindId, ResourceRef } from "../types";
import { baseUri, href } from "../uri";

/** What goes with a resource when it is deleted, said before it is. */
export function goesWith(kind: KindId, executions?: number): string {
  switch (kind) {
    case "conversation":
      return "Its messages go with it, and the files attached to it that no workflow reads. What the chat made stays in the project.";
    case "workflow":
      if (executions === 0) return "Every version of it goes.";
      if (executions === 1) return "Every version of it goes, and its execution with its results.";
      return `Every version of it goes, and its ${executions === undefined ? "" : `${executions} `}executions with their results.`;
    case "execution":
      return "Its results go with it. The workflow stays.";
    case "dataset":
    case "model":
      return "Every version of it goes, with its files.";
    case "computing-unit":
      return "It is stopped and given back. Executions that ran on it keep their results.";
    case "project":
      return "A project goes once it holds nothing. Its settings and its people's access go with it.";
    default:
      return "";
  }
}

export interface Refusal {
  /** Why the thing stays, in a sentence. */
  said: string;
  /** What stands in the way, each once, by its URI without a version. */
  blockers: string[];
}

const uris = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : []).filter((u): u is string => typeof u === "string").map(baseUri))];

/** What the catalog said when it would not delete, for the person to act on; undefined for anything that is not such a refusal. */
export function refusalOf(error: unknown): Refusal | undefined {
  if (!(error instanceof CatalogError) || error.status !== 409) return undefined;
  switch (error.code) {
    case "referenced": {
      const blockers = uris(error.details?.dependents);
      return { said: blockers.length === 1 ? "It stays for now: something still uses it." : `It stays for now: ${blockers.length || "other"} resources still use it.`, blockers };
    }
    case "inherited": {
      const blockers = uris(error.details?.inheritors);
      return { said: "It stays for now: other projects inherit from it, and need another base first.", blockers };
    }
    case "running":
      return { said: "It stays for now: an execution is still going. Stop it first.", blockers: uris([error.details?.execution]) };
    default:
      return { said: error.message, blockers: [] };
  }
}

/**
 * Where to go when what was deleted is what the page shows, or holds it (a workflow, with the
 * page on one of its executions): an execution's workflow, the project a thing lived in, the
 * start page for a chat or a project. Undefined when the page is of something else and stays.
 */
export function pageAfter(ref: ResourceRef, project: string | undefined, pathname: string): string | undefined {
  if (!pathname.split("/").includes(ref.rid)) return undefined;
  if (ref.kind === "execution" && ref.parent) return href({ kind: "workflow", rid: ref.parent });
  if (ref.kind === "conversation" || ref.kind === "project" || !project) return "/";
  return href({ kind: "project", rid: project });
}
