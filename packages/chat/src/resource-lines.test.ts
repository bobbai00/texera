import { describe, expect, it } from "vitest";
import { blocksOf, isResourceUri } from "./resource-lines";

const M = "texera://models/11111111-1111-4111-8111-111111111111@1";
const D = "texera://datasets/22222222-2222-4222-8222-222222222222";

describe("what the agent wrote", () => {
  it("is words, then the resources it put on lines of their own, then words", () => {
    expect(blocksOf(`Two fit:\n\n${M}\n${D}\n\nThe first is better.`)).toEqual([
      { type: "words", text: "Two fit:\n" },
      { type: "resources", uris: [M, D] },
      { type: "words", text: "The first is better." },
    ]);
  });

  it("takes a resource on its line as a list item or in backticks, once", () => {
    expect(blocksOf(`- \`${M}\`\n2. ${D}\n\n${M}`)).toEqual([{ type: "resources", uris: [M, D] }]);
  });

  it("leaves a URI inside a sentence, and one in a code block, as words", () => {
    const sentence = `It reads \`${D}\` first.`;
    expect(blocksOf(sentence)).toEqual([{ type: "words", text: sentence }]);
    const code = `\`\`\`\n${M}\n\`\`\``;
    expect(blocksOf(code)).toEqual([{ type: "words", text: code }]);
  });

  it("reads a URI among words as the resource's name, bare or as a link", () => {
    expect(blocksOf(`See ${M}, and ${D}.`)).toEqual([{ type: "words", text: `See \`${M}\`, and \`${D}\`.` }]);
    expect(blocksOf(`The [model](${M}) is here`)).toEqual([{ type: "words", text: `The \`${M}\` is here` }]);
    expect(blocksOf(`Open it: ${D}@2/files/a.csv.`)).toEqual([{ type: "words", text: `Open it: \`${D}@2/files/a.csv\`.` }]);
  });

  it("does not take a URI still being written for a resource", () => {
    expect(blocksOf("texera://models/1111")).toEqual([{ type: "words", text: "texera://models/1111" }]);
  });
});

describe("a URI in backticks", () => {
  it("is a resource only when that is all it is", () => {
    expect(isResourceUri(M)).toBe(true);
    expect(isResourceUri(`${D}@2/files/a.csv`)).toBe(true);
    expect(isResourceUri(`see ${M}`)).toBe(false);
    expect(isResourceUri("texera://models/x")).toBe(false);
  });
});
