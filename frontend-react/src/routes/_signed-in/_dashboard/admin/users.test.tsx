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
import { admin, newcomer, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

const openPage = async () => {
  const rendered = renderApp("/admin/users", { session: sessionFor(admin) });
  await screen.findByRole("heading", { level: 1, name: "Users" });
  return rendered;
};

describe("the users page", () => {
  it("lists everyone, with who waits for access and why they asked", async () => {
    await openPage();

    const rows = within(screen.getByRole("table", { name: "Users" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows.map(row => within(row).getAllByRole("cell")[0].textContent)).toEqual([
      "texeratexera",
      "readerreader@example.com",
      "newcomernewcomer@example.comUC Irvine · To clean up survey data",
    ]);
    expect(rows[2]).toHaveTextContent("Never");
  });

  it("finds people by name or email, and only those who wait", async () => {
    const { user } = await openPage();

    await user.type(screen.getByRole("searchbox", { name: "Search by name or email" }), "example.com");
    expect(within(screen.getByRole("table", { name: "Users" })).getAllByRole("row")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Waiting for access (1)" }));
    expect(within(screen.getByRole("table", { name: "Users" })).getAllByRole("row")).toHaveLength(2);
  });

  it("gives someone who waits access, and does not let the administrator take their own away", async () => {
    const { user } = await openPage();

    expect(screen.getByRole("combobox", { name: "Role of texera" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Role of newcomer" }));
    await user.click(screen.getByRole("option", { name: "Regular" }));

    await waitFor(() => expect(db.users.find(each => each.uid === newcomer.uid)?.role).toBe("REGULAR"));
  });

  it("is no page at all for someone who is not an administrator", async () => {
    renderApp("/admin/users", { session: sessionFor(reader) });

    expect(await screen.findByText("This page does not exist.")).toBeInTheDocument();
  });
});
