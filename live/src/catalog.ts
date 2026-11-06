/**
 * What the live service asks of the catalog. The catalog is the authority: it says who a
 * token is and what they may do, it holds the versions a session loads from and saves into,
 * and it keeps a session's document between sessions. The service holds nothing of its own.
 *
 * A person's questions go with the person's token, so the answer is the catalog's own
 * decision about them. Loading and saving go with the service's token.
 */
import type { LiveState, Me, Resource, Version, Workflow, WorkflowSpec } from "@texera/catalog-client/types";
import type { FetchLike, ServiceTokenSource } from "@texera/service-auth";

/** The catalog said no, or failed: the HTTP status and its message. */
export class CatalogError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface Person {
  pid: string;
  name: string;
}

/** A workflow's newest version. */
export interface Head {
  vno: number;
  spec: WorkflowSpec;
}

/** A session's document as it was kept, and the version it was last saved as. */
export interface Kept {
  basedOn?: number;
  state: Uint8Array;
}

export interface Catalog {
  /** Who a token is; refused when it is nobody's. */
  person(token: string): Promise<Person>;
  /** The kind of a resource its person may read; refused when they may not. */
  kindOf(rid: string, token: string): Promise<string>;
  /** Whether the person may change the resource. */
  mayWrite(rid: string, token: string): Promise<boolean>;
  /** Whether someone still may, asked by the service while they are connected. */
  stillMay(pid: string, action: "read" | "write", rid: string): Promise<boolean>;
  head(rid: string): Promise<Head>;
  version(rid: string, vno: number): Promise<WorkflowSpec>;
  kept(rid: string): Promise<Kept | undefined>;
  keep(rid: string, kept: Kept): Promise<void>;
  /** Saves a version for the people whose edits it holds; a 409 when the head is not `expectedHead`. */
  save(rid: string, spec: WorkflowSpec, expectedHead: number, onBehalfOf: string[]): Promise<number>;
  /** Tells of every new head, and of the resource's end, until the signal aborts. */
  follow(rid: string, on: { head: (head: Head) => void; gone: () => void }, signal: AbortSignal): void;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

/** The catalog over HTTP. */
export function httpCatalog(options: { baseUrl: string; tokens: ServiceTokenSource; fetch?: FetchLike }): Catalog {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  const call = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // not JSON: the text is the message
      }
      throw new CatalogError(response.status, message || response.statusText);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const asService = async <T>(method: string, path: string, body?: unknown) =>
    call<T>(await options.tokens.get(), method, path, body);
  const decide = (token: string, action: string, rid: string, pid = "") =>
    call<{ decision: boolean }>(token, "POST", "/access/v1/evaluation", {
      subject: { type: "user", id: pid },
      action: { name: action },
      resource: { type: "resource", id: rid },
    }).then((r) => r.decision);

  return {
    async person(token) {
      const me = await call<Me>(token, "GET", "/catalog/v1/me");
      return { pid: me.principal.pid, name: me.principal.displayName };
    },
    async kindOf(rid, token) {
      return (await call<Resource>(token, "GET", `/catalog/v1/resources/${rid}`)).kind;
    },
    mayWrite: (rid, token) => decide(token, "write", rid),
    stillMay: async (pid, action, rid) => decide(await options.tokens.get(), action, rid, pid),
    async head(rid) {
      const workflow = await asService<Workflow>("GET", `/catalog/v1/workflows/${rid}`);
      return { vno: workflow.metadata.head, spec: workflow.spec };
    },
    async version(rid, vno) {
      return (await asService<Version>("GET", `/catalog/v1/workflows/${rid}/versions/${vno}`)).content as WorkflowSpec;
    },
    async kept(rid) {
      try {
        const live = await asService<LiveState & { state: string }>("GET", `/catalog/v1/resources/${rid}/live`);
        return { basedOn: live.basedOn, state: fromBase64(live.state) };
      } catch (err) {
        if (err instanceof CatalogError && err.status === 404) return undefined;
        throw err;
      }
    },
    keep: (rid, kept) =>
      asService("PUT", `/catalog/v1/resources/${rid}/live`, { basedOn: kept.basedOn, state: toBase64(kept.state) }),
    async save(rid, spec, expectedHead, onBehalfOf) {
      const body = {
        spec,
        expectedHead,
        message: "Edited in the workflow editor",
        ...(onBehalfOf.length > 0 ? { onBehalfOf } : {}),
      };
      return (await asService<Version>("POST", `/catalog/v1/workflows/${rid}/edit`, body)).vno;
    },
    follow(rid, on, signal) {
      void (async () => {
        let delay = 500;
        while (!signal.aborted) {
          try {
            const response = await fetchImpl(`${base}/catalog/v1/resources/${rid}/events`, {
              headers: { authorization: `Bearer ${await options.tokens.get()}`, accept: "text/event-stream" },
              signal,
            });
            if ([403, 404].includes(response.status)) return on.gone();
            if (response.ok && response.body) {
              delay = 500;
              for await (const event of serverSentEvents(response.body)) {
                if (event.name === "deleted") return on.gone();
                if (event.name !== "resource") continue;
                const workflow = JSON.parse(event.data) as Workflow;
                on.head({ vno: workflow.metadata.head, spec: workflow.spec });
              }
            }
          } catch {
            // the connection dropped: try again below
          }
          if (signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      })();
    },
  };
}

/** The events of a server-sent event stream; comment lines keep the connection alive and are dropped. */
export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ name: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { name, data: data.join("\n") };
    }
  }
}
