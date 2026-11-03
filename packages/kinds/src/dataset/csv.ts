import type { Column } from "@texera/ui";

/**
 * Parses RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). Previews
 * read only the start of a file, so a final row cut off mid-way is dropped when
 * `truncated` is set.
 */
export function parseCsv(text: string, { delimiter = ",", truncated = false } = {}): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (!truncated && (field !== "" || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.length > 1 || r[0] !== "");
}

const INTEGER = /^[+-]?\d+$/;
const DOUBLE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN = /^(true|false)$/i;

/** Texera's attribute type for a column, guessed from sample values the way CSV scan infers it. */
export function inferType(values: string[]): string {
  const present = values.filter(v => v !== "");
  if (present.length === 0) return "string";
  if (present.every(v => INTEGER.test(v))) return present.every(v => Math.abs(Number(v)) < 2 ** 31) ? "integer" : "long";
  if (present.every(v => DOUBLE.test(v))) return "double";
  if (present.every(v => BOOLEAN.test(v))) return "boolean";
  return "string";
}

export interface TablePreview {
  columns: Column[];
  rows: string[][];
}

/** The delimiter a file scan would use for this file name. */
export const delimiterFor = (fileName: string) => (fileName.toLowerCase().endsWith(".tsv") ? "\t" : ",");

/** Header plus typed columns and the first `limit` rows of a CSV (or TSV) text. */
export function previewCsv(text: string, { limit = 100, truncated = false, delimiter = "," } = {}): TablePreview {
  const [header = [], ...body] = parseCsv(text, { truncated, delimiter });
  const rows = body.slice(0, limit);
  const columns = header.map((name, i) => ({ name, type: inferType(rows.map(r => r[i] ?? "")) }));
  return { columns, rows };
}

export const TABULAR = /\.(csv|tsv|txt)$/i;
