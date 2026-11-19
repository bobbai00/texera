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

import { test as base, type Page } from "@playwright/test";
import { AngularApp } from "./apps/angular-app.ts";
import type { DatasetApp } from "./apps/dataset-app.ts";
import { ReactApp } from "./apps/react-app.ts";
import { WorkflowEditor } from "./apps/workflow-editor.ts";
import { admin, Backend, reader } from "./backend.ts";

export interface Options {
  /** The app the scenarios drive, set by each project in playwright.config.ts. */
  appKind: "react" | "angular";
}

interface Fixtures {
  /** The app under test, used as a person would. */
  app: DatasetApp;
  /** The API, signed in as the admin, to set up and check what the app does not show. */
  backend: Backend;
  /** The React app's workflow editor, in the admin's browser. */
  editor: WorkflowEditor;
  /** The workflow editor in a browser of the second person's, who is signed in as the reader. */
  readerEditor: WorkflowEditor;
  /** The workflow editor in a second browser of the admin's own. */
  secondEditor: WorkflowEditor;
}

/** What a browser starts with for someone who is signed in: both apps read the token from localStorage. */
function signedIn(baseURL: string, token: string) {
  const origin = new URL(baseURL).origin;
  return { cookies: [], origins: [{ origin, localStorage: [{ name: "access_token", value: token }] }] };
}

export const test = base.extend<Options & Fixtures>({
  appKind: ["react", { option: true }],

  app: async ({ appKind, page }, use) => {
    await use(appKind === "react" ? new ReactApp(page) : new AngularApp(page));
  },

  backend: async ({ playwright }, use) => {
    const backend = await Backend.signIn(playwright.request, admin);
    await use(backend);
    await backend.dispose();
  },

  editor: async ({ page }, use) => {
    await use(new WorkflowEditor(page));
  },

  readerEditor: async ({ browser, playwright, baseURL, viewport }, use) => {
    const { username, password } = reader;
    const asReader = await Backend.signIn(playwright.request, { username, password });
    const context = await browser.newContext({ baseURL, viewport, storageState: signedIn(baseURL!, asReader.token) });
    const page: Page = await context.newPage();
    await use(new WorkflowEditor(page));
    await context.close();
    await asReader.dispose();
  },

  secondEditor: async ({ browser, backend, baseURL, viewport }, use) => {
    const context = await browser.newContext({ baseURL, viewport, storageState: signedIn(baseURL!, backend.token) });
    await use(new WorkflowEditor(await context.newPage()));
    await context.close();
  },

  // Each test starts with the admin signed in.
  // A test that signs in by itself starts signed out: test.use({ storageState: { cookies: [], origins: [] } }).
  storageState: async ({ backend, baseURL }, use) => {
    await use(signedIn(baseURL!, backend.token));
  },
});

export { expect } from "@playwright/test";
