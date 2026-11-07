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
  type InputPorts,
  type Line,
  LineError,
  linesOf,
  type PortsOf,
  parseLines,
  type SetLine,
  type Value,
} from "@texera/workflow-model/lines";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { type CatalogClient, CatalogError } from "../catalog/client.ts";
import {
  type CatalogAuth,
  type OperatorSpec,
  parseUri,
  type Validation,
  type WorkflowRecord,
  type WorkflowSpec,
} from "../catalog/types.ts";

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
  'Values are JSON-like: "text", 1.5, true, null, ["a", "b"]; code over several lines goes in """...""". ' +
  "Expressions are text: where=\"glucose < 70\". Ids use letters, digits and '-', never '_'. " +
  'A file is texera://datasets/<rid>@<version>/files/<path>, or by its dataset or model\'s name: "CGM cohort@4/cgm.csv"; ' +
  'a model is texera://models/<rid>@<version>, or by name: predict(cohort, model="Diabetes risk@2").';

/** A workflow record as the agent reads it: where it stands and where it runs, without the JSON of its spec. */
function standing(w: WorkflowRecord) {
  return {
    kind: "workflow",
    metadata: { rid: w.metadata.rid, uri: w.metadata.uri, name: w.metadata.name, head: w.metadata.head },
    ...(w.spec.defaultComputingUnit ? { defaultComputingUnit: w.spec.defaultComputingUnit } : {}),
  };
}

const PYTHON_DOC =
  "Python functions the lines call, as one module. Each top-level function under @returns(column=type, ...) " +
  "becomes one of the project's operators, a new version when its code changed: its positional parameters " +
  "are its inputs, one table each, and its parameters with defaults its settings. A line calls it by its name, " +
  'with by=["patient_id"] to call it once per worker on whole groups: set m: cgm_metrics(night, by=["patient_id"], low=70). ' +
  "A function that may give other rows for the same input (it samples without a seed, reads the clock or calls out) " +
  "adds nondeterministic=True to its @returns, so no run reuses its rows.";

const UNIT_DOC =
  "The computing unit its runs and compiles go to when a call names none, as texera://computing-units/<rid>: " +
  "set it when the workflow needs a unit of its own, such as one with the packages its Python uses.";

/** The operators of a workflow's lines, in the order the lines give them. */
const idsOf = (lines: string[]) => lines.map((l) => /^set ([A-Za-z0-9-]+):/.exec(l)?.[1] ?? "");

/** Each operator's output columns, from a compilation, for the agent to write the next lines against. */
function columnsOf(v: Validation, lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const op of idsOf(lines)) {
    const first = Object.values(v.operatorOutputSchemas?.[op] ?? {})[0];
    if (first) out[op] = first.map((a) => `${a.attributeName} ${a.attributeType}`).join(", ");
  }
  return out;
}

/** The engine's own words for an operator that reads a broken one: it has no columns to check against. */
const NO_SCHEMA = /SchemaNotAvailableException|schema is not available/;
/** The class an engine error was thrown as, which says nothing to the agent. */
const THROWN_AS = /^(?:[a-z][\w$]*\.)+[A-Z][\w$]*: /;

/**
 * Each mistake with the line that made it, in the order of the lines. An operator that only
 * reads a broken one is not a mistake of its own: it is named among those waiting on the fix.
 */
function mistakes(v: Validation, lines: string[]): { errors: { line: string; error: string }[]; waiting: string[] } {
  const all = idsOf(lines).flatMap((op) => {
    const error = v.operatorErrors?.[op];
    if (error === undefined || error === null) return [];
    const text = typeof error === "string" ? error : ((error as { message?: string }).message ?? JSON.stringify(error));
    return [{ op, line: lines[idsOf(lines).indexOf(op)] as string, error: text.replace(THROWN_AS, "") }];
  });
  const own = all.filter((e) => !NO_SCHEMA.test(e.error));
  const shown = own.length > 0 ? own : all;
  return {
    errors: shown.map(({ line, error }) => ({ line, error })),
    waiting: own.length > 0 ? all.filter((e) => NO_SCHEMA.test(e.error)).map((e) => e.op) : [],
  };
}

/** The settings that take a dataset's file: the built-in scan's, and the classic scans'. */
const FILE_SETTINGS = ["file", "fileName"];

/**
 * The input ports of an operator type, as its spec describes them. A built-in without them reads
 * nothing, as a scan; a custom operator without them is not known, and its inputs link in order.
 */
