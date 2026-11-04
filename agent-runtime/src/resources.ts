/**
 * Finds references to catalog resources inside tool results, so the chat can show a card
 * for every workflow, dataset, execution or template an agent touched. A resource is the
 * envelope `{kind, metadata: {rid, uri, head}}`; a version is `{rid, uri, vno, contentKind}`.
 */
export interface ResourceRef {
  kind: string;
  rid: string;
  /** The resource URI, with `@vno` when a version is meant. */
  uri?: string;
  vno?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an MCP tool result (AI SDK shape: `{content: [{type:'text', text}], structuredContent?}`)
 * or any JSON value into the value(s) to scan.
 */
export function toolOutputValues(output: unknown): unknown[] {
  if (!isRecord(output)) return [output];
  const values: unknown[] = [];
  if (output.structuredContent !== undefined) values.push(output.structuredContent);
  const content = output.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        const parsed = tryParseJson(item.text);
        values.push(parsed === undefined ? item.text : parsed);
      } else {
        values.push(item);
      }
    }
  }
  if (values.length === 0) values.push(output);
  return values;
}

function key(ref: ResourceRef): string {
  return `${ref.kind}:${ref.rid}:${ref.vno ?? ""}`;
}

/** Walks a value and collects every resource reference it contains. */
export function findResourceRefs(value: unknown, depth = 0): ResourceRef[] {
  const refs: ResourceRef[] = [];
  const seen = new Set<string>();
  const add = (ref: ResourceRef) => {
    const k = key(ref);
    if (!seen.has(k)) {
      seen.add(k);
      refs.push(ref);
    }
  };
  const walk = (v: unknown, d: number) => {
    if (d > 8) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, d + 1);
      return;
    }
    if (!isRecord(v)) return;
    const metadata = v.metadata;
    if (
      typeof v.kind === "string" &&
      isRecord(metadata) &&
      typeof metadata.rid === "string" &&
      UUID.test(metadata.rid)
    ) {
      const ref: ResourceRef = { kind: v.kind, rid: metadata.rid };
      if (typeof metadata.uri === "string") ref.uri = metadata.uri;
      if (typeof metadata.head === "number" && metadata.head > 0) ref.vno = metadata.head;
      add(ref);
    }
    if (
      typeof v.rid === "string" &&
      UUID.test(v.rid) &&
      typeof v.vno === "number" &&
      typeof v.contentKind === "string"
    ) {
      const ref: ResourceRef = { kind: typeof v.kind === "string" ? v.kind : "version", rid: v.rid, vno: v.vno };
      if (typeof v.uri === "string") ref.uri = v.uri;
      add(ref);
    }
    // Listings (a page's items) are what the agent looked through, not what it touched.
    for (const [k, child] of Object.entries(v)) {
      if (k === "items" && Array.isArray(child)) continue;
      walk(child, d + 1);
    }
  };
  walk(value, depth);
  return refs;
}

/** Resource references in a tool output, deduplicated. */
export function resourceRefsInToolOutput(output: unknown): ResourceRef[] {
  const refs: ResourceRef[] = [];
  const seen = new Set<string>();
  for (const value of toolOutputValues(output)) {
    for (const ref of findResourceRefs(value)) {
      const k = key(ref);
      if (!seen.has(k)) {
        seen.add(k);
        refs.push(ref);
      }
    }
  }
  return refs;
}
