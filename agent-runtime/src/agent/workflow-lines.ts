/**
 * The agent writes a workflow as lines, one per operator:
 *
 *   set night: filter(readings, where="hour(taken_at) >= 22 or hour(taken_at) < 6")
 *
 * These tools take lines in place of the catalog's JSON create_workflow and edit_workflow, and
 * get_workflow answers in lines. An edit's lines apply together or not at all. A file a line names
 * by its dataset's name is resolved to its URI at a version. The workflow is saved as a new
 * version and compiled on a unit, and the answer is the workflow as lines, each operator's output
 * columns, and each mistake on its line, so the agent fixes what it wrote, where it wrote it.
 */
import {
  applyLines,
  type Line,
  LineError,
  linesOf,
  parseLines,
  type SetLine,
  type Value,
} from "@texera/workflow-model/lines";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { type CatalogClient, CatalogError } from "../catalog/client.ts";
import type { CatalogAuth, Validation, WorkflowRecord, WorkflowSpec } from "../catalog/types.ts";

/** The catalog's tools these replace, by name. */
export const LINE_TOOLS = ["create_workflow", "edit_workflow", "get_workflow"] as const;

export interface LineToolDeps {
  catalog: CatalogClient;
  auth: () => CatalogAuth;
  /** The chat's project: where a new workflow goes and where a dataset's name is looked up. */
  project: string;
}

const LINES_DOC =
  "Lines, one statement each: `set <id>: <op>(<inputs>, <setting>=<value>, ...)` creates or replaces an operator; " +
  "`delete <id>` removes one. Inputs are other operators' ids, in port order (a join's left, then its right). " +
  'Values are JSON-like: "text", 1.5, true, null, ["a", "b"]. Expressions are text: where="glucose < 70". ' +
  "Ids use letters, digits and '-', never '_'. A file is texera://datasets/<rid>@<version>/files/<path>, or by name: \"CGM cohort@4/cgm.csv\".";

/** A workflow record as the agent reads it: where it stands, without the JSON of its spec. */
function standing(w: WorkflowRecord) {
  return {
    kind: "workflow",
    metadata: { rid: w.metadata.rid, uri: w.metadata.uri, name: w.metadata.name, head: w.metadata.head },
  };
}

/** Each operator's output columns, from a compilation, for the agent to write the next lines against. */
function columnsOf(v: Validation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [op, ports] of Object.entries(v.operatorOutputSchemas ?? {})) {
    const first = Object.values(ports ?? {})[0];
    if (first) out[op] = first.map((a) => `${a.attributeName} ${a.attributeType}`).join(", ");
  }
  return out;
}

/** Each mistake on its line: the edit's line for an operator it set, else the operator's line now. */
function mistakes(v: Validation, edit: Line[], now: string[]): { line?: number; operator: string; error: string }[] {
  return Object.entries(v.operatorErrors ?? {}).map(([operator, error]) => {
    const set = edit.find((l) => l.kind === "set" && l.id === operator);
    const text =
      typeof error === "string" ? error : ((error as { message?: string })?.message ?? JSON.stringify(error));
    const at = set?.line ?? now.findIndex((l) => l.startsWith(`set ${operator}:`)) + 1;
    return { ...(at > 0 ? { line: at } : {}), operator, error: text };
  });
}

/** A setting that names a dataset's file by the dataset's name, resolved to its URI at a version. */
async function resolveFiles(lines: Line[], deps: LineToolDeps): Promise<Line[]> {
  const out: Line[] = [];
  for (const l of lines) {
    if (l.kind !== "set" || typeof l.settings.file !== "string" || l.settings.file.startsWith("texera://")) {
      out.push(l);
      continue;
    }
    out.push({ ...l, settings: { ...l.settings, file: await fileUri(l.settings.file, l, deps) } } as SetLine);
  }
  return out;
}

