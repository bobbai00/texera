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

// What a story's play function checks of the page it drew, which only a browser can tell: that it asked the backend
// nothing, not even for a socket, that it draws no text smaller than the app draws any, and where things are drawn on
// a workflow's canvas.

import { expect, waitFor, within } from "storybook/test";

/** Where the backend is reached on the site: its API, the engine's socket, and the shared editing service. */
const backend = /^\/(alpha\/)?(api|wsapi|shared-editing)(\/|$)/;

/** The least size the app draws text at: Tailwind's text-xs. */
const smallestText = 12;

/** What the page began to fetch, and the sockets it opened, since its record was started: by their addresses. */
const started: string[] = [];
/** Ends the record that is under way, if one is, and gives the page back its own fetch and sockets. */
let stopRecording: (() => void) | undefined;

/**
 * Starts the page's record of what it asks afresh, as a story begins, without what the stories before it asked, nor
 * the code and the pictures the page loaded: each request it fetches and each socket it opens, from the moment it
 * starts, which the browser's own record of what it fetched would keep only once the request is done and never for a
 * socket, and whatever else the browser fetches for it, as a picture, once fetched. The browser's record is made long
 * enough to keep every request after it. Returns what ends the record, which a story's `beforeEach` returns, so that
 * it is ended after the story.
 */
export function recordRequests(): () => void {
  stopRecording?.();
  started.length = 0;
  performance.setResourceTimingBufferSize(100_000);
  performance.clearResourceTimings();
  const before = { fetch, WebSocket };
  window.fetch = (input, init) => {
    started.push(input instanceof Request ? input.url : String(input));
    return before.fetch(input, init);
  };
  window.WebSocket = new Proxy(WebSocket, {
    construct(target, [url, protocols]: ConstructorParameters<typeof WebSocket>) {
      started.push(String(url));
      return new target(url, protocols);
    },
  });
  const stop = () => {
    if (stopRecording !== stop) return;
    Object.assign(window, before);
    stopRecording = undefined;
  };
  stopRecording = stop;
  return stop;
}

/**
 * The requests the page made of the backend since its record was started, by their paths: each it began to fetch,
 * whether or not it came back, each socket it opened, and whatever else the browser fetched from the backend for it.
 */
export function backendRequests(): string[] {
  const asked = [...started, ...performance.getEntriesByType("resource").map(entry => entry.name)];
  return [...new Set(asked.map(address => new URL(address, location.href).pathname))].filter(path =>
    backend.test(path)
  );
}

/** Each piece of text shown under `root` that is drawn smaller than the app draws any, with the size it is drawn at. */
export function smallText(root: Element = document.body): string[] {
  return [...root.querySelectorAll("*")]
    .filter(element =>
      [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    )
    .filter(element => element.checkVisibility())
    .map(element => ({ text: element.textContent.trim(), size: parseFloat(getComputedStyle(element).fontSize) }))
    .filter(({ size }) => size < smallestText)
    .map(({ text, size }) => `${text} (${size}px)`);
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

/** How long a canvas may take to be drawn, as on a machine that is busy with other work. */
const drawing = { timeout: 5000 };

/**
 * A workflow's canvas in the story, once it is drawn as it stays: React Flow shows each card and chip only once it has
 * measured it, places a card's chips by the card's size, and fits the workflow into view, each a moment after the
 * other. It is drawn once everything on it is shown, and nothing moved over two frames.
 */
export async function drawnCanvas(canvasElement: HTMLElement): Promise<HTMLElement> {
  const flow = await within(canvasElement).findByLabelText("Workflow canvas", {}, drawing);
  const places = () =>
    [...flow.querySelectorAll<HTMLElement>(".react-flow__viewport, .react-flow__node")].map(
      each => each.style.transform
    );
  await waitFor(async () => {
    const nodes = flow.querySelectorAll(".react-flow__node");
    await expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) await expect(node).toBeVisible();
    const before = places();
    await nextFrame();
    await nextFrame();
    await expect(places()).toEqual(before);
  }, drawing);
  return flow;
}

/** An operator's card on a canvas, by the name it goes by: React Flow makes each a group. */
export const cardOf = (flow: HTMLElement, name: string) => within(flow).getByRole("group", { name });
