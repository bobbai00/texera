import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelEndpointRecord } from "../catalog/types.ts";

/** Builds a language model from a model endpoint and the leased value of its credential. */
export type ModelFactory = (endpoint: ModelEndpointRecord, secret: Record<string, string> | undefined) => LanguageModel;

/** The key field of a leased credential: `value`, else `apiKey`, else `key`. */
export function keyOf(secret: Record<string, string> | undefined): string | undefined {
  if (!secret) return undefined;
  return secret.value ?? secret.apiKey ?? secret.key;
}

/** Direct Anthropic, or an OpenAI-compatible gateway (LiteLLM, vLLM) when the endpoint says so. */
export const defaultModelFactory: ModelFactory = (endpoint, secret) => {
  const spec = endpoint.spec;
  const apiKey = keyOf(secret);
  if (spec.provider === "openai_compatible") {
    if (!spec.baseUrl) throw new Error(`model endpoint ${endpoint.name}: openai_compatible needs a baseUrl`);
    const provider = createOpenAICompatible({ name: endpoint.name, baseURL: spec.baseUrl, apiKey: apiKey ?? "unused" });
    return provider(spec.model);
  }
  if (!apiKey) throw new Error(`model endpoint ${endpoint.name}: its credential holds no key`);
  const provider = createAnthropic({ apiKey, ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}) });
  return provider(spec.model);
};
