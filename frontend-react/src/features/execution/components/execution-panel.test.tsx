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
import { ws } from "msw";
import { useState, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FloatingArea } from "@/components/floating/floating-area";
import { ExecutionClient } from "@/lib/execution/client";
import { defaultSettings } from "@/lib/workflow/model";
import { logicalPlan } from "@/lib/workflow/plan";
import { admin } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addComputingUnit } from "@/testing/mock-api/execution";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderWithProviders } from "@/testing/render";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { link, operator, workflowContent } from "@/testing/workflow";
import { ExecutionPanel, type ResultChoice } from "./execution-panel";

const penguins = {
  columns: [
    { attributeName: "species", attributeType: "string" },
    { attributeName: "mass", attributeType: "integer" },
  ],
  rows: [
    { species: "Adelie", mass: 3750 },
    { species: "Gentoo", mass: 5000 },
    { species: "Chinstrap", mass: 3500 },
  ],
};

/** scan -> filter (heavier than the mass) -> limit: the limit's rows are kept as the result. */
const heavierThan = (mass: string) =>
  logicalPlan(
    workflowContent(
      [
        operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
        operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: mass }] }),
        operator("Limit", "limit", { limit: 5 }),
      ],
      [link("scan", "filter"), link("filter", "limit")]
    )
  );

/** scan -> filter (heavier than 3600), whose result is kept -> limit to the first: two results, of 2 rows and of 1. */
const bothKept = logicalPlan(
  workflowContent(
    [
      operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
      {
        ...operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
        viewResult: true,
      },
      operator("Limit", "limit", { limit: 1 }),
    ],
    [link("scan", "filter"), link("filter", "limit")]
  )
);

/**
 * The panel of what a client follows, as a page shows it: over a canvas, as its snapshot says. The result chosen is
 * the page's to keep, and is chosen beside the panel too, as a chip on the canvas does.
 */
function Watched({ client }: { client: ExecutionClient }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.snapshot);
  const [chosen, setChosen] = useState<ResultChoice>();
  return (
    <FloatingArea
      panels={
        <ExecutionPanel
          client={client}
          snapshot={snapshot}
          operatorNames={{ filter: "Filter", limit: "Limit" }}
          chosen={chosen}
          onChoose={operatorId => setChosen({ operatorId })}
        />
      }>
      <button
        type="button"
        onClick={() => setChosen({ operatorId: "filter" })}>
        Show the result of Filter
      </button>
    </FloatingArea>
  );
}

/** A client of a workflow of the admin's on a unit of theirs, connected, which closes when the test ends. */
async function connected() {
  const { wid } = addWorkflow(db, { name: "Heavy penguins" });
  const client = new ExecutionClient(wid, addComputingUnit(db, { name: "Small unit" }).cuid);
  onTestFinished(() => client.close());
  client.connect();
  await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
  return client;
}

/** The test speaks for the engine, beside what the fake engine says, to the clients that connect from now on. */
function speakForTheEngine(): (event: object) => void {
  let say: (event: object) => void = () => {};
  server.use(
    ws.link(`ws://${window.location.host}/wsapi/workflow-websocket`).addEventListener("connection", ({ client }) => {
      say = event => client.send(JSON.stringify(event));
    })
  );
  return event => say(event);
}

const rowsIn = (panel: HTMLElement) =>
  within(panel)
    .getAllByRole("row")
    .map(row => row.textContent);

beforeEach(() => {
  signInAs(admin);
  db.files["penguins.csv"] = penguins;
});

describe("ExecutionPanel", () => {
  it("shows the result kept, a page of rows at a time, and how many rows it has", async () => {
    const client = await connected();
    renderWithProviders(<Watched client={client} />);

    await client.start(heavierThan("4000"), defaultSettings);

    const execution = await screen.findByRole("region", { name: "Execution" });
    expect(await within(execution).findByText("1 row · page 1 of 1")).toBeVisible();
    expect(rowsIn(execution)).toEqual(["species stringmass integer", "Gentoo5000"]);
  });

  it("shows the rows of each execution, though the one before it kept a result of the same operator", async () => {
    const client = await connected();
    renderWithProviders(<Watched client={client} />);
    await client.start(heavierThan("3600"), defaultSettings);
    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("2 rows · page 1 of 1");
    expect(rowsIn(execution)).toEqual(["species stringmass integer", "Adelie3750", "Gentoo5000"]);

    await client.start(heavierThan("4000"), defaultSettings);

    await within(execution).findByText("1 row · page 1 of 1");
    expect(rowsIn(execution)).toEqual(["species stringmass integer", "Gentoo5000"]);
  });

  it("shows the result chosen beside it, on its tab, coming back for it each time it was minimized", async () => {
    const client = await connected();
    const { user } = renderWithProviders(<Watched client={client} />);
    await client.start(bothKept, defaultSettings);
    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");
    await user.click(within(execution).getByRole("tab", { name: "Console" }));
    await user.click(within(execution).getByRole("button", { name: "Minimize Execution" }));

    await user.click(screen.getByRole("button", { name: "Show the result of Filter" }));

    const shown = await screen.findByRole("region", { name: "Execution" });
    expect(within(shown).getByRole("tab", { name: "Result" })).toHaveAttribute("aria-selected", "true");
    expect(within(shown).getByRole("combobox", { name: "Result of" })).toHaveTextContent("Filter");
    expect(await within(shown).findByText("2 rows · page 1 of 1")).toBeInTheDocument();
    // The same result chosen again is a choice again.
    await user.click(within(shown).getByRole("button", { name: "Minimize Execution" }));
    await user.click(screen.getByRole("button", { name: "Show the result of Filter" }));
    expect(await screen.findByRole("region", { name: "Execution" })).toBeVisible();
  });

  it("shows the result chosen in it, which the page keeps", async () => {
    const client = await connected();
    const { user } = renderWithProviders(<Watched client={client} />);
    await client.start(bothKept, defaultSettings);
    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");

    await user.click(within(execution).getByRole("combobox", { name: "Result of" }));
    await user.click(screen.getByRole("option", { name: "Limit" }));

    expect(await within(execution).findByText("1 row · page 1 of 1")).toBeInTheDocument();
    expect(rowsIn(execution)).toEqual(["species stringmass integer", "Adelie3750"]);
  });

  it("keeps the rows of the execution its unit named last while the unit names none, and never another's", async () => {
    const say = speakForTheEngine();
    const client = await connected();
    renderWithProviders(<Watched client={client} />);
    await client.start(heavierThan("3600"), defaultSettings);
    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("2 rows · page 1 of 1");

    // All that a unit says that holds no execution any more, as one that restarted.
    say({ type: "WorkflowStateEvent", state: "Uninitialized" });

    await vi.waitFor(() => expect(within(execution).getByRole("status")).toHaveTextContent("Uninitialized"));
    expect(rowsIn(execution)).toEqual(["species stringmass integer", "Adelie3750", "Gentoo5000"]);

    await client.start(heavierThan("4000"), defaultSettings);
    await within(execution).findByText("1 row · page 1 of 1");
    say({ type: "WorkflowStateEvent", state: "Uninitialized" });

    await vi.waitFor(() => expect(within(execution).getByRole("status")).toHaveTextContent("Uninitialized"));
    expect(rowsIn(execution)).toEqual(["species stringmass integer", "Gentoo5000"]);
  });
});
