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

import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { describe, expect, it } from "vitest";
import { admin, newcomer, reader } from "@/testing/fixtures";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";

describe("the pages for signed-in users", () => {
  it("send a visitor without a session to sign in, and remember where they were going", async () => {
    const { router } = renderApp("/datasets");

    expect(await screen.findByRole("heading", { name: "Sign in to Texera" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({ redirect: "/datasets" });
  });

  it("send an account that is not active yet to the inactive page, where it can sign out", async () => {
    const { user } = renderApp("/datasets", { session: sessionFor(newcomer) });

    expect(await screen.findByRole("heading", { name: "Your account is not active yet" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in to Texera" })).toBeInTheDocument();
  });

  it("drop an expired token and ask to sign in again", async () => {
    renderApp("/datasets", { session: sessionFor(admin, { expiresAt: Date.now() - 60_000 }) });

    expect(await screen.findByRole("heading", { name: "Sign in to Texera" })).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("show the shell: a header, and navigation that leaves for the Angular app where React has no page yet", async () => {
    renderApp("/datasets", { session: sessionFor(reader) });

    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent(reader.name);
    const navigation = screen.getByRole("navigation", { name: "Main" });
    const links = within(navigation)
      .getAllByRole("link")
      .map(link => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Workflows", "/workflows"],
      ["Datasets", "/datasets"],
      ["Models", "/models"],
      ["Computing units", "/computing-units"],
      ["Environments", "/environments"],
      ["Quota", "/quota"],
      ["Public workflows", "/hub?kind=workflow"],
      ["Public datasets", "/hub?kind=dataset"],
      ["Public models", "/hub?kind=model"],
    ]);
  });

  it("show an administrator the administration pages too, those still in the Angular app by its paths", async () => {
    renderApp("/datasets", { session: sessionFor(admin) });

    const administration = await screen.findByRole("list", { name: "Admin" });
    const links = within(administration)
      .getAllByRole("link")
      .map(link => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Users", "/admin/users"],
      ["Executions", "/admin/executions"],
      ["Computing units", "/admin/computing-units"],
      ["Gmail", "/admin/gmail"],
      ["Settings", "/admin/settings"],
      ["CU images", "/admin/cu-image"],
    ]);
  });

  it("open the datasets from the home page", async () => {
    const { router } = renderApp("/", { session: sessionFor(admin) });

    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/datasets");
  });

  it("go to sign in when the session ends in another tab or in the Angular app", async () => {
    renderApp("/datasets", { session: sessionFor(admin) });
    await screen.findByRole("heading", { name: "Datasets" });

    localStorage.removeItem("access_token");
    window.dispatchEvent(new StorageEvent("storage", { key: "access_token", newValue: null }));

    expect(await screen.findByRole("heading", { name: "Sign in to Texera" })).toBeInTheDocument();
  });

  it("go to sign in when the server rejects the token as the first page loads", async () => {
    server.use(http.get("/api/dashboard/search", () => new HttpResponse(null, { status: 401 })));

    const { router } = renderApp("/datasets", { session: sessionFor(admin) });

    expect(await screen.findByRole("heading", { name: "Sign in to Texera" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: "/datasets" });
  });
});
