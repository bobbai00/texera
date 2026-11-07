/**
 * The workflow tools as the agent uses them: lines in, the workflow as lines out. A dataset's
 * file named by the dataset's name is resolved to its URI at a version; an edit goes onto the
 * head it was made against, again once if someone saved in between; a mistake comes back on the
 * line that made it.
 */
import { describe, expect, test } from "bun:test";
import { workflowLineTools } from "../src/agent/workflow-lines.ts";
import { CatalogClient } from "../src/catalog/client.ts";
import type { WorkflowSpec } from "../src/catalog/types.ts";

const IRIS = "texera://datasets/11111111-1111-4111-8111-111111111111";
const WF = "22222222-2222-4222-8222-222222222222";

const METRICS = "44444444-4444-4444-8444-444444444444";
const port = (displayName?: string, many = false) => ({
  portID: "input-0",
  ...(displayName ? { displayName } : {}),
  ...(many ? { allowMultiInputs: true } : {}),
});
const operator = (operatorType: string, inputPorts: object[], rid = crypto.randomUUID(), code?: string) => ({
  kind: "operator",
  metadata: { rid, uri: `texera://operators/${rid}`, name: operatorType, head: 2 },
  spec: { operatorType, inputPorts, ...(code ? { implementation: { python: { code } } } : {}) },
});
/** The built-ins the lines use, a classic type, and one custom operator. */
const OPERATORS = [
  operator("scan", []),
  operator("aggregate", [port()]),
  operator("Aggregate", [port(undefined, true)]),
  operator("limit", [port()]),
  operator("filter", [port()]),
  operator("join", [port("left"), port("right")]),
  operator("union", [port(undefined, true)]),
  operator("cgm_metrics", [port()], METRICS, "def cgm_metrics(readings): ..."),
  // A custom operator that does not say its ports: its inputs link in order.
  {
    kind: "operator",
    metadata: {
      rid: METRICS.replaceAll("4", "6"),
      uri: `texera://operators/${METRICS.replaceAll("4", "6")}`,
      name: "loose",
      head: 1,
    },
    spec: { operatorType: "loose", implementation: { python: { code: "..." } } },
  },
];

/** A catalog with one dataset of one file and one workflow, recording what is asked of it. */
function fakeCatalog(options: { errors?: Record<string, string>; conflictOnce?: boolean; datasets?: string[] } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let spec: WorkflowSpec = { operators: [], links: [] };
  let head = 1;
  let conflict = options.conflictOnce ?? false;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const record = () => ({
    kind: "workflow",
    metadata: { rid: WF, uri: `texera://workflows/${WF}`, name: "means", head },
    spec,
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, body });
    if (url.pathname === "/catalog/v1/resources")
      return json(200, {
        items: (options.datasets ?? [IRIS]).map((uri) => ({
          kind: "dataset",
          metadata: { rid: uri.slice(-36), uri, name: "iris", head: 3 },
        })),
      });
    if (url.pathname.endsWith("/versions/3/files")) return json(200, { files: [{ path: "iris.csv" }] });
    if (url.pathname === "/catalog/v1/operators") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(200, { items: OPERATORS.filter((o) => o.spec.operatorType.toLowerCase().includes(q)) });
    }
    if (url.pathname === `/catalog/v1/operators/${METRICS}/versions/2`)
      return json(200, { content: OPERATORS.find((o) => o.metadata.rid === METRICS)?.spec });
    if (url.pathname === "/catalog/v1/workflows" && method === "POST") {
      spec = body.spec;
      return json(201, record());
    }
    if (url.pathname === `/catalog/v1/workflows/${WF}` && method === "GET") return json(200, record());
    if (url.pathname === `/catalog/v1/workflows/${WF}` && method === "PUT") {
      if (conflict) {
        conflict = false;
        head += 1;
        return json(409, { code: "conflict", message: "the head moved" });
      }
      if (body.expectedHead !== head) return json(409, { code: "conflict", message: "stale" });
      spec = body.spec;
      head += 1;
      return json(200, record());
    }
    if (url.pathname.endsWith("/validate"))
      return json(200, {
        ok: !options.errors,
        operatorErrors: options.errors ?? {},
        operatorOutputSchemas: { scan: { "output-0": [{ attributeName: "Species", attributeType: "string" }] } },
      });
    return json(404, { code: "not_found", message: `no route ${method} ${url.pathname}` });
  };
  return { calls, fetch, spec: () => spec, head: () => head };
}

