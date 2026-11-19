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

import type { Grammar } from "@/components/code/code-look";

/**
 * How a file of a dataset is shown, by its kind. The storage server calls every file "binary/octet-stream", so the
 * kind is told by the file's extension.
 */
export type FileKind =
  /** Rows of values, such as a CSV file, shown as a table. */
  | { kind: "table" }
  /** An Excel workbook, whose first sheet is shown as a table. */
  | { kind: "spreadsheet" }
  /** Text, highlighted as its language. Prose and logs wrap their lines; code and data scroll across. */
  | { kind: "text"; language: Grammar; wrap: boolean }
  /** Text formatted as it is meant to be read: Markdown. */
  | { kind: "markdown" }
  /** A web page, shown in a frame of its own. */
  | { kind: "html" }
  | { kind: "image" }
  | { kind: "pdf" }
  | { kind: "video" }
  | { kind: "audio" }
  /** A kind of file the browser cannot show, such as an archive. */
  | { kind: "binary" }
  /** A file whose kind its name does not tell: it is shown as text if it is text. */
  | { kind: "unknown" };

const code = (language: Grammar): FileKind => ({ kind: "text", language, wrap: false });
const prose: FileKind = { kind: "text", language: "text", wrap: true };

const kinds: Record<string, FileKind> = {
  ...ofEach(["csv", "tsv", "tab", "psv"], { kind: "table" }),
  xlsx: { kind: "spreadsheet" },
  ...ofEach(["json", "geojson", "ipynb"], code("json")),
  ...ofEach(["jsonl", "ndjson"], code("text")),
  ...ofEach(["md", "markdown"], { kind: "markdown" }),
  ...ofEach(["html", "htm"], { kind: "html" }),
  ...ofEach(["txt", "text", "log", "rst"], prose),
  py: code("python"),
  r: code("r"),
  java: code("java"),
  sql: code("sql"),
  ...ofEach(["js", "mjs", "cjs", "ts"], code("javascript")),
  ...ofEach(["sh", "bash", "zsh"], code("shell")),
  ...ofEach(["yaml", "yml"], code("yaml")),
  toml: code("toml"),
  ...ofEach(["xml", "xsd", "kml", "gpx"], code("xml")),
  ...ofEach(["ini", "cfg", "conf", "properties", "env"], code("properties")),
  ...ofEach(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"], { kind: "image" }),
  pdf: { kind: "pdf" },
  ...ofEach(["mp4", "webm", "mov", "m4v", "ogv"], { kind: "video" }),
  ...ofEach(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"], { kind: "audio" }),
  ...ofEach(
    [
      ...["parquet", "arrow", "feather", "avro", "orc", "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar"],
      ...["pkl", "pickle", "npy", "npz", "h5", "hdf5", "pt", "pth", "onnx", "bin", "db", "sqlite"],
      ...["xls", "doc", "docx", "ppt", "pptx", "exe", "dll", "so", "dylib", "class", "jar"],
    ],
    { kind: "binary" }
  ),
};

function ofEach(extensions: string[], kind: FileKind): Record<string, FileKind> {
  return Object.fromEntries(extensions.map(extension => [extension, kind]));
}

/** The kind of a file, by its name. */
export function fileKindOf(name: string): FileKind {
  const dot = name.lastIndexOf(".");
  // A name that starts with its only dot, such as ".env", is all extension.
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return kinds[extension] ?? { kind: "unknown" };
}

const mebibyte = 1024 * 1024;

/**
 * How much of a file is read to show it. Of text, only its start: a file of any size is shown, as far as this.
 * A workbook and a PDF are read whole, so a bigger one is not shown. Images, videos and sound are streamed by the
 * browser as they are shown, so they have no limit.
 */
export const previewLimits = { text: mebibyte, spreadsheet: 20 * mebibyte, pdf: 50 * mebibyte };

/** How many rows of a table are shown. */
export const tableRows = 500;
