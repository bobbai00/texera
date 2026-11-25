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

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { resetMockApi } from "./mock-api";
import { restartSharedEditing } from "./mock-api/shared-editing";
import { server } from "./server";

// jsdom has no layout, so it lacks what these call: the router's scroll restoration calls scrollTo, and
// Radix's Select scrolls its options into view and checks the pointer capture of a click.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
// The workflow canvas (React Flow) shows an operator only once it knows its size, which it asks a
// ResizeObserver for; jsdom has neither sizes nor the observer, so every element is told a size at once.
window.ResizeObserver = class {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    const contentRect = { x: 0, y: 0, top: 0, left: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
    this.callback([{ target, contentRect } as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
};
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { get: () => 200 },
  offsetHeight: { get: () => 60 },
});
// The code editor (CodeMirror) measures the text it shows; jsdom lays nothing out, so every measure is empty.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
// The canvas reads its zoom from a matrix, and measures its links with getBBox.
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => new DOMRect(0, 0, 0, 0);

// A request with no handler fails the test, even when the code catches the error it gets, so no test
// reaches a real network or passes without the answer it needs.
let unhandledRequests = 0;
beforeAll(() =>
  server.listen({
    onUnhandledFrame: ({ defaults }) => {
      unhandledRequests += 1;
      defaults.error();
    },
  })
);
beforeEach(() => resetMockApi());
afterEach(async () => {
  cleanup();
  // What a test left unsaved in a workflow's room is saved before the fake backend forgets the test.
  await restartSharedEditing();
  server.resetHandlers();
  // jsdom keeps storage and the <html> element across the tests of a file: the session and the theme.
  localStorage.clear();
  document.documentElement.removeAttribute("class");
  const unhandled = unhandledRequests;
  unhandledRequests = 0;
  if (unhandled > 0) throw new Error(`${unhandled} request(s) had no handler: see the [MSW] errors above.`);
});
afterAll(() => server.close());
