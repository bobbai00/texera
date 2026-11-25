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

import { EditorView } from "@codemirror/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { codeProperty } from "@/lib/workflow/code";
import { WorkflowDocument } from "@/lib/workflow/document";
import type { CommentBox, WorkflowContent } from "@/lib/workflow/model";
import { WorkflowRoom } from "@/lib/workflow/room";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addComputingUnit, addExecutionRecord } from "@/testing/mock-api/execution";
import { cutSharedEditing } from "@/testing/mock-api/shared-editing";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor } from "@/testing/session";
import { link, operator, workflowContent } from "@/testing/workflow";

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

/** The admin's workflow "Heavy penguins": scan -> filter (mass > 3600) -> limit, on a backend with a running unit. */
function addPenguinWorkflow(seed: { grants?: { uid: number; privilege: "READ" | "WRITE" }[]; unit?: boolean } = {}) {
  db.files["penguins.csv"] = penguins;
  if (seed.unit !== false) addComputingUnit(db, { name: "Small unit" });
  return addWorkflow(db, {
    name: "Heavy penguins",
    grants: seed.grants,
    content: workflowContent(
      [
        operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
        operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
        operator("Limit", "limit", { limit: 5 }),
      ],
      [link("scan", "filter"), link("filter", "limit")]
    ),
  });
}

/** What is saved of a workflow on the fake backend. */
const savedContent = (wid: number) =>
  JSON.parse(db.workflows.find(workflow => workflow.wid === wid)!.content) as WorkflowContent;
const savedOperator = (wid: number, id: string) => savedContent(wid).operators.find(each => each.operatorID === id);

/** The operators on the canvas, by the names they show, from A to Z. The canvas makes each link a group too. */
const operatorsOnCanvas = () =>
  within(screen.getByLabelText("Workflow canvas"))
    .getAllByRole("group")
    .filter(group => group.getAttribute("aria-roledescription") === "node")
    .map(node => node.getAttribute("aria-label"))
    .sort();

/** Selects an operator on the canvas with the keyboard, as someone who cannot use a mouse does. */
async function select(user: UserEvent, name: string) {
  within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name }).focus();
  await user.keyboard("{Enter}");
  return screen.findByRole("region", { name: `Properties of ${name}` });
}

async function openEditor(wid: number, session = sessionFor(admin)) {
  const rendered = renderApp(`/workflows/${wid}`, { session });
  // The editor is loaded on demand and enters the workflow's room first, which takes the first test a moment. Its
  // canvas is drawn once the panels over it are measured.
  await screen.findByRole("heading", { level: 1, name: "Heavy penguins" }, { timeout: 5000 });
  await screen.findByLabelText("Workflow canvas");
  return rendered;
}

/** A workflow whose second operator is written as code. */
function addCodeWorkflow() {
  addComputingUnit(db, { name: "Small unit" });
  return addWorkflow(db, {
    name: "Heavy penguins",
    content: workflowContent(
      [
        operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
        operator("PythonUDFV2", "udf", { [codeProperty]: "yield tuple_\n" }),
      ],
      [link("scan", "udf")]
    ),
  });
}

/** Someone else who has the workflow open, in a browser of their own. They leave when the test ends. */
async function coEditor(wid: number, name: string) {
  const document = new WorkflowDocument();
  const room = new WorkflowRoom(document, wid, name);
  onTestFinished(() => room.leave());
  room.enter();
  await waitFor(() => expect(room.state().entry).toBe("entered"));
  return { document, room };
}

/** Opens the code of the operator that is selected, and returns its panel and the editor in it. */
async function openCode(user: UserEvent, name: string) {
  await user.click(screen.getByRole("button", { name: "Edit the Python code" }));
  const panel = await screen.findByRole("region", { name: `Code of ${name}` });
  // The panel opens at once, and the code's editor in it once it is loaded.
  return { panel, editor: await within(panel).findByRole("textbox", { name: `Code of ${name}` }) };
}

/** Types at the start of the code. jsdom has no way to type into the editor, so CodeMirror is told directly. */
function typeAtStart(editor: HTMLElement, text: string) {
  EditorView.findFromDOM(editor.closest<HTMLElement>(".cm-editor")!)!.dispatch({ changes: { from: 0, insert: text } });
}

/**
 * What pressing ⌘C or Ctrl+C on the canvas puts on the clipboard. jsdom has no clipboard, and user-event copies only
 * selected text, so the copy event is sent as the browser sends it, with a stand-in for the clipboard's data.
 */
function copyFromCanvas(): string {
  const data = new Map<string, string>();
  const clipboardData = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  fireEvent.copy(document.activeElement!, { clipboardData });
  return data.get("text/plain") ?? "";
}

/** Opens the canvas's menu on an operator, or on the empty canvas, as a right-click does. */
async function openMenu(on?: string) {
  const canvas = screen.getByLabelText("Workflow canvas");
  fireEvent.contextMenu(
    on ? within(canvas).getByRole("group", { name: on }) : canvas.querySelector(".react-flow__pane")!
  );
  return screen.findByRole("menu");
}

