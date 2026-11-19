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

import { expect, type Locator, type Page } from "@playwright/test";
import type { Workflow } from "../backend.ts";

/**
 * The React app's workflow editor, used as a person would: found by roles, labels and text alone. Operators are
 * named as the canvas names them, which for a new operator is the name of its type.
 */
export class WorkflowEditor {
  readonly page: Page;
  readonly canvas: Locator;
  readonly toolbar: Locator;
  /** The panel docked to the canvas's bottom edge, with what the last execution did. */
  readonly execution: Locator;
  /** What the last execution is doing: "Running", "Completed", "Failed", and so on. */
  readonly executionState: Locator;
  /** The other people who have the workflow open. */
  readonly alsoEditing: Locator;
  /** The bar that says which version is shown in place of the workflow. */
  readonly versionBar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.canvas = page.getByLabel("Workflow canvas");
    this.toolbar = page.getByRole("toolbar", { name: "Workflow" });
    this.execution = this.panel("Execution");
    this.executionState = this.execution.getByRole("status");
    this.alsoEditing = this.toolbar.getByRole("list", { name: "Also editing" });
    this.versionBar = page.getByRole("toolbar", { name: "Version" });
  }

  async open({ wid }: Workflow): Promise<void> {
    await this.page.goto(`workflows/${wid}`);
    await expect(this.canvas).toBeVisible();
  }

  /** Waits until the toolbar says that everything on the canvas is saved. */
  async saved(): Promise<void> {
    await expect(this.toolbar.getByRole("status")).toHaveText("Saved");
  }

  operator(name: string): Locator {
    return this.canvas.getByRole("group", { name, exact: true });
  }

  /** Adds an operator of a type from the menu. It goes to the right of the others. */
  async addOperator(typeName: string): Promise<void> {
    await this.page.getByRole("searchbox", { name: "Search operators" }).fill(typeName);
    await this.page.getByRole("button", { name: typeName, exact: true }).click();
    await expect(this.operator(typeName)).toBeVisible();
  }

  /** Brings every operator onto the screen: one that the canvas has moved out of view cannot be clicked. */
  private async showAll(): Promise<void> {
    await this.canvas.getByRole("button", { name: "Fit View" }).click();
  }

  /** Links the first output port of one operator to the first input port of another. */
  async link(from: string, to: string): Promise<void> {
    await this.showAll();
    await this.operator(from).getByLabel("Output port 1").click();
    await this.operator(to).getByLabel("Input port 1").click();
  }

  /** Selects an operator, and returns the panel with its properties. */
  async select(name: string): Promise<Locator> {
    await this.showAll();
    await this.operator(name).click();
    const properties = this.properties(name);
    await expect(properties).toBeVisible();
    return properties;
  }

  properties(name: string): Locator {
    return this.page.getByRole("region", { name: `Properties of ${name}` });
  }

  /** Picks one of the options of a field that offers a choice. */
  async choose(field: Locator, option: string): Promise<void> {
    await field.click();
    await this.page.getByRole("option", { name: option, exact: true }).click();
  }

  /** The options a field offers, such as the columns of an operator's input. */
  async options(field: Locator): Promise<string[]> {
    await field.click();
    const options = await this.page.getByRole("option").allInnerTexts();
    await this.page.keyboard.press("Escape");
    return options;
  }

  /** The panel with an operator's code, once it is open. */
  code(name: string): Locator {
    return this.page.getByRole("region", { name: `Code of ${name}` });
  }

  /** The text of an operator's code, where it is typed. */
  codeText(name: string): Locator {
    return this.code(name).getByRole("textbox");
  }

  /** Opens the code of the operator that is selected. */
  async openCode(name: string): Promise<void> {
    await this.properties(name)
      .getByRole("button", { name: /the Python code$/ })
      .click();
    await expect(this.codeText(name)).toBeVisible();
  }

  /** Types into an operator's code where its cursor is, as a keyboard does. */
  async typeCode(name: string, text: string): Promise<void> {
    await this.codeText(name).click();
    await this.page.keyboard.insertText(text);
  }

  /** Replaces all of an operator's code. */
  async replaceCode(name: string, code: string): Promise<void> {
    await this.codeText(name).click();
    await this.page.keyboard.press("ControlOrMeta+a");
    await this.page.keyboard.insertText(code);
  }

  async closeCode(name: string): Promise<void> {
    await this.code(name).getByRole("button", { name: "Close the code" }).click();
  }

  /** Starts an execution, and waits until it has ended as it should. */
  async execute(end: "Completed" | "Failed" = "Completed"): Promise<void> {
    await this.toolbar.getByRole("button", { name: "Execute" }).click();
    // A computing unit that has been idle takes a while to start its workers.
    await expect(this.executionState).toHaveText(end, { timeout: 120_000 });
  }

  /** A cell of the result that is shown, by its text. */
  resultCell(text: string): Locator {
    return this.execution.getByRole("cell", { name: text, exact: true });
  }

  /**
   * A place on the canvas that is empty and that no panel covers: the middle of its top edge, above the room the
   * canvas keeps around the workflow. Its corners are where the panels are docked.
   */
  async emptySpot(): Promise<{ x: number; y: number }> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("The canvas is not on the page.");
    return { x: Math.round(box.width / 2), y: 24 };
  }

  /** Opens the canvas's menu on an operator, or on an empty spot of the canvas, and returns it. */
  async openMenu(on?: string): Promise<Locator> {
    if (on) await this.operator(on).click({ button: "right" });
    else await this.canvas.click({ button: "right", position: await this.emptySpot() });
    const menu = this.page.getByRole("menu");
    await expect(menu).toBeVisible();
    return menu;
  }

  /** The note of a comment box on the canvas, by who started it. */
  comment(by: string): Locator {
    return this.canvas.getByRole("group", { name: `Comment by ${by}` });
  }

  /** Shows the workflow's versions in the workspace panel, and returns their list. */
  async openHistory(): Promise<Locator> {
    await this.page.getByRole("tab", { name: "Versions" }).click();
    const versions = this.page.getByRole("list", { name: "Versions" });
    await expect(versions).toBeVisible();
    return versions;
  }

  /**
   * A panel that floats over the canvas, by its title: "Operators" (or the workspace's other views), "Properties",
   * "Execution", and so on.
   */
  panel(title: string): Locator {
    return this.page.getByRole("region", { name: title, exact: true });
  }

  /** Where a panel is on the page, and how wide, in whole pixels. */
  async panelBox(title: string): Promise<{ x: number; y: number; width: number }> {
    const box = await this.panel(title).boundingBox();
    if (!box) throw new Error(`The ${title} panel is not on the page.`);
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) };
  }

  /** Drags a panel by its header, this far across and down. */
  async movePanel(title: string, dx: number, dy: number): Promise<void> {
    const heading = await this.panel(title).getByRole("heading", { name: title, exact: true }).boundingBox();
    if (!heading) throw new Error(`The ${title} panel has no header on the page.`);
    await this.drag({ x: heading.x + 8, y: heading.y + heading.height / 2 }, dx, dy);
  }

  /** Drags the right edge of a panel, to make it this much wider, or narrower. */
  async widenPanel(title: string, by: number): Promise<void> {
    const box = await this.panel(title).boundingBox();
    if (!box) throw new Error(`The ${title} panel is not on the page.`);
    await this.drag({ x: box.x + box.width - 2, y: box.y + box.height / 2 }, by, 0);
  }

  /** The views of the workspace panel's rail, from top to bottom. */
  async railOrder(): Promise<string[]> {
    return this.page
      .getByRole("tablist", { name: "Workspace" })
      .getByRole("tab")
      .evaluateAll(tabs => tabs.map(tab => tab.getAttribute("aria-label") ?? ""));
  }

  /** Drags the icon of a view in the workspace panel's rail onto the place of another's. */
  async dragRailIcon(view: string, onto: string): Promise<void> {
    const rail = this.page.getByRole("tablist", { name: "Workspace" });
    const from = await rail.getByRole("tab", { name: view, exact: true }).boundingBox();
    const to = await rail.getByRole("tab", { name: onto, exact: true }).boundingBox();
    if (!from || !to) throw new Error("The workspace panel's rail is not on the page.");
    await this.drag({ x: from.x + from.width / 2, y: from.y + from.height / 2 }, 0, to.y - from.y);
  }

  private async drag(from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
    await this.page.mouse.up();
  }

  /** The button that follows someone else who has the workflow open. */
  follow(name: string): Locator {
    return this.alsoEditing.getByRole("button", { name: `Follow ${name}` });
  }
}
