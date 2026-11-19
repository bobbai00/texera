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

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { admin } from "@/testing/fixtures";
import { renderApp, renderWithProviders } from "@/testing/render";
import { sessionFor } from "@/testing/session";
import { Header } from "./header";

describe("Header", () => {
  it("shows the user's name and a link home", () => {
    renderWithProviders(<Header user={{ name: "Zoë Ångström", email: "zoe@example.com" }} />);

    expect(screen.getByRole("banner")).toHaveTextContent("Zoë Ångström");
    expect(screen.getByRole("link", { name: "Texera" })).toHaveAttribute("href", "/");
  });

  it("switches between the light and the dark theme", async () => {
    const { user } = renderWithProviders(<Header user={admin} />);

    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement).toHaveClass("dark");

    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("shows the user's email in the account menu", async () => {
    const { user } = renderWithProviders(<Header user={{ name: "Zoë Ångström", email: "zoe@example.com" }} />);

    await user.click(screen.getByRole("button", { name: "Account" }));

    expect(await screen.findByRole("menu")).toHaveTextContent("zoe@example.com");
  });

  it("signs the user out from the account menu and opens the sign-in page", async () => {
    const { user } = renderApp("/datasets", { session: sessionFor(admin) });

    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in to Texera" })).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
  });
});
