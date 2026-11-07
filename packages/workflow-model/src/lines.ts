// A workflow as lines, the way the agent writes it and a card names an operator:
//
//   set night: filter(readings, where="hour(taken_at) >= 22 or hour(taken_at) < 6")
//   delete old
//
// A `set` names an operator, its type, its inputs (other operators, in port order) and its
// settings; a `delete` removes one. A set replaces an operator whole, its settings and its
// inputs; the operators reading it keep reading it. The lines of one edit apply together or
// not at all, and an input may name an operator a later line of the same edit sets.
//
// Text is in quotes, "..." or '...' with backslash escapes, or """...""" taken as it is, for
// code over several lines. A setting whose name is not a word is quoted: "result attribute"=1.

import type { WorkflowLink, WorkflowOperator, WorkflowSpec } from "./types";

export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

export interface SetLine {
  kind: "set";
  id: string;
  op: string;
  inputs: string[];
  settings: Record<string, Value>;
  /** 1-based, counting the lines of the text. */
  line: number;
}
export interface DeleteLine {
  kind: "delete";
  id: string;
  line: number;
}
export type Line = SetLine | DeleteLine;

/** What is wrong, and on which line. */
export class LineError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

type Token =
  | { t: "word"; v: string; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "num"; v: number; at: number }
  | { t: "sym"; v: string; at: number }
  | { t: "nl"; at: number }
  | { t: "end"; at: number };

const ID = /^[A-Za-z][A-Za-z0-9-]*$/;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "#" && depth === 0) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "\n") {
      // A line break inside brackets continues the line; outside, it ends a statement.
      if (depth === 0) out.push({ t: "nl", at: i });
      i++;
    } else if (/\s/.test(c)) i++;
    else if ((c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
      // Taken as it is, newlines and backslashes included: code reads as it is written.
      const end = text.indexOf(c.repeat(3), i + 3);
      if (end < 0) throw new Error(`at ${i}: the text that starts here is not closed with ${c.repeat(3)}`);
      out.push({ t: "str", v: text.slice(i + 3, end), at: i });
      i = end + 3;
    } else if (c === '"' || c === "'") {
      const start = i;
      let s = "";
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\" && i + 1 < text.length) {
          const e = text[i + 1] as string;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
        } else s += text[i++];
      }
      if (i >= text.length) throw new Error(`at ${start}: the text that starts here is not closed with ${c}`);
      i++;
      out.push({ t: "str", v: s, at: start });
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(text.slice(i)) as RegExpExecArray;
      out.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*(?::\/\/[^\s,()[\]{}]*)?/.exec(text.slice(i)) as RegExpExecArray;
      out.push({ t: "word", v: m[0], at: i });
      i += m[0].length;
    } else if ("()[]{},:=".includes(c)) {
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      out.push({ t: "sym", v: c, at: i });
      i++;
    } else if ("<>!*+/%|&-".includes(c)) {
      throw new Error(
        `at ${i}: '${c}' has no meaning here; an expression is text, so put it in quotes: where="glucose < 70"`
      );
    } else throw new Error(`at ${i}: '${c}' has no meaning here`);
  }
  out.push({ t: "end", at: text.length });
  return out;
}