const toolsOf = (fake: ReturnType<typeof fakeCatalog>) =>
  workflowLineTools({
    catalog: new CatalogClient({ baseUrl: "http://catalog", fetch: fake.fetch }),
    auth: () => ({ userToken: "t" }),
    project: "p",
  });
const call = async (tools: ReturnType<typeof toolsOf>, name: string, input: unknown) =>
  (await tools[name]?.execute?.(input as never, { toolCallId: "c", messages: [], context: {} } as never)) as Record<
    string,
    unknown
  >;

const LINES = `set scan: scan(file="iris/iris.csv")
set avg: aggregate(scan, by=["Species"], outputs=["mean = avg(PetalLengthCm)"])`;

describe("create_workflow", () => {
  test("resolves a file named by its dataset, saves the workflow, and answers in lines with each operator's columns", async () => {
    const fake = fakeCatalog();
    const out = await call(toolsOf(fake), "create_workflow", { name: "means", lines: LINES });
    expect(out.workflow).toEqual({
      kind: "workflow",
      metadata: { rid: WF, uri: `texera://workflows/${WF}`, name: "means", head: 1 },
    });
    expect(out.lines).toEqual([
      `set scan: scan(file="${IRIS}@3/files/iris.csv")`,
      'set avg: aggregate(scan, by=["Species"], outputs=["mean = avg(PetalLengthCm)"])',
    ]);
    expect(out.columns).toEqual({ scan: "Species string" });
    expect(out.errors).toBeUndefined();
    const created = fake.calls.find((c) => c.method === "POST" && c.path === "/catalog/v1/workflows");
    expect(created?.body).toMatchObject({ name: "means", parent: "p" });
    expect(fake.spec().links).toEqual([
      {
        linkID: "scan-avg-0",
        source: { operatorID: "scan", portID: "output-0" },
        target: { operatorID: "avg", portID: "input-0" },
      },
    ]);
  });

  test("gives each mistake back with the line that made it, and names what waits on the fix", async () => {
    const fake = fakeCatalog({
      errors: {
        top: "org.apache.texera.amber.core.workflow.SchemaNotAvailableException: schema is not available",
        avg: 'org.apache.texera.amber.operator.builtin.SettingError: mean: the input has no column "PetalLength"; did you mean "PetalLengthCm"?',
      },
    });
    const out = await call(toolsOf(fake), "create_workflow", {
      name: "means",
      lines: `${LINES.replace("PetalLengthCm", "PetalLength")}\nset top: limit(avg, n=1)`,
    });
    expect(out.errors).toEqual([
      {
        line: 'set avg: aggregate(scan, by=["Species"], outputs=["mean = avg(PetalLength)"])',
        error: 'mean: the input has no column "PetalLength"; did you mean "PetalLengthCm"?',
      },
    ]);
    expect(out.waitingOnTheFix).toEqual(["top"]);
  });

  test("refuses what it cannot read, or a name that is not one dataset's, before saving anything", async () => {
    const fake = fakeCatalog({ datasets: [IRIS, "texera://datasets/33333333-3333-4333-8333-333333333333"] });
    expect(
      await call(toolsOf(fake), "create_workflow", {
        name: "x",
        lines: "set a: filter(where='y')\nset b_c: limit(a, n=1)",
      }),
    ).toEqual({
      error: "line 2: an operator id may not contain '_'; use '-', as in b-c",
    });
    const ambiguous = await call(toolsOf(fake), "create_workflow", { name: "x", lines: LINES });
    expect(String(ambiguous.error)).toStartWith('line 1: 2 datasets are named "iris"');
    expect(fake.calls.some((c) => c.method === "POST" && c.path === "/catalog/v1/workflows")).toBe(false);
  });
});

