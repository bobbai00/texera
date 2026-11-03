/**
 * Runtime configuration, read once from the environment.
 *
 * Every value has a development default that matches `bin/texera-2-0/` so
 * `bun run dev` works against the dev stack with only `ANTHROPIC_API_KEY` set.
 */
export type LlmProvider = "anthropic" | "openai-compatible";

export interface LlmConfig {
  provider: LlmProvider;
  /** Base URL for the openai-compatible provider (e.g. a LiteLLM gateway). */
  baseUrl?: string;
  /** API key for the chosen provider. */
  apiKey?: string;
  /** Model used when a template names none. */
  defaultModel: string;
}

export interface RuntimeConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** The gateway URL as clients see it; the built-in MCP server is `${publicUrl}/mcp`. */
  publicUrl: string;
  /** Base URL for catalog calls. */
  catalogUrl: string;
  /** Issuer claim user tokens must carry. */
  oidcIssuer: string;
  /** Audience claim user tokens must carry. */
  oidcAudience: string;
  /** Where the JWKS is fetched from. */
  jwksUrl: string;
  /** Token endpoint for the client-credentials grant. */
  tokenUrl: string;
  serviceClientId: string;
  serviceClientSecret: string;
  llm: LlmConfig;
  /** Upper bound on model steps per turn. */
  maxSteps: number;
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

/** Builds the configuration from `process.env`. */
export function loadConfig(): RuntimeConfig {
  const issuer = env("TEXERA_OIDC_ISSUER", "http://localhost:8088/auth/realms/texera");
  const provider = env("TEXERA_LLM_PROVIDER", "anthropic");
  if (provider !== "anthropic" && provider !== "openai-compatible") {
    throw new Error(`TEXERA_LLM_PROVIDER must be anthropic or openai-compatible, got ${provider}`);
  }
  const apiKey =
    process.env.TEXERA_LLM_API_KEY ?? (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : undefined);
  return {
    port: envInt("TEXERA_AGENT_PORT", 3002),
    publicUrl: env("TEXERA_PUBLIC_URL", "http://localhost:8088"),
    catalogUrl: env("TEXERA_CATALOG_URL", "http://localhost:8088"),
    oidcIssuer: issuer,
    oidcAudience: env("TEXERA_OIDC_AUDIENCE", "texera"),
    jwksUrl: env("TEXERA_OIDC_JWKS_URL", `${issuer}/protocol/openid-connect/certs`),
    tokenUrl: env("TEXERA_OIDC_TOKEN_URL", `${issuer}/protocol/openid-connect/token`),
    serviceClientId: env("TEXERA_SERVICE_CLIENT_ID", "texera-services"),
    serviceClientSecret: env("TEXERA_SERVICE_CLIENT_SECRET", "texera-services-secret"),
    llm: {
      provider,
      baseUrl: process.env.TEXERA_LLM_BASE_URL,
      apiKey,
      defaultModel: env("TEXERA_LLM_DEFAULT_MODEL", "claude-haiku-5-5"),
    },
    maxSteps: envInt("TEXERA_AGENT_MAX_STEPS", 40),
  };
}
