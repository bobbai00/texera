import { describe, expect, test } from "bun:test";
import { keeper } from "../src/run/keeper.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Something that changes fast, and the copies written of it: each write takes a while. */
function copied(writeTakesMs = 0) {
  const source = { value: 0 };
  const written: number[] = [];
  let writing = 0;
  let overlapped = false;
  const write = async () => {
    if (++writing > 1) overlapped = true;
    const value = source.value;
    await pause(writeTakesMs);
    written.push(value);
    writing--;
  };
  return { source, written, write, overlapped: () => overlapped };
}

describe("a copy kept close behind something that changes fast", () => {
  test("is written once for many changes, a moment after the first", async () => {
    const { source, written, write } = copied();
    const keep = keeper(write, 20);
    for (let i = 1; i <= 50; i++) {
      source.value = i;
      keep.soon();
    }
    expect(written).toEqual([]);
    await pause(60);
    expect(written).toEqual([50]);
  });

  test("is brought level on request, after a write that is under way, never two at once", async () => {
    const { source, written, write, overlapped } = copied(30);
    const keep = keeper(write, 5);
    source.value = 1;
    keep.soon();
    await pause(15); // the first write is under way
    source.value = 2;
    await keep.now();
    expect(written).toEqual([1, 2]);
    expect(overlapped()).toBe(false);
  });

  test("writes nothing more once it is stopped", async () => {
    const { source, written, write } = copied();
    const keep = keeper(write, 10);
    source.value = 1;
    keep.soon();
    keep.stop();
    await pause(40);
    expect(written).toEqual([]);
  });
});
