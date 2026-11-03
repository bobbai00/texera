import type { UserTokenVerifier } from "../auth/jwt.ts";
import type { ServiceTokenSource } from "../auth/service-token.ts";
import type { CatalogClient } from "../catalog/client.ts";
import type { RuntimeConfig } from "../config.ts";
import type { AgentHost } from "../host/agent-host.ts";
import type { Logger } from "../log.ts";

/** Everything the protocol handlers need; built in main.ts, faked in tests. */
export interface RuntimeDeps {
  config: RuntimeConfig;
  verifyUser: UserTokenVerifier;
  serviceTokens: ServiceTokenSource;
  catalog: CatalogClient;
  host: AgentHost;
  log: Logger;
  newId?: () => string;
}
