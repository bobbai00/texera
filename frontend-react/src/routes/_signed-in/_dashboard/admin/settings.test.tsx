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

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

const navigationLinks = () =>
  within(screen.getByRole("navigation", { name: "Main" }))
    .getAllByRole("link")
    .map(link => link.textContent);

describe("the settings of the deployment", () => {
  it("leaves out of the navigation what an administrator switched off", async () => {
    db.settings.models_enabled = "false";
    db.settings.quota_enabled = "false";

    renderApp("/datasets", { session: sessionFor(reader) });

    await screen.findByRole("heading", { name: "Datasets" });
    expect(navigationLinks()).toEqual([
      "Workflows",
      "Datasets",
      "Computing units",
      "Environments",
      "Public workflows",
      "Public datasets",
      "Public models",
    ]);
  });

  it("leaves out all of a user's work when that is switched off", async () => {
    db.settings.your_work_enabled = "false";

    renderApp("/datasets", { session: sessionFor(reader) });

    await screen.findByRole("heading", { name: "Datasets" });
    expect(screen.queryByRole("list", { name: "Your work" })).not.toBeInTheDocument();
  });

  it("switches an area off for everyone, and the navigation follows", async () => {
    const { user } = renderApp("/admin/settings", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("checkbox", { name: "Models" }));

    await waitFor(() => expect(db.settings.models_enabled).toBe("false"));
    await waitFor(() => expect(navigationLinks()).not.toContain("Models"));
    // What is inside an area that is off cannot be switched on alone.
    await user.click(screen.getByRole("checkbox", { name: "Your work" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Quota" })).toBeDisabled());
  });

  it("saves the limits of uploads that are whole numbers, and puts them back to what a new install has", async () => {
    const { user } = renderApp("/admin/settings", { session: sessionFor(admin) });
    const datasets = await screen.findByRole("region", { name: "Datasets" });
    const largest = within(datasets).getByRole("textbox", { name: "Largest file (MiB)" });

    await user.clear(largest);
    await user.type(largest, "0");
    expect(within(datasets).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(largest);
    await user.type(largest, "100");
    await user.click(within(datasets).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(db.settings.dataset_single_file_upload_max_size_mib).toBe("100"));

    await user.click(within(datasets).getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(db.settings.dataset_single_file_upload_max_size_mib).toBe("20"));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Datasets" })).getByRole("textbox", { name: "Largest file (MiB)" })
      ).toHaveValue("20")
    );
  });
});