/** Reads the lines of an edit. */
export function parseLines(text: string): Line[] {
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length;
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (e) {
    const m = /^at (\d+): (.*)$/.exec((e as Error).message);
    throw new LineError(m ? lineAt(Number(m[1])) : 1, m ? (m[2] as string) : (e as Error).message);
  }
  let k = 0;
  const peek = () => tokens[k] as Token;
  const next = () => tokens[k++] as Token;
  const fail = (t: Token, message: string): never => {
    throw new LineError(lineAt(t.at), message);
  };
  const said = (t: Token) =>
    t.t === "end" || t.t === "nl" ? "the end of the line" : t.t === "str" ? JSON.stringify(t.v) : `'${String(t.v)}'`;
  const expect = (v: string, what: string) => {
    const t = next();
    if (t.t !== "sym" || t.v !== v) fail(t, `expected '${v}' ${what}, found ${said(t)}`);
  };
  const operatorId = (t: Token): string => {
    if (t.t !== "word") return fail(t, `expected an operator id, found ${said(t)}`);
    if (t.v.includes("_"))
      return fail(t, `an operator id may not contain '_'; use '-', as in ${t.v.replaceAll("_", "-")}`);
    if (!ID.test(t.v)) return fail(t, `'${t.v}' is not an operator id: letters, digits and '-'`);
    return t.v;
  };
  const value = (): Value => {
    const t = next();
    if (t.t === "str" || t.t === "num") return t.v;
    if (t.t === "word") {
      if (t.v === "true" || t.v === "True") return true;
      if (t.v === "false" || t.v === "False") return false;
      if (t.v === "null" || t.v === "None") return null;
      return fail(t, `${said(t)} is not a value: put text in quotes`);
    }
    if (t.t === "sym" && t.v === "[") {
      const list: Value[] = [];
      while (!(peek().t === "sym" && (peek() as { v: string }).v === "]")) {
        list.push(value());
        if (peek().t === "sym" && (peek() as { v: string }).v === ",") next();
        else break;
      }
      expect("]", "to close the list");
      return list;
    }
    if (t.t === "sym" && t.v === "{") {
      const map: Record<string, Value> = {};
      while (!(peek().t === "sym" && (peek() as { v: string }).v === "}")) {
        const key = next();
        if (key.t !== "str" && key.t !== "word") fail(key, `expected a key, found ${said(key)}`);
        expect(":", "after a key");
        map[String((key as { v: string }).v)] = value();
        if (peek().t === "sym" && (peek() as { v: string }).v === ",") next();
        else break;
      }
      expect("}", "to close the map");
      return map;
    }
    return fail(t, `expected a value, found ${said(t)}`);
  };

  const lines: Line[] = [];
  while (peek().t !== "end") {
    if (peek().t === "nl") {
      next();
      continue;
    }
    const head = next();
    const line = lineAt(head.at);
    if (head.t === "word" && head.v === "delete") {
      lines.push({ kind: "delete", id: operatorId(next()), line });
    } else if (head.t === "word" && head.v === "set") {
      const id = operatorId(next());
      expect(":", `after ${id}`);
      const opToken = next();
      if (opToken.t !== "word") fail(opToken, `expected an operator type after ${id}:, found ${said(opToken)}`);
      const op = String((opToken as { v: string }).v);
      expect("(", `after ${op}`);
      const inputs: string[] = [];
      const settings: Record<string, Value> = {};
      while (!(peek().t === "sym" && (peek() as { v: string }).v === ")")) {
        const t = next();
        const after = peek();
        if ((t.t === "word" || t.t === "str") && after.t === "sym" && after.v === "=") {
          next();
          if (t.v in settings) fail(t, `${t.v} is set twice`);
          settings[t.v] = value();
        } else {
          if (Object.keys(settings).length > 0) fail(t, `the inputs come before the settings`);
          inputs.push(operatorId(t));
        }
        if (peek().t === "sym" && (peek() as { v: string }).v === ",") next();
        else break;
      }
      expect(")", `to close ${op}(`);
      lines.push({ kind: "set", id, op, inputs, settings, line });
    } else {
      fail(head, `a line starts with set or delete, not ${said(head)}`);
    }
    const end = peek();
    if (end.t !== "nl" && end.t !== "end") fail(end, `${said(end)} does not belong after the statement`);
  }
  return lines;
}

export interface PrintOptions {
  /** Text over several lines as """...""", as code is read; else on one line, as a card shows it. */
  multiline?: boolean;
}

