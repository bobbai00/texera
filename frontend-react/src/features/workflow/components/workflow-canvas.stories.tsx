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

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { type Model, resourceLookupQuery, type VersionedKind, versionListQuery } from "@/components/resource/api";
import type { OperatorProgress } from "@/lib/execution/client";
import type { Resource, ResourceVersion } from "@/lib/resource";
import { operatorCard, resourceChip, resultChip } from "@/lib/workflow/canvas-geometry";
import type { Collaborator } from "@/lib/workflow/room";
import { backendRequests, cardOf, drawnCanvas, recordRequests, smallText } from "@/testing/stories";
import { spokenText } from "@/testing/text";
import { inColumns, link, operator, operatorMetadata, workflowContent } from "@/testing/workflow";
import { WorkflowCanvas } from "./workflow-canvas";

const schemas = new Map(operatorMetadata.operators.map(schema => [schema.operatorType, schema]));

/** A file of a dataset of penguins, as the admin keeps it, which a scan reads. */
const penguinsFile = "/dataset/texera/penguins/v1/penguins.csv";

/** The penguins of a file, the heavier ones, and the first five of those: scan -> filter -> limit. */
const penguins = inColumns(
  workflowContent(
    [
      operator("CSVFileScan", "scan", { fileName: penguinsFile, limit: 10 }),
      operator("Filter", "filter", { predicates: [{ attribute: "mass", condition: ">", value: "3600" }] }),
      operator("Limit", "limit", { limit: 5 }),
    ],
    [link("scan", "filter"), link("filter", "limit")]
  ),
  { scan: [0, 0], filter: [1, 0], limit: [2, 0] }
);

/** The penguins workflow with the heavy ones also sorted, under the first five: the filter leads to both. */
const sorted = inColumns(
  {
    ...penguins,
    operators: [...penguins.operators, operator("Sort", "sort")],
    links: [...penguins.links, link("filter", "sort")],
  },
  { scan: [0, 0], filter: [1, 0], limit: [2, 0], sort: [2, 1] }
);

/** Others in the workflow's room, each in their color. */
const grace: Collaborator = { clientId: 7, name: "Grace", color: 2, selection: ["filter"] };
const alan: Collaborator = { clientId: 8, name: "Alan", color: 3, selection: ["filter"] };

/** The surface of a card, which its edge goes around. */
const surfaceOf = (card: HTMLElement) => card.querySelector<HTMLElement>("[data-selected]")!;

/** How opaque an element is drawn, with every element around it, up to its card. */
function opacityOf(element: Element): number {
  let opacity = 1;
  for (let at: Element | null = element; at && !at.classList.contains("react-flow__node"); at = at.parentElement) {
    opacity *= Number(getComputedStyle(at).opacity);
  }
  return opacity;
}

/** Whether two boxes on the screen share some of their area. */
function overlap(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
  );
}

const meta = {
  component: WorkflowCanvas,
  args: { content: penguins, schemas },
  decorators: [
    Story => (
      <div className="h-150 w-300 rounded-lg border">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    // Each story starts with the viewer's choices as the browser has never seen them, and with nothing asked yet.
    localStorage.clear();
    recordRequests();
  },
  // A canvas is drawn from what it is given: it asks the backend nothing, and draws no text under 12px.
  afterEach: async () => {
    await expect(backendRequests()).toEqual([]);
    await expect(smallText()).toEqual([]);
  },
} satisfies Meta<typeof WorkflowCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Each operator is a card: its picture, its name, and its settings in one line under it. */
export const Compact: Story = {
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);

    for (const [name, settings] of [
      ["CSV File Scan", "penguins.csv · Limit 10"],
      ["Filter", "mass > 3600"],
      ["Limit", "Limit 5"],
    ]) {
      const card = cardOf(flow, name);
      await expect(within(card).getByText(settings)).toBeVisible();
      await waitFor(() =>
        expect(within(card).getByRole<HTMLImageElement>("presentation").naturalWidth).toBeGreaterThan(0)
      );
      // As wide as the layout counts a card, and as tall as one line of settings makes it, at the zoom it is fitted at.
      await expect(card.getBoundingClientRect().width).toBe(operatorCard.width);
      await expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(operatorCard.height);
      // Its buttons are not seen until it is pointed at, selected or has the keyboard.
      for (const button of within(card).getAllByRole("button")) await expect(opacityOf(button)).toBe(0);
    }
  },
};

