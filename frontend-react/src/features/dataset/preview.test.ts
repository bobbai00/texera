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

import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "@/testing/server";
import { previewLimits, tableRows } from "./file-kinds";
import { readPreview } from "./preview";

vi.mock("read-excel-file", () => ({
  default: () =>
    Promise.resolve([
      ["species", "mass", "measured", "checked"],
      ["Adelie", 3750, new Date(Date.UTC(2026, 10, 18)), true],
      ["Gentoo", null, null, false],
    ]),
}));

/** Where the files of these tests are: a storage server, which honors a range when `ranges` is true. */
const storage = "http://storage.test/preview";

/** Serves a file, and keeps the range each request asked for. */
function serve(content: string | Uint8Array, { ranges = true } = {}) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const asked: (string | null)[] = [];
  server.use(
    http.get(`${storage}/file`, ({ request }) => {
      const range = request.headers.get("Range");
      asked.push(range);
      const match = ranges ? /^bytes=(\d+)-(\d+)$/.exec(range ?? "") : null;
      if (!match) return new HttpResponse(bytes);
      return new HttpResponse(bytes.slice(Number(match[1]), Number(match[2]) + 1), { status: 206 });
    })
  );
  return { size: bytes.length, asked };
}

const preview = (name: string, size: number) => readPreview({ name, size, url: `${storage}/file` });

describe("a preview of a table", () => {
  it("is its rows under its first, which names the columns, with quoted values whole", async () => {
    const { size } = serve('species,island,note\nAdelie,Torgersen,"bill, short"\nGentoo,Biscoe,\n');

    expect(await preview("penguins.csv", size)).toEqual({
      kind: "table",
      columns: ["species", "island", "note"],
      rows: [
        ["Adelie", "Torgersen", "bill, short"],
        ["Gentoo", "Biscoe", ""],
      ],
      whole: true,
    });
  });

  it("is split by tabs, or whatever the values are split by", async () => {
    const { size } = serve("species\tmass\nAdelie\t3750\n");

    expect(await preview("penguins.tsv", size)).toMatchObject({
      columns: ["species", "mass"],
      rows: [["Adelie", "3750"]],
    });
  });

  it("names the columns its first row leaves without a name, and fills rows that are short", async () => {
    const { size } = serve("species,\nAdelie,3750,Torgersen\nGentoo\n");

    expect(await preview("penguins.csv", size)).toMatchObject({
      columns: ["species", "Column 2", "Column 3"],
      rows: [
        ["Adelie", "3750", "Torgersen"],
        ["Gentoo", "", ""],
      ],
    });
  });

  it(`shows the first ${tableRows} rows of a longer one`, async () => {
    const { size } = serve(["n", ...Array.from({ length: tableRows + 50 }, (_, index) => String(index))].join("\n"));

    const shown = await preview("numbers.csv", size);

    expect(shown).toMatchObject({ kind: "table", whole: false });
    expect(shown.kind === "table" && shown.rows.length).toBe(tableRows);
  });

  it("of a big file is read from its start only, and leaves out the row the start cuts", async () => {
    const line = "Adelie,Torgersen,3750\n";
    const { size, asked } = serve(
      "species,island,mass\n" + line.repeat(Math.ceil((2 * previewLimits.text) / line.length))
    );

    const shown = await preview("penguins.csv", size);

    expect(asked).toEqual([`bytes=0-${previewLimits.text - 1}`]);
    expect(shown).toMatchObject({ kind: "table", whole: false });
    expect(shown.kind === "table" && shown.rows.at(-1)).toEqual(["Adelie", "Torgersen", "3750"]);
  });

  it("of a big file is read no further than its start from a server that sends all of it", async () => {
    const { size } = serve("x\n" + "1234567\n".repeat(previewLimits.text / 4), { ranges: false });

    expect(await preview("numbers.csv", size)).toMatchObject({ kind: "table", whole: false });
  });

  it("of a workbook is its first sheet, with dates as ISO 8601 writes them and empty cells empty", async () => {
    const { size } = serve(new Uint8Array([0x50, 0x4b, 3, 4]));

    expect(await preview("penguins.xlsx", size)).toEqual({
      kind: "table",
      columns: ["species", "mass", "measured", "checked"],
      rows: [
        ["Adelie", "3750", "2026-11-18T00:00:00.000Z", "true"],
        ["Gentoo", "", "", "false"],
      ],
      whole: true,
    });
  });

  it("of a workbook too big to read is not shown", async () => {
    expect(await preview("budget.xlsx", previewLimits.spreadsheet + 1)).toEqual({ kind: "none", reason: "too big" });
  });
});

