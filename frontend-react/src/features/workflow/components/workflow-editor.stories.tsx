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

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { OperatorProgress, OperatorResult } from "@/lib/execution/client";
import type { WorkflowContent } from "@/lib/workflow/model";
import { useLocalEditing } from "@/testing/editing";
import { backendRequests, cardOf, drawnCanvas, recordRequests, smallText } from "@/testing/stories";
import { inColumns, link, operator, operatorMetadata, workflowContent } from "@/testing/workflow";
import { WorkflowEditor } from "./workflow-editor";

interface LocalEditorProps {
  content: WorkflowContent;
  progress?: Record<string, OperatorProgress>;
  results?: Record<string, OperatorResult>;
}

/** The workflow editor on a workflow of this page alone (`useLocalEditing`): it enters no room, and asks nothing. */
function LocalEditor({ content, progress, results }: LocalEditorProps) {
  const editing = useLocalEditing({ content, metadata: operatorMetadata });
  return (
    <WorkflowEditor
      workflow={{ id: 1, name: "Heavy penguins", description: "", content, readonly: false }}
      metadata={operatorMetadata}
      editing={editing}
      user={{ id: 1, name: "texera" }}
      progress={progress}
      results={results}
    />
  );
}

/** A file of penguins, its first five, and all of them sorted, under the first five: scan -> limit, scan -> sort. */
const penguins = inColumns(
  workflowContent(
    [
      operator("CSVFileScan", "scan", { fileName: "/dataset/texera/penguins/v1/penguins.csv" }),
      operator("Limit", "limit", { limit: 5 }),
      operator("Sort", "sort"),
    ],
    [link("scan", "limit"), link("scan", "sort")]
  ),
  { scan: [0, 0], limit: [1, 0], sort: [1, 1] }
);

/** Opens an operator's card as the keyboard does: Enter on the operator, which selects it and opens its card. */
async function openCard(flow: HTMLElement, name: string): Promise<HTMLElement> {
  cardOf(flow, name).focus();
  await userEvent.keyboard("{Enter}");
  return within(flow).findByRole("region", { name: `Properties of ${name}` });
}

/** How far under one card another is drawn, from the top of one to the top of the other. */
const below = (flow: HTMLElement, upper: string, lower: string) =>
  cardOf(flow, lower).getBoundingClientRect().top - cardOf(flow, upper).getBoundingClientRect().top;

const meta = {
  component: LocalEditor,
  args: { content: penguins },
  decorators: [
    Story => (
      <div className="flex h-200 w-300 rounded-lg border">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    // Each story starts with the editor's panels and the viewer's choices as the browser has never seen them, and
    // with nothing asked yet.
    localStorage.clear();
    return recordRequests();
  },
  // The editor works on its own document here: it asks the backend nothing, and draws no text under 12px.
  afterEach: async () => {
    await expect(backendRequests()).toEqual([]);
    await expect(smallText()).toEqual([]);
  },
} satisfies Meta<typeof LocalEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * An operator's settings are edited in its card, which opens in place on the canvas: its name in its head, its
 * settings under it. Every change is in the workflow as it is made, and the closed card says it.
 */
export const EditingInTheCard: Story = {
  play: async ({ canvasElement }) => {
    const flow = await drawnCanvas(canvasElement);
    const apart = below(flow, "Limit", "Sort");
    const properties = await openCard(flow, "Limit");
    await expect(properties).toHaveFocus();

    const limit = within(properties).getByLabelText("Limit *");
    await expect(limit).toHaveValue(5);
    await userEvent.clear(limit);
    await userEvent.type(limit, "2");
    const name = within(properties).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "First two");
    await expect(properties).toHaveAccessibleName("Properties of First two");
    await userEvent.click(within(properties).getByRole("button", { name: "Done" }));

    const closed = cardOf(flow, "First two");
    await waitFor(() => expect(within(flow).queryByRole("region")).not.toBeInTheDocument());
    await expect(closed).toHaveFocus();
    await expect(within(closed).getByText("Limit 2")).toBeVisible();
    // The card under it is drawn where it was again: the room was only while the card was open.
    await waitFor(() => expect(below(flow, "First two", "Sort")).toBe(apart));
  },
};

/** The points of a line on the screen that lie inside a box, and how many of those the line is drawn over. */
function lineInside(line: SVGPathElement, box: DOMRect): { inside: number; drawnOver: number } {
  // A line takes no pointer, so the point is asked what is drawn there as if it took one.
  line.style.pointerEvents = "stroke";
  try {
    const [length, toScreen] = [line.getTotalLength(), line.getScreenCTM()!];
    let [inside, drawnOver] = [0, 0];
    for (let step = 0; step <= 100; step++) {
      const { x, y } = line.getPointAtLength((length * step) / 100).matrixTransform(toScreen);
      if (x <= box.left + 1 || x >= box.right - 1 || y <= box.top + 1 || y >= box.bottom - 1) continue;
      inside += 1;
      if (document.elementFromPoint(x, y) === line) drawnOver += 1;
    }
    return { inside, drawnOver };
  } finally {
    line.style.pointerEvents = "";
  }
}

/**
 * The open card is wider and taller than a closed one: the card under it, in its column, is drawn lower while it is
 * open, under the chip of the result it kept, whose line runs under the open card.
 */
export const RoomForTheOpenCard: Story = {
  args: {
    // The limit keeps its result after each execution, and kept it in the one shown.
    content: {
      ...penguins,
      operators: penguins.operators.map(each => (each.operatorID === "limit" ? { ...each, viewResult: true } : each)),
    },
    progress: {
      scan: { state: "Completed", inputRows: 0, outputRows: 344 },
      limit: { state: "Completed", inputRows: 344, outputRows: 5 },
      sort: { state: "Completed", inputRows: 344, outputRows: 344 },
    },
    results: { limit: { kind: "table", totalRows: 5, revision: 1 } },
  },
  play: async ({ canvasElement }) => {
    const apart = below(await drawnCanvas(canvasElement), "Limit", "Sort");
    const properties = await openCard(await drawnCanvas(canvasElement), "Limit");
    await expect(within(properties).getByRole("button", { name: "Keep the result of Limit" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // Once the open card is measured, the canvas draws the cards under it again, and slides it into view.
    const flow = await drawnCanvas(canvasElement);
    const [limit, sort] = [cardOf(flow, "Limit").getBoundingClientRect(), cardOf(flow, "Sort").getBoundingClientRect()];
    const result = within(flow).getByRole("button", { name: "Result of Limit: 5 rows" }).getBoundingClientRect();

    // The card under the open one is drawn lower, clear of it and of the chip of its result.
    await expect(below(flow, "Limit", "Sort")).toBeGreaterThan(apart);
    await expect(result.top).toBeGreaterThan(limit.bottom);
    await expect(sort.top).toBeGreaterThan(result.bottom);
    // The line to the result starts at the card's output, on its right edge, and runs under the card, which covers it.
    const line = flow.querySelector<SVGPathElement>('.react-flow__edge[data-id="limit:result:line"] path')!;
    const { inside, drawnOver } = lineInside(line, limit);
    await expect(inside).toBeGreaterThan(0);
    await expect(drawnOver).toBe(0);
  },
};