/**
 * A canvas that is only looked at, as a version or the hub shows a workflow: each card opens to read, and its eye says
 * whether its operator keeps its result, which no one can change here.
 */
export const OnlyLookedAt: Story = {
  args: {
    content: {
      ...penguins,
      operators: penguins.operators.map(each => (each.operatorID === "limit" ? { ...each, viewResult: true } : each)),
    },
    readOnly: true,
    onEdit: fn(),
  },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const [filter, limit] = [cardOf(flow, "Filter"), cardOf(flow, "Limit")];

    for (const button of within(filter).getAllByRole("button")) await expect(opacityOf(button)).toBe(0);
    const kept = within(limit).getByRole("button", { name: "Keep the result of Limit" });
    await expect(kept).toHaveAttribute("aria-pressed", "true");
    await expect(kept).toBeDisabled();
    await expect(opacityOf(kept)).toBeGreaterThan(0);
    // A card shows its buttons once it has the keyboard, as when it is pointed at: one opens it to read.
    filter.focus();
    await expect(opacityOf(within(filter).getByRole("button", { name: "View Filter" }))).toBe(1);
    await expect(within(filter).getByRole("button", { name: "Keep the result of Filter" })).toBeDisabled();
  },
};

/** Every setting on a line of its own, by its name, as the viewer may choose for every canvas. */
export const EverySetting: Story = {
  args: { density: "detailed" },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const settingsOf = (name: string) =>
      within(cardOf(flow, name))
        .getAllByRole("term")
        .map(term => [term.textContent, term.nextElementSibling?.textContent]);

    await expect(settingsOf("CSV File Scan")).toEqual([
      ["File", "penguins.csv"],
      ["Limit", "10"],
    ]);
    await expect(settingsOf("Filter")).toEqual([["Predicates", "mass > 3600"]]);
    // Each card is as tall as its settings make it, and the rows are drawn further apart for the tallest.
    await expect(cardOf(flow, "CSV File Scan").getBoundingClientRect().height).toBeGreaterThan(operatorCard.height);
  },
};

/** How each operator does in the execution shown: done, under way, and waiting for its turn. */
const executing: Record<string, OperatorProgress> = {
  scan: { state: "Completed", inputRows: 0, outputRows: 5265 },
  filter: { state: "Completed", inputRows: 5265, outputRows: 3 },
  limit: { state: "Running", inputRows: 3, outputRows: 1 },
  sort: { state: "Uninitialized", inputRows: 0, outputRows: 0 },
};

/**
 * An execution under way: under each card, the operator's state and the rows it took and put out, or, of one that
 * takes none, those it put out. What works turns its icon.
 */
export const Executing: Story = {
  args: { content: sorted, progress: executing },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);

    for (const [name, state, rows] of [
      ["CSV File Scan", "Completed", "5,265 rows"],
      ["Filter", "Completed", "5,265 → 3 rows"],
      ["Limit", "Running", "3 → 1 row"],
      ["Sort", "Uninitialized", "0 rows"],
    ]) {
      const card = cardOf(flow, name);
      await expect(within(card).getByText(state)).toBeVisible();
      await expect(within(card).getByText(rows)).toBeVisible();
    }
    // Only what works turns, unless the viewer asked for less motion.
    const turning = [...flow.querySelectorAll("svg")].filter(icon => getComputedStyle(icon).animationName === "spin");
    await expect(turning.map(icon => icon.closest<HTMLElement>("[role=group]")?.getAttribute("aria-label"))).toEqual([
      "Limit",
    ]);
  },
};

/** An execution that failed at the filter: the operators after it never started. */
export const Failed: Story = {
  args: {
    content: sorted,
    progress: {
      ...executing,
      filter: { state: "Failed", inputRows: 5265, outputRows: 0 },
      limit: { state: "Uninitialized", inputRows: 0, outputRows: 0 },
    },
  },
  play: async ({ canvasElement }) => {
    const filter = cardOf(await drawnCanvas(canvasElement), "Filter");

    await expect(within(filter).getByText("Failed")).toBeVisible();
    await expect(within(filter).getByText("5,265 → 0 rows")).toBeVisible();
  },
};

