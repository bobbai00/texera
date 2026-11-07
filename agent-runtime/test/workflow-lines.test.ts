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

  test("gives each mistake back on the line that made it", async () => {
    const fake = fakeCatalog({
      errors: { avg: 'mean: the input has no column "PetalLength"; did you mean "PetalLengthCm"?' },
    });
    const out = await call(toolsOf(fake), "create_workflow", {
      name: "means",
      lines: LINES.replace("PetalLengthCm", "PetalLength"),
    });
    expect(out.errors).toEqual([
      { line: 2, operator: "avg", error: 'mean: the input has no column "PetalLength"; did you mean "PetalLengthCm"?' },
    ]);
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
