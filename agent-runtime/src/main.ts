import { createServiceTokenSource, createUserTokenVerifier } from "./auth/index.ts";
import { CatalogClient } from "./catalog/client.ts";
import { loadConfig } from "./config.ts";
import { AgentHost } from "./host/agent-host.ts";
import { InProcessSpawner } from "./host/spawner.ts";
import { createLogger } from "./log.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
const log = createLogger();
const catalog = new CatalogClient({ baseUrl: config.catalogUrl });
const host = new AgentHost(
  new InProcessSpawner({ catalog, llm: config.llm, publicUrl: config.publicUrl, maxSteps: config.maxSteps, log }),
);
const app = createApp({
  config,
  log,
  catalog,
  host,
  verifyUser: createUserTokenVerifier({
    issuer: config.oidcIssuer,
    audience: config.oidcAudience,
    jwksUrl: config.jwksUrl,
  }),
  serviceTokens: createServiceTokenSource({
    tokenUrl: config.tokenUrl,
    clientId: config.serviceClientId,
    clientSecret: config.serviceClientSecret,
  }),
});

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  // Long-running runs stream for minutes; Bun's default idle timeout is 10 s.
  idleTimeout: 255,
});
log.info("agent runtime listening", {
  port: server.port,
  catalog: config.catalogUrl,
  issuer: config.oidcIssuer,
  provider: config.llm.provider,
  model: config.llm.defaultModel,
});

const shutdown = async () => {
  log.info("shutting down");
  await host.closeAll();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
