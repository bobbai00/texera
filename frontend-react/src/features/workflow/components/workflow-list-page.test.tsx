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
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

// What the list does for every kind of resource is tested in components/resource/resource-list-page.test.tsx.
describe("the workflows page", () => {
  it("lists the user's workflows, each opening in the editor", async () => {
    const { wid } = addWorkflow(db, { name: "Iris classification", description: "A decision tree" });

    renderApp("/workflows", { session: sessionFor(admin) });

    expect(await screen.findByRole("heading", { level: 1, name: "Workflows" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Workflows" });
    expect(within(list).getByRole("link", { name: "Iris classification" })).toHaveAttribute(
      "href",
      `/workflows/${wid}`
    );
  });

  it("deletes a workflow that the user owns from its row", async () => {
    addWorkflow(db, { name: "Iris classification" });
    const { user } = renderApp("/workflows", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for Iris classification" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Iris classification?" });
    expect(dialog).toHaveTextContent("Its versions and the results of its executions are deleted too.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No workflows yet")).toBeInTheDocument();
    await waitFor(() => expect(db.workflows).toEqual([]));
  });

  it("offers no delete for a workflow that is only shared with the user, which the server would not delete", async () => {
    addWorkflow(db, { name: "Shared", ownerUid: reader.uid, grants: [{ uid: admin.uid, privilege: "WRITE" }] });
    const { user } = renderApp("/workflows", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for Shared" }));

    const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(items.map(item => item.textContent)).toEqual(["Share"]);
  });

  it("shares a workflow through the workflow's access endpoints", async () => {
    addWorkflow(db, { name: "Iris classification" });
    const { user } = renderApp("/workflows", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for Iris classification" }));
    await user.click(await screen.findByRole("menuitem", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share Iris classification" });
    await user.type(within(dialog).getByLabelText("Email"), reader.email);
    await user.click(within(dialog).getByRole("button", { name: "Share" }));

    await waitFor(() =>
      expect(db.resources.find(resource => resource.type === "workflow")?.grants).toEqual([
        { uid: reader.uid, privilege: "READ" },
      ])
    );
  });
});
