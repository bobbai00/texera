import type { BuildInput, BuiltAgent } from "../agent/build.ts";
import type { ServiceTokenSource } from "../auth/index.ts";
import type { UserTokenVerifier } from "../auth/jwt.ts";
import type { CatalogClient } from "../catalog/client.ts";
import type { RuntimeConfig } from "../config.ts";
import type { Logger } from "../log.ts";

/** Everything the protocol handlers need; built in main.ts, faked in tests. */
export interface RuntimeDeps {
  config: RuntimeConfig;
  verifyUser: UserTokenVerifier;
  serviceTokens: ServiceTokenSource;
  catalog: CatalogClient;
  /** Builds the agent of a template version for one turn. */
  build: (input: BuildInput) => Promise<BuiltAgent>;
  log: Logger;
  newId?: () => string;
}
