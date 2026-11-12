// The file subresources of the manifest kinds (datasets and models) behind one interface, so
// the files tabs and the upload flow serve both.

import * as sdk from "@texera/catalog-client";
import type { DatasetFile, Manifest, Version } from "@texera/catalog-client/types";
import { queryOptions } from "@tanstack/react-query";
import { unwrap } from "../api";
import type { KindId } from "../types";
import { delimiterFor, previewCsv, type TablePreview } from "./csv";

export interface FileApi {
  files: (rid: string, vno: number) => Promise<Manifest>;
  staged: (rid: string) => Promise<Manifest>;
  upload: (rid: string, path: string, data: Blob) => Promise<DatasetFile>;
  unstage: (rid: string, path: string) => Promise<void>;
  commit: (rid: string, message?: string) => Promise<Version>;
  download: (rid: string, vno: number, path: string, maxBytes: number) => Promise<string>;
}

const text = async (r: Promise<{ data?: unknown; error?: unknown; response?: Response }>) => {
  const data = await unwrap(r);
  return typeof data === "string" ? data : data instanceof Blob ? await data.text() : "";
};

const datasets: FileApi = {
  files: (rid, vno) => unwrap(sdk.datasetsFiles({ path: { rid, vno } })),
  staged: rid => unwrap(sdk.datasetsStaged({ path: { rid } })),
  upload: (rid, path, data) => unwrap(sdk.datasetsUpload({ path: { rid, path }, body: data, bodySerializer: null, headers: { "Content-Type": "application/octet-stream" } })),
  unstage: (rid, path) => unwrap(sdk.datasetsUnstage({ path: { rid, path } })).then(() => undefined),
  commit: (rid, message) => unwrap(sdk.datasetsCommit({ path: { rid }, body: { message } })) as Promise<Version>,
  download: (rid, vno, path, maxBytes) => text(sdk.datasetsDownload({ path: { rid, vno, path }, query: { maxBytes }, parseAs: "text" })),
};

const models: FileApi = {
  files: (rid, vno) => unwrap(sdk.modelsFiles({ path: { rid, vno } })),
  staged: rid => unwrap(sdk.modelsStaged({ path: { rid } })),
  upload: (rid, path, data) => unwrap(sdk.modelsUpload({ path: { rid, path }, body: data, bodySerializer: null, headers: { "Content-Type": "application/octet-stream" } })),
  unstage: (rid, path) => unwrap(sdk.modelsUnstage({ path: { rid, path } })).then(() => undefined),
  commit: (rid, message) => unwrap(sdk.modelsCommit({ path: { rid }, body: { message } })) as Promise<Version>,
  download: (rid, vno, path, maxBytes) => text(sdk.modelsDownload({ path: { rid, vno, path }, query: { maxBytes }, parseAs: "text" })),
};

export const fileApi = (kind: KindId): FileApi => (kind === "model" ? models : datasets);

export const filesQuery = (kind: KindId, rid: string, vno: number) =>
  queryOptions({ queryKey: ["files", kind, rid, vno], queryFn: () => fileApi(kind).files(rid, vno), staleTime: Number.POSITIVE_INFINITY });

export const stagedQuery = (kind: KindId, rid: string) =>
  queryOptions({ queryKey: ["staged", kind, rid], queryFn: () => fileApi(kind).staged(rid) });

/** How much of a file a preview reads. */
export const PREVIEW_BYTES = 256 * 1024;

/** The first rows of a tabular file of a version, read through the catalog. */
export const previewQuery = (kind: KindId, rid: string, vno: number, path: string) =>
  queryOptions({
    queryKey: ["file-preview", kind, rid, vno, path],
    queryFn: async (): Promise<TablePreview> => {
      const data = await fileApi(kind).download(rid, vno, path, PREVIEW_BYTES);
      return previewCsv(data, { truncated: data.length >= PREVIEW_BYTES, delimiter: delimiterFor(path) });
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

export interface TextPreview {
  text: string;
  /** Only the file's beginning was read. */
  partial: boolean;
}

/** A text file of a version as it is written (markdown, a contract, code), read through the catalog: whole unless it is long. */
export const textQuery = (kind: KindId, rid: string, vno: number, path: string) =>
  queryOptions({
    queryKey: ["file-text", kind, rid, vno, path],
    queryFn: async (): Promise<TextPreview> => {
      const text = await fileApi(kind).download(rid, vno, path, PREVIEW_BYTES);
      return { text, partial: text.length >= PREVIEW_BYTES };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
