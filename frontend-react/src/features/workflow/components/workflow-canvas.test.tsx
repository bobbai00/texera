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

import { RouterContextProvider } from "@tanstack/react-router";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http } from "msw/http";
import type { HTMLAttributes } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AreaContext } from "@/components/floating/area-context";
import { noInsets } from "@/components/floating/geometry";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Point } from "@/lib/workflow/model";
import { dragOnCanvas } from "@/testing/canvas";
import { admin } from "@/testing/fixtures";
import { renderWithProviders } from "@/testing/render";
import { server } from "@/testing/server";
import { signInAs } from "@/testing/session";
import { link, operator, operatorMetadata, workflowContent } from "@/testing/workflow";
import { WorkflowCanvas, type WorkflowCanvasProps } from "./workflow-canvas";

const schemas = new Map(operatorMetadata.operators.map(schema => [schema.operatorType, schema]));

/** scan -> filter (mass > 3600) -> limit 5, in a row from left to right. */
const penguins = workflowContent(
  [
    operator("CSVFileScan", "scan", { fileName: "/dataset/texera/penguins/v1/penguins.csv", limit: 10 }),
    operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
    operator("Limit", "limit", { limit: 5 }),
  ],
  [link("scan", "filter"), link("filter", "limit")]
);

/**
 * The canvas alone, drawn from what it is given: no room, no backend. What reaches past it, as the keys and the
 * clipboard reach the editor's commands around it, is told to `around`. `redraw` draws it again with other props.
 */
function renderCanvas(props: Partial<WorkflowCanvasProps> = {}, around: HTMLAttributes<HTMLDivElement> = {}) {
  const canvas = (more: Partial<WorkflowCanvasProps>) => (
    <div {...around}>
      <WorkflowCanvas
        content={penguins}
        schemas={schemas}
        {...props}
        {...more}
      />
    </div>
  );
  const rendered = renderWithProviders(canvas({}));
  const redraw = (more: Partial<WorkflowCanvasProps>) =>
    rendered.rerender(<RouterContextProvider router={rendered.router}>{canvas(more)}</RouterContextProvider>);
  return { ...rendered, redraw };
}

/** An operator's card, by the name it goes by: React Flow makes each a group. */
const card = (name: string) => screen.findByRole("group", { name });

/** Where a chip is drawn on the canvas: each stands on its own, beside the cards, not in one. */
const chipAt = (chip: HTMLElement) => chip.closest<HTMLElement>(".react-flow__node")!.style.transform;

/**
 * The lines that join the chips to their cards. They are drawn for the eye alone: they say nothing to assistive
 * technology, which finds each chip after its card.
 */
const chipLines = () => [
  ...screen.getByLabelText("Workflow canvas").querySelectorAll<SVGGElement>(".react-flow__edge[aria-hidden=true]"),
];

describe("an operator's card", () => {
  it("says the operator's name, and its settings in one line", async () => {
    renderCanvas();

    expect(await card("CSV File Scan")).toHaveTextContent("penguins.csv · Limit 10");
    expect(await card("Filter")).toHaveTextContent("mass > 3600");
    expect(await card("Limit")).toHaveTextContent("Limit 5");
  });

  it("goes by its type's name when it was given none, and says no settings its type does not describe", async () => {
    const unnamed = { ...operator("Limit", "limit", { limit: 5 }), customDisplayName: undefined };
    const unknown = { ...operator("Limit", "mystery", { limit: 5 }), operatorType: "Mystery", customDisplayName: "" };

    renderCanvas({ content: workflowContent([unnamed, unknown]) });

    expect(await card("Limit")).toHaveTextContent("Limit 5");
    expect(await card("Mystery")).toHaveTextContent(/^Mystery$/);
  });

  it("says how the operator did in the execution shown: its state, and the rows it took and put out", async () => {
    renderCanvas({
      progress: {
        scan: { state: "Completed", inputRows: 0, outputRows: 150 },
        filter: { state: "Completed", inputRows: 150, outputRows: 1 },
        limit: { state: "Running", inputRows: 5265, outputRows: 3 },
      },
    });

    const scan = await card("CSV File Scan");
    expect(within(scan).getByText("Completed")).toBeInTheDocument();
    // A source took no rows: it says those it put out.
    expect(within(scan).getByText("150 rows")).toBeInTheDocument();
    expect(within(await card("Filter")).getByText("150 → 1 row")).toBeInTheDocument();
    const limit = await card("Limit");
    expect(within(limit).getByText("Running")).toBeInTheDocument();
    expect(within(limit).getByText("5,265 → 3 rows")).toBeInTheDocument();
    // What is under way is plain to see: its icon turns, unless the reader asked for less motion.
    expect(limit.querySelector(".motion-safe\\:animate-spin")).not.toBeNull();
    expect(scan.querySelector(".motion-safe\\:animate-spin")).toBeNull();
  });

  it("says nothing of an execution when none is shown", async () => {
    renderCanvas();

    expect(await card("Limit")).not.toHaveTextContent(/row/);
  });

  it("says why the operator cannot be executed as it is, under its name", async () => {
    renderCanvas({ problems: { filter: "Predicates is not set." } });

    expect(await card("Filter")).toHaveTextContent("Predicates is not set.");
    expect(await card("Limit")).not.toHaveTextContent("not set");
  });

  it("says on its card that an operator is left out of executions, on any canvas", async () => {
    const content = workflowContent([
      { ...operator("Limit", "limit", { limit: 5 }), isDisabled: true },
      operator("Filter", "filter"),
    ]);
    const { redraw } = renderCanvas({ content });

    expect(await card("Limit")).toHaveTextContent("Left out");
    expect(await card("Filter")).not.toHaveTextContent("Left out");
    redraw({ readOnly: true });
    expect(await card("Limit")).toHaveTextContent("Left out");
  });

  it("describes each operator, to whoever comes to it with the keyboard, by what its card says of it", async () => {
    renderCanvas({
      progress: { filter: { state: "Completed", inputRows: 3, outputRows: 2 } },
      problems: { limit: "Limit is not set." },
    });

    // After what React Flow says of every node: how it is selected, moved and removed.
    expect(await card("Filter")).toHaveAccessibleDescription(/select a node.*mass > 3600.*Completed.*3 → 2 rows$/);
    expect(await card("Limit")).toHaveAccessibleDescription(/select a node.*Limit 5.*Limit is not set\.$/);
  });
});

/** The settings a card says each on a line of its own: each one's name, and what it is set to. */
const settingsOf = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("term")
    .map(term => [term.textContent, term.nextElementSibling?.textContent]);

describe("how much a card says", () => {
  it("says the settings in one line, and none by its name, unless every setting is shown", async () => {
    renderCanvas();

    expect(settingsOf(await card("CSV File Scan"))).toEqual([]);
  });

  it("says each setting on a line of its own, by its name, when every setting is shown", async () => {
    const named = { ...operator("Limit", "limit", { limit: 5 }), customDisplayName: "First five" };
    renderCanvas({ content: workflowContent([...penguins.operators.slice(0, 2), named]), density: "detailed" });

    expect(settingsOf(await card("CSV File Scan"))).toEqual([
      ["File", "penguins.csv"],
      ["Limit", "10"],
    ]);
    expect(settingsOf(await card("Filter"))).toEqual([["Predicates", "mass > 3600"]]);
    // Under a name of its own, the card says its type, which its settings no longer do in one line.
    expect(await card("First five")).toHaveTextContent(/^First fiveLimitLimit5$/);
    expect(await card("Filter")).toHaveTextContent(/^FilterPredicates/);
  });
});