async function fileUri(named: string, line: SetLine, deps: LineToolDeps): Promise<Value> {
  const slash = named.indexOf("/");
  const head = slash < 0 ? named : named.slice(0, slash);
  const path = slash < 0 ? undefined : named.slice(slash + 1);
  const at = /^(.*)@(\d+)$/.exec(head);
  const name = (at ? at[1] : head) as string;
  const found = (await deps.catalog.searchResources("dataset", name, deps.project, deps.auth())).filter(
    (r) => r.metadata.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (found.length === 0)
    throw new LineError(line.line, `no dataset named "${name}" in this project; search_resources lists the datasets`);
  if (found.length > 1)
    throw new LineError(
      line.line,
      `${found.length} datasets are named "${name}": ${found.map((r) => r.metadata.uri).join(", ")}; use one's URI`,
    );
  const dataset = found[0] as (typeof found)[number];
  const vno = at ? Number(at[2]) : (dataset.metadata.head ?? 1);
  let file = path;
  if (!file) {
    const files = await deps.catalog.datasetFiles(dataset.metadata.rid, vno, deps.auth());
    if (files.length !== 1)
      throw new LineError(
        line.line,
        `"${name}" has ${files.length} files at version ${vno}: ${files.slice(0, 8).join(", ")}; name one, as in "${name}/${files[0] ?? "data.csv"}"`,
      );
    file = files[0] as string;
  }
  return `${dataset.metadata.uri}@${vno}/files/${file}`;
}

/** Saves a workflow's new spec and compiles it, answering in lines. */
async function saved(w: WorkflowRecord, edit: Line[], deps: LineToolDeps) {
  const lines = linesOf(w.spec);
  let checked: Validation | undefined;
  let unchecked: string | undefined;
  try {
    checked = await deps.catalog.validateWorkflow(w.metadata.rid, deps.auth());
  } catch (e) {
    unchecked = e instanceof Error ? e.message : String(e);
  }
  return {
    workflow: standing(w),
    lines,
    ...(checked ? { columns: columnsOf(checked) } : {}),
    ...(checked && !checked.ok ? { errors: mistakes(checked, edit, lines) } : {}),
    ...(unchecked ? { notChecked: unchecked } : {}),
  };
}

/** A refusal the model reads and can act on. */
const refusal = (e: unknown) => ({
  error: e instanceof LineError || e instanceof CatalogError ? e.message : String(e),
});

export function workflowLineTools(deps: LineToolDeps): ToolSet {
  const empty: WorkflowSpec = { operators: [], links: [] };
  return {
    create_workflow: tool({
      description: `Create a workflow from lines, in this chat's project. ${LINES_DOC}`,
      inputSchema: z.object({ name: z.string().min(1), lines: z.string().min(1).describe("The workflow's lines.") }),
      execute: async ({ name, lines }) => {
        try {
          const edit = await resolveFiles(parseLines(lines), deps);
          const spec = applyLines(empty, edit);
          const w = await deps.catalog.createWorkflow(name, spec, deps.project, deps.auth());
          return await saved(w, edit, deps);
        } catch (e) {
          return refusal(e);
        }
      },
    }),
    edit_workflow: tool({
      description: `Change a workflow with lines; it becomes a new version. ${LINES_DOC} Only the lines you send change: the other operators stay.`,
      inputSchema: z.object({ rid: z.string().min(1), lines: z.string().min(1).describe("The lines of the change.") }),
      execute: async ({ rid, lines }) => {
        try {
          const edit = await resolveFiles(parseLines(lines), deps);
          // Someone may save in between: the change goes onto the head it was made against, once more if it moved.
          for (let attempt = 0; ; attempt++) {
            const current = await deps.catalog.getWorkflow(rid, deps.auth());
            const spec = applyLines(current.spec, edit);
            try {
              const w = await deps.catalog.updateWorkflowSpec(
                rid,
                spec,
                current.metadata.head,
                `${edit.length} line${edit.length === 1 ? "" : "s"} from the agent`,
                deps.auth(),
              );
              return await saved(w, edit, deps);
            } catch (e) {
              if (e instanceof CatalogError && e.status === 409 && attempt < 1) continue;
              throw e;
            }
          }
        } catch (e) {
          return refusal(e);
        }
      },
    }),
    get_workflow: tool({
      description: "Read a workflow as lines, with where it stands (its version).",
      inputSchema: z.object({ rid: z.string().min(1) }),
      execute: async ({ rid }) => {
        try {
          const w = await deps.catalog.getWorkflow(rid, deps.auth());
          return { workflow: standing(w), lines: linesOf(w.spec) };
        } catch (e) {
          return refusal(e);
        }
      },
    }),
  };
}
