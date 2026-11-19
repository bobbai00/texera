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

import type { Download, Locator, Page } from "@playwright/test";
import type { Credentials, Dataset, FilePayload, Privilege } from "../backend.ts";
import type { DatasetApp } from "./dataset-app.ts";

/**
 * The Angular app in frontend/, which the React app replaces. Where it has no role or name to find an element
 * by, a comment says so and a CSS selector is used. Paths are absolute: the app is at the root of the gateway.
 */
export class AngularApp implements DatasetApp {
  readonly signInError: Locator;
  readonly datasetsHeading: Locator;
  private readonly page: Page;
  /** ng-zorro's dialogs have no accessible name, so they are told apart by their text. */
  private readonly shareDialog: Locator;

  constructor(page: Page) {
    this.page = page;
    // A paragraph, not an alert, and in the page, empty, until a sign-in fails.
    this.signInError = page.locator("p.error").filter({ hasText: /\S/ });
    this.datasetsHeading = page.getByRole("heading", { name: "Datasets", exact: true });
    this.shareDialog = page.getByRole("dialog").filter({ hasText: "Share this dataset with others" });
  }

  async signIn({ username, password }: Credentials): Promise<void> {
    // Sign-in with Google is on in the stack, and its button loads a script from Google: block it.
    await this.page.route("https://accounts.google.com/**", route => route.abort());
    // After signing in, the app opens the workflows unless it is told to return to the datasets.
    await this.page.goto("/login?returnUrl=/user/dataset");
    // The inputs have placeholders but no labels.
    await this.page.getByPlaceholder("Username").fill(username);
    await this.page.getByPlaceholder("Password").fill(password);
    await this.page.getByRole("button", { name: "Sign in", exact: true }).click();
  }

  async openDatasets(): Promise<void> {
    await this.page.goto("/user/dataset");
  }

  async createDataset({ name, description }: { name: string; description: string }): Promise<void> {
    await this.openDatasets();
    // Its name is "file-add Create Dataset": an icon takes its key as its name.
    await this.page.getByRole("button", { name: "Create Dataset" }).click();
    const dialog = this.page.getByRole("dialog").filter({ hasText: "Create New Dataset" });
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("Description").fill(description);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
  }

  async openDataset({ did }: Dataset): Promise<void> {
    await this.page.goto(`/user/dataset/${did}`);
    await this.page.getByRole("tab", { name: "Versions & Files" }).click();
  }

  datasetHeading(name: string): Locator {
    return this.page.getByRole("heading", { name: `Dataset: ${name}`, exact: true });
  }

  datasetDescription(description: string): Locator {
    return this.page.getByText(description, { exact: true });
  }

  async uploadFiles(files: FilePayload[]): Promise<void> {
    // The button opens a hidden file input.
    const fileChooser = this.page.waitForEvent("filechooser");
    await this.page.getByRole("button", { name: "Upload Files" }).click();
    await (await fileChooser).setFiles(files);
    // "Submit" shows as soon as one file is there, so wait for all of them.
    await this.page.getByText(`Finished: ${files.length} file(s)`).waitFor();
  }

  async createVersion(description: string): Promise<void> {
    // The label "Version:" is not linked to the input.
    await this.page.getByPlaceholder("Describe the new version (Optional)").fill(description);
    await this.page.getByRole("button", { name: "Submit" }).click();
  }

  file(name: string): Locator {
    // The file tree has no roles; each row is a span with the file's name as its title.
    return this.page.getByTitle(name, { exact: true });
  }

  async downloadFile(name: string): Promise<Download> {
    await this.file(name).click();
    const download = this.page.waitForEvent("download");
    // The file chosen shows in a card, whose button is named after its "download" icon. The button of the same
    // name beside the versions downloads the whole version.
    await this.page.locator("nz-card").getByRole("button", { name: "download", exact: true }).click();
    return download;
  }

  async previewFile(name: string): Promise<Locator> {
    // The file chosen shows in a card, whose renderer has no role or name.
    await this.file(name).click();
    return this.page.locator("texera-user-dataset-file-renderer");
  }

  async shareDataset(dataset: Dataset, email: string, privilege: Privilege): Promise<void> {
    // Sharing also emails the person through Gmail: answer that call here, so no test sends mail.
    await this.page.route("**/api/gmail/send", route => route.fulfill({ status: 200 }));
    // Only a dataset's card on the list can share it. A card has no role or name; its share button is named
    // after its icon.
    await this.openDatasets();
    const card = this.page.locator(".card-item").filter({ hasText: dataset.name });
    await card.getByRole("button", { name: "share-alt" }).click();
    await this.shareDialog.getByLabel("E-mails").fill(email);
    // The access select has no label.
    await this.shareDialog.locator("select[formcontrolname=accessLevel]").selectOption(privilege);
    await this.shareDialog.getByRole("button", { name: "Share", exact: true }).click();
  }

  personWithAccess(email: string): Locator {
    return this.shareDialog.getByRole("listitem").filter({ hasText: email });
  }
}
