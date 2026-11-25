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

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryIcon, ShapesIcon } from "lucide-react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFloatingInsets } from "./area-context";
import { FloatingArea } from "./floating-area";
import { FloatingPanel } from "./floating-panel";
import { placementOf, useFloatingPanel } from "./use-floating-panel";

/** A panel docked to the left edge of an area, with what the area's docked panels cover shown under it. */
function Docked({ rail, onClose }: { rail?: ReactNode; onClose?: () => void }) {
  const panel = useFloatingPanel({ id: "operators", dock: "left", size: { width: 280, height: 400 } });
  return (
    <FloatingArea
      panels={
        <FloatingPanel
          panel={panel}
          title="Operators"
          icon={ShapesIcon}
          status="12 found"
          rail={rail}
          onClose={onClose}
          closeLabel="Close the operators">
          <p>Every operator</p>
        </FloatingPanel>
      }>
      <Covered />
    </FloatingArea>
  );
}

function Covered() {
  const { left, right, bottom } = useFloatingInsets() ?? { left: "?", right: "?", bottom: "?" };
  return <output aria-label="Covered">{`left ${left}, right ${right}, bottom ${bottom}`}</output>;
}

/** Two panels in one area, docked to opposite edges. */
function TwoPanels() {
  const left = useFloatingPanel({ id: "left", dock: "left", size: { width: 280 } });
  const right = useFloatingPanel({ id: "right", dock: "right", size: { width: 320 } });
  return (
    <FloatingArea
      panels={
        <>
          <FloatingPanel
            panel={left}
            title="Versions"
            icon={HistoryIcon}>
            <button type="button">A version</button>
          </FloatingPanel>
          <FloatingPanel
            panel={right}
            title="Properties"
            icon={ShapesIcon}>
            <button type="button">A property</button>
          </FloatingPanel>
        </>
      }>
      <p>The canvas</p>
    </FloatingArea>
  );
}

const zIndexOf = (name: string) => Number(screen.getByRole("region", { name }).style.zIndex);

describe("a floating panel", () => {
  it("says what it holds, and is minimized to a button that shows it again, which the browser keeps", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Docked />);
    const panel = screen.getByRole("region", { name: "Operators" });
    expect(panel).toHaveTextContent("Every operator");
    expect(panel).toHaveTextContent("12 found");

    await user.click(screen.getByRole("button", { name: "Minimize Operators" }));
    expect(screen.queryByRole("region", { name: "Operators" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Operators 12 found" })).toBeVisible();

    unmount();
    render(<Docked />);
    await user.click(screen.getByRole("button", { name: "Operators 12 found" }));
    expect(screen.getByRole("region", { name: "Operators" })).toHaveTextContent("Every operator");
  });

  it("keeps its rail of views when it is minimized", async () => {
    const user = userEvent.setup();
    render(<Docked rail={<button type="button">Versions</button>} />);

    await user.click(screen.getByRole("button", { name: "Minimize Operators" }));

    expect(screen.queryByText("Every operator")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Versions" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Operators/ })).not.toBeInTheDocument();
  });

  it("is docked again where it was, once the user moved it", async () => {
    localStorage.setItem("texera.panel.operators", JSON.stringify({ minimized: false, at: { x: 300, y: 200 } }));
    const user = userEvent.setup();
    render(<Docked />);

    await user.click(screen.getByRole("button", { name: "Dock Operators" }));

    expect(screen.queryByRole("button", { name: "Dock Operators" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("texera.panel.operators")!)).toEqual({ minimized: false });
  });

  it("closes what it shows, where that is more than minimizing it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Docked onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close the operators" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("makes room on its edge for what is under it, while it is docked and open", async () => {
    const user = userEvent.setup();
    render(<Docked />);
    const covered = screen.getByRole("status", { name: "Covered" });
    expect(covered).toHaveTextContent("left 280, right 0, bottom 0");

    await user.click(screen.getByRole("button", { name: "Minimize Operators" }));
    expect(covered).toHaveTextContent("left 0, right 0, bottom 0");
  });

  it("makes no room once the user moved it elsewhere", () => {
    localStorage.setItem("texera.panel.operators", JSON.stringify({ minimized: false, at: { x: 300, y: 200 } }));
    render(<Docked />);

    expect(screen.getByRole("status", { name: "Covered" })).toHaveTextContent("left 0, right 0, bottom 0");
  });

  it("comes in front of the others when it is used", async () => {
    const user = userEvent.setup();
    render(<TwoPanels />);
    expect(zIndexOf("Properties")).toBeGreaterThan(zIndexOf("Versions"));

    await user.click(screen.getByRole("button", { name: "A version" }));

    expect(zIndexOf("Versions")).toBeGreaterThan(zIndexOf("Properties"));
  });
});

describe("how the browser kept a panel", () => {
  it("is read back as it was kept", () => {
    expect(placementOf({ minimized: true, at: { x: 10, y: 20 }, size: { width: 300 } })).toEqual({
      minimized: true,
      at: { x: 10, y: 20 },
      size: { width: 300, height: undefined },
    });
  });

  it("leaves out anything it cannot use", () => {
    expect(placementOf(undefined)).toEqual({ minimized: false });
    expect(placementOf("docked")).toEqual({ minimized: false });
    expect(placementOf({ minimized: "yes", at: { x: "10", y: 20 }, size: { width: -5, height: Infinity } })).toEqual({
      minimized: false,
    });
  });
});
