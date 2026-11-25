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
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readPiece } from "@/lib/workflow/clipboard";
import { codeProperty } from "@/lib/workflow/code";
import { WorkflowDocument } from "@/lib/workflow/document";
import { holderOf } from "@/lib/workflow/holds";
import { layout } from "@/lib/workflow/layout";
import type { CommentBox, WorkflowContent } from "@/lib/workflow/model";
import { WorkflowRoom } from "@/lib/workflow/room";
import { dragOnCanvas } from "@/testing/canvas";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addDataset } from "@/testing/mock-api/dataset";
import { addComputingUnit, addExecutionRecord } from "@/testing/mock-api/execution";
import { cutSharedEditing } from "@/testing/mock-api/shared-editing";
import { addWorkflow } from "@/testing/mock-api/workflow";
import { renderApp } from "@/testing/render";
import { server } from "@/testing/server";
import { sessionFor, signInAs } from "@/testing/session";
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

/** An operator's card on the canvas, by the name it goes by. */
const cardOf = (name: string) => within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name });

/** The properties of an operator in its open card, by the name it goes by, while its card is open. */
const propertiesOf = (name: string) => screen.queryByRole("region", { name: `Properties of ${name}` });

/**
 * Opens an operator's card on the canvas with the keyboard, as someone who cannot use a mouse does: Enter selects the
 * operator and opens it.
 */
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

/** What a co-editor is told this user is editing in a card: the first person they see is this user. */
const toldBy = (coEditor: { room: WorkflowRoom }) => coEditor.room.state().collaborators[0]?.editing;

/** Opens the code of the operator whose card is open, and returns its panel and the editor in it. */
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
 * What pressing ⌘C or Ctrl+C on the canvas puts on the clipboard, or ⌘X or Ctrl+X with `cut`. jsdom has no
 * clipboard, and user-event copies only selected text, so the event is sent as the browser sends it, with a stand-in
 * for the clipboard's data.
 */
function copyFromCanvas(event: "copy" | "cut" = "copy"): string {
  const data = new Map<string, string>();
  const clipboardData = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  fireEvent[event](document.activeElement!, { clipboardData });
  return data.get("text/plain") ?? "";
}

