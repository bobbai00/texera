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
import type { UserEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { admin, newcomer, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import type { MockResource } from "@/testing/mock-api/access";
import { addDataset } from "@/testing/mock-api/dataset";
import { renderWithProviders } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";
import { ShareDialog } from "./share-dialog";

/** Opens the dialog for dataset 12, "iris", from its button, as its owner, the admin, with these grants to others. */
async function openShareDialog(grants: MockResource["grants"] = []) {
  db.resources.push({ type: "dataset", id: 12, ownerUid: admin.uid, isPublic: false, grants });
  const rendered = renderWithProviders(
    <ShareDialog resource={{ kind: "dataset", id: 12, name: "iris" }}>
      <Button>Share</Button>
    </ShareDialog>,
    { session: sessionFor(admin) }
  );
  await rendered.user.click(screen.getByRole("button", { name: "Share" }));
  return rendered;
}

/** The rows of the list "People with access", each as its text. */
function peopleWithAccess() {
  const list = screen.getByRole("list", { name: "People with access" });
  return within(list)
    .getAllByRole("listitem")
    .map(row => row.textContent);
}

async function share(user: UserEvent, email: string, access: "Can view" | "Can edit" = "Can view") {
  // user-event cannot type an empty text.
  if (email) await user.type(screen.getByLabelText("Email"), email);
  await user.click(screen.getByRole("combobox", { name: "Access" }));
  await user.click(await screen.findByRole("option", { name: access }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Share" }));
}

describe("ShareDialog", () => {
  it("gives the focus back to the button that opened it when it closes", async () => {
    const { user } = await openShareDialog();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toHaveFocus();
  });

  it("lists the owner and everyone the resource is shared with", async () => {
    await openShareDialog([
      { uid: reader.uid, privilege: "READ" },
      { uid: newcomer.uid, privilege: "WRITE" },
    ]);

    expect(screen.getByRole("dialog", { name: "Share iris" })).toBeInTheDocument();
    await waitFor(() =>
      expect(peopleWithAccess()).toEqual([
        "texera Owner",
        "reader@example.com Can view",
        "newcomer@example.com Can edit",
      ])
    );
  });

  it("shows only the owner when the resource is shared with no one", async () => {
    await openShareDialog();

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner"]));
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
  });

  it.each(["Can view", "Can edit"] as const)("shares the resource with the access %j", async access => {
    const { user } = await openShareDialog();

    await share(user, reader.email, access);

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner", `reader@example.com ${access}`]));
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });

  it("shares the resource with an email that has a # in it", async () => {
    db.users.push({ uid: 4, name: "lab", email: "lab#3@example.com", password: "lab-password", role: "REGULAR" });
    const { user } = await openShareDialog();

    await share(user, "lab#3@example.com");

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner", "lab#3@example.com Can view"]));
  });

  it("changes what a person may do when the resource is shared with them again", async () => {
    const { user } = await openShareDialog([{ uid: reader.uid, privilege: "READ" }]);

    await share(user, reader.email, "Can edit");

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner", "reader@example.com Can edit"]));
  });

  it.each([
    ["is empty", ""],
    ["has no @", "reader"],
    ["has a space", "reader @example.com"],
  ])("asks for an email address when the email %s", async (_, email) => {
    const { user } = await openShareDialog();

    await share(user, email);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an email address, such as name@example.com.");
    expect(screen.getByLabelText("Email")).toBeInvalid();
  });

  it("shows the server's message when no account has the email", async () => {
    const { user } = await openShareDialog();

    await share(user, "nobody@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent("No registered user with email nobody@example.com");
  });

  it("removes a person", async () => {
    const { user } = await openShareDialog([{ uid: reader.uid, privilege: "READ" }]);

    await user.click(await screen.findByRole("button", { name: "Remove reader@example.com" }));

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner"]));
    expect(db.resources[0].grants).toEqual([]);
  });

  it("shows the server's message when a person cannot be removed", async () => {
    server.use(
      http.delete("/api/access/dataset/revoke/12/:email", () =>
        HttpResponse.json({ code: 403, message: "You do not have permission to modify dataset 12" }, { status: 403 })
      )
    );
    const { user } = await openShareDialog([{ uid: reader.uid, privilege: "READ" }]);

    await user.click(await screen.findByRole("button", { name: "Remove reader@example.com" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to modify dataset 12");
    expect(peopleWithAccess()).toEqual(["texera Owner", "reader@example.com Can view"]);
  });

  it.each([
    [
      "fails",
      () =>
        HttpResponse.json(
          { code: 500, message: "There was an error processing your request. It has been logged (ID 1f2e)." },
          { status: 500 }
        ),
      "There was an error processing your request.",
    ],
    [
      "sends a list that cannot be read",
      () => HttpResponse.text("[{"),
      "The server sent a response that could not be read.",
    ],
  ])("shows an error when the server %s", async (_, response, message) => {
    server.use(http.get("/api/access/dataset/list/12", response));
    await openShareDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("list", { name: "People with access" })).not.toBeInTheDocument();
  });
  it("shares a resource of another kind through that kind's endpoints", async () => {
    db.resources.push({ type: "workflow", id: 7, ownerUid: admin.uid, isPublic: false, grants: [] });
    const { user } = renderWithProviders(
      <ShareDialog resource={{ kind: "workflow", id: 7, name: "Iris classification" }}>
        <Button>Share</Button>
      </ShareDialog>,
      { session: sessionFor(admin) }
    );
    await user.click(screen.getByRole("button", { name: "Share" }));

    await share(user, reader.email, "Can edit");

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner", "reader@example.com Can edit"]));
    expect(db.resources.find(resource => resource.type === "workflow")?.grants).toEqual([
      { uid: reader.uid, privilege: "WRITE" },
    ]);
  });

  it("opens without a button of its own, for a place that opens it from a menu", async () => {
    db.resources.push({ type: "dataset", id: 12, ownerUid: admin.uid, isPublic: false, grants: [] });
    renderWithProviders(
      <ShareDialog
        resource={{ kind: "dataset", id: 12, name: "iris" }}
        open
      />,
      { session: sessionFor(admin) }
    );

    expect(await screen.findByRole("dialog", { name: "Share iris" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share", expanded: true })).not.toBeInTheDocument();
  });

  it("says whether a resource is public, for anyone to find in the hub", async () => {
    const { did } = addDataset(db, { name: "census", isPublic: true });
    renderWithProviders(
      <ShareDialog
        resource={{ kind: "dataset", id: did, name: "census" }}
        open
      />,
      { session: sessionFor(admin) }
    );

    expect(await screen.findByRole("checkbox", { name: "Public" })).toBeChecked();
  });

  it("has no Public switch for a computing unit, which cannot be public", async () => {
    db.resources.push({ type: "computing-unit", id: 5, ownerUid: admin.uid, isPublic: false, grants: [] });
    renderWithProviders(
      <ShareDialog
        resource={{ kind: "computing-unit", id: 5, name: "Small" }}
        open
      />,
      { session: sessionFor(admin) }
    );

    await waitFor(() => expect(peopleWithAccess()).toEqual(["texera Owner"]));
    expect(screen.queryByRole("checkbox", { name: "Public" })).not.toBeInTheDocument();
  });
});