function inputPorts(spec: OperatorSpec): InputPorts | undefined {
  if (!spec.inputPorts && spec.implementation) return undefined;
  const ports = spec.inputPorts ?? [];
  return { names: ports.map((p) => p.displayName ?? ""), manyOnLast: ports.at(-1)?.allowMultiInputs === true };
}

/** How far apart two names are, in edits of one letter. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length] as number;
}

/** What a line is told when no operator has its type: the closest type there is. */
async function unknownType(op: string, deps: LineToolDeps): Promise<string> {
  const types = (await deps.catalog.operators("", deps.project, deps.auth())).map((r) => r.spec.operatorType);
  const close = types
    .map((t) => ({ t, d: t.toLowerCase() === op.toLowerCase() ? 0 : distance(op.toLowerCase(), t.toLowerCase()) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d || Number(b.t === b.t.toLowerCase()) - Number(a.t === a.t.toLowerCase()));
  return close[0]
    ? `there is no operator ${op}; did you mean ${close[0].t}?`
    : `there is no operator ${op}; list_operators with q finds one by name`;
}

/**
 * The operator types the lines use, read once each: their input ports, and a custom operator
 * named by its type is written as its URI at its newest version.
 */
async function typesOf(lines: Line[], deps: LineToolDeps): Promise<{ lines: Line[]; ports: PortsOf }> {
  const ports = new Map<string, InputPorts | undefined>();
  const custom = new Map<string, string>();
  for (const l of lines) {
    if (l.kind !== "set" || ports.has(l.op) || custom.has(l.op)) continue;
    if (l.op.startsWith("texera://")) {
      const { plural, rid, vno } = parseUri(l.op);
      if (plural !== "operators" || vno === undefined)
        throw new LineError(l.line, `${l.op} is not an operator at a version: texera://operators/<rid>@<version>`);
      try {
        const spec = await deps.catalog.operatorAt(rid, vno, deps.auth());
        ports.set(l.op, inputPorts({ implementation: {}, ...spec }));
      } catch (e) {
        if (e instanceof CatalogError && (e.status === 404 || e.status === 403))
          throw new LineError(l.line, `there is no operator ${l.op} you may use`);
        throw e;
      }
      continue;
    }
    const found = (await deps.catalog.operators(l.op, deps.project, deps.auth())).filter(
      (r) => r.spec.operatorType === l.op,
    );
    if (found.length === 0) throw new LineError(l.line, await unknownType(l.op, deps));
    if (found.length > 1)
      throw new LineError(
        l.line,
        `${found.length} operators are named ${l.op}: ${found.map((r) => r.metadata.uri).join(", ")}; use one's URI`,
      );
    const r = found[0] as (typeof found)[number];
    if (r.spec.implementation) {
      const uri = `${r.metadata.uri}@${r.metadata.head}`;
      custom.set(l.op, uri);
      ports.set(uri, inputPorts(r.spec));
    } else ports.set(l.op, inputPorts(r.spec));
  }
  return {
    lines: lines.map((l) => (l.kind === "set" && custom.has(l.op) ? { ...l, op: custom.get(l.op) as string } : l)),
    ports: (type) => ports.get(type),
  };
}

/**
 * The functions a Python module makes operators of: the top-level ones with @returns among the
 * decorators right above them.
 */
export function functionsIn(python: string): string[] {
  const lines = python.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    const def = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (!def) return;
    // Up over the decorators and their continued lines, to the line before them.
    for (let k = i - 1; k >= 0; k--) {
      const above = lines[k] as string;
      if (above.startsWith("@returns")) {
        out.push(def[1] as string);
        return;
      }
      if (!(above.startsWith("@") || /^[\s)\]]/.test(above)) || above.trim() === "") return;
    }
  });
  return out;
}

/** What saving a module's functions did to each operator. */
interface SavedFunction {
  name: string;
  operator: string;
  version: number;
  saved: "created" | "new version" | "unchanged";
}

/**
 * Saves each function of a module as one of the project's operators, a new version only when
 * its code changed. The catalog reads each one's inputs, settings and columns from the code, and
 * refuses one it cannot read, on its line.
 */
