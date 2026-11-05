import { client } from "@texera/catalog-client";
import type { Message, Resource } from "@texera/catalog-client/types";
import { afterEach, describe, expect, it } from "vitest";
import { readSseEvents, watchOnce } from "./watch";

const RID = "0b7a1c2d-0000-4000-8000-00000000000a";

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

const previous = client.getConfig();
afterEach(() => client.setConfig(previous));

describe("readSseEvents", () => {
  it("names events across chunk boundaries and drops keepalive comments", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of ['event: message\ndata: {"a":\nda', 'ta: 1}\n\n: keepalive\n\nevent: deleted\ndata: {}\n\n', 'data: {"tail":true}']) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const got: unknown[] = [];
    for await (const ev of readSseEvents(body)) got.push([ev.event, ev.data]);
    expect(got).toEqual([["message", '{"a":\n1}'], ["deleted", "{}"], [undefined, '{"tail":true}']]);
  });
});

describe("watchOnce", () => {
  it("names each event and hands it to the right handler, asking for what was already seen", async () => {
    let request: Request | undefined;
    client.setConfig({
      baseUrl: "http://catalog",
      auth: () => "tok",
      fetch: async (req: Request) => {
        request = req;
        return sse([
          `event: message\ndata: {"conversation":"${RID}","seq":3,"role":"user","author":"p1","parts":[{"type":"text","text":"hi"}],"createdAt":"2026-11-04T00:00:00Z"}\n\n`,
          `: keepalive\n\nevent: resource\ndata: {"apiVersion":"catalog.texera.apache.org/v1","kind":"conversation","metadata":{"rid":"${RID}"},"spec":{},"status":{"activeTurn":"t1","activeTurnBy":"p1"}}\n\n`,
          "event: deleted\ndata: {\"rid\":\"x\"}\n\n",
        ]);
      },
    });
    const seen: string[] = [];
    const outcome = await watchOnce(RID, {
      after: () => 2,
      onMessage: (m: Message) => seen.push(`message ${m.seq} by ${m.author}`),
      onResource: (r: Resource) => seen.push(`resource ${(r.status as { activeTurnBy?: string })?.activeTurnBy}`),
      onDeleted: () => seen.push("deleted"),
    });
    expect(seen).toEqual(["message 3 by p1", "resource p1", "deleted"]);
    expect(outcome).toBe("deleted");
    expect(request?.url).toBe(`http://catalog/catalog/v1/resources/${RID}/events?after=2`);
    expect(request?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("reports a refusal instead of retrying it", async () => {
    let calls = 0;
    client.setConfig({
      baseUrl: "http://catalog",
      fetch: async () => {
        calls++;
        return new Response('{"code":"forbidden"}', { status: 403 });
      },
    });
    expect(await watchOnce(RID, {})).toBe("refused");
    expect(calls).toBe(1);
  });

  it("ends quietly when the connection closes, so the caller reconnects", async () => {
    client.setConfig({ baseUrl: "http://catalog", fetch: async () => sse([`event: resource\ndata: {"kind":"execution","metadata":{"rid":"${RID}"},"spec":{}}\n\n`]) });
    expect(await watchOnce(RID, {})).toBe("ended");
  });
});