describe("an operator card's buttons", () => {
  it("keep the operator's result, or stop keeping it, with its eye", async () => {
    const onPatch = vi.fn();
    const content = workflowContent([
      { ...operator("Limit", "limit", { limit: 5 }), viewResult: true },
      operator("Filter", "filter"),
    ]);
    const { user } = renderCanvas({ content, onPatch });

    const kept = within(await card("Limit")).getByRole("button", { name: "Keep the result of Limit" });
    expect(kept).toHaveAttribute("aria-pressed", "true");
    await user.click(kept);
    expect(onPatch).toHaveBeenLastCalledWith("limit", { viewResult: false });
    const notKept = within(await card("Filter")).getByRole("button", { name: "Keep the result of Filter" });
    expect(notKept).toHaveAttribute("aria-pressed", "false");
    await user.click(notKept);
    expect(onPatch).toHaveBeenLastCalledWith("filter", { viewResult: true });
  });

  it("execute the workflow up to the operator, and say why they cannot when they cannot", async () => {
    const start = vi.fn();
    const { user } = renderCanvas({
      executeUpTo: id => (id === "limit" ? { problem: "Limit is not set.", start } : { start }),
    });

    await user.click(within(await card("Filter")).getByRole("button", { name: "Execute up to Filter" }));
    expect(start).toHaveBeenCalledOnce();
    const limit = within(await card("Limit")).getByRole("button", { name: "Execute up to Limit" });
    expect(limit).toHaveAttribute("aria-disabled", "true");
    // It keeps its place among the keys' stops, so that whoever comes to it with the keyboard is told why, and its
    // edge, which shows that it has the keyboard, is not faded with its icon.
    expect(limit).not.toBeDisabled();
    expect(limit).toHaveAccessibleDescription("Limit is not set.");
    expect(limit).toHaveClass("aria-disabled:[&_svg]:opacity-50");
  });

  it("open the operator's card with its pencil", async () => {
    const onEdit = vi.fn();
    const { user } = renderCanvas({ onEdit });

    await user.click(within(await card("Filter")).getByRole("button", { name: "Edit Filter" }));

    expect(onEdit).toHaveBeenCalledExactlyOnceWith("filter");
  });

  it("change nothing on a canvas that is only looked at, and open the card to read", async () => {
    const onEdit = vi.fn();
    const content = workflowContent([{ ...operator("Limit", "limit", { limit: 5 }), viewResult: true }]);
    const { user } = renderCanvas({ content, readOnly: true, onEdit, onPatch: vi.fn() });

    const limit = await card("Limit");
    expect(within(limit).getByRole("button", { name: "Keep the result of Limit" })).toBeDisabled();
    expect(within(limit).queryByRole("button", { name: "Edit Limit" })).not.toBeInTheDocument();
    await user.click(within(limit).getByRole("button", { name: "View Limit" }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("limit");
  });

  it("offer neither executing nor opening where the canvas does neither", async () => {
    renderCanvas();

    const filter = await card("Filter");
    expect(within(filter).getByRole("button", { name: "Keep the result of Filter" })).toBeDisabled();
    expect(within(filter).queryByRole("button", { name: /^(Execute up to|Edit|View) / })).not.toBeInTheDocument();
  });

  it("show on a card that has the keyboard, as on one that is selected, and take the keyboard while not shown", async () => {
    renderCanvas({ onEdit: vi.fn() });

    // jsdom draws nothing: what it tells is that the card and its buttons follow React Flow's node, which takes the
    // keyboard for its card and draws no outline of its own; and that a button not shown is drawn all the same, unseen
    // and taking no room. A browser gives the keyboard to the button after a card only if the button can take it once
    // the card has let go of it, when nothing on the card has the keyboard, and else to nothing. Whether a button is
    // seen is said around it, apart from its own look, which fades a disabled one (the canvas's stories draw both).
    const filter = await card("Filter");
    expect(filter).toHaveClass("group/node");
    const edit = within(filter).getByRole("button", { name: "Edit Filter" });
    const around = edit.parentElement!;
    expect(around).not.toHaveClass("hidden");
    expect(around).toHaveClass(
      "absolute",
      "opacity-0",
      "group-focus-within/node:static",
      "group-focus-within/node:opacity-100"
    );
    expect(edit).not.toHaveClass("opacity-0");
  });

  it("open no card when one of them is double-clicked, nor does a double click in the open card", async () => {
    const onEdit = vi.fn();
    renderCanvas({ editing: "filter", onEdit, onPatch: vi.fn(), card: body });
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    fireEvent.doubleClick(within(await card("Limit")).getByRole("button", { name: "Keep the result of Limit" }));
    fireEvent.doubleClick(within(properties).getByRole("textbox", { name: "Name" }));

    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe("an operator someone else is editing", () => {
  const grace = { clientId: 7, name: "Grace", color: 2, selection: ["filter"] };
  const alan = { clientId: 8, name: "Alan", color: 3, selection: ["filter"] };
  /** Grace holds the Filter: she has its card open to change it. */
  const held = new Map([["filter", grace]]);

  it("says on its card who is editing it, in their color, and does not say again that they have it selected", async () => {
    renderCanvas({ collaborators: [grace, alan], held });

    const filter = await card("Filter");
    const label = within(filter).getByText("Grace").parentElement!;
    expect(within(label).getByText("is editing")).toBeInTheDocument();
    expect(label).toHaveClass("bg-presence-2", "text-white");
    expect(filter.querySelector("[data-selected]")).toHaveClass("border-presence-2");
    const selecting = within(filter).getByRole("list", { name: "Selected by" });
    expect(selecting).toHaveTextContent(/^Alan$/);
    expect(within(selecting).getByRole("listitem")).toHaveClass("bg-presence-3", "text-white");
    // Whoever comes to it with the keyboard is told first, and what it means, which React Flow's own words, of how a
    // node is deleted, do not say.
    expect(filter).toHaveAccessibleDescription(
      /select a node.*Grace is editing, so it cannot be changed or deleted until they are done.*mass > 3600$/
    );
    expect(await card("Limit")).not.toHaveTextContent("is editing");
  });

  it("says who is editing it beside who has it selected, in one line, where a long name is cut short but not what they do", async () => {
    const long = { ...grace, name: "Alexandria Montgomery-Wellington" };
    renderCanvas({ collaborators: [long, alan], held: new Map([["filter", long]]) });

    const filter = await card("Filter");
    const holder = within(filter).getByText(long.name);
    // jsdom lays nothing out: what it tells is that the two share one line, which shares the card's width between
    // them so that neither lies over the other, and which part of the notice gives way.
    expect(holder.parentElement!.parentElement).toBe(
      within(filter).getByRole("list", { name: "Selected by" }).parentElement
    );
    expect(holder).toHaveClass("truncate");
    expect(within(filter).getByText("is editing")).toHaveClass("shrink-0");
  });

  it("opens to read, and keeps no result, saying who is editing it, but executes the workflow up to it", async () => {
    const [onEdit, onPatch, start] = [vi.fn(), vi.fn(), vi.fn()];
    const { user } = renderCanvas({ held, onEdit, onPatch, executeUpTo: () => ({ start }) });
    const filter = await card("Filter");

    // Its pencil opens it to read, and says who is changing it meanwhile.
    expect(within(filter).queryByRole("button", { name: "Edit Filter" })).not.toBeInTheDocument();
    const view = within(filter).getByRole("button", { name: "View Filter" });
    expect(view).not.toHaveAttribute("aria-disabled", "true");
    expect(view).toHaveAccessibleDescription("Grace is editing");
    await user.click(view);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("filter");
    const keep = within(filter).getByRole("button", { name: "Keep the result of Filter" });
    expect(keep).toHaveAttribute("aria-disabled", "true");
    expect(keep).toHaveAccessibleDescription("Grace is editing");
    // Its icon fades, and its edge, which shows where the keyboard is, stays as it is.
    expect(keep).toHaveClass("aria-disabled:[&_svg]:opacity-50");
    await user.click(keep);
    await user.click(within(filter).getByRole("button", { name: "Execute up to Filter" }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    // The others open to change, as ever.
    await user.click(within(await card("Limit")).getByRole("button", { name: "Edit Limit" }));
    expect(onEdit).toHaveBeenLastCalledWith("limit");
  });

  it("opens to read on a canvas that is only looked at too, saying who is editing it", async () => {
    const onEdit = vi.fn();
    const { user } = renderCanvas({ held, readOnly: true, onEdit, onPatch: vi.fn() });
    const filter = await card("Filter");
    expect(filter).toHaveTextContent("Grace is editing");

    const view = within(filter).getByRole("button", { name: "View Filter" });
    expect(view).toHaveAccessibleDescription("Grace is editing");
    await user.click(view);

    expect(onEdit).toHaveBeenCalledExactlyOnceWith("filter");
  });

  it("changes nothing from a card open to read, while they edit it and once they are done", async () => {
    const [onPatch, start] = [vi.fn(), vi.fn()];
    const { user, redraw } = renderCanvas({
      held,
      editing: "filter",
      openToRead: true,
      onEdit: vi.fn(),
      onPatch,
      card: body,
      executeUpTo: () => ({ start }),
    });
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    expect(await card("Filter")).toHaveTextContent("Grace is editing");
    expect(within(properties).getByRole("textbox", { name: "Name" })).toBeDisabled();
    const keep = within(properties).getByRole("button", { name: "Keep the result of Filter" });
    expect(keep).toBeDisabled();
    expect(keep).toHaveAccessibleDescription("Grace is editing");
    await user.click(within(properties).getByRole("button", { name: "Execute up to Filter" }));
    expect(start).toHaveBeenCalledOnce();
    // A card opened to read stays so: it is opened again to change its operator.
    redraw({ held: new Map() });
    expect(await card("Filter")).not.toHaveTextContent("is editing");
    expect(within(properties).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(properties).getByRole("button", { name: "Keep the result of Filter" })).toBeDisabled();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("draws the others' pointers with their names in white on their colors, as every label of theirs", async () => {
    renderCanvas({ collaborators: [{ ...grace, pointer: { x: 10, y: 10 } }] });

    const pointer = await screen.findByRole("img", { name: "Pointer of Grace" });

    expect(within(pointer).getByText("Grace")).toHaveClass("bg-presence-2", "text-white");
  });

  it("stays on the canvas when Delete is pressed on it, which removes the rest of what is selected", async () => {
    const onRemove = vi.fn();
    const { user } = renderCanvas({ held, onRemove, shown: ["filter"] });

    (await card("Filter")).focus();
    await user.keyboard("{Delete}{Backspace}");
    expect(onRemove).not.toHaveBeenCalled();

    await user.keyboard("{Control>}a{/Control}{Delete}");
    await waitFor(() =>
      expect(onRemove).toHaveBeenCalledExactlyOnceWith({
        operators: ["scan", "limit"],
        commentBoxes: [],
        links: penguins.links.map(each => each.linkID),
      })
    );
  });
});

/**
 * What the editor puts in an open card in these tests: a switch, and a list of choices, as a property's are, which
 * opens apart from the card, under the page's body.
 */
const body = () => (
  <>
    <Checkbox aria-label="Header" />
    <Select>
      <SelectTrigger aria-label="Condition">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {["=", ">", "<"].map(condition => (
          <SelectItem
            key={condition}
            value={condition}>
            {condition}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </>
);

describe("opening an operator's card", () => {
  it("opens the card of the operator that has the keyboard with Enter, as Enter selects it, and not with Space", async () => {
    const onEdit = vi.fn();
    const onSelect = vi.fn();
    const { user } = renderCanvas({ onEdit, onSelect });

    (await card("Filter")).focus();
    await user.keyboard(" ");
    expect(onEdit).not.toHaveBeenCalled();
    // With Ctrl, Enter adds to what is selected, or takes the operator out of it, as React Flow has it.
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onEdit).not.toHaveBeenCalled();
    // React Flow lets go of the keyboard of an operator it took out of the selection a frame later.
    await waitFor(async () => expect(await card("Filter")).not.toHaveFocus());
    (await card("Filter")).focus();
    await user.keyboard("{Enter}");

    expect(onEdit).toHaveBeenCalledExactlyOnceWith("filter");
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ operators: ["filter"] }));
  });

  it("opens the card of an operator that is double-clicked", async () => {
    const onEdit = vi.fn();
    renderCanvas({ onEdit });

    // The press of a click would start a drag, which jsdom cannot do: the click itself is sent, as the browser does.
    fireEvent.doubleClick(await card("Limit"));

    expect(onEdit).toHaveBeenLastCalledWith("limit");
  });

  it("holds the operator's settings in the open card, named for it, with its name to change", async () => {
    const onPatch = vi.fn();
    const { user } = renderCanvas({ editing: "filter", onEdit: vi.fn(), onPatch, card: body });

    const properties = await screen.findByRole("region", { name: "Properties of Filter" });
    expect(within(properties).getByRole("checkbox", { name: "Header" })).toBeInTheDocument();
    expect(within(properties).getByRole("button", { name: "Keep the result of Filter" })).toBeInTheDocument();
    expect(within(await card("Filter")).queryByRole("button", { name: "Edit Filter" })).not.toBeInTheDocument();
    // The other cards stay closed.
    expect(screen.getAllByRole("region")).toHaveLength(1);
    const name = within(properties).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("Filter");

    await user.type(name, "s");
    expect(onPatch).toHaveBeenLastCalledWith("filter", { customDisplayName: "Filters" });
    // A name that is cleared is no name: the operator goes by its type's again.
    await user.clear(name);
    expect(onPatch).toHaveBeenLastCalledWith("filter", { customDisplayName: undefined });
  });

  it("takes the keyboard when it opens", async () => {
    renderCanvas({ editing: "filter", onEdit: vi.fn(), card: body });

    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    await waitFor(() => expect(properties).toHaveFocus());
  });

  it("gives its first setting the keyboard when its operator was just added", async () => {
    renderCanvas({ editing: "filter", justAdded: true, onEdit: vi.fn(), card: body });

    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    await waitFor(() => expect(within(properties).getByRole("checkbox", { name: "Header" })).toHaveFocus());
  });

  it("says the type of its operator under its name only where the name does not say it", async () => {
    const named = { ...operator("Limit", "limit", { limit: 5 }), customDisplayName: "First five" };
    const { redraw } = renderCanvas({
      content: workflowContent([operator("Filter", "filter"), named]),
      editing: "filter",
      onEdit: vi.fn(),
      card: () => null,
    });

    // The name it was given when it was added is its type's.
    expect(await screen.findByRole("region", { name: "Properties of Filter" })).not.toHaveTextContent("Filter");
    redraw({ editing: "limit" });
    expect(await screen.findByRole("region", { name: "Properties of First five" })).toHaveTextContent(/^Limit/);
  });

  it("says why the workflow cannot be executed up to its operator, unless what is wrong with it is said already", async () => {
    const executeUpTo = () => ({ problem: "An execution is under way.", start: vi.fn() });
    const { redraw } = renderCanvas({ editing: "filter", onEdit: vi.fn(), card: body, executeUpTo });

    expect(await screen.findByRole("region", { name: "Properties of Filter" })).toHaveTextContent(
      "An execution is under way."
    );
    // The editor puts what is wrong with the operator in the card, with its settings.
    redraw({
      problems: { filter: "Predicates is not set." },
      executeUpTo: () => ({ problem: "Predicates is not set.", start: vi.fn() }),
    });
    expect(screen.getByRole("region", { name: "Properties of Filter" })).not.toHaveTextContent("not set");
  });

  it("closes the open card with Done, and with Escape, and gives the keyboard back to its card", async () => {
    const onEdit = vi.fn();
    const { user } = renderCanvas({ editing: "filter", onEdit, card: body });
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    await user.click(within(properties).getByRole("button", { name: "Done" }));
    expect(onEdit).toHaveBeenLastCalledWith(undefined);
    expect(await card("Filter")).toHaveFocus();

    onEdit.mockClear();
    within(properties).getByRole("checkbox", { name: "Header" }).focus();
    await user.keyboard("{Escape}");
    expect(onEdit).toHaveBeenLastCalledWith(undefined);
    expect(await card("Filter")).toHaveFocus();
  });

  it("stays open on an Escape that closed something inside it, such as a list of choices", async () => {
    const onEdit = vi.fn();
    const { user } = renderCanvas({ editing: "filter", onEdit, card: body });
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    await user.click(within(properties).getByRole("combobox", { name: "Condition" }));
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(onEdit).not.toHaveBeenCalled();
    expect(within(properties).getByRole("combobox", { name: "Condition" })).toHaveFocus();
  });

  it("closes with Escape on its operator, and gives the keyboard to the card with Enter there", async () => {
    const onEdit = vi.fn();
    const { user } = renderCanvas({ editing: "filter", onEdit, card: body });
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    (await card("Filter")).focus();
    await user.keyboard("{Enter}");
    expect(properties).toHaveFocus();
    expect(onEdit).not.toHaveBeenCalled();

    (await card("Filter")).focus();
    await user.keyboard("{Escape}");
    expect(onEdit).toHaveBeenLastCalledWith(undefined);
    expect(await card("Filter")).toHaveFocus();
  });

  it("gives the keyboard back to its operator, or else to the canvas, when it closes while it has it", async () => {
    const { redraw } = renderCanvas({ editing: "filter", onEdit: vi.fn(), card: body });
    const name = () =>
      within(screen.getByRole("region", { name: "Properties of Filter" })).getByRole("textbox", { name: "Name" });
    await screen.findByRole("region", { name: "Properties of Filter" });

    name().focus();
    // Closed by something else than this user, as when someone else takes it.
    redraw({ editing: undefined });
    await waitFor(async () => expect(await card("Filter")).toHaveFocus());

    redraw({ editing: "filter" });
    await screen.findByRole("region", { name: "Properties of Filter" });
    name().focus();
    // Its operator is gone, as when someone else deletes it.
    redraw({ content: workflowContent(penguins.operators.filter(each => each.operatorID !== "filter")) });
    await waitFor(() => expect(screen.getByLabelText("Workflow canvas")).toHaveFocus());
  });

  it("closes the open card when the empty canvas is clicked", async () => {
    const onEdit = vi.fn();
    renderCanvas({ editing: "filter", onEdit, card: body });
    await screen.findByRole("region", { name: "Properties of Filter" });

    fireEvent.click(screen.getByLabelText("Workflow canvas").querySelector<HTMLElement>(".react-flow__pane")!);

    expect(onEdit).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps the keys pressed in the open card from acting on the canvas: none removes the operator", async () => {
    const onRemove = vi.fn();
    const onSelect = vi.fn();
    const { user } = renderCanvas({
      editing: "scan",
      shown: ["scan"],
      onEdit: vi.fn(),
      onRemove,
      onSelect,
      card: body,
    });
    const properties = await screen.findByRole("region", { name: "Properties of CSV File Scan" });
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ operators: ["scan"] })));
    onSelect.mockClear();

    within(properties).getByRole("checkbox", { name: "Header" }).focus();
    await user.keyboard("{Backspace}{Delete}{Control>}a{/Control}");
    within(properties).getByRole("textbox", { name: "Name" }).focus();
    await user.keyboard("{Backspace}");

    expect(onRemove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    // The same key, on the card itself, removes what is selected.
    (await card("CSV File Scan")).focus();
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ operators: ["scan"] })));
  });

  it("keeps the keys pressed in what its fields open, as a list of choices, from acting on the canvas", async () => {
    const [onRemove, onSelect, onEdit, around] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const { user } = renderCanvas(
      { editing: "scan", shown: ["scan"], onEdit, onRemove, onSelect, card: body },
      { onKeyDown: around }
    );
    const properties = await screen.findByRole("region", { name: "Properties of CSV File Scan" });
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ operators: ["scan"] })));
    const place = (await card("CSV File Scan")).style.transform;
    onSelect.mockClear();

    await user.click(within(properties).getByRole("combobox", { name: "Condition" }));
    await screen.findByRole("listbox");
    // The list is drawn under the page's body, out of the card, though it is the card's.
    await user.keyboard("{ArrowDown}{ArrowDown}{Backspace}{Delete}{Control>}a{/Control}{Control>}d{/Control}{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

    expect(onRemove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    // Ctrl held down is told on, as the canvas follows it; what is pressed with it is not.
    const passed = around.mock.calls.map(([event]) => (event as KeyboardEvent).key);
    expect(passed.filter(key => key !== "Control")).toEqual([]);
    expect((await card("CSV File Scan")).style.transform).toBe(place);
  });

  it("lets the canvas know of a key held down in it, as Ctrl, which adds the operator chosen next to the selection", async () => {
    const onSelect = vi.fn();
    const { user } = renderCanvas({ editing: "filter", shown: ["filter"], onEdit: vi.fn(), onSelect, card: body });
    const properties = await screen.findByRole("region", { name: "Properties of Filter" });
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ operators: ["filter"] })));

    within(properties).getByRole("textbox", { name: "Name" }).focus();
    await user.keyboard("{Control>}");
    (await card("Limit")).focus();
    await user.keyboard("{Enter}{/Control}");

    await waitFor(() =>
      expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ operators: ["filter", "limit"] }))
    );
  });

  it("keeps what is copied, cut, pasted and right-clicked in it its own, and the browser's", async () => {
    const [menu, copy, cut, paste] = [vi.fn(() => null), vi.fn(), vi.fn(), vi.fn()];
    renderCanvas(
      { editing: "filter", onEdit: vi.fn(), card: body, menu },
      { onCopy: copy, onCut: cut, onPaste: paste }
    );
    const name = within(await screen.findByRole("region", { name: "Properties of Filter" })).getByRole("textbox", {
      name: "Name",
    });

    fireEvent.copy(name);
    fireEvent.cut(name);
    fireEvent.paste(name);
    // The browser's own menu, which pastes into a field and spells, opens where nothing keeps it from opening.
    expect(fireEvent.contextMenu(name)).toBe(true);

    expect([copy, cut, paste, menu].map(each => each.mock.calls.length)).toEqual([0, 0, 0, 0]);
    // On a closed card, the canvas's menu opens as ever.
    fireEvent.contextMenu(await card("Limit"));
    await waitFor(() => expect(menu).toHaveBeenCalled());
  });

  it("lies over every other card while it is open", async () => {
    renderCanvas({ editing: "filter", shown: ["limit"], onEdit: vi.fn(), card: body });
    await screen.findByRole("region", { name: "Properties of Filter" });

    const filter = Number((await card("Filter")).style.zIndex);
    expect(filter).toBeGreaterThan(Number((await card("Limit")).style.zIndex));
    expect(filter).toBeGreaterThan(Number((await card("CSV File Scan")).style.zIndex));
  });

  it("opens the card to read on a canvas that is only looked at", async () => {
    renderCanvas({ editing: "filter", readOnly: true, onEdit: vi.fn(), onPatch: vi.fn(), card: body });

    const properties = await screen.findByRole("region", { name: "Properties of Filter" });

    expect(within(properties).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(properties).getByRole("button", { name: "Done" })).toBeEnabled();
  });
});

