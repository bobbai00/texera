/**
 * The turn's identity as the platform's MCP servers and the catalog see it: the service
 * token that vouches for the runtime and the origin (conversation, turn, template version)
 * the catalog records on every resource, version and execution the turn creates. Sent to
 * the platform's own servers only, never to third-party servers.
 */
import { formatOrigin, type Origin } from "../catalog/types.ts";

export class TurnContext {
  constructor(
    private serviceToken: string | undefined,
    private origin: Origin,
  ) {}

  /** A handoff changes the template the rest of the turn runs under. */
  setTemplate(template: string): void {
    this.origin = { ...this.origin, template };
  }

  get current(): Origin {
    return this.origin;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { "X-Texera-Origin": formatOrigin(this.origin) };
    if (this.serviceToken) h["X-Texera-Service-Token"] = this.serviceToken;
    return h;
  }
}
