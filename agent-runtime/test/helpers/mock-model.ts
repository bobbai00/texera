/**
 * A scripted language model for tests: each call streams the next scripted response,
 * so a tool-calling turn is two calls (tool call, then the final text).
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

type Part = Parameters<typeof simulateReadableStream<unknown>>[0]["chunks"][number];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export interface ScriptedToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ScriptedResponse {
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

function chunksFor(response: ScriptedResponse): Part[] {
  const chunks: Part[] = [{ type: "stream-start", warnings: [] }];
  if (response.text) {
    chunks.push({ type: "text-start", id: "text-1" });
    for (const piece of response.text.split(/(?<=\s)/)) {
      chunks.push({ type: "text-delta", id: "text-1", delta: piece });
    }
    chunks.push({ type: "text-end", id: "text-1" });
  }
  for (const call of response.toolCalls ?? []) {
    const json = JSON.stringify(call.input);
    chunks.push({ type: "tool-input-start", id: call.id, toolName: call.toolName });
    chunks.push({ type: "tool-input-delta", id: call.id, delta: json });
    chunks.push({ type: "tool-input-end", id: call.id });
    chunks.push({ type: "tool-call", toolCallId: call.id, toolName: call.toolName, input: json });
  }
  chunks.push({
    type: "finish",
    finishReason: { unified: response.toolCalls?.length ? "tool-calls" : "stop", raw: "scripted" },
    usage,
  });
  return chunks;
}

/** Builds a mock model that plays the scripted responses in order, one per model call. */
export function scriptedModel(responses: ScriptedResponse[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId: "scripted",
    doStream: responses.map((r) => ({
      stream: simulateReadableStream({ chunks: chunksFor(r) as never[] }),
    })) as never,
  });
}