describe("the workflow editor", () => {
  it("shows the workflow's operators on the canvas, with the menu of operator types beside it", async () => {
    const { wid } = addPenguinWorkflow();

    await openEditor(wid);

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
    expect(screen.getByRole("searchbox", { name: "Search operators" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/workflows");
  });

  it("shows the properties of the operator that is selected, and saves a change to one", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    const properties = await select(user, "Limit");
    const limit = within(properties).getByLabelText("Limit *");
    expect(limit).toHaveValue(5);
    await user.clear(limit);
    await user.type(limit, "2");

    await waitFor(() => expect(savedOperator(wid, "limit")?.operatorProperties).toEqual({ limit: 2 }), {
      timeout: 4000,
    });
    expect(screen.getByRole("toolbar", { name: "Workflow" })).toHaveTextContent("Saved");
  });

  it("offers the columns of an operator's input where a property names a column", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    const properties = await select(user, "Filter");
    await user.click(await within(properties).findByRole("combobox", { name: "Attribute *" }));

    const options = await screen.findAllByRole("option");
    expect(options.map(option => option.textContent)).toEqual(["species", "mass"]);
  });

  it("renames an operator and switches it off", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    const properties = await select(user, "Limit");
    await user.type(within(properties).getByLabelText("Name"), " to five");
    await user.click(within(properties).getByRole("checkbox", { name: "Leave it out of executions" }));

    expect(operatorsOnCanvas()).toContain("Limit to five");
    await waitFor(
      () => expect(savedOperator(wid, "limit")).toMatchObject({ customDisplayName: "Limit to five", isDisabled: true }),
      {
        timeout: 4000,
      }
    );
  });

  it("adds an operator from the menu, and undoes and redoes it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.type(screen.getByRole("searchbox", { name: "Search operators" }), "dist");
    await user.click(screen.getByRole("button", { name: "Distinct" }));
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Distinct", "Filter", "Limit"]);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);

    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(operatorsOnCanvas()).toContain("Distinct");
  });

  it("says what is wrong with an operator that cannot be executed, and does not execute until it is put right", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("button", { name: "Sort" }));

    const properties = await select(user, "Sort");
    expect(within(properties).getByRole("alert")).toHaveTextContent("Attributes is not set.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled());
  });

  it("executes the workflow: each operator shows its rows, and the kept result is shown in pages", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Execute" }));

    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");
    const canvas = screen.getByLabelText("Workflow canvas");
    expect(within(canvas).getByRole("group", { name: "Filter" })).toHaveTextContent("Completed · 2 rows");
    const rows = await within(execution).findAllByRole("row");
    expect(rows.map(row => row.textContent)).toEqual(["species stringmass integer", "Adelie3750", "Gentoo5000"]);
    expect(execution).toHaveTextContent("2 rows · page 1 of 1");
  });

  it("keeps the results in the warehouse that is chosen, on a deployment that has warehouses", async () => {
    db.warehouses = [
      { whid: 4, name: "default" },
      { whid: 9, name: "archive" },
    ];
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    expect(await screen.findByRole("combobox", { name: "Warehouse" })).toHaveTextContent("default");
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Execute" }));

    // The fake engine, like the real one, fails an execution that names no warehouse of the user's.
    expect(
      await within(await screen.findByRole("region", { name: "Execution" })).findByText("Completed")
    ).toBeInTheDocument();
  });

  it("opens on the errors when an execution fails, naming the operator each is about", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    db.files = {};

    await user.click(screen.getByRole("button", { name: "Execute" }));

    const execution = await screen.findByRole("region", { name: "Execution" });
    expect(await within(execution).findByRole("alert")).toHaveTextContent(
      "CSV File Scan: java.io.FileNotFoundException: penguins.csv"
    );
    expect(within(execution).getByRole("tab", { name: "Errors (1)" })).toHaveAttribute("aria-selected", "true");
  });

  it("pauses, resumes and stops an execution that is under way", async () => {
    db.executionMs = 60_000;
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Execute" }));
    await user.click(await screen.findByRole("button", { name: "Pause" }));
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByRole("button", { name: "Execute" })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "Execution" })).getByRole("status")).toHaveTextContent("Killed");
  });

  it("points to the computing units when there is none to execute on", async () => {
    const { wid } = addPenguinWorkflow({ unit: false });

    await openEditor(wid);

    expect(screen.getByRole("link", { name: "Start a computing unit to execute" })).toHaveAttribute(
      "href",
      "/computing-units"
    );
    expect(screen.queryByRole("button", { name: "Execute" })).not.toBeInTheDocument();
  });

  it("lets someone who may only view the workflow look at it, but change nothing", async () => {
    const { wid } = addPenguinWorkflow({ grants: [{ uid: reader.uid, privilege: "READ" }] });
    const { user } = await openEditor(wid, sessionFor(reader));

    expect(screen.getByRole("toolbar", { name: "Workflow" })).toHaveTextContent("View only");
    expect(screen.queryByRole("searchbox", { name: "Search operators" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    const properties = await select(user, "Limit");
    expect(within(properties).getByLabelText("Limit *")).toBeDisabled();
  });

  it("opens an operator's code in an editor, and saves what is typed there", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    await select(user, "Python UDF");

    const { panel, editor } = await openCode(user, "Python UDF");
    expect(panel).toHaveTextContent("Python");
    expect(editor).toHaveTextContent("yield tuple_");

    typeAtStart(editor, "# mine\n");
    await waitFor(() =>
      expect(savedOperator(wid, "udf")?.operatorProperties[codeProperty]).toBe("# mine\nyield tuple_\n")
    );

    await user.click(within(panel).getByRole("button", { name: "Close the code" }));
    expect(await screen.findByRole("region", { name: "Properties of Python UDF" })).toBeVisible();
    expect(screen.queryByLabelText("Python script *")).not.toBeInTheDocument();
  });

  it("shows what someone else types into the same code as they type it, and that they are there", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await select(user, "Python UDF");
    const { panel, editor } = await openCode(user, "Python UDF");

    grace.room.openCode("udf");
    grace.document.code("udf")!.insert(0, "# by Grace\n");
    typeAtStart(editor, "# mine\n");

    await waitFor(() => expect(editor).toHaveTextContent("# by Grace"));
    expect(editor).toHaveTextContent("# mine");
    await waitFor(() => expect(grace.document.code("udf")!.toJSON()).toContain("# mine"));
    expect(await within(panel).findByRole("list", { name: "Also in this code" })).toHaveTextContent("Grace");
    // Grace is told that this user has the code open too.
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ code: "udf" }]));
  });

  it("shows where the others are: who is editing, what they have selected, and their pointer", async () => {
    const { wid } = addCodeWorkflow();
    await openEditor(wid);
    const grace = await coEditor(wid, "Grace");

    const alsoEditing = await screen.findByRole("list", { name: "Also editing" });
    expect(within(alsoEditing).getByRole("button", { name: "Follow Grace" })).toHaveAttribute("aria-pressed", "false");

    grace.room.select(["udf"]);
    grace.room.point({ x: 40, y: 20 });
    const canvas = screen.getByLabelText("Workflow canvas");
    expect(await within(canvas).findByRole("img", { name: "Pointer of Grace" })).toBeInTheDocument();
    expect(await within(canvas).findByRole("list", { name: "Selected by" })).toHaveTextContent("Grace");

    grace.room.leave();
    await waitFor(() => expect(screen.queryByRole("list", { name: "Also editing" })).not.toBeInTheDocument());
    expect(within(canvas).queryByRole("img", { name: "Pointer of Grace" })).not.toBeInTheDocument();
  });

  it("follows someone: selects what they select, opens and closes their code with them, until the user goes their own way", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    const follow = await screen.findByRole("button", { name: "Follow Grace" });

    await user.click(follow);
    expect(follow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("list", { name: "Also editing" })).toHaveTextContent("Following Grace");

    grace.room.select(["udf"]);
    expect(await screen.findByRole("region", { name: "Properties of Python UDF" })).toBeVisible();
    grace.room.openCode("udf");
    expect(await screen.findByRole("region", { name: "Code of Python UDF" })).toBeVisible();
    grace.room.openCode(undefined);
    expect(await screen.findByRole("region", { name: "Properties of Python UDF" })).toBeVisible();
    grace.room.select(["scan"]);
    expect(await screen.findByRole("region", { name: "Properties of CSV File Scan" })).toBeVisible();
    expect(follow).toHaveAttribute("aria-pressed", "true");

    // Selecting something else is going one's own way: what Grace does next changes nothing here.
    await select(user, "Python UDF");
    expect(follow).toHaveAttribute("aria-pressed", "false");
    grace.room.select(["scan"]);
    grace.room.openCode("scan");
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["udf"] }]));
    expect(screen.getByRole("region", { name: "Properties of Python UDF" })).toBeVisible();
  });

  it("selects an operator that is added from the menu, and does not go back to it when following someone ends", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");

    await user.click(screen.getByRole("button", { name: "Limit" }));
    expect(await screen.findByRole("region", { name: "Properties of Limit" })).toBeVisible();

    await user.click(await screen.findByRole("button", { name: "Follow Grace" }));
    grace.room.select(["scan"]);
    expect(await screen.findByRole("region", { name: "Properties of CSV File Scan" })).toBeVisible();

    // Going one's own way shows what was selected for it, not the operator that was added before.
    await select(user, "Python UDF");
    expect(screen.getByRole("button", { name: "Follow Grace" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["udf"] }]));
    expect(screen.getByRole("region", { name: "Properties of Python UDF" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Properties of Limit" })).not.toBeInTheDocument();
  });

  // Coming back takes the time the connection waits before it tries again: a second, and more on a busy machine.
  it("opens the workflow again as it is saved when its room was filled anew while the user was offline, and says so", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const toolbar = screen.getByRole("toolbar", { name: "Workflow" });

    cutSharedEditing();
    await waitFor(() => expect(toolbar).toHaveTextContent("Offline"));
    const properties = await select(user, "Limit");
    await user.type(within(properties).getByLabelText("Name"), ", renamed offline");
    expect(operatorsOnCanvas()).toContain("Limit, renamed offline");

    const notice = await screen.findByRole("alert", {}, { timeout: 10_000 });
    expect(notice).toHaveTextContent("What you changed while offline is not in it.");
    await waitFor(() => expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]));
    expect(savedOperator(wid, "limit")?.customDisplayName).toBe("Limit");

    await user.click(within(notice).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }, 20_000);

  it("shows the server's message for a workflow the user may not see, and finds no page for an id that is not a number", async () => {
    const { wid } = addWorkflow(db, { name: "Private", ownerUid: reader.uid });

    renderApp(`/workflows/${wid}`, { session: sessionFor(admin) });
    expect(await screen.findByRole("alert")).toHaveTextContent("No sufficient access privilege.");
  });
});

