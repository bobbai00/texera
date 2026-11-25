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

import { describe, expect, it } from "vitest";
import { coveredBy, keptInside, moved, resized } from "./geometry";

const area = { width: 1000, height: 600 };
const panel = { x: 100, y: 50, width: 300, height: 200 };
const min = { width: 240, height: 120 };

describe("moving a panel", () => {
  it("goes as far as the pointer goes", () => {
    expect(moved(panel, 40, -20, area)).toEqual({ ...panel, x: 140, y: 30 });
  });

  it("stops at the edges of the area", () => {
    expect(moved(panel, -500, 900, area)).toEqual({ ...panel, x: 0, y: 400 });
    expect(moved(panel, 2000, -2000, area)).toEqual({ ...panel, x: 700, y: 0 });
  });

  it("keeps a panel bigger than its area at the top left", () => {
    expect(moved({ x: 0, y: 0, width: 1200, height: 700 }, 50, 50, area)).toMatchObject({ x: 0, y: 0 });
  });
});

describe("resizing a panel", () => {
  it("grows or shrinks by the edge or the corner that is dragged, and the opposite edges stay", () => {
    expect(resized(panel, "right", 50, 999, min, area)).toEqual({ ...panel, width: 350 });
    expect(resized(panel, "bottom", 999, 30, min, area)).toEqual({ ...panel, height: 230 });
    expect(resized(panel, "left", -60, 0, min, area)).toEqual({ ...panel, x: 40, width: 360 });
    expect(resized(panel, "top", 0, 20, min, area)).toEqual({ ...panel, y: 70, height: 180 });
    expect(resized(panel, "bottom-left", 20, 20, min, area)).toEqual({ x: 120, y: 50, width: 280, height: 220 });
    expect(resized(panel, "top-right", 20, -20, min, area)).toEqual({ x: 100, y: 30, width: 320, height: 220 });
    expect(resized(panel, "bottom-right", -10, -10, min, area)).toEqual({ ...panel, width: 290, height: 190 });
  });

  it("is never smaller than the least size", () => {
    expect(resized(panel, "right", -200, 0, min, area).width).toBe(240);
    expect(resized(panel, "left", 200, 0, min, area)).toMatchObject({ x: 160, width: 240 });
    expect(resized(panel, "top", 0, 500, min, area)).toMatchObject({ y: 130, height: 120 });
  });

  it("never reaches out of the area", () => {
    expect(resized(panel, "right", 5000, 0, min, area).width).toBe(900);
    expect(resized(panel, "left", -5000, 0, min, area)).toMatchObject({ x: 0, width: 400 });
    expect(resized(panel, "bottom", 0, 5000, min, area).height).toBe(550);
  });
});

describe("a moved panel in an area that became smaller", () => {
  it("slides back in, as little as it must", () => {
    expect(keptInside({ x: 800, y: 500, width: 300, height: 200 }, area)).toEqual({
      x: 700,
      y: 400,
      width: 300,
      height: 200,
    });
    expect(keptInside(panel, area)).toEqual(panel);
  });

  it("is no bigger than the area", () => {
    expect(keptInside({ x: 50, y: 50, width: 1400, height: 900 }, area)).toEqual({ x: 0, y: 0, ...area });
  });
});

describe("the room the docked panels cover", () => {
  it("is how far each reaches in from the edge it is docked to: the widest on a side, the tallest at the bottom", () => {
    expect(
      coveredBy(
        [
          { dock: "left", size: { width: 280, height: 480 } },
          { dock: "right", size: { width: 320, height: 0 } },
          { dock: "right", size: { width: 200, height: 900 } },
          { dock: "bottom", size: { width: 720, height: 150 } },
        ],
        area
      )
    ).toEqual({ top: 0, left: 280, right: 320, bottom: 150 });
  });

  it("is nothing without docked panels", () => {
    expect(coveredBy([], area)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("is not made room for where the panels would leave less than a third free, as on a phone", () => {
    expect(
      coveredBy(
        [
          { dock: "left", size: { width: 350, height: 480 } },
          { dock: "right", size: { width: 350, height: 0 } },
        ],
        area
      )
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(coveredBy([{ dock: "bottom", size: { width: 720, height: 450 } }], area)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});
