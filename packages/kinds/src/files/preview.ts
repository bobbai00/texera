// How a file of a version is looked at, told from its name: as a table, as a written page, as
// plain text, or not at all.

import { TABULAR } from "./csv";

export type PreviewKind = "table" | "markdown" | "text" | "none";

const MARKDOWN = /\.(md|markdown)$/i;
/** What reads as text: a contract, a model's entry file, a query, a configuration, a log. */
const TEXT = /\.(json|jsonl|py|r|sql|ya?ml|toml|ini|cfg|xml|html?|log|sh|tex|bib)$/i;
/** Files known by their name alone. */
const NAMED = /^(readme|license|notice|citation|authors)$/i;

/** The way a file is previewed: markdown is a page to read, drawn as one unless its source is asked for. */
export function previewKind(path: string): PreviewKind {
  if (TABULAR.test(path)) return "table";
  if (MARKDOWN.test(path)) return "markdown";
  const name = path.split("/").at(-1) ?? path;
  return TEXT.test(name) || NAMED.test(name) ? "text" : "none";
}