/** A value as a line writes it. */
export function printValue(v: Value, options: PrintOptions = {}): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(x => printValue(x, options)).join(", ")}]`;
  if (typeof v === "object")
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${printValue(x, options)}`)
      .join(", ")}}`;
  if (typeof v !== "string") return String(v);
  // """...""" reads back as it is, unless the text holds """ or ends in a quote.
  if (options.multiline && v.includes("\n") && !v.includes('"""') && !v.endsWith('"')) return `"""${v}"""`;
  return JSON.stringify(v);
}

const WORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The inputs of an operator, by the operators its links come from, in port order. */
export function inputsOf(spec: WorkflowSpec, operatorID: string): string[] {
  const port = (p: string) => Number(p.slice(p.lastIndexOf("-") + 1));
  return spec.links
    .filter(l => l.target.operatorID === operatorID)
    .sort((a, b) => port(a.target.portID) - port(b.target.portID))
    .map(l => l.source.operatorID);
}

/** An operator as a card names it: `filter(readings, where="...")`. */
export function callOf(spec: WorkflowSpec, op: WorkflowOperator, options: PrintOptions = {}): string {
  const settings = Object.entries(op.operatorProperties ?? {}).map(
    ([k, v]) => `${WORD.test(k) ? k : JSON.stringify(k)}=${printValue(v as Value, options)}`
  );
  return `${op.operatorType}(${[...inputsOf(spec, op.operatorID), ...settings].join(", ")})`;
}

/** The whole workflow as lines, each operator after the ones it reads. */
export function linesOf(spec: WorkflowSpec): string[] {
  const placed = new Set<string>();
  const out: string[] = [];
  const remaining = [...spec.operators];
  while (remaining.length > 0) {
    const i = remaining.findIndex(op =>
      inputsOf(spec, op.operatorID).every(id => placed.has(id) || !spec.operators.some(o => o.operatorID === id))
    );
    const op = remaining.splice(i >= 0 ? i : 0, 1)[0] as WorkflowOperator;
    placed.add(op.operatorID);
    out.push(`set ${op.operatorID}: ${callOf(spec, op, { multiline: true })}`);
  }
  return out;
}

/** An operator type's input ports, as a line's inputs need them. */
export interface InputPorts {
  /** The ports' names, in order: ["left", "right"]; "" for an unnamed one. */
  names: string[];
  /** The last port takes several links: the inputs past it go there too, as a union's do. */
  manyOnLast: boolean;
}

/** An operator type's input ports, when known; a line of an unknown type links its inputs in order. */
export type PortsOf = (operatorType: string) => InputPorts | undefined;

/** The port each of a line's inputs goes to, once the number of inputs is right for its type. */
function portsFor(l: SetLine, ports: InputPorts | undefined): number[] {
  if (!ports) return l.inputs.map((_, i) => i);
  const n = ports.names.length;
  const reads =
    n === 0
      ? "no input"
      : n === 1
        ? "one input"
        : `${n} inputs${ports.names.every(name => name !== "") ? `, ${ports.names.join(" and ")}` : ""}`;
  const fits = l.inputs.length === n || (l.inputs.length > n && n > 0 && ports.manyOnLast);
  if (!fits)
    throw new LineError(
      l.line,
      `${l.op} reads ${reads}${ports.manyOnLast && n > 0 ? " or more" : ""}; this line gives ${l.inputs.length}`
    );
  return l.inputs.map((_, i) => Math.min(i, n - 1));
}

/** Applies an edit's lines to a workflow, all of them or none. */
export function applyLines(spec: WorkflowSpec, lines: Line[], portsOf?: PortsOf): WorkflowSpec {
  let operators: WorkflowOperator[] = spec.operators.map(o => ({ ...o }));
  let links: WorkflowLink[] = [...spec.links];
  const setBy = new Map<string, number>();
  const deletedBy = new Map<string, number>();
  for (const l of lines) {
    if (setBy.has(l.id) || deletedBy.has(l.id)) throw new LineError(l.line, `${l.id} is named twice in this edit`);
    if (l.kind === "delete") {
      if (!operators.some(o => o.operatorID === l.id)) throw new LineError(l.line, `there is no operator ${l.id}`);
      operators = operators.filter(o => o.operatorID !== l.id);
      links = links.filter(k => k.source.operatorID !== l.id && k.target.operatorID !== l.id);
      deletedBy.set(l.id, l.line);
      continue;
    }
    setBy.set(l.id, l.line);
    const before = operators.find(o => o.operatorID === l.id);
    // A set replaces the operator whole: its type, settings and inputs; its place on the canvas and
    // whether its result is shown stay.
    const next: WorkflowOperator = {
      ...(before?.viewResult !== undefined ? { viewResult: before.viewResult } : {}),
      ...(before?.customDisplayName !== undefined ? { customDisplayName: before.customDisplayName } : {}),
      operatorID: l.id,
      operatorType: l.op,
      operatorProperties: l.settings as WorkflowOperator["operatorProperties"],
    };
    operators = before ? operators.map(o => (o.operatorID === l.id ? next : o)) : [...operators, next];
    links = links.filter(k => k.target.operatorID !== l.id);
    const ports = portsFor(l, portsOf?.(l.op));
    l.inputs.forEach((input, i) => {
      links.push({
        linkID: `${input}-${l.id}-${i}`,
        source: { operatorID: input, portID: "output-0" },
        target: { operatorID: l.id, portID: `input-${ports[i]}` },
      });
    });
  }
  // Every input names an operator the workflow has after the edit; a deleted one still read is named.
  const ids = new Set(operators.map(o => o.operatorID));
  for (const l of lines) {
    if (l.kind !== "set") continue;
    for (const input of l.inputs) {
      if (ids.has(input)) continue;
      const gone = deletedBy.get(input);
      throw new LineError(
        l.line,
        gone
          ? `${l.id} reads ${input}, which line ${gone} deletes`
          : `${l.id} reads ${input}, which is not in the workflow`
      );
    }
  }
  for (const k of spec.links) {
    const gone = deletedBy.get(k.source.operatorID);
    if (gone && ids.has(k.target.operatorID) && !setBy.has(k.target.operatorID))
      throw new LineError(
        gone,
        `${k.target.operatorID} reads ${k.source.operatorID}; delete it too, or set it to read something else`
      );
  }
  return { ...spec, operators, links };
}