describe("the room the cards take", () => {
  /** A column of three cards a row apart, from the second row down, and one beside it in the next column. */
  const column = {
    ...workflowContent(
      (["Open", "Under", "Further", "Beside"] as const).map(name => ({
        ...operator("Limit", name.toLowerCase(), { limit: 5 }),
        customDisplayName: name,
      }))
    ),
    operatorPositions: {
      open: { x: 0, y: 128 },
      under: { x: 0, y: 256 },
      further: { x: 0, y: 384 },
      beside: { x: 320, y: 256 },
    },
  };

  /** Measures each card as tall as `height` says, as a browser would by what it holds: jsdom lays nothing out. */
  function measureCards(height: (card: HTMLElement) => number) {
    const kept = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("react-flow__node") ? height(this) : 60;
      },
    });
    onTestFinished(() => {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", kept);
    });
  }

  /** Where a card is drawn on the canvas. */
  const drawnAt = (element: HTMLElement) => element.style.transform;

  /** Where the pointer of someone else is drawn on the canvas. */
  const pointerOf = (name: string) => screen.getByRole("img", { name: `Pointer of ${name}` }).style.transform;

  /** Where a place on the canvas is on the screen: jsdom lays nothing out, so the canvas starts at the corner. */
  function onScreen({ x, y }: Point) {
    const viewport = screen.getByLabelText("Workflow canvas").querySelector<HTMLElement>(".react-flow__viewport")!;
    const [tx, ty, zoom] = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\((-?[\d.]+)\)/
      .exec(viewport.style.transform)!
      .slice(1)
      .map(Number);
    return { clientX: tx + x * zoom, clientY: ty + y * zoom };
  }

  /**
   * Drags a card pressed at `from` by `by`, places on the canvas: a little first, which starts the drag, then by `by`
   * from there.
   */
  function drag(element: HTMLElement, from: Point, by: Point) {
    const started = { x: from.x + 10, y: from.y };
    const to = { x: started.x + by.x, y: started.y + by.y };
    dragOnCanvas(element, [onScreen(from), onScreen(started), onScreen(to)]);
  }

  /** The places a drag told the workflow to keep, by operator. */
  const keptOf = (onMove: ReturnType<typeof vi.fn>) => (onMove.mock.lastCall as [Record<string, Point>])[0];

  it("lowers the cards under the open card, in its column, as far as it reaches, and moves none in the workflow", async () => {
    // The open card is tall with its settings; the closed ones fit in their rows.
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    const onMove = vi.fn();
    renderCanvas({ content: column, editing: "open", onEdit: vi.fn(), card: body, onMove });

    // It ends at 128 + 400; the card under it starts 32 after that, and the one further down keeps its row from it.
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 560px)"));
    expect(drawnAt(await card("Further"))).toBe("translate(0px, 688px)");
    expect(drawnAt(await card("Beside"))).toBe("translate(320px, 256px)");
    expect(drawnAt(await card("Open"))).toBe("translate(0px, 128px)");
    expect(onMove).not.toHaveBeenCalled();
  });

  /** The column, where the card under the open one reads a version of a dataset, which its chip above it names. */
  const reading = {
    ...column,
    operators: column.operators.map(each =>
      each.operatorID === "under"
        ? {
            ...operator("CSVFileScan", "under", { fileName: "/dataset/texera/penguins/v1/penguins.csv" }),
            customDisplayName: "Under",
          }
        : each
    ),
  };

  it("lowers the cards under the open card far enough that the chips above them clear its room", async () => {
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    renderCanvas({ content: reading, editing: "open", onEdit: vi.fn(), card: body });

    // The rows are a quarter further apart, for a card and the chip above it: the open card starts at 160, and ends at
    // 560; the chip above the card under it starts 32 after that, and its card a chip and its gap further down.
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 650px)"));
    expect(chipAt(await screen.findByRole("button", { name: "penguins v1" }))).toBe("translate(24px, 592px)");
    expect(drawnAt(await card("Further"))).toBe("translate(0px, 810px)");
    expect(drawnAt(await card("Beside"))).toBe("translate(320px, 320px)");
    expect(drawnAt(await card("Open"))).toBe("translate(0px, 160px)");
  });

  it("keeps a card dragged under the open card at its place in the workflow, counting the chip above it", async () => {
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    const onMove = vi.fn();
    renderCanvas({ content: reading, editing: "open", onEdit: vi.fn(), card: body, onMove });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 650px)"));

    drag(await card("Under"), { x: 10, y: 660 }, { x: 50, y: 0 });

    // Drawn 330 lower to make room for the open card and the chip above it, it is kept in its row, with the rows as
    // the workflow keeps them.
    const { under } = keptOf(onMove);
    expect(under.x).toBeCloseTo(50);
    expect(under.y).toBeCloseTo(256);
  });

  it("draws the others' pointers over what they point at while a card is open, counting the chips", async () => {
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    const grace = { clientId: 7, name: "Grace", color: 2, selection: [], pointer: { x: 10, y: 266 } };
    renderCanvas({ content: reading, editing: "open", onEdit: vi.fn(), card: body, collaborators: [grace] });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 650px)"));

    // Grace points 10 into the card under the open one, which is drawn at 650: 12.5 into it here, where the rows are a
    // quarter further apart.
    expect(pointerOf("Grace")).toBe("translate(10px, 662.5px)");
  });

  it("says where under the open card it was right-clicked as the workflow keeps places, counting the chips", async () => {
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    const menu = vi.fn(() => null);
    renderCanvas({ content: reading, editing: "open", onEdit: vi.fn(), card: body, menu });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 650px)"));

    fireEvent.contextMenu(
      screen.getByLabelText("Workflow canvas").querySelector(".react-flow__pane")!,
      onScreen({ x: 100, y: 700 })
    );

    // 50 into the card under the open one, which is drawn at 650 and kept at 256: 40 into it as it is kept.
    await waitFor(() => expect(menu).toHaveBeenCalled());
    const [{ at }] = menu.mock.lastCall as unknown as [{ at: Point }];
    expect(at.x).toBeCloseTo(100);
    expect(at.y).toBeCloseTo(296);
  });

  it("makes no room for chips that the viewer hides, and draws none", async () => {
    measureCards(() => 64);
    const { redraw } = renderCanvas({ content: reading });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 320px)"));

    redraw({ chips: false, results: { under: { kind: "table", totalRows: 3, revision: 1 } } });

    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 256px)"));
    expect(screen.queryByRole("button", { name: /penguins|Result/ })).not.toBeInTheDocument();
    expect(chipLines()).toEqual([]);
  });

  it("keeps a card dragged under the open card at its place in the workflow, not where it is drawn", async () => {
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    const onMove = vi.fn();
    renderCanvas({ content: column, editing: "open", onEdit: vi.fn(), card: body, onMove });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 560px)"));

    drag(await card("Under"), { x: 10, y: 570 }, { x: 50, y: 0 });

    // Drawn 304 lower to make room for the open card, it is kept in its row.
    const { under } = keptOf(onMove);
    expect(under.x).toBeCloseTo(50);
    expect(under.y).toBeCloseTo(256);
  });

  it("moves a card that someone else is editing, as any other: where it stands is not theirs alone", async () => {
    measureCards(() => 64);
    const onMove = vi.fn();
    const grace = { clientId: 7, name: "Grace", color: 2, selection: [] };
    renderCanvas({ content: column, held: new Map([["under", grace]]), onMove });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 256px)"));

    drag(await card("Under"), { x: 10, y: 266 }, { x: 50, y: 0 });

    const { under } = keptOf(onMove);
    expect(under.x).toBeCloseTo(50);
    expect(under.y).toBeCloseTo(256);
  });

  it("keeps a card dragged while the rows are drawn further apart at its place with the rows as they are kept", async () => {
    measureCards(() => 220);
    const onMove = vi.fn();
    renderCanvas({ content: column, onMove });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 512px)"));

    drag(await card("Under"), { x: 10, y: 522 }, { x: 50, y: 40 });

    const { under } = keptOf(onMove);
    expect(under.x).toBeCloseTo(50);
    expect(under.y).toBeCloseTo((512 + 40) / 2);
  });

  it("draws the others' pointers over what they point at while a card is open", async () => {
    measureCards(node => (node.querySelector("section") ? 400 : 64));
    const grace = { clientId: 7, name: "Grace", color: 2, selection: [], pointer: { x: 10, y: 266 } };
    const alan = { clientId: 8, name: "Alan", color: 3, selection: [], pointer: { x: 10, y: 160 } };
    renderCanvas({ content: column, editing: "open", onEdit: vi.fn(), card: body, collaborators: [grace, alan] });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 560px)"));

    // Grace points 10 into the card under the open one, which is drawn 304 lower.
    expect(pointerOf("Grace")).toBe("translate(10px, 570px)");
    // Alan points halfway down the open card's operator as it is kept: here, a quarter of the way down the room the
    // open card takes, on it.
    expect(pointerOf("Alan")).toBe("translate(10px, 236px)");
  });

  it("draws the rows further apart while the cards are taller than a row holds, and the others' pointers with them", async () => {
    measureCards(() => 220);
    const grace = { clientId: 7, name: "Grace", color: 2, selection: [], pointer: { x: 40, y: 100 } };
    renderCanvas({ content: column, collaborators: [grace] });

    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 512px)"));
    expect(drawnAt(await card("Open"))).toBe("translate(0px, 256px)");
    expect(drawnAt(await card("Further"))).toBe("translate(0px, 768px)");
    expect(drawnAt(await card("Beside"))).toBe("translate(320px, 512px)");
    expect(pointerOf("Grace")).toBe("translate(40px, 200px)");
  });

  it("says where on the canvas it was right-clicked as the workflow keeps places, not as they are drawn", async () => {
    measureCards(() => 220);
    const menu = vi.fn(() => null);
    renderCanvas({ content: column, menu });
    await waitFor(async () => expect(drawnAt(await card("Under"))).toBe("translate(0px, 512px)"));

    fireEvent.contextMenu(
      screen.getByLabelText("Workflow canvas").querySelector(".react-flow__pane")!,
      onScreen({ x: 100, y: 400 })
    );

    await waitFor(() => expect(menu).toHaveBeenCalled());
    const [{ at }] = menu.mock.lastCall as unknown as [{ at: Point }];
    expect(at.x).toBeCloseTo(100);
    expect(at.y).toBeCloseTo(200);
  });
});