describe("operator types", () => {
  test("puts a union's inputs on its one port, and a custom operator named by its type at its newest version", async () => {
    const fake = fakeCatalog();
    const out = await call(toolsOf(fake), "create_workflow", {
      name: "both",
      lines: `${LINES}\nset both: union(scan, scan)\nset m: cgm_metrics(both)`,
    });
    expect(out.error).toBeUndefined();
    expect(
      fake
        .spec()
        .links.filter((l) => l.target.operatorID === "both")
        .map((l) => l.target.portID),
    ).toEqual(["input-0", "input-0"]);
    expect((out.lines as string[]).at(-1)).toBe(`set m: texera://operators/${METRICS}@2(both)`);
    // Written back as it reads, the URI is a type too.
    const again = await call(toolsOf(fake), "edit_workflow", {
      rid: WF,
      lines: `set m: texera://operators/${METRICS}@2(both)`,
    });
    expect(again.error).toBeUndefined();
  });

  test("links the inputs of a custom operator that does not say its ports in order", async () => {
    const fake = fakeCatalog();
    const out = await call(toolsOf(fake), "create_workflow", { name: "x", lines: `${LINES}\nset l: loose(scan, avg)` });
    expect(out.error).toBeUndefined();
    expect(
      fake
        .spec()
        .links.filter((k) => k.target.operatorID === "l")
        .map((k) => k.target.portID),
    ).toEqual(["input-0", "input-1"]);
  });

  test("says which type was meant, and how many inputs a type reads", async () => {
    const fake = fakeCatalog();
    expect(await call(toolsOf(fake), "create_workflow", { name: "x", lines: "set a: fliter(where='y')" })).toEqual({
      error: "line 1: there is no operator fliter; did you mean filter?",
    });
    expect(
      await call(toolsOf(fake), "create_workflow", { name: "x", lines: `${LINES}\nset j: join(avg, on=["Species"])` }),
    ).toEqual({ error: "line 3: join reads 2 inputs, left and right; this line gives 1" });
    expect(fake.calls.some((c) => c.method === "POST" && c.path === "/catalog/v1/workflows")).toBe(false);
  });
});

describe("edit_workflow", () => {
  test("changes only the lines sent, onto the head, once more when the head moved", async () => {
    const fake = fakeCatalog({ conflictOnce: true });
    const tools = toolsOf(fake);
    await call(tools, "create_workflow", { name: "means", lines: LINES });
    const out = await call(tools, "edit_workflow", { rid: WF, lines: "set top: limit(avg, n=1)" });
    expect((out.lines as string[]).at(-1)).toBe("set top: limit(avg, n=1)");
    expect((out.lines as string[]).length).toBe(3);
    const puts = fake.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => (c.body as { expectedHead: number }).expectedHead)).toEqual([1, 2]);
  });

  test("sets where the workflow runs, with lines or alone", async () => {
    const fake = fakeCatalog();
    const tools = toolsOf(fake);
    await call(tools, "create_workflow", { name: "means", lines: LINES });
    const unit = "texera://computing-units/55555555-5555-4555-8555-555555555555";
    const out = await call(tools, "edit_workflow", { rid: WF, defaultComputingUnit: unit });
    expect(out.workflow).toMatchObject({ defaultComputingUnit: unit });
    expect(fake.spec().defaultComputingUnit).toBe(unit);
    expect((out.lines as string[]).length).toBe(2);
    const put = fake.calls.findLast((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ message: `runs on ${unit}` });
  });

  test("refuses a change that leaves an operator reading one that is gone", async () => {
    const fake = fakeCatalog();
    const tools = toolsOf(fake);
    await call(tools, "create_workflow", { name: "means", lines: LINES });
    expect(await call(tools, "edit_workflow", { rid: WF, lines: "delete scan" })).toEqual({
      error: "line 1: avg reads scan; delete it too, or set it to read something else",
    });
  });
});

describe("get_workflow", () => {
  test("reads the workflow as lines", async () => {
    const fake = fakeCatalog();
    const tools = toolsOf(fake);
    await call(tools, "create_workflow", { name: "means", lines: LINES });
    const out = await call(tools, "get_workflow", { rid: WF });
    expect(out.lines).toHaveLength(2);
    expect(out.workflow).toMatchObject({ metadata: { head: 1 } });
  });
});
