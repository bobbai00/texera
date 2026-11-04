import { buildAgent } from "./agent/build.ts";
import { createServiceTokenSource, createUserTokenVerifier } from "./auth/index.ts";
import { CatalogClient } from "./catalog/client.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
const log = createLogger();
const catalog = new CatalogClient({ baseUrl: config.catalogUrl });
const app = createApp({
  config,
  log,
  catalog,
  build: (input) =>
    buildAgent(
      { catalog, publicUrl: config.publicUrl, maxSteps: config.maxSteps, policy: { answer: config.answerPolicy }, log },
      input,
    ),
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
log.info("agent runtime listening", { port: server.port, catalog: config.catalogUrl, issuer: config.oidcIssuer });

const shutdown = () => {
  log.info("shutting down");
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