/** Drags an operator's card to the right on the screen: a little first, which starts the drag, then by `by`. */
function dragRight(name: string, by: number) {
  const at = (clientX: number) => ({ clientX, clientY: 10 });
  dragOnCanvas(cardOf(name), [at(10), at(20), at(20 + by)]);
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

  it("opens an operator's card with its properties, and saves a change made in it", async () => {
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

  it("renames an operator in its card, and switches it off from the menu on it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    const properties = await select(user, "Limit");
    await user.type(within(properties).getByLabelText("Name"), " to five");
    await user.click(
      within(await openMenu("Limit to five")).getByRole("menuitemcheckbox", { name: "Leave out of executions" })
    );

    expect(operatorsOnCanvas()).toContain("Limit to five");
    await waitFor(
      () => expect(savedOperator(wid, "limit")).toMatchObject({ customDisplayName: "Limit to five", isDisabled: true }),
      {
        timeout: 4000,
      }
    );
    // Its card no longer offers what the menu does.
    expect(within(properties).queryByRole("checkbox", { name: /result|executions/ })).not.toBeInTheDocument();
  });

  it("names an operator after its type once its name is cleared, and saves it with no name", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const properties = await select(user, "Filter");

    await user.clear(within(properties).getByLabelText("Name"));

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
    expect(properties).toHaveAccessibleName("Properties of Filter");
    expect(within(properties).getByLabelText("Name")).toHaveValue("");
    await waitFor(() => expect(savedOperator(wid, "filter")).not.toHaveProperty("customDisplayName"), {
      timeout: 4000,
    });
    expect(savedOperator(wid, "filter")?.operatorType).toBe("Filter");
  });

  it("adds an operator from the menu one column to the right of the rightmost, and undoes and redoes it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.type(screen.getByRole("searchbox", { name: "Search operators" }), "dist");
    await user.click(screen.getByRole("button", { name: "Distinct" }));
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Distinct", "Filter", "Limit"]);
    // The Limit stands rightmost, at 600: a card and the room for the links between two columns further on.
    await waitFor(() => {
      const added = savedContent(wid).operators.find(each => each.operatorType === "Distinct");
      expect(added && savedContent(wid).operatorPositions[added.operatorID]).toEqual({ x: 920, y: 0 });
    });

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);

    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(operatorsOnCanvas()).toContain("Distinct");
    // Its card went with it, and comes back closed, taking the keyboard from nothing this user does.
    expect(screen.queryByRole("region", { name: "Properties of Distinct" })).not.toBeInTheDocument();
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
    const filter = within(screen.getByLabelText("Workflow canvas")).getByRole("group", { name: "Filter" });
    expect(within(filter).getByText("Completed")).toBeInTheDocument();
    expect(within(filter).getByText("3 → 2 rows")).toBeInTheDocument();
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

  it("executes nothing on a deployment with warehouses where the user has none, as the service would refuse it", async () => {
    db.warehouses = [];
    const { wid } = addPenguinWorkflow();
    await openEditor(wid);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Execute" })).toHaveAttribute(
        "title",
        "This deployment keeps each execution's results in a warehouse: create one first."
      )
    );
    expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
    const upTo = within(cardOf("Filter")).getByRole("button", { name: "Execute up to Filter" });
    expect(upTo).toHaveAttribute("aria-disabled", "true");
    expect(upTo).toHaveAccessibleDescription(
      "This deployment keeps each execution's results in a warehouse: create one first."
    );
    const item = within(await openMenu("Filter")).getByRole("menuitem", { name: "Execute up to here" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    // A menu shows no title: why is said under the item, which stays where the keyboard goes to be told it.
    expect(item).toHaveAccessibleDescription(
      "This deployment keeps each execution's results in a warehouse: create one first."
    );
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
    expect(within(properties).getByLabelText("Name")).toBeDisabled();
    expect(within(cardOf("Filter")).getByRole("button", { name: "Keep the result of Filter" })).toBeDisabled();
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
    // This user selects what Grace selects, as Grace is told, and opens no card of theirs.
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["udf"] }]));
    grace.room.openCode("udf");
    expect(await screen.findByRole("region", { name: "Code of Python UDF" })).toBeVisible();
    grace.room.openCode(undefined);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Code of Python UDF" })).not.toBeInTheDocument());
    grace.room.select(["scan"]);
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["scan"] }]));
    expect(follow).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: /^Properties of/ })).not.toBeInTheDocument();

    // Opening a card of one's own is going one's own way: what Grace does next changes nothing here.
    await select(user, "Python UDF");
    expect(follow).toHaveAttribute("aria-pressed", "false");
    grace.room.select(["scan"]);
    grace.room.openCode("scan");
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["udf"] }]));
    expect(screen.getByRole("region", { name: "Properties of Python UDF" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Code of CSV File Scan" })).not.toBeInTheDocument();
  });

  it("opens the card of an operator that is added from the menu, its first field ready to type in", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("button", { name: "Limit" }));

    const properties = await screen.findByRole("region", { name: "Properties of Limit" });
    await waitFor(() => expect(within(properties).getByLabelText("Limit *")).toHaveFocus());
    await user.keyboard("7");
    expect(within(properties).getByLabelText("Limit *")).toHaveValue(7);
  });

  it("does not go back to an operator that was added once following someone ends, nor open their card", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");

    await user.click(screen.getByRole("button", { name: "Limit" }));
    expect(await screen.findByRole("region", { name: "Properties of Limit" })).toBeVisible();

    // Following someone leaves this user's own card: the canvas is theirs to show.
    await user.click(await screen.findByRole("button", { name: "Follow Grace" }));
    expect(screen.queryByRole("region", { name: "Properties of Limit" })).not.toBeInTheDocument();
    grace.room.select(["scan"]);
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["scan"] }]));

    // Going one's own way shows what was opened for it, not the operator that was added before.
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
    // Closing the card gives the keyboard back to the operator on the canvas.
    await user.keyboard("{Escape}");
    expect(cardOf("Limit")).toHaveFocus();

    await user.paste("select * from penguins");

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
  });

  it("leaves an operator out of executions from the menu on it, and keeps the results of several at once", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    const menu = await openMenu("Filter");
    // One operator's result is kept with the eye on its card.
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /^Keep/ })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Leave out of executions" }));
    await waitFor(() => expect(savedOperator(wid, "filter")).toMatchObject({ isDisabled: true }));
    expect(
      within(await openMenu("Filter")).getByRole("menuitemcheckbox", { name: "Leave out of executions" })
    ).toBeChecked();
    await user.keyboard("{Escape}");

    cardOf("Limit").focus();
    await user.keyboard("{Control>}a{/Control}");
    await user.click(within(await openMenu("Limit")).getByRole("menuitemcheckbox", { name: "Keep their results" }));

    await waitFor(() => expect(savedContent(wid).operators.every(each => each.viewResult)).toBe(true));
  });

  it("executes the workflow up to an operator from the menu on it, keeping each result marked to keep before it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    await user.click(within(cardOf("CSV File Scan")).getByRole("button", { name: "Keep the result of CSV File Scan" }));
    await waitFor(() => expect(savedOperator(wid, "scan")).toMatchObject({ viewResult: true }));

    await user.click(within(await openMenu("Filter")).getByRole("menuitem", { name: "Execute up to here" }));

    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");
    const canvas = screen.getByLabelText("Workflow canvas");
    expect(within(canvas).getByRole("group", { name: "Filter" })).toHaveTextContent(/Completed.*3 → 2 rows/);
    // The operator after it was not executed.
    expect(within(canvas).getByRole("group", { name: "Limit" })).not.toHaveTextContent("Completed");
    await user.click(within(execution).getByRole("combobox", { name: "Result of" }));
    expect(
      screen
        .getAllByRole("option")
        .map(option => option.textContent)
        .toSorted()
    ).toEqual(["CSV File Scan", "Filter"]);
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

describe("an operator's card", () => {
  it("opens with a double click or its pencil, one at a time, and closes with Done or Escape", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    // The press of a click would start a drag, which jsdom cannot do: the click itself is sent, as the browser does.
    fireEvent.doubleClick(cardOf("Filter"));
    expect(await screen.findByRole("region", { name: "Properties of Filter" })).toBeVisible();
    await user.click(within(cardOf("Limit")).getByRole("button", { name: "Edit Limit" }));
    expect(await screen.findByRole("region", { name: "Properties of Limit" })).toBeVisible();
    expect(propertiesOf("Filter")).not.toBeInTheDocument();

    await user.click(within(propertiesOf("Limit")!).getByRole("button", { name: "Done" }));
    expect(propertiesOf("Limit")).not.toBeInTheDocument();
    expect(cardOf("Limit")).toHaveFocus();
    await select(user, "CSV File Scan");
    await user.keyboard("{Escape}");
    expect(propertiesOf("CSV File Scan")).not.toBeInTheDocument();
    expect(cardOf("CSV File Scan")).toHaveFocus();
  });

  it("keeps the operator when Backspace or Delete is pressed in a list of choices its open card opened", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const filter = await select(user, "Filter");

    // The list is drawn apart from the card, under the page's body, though it is the card's.
    await user.click(await within(filter).findByRole("combobox", { name: "Attribute *" }));
    await screen.findAllByRole("option");
    await user.keyboard("{Backspace}{Delete}{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
    expect(screen.getByRole("region", { name: "Properties of Filter" })).toBeVisible();
  });

  it("closes the card of an operator someone else removes, and does not open it when they bring it back", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await waitFor(() => expect(grace.document.content().operators).toHaveLength(3));
    await select(user, "Limit");
    const search = screen.getByRole("searchbox", { name: "Search operators" });
    await user.type(search, "so");

    grace.document.remove({ operators: ["limit"] });
    await waitFor(() => expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter"]));
    grace.document.undo();
    await waitFor(() => expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]));

    // Its card would take the keyboard from what this user is doing now.
    expect(screen.queryByRole("region", { name: /^Properties of/ })).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    expect(search).toHaveValue("so");
  });

  it("keeps the operator when Backspace or Delete is typed in its open card", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const scan = await select(user, "CSV File Scan");

    within(scan).getByRole("checkbox", { name: "Header *" }).focus();
    await user.keyboard("{Backspace}{Delete}");
    const limit = await select(user, "Limit");
    await user.type(within(limit).getByLabelText("Limit *"), "{Backspace}{Delete}");

    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
    // The key on the operator itself still deletes it.
    await user.keyboard("{Escape}{Backspace}");
    await waitFor(() => expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter"]));
  });

  it("keeps an operator's result with the eye on its card, in the workflow everyone in the room shares", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    const eye = within(cardOf("Filter")).getByRole("button", { name: "Keep the result of Filter" });
    expect(eye).toHaveAttribute("aria-pressed", "false");

    await user.click(eye);

    expect(eye).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(grace.document.content().operators.find(each => each.operatorID === "filter")?.viewResult).toBe(true)
    );
    await waitFor(() => expect(savedOperator(wid, "filter")).toMatchObject({ viewResult: true }));
    await user.click(eye);
    await waitFor(() => expect(savedOperator(wid, "filter")).toMatchObject({ viewResult: false }));
  });

  it("executes the workflow up to an operator from its card, keeping each result marked to keep before it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await user.click(within(cardOf("CSV File Scan")).getByRole("button", { name: "Keep the result of CSV File Scan" }));
    const upTo = within(cardOf("Filter")).getByRole("button", { name: "Execute up to Filter" });
    await waitFor(() => expect(upTo).toHaveAttribute("aria-disabled", "false"));

    await user.click(upTo);

    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");
    expect(cardOf("CSV File Scan")).toHaveTextContent(/Completed.*3 rows/);
    expect(cardOf("Filter")).toHaveTextContent(/Completed.*3 → 2 rows/);
    // The operator after it was not executed.
    expect(cardOf("Limit")).not.toHaveTextContent("Completed");
    await user.click(within(execution).getByRole("combobox", { name: "Result of" }));
    expect(
      screen
        .getAllByRole("option")
        .map(option => option.textContent)
        .toSorted()
    ).toEqual(["CSV File Scan", "Filter"]);
  });

  it("shows every setting on each card when the user asks, and keeps that choice for every canvas", async () => {
    const { wid } = addPenguinWorkflow();
    const { user, unmount } = await openEditor(wid);
    const predicates = () => within(cardOf("Filter")).queryByRole("term");
    expect(predicates()).not.toBeInTheDocument();
    expect(cardOf("Filter")).toHaveTextContent("mass > 3600");

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Show every setting on its card" }));

    expect(predicates()).toHaveTextContent("Predicates");
    expect(within(cardOf("Filter")).getByRole("definition")).toHaveTextContent("mass > 3600");
    unmount();
    const { wid: other } = addPenguinWorkflow();
    const { user: again } = await openEditor(other);
    expect(predicates()).toHaveTextContent("Predicates");
    await again.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Show every setting on its card" })).toBeChecked();
  });

  it("says on the card why the workflow cannot be executed up to an operator", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);

    await user.click(screen.getByRole("button", { name: "Sort" }));

    const upTo = within(cardOf("Sort")).getByRole("button", { name: "Execute up to Sort" });
    await waitFor(() => expect(upTo).toHaveAccessibleDescription("Attributes is not set."));
    expect(upTo).toHaveAttribute("aria-disabled", "true");
  });
});

