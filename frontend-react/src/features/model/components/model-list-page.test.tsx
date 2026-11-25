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
import { addModel } from "@/testing/mock-api/model";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

// What the list does for every kind of resource is tested in components/resource/resource-list-page.test.tsx.
describe("the models page", () => {
  it("lists the user's models, each opening on its page in the Angular app", async () => {
    const { mid } = addModel(db, { name: "iris-tree", description: "A decision tree", isPublic: true });

    renderApp("/models", { session: sessionFor(admin) });

    expect(await screen.findByRole("heading", { level: 1, name: "Models" })).toBeInTheDocument();
    const row = within(await screen.findByRole("list", { name: "Models" })).getByRole("listitem");
    expect(within(row).getByRole("link", { name: "iris-tree" })).toHaveAttribute("href", `/user/model/${mid}`);
    expect(row).toHaveTextContent("Public");
    expect(row).toHaveTextContent("texera · Nov 12, 2026");
  });

  it("deletes a model from its row, with its versions and files", async () => {
    addModel(db, { name: "iris-tree" });
    const { user } = renderApp("/models", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for iris-tree" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete iris-tree?" });
    expect(dialog).toHaveTextContent("Its versions and files are deleted too.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No models yet")).toBeInTheDocument();
    await waitFor(() => expect(db.models).toEqual([]));
  });

  it("offers nothing to do with a model that is shared with the user to view", async () => {
    addModel(db, { name: "shared", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "READ" }] });

    renderApp("/models", { session: sessionFor(admin) });

    expect(await screen.findByRole("link", { name: "shared" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for shared" })).not.toBeInTheDocument();
  });
});