describe("a preview of text", () => {
  it("is JSON with its levels indented, as it reads best", async () => {
    const { size } = serve('{"model":{"depth":4},"seed":7}');

    expect(await preview("config.json", size)).toEqual({
      kind: "text",
      text: '{\n  "model": {\n    "depth": 4\n  },\n  "seed": 7\n}',
      language: "json",
      wrap: false,
      whole: true,
    });
  });

  it("is JSON as it is when it does not parse", async () => {
    const { size } = serve('{"model": ');

    expect(await preview("config.json", size)).toMatchObject({ text: '{"model": ', language: "json" });
  });

  it("is the start of a big text, up to its last whole line", async () => {
    const { size } = serve("a line of a log\n".repeat(previewLimits.text / 8));

    const shown = await preview("server.log", size);

    expect(shown).toMatchObject({ kind: "text", language: "text", wrap: true, whole: false });
    expect(shown.kind === "text" && shown.text.endsWith("a line of a log")).toBe(true);
  });

  it("is Markdown, or a page, as its text", async () => {
    const { size } = serve("# Penguins\n");

    expect(await preview("README.md", size)).toEqual({ kind: "markdown", text: "# Penguins\n", whole: true });
    expect(await preview("index.html", size)).toEqual({ kind: "html", text: "# Penguins\n", whole: true });
  });

  it("is a file of a kind its name does not tell, if it is text", async () => {
    const { size } = serve("CC0 1.0 Universal\n");

    expect(await preview("LICENSE", size)).toEqual({
      kind: "text",
      text: "CC0 1.0 Universal\n",
      language: "text",
      wrap: true,
      whole: true,
    });
  });

  it("is not shown of a file of a kind its name does not tell, if it is not text", async () => {
    const { size } = serve(new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 0, 1]));

    expect(await preview("weights", size)).toEqual({ kind: "none", reason: "binary" });
  });
});

describe("a preview of anything else", () => {
  it("is shown by the browser from the file's link: an image, a video, a sound", async () => {
    for (const name of ["photo.png", "talk.mp4", "song.mp3"]) {
      expect(await preview(name, 10)).toMatchObject({ url: `${storage}/file` });
    }
  });

  it("is a PDF typed as one, which the storage server does not do", async () => {
    const { size } = serve("%PDF-1.7\n");

    const shown = await preview("paper.pdf", size);

    expect(shown.kind === "pdf" && shown.pdf.type).toBe("application/pdf");
    expect(shown.kind === "pdf" && (await shown.pdf.text())).toBe("%PDF-1.7\n");
  });

  it("is not shown of a PDF too big to read, nor of a kind the browser cannot show", async () => {
    expect(await preview("paper.pdf", previewLimits.pdf + 1)).toEqual({ kind: "none", reason: "too big" });
    expect(await preview("penguins.parquet", 10)).toEqual({ kind: "none", reason: "binary" });
  });

  it("says the file could not be read when the storage server does not give it", async () => {
    server.use(http.get(`${storage}/file`, () => HttpResponse.xml("<Error/>", { status: 403 })));

    await expect(preview("penguins.csv", 10)).rejects.toThrow("penguins.csv could not be read.");
  });
});