describe("the editor's panels", () => {
  /** The views of the workspace panel's rail, from top to bottom. */
  const railOrder = () =>
    within(screen.getByRole("tablist", { name: "Workspace" }))
      .getAllByRole("tab")
      .map(tab => tab.getAttribute("aria-label"));

  it("keeps the workspace in a panel with a rail of its views, which stays when the panel is minimized", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const rail = screen.getByRole("tablist", { name: "Workspace" });
    expect(
      within(rail)
        .getAllByRole("tab")
        .map(tab => tab.getAttribute("aria-label"))
    ).toEqual(["Operators", "Versions", "Executions", "Settings"]);
    const workspace = screen.getByRole("region", { name: "Operators" });
    expect(within(workspace).getByRole("searchbox", { name: "Search operators" })).toBeVisible();

    await user.click(within(workspace).getByRole("button", { name: "Minimize Operators" }));
    expect(screen.queryByRole("searchbox", { name: "Search operators" })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole("tablist", { name: "Workspace" })).getByRole("tab", { name: "Versions" }));
    expect(await screen.findByRole("region", { name: "Versions" })).toBeVisible();
  });

  it("puts the rail's views in the order the user moves them to with the keyboard, and keeps it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user, unmount } = await openEditor(wid);
    const settings = () => screen.getByRole("tab", { name: "Settings" });
    const moveUp = async () => {
      settings().focus();
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    };

    await moveUp();
    expect(railOrder()).toEqual(["Operators", "Versions", "Settings", "Executions"]);
    expect(screen.getByText("Settings is now 3 of 4 in the rail.")).toBeInTheDocument();
    await waitFor(() => expect(settings()).toHaveFocus());
    await moveUp();
    await moveUp();
    expect(railOrder()).toEqual(["Settings", "Operators", "Versions", "Executions"]);
    // The first view goes no higher.
    await moveUp();
    expect(railOrder()).toEqual(["Settings", "Operators", "Versions", "Executions"]);

    unmount();
    await openEditor(wid);
    expect(railOrder()).toEqual(["Settings", "Operators", "Versions", "Executions"]);
  });

  it("keeps the place of a view that someone does not see when they move the others", async () => {
    const { wid } = addPenguinWorkflow({ grants: [{ uid: reader.uid, privilege: "READ" }] });
    const { user, unmount } = await openEditor(wid, sessionFor(reader));
    expect(railOrder()).toEqual(["Versions", "Executions", "Settings"]);

    screen.getByRole("tab", { name: "Settings" }).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(railOrder()).toEqual(["Versions", "Settings", "Executions"]);

    // In the same browser, someone who may add operators has them where they were.
    unmount();
    await openEditor(wid);
    expect(railOrder()).toEqual(["Operators", "Versions", "Settings", "Executions"]);
  });

  it("minimizes the properties to a button, which then shows the properties of what is selected", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await select(user, "Limit");

    await user.click(screen.getByRole("button", { name: "Minimize Properties" }));
    expect(screen.queryByRole("region", { name: "Properties of Limit" })).not.toBeInTheDocument();
    within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name: "Filter" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("region", { name: "Properties of Filter" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Properties" }));
    expect(await screen.findByRole("region", { name: "Properties of Filter" })).toBeVisible();
  });

  it("minimizes what an execution did, and shows it again when another execution starts", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const execute = () => screen.getByRole("button", { name: "Execute" });
    await waitFor(() => expect(execute()).toBeEnabled());
    await user.click(execute());
    await within(await screen.findByRole("region", { name: "Execution" })).findByText("Completed");

    await user.click(screen.getByRole("button", { name: "Minimize Execution" }));
    expect(screen.queryByRole("region", { name: "Execution" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execution Completed" })).toBeVisible();

    await waitFor(() => expect(execute()).toBeEnabled());
    await user.click(execute());
    expect(await screen.findByRole("region", { name: "Execution" })).toBeVisible();
  });
});

describe("the canvas's menu, the clipboard and comments", () => {
  it("duplicates an operator from the menu on it, beside it and with its properties", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.click(within(await openMenu("Limit")).getByRole("menuitem", { name: /Duplicate/ }));

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit", "Limit"]);
    await waitFor(() => expect(savedContent(wid).operators).toHaveLength(4));
    const copy = savedContent(wid).operators.find(
      each => each.operatorType === "Limit" && each.operatorID !== "limit"
    )!;
    expect(copy.operatorProperties).toEqual({ limit: 5 });
    expect(savedContent(wid).operatorPositions[copy.operatorID]).toEqual({ x: 640, y: 40 });
  });

  it("copies the selected operators with the keyboard and pastes them with their link, under new ids", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await select(user, "Filter");
    await user.keyboard("{Control>}");
    within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name: "Limit" }).focus();
    await user.keyboard("{Enter}{/Control}");

    await user.paste(copyFromCanvas());

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Filter", "Limit", "Limit"]);
    await waitFor(() => expect(savedContent(wid).links).toHaveLength(3));
    const ids = savedContent(wid).operators.map(each => each.operatorID);
    expect(new Set(ids).size).toBe(5);
  });

  it("takes nothing from the clipboard that is not a piece of a workflow", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await select(user, "Limit");

    await user.paste("select * from penguins");

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
  });

  it("leaves an operator out of executions, and keeps its result, from the menu on it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.click(
      within(await openMenu("Filter")).getByRole("menuitemcheckbox", { name: "Leave out of executions" })
    );
    await user.click(within(await openMenu("Filter")).getByRole("menuitemcheckbox", { name: "Keep its result" }));

    await waitFor(() => expect(savedOperator(wid, "filter")).toMatchObject({ isDisabled: true, viewResult: true }));
    const menu = await openMenu("Filter");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Leave out of executions" })).toBeChecked();
  });

  it("executes the workflow up to an operator from the menu on it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());

    await user.click(within(await openMenu("Filter")).getByRole("menuitem", { name: "Execute to here" }));

    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");
    const canvas = screen.getByLabelText("Workflow canvas");
    expect(within(canvas).getByRole("group", { name: "Filter" })).toHaveTextContent("Completed · 2 rows");
    // The operator after it was not executed.
    expect(within(canvas).getByRole("group", { name: "Limit" })).toHaveTextContent("Limit");
  });

  it("starts a comment where the empty canvas is right-clicked, and takes replies to it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.click(within(await openMenu()).getByRole("menuitem", { name: "Comment here" }));
    const thread = await screen.findByRole("region", { name: "Comments" });
    expect(within(thread).getByRole("heading", { name: "New comment" })).toBeInTheDocument();
    await user.type(within(thread).getByRole("textbox", { name: "Write a comment" }), "Check the units");
    await user.click(within(thread).getByRole("button", { name: "Comment" }));

    const canvas = screen.getByLabelText("Workflow canvas");
    expect(within(canvas).getByRole("group", { name: "Comment by texera" })).toHaveTextContent("Check the units");
    // The comment is a box on the canvas now, which is selected, and its thread is the box's.
    const replies = await screen.findByRole("region", { name: "Comments" });
    expect(within(replies).getByRole("heading", { name: "Comments" })).toBeInTheDocument();
    await user.type(
      within(replies).getByRole("textbox", { name: "Write a comment" }),
      "They are grams{Control>}{Enter}{/Control}"
    );
    expect(within(canvas).getByRole("group", { name: "Comment by texera" })).toHaveTextContent("1 reply");
    await waitFor(() =>
      expect(savedContent(wid).commentBoxes[0].comments.map(comment => comment.content)).toEqual([
        "Check the units",
        "They are grams",
      ])
    );
  });

  it("lets the author change and delete their own comment, and no one else's", async () => {
    const box: CommentBox = {
      commentBoxID: "commentBox-1",
      commentBoxPosition: { x: 0, y: 200 },
      comments: [
        {
          content: "Is mass in grams?",
          creationTime: "2026-11-18T09:00:00.000Z",
          creatorName: "Reader",
          creatorID: reader.uid,
        },
        { content: "Yes", creationTime: "2026-11-18T09:05:00.000Z", creatorName: admin.name, creatorID: admin.uid },
      ],
    };
    const workflow = addPenguinWorkflow();
    workflow.content = JSON.stringify({ ...savedContent(workflow.wid), commentBoxes: [box] });
    const { user } = await openEditor(workflow.wid);

    within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name: "Comment by Reader" }).focus();
    await user.keyboard("{Enter}");
    const thread = await screen.findByRole("region", { name: "Comments" });
    expect(within(thread).getAllByRole("button", { name: "Edit your comment" })).toHaveLength(1);

    await user.click(within(thread).getByRole("button", { name: "Edit your comment" }));
    const text = within(thread).getByRole("textbox", { name: "Your comment" });
    await user.clear(text);
    await user.type(text, "Yes, grams");
    await user.click(within(thread).getByRole("button", { name: "Save" }));
    expect(thread).toHaveTextContent("Yes, grams");

    await user.click(within(thread).getByRole("button", { name: "Delete your comment" }));
    await waitFor(() =>
      expect(savedContent(workflow.wid).commentBoxes[0].comments.map(comment => comment.content)).toEqual([
        "Is mass in grams?",
      ])
    );
  });
});

