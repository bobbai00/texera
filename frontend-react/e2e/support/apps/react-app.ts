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

import { type Download, expect, type Locator, type Page } from "@playwright/test";
import type { Credentials, Dataset, FilePayload, Privilege } from "../backend.ts";
import type { DatasetApp } from "./dataset-app.ts";

/**
 * The React app, found by roles, labels and text alone. Paths are relative to the base URL, which ends in /alpha/.
 */
export class ReactApp implements DatasetApp {
  readonly signInError: Locator;
  readonly datasetsHeading: Locator;
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
    this.signInError = page.getByRole("alert");
    this.datasetsHeading = page.getByRole("heading", { name: "Datasets", exact: true });
  }

  async signIn({ username, password }: Credentials): Promise<void> {
    await this.page.goto("sign-in");
    await this.page.getByLabel("Username").fill(username);
    await this.page.getByLabel("Password").fill(password);
    await this.page.getByRole("button", { name: "Sign in" }).click();
  }

  async openDatasets(): Promise<void> {
    await this.page.goto("datasets");
  }

  async createDataset({ name, description }: { name: string; description: string }): Promise<void> {
    await this.openDatasets();
    await this.page.getByRole("button", { name: "Create dataset" }).click();
    const dialog = this.page.getByRole("dialog", { name: "Create dataset" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel("Description").fill(description);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
  }

  async openDataset({ did }: Dataset): Promise<void> {
    await this.page.goto(`datasets/${did}`);
  }

  datasetHeading(name: string): Locator {
    return this.page.getByRole("heading", { name, exact: true });
  }

  datasetDescription(description: string): Locator {
    return this.page.getByText(description, { exact: true });
  }

  async uploadFiles(files: FilePayload[]): Promise<void> {
    // Files are added in the dialog of a new version, which stays open until createVersion makes the version.
    await this.page.getByRole("button", { name: "New version" }).click();
    await this.page.getByLabel("Add files").setInputFiles(files);
    // One row per file, each uploaded. A row that failed shows its message in the assertion's error.
    const rows = this.page.getByRole("list", { name: "Uploads" }).getByRole("listitem");
    await expect(rows).toHaveText(files.map(({ name }) => `${name} Uploaded`));
  }

  async createVersion(description: string): Promise<void> {
    await this.page.getByLabel("Version description").fill(description);
    await this.page.getByRole("button", { name: "Create version" }).click();
  }

  file(name: string): Locator {
    // Each file in the tree has a download button named after it.
    return this.page.getByRole("button", { name: `Download ${name}`, exact: true });
  }

  async downloadFile(name: string): Promise<Download> {
    const download = this.page.waitForEvent("download");
    await this.file(name).click();
    return download;
  }

  async previewFile(name: string): Promise<Locator> {
    // A file's name in the tree is the button that shows what is in it.
    await this.page.getByRole("list", { name: "Files" }).getByRole("button", { name, exact: true }).click();
    return this.page.getByRole("region", { name: `Preview of ${name}`, exact: true });
  }

  async shareDataset(dataset: Dataset, email: string, privilege: Privilege): Promise<void> {
    await this.openDataset(dataset);
    await this.page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = this.page.getByRole("dialog", { name: `Share ${dataset.name}` });
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByRole("combobox", { name: "Access" }).click();
    await this.page.getByRole("option", { name: privilege === "READ" ? "Can view" : "Can edit" }).click();
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
  }

  personWithAccess(email: string): Locator {
    return this.page.getByRole("list", { name: "People with access" }).getByRole("listitem").filter({ hasText: email });
  }
}
