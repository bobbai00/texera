import { describe, expect, it } from "vitest";
import { readSse, runAgent } from "./client";

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });

describe("sse", () => {
  it("yields data payloads across chunk boundaries and multi-line events", async () => {
    const got: string[] = [];
    for await (const d of readSse(stream(['data: {"a":1}\n\nev', 'ent: x\ndata: {"b":\ndata: 2}\n\n', 'data: {"c":3}']))) got.push(d);
    expect(got).toEqual(['{"a":1}', '{"b":\n2}', '{"c":3}']);
  });

  it("posts the run input with the bearer token and feeds parsed events", async () => {
    const events: unknown[] = [];
    let request: Request | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return new Response(stream(['data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n', 'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n']), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    await runAgent({
      url: "http://localhost/agents/p/ag-ui",
      token: "tok",
      input: { threadId: "t", runId: "r", messages: [], tools: [], context: [] },
      onEvent: e => events.push(e.type),
      fetchImpl,
    });
    expect(events).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(request?.headers.get("authorization")).toBe("Bearer tok");
    expect(request?.headers.get("accept")).toBe("text/event-stream");
    expect(JSON.parse(await (request as Request).text())).toMatchObject({ threadId: "t", runId: "r" });
  });

  it("surfaces a refusal with the status", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no", { status: 403 });
    await expect(
      runAgent({ url: "/agents/p/ag-ui", input: { threadId: "t", runId: "r", messages: [], tools: [], context: [] }, onEvent: () => {}, fetchImpl })
    ).rejects.toThrow(/403/);
  });
});