/** An operator that cannot be executed as it is says why, under its name, inside an edge in the color of problems. */
export const WithAProblem: Story = {
  args: {
    content: {
      ...penguins,
      operators: penguins.operators.map(each => (each.operatorID === "filter" ? operator("Filter", "filter") : each)),
    },
    problems: { filter: "Predicates is not set." },
  },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const filter = cardOf(flow, "Filter");

    await expect(within(filter).getByText("Predicates is not set.")).toBeVisible();
    await expect(filter).toHaveAccessibleDescription(/Predicates is not set\.$/);
    const problemColor = getComputedStyle(within(filter).getByText("Predicates is not set.")).color;
    await expect(getComputedStyle(surfaceOf(filter)).borderTopColor).toBe(problemColor);
    await expect(getComputedStyle(surfaceOf(cardOf(flow, "Limit"))).borderTopColor).not.toBe(problemColor);
  },
};

/** An operator left out of executions is faded, inside a dashed edge, and says so in words that are not faded. */
export const LeftOutOfExecutions: Story = {
  args: {
    content: {
      ...penguins,
      operators: penguins.operators.map(each => (each.operatorID === "limit" ? { ...each, isDisabled: true } : each)),
    },
  },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const limit = cardOf(flow, "Limit");

    await expect(opacityOf(within(limit).getByText("Limit", { exact: true }))).toBe(0.5);
    await expect(opacityOf(within(limit).getByText("Left out"))).toBe(1);
    await expect(within(limit).getByText("Left out")).toHaveAttribute("title", "Left out of executions");
    await expect(getComputedStyle(surfaceOf(limit)).borderTopStyle).toBe("dashed");
    await expect(getComputedStyle(surfaceOf(cardOf(flow, "Filter"))).borderTopStyle).toBe("solid");
  },
};

/**
 * Grace is editing the filter in her card: it says so on its top edge, its edge is in her color, and until she is
 * done its eye waits for her. Alan has it selected, which its top edge says too.
 */
export const HeldBySomeoneElse: Story = {
  args: {
    collaborators: [grace, alan],
    held: new Map([["filter", grace]]),
    onEdit: fn(),
    onPatch: fn(),
    executeUpTo: () => ({ start: fn() }),
  },
  play: async ({ canvasElement, args }) => {
    const filter = cardOf(await drawnCanvas(canvasElement), "Filter");
    const holder = within(filter).getByText("Grace").parentElement!;

    await expect(holder).toHaveTextContent("Grace is editing");
    await expect(within(filter).getByRole("list", { name: "Selected by" })).toHaveTextContent(/^Alan$/);
    await expect(getComputedStyle(surfaceOf(filter)).borderTopColor).toBe(getComputedStyle(holder).backgroundColor);
    // Its buttons show once it has the keyboard, as when it is pointed at.
    filter.focus();
    const keep = within(filter).getByRole("button", { name: "Keep the result of Filter" });
    await expect(keep).toHaveAttribute("aria-disabled", "true");
    await expect(keep).toHaveAccessibleDescription("Grace is editing");
    await userEvent.click(keep);
    await expect(args.onPatch).not.toHaveBeenCalled();
  },
};

/** Who is editing a card, with a long name, beside three others who have it selected: none lies over another. */
export const HeldBesideOthers: Story = {
  args: {
    collaborators: [
      { ...grace, name: "Alexandria Montgomery-Wellington", color: 4 },
      alan,
      { clientId: 9, name: "Ada", color: 5, selection: ["filter"] },
      { clientId: 10, name: "Linus", color: 6, selection: ["filter"] },
    ],
    held: new Map([["filter", { ...grace, name: "Alexandria Montgomery-Wellington", color: 4 }]]),
  },
  play: async ({ canvasElement }) => {
    const filter = cardOf(await drawnCanvas(canvasElement), "Filter");
    const card = surfaceOf(filter).getBoundingClientRect();
    const who = within(filter).getByText("Alexandria Montgomery-Wellington");
    const doing = within(filter).getByText("is editing");
    const label = who.parentElement!.getBoundingClientRect();
    const names = within(within(filter).getByRole("list", { name: "Selected by" })).getAllByRole("listitem");

    await expect(names.map(name => name.textContent)).toEqual(["Alan", "Ada", "Linus"]);
    // The long name is cut short, and what they do never is.
    await expect(who.scrollWidth).toBeGreaterThan(who.clientWidth);
    await expect(doing.scrollWidth).toBeLessThanOrEqual(doing.clientWidth);
    for (const name of names) await expect(overlap(name.getBoundingClientRect(), label)).toBe(false);
    await expect(overlap(within(filter).getByText("Filter", { exact: true }).getBoundingClientRect(), label)).toBe(
      false
    );
    await expect([label.left >= card.left, label.right <= card.right]).toEqual([true, true]);
  },
};

