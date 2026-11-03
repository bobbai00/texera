import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { LlmConfig } from "../config.ts";

/**
 * Resolves the language model a template asks for. Direct Anthropic by default; an
 * OpenAI-compatible gateway (LiteLLM) when configured, so the switch is one env var.
 */
export function resolveModel(config: LlmConfig, modelName?: string): LanguageModel {
  const id = modelName?.trim() || config.defaultModel;
  if (config.provider === "openai-compatible") {
    if (!config.baseUrl) throw new Error("TEXERA_LLM_BASE_URL is required for the openai-compatible provider");
    const provider = createOpenAICompatible({
      name: "texera-llm-gateway",
      baseURL: config.baseUrl,
      apiKey: config.apiKey ?? "unused",
    });
    return provider(id);
  }
  if (!config.apiKey) {
    throw new Error("ANTHROPIC_API_KEY (or TEXERA_LLM_API_KEY) is required for the anthropic provider");
  }
  const provider = createAnthropic({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
  return provider(id);
}
