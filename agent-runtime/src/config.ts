/**
 * Runtime configuration, read once from the environment.
 *
 * Every value has a development default that matches `bin/texera-2-0/`. The runtime holds
 * no model key: the template's model endpoint names a credential, and the runtime leases its
 * value from the catalog for each turn.
 */
import type { AnswerPolicy } from "./run/react-loop.ts";

export interface RuntimeConfig {
  /** Port the HTTP server listens on. */
  port: number;
  /** The gateway URL as clients see it; the catalog's MCP servers live under `${publicUrl}/mcp`. */
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
  /** Upper bound on model steps per turn; a template's `loop.maxSteps` overrides it. */
  maxSteps: number;
  /** The answer policy templates inherit when their `loop` names none. */
  answerPolicy: AnswerPolicy;
  /** Handoffs allowed in one turn. */
  maxHandoffs: number;
  /** How closely the catalog's copy of an answer follows it while it streams: the others in a chat watch that copy. */
  answerKeptEveryMs: number;
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
  const answerPolicy = env("TEXERA_AGENT_ANSWER_POLICY", "free");
  if (answerPolicy !== "free" && answerPolicy !== "after_result") {
    throw new Error(`TEXERA_AGENT_ANSWER_POLICY must be free or after_result, got ${answerPolicy}`);
  }
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
    maxSteps: envInt("TEXERA_AGENT_MAX_STEPS", 40),
    answerPolicy,
    maxHandoffs: envInt("TEXERA_AGENT_MAX_HANDOFFS", 2),
    answerKeptEveryMs: envInt("TEXERA_AGENT_ANSWER_KEPT_EVERY_MS", 400),
  };
}
