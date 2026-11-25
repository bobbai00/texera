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
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";

const openPage = async () => {
  const rendered = renderApp("/environments", { session: sessionFor(admin) });
  await screen.findByRole("heading", { level: 1, name: "Environments" });
  return rendered;
};

describe("the environments page", () => {
  it("makes an environment with its packages", async () => {
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: "New environment" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "ml");
    await user.click(within(dialog).getByRole("button", { name: "Add a package" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Package" }), "scikit-learn");
    await user.click(within(dialog).getByRole("combobox", { name: "Which versions" }));
    await user.click(screen.getByRole("option", { name: ">=" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Version" }), "1.5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const list = await screen.findByRole("list", { name: "Environments" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("mlscikit-learn>=1.5");
    expect(db.environments).toMatchObject([{ name: "ml", packages: { "scikit-learn": ">=1.5" } }]);
  });

  it("refuses a name the service does not allow, and says why the service refuses one", async () => {
    db.environments.push({ veid: 1, uid: admin.uid, name: "ml", packages: {} });
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: "New environment" }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "my env");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(name);
    await user.type(name, ".ml");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(name);
    await user.type(name, "ml");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent('An environment named "ml" already exists.');
  });

  it("takes a package without a version as one of any version, and a name and a version without their spaces", async () => {
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: "New environment" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), " ml ");
    await user.click(within(dialog).getByRole("button", { name: "Add a package" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Package" }), "pandas");
    await user.click(within(dialog).getByRole("button", { name: "Add a package" }));
    await user.type(within(dialog).getAllByRole("textbox", { name: "Package" })[1], "numpy");
    await user.type(within(dialog).getAllByRole("textbox", { name: "Version" })[1], " 2.0 ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const list = await screen.findByRole("list", { name: "Environments" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("mlpandas, numpy==2.0");
    expect(db.environments).toMatchObject([{ name: "ml", packages: { pandas: "", numpy: "==2.0" } }]);
  });

  it("saves again an environment that has a package of any version", async () => {
    db.environments.push({ veid: 1, uid: admin.uid, name: "ml", packages: { pandas: "" } });
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: /^ml/ }));
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "analysis");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(db.environments).toMatchObject([{ name: "analysis", packages: { pandas: "" } }]));
  });

  it("refuses a package listed twice, and says why the service refuses a version", async () => {
    const { user } = await openPage();
    await user.click(screen.getByRole("button", { name: "New environment" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "ml");
    for (const version of ["1.5", "1.6"]) {
      await user.click(within(dialog).getByRole("button", { name: "Add a package" }));
      await user.type(within(dialog).getAllByRole("textbox", { name: "Package" }).at(-1)!, "pandas");
      await user.type(within(dialog).getAllByRole("textbox", { name: "Version" }).at(-1)!, version);
    }

    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent('Duplicate package "pandas".');
    expect(db.environments).toEqual([]);

    await user.click(within(dialog).getAllByRole("button", { name: "Remove pandas" })[1]);
    const version = within(dialog).getByRole("textbox", { name: "Version" });
    await user.clear(version);
    await user.type(version, "1 .5");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        `Version "==1 .5" of package "pandas" is not valid: it contains whitespace.`
      )
    );
    expect(db.environments).toEqual([]);
  });

  it("changes an environment's packages, and deletes an environment", async () => {
    db.environments.push({ veid: 1, uid: admin.uid, name: "ml", packages: { numpy: "==2.0", pandas: "<=2.2" } });
    const { user } = await openPage();

    await user.click(screen.getByRole("button", { name: /^ml/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove numpy" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(db.environments[0].packages).toEqual({ pandas: "<=2.2" }));

    await user.click(screen.getByRole("button", { name: /^ml/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No environments yet")).toBeInTheDocument();
  });
});
