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

import { AngularApp } from "../support/apps/angular-app.ts";
import { admin, gateway } from "../support/backend.ts";
import { expect, test } from "../support/fixtures.ts";

// While areas move over one at a time, a person goes back and forth between the two apps. The React app is
// served beside the Angular app, on the same origin, and keeps the token where Angular does: one sign-in.
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(
  ({ baseURL }) => new URL(baseURL!).origin !== new URL(gateway).origin,
  "The React app runs on another origin than the Angular app, such as a dev server's"
);

test("a user signed in to the Angular app is signed in to the React app", async ({ app, page }) => {
  const angularApp = new AngularApp(page);
  await angularApp.signIn(admin);
  await expect(angularApp.datasetsHeading).toBeVisible();

  await app.openDatasets();

  await expect(app.datasetsHeading).toBeVisible();
});
