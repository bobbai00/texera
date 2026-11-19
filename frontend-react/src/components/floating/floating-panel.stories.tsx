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
import { HistoryIcon, Settings2Icon, ShapesIcon, SquareTerminalIcon } from "lucide-react";
import { expect, waitFor, within } from "storybook/test";
import { Button } from "@/components/ui/button";
import { useFloatingInsets } from "./area-context";
import { FloatingArea } from "./floating-area";
import { FloatingPanel } from "./floating-panel";
import { useFloatingPanel } from "./use-floating-panel";

/** An area like the workflow editor's: a panel docked to each of its edges. */
function Workspace() {
  const operators = useFloatingPanel({ id: "story-operators", dock: "left", size: { width: 280, height: 320 } });
  const properties = useFloatingPanel({ id: "story-properties", dock: "right", size: { width: 300 } });
  const execution = useFloatingPanel({ id: "story-execution", dock: "bottom", size: { width: 520, height: 200 } });
  return (
    <FloatingArea
      className="h-150 w-300 rounded-lg border bg-muted"
      panels={
        <>
          <FloatingPanel
            panel={operators}
            title="Operators"
            icon={ShapesIcon}
            rail={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Operators"
                  onClick={() => operators.setMinimized(false)}>
                  <ShapesIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Versions">
                  <HistoryIcon />
                </Button>
              </>
            }>
            <p className="p-3">Every operator, in its groups.</p>
          </FloatingPanel>
          <FloatingPanel
            panel={properties}
            title="Properties"
            icon={Settings2Icon}>
            <p className="p-4">The properties of the operator that is selected, as tall as they are.</p>
          </FloatingPanel>
          <FloatingPanel
            panel={execution}
            title="Execution"
            icon={SquareTerminalIcon}
            status="Completed">
            <p className="p-3">What the execution did.</p>
          </FloatingPanel>
        </>
      }>
      <Covered />
    </FloatingArea>
  );
}

/** What the docked panels cover, as what lies under them reads it. */
function Covered() {
  const { left, right, bottom } = useFloatingInsets() ?? { left: "?", right: "?", bottom: "?" };
  return (
    <output
      aria-label="Covered"
      className="absolute inset-0 flex items-center justify-center text-muted-foreground">
      {`left ${left}, right ${right}, bottom ${bottom}`}
    </output>
  );
}

const meta = {
  render: () => <Workspace />,
  // Each story starts with the panels as the browser has never seen them.
  beforeEach: () => localStorage.clear(),
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** Three panels, each docked to an edge, with what they cover kept free for what is under them. */
export const Docked: Story = {
  play: async ({ canvas }) => {
    // Each panel stands a margin of 12 from the edge, and covers that much more.
    await waitFor(() =>
      expect(canvas.getByRole("status", { name: "Covered" })).toHaveTextContent("left 292, right 312, bottom 212")
    );
  },
};

/** A panel dragged by its header, then by its right edge, and docked again. */
export const MovedAndResized: Story = {
  play: async ({ canvas, userEvent }) => {
    const panel = canvas.getByRole("region", { name: "Operators" });
    const covered = canvas.getByRole("status", { name: "Covered" });
    await waitFor(() => expect(covered).toHaveTextContent("left 292, right 312, bottom 212"));
    const before = panel.getBoundingClientRect();
    const header = within(panel).getByRole("heading", { name: "Operators" });
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: header, coords: { clientX: before.left + 60, clientY: before.top + 20 } },
      { coords: { clientX: before.left + 160, clientY: before.top + 70 } },
      { coords: { clientX: before.left + 260, clientY: before.top + 120 } },
      { keys: "[/MouseLeft]" },
    ]);

    // A panel that was moved covers no edge.
    await waitFor(() => expect(covered).toHaveTextContent("left 0, right 312, bottom 212"));
    const moved = panel.getBoundingClientRect();
    await expect([moved.left - before.left, moved.top - before.top]).toEqual([200, 100]);

    const edge = panel.querySelector<HTMLElement>("[data-handle='right']")!;
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: edge, coords: { clientX: moved.right - 2, clientY: moved.top + 100 } },
      { coords: { clientX: moved.right + 78, clientY: moved.top + 100 } },
      { keys: "[/MouseLeft]" },
    ]);
    await waitFor(() => expect(panel.getBoundingClientRect().width).toBe(moved.width + 80));

    await userEvent.click(within(panel).getByRole("button", { name: "Dock Operators" }));
    await waitFor(() => expect(covered).toHaveTextContent("left 372, right 312, bottom 212"));
    const docked = panel.getBoundingClientRect();
    await expect([docked.left, docked.top, docked.width]).toEqual([before.left, before.top, before.width + 80]);
  },
};

/** A click on a panel's header, without a drag, leaves it where it is. */
export const ClickedNotMoved: Story = {
  play: async ({ canvas, userEvent }) => {
    const panel = canvas.getByRole("region", { name: "Properties" });
    await userEvent.click(within(panel).getByRole("heading", { name: "Properties" }));

    await expect(within(panel).queryByRole("button", { name: "Dock Properties" })).not.toBeInTheDocument();
  },
};

/** Panels minimized to a button, or to their rail, in the place they are docked. */
export const Minimized: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Minimize Operators" }));
    await userEvent.click(canvas.getByRole("button", { name: "Minimize Execution" }));

    await expect(canvas.getByRole("button", { name: "Execution Completed" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Versions" })).toBeVisible();
    await waitFor(() =>
      expect(canvas.getByRole("status", { name: "Covered" })).toHaveTextContent("left 0, right 312, bottom 0")
    );

    await userEvent.click(canvas.getByRole("button", { name: "Operators" }));
    await expect(canvas.getByRole("region", { name: "Operators" })).toBeVisible();
  },
};