describe("the workflow's history", () => {
  const minute = 60_000;
  const start = Date.UTC(2026, 10, 18, 9, 0);
  const scan = operator("CSVFileScan", "scan", { fileName: "penguins.csv" });
  const filter = operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] });
  const limit = operator("Limit", "limit", { limit: 5 });
  /** Four saves: the scan, then a Filter after it, then a Limit, then the Filter's condition changed. */
  const saves: [number, WorkflowContent][] = [
    [start, workflowContent([scan])],
    [start + 2 * minute, workflowContent([scan, filter], [link("scan", "filter")])],
    [start + 60 * minute, workflowContent([scan, filter, limit], [link("scan", "filter"), link("filter", "limit")])],
    [
      start + 61 * minute,
      workflowContent(
        [
          scan,
          { ...filter, operatorProperties: { predicates: [{ attribute: "mass", condition: ">", value: "4000" }] } },
          limit,
        ],
        [link("scan", "filter"), link("filter", "limit")]
      ),
    ],
  ];
  const addHistoryWorkflow = (grants: { uid: number; privilege: "READ" | "WRITE" }[] = []) => {
    db.files["penguins.csv"] = penguins;
    addComputingUnit(db, { name: "Small unit" });
    return addWorkflow(db, { name: "Heavy penguins", saves, grants });
  };
  const marksOnCanvas = (): Record<string, string> =>
    Object.fromEntries(
      within(screen.getByLabelText("Workflow canvas"))
        .getAllByRole("group")
        .filter(group => group.getAttribute("aria-roledescription") === "node")
        .map((node): [string, string] => [
          node.getAttribute("aria-label") ?? "",
          node.textContent?.match(/Added|Removed|Changed/)?.[0] ?? "-",
        ])
    );

  it("lists the versions in sessions of work, newest first, each saying what it changed", async () => {
    const { wid } = addHistoryWorkflow();
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("tab", { name: "Versions" }));

    const versions = await screen.findByRole("list", { name: "Versions" });
    const sessions = within(versions).getAllByRole("group");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toHaveTextContent("Added Limit · Changed Filter");
    expect(
      within(versions)
        .getAllByRole("button")
        .map(button => button.textContent)
    ).toEqual([
      expect.stringContaining("Changed Filter"),
      expect.stringContaining("Added Limit"),
      expect.stringContaining("Added Filter"),
      expect.stringContaining("Created the workflow · Added CSV File Scan"),
    ]);
  });

  it("shows a version in place of the workflow, with what it changed marked, and steps to the one before", async () => {
    const { wid } = addHistoryWorkflow();
    const { user, router } = await openEditor(wid);
    await user.click(screen.getByRole("tab", { name: "Versions" }));

    await user.click(await screen.findByRole("button", { name: /10:00:00/ }));

    expect(router.state.location.search).toEqual({ version: 3 });
    const bar = screen.getByRole("toolbar", { name: "Version" });
    expect(bar).toHaveTextContent("The version of Nov 18, 2026, 10:00 AM");
    expect(marksOnCanvas()).toEqual({ "CSV File Scan": "-", Filter: "-", Limit: "Added" });
    expect(
      within(screen.getByRole("region", { name: "What changed" })).getByRole("region", { name: "Added" })
    ).toHaveTextContent("Limit");
    // Nothing on the canvas can be changed, and nothing is added to the workflow.
    expect(screen.queryByRole("searchbox", { name: "Search operators" })).not.toBeInTheDocument();

    await user.click(within(bar).getByRole("button", { name: "The version before" }));
    expect(router.state.location.search).toEqual({ version: 2 });
    expect(marksOnCanvas()).toEqual({ "CSV File Scan": "-", Filter: "Added" });

    await user.click(within(bar).getByRole("button", { name: "Back to the workflow" }));
    expect(router.state.location.search).toEqual({});
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
  });

  it("says how a property changed, and compares a version with the workflow as it is now", async () => {
    const { wid } = addHistoryWorkflow();
    const { user } = await openEditor(wid);
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /10:01:00/ }));

    const changes = screen.getByRole("region", { name: "What changed" });
    expect(within(changes).getByRole("region", { name: "Changed" })).toHaveTextContent(/Predicates.*3600.*→.*4000/);

    await user.click(
      within(screen.getByRole("toolbar", { name: "Version" })).getByRole("button", { name: "The version before" })
    );
    await user.click(
      within(screen.getByRole("toolbar", { name: "Version" })).getByRole("combobox", { name: "Compared with" })
    );
    await user.click(screen.getByRole("option", { name: "Changes from the workflow now" }));
    expect(marksOnCanvas()).toEqual({ "CSV File Scan": "-", Filter: "Changed", Limit: "-" });
  });

  it("restores a version for everyone in the room, as one step that its user can undo", async () => {
    const { wid } = addHistoryWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /9:02:00/ }));

    await user.click(within(screen.getByRole("toolbar", { name: "Version" })).getByRole("button", { name: "Restore" }));

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter"]);
    const notice = screen
      .getByText(/The version of Nov 18, 2026, 9:02.AM is restored/)
      .closest<HTMLElement>("[role=status]")!;
    await waitFor(() =>
      expect(grace.document.content().operators.map(each => each.operatorID)).toEqual(["filter", "scan"])
    );
    await waitFor(() => expect(savedContent(wid).operators).toHaveLength(2));

    await user.click(within(notice).getByRole("button", { name: "Undo" }));
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
    await waitFor(() =>
      expect(savedOperator(wid, "filter")?.operatorProperties).toEqual(saves[3][1].operators[1].operatorProperties)
    );
  });

  it("copies a version into a new workflow of the user's, and opens it", async () => {
    const { wid } = addHistoryWorkflow();
    const { user, router } = await openEditor(wid);

    await router.navigate({ to: "/workflows/$workflowId", params: { workflowId: wid }, search: { version: 2 } });
    await user.click(await screen.findByRole("button", { name: "Make a copy" }));

    await waitFor(() => expect(router.state.location.pathname).not.toBe(`/workflows/${wid}`));
    const copy = db.workflows.at(-1)!;
    expect(copy.name.replace(/\s/g, " ")).toBe("Heavy penguins (Nov 18, 2026, 9:02 AM)");
    expect(JSON.parse(copy.content)).toEqual(saves[1][1]);
  });

  it("opens the version that the address names, and lets someone who may only view look but not restore", async () => {
    const { wid } = addHistoryWorkflow([{ uid: reader.uid, privilege: "READ" }]);

    renderApp(`/workflows/${wid}?version=1`, { session: sessionFor(reader) });

    const bar = await screen.findByRole("toolbar", { name: "Version" }, { timeout: 5000 });
    expect(bar).toHaveTextContent("The version of Nov 18, 2026, 9:00 AM");
    expect(within(bar).queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Make a copy" })).toBeEnabled();
  });
});