describe("an operator someone else is editing", () => {
  it("is left to them: it shows who, opens here only to read, and changes nothing here, but it moves", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");

    grace.room.edit("scan");

    const scan = cardOf("CSV File Scan");
    await waitFor(() => expect(scan).toHaveTextContent("Grace is editing"));
    const eye = within(scan).getByRole("button", { name: "Keep the result of CSV File Scan" });
    expect(eye).toHaveAttribute("aria-disabled", "true");
    expect(eye).toHaveAccessibleDescription("Grace is editing");
    await user.click(eye);
    expect(within(scan).getByRole("button", { name: "View CSV File Scan" })).toHaveAccessibleDescription(
      "Grace is editing"
    );
    // Enter selects it, and opens it to read: nothing in it changes it, and the others are told of no card.
    scan.focus();
    await user.keyboard("{Enter}");
    const properties = await screen.findByRole("region", { name: "Properties of CSV File Scan" });
    expect(within(properties).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(properties).getByRole("button", { name: "Keep the result of CSV File Scan" })).toBeDisabled();
    expect(within(properties).getByLabelText("Offset")).toBeDisabled();
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["scan"] }]));
    expect(toldBy(grace)).toBeUndefined();
    await user.click(within(properties).getByRole("button", { name: "Done" }));
    // A double click opens it to read too.
    fireEvent.doubleClick(scan);
    const again = await screen.findByRole("region", { name: "Properties of CSV File Scan" });
    expect(within(again).getByLabelText("Offset")).toBeDisabled();
    await user.click(within(again).getByRole("button", { name: "Done" }));

    // Neither its key nor the menu on it deletes it, cuts it or leaves it out.
    scan.focus();
    await user.keyboard("{Delete}{Backspace}");
    const menu = await openMenu("CSV File Scan");
    const items = [
      within(menu).getByRole("menuitem", { name: /^Delete/ }),
      within(menu).getByRole("menuitem", { name: /^Cut/ }),
      within(menu).getByRole("menuitemcheckbox", { name: "Leave out of executions" }),
    ];
    for (const item of items) {
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAccessibleDescription("Grace is editing");
    }
    // Each stays where the keyboard goes, after Copy, so that whoever comes to it is told why, and choosing it does
    // nothing: the menu stays open.
    await user.keyboard("{Home}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(items[0]);
    await user.click(items[2]);
    expect(items[0]).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);
    expect(cardOf("CSV File Scan")).not.toHaveTextContent("Left out");

    // Where it stands is anyone's to change. What is saved then holds all that came before it, which left it as it was.
    dragRight("CSV File Scan", 80);
    await waitFor(() => expect(savedContent(wid).operatorPositions.scan.x).toBeGreaterThan(0));
    expect(savedOperator(wid, "scan")).not.toHaveProperty("viewResult", true);
    expect(savedOperator(wid, "scan")).not.toHaveProperty("isDisabled", true);
  });

  it("opens here to change once whoever was editing it is done, or has left", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    const pencil = (name: string) => within(cardOf("CSV File Scan")).getByRole("button", { name });

    grace.room.edit("scan");
    await waitFor(() => expect(pencil("View CSV File Scan")).toHaveAccessibleDescription("Grace is editing"));
    grace.room.edit(undefined);
    await waitFor(() => expect(cardOf("CSV File Scan")).not.toHaveTextContent("Grace is editing"));
    await user.click(pencil("Edit CSV File Scan"));
    const properties = await screen.findByRole("region", { name: "Properties of CSV File Scan" });
    expect(within(properties).getByLabelText("Offset")).toBeEnabled();
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "scan" }));
    await user.click(within(properties).getByRole("button", { name: "Done" }));

    grace.room.edit("scan");
    await waitFor(() => expect(cardOf("CSV File Scan")).toHaveTextContent("Grace is editing"));
    grace.room.leave();
    await waitFor(() => expect(cardOf("CSV File Scan")).not.toHaveTextContent("Grace is editing"));
    expect(within(await select(user, "CSV File Scan")).getByLabelText("Offset")).toBeEnabled();
  });

  it("stays with whoever opened it first when two open it at once, and closes for the other", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");

    // This user opens the Limit, and Grace opened it a moment before, though her word of it comes after.
    await select(user, "Limit");
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "limit" }));
    const earlier = toldBy(grace)!.since - 1000;
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(earlier);
    grace.room.edit("limit");
    now.mockRestore();

    await waitFor(() => expect(propertiesOf("Limit")).not.toBeInTheDocument());
    expect(cardOf("Limit")).toHaveTextContent("Grace is editing");
    await waitFor(() => expect(toldBy(grace)).toBeUndefined());
    // It opens again, to read.
    expect(within(await select(user, "Limit")).getByLabelText("Limit *")).toBeDisabled();

    // This user opens the Filter before Grace does: it stays this user's.
    const filter = await select(user, "Filter");
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "filter" }));
    grace.room.edit("filter");
    grace.room.select(["filter"]);
    // Her word of it comes before what she selects.
    expect(await within(cardOf("Filter")).findByRole("list", { name: "Selected by" })).toHaveTextContent("Grace");
    expect(filter).toBeVisible();
    expect(cardOf("Filter")).not.toHaveTextContent("Grace is editing");
    expect(holderOf("filter", [grace.room.state().me!, ...grace.room.state().collaborators])).toMatchObject({
      name: admin.name,
    });
  });

  it("keeps the code open that was opened from a card someone else turns out to hold, to type in", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await select(user, "Python UDF");
    const { panel, editor } = await openCode(user, "Python UDF");
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "udf" }));

    // Grace opened the card a moment before this user, though her word of it comes after.
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(toldBy(grace)!.since - 1000);
    grace.room.edit("udf");
    now.mockRestore();

    await waitFor(() => expect(propertiesOf("Python UDF")).not.toBeInTheDocument());
    expect(cardOf("Python UDF")).toHaveTextContent("Grace is editing");
    // Code is shared text that everyone types into: no one holds it.
    expect(panel).toBeInTheDocument();
    typeAtStart(editor, "# mine\n");
    await waitFor(() => expect(grace.document.code("udf")!.toJSON()).toContain("# mine"));
  });

  it("opens to read for someone who may change the workflow, telling nobody, with its code to type in", async () => {
    const { wid } = addCodeWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    grace.room.edit("udf");
    await waitFor(() => expect(cardOf("Python UDF")).toHaveTextContent("Grace is editing"));

    const properties = await select(user, "Python UDF");
    expect(within(properties).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(properties).getByLabelText("Worker count *")).toBeDisabled();
    expect(within(properties).getByRole("button", { name: "Keep the result of Python UDF" })).toBeDisabled();
    // Code is shared text that no one holds: it opens to type in.
    const { editor } = await openCode(user, "Python UDF");
    typeAtStart(editor, "# mine\n");
    await waitFor(() => expect(grace.document.code("udf")!.toJSON()).toContain("# mine"));
    expect(toldBy(grace)).toBeUndefined();

    // Once she is done, the card stays as it was opened, to read, and opened again, it opens to change.
    grace.room.edit(undefined);
    await waitFor(() => expect(cardOf("Python UDF")).not.toHaveTextContent("Grace is editing"));
    expect(within(properties).getByLabelText("Worker count *")).toBeDisabled();
    expect(toldBy(grace)).toBeUndefined();
    await user.click(within(properties).getByRole("button", { name: "Done" }));
    expect(within(await select(user, "Python UDF")).getByLabelText("Worker count *")).toBeEnabled();
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "udf" }));
  });

  it("is, to everyone else, the one whose card this user has open, until they close it", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");

    const limit = await select(user, "Limit");
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "limit" }));
    await user.click(within(cardOf("Filter")).getByRole("button", { name: "Edit Filter" }));
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "filter" }));
    await user.click(
      within(screen.getByRole("region", { name: "Properties of Filter" })).getByRole("button", { name: "Done" })
    );

    await waitFor(() => expect(toldBy(grace)).toBeUndefined());
    expect(limit).not.toBeInTheDocument();
  });

  it("opens to read for someone who may only view the workflow too, while they edit it, telling nobody", async () => {
    const { wid } = addPenguinWorkflow({ grants: [{ uid: reader.uid, privilege: "READ" }] });
    // Grace is the owner, in a browser of her own.
    signInAs(admin);
    const grace = await coEditor(wid, "Grace");
    const edit = vi.spyOn(WorkflowRoom.prototype, "edit");
    onTestFinished(() => edit.mockRestore());
    const { user } = await openEditor(wid, sessionFor(reader));

    grace.room.edit("limit");
    await waitFor(() => expect(cardOf("Limit")).toHaveTextContent("Grace is editing"));
    expect(within(cardOf("Limit")).getByRole("button", { name: "View Limit" })).toHaveAccessibleDescription(
      "Grace is editing"
    );
    const limit = await select(user, "Limit");
    expect(within(limit).getByLabelText("Limit *")).toBeDisabled();

    // A card open only to read stays as it is, whether she is done or opens it anew.
    grace.room.edit(undefined);
    await waitFor(() => expect(cardOf("Limit")).not.toHaveTextContent("Grace is editing"));
    grace.room.edit("limit");
    await waitFor(() => expect(cardOf("Limit")).toHaveTextContent("Grace is editing"));
    expect(limit).toBeVisible();
    const toldByThisUser = edit.mock.calls.filter((_, call) => edit.mock.contexts[call] !== grace.room);
    expect(toldByThisUser.length).toBeGreaterThan(0);
    expect(toldByThisUser.every(([operatorId]) => operatorId === undefined)).toBe(true);
  });

  it("is not opened here for whoever follows the one editing it, until they open it themselves, to read", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await user.click(await screen.findByRole("button", { name: "Follow Grace" }));

    grace.room.select(["filter"]);
    grace.room.edit("filter");

    await waitFor(() => expect(cardOf("Filter")).toHaveTextContent("Grace is editing"));
    await waitFor(() => expect(grace.room.state().collaborators).toMatchObject([{ selection: ["filter"] }]));
    expect(screen.queryByRole("region", { name: /^Properties of/ })).not.toBeInTheDocument();
    // Enter on it is this user's own doing: it opens to read, and following her ends.
    cardOf("Filter").focus();
    await user.keyboard("{Enter}");
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });
    expect(within(properties).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Follow Grace" })).toHaveAttribute("aria-pressed", "false");
    expect(toldBy(grace)).toBeUndefined();
  });

  it("is left out of what the menu and the keys change for several operators at once", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    grace.room.edit("filter");
    await waitFor(() => expect(cardOf("Filter")).toHaveTextContent("Grace is editing"));
    cardOf("Limit").focus();
    await user.keyboard("{Control>}a{/Control}");
    const leaveOut = async () =>
      within(await openMenu("Limit")).getByRole("menuitemcheckbox", { name: "Leave out of executions" });

    await user.click(await leaveOut());
    await user.click(within(await openMenu("Limit")).getByRole("menuitemcheckbox", { name: "Keep their results" }));
    await waitFor(() => expect(savedOperator(wid, "limit")).toMatchObject({ isDisabled: true, viewResult: true }));
    expect(savedOperator(wid, "scan")).toMatchObject({ isDisabled: true, viewResult: true });
    expect(savedOperator(wid, "filter")).not.toHaveProperty("isDisabled", true);
    expect(savedOperator(wid, "filter")).not.toHaveProperty("viewResult", true);

    // A switch says how the operators it changes are set: the Filter, which is Grace's, has no say in it.
    const leftOut = await leaveOut();
    expect(leftOut).toBeChecked();
    await user.click(leftOut);
    await waitFor(() => expect(savedOperator(wid, "limit")).toMatchObject({ isDisabled: false }));
    expect(savedOperator(wid, "scan")).toMatchObject({ isDisabled: false });

    cardOf("Limit").focus();
    const cut = readPiece(copyFromCanvas("cut"));
    expect(cut?.operators.map(each => each.operatorID).toSorted()).toEqual(["limit", "scan"]);
    expect(operatorsOnCanvas()).toEqual(["Filter"]);
  });

  it("is not changed from the menu when everything selected is someone else's, which says who is editing", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    const alan = await coEditor(wid, "Alan");
    grace.room.edit("filter");
    alan.room.edit("limit");
    await waitFor(() => expect(cardOf("Filter")).toHaveTextContent("Grace is editing"));
    await waitFor(() => expect(cardOf("Limit")).toHaveTextContent("Alan is editing"));
    cardOf("Filter").focus();
    await user.keyboard("{Enter}{Control>}");
    cardOf("Limit").focus();
    await user.keyboard("{Enter}{/Control}");

    const menu = await openMenu("Limit");

    const items = [
      within(menu).getByRole("menuitem", { name: /^Delete/ }),
      within(menu).getByRole("menuitem", { name: /^Cut/ }),
      within(menu).getByRole("menuitemcheckbox", { name: "Keep their results" }),
      within(menu).getByRole("menuitemcheckbox", { name: "Leave out of executions" }),
    ];
    for (const item of items) {
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAccessibleDescription("Grace and Alan are editing");
    }
    // What changes nothing that is there is anyone's to do.
    expect(within(menu).getByRole("menuitem", { name: /^Duplicate/ })).not.toHaveAttribute("aria-disabled");
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

  it("opens the card of an operator in a version that is shown, to read, beside what the version changed", async () => {
    const { wid } = addHistoryWorkflow();
    const { user } = await openEditor(wid);
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /10:00:00/ }));

    const limit = await select(user, "Limit");

    expect(within(limit).getByLabelText("Limit *")).toBeDisabled();
    expect(within(limit).getByLabelText("Name")).toBeDisabled();
    expect(within(limit).queryByRole("button", { name: "Execute up to Limit" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What changed" })).toBeVisible();
  });

  it("tells nobody of a card opened in a version that is shown, which is only read there", async () => {
    const { wid } = addHistoryWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await select(user, "Limit");
    await waitFor(() => expect(toldBy(grace)).toMatchObject({ operatorId: "limit" }));

    // Showing a version closes the card, and what it told.
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /10:00:00/ }));
    await waitFor(() => expect(toldBy(grace)).toBeUndefined());
    const edit = vi.spyOn(WorkflowRoom.prototype, "edit");
    onTestFinished(() => edit.mockRestore());
    await select(user, "Limit");

    expect(edit).not.toHaveBeenCalledWith(expect.any(String));
  });

  it("shows no one editing an operator of a version that is shown, whose card opens to read", async () => {
    const { wid } = addHistoryWorkflow();
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    grace.room.edit("limit");
    await waitFor(() => expect(cardOf("Limit")).toHaveTextContent("Grace is editing"));

    // The version is the workflow as it was, which no one is editing.
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /10:00:00/ }));

    expect(cardOf("Limit")).not.toHaveTextContent("Grace is editing");
    expect(within(cardOf("Limit")).getByRole("button", { name: "View Limit" })).not.toHaveAccessibleDescription(
      "Grace is editing"
    );
    const limit = await select(user, "Limit");
    expect(within(limit).getByLabelText("Limit *")).toBeDisabled();
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
    addExecutionRecord(db, {
      wid,
      name: "First try",
      status: 4,
      reason: "unit lost",
      startingTime: at(0),
      lastUpdateTime: at(0, 3),
    });
    addExecutionRecord(db, { wid, name: "Second try", status: 3, startingTime: at(5), lastUpdateTime: at(5, 40) });
    const { user } = await openEditor(wid);

    const executions = await openExecutions(user);

    const items = within(executions).getAllByRole("listitem");
    expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["Second try", "First try"]);
    expect(items[0]).toHaveTextContent(/Completed · by texera · Nov 18, 2026, 10:05.AM · took 40 s/);
    // Why it ended as it did, when the service says.
    expect(items[1]).toHaveTextContent("Failed: unit lost · by texera");

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
    ).toEqual(["OperatorRowsTimeRows as they came", "Filter3 → 2 rows2 s"]);

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

  it("keeps the parameters in step with the code of the person this user follows, as this user types in it", async () => {
    const { wid } = addUdfWorkflow(declared);
    const { user } = await openEditor(wid);
    const grace = await coEditor(wid, "Grace");
    await user.click(await screen.findByRole("button", { name: "Follow Grace" }));

    grace.room.select(["udf"]);
    grace.room.openCode("udf");
    const panel = await screen.findByRole("region", { name: "Code of Python UDF" });
    const editor = await within(panel).findByRole("textbox", { name: "Code of Python UDF" });
    const view = EditorView.findFromDOM(editor.closest<HTMLElement>(".cm-editor")!)!;
    const at = view.state.doc.toString().indexOf(declared) + declared.length;
    view.dispatch({
      changes: { from: at, insert: '\n        self.name = self.UiParameter("name", AttributeType.STRING).value' },
    });

    await waitFor(() =>
      expect(parametersOf(wid)).toEqual([
        { attribute: { attributeName: "count", attributeType: "integer" }, value: "" },
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

describe("the chips around the cards", () => {
  /** Where the admin's dataset "penguins" keeps the file the scan reads, in its version v1. */
  const penguinsFile = "/dataset/texera/penguins/v1/penguins.csv";

  /**
   * The admin's dataset "penguins", with the file the scan reads in its version v1, which the stand-in engine reads by
   * its whole path; and the workflow "Heavy penguins" reading it: scan -> filter -> limit.
   */
  function addDatasetWorkflow() {
    const dataset = addDataset(db, {
      name: "penguins",
      description: "Palmer Archipelago penguins",
      versions: [{ name: "v1", files: { "penguins.csv": "species,mass\n" } }],
    });
    db.files[penguinsFile] = penguins;
    addComputingUnit(db, { name: "Small unit" });
    const workflow = addWorkflow(db, {
      name: "Heavy penguins",
      content: workflowContent(
        [
          operator("CSVFileScan", "scan", { fileName: penguinsFile }),
          operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
          operator("Limit", "limit", { limit: 5 }),
        ],
        [link("scan", "filter"), link("filter", "limit")]
      ),
    });
    return { dataset, workflow };
  }

  /** The chips of the versions the operators read, by what each says. */
  const resourceChips = () =>
    within(screen.getByLabelText("Workflow canvas"))
      .queryAllByRole("button", { name: / v\d+$/ })
      .map(chip => chip.textContent);

  it("shows above the scan the version of the dataset it reads, and what the backend says of it", async () => {
    const { dataset, workflow } = addDatasetWorkflow();
    const { user } = await openEditor(workflow.wid);

    await user.click(within(screen.getByLabelText("Workflow canvas")).getByRole("button", { name: "penguins v1" }));

    const details = await screen.findByRole("dialog", { name: "penguins" });
    expect(await within(details).findByText("Palmer Archipelago penguins")).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/datasets/${dataset.did}?version=${dataset.versions[0].dvid}&file=penguins.csv`
    );
  });

  it("shows the version of a model a UDF's parameter takes, and none for a file named without its dataset", async () => {
    addComputingUnit(db, { name: "Small unit" });
    const { wid } = addWorkflow(db, {
      name: "Heavy penguins",
      content: workflowContent([
        operator("CSVFileScan", "scan", { fileName: "penguins.csv" }),
        operator("PythonUDFV2", "udf", {
          uiParameters: [
            {
              attribute: { attributeName: "weights", attributeType: "string" },
              value: "/model/texera/resnet/v3",
              inputType: "model",
            },
          ],
        }),
      ]),
    });

    await openEditor(wid);

    expect(resourceChips()).toEqual(["resnet v3"]);
  });

  it("never counts a chip as a part of the workflow: selecting all, copying, arranging and deleting see operators only", async () => {
    const { workflow } = addDatasetWorkflow();
    const { user } = await openEditor(workflow.wid);
    expect(resourceChips()).toEqual(["penguins v1"]);
    const before = savedContent(workflow.wid);

    cardOf("Limit").focus();
    await user.keyboard("{Control>}a{/Control}");
    const piece = readPiece(copyFromCanvas());
    expect(piece?.operators.map(each => each.operatorID).toSorted()).toEqual(["filter", "limit", "scan"]);
    expect(piece?.links).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Arrange the operators" }));
    await waitFor(() => expect(savedContent(workflow.wid).operatorPositions).toEqual(layout(before)));
    expect(operatorsOnCanvas()).toEqual(["CSV File Scan", "Filter", "Limit"]);

    cardOf("Limit").focus();
    await user.keyboard("{Control>}a{/Control}{Delete}");

    // Nothing is left on the canvas, which draws no chip without its card.
    expect(within(screen.getByLabelText("Workflow canvas")).queryAllByRole("group")).toEqual([]);
    expect(resourceChips()).toEqual([]);
    await waitFor(() => expect(savedContent(workflow.wid)).toMatchObject({ operators: [], links: [] }));
  });

  it("shows under a card the result it kept, and that result in the panel when it is clicked", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Execute" }));
    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");

    // The limit is a sink, whose result is kept; the filter's is not, until its eye keeps it.
    const canvas = screen.getByLabelText("Workflow canvas");
    const limit = within(canvas).getByRole("button", { name: "Result of Limit: 2 rows" });
    expect(within(canvas).queryByRole("button", { name: /^Result of Filter/ })).not.toBeInTheDocument();
    await user.click(within(execution).getByRole("tab", { name: "Console" }));
    await user.click(within(execution).getByRole("button", { name: "Minimize Execution" }));

    await user.click(limit);

    const shown = await screen.findByRole("region", { name: "Execution" });
    expect(within(shown).getByRole("tab", { name: "Result" })).toHaveAttribute("aria-selected", "true");
    expect(within(shown).getByRole("combobox", { name: "Result of" })).toHaveTextContent("Limit");
    expect(await within(shown).findByText("2 rows · page 1 of 1")).toBeInTheDocument();

    await user.click(within(cardOf("Filter")).getByRole("button", { name: "Keep the result of Filter" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Execute" }));
    expect(await within(canvas).findByRole("button", { name: "Result of Filter: 2 rows" })).toBeInTheDocument();
  });

  it("leaves the panel minimized when a version shown in place of the workflow is closed after a result was shown", async () => {
    const { wid } = addPenguinWorkflow();
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Execute" }));
    const execution = await screen.findByRole("region", { name: "Execution" });
    await within(execution).findByText("Completed");
    await user.click(
      within(screen.getByLabelText("Workflow canvas")).getByRole("button", { name: "Result of Limit: 2 rows" })
    );
    await user.click(within(execution).getByRole("button", { name: "Minimize Execution" }));

    // The panel is not drawn while a version is shown, and is drawn anew after it: the result shown before is no new
    // one to show.
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /12:00:00/ }));
    await user.click(
      within(screen.getByRole("toolbar", { name: "Version" })).getByRole("button", { name: "Back to the workflow" })
    );

    expect(await screen.findByRole("button", { name: "Execution Completed" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Execution" })).not.toBeInTheDocument();
  });

  it("shows a version's datasets, as it read them, and no result of the execution on screen", async () => {
    const start = Date.UTC(2026, 10, 18, 9, 0);
    const reading = (version: string) =>
      workflowContent(
        [
          operator("CSVFileScan", "scan", { fileName: `/dataset/texera/penguins/${version}/penguins.csv` }),
          operator("Limit", "limit", { limit: 5 }),
        ],
        [link("scan", "limit")]
      );
    db.files["/dataset/texera/penguins/v2/penguins.csv"] = penguins;
    addComputingUnit(db, { name: "Small unit" });
    const { wid } = addWorkflow(db, {
      name: "Heavy penguins",
      saves: [
        [start, reading("v1")],
        [start + 60 * 60_000, reading("v2")],
      ],
    });
    const { user } = await openEditor(wid);
    await waitFor(() => expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Execute" }));
    const canvas = screen.getByLabelText("Workflow canvas");
    await within(canvas).findByRole("button", { name: "Result of Limit: 3 rows" });
    expect(resourceChips()).toEqual(["penguins v2"]);

    await user.click(screen.getByRole("tab", { name: "Versions" }));
    await user.click(await screen.findByRole("button", { name: /9:00:00/ }));

    await waitFor(() => expect(resourceChips()).toEqual(["penguins v1"]));
    expect(within(canvas).queryByRole("button", { name: /^Result of/ })).not.toBeInTheDocument();
  });

  it("hides every chip when the user asks, and keeps that choice for every canvas", async () => {
    const { workflow } = addDatasetWorkflow();
    const { user, unmount } = await openEditor(workflow.wid);
    expect(resourceChips()).toEqual(["penguins v1"]);

    await user.click(screen.getByRole("button", { name: "More" }));
    const choice = screen.getByRole("menuitemcheckbox", { name: "Show datasets, models and results" });
    expect(choice).toBeChecked();
    await user.click(choice);

    expect(resourceChips()).toEqual([]);
    unmount();
    const { user: again } = await openEditor(workflow.wid);
    expect(resourceChips()).toEqual([]);
    await again.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Show datasets, models and results" })).not.toBeChecked();
  });
});