/** The penguins as the admin keeps them, and a UDF that reads a version of their model, resnet. */
const reading = inColumns(
  workflowContent(
    [
      operator("CSVFileScan", "scan", { fileName: penguinsFile }),
      operator("PythonUDFV2", "udf", {
        uiParameters: [
          {
            attribute: { attributeName: "weights", attributeType: "string" },
            value: "/model/texera/resnet/v3",
            inputType: "model",
          },
        ],
      }),
    ],
    [link("scan", "udf")]
  ),
  { scan: [0, 0], udf: [1, 0] }
);

const created = Date.UTC(2026, 10, 2);
const penguinsDataset = {
  kind: "dataset",
  id: 7,
  name: "penguins",
  description: "Size measurements of 344 penguins of the Palmer Archipelago.",
  owner: "texera",
  isPublic: true,
  createdAt: created,
  access: "owner",
} satisfies Resource;
const resnet = {
  kind: "model",
  id: 3,
  name: "resnet",
  description: "Tells the species of a penguin from a picture of it.",
  owner: "texera",
  isPublic: false,
  createdAt: created,
  access: "owner",
  framework: "PyTorch",
  format: "TorchScript",
} satisfies Model;

/** A dataset or a model as the backend says it is, and the versions it has, which are asked of a dataset alone. */
interface Known {
  resource: Resource & { kind: VersionedKind };
  versions?: ResourceVersion[];
}

/** Puts what the backend says of these datasets and models in the story's cache, so that their chips call no server. */
function withResources(...known: Known[]): Decorator {
  return Story => {
    const queryClient = useQueryClient();
    for (const { resource, versions } of known) {
      const { kind, owner, name, id } = resource;
      queryClient.setQueryData(resourceLookupQuery({ kind, owner, name }, "yours").queryKey, resource);
      if (versions) queryClient.setQueryData(versionListQuery({ kind, id }).queryKey, versions);
    }
    return <Story />;
  };
}

/** What an opened chip says, each thing by its name, as a screen reader reads it. */
const termsOf = (details: HTMLElement) =>
  within(details)
    .getAllByRole("term")
    .map(term => [term.textContent, spokenText(term.nextElementSibling!)]);

/**
 * Above each card, a chip of each version of a dataset or a model its operator reads, centered on it and joined to it
 * by a dashed line, in the kind's color. A click opens what the backend says of it, and a link to its page.
 */
export const ReadingDatasetsAndModels: Story = {
  args: { content: reading },
  decorators: [
    withResources(
      { resource: penguinsDataset, versions: [{ id: 12, name: "v1", createdAt: created }] },
      { resource: resnet }
    ),
  ],
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const dataset = within(flow).getByRole("button", { name: "penguins v1" });
    const model = within(flow).getByRole("button", { name: "resnet v3" });

    await expect(dataset).toHaveAttribute("title", penguinsFile);
    await expect(model).toHaveAttribute("title", "/model/texera/resnet/v3");
    for (const [chip, name] of [
      [dataset, "CSV File Scan"],
      [model, "Python UDF"],
    ] as const) {
      const [above, card] = [chip.getBoundingClientRect(), cardOf(flow, name).getBoundingClientRect()];
      await expect(above.left + above.width / 2).toBe(card.left + card.width / 2);
      await expect(card.top - above.bottom).toBe(resourceChip.gap);
      await expect(getComputedStyle(chip).borderTopStyle).toBe("dashed");
    }
    // Each kind in its own color.
    await expect(getComputedStyle(dataset).borderTopColor).not.toBe(getComputedStyle(model).borderTopColor);

    await userEvent.click(model);
    const aboutModel = await within(document.body).findByRole("dialog", { name: "resnet" });
    await expect(aboutModel).toHaveTextContent("Model · v3");
    await expect(termsOf(aboutModel)).toEqual([
      ["Owner", "texera"],
      ["Framework", "PyTorch"],
      ["Format", "TorchScript"],
    ]);
    await expect(within(aboutModel).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/user/model/3");
    await userEvent.keyboard("{Escape}");

    await userEvent.click(dataset);
    const aboutDataset = await within(document.body).findByRole("dialog", { name: "penguins" });
    await expect(aboutDataset).toHaveTextContent("Dataset · v1");
    await expect(termsOf(aboutDataset)).toEqual([
      ["File", "penguins.csv"],
      ["Owner", "texera"],
    ]);
    await expect(aboutDataset).toHaveTextContent(penguinsDataset.description);
    // At the version the path names, showing its file.
    await expect(within(aboutDataset).getByRole("link", { name: "Open" }).getAttribute("href")).toMatch(
      /\/datasets\/7\?version=12&file=penguins\.csv$/
    );
  },
};

