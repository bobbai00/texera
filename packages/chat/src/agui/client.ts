// AG-UI over HTTP + SSE: one POST with the run input, one ordered stream of events back.

import type { AgUiEvent, RunAgentInput } from "./types";

export interface RunOptions {
  /** The agent's AG-UI endpoint, e.g. `/agents/<pid>/ag-ui`. */
  url: string;
  input: RunAgentInput;
  token?: string;
  signal?: AbortSignal;
  onEvent: (event: AgUiEvent) => void;
  fetchImpl?: typeof fetch;
}

/** Parses an SSE body into `data:` payloads; exported for tests. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
      boundary = buffer.indexOf("\n\n");
    }
    if (done) {
      const rest = buffer
        .split("\n")
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart())
        .join("\n");
      if (rest) yield rest;
      return;
    }
  }
}

/** Runs the agent once and feeds every event to `onEvent`; resolves when the stream ends. */
export async function runAgent({ url, input, token, signal, onEvent, fetchImpl = fetch }: RunOptions): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`The agent refused the run (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  if (!response.body) throw new Error("The agent sent no stream.");
  for await (const data of readSse(response.body)) {
    let event: AgUiEvent;
    try {
      event = JSON.parse(data) as AgUiEvent;
    } catch {
      continue;
    }
    onEvent(event);
  }
}

export const newRunId = () => crypto.randomUUID();
