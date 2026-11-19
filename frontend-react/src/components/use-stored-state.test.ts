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

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStoredState } from "./use-stored-state";

const asNumber = (kept: unknown) => (typeof kept === "number" ? kept : 1);

describe("a value the browser keeps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts as the browser kept it, and is kept again as it changes", () => {
    localStorage.setItem("texera.test", "7");
    const { result } = renderHook(() => useStoredState("texera.test", asNumber));
    expect(result.current[0]).toBe(7);

    act(() => result.current[1](8));
    expect(result.current[0]).toBe(8);
    expect(localStorage.getItem("texera.test")).toBe("8");
  });

  it("starts as `read` says when nothing is kept, or nothing it can use", () => {
    expect(renderHook(() => useStoredState("texera.test", asNumber)).result.current[0]).toBe(1);
    localStorage.setItem("texera.test", "not json");
    expect(renderHook(() => useStoredState("texera.test", asNumber)).result.current[0]).toBe(1);
    localStorage.setItem("texera.test", '"a word"');
    expect(renderHook(() => useStoredState("texera.test", asNumber)).result.current[0]).toBe(1);
  });

  it("keeps nothing until the value is changed, so that a default that changes later reaches the user", () => {
    renderHook(() => useStoredState("texera.test", asNumber));

    expect(localStorage.getItem("texera.test")).toBeNull();
  });

  it("keeps nothing for a value that is not there", () => {
    localStorage.setItem("texera.test", "7");
    const { result } = renderHook(() =>
      useStoredState("texera.test", kept => (typeof kept === "number" ? kept : undefined))
    );

    act(() => result.current[1](undefined));
    expect(localStorage.getItem("texera.test")).toBeNull();
  });

  it("still changes in a browser that keeps nothing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The storage is off.");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("The storage is off.");
    });
    const { result } = renderHook(() => useStoredState("texera.test", asNumber));
    expect(result.current[0]).toBe(1);

    act(() => result.current[1](3));
    expect(result.current[0]).toBe(3);
  });
});