describe("the workflow's executions", () => {
  const at = (minute: number, second = 0) => Date.UTC(2026, 10, 18, 10, minute, second);

  async function openExecutions(user: UserEvent) {
    await user.click(screen.getByRole("tab", { name: "Executions" }));
    return screen.findByRole("list", { name: "Executions" });
  }

  it("lists the executions, newest first, with who started each, when, and how it ended", async () => {
    const { wid } = addPenguinWorkflow();
    addExecutionRecord(db, { wid, name: "First try", status: 4, startingTime: at(0), lastUpdateTime: at(0, 3) });
    addExecutionRecord(db, { wid, name: "Second try", status: 3, startingTime: at(5), lastUpdateTime: at(5, 40) });
    const { user } = await openEditor(wid);

    const executions = await openExecutions(user);

    const items = within(executions).getAllByRole("listitem");
    expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["Second try", "First try"]);
    expect(items[0]).toHaveTextContent(/Completed · by texera · Nov 18, 2026, 10:05.AM · took 40 s/);
    expect(items[1]).toHaveTextContent("Failed");

    await user.click(screen.getByRole("button", { name: "Failed" }));
    expect(within(screen.getByRole("list", { name: "Executions" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps a record of an execution once it is executed", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Execute" }));
    await within(await screen.findByRole("region", { name: "Execution" })).findByText("Completed");

    const executions = await openExecutions(user);

    await waitFor(() => expect(within(executions).getByRole("listitem")).toHaveTextContent("Completed · by texera"));
  });

  it("renames, bookmarks and deletes an execution", async () => {
    const { wid } = addPenguinWorkflow();
    const { eid } = addExecutionRecord(db, { wid, name: "First try" });
    const { user } = await openEditor(wid);
    const executions = await openExecutions(user);
    const item = within(executions).getByRole("listitem", { name: "First try" });

    await user.click(within(item).getByRole("button", { name: "Rename" }));
    const name = within(item).getByRole("textbox", { name: "Name of the execution" });
    await user.clear(name);
    await user.type(name, "Heavy ones{Enter}");
    await waitFor(() => expect(db.executionRecords[0].name).toBe("Heavy ones"));

    const renamed = await within(executions).findByRole("listitem", { name: "Heavy ones" });
    await user.click(within(renamed).getByRole("button", { name: "Bookmark" }));
    await waitFor(() => expect(db.executionRecords[0].bookmarked).toBe(true));
    await waitFor(() =>
      expect(within(renamed).getByRole("button", { name: "Bookmark" })).toHaveAttribute("aria-pressed", "true")
    );

    await user.click(within(renamed).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(db.executionRecords.find(record => record.eid === eid)).toBeUndefined());
    expect(await screen.findByText("Not executed yet")).toBeInTheDocument();
  });

  it("opens the version an execution executed, and shows what each operator did", async () => {
    const workflow = addPenguinWorkflow();
    addExecutionRecord(db, {
      wid: workflow.wid,
      vid: 1,
      statistics: [
        {
          operatorId: "filter",
          timestamp: at(0, 1),
          inputTupleCount: 3,
          outputTupleCount: 1,
          dataProcessingTime: 1e9,
          controlProcessingTime: 0,
          idleTime: 0,
          numWorkers: 1,
          status: 1,
        },
        {
          operatorId: "filter",
          timestamp: at(0, 2),
          inputTupleCount: 3,
          outputTupleCount: 2,
          dataProcessingTime: 2e9,
          controlProcessingTime: 0,
          idleTime: 0,
          numWorkers: 1,
          status: 3,
        },
      ],
    });
    const { user, router } = await openEditor(workflow.wid);
    const executions = await openExecutions(user);

    await user.click(within(executions).getByRole("button", { name: "Statistics" }));
    const statistics = await within(executions).findByRole("table", { name: "Statistics" });
    expect(
      within(statistics)
        .getAllByRole("row")
        .map(row => row.textContent)
    ).toEqual(["OperatorRows outTimeRows as they came", "Filter22 s"]);

    await user.click(within(executions).getByRole("button", { name: "Open its version" }));
    expect(router.state.location.search).toEqual({ version: 1 });
    expect(await screen.findByRole("toolbar", { name: "Version" })).toBeInTheDocument();
  });

  it("lets someone who may only view the workflow see its executions, and change none of them", async () => {
    const { wid } = addPenguinWorkflow({ grants: [{ uid: reader.uid, privilege: "READ" }] });
    addExecutionRecord(db, { wid, name: "First try" });
    const { user } = await openEditor(wid, sessionFor(reader));

    const executions = await openExecutions(user);

    expect(within(executions).getByRole("listitem", { name: "First try" })).toBeInTheDocument();
    expect(within(executions).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(executions).queryByRole("button", { name: "Bookmark" })).not.toBeInTheDocument();
  });

  it("says so when the address names a version that the workflow does not have", async () => {
    const { wid } = addPenguinWorkflow();

    renderApp(`/workflows/${wid}?version=99`, { session: sessionFor(admin) });

    expect(
      await screen.findByText("This workflow has no version 99 to show.", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
  });
});

describe("the workflow's settings and its own menu", () => {
  it("changes how the workflow is executed, as one change that is saved", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const form = screen.getByRole("form", { name: "Settings" });
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(form).getByRole("combobox", { name: "Execution mode" }));
    await user.click(screen.getByRole("option", { name: "Materialized" }));
    const size = within(form).getByRole("spinbutton", { name: "Batch size" });
    await user.clear(size);
    await user.type(size, "0");
    expect(within(form).getByText("The batch size is a whole number of at least 1.")).toBeVisible();
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(size);
    await user.type(size, "1000");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(savedContent(wid).settings).toEqual({ dataTransferBatchSize: 1000, executionMode: "MATERIALIZED" })
    );
  });

  it("shows the workflow as Python, as the compiling service writes it", async () => {
    const { wid } = addPenguinWorkflow();
    server.use(
      http.post("/api/workflow-to-python", () =>
        HttpResponse.json({ type: "success", pythonCode: "import pandas as pd\n# [CSV File Scan]\n" })
      )
    );
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Show as Python" }));

    const code = await screen.findByRole("textbox", { name: "Heavy penguins as Python" }, { timeout: 5000 });
    expect(code).toHaveTextContent("import pandas as pd");
  });

  it("says why the workflow could not be written as Python", async () => {
    const { wid } = addPenguinWorkflow();
    server.use(
      http.post("/api/workflow-to-python", () => HttpResponse.json({ type: "failure", errorMessage: "No sink." }))
    );
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Show as Python" }));

    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("No sink.");
  });
});

