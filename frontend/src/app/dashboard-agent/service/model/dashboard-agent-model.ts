/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { InjectionToken } from "@angular/core";
import { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { FetchFunction } from "@ai-sdk/provider-utils";
import { AppSettings } from "../../../common/app-setting";
import { AuthService } from "../../../common/service/user/auth.service";

/**
 * Builds an AI SDK language model for the given gateway model id.
 *
 * Injected (rather than constructing the model inline) so the runtime can be
 * unit tested with a `MockLanguageModelV2` while production resolves to the
 * real OpenAI-compatible Texera LLM gateway.
 */
export type DashboardAgentModelFactory = (modelId: string) => LanguageModel;

export const DASHBOARD_AGENT_MODEL_FACTORY = new InjectionToken<DashboardAgentModelFactory>(
  "DASHBOARD_AGENT_MODEL_FACTORY",
  {
    // Self-provided at the root injector so the runtime resolves the real
    // gateway-backed factory without a manual provider registration. Tests
    // override this token to inject a mock model.
    providedIn: "root",
    factory: () => createDashboardAgentModelFactory(),
  }
);

/**
 * Base URL for the OpenAI-compatible gateway. The AI SDK posts to
 * `${baseURL}/chat/completions`; the dev proxy (proxy.config.json) and the
 * production reverse proxy route `/api/chat/completions` to the LLM gateway
 * (LiteLLM). Kept as a constant so it can be adjusted in one place if the
 * deployed gateway exposes a different base path.
 */
export const DASHBOARD_AGENT_LLM_BASE_URL = AppSettings.getApiEndpoint();

/**
 * A fetch wrapper that attaches the logged-in user's Texera JWT as a Bearer
 * token. The gateway authenticates with this token, so no real LLM API key is
 * ever shipped to the browser.
 */
const jwtFetch: FetchFunction = (input, init) => {
  const headers = new Headers(init?.headers);
  const token = AuthService.getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input as RequestInfo, { ...init, headers });
};

/**
 * Production factory: an OpenAI-compatible provider pointed at the Texera LLM
 * gateway. The `apiKey` is a non-empty placeholder only (the provider requires
 * one); the gateway authorizes via the JWT attached by {@link jwtFetch}.
 */
export function createDashboardAgentModelFactory(): DashboardAgentModelFactory {
  const provider = createOpenAI({
    baseURL: DASHBOARD_AGENT_LLM_BASE_URL,
    apiKey: "texera-gateway",
    fetch: jwtFetch,
  });
  return (modelId: string) => provider.chat(modelId);
}
