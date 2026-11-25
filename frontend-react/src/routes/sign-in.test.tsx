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
import { getSession } from "@/lib/session";
import { admin, newcomer, reader, type TestUser } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { emailedCode } from "@/testing/mock-api/auth";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";

async function signIn(user: UserEvent, { name, password }: Pick<TestUser, "name" | "password">) {
  await user.type(await screen.findByLabelText("Username"), name);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("the sign-in page", () => {
  it("signs the user in and opens the datasets", async () => {
    const { user, router } = renderApp("/sign-in");

    await signIn(user, reader);

    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/datasets");
    expect(getSession()?.name).toBe(reader.name);
  });

  it("shows an error for a wrong password", async () => {
    const { user } = renderApp("/sign-in");

    await signIn(user, { name: admin.name, password: "wrong-password" });

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect username or password.");
    expect(getSession()).toBeNull();
  });

  it("shows the server's message when the server fails", async () => {
    server.use(
      http.post("/api/auth/login", () =>
        HttpResponse.json(
          { code: 500, message: "There was an error processing your request. It has been logged (ID 1f2e)." },
          { status: 500 }
        )
      )
    );
    const { user } = renderApp("/sign-in");

    await signIn(user, admin);

    expect(await screen.findByRole("alert")).toHaveTextContent("There was an error processing your request.");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("returns to the page in the redirect parameter", async () => {
    const { user, router } = renderApp(`/sign-in?redirect=${encodeURIComponent("/datasets/12?version=3")}`);

    await signIn(user, admin);

    await waitFor(() => expect(router.state.location.pathname).toBe("/datasets/12"));
    expect(router.state.location.search).toEqual({ version: 3 });
  });

  it.each([
    "https://example.com/datasets",
    "//example.com/datasets",
    "/\\example.com/datasets",
    "/\t/example.com/datasets",
    "/\n/example.com/datasets",
    "javascript:alert(1)",
  ])("ignores a redirect to another site, %j", async redirect => {
    const { user, router } = renderApp(`/sign-in?redirect=${encodeURIComponent(redirect)}`);

    await signIn(user, admin);

    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/datasets");
  });

  it("sends a user who is already signed in on", async () => {
    renderApp("/sign-in", { session: sessionFor(admin) });

    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
  });

  it("sends an account that is not active yet to the inactive page", async () => {
    const { user } = renderApp("/sign-in");

    await signIn(user, newcomer);

    expect(await screen.findByRole("heading", { name: "Your account is not active yet" })).toBeInTheDocument();
  });
});

describe("making an account", () => {
  async function fillIn(user: UserEvent, { name, email, password }: { name: string; email: string; password: string }) {
    await user.click(await screen.findByRole("tab", { name: "Create an account" }));
    const form = screen.getByRole("form", { name: "Create an account" });
    await user.type(within(form).getByLabelText("Username"), name);
    await user.type(within(form).getByLabelText("Email"), email);
    await user.type(within(form).getByLabelText("Password"), password);
    await user.type(within(form).getByLabelText("The password again"), password);
    return form;
  }

  it("makes an account, which waits for an administrator to activate it", async () => {
    const { user, router } = renderApp("/sign-in");

    const form = await fillIn(user, { name: "ada", email: "ada@example.com", password: "analytical" });
    await user.click(within(form).getByRole("button", { name: "Create the account" }));

    expect(await screen.findByRole("heading", { name: "Your account is not active yet" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inactive");
    expect(db.users.at(-1)).toMatchObject({ name: "ada", email: "ada@example.com", role: "INACTIVE" });
  });

  it("asks for the code it emailed, where the deployment emails one", async () => {
    db.signUp.emailCode = true;
    const { user } = renderApp("/sign-in");

    const form = await fillIn(user, { name: "ada", email: "ada@example.com", password: "analytical" });
    await user.click(within(form).getByRole("button", { name: "Email me a code" }));
    const code = await within(form).findByLabelText("Code");
    expect(form).toHaveTextContent("We emailed a code to ada@example.com.");
    await user.type(code, "000000");
    await user.click(within(form).getByRole("button", { name: "Create the account" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("The code is wrong");

    await user.clear(code);
    await user.type(code, emailedCode);
    await user.click(within(form).getByRole("button", { name: "Create the account" }));
    expect(await screen.findByRole("heading", { name: "Your account is not active yet" })).toBeInTheDocument();
  });

  it("says why it makes no account: two passwords that differ, or a name that is taken", async () => {
    const { user } = renderApp("/sign-in");

    const form = await fillIn(user, { name: reader.name, email: "someone@example.com", password: "analytical" });
    await user.type(within(form).getByLabelText("The password again"), "!");
    await user.click(within(form).getByRole("button", { name: "Create the account" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("The two passwords are not the same.");

    await user.type(within(form).getByLabelText("Password"), "!");
    await user.click(within(form).getByRole("button", { name: "Create the account" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Username exists already.");
  });

  it("offers no account to make where the deployment does not let people make their own", async () => {
    db.signUp.local = false;

    renderApp("/sign-in");

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Create an account" })).not.toBeInTheDocument();
  });
});
