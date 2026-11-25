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
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { errorResponse } from "@/testing/mock-api/access";
import { addComputingUnit } from "@/testing/mock-api/execution";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";
import { spokenText } from "@/testing/text";

const openPage = async (session = sessionFor(admin)) => {
  const rendered = renderApp("/computing-units", { session });
  await screen.findByRole("heading", { level: 1, name: "Computing units" });
  return rendered;
};

describe("the computing units page", () => {
  it("lists the user's units and those shared with them, with where each stands and what it has", async () => {
    addComputingUnit(db, { name: "Local" });
    addComputingUnit(db, {
      name: "Big one",
      type: "kubernetes",
      status: "Pending",
      resource: { cpuLimit: "4", memoryLimit: "4Gi", gpuLimit: "1" },
    });

    await openPage();

    const list = screen.getByRole("list", { name: "Computing units" });
    const [local, big] = within(list).getAllByRole("listitem");
    expect(spokenText(local)).toBe("Local Running texera · Nov 12, 2026");
    expect(spokenText(big)).toBe("Big one Pending4 CPU · 4Gi · 1 GPU texera · Nov 12, 2026");
  });

  it("makes a unit somewhere else, at an address, on a deployment that makes only those", async () => {
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: "New computing unit" }));
    const dialog = screen.getByRole("dialog", { name: "New computing unit" });
    await user.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Lab machine");
    expect(within(dialog).getByRole("textbox", { name: "Address" })).toHaveValue(`${window.location.origin}/wsapi`);
    await user.click(within(dialog).getByRole("button", { name: "Make it" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Lab machine")).toBeInTheDocument();
    expect(db.computingUnits.at(-1)).toMatchObject({ name: "Lab machine", type: "local" });
  });

  it("makes a unit of the cluster with the limits chosen, and watches it start", async () => {
    db.unitTypes = ["kubernetes", "local"];
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: "New computing unit" }));
    const dialog = screen.getByRole("dialog", { name: "New computing unit" });
    await user.click(within(dialog).getByRole("combobox", { name: "CPUs" }));
    await user.click(screen.getByRole("option", { name: "4" }));
    await user.click(within(dialog).getByRole("button", { name: "Make it" }));

    const list = await screen.findByRole("list", { name: "Computing units" });
    const row = within(list).getByRole("listitem");
    expect(row).toHaveTextContent("Pending4 CPU · 1Gi");
    db.computingUnits[0].status = "Running";
    await waitFor(() => expect(row).toHaveTextContent("Running"), { timeout: 5000 });
  });

  it("shows why the service would not make a unit", async () => {
    server.use(
      http.post("/api/computing-unit/create", () => errorResponse(403, "You may have at most 2 units running."))
    );
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: "New computing unit" }));
    const dialog = screen.getByRole("dialog", { name: "New computing unit" });
    await user.click(within(dialog).getByRole("button", { name: "Make it" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("You may have at most 2 units running.");
  });

  it("ends a unit its owner chooses to, and lets someone it is shared with only use it", async () => {
    addComputingUnit(db, { name: "Mine", ownerUid: reader.uid });
    const shared = addComputingUnit(db, { name: "Theirs" });
    db.resources.find(each => each.type === "computing-unit" && each.id === shared.cuid)!.grants = [
      { uid: reader.uid, privilege: "WRITE" },
    ];
    const { user } = await openPage(sessionFor(reader));

    // Someone a unit is shared with may share it on, but only its owner may end it.
    await user.click(screen.getByRole("button", { name: "More actions for Theirs" }));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "More actions for Mine" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(db.computingUnits.map(unit => unit.name)).toEqual(["Theirs"]));
  });

  it("finds units by their names and orders them, as every list of resources does", async () => {
    addComputingUnit(db, { name: "Small one" });
    addComputingUnit(db, { name: "Big one" });
    const { user } = await openPage();
    const names = () =>
      within(screen.getByRole("list", { name: "Computing units" }))
        .getAllByRole("listitem")
        .map(item => spokenText(item).split(" Running")[0]);

    await user.type(screen.getByRole("searchbox", { name: "Search computing units" }), "big");
    await waitFor(() => expect(names()).toEqual(["Big one"]));

    await user.clear(screen.getByRole("searchbox", { name: "Search computing units" }));
    await user.click(screen.getByRole("combobox", { name: "Order" }));
    await user.click(screen.getByRole("option", { name: "Name, A to Z" }));
    await waitFor(() => expect(names()).toEqual(["Big one", "Small one"]));
  });
});