async function saveFunctions(python: string, deps: LineToolDeps): Promise<SavedFunction[]> {
  const names = functionsIn(python);
  if (names.length === 0)
    throw new LineError(
      1,
      "the python defines no function under @returns(...): name each function's output columns and their types above its def",
    );
  const out: SavedFunction[] = [];
  for (const name of names) {
    const mine = (await deps.catalog.operators(name, deps.project, deps.auth())).find(
      (r) => r.spec.operatorType === name && r.spec.implementation && r.metadata.project === deps.project,
    );
    const implementation = { python: { code: python, function: name } };
    try {
      if (!mine) {
        const r = await deps.catalog.createOperator(
          name,
          { operatorType: name, implementation },
          deps.project,
          deps.auth(),
        );
        out.push({ name, operator: r.metadata.uri, version: r.metadata.head, saved: "created" });
      } else if (
        mine.spec.implementation?.python?.code === python &&
        mine.spec.implementation?.python?.function === name
      ) {
        out.push({ name, operator: mine.metadata.uri, version: mine.metadata.head, saved: "unchanged" });
      } else {
        const r = await deps.catalog.updateOperatorSpec(
          mine.metadata.rid,
          { ...mine.spec, implementation },
          "the agent's edit",
          deps.auth(),
        );
        out.push({ name, operator: r.metadata.uri, version: r.metadata.head, saved: "new version" });
      }
    } catch (e) {
      if (e instanceof CatalogError && e.status === 400) throw new Error(`python, ${name}: ${e.message}`);
      throw e;
    }
  }
  return out;
}

/** Reads an edit's lines, resolving the files and operator types they name. */
async function readLines(text: string, deps: LineToolDeps): Promise<{ edit: Line[]; ports: PortsOf }> {
  const { lines, ports } = await typesOf(parseLines(text), deps);
  return { edit: await resolveFiles(lines, deps), ports };
}

/** A setting that names a dataset's file by the dataset's name, resolved to its URI at a version. */
async function resolveFiles(lines: Line[], deps: LineToolDeps): Promise<Line[]> {
  const out: Line[] = [];
  for (const l of lines) {
    if (l.kind !== "set") {
      out.push(l);
      continue;
    }
    const settings = { ...l.settings };
    for (const key of FILE_SETTINGS) {
      const named = settings[key];
      if (typeof named === "string" && !named.startsWith("texera://")) settings[key] = await fileUri(named, l, deps);
    }
    const model = settings.model;
    if (typeof model === "string" && !model.startsWith("texera://")) settings.model = await modelUri(model, l, deps);
    out.push({ ...l, settings });
  }
  return out;
}

/**
 * The one resource of these kinds with a name in the project, and the version a `@n` after the
 * name pins: a file is a dataset's or a model version's, a model only a model.
 */
async function oneNamed(kinds: ("dataset" | "model")[], named: string, line: SetLine, deps: LineToolDeps) {
  const at = /^(.*)@(\d+)$/.exec(named);
  const name = (at ? at[1] : named) as string;
  const found = [];
  for (const kind of kinds)
    found.push(
      ...(await deps.catalog.searchResources(kind, name, deps.project, deps.auth()))
        .filter((r) => r.metadata.name.toLowerCase() === name.trim().toLowerCase())
        .map((r) => ({ ...r, kind })),
    );
  const what = kinds.join(" or ");
  if (found.length === 0)
    throw new LineError(line.line, `no ${what} named "${name}" in this project; search_resources lists them`);
  if (found.length > 1)
    throw new LineError(
      line.line,
      `${found.length} resources are named "${name}": ${found.map((r) => r.metadata.uri).join(", ")}; use one's URI`,
    );
  const resource = found[0] as (typeof found)[number];
  return { resource, name, vno: at ? Number(at[2]) : (resource.metadata.head ?? 1) };
}

/** A model named by its name, at the version named or its newest: texera://models/<rid>@<version>. */
async function modelUri(named: string, line: SetLine, deps: LineToolDeps): Promise<Value> {
  const { resource, vno } = await oneNamed(["model"], named, line, deps);
  return `${resource.metadata.uri}@${vno}`;
}

async function fileUri(named: string, line: SetLine, deps: LineToolDeps): Promise<Value> {
  const slash = named.indexOf("/");
  const head = slash < 0 ? named : named.slice(0, slash);
  const path = slash < 0 ? undefined : named.slice(slash + 1);
  const { resource, name, vno } = await oneNamed(["dataset", "model"], head, line, deps);
  let file = path;
  if (!file) {
    const plural = resource.kind === "model" ? "models" : "datasets";
    const files = await deps.catalog.versionFiles(plural, resource.metadata.rid, vno, deps.auth());
    if (files.length !== 1)
      throw new LineError(
        line.line,
        `"${name}" has ${files.length} files at version ${vno}: ${files.slice(0, 8).join(", ")}; name one, as in "${name}/${files[0] ?? "data.csv"}"`,
      );
    file = files[0] as string;
  }
  return `${resource.metadata.uri}@${vno}/files/${file}`;
}