describe("the chips around the cards", () => {
  /** A UDF's parameter as it is kept, given a version of a resource when its input type says so. */
  const parameter = (attributeName: string, value: string, inputType?: string) => ({
    attribute: { attributeName, attributeType: "string" },
    value,
    ...(inputType && { inputType }),
  });

  /** What the execution shown kept: Limit's rows, and Filter's picture. */
  const results = {
    limit: { kind: "table", totalRows: 2, revision: 1 },
    filter: { kind: "visualization", html: "<p>Bars</p>", revision: 1 },
  } as const;

  it("shows above a card the version its operator reads, centered on it and joined to it by a dashed line", async () => {
    renderCanvas();

    // The scan stands at the top left, and reads a file of version v1 of the dataset penguins.
    const penguins = await screen.findByRole("button", { name: "penguins v1" });
    expect(chipAt(penguins)).toBe("translate(24px, -58px)");
    const [line] = chipLines();
    expect(chipLines()).toHaveLength(1);
    // Neither an arrow nor something to select: what a chip names is no step of the workflow.
    expect(line.querySelector("path")).toHaveStyle({ strokeDasharray: "4 4" });
    expect(line.querySelector("path")).not.toHaveAttribute("marker-end");
    expect(line).not.toHaveClass("selectable");
  });

  it("shows a chip for each version a UDF's parameters take, the first nearest its card, and none for a bare name", async () => {
    const udf = operator("PythonUDFV2", "udf", {
      uiParameters: [
        parameter("weights", "/model/texera/resnet/v3", "model"),
        parameter("birds", "/dataset/texera/penguins/v1", "dataset"),
        parameter("greeting", "hello"),
      ],
    });
    renderCanvas({ content: workflowContent([udf, operator("CSVFileScan", "scan", { fileName: "penguins.csv" })]) });

    expect(chipAt(await screen.findByRole("button", { name: "resnet v3" }))).toBe("translate(24px, -58px)");
    expect(chipAt(screen.getByRole("button", { name: "penguins v1" }))).toBe("translate(24px, -116px)");
    expect(chipLines()).toHaveLength(2);
  });

  it("puts each kept result under its card's right edge, joined to its output, and shows it when it is clicked", async () => {
    const onShowResult = vi.fn();
    const { user } = renderCanvas({ results, onShowResult });

    const limit = await screen.findByRole("button", { name: "Result of Limit: 2 rows" });
    // Limit stands at 600, and is drawn 60 high here: its result is under the right edge of a card, at 848.
    expect(chipAt(limit)).toBe("translate(790px, 82px)");
    // Its title says the rows too, which a chip cuts short from a million on.
    expect(limit).toHaveAccessibleDescription("Show the result of Limit: 2 rows");
    // A ring as strong as the app's other rings shows that it has the keyboard, against the canvas, in both themes.
    expect(limit).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring");
    expect(chipAt(screen.getByRole("button", { name: "Result of Filter: Visualization" }))).toBe(
      "translate(490px, 82px)"
    );
    expect(chipLines()).toHaveLength(3);

    await user.click(limit);
    expect(onShowResult).toHaveBeenCalledExactlyOnceWith("limit");
  });

  it("draws each chip's line under its own card, open or closed, so that the card covers what of it crosses the card", async () => {
    renderCanvas({ results, editing: "limit", onEdit: vi.fn(), card: body });
    await screen.findByRole("region", { name: "Properties of Limit" });

    /** How high something lies on the canvas: of two as high, the one drawn later, as a card is after every line. */
    const heightOf = (element: Element) => Number((element as HTMLElement).style.zIndex);
    const lineHeight = (id: string) =>
      heightOf(screen.getByLabelText("Workflow canvas").querySelector(`[data-id="${id}"]`)!.closest("svg")!);
    // The open card is wider than the place of its result, under the right edge of a closed card, so its line runs
    // across the card.
    expect(lineHeight("limit:result:line")).toBeLessThanOrEqual(heightOf(await card("Limit")));
    expect(lineHeight("scan:resource:0:line")).toBeLessThanOrEqual(heightOf(await card("CSV File Scan")));
    expect(lineHeight("filter:result:line")).toBeLessThanOrEqual(heightOf(await card("Filter")));
  });

  it("never selects, removes or counts a chip or its line, which are no part of the workflow", async () => {
    const [onSelect, onRemove] = [vi.fn(), vi.fn()];
    const { user } = renderCanvas({ results, onSelect, onRemove });
    await screen.findByRole("button", { name: "penguins v1" });

    (await card("Filter")).focus();
    await user.keyboard("{Control>}a{/Control}");
    const workflow = {
      operators: ["scan", "filter", "limit"],
      commentBoxes: [],
      links: penguins.links.map(each => each.linkID),
    };
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(workflow));
    await user.keyboard("{Delete}");

    await waitFor(() => expect(onRemove).toHaveBeenCalledExactlyOnceWith(workflow));
  });

  it("takes a card's chips away with the card when it is deleted, leaving none behind on its own", async () => {
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());
    const onRemove = vi.fn();
    const { user } = renderCanvas({ results: { scan: { kind: "table", totalRows: 3, revision: 1 } }, onRemove });
    await screen.findByRole("button", { name: "Result of CSV File Scan: 3 rows" });

    (await card("CSV File Scan")).focus();
    await user.keyboard("{Enter}{Delete}");

    await waitFor(() => expect(onRemove).toHaveBeenCalled());
    // React Flow says so of a chip whose card it no longer has.
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/^Parent node .* not found/));
  });

  it("leaves the chips' buttons where the keyboard goes, each after its card's own", async () => {
    const { user } = renderCanvas({ results, onEdit: vi.fn(), onPatch: vi.fn() });
    await screen.findByRole("button", { name: "penguins v1" });

    (await card("CSV File Scan")).focus();
    const reached: string[] = [];
    for (let step = 0; step < 6; step++) {
      await user.tab();
      const focused = document.activeElement!;
      reached.push(focused.getAttribute("aria-label") ?? focused.textContent ?? "");
    }

    expect(reached).toEqual([
      "Keep the result of CSV File Scan",
      "Edit CSV File Scan",
      "penguins v1",
      "Filter",
      "Keep the result of Filter",
      "Edit Filter",
    ]);
  });

  it("keeps what is pressed and right-clicked on a chip, or in what it opens, its own", async () => {
    signInAs(admin);
    const [onSelect, onRemove, menu] = [vi.fn(), vi.fn(), vi.fn(() => null)];
    const { user } = renderCanvas({ shown: ["filter"], onSelect, onRemove, menu });
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ operators: ["filter"] })));
    onSelect.mockClear();
    const penguins = await screen.findByRole("button", { name: "penguins v1" });

    penguins.focus();
    await user.keyboard("{Delete}{Backspace}");
    // The browser's own menu opens where nothing keeps it from opening.
    expect(fireEvent.contextMenu(penguins)).toBe(true);
    await user.click(penguins);
    await screen.findByRole("dialog", { name: "penguins" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(onRemove).not.toHaveBeenCalled();
    expect(menu).not.toHaveBeenCalled();
    // Escape closed the chip, and left the Filter selected.
    expect(onSelect).not.toHaveBeenCalled();
  });

  /** The keys that reached the editor around the canvas, but those held down while others are pressed. */
  const passedOf = (around: ReturnType<typeof vi.fn>) =>
    around.mock.calls.map(([event]) => (event as KeyboardEvent).key).filter(key => key !== "Control");

  it.each(["penguins v1", "Result of Limit: 2 rows"])(
    "selects every operator with Ctrl+A on the chip %s, and leaves Ctrl+D to the editor, as a card's buttons do",
    async name => {
      const [onSelect, around] = [vi.fn(), vi.fn()];
      const { user } = renderCanvas({ results, onShowResult: vi.fn(), onSelect }, { onKeyDown: around });

      (await screen.findByRole("button", { name })).focus();
      await user.keyboard("{Control>}a{/Control}{Control>}d{/Control}");

      // Not the whole page's text, nor a bookmark of it, as the browser would have them.
      await waitFor(() =>
        expect(onSelect).toHaveBeenLastCalledWith({
          operators: ["scan", "filter", "limit"],
          commentBoxes: [],
          links: penguins.links.map(each => each.linkID),
        })
      );
      expect(passedOf(around)).toEqual(["a", "d"]);
    }
  );

  it("keeps Ctrl+A and Ctrl+D pressed in what a chip opens its own, as a list a field of an open card opens does", async () => {
    signInAs(admin);
    const [onSelect, around] = [vi.fn(), vi.fn()];
    const { user } = renderCanvas({ onSelect }, { onKeyDown: around });
    await user.click(await screen.findByRole("button", { name: "penguins v1" }));
    await screen.findByRole("dialog", { name: "penguins" });
    onSelect.mockClear();
    around.mockClear();

    await user.keyboard("{Control>}a{/Control}{Control>}d{/Control}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(passedOf(around)).toEqual([]);
  });

  it("looks a chip's version up among what the canvas says: what the user may read, or what is public", async () => {
    signInAs(admin);
    const searched: string[] = [];
    server.use(http.get("/api/dashboard/:search", ({ params }) => void searched.push(String(params.search))));
    const { user, redraw } = renderCanvas();

    await user.click(await screen.findByRole("button", { name: "penguins v1" }));
    await within(await screen.findByRole("dialog")).findByText("Not found, or you cannot read it.");
    await user.keyboard("{Escape}");
    redraw({ resourceScope: "public" });
    await user.click(screen.getByRole("button", { name: "penguins v1" }));
    await within(await screen.findByRole("dialog")).findByText("Not found, or you cannot read it.");

    expect(searched).toEqual(["search", "publicSearch"]);
  });

  /**
   * Gives the canvas a browser's sizes, which jsdom does not lay out: the canvas as large as `canvas`, and cards and
   * chips as they are drawn.
   */
  function measure(canvas: { width: number; height: number }) {
    const sizeOf = (element: HTMLElement) =>
      element.classList.contains("react-flow__renderer")
        ? canvas
        : element.classList.contains("react-flow__node-operator")
          ? { width: 248, height: 64 }
          : { width: 200, height: 36 };
    const kept = ["offsetWidth", "offsetHeight"].map(
      name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!] as const
    );
    Object.defineProperties(HTMLElement.prototype, {
      offsetWidth: {
        configurable: true,
        get: function (this: HTMLElement) {
          return sizeOf(this).width;
        },
      },
      offsetHeight: {
        configurable: true,
        get: function (this: HTMLElement) {
          return sizeOf(this).height;
        },
      },
    });
    onTestFinished(() => {
      for (const [name, descriptor] of kept) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    });
  }

  /** How the canvas is moved and zoomed, as React Flow says it on its viewport. */
  const viewportOf = () =>
    screen.getByLabelText("Workflow canvas").querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;

  /** Fits the workflow into view as the canvas does when it starts, once everything on it is measured. */
  async function fit(user: ReturnType<typeof renderCanvas>["user"]) {
    // A browser measures it all at once; jsdom, at the first fit, has not measured the chips.
    await user.click(screen.getByRole("button", { name: "Zoom In" }));
    await waitFor(() => expect(viewportOf()).toMatch(/scale\(1\.2\)/));
    await user.click(screen.getByRole("button", { name: "Fit View" }));
  }

  it("fits the workflow's cards into view, and makes room around them for their chips", async () => {
    measure({ width: 1200, height: 300 });
    const { user } = renderCanvas({ content: workflowContent([penguins.operators[0]]) });
    await screen.findByRole("button", { name: "penguins v1" });

    await fit(user);

    // The card alone is fitted, as large as it is: centered across, and down from the top by the fit's gap and the 58
    // that its chip stands over it, which centering it in the 300 would not leave.
    await waitFor(() => expect(viewportOf()).toBe("translate(476px, 122px) scale(1)"));
  });

  it("makes room under a card and beside it for the chip of its result when it fits the workflow into view", async () => {
    measure({ width: 440, height: 280 });
    const { user } = renderCanvas({
      content: workflowContent([penguins.operators[2]]),
      results: { limit: { kind: "table", totalRows: 2, revision: 1 } },
    });
    await screen.findByRole("button", { name: "Result of Limit: 2 rows" });

    await fit(user);

    // Centered, the card would leave 96 on each side and 108 under it. Its result stands 52 under it, from 58 short of
    // its right edge to 58 past it: the fit's gap and that much more are left on the right and under it.
    await waitFor(() => expect(viewportOf()).toBe("translate(70px, 100px) scale(1)"));
  });

  /** How far the canvas is moved across and down, and how far it is zoomed. */
  function viewOf() {
    const [x, y, zoom] = /translate\((-?[\d.e-]+)px, ?(-?[\d.e-]+)px\) scale\((-?[\d.e-]+)\)/
      .exec(viewportOf())!
      .slice(1)
      .map(Number);
    return { x, y, zoom };
  }

  /** Waits for the canvas to be moved and zoomed so, to within a hundredth of a pixel. */
  const viewBecomes = (expected: { x: number; y: number; zoom: number }) =>
    waitFor(() => {
      const { x, y, zoom } = viewOf();
      expect(x).toBeCloseTo(expected.x);
      expect(y).toBeCloseTo(expected.y);
      expect(zoom).toBeCloseTo(expected.zoom);
    });

  it("brings a chip into view when the keyboard comes to it, at the same zoom, and just as far as it must", async () => {
    measure({ width: 1200, height: 300 });
    const { user } = renderCanvas({
      content: workflowContent([penguins.operators[0]]),
      onEdit: vi.fn(),
      onPatch: vi.fn(),
    });
    await screen.findByRole("button", { name: "penguins v1" });
    await fit(user);
    await waitFor(() => expect(viewportOf()).toBe("translate(476px, 122px) scale(1)"));
    for (let step = 0; step < 4; step++) await user.click(screen.getByRole("button", { name: "Zoom In" }));
    await waitFor(() => expect(viewOf().zoom).toBe(2));
    const { x } = viewOf();
    // Twice as large, the chip, from 58 to 22 above its card, is out of sight above the canvas.
    expect(viewOf().y - 2 * 22).toBeLessThan(0);

    within(await card("CSV File Scan"))
      .getByRole("button", { name: "Keep the result of CSV File Scan" })
      .focus();
    await user.tab();
    await user.tab();

    expect(screen.getByRole("button", { name: "penguins v1" })).toHaveFocus();
    // Down until the chip's top is the slide's gap, 32, under the canvas's top, and no further.
    await viewBecomes({ x, y: 32 + 2 * 58, zoom: 2 });
  });

  it("keeps the chip that has the keyboard in view when a panel is docked over the canvas, as what is selected", async () => {
    measure({ width: 1200, height: 300 });
    /** The area the panels float in, where one is docked over the bottom of the canvas, as tall as `bottom`. */
    const area = (bottom: number) => ({
      room: null,
      size: undefined,
      insets: { ...noInsets, bottom },
      order: [],
      raise: () => {},
      cover: () => {},
    });
    const canvas = (bottom: number) => (
      <AreaContext value={area(bottom)}>
        <WorkflowCanvas
          content={workflowContent([penguins.operators[2]])}
          schemas={schemas}
          results={{ limit: { kind: "table", totalRows: 2, revision: 1 } }}
          onShowResult={vi.fn()}
        />
      </AreaContext>
    );
    const { user, rerender, router } = renderWithProviders(canvas(0));
    const result = await screen.findByRole("button", { name: "Result of Limit: 2 rows" });
    await fit(user);
    // The result stands from 204 to 240 down the canvas.
    await waitFor(() => expect(viewportOf()).toBe("translate(476px, 118px) scale(1)"));

    result.focus();
    // The execution's panel opens over the bottom 150, as when the result is shown.
    rerender(<RouterContextProvider router={router}>{canvas(150)}</RouterContextProvider>);

    // Up until the result ends the slide's gap above the panel, at 118: 122 further.
    await viewBecomes({ x: 476, y: -4, zoom: 1 });
  });
});
