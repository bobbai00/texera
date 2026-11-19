/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import Papa from "papaparse";
import type { CellValue } from "read-excel-file";
import type { Grammar } from "@/components/code/code-look";
import { fileKindOf, previewLimits, tableRows } from "./file-kinds";

/** What is shown of a file. Of text, `whole` says whether all of it is there or only its start. */
export type FilePreview =
  | { kind: "table"; columns: string[]; rows: string[][]; whole: boolean }
  | { kind: "text"; text: string; language: Grammar; wrap: boolean; whole: boolean }
  | { kind: "markdown" | "html"; text: string; whole: boolean }
  /** Shown by the browser from the file's link, which it streams. */
  | { kind: "image" | "video" | "audio"; url: string }
  | { kind: "pdf"; pdf: Blob }
  | { kind: "none"; reason: "binary" | "too big" };

/** The file as the preview needs it: its name and size from the file tree, and its link on the storage server. */
export interface PreviewSource {
  name: string;
  size: number;
  url: string;
}

/**
 * Reads what is shown of a file. Text is read only as far as the preview shows it, with a range request, so a file of
 * gigabytes is shown as quickly as a small one. The link grants access: the request carries no Texera token.
 */
export async function readPreview(source: PreviewSource): Promise<FilePreview> {
  const kind = fileKindOf(source.name);
  switch (kind.kind) {
    case "image":
    case "video":
    case "audio":
      return { kind: kind.kind, url: source.url };
    case "binary":
      return { kind: "none", reason: "binary" };
    case "pdf":
      if (source.size > previewLimits.pdf) return { kind: "none", reason: "too big" };
      // Typed here: the storage server says every file is "binary/octet-stream", which the browser would save.
      return { kind: "pdf", pdf: new Blob([await readAll(source)], { type: "application/pdf" }) };
    case "spreadsheet": {
      if (source.size > previewLimits.spreadsheet) return { kind: "none", reason: "too big" };
      // The reader of workbooks is loaded when the first one is shown.
      const { default: readSheet } = await import("read-excel-file");
      const sheet = await readSheet(new Blob([await readAll(source)]));
      return tableOf(
        sheet.map(row => row.map(cellText)),
        true
      );
    }
  }

  const start = await readStart(source, previewLimits.text);
  if (kind.kind === "unknown" && looksBinary(start.bytes)) return { kind: "none", reason: "binary" };
  const text = textOf(start);
  switch (kind.kind) {
    case "table":
      return tableOf(
        // The delimiter, a comma, a tab or another, is told from the text.
        Papa.parse<string[]>(text, { skipEmptyLines: "greedy", preview: tableRows + 2 }).data,
        start.whole
      );
    case "markdown":
    case "html":
      return { kind: kind.kind, text, whole: start.whole };
    case "text":
      return {
        kind: "text",
        text: kind.language === "json" && start.whole ? pretty(text) : text,
        language: kind.language,
        wrap: kind.wrap,
        whole: start.whole,
      };
    case "unknown":
      return { kind: "text", text, language: "text", wrap: true, whole: start.whole };
  }
}

/** A table from its rows, the first of which names the columns. Rows past `tableRows` are left out. */
function tableOf(cells: string[][], whole: boolean): FilePreview {
  const [header = [], ...body] = cells;
  const width = Math.max(header.length, ...body.map(row => row.length));
  const columns = Array.from({ length: width }, (_, index) => header[index]?.trim() || `Column ${index + 1}`);
  const rows = body.slice(0, tableRows).map(row => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  return { kind: "table", columns, rows, whole: whole && body.length <= tableRows };
}

/** A cell of a workbook as text: a date as ISO 8601 writes it, and an empty cell as nothing. */
function cellText(value: CellValue): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** JSON laid out with its levels indented, as it reads best; JSON that does not parse, as it is. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The start of a file, as far as `limit` bytes, and whether that is all of it. */
interface Start {
  bytes: Uint8Array;
  whole: boolean;
}

async function readStart({ name, size, url }: PreviewSource, limit: number): Promise<Start> {
  const whole = size <= limit;
  const response = await fetchFile(url, name, whole ? undefined : { Range: `bytes=0-${limit - 1}` });
  // A server that sends more than was asked for, as one that takes no ranges does, is read no further than this.
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(await response.arrayBuffer()).subarray(0, limit), whole };
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  void reader.cancel();
  const bytes = new Uint8Array(Math.min(length, limit));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk.subarray(0, bytes.length - at), at);
    at += chunk.length;
    if (at >= bytes.length) break;
  }
  return { bytes, whole };
}

async function readAll({ name, url }: PreviewSource): Promise<ArrayBuffer> {
  return (await fetchFile(url, name)).arrayBuffer();
}

async function fetchFile(url: string, name: string, headers?: HeadersInit): Promise<Response> {
  const problem = `${name} could not be read.`;
  const response = await fetch(url, { headers }).catch(() => {
    throw new Error(problem);
  });
  if (!response.ok) throw new Error(problem);
  return response;
}

/** Whether bytes are not text: text has no zero byte, which nearly every other kind of file has early on. */
function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** The text of the start of a file. Of only its start, the last line, which may be cut, is left out. */
function textOf({ bytes, whole }: Start): string {
  const text = new TextDecoder().decode(bytes);
  const end = text.lastIndexOf("\n");
  return whole || end < 0 ? text : text.slice(0, end);
}
