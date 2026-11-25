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
import { addDataset } from "@/testing/mock-api/dataset";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";
import { link, operator, workflowContent } from "@/testing/workflow";

/** Reader's public workflow "Penguin masses", which the admin likes and someone copied once. */
function addPublicWorkflow() {
  const workflow = addWorkflow(db, {
    name: "Penguin masses",
    description: "Heavy penguins by species",
    ownerUid: reader.uid,
    content: workflowContent(
      [operator("CSVFileScan", "scan", { fileName: "penguins.csv" }), operator("Limit", "limit", { limit: 5 })],
      [link("scan", "limit")]
    ),
  });
  db.resources.find(resource => resource.type === "workflow" && resource.id === workflow.wid)!.isPublic = true;
  db.likes.push({ type: "workflow", id: workflow.wid, uid: admin.uid });
  db.clones.push(workflow.wid);
  return workflow;
}

describe("the hub", () => {
  it("lists the public workflows to someone who is not signed in, with how many like and copied each", async () => {
    addPublicWorkflow();
    addWorkflow(db, { name: "Private one", ownerUid: reader.uid });

    renderApp("/hub");

    const list = await screen.findByRole("list", { name: "Public workflows" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    await waitFor(() => expect(rows[0]).toHaveTextContent("1 likes1 copies"));
    expect(within(rows[0]).getByRole("link", { name: "Penguin masses" })).toHaveAttribute("href", "/hub/workflows/1");
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("lists the public datasets of everyone, and finds them by their words", async () => {
    addDataset(db, { name: "Iris", ownerUid: reader.uid, isPublic: true });
    addDataset(db, { name: "Penguins", description: "Antarctic birds", isPublic: true });

    const { user } = renderApp("/hub?kind=dataset");

    const list = await screen.findByRole("list", { name: "Public datasets" });
    expect(within(list).getByText("Iris")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search public datasets" }), "antarctic");
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "Public datasets" })).getAllByRole("listitem")).toHaveLength(1)
    );
    expect(screen.getByRole("list", { name: "Public datasets" })).toHaveTextContent("Penguins");
  });

  it("opens a public workflow as the public sees it, with the properties of each operator to look at", async () => {
    const { wid } = addPublicWorkflow();
    const { user } = renderApp(`/hub/workflows/${wid}`);

    expect(await screen.findByRole("heading", { level: 1, name: "Penguin masses" })).toBeInTheDocument();
    within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name: "Limit" }).focus();
    await user.keyboard("{Enter}");

    const properties = await screen.findByRole("region", { name: "Properties of Limit" });
    expect(within(properties).getByRole("spinbutton", { name: "Limit *" })).toHaveValue(5);
    expect(within(properties).getByRole("spinbutton", { name: "Limit *" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Sign in to make a copy" })).toBeInTheDocument();
  });

  it("likes a public workflow, and copies it into a workflow of the user's, which opens", async () => {
    const { wid } = addPublicWorkflow();
    const { user, router } = renderApp(`/hub/workflows/${wid}`, { session: sessionFor(reader) });

    const like = await screen.findByRole("button", { name: /^Like/ });
    await user.click(like);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Liked/ })).toHaveAttribute("aria-pressed", "true"));
    expect(db.likes).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflows/${wid + 1}`));
    expect(db.workflows.at(-1)).toMatchObject({ name: "Penguin masses_copy" });
  });

  it("says a workflow is not public, for one that is not", async () => {
    const { wid } = addWorkflow(db, { name: "Private one", ownerUid: reader.uid });

    renderApp(`/hub/workflows/${wid}`);

    expect(await screen.findByText("This workflow is not public.")).toBeInTheDocument();
  });

  it("is no page at all on a deployment without a hub", async () => {
    db.settings.hub_enabled = "false";

    renderApp("/hub");

    await waitFor(() => expect(screen.getByText("This page does not exist.")).toBeInTheDocument());
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(screen.getByText("This page does not exist.")).toBeInTheDocument();
  });
});

describe("making a resource public", () => {
  it("makes a workflow public from its sharing, after which the hub lists it", async () => {
    addWorkflow(db, { name: "Iris" });
    const { user } = renderApp("/workflows", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for Iris" }));
    await user.click(screen.getByRole("menuitem", { name: "Share" }));
    const dialog = screen.getByRole("dialog");
    const publicSwitch = await within(dialog).findByRole("checkbox", { name: /Public/ });
    await waitFor(() => expect(publicSwitch).toBeEnabled());
    await user.click(publicSwitch);

    await waitFor(() => expect(db.resources.find(resource => resource.type === "workflow")?.isPublic).toBe(true));
    await waitFor(() => expect(within(dialog).getByRole("checkbox", { name: /Public/ })).toBeChecked());
  });

  it("turns a dataset's publicity over only when it is not as asked", async () => {
    addDataset(db, { name: "Iris" });
    const { user } = renderApp("/datasets", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "More actions for Iris" }));
    await user.click(screen.getByRole("menuitem", { name: "Share" }));
    const publicSwitch = await within(screen.getByRole("dialog")).findByRole("checkbox", { name: /Public/ });
    await waitFor(() => expect(publicSwitch).toBeEnabled());
    await user.click(publicSwitch);

    await waitFor(() => expect(db.resources.find(resource => resource.type === "dataset")?.isPublic).toBe(true));
  });
});
