// Watching a resource: the catalog streams every change of a resource the caller may read as
// server-sent events (`GET /resources/{rid}/events`, the one route of the contract the
// generated client leaves out). The hook keeps the resource's query fresh for every component
// that reads it and hands a conversation's messages to the caller. It reconnects with a
// backoff when the connection drops and stops when the resource is deleted, when the caller
// may no longer read it, or when the component goes away.
import { useQueryClient } from "@tanstack/react-query";
import { client } from "@texera/catalog-client";
import type { Message, Resource } from "@texera/catalog-client/types";
import { useEffect, useRef } from "react";

export interface WatchHandlers {
  onResource?: (resource: Resource) => void;
  onMessage?: (message: Message) => void;
  onDeleted?: () => void;
  /** The message seq already seen, asked for on every connection so nothing is missed. */
  after?: () => number;
}

export type WatchOutcome = "deleted" | "refused" | "ended";

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parses a server-sent event stream into events; comment lines keep the connection alive and are dropped. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (chunk: string): SseEvent | undefined => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    return data.length ? { event, data: data.join("\n") } : undefined;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const ev = parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (ev) yield ev;
      boundary = buffer.indexOf("\n\n");
    }
    if (done) {
      const ev = parse(buffer);
      if (ev) yield ev;
      return;
    }
  }
}

async function bearer(): Promise<string | undefined> {
  const auth = client.getConfig().auth;
  const value = typeof auth === "function" ? await auth({ scheme: "bearer", type: "http" }) : auth;
  return value ? String(value) : undefined;
}

/** One connection to a resource's event stream; resolves when it ends and says why. */
export async function watchOnce(rid: string, handlers: WatchHandlers, signal?: AbortSignal): Promise<WatchOutcome> {
  const config = client.getConfig();
  const base = (config.baseUrl ?? "/").replace(/\/$/, "");
  const after = handlers.after?.() ?? 0;
  const url = `${base}/catalog/v1/resources/${encodeURIComponent(rid)}/events${after > 0 ? `?after=${after}` : ""}`;
  const token = await bearer();
  const fetchImpl = config.fetch ?? fetch;
  const response = await fetchImpl(new Request(url, { headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal }));
  if (!response.ok) return [401, 403, 404].includes(response.status) ? "refused" : "ended";
  if (!response.body) return "ended";
  for await (const ev of readSseEvents(response.body)) {
    let data: unknown;
    try {
      data = JSON.parse(ev.data);
    } catch {
      continue;
    }
    switch (ev.event) {
      case "resource":
        handlers.onResource?.(data as Resource);
        break;
      case "message":
        handlers.onMessage?.(data as Message);
        break;
      case "deleted":
        handlers.onDeleted?.();
        return "deleted";
    }
  }
  return "ended";
}

/**
 * Watches a resource while the component is mounted. Every `resource` event lands in the
 * resource's query (`["resource", rid]`), so whoever reads it re-renders; messages go to
 * `onMessage`. The handlers may change between renders without reconnecting.
 */
export function useWatch(rid: string | undefined, handlers: WatchHandlers & { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  const current = useRef(handlers);
  current.current = handlers;
  const enabled = handlers.enabled ?? true;
  useEffect(() => {
    if (!rid || !enabled) return;
    const controller = new AbortController();
    void (async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        let outcome: WatchOutcome = "ended";
        try {
          outcome = await watchOnce(
            rid,
            {
              after: () => current.current.after?.() ?? 0,
              onResource: r => {
                delay = 1000;
                queryClient.setQueryData(["resource", rid], r);
                current.current.onResource?.(r);
              },
              onMessage: m => {
                delay = 1000;
                current.current.onMessage?.(m);
              },
              onDeleted: () => current.current.onDeleted?.(),
            },
            controller.signal
          );
        } catch {
          // a failed connection is retried below
        }
        if (outcome !== "ended" || controller.signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    })();
    return () => controller.abort();
  }, [rid, enabled, queryClient]);
}
