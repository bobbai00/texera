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

import type { Download, Locator } from "@playwright/test";
import type { Credentials, Dataset, FilePayload, Privilege } from "../backend.ts";

/**
 * What a user does with datasets, in steps both apps have. Each scenario in e2e/ runs once against the React
 * app (ReactApp) and once against the Angular app it replaces (AngularApp), so the two are held to the same
 * tests. Methods act; locators are for the scenarios' assertions.
 */
export interface DatasetApp {
  /** Opens the sign-in page and signs in. The app then shows the datasets page, or signInError. */
  signIn(user: Credentials): Promise<void>;
  /** Why the sign-in failed. */
  readonly signInError: Locator;

  openDatasets(): Promise<void>;
  readonly datasetsHeading: Locator;

  /** Creates a dataset from the datasets page. The app then shows the new dataset's page. */
  createDataset(dataset: { name: string; description: string }): Promise<void>;

  /** Opens the page of a dataset, where its versions and files are. */
  openDataset(dataset: Dataset): Promise<void>;
  datasetHeading(name: string): Locator;
  datasetDescription(description: string): Locator;
  /** Uploads files to the open dataset, and waits until all of them are there. */
  uploadFiles(files: FilePayload[]): Promise<void>;
  /** Makes a version of the uploaded files. The page then shows the new version. */
  createVersion(description: string): Promise<void>;
  /** A file of the version the page shows. */
  file(name: string): Locator;
  /** Downloads a file of the version the page shows, as the browser saves it. */
  downloadFile(name: string): Promise<Download>;
  /** Chooses a file of the version the page shows, and returns where what is in it is shown. */
  previewFile(name: string): Promise<Locator>;

  /** Shares a dataset with a person, by their email. */
  shareDataset(dataset: Dataset, email: string, privilege: Privilege): Promise<void>;
  /** A person in the share dialog's list of the people with access. */
  personWithAccess(email: string): Locator;
}
