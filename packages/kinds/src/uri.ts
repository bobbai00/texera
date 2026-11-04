// The one grammar of names, as the catalog's internal/uri package has it:
//   texera://{plural}/{rid}[@vno][/{subresource}]            a flat kind
//   texera://workflows/{rid}/executions/{eid}[/{subresource}]  the nested kind
//   texera://settings                                          the singleton
// The app's page paths are the same without the scheme, so a URI is a link.

import { KIND_TABLE, type KindEntry } from "./kinds.gen";
import type { KindId, ResourceRef } from "./types";

export const SCHEME = "texera://";

const byPlural = new Map<string, KindEntry>(KIND_TABLE.map(k => [k.plural, k]));
const byKind = new Map<string, KindEntry>(KIND_TABLE.map(k => [k.kind, k]));

export const pluralOf = (kind: KindId): string => byKind.get(kind)?.plural ?? `${kind}s`;
export const kindOfPlural = (plural: string): KindId | undefined => byPlural.get(plural)?.kind as KindId | undefined;

export interface ParsedUri {
  ref: ResourceRef;
  /** The path after the resource and its version, e.g. `files/iris.csv` or `operators/avg/ports/output-0`. */
  subresource?: string;
}

const RID = /^[^/@]+$/;

function splitVersion(seg: string): { rid: string; vno?: number } | undefined {
  const at = seg.indexOf("@");
  if (at === -1) return RID.test(seg) ? { rid: seg } : undefined;
  const rid = seg.slice(0, at);
  const vno = Number(seg.slice(at + 1));
  return RID.test(rid) && Number.isInteger(vno) && vno > 0 ? { rid, vno } : undefined;
}

/** Parses a path without the scheme: `datasets/{rid}@2/files/a.csv`. */
export function parsePath(path: string): ParsedUri | undefined {
  const segs = path.replace(/^\/+/, "").split("/");
  const entry = segs[0] ? byPlural.get(segs[0]) : undefined;
  if (!entry) return undefined;
  const kind = entry.kind as KindId;
  if (entry.singleton) {
    const rest = segs.slice(1).join("/");
    return { ref: { kind, rid: "" }, ...(rest ? { subresource: rest } : {}) };
  }
  const head = segs[1] ? splitVersion(segs[1]) : undefined;
  if (!head) return undefined;
  let ref: ResourceRef = { kind, rid: head.rid, ...(head.vno !== undefined ? { vno: head.vno } : {}) };
  let i = 2;
  // A nested child right after the parent's rid: workflows/{rid}/executions/{eid}.
  if (head.vno === undefined && segs.length >= 4) {
    const child = byPlural.get(segs[2] as string);
    if (child?.nested && child.parent === kind) {
      const childHead = splitVersion(segs[3] as string);
      if (!childHead) return undefined;
      ref = { kind: child.kind as KindId, rid: childHead.rid, parent: head.rid, ...(childHead.vno !== undefined ? { vno: childHead.vno } : {}) };
      i = 4;
    }
  }
  const rest = segs.slice(i).join("/");
  return { ref, ...(rest ? { subresource: rest } : {}) };
}

export const isUri = (value: unknown): value is string => typeof value === "string" && value.startsWith(SCHEME);

/** Parses a `texera://` URI; undefined when it is not one or names no known kind. */
export function parseUri(uri: string): ParsedUri | undefined {
  return isUri(uri) ? parsePath(uri.slice(SCHEME.length)) : undefined;
}

/** The ref a URI names, or undefined. */
export const refOf = (uri: string): ResourceRef | undefined => parseUri(uri)?.ref;

/** The path of a ref without the scheme; `version` false leaves `@vno` out. */
export function pathOf(ref: ResourceRef, { version = true, subresource }: { version?: boolean; subresource?: string } = {}): string {
  const entry = byKind.get(ref.kind);
  const plural = entry?.plural ?? `${ref.kind}s`;
  const tail = version && ref.vno !== undefined ? `@${ref.vno}` : "";
  const sub = subresource ? `/${subresource}` : "";
  if (entry?.singleton) return `${plural}${sub}`;
  if (entry?.nested && ref.parent) return `${pluralOf(entry.parent as KindId)}/${ref.parent}/${plural}/${ref.rid}${tail}${sub}`;
  return `${plural}/${ref.rid}${tail}${sub}`;
}

export const uriOf = (ref: ResourceRef, options?: Parameters<typeof pathOf>[1]): string => SCHEME + pathOf(ref, options);

/** The same URI without `@vno`. */
export const baseUri = (uri: string): string => {
  const parsed = parseUri(uri);
  return parsed ? uriOf({ ...parsed.ref, vno: undefined }) : uri;
};

/** The version a URI pins, if any. */
export const versionOf = (uri: string): number | undefined => parseUri(uri)?.ref.vno;

/** The page of a resource: `/workflows/{rid}`, with the version as a query when pinned. */
export function href(ref: ResourceRef): string {
  const base = `/${pathOf(ref, { version: false })}`;
  return ref.vno !== undefined ? `${base}?vno=${ref.vno}` : base;
}

/** A file inside a dataset or model version: `texera://datasets/{rid}@{vno}/files/{path}`. */
export const fileUri = (ref: ResourceRef, path: string) => uriOf(ref, { subresource: `files/${path}` });

/** A short, readable form of a URI for labels: `datasets/1a2b3c4d@2/files/iris.csv`. */
export function shortUri(uri: string): string {
  const parsed = parseUri(uri);
  if (!parsed) return uri;
  const { ref, subresource } = parsed;
  const tail = ref.vno !== undefined ? `@${ref.vno}` : "";
  return `${pluralOf(ref.kind)}/${ref.rid.slice(0, 8)}${tail}${subresource ? `/${subresource}` : ""}`;
}