describe("a UDF's parameters", () => {
  const code = (open: string) => `from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def open(self) -> None:
        ${open}

    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        yield tuple_
`;
  const declared = 'self.count = self.UiParameter("count", AttributeType.INT).value';
  const addUdfWorkflow = (open: string, grants: { uid: number; privilege: "READ" | "WRITE" }[] = []) => {
    addComputingUnit(db, { name: "Small unit" });
    return addWorkflow(db, {
      name: "Heavy penguins",
      grants,
      content: workflowContent([operator("PythonUDFV2", "udf", { [codeProperty]: code(open) })]),
    });
  };
  const parametersOf = (wid: number) => savedOperator(wid, "udf")?.operatorProperties.uiParameters;

  it("lists the parameters the code declares, and keeps the value given to each", async () => {
    const { wid } = addUdfWorkflow(
      `${declared}\n        self.on = self.UiParameter("on", AttributeType.BOOLEAN).value`
    );
    const { user } = await openEditor(wid);

    const properties = await select(user, "Python UDF");
    const parameters = within(properties).getByRole("region", { name: "Parameters" });
    await user.type(within(parameters).getByRole("spinbutton", { name: "count integer" }), "10");
    await user.click(within(parameters).getByRole("checkbox", { name: "on boolean" }));

    await waitFor(() =>
      expect(parametersOf(wid)).toEqual([
        { attribute: { attributeName: "count", attributeType: "integer" }, value: "10" },
        { attribute: { attributeName: "on", attributeType: "boolean" }, value: "true" },
      ])
    );
  });

  it("keeps the parameters in step with the code as it is typed, with the values they had", async () => {
    const { wid } = addUdfWorkflow(declared);
    const { user } = await openEditor(wid);
    const properties = await select(user, "Python UDF");
    await user.type(within(properties).getByRole("spinbutton", { name: "count integer" }), "7");
    const { editor } = await openCode(user, "Python UDF");

    const view = EditorView.findFromDOM(editor.closest<HTMLElement>(".cm-editor")!)!;
    const at = view.state.doc.toString().indexOf(declared) + declared.length;
    view.dispatch({
      changes: { from: at, insert: '\n        self.name = self.UiParameter("name", AttributeType.STRING).value' },
    });

    await waitFor(() =>
      expect(parametersOf(wid)).toEqual([
        { attribute: { attributeName: "count", attributeType: "integer" }, value: "7" },
        { attribute: { attributeName: "name", attributeType: "string" }, value: "" },
      ])
    );
  });

  it("declares a new parameter in the code from the properties", async () => {
    const { wid } = addUdfWorkflow("pass");
    const { user } = await openEditor(wid);
    const properties = await select(user, "Python UDF");

    await user.click(within(properties).getByRole("button", { name: "Add a parameter" }));
    const form = within(properties).getByRole("form", { name: "New parameter" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "rate");
    await user.click(within(form).getByRole("combobox", { name: "Type" }));
    await user.click(screen.getByRole("option", { name: "double" }));
    await user.click(within(form).getByRole("button", { name: "Declare it in the code" }));

    expect(await within(properties).findByRole("spinbutton", { name: "rate double" })).toBeInTheDocument();
    await waitFor(() =>
      expect(savedOperator(wid, "udf")?.operatorProperties[codeProperty]).toContain(
        'self.rate = self.UiParameter(name="rate", type=AttributeType.DOUBLE).value'
      )
    );
  });

  it("says what is wrong when the code declares a name twice, and keeps the parameters it had", async () => {
    const { wid } = addUdfWorkflow(
      `${declared}\n        self.again = self.UiParameter("count", AttributeType.LONG).value`
    );
    const { user } = await openEditor(wid);

    const properties = await select(user, "Python UDF");

    expect(within(properties).getByRole("region", { name: "Parameters" })).toHaveTextContent(
      "The parameter count is declared more than once."
    );
  });

  it("shows someone who may only view the workflow the values, and changes none of them", async () => {
    const workflow = addUdfWorkflow(declared, [{ uid: reader.uid, privilege: "READ" }]);
    const content = savedContent(workflow.wid);
    content.operators[0].operatorProperties.uiParameters = [
      { attribute: { attributeName: "count", attributeType: "integer" }, value: "3" },
    ];
    workflow.content = JSON.stringify(content);
    const { user } = await openEditor(workflow.wid, sessionFor(reader));

    const properties = await select(user, "Python UDF");

    const count = within(properties).getByRole("spinbutton", { name: "count integer" });
    expect(count).toHaveValue(3);
    expect(count).toBeDisabled();
    expect(within(properties).queryByRole("button", { name: "Add a parameter" })).not.toBeInTheDocument();
  });
});
