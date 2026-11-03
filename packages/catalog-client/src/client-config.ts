import type { CreateClientConfig } from "./gen/client.gen";

/**
 * Runtime defaults for the generated client. The app and the agent runtime call
 * `client.setConfig({ baseUrl, auth })` once at startup; tests point it at a mock server.
 */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: config?.baseUrl ?? "/",
});