/** Saves a workflow's new spec and compiles it, answering in lines. */
async function saved(w: WorkflowRecord, deps: LineToolDeps) {
  const lines = linesOf(w.spec);
  let checked: Validation | undefined;
  let unchecked: string | undefined;
  try {
    checked = await deps.catalog.validateWorkflow(w.metadata.rid, deps.auth());
  } catch (e) {
    unchecked = e instanceof Error ? e.message : String(e);
  }
  const wrong = checked && !checked.ok ? mistakes(checked, lines) : undefined;
  return {
    workflow: standing(w),
    lines,
    ...(checked ? { columns: columnsOf(checked, lines) } : {}),
    ...(wrong ? { errors: wrong.errors } : {}),
    ...(wrong && wrong.waiting.length > 0 ? { waitingOnTheFix: wrong.waiting } : {}),
    ...(unchecked ? { notChecked: unchecked } : {}),
  };
}

/** A refusal the model reads and can act on. */
const refusal = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

/** The workflow's calls to the functions an edit saved, moved to the versions it saved. */
function callingSaved(spec: WorkflowSpec, functions: SavedFunction[]): WorkflowSpec {
  const latest = new Map(functions.map((f) => [f.operator, `${f.operator}@${f.version}`]));
  return {
    ...spec,
    operators: spec.operators.map((op) => {
      const base = op.operatorType.replace(/@\d+$/, "");
      const now = latest.get(base);
      return now && now !== op.operatorType ? { ...op, operatorType: now } : op;
    }),
  };
}

export function workflowLineTools(deps: LineToolDeps): ToolSet {
  const empty: WorkflowSpec = { operators: [], links: [] };
  return {
    create_workflow: tool({
      description: `Create a workflow from lines, in this chat's project. ${LINES_DOC}`,
      inputSchema: z.object({
        name: z.string().min(1),
        lines: z.string().min(1).describe("The workflow's lines."),
        python: z.string().optional().describe(PYTHON_DOC),
        defaultComputingUnit: z.string().startsWith("texera://computing-units/").optional().describe(UNIT_DOC),
      }),
      execute: async ({ name, lines, python, defaultComputingUnit }) => {
        try {
          const functions = python?.trim() ? await saveFunctions(python, deps) : [];
          const { edit, ports } = await readLines(lines, deps);
          const spec = { ...applyLines(empty, edit, ports), ...(defaultComputingUnit ? { defaultComputingUnit } : {}) };
          const w = await deps.catalog.createWorkflow(name, spec, deps.project, deps.auth());
          return { ...(await saved(w, deps)), ...(functions.length > 0 ? { functions } : {}) };
        } catch (e) {
          return refusal(e);
        }
      },
    }),
    edit_workflow: tool({
      description: `Change a workflow with lines; it becomes a new version. ${LINES_DOC} Only the lines you send change: the other operators stay.`,
      inputSchema: z
        .object({
          rid: z.string().min(1),
          lines: z.string().optional().describe("The lines of the change."),
          python: z.string().optional().describe(PYTHON_DOC),
          defaultComputingUnit: z.string().startsWith("texera://computing-units/").optional().describe(UNIT_DOC),
        })
        .refine((a) => (a.lines ?? "").trim() !== "" || (a.python ?? "").trim() !== "" || a.defaultComputingUnit, {
          message: "send lines, python, a defaultComputingUnit, or some of them",
        }),
      execute: async ({ rid, lines, python, defaultComputingUnit }) => {
        try {
          const functions = python?.trim() ? await saveFunctions(python, deps) : [];
          const { edit, ports } = await readLines(lines ?? "", deps);
          const said = [
            ...(edit.length > 0 ? [`${edit.length} line${edit.length === 1 ? "" : "s"} from the agent`] : []),
            ...functions.filter((f) => f.saved !== "unchanged").map((f) => `${f.name} ${f.saved}`),
            ...(defaultComputingUnit ? [`runs on ${defaultComputingUnit}`] : []),
          ].join("; ");
          // Someone may save in between: the change goes onto the head it was made against, once more if it moved.
          for (let attempt = 0; ; attempt++) {
            const current = await deps.catalog.getWorkflow(rid, deps.auth());
            const spec = {
              ...callingSaved(applyLines(current.spec, edit, ports), functions),
              ...(defaultComputingUnit ? { defaultComputingUnit } : {}),
            };
            try {
              const w = await deps.catalog.updateWorkflowSpec(rid, spec, current.metadata.head, said, deps.auth());
              return { ...(await saved(w, deps)), ...(functions.length > 0 ? { functions } : {}) };
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