/**
 * Under each card, the chip of the result its operator kept in the execution shown: its rows, or a visualization. A
 * click shows it.
 */
export const KeptResults: Story = {
  args: {
    content: sorted,
    progress: {
      scan: { state: "Completed", inputRows: 0, outputRows: 5265 },
      filter: { state: "Completed", inputRows: 5265, outputRows: 3 },
      limit: { state: "Completed", inputRows: 3, outputRows: 3 },
      sort: { state: "Completed", inputRows: 3, outputRows: 3 },
    },
    results: {
      filter: { kind: "table", totalRows: 1234567, revision: 1 },
      limit: { kind: "table", totalRows: 3, revision: 1 },
      sort: { kind: "visualization", html: "<p>Bars</p>", revision: 1 },
    },
    onShowResult: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const flow = await drawnCanvas(canvasElement);
    const limit = within(flow).getByRole("button", { name: "Result of Limit: 3 rows" });

    for (const [chip, name] of [
      [limit, "Limit"],
      [within(flow).getByRole("button", { name: "Result of Sort: Visualization" }), "Sort"],
      [within(flow).getByRole("button", { name: "Result of Filter: 1,234,567 rows" }), "Filter"],
    ] as const) {
      // Under the card's right edge, where its outputs are.
      const [under, card] = [chip.getBoundingClientRect(), cardOf(flow, name).getBoundingClientRect()];
      await expect(under.left + under.width / 2).toBe(card.right);
      await expect(under.top - card.bottom).toBe(resultChip.gap);
    }
    await userEvent.click(limit);
    await expect(args.onShowResult).toHaveBeenCalledWith("limit");
  },
};

/** A ring 2px wide, in a color at its full strength, as a box's shadow says it. */
const fullRing = /oklch\([^/)]+\) 0px 0px 0px 2px/;

/**
 * From a card that is not selected, the keyboard goes to its buttons, which show while it is there, then to its chips,
 * then to the next card.
 */
export const WithTheKeyboard: Story = {
  args: {
    results: { scan: { kind: "table", totalRows: 5265, revision: 1 } },
    onShowResult: fn(),
    onEdit: fn(),
    onPatch: fn(),
    executeUpTo: () => ({ start: fn() }),
  },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const chips = ["penguins v1", "Result of CSV File Scan: 5,265 rows"];
    // A card's buttons are not seen until it is pointed at, selected or has the keyboard, but they are drawn all the
    // same: the browser gives the keyboard only to what is drawn, once the card it leaves has let go of it.
    const unseen = within(cardOf(flow, "Filter")).getAllByRole("button");
    await expect(unseen.map(button => button.getAttribute("aria-label"))).toEqual([
      "Execute up to Filter",
      "Keep the result of Filter",
      "Edit Filter",
    ]);
    for (const button of unseen) await expect([button.checkVisibility(), opacityOf(button)]).toEqual([true, 0]);
    cardOf(flow, "CSV File Scan").focus();

    const reached: string[] = [];
    for (let step = 0; step < 6; step++) {
      await userEvent.tab();
      const focused = document.activeElement as HTMLElement;
      const name = focused.getAttribute("aria-label") ?? focused.textContent;
      reached.push(name);
      // Whatever has the keyboard is drawn whole, and a chip that has it shows a ring as strong as the app's others.
      await expect(opacityOf(focused)).toBe(1);
      await expect(focused.getBoundingClientRect().width).toBeGreaterThan(0);
      if (chips.includes(name)) await expect(getComputedStyle(focused).boxShadow).toMatch(fullRing);
    }

    await expect(reached).toEqual([
      "Execute up to CSV File Scan",
      "Keep the result of CSV File Scan",
      "Edit CSV File Scan",
      ...chips,
      "Filter",
    ]);
  },
};

/** The canvas in the dark theme, as the theme in the toolbar shows it: an execution, a hold, chips and results. */
export const InTheDark: Story = {
  ...KeptResults,
  args: { ...KeptResults.args, collaborators: [grace, alan], held: new Map([["filter", grace]]) },
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);

    await expect(document.documentElement).toHaveClass("dark");
    await expect(flow).toHaveClass("dark");
    await expect(within(cardOf(flow, "Filter")).getByText("Grace").parentElement).toHaveTextContent("Grace is editing");
  },
};
