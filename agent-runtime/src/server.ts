import { Hono } from "hono";
import { AuthError } from "./auth/jwt.ts";
import { CatalogError } from "./catalog/client.ts";
import { a2aHandler, agentCardHandler } from "./protocol/a2a.ts";
import { agUiHandler, BadRequest } from "./protocol/ag-ui.ts";
import type { RuntimeDeps } from "./protocol/deps.ts";

export type { RuntimeDeps } from "./protocol/deps.ts";

/** The HTTP surface: health, AG-UI runs, and the A2A card and endpoint per agent. */
export function createApp(deps: RuntimeDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", agents: deps.host.size }));
  app.post("/agents/:pid/ag-ui", agUiHandler(deps));
  app.get("/agents/:pid/.well-known/agent-card.json", agentCardHandler(deps));
  app.post("/agents/:pid/a2a", a2aHandler(deps));

  app.onError((err, c) => {
    const status =
      err instanceof AuthError || err instanceof BadRequest
        ? err.status
        : err instanceof CatalogError
          ? err.status
          : 500;
    if (status >= 500) deps.log.error("request failed", { path: c.req.path, error: err.message, stack: err.stack });
    return c.json(
      { code: err instanceof CatalogError ? err.code : err.name, message: err.message },
      status as 400 | 401 | 403 | 404 | 409 | 500,
    );
  });
  return app;
}
