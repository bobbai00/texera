/**
 * Configuration, read once from the environment. Every value has a development default that
 * matches `bin/texera-2-0/`.
 */
export interface LiveConfig {
  /** Port the WebSocket server listens on. */
  port: number;
  /** Base URL for catalog calls. */
  catalogUrl: string;
  /** Token endpoint for the service's own client-credentials grant. */
  tokenUrl: string;
  serviceClientId: string;
  serviceClientSecret: string;
  /** How long a document waits after an edit before it is saved, and the longest it waits, in ms. */
  saveAfter: number;
  saveWithin: number;
  /** How often the people connected are asked about again, in ms: access taken away ends a session. */
  recheckEvery: number;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

export function loadConfig(): LiveConfig {
  const issuer = env("TEXERA_OIDC_ISSUER", "http://localhost:8088/auth/realms/texera");
  return {
    port: envInt("TEXERA_LIVE_PORT", 23003),
    catalogUrl: env("TEXERA_CATALOG_URL", "http://localhost:8088"),
    tokenUrl: env("TEXERA_OIDC_TOKEN_URL", `${issuer}/protocol/openid-connect/token`),
    serviceClientId: env("TEXERA_SERVICE_CLIENT_ID", "texera-services"),
    serviceClientSecret: env("TEXERA_SERVICE_CLIENT_SECRET", "texera-services-secret"),
    saveAfter: envInt("TEXERA_LIVE_SAVE_AFTER_MS", 1500),
    saveWithin: envInt("TEXERA_LIVE_SAVE_WITHIN_MS", 8000),
    recheckEvery: envInt("TEXERA_LIVE_RECHECK_MS", 30_000),
  };
}
