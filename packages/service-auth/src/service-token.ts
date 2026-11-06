/**
 * A platform service's own identity at the identity provider: a client-credentials token,
 * cached until shortly before it expires. The agent runtime sends it beside the person's
 * token, so the catalog trusts the chat turn a call names; the live service calls the catalog
 * with it, to load and save the documents people edit together.
 */
/** The subset of `fetch` a service needs; lets tests pass a plain function. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ServiceTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  /** Seconds of safety margin before expiry. */
  refreshMargin?: number;
  now?: () => number;
}

export interface ServiceTokenSource {
  get(): Promise<string>;
  /** Drops the cached token. */
  invalidate(): void;
}

export function createServiceTokenSource(options: ServiceTokenOptions): ServiceTokenSource {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const margin = (options.refreshMargin ?? 30) * 1000;
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const request = async (): Promise<string> => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    const res = await fetchImpl(options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`service token request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("service token response has no access_token");
    const ttl = (json.expires_in ?? 300) * 1000;
    cached = { token: json.access_token, expiresAt: now() + ttl };
    return json.access_token;
  };

  return {
    async get() {
      if (cached && cached.expiresAt - margin > now()) return cached.token;
      if (!inflight) {
        inflight = request().finally(() => {
          inflight = undefined;
        });
      }
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
