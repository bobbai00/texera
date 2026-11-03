/**
 * The per-turn identity an agent's calls to the built-in Texera MCP server carry: the acting
 * agent, the platform's service token that vouches for it, and the chat turn (conversation and
 * message seq) the call belongs to. The catalog records the agent as the creator, the person as
 * on-behalf-of, and the turn as the origin of every resource, version and execution the call
 * creates. These headers are sent to the built-in server only, never to third-party servers.
 */
export interface TurnOrigin {
  conversation: string;
  seq: number;
}

export class TurnContext {
  serviceToken: string | undefined;
  origin: TurnOrigin | undefined;

  constructor(readonly agentPid: string) {}

  /** Updates the context at the start of a turn. */
  begin(serviceToken: string | undefined, origin: TurnOrigin | undefined): void {
    this.serviceToken = serviceToken;
    this.origin = origin;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { "X-Texera-Agent": this.agentPid };
    if (this.serviceToken) h["X-Texera-Service-Token"] = this.serviceToken;
    if (this.origin) h["X-Texera-Origin"] = `${this.origin.conversation}:${this.origin.seq}`;
    return h;
  }
}

/** A fetch that adds the context's headers to every request, read at request time. */
export function fetchWithTurnHeaders(context: TurnContext, base: typeof fetch = fetch): typeof fetch {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(context.headers())) headers.set(k, v);
    return base(input, { ...init, headers });
  };
  return wrapped as typeof fetch;
}
