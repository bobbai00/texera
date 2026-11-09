// How the agent shows resources: by naming them. A URI alone on a line is that resource's card, so
// a list of them is cards to look at or pick from, and a URI in backticks reads as the resource's
// name. The words stay plain text in the catalog; what they show is decided here, as they are read.
// Pure, so it is tested on its own.

/** A part of what the agent wrote: words, or the resources it put on lines of their own. */
export type Block = { type: "words"; text: string } | { type: "resources"; uris: string[] };

// A rid is 36 characters, so a URI still arriving letter by letter stays words until it is whole.
const URI = "texera://[a-z-]+/[0-9a-f-]{36}(?:@\\d+)?(?:/[^\\s`]*)?";
/** A line that is one URI and nothing more, as a list item or in backticks too. */
const ALONE = new RegExp(`^\\s*(?:(?:[-*+]|\\d+[.)])\\s+)?\`?(${URI})\`?\\s*$`);
const WHOLE = new RegExp(`^${URI}$`);
const FENCE = /^\s*(```|~~~)/;

/** Whether some inline code is a resource's URI and nothing more. */
export const isResourceUri = (text: string) => WHOLE.test(text);

/** Splits what the agent wrote into words and runs of resources, in order. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  const words = (line: string) => {
    const last = blocks.at(-1);
    if (last?.type === "words") last.text += `\n${line}`;
    else blocks.push({ type: "words", text: line });
  };
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const uri = fenced ? undefined : ALONE.exec(line)?.[1];
    if (uri) {
      const last = blocks.at(-1);
      if (last?.type === "resources") last.uris.push(uri);
      else blocks.push({ type: "resources", uris: [uri] });
    } else if (line.trim() === "" && blocks.at(-1)?.type === "resources") {
      // Blank lines between resources keep them one run.
    } else words(line);
  }
  return blocks.flatMap((b): Block[] =>
    b.type === "resources" ? [{ ...b, uris: [...new Set(b.uris)] }] : b.text.trim() ? [b] : []
  );
}
